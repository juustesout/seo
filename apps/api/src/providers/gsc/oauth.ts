/**
 * Google Search Console OAuth helpers. Uses the platform's own Google OAuth
 * client (server-side secret) - distinct from Supabase's Google *login*
 * provider. Kept out of the UI entirely.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const GSC_SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'openid',
  'email',
].join(' ');

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

export function buildAuthorizationUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: opts.scope ?? GSC_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state: opts.state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    grant_type: 'authorization_code',
    redirect_uri: opts.redirectUri,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || !json.access_token) {
    const err = json.error_description ?? json.error ?? 'code exchange failed';
    throw new Error(`Google OAuth code exchange failed: ${String(err)}`);
  }
  return {
    access_token: json.access_token as string,
    refresh_token: (json.refresh_token as string) ?? undefined,
    expires_in: json.expires_in as number | undefined,
    scope: json.scope as string | undefined,
  };
}

export async function refreshAccessToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || !json.access_token) {
    throw new Error(`Google token refresh failed: ${String(json.error_description ?? json.error)}`);
  }
  return {
    access_token: json.access_token as string,
    refresh_token: opts.refreshToken,
    expires_in: json.expires_in as number | undefined,
  };
}

// ---------------------------------------------------------------------------
// OAuth state (signed, to prevent CSRF + tampering of redirect params)
// ---------------------------------------------------------------------------

export interface OAuthState {
  projectId: string;
  integrationId: string;
  userId: string;
  nonce: string;
  redirect?: string;
}

export function signState(state: OAuthState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  const sig = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyState(token: string, secret: string): OAuthState {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) throw new Error('Invalid OAuth state');
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid OAuth state signature');
  }
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OAuthState;
}
