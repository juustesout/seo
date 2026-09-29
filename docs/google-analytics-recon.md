# Google Analytics (GA4) integration - Phase A recon

Scope: add GA4 page-traffic data as a first-class Google signal alongside
Google Search Console, without redesigning the existing GSC integration and
without a second Google authentication system.

Classification: **EXISTS** (can reuse as-is) / **REUSABLE** (works with a small
parameter change) / **REQUIRES EXTENSION** (additive change needed) /
**MISSING** / **OUT OF SCOPE**.

---

## Existing Google / GSC integration map

| Concern | Location | Classification |
| --- | --- | --- |
| Google OAuth initiation (account) | `GET /api/account/gsc/connect-url` (`apps/api/src/http/routes/account.ts:157`) | EXISTS |
| Google OAuth initiation (legacy project) | `GET /api/projects/:id/integrations/:iid/oauth-url` (`integrations.ts:256`) | EXISTS |
| Consent URL builder | `buildAuthorizationUrl` (`providers/gsc/oauth.ts:46`) - already takes a `scope` argument | REUSABLE |
| Scopes | `GSC_SCOPES` = `webmasters.readonly` + `openid` + `email` (`providers/gsc/oauth.ts:18`) | REQUIRES EXTENSION (add Analytics scope) |
| Callback handling | `GET /api/oauth/gsc/callback` (`http/routes/oauth.ts:39`), unauthenticated redirect | REQUIRES EXTENSION (provider-aware) |
| OAuth state | signed JSON (`signState`/`verifyState`, `infra/signedPayload.ts`), HMAC with `CREDENTIALS_ENCRYPTION_KEY` | EXISTS |
| Token exchange / refresh | `exchangeCode` / `refreshAccessToken` (`providers/gsc/oauth.ts:69,105`), confidential client | REUSABLE |
| Token storage | encrypted `seo_credentials` scoped by `(integrationId, providerType)` | EXISTS |
| Token refresh on 401 | `GscDataSource.apiWithRefresh` (`gscDataSource.ts:142`) | REUSABLE (pattern) |
| Google account identity | `openid`/`email` scopes are requested but never resolved to a UI value | MISSING (GA4 needs it) |
| Account-scoped integration row | `seo_integrations` with `project_id NULL` + `account_id` (`20260101000013`) | EXISTS |
| Account Google connection state | `googleConnectionState` (`services/accountService.ts:87`) | EXISTS (GSC-specific) |
| GSC property registry | `seo_gsc_properties` + `seo_project_properties` (`20260101000012`) | EXISTS (GSC-specific) |
| Project <-> property binding | `seo_project_properties` (`project_id`, `property_id`, `is_primary`) | EXISTS (GSC-specific) |
| GSC data fetching | `GscDataSource` + `GscApiClient` (`providers/gsc/*`) | EXISTS |
| Integration settings UI | `AccountIntegrations.tsx`, `ProjectSettings.tsx`, `Integrations.tsx` | EXISTS |
| Google client env | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `config.googleConfigured` | EXISTS |

## Can one Google authorization support multiple Google APIs?

Yes. The OAuth machinery is already multi-API capable:

- `buildAuthorizationUrl({ scope })` accepts any scope string, so a single
  consent can request `webmasters.readonly` **and** `analytics.readonly`.
- The encrypted token store is keyed by `(integrationId, providerType)`, and the
  callback already records the granted scope under `google_token_scope`.
- `exchangeCode` / `refreshAccessToken` are generic Google token endpoint calls,
  independent of which API the token will be used for.

What is missing is a token owner for Analytics and a callback that does not
hardcode the GSC provider.

---

## Decision: how GA4 attaches to the existing model

The account owns one Google **Search Console** connection (`provider_type
= 'gsc'`, `project_id NULL`). Two options existed:

1. **Widen the GSC connection's scope** to include `analytics.readonly` and
   reuse its tokens for GA4.
2. **Add a sibling account-scoped `ga4` integration** that reuses the same OAuth
   client, callback, state signing and encrypted token store.

Option 1 changes the existing GSC consent screen (new permission) and couples
GA4 availability to the GSC token, which conflicts with "do not silently change
GSC behavior" and "authorize Google Analytics without changing existing GSC
property selection". **Option 2 is chosen**: it is additive, leaves the GSC
integration row and its scope byte-for-byte unchanged, and introduces no second
authentication system - it is the same Google OAuth client, the same callback
helper, and the same credential storage, just a second provider integration
(similar to how DataForSEO and GSC already coexist). The minimum read-only scope
`https://www.googleapis.com/auth/analytics.readonly` is used.

The conceptual model:

```text
Account
  |-- Google Search Console integration (gsc)   -> seo_gsc_properties
  |-- Google Analytics integration (ga4)         -> GA4 properties (live discovery)
                                                   |
                                                   v
                                            seo_project_analytics (one GA4 property per project)
```

## Reused surfaces (no change)

- `seo_integrations` account-scoping + partial unique index (`20260101000013`).
- `seo_credentials` encrypted store and the scoped credential reader.
- `buildProviderContext` (integration-scoped credentials + logger).
- `GET /api/me` project membership, `requireAccount`, `requireRole`.
- The account/project settings UI structure and `useAsync` conventions.

## Deliberately deferred (OUT OF SCOPE)

- Google Ads (future P5).
- Competitor intelligence and automatic keyword discovery.
- A generic analytics dashboard / arbitrary date-range builder.
- A combined SEO score (seam only; no invented metric).
- GA4 property auto-sync into the database (queries are live reads).

## Risks / notes

- Existing GSC tokens minted before GA4 existed do not carry
  `analytics.readonly`; GA4 uses its own connection, so no re-consent of GSC is
  required and no GSC behavior changes.
- The GA4 Admin API (property names, data streams) and Data API (reporting) must
  be enabled on the Google Cloud project (documented in
  `docs/google-analytics-setup.md`).
- The callback currently hardcodes `providerType = 'gsc'`; it becomes
  provider-aware, reading the integration's `provider_type`. GSC keeps using
  `/api/oauth/gsc/callback`; GA4 uses the same handler via
  `/api/oauth/google/callback`.
