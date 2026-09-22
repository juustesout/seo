# External Image Acquisition (R4.5A)

Status: **done (R4.5A)**. This is the R4.5A contract and
implementation report for the first half of R4.5, the Editor-native Designer
Agent's externally sourced image capability. It sits under Phase R4
(`docs/editor-native-designer-contract.md`) and builds on the R3.1 insertion
slice (`docs/context-aware-image-insertion.md`) and the R4.1 visual foundation
(`docs/visual-design-foundation.md`).

Scope: **stock search only**. R4.5A makes the project library local-first and adds
a fallback to an external stock-image source (Unsplash) when the library has no
suitable asset. It does **not** add image generation, generation confirmation, a
cost/quota surface or any new editor state - those are R4.5B.

## 1. Purpose

The R3.1 insertion flow only ever ranked existing `seo_media` assets. When none
matched, the user got an honest `image_insertion_no_candidate`. R4.5A closes that
gap without changing where content lives:

1. The project library is always tried first.
2. If nothing local matches **and** the caller explicitly allowed external
   search, a stock provider is searched.
3. The chosen image is downloaded inside a host allowlist, validated and stored
   as an ordinary `seo_media` row.
4. The editor receives the same typed `insert_image` operation as before, now
   pointing at that library row and carrying bounded attribution.

The canonical document never carries a hidden remote URL, and the backend still
never writes the document: the editor applies the operation as one undoable
transaction.

## 2. Provenance model

Provenance lives on `seo_media` instead of a parallel table
(`supabase/migrations/20260101000030_media_provenance.sql`):

- `source text not null default 'upload'` with a CHECK over
  `('upload', 'unsplash', 'openai_generated')`.
- `source_meta jsonb not null default '{}'` with an object CHECK.

`project_media` is deliberately **not** a stored value; it is how the insertion
layer presents `upload` assets at runtime (`imageSourceKindOf`). Existing rows
backfill to `upload` by the column default. The contract
(`packages/contracts/src/mediaSource.ts`) bounds `source_meta` to known,
secret-free keys (`provider`, `sourceAssetId`, `author`, `authorUrl`,
`sourceUrl`, `model`); credentials are never persisted.

## 3. Source policy

`ImageSourcePolicy` travels on the image-insertion context and is validated
server-side at the API edge (the client is never the only guard):

```ts
export const IMAGE_SOURCE_POLICY_DEFAULT = {
  allowExternalSearch: false,
  allowGeneration: false,
  requireGenerationConfirmation: true,
};
```

The editor sends `allowExternalSearch: true` only on an explicit image request
(`EMBEDDED_AGENT_IMAGE_SOURCE_POLICY`); generation stays off until R4.5B. Local
assets always take precedence because the fallback only runs when the local
selection is empty.

## 4. Acquisition flow

`apps/api/src/services/externalImageAcquisition.ts` owns the fallback:

1. Resolve the stock provider from the registry; a missing or unconfigured
   provider is an honest `provider_not_configured` (never a fabricated image).
2. Build a bounded query from the editor context and request the role's
   orientation.
3. Download the chosen result only from an allowlisted host
   (`images.unsplash.com`) with a byte cap and an abort timeout; untrusted hosts
   are skipped.
4. Persist the bytes through `MediaService.importExternal` (re-sniffed, format
   and size enforced) as a normal library row with `source: 'unsplash'` and
   bounded attribution.
5. Return a normal `ImageInsertionCandidate` carrying `credit` and `sourceUrl`.

Outcomes are typed and honest: `provider_not_configured`,
`external_search_unavailable`, `asset_persistence_failed`,
`external_image_too_large`, `external_image_untrusted_source`.

## 5. Editor surface

The candidate preview shows the external source ("Stock photo from Unsplash" plus
the credit) alongside the existing role label, alt-text note and source link. The
Agent surface, submission shape, durable run endpoint and apply guard are
unchanged, so nothing new appears in the editor beyond the source note.

## 6. Verification

- `@seo/contracts` build + tests: 420 passing.
- `@seo/api` typecheck + tests: 1623 passing.
- `@seo/web` typecheck + tests: 435 passing + production build.

Migration limitation (recorded): the SQL in
`supabase/migrations/20260101000030_media_provenance.sql` was reviewed and the
matching smoke-check additions are included in `scripts/db-migrate-local.sh`,
but the migration was **not runtime-verified** - local Postgres/`psql` was
unavailable in this environment. It must be run against a fresh database (via
`scripts/db-migrate-local.sh`) in the next database-enabled environment before
R4.5B.

## 7. Boundaries

- No generation and no generation confirmation (R4.5B).
- No new routes, tables or editor boxes.
- No hidden remote URLs in canonical content; every asset is a library row.
- No fabricated assets, metrics or provider status; failures surface as typed
  errors with product-language copy.
- No automatic spending: this milestone performs no paid operation.
