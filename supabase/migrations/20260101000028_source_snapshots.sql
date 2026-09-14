-- ============================================================================
-- SEO Platform - reusable source snapshots (KW4.5 foundation)
--
-- A job is an execution record (lifecycle, progress, errors, traceability); a
-- source snapshot is the reusable, project-scoped *copy* of what a provider
-- returned for one canonical scope. This separates "what ran" from "what we
-- know", so a later analysis (KW5) can ask for the current best competitor gap
-- data without depending on whichever job id happened to run last.
--
-- Design rules:
--   * One row per (project_id, type, scope_key) - the current best known.
--     A refresh upserts in place; this table is NOT a history/time-series.
--   * `scope` holds every parameter that can change the substantive provider
--     result (domain, market, filters, limits). `scope_key` is its SHA-256, so
--     scope matching is stable and order-insensitive. It never contains a
--     jobId, userId or timestamp.
--   * `data` holds the bounded, normalized provider payload - never a raw
--     vendor blob - and is size-capped so a snapshot cannot become a blob store.
--   * Freshness is NOT stored: `fetched_at` is a fact and the fresh/due/stale
--     state is derived on read (mirrors KB7). An expired snapshot therefore
--     stays available; expiry never means deletion.
--
-- Purely additive.
-- ============================================================================

create table public.seo_source_snapshots (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.seo_projects (id) on delete cascade,
  type           text not null,
  provider       text not null,
  scope          jsonb not null default '{}'::jsonb,
  scope_key      text not null,
  data           jsonb not null,
  schema_version integer not null default 1,
  fetched_at     timestamptz not null default now(),
  source_job_id  uuid references public.seo_sync_jobs (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint seo_source_snapshots_type_check
    check (type in ('competitor_discovery', 'competitor_gap')),
  constraint seo_source_snapshots_provider_not_blank check (length(btrim(provider)) > 0),
  constraint seo_source_snapshots_scope_key_check check (length(scope_key) = 64),
  constraint seo_source_snapshots_schema_version_check check (schema_version >= 1),
  constraint seo_source_snapshots_scope_size_check check (pg_column_size(scope) <= 8192),
  constraint seo_source_snapshots_data_size_check check (pg_column_size(data) <= 262144),
  constraint seo_source_snapshots_unique_scope unique (project_id, type, scope_key)
);

create index seo_source_snapshots_project_type_fetched_idx
  on public.seo_source_snapshots (project_id, type, fetched_at desc);

create trigger seo_source_snapshots_touch_updated_at
  before update on public.seo_source_snapshots
  for each row execute function public.seo_touch_updated_at();

-- ----------------------------------------------------------------------------
-- RLS: members read; owners/admins/editors write (they are the ones allowed to
-- start a paid provider refresh); only owners/admins delete. Reading a snapshot
-- is deliberately separate from spending provider credits.
-- ----------------------------------------------------------------------------

alter table public.seo_source_snapshots enable row level security;

drop policy if exists seo_source_snapshots_select on public.seo_source_snapshots;
create policy seo_source_snapshots_select on public.seo_source_snapshots
  for select using (public.seo_is_member(project_id, auth.uid()));

drop policy if exists seo_source_snapshots_insert on public.seo_source_snapshots;
create policy seo_source_snapshots_insert on public.seo_source_snapshots
  for insert with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_source_snapshots_update on public.seo_source_snapshots;
create policy seo_source_snapshots_update on public.seo_source_snapshots
  for update using (public.seo_has_role(project_id, array['owner', 'admin', 'editor']))
  with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_source_snapshots_delete on public.seo_source_snapshots;
create policy seo_source_snapshots_delete on public.seo_source_snapshots
  for delete using (public.seo_has_role(project_id, array['owner', 'admin']));

comment on table public.seo_source_snapshots is
  'Reusable, project-scoped provider intelligence (KW4.5). One row per (project, type, canonical scope) = current best known; a refresh upserts in place, never a history.';
comment on column public.seo_source_snapshots.scope is
  'Canonical provider-affecting scope. Never contains a jobId, userId or timestamp.';
comment on column public.seo_source_snapshots.scope_key is
  'SHA-256 of the canonical scope; the stable identity used for reuse matching.';
comment on column public.seo_source_snapshots.data is
  'Bounded, normalized provider payload. Never a raw vendor blob.';
comment on column public.seo_source_snapshots.fetched_at is
  'When the provider actually returned this data. Freshness state is derived from this on read, never stored.';
