# Google Ads setup

P5 adds Google Ads as a read-only data source alongside Google Search Console
and Google Analytics. An account authorizes Google Ads once; a project then
selects one Google Ads customer and reads paid search intelligence (search terms
and keywords) from it. Nothing here changes the existing GSC or GA4
integrations: Ads lives on its own account-scoped integration, and all three
reuse the same Google OAuth client.

## What the integration does

- Reads Google Ads search terms (what users typed) and keywords (what the
  advertiser bid on) for the last 7 / 28 / 90 days (default 28).
- Per row: impressions, clicks, click-through rate, cost (`cost_micros` /
  1,000,000, in the customer's currency) and conversions.
- Discovers the Google Ads customers the authorized Google account can reach,
  including the client accounts of accessible manager (MCC) accounts, with
  Google's real descriptive names and currency.
- Stores only the selected customer reference per project (`seo_project_ads`);
  it never duplicates Google credentials per project.

It is **read-only by construction**: it only issues customer discovery
(`customers:listAccessibleCustomers`) and reporting queries
(`googleAds:searchStream`). It never creates, edits, pauses or deletes a
campaign, ad group, ad, budget or bid, and it is not a Google Ads replacement
UI.

## Google Cloud requirements

The platform's own Google OAuth client (the same `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` used by GSC and GA4) must have:

1. **Google Ads API** enabled.
2. The consent screen scope `https://www.googleapis.com/auth/adwords`.
3. An authorized redirect URI for the Ads callback:
   `https://<your-app-domain>/api/oauth/ads/callback`.
4. A Google Ads **API access level** attached to the Cloud project that owns the
   OAuth client. `Test` access only reaches test accounts; a production account
   requires `Basic` or `Standard` access, otherwise Google returns
   `AuthorizationError.CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` (surfaced as a
   permission error).

No new client or secret is introduced; the Ads flow reuses the existing Google
OAuth client with a different scope and redirect URI.

## Required scopes

```
https://www.googleapis.com/auth/adwords
openid
email
```

`adwords` is the only scope Google exposes for the Google Ads API. Google does
not offer a read-only variant of it; the integration enforces read-only behavior
by construction (only read reporting calls are issued). `openid`/`email` are
added only to show "Connected as <email>".

## OAuth behavior

- Authorizing Ads is **separate** from Search Console and Analytics: it
  creates/uses an account-scoped `seo_integrations` row with
  `provider_type = 'ads'`. The GSC and GA4 integration rows and their scopes are
  left untouched, so no re-consent is required.
- Tokens are stored encrypted in `seo_credentials` under the Ads integration
  (`google_access_token` / `google_refresh_token` / `google_token_scope`). The
  browser never sees them; refresh tokens are never returned by the API.
- The callback verifies the signed `state` (HMAC with
  `CREDENTIALS_ENCRYPTION_KEY`) before exchanging the code, then seals the
  connected Google email into the integration config for "Connected as ...".

## Environment variables

Ads reuses the Google OAuth client and adds two optional tuning variables:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Platform Google OAuth client |
| `CREDENTIALS_ENCRYPTION_KEY` | State signing + encrypted token storage |
| `PUBLIC_APP_URL` | Redirect base for `/api/oauth/ads/callback` |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Optional, deprecated. Forwarded as `developer-token` when set; not required. |
| `GOOGLE_ADS_API_VERSION` | REST API version (default `v25`). |

Developer tokens were sunset on 2026-09-09 (API access levels now attach to the
Cloud project owning the OAuth client), so the integration does not require one
and only forwards it for legacy continuity.

## Supabase configuration

Apply migration `supabase/migrations/20260101000037_google_ads.sql`. It creates
`seo_project_ads` (one Google Ads customer per project) with RLS: project members
may read the binding; writes are server-side only (no insert/update/delete
policy). The same migration widens the usage-ledger unit vocabulary with
`ads_request` (category `google`, provider `ads`). No Supabase Auth changes are
needed.

## Customer selection behavior

1. Connect Google Ads from the account **Integrations** view. The account is
   shown as "Connected as <email>".
2. In a project's **Settings**, the Google Ads panel lists the customers the
   account can reach (live from Google, real names).
3. A project administrator/owner selects one customer (or removes/replaces it).
   The server re-validates the customer id against the account's live Google
   metadata, so an arbitrary id cannot be bound.
4. The project **Paid search** view shows search terms and keywords for the
   selected period, with an optional text filter.

A project with no customer selected remains fully functional; the Paid search
view simply prompts for a customer.

## Read-only and failure behavior

- Google API failures surface as `ads_unavailable` (502); quota/rate-limit
  failures as `ads_quota_exceeded` (429); permission failures (including the
  unapproved-Cloud-project case) as `ads_permission_denied` (403); expired or
  revoked authorization as `ads_reauthorization_required` (403) and the UI asks
  to reconnect. An unknown or inaccessible customer is a `bad_request` (400). No
  raw Google error text is shown to users.
- "No customer selected" and "no data recorded" are distinct, honest states,
  never fabricated zeros.
- One real Google Ads API request is recorded as one `ads_request` usage fact
  under the `google` category; account-scoped discovery emits no project fact.

Never commit credentials or client secrets.
