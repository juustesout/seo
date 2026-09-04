/**
 * Minimal Qdrant REST client. Only the operations the platform needs:
 * collection lifecycle, payload indexes, point upsert/search/delete.
 */

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface QdrantSearchHit {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface QdrantFilter {
  must?: Array<Record<string, unknown>>;
  mustNot?: Array<Record<string, unknown>>;
}

export class QdrantError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'QdrantError';
  }
}

export class QdrantClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

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

  private async collectionExists(name: string): Promise<boolean> {
    try {
      await this.request('GET', `/collections/${encodeURIComponent(name)}`);
      return true;
    } catch (err) {
      if (err instanceof QdrantError && err.status === 404) return false;
      throw err;
    }
  }

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

  async upsertPoints(collection: string, points: QdrantPoint[]): Promise<void> {
    for (let i = 0; i < points.length; i += 256) {
      await this.request('PUT', `/collections/${encodeURIComponent(collection)}/points?wait=true`, {
        points: points.slice(i, i + 256).map((p) => ({ ...p, id: p.id })),
      });
    }
  }

  async search(collection: string, vector: number[], filter: QdrantFilter, limit: number): Promise<QdrantSearchHit[]> {
    const data = await this.request<{ result?: Array<{ id: string; score: number; payload: Record<string, unknown> }> }>(
      'POST',
      `/collections/${encodeURIComponent(collection)}/points/search`,
      { vector, limit, with_payload: true, filter },
    );
    return (data.result ?? []).map((r) => ({ id: String(r.id), score: r.score, payload: r.payload ?? {} }));
  }

  async deleteByFilter(collection: string, filter: QdrantFilter): Promise<void> {
    await this.request('POST', `/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
      filter,
    });
  }
}

export function matchOn(key: string, value: string): Record<string, unknown> {
  return { key, match: { value } };
}
