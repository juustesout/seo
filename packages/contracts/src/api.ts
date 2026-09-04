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
  kind: 'datasource' | 'knowledge' | 'publisher';
  ui?: { icon: string; color?: string };
}

export interface ProvidersCatalogDto {
  dataSources: ProviderDescriptorDto[];
  knowledge: ProviderDescriptorDto[];
  publishers: ProviderDescriptorDto[];
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
