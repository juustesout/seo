-- ============================================================================
-- SEO Platform - entitlement & resource-allowance foundation (P13)
--
-- P9/P11 provide *technical* resource protection: conservative ceilings that
-- keep expensive, server-funded work bounded and attributable, and that apply
-- to every authenticated user regardless of plan. P13 adds the first
-- *product-policy* layer above them:
--
--     technical protection
--         -> P9/P11 technical ceiling        (unchanged, plan-unaware)
--         -> product entitlement / allowance  (this migration)
--         -> actual usage                      (seo_usage_events, unchanged)
--         -> period accounting                 (derived, never stored)
--
-- The effective product limit is:
--
--     effective = min(technical_ceiling, plan_allowance)
--
-- A plan can only ever LOWER the technical ceiling, never raise it. P9/P11 are
-- intentionally untouched and remain usable without any entitlement data.
--
-- This is NOT billing: there are no prices, credits, wallets, invoices or
-- payment tables. Cost remains a future derivation from usage facts + pricing.
-- See docs/p13-entitlement-foundation.md.
--
-- Entities:
--   seo_plans                 named plan (policy baseline)
--   seo_plan_features         plan -> feature on/off
--   seo_resource_policies     plan -> operator-funded resource allowance
--   seo_account_entitlements  account -> plan binding (effective dates)
--   seo_entitlement_reservations  transient in-flight allowance holds
-- ============================================================================

-- ----------------------------------------------------------------------------
-- seo_plans
-- ----------------------------------------------------------------------------
create table public.seo_plans (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  name        text not null,
  description text,
  is_default  boolean not null default false,
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint seo_plans_key_format check (key ~ '^[a-z0-9_]{1,40}$'),
  constraint seo_plans_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint seo_plans_status_check check (status in ('active', 'disabled'))
);

-- At most one default plan may be active at a time (partial unique index).
create unique index seo_plans_default_idx on public.seo_plans (is_default) where is_default;

create trigger seo_plans_touch_updated_at
  before update on public.seo_plans
  for each row execute function public.seo_touch_updated_at();

comment on table public.seo_plans is
  'P13 product plan. Policy only: no prices, billing or credits. The default plan preserves the full product for every authenticated user.';

-- ----------------------------------------------------------------------------
-- seo_plan_features - boolean feature entitlements
-- ----------------------------------------------------------------------------
create table public.seo_plan_features (
  plan_id uuid not null references public.seo_plans (id) on delete cascade,
  feature text not null,
  enabled boolean not null default true,
  primary key (plan_id, feature),
  constraint seo_plan_features_feature_check check (
    feature in ('api_access', 'mcp_access', 'ai_editing', 'publishing', 'designer', 'composer')
  )
);

comment on table public.seo_plan_features is
  'P13 feature entitlements (P12 section 4.5/4.9). Adding a feature is a reviewed code change, not a data-only change.';

-- ----------------------------------------------------------------------------
-- seo_resource_policies - operator-funded resource allowances
--
-- `allowance is null` means "no product cap": the technical P9/P11 ceiling is
-- the only limit. `0` means the resource is not included. The resource key is
-- intentionally open (format-checked, not enumerated) so future plans need no
-- schema change; the application validates it against the closed
-- ENTITLEMENT_RESOURCES vocabulary when resolving.
-- ----------------------------------------------------------------------------
create table public.seo_resource_policies (
  id              uuid primary key default gen_random_uuid(),
  plan_id         uuid not null references public.seo_plans (id) on delete cascade,
  resource        text not null,
  unit            text not null,
  period          text not null default 'month',
  scope           text not null default 'account',
  operator_funded boolean not null default true,
  byok_exempt     boolean not null default true,
  status          text not null default 'active',
  allowance       integer,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint seo_resource_policies_unique unique (plan_id, resource),
  constraint seo_resource_policies_resource_format check (resource ~ '^[a-z0-9_]{1,40}$'),
  constraint seo_resource_policies_unit_format check (unit ~ '^[a-z0-9_]{1,32}$'),
  constraint seo_resource_policies_period_check check (period in ('day', 'week', 'month', 'year', 'none')),
  constraint seo_resource_policies_scope_check check (scope in ('account', 'project')),
  constraint seo_resource_policies_status_check check (status in ('active', 'disabled')),
  constraint seo_resource_policies_allowance_check check (allowance is null or allowance >= 0)
);

create index seo_resource_policies_plan_idx on public.seo_resource_policies (plan_id);

create trigger seo_resource_policies_touch_updated_at
  before update on public.seo_resource_policies
  for each row execute function public.seo_touch_updated_at();

comment on column public.seo_resource_policies.allowance is
  'P13 product allowance for the period. NULL = no product cap (technical ceiling only).';

-- ----------------------------------------------------------------------------
-- seo_account_entitlements - account -> plan binding (versioned by effective
-- window). Only one active row per account (effective_to is null). Historical
-- rows are kept so a plan change never rewrites the past.
-- ----------------------------------------------------------------------------
create table public.seo_account_entitlements (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references public.seo_accounts (id) on delete cascade,
  plan_id        uuid not null references public.seo_plans (id),
  effective_from timestamptz not null default now(),
  effective_to   timestamptz,
  assigned_by    uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint seo_account_entitlements_window check (effective_to is null or effective_to > effective_from)
);

create unique index seo_account_entitlements_active_idx
  on public.seo_account_entitlements (account_id) where effective_to is null;
create index seo_account_entitlements_account_idx
  on public.seo_account_entitlements (account_id, effective_from desc);

comment on table public.seo_account_entitlements is
  'P13 account plan binding. Append-only history; the active row (effective_to null) is the current plan.';

-- ----------------------------------------------------------------------------
-- seo_entitlement_reservations - transient holds on an allowance.
--
-- The row *is* a pending consumption: it counts while unreleased and unexpired,
-- and is released once the operation finishes and its usage fact exists. It is
-- operational evidence, never a billing ledger; the append-only
-- seo_usage_events remains the single source of usage facts. A TTL bounds a
-- leaked reservation from a crashed process.
-- ----------------------------------------------------------------------------
create table public.seo_entitlement_reservations (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.seo_accounts (id) on delete cascade,
  project_id   uuid references public.seo_projects (id) on delete set null,
  user_id      uuid references auth.users (id) on delete set null,
  resource     text not null,
  amount       integer not null default 1,
  period_start timestamptz not null,
  period_end   timestamptz not null,
  acquired_at  timestamptz not null default now(),
  expires_at   timestamptz not null,
  released_at  timestamptz,
  constraint seo_entitlement_reservations_resource_format check (resource ~ '^[a-z0-9_]{1,40}$'),
  constraint seo_entitlement_reservations_amount_check check (amount >= 1),
  constraint seo_entitlement_reservations_window check (period_end > period_start)
);

create index seo_entitlement_reservations_active_idx
  on public.seo_entitlement_reservations (account_id, resource)
  where released_at is null;
create index seo_entitlement_reservations_account_idx
  on public.seo_entitlement_reservations (account_id, acquired_at desc);

comment on table public.seo_entitlement_reservations is
  'P13 in-flight allowance holds. Counted while released_at is null and expires_at > now(); never a billing record.';

-- ----------------------------------------------------------------------------
-- Default plan seed.
--
-- The default plan preserves the full product: every feature is enabled and
-- operator-funded allowances are uncapped (null) EXCEPT X link posts, which
-- carry a real per-post operator cost and must not be given away unlimited by
-- default (P13 section 5). The finite X value is a product-policy placeholder,
-- not a price.
-- ----------------------------------------------------------------------------
insert into public.seo_plans (key, name, description, is_default)
values ('base', 'Base', 'Default plan: full product, technical protection only, no included X link posts.', true)
on conflict (key) do nothing;

insert into public.seo_plan_features (plan_id, feature, enabled)
select p.id, f.feature, true
from public.seo_plans p
cross join (values ('api_access'), ('mcp_access'), ('ai_editing'), ('publishing'), ('designer'), ('composer')) as f(feature)
where p.key = 'base'
on conflict (plan_id, feature) do nothing;

insert into public.seo_resource_policies
  (plan_id, resource, unit, period, scope, operator_funded, byok_exempt, allowance)
select p.id, v.resource, v.unit, 'month', 'account', v.operator_funded, v.byok_exempt, v.allowance
from public.seo_plans p
cross join (values
  ('ai_generation',       'tokens',      true,  true,  null::integer),
  ('ai_image',            'images',      true,  true,  null),
  ('dataforseo_research', 'requests',    true,  true,  null),
  ('media',               'assets',      true,  false, null),
  ('x_link_post',         'link_posts',  true,  false, 0)
) as v(resource, unit, operator_funded, byok_exempt, allowance)
where p.key = 'base'
on conflict (plan_id, resource) do nothing;

-- Attach every existing account to the default plan, and keep new accounts
-- attached automatically so an account always resolves a plan.
insert into public.seo_account_entitlements (account_id, plan_id)
select a.id, p.id
from public.seo_accounts a
cross join public.seo_plans p
where p.key = 'base'
on conflict do nothing;

create or replace function public.seo_assign_default_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan uuid;
begin
  select id into v_plan from public.seo_plans where is_default limit 1;
  if v_plan is not null then
    insert into public.seo_account_entitlements (account_id, plan_id)
    values (new.id, v_plan)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists seo_accounts_assign_default_plan on public.seo_accounts;
create trigger seo_accounts_assign_default_plan
  after insert on public.seo_accounts
  for each row execute function public.seo_assign_default_plan();

-- ----------------------------------------------------------------------------
-- seo_entitlement_consumed - operator-funded consumption in a period.
--
-- The single SQL definition of "how much of this resource has been consumed in
-- this window", used both by admission (atomic) and the read model, so the two
-- can never disagree. Counts only successful operator-funded facts from the one
-- append-only ledger; the ledger mapping is passed in from the contract source
-- of truth. Not exposed to browser roles.
-- ----------------------------------------------------------------------------
create or replace function public.seo_entitlement_consumed(
  p_account_id  uuid,
  p_category    text,
  p_units       text[],
  p_x_link_only boolean,
  p_from        timestamptz,
  p_to          timestamptz
)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(e.quantity), 0)::bigint
  from public.seo_usage_events e
  where e.account_id = p_account_id
    and e.category = p_category
    and e.success
    and e.funding_source = 'operator_funded'
    and e.occurred_at >= p_from
    and e.occurred_at < p_to
    and (p_units is null or cardinality(p_units) = 0 or e.unit = any (p_units))
    and (not p_x_link_only or (e.provider = 'x' and e.metadata ->> 'hasLink' = 'true'));
$$;

revoke execute on function public.seo_entitlement_consumed(uuid, text, text[], boolean, timestamptz, timestamptz) from public;
grant execute on function public.seo_entitlement_consumed(uuid, text, text[], boolean, timestamptz, timestamptz) to service_role;

-- ----------------------------------------------------------------------------
-- seo_admit_entitlement - atomic product-allowance admission.
--
-- Evaluated only when a plan actually applies a finite allowance; when there is
-- no policy (or allowance is null) the application never calls this and P9/P11
-- remain the only limit.
--
-- Consumption = operator-funded usage facts in the period (one SQL definition,
-- seo_entitlement_consumed) + active entitlement reservations for the same
-- account/resource and period (in-flight holds whose usage fact does not exist
-- yet). Both are summed under a per-account+resource advisory lock so
-- concurrent requests cannot oversubscribe the allowance and no negative/double
-- consumption is possible.
--
-- Raises SE004 with message `seo_entitlement_limit` on denial, a code distinct
-- from the transient P9/P11 codes so the UI can present it as persistent.
-- ----------------------------------------------------------------------------
create or replace function public.seo_admit_entitlement(
  p_account_id   uuid,
  p_project_id   uuid,
  p_user_id      uuid,
  p_resource     text,
  p_category     text,
  p_units        text[],
  p_x_link_only  boolean,
  p_amount       integer,
  p_period_start timestamptz,
  p_period_end   timestamptz,
  p_allowance    integer,
  p_ttl_seconds  integer default 900
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount    integer := greatest(coalesce(p_amount, 1), 1);
  v_ttl       integer := greatest(coalesce(p_ttl_seconds, 900), 1);
  v_consumed  bigint := 0;
  v_held      bigint := 0;
  v_id        uuid;
begin
  if p_account_id is null or p_resource is null or p_resource !~ '^[a-z0-9_]{1,40}$' then
    raise exception 'seo_entitlement_invalid' using errcode = 'SE004',
      detail = json_build_object('resource', coalesce(p_resource, 'unknown'))::text;
  end if;
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    raise exception 'seo_entitlement_invalid' using errcode = 'SE004',
      detail = json_build_object('resource', p_resource)::text;
  end if;

  -- Serialize per account + resource: the same key for every concurrent
  -- admission of this allowance, so the read-then-reserve is atomic.
  perform pg_advisory_xact_lock(hashtext('seo:entitlement:' || p_account_id::text || ':' || p_resource));

  select public.seo_entitlement_consumed(
    p_account_id, p_category, p_units, p_x_link_only, p_period_start, p_period_end
  ) into v_consumed;

  select coalesce(sum(r.amount), 0) into v_held
  from public.seo_entitlement_reservations r
  where r.account_id = p_account_id
    and r.resource = p_resource
    and r.period_start = p_period_start
    and r.released_at is null
    and r.expires_at > now();

  if p_allowance is not null and v_consumed + v_held + v_amount > p_allowance then
    raise exception 'seo_entitlement_limit' using errcode = 'SE004',
      detail = json_build_object('resource', p_resource, 'scope', 'account')::text;
  end if;

  insert into public.seo_entitlement_reservations
    (account_id, project_id, user_id, resource, amount, period_start, period_end, expires_at)
  values
    (p_account_id, p_project_id, p_user_id, p_resource, v_amount, p_period_start, p_period_end,
     now() + make_interval(secs => v_ttl))
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.seo_release_entitlement(p_reservation_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.seo_entitlement_reservations
     set released_at = now()
   where id = p_reservation_id and released_at is null;
$$;

revoke execute on function public.seo_admit_entitlement(
  uuid, uuid, uuid, text, text, text[], boolean, integer, timestamptz, timestamptz, integer, integer
) from public;
revoke execute on function public.seo_release_entitlement(uuid) from public;
grant execute on function public.seo_admit_entitlement(
  uuid, uuid, uuid, text, text, text[], boolean, integer, timestamptz, timestamptz, integer, integer
) to service_role;
grant execute on function public.seo_release_entitlement(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- RLS.
--
-- Policy tables are managed by the operator and read only through the API's
-- entitlement read model: deny-all to browser/PostgREST, service-role only
-- (no insert/update/delete policy anywhere, so no browser path can change
-- commercial policy or a user's own allowance). The account's relevant policy
-- tables are exposed as a DTO by the API, never as raw rows.
--
-- The account binding is additionally readable by its owner so account
-- isolation is explicit and testable.
-- ----------------------------------------------------------------------------
alter table public.seo_plans enable row level security;
alter table public.seo_plan_features enable row level security;
alter table public.seo_resource_policies enable row level security;
alter table public.seo_entitlement_reservations enable row level security;
alter table public.seo_account_entitlements enable row level security;

drop policy if exists seo_account_entitlements_select on public.seo_account_entitlements;
create policy seo_account_entitlements_select on public.seo_account_entitlements
  for select using (account_id = public.seo_account_id_for_user(auth.uid()));

-- ----------------------------------------------------------------------------
-- Extend the usage read aggregate with a funding-source filter (P13 section 7).
--
-- Purely additive: the parameter defaults to null (all funding), and the
-- returned columns are unchanged, so existing callers keep their exact
-- behaviour. The explicit parameter list changes, so the function is recreated
-- and its execute grant re-issued.
-- ----------------------------------------------------------------------------
drop function if exists public.seo_usage_totals(
  uuid, uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean
);

create or replace function public.seo_usage_totals(
  p_user           uuid,
  p_project        uuid default null,
  p_account        uuid default null,
  p_from           timestamptz default null,
  p_to             timestamptz default null,
  p_category       text default null,
  p_provider       text default null,
  p_operation      text default null,
  p_unit           text default null,
  p_success        boolean default null,
  p_funding_source text default null
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
security definer
set search_path = ''
as $$
begin
  if p_user is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_project is null and p_account is null then
    raise exception 'A project or account scope is required' using errcode = '22023';
  end if;
  if p_project is not null and not public.seo_is_member(p_project, p_user) then
    raise exception 'Not a member of this project' using errcode = '42501';
  end if;
  if p_account is not null and p_account is distinct from public.seo_account_id_for_user(p_user) then
    raise exception 'Not the owner of this account' using errcode = '42501';
  end if;

  return query
    select e.category, e.provider, e.operation, e.unit,
           coalesce(sum(e.quantity), 0)::bigint as quantity,
           count(*)::bigint as event_count
    from public.seo_usage_events e
    where (p_project is null or e.project_id = p_project)
      and (p_account is null or e.account_id = p_account)
      and (p_from is null or e.occurred_at >= p_from)
      and (p_to is null or e.occurred_at < p_to)
      and (p_category is null or e.category = p_category)
      and (p_provider is null or e.provider = p_provider)
      and (p_operation is null or e.operation = p_operation)
      and (p_unit is null or e.unit = p_unit)
      and (p_success is null or e.success = p_success)
      and (p_funding_source is null or e.funding_source = p_funding_source)
    group by e.category, e.provider, e.operation, e.unit
    order by e.category, e.provider, e.operation, e.unit;
end;
$$;

revoke execute on function public.seo_usage_totals(
  uuid, uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean, text
) from public;
grant execute on function public.seo_usage_totals(
  uuid, uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean, text
) to service_role;

-- ----------------------------------------------------------------------------
-- Platform-admin plan read/manage (P13 section 8).
--
-- The operator manages plan bindings; this is a policy surface, not billing.
-- Both functions re-verify the actor with seo_assert_platform_admin (defense in
-- depth behind the API gate) and are service-role only, so no browser role can
-- read cross-account policy or reassign a plan.
-- ----------------------------------------------------------------------------

create or replace function public.seo_platform_admin_plans(p_actor uuid)
returns table (
  key             text,
  name            text,
  description     text,
  is_default      boolean,
  status          text,
  features        text[],
  allowance_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.seo_assert_platform_admin(p_actor);

  return query
    select p.key,
           p.name,
           p.description,
           p.is_default,
           p.status,
           coalesce(
             array_agg(f.feature order by f.feature) filter (where f.enabled),
             '{}'
           )::text[] as features,
           (select count(*) from public.seo_resource_policies rp where rp.plan_id = p.id)::bigint
    from public.seo_plans p
    left join public.seo_plan_features f on f.plan_id = p.id
    group by p.id, p.key, p.name, p.description, p.is_default, p.status
    order by p.is_default desc, p.key;
end;
$$;

-- Move an account onto a plan. The current binding is closed (effective_to) and
-- a new binding is appended, so history is preserved and enforcement is atomic.
-- Idempotent when the account already holds the requested active plan.
create or replace function public.seo_platform_admin_assign_plan(
  p_actor   uuid,
  p_account uuid,
  p_plan    uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current uuid;
  v_id      uuid;
begin
  perform public.seo_assert_platform_admin(p_actor);

  if p_account is null or p_plan is null then
    raise exception 'An account and plan are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.seo_plans where id = p_plan and status = 'active') then
    raise exception 'Unknown or inactive plan' using errcode = '22023';
  end if;

  select plan_id into v_current
  from public.seo_account_entitlements
  where account_id = p_account and effective_to is null
  for update;

  if v_current = p_plan then
    select id into v_id
    from public.seo_account_entitlements
    where account_id = p_account and effective_to is null;
    return v_id;
  end if;

  update public.seo_account_entitlements
     set effective_to = now()
   where account_id = p_account and effective_to is null;

  insert into public.seo_account_entitlements (account_id, plan_id, assigned_by)
  values (p_account, p_plan, p_actor)
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.seo_platform_admin_plans(uuid) from public, anon, authenticated;
revoke execute on function public.seo_platform_admin_assign_plan(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.seo_platform_admin_plans(uuid) to service_role;
grant execute on function public.seo_platform_admin_assign_plan(uuid, uuid, uuid) to service_role;
