-- ============================================================================
-- SEO Platform - resource protection foundation (P9)
--
-- P9 makes expensive and potentially abusive operations bounded and
-- attributable. It is deliberately NOT monetization: there are no plans, tiers,
-- subscriptions, prices, entitlements or paid/free feature distinctions. See
-- docs/p9-resource-protection.md.
--
-- The admission layer is enforced at the queue itself, in a BEFORE INSERT
-- trigger on seo_sync_jobs, so that *every* enqueue path is covered with no
-- per-call-site opt-in: the generic /jobs route, feature routes, the versioned
-- API (/api/v1), MCP, scheduled publishing, agent-run reconciliation and any
-- future caller all insert through the same table and therefore the same check.
--
-- Atomicity: Postgres READ COMMITTED would let two concurrent transactions both
-- observe the same pre-insert counts and oversubscribe the queue, so the guard
-- takes transaction-scoped advisory locks before counting. Locks are always
-- taken in one order (account, then project) and released automatically at
-- commit/rollback, so a multi-process deployment or a scaled worker fleet
-- cannot bypass the ceiling.
--
-- Reservation lifecycle: the job row *is* the reservation. A queued/running row
-- consumes capacity; completed/failed/canceled releases it. A retry is an
-- UPDATE back to 'queued' on the same row, not an INSERT, so retries never
-- multiply reservations.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- seo_resource_limits - conservative operational safety ceilings.
--
-- These are safety ceilings, not customer plans: every authenticated user gets
-- the full product, and the limits bound runaway work rather than price it.
-- They are data (not hardcoded) so the operationally correct value can be
-- adjusted without a redeploy, and so the migration smoke test can prove the
-- trigger honours an overridden ceiling. The trigger falls back to the same
-- defaults if a row is ever missing.
-- ----------------------------------------------------------------------------
create table public.seo_resource_limits (
  scope          text not null,
  resource       text not null,
  max_value      integer not null,
  window_seconds integer,
  updated_at     timestamptz not null default now(),
  constraint seo_resource_limits_pkey primary key (scope, resource),
  constraint seo_resource_limits_scope_check check (scope in ('project', 'account')),
  constraint seo_resource_limits_resource_format check (resource ~ '^[a-z0-9_]{1,40}$'),
  constraint seo_resource_limits_max_check check (max_value >= 0),
  constraint seo_resource_limits_window_check check (window_seconds is null or window_seconds > 0)
);

create trigger seo_resource_limits_touch_updated_at
  before update on public.seo_resource_limits
  for each row execute function public.seo_touch_updated_at();

-- Initial ceilings. Chosen from the resource-protection recon, not arbitrary
-- SaaS conventions: one worker process runs one job at a time and the queue was
-- previously unbounded, so these bound backlog and burst rather than throughput.
insert into public.seo_resource_limits (scope, resource, max_value, window_seconds) values
  ('project', 'jobs_queued',      25,  null),
  ('account', 'jobs_queued',      100, null),
  ('project', 'jobs_running',     10,  null),
  ('account', 'jobs_running',     40,  null),
  ('project', 'jobs_create_rate', 60,  60),
  ('account', 'jobs_create_rate', 180, 60)
on conflict (scope, resource) do nothing;

-- ----------------------------------------------------------------------------
-- Limit lookup with an in-code fallback, so a missing row can never silently
-- disable protection.
-- ----------------------------------------------------------------------------
create or replace function public.seo_resource_limit(p_scope text, p_resource text, p_default integer)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select l.max_value from public.seo_resource_limits l
      where l.scope = p_scope and l.resource = p_resource),
    p_default
  );
$$;

-- ----------------------------------------------------------------------------
-- seo_admit_job - the single admission primitive for background work.
--
-- Raises a structured exception when the requested job would exceed a ceiling.
-- The API maps the SQLSTATE/message onto a stable resource error; the trigger
-- itself never records a denial because its raise rolls the transaction back
-- (denial evidence is written by the API after the failed insert; see
-- apps/api/src/services/resourceAdmission.ts).
-- ----------------------------------------------------------------------------
create or replace function public.seo_admit_job()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account  uuid;
  v_limit    integer;
  v_count    integer;
  v_window   integer;
begin
  select p.account_id into v_account
  from public.seo_projects p
  where p.id = new.project_id;

  -- Serialize per account, then per project. Consistent ordering means two
  -- writers can never deadlock; different accounts hash to (almost always)
  -- distinct locks and proceed in parallel.
  if v_account is not null then
    perform pg_advisory_xact_lock(hashtext('seo:job:account:' || v_account::text));
  end if;
  perform pg_advisory_xact_lock(hashtext('seo:job:project:' || new.project_id::text));

  -- 1. Repeated request creation (per project, rolling window).
  v_limit := public.seo_resource_limit('project', 'jobs_create_rate', 60);
  select l.window_seconds into v_window from public.seo_resource_limits l
    where l.scope = 'project' and l.resource = 'jobs_create_rate';
  v_window := coalesce(v_window, 60);
  select count(*) into v_count from public.seo_sync_jobs j
    where j.project_id = new.project_id
      and j.created_at >= now() - make_interval(secs => v_window);
  if v_count >= v_limit then
    raise exception 'seo_resource_rate' using errcode = 'SE003',
      detail = json_build_object('scope', 'project', 'resource', 'background_job')::text;
  end if;

  -- 1b. Repeated request creation (per account).
  if v_account is not null then
    v_limit := public.seo_resource_limit('account', 'jobs_create_rate', 180);
    select l.window_seconds into v_window from public.seo_resource_limits l
      where l.scope = 'account' and l.resource = 'jobs_create_rate';
    v_window := coalesce(v_window, 60);
    select count(*) into v_count
      from public.seo_sync_jobs j
      join public.seo_projects p on p.id = j.project_id
      where p.account_id = v_account
        and j.created_at >= now() - make_interval(secs => v_window);
    if v_count >= v_limit then
      raise exception 'seo_resource_rate' using errcode = 'SE003',
        detail = json_build_object('scope', 'account', 'resource', 'background_job')::text;
    end if;
  end if;

  -- 2. Queue depth (queued jobs) per project.
  v_limit := public.seo_resource_limit('project', 'jobs_queued', 25);
  select count(*) into v_count from public.seo_sync_jobs j
    where j.project_id = new.project_id and j.status = 'queued';
  if v_count >= v_limit then
    raise exception 'seo_queue_limit' using errcode = 'SE001',
      detail = json_build_object('scope', 'project', 'resource', 'background_job')::text;
  end if;

  -- 2b. Queue depth per account across all of its projects.
  if v_account is not null then
    v_limit := public.seo_resource_limit('account', 'jobs_queued', 100);
    select count(*) into v_count
      from public.seo_sync_jobs j
      join public.seo_projects p on p.id = j.project_id
      where p.account_id = v_account and j.status = 'queued';
    if v_count >= v_limit then
      raise exception 'seo_queue_limit' using errcode = 'SE001',
        detail = json_build_object('scope', 'account', 'resource', 'background_job')::text;
    end if;
  end if;

  -- 3. Running concurrency per project.
  v_limit := public.seo_resource_limit('project', 'jobs_running', 10);
  select count(*) into v_count from public.seo_sync_jobs j
    where j.project_id = new.project_id and j.status = 'running';
  if v_count >= v_limit then
    raise exception 'seo_resource_concurrency' using errcode = 'SE002',
      detail = json_build_object('scope', 'project', 'resource', 'background_job')::text;
  end if;

  -- 3b. Running concurrency per account.
  if v_account is not null then
    v_limit := public.seo_resource_limit('account', 'jobs_running', 40);
    select count(*) into v_count
      from public.seo_sync_jobs j
      join public.seo_projects p on p.id = j.project_id
      where p.account_id = v_account and j.status = 'running';
    if v_count >= v_limit then
      raise exception 'seo_resource_concurrency' using errcode = 'SE002',
        detail = json_build_object('scope', 'account', 'resource', 'background_job')::text;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists seo_sync_jobs_admit on public.seo_sync_jobs;
create trigger seo_sync_jobs_admit
  before insert on public.seo_sync_jobs
  for each row execute function public.seo_admit_job();

-- ----------------------------------------------------------------------------
-- seo_resource_denials - operational evidence of a refused admission.
--
-- Kept separate from seo_usage_events on purpose: a denial is NOT billable
-- usage and must never inflate consumption. Rows are written by the API after
-- the failed insert (best-effort) and never mutate. ON DELETE SET NULL/CASCADE
-- mirrors the usage ledger's historical-visibility stance for account/project.
-- ----------------------------------------------------------------------------
create table public.seo_resource_denials (
  id            uuid primary key default gen_random_uuid(),
  occurred_at   timestamptz not null default now(),

  account_id    uuid references public.seo_accounts (id) on delete set null,
  project_id    uuid references public.seo_projects (id) on delete cascade,
  user_id       uuid references auth.users (id) on delete set null,

  resource      text not null,
  code          text not null,
  scope         text not null,
  requested     integer not null default 1,
  job_type      text,

  constraint seo_resource_denials_code_check
    check (code in ('resource_limit', 'resource_concurrency', 'queue_limit')),
  constraint seo_resource_denials_scope_check check (scope in ('project', 'account')),
  constraint seo_resource_denials_resource_format check (resource ~ '^[a-z0-9_]{1,40}$'),
  constraint seo_resource_denials_requested_check check (requested >= 0)
);

create index seo_resource_denials_project_time_idx
  on public.seo_resource_denials (project_id, occurred_at desc);
create index seo_resource_denials_account_time_idx
  on public.seo_resource_denials (account_id, occurred_at desc);
create index seo_resource_denials_code_time_idx
  on public.seo_resource_denials (code, occurred_at desc);

-- ----------------------------------------------------------------------------
-- RLS: both tables are operational and deny-all to browser/PostgREST traffic
-- (enabled with no policies). The API reads limits through the SECURITY DEFINER
-- helper and writes denial evidence with the service role. There is no
-- authenticated policy, so neither ceilings nor denial records leak.
-- ----------------------------------------------------------------------------
alter table public.seo_resource_limits  enable row level security;
alter table public.seo_resource_denials enable row level security;

-- The usage ledger stays the historical measurement layer; admission is a
-- separate concern. No existing table is altered or backfilled.
