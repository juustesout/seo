-- ============================================================================
-- SEO Platform - BYOK / project-scoped AI credentials
--
-- Extends seo_credentials so secrets can be owned by exactly one of an
-- integration, a publisher, or a project-scoped AI scope (per-project
-- bring-your-own-key). All rows stay server-only (RLS denies everything).
-- ============================================================================

alter table public.seo_credentials
  add column project_id uuid references public.seo_projects (id) on delete cascade;

alter table public.seo_credentials
  drop constraint seo_credentials_owner_check;

alter table public.seo_credentials
  add constraint seo_credentials_owner_check
    check (num_nonnulls(integration_id, publisher_id, project_id) = 1);

-- AI rows always carry project_id; integration/publisher rows leave it null
-- (nulls are distinct, so they never collide with this index).
create unique index seo_credentials_ai_project_key
  on public.seo_credentials (project_id, key_name);
