-- ============================================================================
-- SEO Platform - platform administration (P3)
--
-- The platform administrator is a SEPARATE trust boundary from project
-- membership. Project roles (owner/admin/editor/viewer) never imply platform
-- admin, and this table never grants project access.
--
-- seo_platform_admins is the registry of platform administrators, keyed by the
-- authenticated Supabase user id (never by email). It is a server-only
-- registry:
--   * RLS is enabled with NO policies, so browser/PostgREST traffic under the
--     anon or authenticated role can neither read nor write it;
--   * table privileges are revoked from anon/authenticated and granted only to
--     service_role, which the API server uses after it has verified the bearer
--     token;
--   * there is no self-service path: a row is provisioned out of band (SQL /
--     operator action). See docs/platform-admin-bootstrap.md.
--
-- The admin read RPCs below are security definer (so they can read auth.users),
-- verify the caller-supplied actor with seo_is_platform_admin before returning
-- any row, and are executable only by service_role. The API passes the already
-- verified session user id as p_actor - the same pattern as seo_usage_totals.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Registry
-- ----------------------------------------------------------------------------

create table public.seo_platform_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

comment on table public.seo_platform_admins is
  'Platform administrator registry (P3). Separate from project roles. Populated out of band only; see docs/platform-admin-bootstrap.md.';

alter table public.seo_platform_admins enable row level security;

-- Server-only: the API reads/writes this with the service role after verifying
-- the bearer token. No policy exists on purpose, so even if a grant were
-- widened, anon/authenticated row access would still be denied by RLS.
revoke all on public.seo_platform_admins from public, anon, authenticated;
grant select, insert, update, delete on public.seo_platform_admins to service_role;

-- ----------------------------------------------------------------------------
-- Registry lookup helpers (executable only by service_role)
-- ----------------------------------------------------------------------------

create or replace function public.seo_is_platform_admin(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.seo_platform_admins a where a.user_id = p_user
  );
$$;

comment on function public.seo_is_platform_admin(uuid) is
  'True when the user id is a registered platform administrator. Server-only.';

create or replace function public.seo_assert_platform_admin(p_actor uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_actor is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if not public.seo_is_platform_admin(p_actor) then
    raise exception 'Platform administrator access required' using errcode = '42501';
  end if;
end;
$$;

comment on function public.seo_assert_platform_admin(uuid) is
  'Raises unless the actor is a registered platform administrator. Called by the admin read RPCs.';

revoke execute on function public.seo_is_platform_admin(uuid) from public, anon, authenticated;
revoke execute on function public.seo_assert_platform_admin(uuid) from public, anon, authenticated;
grant execute on function public.seo_is_platform_admin(uuid) to service_role;
grant execute on function public.seo_assert_platform_admin(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- Operational overview counts. Only metrics that map to an unambiguous
-- existing definition are returned; there is deliberately no "active user"
-- definition. usage_events_this_period counts recorded usage facts in the
-- current UTC calendar month - it does not sum quantities across units, which
-- would be meaningless.
-- ----------------------------------------------------------------------------

create or replace function public.seo_platform_admin_overview(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_users    bigint;
  v_accounts bigint;
  v_projects bigint;
  v_jobs     bigint;
  v_active   bigint;
  v_failed   bigint;
  v_usage    bigint;
begin
  perform public.seo_assert_platform_admin(p_actor);

  select count(*) into v_users from auth.users;
  select count(*) into v_accounts from public.seo_accounts;
  select count(*) into v_projects from public.seo_projects;
  select count(*) into v_jobs from public.seo_sync_jobs;
  select count(*) into v_active from public.seo_sync_jobs where status in ('queued', 'running');
  select count(*) into v_failed from public.seo_sync_jobs where status = 'failed';
  select count(*) into v_usage from public.seo_usage_events where occurred_at >= date_trunc('month', now());

  return jsonb_build_object(
    'users', v_users,
    'accounts', v_accounts,
    'projects', v_projects,
    'jobs', v_jobs,
    'active_jobs', v_active,
    'failed_jobs', v_failed,
    'usage_events_this_period', v_usage,
    'usage_period_start', date_trunc('month', now())
  );
end;
$$;

-- ----------------------------------------------------------------------------
-- Users: identity, account association, creation date, project count. Never
-- secrets (no password/token/key columns exist here at all).
-- ----------------------------------------------------------------------------

create or replace function public.seo_platform_admin_users(p_actor uuid)
returns table (
  user_id       uuid,
  email         text,
  created_at    timestamptz,
  account_id    uuid,
  project_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.seo_assert_platform_admin(p_actor);

  return query
    select
      u.id,
      u.email::text,
      u.created_at,
      a.id,
      (select count(*) from public.seo_project_members m where m.user_id = u.id)::bigint
    from auth.users u
    left join public.seo_accounts a on a.owner_user_id = u.id
    order by u.created_at asc;
end;
$$;

-- ----------------------------------------------------------------------------
-- Accounts: identity, owner, project count, distinct member reach, creation.
-- ----------------------------------------------------------------------------

create or replace function public.seo_platform_admin_accounts(p_actor uuid)
returns table (
  account_id    uuid,
  name          text,
  owner_user_id uuid,
  owner_email   text,
  created_at    timestamptz,
  project_count bigint,
  member_count  bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.seo_assert_platform_admin(p_actor);

  return query
    select
      a.id,
      a.name,
      a.owner_user_id,
      ou.email::text,
      a.created_at,
      (select count(*) from public.seo_projects p where p.account_id = a.id)::bigint,
      (
        select count(distinct m.user_id)
        from public.seo_project_members m
        join public.seo_projects p on p.id = m.project_id
        where p.account_id = a.id
      )::bigint
    from public.seo_accounts a
    left join auth.users ou on ou.id = a.owner_user_id
    order by a.created_at asc;
end;
$$;

-- ----------------------------------------------------------------------------
-- Projects: identity, owning account, creator, member count, creation. There
-- is no project status column in the schema, so none is reported.
-- ----------------------------------------------------------------------------

create or replace function public.seo_platform_admin_projects(p_actor uuid)
returns table (
  project_id   uuid,
  name         text,
  account_id   uuid,
  created_by   uuid,
  created_at   timestamptz,
  member_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.seo_assert_platform_admin(p_actor);

  return query
    select
      p.id,
      p.name,
      p.account_id,
      p.created_by,
      p.created_at,
      (select count(*) from public.seo_project_members m where m.project_id = p.id)::bigint
    from public.seo_projects p
    order by p.created_at desc;
end;
$$;

-- ----------------------------------------------------------------------------
-- Recent jobs (read-only, safe fields only). Job payloads/error blobs are not
-- returned so nothing sensitive can leak through the operator view.
-- ----------------------------------------------------------------------------

create or replace function public.seo_platform_admin_jobs(p_actor uuid, p_limit integer default 20)
returns table (
  job_id       uuid,
  project_id   uuid,
  project_name text,
  provider     text,
  job_type     text,
  status       text,
  queued_at    timestamptz,
  started_at   timestamptz,
  completed_at timestamptz,
  message      text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer;
begin
  perform public.seo_assert_platform_admin(p_actor);
  v_limit := least(greatest(coalesce(p_limit, 20), 1), 100);

  return query
    select
      j.id,
      j.project_id,
      p.name,
      j.provider,
      j.job_type,
      j.status,
      j.queued_at,
      j.started_at,
      j.completed_at,
      j.message
    from public.seo_sync_jobs j
    left join public.seo_projects p on p.id = j.project_id
    order by j.queued_at desc
    limit v_limit;
end;
$$;

-- ----------------------------------------------------------------------------
-- Cross-account usage totals. Same aggregate shape as seo_usage_totals, but the
-- scope is every account (platform administrators intentionally have
-- cross-account visibility) and the guard is platform admin rather than
-- membership. Reads the existing append-only ledger; adds no accounting.
-- ----------------------------------------------------------------------------

create or replace function public.seo_platform_admin_usage_totals(
  p_actor     uuid,
  p_account   uuid default null,
  p_project   uuid default null,
  p_from      timestamptz default null,
  p_to        timestamptz default null,
  p_category  text default null,
  p_provider  text default null,
  p_operation text default null,
  p_unit      text default null,
  p_success   boolean default null
)
returns table (
  category    text,
  provider    text,
  operation   text,
  unit        text,
  quantity    bigint,
  event_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.seo_assert_platform_admin(p_actor);

  return query
    select e.category, e.provider, e.operation, e.unit,
           coalesce(sum(e.quantity), 0)::bigint as quantity,
           count(*)::bigint as event_count
    from public.seo_usage_events e
    where (p_account is null or e.account_id = p_account)
      and (p_project is null or e.project_id = p_project)
      and (p_from is null or e.occurred_at >= p_from)
      and (p_to is null or e.occurred_at < p_to)
      and (p_category is null or e.category = p_category)
      and (p_provider is null or e.provider = p_provider)
      and (p_operation is null or e.operation = p_operation)
      and (p_unit is null or e.unit = p_unit)
      and (p_success is null or e.success = p_success)
    group by e.category, e.provider, e.operation, e.unit
    order by e.category, e.provider, e.operation, e.unit;
end;
$$;

-- ----------------------------------------------------------------------------
-- Lock these RPCs down to the service role: the API is the only caller and it
-- has already verified the actor's session.
-- ----------------------------------------------------------------------------

revoke execute on function public.seo_platform_admin_overview(uuid) from public, anon, authenticated;
revoke execute on function public.seo_platform_admin_users(uuid) from public, anon, authenticated;
revoke execute on function public.seo_platform_admin_accounts(uuid) from public, anon, authenticated;
revoke execute on function public.seo_platform_admin_projects(uuid) from public, anon, authenticated;
revoke execute on function public.seo_platform_admin_jobs(uuid, integer) from public, anon, authenticated;
revoke execute on function public.seo_platform_admin_usage_totals(
  uuid, uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean
) from public, anon, authenticated;

grant execute on function public.seo_platform_admin_overview(uuid) to service_role;
grant execute on function public.seo_platform_admin_users(uuid) to service_role;
grant execute on function public.seo_platform_admin_accounts(uuid) to service_role;
grant execute on function public.seo_platform_admin_projects(uuid) to service_role;
grant execute on function public.seo_platform_admin_jobs(uuid, integer) to service_role;
grant execute on function public.seo_platform_admin_usage_totals(
  uuid, uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean
) to service_role;
