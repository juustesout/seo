#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Validate the Supabase migrations against a local PostgreSQL 15 instance.
#
# Creates (if absent) a database `seo_dev`, stubs the minimal Supabase Auth
# surface that the migrations reference (auth.users, auth.uid(), the anon /
# authenticated / service_role roles), then applies every migration in order
# with ON_ERROR_STOP so the first failure is reported loudly.
#
# No destructive commands are run: existing objects are reused, not dropped.
# ---------------------------------------------------------------------------
set -euo pipefail

DB_NAME="${DB_NAME:-seo_dev}"
MIGRATIONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations"
# How to reach the Postgres superuser. Locally the script runs as root and drops
# to the postgres OS user; CI overrides PSQL_CMD/CREATEDB_CMD to talk to a
# service container over TCP (e.g. "psql -h 127.0.0.1 -U postgres" + PGPASSWORD).
PSQL_CMD="${PSQL_CMD:-runuser -u postgres -- psql}"
CREATEDB_CMD="${CREATEDB_CMD:-runuser -u postgres -- createdb}"
PSQL() { $PSQL_CMD -v ON_ERROR_STOP=1 -X -q "$@"; }

echo "==> ensuring roles + database (${DB_NAME})"
$PSQL_CMD -X -q -d postgres <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
SQL
$PSQL_CMD -X -q -d postgres -c "select 1 from pg_database where datname = '${DB_NAME}'" | grep -q 1 \
  || $CREATEDB_CMD "${DB_NAME}"

if $PSQL_CMD -X -q -t -A -d "${DB_NAME}" -c "select count(*) from pg_tables where schemaname='public' and tablename like 'seo_%'" | grep -vq '^0$'; then
  echo "!! database '${DB_NAME}' already contains seo_* tables from a previous run." >&2
  echo "   This harness never drops databases; re-run with a fresh name, e.g.:" >&2
  echo "   DB_NAME=seo_dev_2 bash ${0}" >&2
  exit 1
fi

echo "==> stubbing minimal Supabase Auth surface (auth.users, auth.uid)"
PSQL -d "${DB_NAME}" <<'SQL'
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz not null default now()
);
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
SQL

echo "==> applying migrations"
for f in "${MIGRATIONS_DIR}"/*.sql; do
  # Pause before the KB1 canonical-vocabulary migration to seed legacy rows so
  # the data remap itself is validated, not only the fresh-schema path.
  if [ "$(basename "${f}")" = "20260101000021_knowledge_source_lifecycle.sql" ]; then
    echo "   - seeding legacy knowledge rows before canonical-vocabulary migration"
    PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'owner@example.com') on conflict (id) do nothing;
select public.seo_create_project('Legacy KB project', 'legacy-kb', 'https://legacy.example', 'legacy kb seed');
insert into public.seo_knowledge_sources (project_id, source_type, name, status, chunk_count)
select id, 'note', 'Legacy seeded note', 'pending', 2 from public.seo_projects where slug = 'legacy-kb';
insert into public.seo_knowledge_sources (project_id, source_type, name, status, chunk_count)
select id, 'reference', 'Legacy seeded ref', 'indexing', 0 from public.seo_projects where slug = 'legacy-kb';
insert into public.seo_knowledge_sources (project_id, source_type, name, status, chunk_count)
select id, 'url', 'Legacy seeded url', 'indexed', 3 from public.seo_projects where slug = 'legacy-kb';
insert into public.seo_knowledge_sources (project_id, source_type, name, status, chunk_count)
select id, 'note', 'Legacy seeded error', 'error', 0 from public.seo_projects where slug = 'legacy-kb';
SQL
  fi
  echo "   - $(basename "${f}")"
  PSQL -d "${DB_NAME}" -f "${f}" >/dev/null
done

echo "==> smoke test: create project via RPC + dashboard summary"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001","email":"owner@example.com"}';
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'owner@example.com') on conflict (id) do nothing;
select public.seo_create_project('Demo project', 'demo', 'https://example.com', 'migration smoke test');
do $$
declare
  v_project uuid;
  v_prop uuid;
  v_summary jsonb;
  v_role text;
  v_acc uuid;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: project was not created'; end if;

  select role into v_role from public.seo_project_members where project_id = v_project and user_id = '00000000-0000-0000-0000-000000000001';
  if v_role is distinct from 'owner' then raise exception 'smoke: owner membership not auto-created (role=%)', v_role; end if;

  select account_id into v_acc from public.seo_projects where id = v_project;
  if v_acc is null then raise exception 'smoke: project has no account'; end if;

  insert into public.seo_gsc_properties (account_id, site_url, is_active)
  values (v_acc, 'sc-domain:example.com', true) returning id into v_prop;
  insert into public.seo_project_properties (project_id, property_id, is_primary)
  values (v_project, v_prop, true);
  insert into public.seo_gsc_performance (project_id, property_id, date, clicks, impressions, ctr, position)
  values (v_project, v_prop, current_date, 10, 1000, 0.01, 5.5);
  insert into public.seo_domains (project_id, domain, protocol, is_primary)
  values (v_project, 'example.com', 'https', true);

  v_summary := public.seo_dashboard_summary(v_project, 30);
  if not (v_summary ? 'overview') then raise exception 'smoke: dashboard summary malformed'; end if;
  raise notice 'smoke: dashboard overview = %', v_summary->'overview';
end $$;
SQL

echo "==> smoke test: BYOK project-scoped AI credential ownership"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_id uuid;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: project missing for ai credential test'; end if;

  insert into public.seo_credentials (project_id, provider_type, key_name, ciphertext, iv)
  values (v_project, 'ai', 'OPENAI_API_KEY', 'cipher', 'iv') returning id into v_id;
  if v_id is null then raise exception 'smoke: ai project credential was not stored'; end if;

  begin
    insert into public.seo_credentials (project_id, provider_type, key_name, ciphertext, iv)
    values (v_project, 'ai', 'OPENAI_API_KEY', 'cipher2', 'iv2');
    raise exception 'smoke: duplicate ai key unexpectedly allowed';
  exception when unique_violation then
    null;
  end;

  begin
    insert into public.seo_credentials (provider_type, key_name, ciphertext, iv)
    values ('ai', 'NO_OWNER', 'cipher', 'iv');
    raise exception 'smoke: ownerless credential unexpectedly allowed';
  exception when check_violation then
    null;
  end;

  raise notice 'smoke: ai project credentials OK';
end $$;
SQL

echo "==> smoke test: structured content model"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_content uuid;
  v_blocks jsonb := '[{"type":"heading","attrs":{"level":2,"text":"Intro"}},{"type":"paragraph","attrs":{"text":"Hello world"}}]'::jsonb;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;

  insert into public.seo_content (project_id, title, slug, target_keyword, meta_title, meta_description, content_json, content_html, outline, status)
  values (v_project, 'Demo article', 'demo-article', 'demo keyword', 'Demo | SEO', 'A demo description', v_blocks, '<p>Hello</p>', '[{"level":2,"text":"Intro"}]', 'draft')
  returning id into v_content;
  if v_content is null then raise exception 'smoke: content row was not created'; end if;

  begin
    insert into public.seo_content (project_id, title, slug)
    values (v_project, 'Duplicate slug', 'demo-article');
    raise exception 'smoke: duplicate project slug unexpectedly allowed';
  exception when unique_violation then
    null;
  end;

  raise notice 'smoke: structured content OK';
end $$;
SQL

echo "==> smoke test: rest api keys"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_key uuid;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;

  insert into public.seo_api_keys (project_id, name, key_prefix, key_hash, scopes)
  values (v_project, 'ci-key', 'seo_live_abcd', 'deadbeef', array['read'])
  returning id into v_key;
  if v_key is null then raise exception 'smoke: api key row was not created'; end if;

  begin
    insert into public.seo_api_keys (project_id, name, key_prefix, key_hash, scopes)
    values (v_project, 'ci-key', 'seo_live_xxxx', 'cafebabe', array['read']);
    raise exception 'smoke: duplicate api key name unexpectedly allowed';
  exception when unique_violation then
    null;
  end;

  raise notice 'smoke: rest api keys OK';
end $$;
SQL

echo "==> smoke test: account (master) api keys"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_master uuid;
begin
  -- Account/master keys carry project_id = NULL and belong to the creator.
  insert into public.seo_api_keys (project_id, name, key_prefix, key_hash, scopes, created_by)
  values (null, 'master-ci', 'seo_live_master1', 'deadbeef1', array['read', 'write'], '00000000-0000-0000-0000-000000000001')
  returning id into v_master;
  if v_master is null then raise exception 'smoke: account api key was not created'; end if;

  -- One name per owner for account keys.
  begin
    insert into public.seo_api_keys (project_id, name, key_prefix, key_hash, scopes, created_by)
    values (null, 'master-ci', 'seo_live_master2', 'cafebabe1', array['read'], '00000000-0000-0000-0000-000000000001');
    raise exception 'smoke: duplicate account key name for one owner unexpectedly allowed';
  exception when unique_violation then
    null;
  end;

  -- Two owners may both name a key 'master-ci' (the account index is per owner).
  insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000002', 'member2@example.com') on conflict (id) do nothing;
  insert into public.seo_api_keys (project_id, name, key_prefix, key_hash, scopes, created_by)
  values (null, 'master-ci', 'seo_live_master3', 'cafebabe2', array['read'], '00000000-0000-0000-0000-000000000002');

  -- A project key and an account key with the same name coexist.
  insert into public.seo_api_keys (project_id, name, key_prefix, key_hash, scopes, created_by)
  values ((select id from public.seo_projects where slug = 'demo'), 'master-ci', 'seo_live_master4', 'cafebabe3', array['read'],
          '00000000-0000-0000-0000-000000000001');

  raise notice 'smoke: account api keys OK';
end $$;
SQL

echo "==> smoke test: account layer (stage 1+2)"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_project2 uuid;
  v_account uuid;
  v_account2 uuid;
  v_integration uuid;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: account test project missing'; end if;

  select id into v_account from public.seo_accounts where owner_user_id = '00000000-0000-0000-0000-000000000001';
  if v_account is null then raise exception 'smoke: creator account was not created'; end if;

  if not exists (select 1 from public.seo_projects where id = v_project and account_id = v_account) then
    raise exception 'smoke: project account_id not backfilled to creator account';
  end if;

  insert into public.seo_integrations (project_id, provider_type, name, status)
  values (v_project, 'dataforseo', 'DataForSEO', 'disconnected')
  returning id into v_integration;
  if not exists (select 1 from public.seo_integrations where id = v_integration and account_id = v_account) then
    raise exception 'smoke: integration account_id not set from project';
  end if;

  insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000002', 'member@example.com') on conflict (id) do nothing;
  insert into public.seo_projects (name, slug, created_by)
  values ('Second user project', 'second-user-project', '00000000-0000-0000-0000-000000000002')
  returning id into v_project2;

  select id into v_account2 from public.seo_accounts where owner_user_id = '00000000-0000-0000-0000-000000000002';
  if v_account2 is null then raise exception 'smoke: second user account not auto-created by trigger'; end if;
  if v_account2 = v_account then raise exception 'smoke: two users share one account'; end if;
  if not exists (select 1 from public.seo_projects where id = v_project2 and account_id = v_account2) then
    raise exception 'smoke: second project account_id not set';
  end if;

  raise notice 'smoke: account layer OK';
end $$;
SQL

echo "==> smoke test: project member administration (phase B) + authorization boundaries"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000002', 'member2@example.com'),
  ('00000000-0000-0000-0000-000000000003', 'admin3@example.com'),
  ('00000000-0000-0000-0000-000000000004', 'owner4@example.com')
on conflict (id) do nothing;
do $$
declare
  v_project uuid;
  v_owner  uuid := '00000000-0000-0000-0000-000000000001';
  v_editor uuid := '00000000-0000-0000-0000-000000000002';
  v_admin  uuid := '00000000-0000-0000-0000-000000000003';
  v_owner2 uuid := '00000000-0000-0000-0000-000000000004';
  v_role text;
  v_denied boolean;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: demo project missing for member admin'; end if;

  -- Owner adds an editor, an admin and a second owner.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  perform public.seo_add_project_member(v_project, 'member2@example.com', 'editor');
  perform public.seo_add_project_member(v_project, 'admin3@example.com', 'admin');
  perform public.seo_add_project_member(v_project, 'owner4@example.com', 'owner');

  select role into v_role from public.seo_list_project_members(v_project) where user_id = v_admin;
  if v_role is distinct from 'admin' then raise exception 'smoke: added admin role not visible to owner (role=%)', v_role; end if;
  if (select count(*) from public.seo_list_project_members(v_project)) < 4 then
    raise exception 'smoke: owner member list incomplete';
  end if;

  -- An editor cannot list or add members.
  perform set_config('request.jwt.claims', json_build_object('sub', v_editor)::text, true);
  v_denied := false;
  begin perform public.seo_list_project_members(v_project);
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'smoke: editor was allowed to list members'; end if;

  v_denied := false;
  begin perform public.seo_add_project_member(v_project, 'owner4@example.com', 'viewer');
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'smoke: editor was allowed to add a member'; end if;

  -- An admin cannot grant the owner/admin role, nor remove an owner.
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  v_denied := false;
  begin perform public.seo_add_project_member(v_project, 'member2@example.com', 'owner');
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'smoke: admin was allowed to grant the owner role'; end if;

  v_denied := false;
  begin perform public.seo_remove_project_member(v_project, v_owner);
  exception when insufficient_privilege then v_denied := true; end;
  if not v_denied then raise exception 'smoke: admin was allowed to remove an owner'; end if;

  -- Owner changes a role, then removes the member.
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner)::text, true);
  perform public.seo_update_project_member_role(v_project, v_editor, 'viewer');
  select role into v_role from public.seo_project_members where project_id = v_project and user_id = v_editor;
  if v_role is distinct from 'viewer' then raise exception 'smoke: role change did not take effect (role=%)', v_role; end if;

  perform public.seo_remove_project_member(v_project, v_editor);
  if exists (select 1 from public.seo_project_members where project_id = v_project and user_id = v_editor) then
    raise exception 'smoke: owner removal did not take effect';
  end if;

  -- Owner protection: the last owner cannot be demoted.
  perform public.seo_update_project_member_role(v_project, v_owner, 'editor');
  if (select role from public.seo_project_members where project_id = v_project and user_id = v_owner) is distinct from 'editor' then
    raise exception 'smoke: owner demotion with a second owner did not take effect';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_owner2)::text, true);
  v_denied := false;
  begin perform public.seo_update_project_member_role(v_project, v_owner2, 'editor');
  exception when raise_exception then
    if sqlerrm like '%at least one owner%' then v_denied := true; else raise; end if;
  end;
  if not v_denied then raise exception 'smoke: last owner was allowed to be demoted'; end if;

  v_denied := false;
  begin perform public.seo_remove_project_member(v_project, v_owner2);
  exception when raise_exception then
    if sqlerrm like '%at least one owner%' then v_denied := true; else raise; end if;
  end;
  if not v_denied then raise exception 'smoke: last owner was allowed to be removed'; end if;

  -- A remaining owner can restore the other owner.
  perform public.seo_update_project_member_role(v_project, v_owner, 'owner');
  if (select role from public.seo_project_members where project_id = v_project and user_id = v_owner) is distinct from 'owner' then
    raise exception 'smoke: owner restore did not take effect';
  end if;

  raise notice 'smoke: member administration + authorization boundaries OK';
end $$;
SQL

echo "==> smoke test: knowledge sources (phase E) + canonical vocabulary + isolation"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_source uuid;
  v_url_source uuid;
  v_file_source uuid;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: demo project missing for knowledge sources'; end if;

  insert into public.seo_knowledge_sources (project_id, source_type, name, url, content_text, status, chunk_count)
  values (v_project, 'text', 'Smoke note', null, 'A short project note about phase E ingestion.', 'queued', 0)
  returning id into v_source;
  if v_source is null then raise exception 'smoke: knowledge source row was not created'; end if;

  update public.seo_knowledge_sources set status = 'ready', chunk_count = 1 where id = v_source;
  if not exists (select 1 from public.seo_knowledge_sources where id = v_source and status = 'ready' and chunk_count = 1) then
    raise exception 'smoke: source status transition failed';
  end if;

  -- A file source stores only private-storage metadata, never the bytes.
  insert into public.seo_knowledge_sources
    (project_id, source_type, name, status, original_filename, content_type, size_bytes, storage_path)
  values
    (v_project, 'file', 'Smoke file', 'draft', 'notes.txt', 'text/plain', 123, v_project::text || '/file-1')
  returning id into v_file_source;
  if not exists (
    select 1 from public.seo_knowledge_sources
    where id = v_file_source and storage_path is not null and size_bytes = 123 and content_text is null
  ) then raise exception 'smoke: file knowledge source metadata was not stored'; end if;

  -- A negative file size is rejected by the KB4 check constraint.
  begin
    insert into public.seo_knowledge_sources (project_id, source_type, name, size_bytes)
    values (v_project, 'file', 'Bad size', -1);
    raise exception 'smoke: negative file size unexpectedly allowed';
  exception when check_violation then
    null;
  end;
  raise notice 'smoke: knowledge file source metadata + size constraint OK';

  -- A URL-only source is stored as draft; fetching is not part of KB1.
  insert into public.seo_knowledge_sources (project_id, source_type, name, url, status)
  values (v_project, 'url', 'Smoke url', 'https://example.com/ref', 'draft')
  returning id into v_url_source;
  if v_url_source is null then raise exception 'smoke: url knowledge source was not created'; end if;

  -- The legacy vocabulary is rejected by the canonical checks.
  begin
    insert into public.seo_knowledge_sources (project_id, source_type, name)
    values (v_project, 'note', 'Legacy type');
    raise exception 'smoke: legacy knowledge source_type unexpectedly allowed';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.seo_knowledge_sources (project_id, source_type, name, status)
    values (v_project, 'text', 'Legacy status', 'indexed');
    raise exception 'smoke: legacy knowledge status unexpectedly allowed';
  exception when check_violation then
    null;
  end;

  -- The KB1 migration remapped the rows seeded before it onto the canonical set.
  if not exists (
    select 1 from public.seo_knowledge_sources
    where name = 'Legacy seeded note' and source_type = 'text' and status = 'queued'
  ) then raise exception 'smoke: legacy note row was not remapped'; end if;
  if not exists (
    select 1 from public.seo_knowledge_sources
    where name = 'Legacy seeded ref' and source_type = 'text' and status = 'processing'
  ) then raise exception 'smoke: legacy reference row was not remapped'; end if;
  if not exists (
    select 1 from public.seo_knowledge_sources
    where name = 'Legacy seeded url' and source_type = 'url' and status = 'ready'
  ) then raise exception 'smoke: legacy url row was not remapped'; end if;
  if not exists (
    select 1 from public.seo_knowledge_sources
    where name = 'Legacy seeded error' and source_type = 'text' and status = 'failed'
  ) then raise exception 'smoke: legacy error row was not remapped'; end if;

  -- KB7 freshness facts: URL rows that pre-date the migration are put on the
  -- manual policy and the failure counter defaults to zero; nothing else is
  -- pre-populated (freshness state itself is never stored).
  if not exists (
    select 1 from public.seo_knowledge_sources
    where name = 'Legacy seeded url' and source_type = 'url' and refresh_policy = 'manual'
      and refresh_failures = 0 and content_hash is null and next_refresh_at is null
  ) then raise exception 'smoke: KB7 freshness defaults were not applied'; end if;

  update public.seo_knowledge_sources
  set content_hash = repeat('a', 64),
      last_fetched_at = now(),
      last_changed_at = now(),
      next_refresh_at = now() + interval '1 day',
      refresh_policy = 'daily',
      refresh_failures = 2
  where id = v_url_source;
  if not exists (
    select 1 from public.seo_knowledge_sources
    where id = v_url_source and refresh_policy = 'daily' and refresh_failures = 2
      and content_hash = repeat('a', 64) and next_refresh_at is not null
  ) then raise exception 'smoke: KB7 freshness facts were not stored'; end if;

  begin
    update public.seo_knowledge_sources set refresh_policy = 'hourly' where id = v_url_source;
    raise exception 'smoke: invalid refresh_policy unexpectedly allowed';
  exception when check_violation then
    null;
  end;

  begin
    update public.seo_knowledge_sources set refresh_failures = -1 where id = v_url_source;
    raise exception 'smoke: negative refresh_failures unexpectedly allowed';
  exception when check_violation then
    null;
  end;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'seo_knowledge_sources_due_refresh_idx'
  ) then raise exception 'smoke: KB7 due-refresh index missing'; end if;
  raise notice 'smoke: KB7 freshness facts + policy/backoff constraints OK';

  raise notice 'smoke: knowledge source insert + status transition OK';
end $$;
SQL

echo "==> smoke test: knowledge collections (KB8) + optional organization + isolation"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_project2 uuid;
  v_source uuid;
  v_collection uuid;
  v_foreign_collection uuid;
  v_owner uuid := '00000000-0000-0000-0000-000000000001';
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  select id into v_project2 from public.seo_projects where slug = 'second-user-project' limit 1;
  if v_project is null or v_project2 is null then raise exception 'smoke: KB8 projects missing'; end if;
  select id into v_source from public.seo_knowledge_sources where project_id = v_project and name = 'Smoke note' limit 1;
  if v_source is null then raise exception 'smoke: KB8 source missing'; end if;

  -- 1. Collection creation.
  insert into public.seo_knowledge_collections (project_id, name, description, created_by)
  values (v_project, 'Smoke collection', 'migration smoke', v_owner)
  returning id into v_collection;
  if v_collection is null then raise exception 'smoke: KB8 collection was not created'; end if;
  if not exists (
    select 1 from public.seo_knowledge_collections
    where id = v_collection and project_id = v_project and description = 'migration smoke'
  ) then raise exception 'smoke: KB8 collection metadata was not stored'; end if;

  -- 2. Case-insensitive uniqueness per project.
  begin
    insert into public.seo_knowledge_collections (project_id, name, created_by)
    values (v_project, 'smoke collection', v_owner);
    raise exception 'smoke: duplicate collection name unexpectedly allowed';
  exception when unique_violation then
    null;
  end;

  -- 3. Assignment (membership only; the source keeps its lifecycle).
  update public.seo_knowledge_sources set collection_id = v_collection where id = v_source;
  if not exists (
    select 1 from public.seo_knowledge_sources where id = v_source and collection_id = v_collection and status = 'ready'
  ) then raise exception 'smoke: KB8 source assignment failed'; end if;

  -- 6/7/8. Normal / collection-filtered / uncategorized queries the API uses.
  if (select count(*) from public.seo_knowledge_sources where project_id = v_project and status <> 'deleted') < 1 then
    raise exception 'smoke: KB8 normal source query returned nothing';
  end if;
  if (select count(*) from public.seo_knowledge_sources where project_id = v_project and collection_id = v_collection) < 1 then
    raise exception 'smoke: KB8 collection-filtered query returned nothing';
  end if;
  if not exists (
    select 1 from public.seo_knowledge_sources where project_id = v_project and collection_id is null
  ) then raise exception 'smoke: KB8 uncategorized query returned nothing'; end if;

  -- 4. A foreign-project collection cannot be assigned (composite FK).
  insert into public.seo_knowledge_collections (project_id, name, created_by)
  values (v_project2, 'Foreign collection', v_owner)
  returning id into v_foreign_collection;
  begin
    update public.seo_knowledge_sources set collection_id = v_foreign_collection where id = v_source;
    raise exception 'smoke: cross-project collection assignment unexpectedly allowed';
  exception when foreign_key_violation then
    null;
  end;

  -- 5. Deleting a collection never deletes its sources (ON DELETE SET NULL).
  delete from public.seo_knowledge_collections where id = v_collection;
  if exists (select 1 from public.seo_knowledge_collections where id = v_collection) then
    raise exception 'smoke: KB8 collection delete failed';
  end if;
  if not exists (
    select 1 from public.seo_knowledge_sources where id = v_source and collection_id is null and status = 'ready'
  ) then raise exception 'smoke: KB8 collection delete removed or detached the source'; end if;

  -- Kept for the RLS check below (user 2 is not a member of the demo project).
  insert into public.seo_knowledge_collections (project_id, name, created_by)
  values (v_project, 'RLS demo collection', v_owner);

  raise notice 'smoke: knowledge collections (create/uniqueness/assign/isolate/delete) OK';
end $$;
SQL

# RLS can only be exercised as a non-superuser role (superusers bypass RLS).
COLLECTION_LEAK_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant usage on schema public to authenticated;
grant select on public.seo_knowledge_collections to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
select count(*) from public.seo_knowledge_collections where name = 'RLS demo collection';
SQL
)"
if [ -z "${COLLECTION_LEAK_COUNT}" ] || [ "${COLLECTION_LEAK_COUNT}" != "0" ]; then
  echo "!! RLS leak: non-member read ${COLLECTION_LEAK_COUNT} rows from a foreign project collection" >&2
  exit 1
fi
echo "   smoke: non-member cannot read a foreign project collection (RLS isolation OK)"

# RLS can only be exercised as a non-superuser role (superusers bypass RLS).
LEAK_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant usage on schema public to authenticated;
grant select on public.seo_knowledge_sources to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
select count(*) from public.seo_knowledge_sources where name = 'Smoke note';
SQL
)"
if [ -z "${LEAK_COUNT}" ] || [ "${LEAK_COUNT}" != "0" ]; then
  echo "!! RLS leak: non-member read ${LEAK_COUNT} rows from a foreign project source" >&2
  exit 1
fi
echo "   smoke: non-member cannot read a foreign project source (RLS isolation OK)"

echo "==> smoke test: knowledge discovery sessions (KB9) + limits + isolation"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_project2 uuid;
  v_collection uuid;
  v_foreign_collection uuid;
  v_session uuid;
  v_owner uuid := '00000000-0000-0000-0000-000000000001';
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  select id into v_project2 from public.seo_projects where slug = 'second-user-project' limit 1;
  if v_project is null or v_project2 is null then raise exception 'smoke: KB9 projects missing'; end if;

  insert into public.seo_knowledge_collections (project_id, name, created_by)
  values (v_project, 'Discovery target', v_owner)
  returning id into v_collection;

  insert into public.seo_knowledge_discovery_sessions
    (project_id, seed_url, normalized_seed_url, collection_id, scope, max_urls, max_depth, request_json, created_by)
  values
    (v_project, 'https://example.com/', 'https://example.com', v_collection, 'same_host', 25, 1, '{"seedUrl":"https://example.com/"}'::jsonb, v_owner)
  returning id into v_session;
  if v_session is null then raise exception 'smoke: KB9 session was not created'; end if;
  if not exists (
    select 1 from public.seo_knowledge_discovery_sessions
    where id = v_session and status = 'queued' and scope = 'same_host' and collection_id = v_collection
  ) then raise exception 'smoke: KB9 session defaults were not stored'; end if;

  -- Limits: max_urls 1..100, max_depth 0..3, scope + status allowlists.
  begin
    insert into public.seo_knowledge_discovery_sessions (project_id, seed_url, normalized_seed_url, max_urls)
    values (v_project, 'https://example.com/', 'https://example.com', 0);
    raise exception 'smoke: KB9 max_urls below 1 unexpectedly allowed';
  exception when check_violation then null;
  end;
  begin
    insert into public.seo_knowledge_discovery_sessions (project_id, seed_url, normalized_seed_url, max_urls)
    values (v_project, 'https://example.com/', 'https://example.com', 101);
    raise exception 'smoke: KB9 max_urls above 100 unexpectedly allowed';
  exception when check_violation then null;
  end;
  begin
    insert into public.seo_knowledge_discovery_sessions (project_id, seed_url, normalized_seed_url, max_depth)
    values (v_project, 'https://example.com/', 'https://example.com', 4);
    raise exception 'smoke: KB9 max_depth above 3 unexpectedly allowed';
  exception when check_violation then null;
  end;
  begin
    insert into public.seo_knowledge_discovery_sessions (project_id, seed_url, normalized_seed_url, scope)
    values (v_project, 'https://example.com/', 'https://example.com', 'everywhere');
    raise exception 'smoke: KB9 invalid scope unexpectedly allowed';
  exception when check_violation then null;
  end;
  begin
    insert into public.seo_knowledge_discovery_sessions (project_id, seed_url, normalized_seed_url, status)
    values (v_project, 'https://example.com/', 'https://example.com', 'done');
    raise exception 'smoke: KB9 invalid status unexpectedly allowed';
  exception when check_violation then null;
  end;

  -- A foreign-project collection cannot be targeted (composite FK).
  insert into public.seo_knowledge_collections (project_id, name, created_by)
  values (v_project2, 'Foreign discovery target', v_owner)
  returning id into v_foreign_collection;
  begin
    update public.seo_knowledge_discovery_sessions set collection_id = v_foreign_collection where id = v_session;
    raise exception 'smoke: KB9 cross-project collection unexpectedly allowed';
  exception when foreign_key_violation then null;
  end;

  -- Proposal transition + bounded candidate payload the API serializes.
  update public.seo_knowledge_discovery_sessions
  set status = 'ready',
      result_json = '{"candidates":[{"url":"https://example.com/a","normalizedUrl":"https://example.com/a","depth":1,"eligible":true}]}'::jsonb
  where id = v_session;
  if not exists (
    select 1 from public.seo_knowledge_discovery_sessions
    where id = v_session and status = 'ready' and jsonb_array_length(result_json->'candidates') = 1
  ) then raise exception 'smoke: KB9 proposal was not stored'; end if;

  -- Deleting the target collection keeps the session (ON DELETE SET NULL).
  delete from public.seo_knowledge_collections where id = v_collection;
  if not exists (
    select 1 from public.seo_knowledge_discovery_sessions where id = v_session and collection_id is null
  ) then raise exception 'smoke: KB9 collection delete did not keep the session'; end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'seo_knowledge_discovery_sessions_project_status_idx'
  ) then raise exception 'smoke: KB9 status index missing'; end if;

  raise notice 'smoke: knowledge discovery session (limits/transition/isolate/delete) OK';
end $$;
SQL

# RLS can only be exercised as a non-superuser role (superusers bypass RLS).
DISCOVERY_LEAK_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant usage on schema public to authenticated;
grant select on public.seo_knowledge_discovery_sessions to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
select count(*) from public.seo_knowledge_discovery_sessions;
SQL
)"
if [ -z "${DISCOVERY_LEAK_COUNT}" ] || [ "${DISCOVERY_LEAK_COUNT}" != "0" ]; then
  echo "!! RLS leak: non-member read ${DISCOVERY_LEAK_COUNT} discovery sessions" >&2
  exit 1
fi
echo "   smoke: non-member cannot read a foreign project discovery session (RLS isolation OK)"

echo "==> smoke test: knowledge lexical index (KB10) + hybrid search + isolation"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_project2 uuid;
  v_source uuid;
  v_collection uuid;
  v_matches integer;
  v_top text;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  select id into v_project2 from public.seo_projects where slug = 'second-user-project' limit 1;
  if v_project is null or v_project2 is null then raise exception 'smoke: KB10 projects missing'; end if;

  insert into public.seo_knowledge_sources (project_id, source_type, name, content_text, status, chunk_count)
  values (v_project, 'text', 'Lexical smoke', 'Running the lexical migration smoke test.', 'ready', 2)
  returning id into v_source;

  insert into public.seo_knowledge_lexical_chunks (project_id, source_id, chunk_index, content)
  values (v_project, v_source, 0, 'Running the lexical migration smoke test.'),
         (v_project, v_source, 1, 'A second chunk about hybrid retrieval.');

  -- Normal match.
  select count(*) into v_matches
  from public.seo_knowledge_lexical_search(v_project, 'lexical migration', 10);
  if v_matches < 1 then raise exception 'smoke: KB10 normal lexical query returned nothing'; end if;

  -- Word variation: `run` matches `Running` through english stemming.
  select content into v_top from public.seo_knowledge_lexical_search(v_project, 'run', 10) limit 1;
  if v_top is null then raise exception 'smoke: KB10 stemming query returned nothing'; end if;

  -- Non-ready sources are excluded before fusion.
  update public.seo_knowledge_sources set status = 'processing' where id = v_source;
  select count(*) into v_matches
  from public.seo_knowledge_lexical_search(v_project, 'lexical migration', 10);
  if v_matches <> 0 then raise exception 'smoke: KB10 non-ready source was searchable'; end if;
  update public.seo_knowledge_sources set status = 'ready' where id = v_source;

  -- Project isolation: the second project has no matching chunks.
  select count(*) into v_matches
  from public.seo_knowledge_lexical_search(v_project2, 'lexical migration', 10);
  if v_matches <> 0 then raise exception 'smoke: KB10 cross-project lexical leak'; end if;

  -- Collection + uncategorized filters.
  insert into public.seo_knowledge_collections (project_id, name, created_by)
  values (v_project, 'Lexical target', '00000000-0000-0000-0000-000000000001')
  returning id into v_collection;
  update public.seo_knowledge_sources set collection_id = v_collection where id = v_source;

  select count(*) into v_matches
  from public.seo_knowledge_lexical_search(v_project, 'lexical migration', 10, null, null, v_collection, false);
  if v_matches < 1 then raise exception 'smoke: KB10 collection filter returned nothing'; end if;

  select count(*) into v_matches
  from public.seo_knowledge_lexical_search(v_project, 'lexical migration', 10, null, null, null, true);
  if v_matches <> 0 then raise exception 'smoke: KB10 uncategorized filter matched a categorized source'; end if;

  -- Source-id filter (as the API passes managed source uuids).
  select count(*) into v_matches
  from public.seo_knowledge_lexical_search(v_project, 'lexical migration', 10, array[v_source], null, null, false);
  if v_matches < 1 then raise exception 'smoke: KB10 source-id filter returned nothing'; end if;
  select count(*) into v_matches
  from public.seo_knowledge_lexical_search(v_project, 'lexical migration', 10, array[gen_random_uuid()], null, null, false);
  if v_matches <> 0 then raise exception 'smoke: KB10 source-id filter ignored the filter'; end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'seo_knowledge_lexical_chunks_search_idx'
  ) then raise exception 'smoke: KB10 GIN lexical index missing'; end if;

  -- Deleting the source cascades to its projection (no orphan chunk).
  delete from public.seo_knowledge_sources where id = v_source;
  if exists (select 1 from public.seo_knowledge_lexical_chunks where source_id = v_source) then
    raise exception 'smoke: KB10 source delete left orphan lexical chunks';
  end if;

  raise notice 'smoke: knowledge lexical index (match/stem/isolate/filter/cascade) OK';
end $$;
SQL

# RLS can only be exercised as a non-superuser role (superusers bypass RLS).
LEXICAL_LEAK_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant usage on schema public to authenticated;
grant select on public.seo_knowledge_lexical_chunks to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
select count(*) from public.seo_knowledge_lexical_chunks;
SQL
)"
if [ -z "${LEXICAL_LEAK_COUNT}" ] || [ "${LEXICAL_LEAK_COUNT}" != "0" ]; then
  echo "!! RLS leak: non-member read ${LEXICAL_LEAK_COUNT} lexical chunks" >&2
  exit 1
fi
echo "   smoke: non-member cannot read foreign project lexical chunks (RLS isolation OK)"

echo "==> smoke test: media library (phase F) + safe deletion + isolation"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_content uuid;
  v_media_a uuid;
  v_media_b uuid;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: demo project missing for media'; end if;
  select id into v_content from public.seo_content where slug = 'demo-article' and project_id = v_project limit 1;
  if v_content is null then raise exception 'smoke: demo content missing for media refs'; end if;

  insert into public.seo_media (project_id, filename, mime_type, size, storage_key, width, height, alt_text)
  values (v_project, 'Smoke image A.png', 'image/png', 123, 'p-smoke/smoke-a.png', 800, 600, 'Smoke alt')
  returning id into v_media_a;
  insert into public.seo_media (project_id, filename, mime_type, size, storage_key, width, height, alt_text)
  values (v_project, 'Smoke image B.webp', 'image/webp', 456, 'p-smoke/smoke-b.webp', 640, 480, '')
  returning id into v_media_b;
  if v_media_a is null or v_media_b is null then raise exception 'smoke: media rows were not created'; end if;

  if (select source from public.seo_media where id = v_media_a) <> 'upload' then
    raise exception 'smoke: media source default was not upload';
  end if;
  if (select source_meta from public.seo_media where id = v_media_a) <> '{}'::jsonb then
    raise exception 'smoke: media source_meta default was not an empty object';
  end if;
  begin
    update public.seo_media set source = 'remote_hotlink' where id = v_media_b;
    raise exception 'smoke: invalid media source was unexpectedly accepted';
  exception when check_violation then
    null;
  end;
  update public.seo_media
    set source = 'unsplash',
        source_meta = jsonb_build_object('provider', 'unsplash', 'sourceAssetId', 'abc123', 'author', 'Ada')
    where id = v_media_b;
  if (select source from public.seo_media where id = v_media_b) <> 'unsplash' then
    raise exception 'smoke: external media provenance was not recorded';
  end if;

  insert into public.seo_content_media (project_id, content_id, media_id) values (v_project, v_content, v_media_a);

  begin
    delete from public.seo_media where id = v_media_a;
    raise exception 'smoke: deleting referenced media unexpectedly allowed';
  exception when foreign_key_violation then
    null;
  end;

  delete from public.seo_media where id = v_media_b;
  if exists (select 1 from public.seo_media where id = v_media_b) then
    raise exception 'smoke: unreferenced media delete failed';
  end if;

  if not exists (select 1 from public.seo_media where id = v_media_a) then
    raise exception 'smoke: referenced media was deleted';
  end if;

  raise notice 'smoke: media lifecycle (referenced delete refused) OK';
end $$;
SQL

# RLS can only be exercised as a non-superuser role (superusers bypass RLS).
MEDIA_LEAK_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant usage on schema public to authenticated;
grant select on public.seo_media to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
select count(*) from public.seo_media where filename = 'Smoke image A.png';
SQL
)"
if [ -z "${MEDIA_LEAK_COUNT}" ] || [ "${MEDIA_LEAK_COUNT}" != "0" ]; then
  echo "!! RLS leak: non-member read ${MEDIA_LEAK_COUNT} rows from a foreign project media library" >&2
  exit 1
fi
echo "   smoke: non-member cannot read a foreign project media library (RLS isolation OK)"

PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_media_a uuid;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  select id into v_media_a from public.seo_media where filename = 'Smoke image A.png' limit 1;
  if v_media_a is null then raise exception 'smoke: referenced media A missing after ref delete test'; end if;

  delete from public.seo_content_media where media_id = v_media_a;
  delete from public.seo_media where id = v_media_a;
  if exists (select 1 from public.seo_media where id = v_media_a) then
    raise exception 'smoke: media delete after dereference failed';
  end if;

  raise notice 'smoke: media delete after dereference OK';
end $$;
SQL

echo "==> smoke test: property registry (stage 3)"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_acc uuid;
  v_prop uuid;
  v_project uuid;
  v_proj2 uuid;
begin
  select id into v_acc from public.seo_accounts where owner_user_id = '00000000-0000-0000-0000-000000000001';
  select id into v_prop from public.seo_gsc_properties where site_url = 'sc-domain:example.com' and account_id = v_acc limit 1;
  if v_prop is null then raise exception 'smoke: registry property missing'; end if;
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  select id into v_proj2 from public.seo_projects where slug = 'second-user-project' limit 1;

  if not exists (
    select 1 from public.seo_project_properties
    where project_id = v_project and property_id = v_prop and is_primary
  ) then raise exception 'smoke: project property link not backfilled as primary'; end if;

  begin
    insert into public.seo_gsc_properties (account_id, site_url, is_active)
    values (v_acc, 'sc-domain:example.com', true);
    raise exception 'smoke: duplicate registry site unexpectedly allowed';
  exception when unique_violation then
    null;
  end;

  begin
    insert into public.seo_project_properties (project_id, property_id, is_primary)
    values (v_proj2, v_prop, false);
    raise exception 'smoke: cross-project property link unexpectedly allowed';
  exception when unique_violation then
    null;
  end;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'seo_gsc_properties'
      and column_name in ('project_id', 'data_source_id')
  ) then raise exception 'smoke: legacy project-scoped property columns still present'; end if;

  raise notice 'smoke: property registry OK';
end $$;
SQL

echo "==> smoke test: account-scoped integrations (stage 4)"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_acc uuid;
  v_project uuid;
  v_account_gsc uuid;
begin
  select id into v_acc from public.seo_accounts where owner_user_id = '00000000-0000-0000-0000-000000000001';
  if v_acc is null then raise exception 'smoke: stage4 account missing'; end if;
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: stage4 project missing'; end if;

  -- A legacy project-scoped GSC integration can stay connected for the same
  -- account without colliding with the new account-scoped one.
  insert into public.seo_integrations (project_id, account_id, provider_type, name, status, created_by)
  values (v_project, v_acc, 'gsc', 'GSC legacy', 'connected', '00000000-0000-0000-0000-000000000001');

  -- Account-scoped connect: project_id NULL is accepted and account_id sticks.
  insert into public.seo_integrations (project_id, account_id, provider_type, name, status, created_by)
  values (null, v_acc, 'gsc', 'Google Search Console', 'connected', '00000000-0000-0000-0000-000000000001')
  returning id into v_account_gsc;
  if v_account_gsc is null then raise exception 'smoke: account-scoped integration was not created'; end if;
  if not exists (
    select 1 from public.seo_integrations where id = v_account_gsc and account_id = v_acc and project_id is null
  ) then raise exception 'smoke: account-scoped integration not attributed to the account'; end if;

  -- One active account-scoped connection per provider per account.
  begin
    insert into public.seo_integrations (account_id, provider_type, name, status, created_by)
    values (v_acc, 'gsc', 'GSC duplicate', 'connected', '00000000-0000-0000-0000-000000000001');
    raise exception 'smoke: duplicate account-scoped connection unexpectedly allowed';
  exception when unique_violation then
    null;
  end;

  -- An integration must resolve to a project or an account.
  begin
    insert into public.seo_integrations (provider_type, name, status)
    values ('gsc', 'Ownerless', 'disconnected');
    raise exception 'smoke: ownerless integration unexpectedly allowed';
  exception when check_violation then
    null;
  end;

  raise notice 'smoke: account-scoped integrations OK';
end $$;
SQL

echo "==> smoke test: content scheduling core (phase H1)"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_content uuid;
  v_publisher uuid;
  v_schedule uuid;
  v_job uuid;
  v_publication uuid;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: h1 project missing'; end if;
  select id into v_content from public.seo_content where slug = 'demo-article' and project_id = v_project limit 1;
  if v_content is null then raise exception 'smoke: h1 content missing'; end if;

  insert into public.seo_publishers (project_id, provider, name, status)
  values (v_project, 'wordpress', 'Smoke WP', 'connected')
  returning id into v_publisher;
  if v_publisher is null then raise exception 'smoke: h1 publisher was not created'; end if;

  insert into public.seo_sync_jobs (project_id, provider, job_type, params, run_after, idempotency_key, created_by)
  values (v_project, 'wordpress', 'publish', '{"publication_id":"00000000-0000-0000-0000-000000000000"}'::jsonb,
          now() + interval '1 hour', 'smoke-schedule:publish', '00000000-0000-0000-0000-000000000001')
  returning id into v_job;
  if v_job is null then raise exception 'smoke: h1 backing job was not created'; end if;

  begin
    insert into public.seo_sync_jobs (project_id, provider, job_type, idempotency_key)
    values (v_project, 'wordpress', 'publish', 'smoke-schedule:publish');
    raise exception 'smoke: duplicate idempotency key unexpectedly allowed';
  exception when unique_violation then
    null;
  end;

  insert into public.seo_schedules (project_id, content_id, publisher_id, scheduled_at, status, job_id, created_by)
  values (v_project, v_content, v_publisher, now() + interval '1 day', 'scheduled', v_job, '00000000-0000-0000-0000-000000000001')
  returning id into v_schedule;
  if v_schedule is null then raise exception 'smoke: h1 schedule row was not created'; end if;

  begin
    insert into public.seo_schedules (project_id, content_id, publisher_id, scheduled_at, status, created_by)
    values (v_project, v_content, v_publisher, now() + interval '2 days', 'bogus', '00000000-0000-0000-0000-000000000001');
    raise exception 'smoke: invalid schedule status unexpectedly allowed';
  exception when check_violation then
    null;
  end;

  insert into public.seo_publications (project_id, publisher_id, content_id, schedule_id, status, title, content, scheduled_for, created_by)
  values (v_project, v_publisher, v_content, v_schedule, 'scheduled', 'Demo article', '<p>Hello</p>', now() + interval '1 day',
          '00000000-0000-0000-0000-000000000001')
  returning id into v_publication;
  if v_publication is null then raise exception 'smoke: h1 publication was not created'; end if;
  if not exists (
    select 1 from public.seo_publications where id = v_publication and schedule_id = v_schedule
  ) then raise exception 'smoke: publication.schedule_id link missing'; end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'seo_publications' and column_name in ('content', 'excerpt', 'slug')
  ) then raise exception 'smoke: existing publication payload columns were removed'; end if;

  update public.seo_schedules set status = 'cancelled', cancelled_at = now() where id = v_schedule;
  if not exists (select 1 from public.seo_schedules where id = v_schedule and status = 'cancelled' and cancelled_at is not null) then
    raise exception 'smoke: h1 schedule cancellation transition failed';
  end if;

  raise notice 'smoke: content scheduling core OK';
end $$;
SQL

echo "==> smoke test: publish kind intent (phase H6.1)"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_content uuid;
  v_publisher uuid;
  v_schedule uuid;
  v_publication uuid;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  select id into v_content from public.seo_content where slug = 'demo-article' and project_id = v_project limit 1;
  select id into v_publisher from public.seo_publishers where name = 'Smoke WP' and project_id = v_project limit 1;
  if v_publisher is null then raise exception 'smoke: h6 publisher missing'; end if;

  -- Existing rows default to article (backwards compatible).
  select id into v_schedule from public.seo_schedules
  where project_id = v_project and content_id = v_content and publisher_id = v_publisher
  order by created_at desc limit 1;
  if v_schedule is null then raise exception 'smoke: h6 schedule row missing'; end if;
  if not exists (
    select 1 from public.seo_schedules where id = v_schedule and publish_kind = 'article'
  ) then raise exception 'smoke: schedule publish_kind did not default to article'; end if;
  select id into v_publication from public.seo_publications where schedule_id = v_schedule limit 1;
  if not exists (
    select 1 from public.seo_publications where id = v_publication and publish_kind = 'article'
  ) then raise exception 'smoke: publication publish_kind did not default to article'; end if;

  -- A text intent is accepted and stored (publish_text channels such as X).
  insert into public.seo_publications (project_id, publisher_id, content_id, status, title, content, publish_kind, created_by)
  values (v_project, v_publisher, v_content, 'queued', 'Text post demo', 'Short post', 'text',
          '00000000-0000-0000-0000-000000000001')
  returning id into v_publication;
  if not exists (
    select 1 from public.seo_publications where id = v_publication and publish_kind = 'text'
  ) then raise exception 'smoke: text publish_kind was not stored'; end if;

  -- Canonical vocabulary is enforced for schedules + publications.
  begin
    insert into public.seo_schedules (project_id, content_id, publisher_id, scheduled_at, status, publish_kind, created_by)
    values (v_project, v_content, v_publisher, now() + interval '2 days', 'scheduled', 'audio',
            '00000000-0000-0000-0000-000000000001');
    raise exception 'smoke: invalid schedule publish_kind unexpectedly allowed';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.seo_publications (project_id, publisher_id, content_id, status, title, publish_kind)
    values (v_project, v_publisher, v_content, 'queued', 'Bad kind', 'audio');
    raise exception 'smoke: invalid publication publish_kind unexpectedly allowed';
  exception when check_violation then
    null;
  end;

  raise notice 'smoke: publish kind intent OK';
end $$;
SQL

# RLS can only be exercised as a non-superuser role (superusers bypass RLS).
H1_LEAK_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant usage on schema public to authenticated;
grant select on public.seo_schedules to authenticated;
grant select on public.seo_content to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
select count(*) from public.seo_schedules s
join public.seo_content c on c.id = s.content_id
where c.slug = 'demo-article';
SQL
)"
if [ -z "${H1_LEAK_COUNT}" ] || [ "${H1_LEAK_COUNT}" != "0" ]; then
  echo "!! RLS leak: non-member read ${H1_LEAK_COUNT} rows from a foreign project schedule" >&2
  exit 1
fi
echo "   smoke: non-member cannot read a foreign project schedule (RLS isolation OK)"

echo "==> smoke test: durable writer runs (W7)"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_content uuid;
  v_run_id text;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: w7 project missing'; end if;
  select id into v_content from public.seo_content where slug = 'demo-article' and project_id = v_project limit 1;
  if v_content is null then raise exception 'smoke: w7 content missing'; end if;

  v_run_id := 'wr_' || gen_random_uuid()::text;

  insert into public.seo_writer_runs (run_id, project_id, content_id, user_id, status, state_json)
  values (v_run_id, v_project, v_content, '00000000-0000-0000-0000-000000000001', 'awaiting_approval',
          ( '{"runId":"' || v_run_id || '","status":"awaiting_approval"}' )::jsonb);

  if not exists (
    select 1 from public.seo_writer_runs
    where run_id = v_run_id and project_id = v_project and content_id = v_content
      and status = 'awaiting_approval'
  ) then raise exception 'smoke: w7 writer run row was not created'; end if;

  -- The run must inherit the project's (nullable) account automatically.
  if exists (
    select 1 from public.seo_writer_runs r
    join public.seo_projects p on p.id = r.project_id
    where r.run_id = v_run_id
      and p.account_id is distinct from r.account_id
  ) then raise exception 'smoke: w7 writer run account_id does not mirror the project'; end if;

  begin
    insert into public.seo_writer_runs (run_id, project_id, content_id, user_id, status)
    values (v_run_id, v_project, v_content, '00000000-0000-0000-0000-000000000001', 'awaiting_approval');
    raise exception 'smoke: duplicate writer run_id unexpectedly allowed';
  exception when unique_violation then
    null;
  end;

  begin
    insert into public.seo_writer_runs (run_id, project_id, content_id, user_id, status)
    values ('wr_' || gen_random_uuid()::text, v_project, v_content,
            '00000000-0000-0000-0000-000000000001', 'bogus');
    raise exception 'smoke: invalid writer run status unexpectedly allowed';
  exception when check_violation then
    null;
  end;

  update public.seo_writer_runs
  set status = 'completed', completed_at = now()
  where run_id = v_run_id;
  if not exists (
    select 1 from public.seo_writer_runs where run_id = v_run_id and status = 'completed' and completed_at is not null
  ) then raise exception 'smoke: w7 terminal writer run transition failed'; end if;

  -- W8: the lifecycle vocabulary is widened with the revision loop statuses
  -- (revising = async section rewrites, reviewing = synchronous re-review) and
  -- the revision counters are observable columns derived from state_json.
  update public.seo_writer_runs
  set status = 'revising'
  where run_id = v_run_id;
  if not exists (
    select 1 from public.seo_writer_runs where run_id = v_run_id and status = 'revising'
  ) then raise exception 'smoke: w8 revising status was not accepted'; end if;

  update public.seo_writer_runs
  set status = 'reviewing'
  where run_id = v_run_id;
  if not exists (
    select 1 from public.seo_writer_runs where run_id = v_run_id and status = 'reviewing'
  ) then raise exception 'smoke: w8 reviewing status was not accepted'; end if;

  update public.seo_writer_runs
  set status = 'review_ready', revision_count = 1, last_revision_at = now()
  where run_id = v_run_id;
  if not exists (
    select 1 from public.seo_writer_runs
    where run_id = v_run_id and status = 'review_ready' and revision_count = 1
      and last_revision_at is not null
  ) then raise exception 'smoke: w8 review_ready rest + revision counters failed'; end if;

  raise notice 'smoke: durable writer runs OK';
end $$;
SQL

W7_LEAK_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant select on public.seo_writer_runs to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
select count(*) from public.seo_writer_runs r
join public.seo_content c on c.id = r.content_id
where c.slug = 'demo-article';
SQL
)"
if [ -z "${W7_LEAK_COUNT}" ] || [ "${W7_LEAK_COUNT}" != "0" ]; then
  echo "!! RLS leak: non-member read ${W7_LEAK_COUNT} rows from a foreign project writer run" >&2
  exit 1
fi
echo "   smoke: non-member cannot read a foreign project writer run (RLS isolation OK)"

echo "==> smoke test: data source upsert is ON CONFLICT-usable (non-deferrable unique)"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_id uuid;
  v_deferrable boolean;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: data source upsert project missing'; end if;

  select condeferrable into v_deferrable
  from pg_constraint
  where conname = 'seo_data_sources_unique_external'
    and conrelid = 'public.seo_data_sources'::regclass;
  if v_deferrable is null then raise exception 'smoke: seo_data_sources unique constraint missing'; end if;
  if v_deferrable then raise exception 'smoke: seo_data_sources unique constraint is still deferrable'; end if;

  -- The exact upsert shape the GSC attach routes use must now succeed.
  insert into public.seo_data_sources
    (project_id, provider_type, kind, name, status, external_id, external_url, config, capabilities)
  values
    (v_project, 'gsc', 'gsc_property', 'https://www.example.com/', 'active',
     'https://www.example.com/', 'https://www.example.com/', '{}'::jsonb, '[]'::jsonb)
  on conflict (project_id, provider_type, external_id)
  do update set status = excluded.status, name = excluded.name
  returning id into v_id;
  if v_id is null then raise exception 'smoke: data source ON CONFLICT upsert returned no row'; end if;

  raise notice 'smoke: data source ON CONFLICT upsert OK';
end $$;
SQL

echo "==> smoke test: source snapshots (KW4.5) + unique scope + in-place refresh + isolation"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_id uuid;
  v_scope_key text := repeat('a', 64);
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: source snapshot project missing'; end if;

  insert into public.seo_source_snapshots (project_id, type, provider, scope, scope_key, data, fetched_at)
  values (v_project, 'competitor_discovery', 'dataforseo',
          '{"domain":"example.com","limit":20}'::jsonb, v_scope_key,
          '{"competitors":[{"domain":"rival.example"}],"total":1}'::jsonb,
          now() - interval '2 days')
  returning id into v_id;
  if v_id is null then raise exception 'smoke: source snapshot insert returned no row'; end if;

  -- Upsert on the canonical key refreshes the existing row in place; this table
  -- is current-best-known, not a history, so there must still be exactly one.
  insert into public.seo_source_snapshots (project_id, type, provider, scope, scope_key, data, fetched_at)
  values (v_project, 'competitor_discovery', 'dataforseo',
          '{"domain":"example.com","limit":20}'::jsonb, v_scope_key,
          '{"competitors":[{"domain":"rival.example"}],"total":2}'::jsonb, now())
  on conflict (project_id, type, scope_key)
  do update set data = excluded.data, fetched_at = excluded.fetched_at;
  if (select count(*) from public.seo_source_snapshots
      where project_id = v_project and type = 'competitor_discovery') <> 1
  then raise exception 'smoke: source snapshot upsert created a duplicate row'; end if;
  if not exists (select 1 from public.seo_source_snapshots
                 where id = v_id and (data ->> 'total') = '2'
                   and fetched_at > now() - interval '1 minute')
  then raise exception 'smoke: source snapshot upsert did not refresh in place'; end if;

  begin
    insert into public.seo_source_snapshots (project_id, type, provider, scope, scope_key, data)
    values (v_project, 'bogus_type', 'dataforseo', '{}'::jsonb, repeat('b', 64), '{}'::jsonb);
    raise exception 'smoke: invalid source snapshot type unexpectedly allowed';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.seo_source_snapshots (project_id, type, provider, scope, scope_key, data)
    values (v_project, 'competitor_gap', 'dataforseo', '{}'::jsonb, repeat('c', 63), '{}'::jsonb);
    raise exception 'smoke: short source snapshot scope_key unexpectedly allowed';
  exception when check_violation then
    null;
  end;

  raise notice 'smoke: source snapshots OK';
end $$;
SQL

SNAPSHOT_LEAK_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant select on public.seo_source_snapshots to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
select count(*) from public.seo_source_snapshots where scope_key = repeat('a', 64);
SQL
)"
if [ -z "${SNAPSHOT_LEAK_COUNT}" ] || [ "${SNAPSHOT_LEAK_COUNT}" != "0" ]; then
  echo "!! RLS leak: non-member read ${SNAPSHOT_LEAK_COUNT} rows from a foreign project source snapshot" >&2
  exit 1
fi
echo "   smoke: non-member cannot read a foreign project source snapshot (RLS isolation OK)"

echo "==> smoke test: durable agent runs (Phase 4.1) + idempotency scope + isolation"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_project2 uuid;
  v_run_id text;
  v_run2_id text;
  v_job uuid;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  select id into v_project2 from public.seo_projects where slug = 'second-user-project' limit 1;
  if v_project is null or v_project2 is null then raise exception 'smoke: agent run projects missing'; end if;

  v_run_id := 'ar_' || gen_random_uuid()::text;

  insert into public.seo_agent_runs
    (run_id, project_id, status, input_json, idempotency_key, created_by)
  values
    (v_run_id, v_project, 'queued',
     '{"mode":"plan","plan":{"version":1,"steps":[{"kind":"designer.review","criteria":["document_valid"]}]},"baseRevision":"rev1:abc"}'::jsonb,
     'smoke-agent-run', '00000000-0000-0000-0000-000000000001');

  if not exists (
    select 1 from public.seo_agent_runs where run_id = v_run_id and project_id = v_project and status = 'queued'
  ) then raise exception 'smoke: agent run row was not created'; end if;

  -- Account mirrors the project, exactly like writer runs.
  if exists (
    select 1 from public.seo_agent_runs r
    join public.seo_projects p on p.id = r.project_id
    where r.run_id = v_run_id and p.account_id is distinct from r.account_id
  ) then raise exception 'smoke: agent run account_id does not mirror the project'; end if;

  -- Duplicate run id is rejected.
  begin
    insert into public.seo_agent_runs (run_id, project_id, status, input_json)
    values (v_run_id, v_project, 'queued', '{}'::jsonb);
    raise exception 'smoke: duplicate agent run_id unexpectedly allowed';
  exception when unique_violation then null;
  end;

  -- Duplicate idempotency key within one project is rejected.
  begin
    insert into public.seo_agent_runs (run_id, project_id, status, input_json, idempotency_key)
    values ('ar_' || gen_random_uuid()::text, v_project, 'queued', '{}'::jsonb, 'smoke-agent-run');
    raise exception 'smoke: duplicate project idempotency key unexpectedly allowed';
  exception when unique_violation then null;
  end;

  -- The same key in another project is a different logical submission.
  v_run2_id := 'ar_' || gen_random_uuid()::text;
  insert into public.seo_agent_runs (run_id, project_id, status, input_json, idempotency_key)
  values (v_run2_id, v_project2, 'queued', '{}'::jsonb, 'smoke-agent-run');
  if not exists (
    select 1 from public.seo_agent_runs where run_id = v_run2_id and project_id = v_project2
  ) then raise exception 'smoke: project-scoped idempotency key was not accepted'; end if;

  -- Status vocabulary, kind vocabulary and run-id format are enforced.
  begin
    insert into public.seo_agent_runs (run_id, project_id, status, input_json)
    values ('ar_' || gen_random_uuid()::text, v_project, 'completed', '{}'::jsonb);
    raise exception 'smoke: invalid agent run status unexpectedly allowed';
  exception when check_violation then null;
  end;

  begin
    insert into public.seo_agent_runs (run_id, project_id, kind, status, input_json)
    values ('ar_' || gen_random_uuid()::text, v_project, 'audio', 'queued', '{}'::jsonb);
    raise exception 'smoke: invalid agent run kind unexpectedly allowed';
  exception when check_violation then null;
  end;

  begin
    insert into public.seo_agent_runs (run_id, project_id, status, input_json)
    values ('not-a-run-id', v_project, 'queued', '{}'::jsonb);
    raise exception 'smoke: malformed agent run_id unexpectedly allowed';
  exception when check_violation then null;
  end;

  -- The job association is explicit and one-way (run.job_id -> seo_sync_jobs).
  insert into public.seo_sync_jobs (project_id, provider, job_type, params, idempotency_key, created_by)
  values (v_project, 'designer', 'agent_design', '{}'::jsonb, 'smoke-agent-run-job',
          '00000000-0000-0000-0000-000000000001')
  returning id into v_job;
  update public.seo_agent_runs set job_id = v_job where run_id = v_run_id;
  if not exists (
    select 1 from public.seo_agent_runs where run_id = v_run_id and job_id = v_job
  ) then raise exception 'smoke: agent run job association failed'; end if;

  -- A terminal transition stores the failure facts.
  update public.seo_agent_runs
  set status = 'failed', error_json = '{"code":"planner_failed","message":"boom"}'::jsonb, completed_at = now()
  where run_id = v_run_id;
  if not exists (
    select 1 from public.seo_agent_runs
    where run_id = v_run_id and status = 'failed'
      and (error_json ->> 'code') = 'planner_failed' and completed_at is not null
  ) then raise exception 'smoke: agent run terminal failure facts were not stored'; end if;

  -- Deleting the backing job keeps the run (ON DELETE SET NULL).
  delete from public.seo_sync_jobs where id = v_job;
  if not exists (
    select 1 from public.seo_agent_runs where run_id = v_run_id and job_id is null
  ) then raise exception 'smoke: agent run did not survive job deletion'; end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'seo_agent_runs_idempotency_idx'
  ) then raise exception 'smoke: agent run idempotency index missing'; end if;

  raise notice 'smoke: durable agent runs OK';
end $$;
SQL

# RLS can only be exercised as a non-superuser role (superusers bypass RLS).
AGENT_RUN_LEAK_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant usage on schema public to authenticated;
grant select on public.seo_agent_runs to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
select count(*) from public.seo_agent_runs where created_by = '00000000-0000-0000-0000-000000000001';
SQL
)"
if [ -z "${AGENT_RUN_LEAK_COUNT}" ] || [ "${AGENT_RUN_LEAK_COUNT}" != "0" ]; then
  echo "!! RLS leak: non-member read ${AGENT_RUN_LEAK_COUNT} rows from a foreign project agent run" >&2
  exit 1
fi
echo "   smoke: non-member cannot read a foreign project agent run (RLS isolation OK)"

echo "==> smoke test: append-only usage ledger (R5.10.2) + idempotency scope + immutability + isolation"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_project2 uuid;
  v_account uuid;
  v_total bigint;
  v_groups int;
begin
  select id, account_id into v_project, v_account from public.seo_projects where slug = 'demo' limit 1;
  select id into v_project2 from public.seo_projects where slug = 'second-user-project' limit 1;
  if v_project is null or v_project2 is null or v_account is null then
    raise exception 'smoke: usage ledger projects missing';
  end if;

  -- A project-scoped event: the trigger mirrors the project's account.
  insert into public.seo_usage_events
    (project_id, user_id, category, provider, operation, quantity, unit, success, source_id, idempotency_key)
  values
    (v_project, '00000000-0000-0000-0000-000000000001', 'ai', 'openai', 'chat', 60,
     'input_token', true, 'smoke-usage-1', 'v1|ai|openai|chat|input_token|smoke-usage-1|0'),
    (v_project, '00000000-0000-0000-0000-000000000001', 'ai', 'openai', 'chat', 40,
     'output_token', true, 'smoke-usage-2', 'v1|ai|openai|chat|output_token|smoke-usage-2|0');

  if exists (
    select 1 from public.seo_usage_events e
    join public.seo_projects p on p.id = e.project_id
    where e.source_id = 'smoke-usage-1' and p.account_id is distinct from e.account_id
  ) then raise exception 'smoke: usage event account_id does not mirror the project'; end if;

  -- A worker-originated event: project scope, no acting user.
  insert into public.seo_usage_events
    (project_id, user_id, category, provider, operation, quantity, unit, success, source_id)
  values
    (v_project, null, 'job', 'worker', 'run', 1, 'job', true, 'smoke-usage-4');

  -- A Google Analytics request under the P4.5 vocabulary extension: the
  -- `google` category and `ga4_request` unit must be accepted.
  insert into public.seo_usage_events
    (project_id, user_id, category, provider, operation, quantity, unit, success, source_id)
  values
    (v_project, null, 'google', 'ga4', 'page_traffic', 1, 'ga4_request', true, 'smoke-usage-6');

  -- A Google Ads request under the P5 vocabulary extension: the `google`
  -- category and `ads_request` unit must be accepted.
  insert into public.seo_usage_events
    (project_id, user_id, category, provider, operation, quantity, unit, success, source_id)
  values
    (v_project, null, 'google', 'ads', 'search_terms', 1, 'ads_request', true, 'smoke-usage-7');

  -- An account-scoped event with no project.
  insert into public.seo_usage_events
    (account_id, user_id, category, provider, operation, quantity, unit, success, source_id, idempotency_key)
  values
    (v_account, '00000000-0000-0000-0000-000000000001', 'dataforseo', 'dataforseo', 'serp_live', 5,
     'serp_request', true, 'smoke-usage-3', 'v1|dataforseo|dataforseo|serp_live|serp_request|smoke-usage-3|0');

  -- Idempotency: a duplicate (project_id, key) is rejected ...
  begin
    insert into public.seo_usage_events
      (project_id, category, provider, operation, quantity, unit, success, idempotency_key)
    values
      (v_project, 'ai', 'openai', 'chat', 1, 'input_token', true,
       'v1|ai|openai|chat|input_token|smoke-usage-1|0');
    raise exception 'smoke: duplicate usage idempotency key unexpectedly allowed';
  exception when unique_violation then null;
  end;

  -- ... but the same key in another project is a different logical fact.
  insert into public.seo_usage_events
    (project_id, category, provider, operation, quantity, unit, success, idempotency_key)
  values
    (v_project2, 'ai', 'openai', 'chat', 1, 'input_token', true,
     'v1|ai|openai|chat|input_token|smoke-usage-1|0');
  if not exists (
    select 1 from public.seo_usage_events where project_id = v_project2
  ) then raise exception 'smoke: project-scoped usage key was not accepted'; end if;

  -- Account-scope duplicate is rejected too.
  begin
    insert into public.seo_usage_events
      (account_id, category, provider, operation, quantity, unit, success, idempotency_key)
    values
      (v_account, 'dataforseo', 'dataforseo', 'serp_live', 1, 'serp_request', true,
       'v1|dataforseo|dataforseo|serp_live|serp_request|smoke-usage-3|0');
    raise exception 'smoke: duplicate account usage idempotency key unexpectedly allowed';
  exception when unique_violation then null;
  end;

  -- A NULL idempotency key is never deduplicated.
  insert into public.seo_usage_events
    (project_id, category, provider, operation, quantity, unit, success, source_id)
  values (v_project, 'ai', 'openai', 'chat', 0, 'input_token', false, 'smoke-usage-5');
  insert into public.seo_usage_events
    (project_id, category, provider, operation, quantity, unit, success, source_id)
  values (v_project, 'ai', 'openai', 'chat', 0, 'input_token', false, 'smoke-usage-5');
  if (select count(*) from public.seo_usage_events where source_id = 'smoke-usage-5') <> 2 then
    raise exception 'smoke: null-key usage events were unexpectedly deduplicated';
  end if;

  -- Closed vocabulary + format + bounds are enforced.
  begin
    insert into public.seo_usage_events (project_id, category, provider, operation, unit, success)
    values (v_project, 'billing', 'openai', 'chat', 'request', true);
    raise exception 'smoke: invalid usage category unexpectedly allowed';
  exception when check_violation then null;
  end;

  begin
    insert into public.seo_usage_events (project_id, category, provider, operation, unit, success)
    values (v_project, 'ai', 'openai', 'chat', 'tokens', true);
    raise exception 'smoke: invalid usage unit unexpectedly allowed';
  exception when check_violation then null;
  end;

  begin
    insert into public.seo_usage_events (project_id, category, provider, operation, quantity, unit, success)
    values (v_project, 'ai', 'openai', 'chat', -1, 'request', true);
    raise exception 'smoke: negative usage quantity unexpectedly allowed';
  exception when check_violation then null;
  end;

  begin
    insert into public.seo_usage_events (project_id, category, provider, operation, unit, success)
    values (v_project, 'ai', 'Not Valid', 'chat', 'request', true);
    raise exception 'smoke: malformed usage provider unexpectedly allowed';
  exception when check_violation then null;
  end;

  begin
    insert into public.seo_usage_events (project_id, category, provider, operation, unit, success, metadata)
    values (v_project, 'ai', 'openai', 'chat', 'request', true, '[]'::jsonb);
    raise exception 'smoke: non-object usage metadata unexpectedly allowed';
  exception when check_violation then null;
  end;

  begin
    insert into public.seo_usage_events
      (project_id, category, provider, operation, unit, success, idempotency_key)
    values (v_project, 'ai', 'openai', 'chat', 'request', true, repeat('x', 513));
    raise exception 'smoke: oversized usage idempotency key unexpectedly allowed';
  exception when check_violation then null;
  end;

  -- Historical immutability is a schema property: every FK uses ON DELETE SET
  -- NULL ('n'), so deleting a project/account/user cannot erase usage evidence.
  if (select count(*) from pg_constraint
        where conrelid = 'public.seo_usage_events'::regclass and contype = 'f' and confdeltype = 'n') <> 3 then
    raise exception 'smoke: usage event foreign keys are not all ON DELETE SET NULL';
  end if;

  -- Append-only RLS: a SELECT-only policy, no write policies, and no updated_at.
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'seo_usage_events' and cmd = 'SELECT'
  ) then raise exception 'smoke: usage events select policy missing'; end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'seo_usage_events' and cmd <> 'SELECT'
  ) then raise exception 'smoke: usage events table has a non-select policy'; end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'seo_usage_events' and column_name = 'updated_at'
  ) then raise exception 'smoke: usage events table must not have updated_at'; end if;

  -- Aggregation RPC: fixed shape, membership enforced, raw ledger never returned.
  select coalesce(sum(quantity), 0), count(*) into v_total, v_groups
  from public.seo_usage_totals('00000000-0000-0000-0000-000000000001', v_project, null);
  if v_total <> 103 then raise exception 'smoke: usage project total was % not 103', v_total; end if;
  if v_groups < 2 then raise exception 'smoke: usage aggregate returned too few groups'; end if;

  select coalesce(sum(quantity), 0) into v_total
  from public.seo_usage_totals('00000000-0000-0000-0000-000000000001', null, v_account);
  if v_total <> 108 then raise exception 'smoke: usage account total was % not 108', v_total; end if;

  begin
    perform 1 from public.seo_usage_totals('00000000-0000-0000-0000-000000000002', v_project, null);
    raise exception 'smoke: non-member usage aggregate unexpectedly allowed';
  exception when insufficient_privilege then null;
  end;

  -- Only the service role may execute the aggregation RPC; browser roles cannot.
  if has_function_privilege('authenticated',
      'public.seo_usage_totals(uuid,uuid,uuid,timestamptz,timestamptz,text,text,text,text,boolean)', 'execute') then
    raise exception 'smoke: usage aggregate is executable by authenticated';
  end if;
  if not has_function_privilege('service_role',
      'public.seo_usage_totals(uuid,uuid,uuid,timestamptz,timestamptz,text,text,text,text,boolean)', 'execute') then
    raise exception 'smoke: usage aggregate is not executable by service_role';
  end if;

  raise notice 'smoke: append-only usage ledger OK';
end $$;
SQL

# RLS can only be exercised as a non-superuser role (superusers bypass RLS).
DEMO_PROJECT_ID="$(PSQL -d "${DB_NAME}" -t -A -c "select id from public.seo_projects where slug = 'demo' limit 1")"
USAGE_LEAK_COUNT="$(PSQL -d "${DB_NAME}" -v demo_project="${DEMO_PROJECT_ID}" -t -A <<'SQL'
grant usage on schema public to authenticated;
grant select on public.seo_usage_events to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
select count(*) from public.seo_usage_events where project_id = :'demo_project';
SQL
)"
if [ -z "${USAGE_LEAK_COUNT}" ] || [ "${USAGE_LEAK_COUNT}" != "0" ]; then
  echo "!! RLS leak: non-member read ${USAGE_LEAK_COUNT} usage rows from a foreign project" >&2
  exit 1
fi
echo "   smoke: non-member cannot read foreign project usage events (RLS isolation OK)"

USAGE_ACCOUNT_LEAK_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
select count(*) from public.seo_usage_events where project_id is null and account_id is not null;
SQL
)"
if [ -z "${USAGE_ACCOUNT_LEAK_COUNT}" ] || [ "${USAGE_ACCOUNT_LEAK_COUNT}" != "0" ]; then
  echo "!! RLS leak: non-member read ${USAGE_ACCOUNT_LEAK_COUNT} account-scoped usage rows" >&2
  exit 1
fi
echo "   smoke: non-owner cannot read foreign account usage events (RLS isolation OK)"

echo "==> smoke test: platform administration (phase 3) + authorization boundaries"
PSQL -d "${DB_NAME}" <<'SQL'
do $$
declare
  v_owner   uuid := '00000000-0000-0000-0000-000000000001';
  v_admin   uuid := '00000000-0000-0000-0000-000000000002';
  v_overview jsonb;
  v_users   int;
  v_rows    int;
begin
  -- Register one user as a platform administrator out of band. This is the only
  -- supported provisioning path - there is no self-service insert.
  insert into public.seo_platform_admins (user_id, created_by)
  values (v_admin, v_owner)
  on conflict (user_id) do nothing;

  if not public.seo_is_platform_admin(v_admin) then
    raise exception 'smoke: registered admin not recognized';
  end if;
  if public.seo_is_platform_admin(v_owner) then
    raise exception 'smoke: unregistered user recognized as platform admin';
  end if;

  -- The demo project owner is a legitimate project owner but not a platform
  -- admin; project roles never imply platform-admin access.
  begin
    perform public.seo_platform_admin_overview(v_owner);
    raise exception 'smoke: project owner was allowed a platform-admin read';
  exception when insufficient_privilege then null;
  end;

  -- A registered admin can read every operational view.
  v_overview := public.seo_platform_admin_overview(v_admin);
  if (v_overview->>'projects')::int < 1 then
    raise exception 'smoke: platform overview missing projects (%)', v_overview;
  end if;

  select count(*) into v_users from public.seo_platform_admin_users(v_admin);
  if v_users < 1 then raise exception 'smoke: platform-admin users read was empty'; end if;

  select count(*) into v_rows from public.seo_platform_admin_usage_totals(v_admin, null, null);
  if v_rows < 0 then raise exception 'smoke: platform-admin usage read failed'; end if;

  perform 1 from public.seo_platform_admin_jobs(v_admin, 5);
  perform 1 from public.seo_platform_admin_accounts(v_admin);
  perform 1 from public.seo_platform_admin_projects(v_admin);

  raise notice 'smoke: platform administration + authorization boundaries OK';
end $$;
SQL

# The registry and read RPCs are server-only: browser roles hold no access.
PSQL -d "${DB_NAME}" -t -A <<'SQL' >/dev/null
do $$
begin
  if has_table_privilege('authenticated', 'public.seo_platform_admins', 'select') then
    raise exception 'smoke: authenticated can read the platform-admin registry';
  end if;
  if has_table_privilege('anon', 'public.seo_platform_admins', 'insert') then
    raise exception 'smoke: anon can write the platform-admin registry';
  end if;
  if not has_table_privilege('service_role', 'public.seo_platform_admins', 'select') then
    raise exception 'smoke: service_role cannot read the platform-admin registry';
  end if;
  if has_function_privilege('authenticated', 'public.seo_platform_admin_overview(uuid)', 'execute') then
    raise exception 'smoke: authenticated can execute a platform-admin RPC';
  end if;
  if not has_function_privilege('service_role', 'public.seo_platform_admin_overview(uuid)', 'execute') then
    raise exception 'smoke: service_role cannot execute a platform-admin RPC';
  end if;
end $$;
SQL
echo "   smoke: platform-admin registry + RPCs are server-only"

echo "==> smoke test: Google Analytics project binding (phase 4) + RLS isolation"
PSQL -d "${DB_NAME}" <<'SQL'
do $$
declare
  v_project uuid;
  v_owner   uuid := '00000000-0000-0000-0000-000000000001';
  v_denied  boolean;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: demo project missing for analytics binding'; end if;

  -- Bind a real GA4 property to the project.
  insert into public.seo_project_analytics (project_id, property_id, property_name, property_url, created_by)
  values (v_project, '123456789', 'My Website', 'https://example.com', v_owner);

  if not exists (select 1 from public.seo_project_analytics where project_id = v_project and property_id = '123456789') then
    raise exception 'smoke: analytics binding was not stored';
  end if;

  -- Replacing the property upserts on the project primary key.
  insert into public.seo_project_analytics (project_id, property_id, property_name, created_by)
  values (v_project, '987654321', 'Renamed', v_owner)
  on conflict (project_id) do update
    set property_id = excluded.property_id, property_name = excluded.property_name;
  if (select property_id from public.seo_project_analytics where project_id = v_project) <> '987654321' then
    raise exception 'smoke: analytics property replacement failed';
  end if;

  -- One property per project: a second plain insert must conflict.
  v_denied := false;
  begin
    insert into public.seo_project_analytics (project_id, property_id, property_name)
    values (v_project, '555000111', 'Another');
  exception when unique_violation then v_denied := true; end;
  if not v_denied then raise exception 'smoke: a project was allowed two analytics properties'; end if;

  -- A non-numeric property id is rejected by the format check.
  v_denied := false;
  begin
    insert into public.seo_project_analytics (project_id, property_id, property_name)
    values (gen_random_uuid(), 'properties/1', 'bad');
  exception when check_violation then v_denied := true; end;
  if not v_denied then raise exception 'smoke: invalid analytics property id was accepted'; end if;

  raise notice 'smoke: analytics binding + replacement + format check OK';
end $$;
SQL

# RLS + write-privilege boundary: members may read, nobody may write via PostgREST.
ANALYTICS_MEMBER_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant usage on schema public to authenticated;
grant select on public.seo_project_analytics to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
select count(*) from public.seo_project_analytics;
SQL
)"
if [ -z "${ANALYTICS_MEMBER_COUNT}" ] || [ "${ANALYTICS_MEMBER_COUNT}" = "0" ]; then
  echo "!! RLS: project owner could not read the project analytics binding (${ANALYTICS_MEMBER_COUNT})" >&2
  exit 1
fi
echo "   smoke: project member can read the analytics binding (RLS OK)"

ANALYTICS_LEAK_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant usage on schema public to authenticated;
grant select on public.seo_project_analytics to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
select count(*) from public.seo_project_analytics;
SQL
)"
if [ -z "${ANALYTICS_LEAK_COUNT}" ] || [ "${ANALYTICS_LEAK_COUNT}" != "0" ]; then
  echo "!! RLS leak: non-member read ${ANALYTICS_LEAK_COUNT} analytics bindings" >&2
  exit 1
fi
echo "   smoke: non-member cannot read a foreign analytics binding (RLS isolation OK)"

PSQL -d "${DB_NAME}" -t -A <<'SQL' >/dev/null
do $$
declare
  v_write_policies int;
begin
  -- The API/worker write with the service role; there is deliberately no
  -- insert/update/delete policy, so browser/PostgREST traffic can never write
  -- an analytics binding (only the SELECT policy exists).
  select count(*) into v_write_policies
  from pg_policies
  where tablename = 'seo_project_analytics' and cmd in ('INSERT', 'UPDATE', 'DELETE');
  if v_write_policies <> 0 then
    raise exception 'smoke: analytics binding has a write policy (%)', v_write_policies;
  end if;
  if has_table_privilege('authenticated', 'public.seo_project_analytics', 'insert') then
    raise exception 'smoke: authenticated can insert an analytics binding';
  end if;
  if has_table_privilege('authenticated', 'public.seo_project_analytics', 'update') then
    raise exception 'smoke: authenticated can update an analytics binding';
  end if;
end $$;
SQL
echo "   smoke: analytics bindings are server-write only (read-only RLS OK)"

echo "==> smoke test: Google Ads project binding (phase 5) + RLS isolation"
PSQL -d "${DB_NAME}" <<'SQL'
do $$
declare
  v_project uuid;
  v_owner   uuid := '00000000-0000-0000-0000-000000000001';
  v_denied  boolean;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: demo project missing for ads binding'; end if;

  -- Bind a real Google Ads customer to the project.
  insert into public.seo_project_ads (project_id, customer_id, customer_name, currency_code, login_customer_id, created_by)
  values (v_project, '1234567890', 'Acme Ads', 'USD', null, v_owner);

  if not exists (select 1 from public.seo_project_ads where project_id = v_project and customer_id = '1234567890') then
    raise exception 'smoke: ads binding was not stored';
  end if;

  -- Replacing the customer upserts on the project primary key.
  insert into public.seo_project_ads (project_id, customer_id, customer_name, created_by)
  values (v_project, '9998887776', 'Renamed', v_owner)
  on conflict (project_id) do update
    set customer_id = excluded.customer_id, customer_name = excluded.customer_name;
  if (select customer_id from public.seo_project_ads where project_id = v_project) <> '9998887776' then
    raise exception 'smoke: ads customer replacement failed';
  end if;

  -- One customer per project: a second plain insert must conflict.
  v_denied := false;
  begin
    insert into public.seo_project_ads (project_id, customer_id, customer_name)
    values (v_project, '5550001112', 'Another');
  exception when unique_violation then v_denied := true; end;
  if not v_denied then raise exception 'smoke: a project was allowed two ads customers'; end if;

  -- A malformed customer id is rejected by the format check.
  v_denied := false;
  begin
    insert into public.seo_project_ads (project_id, customer_id, customer_name)
    values (gen_random_uuid(), 'customers/1', 'bad');
  exception when check_violation then v_denied := true; end;
  if not v_denied then raise exception 'smoke: invalid ads customer id was accepted'; end if;

  raise notice 'smoke: ads binding + replacement + format check OK';
end $$;
SQL

# RLS + write-privilege boundary: members may read, nobody may write via PostgREST.
ADS_MEMBER_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant usage on schema public to authenticated;
grant select on public.seo_project_ads to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
select count(*) from public.seo_project_ads;
SQL
)"
if [ -z "${ADS_MEMBER_COUNT}" ] || [ "${ADS_MEMBER_COUNT}" = "0" ]; then
  echo "!! RLS: project owner could not read the project ads binding (${ADS_MEMBER_COUNT})" >&2
  exit 1
fi
echo "   smoke: project member can read the ads binding (RLS OK)"

ADS_LEAK_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant usage on schema public to authenticated;
grant select on public.seo_project_ads to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
select count(*) from public.seo_project_ads;
SQL
)"
if [ -z "${ADS_LEAK_COUNT}" ] || [ "${ADS_LEAK_COUNT}" != "0" ]; then
  echo "!! RLS leak: non-member read ${ADS_LEAK_COUNT} ads bindings" >&2
  exit 1
fi
echo "   smoke: non-member cannot read a foreign ads binding (RLS isolation OK)"

PSQL -d "${DB_NAME}" -t -A <<'SQL' >/dev/null
do $$
declare
  v_write_policies int;
begin
  -- The API/worker write with the service role; there is deliberately no
  -- insert/update/delete policy, so browser/PostgREST traffic can never write
  -- an ads binding (only the SELECT policy exists).
  select count(*) into v_write_policies
  from pg_policies
  where tablename = 'seo_project_ads' and cmd in ('INSERT', 'UPDATE', 'DELETE');
  if v_write_policies <> 0 then
    raise exception 'smoke: ads binding has a write policy (%)', v_write_policies;
  end if;
  if has_table_privilege('authenticated', 'public.seo_project_ads', 'insert') then
    raise exception 'smoke: authenticated can insert an ads binding';
  end if;
  if has_table_privilege('authenticated', 'public.seo_project_ads', 'update') then
    raise exception 'smoke: authenticated can update an ads binding';
  end if;
end $$;
SQL
echo "   smoke: ads bindings are server-write only (read-only RLS OK)"

echo "==> smoke test: RLS hardening (creator backdoor + definer grants)"
PSQL -d "${DB_NAME}" <<'SQL'
do $$
declare
  v_project uuid;
begin
  -- A project whose creator is user 0002, then that creator is removed from
  -- the roster entirely (user 0001 is left as the sole owner).
  insert into public.seo_projects (name, slug, created_by)
  values ('Edge project', 'edge-project', '00000000-0000-0000-0000-000000000002')
  returning id into v_project;

  insert into public.seo_project_members (project_id, user_id, role)
  values (v_project, '00000000-0000-0000-0000-000000000001', 'owner')
  on conflict (project_id, user_id) do nothing;

  delete from public.seo_project_members
  where project_id = v_project and user_id = '00000000-0000-0000-0000-000000000002';

  if exists (select 1 from public.seo_project_members where project_id = v_project and user_id = '00000000-0000-0000-0000-000000000002') then
    raise exception 'smoke: creator membership was not removed';
  end if;
end $$;
SQL

CREATOR_LEAK_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant usage on schema public to authenticated;
grant select on public.seo_projects to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
select count(*) from public.seo_projects where slug = 'edge-project';
SQL
)"
if [ -z "${CREATOR_LEAK_COUNT}" ] || [ "${CREATOR_LEAK_COUNT}" != "0" ]; then
  echo "!! RLS: removed creator still reads the project (${CREATOR_LEAK_COUNT})" >&2
  exit 1
fi
echo "   smoke: a removed creator loses project access (created_by backdoor closed)"

PSQL -d "${DB_NAME}" -t -A <<'SQL' >/dev/null
do $$
begin
  if has_function_privilege('anon', 'public.seo_is_member(uuid, uuid)', 'execute') then
    raise exception 'smoke: anon can execute seo_is_member';
  end if;
  if not has_function_privilege('authenticated', 'public.seo_is_member(uuid, uuid)', 'execute') then
    raise exception 'smoke: authenticated lost execute on seo_is_member (RLS would break)';
  end if;
  if not has_function_privilege('authenticated', 'public.seo_has_role(uuid, text[])', 'execute') then
    raise exception 'smoke: authenticated lost execute on seo_has_role (RLS would break)';
  end if;
  if not has_function_privilege('authenticated', 'public.seo_account_id_for_user(uuid)', 'execute') then
    raise exception 'smoke: authenticated lost execute on seo_account_id_for_user (RLS would break)';
  end if;
  if has_function_privilege('authenticated', 'public.seo_ensure_account(uuid)', 'execute') then
    raise exception 'smoke: authenticated can execute seo_ensure_account';
  end if;
  if not has_function_privilege('service_role', 'public.seo_ensure_account(uuid)', 'execute') then
    raise exception 'smoke: service_role cannot execute seo_ensure_account';
  end if;
end $$;
SQL
echo "   smoke: definer grants are least-privilege (RLS helpers intact, write helper revoked)"

echo "==> smoke test: data-integrity hardening (S12/S13/S15/S16)"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_p1 uuid;
  v_p2 uuid;
  v_content1 uuid;
  v_media2 uuid;
begin
  select id into v_p1 from public.seo_projects where slug = 'demo' limit 1;
  select id into v_p2 from public.seo_projects where slug = 'second-user-project' limit 1;
  if v_p1 is null or v_p2 is null then raise exception 'smoke: S13 projects missing'; end if;
  select id into v_content1 from public.seo_content where project_id = v_p1 limit 1;
  if v_content1 is null then raise exception 'smoke: S13 content missing'; end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'seo_content_media'
      and column_name = 'project_id' and is_nullable = 'YES'
  ) then raise exception 'smoke: S13 seo_content_media.project_id is still nullable'; end if;

  insert into public.seo_media (project_id, filename, mime_type, size, storage_key)
  values (v_p2, 'Foreign media.png', 'image/png', 10, v_p2::text || '/foreign.png')
  returning id into v_media2;
  if v_media2 is null then raise exception 'smoke: S13 foreign media not created'; end if;

  -- A project-1 content row cannot be recorded under project 2.
  begin
    insert into public.seo_content_media (project_id, content_id, media_id)
    values (v_p2, v_content1, v_media2);
    raise exception 'smoke: S13 cross-project content link unexpectedly allowed';
  exception when foreign_key_violation then
    null;
  end;

  -- A project-2 media row cannot be linked from project 1.
  begin
    insert into public.seo_content_media (project_id, content_id, media_id)
    values (v_p1, v_content1, v_media2);
    raise exception 'smoke: S13 cross-project media link unexpectedly allowed';
  exception when foreign_key_violation then
    null;
  end;

  raise notice 'smoke: content<->media links are project-bound (S13) OK';
end $$;
SQL

PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_job1 uuid;
  v_job2 uuid;
  v_audit int;
begin
  -- S12: deleting a project with child rows succeeds and keeps the audit trail.
  insert into public.seo_projects (name, slug, created_by)
  values ('Teardown project', 'teardown-project', '00000000-0000-0000-0000-000000000001')
  returning id into v_project;
  insert into public.seo_content (project_id, title, slug)
  values (v_project, 'Teardown article', 'teardown-article');

  delete from public.seo_projects where id = v_project;
  if exists (select 1 from public.seo_projects where id = v_project) then
    raise exception 'smoke: S12 project delete failed';
  end if;

  select count(*) into v_audit from public.seo_audit_logs
  where action = 'delete' and entity_type = 'seo_projects' and entity_id = v_project::text and project_id is null;
  if v_audit < 1 then raise exception 'smoke: S12 audit trail for the deleted project was lost'; end if;

  -- S15: the same idempotency key is independent per project.
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  insert into public.seo_sync_jobs (project_id, provider, job_type, idempotency_key)
  values (v_project, 'wordpress', 'publish', 'cross-project-idem') returning id into v_job1;
  insert into public.seo_sync_jobs (project_id, provider, job_type, idempotency_key)
  values ((select id from public.seo_projects where slug = 'second-user-project' limit 1), 'wordpress', 'publish', 'cross-project-idem')
  returning id into v_job2;
  if v_job1 is null or v_job2 is null then
    raise exception 'smoke: S15 per-project idempotency key collided across projects';
  end if;

  begin
    insert into public.seo_sync_jobs (project_id, provider, job_type, idempotency_key)
    values (v_project, 'wordpress', 'publish', 'cross-project-idem');
    raise exception 'smoke: S15 duplicate per-project idempotency key unexpectedly allowed';
  exception when unique_violation then
    null;
  end;

  raise notice 'smoke: project delete + audit trail + per-project idempotency (S12/S15) OK';
end $$;
SQL

PSQL -d "${DB_NAME}" -t -A <<'SQL' >/dev/null
do $$
begin
  -- S16: usage totals is service-role only.
  if has_function_privilege('authenticated', 'public.seo_usage_totals(uuid, uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean)', 'execute') then
    raise exception 'smoke: S16 authenticated can execute seo_usage_totals';
  end if;
  if has_function_privilege('anon', 'public.seo_usage_totals(uuid, uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean)', 'execute') then
    raise exception 'smoke: S16 anon can execute seo_usage_totals';
  end if;
  if not has_function_privilege('service_role', 'public.seo_usage_totals(uuid, uuid, uuid, timestamptz, timestamptz, text, text, text, text, boolean)', 'execute') then
    raise exception 'smoke: S16 service_role lost execute on seo_usage_totals';
  end if;
end $$;
SQL
echo "   smoke: usage totals is service-role only (S16 OK)"

# ---------------------------------------------------------------------------
# P1 hardening: RLS isolation matrix.
#
# The checks above exercise leakage for a handful of tables. This section is
# systematic: it enumerates every public seo_* table that carries a project_id
# from the catalog (never a hard-coded list), grants the browser roles the same
# table privileges Supabase grants by default, and asserts an unrelated
# authenticated user and anon read zero rows of the demo project from each. A
# permission error is NOT treated as isolation - the grants are in place, so a
# failure to run is a failure of the harness, not evidence of safety. Focused
# write-denial and platform-admin checks follow.
# ---------------------------------------------------------------------------

echo "==> smoke test: RLS coverage for every seo_* table"
PSQL -d "${DB_NAME}" -t -A <<'SQL' >/dev/null
do $$
declare
  v_missing text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
    and c.relname like 'seo\_%'
    and not c.relrowsecurity;
  if v_missing is not null then
    raise exception 'smoke: seo_* tables without RLS enabled: %', v_missing;
  end if;
end $$;
SQL
echo "   smoke: every seo_* table has RLS enabled"

DEMO_PROJECT_ID="$(PSQL -d "${DB_NAME}" -t -A -c "select id from public.seo_projects where slug = 'demo' limit 1")"
if [ -z "${DEMO_PROJECT_ID}" ]; then
  echo "!! RLS matrix: demo project id not found" >&2
  exit 1
fi

# Browser roles get the table privileges, so a leak can only come from a policy.
PSQL -d "${DB_NAME}" -t -A <<'SQL' >/dev/null
grant usage on schema public to authenticated, anon;
do $$
declare
  t text;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname like 'seo\_%'
      and exists (
        select 1 from information_schema.columns col
        where col.table_schema = 'public'
          and col.table_name = c.relname
          and col.column_name = 'project_id'
      )
  loop
    execute format('grant select on public.%I to authenticated, anon', t);
  end loop;
end $$;
SQL

PSQL -d "${DB_NAME}" -v ON_ERROR_STOP=1 -t -A <<'SQL' >/dev/null
do $$
declare
  v_demo uuid;
  v_table record;
  v_n bigint;
  v_count int := 0;
begin
  select id into v_demo from public.seo_projects where slug = 'demo' limit 1;
  if v_demo is null then
    raise exception 'smoke: demo project id not found';
  end if;

  for v_table in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname like 'seo\_%'
      and exists (
        select 1 from information_schema.columns col
        where col.table_schema = 'public'
          and col.table_name = c.relname
          and col.column_name = 'project_id'
      )
    order by c.relname
  loop
    -- An unrelated authenticated principal must have the policy evaluate and
    -- deny: exactly zero rows, never a permission error (the helper grants are
    -- in place for `authenticated`, so an error here is a real regression).
    execute 'set local role authenticated';
    execute 'set local request.jwt.claims = ''{"sub":"00000000-0000-0000-0000-000000000002"}''';
    execute format('select count(*) from public.%I where project_id = %L', v_table.relname, v_demo) into v_n;
    execute 'reset role';
    if v_n <> 0 then
      raise exception 'smoke: RLS leak in % for authenticated non-member (%)', v_table.relname, v_n;
    end if;

    -- anon is denied either by returning zero rows or by a hard permission
    -- denial (the membership helpers are authenticated-only, so policy
    -- evaluation itself raises insufficient_privilege). Both are denials; any
    -- other error is a harness/migration failure and propagates.
    begin
      execute 'set local role anon';
      execute 'set local request.jwt.claims = ''{"sub":null}''';
      execute format('select count(*) from public.%I where project_id = %L', v_table.relname, v_demo) into v_n;
      execute 'reset role';
      if v_n <> 0 then
        raise exception 'smoke: RLS leak in % for anon (%)', v_table.relname, v_n;
      end if;
    exception
      when insufficient_privilege then
        execute 'reset role';
    end;

    v_count := v_count + 1;
  end loop;

  raise notice 'smoke: % project-scoped seo_* tables deny foreign reads (authenticated + anon)', v_count;
end $$;
SQL
echo "   smoke: every project-scoped seo_* table denies foreign reads (authenticated + anon)"

echo "==> smoke test: focused RLS write denial + deny-all tables"
PSQL -d "${DB_NAME}" -t -A -v pid="${DEMO_PROJECT_ID}" <<'SQL' >/dev/null
grant select, insert, update, delete on public.seo_content to authenticated;
grant select, insert, update, delete on public.seo_media to authenticated;
grant select, insert, update, delete on public.seo_sync_jobs to authenticated;
grant select, insert, update, delete on public.seo_publications to authenticated;
grant select, insert, update, delete on public.seo_integrations to authenticated;
grant select, insert, update, delete on public.seo_api_keys to authenticated;
grant select, insert, update, delete on public.seo_audit_logs to authenticated;
grant select on public.seo_credentials to authenticated;
select set_config('smoke.demo_project', :'pid', false);
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
do $$
declare
  v_demo uuid := current_setting('smoke.demo_project')::uuid;
  v_n int;
begin
  -- content: no read, no update, no delete, no insert into a foreign project.
  select count(*) into v_n from public.seo_content where project_id = v_demo;
  if v_n <> 0 then raise exception 'smoke: foreign content is readable (%)', v_n; end if;
  update public.seo_content set id = id where project_id = v_demo;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'smoke: foreign content is updatable'; end if;
  delete from public.seo_content where project_id = v_demo;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'smoke: foreign content is deletable'; end if;
  begin
    insert into public.seo_content (project_id, title, slug) values (v_demo, 'tampered', 'tampered');
    raise exception 'smoke: foreign content insert was allowed';
  exception when insufficient_privilege then null;
  end;

  -- server-written tables: member-read only, so a non-member gets nothing and
  -- cannot mutate the rows through the browser role.
  select count(*) into v_n from public.seo_sync_jobs where project_id = v_demo;
  if v_n <> 0 then raise exception 'smoke: foreign sync jobs are readable (%)', v_n; end if;
  update public.seo_sync_jobs set id = id where project_id = v_demo;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'smoke: foreign sync jobs are updatable'; end if;

  select count(*) into v_n from public.seo_publications where project_id = v_demo;
  if v_n <> 0 then raise exception 'smoke: foreign publications are readable (%)', v_n; end if;
  update public.seo_publications set id = id where project_id = v_demo;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'smoke: foreign publications are updatable'; end if;

  select count(*) into v_n from public.seo_integrations where project_id = v_demo;
  if v_n <> 0 then raise exception 'smoke: foreign integrations are readable (%)', v_n; end if;
  update public.seo_integrations set id = id where project_id = v_demo;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'smoke: foreign integrations are updatable'; end if;

  -- api keys: owner/admin only, so a foreign owner cannot read or revoke.
  select count(*) into v_n from public.seo_api_keys where project_id = v_demo;
  if v_n <> 0 then raise exception 'smoke: foreign api keys are readable (%)', v_n; end if;
  delete from public.seo_api_keys where project_id = v_demo;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'smoke: foreign api keys are deletable'; end if;

  -- audit logs: a non-member reads nothing.
  select count(*) into v_n from public.seo_audit_logs where project_id = v_demo;
  if v_n <> 0 then raise exception 'smoke: foreign audit logs are readable (%)', v_n; end if;

  -- credentials are deny-all: even a broad select grant returns no rows.
  select count(*) into v_n from public.seo_credentials where true;
  if v_n <> 0 then raise exception 'smoke: credentials are directly readable (%)', v_n; end if;

  raise notice 'smoke: focused RLS write + deny-all checks OK';
end $$;
SQL
echo "   smoke: focused RLS write denial + deny-all tables OK"

echo "==> smoke test: platform-admin trust boundary in policy definitions"
PSQL -d "${DB_NAME}" -t -A <<'SQL' >/dev/null
do $$
declare
  v_bad text;
begin
  -- The platform-admin helper is a service-role RPC boundary, never a table
  -- policy; no policy anywhere may reference it.
  select string_agg(format('%s.%s', p.schemaname, p.policyname), ', ' order by p.policyname)
    into v_bad
  from pg_policies p
  where p.schemaname = 'public'
    and (
      coalesce(p.qual, '') like '%seo_is_platform_admin%'
      or coalesce(p.with_check, '') like '%seo_is_platform_admin%'
    );
  if v_bad is not null then
    raise exception 'smoke: platform-admin helper referenced by table policy: %', v_bad;
  end if;

  -- No project-scoped customer table may have a blanket permissive policy:
  -- `USING (true)` would bypass membership even though RLS is enabled.
  select string_agg(format('%s.%s', p.schemaname, p.policyname), ', ' order by p.policyname)
    into v_bad
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename like 'seo\_%'
    and (
      btrim(coalesce(p.qual, '')) in ('true', '(true)')
      or btrim(coalesce(p.with_check, '')) in ('true', '(true)')
    )
    and exists (
      select 1 from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = p.tablename
        and c.column_name = 'project_id'
    );
  if v_bad is not null then
    raise exception 'smoke: permissive policy on a project-scoped table: %', v_bad;
  end if;

  -- The helper itself stays service-role only.
  if has_function_privilege('authenticated', 'public.seo_is_platform_admin(uuid)', 'execute') then
    raise exception 'smoke: authenticated can execute seo_is_platform_admin';
  end if;
  if has_function_privilege('anon', 'public.seo_is_platform_admin(uuid)', 'execute') then
    raise exception 'smoke: anon can execute seo_is_platform_admin';
  end if;
  if not has_function_privilege('service_role', 'public.seo_is_platform_admin(uuid)', 'execute') then
    raise exception 'smoke: service_role cannot execute seo_is_platform_admin';
  end if;
end $$;
SQL
echo "   smoke: platform-admin boundary holds (no policies, no permissive USING true, RPCs service-role only)"

echo "==> smoke test: persisted GA4 page traffic (P7) + RLS isolation"
PSQL -d "${DB_NAME}" <<'SQL'
do $$
declare
  v_project uuid;
  v_denied  boolean;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: demo project missing for page traffic'; end if;

  insert into public.seo_page_traffic (project_id, property_id, date, path, views, active_users, sessions)
  values (v_project, '123456789', '2026-09-10', '/blog/seo-guide', 300, 250, 280);

  -- Re-sync overwrites the same natural key (GA4 is authoritative for a date).
  insert into public.seo_page_traffic (project_id, property_id, date, path, views, active_users, sessions)
  values (v_project, '123456789', '2026-09-10', '/blog/seo-guide', 400, 260, 300)
  on conflict (project_id, property_id, date, path) do update
    set views = excluded.views, active_users = excluded.active_users, sessions = excluded.sessions;
  if (select views from public.seo_page_traffic where project_id = v_project and path = '/blog/seo-guide') <> 400 then
    raise exception 'smoke: page traffic re-sync did not overwrite';
  end if;

  -- Negative metrics are rejected.
  v_denied := false;
  begin
    insert into public.seo_page_traffic (project_id, property_id, date, path, views)
    values (v_project, '123456789', '2026-09-11', '/bad', -1);
  exception when check_violation then v_denied := true; end;
  if not v_denied then raise exception 'smoke: negative page-traffic views accepted'; end if;

  -- A non-numeric GA4 property id is rejected by the format check.
  v_denied := false;
  begin
    insert into public.seo_page_traffic (project_id, property_id, date, path)
    values (v_project, 'properties/1', '2026-09-11', '/bad');
  exception when check_violation then v_denied := true; end;
  if not v_denied then raise exception 'smoke: invalid page-traffic property id accepted'; end if;

  raise notice 'smoke: page traffic upsert + checks OK';
end $$;
SQL

PAGE_TRAFFIC_MEMBER_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant usage on schema public to authenticated;
grant select on public.seo_page_traffic to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
select count(*) from public.seo_page_traffic;
SQL
)"
if [ -z "${PAGE_TRAFFIC_MEMBER_COUNT}" ] || [ "${PAGE_TRAFFIC_MEMBER_COUNT}" = "0" ]; then
  echo "!! RLS: project owner could not read page traffic (${PAGE_TRAFFIC_MEMBER_COUNT})" >&2
  exit 1
fi
echo "   smoke: project member can read page traffic (RLS OK)"

PAGE_TRAFFIC_LEAK_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<'SQL'
grant usage on schema public to authenticated;
grant select on public.seo_page_traffic to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000002"}';
select count(*) from public.seo_page_traffic;
SQL
)"
if [ -z "${PAGE_TRAFFIC_LEAK_COUNT}" ] || [ "${PAGE_TRAFFIC_LEAK_COUNT}" != "0" ]; then
  echo "!! RLS leak: non-member read ${PAGE_TRAFFIC_LEAK_COUNT} page-traffic rows" >&2
  exit 1
fi
echo "   smoke: non-member cannot read foreign page traffic (RLS isolation OK)"

# ---------------------------------------------------------------------------
# Resource protection (P9): atomic queue admission, release/retry semantics,
# account-level bounding, repeated-request ceiling, and deny-all operational
# tables. Uses fresh accounts so earlier smoke-run jobs cannot influence counts.
# ---------------------------------------------------------------------------

echo "==> smoke test: resource protection (P9) + atomic queue admission"

rp_create_project() {
  local rp_user="$1" rp_name="$2" rp_slug="$3"
  PSQL -d "${DB_NAME}" <<SQL >/dev/null
set request.jwt.claims = '{"sub":"${rp_user}","email":"${rp_slug}@example.com"}';
insert into auth.users (id, email) values ('${rp_user}', '${rp_slug}@example.com') on conflict (id) do nothing;
select public.seo_create_project('${rp_name}', '${rp_slug}', 'https://${rp_slug}.example', 'p9 resource smoke');
SQL
}

rp_create_project '00000000-0000-0000-0000-0000000000a1' 'RP alpha' 'rp-alpha'
rp_create_project '00000000-0000-0000-0000-0000000000a1' 'RP beta' 'rp-beta'
rp_create_project '00000000-0000-0000-0000-0000000000c1' 'RP rate' 'rp-rate'
rp_create_project '00000000-0000-0000-0000-0000000000d1' 'RP concurrency' 'rp-conc'

PSQL -d "${DB_NAME}" <<'SQL'
do $$
declare
  v_a uuid; v_b uuid; v_acc uuid;
  v_id uuid; v_count int;
  v_denied boolean; v_code text;
begin
  select id, account_id into v_a, v_acc from public.seo_projects where slug = 'rp-alpha';
  select id into v_b from public.seo_projects where slug = 'rp-beta';
  if v_a is null or v_b is null then raise exception 'p9: projects missing'; end if;
  if (select account_id from public.seo_projects where id = v_b) is distinct from v_acc then
    raise exception 'p9: sibling projects not on the same account';
  end if;
  if (select count(*) from public.seo_resource_limits) < 6 then
    raise exception 'p9: resource limits were not seeded';
  end if;

  -- (1) Project queued ceiling enforced with the SE001 SQLSTATE.
  update public.seo_resource_limits set max_value = 2 where scope = 'project' and resource = 'jobs_queued';
  insert into public.seo_sync_jobs (project_id, provider, job_type) values (v_a, 'wordpress', 'publish');
  insert into public.seo_sync_jobs (project_id, provider, job_type) values (v_a, 'wordpress', 'publish');
  v_denied := false; v_code := null;
  begin
    insert into public.seo_sync_jobs (project_id, provider, job_type) values (v_a, 'wordpress', 'publish');
  exception when others then v_denied := true; v_code := sqlstate; end;
  if not v_denied or v_code <> 'SE001' then
    raise exception 'p9: project queue ceiling not enforced (denied=%, sqlstate=%)', v_denied, v_code;
  end if;

  -- (2) Cancelling a queued job releases capacity.
  select id into v_id from public.seo_sync_jobs where project_id = v_a and status = 'queued' order by queued_at limit 1;
  update public.seo_sync_jobs set status = 'canceled', completed_at = now() where id = v_id;
  insert into public.seo_sync_jobs (project_id, provider, job_type) values (v_a, 'wordpress', 'publish');
  select count(*) into v_count from public.seo_sync_jobs where project_id = v_a and status = 'queued';
  if v_count <> 2 then raise exception 'p9: release did not free capacity (queued=%)', v_count; end if;

  -- (2b) A retry requeues with an UPDATE, so it is still one reservation and
  -- admission is not re-evaluated (no second INSERT).
  update public.seo_sync_jobs set retry_count = retry_count + 1, run_after = now()
    where id = (select id from public.seo_sync_jobs where project_id = v_a and status = 'queued' order by queued_at limit 1);
  select count(*) into v_count from public.seo_sync_jobs where project_id = v_a and status = 'queued';
  if v_count <> 2 then raise exception 'p9: retry multiplied reservations (queued=%)', v_count; end if;

  -- (3) Running concurrency ceiling enforced with the SE002 SQLSTATE.
  update public.seo_resource_limits set max_value = 1 where scope = 'project' and resource = 'jobs_running';
  update public.seo_resource_limits set max_value = 1000 where scope = 'project' and resource = 'jobs_queued';
  update public.seo_sync_jobs set status = 'running', started_at = now()
    where id = (select id from public.seo_sync_jobs where project_id = v_a and status = 'queued' order by queued_at limit 1);
  v_denied := false; v_code := null;
  begin
    insert into public.seo_sync_jobs (project_id, provider, job_type) values (v_a, 'wordpress', 'publish');
  exception when others then v_denied := true; v_code := sqlstate; end;
  if not v_denied or v_code <> 'SE002' then
    raise exception 'p9: running concurrency not enforced (denied=%, sqlstate=%)', v_denied, v_code;
  end if;
  update public.seo_sync_jobs set status = 'completed', completed_at = now()
    where id = (select id from public.seo_sync_jobs where project_id = v_a and status = 'running' order by started_at limit 1);

  -- (4) Account-level queued ceiling bounds across sibling projects: an
  -- account cannot dodge protection by spreading work over multiple projects.
  select count(*) into v_count
    from public.seo_sync_jobs j
    join public.seo_projects p on p.id = j.project_id
    where p.account_id = v_acc and j.status = 'queued';
  update public.seo_resource_limits set max_value = v_count where scope = 'account' and resource = 'jobs_queued';
  v_denied := false; v_code := null;
  begin
    insert into public.seo_sync_jobs (project_id, provider, job_type) values (v_b, 'wordpress', 'publish');
  exception when others then v_denied := true; v_code := sqlstate; end;
  if not v_denied or v_code <> 'SE001' then
    raise exception 'p9: account queue ceiling not enforced (denied=%, sqlstate=%)', v_denied, v_code;
  end if;

  raise notice 'p9: ceiling + release + retry + running concurrency + account scope OK';
end $$;

-- (5) Repeated request creation is bounded per project (SE003).
do $$
declare
  v_r uuid; v_denied boolean; v_code text;
begin
  select id into v_r from public.seo_projects where slug = 'rp-rate';
  update public.seo_resource_limits set max_value = 1, window_seconds = 60
    where scope = 'project' and resource = 'jobs_create_rate';
  insert into public.seo_sync_jobs (project_id, provider, job_type) values (v_r, 'wordpress', 'publish');
  v_denied := false; v_code := null;
  begin
    insert into public.seo_sync_jobs (project_id, provider, job_type) values (v_r, 'wordpress', 'publish');
  exception when others then v_denied := true; v_code := sqlstate; end;
  if not v_denied or v_code <> 'SE003' then
    raise exception 'p9: create-rate ceiling not enforced (denied=%, sqlstate=%)', v_denied, v_code;
  end if;
  raise notice 'p9: repeated-request ceiling OK';
end $$;
SQL
echo "   smoke: admission ceiling + release + retry + concurrency + rate OK"

# (6) The operational tables are deny-all to authenticated/anon.
for rp_table in seo_resource_limits seo_resource_denials; do
  RP_COUNT="$(PSQL -d "${DB_NAME}" -t -A <<SQL
grant usage on schema public to authenticated;
grant select on public.${rp_table} to authenticated;
set role authenticated;
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
select count(*) from public.${rp_table};
SQL
)"
  if [ -z "${RP_COUNT}" ] || [ "${RP_COUNT}" != "0" ]; then
    echo "!! RLS leak: authenticated read ${RP_COUNT} rows from ${rp_table}" >&2
    exit 1
  fi
done
echo "   smoke: resource limits + denials are deny-all to authenticated (RLS OK)"

# (7) Concurrent inserts cannot oversubscribe the queue: two racing sessions
# each pause before inserting into a project whose queued ceiling is 1.
PSQL -d "${DB_NAME}" -c "update public.seo_resource_limits set max_value = 1 where scope = 'project' and resource = 'jobs_queued'" >/dev/null
PSQL -d "${DB_NAME}" -c "update public.seo_resource_limits set max_value = 100 where scope = 'account' and resource = 'jobs_queued'" >/dev/null
RP_CONC_PROJ="$(PSQL -d "${DB_NAME}" -t -A -c "select id from public.seo_projects where slug = 'rp-conc'")"
RP_RACE_OUT1="$(mktemp -p /tmp/opencode p9race1.XXXXXX)"
RP_RACE_OUT2="$(mktemp -p /tmp/opencode p9race2.XXXXXX)"
RP_RACE_SQL="begin; select pg_sleep(0.5); insert into public.seo_sync_jobs (project_id, provider, job_type) values ('${RP_CONC_PROJ}','wordpress','publish'); commit;"
( $PSQL_CMD -v ON_ERROR_STOP=1 -X -q -d "${DB_NAME}" -c "${RP_RACE_SQL}" >"${RP_RACE_OUT1}" 2>&1; echo $? > "${RP_RACE_OUT1}.rc" ) &
( $PSQL_CMD -v ON_ERROR_STOP=1 -X -q -d "${DB_NAME}" -c "${RP_RACE_SQL}" >"${RP_RACE_OUT2}" 2>&1; echo $? > "${RP_RACE_OUT2}.rc" ) &
wait || true
RP_RC1="$(cat "${RP_RACE_OUT1}.rc" 2>/dev/null || echo 1)"
RP_RC2="$(cat "${RP_RACE_OUT2}.rc" 2>/dev/null || echo 1)"
RP_CONC_QUEUED="$(PSQL -d "${DB_NAME}" -t -A -c "select count(*) from public.seo_sync_jobs where project_id = '${RP_CONC_PROJ}' and status = 'queued'")"
if [ "${RP_CONC_QUEUED}" != "1" ]; then
  echo "!! p9: concurrent admission oversubscribed the queue (queued=${RP_CONC_QUEUED})" >&2
  exit 1
fi
if { [ "${RP_RC1}" = "0" ] && [ "${RP_RC2}" = "0" ]; } || { [ "${RP_RC1}" != "0" ] && [ "${RP_RC2}" != "0" ]; }; then
  echo "!! p9: racing inserts did not resolve to exactly one admit (rc1=${RP_RC1} rc2=${RP_RC2})" >&2
  exit 1
fi
echo "   smoke: exactly one of two racing inserts was admitted (queued=1)"

echo "==> migration validation OK (${DB_NAME})"
