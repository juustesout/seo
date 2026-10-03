/**
 * Google Ads logical-operation usage accounting (P5).
 *
 * Counts one real Google Ads API request as one `ads_request` fact under the
 * shared `google` category, mirroring GSC's and GA4's per-request accounting.
 * The observer fires at the client's transport seams (`get`, `search`), so
 * every actual request - including the retried request after a 401 refresh -
 * is counted exactly once. The userinfo identity lookup is not a Google Ads
 * API request and is never counted.
 *
 * Only project-scoped reads (search-term/keyword reports) form a fact: an
 * account-scoped customer discovery or binding validation has no real project
 * id, so it emits nothing rather than a fabricated project fact. Emission is
 * best-effort (R5.10.3/R5.10.4 convention): a ledger append failure is logged
 * and swallowed so it can never turn a real Ads result or error into a usage
 * failure.
 */

import {
  usageEventIdempotencyKey,
  type NewUsageEvent,
  type ProviderUsageContext,
} from '@seo/contracts';
import { appendUsage } from '../../services/usageInstrumentation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[a-z0-9_]{1,64}$/;

/** Canonical scope + usage correlation available to a Google Ads request. */
export interface AdsUsageScope {
  usage: ProviderUsageContext;
  projectId: string;
  userId: string | null;
}

/**
 * The usage fact for one real Google Ads API request, or null when the scope
 * cannot form a valid event (non-UUID project, invalid operation token).
 */
export function buildAdsRequestUsageEvent(
  args: AdsUsageScope & { operation: string; success: boolean },
): NewUsageEvent | null {
  const { usage, projectId, userId, operation, success } = args;
  if (!UUID_RE.test(projectId)) return null;
  if (!TOKEN_RE.test(operation)) return null;
  return {
    accountId: null,
    projectId,
    userId,
    category: 'google',
    provider: 'ads',
    operation,
    quantity: 1,
    unit: 'ads_request',
    success,
    sourceId: usage.sourceId,
    idempotencyKey: usageEventIdempotencyKey({
      category: 'google',
      provider: 'ads',
      operation,
      unit: 'ads_request',
      sourceId: usage.sourceId,
      occurrence: usage.nextOccurrence(operation),
    }),
  };
}

/**
 * Best-effort append of one request's usage fact. Reuses the shared
 * `appendUsage` seam: a persistence failure is logged and swallowed, never
 * propagated into the Google Ads call.
 */
export async function emitAdsRequestUsage(
  args: AdsUsageScope & { operation: string; success: boolean },
): Promise<void> {
  const event = buildAdsRequestUsageEvent(args);
  if (!event) return;
  await appendUsage(args.usage.sink, [event]);
}
