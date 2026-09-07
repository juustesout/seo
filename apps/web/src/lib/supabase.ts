/**
 * Supabase browser client setup.
 *
 * The web app only ever sees the anon key and project URL from
 * `apps/web/.env` (`VITE_SUPABASE_*`); the service-role key stays on the API
 * server and is never bundled here. When the env vars are missing the client
 * is `null` and `configured` is false so the app can show a boot error instead
 * of pretending auth works.
 *
 * `sessionToken()` is the bridge to the SEO API: the Supabase access token is
 * sent as a bearer token on every `/api` call so the API can authorize
 * project-scoped operations against the signed-in user (RLS still applies on
 * the service-role client server-side).
 */
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = Boolean(url && anonKey);

export const supabase = configured
  ? createClient(url!, anonKey!, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

/** Access token for the SEO API, or null when unauthenticated/not configured. */
export async function sessionToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Signed-in Supabase user (id + email), or null when not configured/authed. */
export async function currentUser(): Promise<{ id: string; email: string | null } | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}
