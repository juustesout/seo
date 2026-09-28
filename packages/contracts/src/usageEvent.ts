/**
 * Canonical usage-event vocabulary (R5.10.1).
 *
 * A usage event is an immutable, append-only fact about an externally
 * measurable resource that was consumed - AI tokens, DataForSEO tasks/SERPs,
 * background job executions, publish attempts or media acquisitions. It is an
 * *evidence projection* of consumption, not the domain record of what happened
 * to an application object.
 *
 * The distinction is deliberate and load-bearing:
 *
 *   domain record = what happened to the application object
 *   usage event   = what externally measurable resource was consumed
 *
 * Existing domain records (seo_sync_jobs lifecycle, seo_publications attempts,
 * seo_media provenance, AI provider `usage`, DataForSEO task ids,
 * account/project ownership) stay authoritative. A usage event points back at
 * them via `sourceId`; it never replaces or duplicates them.
 *
 * A usage event records facts only. It must never encode subscription plans,
 * credits, wallets, invoices, payment state, quotas, pricing or calculated
 * monetary cost - cost is a future derivation from usage facts + pricing rules.
 *
 * Dependency-free by convention: plain types with hand-rolled `isValid...`
 * guards. No Supabase, provider SDK, database access or runtime side effects.
 */

import type { IsoDateTime } from './common.js';

// ---------------------------------------------------------------------------
// Categories (closed vocabulary - first version)
// ---------------------------------------------------------------------------

/**
 * What kind of external resource the event consumed. Closed for the first
 * version by design: adding a category is an explicit, reviewed change, never a
 * speculative placeholder.
 *
 * `dataforseo` is the platform's external SEO data-API category. The first
 * external data providers are DataForSEO (`provider = dataforseo`) and Google
 * Search Console (`provider = gsc`, `unit = gsc_request`); further external
 * data APIs are expected to land here as well.
 */
export const USAGE_CATEGORIES = ['ai', 'dataforseo', 'job', 'publishing', 'media'] as const;
export type UsageCategory = (typeof USAGE_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Units (closed vocabulary - first version)
// ---------------------------------------------------------------------------

/**
 * The unit `quantity` is expressed in. `quantity + unit` must be unambiguous:
 * input and output tokens are distinct units rather than a generic "tokens"
 * bucket, and a SERP request is distinct from a generic "request".
 *
 * Duration is deliberately NOT a unit - it is evidence, never cost.
 */
export const USAGE_UNITS = [
  'request',
  'task',
  'keyword',
  'serp_request',
  'gsc_request',
  'input_token',
  'output_token',
  'image_generation',
  'asset',
  'publish_attempt',
  'job',
] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

// ---------------------------------------------------------------------------
// Canonical event
// ---------------------------------------------------------------------------

/**
 * One immutable consumption fact.
 *
 * Scope mirrors the existing account/project hierarchy: `accountId` and
 * `projectId` are the canonical `seo_accounts.id` / `seo_projects.id` (never
 * derived from each other), and `userId` is the acting `auth.users.id` where
 * one exists. Any of the three may be null when the operation genuinely has no
 * such scope - background jobs and worker-originated work have no acting user.
 *
 * `provider` identifies the external/internal resource provider (reuse the
 * `PROVIDER_IDS` tokens where they apply: `openai`, `dataforseo`, `gsc`,
 * `wordpress`, `unsplash`). `operation` identifies the concrete operation
 * (`chat`, `embed`, `serp_live`, `keyword_research`, `publish`,
 * `image_generate`, `media_search`, ...). Both are open strings on purpose:
 * provider-specific operations must not force a global enum.
 *
 * `success` is false for failed attempts, which are still meaningful usage
 * facts. `quantity` is a non-negative integer count (every unit in the
 * vocabulary is countable) and may be 0 when a failed attempt consumed nothing
 * measurable.
 *
 * `sourceId` is the correlation handle back to the originating domain record or
 * provider attempt (job id, publication id, media id, DataForSEO task id, AI
 * call id, ...) so R5.10.2 can trace and de-duplicate. `metadata` holds
 * bounded, secret-free context (model, retryCount, durationMs, taskCount,
 * keywordCount, ...) - never an escape hatch for core semantics.
 */
export interface UsageEvent {
  id: string;
  occurredAt: IsoDateTime;

  accountId: string | null;
  projectId: string | null;
  userId: string | null;

  category: UsageCategory;
  provider: string;
  operation: string;

  quantity: number;
  unit: UsageUnit;

  success: boolean;

  sourceId: string | null;

  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const USAGE_PROVIDER_MAX_CHARS = 64;
export const USAGE_OPERATION_MAX_CHARS = 64;
export const USAGE_SOURCE_ID_MAX_CHARS = 200;
export const USAGE_OCCURRED_AT_MAX_CHARS = 100;
export const USAGE_EVENT_IDEMPOTENCY_KEY_MAX_CHARS = 512;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[a-z0-9_]+$/;

const USAGE_EVENT_KEYS: ReadonlySet<string> = new Set([
  'id',
  'occurredAt',
  'accountId',
  'projectId',
  'userId',
  'category',
  'provider',
  'operation',
  'quantity',
  'unit',
  'success',
  'sourceId',
  'metadata',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isToken(value: unknown, max: number): value is string {
  return isBoundedText(value, max) && TOKEN_RE.test(value);
}

function isNullableUuid(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && UUID_RE.test(value));
}

function isNullableBoundedText(value: unknown, max: number): value is string | null {
  return value === null || isBoundedText(value, max);
}

/** True when `value` is one of the closed usage categories. */
export function isValidUsageCategory(value: unknown): value is UsageCategory {
  return typeof value === 'string' && (USAGE_CATEGORIES as readonly string[]).includes(value);
}

/** True when `value` is one of the closed usage units. */
export function isValidUsageUnit(value: unknown): value is UsageUnit {
  return typeof value === 'string' && (USAGE_UNITS as readonly string[]).includes(value);
}

/** True when `value` is a non-negative integer quantity. */
export function isValidUsageQuantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** True when `value` is a bounded, secret-free metadata bag (plain object). */
export function isValidUsageMetadata(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

/**
 * True when `value` is a complete, well-formed usage event. Shape only: it does
 * not enforce category/unit pairings (those are documented semantics) and it
 * does not inspect metadata values (secrets are a writer obligation, not a
 * shape) beyond requiring a plain object.
 */
export function isValidUsageEvent(value: unknown): value is UsageEvent {
  if (!isPlainObject(value) || !hasOnlyKeys(value, USAGE_EVENT_KEYS)) return false;
  if (typeof value.id !== 'string' || !UUID_RE.test(value.id)) return false;
  if (!isBoundedText(value.occurredAt, USAGE_OCCURRED_AT_MAX_CHARS)) return false;
  if (!isNullableUuid(value.accountId)) return false;
  if (!isNullableUuid(value.projectId)) return false;
  if (!isNullableUuid(value.userId)) return false;
  if (!isValidUsageCategory(value.category)) return false;
  if (!isToken(value.provider, USAGE_PROVIDER_MAX_CHARS)) return false;
  if (!isToken(value.operation, USAGE_OPERATION_MAX_CHARS)) return false;
  if (!isValidUsageQuantity(value.quantity)) return false;
  if (!isValidUsageUnit(value.unit)) return false;
  if (typeof value.success !== 'boolean') return false;
  if (!isNullableBoundedText(value.sourceId, USAGE_SOURCE_ID_MAX_CHARS)) return false;
  if (!isValidUsageMetadata(value.metadata)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Write and read shapes (R5.10.2 append-only ledger)
// ---------------------------------------------------------------------------

/**
 * The write shape: a fact the caller wants recorded. `id` and `occurredAt` are
 * assigned when absent; `metadata` defaults to `{}`. `idempotencyKey` is an
 * explicit override for the derived key (see `usageEventIdempotencyKey`).
 */
export type NewUsageEvent = Omit<UsageEvent, 'id' | 'occurredAt' | 'metadata'> & {
  id?: string;
  occurredAt?: IsoDateTime;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string | null;
};

/**
 * The minimal append surface a producer depends on (R5.10.2 store, R5.10.4
 * provider/job instrumentation). Deliberately write-only: a producer must not be
 * able to read back or mutate the ledger, so it depends on this narrow type
 * instead of the full store. `UsageEventStore.append` is structurally compatible.
 */
export interface UsageEventSink {
  append(events: readonly NewUsageEvent[]): Promise<{ inserted: number; duplicates: number }>;
}

/** Read filter over the ledger. A scope (account or project) is required. */
export interface UsageEventFilter {
  accountId?: string | null;
  projectId?: string | null;
  category?: UsageCategory;
  provider?: string;
  operation?: string;
  unit?: UsageUnit;
  success?: boolean;
  sourceId?: string;
  occurredFrom?: IsoDateTime;
  occurredTo?: IsoDateTime;
  limit?: number;
}

/** Fixed aggregate shape returned by the ledger (category/provider/operation/unit). */
export interface UsageAggregate {
  category: UsageCategory;
  provider: string;
  operation: string;
  unit: UsageUnit;
  quantity: number;
  eventCount: number;
}

/**
 * The stable usage report returned by the read surface (R5.10.8). This is the
 * one shape both the project and account endpoints return and the shape the web
 * view (and future MCP tools) consume: the exact scope that was read plus the
 * aggregate rows for it. It never carries raw events, cost, pricing or any other
 * derived/forecast value - cost is a future derivation from usage + pricing.
 */
export interface UsageReportDto {
  scope: {
    accountId: string | null;
    projectId: string | null;
  };
  totals: UsageAggregate[];
}

/** The inputs a deterministic ledger idempotency key is derived from. */
export interface UsageIdempotencyParts {
  category: UsageCategory;
  provider: string;
  operation: string;
  unit: UsageUnit;
  sourceId: string | null;
  /** Disambiguates several facts of the same kind within one external attempt. */
  occurrence?: number;
}

/**
 * The deterministic ledger idempotency key (R5.10.2):
 *
 *   v1|<category>|<provider>|<operation>|<unit>|<sourceId>|<occurrence ?? 0>
 *
 * Returns null when there is no `sourceId`: an event that is not tied to a
 * stable external attempt identity cannot be honestly de-duplicated. Scope
 * (project/account) is enforced by the DB unique indexes, not by this string.
 * Callers may override the derived key explicitly when a stable identity exists
 * outside `sourceId`; such a key must be namespaced by the caller.
 */
export function usageEventIdempotencyKey(parts: UsageIdempotencyParts): string | null {
  if (parts.sourceId === null || parts.sourceId.length === 0) return null;
  const occurrence = parts.occurrence ?? 0;
  return `v1|${parts.category}|${parts.provider}|${parts.operation}|${parts.unit}|${parts.sourceId}|${occurrence}`;
}
