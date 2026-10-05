/**
 * GSC logical-operation usage accounting (R5.10.5).
 *
 * Counts one Search Console API request as one `gsc_request` fact. Unlike the
 * DataForSEO adapter (whose low-level client mixes auth, retries and polling),
 * `GscApiClient.request()` is a GSC-specific 1:1 request boundary: one call,
 * one fetch, no internal retry. So the fact is emitted at the request seam and
 * every actual request - including the second request of an `apiWithRefresh`
 * 401-refresh-retry - is counted exactly once. OAuth token calls to
 * oauth2.googleapis.com are not Search Console requests and are never counted.
 *
 * Emission is best-effort (R5.10.3/R5.10.4 convention): a ledger append failure
 * is logged and swallowed so it can never turn a real GSC result or error into a
 * usage failure.
 */

import {
  usageEventIdempotencyKey,
  type NewUsageEvent,
  type ProviderUsageContext,
} from '@seo/contracts';
import { appendUsage } from '../../services/usageInstrumentation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[a-z0-9_]{1,64}$/;

/** Canonical scope + usage correlation available to a GSC request. */
export interface GscUsageScope {
  usage: ProviderUsageContext;
  projectId: string;
  userId: string | null;
}

/**
 * The usage fact for one real GSC API request, or null when the scope cannot
 * form a valid event (non-UUID project, invalid operation token). A malformed
 * fact must never be emitted - so account-scoped calls that carry no real
 * project id correctly emit nothing rather than a fabricated project fact.
 */
export function buildGscRequestUsageEvent(
  args: GscUsageScope & { operation: string; success: boolean },
): NewUsageEvent | null {
  const { usage, projectId, userId, operation, success } = args;
  if (!UUID_RE.test(projectId)) return null;
  if (!TOKEN_RE.test(operation)) return null;
  return {
    accountId: null,
    projectId,
    userId,
    category: 'google',
    provider: 'gsc',
    operation,
    quantity: 1,
    unit: 'gsc_request',
    success,
    sourceId: usage.sourceId,
    fundingSource: usage.fundingSource ?? null,
    idempotencyKey: usageEventIdempotencyKey({
      category: 'google',
      provider: 'gsc',
      operation,
      unit: 'gsc_request',
      sourceId: usage.sourceId,
      occurrence: usage.nextOccurrence(operation),
    }),
  };
}

/**
 * Best-effort append of one request's usage fact. Reuses the shared
 * `appendUsage` seam: a persistence failure is logged and swallowed, never
 * propagated into the GSC call.
 */
export async function emitGscRequestUsage(
  args: GscUsageScope & { operation: string; success: boolean },
): Promise<void> {
  const event = buildGscRequestUsageEvent(args);
  if (!event) return;
  await appendUsage(args.usage.sink, [event]);
}
