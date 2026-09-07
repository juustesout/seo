/**
 * API transport for the web client.
 *
 * Every request targets `/api...`; in dev the Vite server proxies that prefix
 * to the API on :3001, and in production the deploy host serves both, so the
 * browser never needs a second origin. The wrapper attaches the Supabase
 * session as `Authorization: Bearer <token>` when present, which is how the
 * API authorizes each project-scoped call. The client never sends provider
 * credentials or service-role secrets - those live server-side only.
 *
 * Wire contract: success is `{ data }`, failure is `{ error: { code, message,
 * details } }` with a non-2xx status. Failures are raised as
 * {@link ApiRequestError} so views can branch on the machine-readable `code`
 * (role denials, not found, provider errors) instead of scraping message text.
 */
import { sessionToken } from './supabase';

/**
 * Error thrown when the API returns an error envelope. Keeps the machine
 * `code` and HTTP `status` alongside the human message so callers can react to
 * specific conditions without parsing text.
 */
export class ApiRequestError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

type Body = Record<string, unknown> | undefined;

/**
 * Call a project-scoped API endpoint (path is relative to `/api`) with the
 * Supabase session token. Resolves to the `{ data }` payload, or rejects with
 * an {@link ApiRequestError} carrying the server's error code.
 */
export async function api<T>(path: string, opts: { method?: string; body?: Body } = {}): Promise<T> {
  const token = await sessionToken();
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { code: string; message: string; details?: unknown } } | null;
  if (!res.ok) {
    const err = json?.error ?? { code: 'http_error', message: `HTTP ${res.status}` };
    throw new ApiRequestError(err.code, err.message, res.status);
  }
  // 204 responses (deletes) have no body; treat them as success without data.
  if (json && 'data' in json) return json.data as T;
  return undefined as unknown as T;
}

/**
 * POST a raw binary body (used for media uploads, where the file bytes are the
 * request body and the server sniffs the format). The content-type header is
 * derived from the file so the API's raw-body parser accepts it; the server
 * never trusts that header. Unlike {@link api} this also treats a 2xx without
 * a `{ data }` envelope as an error, because a raw upload that "succeeded"
 * while returning no object would otherwise look like empty data.
 */
export async function apiRaw<T>(path: string, file: Blob, params: Record<string, string> = {}): Promise<T> {
  const token = await sessionToken();
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`/api${path}${qs ? `?${qs}` : ''}`, {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: file,
  });
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { code: string; message: string; details?: unknown } } | null;
  if (!res.ok || !json || !('data' in json)) {
    const err = json?.error ?? { code: 'http_error', message: `HTTP ${res.status}` };
    throw new ApiRequestError(err.code, err.message, res.status);
  }
  return json.data as T;
}

/**
 * Run `fn` on an interval until the returned stop function is called. Errors
 * are swallowed on purpose: pollers here only keep status tables (jobs, syncs)
 * fresh, and the owning view already renders its own error state from the
 * request that failed. Returning the stop handle keeps the caller in charge of
 * the lifecycle (e.g. from an effect cleanup).
 */
export function poll<T>(fn: () => Promise<T>, everyMs = 4000): () => void {
  let alive = true;
  const tick = async () => {
    if (!alive) return;
    try {
      await fn();
    } catch {
      /* transient polling error: keep going */
    }
    if (alive) setTimeout(tick, everyMs);
  };
  void tick();
  return () => {
    alive = false;
  };
}
