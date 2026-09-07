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

/**
 * Publisher capabilities. Canonical tokens describe the content kinds a
 * publisher can accept (publish_article / publish_text / publish_image /
 * publish_video) plus lifecycle support (update / delete / schedule). The
 * legacy aliases `post` and `media` are kept so capability snapshots stored on
 * older seo_publishers rows keep type-checking; use
 * `normalizePublisherCapabilities` when deciding what a publisher can do.
 */
export type PublisherCapability =
  | 'publish_article'
  | 'publish_text'
  | 'publish_image'
  | 'publish_video'
  | 'update'
  | 'delete'
  | 'schedule'
  | 'post'
  | 'media';

export const PUBLISHER_CAPABILITIES: readonly PublisherCapability[] = [
  'publish_article',
  'publish_text',
  'publish_image',
  'publish_video',
  'update',
  'delete',
  'schedule',
  'post',
  'media',
];

/** The content kind a user is trying to send to a publisher. */
export type PublishContentKind = 'article' | 'text' | 'image' | 'video';

const LEGACY_PUBLISHER_ALIASES: Record<string, PublisherCapability[]> = {
  post: ['publish_article'],
  media: ['publish_image'],
};

const KIND_TOKEN: Record<PublishContentKind, PublisherCapability> = {
  article: 'publish_article',
  text: 'publish_text',
  image: 'publish_image',
  video: 'publish_video',
};

/** Capabilities that can carry article-style content (full article or text render). */
const ARTICLE_ACCEPTANCE = new Set<PublisherCapability>(['publish_article', 'publish_text']);

/**
 * Expand a publisher's declared capabilities into the canonical vocabulary.
 * Legacy aliases map to their canonical tokens (`post` -> publish_article,
 * `media` -> publish_image); unknown strings are dropped. Canonical tokens and
 * the shared lifecycle tokens (update/delete/schedule) pass through.
 */
export function normalizePublisherCapabilities(declared: readonly string[]): PublisherCapability[] {
  const out: PublisherCapability[] = [];
  for (const raw of declared ?? []) {
    const aliases = LEGACY_PUBLISHER_ALIASES[raw];
    if (aliases) {
      for (const a of aliases) if (!out.includes(a)) out.push(a);
    } else if ((PUBLISHER_CAPABILITIES as readonly string[]).includes(raw)) {
      if (!out.includes(raw as PublisherCapability)) out.push(raw as PublisherCapability);
    }
  }
  return out;
}

/**
 * True when the publisher's capabilities allow publishing content of the given
 * kind. Articles are accepted by publish_article and publish_text channels (a
 * text adapter renders the article into a post); image/video kinds require
 * their exact token. An empty or unknown capability set stays permissive so
 * legacy publisher rows without a snapshot never break scheduling.
 */
export function publisherCanPublishContent(kind: PublishContentKind, declared: readonly string[]): boolean {
  if (!declared || declared.length === 0) return true;
  const normalized = new Set(normalizePublisherCapabilities(declared));
  if (normalized.size === 0) return true;
  if (kind === 'article') {
    return [...normalized].some((c) => ARTICLE_ACCEPTANCE.has(c));
  }
  return normalized.has(KIND_TOKEN[kind]);
}

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

/**
 * Planning/read-model status of a content schedule (seo_schedules). Execution
 * truth lives on the backing seo_sync_jobs row + seo_publications attempt;
 * this is synchronized from those outcomes, never a second source of truth.
 */
export type ScheduleStatus =
  | 'scheduled'
  | 'queued'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'cancelled';

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
