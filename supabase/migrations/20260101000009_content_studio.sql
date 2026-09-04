-- ============================================================================
-- SEO Platform - structured content model (Content Studio)
--
-- Extends seo_content so structured blocks are the source of truth and HTML
-- is a render (never the only representation). Columns are additive; existing
-- rows keep working with empty structured fields.
-- ============================================================================

alter table public.seo_content
  add column slug             text,
  add column target_keyword   text,
  add column meta_title       text,
  add column meta_description text,
  add column language         text not null default 'en',
  add column outline          jsonb not null default '[]'::jsonb,
  add column content_json     jsonb not null default '[]'::jsonb,
  add column content_html     text,
  add column seo_score        numeric(5, 2);

create unique index seo_content_project_slug_key
  on public.seo_content (project_id, slug) where slug is not null;

create index seo_content_target_keyword_idx on public.seo_content (target_keyword);
