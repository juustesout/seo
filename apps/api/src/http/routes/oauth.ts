/**
 * OAuth callbacks - the browser lands here after a vendor consent screen, so
 * unlike every other router these routes are NOT session-authenticated and
 * always redirect rather than return JSON. Two flows share this router:
 *
 *  - GET /gsc/callback   - Google Search Console connect (project- or
 *    account-scoped). The signed `state` decides the scope; it is verified
 *    with CREDENTIALS_ENCRYPTION_KEY before the code is exchanged, so a forged
 *    or tampered callback cannot attach tokens to an integration/project the
 *    user never authorized. Tokens are stored encrypted under the integration
 *    and the flow redirects back into the app.
 *  - GET /ga4/callback   - account-scoped Google Analytics (GA4) connect. Same
 *    signed-state handshake, stored under the account's separate 'ga4'
 *    integration so the GSC connection is never altered.
 *  - GET /ads/callback   - account-scoped Google Ads connect. Same machinery,
 *    stored under the account's separate 'ads' integration.
 *  - GET /publisher/callback - generic publisher connect-by-consent (e.g. X);
 *    all flow logic lives in publisherOAuthService so no vendor logic is here.
 *
 * Error handling differs from the JSON API on purpose: a callback failure must
 * still navigate the browser somewhere meaningful, so errors become a short
 * oauth_error code on the app URL instead of a thrown 4xx JSON body.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { exchangeCode, verifyState } from '../../providers/gsc/oauth.js';
import { googleOAuthProvider, type GoogleOAuthProvider } from '../../providers/google/oauthProviders.js';
import { publisherOAuthComplete } from '../../services/publisherOAuthService.js';
import { redirectBase } from './utils.js';
import { logger } from '../../logger.js';

export const oauthRouter: Router = Router();

/**
 * One provider-aware handler for every Google consent callback. The descriptor
 * declares the only real differences (scopes, callback path, token owner,
 * redirect); the handshake, scoping, encryption and persistence are identical.
 * Signed state is verified with CREDENTIALS_ENCRYPTION_KEY before the code is
 * exchanged, so a forged callback cannot attach tokens to an integration the
 * user never authorized.
 */
async function handleGoogleCallback(req: Request, res: Response, provider: GoogleOAuthProvider): Promise<void> {
  const container = req.container;
  const parsed = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
  const base = redirectBase(req);

  if (parsed.error) {
    logger.warn({ error: parsed.error, provider: provider.providerType }, `${provider.providerType} oauth error`);
    res.redirect(provider.errorRedirect(base, parsed.error));
    return;
  }
  if (!parsed.code || !parsed.state) {
    throw ApiError.badRequest('Missing OAuth code or state');
  }

  const key = container.config.env.CREDENTIALS_ENCRYPTION_KEY;
  const clientId = container.config.env.GOOGLE_CLIENT_ID;
  const clientSecret = container.config.env.GOOGLE_CLIENT_SECRET;
  if (!key || !clientId || !clientSecret) {
    throw ApiError.notConfigured('Google OAuth or credential storage is not configured');
  }

  let state;
  try {
    state = verifyState(parsed.state, key);
  } catch (err) {
    logger.warn({ err: (err as Error).message, provider: provider.providerType }, 'oauth state verification failed');
    throw ApiError.forbidden('Invalid OAuth state');
  }

  // Confirm the integration still belongs to this project or account, and to
  // this Google product (the state is signed server-side, so its scope cannot
  // be tampered with).
  let query = container.sb
    .from('seo_integrations')
    .select('id, config')
    .eq('id', state.integrationId)
    .eq('provider_type', provider.providerType);
  if (state.accountId) {
    query = query.eq('account_id', state.accountId).is('project_id', null);
  } else if (state.projectId) {
    query = query.eq('project_id', state.projectId);
  } else {
    throw ApiError.badRequest('OAuth state has no scope');
  }
  const { data: integration } = await query.maybeSingle();
  if (!integration) throw ApiError.notFound('Integration no longer exists');
  if (provider.accountScopedOnly && !state.accountId) {
    throw ApiError.badRequest('OAuth state has no account scope');
  }

  const redirectUri = `${base}${provider.callbackPath}`;
  const tokens = await exchangeCode({ clientId, clientSecret, code: parsed.code, redirectUri });

  const creds = container.credentials.reader({ integrationId: state.integrationId }, provider.providerType);
  await creds.set(provider.tokenKeys.access, tokens.access_token, { scope: tokens.scope ?? provider.scopes });
  if (tokens.refresh_token) {
    await creds.set(provider.tokenKeys.refresh, tokens.refresh_token, { scope: tokens.scope ?? provider.scopes });
  }
  if (tokens.scope) {
    await creds.set(provider.tokenKeys.scope, tokens.scope);
  }

  // Best-effort identity so the UI can show "Connected as ...". A failure to
  // read it must not fail the connect itself.
  let email: string | null = null;
  try {
    email = await provider.resolveIdentity(tokens.access_token);
  } catch (err) {
    logger.warn({ err: (err as Error).message, provider: provider.providerType }, `${provider.providerType} identity lookup failed`);
  }
  const patch: Record<string, unknown> = { status: 'connected', last_error: null };
  if (email) {
    const existing = (integration.config as Record<string, unknown> | null) ?? {};
    patch.config = { ...existing, google_email: email };
  }

  await container.sb.from('seo_integrations').update(patch).eq('id', state.integrationId);

  logger.info(
    {
      provider: provider.providerType,
      scope: state.accountId ? 'account' : 'project',
      integrationId: state.integrationId,
      accountId: state.accountId ?? null,
      projectId: state.projectId ?? null,
    },
    `${provider.providerType} oauth completed`,
  );
  res.redirect(provider.successRedirect(base, state));
}

/** Google Search Console consent callback (project- and account-scoped connects). */
oauthRouter.get(
  '/gsc/callback',
  asyncHandler((req, res) => handleGoogleCallback(req, res, googleOAuthProvider('gsc'))),
);

/** Google Analytics (GA4) consent callback (account-scoped connects only). */
oauthRouter.get(
  '/ga4/callback',
  asyncHandler((req, res) => handleGoogleCallback(req, res, googleOAuthProvider('ga4'))),
);

/** Google Ads consent callback (account-scoped connects only). */
oauthRouter.get(
  '/ads/callback',
  asyncHandler((req, res) => handleGoogleCallback(req, res, googleOAuthProvider('ads'))),
);

/**
 * Generic publisher OAuth callback (e.g. X connect-by-consent). Unauthenticated
 * by design - the browser lands here from the vendor consent screen. Every
 * outcome redirects back into the app with a short oauth_error code when the
 * connect did not succeed; the flow logic lives in publisherOAuthService.
 */
oauthRouter.get(
  '/publisher/callback',
  asyncHandler(async (req, res) => {
    const container = req.container;
    const parsed = z
      .object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() })
      .parse(req.query);
    const redirect = await publisherOAuthComplete(container, {
      code: parsed.code,
      state: parsed.state,
      error: parsed.error,
      redirectBase: redirectBase(req),
    });
    res.redirect(redirect);
  }),
);
