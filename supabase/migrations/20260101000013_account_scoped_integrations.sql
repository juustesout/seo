-- ============================================================================
-- SEO Platform - Account-scoped integrations (Stage 4)
--
-- A Google connection is a property of the *account*, not of a single project:
-- one account authorizes Google once (seo_integrations row with project_id
-- NULL, account_id set) and then attaches any of its Search Console properties
-- to the projects it wants. The legacy project-scoped rows created during the
-- transition are kept untouched (project_id stays populated on them) so the
-- existing worker, data sources and RLS keep working unchanged.
--
-- Changes here are additive / non-destructive:
--   1. seo_integrations.project_id becomes nullable so account-scoped rows can
--      exist without pretending to belong to a project.
--   2. A scoping check guarantees every integration still resolves to a project
--      OR an account (no ownerless rows).
--   3. Account-scoped uniqueness: one *active* connection per provider per
--      account, mirroring the legacy (project_id, provider_type) index but only
--      for rows without a project so legacy rows never collide with it.
--   4. seo_write_audit stops substituting a non-project id for rows that have
--      no project_id (previously an account-scoped insert would write the
--      integration's own id into seo_audit_logs.project_id and violate the FK
--      to seo_projects, rolling the insert back).
-- No rows are dropped and no legacy constraint is removed.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. seo_integrations.project_id becomes nullable
-- ----------------------------------------------------------------------------

alter table public.seo_integrations
  alter column project_id drop not null;

-- Every integration must still resolve to a project OR an account.
alter table public.seo_integrations
  add constraint seo_integrations_scoped_check
  check (project_id is not null or account_id is not null);

-- ----------------------------------------------------------------------------
-- 2. One active account-scoped connection per provider per account
-- ----------------------------------------------------------------------------

create unique index seo_integrations_account_active_provider_key
  on public.seo_integrations (account_id, provider_type)
  where project_id is null and status in ('connected', 'connecting');

-- ----------------------------------------------------------------------------
-- 3. Audit attribution for rows without a project id
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
  -- Resolve the owning project id from the row. Only seo_projects has no
  -- project_id column (its own id is the project id). Rows that are scoped to
  -- an account rather than a project (e.g. account-level integrations) stay
  -- project_id NULL so the FK to seo_projects is never violated; their audit
  -- entry is attributed purely to the acting user.
  if tg_table_name = 'seo_projects' then
    v_project := coalesce(new.id, old.id);
  else
    v_project := coalesce(
      case
        when to_jsonb(new) is not null and (to_jsonb(new) ->> 'project_id') is not null
          then (to_jsonb(new) ->> 'project_id')::uuid
        else null
      end,
      case
        when to_jsonb(old) is not null and (to_jsonb(old) ->> 'project_id') is not null
          then (to_jsonb(old) ->> 'project_id')::uuid
        else null
      end
    );
  end if;

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

comment on table public.seo_integrations is
  'Provider connections. Rows are project-scoped or (for account-level providers like Google Search Console) account-scoped with project_id NULL; active connections are unique per scope and provider.';
