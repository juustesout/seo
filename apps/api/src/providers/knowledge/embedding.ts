/**
 * Embedding abstraction + OpenAI-compatible implementation.
 *
 * Qdrant stores vectors; something must produce them. The embedder is a
 * pluggable dependency resolved from server env (EMBEDDINGS_*). If no embedder
 * is configured the KnowledgeProvider refuses to run with a clear
 * "not configured" error - it never falls back to fake vectors.
 *
 * Vector dimensionality is a hard invariant: a collection's vector size is
 * fixed at creation, so the embedder's `dimensions` must be resolved before
 * the first collection creation and stay stable afterwards. dimensionsForModel
 * encodes the known model sizes so misconfiguration surfaces as a Qdrant
 * mismatch error instead of silently truncated vectors.
 */

/**
 * Something that turns text into equal-length vectors. The dimension must be
 * known ahead of time (Qdrant collections are dimension-locked) and every
 * returned vector must match it.
 */
export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** OpenAI-compatible embeddings endpoint settings (baseUrl optional -> OpenAI default). */
export interface EmbedderConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

/** Known OpenAI embedding model dimensions (used when EMBEDDINGS_DIMENSIONS is absent). */
export function dimensionsForModel(model: string | undefined, fallback = 1536): number {
  if (!model) return fallback;
  const m = model.toLowerCase();
  if (m.includes('text-embedding-3-large')) return 3072;
  if (m.includes('text-embedding-3-small') || m.includes('ada-002')) return 1536;
  return fallback;
}

/**
 * OpenAI-compatible /embeddings client. Inputs are sent in batches of 8 to
 * stay well under vendor request limits; a short response (fewer vectors than
 * texts) is a hard error because a partial index would poison future searches
 * with silently missing chunks.
 */
export class OpenAiCompatibleEmbedder implements Embedder {
  readonly dimensions: number;

  constructor(
    private readonly config: EmbedderConfig,
    dimensions = 1536,
  ) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const baseUrl = this.config.baseUrl ?? 'https://api.openai.com/v1';
    const apiKey = this.config.apiKey;
    const model = this.config.model ?? 'text-embedding-3-small';
    if (!apiKey) {
      throw new Error('Embedding provider is not configured: set EMBEDDINGS_API_KEY or OPENAI_API_KEY');
    }
    const batches: number[][] = [];
    for (let i = 0; i < texts.length; i += 8) {
      const batch = texts.slice(i, i + 8);
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: batch }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Embedding API ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
      const vectors = (json.data ?? []).map((d) => d.embedding);
      if (vectors.length !== batch.length) {
        throw new Error('Embedding API returned fewer vectors than requested');
      }
      batches.push(...vectors);
    }
    return batches;
  }
}

/**
 * Resolve an embedder from server env. Priority:
 *   1. Explicit EMBEDDINGS_* endpoint (any OpenAI-compatible server)
 *   2. OPENAI_API_KEY (defaults to the OpenAI /v1 embeddings endpoint)
 * Returns null when neither is configured - callers then report themselves as
 * "not configured" instead of inventing vectors.
 */
export function embedderFromConfig(config: Record<string, string | undefined>): Embedder | null {
  const fallbackDims = config.EMBEDDINGS_DIMENSIONS ? Number(config.EMBEDDINGS_DIMENSIONS) : undefined;
  const resolvedDims = Number.isFinite(fallbackDims) ? (fallbackDims as number) : undefined;

  if (config.EMBEDDINGS_API_KEY || config.EMBEDDINGS_BASE_URL) {
    const model = config.EMBEDDINGS_MODEL;
    return new OpenAiCompatibleEmbedder(
      {
        baseUrl: config.EMBEDDINGS_BASE_URL,
        apiKey: config.EMBEDDINGS_API_KEY,
        model,
      },
      resolvedDims ?? dimensionsForModel(model),
    );
  }

  if (config.OPENAI_API_KEY) {
    const model = config.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small';
    return new OpenAiCompatibleEmbedder(
      { baseUrl: config.OPENAI_BASE_URL, apiKey: config.OPENAI_API_KEY, model },
      resolvedDims ?? dimensionsForModel(model),
    );
  }

  return null;
}

