-- ============================================================================
-- SEO Platform - Google Analytics (GA4) project binding (P4)
--
-- GA4 is a read-only Google data source alongside Search Console. The account
-- owns the Google Analytics OAuth connection (an account-scoped seo_integrations
-- row with provider_type = 'ga4', project_id NULL); a project selects exactly
-- one GA4 property to read page traffic from.
--
-- Only the property reference needed to bind a project to GA4 is stored here -
-- no Google credentials are duplicated per project (tokens live encrypted once
-- under the account integration in seo_credentials). This mirrors the GSC model
-- but keeps GA4 storage separate so the GSC registry/link tables are untouched.
--
-- RLS: members of the project may read the binding; writes stay server-side
-- (service role) after the route's role check, so there is no insert/update/
-- delete policy. A project with no row simply has no Analytics property and
-- remains fully functional.
-- ============================================================================

create table public.seo_project_analytics (
  project_id    uuid primary key references public.seo_projects (id) on delete cascade,
  -- GA4 numeric property id as returned by the Google Analytics Admin API
  -- (e.g. "properties/123456789" is normalized to "123456789").
  property_id   text not null,
  property_name text not null,
  -- Optional website URL from the property's web data stream; null when the
  -- property has no usable URL (the real name and id are still shown).
  property_url  text,
  created_by    uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint seo_project_analytics_property_id_format
    check (property_id ~ '^[0-9]{1,32}$')
);

comment on table public.seo_project_analytics is
  'One GA4 property per project (P4). Read-only page-traffic intelligence; credentials stay on the account-level ga4 integration.';

create index seo_project_analytics_property_idx on public.seo_project_analytics (property_id);

create trigger seo_project_analytics_touch_updated_at
  before update on public.seo_project_analytics
  for each row execute function public.seo_touch_updated_at();

alter table public.seo_project_analytics enable row level security;

drop policy if exists seo_project_analytics_select on public.seo_project_analytics;
create policy seo_project_analytics_select on public.seo_project_analytics
  for select using (public.seo_is_member(project_id, auth.uid()));
