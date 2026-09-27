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
} from '@seo/contracts';
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
