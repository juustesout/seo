# Google OAuth scope justification

Copy-paste justification for the Google OAuth consent-screen verification form
("Explain to Google why you need these scopes, how you will use them, and why
more limited scopes aren't sufficient").

## Requested scopes

- `openid`
- `https://www.googleapis.com/auth/userinfo.email` (the `email` scope)
- `https://www.googleapis.com/auth/webmasters.readonly` (Search Console)
- `https://www.googleapis.com/auth/analytics.readonly` (Google Analytics 4)

Both provider clients request the same identity pair (`openid` + `email`); the
Search Console client adds `webmasters.readonly` and the Analytics client adds
`analytics.readonly`. See `apps/api/src/providers/gsc/oauth.ts` and
`apps/api/src/providers/ga4/scopes.ts`.

## Overall justification (form field, under 1000 characters)

OldSkoolSEO (oldskoolseo.com) is a read-only SEO dashboard. A user connects their
own Google account to view their Search Console and Google Analytics 4 data in
one place. We only read data; we never create, edit or delete anything in their
Google account.

openid + email: identify and display which Google account is connected.

webmasters.readonly: read Search Console queries, clicks, impressions, positions
and pages for the sites the user attaches. This is the most limited Search
Console scope; the only alternative also grants write access we do not need.

analytics.readonly: read GA4 properties so the user can choose one, and read page
views, users and sessions. Most limited Analytics scope; broader scopes allow
changes we do not need.

No Ads or write/admin scopes are requested. Tokens are encrypted and deleted when
the user disconnects. Data is never sold, not used for ads, and not used to train
AI models. Access is user-initiated and revocable at any time.

977 characters including spaces and line breaks.

## Per-scope justification

### openid and `.../userinfo.email`

Used only to identify the Google account the user connected and display it back
("Connected as user@..."), and to bind the connected data to the correct
OldSkoolSEO account. This is the minimum identity pair; the broader `profile`
scope is not requested because we do not need name, photo or other profile data.

### `https://www.googleapis.com/auth/webmasters.readonly`

Used to read Google Search Console search-performance data for the sites the user
explicitly attaches: search queries, clicks, impressions, average position, pages
and dates. This powers the SEO performance view. This is the most limited Search
Console scope available for reading data. The only alternative,
`https://www.googleapis.com/auth/webmasters`, also grants write access (managing
properties, submitting sitemaps), which the app does not do and does not need.

### `https://www.googleapis.com/auth/analytics.readonly`

Used for two read-only operations:

1. Listing the Google Analytics 4 properties/data streams the user can access so
   the user can select one (Admin API `accountSummaries` / `dataStreams`).
2. Running read-only reports for that selected property (Data API `runReport`):
   page views, users and sessions per page, for 7/28/90-day periods.

This is the most limited Analytics scope available. There is no narrower
read-only scope; the broader `analytics.edit` and `analytics.manage.users`
scopes would allow changing configurations and users, which we do not request and
do not need.

## Why limited/broader scopes aren't used

We request no Google Ads scope and no write or administrative scope of any kind.
Every requested scope is read-only and is the minimum needed for the user-facing
feature it supports.

## Data handling (Google Limited Use)

Google user data is never sold, is not used or transferred for advertising, and
is not used to train or improve generalized/foundation AI or ML models. OAuth
tokens are stored encrypted (AES-256) on the server only, never in the browser,
and are deleted when the user disconnects the integration or deletes their
account. Our use and transfer to any other app of information received from
Google APIs adheres to the Google API Services User Data Policy, including the
Limited Use requirements.
