/**
 * Google Analytics (GA4) logical-operation usage accounting (P4.5).
 *
 * Counts one real Analytics Admin/Data API request as one `ga4_request` fact
 * under the shared `google` category, mirroring GSC's per-request accounting.
 * The observer fires at the client's single `request()` seam, so every actual
 * request - including the retried request after a 401 refresh - is counted
 * exactly once. The userinfo identity lookup is not an Analytics API request
 * and is never counted.
 *
 * Only project-scoped reads (the page-traffic report) form a fact: an
 * account-scoped property discovery has no real project id, so it emits nothing
 * rather than a fabricated project fact. Emission is best-effort
 * (R5.10.3/R5.10.4 convention): a ledger append failure is logged and swallowed
 * so it can never turn a real Analytics result or error into a usage failure.
 */

import {
  usageEventIdempotencyKey,
  type NewUsageEvent,
  type ProviderUsageContext,
} from '@seo/contracts';
import { appendUsage } from '../../services/usageInstrumentation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[a-z0-9_]{1,64}$/;

/** Canonical scope + usage correlation available to a GA4 request. */
export interface Ga4UsageScope {
  usage: ProviderUsageContext;
  projectId: string;
  userId: string | null;
}

/**
 * The usage fact for one real GA4 API request, or null when the scope cannot
 * form a valid event (non-UUID project, invalid operation token).
 */
export function buildGa4RequestUsageEvent(
  args: Ga4UsageScope & { operation: string; success: boolean },
): NewUsageEvent | null {
  const { usage, projectId, userId, operation, success } = args;
  if (!UUID_RE.test(projectId)) return null;
  if (!TOKEN_RE.test(operation)) return null;
  return {
    accountId: null,
    projectId,
    userId,
    category: 'google',
    provider: 'ga4',
    operation,
    quantity: 1,
    unit: 'ga4_request',
    success,
    sourceId: usage.sourceId,
    idempotencyKey: usageEventIdempotencyKey({
      category: 'google',
      provider: 'ga4',
      operation,
      unit: 'ga4_request',
      sourceId: usage.sourceId,
      occurrence: usage.nextOccurrence(operation),
    }),
  };
}

/**
 * Best-effort append of one request's usage fact. Reuses the shared
 * `appendUsage` seam: a persistence failure is logged and swallowed, never
 * propagated into the GA4 call.
 */
export async function emitGa4RequestUsage(
  args: Ga4UsageScope & { operation: string; success: boolean },
): Promise<void> {
  const event = buildGa4RequestUsageEvent(args);
  if (!event) return;
  await appendUsage(args.usage.sink, [event]);
}
