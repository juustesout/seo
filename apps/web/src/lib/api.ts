import { sessionToken } from './supabase';

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

/** Call a project-scoped API endpoint with the Supabase session token. */
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
 * Send a raw binary body (used for media uploads, where the file bytes are the
 * request body and the server sniffs the format). The content-type header is
 * derived from the file so the API's raw-body parser accepts it; the server
 * never trusts that header.
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
