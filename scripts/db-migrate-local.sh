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
begin
  select id into v_project from public.seo_projects where slug = 'demo' limit 1;
  if v_project is null then raise exception 'smoke: project was not created'; end if;

  select role into v_role from public.seo_project_members where project_id = v_project and user_id = '00000000-0000-0000-0000-000000000001';
  if v_role is distinct from 'owner' then raise exception 'smoke: owner membership not auto-created (role=%)', v_role; end if;

  insert into public.seo_gsc_properties (project_id, site_url, is_active)
  values (v_project, 'sc-domain:example.com', true) returning id into v_prop;
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

echo "==> migration validation OK (${DB_NAME})"
