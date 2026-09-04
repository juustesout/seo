-- ============================================================================
-- SEO Platform - Row Level Security, security-definer helpers, project
-- membership triggers, audit-log triggers and member management RPCs.
--
-- Model: Supabase Auth owns identity. Tenancy is project-centric. Every
-- project-scoped table has a project_id and is guarded by an RLS policy that
-- checks the caller is a member of that project (helper functions are
-- SECURITY DEFINER but only ever answer "is this user a member/role"). The API
-- server re-checks membership before every project-scoped operation as a second
-- line of defense; RLS still protects direct PostgREST access.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Membership helpers
-- ----------------------------------------------------------------------------

create or replace function public.seo_is_member(p_project uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.seo_project_members m
    where m.project_id = p_project and m.user_id = p_user
  );
$$;

create or replace function public.seo_has_role(p_project uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.seo_project_members m
    where m.project_id = p_project
      and m.user_id = auth.uid()
      and m.role = any(p_roles)
  );
$$;

-- ----------------------------------------------------------------------------
-- Auto-owner membership on project creation
-- ----------------------------------------------------------------------------

create or replace function public.seo_project_add_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.seo_project_members (project_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict (project_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists seo_projects_add_owner on public.seo_projects;
create trigger seo_projects_add_owner
  after insert on public.seo_projects
  for each row execute function public.seo_project_add_owner_membership();

-- ----------------------------------------------------------------------------
-- Audit log trigger (append-only activity trail)
-- ----------------------------------------------------------------------------

create or replace function public.seo_write_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_project uuid;
  v_meta jsonb := '{}'::jsonb;
  v_exclude text[] := array[
    'id', 'project_id', 'created_at', 'updated_at',
    'created_by', 'updated_by',
    'body', 'content', 'excerpt', 'description', 'meta', 'seo_meta', 'keywords',
    'config', 'settings', 'payload', 'result', 'error', 'detail', 'recommendation',
    'ciphertext', 'iv', 'auth_tag'
  ];
  v_key text;
  v_val text;
begin
  -- Resolve the owning project id. Only seo_projects lacks a project_id column
  -- (its own id is the project id). Attribute presence is inspected through
  -- jsonb so this single function works across differently-shaped trigger rows.
  v_project := coalesce(
    case when to_jsonb(new) ? 'project_id' then (to_jsonb(new) ->> 'project_id')::uuid end,
    new.id,
    old.id
  );

  if tg_op = 'DELETE' then
    if tg_table_name = 'seo_sync_jobs' then
      return old;
    end if;
    insert into public.seo_audit_logs (project_id, user_id, action, entity_type, entity_id, meta)
    values (v_project, auth.uid(), 'delete', tg_table_name, old.id::text, '{}'::jsonb);
    return old;
  end if;

  -- Jobs: only record meaningful terminal transitions (activity feed, low noise).
  if tg_table_name = 'seo_sync_jobs' then
    if (new.status not in ('completed', 'failed', 'canceled')) or (new.status = old.status) then
      return new;
    end if;
    insert into public.seo_audit_logs (project_id, user_id, action, entity_type, entity_id, meta)
    values (
      v_project,
      auth.uid(),
      new.status,
      'job',
      new.id::text,
      jsonb_build_object(
        'job_type', new.job_type,
        'provider', new.provider,
        'progress', new.progress,
        'retry_count', new.retry_count,
        'message', new.message
      )
    );
    return new;
  end if;

  if tg_op = 'UPDATE' and to_jsonb(old) = to_jsonb(new) then
    return new;
  end if;

  v_action := case tg_op when 'INSERT' then 'create' else 'update' end;
  v_meta := to_jsonb(new);

  for v_key in select jsonb_object_keys(v_meta) loop
    if v_key = any(v_exclude) then
      v_meta := v_meta - v_key;
    else
      if jsonb_typeof(v_meta -> v_key) = 'string' then
        v_val := v_meta ->> v_key;
        if length(v_val) > 200 then
          v_meta := jsonb_set(v_meta, array[v_key], to_jsonb(left(v_val, 200)));
        end if;
      end if;
    end if;
  end loop;

  insert into public.seo_audit_logs (project_id, user_id, action, entity_type, entity_id, meta)
  values (v_project, auth.uid(), v_action, tg_table_name, new.id::text, v_meta);
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- Enable RLS everywhere
-- ----------------------------------------------------------------------------

alter table public.seo_projects            enable row level security;
alter table public.seo_project_members     enable row level security;
alter table public.seo_domains             enable row level security;
alter table public.seo_integrations        enable row level security;
alter table public.seo_credentials         enable row level security;
alter table public.seo_data_sources        enable row level security;
alter table public.seo_keywords            enable row level security;
alter table public.seo_pages               enable row level security;
alter table public.seo_rankings            enable row level security;
alter table public.seo_serp_results        enable row level security;
alter table public.seo_audits              enable row level security;
alter table public.seo_content             enable row level security;
alter table public.seo_gsc_properties      enable row level security;
alter table public.seo_gsc_queries         enable row level security;
alter table public.seo_gsc_pages           enable row level security;
alter table public.seo_gsc_performance     enable row level security;
alter table public.seo_sync_jobs           enable row level security;
alter table public.seo_publishers          enable row level security;
alter table public.seo_publications        enable row level security;
alter table public.seo_audit_logs          enable row level security;

-- ----------------------------------------------------------------------------
-- seo_projects
-- ----------------------------------------------------------------------------

drop policy if exists seo_projects_select on public.seo_projects;
create policy seo_projects_select on public.seo_projects
  for select using (created_by = auth.uid() or public.seo_is_member(id, auth.uid()));

drop policy if exists seo_projects_insert on public.seo_projects;
create policy seo_projects_insert on public.seo_projects
  for insert with check (created_by = auth.uid());

drop policy if exists seo_projects_update on public.seo_projects;
create policy seo_projects_update on public.seo_projects
  for update using (created_by = auth.uid() or public.seo_has_role(id, array['owner', 'admin']))
  with check (created_by = auth.uid() or public.seo_has_role(id, array['owner', 'admin']));

drop policy if exists seo_projects_delete on public.seo_projects;
create policy seo_projects_delete on public.seo_projects
  for delete using (created_by = auth.uid() or public.seo_has_role(id, array['owner']));

-- ----------------------------------------------------------------------------
-- seo_project_members - users see their own membership; the project creator can
-- administer the roster. Other admin actions happen through seo_* RPCs which
-- enforce roles server-side.
-- ----------------------------------------------------------------------------

drop policy if exists seo_project_members_select on public.seo_project_members;
create policy seo_project_members_select on public.seo_project_members
  for select using (
    user_id = auth.uid()
    or exists (
      select 1 from public.seo_projects p
      where p.id = project_id and p.created_by = auth.uid()
    )
  );

-- ----------------------------------------------------------------------------
-- User-content tables: members can read/write, owners/admins can delete.
-- ----------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['seo_domains', 'seo_keywords', 'seo_pages', 'seo_content']
  loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select using (public.seo_is_member(project_id, auth.uid()))', t, t);
    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format('create policy %I_insert on public.%I for insert with check (public.seo_has_role(project_id, array[''owner'', ''admin'', ''editor'']))', t, t);
    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format('create policy %I_update on public.%I for update using (public.seo_has_role(project_id, array[''owner'', ''admin'', ''editor''])) with check (public.seo_has_role(project_id, array[''owner'', ''admin'', ''editor'']))', t, t);
    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format('create policy %I_delete on public.%I for delete using (public.seo_has_role(project_id, array[''owner'', ''admin'']))', t, t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Server-written tables: members may only read. Writes happen through the API
-- server (service role) after a server-side membership/role check, or via the
-- RPCs below. Viewers and editors therefore cannot mutate sync state, queue
-- arbitrary jobs or tamper with publishing rows from the browser.
-- ----------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'seo_integrations', 'seo_data_sources', 'seo_rankings', 'seo_serp_results',
    'seo_audits', 'seo_gsc_properties', 'seo_gsc_queries', 'seo_gsc_pages',
    'seo_gsc_performance', 'seo_sync_jobs', 'seo_publishers', 'seo_publications'
  ]
  loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('create policy %I_select on public.%I for select using (public.seo_is_member(project_id, auth.uid()))', t, t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- seo_credentials - deny everything (no policies).
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- seo_audit_logs - members read their project activity; users see their own.
-- ----------------------------------------------------------------------------

drop policy if exists seo_audit_logs_select on public.seo_audit_logs;
create policy seo_audit_logs_select on public.seo_audit_logs
  for select using (
    (project_id is not null and public.seo_is_member(project_id, auth.uid()))
    or (project_id is null and user_id = auth.uid())
    or user_id = auth.uid()
  );

-- ----------------------------------------------------------------------------
-- Audit triggers (attached to tables worth tracking)
-- ----------------------------------------------------------------------------

create trigger seo_projects_audit
  after insert or update or delete on public.seo_projects
  for each row execute function public.seo_write_audit();
create trigger seo_domains_audit
  after insert or update or delete on public.seo_domains
  for each row execute function public.seo_write_audit();
create trigger seo_keywords_audit
  after insert or update or delete on public.seo_keywords
  for each row execute function public.seo_write_audit();
create trigger seo_content_audit
  after insert or update or delete on public.seo_content
  for each row execute function public.seo_write_audit();
create trigger seo_integrations_audit
  after insert or update or delete on public.seo_integrations
  for each row execute function public.seo_write_audit();
create trigger seo_data_sources_audit
  after insert or update or delete on public.seo_data_sources
  for each row execute function public.seo_write_audit();
create trigger seo_publishers_audit
  after insert or update or delete on public.seo_publishers
  for each row execute function public.seo_write_audit();
create trigger seo_publications_audit
  after insert or update or delete on public.seo_publications
  for each row execute function public.seo_write_audit();
create trigger seo_sync_jobs_audit
  after insert or update or delete on public.seo_sync_jobs
  for each row execute function public.seo_write_audit();

-- ----------------------------------------------------------------------------
-- Member management RPCs (enforce roles inside the function)
-- ----------------------------------------------------------------------------

create or replace function public.seo_create_project(
  p_name text,
  p_slug text default null,
  p_website_url text default null,
  p_description text default null
)
returns public.seo_projects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project public.seo_projects;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  insert into public.seo_projects (name, slug, website_url, description, created_by)
  values (p_name, p_slug, p_website_url, p_description, auth.uid())
  returning * into v_project;

  return v_project;
end;
$$;

create or replace function public.seo_list_project_members(p_project uuid)
returns table (user_id uuid, email text, role text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (public.seo_has_role(p_project, array['owner', 'admin'])) then
    raise exception 'Only project owners and admins can view the member list' using errcode = '42501';
  end if;
  return query
    select m.user_id, u.email::text, m.role, m.created_at
    from public.seo_project_members m
    left join auth.users u on u.id = m.user_id
    where m.project_id = p_project
    order by m.created_at asc;
end;
$$;

create or replace function public.seo_add_project_member(
  p_project uuid,
  p_email text,
  p_role text default 'editor'
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_is_owner boolean;
  v_role text;
begin
  v_role := lower(p_role);
  if v_role not in ('owner', 'admin', 'editor', 'viewer') then
    raise exception 'Invalid role %', p_role using errcode = 'P0001';
  end if;

  if not public.seo_has_role(p_project, array['owner', 'admin']) then
    raise exception 'Only project owners and admins can invite members' using errcode = '42501';
  end if;

  v_is_owner := public.seo_has_role(p_project, array['owner']);
  if (not v_is_owner) and v_role in ('owner', 'admin') then
    raise exception 'Only an owner can grant the owner or admin role' using errcode = '42501';
  end if;

  select id into v_user from auth.users where lower(email) = lower(p_email) limit 1;
  if v_user is null then
    raise exception 'No user with that email address exists yet' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.seo_project_members m where m.project_id = p_project and m.user_id = v_user) then
    raise exception 'User is already a member of this project' using errcode = 'P0001';
  end if;

  insert into public.seo_project_members (project_id, user_id, role)
  values (p_project, v_user, v_role);

  return 'Member added';
end;
$$;

create or replace function public.seo_update_project_member_role(
  p_project uuid,
  p_user uuid,
  p_role text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_is_owner boolean;
  v_owners int;
begin
  v_role := lower(p_role);
  if v_role not in ('owner', 'admin', 'editor', 'viewer') then
    raise exception 'Invalid role %', p_role using errcode = 'P0001';
  end if;

  if not public.seo_has_role(p_project, array['owner']) then
    raise exception 'Only an owner can change member roles' using errcode = '42501';
  end if;

  if not exists (select 1 from public.seo_project_members m where m.project_id = p_project and m.user_id = p_user) then
    raise exception 'User is not a member of this project' using errcode = 'P0001';
  end if;

  if v_role <> 'owner' then
    select count(*) into v_owners
    from public.seo_project_members m
    where m.project_id = p_project and m.role = 'owner';
    if v_owners <= 1 and exists (
      select 1 from public.seo_project_members m
      where m.project_id = p_project and m.user_id = p_user and m.role = 'owner'
    ) then
      raise exception 'A project must keep at least one owner' using errcode = 'P0001';
    end if;
  end if;

  update public.seo_project_members m
  set role = v_role
  where m.project_id = p_project and m.user_id = p_user;

  return 'Role updated';
end;
$$;

create or replace function public.seo_remove_project_member(p_project uuid, p_user uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owners int;
begin
  if not (public.seo_has_role(p_project, array['owner', 'admin'])) then
    raise exception 'Only owners and admins can remove members' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.seo_project_members m
    where m.project_id = p_project and m.user_id = p_user and m.role = 'owner'
  ) then
    if not public.seo_has_role(p_project, array['owner']) then
      raise exception 'Only an owner can remove another owner' using errcode = '42501';
    end if;
    select count(*) into v_owners
    from public.seo_project_members m
    where m.project_id = p_project and m.role = 'owner';
    if v_owners <= 1 then
      raise exception 'A project must keep at least one owner' using errcode = 'P0001';
    end if;
  end if;

  delete from public.seo_project_members m
  where m.project_id = p_project and m.user_id = p_user;

  return 'Member removed';
end;
$$;
