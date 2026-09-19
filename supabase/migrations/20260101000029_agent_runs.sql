-- ============================================================================
-- SEO Platform - durable agent runs (Stage 8E.6, ADR Phase 4 Part 1)
--
-- An agent run is the durable, project-scoped lifecycle record of an agent
-- request. It is deliberately NOT a job: `seo_sync_jobs` is the shared
-- execution queue, while a run owns the request, the terminal result and the
-- failure facts a caller can poll. The relationship is explicit and one-way:
-- a run records the job that carries its execution (`job_id`), and the job
-- params carry the run id. There is no second queue, worker or retry model.
--
-- Part 1 is the durable submission boundary only: validate -> authorize ->
-- idempotency -> persist the run and associate the job. Execution and the
-- status API are Phase 4 Part 2 and are intentionally absent here.
--
--   * run_id is the external agent run id (`ar_<uuid>`), UNIQUE and opaque.
--   * account_id mirrors the owning project's account (nullable, exactly like
--     seo_projects.account_id): derived from the authoritative project row,
--     never guessed from the request. Project membership remains the primary
--     authorization boundary.
--   * kind is the run kind vocabulary (only `design` today).
--   * status is the safe external lifecycle vocabulary (queued / running /
--     succeeded / failed) enforced by CHECK. A run is never `succeeded`
--     before its result is durably persisted.
--   * input_json holds only the validated AgentRunInput (a Designer plan or
--     intent). result_json holds only the validated DesignerProposal once the
--     run succeeds. error_json holds only the bounded AgentRunError. No
--     secrets, credentials, API keys, prompts or runtime objects are stored;
--     reads validate and fail closed on malformed rows.
--   * idempotency_key is scoped to the project (a client-supplied key must not
--     collide across projects). A duplicate insert is the concurrent-safety
--     guard: the winner creates the run, losers read it back instead of
--     creating a second run or job. NULL keys are not deduplicated.
--   * completed_at marks a terminal resting point; rows are never hard-deleted
--     (retention policy is a separate operational concern).
-- ============================================================================

create table public.seo_agent_runs (
  id              uuid primary key default gen_random_uuid(),
  run_id          text not null unique,
  account_id      uuid references public.seo_accounts (id) on delete cascade,
  project_id      uuid not null references public.seo_projects (id) on delete cascade,
  kind            text not null default 'design',
  status          text not null default 'queued',
  input_json      jsonb not null default '{}'::jsonb,
  result_json     jsonb,
  error_json      jsonb,
  job_id          uuid references public.seo_sync_jobs (id) on delete set null,
  idempotency_key text,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz,
  constraint seo_agent_runs_run_format
    check (run_id ~ '^ar_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  constraint seo_agent_runs_status_check
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  constraint seo_agent_runs_kind_check
    check (kind in ('design'))
);

create index seo_agent_runs_project_idx on public.seo_agent_runs (project_id);
create index seo_agent_runs_account_idx on public.seo_agent_runs (account_id);
create index seo_agent_runs_job_idx on public.seo_agent_runs (job_id);
create index seo_agent_runs_recovery_idx on public.seo_agent_runs (status, updated_at);
create unique index seo_agent_runs_idempotency_idx
  on public.seo_agent_runs (project_id, idempotency_key)
  where idempotency_key is not null;

create trigger seo_agent_runs_touch_updated_at
  before update on public.seo_agent_runs
  for each row execute function public.seo_touch_updated_at();

-- Keep a run attached to its project's account automatically (mirrors the
-- seo_writer_runs pattern): the project row is the authoritative account
-- source, so callers never need to know about accounts.
create or replace function public.seo_agent_runs_set_account()
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

drop trigger if exists seo_agent_runs_set_account on public.seo_agent_runs;
create trigger seo_agent_runs_set_account
  before insert on public.seo_agent_runs
  for each row when (new.account_id is null)
  execute function public.seo_agent_runs_set_account();

-- ----------------------------------------------------------------------------
-- RLS. The API writes with the service role (bypasses RLS after its own access
-- checks); these policies are the boundary for any browser-side / PostgREST
-- traffic: members may read runs, editors+ may create/advance them. Runs are
-- never hard-deleted, so there is no delete policy.
-- ----------------------------------------------------------------------------

alter table public.seo_agent_runs enable row level security;

drop policy if exists seo_agent_runs_select on public.seo_agent_runs;
create policy seo_agent_runs_select on public.seo_agent_runs
  for select using (public.seo_is_member(project_id, auth.uid()));

drop policy if exists seo_agent_runs_insert on public.seo_agent_runs;
create policy seo_agent_runs_insert on public.seo_agent_runs
  for insert with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_agent_runs_update on public.seo_agent_runs;
create policy seo_agent_runs_update on public.seo_agent_runs
  for update using (public.seo_has_role(project_id, array['owner', 'admin', 'editor']))
  with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));
