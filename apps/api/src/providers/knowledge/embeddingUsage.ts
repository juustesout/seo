/**
 * Embedding request usage accounting (R5.10.7).
 *
 * Counts one real external embeddings HTTP request (`POST /embeddings`) as one
 * `ai`/`embed`/`input_token` fact. The seam is the concrete embedder's physical
 * request loop (`OpenAiCompatibleEmbedder.embed`), not a logical `embed()` call:
 * the embedder splits input into batches, so a 20-text embed is two or three
 * physical requests and must record two or three facts, never one summed fact.
 *
 * The quantity is the authoritative provider-reported `usage.prompt_tokens` for
 * that physical request. Token counts are never estimated and a request whose
 * response carries no positive usage records nothing (R5.10.3 honesty rule).
 *
 * Physical-attempt model (R5.10.6 convention): a retried batch that really
 * issues another request is another occurrence, so retry-aware occurrence bases
 * keep it distinct from the prior execution. Emission is best-effort - an append
 * failure is logged and swallowed, never failing the embedding call.
 */

import {
  PROVIDER_IDS,
  usageEventIdempotencyKey,
  type NewUsageEvent,
  type ProviderContext,
} from '@seo/contracts';
import { appendUsage } from '../../services/usageInstrumentation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[a-z0-9_]{1,64}$/;

/**
 * What one physical embeddings request observed: the provider-reported prompt
 * token count and the number of inputs sent in that request. Absent or
 * non-positive tokens mean the fact is skipped rather than estimated.
 */
export interface EmbedUsageObservation {
  model: string;
  inputTokens: number;
  batchSize: number;
}

/** Called once per physical embeddings request the embedder actually issues. */
export type EmbedUsageObserver = (observation: EmbedUsageObservation) => void;

/** Canonical scope + usage correlation for one embedder's physical requests. */
export interface EmbeddingUsageScope {
  usage: NonNullable<ProviderContext['usage']>;
  projectId: string;
  userId: string | null;
  /** Provider id; defaults to the OpenAI-compatible provider identity. */
  provider?: string;
}

/**
 * The usage fact for one physical embeddings request, or null when the scope
 * cannot form a valid event (non-UUID project, invalid provider token) or the
 * provider reported no positive token count. A malformed fact is never emitted.
 */
export function buildEmbeddingUsageEvent(
  args: EmbeddingUsageScope & EmbedUsageObservation,
): NewUsageEvent | null {
  const { usage, projectId, userId, model, inputTokens, batchSize } = args;
  const provider = args.provider ?? PROVIDER_IDS.OPENAI;
  if (!UUID_RE.test(projectId)) return null;
  if (!TOKEN_RE.test(provider)) return null;
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens <= 0) return null;
  return {
    accountId: null,
    projectId,
    userId,
    category: 'ai',
    provider,
    operation: 'embed',
    quantity: Math.round(inputTokens),
    unit: 'input_token',
    success: true,
    sourceId: usage.sourceId,
    metadata: { model, batchSize },
    idempotencyKey: usageEventIdempotencyKey({
      category: 'ai',
      provider,
      operation: 'embed',
      unit: 'input_token',
      sourceId: usage.sourceId,
      occurrence: usage.nextOccurrence('embed'),
    }),
  };
}

/** Best-effort append of one physical embeddings request's usage fact. */
export async function emitEmbeddingUsage(
  args: EmbeddingUsageScope & EmbedUsageObservation,
): Promise<void> {
  const event = buildEmbeddingUsageEvent(args);
  if (!event) return;
  await appendUsage(args.usage.sink, [event]);
}

/**
 * Bind a provider context's usage scope to an embedder observer. Returns
 * undefined when there is no usage context, so the embedder performs no usage
 * work at all. The observer is fire-and-forget: emission is best-effort and must
 * never block or fail the embedding request.
 */
export function embeddingUsageObserver(
  ctx: Pick<ProviderContext, 'usage' | 'projectId' | 'userId'>,
  provider?: string,
): EmbedUsageObserver | undefined {
  const usage = ctx.usage;
  if (!usage) return undefined;
  return (observation) => {
    void emitEmbeddingUsage({ usage, projectId: ctx.projectId, userId: ctx.userId, provider, ...observation });
  };
}
