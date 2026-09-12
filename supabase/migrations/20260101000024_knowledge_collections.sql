-- ============================================================================
-- SEO Platform - knowledge collections (KB8)
--
-- Lightweight, optional organization for knowledge sources: a project can group
-- its sources into named collections so a large library stays navigable and
-- retrieval can be narrowed to one collection. This is organizational metadata
-- only - it is NOT a second knowledge store and it never changes a source's
-- lifecycle or its vectors. Postgres stays the source of truth; Qdrant stays a
-- derived retrieval index.
--
--   * a source belongs to zero or one collection (`collection_id`), or to none
--     ("uncategorized") - both are valid and normal
--   * deleting a collection never deletes sources; ON DELETE SET NULL returns
--     them to uncategorized
--   * a source may only reference a collection in its own project (composite FK)
--   * collection names are unique per project, case-insensitively
--
-- Purely additive: existing sources keep collection_id NULL. Nothing here
-- touches lifecycle, freshness or indexing fields.
-- ============================================================================

create table public.seo_knowledge_collections (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.seo_projects (id) on delete cascade,
  name         text not null,
  description  text,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint seo_knowledge_collections_name_check
    check (length(name) between 1 and 120 and name = btrim(name)),
  constraint seo_knowledge_collections_description_check
    check (description is null or length(description) <= 500)
);

-- Deterministic, de-duplicated ordering and the case-insensitive uniqueness the
-- service reports as a clean conflict (never a raw SQL error to the client).
create unique index seo_knowledge_collections_project_name_key
  on public.seo_knowledge_collections (project_id, lower(name));
create index seo_knowledge_collections_project_idx
  on public.seo_knowledge_collections (project_id, name);

create trigger seo_knowledge_collections_touch_updated_at
  before update on public.seo_knowledge_collections
  for each row execute function public.seo_touch_updated_at();

-- ----------------------------------------------------------------------------
-- Source -> collection membership. Nullable: an uncategorized source is valid.
-- The composite foreign key (collection_id, project_id) makes it impossible for
-- a source to point at a collection in another project, and ON DELETE SET NULL
-- only clears the collection (the source row survives) so deleting a collection
-- can never delete knowledge.
-- ----------------------------------------------------------------------------

alter table public.seo_knowledge_collections
  add constraint seo_knowledge_collections_id_project_key unique (id, project_id);

alter table public.seo_knowledge_sources
  add column if not exists collection_id uuid,
  add constraint seo_knowledge_sources_collection_fk
    foreign key (collection_id, project_id)
    references public.seo_knowledge_collections (id, project_id)
    on delete set null (collection_id);

create index if not exists seo_knowledge_sources_collection_idx
  on public.seo_knowledge_sources (project_id, collection_id);

-- ----------------------------------------------------------------------------
-- RLS: members read; owners/admins/editors create and update; only owners/admins
-- delete directly. The API writes server-side after its own role check, so these
-- policies are the boundary for any browser-side/PostgREST access. Collections
-- deliberately introduce no new permission model: they reuse the knowledge rules.
-- ----------------------------------------------------------------------------

alter table public.seo_knowledge_collections enable row level security;

drop policy if exists seo_knowledge_collections_select on public.seo_knowledge_collections;
create policy seo_knowledge_collections_select on public.seo_knowledge_collections
  for select using (public.seo_is_member(project_id, auth.uid()));

drop policy if exists seo_knowledge_collections_insert on public.seo_knowledge_collections;
create policy seo_knowledge_collections_insert on public.seo_knowledge_collections
  for insert with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_knowledge_collections_update on public.seo_knowledge_collections;
create policy seo_knowledge_collections_update on public.seo_knowledge_collections
  for update using (public.seo_has_role(project_id, array['owner', 'admin', 'editor']))
  with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_knowledge_collections_delete on public.seo_knowledge_collections;
create policy seo_knowledge_collections_delete on public.seo_knowledge_collections
  for delete using (public.seo_has_role(project_id, array['owner', 'admin']));

comment on table public.seo_knowledge_collections is
  'Optional, project-scoped grouping for knowledge sources. Organizational metadata only - never a knowledge store; deleting one leaves its sources intact (they become uncategorized).';
comment on column public.seo_knowledge_sources.collection_id is
  'Optional collection. NULL means uncategorized, which is a valid, fully searchable state.';
