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

echo "==> migration validation OK (${DB_NAME})"
