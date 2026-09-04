/**
 * Embedding abstraction + OpenAI-compatible implementation.
 *
 * Qdrant stores vectors; something must produce them. The embedder is a
 * pluggable dependency resolved from server env (EMBEDDINGS_*). If no embedder
 * is configured the KnowledgeProvider refuses to run with a clear
 * "not configured" error - it never falls back to fake vectors.
 */

export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbedderConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

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
      throw new Error('Embedding provider is not configured: set EMBEDDINGS_API_KEY');
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

export function embedderFromConfig(config: Record<string, string | undefined>): Embedder | null {
  const baseUrl = config.EMBEDDINGS_BASE_URL;
  const apiKey = config.EMBEDDINGS_API_KEY;
  const model = config.EMBEDDINGS_MODEL;
  const dims = config.EMBEDDINGS_DIMENSIONS ? Number(config.EMBEDDINGS_DIMENSIONS) : 1536;
  if (!apiKey && !baseUrl) return null;
  return new OpenAiCompatibleEmbedder({ baseUrl, apiKey, model }, Number.isFinite(dims) ? dims : 1536);
}
