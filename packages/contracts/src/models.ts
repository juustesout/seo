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
  PublishContentKind,
  ProviderId,
  ScheduleStatus,
} from './common.js';
import type { ContentBlock, ContentOutlineItem } from './content.js';
import type { TipDoc } from './contentDoc.js';

// ---------------------------------------------------------------------------
// Row base
// ---------------------------------------------------------------------------

/**
 * Minimal shape shared by every persisted row: a stable string `id` and
 * always-present ISO-8601 UTC `created_at` / `updated_at` timestamps.
 */
export interface BaseRow {
  id: string;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

/**
 * A BaseRow that additionally carries `project_id`. Every `seo_*` table row is
 * project-scoped so jobs, credentials, content and audit entries always resolve
 * under exactly one project; authorization and RLS filter on this key.
 */
export interface ProjectScopedRow extends BaseRow {
  project_id: string;
}

// ---------------------------------------------------------------------------
// Projects & membership
// ---------------------------------------------------------------------------

/**
 * A project: the top-level tenant under which every SEO entity, job, credential
 * and publication resolves. `id` and `created_by` reference auth entities;
 * `slug` / `website_url` / `description` are optional, `settings` carries
 * non-secret project options, and `timezone` governs date handling for the
 * project's calendar and scheduling surfaces.
 */
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

/**
 * Membership link between an auth user and a project. `role` is one of
 * owner/admin/editor/viewer and is what `container.access.requireRole`
 * evaluates; `user_email` is a denormalized convenience for list surfaces and
 * may be null when the account has not linked an email yet.
 */
export interface ProjectMember {
  id: string;
  project_id: string;
  user_id: string;
  role: MemberRole;
  created_at: IsoDateTime;
  user_email?: string | null;
}

/**
 * List-surface read model for a project: the full Project plus aggregate
 * counters. `member_count`/`domain_count`/`integration_count`/`connected_count`
 * /`job_count` are computed counts, `role` is the acting user's role in this
 * project, and `last_sync_at` is null until any integration has synced.
 */
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

/**
 * A website the project tracks. `domain` is the bare host name (no protocol);
 * `protocol` is stored separately (e.g. https). `is_primary` marks the domain
 * used as the project's main site; `settings` holds non-secret per-domain
 * options. One project can track multiple domains.
 */
export interface Domain extends ProjectScopedRow {
  domain: string;
  protocol: string;
  is_primary: boolean;
  settings: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

/**
 * A keyword the project tracks or has observed. `domain_id` links the domain
 * it belongs to when known (null for research rows not tied to a domain).
 * `provider` names the data-source adapter that produced the row; `source` is
 * the finer origin bucket that adapter reports. Market metrics (`volume`,
 * `difficulty`, `cpc`, `competition`) are null when unknown - never fabricated
 * zeros. `first_seen_at` / `last_seen_at` bound the observation window.
 */
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

/**
 * A page discovered or crawled for a domain. `url` is unique per domain in
 * practice; `status_code`, `content_type`, `word_count` and `is_indexable` are
 * null until a crawl/sync populated them. `is_homepage` flags the domain entry
 * page. `provider` / `source` identify the adapter and origin bucket, and the
 * `_seen_at` timestamps bound observation windows.
 */
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

/**
 * A dated position observation: where `keyword` ranked on `engine` for the
 * given `country` / `device` on `date`. `position` is null only when the
 * keyword was not found in the results. `is_estimate` is true when the rank is
 * estimated (for example aggregated or inferred) rather than an exact reported
 * position - estimates are never silently promoted to exact ones. The
 * denormalized `keyword` and `url` keep the row self-describing even if the
 * linked keyword/page rows are later removed.
 */
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

/**
 * One day of normalized search-performance metrics (GSC-style). These are
 * observed numbers reported by a data source - never fabricated. `ctr` is
 * clicks/impressions for the day and `position` follows search-engine
 * convention where a lower value is better.
 */
export interface PerformancePoint {
  date: IsoDate;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** A PerformancePoint broken down by keyword (`keyword` is the denormalized label). */
export interface KeywordPerformance extends PerformancePoint {
  keyword: string;
}

/** A PerformancePoint broken down by page (`page` is the URL). */
export interface PagePerformance extends PerformancePoint {
  page: string;
}

// ---------------------------------------------------------------------------
// SERP results
// ---------------------------------------------------------------------------

/**
 * One result in a SERP snapshot. `kind` is the result type the source reports
 * when known; `is_paid` marks paid/ads entries, which are excluded from
 * organic rankings analysis.
 */
export interface SerpItem {
  position: number;
  url: string;
  domain: string | null;
  title: string | null;
  description: string | null;
  kind: string | null;
  is_paid: boolean;
}

/**
 * A snapshot of the search-engine results page for a keyword at `fetched_at`.
 * `results` is ordered by position (1 = first). `keyword_id` may be null for
 * research rows where no tracked keyword exists yet, and `url` is the queried
 * URL the snapshot was retrieved against. The snapshot is project-scoped and
 * qualified by `engine`, `country`, `locale` and `device`.
 */
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

/**
 * One finding from a technical/onpage/content/performance audit.
 * `audit_type` groups the finding while `finding_key` is the stable
 * machine-readable rule identifier used to dedupe and group findings across
 * runs. `severity` (critical/warning/info) drives triage, `score` is an
 * optional numeric weight, `payload` carries rule-specific machine extras, and
 * `title` / `detail` / `recommendation` are the human-readable surface.
 */
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

/**
 * A content item owned by a project - the core row of the Content Studio.
 *
 * Structured content is the source of truth: `content_json` is the canonical
 * representation (a Tiptap `{type:'doc',...}` document for Phase B content,
 * with older records tolerated as a legacy block array), and `content_html` is
 * always a render of it - never authored directly. `outline` mirrors the
 * heading structure; `target_keyword` is the single keyword the piece is
 * optimized for and `meta_title` / `meta_description` feed the on-page SEO
 * checks (seo.ts). `seo_score` is the 0..100 deterministic evaluation result,
 * null until evaluated. `keywords` is the general keyword list and `seo_meta`
 * a free-form non-secret bag. `body` is a plain-text fallback for older
 * records. `status` moves draft -> in_review -> published (+ archived);
 * `published_at` is null until published.
 */
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

/**
 * Kinds of computed SEO opportunities surfaced on dashboards. Each kind implies
 * its own shape of follow-up action (see SeoOpportunity).
 */
export type OpportunityKind =
  | 'quick_win'
  | 'position_gain'
  | 'content_gap'
  | 'keyword_opportunity'
  | 'indexability'
  | 'technical'
  | 'decline'
  | 'new_content';

/**
 * A computed, prioritized SEO opportunity. Derived from real observed data by
 * SEO Core - never fabricated. `impact` / `effort` are coarse triage labels;
 * `keyword`, `url` and `metric` point at the subject when the opportunity is
 * about one specific keyword/page/measure.
 */
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

/**
 * A connected provider integration for a project (e.g. an authorized Google
 * Search Console account). `provider_type` is a provider id; `config` holds
 * non-secret settings only (secrets live encrypted in `seo_credentials`);
 * `capabilities` is a snapshot of what the provider can do. `status` follows
 * the connection lifecycle and `last_error` is the non-secret surface of the
 * most recent failure ({message, provider, operation}).
 */
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

/**
 * A concrete data source under an integration - for example one GSC property
 * or one crawl target. `integration_id` links it to its parent Integration and
 * is null for standalone sources. `kind` is the source-specific type token;
 * `external_id` / `external_url` reference the source's own handle and public
 * URL when one exists. `status`, `capabilities` and the sync timestamps mirror
 * the integration vocabulary at source granularity.
 */
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

/**
 * A Google Search Console property registered for a project. `site_url` is the
 * GSC property URL (https://... or sc-domain://...). `permission_level` is the
 * access level Google reported (e.g. siteFullUser) and `verified_at` when the
 * authorization was confirmed. `is_active` controls whether the property is
 * currently synced. Links its parent `integration_id` and, once a data source
 * row exists, its `data_source_id`.
 */
export interface GscProperty extends ProjectScopedRow {
  integration_id: string | null;
  data_source_id: string | null;
  site_url: string;
  permission_level: string | null;
  verified_at: IsoDateTime | null;
  is_active: boolean;
}

/**
 * One GSC query-performance row for a property on a date, keyed by the
 * query/country/device/page dimensions Google reports against. These are
 * verbatim observed numbers from GSC, not derived metrics.
 */
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

/** One GSC page-performance row for a property on a date (per URL). */
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

/** One GSC day of aggregate performance for a property (no dimension split). */
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

/**
 * Structured error attached to a job or publication attempt.
 *
 * `message` is always present and human-readable; `provider` / `operation`
 * identify where the failure happened, `http_status` / `status` / `code` carry
 * the underlying transport/provider code when one exists, and `retryable`
 * tells the worker whether retrying can succeed. `occurred_at` records when
 * the failure happened. This is the error shape used on SyncJob.error,
 * Publication.error and the publisher/integration `last_error` surfaces.
 */
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

/**
 * A durable background job (queued and executed by the worker).
 *
 * `job_type` is a JobType; `status` moves queued -> running ->
 * completed/failed/canceled. `params` is the typed request payload and
 * `result` the optional success output. `progress` is 0..100 once running,
 * `message` a human status line, and `error` a JobError when the job failed.
 * `queued_at` / `started_at` / `completed_at` bound the lifecycle;
 * `run_after` delays execution (used by scheduled work); `retry_count` /
 * `max_retries` track the retry budget. `integration_id` / `data_source_id`
 * scope the job when it belongs to one, and `created_by` is the auth user who
 * enqueued it (null for worker-originated jobs).
 */
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

/**
 * A configured publishing destination for a project (WordPress, X, ...).
 * `provider` is a provider id; `config` holds non-secret destination settings
 * while secrets live encrypted server-side. `capabilities` is the snapshot of
 * PublisherCapability tokens used to decide which content kinds and lifecycle
 * operations are allowed (see the common.ts capability helpers). `status`
 * reflects the destination connection state and `last_error` the most recent
 * failure.
 */
export interface Publisher extends ProjectScopedRow {
  provider: string;
  name: string;
  config: Record<string, unknown>;
  status: string;
  capabilities: string[];
  last_error: { message?: string; operation?: string } | null;
}

/**
 * One attempt to publish content through a publisher - the execution trace.
 *
 * `status` follows the PublicationStatus lifecycle (queued -> publishing ->
 * published/updated/deleted/failed/scheduled). `publish_kind` is the content
 * kind requested and maps one-to-one onto a publisher capability the
 * destination must declare (see common.ts). `content_id` links the source
 * content row and is null for ad-hoc publications not tied to stored content.
 * `remote_id` is only set after the provider confirms success and is the
 * destination's own id used for later update/delete; `target_url` is the live
 * URL when the provider returns one. `error` carries the JobError on failure;
 * `scheduled_for` and `published_at` bound the timeline.
 */
export interface Publication extends ProjectScopedRow {
  publisher_id: string;
  content_id: string | null;
  status: PublicationStatus;
  /** Publication intent inherited from the schedule/request (default 'article'). */
  publish_kind: PublishContentKind;
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
  /** Publication intent; the backing publication inherits the same kind. */
  publish_kind: PublishContentKind;
  job_id: string | null;
  created_by: string;
  cancelled_at: IsoDateTime | null;
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * One appended audit-trail entry. `project_id` is null for account-level
 * actions that happen outside any single project. `action`, `entity_type` and
 * `entity_id` identify what happened to which entity, and `meta` carries
 * extra non-secret context.
 */
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

/** One vector-search hit from a project knowledge base: the similarity `score`
 *  and the original indexed metadata in `payload`. */
export interface KnowledgeSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

/**
 * A document to be indexed into project knowledge. `externalId` is the stable
 * key used to dedupe on reindex; `kind` is the logical source kind used for
 * filtering and Qdrant payloads; `text` is the chunkable body.
 */
export interface KnowledgeDocumentInput {
  /** stable external id used to dedupe on reindex (e.g. `page:<url>`). */
  externalId: string;
  kind: 'page' | 'content' | 'audit' | 'keyword' | 'serp' | 'note';
  text: string;
  title?: string;
  url?: string;
  meta?: Record<string, unknown>;
}

/** Outcome counts of a knowledge indexing operation (see KnowledgeProvider). */
export interface IndexSummary {
  indexed: number;
  skipped?: number;
  deleted?: number;
}

// ---------------------------------------------------------------------------
// DataForSEO (normalized research output)
// ---------------------------------------------------------------------------

/**
 * Normalized DataForSEO keyword-research output. `location_code` /
 * `language_code` are the DataForSEO market identifiers that were queried;
 * `search_volume` / `cpc` / `competition` / `difficulty` are market metrics
 * (null when the provider reported none - never filled with guesses); `serp`
 * is the current results page for the keyword and `monthly_searches` the
 * trailing monthly volume distribution when available.
 */
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

/**
 * A competitor result observed for a keyword during research: the ranking
 * domain/URL plus position. `keyword` is the keyword the observation is for
 * and `serp_item` the underlying raw SERP entry when one was captured.
 */
export interface CompetitorItem {
  domain: string;
  url: string;
  title: string | null;
  description: string | null;
  position: number | null;
  keyword: string;
  serp_item: SerpItem | null;
}

/** Alias over ProviderId so generic provider surfaces accept any registered provider id. */
export type ProviderGeneric = ProviderId;
