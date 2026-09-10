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
