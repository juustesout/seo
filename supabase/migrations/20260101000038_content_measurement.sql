-- ============================================================================
-- SEO Platform - persisted GA4 page traffic (P7 measurement loop)
--
-- Closes the loop Research -> Create -> Publish -> Measure -> Improve by
-- durably storing the daily page traffic Google Analytics 4 reports for the
-- project's bound property. Until now GA4 page traffic was read live per
-- request and thrown away, so there was no warehouse to join publications and
-- created content against; Search Console performance was already persisted.
--
-- One row per (project, GA4 property, day, page path). GA4 is authoritative for
-- a past date, so a re-sync overwrites (upsert) - like GSC performance and
-- unlike append-only ranking snapshots.
--
-- The GA4 property is referenced by its numeric id as text, so this table does
-- not depend on the project binding row surviving; a project may rebind and the
-- historical traffic stays attributable to the property it came from.
--
-- RLS: project members may read; writes stay server-side (service role) after
-- the worker's provider call, so there is deliberately no write policy.
-- ============================================================================

create table public.seo_page_traffic (
  id           bigint generated always as identity primary key,
  project_id   uuid not null references public.seo_projects (id) on delete cascade,
  -- GA4 numeric property id (normalized "properties/123" -> "123").
  property_id  text not null,
  date         date not null,
  -- GA4 pagePath (e.g. "/blog/seo-guide"), never a full URL.
  path         text not null,
  views        bigint not null default 0,
  active_users bigint not null default 0,
  sessions     bigint not null default 0,
  -- When the sync last wrote this row (distinguishes a real zero from no data).
  fetched_at   timestamptz not null default now(),
  constraint seo_page_traffic_metrics_nonnegative
    check (views >= 0 and active_users >= 0 and sessions >= 0),
  constraint seo_page_traffic_property_id_format
    check (property_id ~ '^[0-9]{1,32}$'),
  constraint seo_page_traffic_unique_row
    unique (project_id, property_id, date, path)
);

comment on table public.seo_page_traffic is
  'Persisted daily GA4 page traffic (P7). One row per project/property/day/path; re-sync overwrites. Read-only via RLS.';

create index seo_page_traffic_project_date_idx on public.seo_page_traffic (project_id, date desc);
create index seo_page_traffic_project_path_idx on public.seo_page_traffic (project_id, path);
create index seo_page_traffic_property_idx on public.seo_page_traffic (property_id);

alter table public.seo_page_traffic enable row level security;

drop policy if exists seo_page_traffic_select on public.seo_page_traffic;
create policy seo_page_traffic_select on public.seo_page_traffic
  for select using (public.seo_is_member(project_id, auth.uid()));

-- Publication -> content lookup: the measurement join starts from the content
-- that was actually published, so a per-content index on seo_publications keeps
-- that read bounded as the history grows.
create index if not exists seo_publications_content_idx
  on public.seo_publications (project_id, content_id, published_at desc);
