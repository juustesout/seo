/** Google OAuth callback: exchanges the auth code, stores tokens, redirects back to the app. */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { exchangeCode, verifyState, GSC_SCOPES } from '../../providers/gsc/oauth.js';
import { redirectBase } from './utils.js';
import { logger } from '../../logger.js';

export const oauthRouter: Router = Router();

const TOKEN_KEYS = {
  access: 'google_access_token',
  refresh: 'google_refresh_token',
  scope: 'google_token_scope',
} as const;

oauthRouter.get(
  '/gsc/callback',
  asyncHandler(async (req, res) => {
    const container = req.container;
    const parsed = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query);
    const base = redirectBase(req);

    if (parsed.error) {
      logger.warn({ error: parsed.error }, 'gsc oauth error');
      res.redirect(`${base}/p?oauth_error=${encodeURIComponent(parsed.error)}`);
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
      logger.warn({ err: (err as Error).message }, 'oauth state verification failed');
      throw ApiError.forbidden('Invalid OAuth state');
    }

    // Confirm the integration still belongs to this project.
    const { data: integration } = await container.sb
      .from('seo_integrations')
      .select('id')
      .eq('id', state.integrationId)
      .eq('project_id', state.projectId)
      .maybeSingle();
    if (!integration) throw ApiError.notFound('Integration no longer exists');

    const redirectUri = `${base}/api/oauth/gsc/callback`;
    const tokens = await exchangeCode({ clientId, clientSecret, code: parsed.code, redirectUri });

    const creds = container.credentials.reader({ integrationId: state.integrationId }, 'gsc');
    await creds.set(TOKEN_KEYS.access, tokens.access_token, { scope: tokens.scope ?? GSC_SCOPES });
    if (tokens.refresh_token) {
      await creds.set(TOKEN_KEYS.refresh, tokens.refresh_token, { scope: tokens.scope ?? GSC_SCOPES });
    }
    await container.sb
      .from('seo_integrations')
      .update({ status: 'connected', last_error: null })
      .eq('id', state.integrationId);

    logger.info({ projectId: state.projectId, integrationId: state.integrationId }, 'gsc oauth completed');
    res.redirect(`${base}/p/${state.projectId}/integrations?gsc=connected`);
  }),
);
