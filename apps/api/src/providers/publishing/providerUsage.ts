/**
 * Publishing logical-attempt usage accounting (R5.10.6).
 *
 * Counts one real external publication HTTP request as one `publish_attempt`
 * fact. The seam is the provider-specific client method (WordPress
 * create/update/delete post, X POST /2/tweets), not a generic adapter or
 * `fetch` wrapper: `mock_social` performs no external request and must never
 * produce publishing usage, which a generic wrapper could not distinguish.
 *
 * Job-level retry semantics deliberately differ from the R5.10.4 terminal
 * `job/job` fact. Publishing usage records actual remote attempts, so a new job
 * execution that really sends another publication request is a new attempt and
 * must not deduplicate against the previous execution. `publishUsageOccurrenceBase`
 * makes the shared per-execution occurrence counter advance per retry while the
 * event's `sourceId` stays exactly `job.id`.
 *
 * Emission is best-effort (R5.10.3/R5.10.4 convention): a ledger append failure
 * is logged and swallowed so it can never turn a real publication success or
 * error into a usage failure.
 */

import {
  usageEventIdempotencyKey,
  type NewUsageEvent,
  type ProviderContext,
} from '@seo/contracts';
import { appendUsage } from '../../services/usageInstrumentation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[a-z0-9_]{1,64}$/;

/**
 * Publication lifecycle actions that hit the remote platform. These reuse the
 * job_type vocabulary already used by the publish executor.
 */
export type PublishOperation = 'publish' | 'publish_update' | 'publish_delete';

export const PUBLISH_OPERATIONS: readonly PublishOperation[] = ['publish', 'publish_update', 'publish_delete'];

/**
 * Reported by a provider-specific publish client once a publication request has
 * been attempted: the lifecycle action and whether the HTTP exchange succeeded.
 * A thrown `fetch` is reported as `success = false` (the attempt did not
 * complete); the client cannot know whether the remote received it.
 */
export type PublishRequestObserver = (operation: PublishOperation, success: boolean) => Promise<void>;

/** Canonical scope + usage correlation available to a publish client. */
export interface PublishUsageScope {
  usage: NonNullable<ProviderContext['usage']>;
  projectId: string;
  userId: string | null;
  provider: string;
}

/**
 * Occurrence stride between successive executions of the same job. Each durable
 * job retry increments `retry_count`, so seeding the occurrence counter at
 * `retry_count * stride` keeps a retried attempt's key distinct from the prior
 * attempt's. The stride is far above any realistic number of publication
 * requests a single execution makes.
 */
export const PUBLISH_OCCURRENCE_STRIDE = 1_000_000;

/** Occurrence base for one job execution, derived from the durable retry counter. */
export function publishUsageOccurrenceBase(retryCount: number | null | undefined): number {
  const retries = typeof retryCount === 'number' && Number.isInteger(retryCount) && retryCount > 0 ? retryCount : 0;
  return retries * PUBLISH_OCCURRENCE_STRIDE;
}

/**
 * The usage fact for one real external publication request, or null when the
 * scope cannot form a valid event (non-UUID project, invalid provider/operation
 * token). A malformed fact is never emitted.
 */
export function buildPublishAttemptUsageEvent(
  args: PublishUsageScope & { operation: PublishOperation; success: boolean; metadata?: Record<string, unknown> },
): NewUsageEvent | null {
  const { usage, projectId, userId, provider, operation, success, metadata } = args;
  if (!UUID_RE.test(projectId)) return null;
  if (!TOKEN_RE.test(provider)) return null;
  if (!TOKEN_RE.test(operation)) return null;
  return {
    accountId: null,
    projectId,
    userId,
    category: 'publishing',
    provider,
    operation,
    quantity: 1,
    unit: 'publish_attempt',
    success,
    sourceId: usage.sourceId,
    fundingSource: usage.fundingSource ?? null,
    metadata: metadata ?? {},
    idempotencyKey: usageEventIdempotencyKey({
      category: 'publishing',
      provider,
      operation,
      unit: 'publish_attempt',
      sourceId: usage.sourceId,
      occurrence: usage.nextOccurrence(operation),
    }),
  };
}

/**
 * Best-effort append of one publication request's usage fact. Reuses the shared
 * `appendUsage` seam: a persistence failure is logged and swallowed, never
 * propagated into the publication call.
 */
export async function emitPublishAttemptUsage(
  args: PublishUsageScope & { operation: PublishOperation; success: boolean; metadata?: Record<string, unknown> },
): Promise<void> {
  const event = buildPublishAttemptUsageEvent(args);
  if (!event) return;
  await appendUsage(args.usage.sink, [event]);
}

/**
 * Bind a request's scope to a publish client's observer. Returns undefined when
 * there is no usage context (the client then performs no usage work at all).
 * `metadata` is attached to every fact the observer emits (e.g. `hasLink` for an
 * X post), giving the entitlement layer the same predicate it admits on.
 */
export function publishUsageObserver(
  ctx: Pick<ProviderContext, 'usage' | 'projectId' | 'userId'>,
  provider: string,
  metadata?: Record<string, unknown>,
): PublishRequestObserver | undefined {
  const usage = ctx.usage;
  if (!usage) return undefined;
  return (operation, success) =>
    emitPublishAttemptUsage({
      usage,
      projectId: ctx.projectId,
      userId: ctx.userId,
      provider,
      operation,
      success,
      metadata,
    });
}
