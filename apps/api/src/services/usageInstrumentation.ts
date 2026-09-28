/**
 * Usage instrumentation (R5.10.3).
 *
 * The single place where real AI/media provider operations are turned into
 * append-only usage events. It is deliberately small and domain-specific - not
 * a telemetry framework - and it must not be a transaction boundary:
 *
 *   AI/media operation succeeds
 *     -> usage append fails
 *          -> log the persistence failure
 *          -> do NOT fail the operation
 *
 * So every append goes through `appendUsage`, which swallows persistence errors
 * and returns. The provider wrapper only records *after* a provider call has
 * actually been made (a thrown call records nothing for tokens, because token
 * usage is unavailable on the error path and must not be invented).
 *
 * Scope is real request scope taken from the resolved project/provider, never
 * from arbitrary caller input. The acting user is null at this seam: the
 * canonical `AIService.resolve(projectId)` gate has no user context, and
 * worker/background callers legitimately have no acting user.
 */

import type {
  AIChatResult,
  AIEmbeddingResult,
  AIProvider,
  NewUsageEvent,
  ProviderUsageContext,
} from '@seo/contracts';
import { usageEventIdempotencyKey } from '@seo/contracts';
import { logger } from '../logger.js';
import type { UsageEventStore } from './usageEventRepository.js';

/** Real scope every emitted event preserves. */
export interface UsageScope {
  accountId: string | null;
  projectId: string;
  userId: string | null;
}

/** Minimal append surface instrumentation depends on (the R5.10.2 store). */
export type UsageSink = Pick<UsageEventStore, 'append'>;

/**
 * Occurrence stride between successive executions of the same durable job
 * (R5.10.7, following R5.10.6). Each retry increments `retry_count`, so seeding
 * the per-execution occurrence counter at `retry_count * stride` keeps a retried
 * execution's physical-attempt facts distinct from the prior execution's. The
 * stride is far above any realistic number of requests one execution makes.
 */
export const USAGE_RETRY_OCCURRENCE_STRIDE = 1_000_000;

/** Occurrence base for one job execution, derived from the durable retry counter. */
export function retryOccurrenceBase(retryCount: number | null | undefined): number {
  const retries = typeof retryCount === 'number' && Number.isInteger(retryCount) && retryCount > 0 ? retryCount : 0;
  return retries * USAGE_RETRY_OCCURRENCE_STRIDE;
}

/**
 * Build the append-only usage correlation for a provider operation (R5.10.7).
 * Returns undefined when there is no sink, so callers can skip usage entirely.
 * `sourceId` is the stable identity of the logical execution (a job id);
 * `occurrenceBase` seeds the per-execution counter so a retried physical attempt
 * is not deduplicated against the previous execution.
 */
export function usageScopeContext(args: {
  sink: UsageSink | null | undefined;
  sourceId?: string | null;
  occurrenceBase?: number;
}): ProviderUsageContext | undefined {
  if (!args.sink) return undefined;
  const occurrences = new Map<string, number>();
  const base =
    typeof args.occurrenceBase === 'number' && Number.isFinite(args.occurrenceBase) && args.occurrenceBase > 0
      ? Math.floor(args.occurrenceBase)
      : 0;
  return {
    sink: args.sink,
    sourceId: args.sourceId ?? null,
    nextOccurrence: (operation: string) => {
      const next = occurrences.get(operation) ?? base;
      occurrences.set(operation, next + 1);
      return next;
    },
  };
}

/**
 * Best-effort append: usage evidence is observability, not the operation's
 * transaction boundary. A missing sink or a failed append is logged and
 * swallowed so it can never turn a successful AI/media operation into a failure.
 */
export async function appendUsage(
  sink: UsageSink | null | undefined,
  events: readonly NewUsageEvent[],
): Promise<void> {
  if (!sink || events.length === 0) return;
  try {
    await sink.append(events);
  } catch (err) {
    logger.error({ err, events: events.length }, 'usage event append failed');
  }
}

/** Token events for one chat/generate result: one per present, positive unit. */
function chatTokenEvents(args: {
  result: AIChatResult;
  providerId: string;
  operation: 'chat' | 'generate';
  scope: UsageScope;
}): NewUsageEvent[] {
  const { result, providerId, operation, scope } = args;
  const metadata = { model: result.model };
  const events: NewUsageEvent[] = [];
  const input = result.usage?.inputTokens;
  const output = result.usage?.outputTokens;
  if (typeof input === 'number' && input > 0) {
    events.push({
      ...scope,
      category: 'ai',
      provider: providerId,
      operation,
      quantity: input,
      unit: 'input_token',
      success: true,
      sourceId: null,
      metadata,
    });
  }
  if (typeof output === 'number' && output > 0) {
    events.push({
      ...scope,
      category: 'ai',
      provider: providerId,
      operation,
      quantity: output,
      unit: 'output_token',
      success: true,
      sourceId: null,
      metadata,
    });
  }
  return events;
}

/**
 * One input-token event for an embed call. The provider batches internally and
 * returns the summed usage, so this is the total for the logical operation -
 * never one event per internal batch.
 */
function embeddingEvents(args: {
  result: AIEmbeddingResult;
  providerId: string;
  scope: UsageScope;
}): NewUsageEvent[] {
  const input = args.result.usage?.inputTokens;
  if (typeof input !== 'number' || input <= 0) return [];
  return [
    {
      ...args.scope,
      category: 'ai',
      provider: args.providerId,
      operation: 'embed',
      quantity: input,
      unit: 'input_token',
      success: true,
      sourceId: null,
      metadata: { model: args.result.model },
    },
  ];
}

/**
 * The image-generation usage fact (external resource consumption, distinct from
 * the later `seo_media` row that records the application asset).
 */
export function imageGenerationUsageEvent(args: {
  providerId: string;
  model: string;
  scope: UsageScope;
  success: boolean;
}): NewUsageEvent {
  return {
    ...args.scope,
    category: 'media',
    provider: args.providerId,
    operation: 'image_generate',
    quantity: 1,
    unit: 'image_generation',
    success: args.success,
    sourceId: null,
    metadata: { model: args.model },
  };
}

/**
 * Wrap a resolved `AIProvider` so chat/generate/embed record usage after the
 * real provider call. This is the one central text/embedding seam: every caller
 * reaches AI through `AIService.resolve`, so wrapping there guarantees exactly
 * one event per actual provider operation with no per-caller double counting.
 *
 * `generate()` is instrumented separately from `chat()` because the provider
 * implements generate on top of its own (unwrapped) chat, so the wrapper sees a
 * single logical operation either way.
 */
export function instrumentAiProvider(args: {
  provider: AIProvider;
  sink: UsageSink | null | undefined;
  scope: UsageScope;
}): AIProvider {
  const { provider, sink, scope } = args;
  return {
    get id() {
      return provider.id;
    },
    get name() {
      return provider.name;
    },
    get description() {
      return provider.description;
    },
    get capabilities() {
      return provider.capabilities;
    },
    isConfigured: () => provider.isConfigured(),
    models: () => provider.models(),
    async chat(req) {
      const result = await provider.chat(req);
      await appendUsage(sink, chatTokenEvents({ result, providerId: provider.id, operation: 'chat', scope }));
      return result;
    },
    async generate(req) {
      const result = await provider.generate(req);
      await appendUsage(sink, chatTokenEvents({ result, providerId: provider.id, operation: 'generate', scope }));
      return result;
    },
    async embed(req) {
      const result = await provider.embed(req);
      await appendUsage(sink, embeddingEvents({ result, providerId: provider.id, scope }));
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Job execution (R5.10.4, Layer B)
// ---------------------------------------------------------------------------

const JOB_USAGE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_USAGE_TOKEN_RE = /^[a-z0-9_]{1,64}$/;
const JOB_USAGE_SOURCE_MAX = 200;

/** The durable job fields a job usage event is built from. */
export interface JobUsageRecord {
  id: string;
  project_id: string;
  provider: string;
  job_type: string;
  created_by: string | null;
  retry_count: number;
  started_at: string | null;
}

/**
 * The single usage fact for one *terminal* logical job execution (R5.10.4).
 *
 * Emitted only once the job reaches a terminal state - completed, or failed with
 * no retries left. A retryable failure that is requeued records nothing, so a
 * job is one usage fact carrying its retry count rather than one row per worker
 * attempt. `sourceId = seo_sync_jobs.id` makes a re-execution idempotent.
 *
 * Returns null when the job cannot form a valid event (non-UUID project, invalid
 * provider/operation token) so a malformed fact is skipped, never persisted.
 */
export function jobUsageEvent(args: {
  job: JobUsageRecord;
  success: boolean;
  status: 'completed' | 'failed';
  durationMs?: number | null;
}): NewUsageEvent | null {
  const { job, success, status } = args;
  if (!JOB_USAGE_UUID_RE.test(job.project_id)) return null;
  if (!JOB_USAGE_TOKEN_RE.test(job.provider)) return null;
  if (!JOB_USAGE_TOKEN_RE.test(job.job_type)) return null;
  if (typeof job.id !== 'string' || job.id.length === 0 || job.id.length > JOB_USAGE_SOURCE_MAX) return null;
  const userId = job.created_by && JOB_USAGE_UUID_RE.test(job.created_by) ? job.created_by : null;
  const metadata: Record<string, unknown> = { retryCount: job.retry_count, status };
  if (typeof args.durationMs === 'number' && Number.isFinite(args.durationMs) && args.durationMs >= 0) {
    metadata.durationMs = Math.round(args.durationMs);
  }
  return {
    accountId: null,
    projectId: job.project_id,
    userId,
    category: 'job',
    provider: job.provider,
    operation: job.job_type,
    quantity: 1,
    unit: 'job',
    success,
    sourceId: job.id,
    metadata,
    idempotencyKey: usageEventIdempotencyKey({
      category: 'job',
      provider: job.provider,
      operation: job.job_type,
      unit: 'job',
      sourceId: job.id,
    }),
  };
}
