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
  AICapability,
  DataSourceCapability,
  IsoDate,
  KnowledgeCapability,
  MediaCapability,
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
// Knowledge fetcher (URL -> document extraction)
// ---------------------------------------------------------------------------
//
// URL knowledge sources are fetched and extracted by a KnowledgeFetcher before
// entering the same normalize -> chunk -> index pipeline as pasted text. The
// fetcher is a pure external-content adapter: it holds no credentials from the
// database, never touches Qdrant/Postgres/HTTP routes, and treats everything it
// returns as untrusted data. Jina is the first implementation; the interface is
// the seam for adding/replacing fetchers later.

export interface KnowledgeFetchOptions {
  /** Caller cancellation, combined with the fetcher's own timeout. */
  signal?: AbortSignal;
}

/**
 * One fetched + extracted external document. `contentText` is the extracted
 * body (untrusted), never HTML markup that the application interprets; callers
 * normalize and chunk it like any other source.
 */
export interface FetchedDocument {
  /** The URL that was requested (the source's primary identity). */
  sourceUrl: string;
  /** Provider-reported canonical URL, when offered. Never an authorization input. */
  canonicalUrl?: string;
  /** Provider-reported document title, when offered. */
  title?: string;
  contentText: string;
  contentType?: string;
  fetchedAt: string;
}

export interface KnowledgeFetcher {
  readonly id: string;
  readonly name: string;
  /** False when the server lacks the credentials this fetcher needs. */
  isConfigured(): boolean;
  /** Fetch + extract one URL. Throws a normalized ingestion error on failure. */
  fetch(url: string, options?: KnowledgeFetchOptions): Promise<FetchedDocument>;
}

// ---------------------------------------------------------------------------
// Knowledge file extraction (uploaded documents -> text)
// ---------------------------------------------------------------------------
//
// Uploaded files (KB4) are extracted to text by a KnowledgeFileExtractor before
// entering the exact same normalize -> chunk -> index pipeline as pasted text
// and fetched URLs. Extractors are pure: they receive bytes in memory, never
// touch storage/Postgres/Qdrant/HTTP, never execute embedded scripts or fetch
// external URLs, and hand back only plain text treated as untrusted data.
// `bytes` is a Uint8Array so the contract stays runtime-agnostic (the API
// passes a Node Buffer, which is a Uint8Array subclass).

export type KnowledgeFileFormat = 'txt' | 'md' | 'pdf' | 'docx';

/** One uploaded file in memory, already validated at the HTTP boundary. */
export interface KnowledgeFile {
  /** Original display filename (sanitized at the boundary; never a server path). */
  filename: string;
  /** Declared/validated MIME type. */
  contentType: string;
  /** Byte length of `bytes`. */
  size: number;
  /** Raw file bytes. */
  bytes: Uint8Array;
}

/** Plain-text extraction result: no HTML, no formatting commands. */
export interface ExtractedDocument {
  contentText: string;
  title?: string;
  contentType: string;
}

export interface KnowledgeFileExtractor {
  readonly id: string;
  readonly name: string;
  readonly formats: readonly KnowledgeFileFormat[];
  /** True when this extractor handles the file's format/type. */
  supports(file: KnowledgeFile): boolean;
  /** Extract plain text. Throws a normalized ingestion error on failure. */
  extract(file: KnowledgeFile): Promise<ExtractedDocument>;
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
// Publisher OAuth connect (authorization-code with PKCE)
// ---------------------------------------------------------------------------
//
// Some publishers (e.g. X) connect by sending the user through the provider's
// consent screen instead of typing credentials into a form. The generic
// publisher routes own the flow (state, callback, encrypted token storage);
// each provider implements this connector so no X-specific logic lives in the
// generic routes or the UI.

/** Raw token response from an OAuth 2.0 token endpoint (provider-agnostic). */
export interface OAuthTokenResult {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

/** Account identity discovered after a successful OAuth connect. */
export interface OAuthAccountIdentity {
  id: string;
  name?: string;
  username?: string;
}

export interface PublisherOAuthConnector {
  readonly providerId: string;
  /** False when the server is missing the env this connector needs (e.g. client id). */
  readonly configured: boolean;
  /** Scopes requested on the consent screen (provider-specific). */
  readonly scopes: string;
  /** Consent URL the browser is sent to (PKCE code flow). */
  authorizeUrl(opts: { redirectUri: string; state: string; codeChallenge: string }): string;
  /** Exchange the callback authorization code at the token endpoint. */
  exchangeCode(opts: { code: string; redirectUri: string; codeVerifier: string }): Promise<OAuthTokenResult>;
  /** Persist the fresh token pair into the publisher's encrypted credential scope. */
  saveTokens(ctx: ProviderContext, tokens: OAuthTokenResult): Promise<void>;
  /** Read + describe the connected account using stored tokens (provider users/me). */
  fetchIdentity(ctx: ProviderContext): Promise<OAuthAccountIdentity>;
}

// ---------------------------------------------------------------------------
// AI providers (chat/generation + embeddings)
// ---------------------------------------------------------------------------
//
// Application services (content agent, embedding service, analysis) depend on
// this interface only. Which provider answers is decided by configuration and
// per-project credentials resolved server-side - never by the browser.

export type AIChatRole = 'system' | 'user' | 'assistant';

export interface AIChatMessage {
  role: AIChatRole;
  content: string;
}

export interface AIChatRequest {
  messages: AIChatMessage[];
  /** Provider model id; when omitted the provider default is used. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Structured output schema hint (JSON object the model must conform to). */
  json?: boolean;
}

export interface AIChatResult {
  content: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AIGenerateRequest {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}

export interface AIEmbeddingRequest {
  input: string | string[];
  model?: string;
}

export interface AIEmbeddingResult {
  vectors: number[][];
  model: string;
  usage?: { inputTokens?: number };
}

export interface AIModelInfo {
  id: string;
  name?: string;
  kind: 'chat' | 'embedding';
  contextWindow?: number;
}

export interface AIProvider {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly AICapability[];

  /** Whether the provider is usable with the resolved server credentials. */
  isConfigured(): boolean;
  /** List models the provider can serve (config defaults merged in first). */
  models(): AIModelInfo[];
  chat(req: AIChatRequest): Promise<AIChatResult>;
  generate(req: AIGenerateRequest): Promise<AIChatResult>;
  embed(req: AIEmbeddingRequest): Promise<AIEmbeddingResult>;
}

// ---------------------------------------------------------------------------
// Media providers (image search / generation / upload)
// ---------------------------------------------------------------------------
//
// Content Studio inserts media placeholders; image resolution happens through
// a MediaProvider (Unsplash search, OpenAI image generation, ...). The web UI
// never holds media vendor secrets.

export interface MediaSearchOptions {
  query: string;
  limit?: number;
  orientation?: 'landscape' | 'portrait' | 'squarish';
}

export interface MediaResult {
  id: string;
  url: string;
  thumbUrl?: string;
  width?: number;
  height?: number;
  description?: string;
  source: string;
}

export interface MediaGenerateOptions {
  prompt: string;
  size?: '1024x1024' | '1792x1024' | '1024x1792';
}

export interface MediaProvider {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: readonly MediaCapability[];

  isConfigured(): boolean;
  search?(opts: MediaSearchOptions): Promise<MediaResult[]>;
  generate?(opts: MediaGenerateOptions): Promise<MediaResult>;
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
export type AIFactory = (deps: ProviderDeps) => AIProvider;
export type MediaFactory = (deps: ProviderDeps) => MediaProvider;

/** One non-secret field the connect UI should render for a publisher. */
export interface PublisherSetupField {
  key: string;
  label: string;
  type?: 'text' | 'url' | 'password';
  placeholder?: string;
}

/**
 * Publisher-only connect/setup hints served through the catalog. Values are
 * field *shapes* (keys/labels), never secrets - the UI renders these instead of
 * hardcoding per-vendor screens, and the API only ever accepts keys declared
 * here. `category` groups publishers in the UI (e.g. website vs social).
 */
export interface PublisherSetupHint {
  category?: string;
  /**
   * How the user connects this publisher: 'form' (typed credential fields,
   * default) or 'oauth' (the UI shows a "Connect with <name>" button that runs
   * the generic OAuth flow registered for the provider).
   */
  auth?: 'form' | 'oauth';
  /** Non-secret persisted settings stored on seo_publishers.config. */
  config?: PublisherSetupField[];
  /** Credential fields stored encrypted server-side via the credentials API. */
  credentials?: PublisherSetupField[];
  /** Plain informational note shown in the connect card (e.g. "demo only"). */
  note?: string;
}

export interface ProviderDescriptor<T = unknown> {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  kind: 'datasource' | 'knowledge' | 'publisher' | 'ai' | 'media';
  /** UI hints (icon key, color). */
  ui?: { icon: string; color?: string };
  /** Publisher connect/setup hints (see PublisherSetupHint). */
  setup?: PublisherSetupHint;
}

export interface ProviderRegistry {
  registerDataSource(factory: DataSourceFactory, descriptor: Omit<ProviderDescriptor, 'kind'>): void;
  registerKnowledge(factory: KnowledgeFactory, descriptor: Omit<ProviderDescriptor, 'kind'>): void;
  registerPublisher(factory: PublisherFactory, descriptor: Omit<ProviderDescriptor, 'kind'>): void;
  /** Register the OAuth connector for a publisher provider (connect-by-consent). */
  registerPublisherOAuth(factory: (deps: ProviderDeps) => PublisherOAuthConnector, providerId: string): void;
  registerAI(factory: AIFactory, descriptor: Omit<ProviderDescriptor, 'kind'>): void;
  registerMedia(factory: MediaFactory, descriptor: Omit<ProviderDescriptor, 'kind'>): void;

  getDataSource(id: string): SeoDataSource | undefined;
  getKnowledge(id: string): KnowledgeProvider | undefined;
  getPublisher(id: string): PublisherProvider | undefined;
  getPublisherOAuth(id: string): PublisherOAuthConnector | undefined;
  getAI(id: string): AIProvider | undefined;
  getMedia(id: string): MediaProvider | undefined;

  listDataSources(): ProviderDescriptor<'datasource'>[];
  listKnowledge(): ProviderDescriptor<'knowledge'>[];
  listPublishers(): ProviderDescriptor<'publisher'>[];
  listAI(): ProviderDescriptor<'ai'>[];
  listMedia(): ProviderDescriptor<'media'>[];
}
