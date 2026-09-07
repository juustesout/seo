/**
 * X (Twitter) OAuth 2.0 API client - Authorization Code flow with PKCE.
 *
 * X connects through a public (PKCE) client: the server only holds
 * X_OAUTH_CLIENT_ID (no client secret), and proves the token exchange with the
 * code verifier it generated when the consent URL was built. This module owns
 * the four X API surface points H6.2 needs:
 *   - the authorize URL the browser is sent to,
 *   - the code exchange + refresh at the token endpoint,
 *   - GET /2/users/me (account identity),
 *   - POST /2/tweets (text-only posts).
 *
 * Every remote call returns typed results or throws XApiError (safe, never
 * echoes tokens); the publisher adapter maps those onto PublisherError. No
 * platform-specific knowledge leaks past this file.
 */

import type { OAuthAccountIdentity, OAuthTokenResult, ProviderContext, ProviderDeps, PublisherOAuthConnector } from '@seo/contracts';

/**
 * X API base. api.x.com is the API host (token + tweets + users/me) and wants
 * a Bearer token, so it can NOT serve the browser consent page. The consent
 * page lives on x.com/i/oauth2/authorize (the pre-rebrand twitter.com URL
 * redirects there too).
 */
export const X_API_BASE = 'https://api.x.com';
export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_URL = `${X_API_BASE}/2/oauth2/token`;
export const X_POST_MAX_CHARS = 280;

/** Scopes needed for text-only posting + the offline refresh token. */
export const X_SCOPES = 'tweet.read tweet.write users.read offline.access';

/** Credential vault keys used for the stored token pair. */
export const X_CRED = {
  access: 'x_access_token',
  refresh: 'x_refresh_token',
} as const;

/** Non-secret seo_publishers.config keys written after a successful connect. */
export const X_IDENTITY_CONFIG_KEYS = {
  id: 'remote_account_id',
  name: 'remote_account_name',
  username: 'remote_account_username',
} as const;

export interface XUser {
  id: string;
  name: string;
  username: string;
}

export interface XTweet {
  id: string;
  text: string;
}

export interface XProblem {
  title?: string;
  detail?: string;
  type?: string;
}

export class XApiError extends Error {
  constructor(
    message: string,
    /** Remote HTTP status; 0 when the request itself failed. */
    public readonly status: number,
    public readonly problem?: XProblem,
  ) {
    super(message);
    this.name = 'XApiError';
  }
}

/** Parse a (possibly non-JSON) error response into a safe problem object. */
function problemFromJson(json: unknown): XProblem {
  const obj = (json ?? {}) as { title?: string; detail?: string; type?: string };
  return { title: obj.title, detail: obj.detail, type: obj.type };
}

/** Normalized token result from the X token endpoint. */
async function parseTokenResponse(res: Response): Promise<OAuthTokenResult> {
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== 'string') {
    const detail = String(json.error_description ?? json.error ?? `HTTP ${res.status}`);
    throw new XApiError(detail, res.status, { detail });
  }
  return {
    access_token: json.access_token as string,
    refresh_token: (json.refresh_token as string) ?? undefined,
    expires_in: typeof json.expires_in === 'number' ? json.expires_in : undefined,
    scope: (json.scope as string) ?? undefined,
  };
}

export class XOAuthClient {
  constructor(
    private readonly clientId: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.clientId);
  }

  /** Consent URL the browser is sent to (S256 PKCE, offline refresh). */
  authorizeUrl(opts: { redirectUri: string; state: string; codeChallenge: string }): string {
    if (!this.configured) throw new Error('X OAuth client id is not configured on the server');
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: opts.redirectUri,
      response_type: 'code',
      scope: X_SCOPES,
      state: opts.state,
      code_challenge: opts.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${X_AUTHORIZE_URL}?${params.toString()}`;
  }

  /** Exchange the callback authorization code for a token pair (PKCE). */
  async exchangeCode(opts: { code: string; redirectUri: string; codeVerifier: string }): Promise<OAuthTokenResult> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: this.clientId,
      code_verifier: opts.codeVerifier,
    });
    const res = await this.fetchFn(X_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    return parseTokenResponse(res);
  }

  /** Rotate an expired access token. Public clients send only client_id. */
  async refreshAccessToken(refreshToken: string): Promise<OAuthTokenResult> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
    });
    const res = await this.fetchFn(X_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    return parseTokenResponse(res);
  }

  /** The connected account (used after connect and to verify tokens). */
  async fetchAuthenticatedUser(accessToken: string): Promise<XUser> {
    const json = await this.jsonRequest('GET', '/2/users/me?user.fields=name,username', accessToken);
    const data = (json?.data ?? {}) as Record<string, unknown>;
    if (!json || typeof data.id !== 'string' || typeof data.username !== 'string') {
      throw new XApiError('X /users/me returned an unexpected response', 200);
    }
    return {
      id: data.id,
      username: data.username,
      name: typeof data.name === 'string' ? data.name : data.username,
    };
  }

  /** Create a text post. Only a real X success returns a tweet id. */
  async createPost(accessToken: string, text: string): Promise<XTweet> {
    const json = await this.jsonRequest('POST', '/2/tweets', accessToken, { text });
    const data = (json?.data ?? {}) as Record<string, unknown>;
    if (!json || typeof data.id !== 'string') {
      throw new XApiError('X /tweets returned an unexpected response', 200);
    }
    return { id: data.id, text: typeof data.text === 'string' ? data.text : text };
  }

  private async jsonRequest(
    method: 'GET' | 'POST',
    path: string,
    accessToken: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const res = await this.fetchFn(`${X_API_BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const problem = problemFromJson(json);
      const message = problem.detail ?? problem.title ?? `X returned HTTP ${res.status}`;
      throw new XApiError(message, res.status, problem);
    }
    return json;
  }
}

// ---------------------------------------------------------------------------
// Publisher OAuth connector (registered per provider - generic routes dispatch
// on it, so no X-specific logic lives in the routes or the UI)
// ---------------------------------------------------------------------------

export class XOAuthConnector implements PublisherOAuthConnector {
  readonly providerId = 'x';
  readonly scopes = X_SCOPES;

  constructor(private readonly deps: ProviderDeps) {}

  get configured(): boolean {
    return Boolean(this.deps.config.X_OAUTH_CLIENT_ID);
  }

  private client(): XOAuthClient {
    return new XOAuthClient(this.deps.config.X_OAUTH_CLIENT_ID ?? '', this.deps.fetchFn);
  }

  authorizeUrl(opts: { redirectUri: string; state: string; codeChallenge: string }): string {
    return this.client().authorizeUrl(opts);
  }

  exchangeCode(opts: { code: string; redirectUri: string; codeVerifier: string }): Promise<OAuthTokenResult> {
    return this.client().exchangeCode(opts);
  }

  async saveTokens(ctx: ProviderContext, tokens: OAuthTokenResult): Promise<void> {
    const scope = tokens.scope ?? X_SCOPES;
    await ctx.credentials.set(X_CRED.access, tokens.access_token, { scope });
    if (tokens.refresh_token) {
      await ctx.credentials.set(X_CRED.refresh, tokens.refresh_token, { scope });
    }
  }

  async fetchIdentity(ctx: ProviderContext): Promise<OAuthAccountIdentity> {
    const access = await ctx.credentials.get(X_CRED.access);
    if (!access) throw new Error('No X access token is stored for this publisher');
    const user = await this.client().fetchAuthenticatedUser(access);
    return { id: user.id, name: user.name, username: user.username };
  }
}

/**
 * Approximate X post length in "weighted" characters. Every http(s) URL counts
 * as the t.co width (23) because X shortens them; everything else counts per
 * Unicode code point (astral-safe). This is deliberately conservative (never
 * auto-shortens) - X re-validates on its side and rejects if we mis-estimate.
 */
export function xPostCharacterCount(text: string): number {
  const urlAware = String(text).replace(/https?:\/\/\S+/gi, 'x'.repeat(23));
  return Array.from(urlAware).length;
}
