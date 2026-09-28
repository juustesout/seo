/**
 * Media external-request usage accounting (R5.10.7).
 *
 * Counts one real external media HTTP request as one usage fact. The seam is
 * the concrete provider method (`UnsplashMediaProvider.search`,
 * `OpenAiMediaProvider.generate`), not a generic `fetch` wrapper: a provider
 * that performs no external request must never produce media usage, and the
 * same seam covers both the acquisition service and the `content_images` job.
 *
 * Physical-attempt model (R5.10.6 convention): each provider call that actually
 * issues an external request records one fact - a failed attempt records
 * `success=false` with quantity 1. Local guards (not configured, bad input)
 * issue no request and record nothing. Emission is best-effort: an append
 * failure is logged and swallowed, never failing the media call.
 */

import { usageEventIdempotencyKey, type MediaUsageScope, type NewUsageEvent, type UsageUnit } from '@seo/contracts';
import { appendUsage } from '../../services/usageInstrumentation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[a-z0-9_]{1,64}$/;

/** The two external media operations this slice accounts for. */
export type MediaUsageOperation = 'media_search' | 'image_generate';

/** The unit one media operation's quantity is expressed in. */
export function mediaUsageUnit(operation: MediaUsageOperation): UsageUnit {
  return operation === 'image_generate' ? 'image_generation' : 'request';
}

/**
 * The usage fact for one real external media request, or null when the scope
 * cannot form a valid event (non-UUID project, invalid provider token). A
 * malformed fact is never emitted.
 */
export function buildMediaUsageEvent(args: {
  scope: MediaUsageScope;
  provider: string;
  operation: MediaUsageOperation;
  success: boolean;
  model?: string;
}): NewUsageEvent | null {
  const { scope, provider, operation, success } = args;
  if (!UUID_RE.test(scope.projectId)) return null;
  if (!TOKEN_RE.test(provider)) return null;
  const unit = mediaUsageUnit(operation);
  return {
    accountId: null,
    projectId: scope.projectId,
    userId: scope.userId,
    category: 'media',
    provider,
    operation,
    quantity: 1,
    unit,
    success,
    sourceId: scope.usage.sourceId,
    ...(args.model ? { metadata: { model: args.model } } : {}),
    idempotencyKey: usageEventIdempotencyKey({
      category: 'media',
      provider,
      operation,
      unit,
      sourceId: scope.usage.sourceId,
      occurrence: scope.usage.nextOccurrence(operation),
    }),
  };
}

/** Best-effort append of one external media request's usage fact. */
export async function emitMediaUsage(args: {
  scope: MediaUsageScope;
  provider: string;
  operation: MediaUsageOperation;
  success: boolean;
  model?: string;
}): Promise<void> {
  const event = buildMediaUsageEvent(args);
  if (!event) return;
  await appendUsage(args.scope.usage.sink, [event]);
}
