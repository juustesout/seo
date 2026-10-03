/**
 * Google OAuth flow descriptors (P4.5).
 *
 * The platform runs one Google OAuth client for every Google product. Search
 * Console and Analytics differ only in their scopes, callback path, token
 * owner and post-consent redirect - never in the OAuth machinery. This module
 * is the single place that difference is declared, so the callback router has
 * one provider-aware handler instead of one hardcoded handler per product.
 *
 * This is not a second authorization system and not a provider-registry entry:
 * the account-scoped integration model (GSC account-or-legacy-project, GA4
 * account-only) is unchanged. A future Google Ads integration adds one entry
 * here and reuses the same signed-state + AES credential store.
 */

import { GSC_SCOPES, type OAuthState } from '../gsc/oauth.js';
import { GA4_SCOPES } from '../ga4/scopes.js';
import { GoogleAnalyticsClient } from '../ga4/googleAnalyticsClient.js';

/** Google products the platform currently authorizes against. */
export type GoogleProviderType = 'gsc' | 'ga4';

/** Encrypted-credential keys under which a Google token triple is stored. */
export interface GoogleTokenKeys {
  access: string;
  refresh: string;
  scope: string;
}

export interface GoogleOAuthProvider {
  providerType: GoogleProviderType;
  /** Stable registered redirect path; part of the Google Cloud console config. */
  callbackPath: string;
  /** Scopes requested on the consent screen. */
  scopes: string;
  tokenKeys: GoogleTokenKeys;
  /** True when only an account-scoped integration is valid (GA4). */
  accountScopedOnly: boolean;
  /** Best-effort display identity from a fresh access token; null when none. */
  resolveIdentity(accessToken: string): Promise<string | null>;
  /** Success redirect back into the app. */
  successRedirect(base: string, state: OAuthState): string;
  /** Consent-failure redirect back into the app. */
  errorRedirect(base: string, error: string): string;
}

const TOKEN_KEYS: GoogleTokenKeys = {
  access: 'google_access_token',
  refresh: 'google_refresh_token',
  scope: 'google_token_scope',
};

const GSC_PROVIDER: GoogleOAuthProvider = {
  providerType: 'gsc',
  callbackPath: '/api/oauth/gsc/callback',
  scopes: GSC_SCOPES,
  tokenKeys: TOKEN_KEYS,
  accountScopedOnly: false,
  resolveIdentity: async () => null,
  successRedirect(base, state) {
    if (state.accountId) return `${base}/overview?gsc=connected`;
    if (state.projectId) return `${base}/p/${state.projectId}/integrations?gsc=connected`;
    return `${base}/overview`;
  },
  errorRedirect: (base, error) => `${base}/p?oauth_error=${encodeURIComponent(error)}`,
};

const GA4_PROVIDER: GoogleOAuthProvider = {
  providerType: 'ga4',
  callbackPath: '/api/oauth/ga4/callback',
  scopes: GA4_SCOPES,
  tokenKeys: TOKEN_KEYS,
  accountScopedOnly: true,
  resolveIdentity: (accessToken) => new GoogleAnalyticsClient(accessToken).getUserEmail(),
  successRedirect: (base) => `${base}/integrations?analytics=connected`,
  errorRedirect: (base, error) => `${base}/integrations?analytics_error=${encodeURIComponent(error)}`,
};

const PROVIDERS: Record<GoogleProviderType, GoogleOAuthProvider> = {
  gsc: GSC_PROVIDER,
  ga4: GA4_PROVIDER,
};

/** Resolve the descriptor for one Google product. */
export function googleOAuthProvider(type: GoogleProviderType): GoogleOAuthProvider {
  return PROVIDERS[type];
}
