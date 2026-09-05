-- ============================================================================
-- SEO Platform - Property registry split (Stage 3)
--
-- A Google property is no longer a project-owned mirror. seo_gsc_properties
-- becomes the account-level registry of Google Search Console properties the
-- account can see/use; the optional project <-> property relationship moves to
-- the new seo_project_properties table (project_id, property_id, is_primary),
-- leaving room for a project to use several properties later.
--
--   seo_accounts -> seo_gsc_properties (registry)
--   seo_projects -> seo_project_properties -> seo_gsc_properties (optional link)
--
-- The GSC metric tables (queries/pages/performance) are untouched: they keep
-- their project_id (RLS scoping) and point at the registry property via
-- property_id. The property registry itself no longer carries project_id or
-- data_source_id.
--
-- No data is dropped: existing per-project property rows are first moved up to
-- account scope (account_id backfill), linked into seo_project_properties, and
-- only then are the redundant project-scoped columns removed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Bring the registry to account scope
-- ----------------------------------------------------------------------------

alter table public.seo_gsc_properties
  add column account_id uuid references public.seo_accounts (id) on delete cascade;

update public.seo_gsc_properties gp
set account_id = i.account_id
from public.seo_integrations i
where i.id = gp.integration_id
  and gp.account_id is null;

update public.seo_gsc_properties gp
set account_id = p.account_id
from public.seo_projects p
where p.id = gp.project_id
  and gp.account_id is null;

do $$
declare
  v_orphans int;
  v_dups    int;
begin
  select count(*) into v_orphans from public.seo_gsc_properties where account_id is null;
  if v_orphans > 0 then
    raise exception 'property registry: % row(s) could not be attributed to an account', v_orphans;
  end if;

  select count(*) into v_dups
  from (
    select account_id, site_url
    from public.seo_gsc_properties
    group by account_id, site_url
    having count(*) > 1
  ) d;
  if v_dups > 0 then
    raise exception 'property registry: % duplicate site(s) within one account require manual consolidation before the registry can be unique', v_dups;
  end if;
end $$;

alter table public.seo_gsc_properties
  alter column account_id set not null;

-- ----------------------------------------------------------------------------
-- 2. Project <-> property relationship table
-- ----------------------------------------------------------------------------

create table public.seo_project_properties (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.seo_projects (id) on delete cascade,
  property_id uuid not null references public.seo_gsc_properties (id) on delete cascade,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- A registry property links to at most one project (GSC sites are
  -- domain-scoped; projects are distinct workspaces).
  constraint seo_project_properties_property_key unique (property_id),
  constraint seo_project_properties_link_key unique (project_id, property_id)
);

comment on table public.seo_project_properties is
  'Optional link between a project workspace and an account GSC property. is_primary marks the project''s dashboard property when several are attached.';

create index seo_project_properties_project_idx on public.seo_project_properties (project_id);

create trigger seo_project_properties_touch_updated_at
  before update on public.seo_project_properties
  for each row execute function public.seo_touch_updated_at();

-- ----------------------------------------------------------------------------
-- 3. Backfill links from existing project-scoped property rows, then drop the
--    legacy project-scoped columns and switch to account-scoped uniqueness.
-- ----------------------------------------------------------------------------

insert into public.seo_project_properties (project_id, property_id, is_primary)
select project_id, id, true
from public.seo_gsc_properties;

drop policy if exists seo_gsc_properties_select on public.seo_gsc_properties;

alter table public.seo_gsc_properties
  drop column project_id,
  drop column data_source_id;

alter table public.seo_gsc_properties
  add constraint seo_gsc_properties_account_site_key unique (account_id, site_url);

comment on table public.seo_gsc_properties is
  'Account-level registry of Google Search Console properties. A project links one via seo_project_properties; metrics stay project-scoped.';

-- ----------------------------------------------------------------------------
-- 4. RLS: account owner (or a member of a linked project) can read registry
--    properties; links are readable by members of the project. Writes stay
--    server-side (service role) as before.
-- ----------------------------------------------------------------------------

create policy seo_gsc_properties_account_select on public.seo_gsc_properties
  for select using (
    account_id = public.seo_account_id_for_user(auth.uid())
    or exists (
      select 1 from public.seo_project_properties l
      where l.property_id = public.seo_gsc_properties.id
        and public.seo_is_member(l.project_id, auth.uid())
    )
  );

alter table public.seo_project_properties enable row level security;

drop policy if exists seo_project_properties_select on public.seo_project_properties;
create policy seo_project_properties_select on public.seo_project_properties
  for select using (public.seo_is_member(project_id, auth.uid()));
