# H6.2 spec - live X publishing: auth flow + credential UX (recon)

Status: recon + proposal for developer approval. No code written yet.
Builds on H6.1 (`publish_kind`, X registered as real text-only publisher
foundation). H6.2 = make X publish *text* for real (OAuth connect + `POST
/2/tweets`), reusing the whole existing schedule/publication/job pipeline.

Scope of this phase: connect an X account via OAuth 2.0 (PKCE), store tokens
encrypted, publish a text post, show real history. NOT in scope (unchanged
roadmap STOP): publish_image/video, threads, replies, analytics, long-form
posts, X-specific MCP tools, social composer redesign, extra social networks.

---

## 1. Facts - current codebase

### 1.1 Publishers are project-scoped rows, not integrations
- `seo_publishers` (one row per provider per project, `config {}` +
  `status` + `capabilities` snapshot), CRUD in
  `apps/api/src/http/routes/publishers.ts`:
  - `POST /` create publisher from catalog descriptor (duplicate rejected).
  - `POST /:publisherId/config` stores only descriptor-declared non-secret
    keys into `seo_publishers.config`.
  - `POST /:publisherId/credentials` stores only descriptor-declared keys,
    AES-256 encrypted in `seo_credentials` (owner = `publisher_id`).
  - `POST /:publisherId/test` runs `adapter.testConnection(ctx)` and flips
    `status` to `connected`/`error`.
  - `POST /:publisherId/disconnect` clears credentials, sets disconnected.
  - `DELETE /:publisherId` clears credentials + deletes row.
- All read/writes go through service-role client with RLS; every operation
  checks `container.access.requireRole(...)`.
- Descriptor `setup` contract: `PublisherSetupHint { category, config,
  credentials, note }` in `packages/contracts/src/providers.ts:312-333`.
  Fields are *shapes* (key/label/type), never values. The web UI renders
  config/credential fields from the descriptor in
  `apps/web/src/views/Publishing.tsx` (PublisherCard); no per-vendor React
  forms exist.

### 1.2 Credential storage is generic and provider-agnostic
- `apps/api/src/infra/credentials.ts`: `CredentialStore.reader(owner,
  providerType)` -> `get/set/delete` by key. Owner is exactly one of
  `integration_id` | `publisher_id` | `project_id`(ai). Rows carry
  `provider_type`, encrypted `ciphertext/iv/auth_tag`, JSON `meta`.
- AES-256-GCM via `apps/api/src/crypto.ts`; gated by
  `CREDENTIALS_ENCRYPTION_KEY`. `clearForOwner` deletes all rows for a
  publisher (used on disconnect/delete).
- `ProviderContext.credentials` + `.config` + `.logger` are built in
  `apps/api/src/context.ts` (`buildPublisherProviderContext`), consumed by
  adapters (see WordPress/dataforseo/gsc).

### 1.3 There IS an OAuth precedent: Google Search Console
- `apps/api/src/http/routes/integrations.ts`: `GET
  /:integrationId/oauth-url` builds a signed-state authorize URL;
  `apps/api/src/http/routes/oauth.ts` `GET /api/oauth/gsc/callback` verifies
  the state, confirms ownership, exchanges the code server-side, stores
  tokens encrypted, redirects back to the app.
- Shared OAuth plumbing exists: `signState/verifyState` (HMAC-signed,
  contains scope: projectId/integrationId + userId + nonce),
  `buildAuthorizationUrl`, `exchangeCode`, `refreshAccessToken`,
  `GSC_SCOPES`, `redirectBase(req)` in `apps/api/src/providers/gsc/oauth.ts`
  and `apps/api/src/http/routes/utils.ts`.
- App-level OAuth config env vars precedent:
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in
  `apps/api/src/config.ts` (`googleConfigured` flag).

### 1.4 Publishing path already ends at the adapter
- Worker job -> `publish` executor
  (`apps/api/src/jobs/executors.ts:461`) loads the publication row +
  publisher row, builds the provider context, then calls
  `adapter.publish(ctx, { title, content, excerpt, slug, status })`.
  Success -> `seo_publications` set to `published` with `remote_id` +
  `target_url`. Errors from the adapter flow into existing job failure
  handling (publication never marked successful).
- X adapter today (`apps/api/src/providers/social/xPublisher.ts`) throws
  `PublisherError('publisher_not_available')` from every path.
- `buildSocialTextPost(input, { maxChars })`
  (`apps/api/src/providers/social/textPayload.ts`) turns canonical content
  (title/excerpt/HTML or markdown body) into plain text. `PublishInput` has
  no `publish_kind` today - the executor passes the stored HTML snapshot
  (`pub.content`) for both article and text intents. For X we only need text;
  the adapter renders it from the same input mock_social already uses.
- The full X URL is derivable only when we know the handle:
  `https://x.com/<username>/status/<tweet_id>`; the tweet create response
  returns `id` + `text`, no URL.

### 1.5 UI status/kind logic (H6.1)
- `apps/web/src/lib/publishers.ts`: `usableKinds`, `supportedPublishKinds`,
  `defaultPublishKind`, `PUBLISH_KIND_LABELS` drive which publishers show in
  compose/schedule pickers. `Publishing.tsx` renders the publisher list and
  add-publisher cards from `GET /projects/:projectId/publishers` +
  descriptors; compose/schedule views are kind-aware. There is no
  "Connect with X" button anywhere yet.

---

## 2. Facts - X platform (checked against docs.x.com today)

### 2.1 Auth: OAuth 2.0 Authorization Code + PKCE (user context)
- Confirmed flow is OAuth 2.0 **Authorization Code with PKCE** (public or
  confidential client). Consumer-key/secret 3-legged OAuth 1.0a is the legacy
  alternative and is out of scope unless the developer decides otherwise.
- Authorize URL (from the v2 OpenAPI security scheme):
  `https://x.com/i/oauth2/authorize`
  (verified live 2026-09-07: `api.x.com/2/oauth2/authorize` returns HTTP 400
  `Bad Authentication data` — it is the Bearer-token API host, NOT the consent
  page. The browser consent page is served by `x.com/i/oauth2/authorize`.)
- Token endpoint: `https://api.x.com/2/oauth2/token`
  - `grant_type=authorization_code` with `code`, `redirect_uri`, `client_id`,
    `code_verifier` (S256 challenge sent in the authorize step). No client
    secret needed for a public (PKCE) client; a secret is appended only for a
    confidential client.
  - `grant_type=refresh_token` returns a fresh `access_token` (and usually a
    rotated `refresh_token`).
- Scopes relevant to posting (v2 OpenAPI `OAuth2UserToken`): `tweet.write`,
  `tweet.read`, `users.read`, and **`offline.access`** (returns a refresh
  token, which scheduled background posting requires). Media later:
  `media.write` + `media.read`.
- App-level prerequisite: the X Developer App must have *Read and write*
  permission for `tweet.write` to be granted to the token; token issuance +
  scopes depend on the current App settings/plan. This is an operator
  configuration step, not code.

### 2.2 Publish a text post
- `POST https://api.x.com/2/tweets`, OAuth 2.0 user token
  (`tweet.write`/`tweet.read`/`users.read`). Body `{ "text": "..." }`
  (`text` required unless `media` is attached). Response `201` ->
  `{ data: { id, text } }`.
- Post length limit is enforced by X (standard accounts: 280 characters;
  verify the current value/plan behaviour at implementation). Our own payload
  builder will pre-validate and **refuse** overflow
  (`publisher_rejected_content`) rather than truncate (roadmap rule).

### 2.3 Identity for the record + URL
- `GET https://api.x.com/2/users/me` (scopes `tweet.read`, `users.read`) ->
  `{ data: { id, name, username } }`. Username is what we persist so each
  successful publish yields `target_url = https://x.com/<username>/status/<id>`.

### 2.4 Error surface (v2 "Problem" objects + HTTP status)
- Errors are JSON Problem objects with `title`, `detail`, `status`, `type`;
  relevant families for a publishing adapter:
  - HTTP 401 / token problems -> `publisher_auth_failed`.
  - HTTP 429 (rate limit) -> `publisher_rate_limited`.
  - HTTP 403 (`not-authorized-for-resource`, `disallowed-resource`, or app
    permission issues) and **duplicate content** rejections ->
    `publisher_rejected_content`.
  - HTTP 400 `invalid-request` (e.g. text too long, malformed body) ->
    `publisher_rejected_content`.
  - HTTP 5xx / `internal-error` / `resource-unavailable` / network timeouts ->
    `provider_error` (retryable per existing job semantics).
- Mapping target vocabulary is the H5 `PublisherError` codes in
  `apps/api/src/providers/publisherError.ts` + roadmap H6 rules.

---

## 3. Design proposal

Principle from the roadmap: *OAuth implemented as a clean provider flow, not
as X-specific logic in generic routes*, and *no X-specific React*.

### 3.1 Provider-level OAuth (new module, mirrors gsc/oauth.ts)
New `apps/api/src/providers/social/xOAuth.ts` exporting the X OAuth client:
- `buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge })` ->
  `https://x.com/i/oauth2/authorize?...` with
  `response_type=code`, `scope` (`tweet.write tweet.read users.read
  offline.access`), `code_challenge_method=S256`, `state`.
- `exchangeCode({ clientId, clientSecret?, code, redirectUri,
  codeVerifier })` and `refreshAccessToken({ clientId, clientSecret?,
  refreshToken })` against the token endpoint.
- `fetchAuthenticatedUser(accessToken)` -> `GET /2/users/me`, returns
  `{ id, name, username }`.
- Standard crypto helpers stay shared: PKCE verifier/challenge generation
  (sha256 base64url) lives here; state signing reuses
  `signState/verifyState`.
- No database access, no route logic - a pure client, like gsc/oauth.ts.

### 3.2 Generic registry/descriptor support for "connect by OAuth"
The web UI + publishers routes decide between *typed credential fields*
(WordPress) and *"Connect with <Provider>" button* from data, never by
hardcoding `x`:
- Add an optional `auth?: { mode: 'form' | 'oauth' }` (or an `oauth: true`
  flag) to `PublisherSetupHint` in
  `packages/contracts/src/providers.ts`; X descriptor sets `mode:'oauth'`,
  WordPress stays `mode:'form'` (default when absent).
- Add an `OAuthClientProvider` capability to the registry keyed by provider
  id (factory returning the provider OAuth client above), so generic routes
  can build authorize URLs / exchange codes for any oauth-mode publisher
  without an X import. GSC already demonstrates the route side pattern; we
  mirror it for publishers.

### 3.3 Generic publisher OAuth endpoints (routes stay generic)
- `GET /projects/:projectId/publishers/:publisherId/oauth-url`
  (publishers.ts, editor role): only when the descriptor `auth.mode ===
  'oauth'`; requires `xConfigured` (env) + encryption configured; signs state
  `{ projectId, publisherId, provider, userId, nonce, codeVerifier,
  redirect? }`; returns `{ url, redirect_uri }`. The browser opens the URL.
- `GET /api/oauth/publisher/callback` (oauth.ts, no auth header - browser
  redirect): verify state signature; load publisher row; confirm project
  ownership; look up the provider OAuth client from the registry by
  `state.provider`; exchange the code with the stored verifier; store tokens
  encrypted (`x_access_token`, `x_refresh_token` under publisher owner scope);
  call `fetchAuthenticatedUser` once and write non-secret handle/name/id to
  `seo_publishers.config`; set `status: connected`; redirect back to
  `/p/{project}/publishing?x=connected` (mirrors `?gsc=connected`). Because
  the state is signed, the generic handler can dispatch safely on
  `provider`.
- Error path: redirect back with `?oauth_error=...` (no secrets), same as the
  gsc callback.

### 3.4 X adapter rewrite (same interface, real HTTP)
`apps/api/src/providers/social/xPublisher.ts` (and/or split a small
`xClient.ts`) implements `PublisherProvider` unchanged in shape:
- `connect/testConnection`: read stored tokens; `fetchAuthenticatedUser`;
  on success return the handle; on missing/invalid/expired token return a
  safe "not connected/authorization failed" result (`PublisherError` mapped
  per 2.4). Never echoes tokens.
- Token lifecycle: before each publish, use the access token; if the API
  answers 401 (or token is expired), `refreshAccessToken`, persist the
  rotated pair encrypted via `ctx.credentials.set`, and retry once. Refresh
  failure -> `publisher_auth_failed`, non-retryable, publication fails safely.
- `publish`: build text via `buildSocialTextPost(input)` (canonical content
  already resolved by the executor), validate length locally against X's
  limit and refuse overflow; `POST /2/tweets` with `{ text }`; map response
  to `{ remoteId: data.id, url: https://x.com/<handle>/status/<id> }`.
- `update`/`delete`: remain honest errors (`publisher_not_available`) for
  this phase - X capability list stays `publish_text` + `schedule` only.
- Executor/worker/schedules/publications/MCP: untouched. The kind gate
  already allows text -> `publish_text`; schedules/jobs flow unchanged.

### 3.5 Config/env additions (`apps/api/src/config.ts`)
- `X_OAUTH_CLIENT_ID` (required for the flow), optional
  `X_OAUTH_CLIENT_SECRET` (only if a confidential client is chosen), plus an
  `xConfigured` boolean flag (and a `publicAppUrl`-based redirect check like
  Google). Operator registers `.../api/oauth/publisher/callback` as the X App
  callback URL (and may need to opt the App into read+write + the right plan
  for post-create usage).

### 3.6 Web (Publishing.tsx + lib)
- PublisherCard branches on `descriptor.setup.auth?.mode`:
  - `form` (default): today's config/credential fields + save.
  - `oauth`: one primary action `Connect with X` (label from descriptor) that
    fetches `oauth-url`, opens it (popup/new tab), and on return reloads the
    list to show the connected handle/status. Show the handle (config value)
    + status pill; `Test connection`/`Disconnect` keep working through the
    existing generic endpoints.
- Compose/schedule text flows already work for a `connected` X publisher
  (kind radio from H6.1), so no new composer work.

### 3.7 Error/UX table for the spec
| Situation                              | Surface                                                        |
| -------------------------------------- | -------------------------------------------------------------- |
| No App configured (env)                | `not_configured` on oauth-url + adapter                        |
| User cancels/denies                    | redirect `?oauth_error`, publisher stays disconnected          |
| Token expired, refresh works           | silent refresh before publish                                  |
| Refresh fails / revoked                | `publisher_auth_failed`, publication error, status 'error'     |
| 429                                    | `publisher_rate_limited`, existing job retry semantics         |
| Duplicate text / forbidden / too long  | `publisher_rejected_content` with safe message                 |
| 5xx / network / malformed response     | `provider_error`; never fake success; no id/url                |

---

## 4. Open decisions for the developer (confirm before building)

1. **Client type**: public PKCE app (client id only, simplest) vs
   confidential (adds `X_OAUTH_CLIENT_SECRET`). Recommend public PKCE.
2. **X App provisioning**: operator must create an X Developer App with
   Read+Write and register the callback. Confirm the current plan/permission
   model (write usage is pay-per-use today; there is no free write tier to
   assume).
3. **Post text limit**: keep local validation at 280 (standard) and refuse
   overflow, or accept longer posts for Premium accounts later. Recommend 280
   + refuse, matching the roadmap no-truncation rule.
4. **Redirect UX**: popup vs full-tab for the X consent; recommend full-tab +
   query-param return (consistent with gsc).
5. **Where `oauth-url` returns handle storage**: non-secret handle/name/id on
   `seo_publishers.config` (so history DTOs can show the target account).
6. RESOLVED (live check 2026-09-07): the authorize/consent host is
   `x.com/i/oauth2/authorize`; `api.x.com/2/oauth2/authorize` is an
   API endpoint that returns 400 `Bad Authentication data` and must not be
   used for the browser flow. Token + v2 calls stay on `api.x.com`.

## 5. Test + Definition of done mapping
Adapter unit tests (publish success via mocked fetch, url/id parsing, length
reject, each error family incl. refresh-once-on-401 and refresh-failure);
route tests for oauth-url (authz, not-configured, oauth-mode-only) and
callback (state tamper, ownership, exchange + token storage + redirect);
integration tests: connect X then direct + scheduled text publish -> real
history rows; WordPress/mock_social unchanged; contracts build, api
typecheck/build/tests, web typecheck/build all green; no token ever in any
response/log/UI.
