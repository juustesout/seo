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
import type { TipDoc } from './contentDoc.js';
import type { SeoResult } from './seo.js';

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
// Writer Agent integration (Content Studio) - project/content-scoped runs
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one writer run as seen by the API/UI. The W8 revision loop
 * turns `review_ready` into the resting, revisable state: a run whose W5
 * deterministic review produced a canonical artifact pauses there and can be
 * revised (AI rewrites the selected sections) any number of times before it is
 * explicitly accepted. The states a caller can actually meet are:
 * `awaiting_approval` (proposed plan, paused on the human gate), `writing`
 * (an approved run is actively writing the first generation), `reviewing`
 * (the deterministic re-review is running), `review_ready` (resting result,
 * revision hub - non-terminal), `revising` (AI is rewriting the selected
 * sections), `completed` (terminal, reserved for an explicit accept that W8
 * does not auto-reach), `rejected` and `failed`. The transient vocabulary
 * (starting/gathering_context/planning) is kept for forward compatibility but
 * is never fabricated: the graph rests on `review_ready` only after its
 * deterministic review ran, never before.
 */
export type WriterRunStatus =
  | 'starting'
  | 'gathering_context'
  | 'planning'
  | 'awaiting_approval'
  | 'writing'
  | 'reviewing'
  | 'revising'
  | 'review_ready'
  | 'completed'
  | 'rejected'
  | 'failed';

/**
 * One planned section of a writer proposal: heading + content targets. Each
 * section carries a stable, backend-validated identity (`section_<index>`,
 * derived from the approved plan) so a W8 revision request can address
 * exactly the sections it wants without relying on UI order or heading text.
 */
export interface WriterRunPlanSectionDto {
  sectionId: string;
  heading: string;
  keyPoints: string[];
  suggestedKeywords: string[];
}

/**
 * The structural article plan the writer proposes (the W2 output). Plain,
 * bounded and UI-safe: never article body text and never related-content
 * internals.
 */
export interface WriterRunPlanDto {
  title: string;
  metaDescription: string | null;
  introductionPurpose: string;
  sections: WriterRunPlanSectionDto[];
}

/**
 * The canonical review artifact the W5 phase produces for a completed run.
 * Reuses the canonical contracts shapes (TipDoc content_json, rendered
 * content_html, full evaluateSeo result) - no parallel writer model.
 */
export interface WriterRunReviewDto {
  /** Canonical Tiptap document (a future explicit Apply would save this as
   *  seo_content.content_json; W6 never saves it automatically). */
  contentJson: TipDoc;
  /** Canonical render of the document via the existing renderer. */
  contentHtml: string;
  /** Full output of the existing Phase C evaluateSeo evaluator. */
  seo: SeoResult;
}

/**
 * A safe writer-run snapshot for the UI: identity bound to exactly one
 * project+content pair, the proposed plan, an optional human note (rejection
 * reason / honest failure message) and - once the run rests on `review_ready`
 * or later - the W5 canonical review artifact. It never carries prompts,
 * internal graph state, checkpoint data or credentials. `revisionCount` /
 * `lastRevisionAt` let the UI show how many times this run has been revised
 * without leaking the revision request wording.
 */
export interface WriterRunDto {
  runId: string;
  projectId: string;
  contentId: string;
  status: WriterRunStatus;
  plan: WriterRunPlanDto | null;
  note: string | null;
  review: WriterRunReviewDto | null;
  /** Number of W8 revisions applied to this run (0 when never revised). */
  revisionCount: number;
  /** ISO timestamp of the most recent revision round, if any. */
  lastRevisionAt: string | null;
  /** The Section Magic action currently being applied, present only while the
   *  run is `revising` through a magic request (so the UI can say exactly what
   *  the AI is doing and that it is a proposal, not an auto-acceptance). Null
   *  for a plain W8 revision or when the run is not mid-revision. */
  magicAction: WriterMagicAction | null;
  /** Bounded, durable "research context" the human explicitly gathered for this
   *  run (W10.2). Null until the human triggers a research operation; once
   *  gathered it survives restarts and is offered to later revision/magic
   *  rounds as untrusted reference material only - it is never applied
   *  automatically and never changes the workflow. */
  evidence: WriterEvidenceDto | null;
  /** Bounded, durable "intelligence" the human explicitly gathered for this run
   *  (W10.3): combined, project-scoped signals (knowledge, existing content,
   *  keyword demand, Search Console, Phase G intelligence). Null until an
   *  intelligence operation runs; once gathered it is reference material only -
   *  never applied automatically and never a workflow command. */
  intelligence: WriterIntelligenceDto | null;
  /** Bounded W10.4 agent coordinator state for this run: the explicit goal the
   *  human started, the safe per-step summaries of the actions it chose from the
   *  fixed allowlist and the honest terminal status. Null until an agent run is
   *  started. It never carries prompts, chain-of-thought, credentials or raw
   *  provider output. */
  agent: WriterAgentDto | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Writer advanced agent (W10.4) - bounded, allowlisted multi-step coordination
// ---------------------------------------------------------------------------

/**
 * Lifecycle of one bounded agent coordination run. `idle` is the resting/absent
 * value, `running` means the bounded loop is choosing/executing allowlisted
 * actions, `awaiting_approval` is reserved for a future explicit approval gate,
 * `completed` means the loop chose `finish`, `limit_reached` means a step or
 * per-action budget stopped it and `failed` means a decision could not be
 * validated or an action failed honestly. The agent never auto-applies or
 * publishes.
 */
export type WriterAgentStatus = 'idle' | 'running' | 'awaiting_approval' | 'completed' | 'limit_reached' | 'failed';

/** The only actions the W10.4 coordinator may choose. `research`, `intelligence`
 *  and `review` are read-only/observational; `magic` and `revision` mutate prose
 *  only through the existing controlled revision boundary; `finish` stops. */
export type WriterAgentAction = 'research' | 'intelligence' | 'magic' | 'revision' | 'review' | 'finish';

/** Bounded goal vocabulary the human can start the coordinator with. There is
 *  no free-form autonomy: the goal only biases which allowlisted actions the
 *  coordinator prefers. */
export type WriterAgentGoal =
  | 'improve_evidence'
  | 'improve_seo'
  | 'improve_clarity'
  | 'deep_research'
  | 'section_improvement';

/** Status of one recorded agent step. */
export type WriterAgentStepStatus = 'planned' | 'running' | 'completed' | 'failed';

/** One safe, human-readable agent step. It carries only the chosen action, its
 *  status and a bounded summary - never prompts, reasoning or raw payloads. */
export interface WriterAgentStepDto {
  index: number;
  action: WriterAgentAction;
  status: WriterAgentStepStatus;
  summary: string | null;
}

/** The durable W10.4 agent state of a writer run. It is a safe progress record,
 *  never a reasoning trace. */
export interface WriterAgentDto {
  status: WriterAgentStatus;
  goal: WriterAgentGoal;
  /** Bounded, untrusted user instruction, or null. It never grants a capability. */
  instruction: string | null;
  /** Server-bounded step budget the run was started with. */
  maxSteps: number;
  stepCount: number;
  steps: WriterAgentStepDto[];
  /** How many times each action was actually executed. */
  actionCounts: Record<WriterAgentAction, number>;
  note: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Start one bounded agent coordination run on a `review_ready` writer run.
 *  `max_steps` is optional and server-bounded; `instruction` is untrusted user
 *  intent that can never add capabilities; `sections` are optional plan-scoped
 *  ids. */
export interface WriterAgentRequest {
  goal: WriterAgentGoal;
  max_steps?: number;
  instruction?: string;
  sections?: string[];
}

// ---------------------------------------------------------------------------
// Writer research & evidence (W10.2) - bounded, untrusted research context
// ---------------------------------------------------------------------------

/** Which safe, project-scoped read a piece of research evidence came from.
 *  `search` is part of the canonical vocabulary but stays unwired (deny by
 *  default) until an explicit, project-scoped search source exists. */
export type WriterEvidenceSource = 'knowledge' | 'existing_content' | 'search' | 'intelligence';

/** Honest availability of one research source. A source that is not wired or
 *  not configured is reported as such - never padded with invented fallback. */
export type WriterEvidenceStatus = 'available' | 'empty' | 'not_configured' | 'unavailable';

/**
 * One bounded, sanitized piece of research context. It is reference material,
 * never truth and never an instruction: every item is labelled `untrusted` and
 * carries only the fields a safe UI/prompt may show (source type, optional
 * title/url, a capped text slice and small typed metadata). It never contains
 * credentials, raw provider responses, tokens, database or worker internals.
 */
export interface WriterEvidenceItemDto {
  /** Stable id within the run, e.g. `knowledge:0`. */
  id: string;
  source: WriterEvidenceSource;
  title: string | null;
  /** Capped, sanitized text (may be empty when the source has no body text,
   *  e.g. an existing-content row). */
  text: string;
  /** Present only when the source itself provided one; never invented. */
  url: string | null;
  /** When this evidence was retrieved, if the source provides it. */
  retrievedAt: string | null;
  /** Retrieved content is data, never instructions. */
  trust: 'untrusted';
  metadata?: Record<string, string | number | boolean | null>;
}

/** One research source with its honest status and bounded items. */
export interface WriterEvidenceSourceDto {
  source: WriterEvidenceSource;
  status: WriterEvidenceStatus;
  note: string | null;
  items: WriterEvidenceItemDto[];
}

/**
 * The durable research context of a writer run (W10.2): the per-source honest
 * result of the last explicit research operation the human triggered. Absent
 * (null on WriterRunDto.evidence) until research runs; once gathered it is
 * shown as "research context" - reference material, not verified facts - and
 * later revision/magic rounds may use it as untrusted material only.
 */
export interface WriterEvidenceDto {
  /** ISO timestamp of the gather, or null when nothing was ever gathered. */
  gatheredAt: string | null;
  sources: WriterEvidenceSourceDto[];
}

// ---------------------------------------------------------------------------
// Writer intelligence / deeper research (W10.3) - bounded, untrusted signals
// ---------------------------------------------------------------------------

/** Overall honesty of an intelligence gather. `partial` means at least one
 *  source produced usable findings while another relevant source was empty /
 *  not configured / unavailable; `not_configured` means no source is wired and
 *  `unavailable` means every wired source failed - never a fabricated result. */
export type WriterIntelligenceStatus = 'available' | 'partial' | 'empty' | 'not_configured' | 'unavailable';

/** Safe, project-scoped reads a piece of intelligence may be combined from.
 *  `content_intelligence` is the Phase G deterministic report; `gsc` is its
 *  Search Console signal; `dataforseo` is tracked keyword demand. */
export type WriterIntelligenceSource =
  | 'knowledge'
  | 'existing_content'
  | 'dataforseo'
  | 'gsc'
  | 'content_intelligence';

/** The kind of signal a finding represents. */
export type WriterIntelligenceFindingType = 'keyword' | 'opportunity' | 'overlap' | 'knowledge' | 'content';

/**
 * One bounded, sanitized intelligence finding. It is reference material, never
 * truth and never an instruction: every finding is labelled `untrusted`, carries
 * a capped summary and stable evidence references, and never contains
 * credentials, raw provider responses or internal state.
 */
export interface WriterIntelligenceFindingDto {
  /** Stable id within the run, e.g. `keyword:0`. */
  id: string;
  type: WriterIntelligenceFindingType;
  /** Capped, single-block summary of the signal. */
  summary: string;
  /** Stable references to the source rows the finding was derived from. */
  evidenceIds: string[];
  /** Retrieved/derived intelligence is data, never instructions. */
  trust: 'untrusted';
}

/** One intelligence source with its honest status and finding count. */
export interface WriterIntelligenceSourceDto {
  source: WriterIntelligenceSource;
  status: WriterEvidenceStatus;
  note: string | null;
  findingCount: number;
}

/**
 * The durable intelligence snapshot of a writer run (W10.3): the combined,
 * bounded signals from the project's own sources. Absent (null on
 * WriterRunDto.intelligence) until the human explicitly runs an intelligence
 * gather; once gathered it is shown as "intelligence" - reference material, not
 * verified facts - and later revision/magic rounds may use it only as
 * untrusted context. It never changes the workflow automatically.
 */
export interface WriterIntelligenceDto {
  /** ISO timestamp of the gather, or null when nothing was ever gathered. */
  gatheredAt: string | null;
  status: WriterIntelligenceStatus;
  findings: WriterIntelligenceFindingDto[];
  sources: WriterIntelligenceSourceDto[];
  note: string | null;
}

/** Start a writer run for one content item. `instruction` (optional) becomes
 *  the run's topic; without one the content title is used. */
export interface WriterStartRequest {
  instruction?: string;
}

/**
 * Request a W8 revision of one `review_ready` writer run. The strict grammar
 * is validated server-side by the shared writer revision gate (mirroring the
 * W3 approval boundary): `sectionIds` must address stable, plan-validated
 * section identities and `instruction` must be present and bounded. A
 * revision only ever rewrites the selected sections; the approved plan and
 * every unselected section are preserved as-is.
 */
export interface WriterReviseRequest {
  sectionIds: string[];
  instruction: string;
}

// ---------------------------------------------------------------------------
// Writer Section Magic (W10.1) - controlled, user-triggered transformations
// ---------------------------------------------------------------------------

/**
 * The canonical Section Magic action vocabulary (W10.1). Each action has
 * deterministic prompt semantics and only ever rewrites the body of the
 * explicitly selected section(s) the user chose - never the approved outline,
 * other sections or the workflow. Unknown action strings are rejected.
 */
export type WriterMagicAction =
  | 'improve'
  | 'expand'
  | 'shorten'
  | 'clarify'
  | 'change_tone'
  | 'add_examples'
  | 'improve_seo'
  | 'custom';

/**
 * Bounded, validated tone choices for the `change_tone` magic action. The
 * tone itself is never free text: it must be one of these canonical values.
 */
export type WriterMagicTone =
  | 'professional'
  | 'friendly'
  | 'authoritative'
  | 'conversational'
  | 'formal'
  | 'persuasive'
  | 'practical'
  | 'casual';

/**
 * A Section Magic request (W10.1): the user explicitly picks the action and
 * the sections to transform. `instruction` is an optional bounded prose
 * refinement - it is untrusted user intent that may influence prose only and
 * can never control the workflow, the outline or other sections. `tone` is
 * required (and `instruction` must be absent) for `change_tone`; `custom`
 * requires an `instruction`.
 */
export interface WriterMagicRequest {
  sectionIds: string[];
  action: WriterMagicAction;
  instruction?: string;
  tone?: WriterMagicTone;
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

/**
 * Retrieval (KB6) - canonical, attributed, bounded search over the project
 * knowledge base. The retrieval index (Qdrant) is a ranking signal only:
 * `score` is a similarity/retrieval score, never confidence, truth or quality.
 * Result content is untrusted plain text and is always bounded server-side.
 */

/** Bounded default number of retrieval results returned per search. */
export const KNOWLEDGE_SEARCH_DEFAULT_LIMIT = 10;

/** Hard maximum number of retrieval results a client can request. */
export const KNOWLEDGE_SEARCH_MAX_LIMIT = 50;

/** Longest retrieval query accepted (bound before it reaches the provider). */
export const KNOWLEDGE_SEARCH_QUERY_MAX_CHARS = 1000;

/** Hard cap on the plain-text content returned for one retrieval hit. */
export const KNOWLEDGE_SEARCH_CONTENT_MAX_CHARS = 1200;

/** Maximum number of source ids a client may filter one search by. */
export const KNOWLEDGE_SEARCH_MAX_SOURCE_FILTERS = 50;

/** Retrieval request: a required query plus bounded, allowlisted filters. */
export interface KnowledgeSearchRequest {
  query: string;
  limit?: number;
  /** Restrict to these managed source types (project scoped). */
  source_types?: KnowledgeSourceType[];
  /** Restrict to these managed source ids (UUIDs, project scoped). */
  source_ids?: string[];
  /**
   * Restrict retrieval to one collection (KB8, project scoped). Omit to search
   * all project knowledge. Mutually exclusive with `uncategorized`.
   */
  collection_id?: string;
  /**
   * Restrict retrieval to sources that belong to no collection (KB8). Explicit,
   * so `collection_id` is never overloaded to mean "the null collection".
   * Mutually exclusive with `collection_id`.
   */
  uncategorized?: boolean;
}

/**
 * One canonical retrieval hit. Source attribution is mandatory: a hit that
 * cannot be attributed to a source is never returned (fail closed). `content`
 * is a bounded plain-text excerpt and must be treated as untrusted data.
 */
export interface KnowledgeSearchHitDto {
  /** Stable source identifier. For managed sources this is the project's
   *  source UUID (open it in Source Detail); for system-indexed knowledge it is
   *  the provider external id. Never a Qdrant/vector point id. */
  source_id: string;
  source_name: string;
  source_type: KnowledgeSourceType;
  /** Public source URL when the indexed item has one; never a storage path. */
  source_url: string | null;
  /** True when `source_id` is a managed Knowledge Source (KB5) and can be
   *  opened in Source Detail. */
  managed: boolean;
  /** Organizational collection of the source (KB8), or null when uncategorized
   *  or not a managed source. Organizational attribution only - not evidence. */
  collection_id: string | null;
  /** Display name of `collection_id`, or null when uncategorized/unresolved. */
  collection_name: string | null;
  /** 0-based chunk position within the source, when the index recorded it. */
  chunk_index: number | null;
  /** Bounded plain-text excerpt of the matched chunk. Untrusted data. */
  content: string;
  /** Provider retrieval/similarity score (higher = closer). A ranking signal
   *  only - it is not evidence of correctness and is never normalized here. */
  score: number;
}

/** Honest, server-measured retrieval metadata. Never raw provider internals. */
export interface KnowledgeSearchDiagnosticsDto {
  /** Number of attributed results in this response. */
  result_count: number;
  /** Registered retrieval provider id (e.g. `qdrant`). */
  provider: string;
  /** Wall time spent in the provider retrieval call, in milliseconds. */
  search_duration_ms: number;
}

/** Canonical retrieval response, scoped to one project. */
export interface KnowledgeSearchResponse {
  project_id: string;
  /** The normalized query that was actually executed. */
  query: string;
  /** The bounded result limit that was applied. */
  limit: number;
  results: KnowledgeSearchHitDto[];
  diagnostics: KnowledgeSearchDiagnosticsDto;
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

/**
 * Canonical lifecycle of a knowledge source. Postgres is the source of truth:
 *   draft      -> stored but not yet ingestable (e.g. a URL awaiting fetch)
 *   queued     -> an ingest job is pending
 *   processing -> an ingest job is running
 *   ready      -> vectors exist for this source
 *   failed     -> the last ingest failed; see the source's `error`
 *   deleted    -> the source is being torn down (vectors + row)
 */
export type KnowledgeSourceStatus = 'draft' | 'queued' | 'processing' | 'ready' | 'failed' | 'deleted';

/**
 * Canonical kind of knowledge source. `text` is pasted/typed content, `url` is
 * a reference awaiting fetch (KB3), `file` is uploaded content (KB4). Only
 * capabilities that actually exist are accepted by the server.
 */
export type KnowledgeSourceType = 'text' | 'url' | 'file';

/**
 * Logical model of one indexed knowledge item. Postgres is the source of truth
 * (ownership, lifecycle, metadata); vectors live in Qdrant under external_id
 * `source:<id>` and are only a retrieval index, never the record.
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
  /** Original uploaded filename (file sources only). */
  original_filename: string | null;
  /** Validated MIME type of the uploaded file (file sources only). */
  content_type: string | null;
  /** Uploaded file size in bytes (file sources only). */
  size_bytes: number | null;
  /**
   * Optional organizational collection (KB8). Null means uncategorized, which is
   * a valid, fully searchable state - never an error or a "missing" source.
   */
  collection_id: string | null;
  /** Display name of `collection_id`, or null when uncategorized/unresolved. */
  collection_name: string | null;
  /**
   * Derived freshness (KB7). Present for every source the API returns; `state`
   * is `unknown` and the policy null for text/file sources. Never stored.
   */
  freshness?: KnowledgeFreshnessDto;
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
  /** This page of sources for the current filter/sort (bounded by `limit`). */
  items: KnowledgeSourceDto[];
  /** Total sources matching the current filter (ignores pagination). */
  total: number;
  limit: number;
  offset: number;
  /** Project-level health counts, computed from the source registry. */
  summary: KnowledgeSourceSummaryDto;
}

export interface KnowledgeSourceCreateInput {
  /** text | url | file (defaults to 'text'). Legacy note/reference map to text at the API boundary. */
  source_type?: KnowledgeSourceType;
  name: string;
  url?: string | null;
  /** Body text to index. Required for a text source; URL-only sources stay draft until fetched. */
  text?: string | null;
}

// ---------------------------------------------------------------------------
// Knowledge Library (KB5) - listing, filtering, detail and project summary.
// The UI reads source metadata only through the API; Qdrant is never queried
// directly and no field here carries raw content_text or a storage path.
// ---------------------------------------------------------------------------

/** Canonical source types, exposed for UI filters (single vocabulary). */
export const KNOWLEDGE_SOURCE_TYPES = ['text', 'url', 'file'] as const;

/** Canonical statuses, exposed for UI filters (single vocabulary). */
export const KNOWLEDGE_SOURCE_STATUSES = [
  'draft',
  'queued',
  'processing',
  'ready',
  'failed',
  'deleted',
] as const;

/**
 * Server-side sort allowlist for the source list. Values map to fixed
 * column/direction pairs on the API - a client can never pass a raw SQL order.
 */
export const KNOWLEDGE_SOURCE_SORTS = [
  'updated_desc',
  'updated_asc',
  'indexed_desc',
  'indexed_asc',
  'name_asc',
  'name_desc',
] as const;

export type KnowledgeSourceSort = (typeof KNOWLEDGE_SOURCE_SORTS)[number];

/** Bounded, allowlisted query for the knowledge source list. */
export interface KnowledgeSourceListQuery {
  type?: KnowledgeSourceType;
  /** When omitted the API hides `deleted` sources; pass `deleted` to see them. */
  status?: KnowledgeSourceStatus;
  /** Metadata search over name/url/filename (never vector search). */
  search?: string;
  /** Restrict to one collection (KB8, project scoped). */
  collection_id?: string;
  /** Restrict to sources in no collection (KB8). Mutually exclusive with `collection_id`. */
  uncategorized?: boolean;
  sort?: KnowledgeSourceSort;
  limit?: number;
  offset?: number;
}

export interface KnowledgeSourceListResponse {
  items: KnowledgeSourceDto[];
  total: number;
  limit: number;
  offset: number;
}

/** Project-level source health summary (non-deleted sources only). */
export interface KnowledgeSourceSummaryDto {
  total: number;
  draft: number;
  queued: number;
  processing: number;
  ready: number;
  failed: number;
  total_chunks: number;
}

/** Bounded, read-only plain-text preview of a source's stored content. */
export interface KnowledgeSourcePreviewDto {
  /** First `KNOWLEDGE_PREVIEW_MAX_CHARS` characters of the stored body. */
  text: string;
  /** True when the stored body was longer than the cap and was cut. */
  truncated: boolean;
  /** Total character count of the stored body. */
  characters: number;
}

/**
 * One source with its safe detail surface. `preview` is present only for
 * `text`/`url` sources that actually captured a body; file sources have no
 * preview because the original bytes stay in private storage.
 */
export interface KnowledgeSourceDetailDto extends KnowledgeSourceDto {
  preview: KnowledgeSourcePreviewDto | null;
}

// ---------------------------------------------------------------------------
// Knowledge freshness & refresh lifecycle (KB7)
//
// Postgres stays the source of truth and Qdrant stays a derived index. For URL
// sources the registry records the facts (when it was fetched, whether the body
// changed, when it is next due and how often it failed); `state` is derived
// deterministically from those facts and is never stored. `content_hash` is
// internal-only and is deliberately absent from every DTO.
// ---------------------------------------------------------------------------

/** Canonical refresh cadence for a URL source. `manual` never auto-refreshes. */
export const KNOWLEDGE_REFRESH_POLICIES = ['manual', 'daily', 'weekly', 'monthly'] as const;

export type KnowledgeRefreshPolicy = (typeof KNOWLEDGE_REFRESH_POLICIES)[number];

/**
 * Derived freshness of a URL source. It is computed centrally from the stored
 * facts and the current time - never stored and never computed ad hoc in a
 * route or the UI:
 *   fresh   -> ready and not yet due (or manual with no schedule)
 *   due     -> ready and the scheduled check time has passed
 *   stale   -> ready and the schedule is strongly overdue
 *   unknown -> text/file sources, or a URL without a successful fetch
 */
export type KnowledgeFreshnessState = 'fresh' | 'due' | 'stale' | 'unknown';

/** Safe freshness metadata. Never carries a content hash, provider field or path. */
export interface KnowledgeFreshnessDto {
  state: KnowledgeFreshnessState;
  refresh_policy: KnowledgeRefreshPolicy | null;
  last_fetched_at: string | null;
  last_changed_at: string | null;
  next_refresh_at: string | null;
  refresh_failures: number;
}

/** Update a URL source's refresh cadence (editor+). */
export interface KnowledgeRefreshPolicyInput {
  refresh_policy: KnowledgeRefreshPolicy;
}

/**
 * One URL source that is due for a refresh. Returned by the service-level
 * `listDueRefreshes` capability (bounded, project-scoped) that a future
 * scheduler (KB9) will consume - there is no public dashboard in KB7.
 */
export interface KnowledgeDueRefreshDto {
  id: string;
  project_id: string;
  name: string;
  url: string | null;
  next_refresh_at: string;
  refresh_policy: KnowledgeRefreshPolicy;
  refresh_failures: number;
}

// ---------------------------------------------------------------------------
// Knowledge collections (KB8) - optional, project-scoped source organization
//
// Collections are organizational metadata, not a knowledge store: a source may
// belong to at most one collection, uncategorized is a valid normal state, and
// deleting a collection never deletes its sources. Collection names/descriptions
// are untrusted text. These DTOs are camelCase (like the Writer DTOs) to keep
// collection objects visually distinct from the snake_case source DTOs.
// ---------------------------------------------------------------------------

/** Longest collection name accepted (trimmed). */
export const KNOWLEDGE_COLLECTION_NAME_MAX_CHARS = 120;

/** Longest collection description accepted. */
export const KNOWLEDGE_COLLECTION_DESCRIPTION_MAX_CHARS = 500;

/** Maximum source ids movable in one bulk assignment (fail-closed beyond this). */
export const KNOWLEDGE_SOURCE_BULK_MAX_IDS = 100;

/** One project knowledge collection plus its source count. */
export interface KnowledgeCollectionDto {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  /** Number of non-deleted sources currently assigned to this collection. */
  sourceCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Create a collection (editor+). `description` is optional free text. */
export interface KnowledgeCollectionCreateRequest {
  name: string;
  description?: string | null;
}

/** Update a collection's name and/or description (editor+). */
export interface KnowledgeCollectionUpdateRequest {
  name?: string;
  description?: string | null;
}

/** Bounded, paginated collection list for one project. */
export interface KnowledgeCollectionsResponse {
  items: KnowledgeCollectionDto[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * One collection with a bounded page of its source summaries. `total` is the
 * collection's full source count; `items` is only the returned window.
 */
export interface KnowledgeCollectionDetailDto extends KnowledgeCollectionDto {
  items: KnowledgeSourceDto[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Move sources into a collection, or out of any collection with
 * `collection_id: null` (KB8). Applied atomically and fail-closed: if any id is
 * unknown or in another project nothing is changed.
 */
export interface KnowledgeSourceBulkAssignRequest {
  source_ids: string[];
  collection_id: string | null;
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
