/**
 * HTTP API contracts shared by the API server and the web client.
 * The browser only ever talks to these endpoints for operations that require
 * server-held secrets (provider connect/oauth, credential storage, background
 * job enqueue, publishing). Plain entity CRUD/reads go through Supabase
 * (PostgREST) under Row Level Security.
 */

import type { JobType, MemberRole } from './common.js';
import type {
  DataSource,
  Integration,
  Project,
  ProjectMember,
  ProjectSummary,
  Publication,
  Publisher,
  SeoOpportunity,
  SyncJob,
} from './models.js';

export interface ApiEnvelope<T> {
  data: T;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResult<T> = ApiEnvelope<T> | ApiErrorBody;

// ---------------------------------------------------------------------------
// Providers / capabilities discovery
// ---------------------------------------------------------------------------

export interface ProviderDescriptorDto {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  kind: 'datasource' | 'knowledge' | 'publisher' | 'ai' | 'media';
  ui?: { icon: string; color?: string };
}

export interface ProvidersCatalogDto {
  dataSources: ProviderDescriptorDto[];
  knowledge: ProviderDescriptorDto[];
  publishers: ProviderDescriptorDto[];
  ai: ProviderDescriptorDto[];
  media: ProviderDescriptorDto[];
}

// ---------------------------------------------------------------------------
// Project AI configuration (BYOK, server-side only)
// ---------------------------------------------------------------------------

/**
 * Key source priority: account-stored key first, then project-stored key,
 * then the server env, then none. No key value is ever exposed to the browser.
 */
export type AiKeySource = 'account' | 'project' | 'env' | 'none';

export interface ProjectAiStatusDto {
  provider: string;
  providerConfigured: boolean;
  chatModel: string;
  embeddingModel: string;
  configured: boolean;
  keySource: AiKeySource;
  models: Array<{ id: string; kind: 'chat' | 'embedding'; name?: string }>;
  capabilities: string[];
}

export interface ProjectAiSettingsInput {
  provider?: string;
  chatModel?: string;
  embeddingModel?: string;
}

// ---------------------------------------------------------------------------
// Account-level AI providers (BYOK shared across an account's projects)
// ---------------------------------------------------------------------------

export interface AiModelInfoDto {
  id: string;
  kind: 'chat' | 'embedding';
  name?: string;
}

/** One AI provider the account has configured (or not), never its key. */
export interface AccountAiProviderDto {
  id: string;
  name: string;
  description: string | null;
  /** True when the account stores a working key for this provider. */
  configured: boolean;
  capabilities: string[];
  models: AiModelInfoDto[];
  /** Non-secret error while reading the stored credential, when any. */
  error: string | null;
}

export interface AccountAiStatusDto {
  providers: AccountAiProviderDto[];
}

// ---------------------------------------------------------------------------
// Content Studio AI actions (in-editor, review-before-apply)
// ---------------------------------------------------------------------------

export const CONTENT_AI_ACTIONS = [
  'rewrite',
  'improve',
  'expand',
  'shorten',
  'tone',
  'improve_seo',
  'generate_section',
] as const;

export type ContentAiAction = (typeof CONTENT_AI_ACTIONS)[number];

/**
 * One project-knowledge passage offered to the AI for an action. The passage
 * is reference material the human can verify - AI output is generated text and
 * must never be conflated with these sources.
 */
export interface ContentAiKnowledgeDto {
  /** Source row name (or the passage title stored in Qdrant). */
  name: string;
  url?: string;
  /** Short excerpt of the passage that was sent to the provider. */
  excerpt?: string;
}

export interface ContentAiSuggestionDto {
  action: ContentAiAction;
  /** Existing text the suggestion replaces (empty for generate_section). */
  source: string;
  /** Suggested plain-text replacement or new copy. */
  text: string;
  /** Short explanation of what changed and why. */
  reason: string | null;
  model: string;
  /**
   * Project-knowledge passages the AI was allowed to use, when knowledge was
   * requested and any existed. Absent/empty means no knowledge was supplied.
   */
  knowledge?: ContentAiKnowledgeDto[];
}

// ---------------------------------------------------------------------------
// Media library (Content Studio Phase F) - project-scoped object storage
// ---------------------------------------------------------------------------

/** Image formats the Phase F upload accepts (bytes are sniffed, not trusted). */
export type MediaMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

/** One media-library item. The file lives in project storage; only metadata
 *  (never bytes) lives in Postgres. `url` is a stable public object URL that
 *  document renders resolve the media reference to. */
export interface MediaItemDto {
  id: string;
  project_id: string;
  filename: string;
  mime_type: MediaMimeType;
  /** Size in bytes. */
  size: number;
  url: string;
  width: number | null;
  height: number | null;
  alt_text: string;
  caption: string;
  /** Number of content documents that currently reference this item. */
  usage_count: number;
  created_at: string;
  updated_at: string;
}

export interface MediaListResponse {
  project_id: string;
  /** True when the object store is reachable/configured. */
  configured: boolean;
  note: string | null;
  media: MediaItemDto[];
}

export interface MediaUploadRequest {
  /** Original file name; sanitized server-side for storage/display. */
  filename?: string;
  alt?: string;
}

export interface MediaPatchRequest {
  alt_text?: string;
  caption?: string;
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export interface CreateIntegrationRequest {
  provider_type: string;
  name?: string;
}

export interface IntegrationDetailDto extends Integration {
  descriptor: ProviderDescriptorDto | null;
}

export interface ConnectUrlDto {
  url: string;
}

export interface GscPropertyOption {
  siteUrl: string;
  permissionLevel: string;
}

export interface GscAttachRequest {
  siteUrl: string;
  name?: string;
}

export interface CredentialPutRequest {
  key: string;
  value: string;
  meta?: Record<string, unknown>;
}

export interface TestConnectionResult {
  ok: boolean;
  message?: string;
}

export interface AttachResult {
  dataSource: DataSource;
  property?: { id: string; site_url: string };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface EnqueueJobRequest {
  job_type: JobType | string;
  params?: Record<string, unknown>;
}

export interface EnqueueJobResult {
  job: SyncJob;
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export interface KnowledgeSearchRequest {
  query: string;
  limit?: number;
}

export interface KnowledgeSearchResponse {
  results: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
  project_id: string;
}

export interface KnowledgeStatusResponse {
  project_id: string;
  ready: boolean;
  indexed_kinds: string[];
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Knowledge sources (Content Studio Phase E) - user-managed, project-scoped
// ---------------------------------------------------------------------------

export type KnowledgeSourceStatus = 'pending' | 'indexing' | 'indexed' | 'error' | 'deleting';

export type KnowledgeSourceType = 'note' | 'reference' | 'url';

/**
 * Logical model of one indexed knowledge item. Vectors live in Qdrant under
 * external_id `source:<id>`; the row is the traceability record + status.
 */
export interface KnowledgeSourceDto {
  id: string;
  project_id: string;
  source_type: KnowledgeSourceType;
  name: string;
  url: string | null;
  status: KnowledgeSourceStatus;
  error: string | null;
  chunk_count: number;
  last_indexed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeSourcesResponse {
  project_id: string;
  /** True when Qdrant + an embedding key are configured on this server. */
  configured: boolean;
  provider: ProviderDescriptorDto | null;
  /** Human note explaining why knowledge is (not) usable. */
  note: string | null;
  sources: KnowledgeSourceDto[];
}

export interface KnowledgeSourceCreateInput {
  /** note | reference | url (defaults to 'note'). */
  source_type?: KnowledgeSourceType;
  name: string;
  url?: string | null;
  /** Body text to index. Optional when a URL is supplied. */
  text?: string | null;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export interface CreatePublisherRequest {
  provider: string;
  name: string;
  config?: Record<string, unknown>;
}

export interface PublishRequest {
  publisher_id: string;
  content_id?: string;
  title: string;
  content?: string;
  excerpt?: string;
  slug?: string;
  remote_status?: 'draft' | 'publish';
  categories?: string[];
  tags?: string[];
  schedule_at?: string;
}

export interface PublishResultDto {
  job: SyncJob;
  publication?: Publication;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardSummaryDto {
  overview: {
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
    clicks_trend: number | null;
    impressions_trend: number | null;
    position_trend: number | null;
  } | null;
  trends: Array<{ date: string; clicks: number; impressions: number; ctr: number; position: number }>;
  topQueries: Array<{ query: string; clicks: number; impressions: number; ctr: number; position: number; trend: number | null }>;
  topPages: Array<{ url: string; clicks: number; impressions: number; ctr: number; position: number }>;
  keywordStats: { total: number; tracked: number; top10: number; top3: number; untracked: number } | null;
  sync: { last_sync_at: string | null; active_jobs: number; failed_jobs: number };
  opportunities: SeoOpportunity[];
  recentActivity: Array<{ id: string; action: string; entity_type: string; entity_id: string | null; created_at: string; meta: Record<string, unknown> }>;
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export interface MeDto {
  user_id: string;
  email: string | null;
  projects: ProjectSummary[];
}

// ---------------------------------------------------------------------------
// Account (Stage 4): account-level Google connection, property registry and
// cross-project overview. The account owns the Google connection and the GSC
// property registry; projects optionally link a property via seo_project_properties.
// ---------------------------------------------------------------------------

export interface GscConnectionDto {
  connected: boolean;
  integration_id: string | null;
  status: string | null;
  last_sync_at: string | null;
  error: string | null;
}

export interface AccountPropertyLinkDto {
  property_id: string;
  site_url: string;
  is_primary: boolean;
}

export interface AccountProjectSummaryDto extends ProjectSummary {
  /** The GSC property currently attached to this project, if any. */
  property: AccountPropertyLinkDto | null;
  content_count: number;
}

export interface AccountRecentActivityDto {
  id: string;
  project_id: string | null;
  project_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  created_at: string;
  meta: Record<string, unknown>;
}

export interface AccountDto {
  account: { id: string; name: string; created_at: string };
  google: GscConnectionDto;
  /** Account-level GSC registry size (properties this account can attach). */
  registry_count: number;
  /** Projects in this account that currently link a GSC property. */
  attached_projects: number;
  projects: AccountProjectSummaryDto[];
  recent_activity: AccountRecentActivityDto[];
}

/** GSC registry property with its current project link (server-computed). */
export interface GscRegistryPropertyDto {
  id: string;
  site_url: string;
  permission_level: string | null;
  verified_at: string | null;
  is_active: boolean;
  integration_id: string | null;
  linked_project: { id: string; name: string } | null;
}

export interface OverviewMetricRow {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Adaptive account overview. `totals` / `series` / `properties` are null until
 * the account has a connected Google integration AND at least one project with
 * an attached property - never fabricated zeros for an unconnected account.
 */
export interface AccountOverviewDto {
  connected: boolean;
  registry_count: number;
  attached_count: number;
  totals: {
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
    clicks_trend: number | null;
    impressions_trend: number | null;
  } | null;
  series: OverviewMetricRow[] | null;
  properties: Array<{
    property_id: string;
    site_url: string;
    project_id: string;
    project_name: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }> | null;
}

/** Per-project GSC state + attach candidates (project Settings / dashboard CTA). */
export interface ProjectGscStateDto {
  google: GscConnectionDto;
  current: AccountPropertyLinkDto | null;
  candidates: GscRegistryPropertyDto[];
}

export interface ProjectGscAttachRequest {
  /** Existing account registry property to attach. */
  property_id?: string;
  /** Alternatively register a newly discovered site under the account. */
  siteUrl?: string;
  name?: string;
}
