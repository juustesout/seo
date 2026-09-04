/**
 * Provider abstraction layer.
 *
 * The SEO Core, application services and UI depend ONLY on these interfaces.
 * Concrete implementations (Google Search Console, DataForSEO, Qdrant,
 * WordPress, a future crawler, ...) live behind adapters that are registered
 * in a ProviderRegistry. Adding a provider = implementing the matching
 * interface + registering it - never touching the core or the UI.
 */

import type {
  DataSourceCapability,
  IsoDate,
  KnowledgeCapability,
  PublisherCapability,
} from './common.js';
import type {
  AuditFinding,
  ContentItem,
  Keyword,
  KeywordPerformance,
  KeywordResearchResult,
  KnowledgeDocumentInput,
  KnowledgeSearchResult,
  Page,
  PagePerformance,
  SerpSnapshot,
} from './models.js';

// ---------------------------------------------------------------------------
// Shared runtime context passed to every provider call
// ---------------------------------------------------------------------------

export interface ProviderLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Server-side reader/writer for the provider's own secrets. Backed by the
 * encrypted `seo_credentials` table in production. Values never cross to the
 * browser.
 */
export interface CredentialReader {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, meta?: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ProviderContext {
  /** Project the operation is running for. Never undefined. */
  projectId: string;
  /** Authenticated acting user, if any (background jobs pass null). */
  userId: string | null;
  /** Non-secret, persisted integration/data-source config. */
  config: Record<string, unknown>;
  credentials: CredentialReader;
  logger: ProviderLogger;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------------

export interface DateRange {
  startDate: IsoDate;
  endDate: IsoDate;
}

export interface DataSourceConnectionResult {
  ok: boolean;
  message?: string;
  /** Provider-side handles/ids discovered during connect (e.g. GSC properties). */
  external?: Array<{ id: string; label: string; url?: string; extra?: Record<string, unknown> }>;
}

export interface SeoDataSource {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly DataSourceCapability[];

  /** Establish the connection using server-side stored credentials. */
  connect(ctx: ProviderContext): Promise<DataSourceConnectionResult>;
  /** Tear down/disable a connection. May be a no-op for stateless sources. */
  disconnect(ctx: ProviderContext): Promise<void>;
  /** Verify stored credentials still work. */
  testConnection(ctx: ProviderContext): Promise<{ ok: boolean; message?: string }>;

  /**
   * Optional provider-specific retrieval entry points. Adapters expose richer
   * typed operations (e.g. GSC daily/query/page fetches) on their concrete
   * class; the SEO Core normalizes + persists through SeoWriter.
   */
  getKeywords?(ctx: ProviderContext, range: DateRange): Promise<Keyword[]>;
  getPages?(ctx: ProviderContext, range: DateRange): Promise<Page[]>;
  getRankings?(ctx: ProviderContext, range: DateRange): Promise<import('./models.js').Ranking[]>;
  getPerformance?(ctx: ProviderContext, range: DateRange): Promise<{
    daily: Array<{ date: IsoDate; clicks: number; impressions: number; ctr: number; position: number }>;
    keywords: KeywordPerformance[];
    pages: PagePerformance[];
  }>;
  getSerp?(ctx: ProviderContext, keywords: string[], range?: DateRange): Promise<SerpSnapshot[]>;
  getCompetitors?(ctx: ProviderContext, keywords: string[]): Promise<import('./models.js').CompetitorItem[]>;
  researchKeywords?(ctx: ProviderContext, keywords: string[]): Promise<KeywordResearchResult[]>;
  crawl?(ctx: ProviderContext, startUrls: string[]): Promise<{ pages: Page[]; findings: AuditFinding[] }>;
}

// ---------------------------------------------------------------------------
// Knowledge provider
// ---------------------------------------------------------------------------

export interface KnowledgeSearchOptions {
  projectId: string;
  query: string;
  limit?: number;
  filter?: Record<string, string | string[]>;
}

export interface KnowledgeProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly KnowledgeCapability[];

  /** Build the logical knowledge base for a project (idempotent). */
  ensureProject(ctx: ProviderContext): Promise<void>;
  /** Index documents for a project. */
  index(ctx: ProviderContext, documents: KnowledgeDocumentInput[]): Promise<{ indexed: number }>;
  /** Replace the project index content in one go (used by full reindex). */
  reindex(ctx: ProviderContext, documents: KnowledgeDocumentInput[]): Promise<{ indexed: number; deleted: number }>;
  /** Remove a single document by external id. */
  delete(ctx: ProviderContext, externalId: string): Promise<void>;
  /** Delete the whole project knowledge base. */
  deleteProject(ctx: ProviderContext): Promise<void>;
  /** Vector + metadata search scoped to a project. */
  search(opts: KnowledgeSearchOptions): Promise<KnowledgeSearchResult[]>;
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

export interface PublishInput {
  title: string;
  /** Body. Supports the destination's native format when possible (markdown/html). */
  content: string;
  contentFormat?: 'markdown' | 'html' | 'plain';
  excerpt?: string;
  slug?: string;
  status?: 'draft' | 'publish';
  categories?: string[];
  tags?: string[];
  meta?: Record<string, string>;
  scheduledFor?: Date;
}

export interface PublishResult {
  remoteId: string;
  url: string | null;
}

export interface PublisherProvider {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly PublisherCapability[];
  readonly description: string;

  connect(ctx: ProviderContext): Promise<DataSourceConnectionResult>;
  disconnect(ctx: ProviderContext): Promise<void>;
  testConnection(ctx: ProviderContext): Promise<{ ok: boolean; message?: string }>;

  publish(ctx: ProviderContext, input: PublishInput): Promise<PublishResult>;
  update(ctx: ProviderContext, remoteId: string, input: PublishInput): Promise<PublishResult>;
  delete(ctx: ProviderContext, remoteId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

export interface ProviderDeps {
  config: Record<string, string | undefined>;
  logger: ProviderLogger;
  fetchFn?: typeof fetch;
}

export type DataSourceFactory = (deps: ProviderDeps) => SeoDataSource;
export type KnowledgeFactory = (deps: ProviderDeps) => KnowledgeProvider;
export type PublisherFactory = (deps: ProviderDeps) => PublisherProvider;

export interface ProviderDescriptor<T = unknown> {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  kind: 'datasource' | 'knowledge' | 'publisher';
  /** UI hints (icon key, color). */
  ui?: { icon: string; color?: string };
}

export interface ProviderRegistry {
  registerDataSource(factory: DataSourceFactory, descriptor: Omit<ProviderDescriptor, 'kind'>): void;
  registerKnowledge(factory: KnowledgeFactory, descriptor: Omit<ProviderDescriptor, 'kind'>): void;
  registerPublisher(factory: PublisherFactory, descriptor: Omit<ProviderDescriptor, 'kind'>): void;

  getDataSource(id: string): SeoDataSource | undefined;
  getKnowledge(id: string): KnowledgeProvider | undefined;
  getPublisher(id: string): PublisherProvider | undefined;

  listDataSources(): ProviderDescriptor<'datasource'>[];
  listKnowledge(): ProviderDescriptor<'knowledge'>[];
  listPublishers(): ProviderDescriptor<'publisher'>[];
}
