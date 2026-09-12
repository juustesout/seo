-- ============================================================================
-- SEO Platform - knowledge discovery sessions (KB9)
--
-- A discovery session records a *proposal*: the bounded, in-scope candidate
-- URLs found by following links from one seed page. It never stores scraped
-- page content and it never indexes anything by itself. A human reviews the
-- candidates, selects some, and only then are normal `seo_knowledge_sources`
-- rows created and the existing KB3 ingestion queued.
--
--   * `request_json` holds the bounded request (seed, scope, limits); it is
--     size-capped so a session can never become a blob store.
--   * `result_json` holds the bounded, normalized candidate proposal (never a
--     raw provider payload) and is likewise size-capped.
--   * `collection_id` is an optional KB8 target; deleting that collection
--     leaves the session intact (ON DELETE SET NULL) - it only changes the
--     default destination of a later apply.
--   * lifecycle: queued -> processing -> ready | failed, then ready -> applied.
--
-- Purely additive.
-- ============================================================================

create table public.seo_knowledge_discovery_sessions (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.seo_projects (id) on delete cascade,
  seed_url              text not null,
  normalized_seed_url   text not null,
  collection_id         uuid,
  status                text not null default 'queued',
  scope                 text not null default 'same_host',
  max_urls              integer not null default 25,
  max_depth             integer not null default 1,
  request_json          jsonb not null default '{}'::jsonb,
  result_json           jsonb,
  error                 text,
  created_by            uuid references auth.users (id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint seo_knowledge_discovery_sessions_status_check
    check (status in ('queued', 'processing', 'ready', 'failed', 'applied')),
  constraint seo_knowledge_discovery_sessions_scope_check
    check (scope in ('same_host', 'same_domain')),
  constraint seo_knowledge_discovery_sessions_seed_check
    check (length(seed_url) between 3 and 2048 and seed_url = btrim(seed_url)),
  constraint seo_knowledge_discovery_sessions_normalized_seed_check
    check (length(normalized_seed_url) between 3 and 2048),
  constraint seo_knowledge_discovery_sessions_max_urls_check
    check (max_urls between 1 and 100),
  constraint seo_knowledge_discovery_sessions_max_depth_check
    check (max_depth between 0 and 3),
  constraint seo_knowledge_discovery_sessions_request_size_check
    check (pg_column_size(request_json) <= 8192),
  constraint seo_knowledge_discovery_sessions_result_size_check
    check (result_json is null or pg_column_size(result_json) <= 262144)
);

alter table public.seo_knowledge_discovery_sessions
  add constraint seo_knowledge_discovery_sessions_collection_fk
    foreign key (collection_id, project_id)
    references public.seo_knowledge_collections (id, project_id)
    on delete set null (collection_id);

create index seo_knowledge_discovery_sessions_project_created_idx
  on public.seo_knowledge_discovery_sessions (project_id, created_at desc);
create index seo_knowledge_discovery_sessions_project_status_idx
  on public.seo_knowledge_discovery_sessions (project_id, status);

create trigger seo_knowledge_discovery_sessions_touch_updated_at
  before update on public.seo_knowledge_discovery_sessions
  for each row execute function public.seo_touch_updated_at();

-- ----------------------------------------------------------------------------
-- RLS: members read; owners/admins/editors create and drive a session; only
-- owners/admins delete. Discovery reuses the knowledge permission model.
-- ----------------------------------------------------------------------------

alter table public.seo_knowledge_discovery_sessions enable row level security;

drop policy if exists seo_knowledge_discovery_sessions_select on public.seo_knowledge_discovery_sessions;
create policy seo_knowledge_discovery_sessions_select on public.seo_knowledge_discovery_sessions
  for select using (public.seo_is_member(project_id, auth.uid()));

drop policy if exists seo_knowledge_discovery_sessions_insert on public.seo_knowledge_discovery_sessions;
create policy seo_knowledge_discovery_sessions_insert on public.seo_knowledge_discovery_sessions
  for insert with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_knowledge_discovery_sessions_update on public.seo_knowledge_discovery_sessions;
create policy seo_knowledge_discovery_sessions_update on public.seo_knowledge_discovery_sessions
  for update using (public.seo_has_role(project_id, array['owner', 'admin', 'editor']))
  with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_knowledge_discovery_sessions_delete on public.seo_knowledge_discovery_sessions;
create policy seo_knowledge_discovery_sessions_delete on public.seo_knowledge_discovery_sessions
  for delete using (public.seo_has_role(project_id, array['owner', 'admin']));

comment on table public.seo_knowledge_discovery_sessions is
  'Bounded, human-approved link discovery proposals (KB9). Stores proposed candidate URLs only - never scraped content; applying a selection creates normal knowledge sources.';
comment on column public.seo_knowledge_discovery_sessions.result_json is
  'Normalized, bounded candidate proposal. Never a raw provider payload.';
