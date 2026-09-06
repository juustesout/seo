-- ============================================================================
-- SEO Platform - project-scoped knowledge sources (Content Studio Phase E)
--
-- User-managed knowledge items for a project. Each row is the logical model of
-- an indexed item: the text/notes a user pasted (or a reference URL). Rows are
-- traceability records - the actual vectors live in the Qdrant collection and
-- every vector points back here through its external_id (`source:<row id>`).
-- A row's `status` mirrors the state of its vectors in Qdrant:
--   pending   -> queued / not indexed yet
--   indexing  -> an ingest job is running
--   indexed   -> vectors exist (chunk_count > 0 unless the source had no text)
--   error     -> last ingest failed; see `error`
--   deleting  -> a delete job is running (row is removed when it finishes)
--
-- This table complements (never duplicates) the existing vector pipeline: the
-- Qdrant provider, the embedder and the chunker are reused unchanged.
-- ============================================================================

create table public.seo_knowledge_sources (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.seo_projects (id) on delete cascade,
  source_type      text not null default 'note',
  name             text not null,
  url              text,
  content_text     text,
  status           text not null default 'pending',
  error            text,
  chunk_count      integer not null default 0,
  last_indexed_at  timestamptz,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint seo_knowledge_sources_status_check
    check (status in ('pending', 'indexing', 'indexed', 'error', 'deleting')),
  constraint seo_knowledge_sources_type_check
    check (source_type in ('note', 'reference', 'url')),
  constraint seo_knowledge_sources_name_not_blank check (length(btrim(name)) > 0)
);

create index seo_knowledge_sources_project_idx on public.seo_knowledge_sources (project_id);
create index seo_knowledge_sources_project_status_idx on public.seo_knowledge_sources (project_id, status);
create index seo_knowledge_sources_updated_at_idx on public.seo_knowledge_sources (updated_at desc);

create trigger seo_knowledge_sources_touch_updated_at
  before update on public.seo_knowledge_sources
  for each row execute function public.seo_touch_updated_at();

-- ----------------------------------------------------------------------------
-- RLS: members read; owners/admins/editors add and update; only owners/admins
-- delete directly. The API writes rows server-side after its own role check,
-- so these policies are the boundary for any browser-side/PostgREST access.
-- ----------------------------------------------------------------------------

alter table public.seo_knowledge_sources enable row level security;

drop policy if exists seo_knowledge_sources_select on public.seo_knowledge_sources;
create policy seo_knowledge_sources_select on public.seo_knowledge_sources
  for select using (public.seo_is_member(project_id, auth.uid()));

drop policy if exists seo_knowledge_sources_insert on public.seo_knowledge_sources;
create policy seo_knowledge_sources_insert on public.seo_knowledge_sources
  for insert with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_knowledge_sources_update on public.seo_knowledge_sources;
create policy seo_knowledge_sources_update on public.seo_knowledge_sources
  for update using (public.seo_has_role(project_id, array['owner', 'admin', 'editor']))
  with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_knowledge_sources_delete on public.seo_knowledge_sources;
create policy seo_knowledge_sources_delete on public.seo_knowledge_sources
  for delete using (public.seo_has_role(project_id, array['owner', 'admin']));
