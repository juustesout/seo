/**
 * Supabase admin (service-role) data access + membership authorization used by
 * the API server.
 *
 * The service-role client (createAdminClient) authenticates the whole server
 * and bypasses row-level security, so authorization can never be delegated to
 * PostgREST policies for this client. That is why AccessService re-derives
 * every caller's project membership from seo_project_members on each request
 * before any project-scoped row is touched - defense in depth, and the reason
 * RLS can stay the boundary for direct browser/anon traffic without being the
 * server's only line of defense. In RLS terms `auth.uid()` still identifies the
 * end user for anything that talks to PostgREST with a user session; the code
 * in this module always identifies the user explicitly by `user.sub`.
 *
 * chunkedUpsert keeps bulk sync writes inside single-request size limits so a
 * large payload cannot exceed PostgREST/body constraints or time out.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from './apiErrors.js';
import { logger } from './logger.js';
import type { MemberRole } from '@seo/contracts';

/** Max rows per upsert request - keeps requests under PostgREST/body limits. */
export const MAX_BATCH_ROWS = 800;

/** Loose row shape for generic bulk writes (values are untyped by design). */
export interface RowLike {
  [key: string]: unknown;
}

/**
 * Build the service-role (admin) Supabase client. persistSession and
 * autoRefreshToken are disabled because this is a long-lived server process,
 * not a browser: there is no storage to persist a session into and no user
 * session to refresh - the service key itself authenticates every request.
 * Because that key bypasses RLS, AccessService must re-check membership for
 * every project-scoped operation (see module header). x-application-name tags
 * each request for Supabase-side observability.
 */
export function createAdminClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { 'x-application-name': 'seo-platform-api' },
    },
  });
}

/**
 * Batch upsert that never sends more than MAX_BATCH_ROWS rows per request, so
 * large sync payloads stay within single-request limits and a storage failure
 * can be attributed to the chunk that caused it. `inserted` counts every row
 * handed to upsert (an ignored duplicate still counts); options pass through to
 * the underlying PostgREST upsert (onConflict column and ignoreDuplicates).
 * Throws a 500 storage_error with the failing chunk offset rather than
 * swallowing partial failures.
 */
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

/** Role a user holds on a project (read from the seo_project_members join). */
export interface ProjectRole {
  project_id: string;
  role: MemberRole;
  name: string;
}

/** Minimal project row surfaced to API-key holders (no secrets). */
export interface ProjectBrief {
  id: string;
  name: string;
  slug: string | null;
  website_url: string | null;
  created_at: string;
  role: MemberRole | null;
}

/**
 * Project/account membership authorization (defense in depth). The service-role
 * client bypasses RLS, so every project-scoped entry point must re-derive the
 * caller's role from seo_project_members through this class before any
 * project-scoped row is read or written. Keeping all membership/role logic here
 * (instead of in route handlers) means authorization has exactly one
 * implementation and one error vocabulary across REST, worker and MCP surfaces.
 */
export class AccessService {
  constructor(private readonly sb: SupabaseClient) {}

  /**
   * One-row role lookup scoped to both user_id and project_id - null when the
   * user is not a member at all. Storage errors surface as 500, never as
   * "forbidden": reporting "you lack access" when the database is merely
   * failing would hide a real outage behind an auth error.
   */
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

  /** Public role read for callers that need the role but no authorization side effect. */
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

  /**
   * True when the project row exists. Lets a route distinguish "the project is
   * unknown" from "the user is not a member" so it can answer 404 vs 403.
   */
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

  /**
   * Every project a user is a member of, with their role - the reach of an
   * account (master) API key. Two queries by design: roles are read from
   * seo_project_members, then project metadata is fetched in one batched in()
   * instead of a cross-table join, keeping this cheap for users with many
   * memberships.
   */
  async listMembershipProjects(userId: string): Promise<ProjectBrief[]> {
    const { data: members, error } = await this.sb
      .from('seo_project_members')
      .select('project_id, role')
      .eq('user_id', userId);
    if (error) {
      logger.error({ error }, 'membership project list failed');
      throw new ApiError(500, 'storage_error', 'Could not list your projects');
    }
    const roles = new Map((members ?? []).map((m) => [String(m.project_id), m.role as MemberRole]));
    const ids = [...roles.keys()];
    if (ids.length === 0) return [];
    const { data: projects, error: perr } = await this.sb
      .from('seo_projects')
      .select('id, name, slug, website_url, created_at')
      .in('id', ids);
    if (perr) {
      logger.error({ error: perr }, 'membership project info failed');
      throw new ApiError(500, 'storage_error', 'Could not list your projects');
    }
    return ((projects ?? []) as Array<{ id: string; name: string; slug: string | null; website_url: string | null; created_at: string }>)
      .filter((p) => roles.has(p.id))
      .map((p) => ({ ...p, role: roles.get(p.id) ?? null }));
  }

  /** Minimal metadata for one project (used to describe a bound project key). */
  async projectInfo(projectId: string): Promise<ProjectBrief | null> {
    const { data, error } = await this.sb
      .from('seo_projects')
      .select('id, name, slug, website_url, created_at')
      .eq('id', projectId)
      .maybeSingle();
    if (error) {
      logger.error({ error }, 'project info lookup failed');
      throw new ApiError(500, 'storage_error', 'Could not read the project');
    }
    if (!data) return null;
    const row = data as { id: string; name: string; slug: string | null; website_url: string | null; created_at: string };
    return { ...row, role: null };
  }
}
