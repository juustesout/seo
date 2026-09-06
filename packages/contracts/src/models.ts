/**
 * Normalized SEO domain models.
 *
 * These are the canonical shapes the platform operates on. Provider adapters
 * are responsible for transforming raw external responses into these types so
 * the SEO Core (and everything above it) never depends on an external vendor.
 */

import type {
  AuditSeverity,
  AuditSource,
  ContentStatus,
  IsoDate,
  IsoDateTime,
  MemberRole,
  PublicationStatus,
  ProviderId,
  ScheduleStatus,
} from './common.js';
import type { ContentBlock, ContentOutlineItem } from './content.js';
import type { TipDoc } from './contentDoc.js';

// ---------------------------------------------------------------------------
// Row base
// ---------------------------------------------------------------------------

export interface BaseRow {
  id: string;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface ProjectScopedRow extends BaseRow {
  project_id: string;
}

// ---------------------------------------------------------------------------
// Projects & membership
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  website_url: string | null;
  timezone: string;
  settings: Record<string, unknown>;
  created_by: string;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  role: MemberRole;
  created_at: IsoDateTime;
  user_email?: string | null;
}

export interface ProjectSummary extends Project {
  member_count: number;
  domain_count: number;
  integration_count: number;
  connected_count: number;
  job_count: number;
  role: MemberRole;
  last_sync_at: IsoDateTime | null;
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export interface Domain extends ProjectScopedRow {
  domain: string;
  protocol: string;
  is_primary: boolean;
  settings: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

export interface Keyword extends ProjectScopedRow {
  domain_id: string | null;
  keyword: string;
  intent: string | null;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competition: string | null;
  source: string;
  provider: string;
  meta: Record<string, unknown>;
  first_seen_at: IsoDateTime;
  last_seen_at: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface Page extends ProjectScopedRow {
  domain_id: string | null;
  url: string;
  title: string | null;
  description: string | null;
  status_code: number | null;
  content_type: string | null;
  word_count: number | null;
  is_indexable: boolean | null;
  is_homepage: boolean;
  provider: string;
  source: string;
  meta: Record<string, unknown>;
  first_seen_at: IsoDateTime;
  last_seen_at: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

export interface Ranking extends ProjectScopedRow {
  keyword_id: string | null;
  keyword: string;
  page_id: string | null;
  url: string;
  domain: string | null;
  position: number | null;
  engine: string;
  country: string | null;
  device: string | null;
  source: string;
  date: IsoDate;
  is_estimate: boolean;
  meta: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Search performance (GSC-style normalized metrics)
// ---------------------------------------------------------------------------

export interface PerformancePoint {
  date: IsoDate;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface KeywordPerformance extends PerformancePoint {
  keyword: string;
}

export interface PagePerformance extends PerformancePoint {
  page: string;
}

// ---------------------------------------------------------------------------
// SERP results
// ---------------------------------------------------------------------------

export interface SerpItem {
  position: number;
  url: string;
  domain: string | null;
  title: string | null;
  description: string | null;
  kind: string | null;
  is_paid: boolean;
}

export interface SerpSnapshot extends ProjectScopedRow {
  keyword_id: string | null;
  keyword: string;
  engine: string;
  country: string | null;
  locale: string | null;
  device: string | null;
  url: string | null;
  fetched_at: IsoDateTime;
  results: SerpItem[];
}

// ---------------------------------------------------------------------------
// Audit findings
// ---------------------------------------------------------------------------

export interface AuditFinding extends ProjectScopedRow {
  domain_id: string | null;
  url: string | null;
  source: AuditSource;
  audit_type: string;
  finding_key: string;
  severity: AuditSeverity;
  score: number | null;
  title: string;
  detail: string | null;
  recommendation: string | null;
  payload: Record<string, unknown>;
  audited_at: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export interface ContentItem extends ProjectScopedRow {
  domain_id: string | null;
  url: string | null;
  title: string;
  status: ContentStatus;
  excerpt: string | null;
  body: string | null;
  keywords: string[];
  seo_meta: Record<string, unknown>;
  created_by: string | null;
  updated_by: string | null;
  published_at: IsoDateTime | null;
  // Structured content model. content_json is the canonical representation: a
  // Tiptap document ({type:'doc',...}) for Phase B content, with older records
  // tolerated as a legacy block array. content_html is always a render of it.
  slug: string | null;
  target_keyword: string | null;
  meta_title: string | null;
  meta_description: string | null;
  outline: ContentOutlineItem[];
  content_json: TipDoc | ContentBlock[];
  content_html: string | null;
  seo_score: number | null;
  language: string | null;
}

// ---------------------------------------------------------------------------
// SEO opportunity (computed, not stored)
// ---------------------------------------------------------------------------

export type OpportunityKind =
  | 'quick_win'
  | 'position_gain'
  | 'content_gap'
  | 'keyword_opportunity'
  | 'indexability'
  | 'technical'
  | 'decline'
  | 'new_content';

export interface SeoOpportunity {
  id: string;
  kind: OpportunityKind;
  title: string;
  description: string;
  impact: 'high' | 'medium' | 'low';
  effort: 'low' | 'medium' | 'high';
  keyword?: string;
  url?: string;
  metric?: { label: string; value: string };
}

// ---------------------------------------------------------------------------
// Integrations / data sources
// ---------------------------------------------------------------------------

export interface Integration extends ProjectScopedRow {
  provider_type: string;
  name: string;
  status: string;
  config: Record<string, unknown>;
  capabilities: string[];
  last_sync_at: IsoDateTime | null;
  last_error: { message?: string; provider?: string; operation?: string } | null;
  created_by: string | null;
}

export interface DataSource extends ProjectScopedRow {
  integration_id: string | null;
  provider_type: string;
  kind: string;
  name: string;
  status: string;
  external_id: string | null;
  external_url: string | null;
  config: Record<string, unknown>;
  capabilities: string[];
  last_synced_at: IsoDateTime | null;
  first_synced_at: IsoDateTime | null;
}

// ---------------------------------------------------------------------------
// GSC-specific stored entities
// ---------------------------------------------------------------------------

export interface GscProperty extends ProjectScopedRow {
  integration_id: string | null;
  data_source_id: string | null;
  site_url: string;
  permission_level: string | null;
  verified_at: IsoDateTime | null;
  is_active: boolean;
}

export interface GscQueryRow extends ProjectScopedRow {
  property_id: string;
  date: IsoDate;
  query: string;
  country: string;
  device: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscPageRow extends ProjectScopedRow {
  property_id: string;
  date: IsoDate;
  url: string;
  country: string;
  device: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface GscDailyPerformance extends ProjectScopedRow {
  property_id: string;
  date: IsoDate;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface JobError {
  provider?: string;
  operation?: string;
  message: string;
  status?: number | null;
  http_status?: number | null;
  code?: string | null;
  retryable?: boolean;
  occurred_at: IsoDateTime;
}

export interface SyncJob extends BaseRow {
  project_id: string;
  integration_id: string | null;
  data_source_id: string | null;
  provider: string;
  job_type: string;
  status: string;
  params: Record<string, unknown>;
  progress: number;
  message: string | null;
  result: Record<string, unknown> | null;
  error: JobError | null;
  queued_at: IsoDateTime;
  started_at: IsoDateTime | null;
  completed_at: IsoDateTime | null;
  run_after: IsoDateTime;
  retry_count: number;
  max_retries: number;
  created_by: string | null;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

export interface Publisher extends ProjectScopedRow {
  provider: string;
  name: string;
  config: Record<string, unknown>;
  status: string;
  capabilities: string[];
  last_error: { message?: string; operation?: string } | null;
}

export interface Publication extends ProjectScopedRow {
  publisher_id: string;
  content_id: string | null;
  status: PublicationStatus;
  title: string;
  slug: string | null;
  content: string | null;
  excerpt: string | null;
  target_url: string | null;
  remote_id: string | null;
  error: JobError | null;
  scheduled_for: IsoDateTime | null;
  published_at: IsoDateTime | null;
  created_by: string | null;
}

/**
 * A planned publication (Content Studio Phase H1). Intention only - execution
 * lives on the backing publish job (job_id) and the publication attempts
 * (seo_publications rows linked via schedule_id).
 */
export interface Schedule extends ProjectScopedRow {
  content_id: string;
  publisher_id: string;
  scheduled_at: IsoDateTime;
  status: ScheduleStatus;
  job_id: string | null;
  created_by: string;
  cancelled_at: IsoDateTime | null;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditLogEntry {
  id: string;
  project_id: string | null;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  meta: Record<string, unknown>;
  created_at: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------

export interface KnowledgeSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

export interface KnowledgeDocumentInput {
  /** stable external id used to dedupe on reindex (e.g. `page:<url>`). */
  externalId: string;
  kind: 'page' | 'content' | 'audit' | 'keyword' | 'serp' | 'note';
  text: string;
  title?: string;
  url?: string;
  meta?: Record<string, unknown>;
}

export interface IndexSummary {
  indexed: number;
  skipped?: number;
  deleted?: number;
}

// ---------------------------------------------------------------------------
// DataForSEO (normalized research output)
// ---------------------------------------------------------------------------

export interface KeywordResearchResult {
  keyword: string;
  location_code: number | null;
  language_code: string | null;
  search_volume: number | null;
  cpc: number | null;
  competition: string | null;
  difficulty: number | null;
  serp: SerpItem[];
  keyword_intents?: string[] | null;
  monthly_searches?: { year: number; month: number; volume: number }[];
}

export interface CompetitorItem {
  domain: string;
  url: string;
  title: string | null;
  description: string | null;
  position: number | null;
  keyword: string;
  serp_item: SerpItem | null;
}

export type ProviderGeneric = ProviderId;
