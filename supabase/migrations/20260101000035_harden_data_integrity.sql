-- ============================================================================
-- SEO Platform - data-integrity hardening (audit findings S12-S16).
--
--  * S12: project deletion must succeed and the activity trail must survive.
--    The generic audit AFTER DELETE trigger inserted a seo_audit_logs row
--    pointing at the project being deleted (FK violation), while the audit FK
--    cascaded the history away. The FK becomes ON DELETE SET NULL and the
--    trigger drops the project id once the project no longer exists.
--  * S13: seo_content_media gains project_id plus composite FKs, so a link can
--    only join a content row and a media row that belong to the SAME project.
--  * S15: job idempotency is per project, not global.
--  * S16: seo_usage_totals is revoked from anon/authenticated, not just public.
--  * S14: storage.objects policies bound the authenticated storage API for the
--    public seo-media bucket to a member's own project prefix (skipped where the
--    storage schema is absent, e.g. the plain-Postgres migration harness).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- S12: project deletion + audit trail
-- ----------------------------------------------------------------------------

alter table public.seo_audit_logs
  drop constraint if exists seo_audit_logs_project_id_fkey;
alter table public.seo_audit_logs
  add constraint seo_audit_logs_project_id_fkey
  foreign key (project_id) references public.seo_projects (id) on delete set null;

-- Full replacement of the audit writer. The only change from
-- 20260101000013_account_scoped_integrations.sql is the DELETE branch: when the
-- project the row belonged to has already gone (the row IS the project, or a
-- cascade removed a child after the project), the audit entry is stored with a
-- NULL project_id instead of a dangling one. History is retained and attributed
-- to the acting user.
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
    if v_project is not null and not exists (select 1 from public.seo_projects where id = v_project) then
      v_project := null;
    end if;
    insert into public.seo_audit_logs (project_id, user_id, action, entity_type, entity_id, meta)
    values (v_project, auth.uid(), 'delete', tg_table_name, old.id::text, '{}'::jsonb);
    return old;
  end if;

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
-- S13: project-scoped content<->media links
-- ----------------------------------------------------------------------------

alter table public.seo_content_media add column project_id uuid;

update public.seo_content_media cm
set project_id = c.project_id
from public.seo_content c
where c.id = cm.content_id and cm.project_id is null;

alter table public.seo_content_media alter column project_id set not null;

-- Composite-FK targets. `id` alone is already unique (PK); these exist so the
-- link table can reference (id, project_id) and thereby prove both endpoints
-- share a project.
alter table public.seo_content
  add constraint seo_content_id_project_key unique (id, project_id);
alter table public.seo_media
  add constraint seo_media_id_project_key unique (id, project_id);

-- Replace the single-column FKs with composite ones. The content link cascades
-- with its document; the media link uses NO ACTION (not RESTRICT) so a project
-- teardown - where media and links are removed in the same statement - is not
-- blocked by the reference check, while a direct delete of a still-referenced
-- media item is still refused.
alter table public.seo_content_media
  drop constraint if exists seo_content_media_content_id_fkey,
  drop constraint if exists seo_content_media_media_id_fkey;

alter table public.seo_content_media
  add constraint seo_content_media_content_fk
    foreign key (content_id, project_id) references public.seo_content (id, project_id) on delete cascade,
  add constraint seo_content_media_media_fk
    foreign key (media_id, project_id) references public.seo_media (id, project_id) on delete no action,
  add constraint seo_content_media_project_fk
    foreign key (project_id) references public.seo_projects (id) on delete cascade;

create index seo_content_media_project_idx on public.seo_content_media (project_id);

-- RLS now checks the link's own project_id (guaranteed to match both endpoints
-- by the composite FKs) instead of only the media side.
drop policy if exists seo_content_media_select on public.seo_content_media;
create policy seo_content_media_select on public.seo_content_media
  for select using (public.seo_is_member(project_id, auth.uid()));

drop policy if exists seo_content_media_insert on public.seo_content_media;
create policy seo_content_media_insert on public.seo_content_media
  for insert with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_content_media_update on public.seo_content_media;
create policy seo_content_media_update on public.seo_content_media
  for update using (public.seo_has_role(project_id, array['owner', 'admin', 'editor']))
  with check (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

drop policy if exists seo_content_media_delete on public.seo_content_media;
create policy seo_content_media_delete on public.seo_content_media
  for delete using (public.seo_has_role(project_id, array['owner', 'admin', 'editor']));

-- ----------------------------------------------------------------------------
-- S15: per-project job idempotency
-- ----------------------------------------------------------------------------

alter table public.seo_sync_jobs
  drop constraint if exists seo_sync_jobs_idempotency_unique;
alter table public.seo_sync_jobs
  add constraint seo_sync_jobs_idempotency_unique unique (project_id, idempotency_key);

-- ----------------------------------------------------------------------------
-- S16: usage totals function grant
-- ----------------------------------------------------------------------------

revoke execute on function public.seo_usage_totals(
  uuid, uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean
) from anon, authenticated;

-- ----------------------------------------------------------------------------
-- S14: storage.objects policies for the seo-media bucket
-- ----------------------------------------------------------------------------

do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'storage.objects not present; skipping seo-media storage policies';
    return;
  end if;

  execute $policies$
    -- A well-formed project id is the first path segment. The CASE guards the
    -- uuid cast so a malformed key denies access instead of erroring.
    drop policy if exists seo_media_objects_select on storage.objects;
    create policy seo_media_objects_select on storage.objects
      for select to authenticated
      using (
        bucket_id = 'seo-media'
        and public.seo_is_member(
          case
            when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              then ((storage.foldername(name))[1])::uuid
          end,
          auth.uid()
        )
      );

    drop policy if exists seo_media_objects_insert on storage.objects;
    create policy seo_media_objects_insert on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'seo-media'
        and public.seo_has_role(
          case
            when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              then ((storage.foldername(name))[1])::uuid
          end,
          array['owner', 'admin', 'editor']
        )
      );

    drop policy if exists seo_media_objects_update on storage.objects;
    create policy seo_media_objects_update on storage.objects
      for update to authenticated
      using (
        bucket_id = 'seo-media'
        and public.seo_has_role(
          case
            when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              then ((storage.foldername(name))[1])::uuid
          end,
          array['owner', 'admin', 'editor']
        )
      );

    drop policy if exists seo_media_objects_delete on storage.objects;
    create policy seo_media_objects_delete on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'seo-media'
        and public.seo_has_role(
          case
            when (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              then ((storage.foldername(name))[1])::uuid
          end,
          array['owner', 'admin']
        )
      );
  $policies$;
end $$;
