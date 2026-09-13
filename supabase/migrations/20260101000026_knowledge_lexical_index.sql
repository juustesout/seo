-- ============================================================================
-- SEO Platform - knowledge lexical index (KB10)
--
-- The lexical half of hybrid retrieval: a small, derived projection of the
-- bounded chunks that are already sent to the vector provider, so lexical and
-- vector hits share one identity (source + chunk index) and can be fused
-- chunk-for-chunk. It is NOT a second system of record - `seo_knowledge_sources`
-- (and, for files, object storage) stays canonical and this table is rebuildable
-- by re-ingesting a source.
--
--   * rows are keyed by (source_id, chunk_index); a source's projection is
--     replaced wholesale on every successful ingest/refresh, so a shorter body
--     never leaves stale chunks behind
--   * ON DELETE CASCADE follows the source row: deleting a source removes its
--     projection with it, so no orphan chunk is ever searchable
--   * the composite FK (source_id, project_id) makes it impossible for a chunk
--     to be attributed to another project
--   * `search_vector` is a stored generated tsvector with a GIN index, so the
--     query is index-backed and never recomputes to_tsvector across the table
--
-- Purely additive: no existing table/column is rewritten. The only change to an
-- existing table is a unique key on seo_knowledge_sources (id, project_id) used
-- by the composite foreign key.
-- ============================================================================

alter table public.seo_knowledge_sources
  add constraint seo_knowledge_sources_id_project_key unique (id, project_id);

create table public.seo_knowledge_lexical_chunks (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.seo_projects (id) on delete cascade,
  source_id     uuid not null,
  chunk_index   integer not null,
  content       text not null,
  search_vector tsvector generated always as (pg_catalog.to_tsvector('english'::pg_catalog.regconfig, content)) stored,
  created_at    timestamptz not null default now(),
  constraint seo_knowledge_lexical_chunks_source_fk
    foreign key (source_id, project_id)
    references public.seo_knowledge_sources (id, project_id)
    on delete cascade,
  constraint seo_knowledge_lexical_chunks_source_chunk_key unique (source_id, chunk_index),
  constraint seo_knowledge_lexical_chunks_chunk_index_check check (chunk_index >= 0)
);

create index seo_knowledge_lexical_chunks_search_idx
  on public.seo_knowledge_lexical_chunks using gin (search_vector);
create index seo_knowledge_lexical_chunks_project_source_idx
  on public.seo_knowledge_lexical_chunks (project_id, source_id);

-- ----------------------------------------------------------------------------
-- RLS: members read; owners/admins/editors may write. The API writes with the
-- service-role client after its own role check, so these policies are the
-- boundary for direct browser/PostgREST access (the RPC below is invoker, so
-- RLS still applies to a user session).
-- ----------------------------------------------------------------------------

alter table public.seo_knowledge_lexical_chunks enable row level security;

drop policy if exists seo_knowledge_lexical_chunks_select on public.seo_knowledge_lexical_chunks;
create policy seo_knowledge_lexical_chunks_select on public.seo_knowledge_lexical_chunks
  for select using (public.seo_is_member(project_id, auth.uid()));

drop policy if exists seo_knowledge_lexical_chunks_insert on public.seo_knowledge_lexical_chunks;
create policy seo_knowledge_lexical_chunks_insert on public.seo_knowledge_lexical_chunks
  for insert with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_knowledge_lexical_chunks_update on public.seo_knowledge_lexical_chunks;
create policy seo_knowledge_lexical_chunks_update on public.seo_knowledge_lexical_chunks
  for update using (public.seo_has_role(project_id, array['owner', 'admin', 'editor']))
  with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_knowledge_lexical_chunks_delete on public.seo_knowledge_lexical_chunks;
create policy seo_knowledge_lexical_chunks_delete on public.seo_knowledge_lexical_chunks
  for delete using (public.seo_has_role(project_id, array['owner', 'admin']));

comment on table public.seo_knowledge_lexical_chunks is
  'Derived lexical projection of knowledge chunks for hybrid retrieval (KB10). Rebuildable by re-ingesting a source; never a system of record. Cascade-deleted with its source.';

-- ----------------------------------------------------------------------------
-- Ranked lexical search used by the retrieval pipeline. It joins the source row
-- so project isolation, the `ready` lifecycle gate and every allowlisted filter
-- are applied in the database, before any candidate reaches fusion. Returns one
-- row per matching chunk with its ts_rank score. `security invoker` (the
-- default) keeps RLS as the boundary for user-session callers; the API's
-- service-role client bypasses RLS and passes the project explicitly.
-- ----------------------------------------------------------------------------

create or replace function public.seo_knowledge_lexical_search(
  p_project uuid,
  p_query text,
  p_limit integer default 50,
  p_source_ids uuid[] default null,
  p_source_types text[] default null,
  p_collection_id uuid default null,
  p_uncategorized boolean default false
)
returns table (
  source_id uuid,
  chunk_index integer,
  score real,
  content text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select pg_catalog.websearch_to_tsquery('english', p_query) as tsq
  )
  select
    c.source_id,
    c.chunk_index,
    pg_catalog.ts_rank(c.search_vector, q.tsq)::real as score,
    c.content
  from public.seo_knowledge_lexical_chunks c
  join public.seo_knowledge_sources s
    on s.id = c.source_id and s.project_id = c.project_id
  cross join q
  where c.project_id = p_project
    and s.status = 'ready'
    and c.search_vector @@ q.tsq
    and (p_source_ids is null or c.source_id = any (p_source_ids))
    and (p_source_types is null or s.source_type = any (p_source_types))
    and (
      (p_collection_id is null and coalesce(p_uncategorized, false) = false)
      or (p_collection_id is not null and s.collection_id = p_collection_id)
      or (coalesce(p_uncategorized, false) and s.collection_id is null)
    )
  order by score desc, c.source_id, c.chunk_index
  limit least(greatest(coalesce(p_limit, 50), 0), 200);
$$;
