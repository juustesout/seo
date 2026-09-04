-- ============================================================================
-- SEO Platform - Google Search Console storage.
-- Large-volume analytics rows use identity primary keys to keep the tables
-- compact. Every row is project-scoped and carries source timestamps.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- seo_gsc_properties
-- ----------------------------------------------------------------------------

create table public.seo_gsc_properties (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.seo_projects (id) on delete cascade,
  integration_id   uuid references public.seo_integrations (id) on delete set null,
  data_source_id   uuid references public.seo_data_sources (id) on delete set null,
  site_url         text not null,
  permission_level text,
  verified_at      timestamptz,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint seo_gsc_properties_unique unique (project_id, site_url)
);

create index seo_gsc_properties_project_idx on public.seo_gsc_properties (project_id);
create index seo_gsc_properties_integration_idx on public.seo_gsc_properties (integration_id);

create trigger seo_gsc_properties_touch_updated_at
  before update on public.seo_gsc_properties
  for each row execute function public.seo_touch_updated_at();

-- ----------------------------------------------------------------------------
-- seo_gsc_queries - daily query-level performance
-- ----------------------------------------------------------------------------

create table public.seo_gsc_queries (
  id           bigint generated always as identity primary key,
  project_id   uuid not null references public.seo_projects (id) on delete cascade,
  property_id  uuid not null references public.seo_gsc_properties (id) on delete cascade,
  date         date not null,
  query        text not null,
  country      text not null default '',
  device       text not null default '',
  page         text not null default '',
  clicks       bigint not null default 0,
  impressions  bigint not null default 0,
  ctr          numeric(10,6) not null default 0,
  position     numeric(7,2) not null default 0,
  created_at   timestamptz not null default now(),
  constraint seo_gsc_queries_metrics_nonnegative
    check (clicks >= 0 and impressions >= 0 and ctr >= 0 and position >= 0),
  constraint seo_gsc_queries_unique_row
    unique (property_id, date, query, country, device, page)
);

create index seo_gsc_queries_project_date_idx on public.seo_gsc_queries (project_id, date desc);
create index seo_gsc_queries_project_query_idx on public.seo_gsc_queries (project_id, query);
create index seo_gsc_queries_property_idx on public.seo_gsc_queries (property_id);
create index seo_gsc_queries_created_at_idx on public.seo_gsc_queries (created_at desc);

-- ----------------------------------------------------------------------------
-- seo_gsc_pages - daily page-level performance
-- ----------------------------------------------------------------------------

create table public.seo_gsc_pages (
  id           bigint generated always as identity primary key,
  project_id   uuid not null references public.seo_projects (id) on delete cascade,
  property_id  uuid not null references public.seo_gsc_properties (id) on delete cascade,
  date         date not null,
  url          text not null,
  country      text not null default '',
  device       text not null default '',
  clicks       bigint not null default 0,
  impressions  bigint not null default 0,
  ctr          numeric(10,6) not null default 0,
  position     numeric(7,2) not null default 0,
  created_at   timestamptz not null default now(),
  constraint seo_gsc_pages_metrics_nonnegative
    check (clicks >= 0 and impressions >= 0 and ctr >= 0 and position >= 0),
  constraint seo_gsc_pages_unique_row
    unique (property_id, date, url, country, device)
);

create index seo_gsc_pages_project_date_idx on public.seo_gsc_pages (project_id, date desc);
create index seo_gsc_pages_project_url_idx on public.seo_gsc_pages (project_id, url);
create index seo_gsc_pages_property_idx on public.seo_gsc_pages (property_id);
create index seo_gsc_pages_created_at_idx on public.seo_gsc_pages (created_at desc);

-- ----------------------------------------------------------------------------
-- seo_gsc_performance - daily rollup per property (dashboard fast path)
-- ----------------------------------------------------------------------------

create table public.seo_gsc_performance (
  id           bigint generated always as identity primary key,
  project_id   uuid not null references public.seo_projects (id) on delete cascade,
  property_id  uuid not null references public.seo_gsc_properties (id) on delete cascade,
  date         date not null,
  clicks       bigint not null default 0,
  impressions  bigint not null default 0,
  ctr          numeric(10,6) not null default 0,
  position     numeric(7,2) not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint seo_gsc_performance_unique unique (property_id, date)
);

create index seo_gsc_performance_project_date_idx on public.seo_gsc_performance (project_id, date desc);
create index seo_gsc_performance_project_idx on public.seo_gsc_performance (project_id);

create trigger seo_gsc_performance_touch_updated_at
  before update on public.seo_gsc_performance
  for each row execute function public.seo_touch_updated_at();
