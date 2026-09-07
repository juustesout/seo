/**
 * X (Twitter) publisher adapter - live text posting (Content Studio Phase H6.2).
 *
 * Registered with publish_text + schedule so gates/flows treat it as a real
 * text-only channel. Posts go through the real X API v2 (POST /2/tweets) using
 * tokens obtained via the OAuth connect flow and stored encrypted per
 * publisher. Honesty rules:
 *   - a remote_id / target_url is only produced on a genuine X API success;
 *   - an expired access token is silently refreshed ONCE and the post retried
 *     exactly once (X refresh tokens rotate, so a stale refresh is terminal);
 *   - local 280-char validation refuses over-long posts before any remote call
 *     (no auto-truncation, no fake success);
 *   - X errors are mapped onto PublisherError so the worker/job surface never
 *     sees raw platform text; update/delete stay honest "not available".
 */

import type {
  DataSourceConnectionResult,
  ProviderContext,
  ProviderDeps,
  PublishInput,
  PublisherProvider,
  PublishResult,
} from '@seo/contracts';
import { PublisherError } from '../publisherError.js';
import { buildSocialTextPost } from './textPayload.js';
import {
  XApiError,
  XOAuthClient,
  X_CRED,
  X_IDENTITY_CONFIG_KEYS,
  X_POST_MAX_CHARS,
  xPostCharacterCount,
} from './xOAuth.js';

const NOT_CONNECTED =
  'X is not connected. Run "Connect with X" in Publishing first - nothing was posted.';
const NO_UPDATE_DELETE =
  'Updating or deleting X posts is not supported yet. Nothing was changed on X.';

/**
 * X adapter. Wraps XOAuthClient (raw HTTP + token calls) and turns it into a
 * PublisherProvider: it owns token lifecycle during publish (read -> possibly
 * refresh-on-401 once), payload validation against the 280-char reality of X,
 * error normalization onto PublisherError and identity-based connect checks.
 * Deliberately stateless: every call builds a fresh XOAuthClient and reads the
 * current tokens from ctx.credentials so no stale token ever sits in memory.
 */
export class XPublisher implements PublisherProvider {
  readonly id = 'x';
  readonly name = 'X';
  readonly description = 'Publish short text posts to X via its OAuth-connected API';
  readonly capabilities = ['publish_text', 'schedule'] as const;

  constructor(private readonly deps: ProviderDeps) {}

  /** Fresh, stateless X API client bound to the server's OAuth client id. */
  private client(): XOAuthClient {
    return new XOAuthClient(this.deps.config.X_OAUTH_CLIENT_ID ?? '', this.deps.fetchFn);
  }

  /** Terminal auth error: the user must reconnect the channel; retrying cannot help. */
  private authFailed(message: string, status = 401): PublisherError {
    return new PublisherError('publisher_auth_failed', message, { status, retryable: false });
  }

  /**
   * Normalize any error from the X client onto the shared PublisherError surface.
   *
   * Classification rules (why each maps where):
   *   429  -> rate_limited, retryable (X asks us to back off; same payload is fine later).
   *   401  -> auth_failed, terminal (bad/expired token; handled upstream by refresh-once,
   *          reaching here means the refresh also failed or the token was never present).
   *   403  -> mostly a *content rule* (duplicate tweet, disallowed media), i.e. the token
   *          is fine but X refuses this content: rejected_content when the problem text
   *          signals that, otherwise auth_failed as a safe fallback. Never retryable.
   *   other 4xx -> rejected_content (X refused the specific request).
   *   5xx/network -> remote_error, retryable (transient server fault).
   * Unknown/non-X errors become remote_error with the message truncated to 300 chars so a
   * vendor error string can never blow up the persisted job error or leak internals.
   */
  private mapError(err: unknown): PublisherError {
    if (err instanceof XApiError) {
      const detail = (err.problem?.detail ?? err.problem?.title ?? `X returned HTTP ${err.status}`).slice(0, 300);
      if (err.status === 429) {
        return new PublisherError('publisher_rate_limited', detail, { status: 429, retryable: true });
      }
      if (err.status === 401) {
        return new PublisherError('publisher_auth_failed', detail, { status: 401, retryable: false });
      }
      // 403 is usually a content rule (e.g. duplicate) rather than a token issue.
      if (err.status === 403) {
        const rejected = (err.problem?.title ?? err.problem?.type ?? '').toLowerCase();
        if (rejected.includes('duplicate') || rejected.includes('disallowed') || rejected.includes('forbidden')) {
          return new PublisherError('publisher_rejected_content', detail, { status: 403, retryable: false });
        }
        return new PublisherError('publisher_auth_failed', detail, { status: 403, retryable: false });
      }
      if (err.status >= 400 && err.status < 500) {
        return new PublisherError('publisher_rejected_content', detail, { status: err.status, retryable: false });
      }
      return new PublisherError('publisher_remote_error', detail, { status: err.status, retryable: true });
    }
    const message = err instanceof Error ? err.message : 'X request failed';
    return new PublisherError('publisher_remote_error', String(message).slice(0, 300), { retryable: true });
  }

  /**
   * Rotate a stored refresh token; throws a terminal auth error when it fails.
   *
   * X *refresh tokens rotate*: the token endpoint returns a new refresh_token on
   * every refresh, so the freshly returned pair must be persisted immediately.
   * The rotation is written to the encrypted credential store before the caller
   * retries with the new access token - if that retry then fails, the stored
   * pair is still the newest one and a later publish can refresh again. A stale
   * refresh token (already rotated by a concurrent publish) surfaces as
   * 400/401/403 from the token endpoint and is mapped to a terminal auth error
   * telling the user to reconnect - X never accepts an old refresh token twice.
   */
  private async refreshOnce(ctx: ProviderContext): Promise<string> {
    const refresh = await ctx.credentials.get(X_CRED.refresh);
    if (!refresh) {
      throw this.authFailed('X session expired and no refresh token is stored - reconnect the account');
    }
    let fresh: Awaited<ReturnType<XOAuthClient['refreshAccessToken']>>;
    try {
      fresh = await this.client().refreshAccessToken(refresh);
    } catch (err) {
      if (err instanceof XApiError && (err.status === 400 || err.status === 401 || err.status === 403)) {
        // Invalid/expired/revoked grant -> the user must reconnect.
        throw this.authFailed('X could not refresh the session - reconnect the account', err.status);
      }
      throw this.mapError(err);
    }
    await ctx.credentials.set(X_CRED.access, fresh.access_token, { note: 'refreshed during publish' });
    if (fresh.refresh_token && fresh.refresh_token !== refresh) {
      await ctx.credentials.set(X_CRED.refresh, fresh.refresh_token, { note: 'rotated during publish' });
    }
    return fresh.access_token;
  }

  /**
   * Run an authenticated X call, retrying exactly once after a silent token
   * refresh when X answers 401 (expired access token). Any other error is
   * normalized immediately.
   */
  private async withToken<T>(ctx: ProviderContext, run: (accessToken: string) => Promise<T>): Promise<T> {
    const access = await ctx.credentials.get(X_CRED.access);
    if (!access) throw this.authFailed(NOT_CONNECTED);
    try {
      return await run(access);
    } catch (err) {
      if (!(err instanceof XApiError) || err.status !== 401) throw this.mapError(err);
      const refreshed = await this.refreshOnce(ctx);
      try {
        return await run(refreshed);
      } catch (retryErr) {
        throw this.mapError(retryErr);
      }
    }
  }

  /**
   * Resolve the connected X identity from the stored tokens. Any auth problem
   * (no token stored, expired + refresh failed) is turned into a user-safe
   * message instead of an exception so connect/test can report a clean
   * `ok: false, message` rather than surfacing a raw provider error to the UI.
   */
  private async verifiedIdentity(ctx: ProviderContext): Promise<{ ok: boolean; message: string; user?: { id: string; name: string; username: string } }> {
    const stored = await ctx.credentials.get(X_CRED.access);
    if (!stored) return { ok: false, message: NOT_CONNECTED };
    try {
      const user = await this.withToken(ctx, (token) => this.client().fetchAuthenticatedUser(token));
      return { ok: true, message: `Authenticated as @${user.username}`, user };
    } catch (err) {
      if (err instanceof PublisherError) return { ok: false, message: err.message };
      throw err;
    }
  }

  async connect(ctx: ProviderContext): Promise<DataSourceConnectionResult> {
    const identity = await this.verifiedIdentity(ctx);
    if (!identity.ok || !identity.user) {
      return { ok: false, message: identity.message };
    }
    return {
      ok: true,
      message: `Connected to X as @${identity.user.username} (${identity.user.name})`,
      external: [{ id: identity.user.id, label: `@${identity.user.username}`, url: `https://x.com/${identity.user.username}` }],
    };
  }

  async disconnect(): Promise<void> {
    // token rows are cleared by the caller (publisher store / disconnect route)
  }

  async testConnection(ctx: ProviderContext): Promise<{ ok: boolean; message?: string }> {
    const identity = await this.verifiedIdentity(ctx);
    if (identity.ok) return { ok: true, message: identity.message };
    return { ok: false, message: identity.message };
  }

  async publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult> {
    const { text } = buildSocialTextPost(input);
    const body = String(text).trim();
    if (!body) {
      throw new PublisherError('publisher_rejected_content', 'Nothing to post: the content produced no text', { retryable: false });
    }
    const count = xPostCharacterCount(body);
    if (count > X_POST_MAX_CHARS) {
      throw new PublisherError(
        'publisher_rejected_content',
        `Post is ${count} characters; X allows up to ${X_POST_MAX_CHARS} (no auto-truncation)`,
        { retryable: false },
      );
    }
    const tweet = await this.withToken(ctx, (access) => this.client().createPost(access, body));
    ctx.logger.info('X post created', { remoteId: tweet.id });
    const username = ctx.config[X_IDENTITY_CONFIG_KEYS.username];
    const handle = typeof username === 'string' && username.trim() ? username.trim() : null;
    return {
      remoteId: tweet.id,
      // Only derived after a genuine X success; null when the handle is unknown.
      url: handle ? `https://x.com/${handle}/status/${tweet.id}` : null,
    };
  }

  async update(_ctx: ProviderContext, _remoteId: string, _input: PublishInput): Promise<PublishResult> {
    throw new PublisherError('publisher_not_available', NO_UPDATE_DELETE, { retryable: false });
  }

  async delete(_ctx: ProviderContext, _remoteId: string): Promise<void> {
    throw new PublisherError('publisher_not_available', NO_UPDATE_DELETE, { retryable: false });
  }
}
