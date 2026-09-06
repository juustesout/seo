/**
 * Supabase admin (service-role) data access + membership authorization used by
 * the API server. Server-side operations re-verify project membership before
 * touching any project-scoped resource (defense in depth on top of RLS, which
 * still protects direct PostgREST browser traffic).
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from './apiErrors.js';
import { logger } from './logger.js';
import type { MemberRole } from '@seo/contracts';

export const MAX_BATCH_ROWS = 800;

export interface RowLike {
  [key: string]: unknown;
}

export function createAdminClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { 'x-application-name': 'seo-platform-api' },
    },
  });
}

export async function chunkedUpsert(
  sb: SupabaseClient,
  table: string,
  rows: RowLike[],
  opts: { onConflict?: string; ignoreDuplicates?: boolean } = {},
): Promise<{ inserted: number; skipped?: number }> {
  if (rows.length === 0) return { inserted: 0 };
  let inserted = 0;
  for (let i = 0; i < rows.length; i += MAX_BATCH_ROWS) {
    const chunk = rows.slice(i, i + MAX_BATCH_ROWS);
    const query = sb.from(table).upsert(chunk as never, {
      onConflict: opts.onConflict,
      ignoreDuplicates: opts.ignoreDuplicates,
    });
    const { error } = await query;
    if (error) {
      logger.error({ error, table, chunkStart: i }, 'chunked upsert failed');
      throw new ApiError(500, 'storage_error', `Failed to store ${table} rows`, error.message);
    }
    inserted += chunk.length;
  }
  return { inserted };
}

export interface ProjectRole {
  project_id: string;
  role: MemberRole;
  name: string;
}

export class AccessService {
  constructor(private readonly sb: SupabaseClient) {}

  private async membership(userId: string, projectId: string): Promise<{ role: MemberRole } | null> {
    const { data, error } = await this.sb
      .from('seo_project_members')
      .select('role')
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .maybeSingle();
    if (error) {
      logger.error({ error }, 'membership check failed');
      throw new ApiError(500, 'storage_error', 'Could not verify project access');
    }
    return data ? { role: data.role as MemberRole } : null;
  }

  async getRole(userId: string, projectId: string): Promise<MemberRole | null> {
    const m = await this.membership(userId, projectId);
    return m?.role ?? null;
  }

  /**
   * Authorize a project-scoped operation. Never trust the project_id coming
   * from the browser without this verification.
   */
  async requireRole(
    userId: string,
    projectId: string,
    minRole: MemberRole = 'viewer',
  ): Promise<{ project_id: string; role: MemberRole }> {
    const role = await this.getRole(userId, projectId);
    if (!role) throw ApiError.forbidden('You do not have access to this project');
    const order: Record<MemberRole, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };
    if (order[role] < order[minRole]) {
      throw ApiError.forbidden(`This action requires the ${minRole} role`);
    }
    return { project_id: projectId, role };
  }

  async projectExists(projectId: string): Promise<boolean> {
    const { data, error } = await this.sb.from('seo_projects').select('id').eq('id', projectId).maybeSingle();
    if (error) {
      logger.error({ error }, 'project existence check failed');
      return false;
    }
    return Boolean(data);
  }

  /**
   * Authorize an account-scoped operation. The caller must own the account
   * (one user = one account for now); a missing account is created lazily so a
   * fresh signup can connect Google before creating any project.
   */
  async requireAccount(userId: string): Promise<{ account_id: string }> {
    const { data, error } = await this.sb.rpc('seo_ensure_account', { p_user: userId });
    if (error) {
      logger.error({ error }, 'account resolution failed');
      throw new ApiError(500, 'storage_error', 'Could not resolve your account');
    }
    const accountId = Array.isArray(data) ? (data[0] as { id?: string } | null)?.id : (data as string | null);
    if (!accountId) throw new ApiError(500, 'storage_error', 'Could not resolve your account');
    return { account_id: accountId };
  }
}
