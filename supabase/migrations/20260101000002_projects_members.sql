-- ============================================================================
-- SEO Platform - projects, membership, domains, integrations, credentials,
-- data sources.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- seo_projects
-- ----------------------------------------------------------------------------

create table public.seo_projects (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text,
  description   text,
  website_url   text,
  timezone      text not null default 'UTC',
  settings      jsonb not null default '{}'::jsonb,
  created_by    uuid not null references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint seo_projects_name_not_blank check (length(btrim(name)) > 0),
  constraint seo_projects_timezone_valid check (char_length(timezone) between 1 and 64)
);

create unique index seo_projects_slug_key on public.seo_projects (slug) where slug is not null;
create index seo_projects_created_by_idx on public.seo_projects (created_by);
create index seo_projects_created_at_idx on public.seo_projects (created_at desc);

create trigger seo_projects_touch_updated_at
  before update on public.seo_projects
  for each row execute function public.seo_touch_updated_at();

-- ----------------------------------------------------------------------------
-- seo_project_members
-- ----------------------------------------------------------------------------

create table public.seo_project_members (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.seo_projects (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null default 'editor',
  created_at  timestamptz not null default now(),
  constraint seo_project_members_role_check check (role in ('owner', 'admin', 'editor', 'viewer')),
  constraint seo_project_members_unique unique (project_id, user_id)
);

create index seo_project_members_user_idx on public.seo_project_members (user_id);
create index seo_project_members_project_idx on public.seo_project_members (project_id);

-- ----------------------------------------------------------------------------
-- seo_domains
-- ----------------------------------------------------------------------------

create table public.seo_domains (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.seo_projects (id) on delete cascade,
  domain      text not null,
  protocol    text not null default 'https',
  is_primary  boolean not null default false,
  settings    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint seo_domains_unique_per_project unique (project_id, domain),
  constraint seo_domains_protocol_check check (protocol in ('https', 'http'))
);

create index seo_domains_project_idx on public.seo_domains (project_id);
create index seo_domains_domain_idx on public.seo_domains (lower(domain));

create trigger seo_domains_touch_updated_at
  before update on public.seo_domains
  for each row execute function public.seo_touch_updated_at();

-- ----------------------------------------------------------------------------
-- seo_integrations
-- A project-level connection to a provider (Google Search Console, DataForSEO,
-- a website crawler, ...). Only NON-secret configuration is stored here;
-- credentials live encrypted in seo_credentials.
-- ----------------------------------------------------------------------------

create table public.seo_integrations (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.seo_projects (id) on delete cascade,
  provider_type  text not null,
  name           text not null,
  status         text not null default 'disconnected',
  config         jsonb not null default '{}'::jsonb,
  capabilities   jsonb not null default '[]'::jsonb,
  last_sync_at   timestamptz,
  last_error     jsonb,
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint seo_integrations_status_check
    check (status in ('disconnected', 'connecting', 'connected', 'error', 'disabled')),
  constraint seo_integrations_provider_not_blank check (length(btrim(provider_type)) > 0)
);

-- A project should have at most one *active* connection per provider type so
-- the UI and sync engine never have to guess which integration wins. Historic
-- rows are marked disconnected/disabled and excluded from this index.
create unique index seo_integrations_active_provider_key
  on public.seo_integrations (project_id, provider_type)
  where status in ('connected', 'connecting');

create index seo_integrations_project_idx on public.seo_integrations (project_id);
create index seo_integrations_provider_idx on public.seo_integrations (provider_type);
create index seo_integrations_created_at_idx on public.seo_integrations (created_at desc);

create trigger seo_integrations_touch_updated_at
  before update on public.seo_integrations
  for each row execute function public.seo_touch_updated_at();

-- ----------------------------------------------------------------------------
-- seo_credentials
-- Encrypted credential rows. NEVER granted to anon/authenticated. The API
-- server encrypts/decrypts with an app-level key (AES-256-GCM) before storing.
-- ----------------------------------------------------------------------------

create table public.seo_credentials (
  id              uuid primary key default gen_random_uuid(),
  integration_id  uuid references public.seo_integrations (id) on delete cascade,
  -- publisher FK is added in the jobs/publishing migration (table ordering).
  publisher_id    uuid,
  provider_type   text not null,
  key_name        text not null,
  ciphertext      text not null,
  iv              text not null,
  auth_tag        text,
  meta            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint seo_credentials_owner_check
    check (num_nonnulls(integration_id, publisher_id) = 1),
  constraint seo_credentials_integration_key unique (integration_id, key_name),
  constraint seo_credentials_publisher_key unique (publisher_id, key_name)
);

create index seo_credentials_integration_idx on public.seo_credentials (integration_id);
create index seo_credentials_publisher_idx on public.seo_credentials (publisher_id);

create trigger seo_credentials_touch_updated_at
  before update on public.seo_credentials
  for each row execute function public.seo_touch_updated_at();

revoke all on public.seo_credentials from anon, authenticated;

-- ----------------------------------------------------------------------------
-- seo_data_sources
-- A concrete provider object attached to a project (e.g. the GSC property
-- "sc-domain:example.com" under the GSC integration).
-- ----------------------------------------------------------------------------

create table public.seo_data_sources (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.seo_projects (id) on delete cascade,
  integration_id uuid references public.seo_integrations (id) on delete set null,
  provider_type  text not null,
  kind           text not null,
  name           text not null,
  status         text not null default 'inactive',
  external_id    text,
  external_url   text,
  config         jsonb not null default '{}'::jsonb,
  capabilities   jsonb not null default '[]'::jsonb,
  last_synced_at timestamptz,
  first_synced_at timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint seo_data_sources_status_check
    check (status in ('inactive', 'active', 'error', 'syncing')),
  constraint seo_data_sources_unique_external
    unique (project_id, provider_type, external_id) deferrable initially immediate,
  constraint seo_data_sources_kind_not_blank check (length(btrim(kind)) > 0)
);

create index seo_data_sources_project_idx on public.seo_data_sources (project_id);
create index seo_data_sources_integration_idx on public.seo_data_sources (integration_id);
create index seo_data_sources_provider_idx on public.seo_data_sources (provider_type);
create index seo_data_sources_created_at_idx on public.seo_data_sources (created_at desc);

create trigger seo_data_sources_touch_updated_at
  before update on public.seo_data_sources
  for each row execute function public.seo_touch_updated_at();
