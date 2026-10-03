-- ============================================================================
-- SEO Platform - Google Ads project binding (P5)
--
-- Google Ads is a read-only Google data source alongside Search Console and
-- Analytics. The account owns the Google Ads OAuth connection (an
-- account-scoped seo_integrations row with provider_type = 'ads', project_id
-- NULL); a project selects exactly one authorized Google Ads customer to read
-- paid search intelligence from.
--
-- Only the customer reference needed to bind a project to Google Ads is stored
-- here - no Google credentials are duplicated per project (tokens live
-- encrypted once under the account integration in seo_credentials). This
-- mirrors the GA4 model (seo_project_analytics) and keeps the GSC registry/link
-- tables untouched.
--
-- This migration also widens the append-only usage ledger unit vocabulary with
-- `ads_request` (one real Google Ads API request, category `google`,
-- provider `ads`), exactly as 20260101000036 did for GA4.
--
-- RLS: members of the project may read the binding; writes stay server-side
-- (service role) after the route's role check, so there is no insert/update/
-- delete policy. A project with no row simply has no Ads customer and remains
-- fully functional.
-- ============================================================================

create table public.seo_project_ads (
  project_id        uuid primary key references public.seo_projects (id) on delete cascade,
  -- Google Ads numeric customer id ("customers/1234567890" -> "1234567890").
  customer_id       text not null,
  customer_name     text not null,
  -- ISO 4217 currency of the customer's cost metrics; null when Google reports
  -- none (the real name and id are still shown).
  currency_code     text,
  -- True when the bound customer is a manager (MCC) account.
  is_manager        boolean not null default false,
  -- Manager customer id to send as `login-customer-id` when querying a customer
  -- reached through its manager; null for a directly-accessible customer.
  login_customer_id text,
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint seo_project_ads_customer_id_format
    check (customer_id ~ '^[0-9]{1,20}$'),
  constraint seo_project_ads_login_customer_id_format
    check (login_customer_id is null or login_customer_id ~ '^[0-9]{1,20}$')
);

comment on table public.seo_project_ads is
  'One Google Ads customer per project (P5). Read-only paid search intelligence; credentials stay on the account-level ads integration.';

create index seo_project_ads_customer_idx on public.seo_project_ads (customer_id);

create trigger seo_project_ads_touch_updated_at
  before update on public.seo_project_ads
  for each row execute function public.seo_touch_updated_at();

alter table public.seo_project_ads enable row level security;

drop policy if exists seo_project_ads_select on public.seo_project_ads;
create policy seo_project_ads_select on public.seo_project_ads
  for select using (public.seo_is_member(project_id, auth.uid()));

-- ----------------------------------------------------------------------------
-- Usage vocabulary: unit `ads_request` (category `google`, provider `ads`)
-- ----------------------------------------------------------------------------

alter table public.seo_usage_events
  drop constraint if exists seo_usage_events_unit_check,
  add constraint seo_usage_events_unit_check
    check (unit in ('request', 'task', 'keyword', 'serp_request', 'gsc_request',
                    'ga4_request', 'ads_request', 'input_token', 'output_token',
                    'image_generation', 'asset', 'publish_attempt', 'job'));
