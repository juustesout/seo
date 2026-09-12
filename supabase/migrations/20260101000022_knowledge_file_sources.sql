-- ============================================================================
-- SEO Platform - uploaded file knowledge sources (KB4)
--
-- Adds the private-storage metadata an uploaded file source needs. The file
-- bytes themselves never live in Postgres: only a project/source-scoped object
-- path in the private `seo-knowledge` bucket plus display metadata. The row
-- stays the source of truth for ownership, lifecycle and metadata; Qdrant stays
-- a rebuildable retrieval index. Purely additive - existing rows keep working
-- with NULLs and their RLS policies are unchanged.
--
--   storage_path       -> private bucket object path (never a public URL/credential)
--   original_filename  -> sanitized display name of the uploaded file
--   content_type       -> validated MIME type
--   size_bytes         -> uploaded byte length
-- ============================================================================

alter table public.seo_knowledge_sources
  add column if not exists storage_path text,
  add column if not exists original_filename text,
  add column if not exists content_type text,
  add column if not exists size_bytes bigint;

alter table public.seo_knowledge_sources
  add constraint seo_knowledge_sources_size_bytes_check
    check (size_bytes is null or size_bytes >= 0);

comment on column public.seo_knowledge_sources.storage_path is
  'Private seo-knowledge bucket object path for a file source. Never a public URL or credential.';
comment on column public.seo_knowledge_sources.original_filename is
  'Sanitized display filename of the uploaded file (file sources only).';
comment on column public.seo_knowledge_sources.content_type is
  'Validated MIME type of the uploaded file (file sources only).';
comment on column public.seo_knowledge_sources.size_bytes is
  'Uploaded file size in bytes (file sources only).';
