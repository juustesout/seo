-- ============================================================================
-- SEO Platform - publication intent (publish_kind) threading (Phase H6.1)
--
-- A publication intent describes *how* a source content item is sent to a
-- publisher: as a full article (wordpress), as a text post (X / social), or
-- later as image/video. Each kind maps to exactly one publisher capability:
--   article -> publish_article, text -> publish_text, image -> publish_image,
--   video -> publish_video
-- There is no implicit "article counts as text" fallback anymore: a source
-- article in seo_content stays the source, and the intent is chosen at the
-- schedule/publication edge. Both seo_schedules (planning read model) and the
-- backing seo_publications row (execution truth) carry the same kind so a
-- schedule never loses the intent its publication was created with.
--
-- Additive only: the column defaults to 'article' so every existing row and
-- existing caller that does not specify a kind keeps today's semantics.
-- ============================================================================

alter table public.seo_schedules
  add column publish_kind text not null default 'article';

alter table public.seo_schedules
  add constraint seo_schedules_publish_kind_check
    check (publish_kind in ('article', 'text', 'image', 'video'));

alter table public.seo_publications
  add column publish_kind text not null default 'article';

alter table public.seo_publications
  add constraint seo_publications_publish_kind_check
    check (publish_kind in ('article', 'text', 'image', 'video'));

-- ----------------------------------------------------------------------------
-- RLS. publish_kind is a plain column on existing tables; the table-level RLS
-- policies from the base migrations (seo_schedules / seo_publications) already
-- cover read + editor write access, so no new policy is required.
-- ----------------------------------------------------------------------------
