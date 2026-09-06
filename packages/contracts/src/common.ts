/**
 * Shared primitive types, enums and constants used across the platform.
 * This package must stay dependency-free so both the API (node) and the
 * web app (browser) can import it.
 */

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

/** Stable identifiers for the data-source / knowledge / publishing providers the platform ships with. */
export const PROVIDER_IDS = {
  GOOGLE_SEARCH_CONSOLE: 'gsc',
  DATAFORSEO: 'dataforseo',
  WEBSITE_CRAWLER: 'crawler',
  QDRANT: 'qdrant',
  WORDPRESS: 'wordpress',
  MANUAL: 'manual',
  OPENAI: 'openai',
  OPENAI_MEDIA: 'openai_media',
  UNSPLASH: 'unsplash',
} as const;

export type ProviderId = (typeof PROVIDER_IDS)[keyof typeof PROVIDER_IDS];

// ---------------------------------------------------------------------------
// Capabilities (declared by each provider)
// ---------------------------------------------------------------------------

export type DataSourceCapability =
  | 'keywords'
  | 'pages'
  | 'rankings'
  | 'performance'
  | 'serp'
  | 'competitors'
  | 'crawl'
  | 'audit';

export type PublisherCapability = 'post' | 'update' | 'delete' | 'media' | 'schedule';

export type KnowledgeCapability = 'index' | 'search' | 'update' | 'delete';

/** Capabilities declared by AI providers (chat/generation and embeddings). */
export type AICapability = 'chat' | 'generate' | 'embed' | 'models';

/** Capabilities declared by media providers (stock search / generation). */
export type MediaCapability = 'search' | 'generate' | 'upload';

// ---------------------------------------------------------------------------
// Generic statuses
// ---------------------------------------------------------------------------

export type IntegrationStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'disabled';

export type DataSourceStatus = 'inactive' | 'active' | 'error' | 'syncing';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type MemberRole = 'owner' | 'admin' | 'editor' | 'viewer';

// ---------------------------------------------------------------------------
// Sync jobs
// ---------------------------------------------------------------------------

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

export type JobType =
  | 'gsc_sync'
  | 'dataforseo_rank_sync'
  | 'dataforseo_keyword_research'
  | 'serp_retrieval'
  | 'competitor_research'
  | 'website_crawl'
  | 'website_audit'
  | 'knowledge_index'
  | 'knowledge_reindex'
  | 'knowledge_delete'
  | 'knowledge_source_ingest'
  | 'knowledge_source_delete'
  | 'content_generate'
  | 'content_images'
  | 'content_analyze'
  | 'publish'
  | 'publish_update'
  | 'publish_delete';

export const JOB_TYPE_GROUPS: Record<string, JobType[]> = {
  sync: [
    'gsc_sync',
    'dataforseo_rank_sync',
    'dataforseo_keyword_research',
    'serp_retrieval',
    'competitor_research',
    'website_crawl',
    'website_audit',
  ],
  knowledge: [
    'knowledge_index',
    'knowledge_reindex',
    'knowledge_delete',
    'knowledge_source_ingest',
    'knowledge_source_delete',
  ],
  content: ['content_generate', 'content_images', 'content_analyze'],
  publish: ['publish', 'publish_update', 'publish_delete'],
};

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export type PublicationStatus =
  | 'queued'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'updated'
  | 'deleted'
  | 'scheduled';

// ---------------------------------------------------------------------------
// SEO domain entity statuses
// ---------------------------------------------------------------------------

export type ContentStatus = 'draft' | 'in_review' | 'published' | 'archived';

export type AuditSeverity = 'critical' | 'warning' | 'info';

export type AuditSource = 'technical' | 'onpage' | 'content' | 'performance';

// ---------------------------------------------------------------------------
// Roles / permissions
// ---------------------------------------------------------------------------

export const ROLE_HIERARCHY: Record<MemberRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

export function roleAtLeast(role: MemberRole, min: MemberRole): boolean {
  return ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[min];
}

// ---------------------------------------------------------------------------
// Misc helpers shared by UI + API
// ---------------------------------------------------------------------------

export type IsoDate = string; // YYYY-MM-DD
export type IsoDateTime = string; // ISO-8601

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function nullToZero(value: number | null | undefined): number {
  return value ?? 0;
}
