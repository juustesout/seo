/**
 * Generic "connect a publisher by OAuth consent" flow (Content Studio Phase H6.2).
 *
 * Publishers that connect by sending the user to a consent screen (e.g. X)
 * declare `setup.auth = 'oauth'` plus a PublisherOAuthConnector in the
 * registry. This service owns the two generic HTTP touchpoints the browser
 * sees - starting the flow and completing the callback - so no per-vendor
 * logic leaks into the routes:
 *   - start: load the publisher + connector, mint a signed state (embedding a
 *     PKCE verifier) and hand back the consent URL;
 *   - complete: verify the signed state, exchange the code with the verifier,
 *     store the token pair encrypted under the publisher, record the connected
 *     account identity on seo_publishers.config and produce the app redirect.
 *
 * The callback always redirects (browser navigation, never a JSON error) and
 * never surfaces raw platform/token text - failures become a short oauth_error
 * code on the app URL.
 */

import { randomUUID } from 'node:crypto';
import type { ProviderContext } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { logger } from '../logger.js';
import { createPkcePair } from '../infra/oauthPkce.js';
import { signJsonPayload, verifyJsonPayload } from '../infra/signedPayload.js';

export const PUBLISHER_OAUTH_CALLBACK_PATH = '/api/oauth/publisher/callback';

/** Neutral keys under which a connected account identity is stored on config. */
export const PUBLISHER_ACCOUNT_KEYS = {
  id: 'remote_account_id',
  name: 'remote_account_name',
  username: 'remote_account_username',
} as const;

export interface PublisherOAuthState {
  v: 1;
  projectId: string;
  publisherId: string;
  provider: string;
  userId: string;
  nonce: string;
  verifier: string;
}

/**
 * The HMAC secret for OAuth states. It deliberately reuses
 * CREDENTIALS_ENCRYPTION_KEY: state tokens must be verifiable from any
 * API/worker process and survive deploys (they live only a few minutes, but a
 * pod restart mid-flow must not invalidate them), and the platform already
 * guarantees this key is set, stable and never shipped to the browser. An
 * empty string here means "not configured" and blocks the whole flow.
 */
function stateSecret(container: ServiceContainer): string {
  return container.config.env.CREDENTIALS_ENCRYPTION_KEY ?? '';
}

/**
 * Build the ProviderContext the connector sees during this flow. The
 * credential reader is scoped to this publisher row + provider (so tokens land
 * under the right encrypted scope), the logger is namespaced per project +
 * provider, and userId is the acting user - or null for background flows.
 */
function publisherCtx(
  container: ServiceContainer,
  args: { projectId: string; userId: string; publisherId: string; provider: string; config: Record<string, unknown> },
): ProviderContext {
  const child = logger.child({ projectId: args.projectId, provider: args.provider });
  const safeLogger: ProviderContext['logger'] = {
    info: (m, meta) => child.info(meta ?? {}, m),
    warn: (m, meta) => child.warn(meta ?? {}, m),
    error: (m, meta) => child.error(meta ?? {}, m),
    debug: (m, meta) => child.debug(meta ?? {}, m),
  };
  return {
    projectId: args.projectId,
    userId: args.userId,
    config: args.config,
    credentials: container.credentials.reader({ publisherId: args.publisherId }, args.provider),
    logger: safeLogger,
  };
}

/** Load a publisher row scoped to the project; null when it does not exist there. */
async function loadPublisher(
  container: ServiceContainer,
  projectId: string,
  publisherId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await container.sb
    .from('seo_publishers')
    .select('*')
    .eq('project_id', projectId)
    .eq('id', publisherId)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

/** Human-readable provider name for error messages (falls back to the provider id). */
function descriptorName(container: ServiceContainer, provider: string): string {
  return container.registry.listPublishers().find((p) => p.id === provider)?.name ?? provider;
}

/**
 * Start a publisher OAuth connect. Returns the consent URL (and the exact
 * redirect_uri the callback must match). Throws ApiError on invalid state.
 */
export async function publisherOAuthStart(
  container: ServiceContainer,
  args: { projectId: string; publisherId: string; userId: string; redirectBase: string },
): Promise<{ url: string; redirectUri: string }> {
  if (!container.config.encryptionConfigured || !stateSecret(container)) {
    throw ApiError.notConfigured('Credential storage is not configured (CREDENTIALS_ENCRYPTION_KEY)');
  }
  const publisher = await loadPublisher(container, args.projectId, args.publisherId);
  if (!publisher) throw ApiError.notFound('Publisher not found for this project');
  const provider = String(publisher.provider);
  const connector = container.registry.getPublisherOAuth(provider);
  if (!connector) {
    throw ApiError.badRequest(`Publisher provider '${provider}' does not support OAuth connect`);
  }
  if (!connector.configured) {
    throw ApiError.notConfigured(`${descriptorName(container, provider)} OAuth is not configured on the server`);
  }

  // The PKCE verifier travels inside the signed state, not a server-side
  // session: the flow is stateless across pods/restarts, and because the state
  // is HMAC-signed with CREDENTIALS_ENCRYPTION_KEY, only this platform can read
  // the verifier back. That binds the code exchange to the exact flow that
  // started it (CSRF-proof) without persisting anything between start/callback.
  const pkce = createPkcePair();
  const state = signJsonPayload(
    {
      v: 1,
      projectId: args.projectId,
      publisherId: args.publisherId,
      provider,
      userId: args.userId,
      nonce: randomUUID(),
      verifier: pkce.codeVerifier,
    },
    stateSecret(container),
  );
  const redirectUri = `${args.redirectBase}${PUBLISHER_OAUTH_CALLBACK_PATH}`;
  const url = connector.authorizeUrl({ redirectUri, state, codeChallenge: pkce.codeChallenge });
  logger.info({ provider, publisherId: args.publisherId, projectId: args.projectId }, 'publisher oauth started');
  return { url, redirectUri };
}

/**
 * Complete a publisher OAuth callback (browser redirect). Never throws - every
 * outcome is a redirect URL back into the app, with failures expressed as a
 * short oauth_error query code (no raw platform text, no secrets).
 */
export async function publisherOAuthComplete(
  container: ServiceContainer,
  args: { code?: string; state?: string; error?: string; redirectBase: string },
): Promise<string> {
  const { code, state, error } = args;
  const secret = stateSecret(container);

  // A pre-decode of the signed payload just to learn the project for redirects
  // when the signature checks out; forged states never reach that branch.
  let parsed: PublisherOAuthState | null = null;
  if (state) {
    try {
      parsed = verifyJsonPayload<PublisherOAuthState>(state, secret);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'publisher oauth state verification failed');
    }
  }

  const publishingUrl = (projectId: string) => `${args.redirectBase}/p/${projectId}/publishing`;
  const errorRedirect = (codeValue: string, projectId?: string) =>
    projectId
      ? `${publishingUrl(projectId)}?oauth_error=${encodeURIComponent(codeValue)}`
      : `${args.redirectBase}/p?oauth_error=${encodeURIComponent(codeValue)}`;

  if (error) {
    logger.warn({ error, projectId: parsed?.projectId ?? null }, 'publisher oauth denied or errored');
    return errorRedirect('denied', parsed?.projectId);
  }
  if (!secret) return errorRedirect('not_configured', parsed?.projectId);
  if (!code || !parsed) return errorRedirect('invalid_state', parsed?.projectId);

  const publisher = await loadPublisher(container, parsed.projectId, parsed.publisherId);
  if (!publisher || String(publisher.provider) !== parsed.provider) {
    logger.warn({ projectId: parsed.projectId, publisherId: parsed.publisherId }, 'publisher oauth target missing');
    return errorRedirect('publisher_missing', parsed.projectId);
  }

  const provider = parsed.provider;
  const connector = container.registry.getPublisherOAuth(provider);
  if (!connector) return errorRedirect('unsupported', parsed.projectId);
  if (!connector.configured) return errorRedirect('not_configured', parsed.projectId);

  const config = (publisher.config as Record<string, unknown> | null) ?? {};
  const ctx = publisherCtx(container, {
    projectId: parsed.projectId,
    userId: parsed.userId,
    publisherId: parsed.publisherId,
    provider,
    config,
  });

  try {
    const redirectUri = `${args.redirectBase}${PUBLISHER_OAUTH_CALLBACK_PATH}`;
    // Exchange + persist the token pair server-side. The access/refresh tokens
    // are written into the publisher's encrypted credential scope and NEVER
    // appear in the callback redirect, the UI or any response body - the app
    // only learns "connected" via the account identity written to config.
    const tokens = await connector.exchangeCode({ code, redirectUri, codeVerifier: parsed.verifier });
    await connector.saveTokens(ctx, tokens);
    const identity = await connector.fetchIdentity(ctx);

    const configPatch: Record<string, unknown> = { ...config };
    configPatch[PUBLISHER_ACCOUNT_KEYS.id] = identity.id;
    if (identity.name) configPatch[PUBLISHER_ACCOUNT_KEYS.name] = identity.name;
    if (identity.username) configPatch[PUBLISHER_ACCOUNT_KEYS.username] = identity.username;

    const { error: updateError } = await container.sb
      .from('seo_publishers')
      .update({ status: 'connected', config: configPatch, last_error: null })
      .eq('project_id', parsed.projectId)
      .eq('id', parsed.publisherId);
    if (updateError) throw new Error(`Could not persist connected publisher: ${updateError.message}`);

    logger.info(
      { provider, projectId: parsed.projectId, publisherId: parsed.publisherId, accountId: identity.id },
      'publisher oauth completed',
    );
    return `${publishingUrl(parsed.projectId)}?x=connected`;
  } catch (err) {
    const notConfigured = err instanceof ApiError && err.code === 'not_configured';
    logger.error({ err, provider, projectId: parsed.projectId }, 'publisher oauth connect failed');
    return errorRedirect(notConfigured ? 'not_configured' : 'connect_failed', parsed.projectId);
  }
}
