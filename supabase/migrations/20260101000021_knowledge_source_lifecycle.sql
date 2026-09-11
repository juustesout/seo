-- ============================================================================
-- SEO Platform - canonical knowledge source vocabulary (KB1)
--
-- Aligns seo_knowledge_sources with the canonical contract used by the API,
-- worker and UI. This migration is purely additive at the data level: existing
-- rows are remapped, nothing is dropped and no content is lost.
--
--   source_type:  note | reference -> text          (url stays url)
--   status:       pending  -> queued
--                 indexing -> processing
--                 indexed  -> ready
--                 error    -> failed
--                 deleting -> deleted
--
-- Canonical vocabularies after this migration:
--   source_type in (text, url, file)
--   status      in (draft, queued, processing, ready, failed, deleted)
--
-- The table remains the source of truth (ownership, lifecycle, metadata); the
-- Qdrant vectors stay a retrieval index addressed by external_id `source:<id>`.
-- ============================================================================

-- 1. Drop the legacy constraints first so the remap below is not rejected.
alter table public.seo_knowledge_sources
  drop constraint if exists seo_knowledge_sources_status_check,
  drop constraint if exists seo_knowledge_sources_type_check;

-- 2. Remap existing rows onto the canonical vocabulary (no data loss).
update public.seo_knowledge_sources
set source_type = 'text'
where source_type in ('note', 'reference');

update public.seo_knowledge_sources
set status = case status
  when 'pending'  then 'queued'
  when 'indexing' then 'processing'
  when 'indexed'  then 'ready'
  when 'error'    then 'failed'
  when 'deleting' then 'deleted'
  else status
end;

-- 3. Re-impose the canonical vocabulary and defaults.
alter table public.seo_knowledge_sources
  add constraint seo_knowledge_sources_status_check
    check (status in ('draft', 'queued', 'processing', 'ready', 'failed', 'deleted')),
  add constraint seo_knowledge_sources_type_check
    check (source_type in ('text', 'url', 'file'));

alter table public.seo_knowledge_sources
  alter column source_type set default 'text',
  alter column status set default 'queued';

comment on table public.seo_knowledge_sources is
  'Project-scoped user-managed knowledge sources. Postgres is the source of truth; Qdrant holds the retrieval index under external_id source:<id>.';
