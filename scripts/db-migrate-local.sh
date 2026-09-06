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

echo "==> smoke test: knowledge sources (phase E) + cross-project isolation"
PSQL -d "${DB_NAME}" <<'SQL'
set request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000001"}';
do $$
declare
  v_project uuid;
  v_source uuid;
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: demo project missing for knowledge sources'; end if;

  insert into public.seo_knowledge_sources (project_id, source_type, name, url, content_text, status, chunk_count)
  values (v_project, 'note', 'Smoke note', null, 'A short project note about phase E ingestion.', 'pending', 0)
  returning id into v_source;
  if v_source is null then raise exception 'smoke: knowledge source row was not created'; end if;

  update public.seo_knowledge_sources set status = 'indexed', chunk_count = 1 where id = v_source;
  if not exists (select 1 from public.seo_knowledge_sources where id = v_source and status = 'indexed' and chunk_count = 1) then
    raise exception 'smoke: source status transition failed';
  end if;

  raise notice 'smoke: knowledge source insert + status transition OK';
end $$;
SQL

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

echo "==> migration validation OK (${DB_NAME})"
