/**
 * Entitlement service (P13).
 *
 * The application-side half of the product-policy layer that sits ABOVE the
 * P9/P11 technical resource protection. P9/P11 ask "is this technically allowed
 * right now?"; this service asks "does the account's plan include this
 * consumption, and is the operator-funded allowance for this period used up?".
 *
 * It never replaces or weakens P9/P11:
 *
 *   - P9/P11 ceilings remain the floor and are always evaluated independently;
 *   - a plan allowance can only ever *lower* the effective limit, because the
 *     admission rejection happens before any provider work;
 *   - where no policy applies (no plan binding, `allowance is null`, a
 *     user-funded resource, or BYOK on an exempt resource) this service returns
 *     `null` and P9/P11 remain the only limit.
 *
 * Consumption is derived from the one append-only `seo_usage_events` ledger via
 * `seo_entitlement_consumed` (never a second ledger), and admission is atomic in
 * the database (`seo_admit_entitlement`, advisory lock + reservation). This is
 * NOT billing: no prices, credits, invoices or payments. See
 * docs/p13-entitlement-foundation.md.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  ENTITLEMENT_FEATURES,
  ENTITLEMENT_RESOURCE_SPEC,
  isValidEntitlementResource,
  resolveAllowancePeriod,
  type AccountEntitlementDto,
  type AllowancePeriod,
  type EntitlementAllowanceDto,
  type EntitlementFeature,
  type EntitlementFeatureDto,
  type EntitlementResource,
  type FundingSource,
  type ResourceKind,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';

/**
 * Map a P9/P11 technical resource onto the product resource whose allowance it
 * consumes, or null when the resource is not entitlement-enforced (user-funded,
 * infrastructure, or bundled). This is the single join between the two layers.
 */
const ENTITLEMENT_RESOURCE_FOR_RESOURCE_KIND: Partial<Record<ResourceKind, EntitlementResource>> = {
  ai_generation: 'ai_generation',
  ai_image: 'ai_image',
  dataforseo_research: 'dataforseo_research',
  dataforseo_serp: 'dataforseo_research',
  dataforseo_keywords: 'dataforseo_research',
  media: 'media',
};

/** The product resource a technical resource consumes, or null when none applies. */
export function entitlementResourceFor(kind: ResourceKind): EntitlementResource | null {
  return ENTITLEMENT_RESOURCE_FOR_RESOURCE_KIND[kind] ?? null;
}

/** A synchronous operation asking to be admitted against a product allowance. */
export interface EntitlementAdmissionRequest {
  projectId: string;
  userId: string | null;
  resource: EntitlementResource;
  amount?: number;
  /**
   * Funding attribution. When omitted the service resolves it (AI via the same
   * credential precedence the usage ledger uses). `null` means unattributable:
   * no operator-funded allowance is consumed.
   */
  fundingSource?: FundingSource | null;
  ttlSeconds?: number;
}

/** Resolves which credential would fund a resource for a project pre-call. */
export type FundingResolver = (projectId: string, resource: EntitlementResource) => Promise<FundingSource | null>;

/**
 * The minimal seam the technical admission layer depends on. Kept structural so
 * P9/P11 can sit above the entitlement layer without importing its whole shape,
 * and so tests can substitute a double without a database.
 */
export interface EntitlementAdmitter {
  admit(request: EntitlementAdmissionRequest): Promise<string | null>;
  release(reservationId: string | null | undefined): Promise<void>;
}

interface PlanRow {
  id: string;
  key: string;
  name: string;
  is_default: boolean;
  status: string;
}

interface PolicyRow {
  resource: string;
  unit: string;
  period: string;
  scope: string;
  operator_funded: boolean;
  byok_exempt: boolean;
  status: string;
  allowance: number | null;
}

interface FeatureRow {
  feature: string;
  enabled: boolean;
}

interface ReservationRow {
  resource: string;
  amount: number | string;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Recognise the entitlement admission denial raised by `seo_admit_entitlement`.
 * Returns false for any other error so genuinely broken admission surfaces as
 * an internal error instead of being misreported as a plan restriction.
 */
export function isEntitlementDenial(err: unknown): boolean {
  const rec = (err ?? {}) as { code?: unknown; message?: unknown };
  if (typeof rec.code === 'string' && rec.code === 'SE004') return true;
  const message = err instanceof Error ? err.message : typeof rec.message === 'string' ? rec.message : '';
  return message.includes('seo_entitlement_limit');
}

/** The persistent, secret-free API error for an exhausted/absent allowance. */
export function entitlementError(resource: EntitlementResource): ApiError {
  const spec = ENTITLEMENT_RESOURCE_SPEC[resource];
  return new ApiError(403, 'entitlement_limit', `${spec.label} is not available on the current plan for this period.`, {
    resource,
    scope: 'account',
  });
}

export class EntitlementService implements EntitlementAdmitter {
  constructor(
    private readonly sb: SupabaseClient,
    private readonly resolveFunding?: FundingResolver,
  ) {}

  // -------------------------------------------------------------------------
  // Admission
  // -------------------------------------------------------------------------

  /**
   * Admit one operation against the account's product allowance.
   *
   * Returns the reservation id to release when done, or `null` when no product
   * limit applies (no plan binding, no active policy, no product cap, a
   * user-funded resource, or BYOK on an exempt resource) - in which case only
   * the P9/P11 technical ceiling remains. Throws a 403 `entitlement_limit` when
   * the allowance for the current period is exhausted.
   */
  async admit(request: EntitlementAdmissionRequest): Promise<string | null> {
    const accountId = await this.accountForProject(request.projectId);
    if (!accountId) return null;

    const plan = await this.activePlan(accountId);
    if (!plan) return null;

    const policy = await this.resourcePolicy(plan.id, request.resource);
    if (!policy || !policy.operator_funded || policy.status !== 'active') return null;
    // No product cap: the technical ceiling is the only limit.
    if (policy.allowance === null) return null;

    const funding =
      request.fundingSource !== undefined
        ? request.fundingSource
        : this.resolveFunding
          ? await this.resolveFunding(request.projectId, request.resource)
          : null;
    // BYOK on an exempt resource costs the operator nothing, so it consumes no
    // operator-funded allowance (it is still bounded technically).
    if (funding === 'byok' && policy.byok_exempt) return null;
    // Unattributable funding is not assumed to be operator-funded.
    if (funding === null) return null;

    const period = resolveAllowancePeriod(policy.period as AllowancePeriod, new Date());
    const spec = ENTITLEMENT_RESOURCE_SPEC[request.resource];
    const { data, error } = await this.sb.rpc('seo_admit_entitlement', {
      p_account_id: accountId,
      p_project_id: request.projectId,
      p_user_id: request.userId,
      p_resource: request.resource,
      p_category: spec.category,
      p_units: spec.units.length > 0 ? [...spec.units] : null,
      p_x_link_only: spec.xLinkOnly,
      p_amount: request.amount ?? 1,
      p_period_start: period.start,
      p_period_end: period.end,
      p_allowance: policy.allowance,
      p_ttl_seconds: request.ttlSeconds ?? 900,
    });
    if (error) {
      if (isEntitlementDenial(error)) throw entitlementError(request.resource);
      logger.error({ error, resource: request.resource }, 'entitlement admission failed');
      throw new ApiError(500, 'entitlement_admission_failed', 'Could not evaluate plan allowance.');
    }
    return String(data);
  }

  /** Release an allowance reservation once the operation has finished. Best-effort. */
  async release(reservationId: string | null | undefined): Promise<void> {
    if (!reservationId) return;
    try {
      const { error } = await this.sb.rpc('seo_release_entitlement', { p_reservation_id: reservationId });
      if (error) logger.warn({ error }, 'entitlement reservation release failed');
    } catch (err) {
      logger.warn({ err }, 'entitlement reservation release failed');
    }
  }

  /**
   * Run `fn` under an allowance reservation, releasing it afterwards whether
   * `fn` succeeds or throws. A denial from `admit` propagates before `fn` runs.
   */
  async withAdmission<T>(request: EntitlementAdmissionRequest, fn: () => Promise<T>): Promise<T> {
    const reservationId = await this.admit(request);
    try {
      return await fn();
    } finally {
      await this.release(reservationId);
    }
  }

  // -------------------------------------------------------------------------
  // Read model
  // -------------------------------------------------------------------------

  /**
   * The account's resolved entitlement read model: plan, features, per-resource
   * operator-funded allowance vs current-period consumption and remaining. The
   * caller must have already authorized `actorUserId` as the account owner; the
   * `seo_entitlement_consumed`/policy reads are service-role and scoped to the
   * exact account id.
   */
  async accountEntitlement(actorUserId: string, accountId: string): Promise<AccountEntitlementDto> {
    const plan = await this.activePlan(accountId);
    if (!plan) throw new ApiError(500, 'entitlement_state_invalid', 'Account has no resolvable plan.');

    const [featureRows, policyRows, reservationRows] = await Promise.all([
      this.features(plan.id),
      this.policies(plan.id),
      this.activeReservations(accountId),
    ]);

    const held = new Map<string, number>();
    for (const r of reservationRows) held.set(r.resource, (held.get(r.resource) ?? 0) + num(r.amount));

    const now = new Date();
    let accountPeriod: AllowancePeriod = 'month';
    const allowances: EntitlementAllowanceDto[] = [];
    for (const policy of policyRows) {
      if (!isValidEntitlementResource(policy.resource)) continue;
      const resource = policy.resource;
      const period = policy.period as AllowancePeriod;
      accountPeriod = period;
      const window = resolveAllowancePeriod(period, now);
      const consumedLedger = await this.consumed(resource, accountId, window.start, window.end);
      const consumed = consumedLedger + (held.get(resource) ?? 0);
      const allowance = policy.allowance;
      allowances.push({
        resource,
        unit: policy.unit,
        period,
        scope: policy.scope === 'project' ? 'project' : 'account',
        operatorFunded: policy.operator_funded,
        byokExempt: policy.byok_exempt,
        status: policy.status === 'disabled' ? 'disabled' : 'active',
        allowance,
        consumed,
        remaining: allowance === null ? null : Math.max(allowance - consumed, 0),
      });
    }

    const features: EntitlementFeatureDto[] = ENTITLEMENT_FEATURES.map((feature) => ({
      feature: feature as EntitlementFeature,
      enabled: featureRows.find((f) => f.feature === feature)?.enabled ?? false,
    }));

    return {
      plan: { key: plan.key, name: plan.name, isDefault: plan.is_default },
      features,
      allowances,
      period: resolveAllowancePeriod(accountPeriod, now),
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async accountForProject(projectId: string): Promise<string | null> {
    const { data } = await this.sb
      .from('seo_projects')
      .select('account_id')
      .eq('id', projectId)
      .maybeSingle<{ account_id: string | null }>();
    return data?.account_id ?? null;
  }

  /** The account's active plan, falling back to the default plan when unbound. */
  private async activePlan(accountId: string): Promise<PlanRow | null> {
    const { data, error } = await this.sb
      .from('seo_account_entitlements')
      .select('seo_plans(id, key, name, is_default, status)')
      .eq('account_id', accountId)
      .is('effective_to', null)
      .maybeSingle<{ seo_plans: PlanRow | PlanRow[] | null }>();
    if (error) {
      logger.error({ error, accountId }, 'account entitlement plan lookup failed');
      throw new ApiError(500, 'storage_error', 'Could not read the account plan.');
    }
    const embedded = data?.seo_plans ?? null;
    const plan = Array.isArray(embedded) ? (embedded[0] ?? null) : embedded;
    if (plan && plan.status === 'active') return plan;
    const { data: fallback } = await this.sb
      .from('seo_plans')
      .select('id, key, name, is_default, status')
      .eq('is_default', true)
      .eq('status', 'active')
      .maybeSingle<PlanRow>();
    return fallback ?? null;
  }

  private async resourcePolicy(planId: string, resource: EntitlementResource): Promise<PolicyRow | null> {
    const { data, error } = await this.sb
      .from('seo_resource_policies')
      .select('resource, unit, period, scope, operator_funded, byok_exempt, status, allowance')
      .eq('plan_id', planId)
      .eq('resource', resource)
      .maybeSingle<PolicyRow>();
    if (error) {
      logger.error({ error, resource }, 'resource policy lookup failed');
      throw new ApiError(500, 'storage_error', 'Could not read the plan allowance.');
    }
    return data ?? null;
  }

  private async features(planId: string): Promise<FeatureRow[]> {
    const { data } = await this.sb
      .from('seo_plan_features')
      .select('feature, enabled')
      .eq('plan_id', planId);
    return (data ?? []) as FeatureRow[];
  }

  private async policies(planId: string): Promise<PolicyRow[]> {
    const { data } = await this.sb
      .from('seo_resource_policies')
      .select('resource, unit, period, scope, operator_funded, byok_exempt, status, allowance')
      .eq('plan_id', planId)
      .eq('status', 'active')
      .order('resource', { ascending: true });
    return (data ?? []) as PolicyRow[];
  }

  private async activeReservations(accountId: string): Promise<ReservationRow[]> {
    const { data } = await this.sb
      .from('seo_entitlement_reservations')
      .select('resource, amount')
      .eq('account_id', accountId)
      .is('released_at', null)
      .gt('expires_at', new Date().toISOString());
    return (data ?? []) as ReservationRow[];
  }

  private async consumed(
    resource: EntitlementResource,
    accountId: string,
    from: string,
    to: string,
  ): Promise<number> {
    const spec = ENTITLEMENT_RESOURCE_SPEC[resource];
    const { data, error } = await this.sb.rpc('seo_entitlement_consumed', {
      p_account_id: accountId,
      p_category: spec.category,
      p_units: spec.units.length > 0 ? [...spec.units] : null,
      p_x_link_only: spec.xLinkOnly,
      p_from: from,
      p_to: to,
    });
    if (error) {
      logger.error({ error, resource }, 'entitlement consumption read failed');
      throw new ApiError(500, 'storage_error', 'Could not read current consumption.');
    }
    return num(data);
  }
}
