-- ============================================================================
-- SEO Platform - synchronous resource protection completion (P11)
--
-- P9 protects durable work at the queue: every insert into seo_sync_jobs passes
-- through seo_admit_job, so async job admission is uniform.
--
-- P10 found that economically relevant server-funded consumption also happens
-- *synchronously*, inside an HTTP request, without ever creating a job row:
-- Composer, Designer, the Writer planner/research, in-editor AI edit,
-- content-intelligence ?with_ai=1 and knowledge search. P11 adds a second,
-- generic admission primitive for that class of work. It is the same model as
-- P9 - a conservative technical ceiling evaluated atomically before the work
-- starts, with a structured denial - not a second, per-feature mechanism.
--
-- P11 is technical protection only. There are no plans, subscriptions, prices,
-- entitlements or per-feature restrictions here; those belong to a future
-- entitlement layer that resolves *on top of* these technical floors. See
-- docs/p11-resource-protection.md.
--
-- Model:
--   seo_resource_limits       technical ceilings (shared with P9 jobs_* keys)
--   seo_resource_reservations short-lived reservation of an in-flight sync op
--   seo_admit_resource()      atomic check + reserve (advisory locks)
--   seo_release_resource()    release a finished reservation
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Funding attribution (P11): which credential funded a measured fact. Nullable
-- because a mixed background job cannot always be attributed to one credential.
-- ----------------------------------------------------------------------------
alter table public.seo_usage_events
  add column if not exists funding_source text;

alter table public.seo_usage_events
  drop constraint if exists seo_usage_events_funding_check,
  add constraint seo_usage_events_funding_check
    check (funding_source is null or funding_source in ('byok', 'operator_funded'));

comment on column public.seo_usage_events.funding_source is
  'P11: byok = user credential funded the call; operator_funded = server env key. Null = unattributable.';

-- ----------------------------------------------------------------------------
-- seo_resource_reservations - one row per admitted synchronous operation.
--
-- The row *is* the reservation: it is counted while active (released_at null and
-- expires_at in the future) and stops counting when released. A TTL bounds
-- leaked reservations from a crashed process without requiring a sweeper: an
-- expired reservation no longer counts as in-flight. Reservation rows are
-- operational evidence, never a billing record.
-- ----------------------------------------------------------------------------
create table public.seo_resource_reservations (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid references public.seo_accounts (id) on delete set null,
  project_id  uuid not null references public.seo_projects (id) on delete cascade,
  user_id     uuid references auth.users (id) on delete set null,
  resource    text not null,
  amount      integer not null default 1,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  released_at timestamptz,
  constraint seo_resource_reservations_resource_format check (resource ~ '^[a-z0-9_]{1,40}$'),
  constraint seo_resource_reservations_amount_check check (amount >= 1)
);

create index seo_resource_reservations_project_idx
  on public.seo_resource_reservations (project_id, resource)
  where released_at is null;
create index seo_resource_reservations_account_idx
  on public.seo_resource_reservations (account_id, resource)
  where released_at is null;
create index seo_resource_reservations_project_time_idx
  on public.seo_resource_reservations (project_id, acquired_at desc);

-- Operational only: deny-all to browser/PostgREST. The API reserves/releases
-- through the SECURITY DEFINER functions below with the service role.
alter table public.seo_resource_reservations enable row level security;

-- ----------------------------------------------------------------------------
-- seo_admit_resource - the synchronous admission primitive.
--
-- Evaluates a repeated-request rate ceiling and an in-flight concurrency ceiling
-- for both the project and its account, takes the same ordered advisory locks as
-- P9 (account then project, so two writers can never deadlock) and, when the
-- request fits, records a reservation and returns its id. Raises the same
-- structured SQLSTATEs as seo_admit_job so the API maps them identically:
--   SE001 queue_limit, SE002 resource_concurrency, SE003 resource_limit.
--
-- The ceiling values are read from seo_resource_limits with in-code fallbacks,
-- so a missing row can never silently disable protection.
-- ----------------------------------------------------------------------------
create or replace function public.seo_admit_resource(
  p_project_id  uuid,
  p_resource    text,
  p_amount      integer default 1,
  p_ttl_seconds integer default 900
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account    uuid;
  v_limit      integer;
  v_window     integer;
  v_count      integer;
  v_amount     integer := greatest(coalesce(p_amount, 1), 1);
  v_ttl        integer := greatest(coalesce(p_ttl_seconds, 900), 1);
  v_id         uuid;
begin
  if p_project_id is null or p_resource is null or p_resource !~ '^[a-z0-9_]{1,40}$' then
    raise exception 'seo_resource_invalid' using errcode = 'SE003',
      detail = json_build_object('scope', 'project', 'resource', coalesce(p_resource, 'unknown'))::text;
  end if;

  select p.account_id into v_account
  from public.seo_projects p
  where p.id = p_project_id;

  -- Same lock ordering as seo_admit_job: account first, then project.
  if v_account is not null then
    perform pg_advisory_xact_lock(hashtext('seo:job:account:' || v_account::text));
  end if;
  perform pg_advisory_xact_lock(hashtext('seo:job:project:' || p_project_id::text));

  -- 1. Repeated request creation, per project (rolling window).
  v_limit := public.seo_resource_limit('project', 'sync_create_rate', 60);
  select l.window_seconds into v_window from public.seo_resource_limits l
    where l.scope = 'project' and l.resource = 'sync_create_rate';
  v_window := coalesce(v_window, 60);
  select count(*) into v_count from public.seo_resource_reservations r
    where r.project_id = p_project_id
      and r.resource = p_resource
      and r.acquired_at >= now() - make_interval(secs => v_window);
  if v_count + v_amount > v_limit then
    raise exception 'seo_resource_rate' using errcode = 'SE003',
      detail = json_build_object('scope', 'project', 'resource', p_resource)::text;
  end if;

  -- 1b. Repeated request creation, per account.
  if v_account is not null then
    v_limit := public.seo_resource_limit('account', 'sync_create_rate', 180);
    select l.window_seconds into v_window from public.seo_resource_limits l
      where l.scope = 'account' and l.resource = 'sync_create_rate';
    v_window := coalesce(v_window, 60);
    select count(*) into v_count from public.seo_resource_reservations r
      where r.account_id = v_account
        and r.resource = p_resource
        and r.acquired_at >= now() - make_interval(secs => v_window);
    if v_count + v_amount > v_limit then
      raise exception 'seo_resource_rate' using errcode = 'SE003',
        detail = json_build_object('scope', 'account', 'resource', p_resource)::text;
    end if;
  end if;

  -- 2. In-flight concurrency, per project.
  v_limit := public.seo_resource_limit('project', p_resource || '_inflight', 4);
  select count(*) into v_count from public.seo_resource_reservations r
    where r.project_id = p_project_id
      and r.resource = p_resource
      and r.released_at is null
      and r.expires_at > now();
  if v_count + v_amount > v_limit then
    raise exception 'seo_resource_concurrency' using errcode = 'SE002',
      detail = json_build_object('scope', 'project', 'resource', p_resource)::text;
  end if;

  -- 2b. In-flight concurrency, per account.
  if v_account is not null then
    v_limit := public.seo_resource_limit('account', p_resource || '_inflight', 12);
    select count(*) into v_count from public.seo_resource_reservations r
      where r.account_id = v_account
        and r.resource = p_resource
        and r.released_at is null
        and r.expires_at > now();
    if v_count + v_amount > v_limit then
      raise exception 'seo_resource_concurrency' using errcode = 'SE002',
        detail = json_build_object('scope', 'account', 'resource', p_resource)::text;
    end if;
  end if;

  insert into public.seo_resource_reservations (account_id, project_id, resource, amount, expires_at)
  values (v_account, p_project_id, p_resource, v_amount, now() + make_interval(secs => v_ttl))
  returning id into v_id;

  return v_id;
end;
$$;

-- Release a reservation once the operation has finished (success or failure).
-- Idempotent: releasing twice is a no-op.
create or replace function public.seo_release_resource(p_reservation_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.seo_resource_reservations
     set released_at = now()
   where id = p_reservation_id and released_at is null;
$$;

grant execute on function public.seo_admit_resource(uuid, text, integer, integer) to service_role;
grant execute on function public.seo_release_resource(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- Technical ceilings for synchronous server-funded resources.
--
-- Conservative operational safety ceilings, not commercial quotas. Every
-- authenticated user still gets the full product; these bound concurrent
-- in-flight work and repeated requests so one account cannot overload a
-- provider or the server. Values are data, adjustable without a redeploy, and
-- the trigger/function falls back to the same defaults when a row is missing.
--
--   <resource>_inflight : max concurrent in-flight operations for the scope
--   sync_create_rate    : max admitted sync operations per rolling window
-- ----------------------------------------------------------------------------
insert into public.seo_resource_limits (scope, resource, max_value, window_seconds) values
  ('project', 'sync_create_rate',       60,  60),
  ('account', 'sync_create_rate',       180, 60),
  ('project', 'ai_generation_inflight', 6,   null),
  ('account', 'ai_generation_inflight', 20,  null),
  ('project', 'ai_image_inflight',      3,   null),
  ('account', 'ai_image_inflight',      10,  null),
  ('project', 'ai_embedding_inflight',  4,   null),
  ('account', 'ai_embedding_inflight',  15,  null),
  ('project', 'dataforseo_inflight',    4,   null),
  ('account', 'dataforseo_inflight',    12,  null),
  ('project', 'media_inflight',         4,   null),
  ('account', 'media_inflight',         12,  null)
on conflict (scope, resource) do nothing;

-- The P9 job trigger and its limits are untouched: async work stays on
-- seo_admit_job, sync work uses seo_admit_resource.
