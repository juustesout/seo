-- ============================================================================
-- SEO Platform - Account layer (Stage 1 + 2)
--
-- Introduces the account that will own integrations and Google properties.
-- For now one authenticated user = one account; a shared workspace can be
-- layered on later via a future seo_account_members table (owner_user_id stays
-- unique, so nothing here blocks that).
--
-- Hierarchy becomes: auth.users -> seo_accounts -> seo_projects
--
-- This migration is strictly additive / non-destructive:
--   * creates seo_accounts
--   * adds + backfills seo_projects.account_id
--   * adds + backfills seo_integrations.account_id (ownership moves to the
--     account while project_id is preserved for compatibility)
-- Existing columns, constraints and unique indexes are kept intact so the
-- current application keeps working unchanged during the transition. No rows
-- are dropped and no legacy constraint is removed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- seo_accounts
-- ----------------------------------------------------------------------------

create table public.seo_accounts (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid not null references auth.users (id) on delete cascade,
  name           text not null default 'My workspace',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint seo_accounts_owner_unique unique (owner_user_id),
  constraint seo_accounts_name_length check (char_length(btrim(name)) between 1 and 128)
);

comment on table public.seo_accounts is
  'Account layer: owns integrations and Google properties. One user = one account for now; future seo_account_members can widen this to a shared workspace.';

create index seo_accounts_created_at_idx on public.seo_accounts (created_at desc);

create trigger seo_accounts_touch_updated_at
  before update on public.seo_accounts
  for each row execute function public.seo_touch_updated_at();

-- ----------------------------------------------------------------------------
-- Account helpers (security definer, idempotent)
-- ----------------------------------------------------------------------------

create or replace function public.seo_account_id_for_user(p_user uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id
  from public.seo_accounts
  where owner_user_id = p_user
  limit 1;
$$;

comment on function public.seo_account_id_for_user(uuid) is
  'Returns the account id owned by the given user, or null when the user has no account yet. Used by RLS policies.';

create or replace function public.seo_ensure_account(p_user uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_account uuid;
begin
  if p_user is null then
    return null;
  end if;

  select id into v_account
  from public.seo_accounts
  where owner_user_id = p_user
  limit 1;
  if v_account is not null then
    return v_account;
  end if;

  insert into public.seo_accounts (owner_user_id)
  values (p_user)
  on conflict (owner_user_id) do nothing;

  select id into v_account
  from public.seo_accounts
  where owner_user_id = p_user
  limit 1;
  return v_account;
end;
$$;

comment on function public.seo_ensure_account(uuid) is
  'Creates the account for a user when missing and returns its id. Idempotent and concurrency safe.';

-- ----------------------------------------------------------------------------
-- seo_projects.account_id
-- ----------------------------------------------------------------------------

alter table public.seo_projects
  add column account_id uuid references public.seo_accounts (id) on delete cascade;

create index seo_projects_account_idx on public.seo_projects (account_id);

-- Backfill: one account per distinct project creator.
insert into public.seo_accounts (owner_user_id)
select distinct p.created_by
from public.seo_projects p
where p.created_by is not null
on conflict (owner_user_id) do nothing;

-- Users who only appear as members get an account too, so every auth user in
-- the roster owns an account.
insert into public.seo_accounts (owner_user_id)
select distinct m.user_id
from public.seo_project_members m
where m.user_id is not null
on conflict (owner_user_id) do nothing;

update public.seo_projects p
set account_id = a.id
from public.seo_accounts a
where a.owner_user_id = p.created_by
  and p.account_id is null;

-- Keep every new project attached to its creator's account automatically, so
-- the application does not need to know about accounts to keep working.
create or replace function public.seo_projects_set_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.created_by is not null and new.account_id is null then
    new.account_id := public.seo_ensure_account(new.created_by);
  end if;
  return new;
end;
$$;

drop trigger if exists seo_projects_set_account on public.seo_projects;
create trigger seo_projects_set_account
  before insert on public.seo_projects
  for each row when (new.account_id is null)
  execute function public.seo_projects_set_account();

-- ----------------------------------------------------------------------------
-- seo_integrations.account_id (ownership moves to the account; project_id is
-- preserved and stays NOT NULL for now - relaxing that comes with the property
-- registry stage).
-- ----------------------------------------------------------------------------

alter table public.seo_integrations
  add column account_id uuid references public.seo_accounts (id) on delete cascade;

create index seo_integrations_account_idx on public.seo_integrations (account_id);

update public.seo_integrations i
set account_id = p.account_id
from public.seo_projects p
where p.id = i.project_id
  and i.account_id is null;

-- Keep account_id in sync whenever an integration is inserted under a project,
-- or its project association changes.
create or replace function public.seo_integrations_set_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.project_id is not null then
    select p.account_id into new.account_id
    from public.seo_projects p
    where p.id = new.project_id;
  end if;
  if new.account_id is null and new.created_by is not null then
    new.account_id := public.seo_ensure_account(new.created_by);
  end if;
  return new;
end;
$$;

drop trigger if exists seo_integrations_set_account on public.seo_integrations;
create trigger seo_integrations_set_account
  before insert or update of project_id on public.seo_integrations
  for each row
  execute function public.seo_integrations_set_account();

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------

alter table public.seo_accounts enable row level security;

drop policy if exists seo_accounts_select on public.seo_accounts;
create policy seo_accounts_select on public.seo_accounts
  for select using (owner_user_id = auth.uid());

drop policy if exists seo_accounts_insert on public.seo_accounts;
create policy seo_accounts_insert on public.seo_accounts
  for insert with check (owner_user_id = auth.uid());

drop policy if exists seo_accounts_update on public.seo_accounts;
create policy seo_accounts_update on public.seo_accounts
  for update using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

drop policy if exists seo_accounts_delete on public.seo_accounts;
create policy seo_accounts_delete on public.seo_accounts
  for delete using (owner_user_id = auth.uid());

-- Account-owned integrations remain visible to the account owner in addition
-- to the existing project-member policy (kept untouched above).
drop policy if exists seo_integrations_account_select on public.seo_integrations;
create policy seo_integrations_account_select on public.seo_integrations
  for select using (account_id = public.seo_account_id_for_user(auth.uid()));
