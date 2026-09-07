/**
 * Minimal Qdrant REST client. Only the operations the platform needs:
 * collection lifecycle, payload indexes, point upsert/search/delete.
 *
 * Qdrant operations happen inside one shared cluster but the platform's
 * isolation model is enforced at the payload level (every point carries its
 * project_id and every filter mentions it) - see qdrantKnowledge.ts. This
 * client deliberately exposes raw collection names so the caller decides the
 * namespace; it never guesses a project from a name.
 */

/**
 * A vector point ready for upsert. `id` is our deterministic UUID (see
 * deterministicId) so re-indexing the same external document overwrites its
 * chunks instead of duplicating them.
 */
export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

/** A search hit with Qdrant's cosine score plus the stored payload. */
export interface QdrantSearchHit {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

/** Subset of Qdrant's filter DSL used by the platform (match conditions only). */
export interface QdrantFilter {
  must?: Array<Record<string, unknown>>;
  mustNot?: Array<Record<string, unknown>>;
}

/**
 * Typed failure carrying the HTTP status so callers can distinguish "not
 * found" (404, e.g. collection missing) from genuine server trouble without
 * parsing Qdrant's error body.
 */
export class QdrantError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'QdrantError';
  }
}

/**
 * One authenticated Qdrant cluster. Shared across projects; the api-key header
 * is attached server-side on every call and never leaks into logs or errors.
 */
export class QdrantClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * JSON request with the api-key header. Non-ok responses become QdrantError
   * with the status preserved and a truncated body for diagnostics.
   */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'api-key': this.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new QdrantError(`Qdrant ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    return (await res.json()) as T;
  }

  /**
   * Create the collection with Cosine distance if absent, then guarantee the
   * keyword payload indexes exist. Indexes keep project/external-id filtered
   * searches fast on large knowledge bases; ensuring them here means callers
   * never see a correct-but-slow first query.
   */
  async ensureCollection(name: string, size: number): Promise<void> {
    const exists = await this.collectionExists(name);
    if (!exists) {
      await this.request('PUT', `/collections/${encodeURIComponent(name)}`, {
        vectors: { size, distance: 'Cosine' },
      });
    }
    // payload indexes so filters stay fast on large knowledge bases
    for (const field of ['project_id', 'external_id', 'kind']) {
      await this.ensurePayloadIndex(name, field);
    }
  }

  /** True when the collection already exists (404 => absent, other errors rethrow). */
  private async collectionExists(name: string): Promise<boolean> {
    try {
      await this.request('GET', `/collections/${encodeURIComponent(name)}`);
      return true;
    } catch (err) {
      if (err instanceof QdrantError && err.status === 404) return false;
      throw err;
    }
  }

  /**
   * Ensure a keyword index for one payload field. Newer Qdrant uses PUT and
   * older builds POST, so both are attempted; a non-5xx failure on both is
   * assumed to mean "already indexed" and tolerated rather than failing the
   * whole ensure pass.
   */
  private async ensurePayloadIndex(name: string, field: string): Promise<void> {
    const body = { field_name: field, field_schema: 'keyword' };
    try {
      await this.request('PUT', `/collections/${encodeURIComponent(name)}/index`, body);
    } catch {
      // Some Qdrant versions expect POST; a 4xx on PUT is handled below.
      try {
        await this.request('POST', `/collections/${encodeURIComponent(name)}/index`, body);
      } catch (err) {
        if (err instanceof QdrantError && err.status !== undefined && err.status < 500) {
          // index likely already exists
          return;
        }
        throw err;
      }
    }
  }

  /**
   * Upsert points in batches of 256 with wait=true so the write is durable
   * before the caller reports success (index jobs must not claim persistence
   * that a crash could still roll back).
   */
  async upsertPoints(collection: string, points: QdrantPoint[]): Promise<void> {
    for (let i = 0; i < points.length; i += 256) {
      await this.request('PUT', `/collections/${encodeURIComponent(collection)}/points?wait=true`, {
        points: points.slice(i, i + 256).map((p) => ({ ...p, id: p.id })),
      });
    }
  }

  /** Cosine search with payloads attached and an optional filter applied. */
  async search(collection: string, vector: number[], filter: QdrantFilter, limit: number): Promise<QdrantSearchHit[]> {
    const data = await this.request<{ result?: Array<{ id: string; score: number; payload: Record<string, unknown> }> }>(
      'POST',
      `/collections/${encodeURIComponent(collection)}/points/search`,
      { vector, limit, with_payload: true, filter },
    );
    return (data.result ?? []).map((r) => ({ id: String(r.id), score: r.score, payload: r.payload ?? {} }));
  }

  /** Delete every point matching a filter (used for reindex and project teardown). */
  async deleteByFilter(collection: string, filter: QdrantFilter): Promise<void> {
    await this.request('POST', `/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
      filter,
    });
  }
}

/**
 * Build one Qdrant match-condition object (e.g. `{ key, match: { value } }`).
 * Centralizing the shape keeps the filter DSL consistent across every query.
 */
export function matchOn(key: string, value: string): Record<string, unknown> {
  return { key, match: { value } };
}
