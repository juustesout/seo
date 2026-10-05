/**
 * Resource-protection vocabulary (P9).
 *
 * P9 adds a server-side resource admission layer so expensive and potentially
 * abusive operations are *bounded and attributable*. This module holds only the
 * closed vocabulary shared by the API (enforcement + denial recording) and the
 * web UI (rendering a resource error). It deliberately contains no enforcement
 * logic, no limits and no pricing.
 *
 * This is NOT monetization: there are no plans, tiers, credits, prices,
 * entitlements or paid/free feature distinctions. See
 * docs/p9-resource-protection.md. The vocabulary is meant to remain useful
 * whether the eventual product is free, BYOK, usage-based or subscription-based.
 *
 * Reuse the usage vocabulary wherever practical: a protected resource is a
 * coarse, stable classification of the external capability being consumed, so
 * an admission denial and the eventual usage event can be reasoned about
 * together. It is intentionally smaller than the set of concrete provider
 * operations.
 */

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

/**
 * The closed set of resources the admission layer understands.
 *
 * This mirrors the usage-event categories/units (ai, dataforseo, google, job,
 * publishing, media) at the granularity that admission needs: someone asking
 * "may this account consume this resource?" must be able to name it stably, and
 * the answer must not depend on provider-internal operation names.
 */
export const RESOURCE_KINDS = [
  'ai_generation',
  'ai_embedding',
  'ai_image',
  'dataforseo_research',
  'dataforseo_serp',
  'dataforseo_keywords',
  'google_search_console',
  'google_analytics',
  'google_ads',
  'background_job',
  'publishing',
  'media',
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** The scope a resource ceiling is evaluated against. */
export const RESOURCE_SCOPES = ['project', 'account'] as const;
export type ResourceScope = (typeof RESOURCE_SCOPES)[number];

// ---------------------------------------------------------------------------
// Structured errors
// ---------------------------------------------------------------------------

/**
 * Stable machine-readable codes for resource-protection denials. Kept separate
 * from generic bad_request/rate_limited so the UI can explain *what* was
 * bounded and *how* to proceed, without leaking queue internals.
 *
 * - `queue_limit`          too much work is already queued for the scope;
 * - `resource_concurrency` too much work is already running for the scope;
 * - `resource_limit`       too much equivalent work was requested in a window.
 *
 * Only distinctions the frontend actually benefits from are modelled; adding a
 * code is an explicit reviewable change.
 */
export const RESOURCE_ERROR_CODES = ['resource_limit', 'resource_concurrency', 'queue_limit'] as const;
export type ResourceErrorCode = (typeof RESOURCE_ERROR_CODES)[number];

/**
 * Secret-free context attached to a resource denial. Never carries counts,
 * limits, queue internals, credentials or another user's usage.
 */
export interface ResourceErrorDetails {
  resource: ResourceKind;
  scope: ResourceScope;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** True when `value` is one of the closed resource kinds. */
export function isValidResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && (RESOURCE_KINDS as readonly string[]).includes(value);
}

/** True when `value` is one of the closed resource scopes. */
export function isValidResourceScope(value: unknown): value is ResourceScope {
  return typeof value === 'string' && (RESOURCE_SCOPES as readonly string[]).includes(value);
}

/** True when `value` is one of the closed resource error codes. */
export function isResourceErrorCode(value: unknown): value is ResourceErrorCode {
  return typeof value === 'string' && (RESOURCE_ERROR_CODES as readonly string[]).includes(value);
}
