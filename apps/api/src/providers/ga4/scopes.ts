/**
 * Google Analytics (GA4) OAuth constants.
 *
 * The minimum read-only scope for the Google Analytics Data API (runReport) and
 * the Admin API's accountSummaries (property discovery). openid/email are added
 * so the connected Google identity can be shown ("Connected as user@...").
 *
 * No write/admin scope is ever requested: this integration is read only.
 */

/** Read-only Analytics reporting + property discovery, plus identity. */
export const GA4_SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'openid',
  'email',
].join(' ');
