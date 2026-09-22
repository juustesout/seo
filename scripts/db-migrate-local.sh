#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Validate the Supabase migrations against a local PostgreSQL 15 instance.
#
# Creates (if absent) a database `seo_dev`, stubs the minimal Supabase Auth
# surface that the migrations reference (auth.users, auth.uid(), the anon /
# authenticated roles), then applies every migration in order with
# ON_ERROR_STOP so the first failure is reported loudly.
#
# No destructive commands are run: existing objects are reused, not dropped.
# ---------------------------------------------------------------------------
set -euo pipefail

DB_NAME="${DB_NAME:-seo_dev}"
MIGRATIONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations"
PSQL() { runuser -u postgres -- psql -v ON_ERROR_STOP=1 -X -q "$@"; }

echo "==> ensuring roles + database (${DB_NAME})"
runuser -u postgres -- psql -X -q -d postgres <<'SQL'
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
SQL
runuser -u postgres -- psql -X -q -d postgres -c "select 1 from pg_database where datname = '${DB_NAME}'" | grep -q 1 \
  || runuser -u postgres -- createdb "${DB_NAME}"

if runuser -u postgres -- psql -X -q -t -A -d "${DB_NAME}" -c "select count(*) from pg_tables where schemaname='public' and tablename like 'seo_%'" | grep -vq '^0$'; then
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
  email text
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

  insert into public.seo_content_media (content_id, media_id) values (v_content, v_media_a);

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

echo "==> migration validation OK (${DB_NAME})"
