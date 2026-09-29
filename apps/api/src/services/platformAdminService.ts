/**
 * Platform-administrator read service (P3).
 *
 * Read-only operational views over data that already exists. Every method calls
 * a service-role-only database function that re-verifies the actor against the
 * platform-admin registry, so the API gate and the database agree (defense in
 * depth). This service never writes, never returns secrets and never derives
 * cost; it is not a second accounting or project-administration system.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  PlatformAdminAccountDto,
  PlatformAdminJobDto,
  PlatformAdminOverviewDto,
  PlatformAdminProjectDto,
  PlatformAdminUsageDto,
  PlatformAdminUserDto,
  UsageAggregate,
  UsageCategory,
  UsageUnit,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';

/** Validated filter for a cross-account usage read. */
export interface PlatformAdminUsageRequest {
  accountId?: string | null;
  projectId?: string | null;
  category?: UsageCategory;
  provider?: string;
  operation?: string;
  unit?: UsageUnit;
  success?: boolean;
  occurredFrom?: string;
  occurredTo?: string;
}

export interface PlatformAdminReadService {
  overview(actorId: string): Promise<PlatformAdminOverviewDto>;
  listUsers(actorId: string): Promise<PlatformAdminUserDto[]>;
  listAccounts(actorId: string): Promise<PlatformAdminAccountDto[]>;
  listProjects(actorId: string): Promise<PlatformAdminProjectDto[]>;
  usage(actorId: string, filter: PlatformAdminUsageRequest): Promise<PlatformAdminUsageDto>;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export class SupabasePlatformAdminService implements PlatformAdminReadService {
  constructor(private readonly sb: SupabaseClient) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.sb.rpc(fn, args);
    if (error) {
      // A 42501 here means the registry check failed despite the API gate. That
      // is an authorization refusal, not a storage fault, so it stays a 403.
      const code = String((error as { code?: string }).code ?? '');
      logger.error({ error, fn }, 'platform-admin read failed');
      if (code === '42501') throw ApiError.forbidden('Platform administrator access required');
      throw new ApiError(500, 'storage_error', 'Platform administration read failed');
    }
    return data as T;
  }

  async overview(actorId: string): Promise<PlatformAdminOverviewDto> {
    const [summary, jobs] = await Promise.all([
      this.rpc<Record<string, unknown>>('seo_platform_admin_overview', { p_actor: actorId }),
      this.listRecentJobs(actorId),
    ]);
    return {
      users: num(summary.users),
      accounts: num(summary.accounts),
      projects: num(summary.projects),
      jobs: num(summary.jobs),
      active_jobs: num(summary.active_jobs),
      failed_jobs: num(summary.failed_jobs),
      usage_events_this_period: num(summary.usage_events_this_period),
      usage_period_start: String(summary.usage_period_start ?? ''),
      recent_jobs: jobs,
    };
  }

  private async listRecentJobs(actorId: string): Promise<PlatformAdminJobDto[]> {
    const rows = await this.rpc<Array<Record<string, unknown>>>('seo_platform_admin_jobs', {
      p_actor: actorId,
      p_limit: 10,
    });
    return (rows ?? []).map((r) => ({
      job_id: String(r.job_id),
      project_id: String(r.project_id),
      project_name: (r.project_name as string | null) ?? null,
      provider: String(r.provider),
      job_type: String(r.job_type),
      status: String(r.status),
      queued_at: String(r.queued_at),
      started_at: (r.started_at as string | null) ?? null,
      completed_at: (r.completed_at as string | null) ?? null,
      message: (r.message as string | null) ?? null,
    }));
  }

  async listUsers(actorId: string): Promise<PlatformAdminUserDto[]> {
    const rows = await this.rpc<Array<Record<string, unknown>>>('seo_platform_admin_users', {
      p_actor: actorId,
    });
    return (rows ?? []).map((r) => ({
      user_id: String(r.user_id),
      email: (r.email as string | null) ?? null,
      created_at: (r.created_at as string | null) ?? null,
      account_id: (r.account_id as string | null) ?? null,
      project_count: num(r.project_count),
    }));
  }

  async listAccounts(actorId: string): Promise<PlatformAdminAccountDto[]> {
    const rows = await this.rpc<Array<Record<string, unknown>>>('seo_platform_admin_accounts', {
      p_actor: actorId,
    });
    return (rows ?? []).map((r) => ({
      account_id: String(r.account_id),
      name: String(r.name),
      owner_user_id: String(r.owner_user_id),
      owner_email: (r.owner_email as string | null) ?? null,
      created_at: String(r.created_at),
      project_count: num(r.project_count),
      member_count: num(r.member_count),
    }));
  }

  async listProjects(actorId: string): Promise<PlatformAdminProjectDto[]> {
    const rows = await this.rpc<Array<Record<string, unknown>>>('seo_platform_admin_projects', {
      p_actor: actorId,
    });
    return (rows ?? []).map((r) => ({
      project_id: String(r.project_id),
      name: String(r.name),
      account_id: (r.account_id as string | null) ?? null,
      created_by: (r.created_by as string | null) ?? null,
      created_at: String(r.created_at),
      member_count: num(r.member_count),
    }));
  }

  async usage(actorId: string, filter: PlatformAdminUsageRequest): Promise<PlatformAdminUsageDto> {
    const rows = await this.rpc<Array<Record<string, unknown>>>('seo_platform_admin_usage_totals', {
      p_actor: actorId,
      p_account: filter.accountId ?? null,
      p_project: filter.projectId ?? null,
      p_from: filter.occurredFrom ?? null,
      p_to: filter.occurredTo ?? null,
      p_category: filter.category ?? null,
      p_provider: filter.provider ?? null,
      p_operation: filter.operation ?? null,
      p_unit: filter.unit ?? null,
      p_success: filter.success ?? null,
    });
    const totals: UsageAggregate[] = (rows ?? []).map((r) => ({
      category: r.category as UsageCategory,
      provider: String(r.provider),
      operation: String(r.operation),
      unit: r.unit as UsageUnit,
      quantity: num(r.quantity),
      eventCount: num(r.event_count),
    }));
    return {
      scope: {
        accountId: filter.accountId ?? null,
        projectId: filter.projectId ?? null,
      },
      totals,
    };
  }
}
