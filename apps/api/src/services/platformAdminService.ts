/**
 * Platform-administrator read service (P3), extended with plan policy in P13.
 *
 * Operational views over data that already exists, plus one policy write: plan
 * assignment. Every method calls a service-role-only database function that
 * re-verifies the actor against the platform-admin registry, so the API gate
 * and the database agree (defense in depth). It never derives cost and never
 * returns secrets; it is not a second accounting or project-administration
 * system.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  isValidEntitlementFeature,
  isValidPlanBillingInterval,
  isValidPlanPriceStatus,
  type AccountEntitlementDto,
  type EntitlementFeature,
  type PlanBillingInterval,
  type PlatformAdminAccountDto,
  type PlatformAdminJobDto,
  type PlatformAdminOverviewDto,
  type PlatformAdminPlanDto,
  type PlatformAdminProjectDto,
  type PlatformAdminUsageDto,
  type PlatformAdminUserDto,
  type UsageAggregate,
  type UsageCategory,
  type UsageUnit,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';
import type { EntitlementService } from './entitlementService.js';

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
  listPlans(actorId: string): Promise<PlatformAdminPlanDto[]>;
  assignPlan(actorId: string, accountId: string, planId: string): Promise<{ accountId: string; planId: string }>;
  accountEntitlement(actorId: string, accountId: string): Promise<AccountEntitlementDto>;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export class SupabasePlatformAdminService implements PlatformAdminReadService {
  constructor(
    private readonly sb: SupabaseClient,
    private readonly entitlements: EntitlementService,
  ) {}

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

  async listPlans(actorId: string): Promise<PlatformAdminPlanDto[]> {
    const rows = await this.rpc<Array<Record<string, unknown>>>('seo_platform_admin_plans', {
      p_actor: actorId,
    });
    return (rows ?? []).map((r) => ({
      key: String(r.key),
      name: String(r.name),
      display_name: typeof r.display_name === 'string' && r.display_name.length > 0 ? r.display_name : String(r.name),
      description: (r.description as string | null) ?? null,
      is_default: Boolean(r.is_default),
      is_public: r.is_public === undefined ? true : Boolean(r.is_public),
      sort_order: num(r.sort_order),
      status: String(r.status),
      currency: (r.currency as string | null) ?? null,
      monthly_price: r.monthly_price === null || r.monthly_price === undefined ? null : num(r.monthly_price),
      yearly_price: r.yearly_price === null || r.yearly_price === undefined ? null : num(r.yearly_price),
      price_status: isValidPlanPriceStatus(r.price_status) ? r.price_status : 'draft',
      price_label: (r.price_label as string | null) ?? null,
      billing_intervals: Array.isArray(r.billing_intervals)
        ? r.billing_intervals.filter((i): i is PlanBillingInterval => isValidPlanBillingInterval(i))
        : [],
      features: Array.isArray(r.features)
        ? r.features.filter((f): f is EntitlementFeature => isValidEntitlementFeature(f))
        : [],
      allowance_count: num(r.allowance_count),
    }));
  }

  /**
   * Assign a plan to an account. This is the one policy write on the admin
   * surface: it changes which entitlements an account resolves to, never usage
   * or billing. Existence/active checks and the binding swap happen inside the
   * database function under the actor re-check.
   */
  async assignPlan(
    actorId: string,
    accountId: string,
    planId: string,
  ): Promise<{ accountId: string; planId: string }> {
    await this.rpc<string>('seo_platform_admin_assign_plan', {
      p_actor: actorId,
      p_account: accountId,
      p_plan: planId,
    });
    return { accountId, planId };
  }

  /**
   * The effective product policy an account currently resolves to (P14): plan,
   * features and per-resource operator-funded allowance vs this-period
   * consumption/remaining. Reuses the exact read model the account owner sees,
   * after re-verifying the actor against the service-role-only admin registry,
   * so the operator inspects the same numbers enforcement uses and no second
   * accounting path exists.
   */
  async accountEntitlement(actorId: string, accountId: string): Promise<AccountEntitlementDto> {
    await this.rpc<null>('seo_assert_platform_admin', { p_actor: actorId });
    return this.entitlements.accountEntitlement(actorId, accountId);
  }
}
