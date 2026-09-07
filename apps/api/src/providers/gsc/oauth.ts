/**
 * Google Search Console OAuth helpers. Uses the platform's own Google OAuth
 * client (server-side secret) - distinct from Supabase's Google *login*
 * provider. Kept out of the UI entirely.
 *
 * Two OAuth shapes are served from this one module:
 *  - The confidential-client token dance (client_id + client_secret at the
 *    token endpoint) used by GSC connects, both project- and account-scoped.
 *  - The signed-state helpers that make the callback verifiable. State is
 *    signed with CREDENTIALS_ENCRYPTION_KEY (see infra/signedPayload.ts) so a
 *    forged callback carrying someone else's integration/project id is
 *    rejected before any token is stored.
 */

import { signJsonPayload, verifyJsonPayload } from '../../infra/signedPayload.js';

/** Read-only Search Console scope + openid/email so identity resolves. */
export const GSC_SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'openid',
  'email',
].join(' ');

/** Normalized Google token response (refresh_token absent on refresh grants). */
export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Server-held OAuth client credentials for the confidential-code flow. */
export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Consent URL for the browser. access_type=offline plus prompt=consent force
 * a refresh_token on first consent (Google silently omits it otherwise), and
 * the caller-provided state is echoed back by Google unchanged so the signed
 * payload can be verified on the callback.
 */
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

/**
 * Exchange the callback authorization code for tokens. A response that is ok
 * but carries no access_token is still an error - an attacker must never be
 * able to push a token-less body into the credential store as "connected".
 */
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

/**
 * Rotate an expired access token. Google's refresh grant returns no new
 * refresh_token, so the existing one is echoed back unchanged - the caller
 * keeps storing the same refresh token, never a blank one.
 */
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
  /** Set for a legacy project-scoped connect. */
  projectId?: string;
  /** Set for an account-scoped connect (Stage 4). */
  accountId?: string;
  integrationId: string;
  userId: string;
  nonce: string;
  redirect?: string;
}

export function signState(state: OAuthState, secret: string): string {
  return signJsonPayload(state, secret);
}

export function verifyState(token: string, secret: string): OAuthState {
  return verifyJsonPayload<OAuthState>(token, secret);
}
