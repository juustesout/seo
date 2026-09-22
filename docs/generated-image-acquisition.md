# Confirmed Image Generation (R4.5B)

Status: **done (R4.5B)**. This is the R4.5B contract and implementation report for
the second half of R4.5: explicitly confirmed AI image generation in the
Editor-native Designer Agent. It sits under Phase R4
(`docs/editor-native-designer-contract.md`), on top of the R4.5A stock-search
slice (`docs/external-image-acquisition.md`), the R3.1 insertion slice
(`docs/context-aware-image-insertion.md`) and the R4.1 visual foundation
(`docs/visual-design-foundation.md`).

Scope: **confirmed generation only**. R4.5B adds a fourth source after the
project library and external stock search: an AI-generated image. Generation is
never silent. A first request may only *offer* generation; the user must confirm
with an explicit action, and only the confirmed follow-up run may spend. Cost,
quota and provider-choice surfaces remain out of scope.

## 1. Purpose

R4.5A closed the "no local asset" gap with stock search. When stock search is off
or finds nothing usable, the user still needs an image. R4.5B adds generation
without ever surprising the user with a paid call:

1. The project library is always tried first.
2. If allowed, external stock search is tried next.
3. If both fail and generation is permitted by policy, the run returns a
   **succeeded** proposal that asks the user to confirm an AI image.
4. Only when the user confirms does a new run generate, store and return a normal
   `insert_image` operation.

The canonical document is still never written by the backend: the editor applies
the operation as one undoable transaction.

## 2. Acquisition states

`DesignerProposal` gains an optional, single-purpose `acquisition` field
(`packages/contracts/src/designer.ts`, `packages/contracts/src/mediaSource.ts`):

```ts
interface DesignerAcquisition {
  kind: 'generation_required';
  provider: 'openai';
  model: string;
}
```

- `acquisition` and `insertion` are mutually exclusive: a generation request
  describes a future image, so it can never also carry an insertion.
- The state is a **successful** run, not a failure and not a 422. The UI renders
  it as an offer with an explicit "Generate image" action.
- Only `openai` is a legal provider (`IMAGE_GENERATION_PROVIDERS`); the client
  never chooses the provider. `model` is a bounded, non-secret display fact.

## 3. Source policy and confirmation

The editor sends `EMBEDDED_AGENT_IMAGE_SOURCE_POLICY` on an explicit image
request:

```ts
{
  allowExternalSearch: true,
  allowGeneration: true,        // generation may be offered
  requireGenerationConfirmation: true, // ...but never runs unconfirmed
}
```

`ImageInsertionContext` gains `generationConfirmed?: boolean`. The initial run
omits it; the confirmed rerun sets it to `true`. Policy and confirmation are
validated server-side: a client that sets `generationConfirmed` while the policy
forbids generation is ignored, and generation never runs as a silent fallback
(`image_insertion_service.test.ts` pins this).

## 4. Generation flow

`apps/api/src/services/imageGenerationAcquisition.ts` owns the spending path, and
`ImageInsertionService.buildProposal` is the only caller:

1. Resolve the effective OpenAI credential through `AIService.resolveImageGeneration`
   - the same BYOK chain as every other AI call (account -> project -> server
     env). No second credential source is introduced.
2. If generation is permitted but **not configured**, fail honestly with
   `image_generation_not_configured` (never a fabricated image).
3. If confirmation is required and `generationConfirmed` is absent, return the
   `generation_required` proposal and spend nothing.
4. Otherwise build a bounded prompt from the editor context, request the role's
   aspect size, and call the OpenAI media provider.
5. Resolve the returned inline `b64_json` data URL or provider URL (https, byte
   cap, timeout), then persist the bytes through `MediaService.importExternal`
   (re-sniffed, format and size enforced) as a normal library row with
   `source: 'openai_generated'` and `source_meta: { provider, model }`.
6. Return a normal `ImageInsertionCandidate` with `source: 'openai_generated'`.

Outcomes are typed and honest: `image_generation_not_configured`,
`image_generation_failed`, `generated_image_too_large`, `asset_persistence_failed`.

## 5. Editor surface

The Agent status surface adds one state and no new boxes: a
`generation` panel ("Create an image with AI") with a provider label and a single
"Generate image" button plus Cancel. Clicking it re-runs the same instruction with
`generationConfirmed: true`; the second click while a run is in flight is ignored.
The resulting candidate is the ordinary insertion preview with an
"AI-generated image" source note, so provenance stays visible before insertion.

## 6. Product cases

| Case | Situation | Result |
| --- | --- | --- |
| 1 | Local/external image found | Unchanged R4.5A flow: persisted library row, normal `insert_image`. |
| 2 | Nothing found, generation not permitted or not configured | Honest no-candidate, or `image_generation_not_configured` when policy allows generation. |
| 3 | Generation available, not confirmed | Succeeded proposal with `acquisition: { kind: 'generation_required', provider: 'openai', model }`; no insertion, no spend. |
| 4 | User confirms | New run with generation enabled and confirmed; validates policy, resolves credentials, generates, persists, returns a normal `insert_image`. |

## 7. Verification

- `@seo/contracts` build + tests: 425 passing.
- `@seo/api` typecheck + tests: 1645 passing.
- `@seo/web` typecheck + tests: 440 passing + production build.

Migration limitation (inherited from R4.5A, still open):
`supabase/migrations/20260101000030_media_provenance.sql` was reviewed and the
matching smoke-check additions are included in `scripts/db-migrate-local.sh`, but
the migration was **not runtime-verified** - local Postgres/`psql` was
unavailable in this environment. R4.5B adds no migration and reuses the existing
`source` / `source_meta` columns, so it is unaffected once that migration is run
against a fresh database.

## 8. Boundaries

- No silent or background generation; every generation is user-confirmed.
- No cost, quota or provider-choice UI (a later milestone).
- No new routes, tables or editor boxes; one new acquisition state and one action.
- No credentials, keys or `keySource` exposed to the editor or stored in
  `source_meta`; the provider/model are the only reported facts.
- No fabricated assets; every failure is a typed error with product-language copy.
