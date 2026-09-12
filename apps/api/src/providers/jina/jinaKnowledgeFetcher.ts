/**
 * Jina Reader-backed KnowledgeFetcher (KB3).
 *
 * Fetches one URL through Jina's reader endpoint and returns the extracted
 * body + metadata. This adapter is deliberately thin and side-effect free: it
 * never touches Qdrant, Postgres or HTTP routes, holds no database credentials
 * (the key comes only from server env), performs no LLM interpretation, and
 * treats the returned text strictly as untrusted data.
 *
 * Bounded by construction: a hard timeout, a streaming byte cap and an
 * extracted-character cap. Provider failures are normalized to
 * KnowledgeIngestError codes; response bodies and the API key never leak into
 * errors or logs. Retry/backoff is the job layer's concern - there is no retry
 * loop here.
 */

import type {
  FetchedDocument,
  KnowledgeFetchOptions,
  KnowledgeFetcher,
  ProviderLogger,
} from '@seo/contracts';
import { KnowledgeIngestError } from '../../knowledge/errors.js';
import {
  FETCH_TIMEOUT_MS,
  MAX_FETCHED_BYTES,
  MAX_FETCHED_CHARS,
} from '../../knowledge/limits.js';
import { validateExternalUrl } from '../../knowledge/url.js';

const DEFAULT_BASE_URL = 'https://r.jina.ai';

export interface JinaFetcherDeps {
  config: Record<string, string | undefined>;
  logger?: ProviderLogger;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

function httpError(status: number): KnowledgeIngestError {
  if (status === 429) return new KnowledgeIngestError('knowledge_fetch_rate_limited');
  if (status >= 500) return new KnowledgeIngestError('knowledge_fetch_5xx');
  if (status >= 400) return new KnowledgeIngestError('knowledge_fetch_4xx');
  return new KnowledgeIngestError('knowledge_fetch_provider_error');
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Read a response body without buffering more than the configured byte cap. */
async function readBounded(res: Response): Promise<string> {
  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body;
  if (!body) {
    const text = await res.text();
    if (text.length > MAX_FETCHED_CHARS) throw new KnowledgeIngestError('knowledge_source_too_large');
    return text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > MAX_FETCHED_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new KnowledgeIngestError('knowledge_source_too_large');
      }
      out += decoder.decode(value, { stream: true });
    }
  }
  out += decoder.decode();
  return out;
}

export class JinaKnowledgeFetcher implements KnowledgeFetcher {
  readonly id = 'jina';
  readonly name = 'Jina Reader';

  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(deps: JinaFetcherDeps) {
    const key = deps.config.JINA_API_KEY;
    this.apiKey = typeof key === 'string' && key.trim() ? key.trim() : null;
    const base = deps.config.JINA_BASE_URL;
    this.baseUrl = (typeof base === 'string' && base.trim() ? base.trim() : DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  isConfigured(): boolean {
    return this.apiKey !== null;
  }

  async fetch(rawUrl: string, options?: KnowledgeFetchOptions): Promise<FetchedDocument> {
    if (!this.apiKey) throw new KnowledgeIngestError('knowledge_jina_not_configured');
    const url = validateExternalUrl(rawUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await this.fetchFn(`${this.baseUrl}/${url.toString()}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          'x-return-format': 'markdown',
          'x-timeout': String(Math.ceil(FETCH_TIMEOUT_MS / 1000)),
        },
        signal: controller.signal,
      });
      if (!res.ok) throw httpError(res.status);
      const body = await readBounded(res);
      return this.parse(body, url, res.headers?.get?.('content-type') ?? undefined);
    } catch (err) {
      if (err instanceof KnowledgeIngestError) throw err;
      if (isAbortLike(err)) throw new KnowledgeIngestError('knowledge_fetch_timeout');
      throw new KnowledgeIngestError('knowledge_fetch_provider_error');
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Accept either Jina's JSON envelope ({ data: { content, title, url } }) or a
   * plain-text/markdown body. Rejects empty and over-limit content so an empty
   * fetch can never be indexed as 'ready'.
   */
  private parse(body: string, url: URL, contentType?: string): FetchedDocument {
    const fetchedAt = new Date().toISOString();
    let contentText = '';
    let title: string | undefined;
    let canonicalUrl: string | undefined;

    const looksJson = (contentType ?? '').toLowerCase().includes('json') || body.trimStart().startsWith('{');
    if (looksJson) {
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        throw new KnowledgeIngestError('knowledge_fetch_provider_error');
      }
      const envelope = json as { data?: Record<string, unknown> } & Record<string, unknown>;
      const data = (envelope.data ?? envelope) as Record<string, unknown>;
      if (typeof data.content === 'string') contentText = data.content;
      if (typeof data.title === 'string' && data.title.trim()) title = data.title.trim();
      if (typeof data.url === 'string' && data.url.trim()) canonicalUrl = data.url.trim();
    } else {
      contentText = body;
    }

    if (!contentText.trim()) throw new KnowledgeIngestError('knowledge_empty_content');
    if (contentText.length > MAX_FETCHED_CHARS) throw new KnowledgeIngestError('knowledge_source_too_large');
    return { sourceUrl: url.toString(), canonicalUrl, title, contentText, contentType, fetchedAt };
  }
}
