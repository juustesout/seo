/**
 * HTTP API contracts shared by the API server and the web client.
 * The browser only ever talks to these endpoints for operations that require
 * server-held secrets (provider connect/oauth, credential storage, background
 * job enqueue, publishing). Plain entity CRUD/reads go through Supabase
 * (PostgREST) under Row Level Security.
 */

import type { JobType, MemberRole, PublicationStatus, PublishContentKind, ScheduleStatus } from './common.js';
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

/**
 * Success envelope: the shared error handler wraps every 2xx payload as
 * `{ data: T }`.
 */
export interface ApiEnvelope<T> {
  data: T;
}

/** Error envelope: machine `code` plus a human `message`, with optional
 *  `details` for validation/context. Returned on every non-2xx response. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Any API response is either a `{ data }` success or an `{ error }` failure. */
export type ApiResult<T> = ApiEnvelope<T> | ApiErrorBody;

// ---------------------------------------------------------------------------
// Providers / capabilities discovery
// ---------------------------------------------------------------------------

/**
 * Wire shape of a provider's public descriptor (mirrors ProviderDescriptor in
 * providers.ts). The UI discovers providers through the catalog and renders
 * their connect form from `setup` - it never hardcodes a provider id or vendor
 * and never sees secrets.
 */
export interface ProviderDescriptorDto {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  kind: 'datasource' | 'knowledge' | 'publisher' | 'ai' | 'media';
  ui?: { icon: string; color?: string };
  /** Publisher connect/setup hints (see ProviderDescriptor). */
  setup?: {
    category?: string;
    config?: Array<{ key: string; label: string; type?: 'text' | 'url' | 'password'; placeholder?: string }>;
    credentials?: Array<{ key: string; label: string; type?: 'text' | 'url' | 'password'; placeholder?: string }>;
    note?: string;
  };
}

/** Catalog of every registered provider, grouped by capability kind. */
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

/**
 * Server-computed AI configuration state for a project. `providerConfigured`
 * reports whether the resolved credential exists for the provider, `configured`
 * is the aggregate readiness, `keySource` says which BYOK scope wins, and
 * `models`/`capabilities` enumerate what the UI can offer. Never exposes key
 * values.
 */
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

/** User-editable AI settings for a project (model selection, provider choice). */
export interface ProjectAiSettingsInput {
  provider?: string;
  chatModel?: string;
  embeddingModel?: string;
}

// ---------------------------------------------------------------------------
// Account-level AI providers (BYOK shared across an account's projects)
// ---------------------------------------------------------------------------

/** One model a provider can serve, tagged by its purpose (chat vs embedding). */
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

/** Account-level AI readiness: every AI provider the account has configured. */
export interface AccountAiStatusDto {
  providers: AccountAiProviderDto[];
}

// ---------------------------------------------------------------------------
// Content Studio AI actions (in-editor, review-before-apply)
// ---------------------------------------------------------------------------

/** In-editor AI actions the Content Studio can perform on a selection or the
 *  whole document (review-before-apply). */
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

/** Media upload intent. The file bytes are sent separately to project object
 *  storage; this carries display metadata. */
export interface MediaUploadRequest {
  /** Original file name; sanitized server-side for storage/display. */
  filename?: string;
  alt?: string;
}

/** Editable display metadata on an existing media-library item. */
export interface MediaPatchRequest {
  alt_text?: string;
  caption?: string;
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

/** Start creating an integration of a given provider type (name optional). */
export interface CreateIntegrationRequest {
  provider_type: string;
  name?: string;
}

/** An integration enriched with its provider descriptor for the UI. */
export interface IntegrationDetailDto extends Integration {
  descriptor: ProviderDescriptorDto | null;
}

/** OAuth-style connect response: the URL to send the browser to. */
export interface ConnectUrlDto {
  url: string;
}

/** A GSC property the user can pick during connect (id-less catalog item). */
export interface GscPropertyOption {
  siteUrl: string;
  permissionLevel: string;
}

/** Attach an existing GSC property to a project data source. */
export interface GscAttachRequest {
  siteUrl: string;
  name?: string;
}

/** Write one encrypted credential under a key (server-side only). */
export interface CredentialPutRequest {
  key: string;
  value: string;
  meta?: Record<string, unknown>;
}

/** Outcome of a connection/credential test. */
export interface TestConnectionResult {
  ok: boolean;
  message?: string;
}

/** Result of attaching a data source: the new row plus the linked property. */
export interface AttachResult {
  dataSource: DataSource;
  property?: { id: string; site_url: string };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

/** Enqueue a background job of a given type with optional typed params. */
export interface EnqueueJobRequest {
  job_type: JobType | string;
  params?: Record<string, unknown>;
}

/** The durable SyncJob row created for the enqueued work. */
export interface EnqueueJobResult {
  job: SyncJob;
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

/** Vector search over the project knowledge base. */
export interface KnowledgeSearchRequest {
  query: string;
  limit?: number;
}

/** Ranked knowledge hits for the query, scoped to one project. */
export interface KnowledgeSearchResponse {
  results: Array<{ id: string; score: number; payload: Record<string, unknown> }>;
  project_id: string;
}

/** Whether the project knowledge base is ready and which kinds are indexed. */
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

/** Configure a new publisher destination under the project. `config` holds
 *  non-secret settings; secrets are stored separately through the credentials
 *  API or the OAuth flow. */
export interface CreatePublisherRequest {
  provider: string;
  name: string;
  config?: Record<string, unknown>;
}

/**
 * Publish a piece of content to a publisher now (Phase H). `publish_kind`
 * selects the content kind; the publisher's declared capabilities are checked
 * before enqueueing. Content may be supplied inline (`content`) or referenced
 * by `content_id`.
 */
export interface PublishRequest {
  publisher_id: string;
  content_id?: string;
  /** Publication intent: which capability the publisher must satisfy. Defaults to 'article'. */
  publish_kind?: PublishContentKind;
  title: string;
  content?: string;
  excerpt?: string;
  slug?: string;
  remote_status?: 'draft' | 'publish';
  categories?: string[];
  tags?: string[];
  schedule_at?: string;
}

/** Enqueued publish job plus the publication attempt row it will drive. */
export interface PublishResultDto {
  job: SyncJob;
  publication?: Publication;
}

/**
 * Publication as seen by the API (Content Studio Phase H3). Safe read-only
 * metadata for history/detail surfaces - no credentials, no raw publisher
 * config, and no article body. The canonical article stays in seo_content.
 * content_title resolves from the linked content row when it still exists and
 * otherwise falls back to the title snapshot stored on the publication.
 */
export interface PublicationDto {
  id: string;
  project_id: string;
  content_id: string | null;
  content_title: string | null;
  publisher_id: string;
  publisher_name: string | null;
  /** The schedule that triggered this publication, when it came from one. */
  schedule_id: string | null;
  status: PublicationStatus;
  publish_kind: PublishContentKind;
  remote_id: string | null;
  target_url: string | null;
  scheduled_for: string | null;
  published_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Schedule as seen by the API: the planning row enriched with the content
 * title and publisher name so calendar/list surfaces need no extra lookups.
 */
export interface ScheduleDto {
  id: string;
  project_id: string;
  content_id: string;
  content_title: string | null;
  publisher_id: string;
  publisher_name: string | null;
  scheduled_at: string;
  status: ScheduleStatus;
  publish_kind: PublishContentKind;
  job_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
}

/**
 * Create a scheduling plan (intention only - execution happens on the publish
 * job the schedule backs, so the plan row never becomes a second source of
 * truth).
 */
export interface CreateScheduleInput {
  content_id: string;
  publisher_id: string;
  /**
   * Publication intent. Defaults to 'article' so existing callers keep working;
   * each kind maps to exactly one publisher capability (see
   * publisherCanPublishKind). Choosing text lets article content be scheduled
   * as a text post to a publish_text-only channel (e.g. X).
   */
  publish_kind?: PublishContentKind;
  /** Absolute ISO-8601 timestamp (timestamptz); stored unambiguously in UTC. */
  scheduled_at: string;
}

/** Reschedule an existing plan to a new absolute timestamp. */
export interface UpdateScheduleInput {
  scheduled_at: string;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

/**
 * Project dashboard read model. `overview` and `keywordStats` are null until
 * the project has synced real data - an unconnected project reports absence,
 * never fabricated zeros. `sync` reflects the job queue state.
 */
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

/** The authenticated user's identity plus the projects they belong to. */
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

/** Account-level Google connection state (single shared Google integration). */
export interface GscConnectionDto {
  connected: boolean;
  integration_id: string | null;
  status: string | null;
  last_sync_at: string | null;
  error: string | null;
}

/** The GSC property currently linked to a project, with its primary flag. */
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

/** One recent activity entry across the account, denormalized with project name. */
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

/** Account-level overview: identity, Google connection, and linked projects. */
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

/** One row of the overview time series (a day of observed performance). */
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

/** Attach a GSC property to the project: reference an existing account
 *  registry property or register a newly discovered site under the account. */
export interface ProjectGscAttachRequest {
  /** Existing account registry property to attach. */
  property_id?: string;
  /** Alternatively register a newly discovered site under the account. */
  siteUrl?: string;
  name?: string;
}
