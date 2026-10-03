-- ============================================================================
-- SEO Platform - Google usage vocabulary (P4.5)
--
-- The append-only usage ledger (20260101000031) shipped with a closed category
-- and unit vocabulary. Google Search Console was recorded under the
-- `dataforseo` category, which is misleading and does not scale to a second
-- Google product. This migration widens the two CHECK constraints with:
--
--   * category `google` - Google platform API consumption regardless of
--     product (Search Console `gsc`, Analytics `ga4`, future Ads). The provider
--     column already distinguishes the concrete product, so one category per
--     external platform reason is enough.
--   * unit `ga4_request` - one real Google Analytics Admin/Data API request.
--
-- The `dataforseo` category and its units are unchanged: DataForSEO history and
-- its derived idempotency keys must keep validating. Existing GSC rows remain
-- `dataforseo` (historical facts are immutable); new GSC facts use `google`.
-- ============================================================================

alter table public.seo_usage_events
  drop constraint if exists seo_usage_events_category_check,
  add constraint seo_usage_events_category_check
    check (category in ('ai', 'dataforseo', 'google', 'job', 'publishing', 'media'));

alter table public.seo_usage_events
  drop constraint if exists seo_usage_events_unit_check,
  add constraint seo_usage_events_unit_check
    check (unit in ('request', 'task', 'keyword', 'serp_request', 'gsc_request',
                    'ga4_request', 'input_token', 'output_token',
                    'image_generation', 'asset', 'publish_attempt', 'job'));
