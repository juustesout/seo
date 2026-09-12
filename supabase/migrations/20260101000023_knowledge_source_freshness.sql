-- ============================================================================
-- SEO Platform - knowledge source freshness & refresh lifecycle (KB7)
--
-- Adds the durable freshness facts a URL source needs to answer "when was this
-- last fetched, did it change, when is it due, how often has it failed?".
-- Postgres stays the source of truth; Qdrant stays a derived retrieval index:
-- nothing here makes a source searchable - it only records the schedule and the
-- outcome of re-fetching it. Purely additive - text/file sources keep NULLs and
-- a NULL policy, and their RLS policies are unchanged.
--
--   content_hash      -> SHA-256 of the normalized, capped body (change detector)
--   last_fetched_at   -> when a fetch last succeeded
--   last_changed_at   -> when the body last actually changed
--   next_refresh_at   -> scheduled check time (NULL for manual / no schedule)
--   refresh_policy    -> manual | daily | weekly | monthly (URL sources only)
--   refresh_failures  -> consecutive refresh failures, drives bounded backoff
--
-- Derived freshness (fresh/due/stale/unknown) is NOT stored - it is recomputed
-- from these facts plus the current time so it can never drift.
-- ============================================================================

alter table public.seo_knowledge_sources
  add column if not exists content_hash text,
  add column if not exists last_fetched_at timestamptz,
  add column if not exists last_changed_at timestamptz,
  add column if not exists next_refresh_at timestamptz,
  add column if not exists refresh_policy text,
  add column if not exists refresh_failures integer not null default 0;

-- The policy vocabulary is closed and only meaningful for URL sources; existing
-- URL rows start on the manual cadence (never fetched on a schedule by default).
alter table public.seo_knowledge_sources
  add constraint seo_knowledge_sources_refresh_policy_check
    check (refresh_policy is null or refresh_policy in ('manual', 'daily', 'weekly', 'monthly')),
  add constraint seo_knowledge_sources_refresh_failures_check
    check (refresh_failures >= 0);

update public.seo_knowledge_sources
set refresh_policy = 'manual'
where source_type = 'url' and refresh_policy is null;

-- Due-refresh lookup: partial index keeps it tiny (only URL sources that have
-- an actual schedule) and ordered for the scheduler's oldest-first claim.
create index if not exists seo_knowledge_sources_due_refresh_idx
  on public.seo_knowledge_sources (project_id, next_refresh_at)
  where source_type = 'url' and next_refresh_at is not null;

comment on column public.seo_knowledge_sources.content_hash is
  'SHA-256 (hex) of the normalized, capped body used to detect content changes on refresh. Internal only; never returned by the API.';
comment on column public.seo_knowledge_sources.last_fetched_at is
  'When a URL fetch last succeeded (URL sources only).';
comment on column public.seo_knowledge_sources.last_changed_at is
  'When the fetched body last actually changed (URL sources only).';
comment on column public.seo_knowledge_sources.next_refresh_at is
  'Next scheduled refresh check; NULL for manual or no schedule (URL sources only).';
comment on column public.seo_knowledge_sources.refresh_policy is
  'Refresh cadence: manual | daily | weekly | monthly (URL sources only).';
comment on column public.seo_knowledge_sources.refresh_failures is
  'Consecutive refresh failures; drives bounded retry backoff.';
