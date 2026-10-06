/**
 * Entitlement & resource-allowance contracts (P13).
 *
 * P9/P11 provide technical resource protection: conservative ceilings that keep
 * expensive work bounded and attributable. P13 adds a product-policy layer on
 * top: an account has a plan, a plan has feature entitlements and
 * operator-funded resource allowances, and the effective product ceiling is
 * applied above (never above) the existing technical ceiling.
 *
 * This module is deliberately dependency-free and billing-free: it models
 * features, allowances, periods and the read model, but no prices, invoices,
 * payments, credits or wallets. Cost is a future derivation from usage facts +
 * pricing rules. See docs/p13-entitlement-foundation.md.
 */

import type { IsoDateTime } from './common.js';
import type { UsageCategory, UsageUnit } from './usageEvent.js';

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

/**
 * The closed set of product capabilities a plan can enable or disable. These
 * are real product surfaces, not speculative placeholders; adding a feature is
 * an explicit, reviewed change.
 */
export const ENTITLEMENT_FEATURES = [
  'api_access',
  'mcp_access',
  'ai_editing',
  'publishing',
  'designer',
  'composer',
] as const;
export type EntitlementFeature = (typeof ENTITLEMENT_FEATURES)[number];

// ---------------------------------------------------------------------------
// Allowances
// ---------------------------------------------------------------------------

/** The period an allowance resets over. `none` means no reset (lifetime/state). */
export const ALLOWANCE_PERIODS = ['day', 'week', 'month', 'year', 'none'] as const;
export type AllowancePeriod = (typeof ALLOWANCE_PERIODS)[number];

/** The scope an allowance is accounted against. Account is the money boundary. */
export const ALLOWANCE_SCOPES = ['account', 'project'] as const;
export type AllowanceScope = (typeof ALLOWANCE_SCOPES)[number];

/** Whether an allowance is currently enforced. */
export const ALLOWANCE_STATUSES = ['active', 'disabled'] as const;
export type AllowanceStatus = (typeof ALLOWANCE_STATUSES)[number];

/** One feature entitlement on a plan (or resolved for an account). */
export interface EntitlementFeatureDto {
  feature: EntitlementFeature;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Plan catalog, pricing & billing metadata (P15)
// ---------------------------------------------------------------------------

/** Billing intervals a plan may be offered on. Product metadata only. */
export const PLAN_BILLING_INTERVALS = ['monthly', 'yearly'] as const;
export type PlanBillingInterval = (typeof PLAN_BILLING_INTERVALS)[number];

/** Whether a plan's commercial price is a decision or still a draft. */
export const PLAN_PRICE_STATUSES = ['draft', 'final'] as const;
export type PlanPriceStatus = (typeof PLAN_PRICE_STATUSES)[number];

/**
 * Commercial price metadata for a plan. This is *product-catalog* data, not a
 * billing engine: it states what a plan is offered at and must never trigger
 * payment authorization, invoices or provider charges. Amounts are integer
 * minor units (`EUR 19.00` -> `1900`), never floating point; `null` means the
 * value is not yet decided, and `priceStatus: 'draft'` marks a plan whose price
 * is still a provisional product decision.
 */
export interface PlanPricingDto {
  /** ISO 4217 code, e.g. `EUR`; null when no currency has been decided. */
  currency: string | null;
  /** Monthly price in integer minor units; null when undecided. */
  monthlyPrice: number | null;
  /** Yearly price in integer minor units; null when undecided. */
  yearlyPrice: number | null;
  priceStatus: PlanPriceStatus;
  /** Optional display override, e.g. "Contact us" or "Free". */
  priceLabel: string | null;
}

/**
 * The customer-facing identity and commercial metadata of a plan, independent
 * of any account. This is what a plan is, never what an account has consumed.
 */
export interface PlanSummaryDto {
  key: string;
  name: string;
  displayName: string;
  description: string | null;
  isDefault: boolean;
  isPublic: boolean;
  sortOrder: number;
  pricing: PlanPricingDto;
  billingIntervals: PlanBillingInterval[];
}

/** One operator-funded resource allowance as configured on a plan (no usage). */
export interface PlanAllowanceDto {
  resource: string;
  unit: string;
  period: AllowancePeriod;
  scope: AllowanceScope;
  operatorFunded: boolean;
  byokExempt: boolean;
  status: AllowanceStatus;
  /** null = no product cap; 0 = not included; a number is the included amount. */
  allowance: number | null;
}

/** A plan as presented in the customer-facing catalog. */
export interface CustomerPlanDto extends PlanSummaryDto {
  features: EntitlementFeatureDto[];
  allowances: PlanAllowanceDto[];
}

/**
 * One operator-funded resource allowance resolved for an account in the current
 * period.
 *
 * `allowance === null` means "no product cap": the technical P9/P11 floor is the
 * only limit (the default product policy preserves the full product for every
 * authenticated user). `allowance === 0` means the resource is not included.
 * `remaining` mirrors that: null when the allowance is null, otherwise
 * `max(allowance - consumed, 0)`.
 */
export interface EntitlementAllowanceDto {
  resource: string;
  unit: string;
  period: AllowancePeriod;
  scope: AllowanceScope;
  operatorFunded: boolean;
  byokExempt: boolean;
  status: AllowanceStatus;
  allowance: number | null;
  consumed: number;
  remaining: number | null;
}

/** The period the resolved allowance figures apply to. */
export interface EntitlementPeriodDto {
  start: IsoDateTime;
  end: IsoDateTime;
}

/** The account's resolved entitlement/plan read model. */
export interface AccountEntitlementDto {
  plan: PlanSummaryDto;
  features: EntitlementFeatureDto[];
  allowances: EntitlementAllowanceDto[];
  period: EntitlementPeriodDto;
}

/** One plan as seen by a platform administrator (policy, no secrets). */
export interface PlatformAdminPlanDto {
  key: string;
  name: string;
  display_name: string;
  description: string | null;
  is_default: boolean;
  is_public: boolean;
  sort_order: number;
  status: string;
  currency: string | null;
  monthly_price: number | null;
  yearly_price: number | null;
  price_status: PlanPriceStatus;
  price_label: string | null;
  billing_intervals: PlanBillingInterval[];
  features: EntitlementFeature[];
  allowance_count: number;
}

// ---------------------------------------------------------------------------
// Entitlement resources
// ---------------------------------------------------------------------------

/**
 * The closed set of product resources an operator-funded allowance can be
 * defined over. This is *not* the technical `RESOURCE_KINDS` vocabulary: it is
 * the customer-facing consumption resource (what a plan sells), and each one
 * maps onto one or more raw usage categories/units via
 * `ENTITLEMENT_RESOURCE_SPEC`.
 *
 * `x_link_post` is deliberately separate from `publishing`: publishing is a
 * technical class (WordPress is user-funded and free), while an X post that
 * contains a link incurs a real per-post operator cost and is a monetizable
 * consumption resource.
 */
export const ENTITLEMENT_RESOURCES = [
  'ai_generation',
  'ai_image',
  'dataforseo_research',
  'media',
  'x_link_post',
] as const;
export type EntitlementResource = (typeof ENTITLEMENT_RESOURCES)[number];

/**
 * Who normally pays for a resource. `operator` is always server-funded;
 * `byok_or_operator` may be server-funded or funded by the user's own key
 * (BYOK), in which case a BYOK-exempt allowance is not consumed.
 */
export type EntitlementFundingModel = 'operator' | 'byok_or_operator';

/**
 * How one entitlement resource is counted from the append-only usage ledger.
 * This is the canonical registry entry for a product resource: display name,
 * measured ledger facts, funding model and the metering definition the UI and
 * enforcement both read from one place.
 */
export interface EntitlementResourceSpec {
  /** The usage category the resource is measured from. */
  category: UsageCategory;
  /**
   * Ledger units summed for this resource. There is deliberately no
   * "all units" fallback: counting an unfiltered category mixed sub-units
   * (e.g. `keyword` and `task` alongside `request`) and overstated usage, so
   * every resource now names the exact unit(s) that are one billable request.
   */
  units: readonly UsageUnit[];
  /** When true, only X publishing attempts whose metadata marks a link count. */
  xLinkOnly: boolean;
  /** Human label for the UI. */
  label: string;
  /** Product-facing unit label (not necessarily a raw ledger unit). */
  unitLabel: string;
  /** Which party normally funds the resource. */
  fundingModel: EntitlementFundingModel;
  /** Plain-language definition of exactly what one metered unit is. */
  metering: string;
}

/**
 * The single source of truth mapping an entitlement resource onto the existing
 * usage vocabulary. Consumption is derived from `seo_usage_events` (the one
 * ledger), never a second ledger. Where P12 left the customer-facing product
 * unit as a product decision, the raw canonical unit is used and the default
 * plan leaves the allowance uncapped (`null`).
 */
export const ENTITLEMENT_RESOURCE_SPEC: Record<EntitlementResource, EntitlementResourceSpec> = {
  ai_generation: {
    category: 'ai',
    units: ['input_token', 'output_token'],
    xLinkOnly: false,
    label: 'AI text',
    unitLabel: 'tokens',
    fundingModel: 'byok_or_operator',
    metering: 'One AI text call, measured in the input and output tokens the provider reports.',
  },
  ai_image: {
    category: 'media',
    units: ['image_generation'],
    xLinkOnly: false,
    label: 'AI image',
    unitLabel: 'images',
    fundingModel: 'byok_or_operator',
    metering: 'One generated image from the configured AI image model.',
  },
  dataforseo_research: {
    category: 'dataforseo',
    units: ['request', 'serp_request'],
    xLinkOnly: false,
    label: 'DataForSEO research',
    unitLabel: 'requests',
    fundingModel: 'byok_or_operator',
    metering: 'One billable DataForSEO provider request: a research call or a SERP retrieval.',
  },
  media: {
    category: 'media',
    units: ['request'],
    xLinkOnly: false,
    label: 'Stock media',
    unitLabel: 'searches',
    fundingModel: 'operator',
    metering: 'One external stock-media search request.',
  },
  x_link_post: {
    category: 'publishing',
    units: ['publish_attempt'],
    xLinkOnly: true,
    label: 'X link posts',
    unitLabel: 'link posts',
    fundingModel: 'operator',
    metering: 'One X publish attempt whose body contains a link.',
  },
};

/** The key of the default/base plan every account resolves when unbound. */
export const ENTITLEMENT_BASE_PLAN_KEY = 'base';

/** True when `value` is one of the closed entitlement resources. */
export function isValidEntitlementResource(value: unknown): value is EntitlementResource {
  return typeof value === 'string' && (ENTITLEMENT_RESOURCES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/** The half-open UTC window an allowance resets over. */
export interface AllowancePeriodWindow {
  /** Inclusive start. */
  start: IsoDateTime;
  /** Exclusive end. */
  end: IsoDateTime;
}

/**
 * Deterministic UTC period boundaries for an allowance, computed from a single
 * instant so enforcement and reporting agree without a stored period table.
 * Weeks start Monday (ISO). `none` is a lifetime window (epoch to far future).
 * Historical usage is never rewritten: changing the period only changes which
 * window future reads/enforcement use.
 */
export function resolveAllowancePeriod(period: AllowancePeriod, now: Date): AllowancePeriodWindow {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  if (period === 'day') {
    return iso(Date.UTC(year, month, day), Date.UTC(year, month, day + 1));
  }
  if (period === 'week') {
    const weekday = (now.getUTCDay() + 6) % 7;
    const monday = Date.UTC(year, month, day - weekday);
    return iso(monday, monday + 7 * 86_400_000);
  }
  if (period === 'month') {
    return iso(Date.UTC(year, month, 1), Date.UTC(year, month + 1, 1));
  }
  if (period === 'year') {
    return iso(Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1));
  }
  return iso(Date.UTC(1970, 0, 1), Date.UTC(9999, 11, 31));
}

function iso(startMs: number, endMs: number): AllowancePeriodWindow {
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

// ---------------------------------------------------------------------------
// Denial
// ---------------------------------------------------------------------------

/**
 * The stable code for a persistent product-policy denial (a plan feature is
 * disabled or an operator-funded allowance is exhausted). Kept distinct from
 * P9/P11 technical codes so the UI never tells a user to retry a condition that
 * will not change, and never tells a user to upgrade for a transient queue.
 */
export const ENTITLEMENT_LIMIT_CODE = 'entitlement_limit' as const;

/** Secret-free context attached to an entitlement denial. */
export interface EntitlementErrorDetails {
  resource: EntitlementResource;
  scope: 'account';
}

// ---------------------------------------------------------------------------
// Bounds and guards
// ---------------------------------------------------------------------------

export const ENTITLEMENT_RESOURCE_MAX_CHARS = 40;
export const ENTITLEMENT_UNIT_MAX_CHARS = 32;
export const PLAN_DISPLAY_NAME_MAX_CHARS = 120;
export const PLAN_PRICE_LABEL_MAX_CHARS = 40;

/** True when `value` is one of the closed entitlement features. */
export function isValidEntitlementFeature(value: unknown): value is EntitlementFeature {
  return typeof value === 'string' && (ENTITLEMENT_FEATURES as readonly string[]).includes(value);
}

/** True when `value` is one of the closed allowance periods. */
export function isValidAllowancePeriod(value: unknown): value is AllowancePeriod {
  return typeof value === 'string' && (ALLOWANCE_PERIODS as readonly string[]).includes(value);
}

/** True when `value` is one of the closed allowance scopes. */
export function isValidAllowanceScope(value: unknown): value is AllowanceScope {
  return typeof value === 'string' && (ALLOWANCE_SCOPES as readonly string[]).includes(value);
}

/** True when `value` is one of the closed plan billing intervals. */
export function isValidPlanBillingInterval(value: unknown): value is PlanBillingInterval {
  return typeof value === 'string' && (PLAN_BILLING_INTERVALS as readonly string[]).includes(value);
}

/** True when `value` is one of the closed plan price statuses. */
export function isValidPlanPriceStatus(value: unknown): value is PlanPriceStatus {
  return typeof value === 'string' && (PLAN_PRICE_STATUSES as readonly string[]).includes(value);
}
