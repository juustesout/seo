-- ============================================================================
-- SEO Platform - core SEO entities (keywords, pages, rankings, serp, audits,
-- content). These tables receive normalized data from any provider through the
-- SEO Core.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- seo_keywords
-- ----------------------------------------------------------------------------

create table public.seo_keywords (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.seo_projects (id) on delete cascade,
  domain_id      uuid references public.seo_domains (id) on delete set null,
  keyword        text not null,
  intent         text,
  volume         bigint,
  difficulty     integer,
  cpc            numeric(10,2),
  competition    text,
  source         text not null default 'manual',
  provider       text not null default 'manual',
  meta           jsonb not null default '{}'::jsonb,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint seo_keywords_unique_per_source
    unique (project_id, provider, source, keyword),
  constraint seo_keywords_not_blank check (length(btrim(keyword)) > 0),
  constraint seo_keywords_volume_nonnegative check (volume is null or volume >= 0),
  constraint seo_keywords_difficulty_range check (difficulty is null or difficulty between 0 and 100)
);

create index seo_keywords_project_idx on public.seo_keywords (project_id);
create index seo_keywords_project_keyword_idx on public.seo_keywords (project_id, lower(keyword));
create index seo_keywords_last_seen_idx on public.seo_keywords (last_seen_at desc);
create index seo_keywords_created_at_idx on public.seo_keywords (created_at desc);

create trigger seo_keywords_touch_updated_at
  before update on public.seo_keywords
  for each row execute function public.seo_touch_updated_at();

-- ----------------------------------------------------------------------------
-- seo_pages
-- ----------------------------------------------------------------------------

create table public.seo_pages (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.seo_projects (id) on delete cascade,
  domain_id      uuid references public.seo_domains (id) on delete set null,
  url            text not null,
  title          text,
  description    text,
  status_code    integer,
  content_type   text,
  word_count     integer,
  is_indexable   boolean,
  is_homepage    boolean not null default false,
  provider       text not null default 'manual',
  source         text not null default 'manual',
  meta           jsonb not null default '{}'::jsonb,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint seo_pages_url_unique unique (project_id, url)
);

create index seo_pages_project_idx on public.seo_pages (project_id);
create index seo_pages_project_url_idx on public.seo_pages (project_id, url);
create index seo_pages_last_seen_idx on public.seo_pages (last_seen_at desc);

create trigger seo_pages_touch_updated_at
  before update on public.seo_pages
  for each row execute function public.seo_touch_updated_at();

-- ----------------------------------------------------------------------------
-- seo_rankings
-- Time-series ranking history. Keyword + url snapshots are stored so history
-- remains interpretable even if the parent keyword/page rows are deleted or
-- renamed.
-- ----------------------------------------------------------------------------

create table public.seo_rankings (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.seo_projects (id) on delete cascade,
  keyword_id   uuid references public.seo_keywords (id) on delete set null,
  keyword      text not null,
  page_id      uuid references public.seo_pages (id) on delete set null,
  url          text not null,
  domain       text,
  position     numeric(7,2),
  engine       text not null default 'google',
  country      text,
  device       text,
  source       text not null default 'manual',
  date         date not null,
  is_estimate  boolean not null default false,
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint seo_rankings_unique_row
    unique (project_id, source, keyword, url, engine, country, device, date),
  constraint seo_rankings_keyword_not_blank check (length(btrim(keyword)) > 0),
  constraint seo_rankings_position_range check (position is null or (position >= 1 and position <= 100))
);

create index seo_rankings_project_date_idx on public.seo_rankings (project_id, date desc);
create index seo_rankings_keyword_idx on public.seo_rankings (keyword_id);
create index seo_rankings_url_idx on public.seo_rankings (project_id, url);
create index seo_rankings_created_at_idx on public.seo_rankings (created_at desc);

create trigger seo_rankings_touch_updated_at
  before update on public.seo_rankings
  for each row execute function public.seo_touch_updated_at();

-- ----------------------------------------------------------------------------
-- seo_serp_results
-- ----------------------------------------------------------------------------

create table public.seo_serp_results (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.seo_projects (id) on delete cascade,
  keyword_id    uuid references public.seo_keywords (id) on delete set null,
  keyword       text not null,
  engine        text not null default 'google',
  country       text,
  locale        text,
  device        text,
  url           text not null,
  domain        text,
  position      integer not null,
  title         text,
  description   text,
  kind          text,
  is_paid       boolean not null default false,
  fetched_at    timestamptz not null default now(),
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  constraint seo_serp_results_keyword_not_blank check (length(btrim(keyword)) > 0),
  constraint seo_serp_results_position_positive check (position > 0)
);

create index seo_serp_results_project_fetched_idx on public.seo_serp_results (project_id, fetched_at desc);
create index seo_serp_results_keyword_idx on public.seo_serp_results (project_id, keyword);
create index seo_serp_results_url_idx on public.seo_serp_results (url);
create index seo_serp_results_domain_idx on public.seo_serp_results (domain);

-- ----------------------------------------------------------------------------
-- seo_audits
-- ----------------------------------------------------------------------------

create table public.seo_audits (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.seo_projects (id) on delete cascade,
  domain_id       uuid references public.seo_domains (id) on delete set null,
  url             text,
  source          text not null default 'technical',
  audit_type      text not null default 'technical',
  finding_key     text not null,
  severity        text not null default 'info',
  score           numeric(5,2),
  title           text not null,
  detail          text,
  recommendation  text,
  payload         jsonb not null default '{}'::jsonb,
  audited_at      timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  constraint seo_audits_severity_check
    check (severity in ('critical', 'warning', 'info')),
  constraint seo_audits_finding_key_not_blank check (length(btrim(finding_key)) > 0)
);

create index seo_audits_project_audited_idx on public.seo_audits (project_id, audited_at desc);
create index seo_audits_project_severity_idx on public.seo_audits (project_id, severity);
create index seo_audits_url_idx on public.seo_audits (project_id, url);

-- ----------------------------------------------------------------------------
-- seo_content
-- ----------------------------------------------------------------------------

create table public.seo_content (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.seo_projects (id) on delete cascade,
  domain_id      uuid references public.seo_domains (id) on delete set null,
  url            text,
  title          text not null,
  status         text not null default 'draft',
  excerpt        text,
  body           text,
  keywords       jsonb not null default '[]'::jsonb,
  seo_meta       jsonb not null default '{}'::jsonb,
  created_by     uuid references auth.users (id) on delete set null,
  updated_by     uuid references auth.users (id) on delete set null,
  published_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint seo_content_status_check
    check (status in ('draft', 'in_review', 'published', 'archived')),
  constraint seo_content_title_not_blank check (length(btrim(title)) > 0)
);

create index seo_content_project_idx on public.seo_content (project_id);
create index seo_content_project_status_idx on public.seo_content (project_id, status);
create index seo_content_updated_at_idx on public.seo_content (updated_at desc);

create trigger seo_content_touch_updated_at
  before update on public.seo_content
  for each row execute function public.seo_touch_updated_at();
