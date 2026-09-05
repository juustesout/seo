-- ============================================================================
-- SEO Platform - REST API keys (milestone 8)
--
-- Project-scoped bearer keys for the /api/v1 REST surface. Only a SHA-256
-- hash of the key is stored (key_prefix helps lookups + display); the plain
-- key is shown exactly once at creation. RLS keeps management to project
-- owners/admins; the API v1 middleware authenticates with the key itself
-- (service-role read path), never with a browser session.
-- ============================================================================

create table if not exists public.seo_api_keys (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.seo_projects (id) on delete cascade,
  name        text not null,
  key_prefix  text not null,
  key_hash    text not null unique,
  scopes      text[] not null default '{read}',
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at  timestamptz
);

create unique index seo_api_keys_project_name
  on public.seo_api_keys (project_id, name);

alter table public.seo_api_keys enable row level security;

drop policy if exists seo_api_keys_manage on public.seo_api_keys;
create policy seo_api_keys_manage on public.seo_api_keys
  for all to authenticated
  using (public.seo_has_role(project_id, array['owner', 'admin']))
  with check (public.seo_has_role(project_id, array['owner', 'admin']));
