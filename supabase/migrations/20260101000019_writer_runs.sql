-- ============================================================================
-- SEO Platform - durable writer runs (Writer W7)
--
-- A writer run is the durable, project-scoped record of a Content Studio
-- writing session. It exists so a run survives API process restarts: its row
-- is the safe external source of truth (status + validated, JSON-serialisable
-- run snapshot), while the actual LangGraph execution state lives in the
-- official Postgres checkpoint tables managed by the LangGraph checkpointer at
-- runtime (this migration only owns the `seo_` read model, never a private
-- checkpoint format).
--
--   * run_id is the external writer run id (`wr_<uuid>`), UNIQUE, and is also
--     the LangGraph thread_id of the run's graph (1:1).
--   * account_id mirrors the owning project's account (nullable, exactly like
--     seo_projects.account_id): it is derived from the authoritative project
--     row, never guessed from the request context. Project membership remains
--     the primary authorization boundary.
--   * status is the safe external lifecycle vocabulary (starting /
--     gathering_context / planning / awaiting_approval / writing /
--     review_ready / completed / rejected / failed) enforced by CHECK.
--   * state_json holds only safe, validated WriterRunResult data (identity,
--     brief, bounded context summary, plan, written sections, review artifact,
--     notes). No secrets, credentials, API keys, prompt text or LangGraph
--     runtime objects are ever stored here; reads validate the snapshot with a
--     strict schema and fail closed on malformed rows.
--   * completed_at marks a terminal resting point; rows are never hard-deleted
--     (retention policy is a separate operational concern).
-- ============================================================================

create table public.seo_writer_runs (
  id            uuid primary key default gen_random_uuid(),
  run_id        text not null unique,
  account_id    uuid references public.seo_accounts (id) on delete cascade,
  project_id    uuid not null references public.seo_projects (id) on delete cascade,
  content_id    uuid not null references public.seo_content (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete restrict,
  status        text not null default 'starting',
  state_json    jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz,
  constraint seo_writer_runs_run_format
    check (run_id ~ '^wr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  constraint seo_writer_runs_status_check
    check (status in ('starting', 'gathering_context', 'planning', 'awaiting_approval',
                      'writing', 'review_ready', 'completed', 'rejected', 'failed'))
);

create index seo_writer_runs_project_idx on public.seo_writer_runs (project_id);
create index seo_writer_runs_content_idx on public.seo_writer_runs (content_id);
create index seo_writer_runs_account_idx on public.seo_writer_runs (account_id);
create index seo_writer_runs_recovery_idx on public.seo_writer_runs (status, updated_at);

create trigger seo_writer_runs_touch_updated_at
  before update on public.seo_writer_runs
  for each row execute function public.seo_touch_updated_at();

-- Keep a writer run attached to its project's account automatically (mirrors
-- the seo_integrations pattern): the project row is the authoritative account
-- source, so callers never need to know about accounts.
create or replace function public.seo_writer_runs_set_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.account_id is null then
    select p.account_id into new.account_id
    from public.seo_projects p
    where p.id = new.project_id;
  end if;
  return new;
end;
$$;

drop trigger if exists seo_writer_runs_set_account on public.seo_writer_runs;
create trigger seo_writer_runs_set_account
  before insert on public.seo_writer_runs
  for each row when (new.account_id is null)
  execute function public.seo_writer_runs_set_account();

-- ----------------------------------------------------------------------------
-- RLS. The API writes with the service role (bypasses RLS after its own access
-- checks); these policies are the boundary for any browser-side / PostgREST
-- traffic: members may read runs, editors+ may start/resume them. Writer runs
-- are never hard-deleted, so there is no delete policy.
-- ----------------------------------------------------------------------------

alter table public.seo_writer_runs enable row level security;

drop policy if exists seo_writer_runs_select on public.seo_writer_runs;
create policy seo_writer_runs_select on public.seo_writer_runs
  for select using (public.seo_is_member(project_id, auth.uid()));

drop policy if exists seo_writer_runs_insert on public.seo_writer_runs;
create policy seo_writer_runs_insert on public.seo_writer_runs
  for insert with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_writer_runs_update on public.seo_writer_runs;
create policy seo_writer_runs_update on public.seo_writer_runs
  for update using (public.seo_has_role(project_id, array['owner', 'admin', 'editor']))
  with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));
