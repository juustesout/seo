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
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { code: string; message: string; details?: unknown } };
  if (!res.ok || !json.data) {
    const err = json.error ?? { code: 'http_error', message: `HTTP ${res.status}` };
    throw new ApiRequestError(err.code, err.message, res.status);
  }
  return json.data;
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
