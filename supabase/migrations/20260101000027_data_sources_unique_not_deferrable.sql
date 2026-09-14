-- ============================================================================
-- SEO Platform - make the data source external-id uniqueness usable as an
-- ON CONFLICT arbiter.
--
-- seo_data_sources_unique_external was declared `deferrable initially
-- immediate`. PostgreSQL refuses a deferrable unique constraint as the arbiter
-- of INSERT ... ON CONFLICT, so the PostgREST upsert every GSC attach uses
-- (project_id, provider_type, external_id) failed with:
--
--   ON CONFLICT does not support deferrable unique constraints/exclusion
--   constraints as arbiters
--
-- Nothing here relies on deferred checking, so the constraint is recreated as a
-- plain (non-deferrable) unique constraint. The uniqueness guarantee is
-- unchanged and is now usable as an upsert target.
-- ============================================================================

alter table public.seo_data_sources
  drop constraint seo_data_sources_unique_external;

alter table public.seo_data_sources
  add constraint seo_data_sources_unique_external
  unique (project_id, provider_type, external_id);
