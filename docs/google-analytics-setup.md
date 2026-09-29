# Google Analytics (GA4) setup

P4 adds Google Analytics 4 as a read-only data source alongside Google Search
Console. An account authorizes Google Analytics once; a project then selects one
GA4 property and reads page traffic from it. Nothing here changes the existing
GSC integration: Analytics lives on its own account-scoped integration.

## What the integration does

- Reads GA4 page traffic per page path for the last 7 / 28 / 90 days (default 28).
- Metrics: `screenPageViews` (Views), `activeUsers` (Users), `sessions` (Sessions).
- Discovers the GA4 properties the authorized Google account can read, with
  Google's real property names and, when a web data stream exposes one, its URL.
- Stores only the selected property reference per project
  (`seo_project_analytics`); it never duplicates Google credentials per project.

It does **not** read write/admin data, Ads, or competitor data, and it is not a
Google Analytics replacement UI.

## Google Cloud requirements

The platform's own Google OAuth client (the same `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` used by GSC) must have:

1. **Google Analytics Data API** enabled.
2. **Google Analytics Admin API** enabled (used to list properties and read
   web-stream URLs).
3. The consent screen scope
   `https://www.googleapis.com/auth/analytics.readonly` (read only).
4. An authorized redirect URI for the GA4 callback:
   `https://<your-app-domain>/api/oauth/ga4/callback`.

No new client or secret is introduced; the GA4 flow reuses the existing Google
OAuth client with a different scope and redirect URI.

## Required scopes

```
https://www.googleapis.com/auth/analytics.readonly
openid
email
```

`analytics.readonly` is the minimum scope needed for the Admin API
`accountSummaries`/`dataStreams` reads and the Data API `runReport`. No
write/admin scope is requested.

## OAuth behavior

- Authorizing Analytics is **separate** from Search Console: it creates/uses an
  account-scoped `seo_integrations` row with `provider_type = 'ga4'`. The GSC
  integration row and its scope are left untouched, so no GSC re-consent is
  required and existing GSC property selection keeps working.
- Tokens are stored encrypted in `seo_credentials` under the GA4 integration
  (`google_access_token` / `google_refresh_token` / `google_token_scope`). The
  browser never sees them; refresh tokens are never returned by the API.
- The callback verifies the signed `state` (HMAC with
  `CREDENTIALS_ENCRYPTION_KEY`) before exchanging the code, then seals the
  connected Google email into the integration config for "Connected as ...".

## Environment variables

No new environment variables are required. GA4 reuses:

| Variable | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Platform Google OAuth client |
| `CREDENTIALS_ENCRYPTION_KEY` | State signing + encrypted token storage |
| `PUBLIC_APP_URL` | Redirect base for `/api/oauth/ga4/callback` |

## Supabase configuration

Apply migration `supabase/migrations/20260101000033_google_analytics.sql`. It
creates `seo_project_analytics` (one GA4 property per project) with RLS: project
members may read the binding; writes are server-side only (no insert/update/
delete policy). No Supabase Auth changes are needed.

## Property selection behavior

1. Connect Google Analytics from the account **Integrations** view. The account
   is shown as "Connected as <email>".
2. In a project's **Settings**, the Google Analytics panel lists the properties
   the account can read (live from Google, real names).
3. A project administrator/owner selects one property (or removes/replaces it).
   The server re-validates the id against the account's live Google metadata, so
   an arbitrary property id cannot be bound.
4. The project **Analytics** view shows page traffic for the selected period.

A project with no Analytics property selected remains fully functional; the
Analytics view simply prompts for a property.

## Read-only and failure behavior

- Google API failures surface as `analytics_unavailable` (502); expired/revoked
  authorization surfaces as `analytics_reauthorization_required` (403) and the
  UI asks to reconnect. No raw Google error text is shown to users.
- "No property selected" and "no traffic recorded" are distinct, honest states,
  never fabricated zeros.

Never commit credentials or client secrets.
