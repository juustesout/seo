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

/** Key source priority: project-stored key first, then server env, then none. */
export type AiKeySource = 'project' | 'env' | 'none';

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
