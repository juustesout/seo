/**
 * Google Ads OAuth constants (P5).
 *
 * Google Ads exposes a single OAuth scope, `.../auth/adwords`, which is
 * read-write: Google does not offer a read-only variant (unlike Drive/Gmail).
 * This integration requests it because it is the minimum Google provides and
 * enforces read-only behavior by construction - the client only ever issues
 * read reporting calls (`googleAds:searchStream`) and customer discovery
 * (`customers:listAccessibleCustomers`); it never mutates a campaign, ad,
 * budget or bid.
 *
 * openid/email are added only so the connected Google identity can be shown
 * ("Connected as user@..."), exactly as for Search Console and Analytics.
 */

/** Google Ads data scope (read-write by Google's design) plus identity. */
export const GOOGLE_ADS_SCOPES = [
  'https://www.googleapis.com/auth/adwords',
  'openid',
  'email',
].join(' ');
