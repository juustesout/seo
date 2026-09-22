-- ============================================================================
-- SEO Platform - media provenance for externally acquired images (R4.5A)
--
-- seo_media is the single asset system: user uploads and images acquired from
-- external sources (stock search today, confirmed generation in R4.5B) all
-- become ordinary library rows so they are reusable, manageable and deletable
-- through the existing media management.
--
-- Provenance lives on the row instead of a parallel table:
--   source       stable discriminator for filtering/behavior. `upload` covers
--                every user upload (historically the only source); `unsplash`
--                and `openai_generated` are acquired assets. `project_media`
--                is deliberately NOT stored - it is a runtime presentation of
--                `upload` used by the insertion layer.
--   source_meta  bounded, secret-free provider specifics (provider id,
--                original asset id, author/attribution, generation model).
--                Never credentials, never raw provider payloads.
--
-- Existing rows are backfilled to `upload` by the column default; the API also
-- tolerates a missing/legacy value defensively when mapping.
-- ============================================================================

alter table public.seo_media
  add column if not exists source text not null default 'upload',
  add column if not exists source_meta jsonb not null default '{}'::jsonb;

alter table public.seo_media
  drop constraint if exists seo_media_source_check;
alter table public.seo_media
  add constraint seo_media_source_check
  check (source in ('upload', 'unsplash', 'openai_generated'));

alter table public.seo_media
  drop constraint if exists seo_media_source_meta_object_check;
alter table public.seo_media
  add constraint seo_media_source_meta_object_check
  check (jsonb_typeof(source_meta) = 'object');

create index if not exists seo_media_project_source_idx on public.seo_media (project_id, source);
