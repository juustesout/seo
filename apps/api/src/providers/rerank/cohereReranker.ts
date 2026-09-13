/**
 * Cohere Rerank-backed KnowledgeReranker (KB10.3).
 *
 * The first concrete reranker. It is a thin, side-effect-free adapter: it holds
 * no database credentials (the key comes only from server env), touches no
 * Qdrant/Postgres/HTTP routes, and treats candidate text strictly as data. The
 * Cohere rerank endpoint takes the query and the documents as separate request
 * fields, so candidate content can never become workflow control - it is only
 * scored against the query. The query is never concatenated with candidate
 * text.
 *
 * Bounded by construction: a hard timeout, a bounded response read, a request
 * built only from the already-bounded rerank request, and strict validation of
 * every returned index/score. Provider failures are normalized to safe codes;
 * the API key and provider response body never leak into errors or logs.
 */

import type { ProviderDeps } from '@seo/contracts';
import { KnowledgeRerankError, type KnowledgeRerankRanking, type KnowledgeRerankRequest, type KnowledgeRerankResult, type KnowledgeReranker } from '../../knowledge/retrieval/rerank.js';
import { KNOWLEDGE_RERANK_MAX_RESPONSE_BYTES, KNOWLEDGE_RERANK_TIMEOUT_MS } from '../../knowledge/retrieval/limits.js';

const DEFAULT_BASE_URL = 'https://api.cohere.com';
const DEFAULT_MODEL = 'rerank-v3.5';

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Read the response body with a hard byte cap so a provider cannot stream unbounded data. */
async function readBounded(res: Response): Promise<string> {
  const text = await res.text();
  if (text.length > KNOWLEDGE_RERANK_MAX_RESPONSE_BYTES) throw new KnowledgeRerankError('invalid_response');
  return text;
}

export class CohereKnowledgeReranker implements KnowledgeReranker {
  readonly id = 'cohere';
  readonly name = 'Cohere Rerank';

  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(deps: ProviderDeps) {
    const key = deps.config.KNOWLEDGE_RERANKER_API_KEY;
    this.apiKey = typeof key === 'string' && key.trim() ? key.trim() : null;
    const base = deps.config.KNOWLEDGE_RERANKER_BASE_URL;
    this.baseUrl = (typeof base === 'string' && base.trim() ? base.trim() : DEFAULT_BASE_URL).replace(/\/+$/, '');
    const model = deps.config.KNOWLEDGE_RERANKER_MODEL;
    this.model = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_MODEL;
    const timeout = Number(deps.config.KNOWLEDGE_RERANKER_TIMEOUT_MS);
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : KNOWLEDGE_RERANK_TIMEOUT_MS;
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  isConfigured(): boolean {
    return this.apiKey !== null;
  }

  async rerank(request: KnowledgeRerankRequest): Promise<KnowledgeRerankResult> {
    if (!this.apiKey) throw new KnowledgeRerankError('not_configured');
    const documents = request.candidates.map((candidate) => candidate.content);
    if (documents.length === 0) return { rankings: [] };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}/v1/rerank`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        // Query and documents are separate fields; candidate text is data only.
        body: JSON.stringify({
          model: this.model,
          query: request.query,
          documents,
          top_n: documents.length,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new KnowledgeRerankError('provider_error');
      const body = await readBounded(res);
      return parseCohereResponse(body, request, documents.length);
    } catch (err) {
      if (err instanceof KnowledgeRerankError) throw err;
      if (isAbortLike(err)) throw new KnowledgeRerankError('timeout');
      throw new KnowledgeRerankError('provider_error');
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Strictly parse Cohere's `{ results: [{ index, relevance_score }] }` envelope.
 * Every index must reference a document we sent and every score must be finite;
 * anything else is an invalid response and the pipeline keeps the RRF order.
 */
function parseCohereResponse(
  body: string,
  request: KnowledgeRerankRequest,
  documentCount: number,
): KnowledgeRerankResult {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new KnowledgeRerankError('invalid_response');
  }
  const results = (json as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new KnowledgeRerankError('invalid_response');

  const rankings: KnowledgeRerankRanking[] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== 'object') throw new KnowledgeRerankError('invalid_response');
    const index = (entry as { index?: unknown }).index;
    const score = (entry as { relevance_score?: unknown }).relevance_score;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= documentCount) {
      throw new KnowledgeRerankError('invalid_response');
    }
    if (typeof score !== 'number' || !Number.isFinite(score)) throw new KnowledgeRerankError('invalid_response');
    const candidate = request.candidates[index];
    if (!candidate) throw new KnowledgeRerankError('invalid_response');
    rankings.push({ id: candidate.id, score });
  }
  return { rankings };
}
