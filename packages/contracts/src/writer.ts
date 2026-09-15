/**
 * Writer contracts (W1: Writer Engine core + Quick Draft).
 *
 * These types define the canonical input the shared Writer Engine consumes.
 * The existing "writer agent" state types (WriterPlan / WriterSection / ...)
 * stay where they are; the shapes here are deliberately a thin, bounded,
 * UI-safe projection so the engine, the REST route and the job executor all
 * agree on what an article request is.
 *
 * One writer, one article meaning: Quick Draft and (later) Deep Write consume
 * the same WriterInput and differ only in execution depth, never in what an
 * article is. No provider, credential or retrieval type leaks in here.
 */

import { OPPORTUNITY_INTENTS, OPPORTUNITY_REASONS } from './api.js';
import type { OpportunityCompetitorDto, OpportunityIntent, OpportunityReason } from './api.js';
import type { KnowledgeReadinessState } from './opportunityTopics.js';

// ---------------------------------------------------------------------------
// Formats / execution profiles
// ---------------------------------------------------------------------------

/** Article formats the engine can render. Additive; the UI is not hardcoded. */
export const WRITER_FORMAT_IDS = ['short_article', 'explainer'] as const;
export type WriterFormatId = (typeof WRITER_FORMAT_IDS)[number];

/**
 * Execution depth. `quick_draft` is the bounded single-pass profile; `deep_write`
 * adds hierarchical, still-bounded passes (section planning, per-paragraph
 * generation, bounded refinement, coherence). Both consume the same input and
 * produce the same article meaning - depth changes effort, never structure.
 * This is a third channel: the engine's `mode`, and nothing else. Callers do not
 * pick a pass count; the engine derives the bounded stages from format and
 * length, so the type stays a closed union a caller cannot extend.
 */
export const WRITER_EXECUTION_PROFILE_IDS = ['quick_draft', 'deep_write'] as const;
export type WriterExecutionProfileId = (typeof WRITER_EXECUTION_PROFILE_IDS)[number];

// ---------------------------------------------------------------------------
// Bounds (single source of truth, enforced at the API edge and in the engine)
// ---------------------------------------------------------------------------

export const WRITER_TOPIC_NAME_MAX_CHARS = 300;
export const WRITER_TOPIC_DESCRIPTION_MAX_CHARS = 1000;
export const WRITER_PRIMARY_KEYWORD_MAX_CHARS = 200;
export const WRITER_RELATED_KEYWORDS_MAX = 20;
export const WRITER_RELATED_KEYWORD_MAX_CHARS = 200;
export const WRITER_USER_INSTRUCTION_MAX_CHARS = 500;
export const WRITER_TONE_MAX_CHARS = 100;
export const WRITER_LANGUAGE_MAX_CHARS = 16;
export const WRITER_TARGET_LENGTH_MIN = 150;
export const WRITER_TARGET_LENGTH_MAX = 6000;
export const WRITER_KNOWLEDGE_CONTEXT_MAX_CHARS = 6000;

/** Bounds for the structured KW6 opportunity context. */
export const WRITER_OPPORTUNITY_TOPIC_MAX_CHARS = 500;
export const WRITER_OPPORTUNITY_DESCRIPTION_MAX_CHARS = 1000;
export const WRITER_OPPORTUNITY_KEYWORDS_MAX = 20;
export const WRITER_OPPORTUNITY_COMPETITORS_MAX = 3;
export const WRITER_OPPORTUNITY_TEXT_MAX_CHARS = 4000;

/** Bounds for a validated article plan. */
export const WRITER_ARTICLE_TITLE_MAX_CHARS = 200;
export const WRITER_ARTICLE_INTENT_MAX_CHARS = 600;
export const WRITER_MAX_SECTIONS = 12;
export const WRITER_SECTION_HEADING_MAX_CHARS = 200;
export const WRITER_SECTION_PURPOSE_MAX_CHARS = 500;
export const WRITER_SECTION_KEYWORDS_MAX = 6;

/**
 * Code-owned safety bounds for the Deep Write execution profile. These are the
 * single source of truth the engine enforces; no caller can raise them, and
 * there is deliberately no user-facing "number of passes" control. The stage
 * counts below are caps, not targets: the engine sizes each run from the
 * selected format and requested length and stays inside them.
 */
export const WRITER_DEEP_MAX_SUBSECTIONS_PER_SECTION = 5;
export const WRITER_DEEP_MAX_REFINEMENT_UNITS = 8;
export const WRITER_DEEP_MAX_BRIDGES = 12;
export const WRITER_DEEP_MAX_BRIDGE_CHARS = 300;
/** Hard ceiling on AI calls for one deep_write run: architecture + section
 *  planning + per-paragraph generation + refinement + coherence. The engine
 *  counts every call and fails honestly rather than running away. */
export const WRITER_DEEP_MAX_TOTAL_LLM_CALLS = 90;
/** Hard ceiling on the in-memory pass trace; oldest entries drop first. */
export const WRITER_DEEP_MAX_PASS_TRACE_ENTRIES = 400;

// ---------------------------------------------------------------------------
// Canonical writer input
// ---------------------------------------------------------------------------

/** The topic brief. `description` carries the semantic context a name lacks. */
export interface WriterTopicBrief {
  name: string;
  description: string;
}

/** One related keyword with its measured demand, when the project has it. */
export interface WriterRelatedKeyword {
  keyword: string;
  volume: number | null;
}

/**
 * Structured KW6 opportunity context. Promoted from the existing topic article
 * request so the writer never has to rediscover the opportunity. Deliberately
 * bounded by `boundWriterOpportunityContext`.
 */
export interface WriterOpportunityContext {
  topic: string;
  description: string;
  primaryKeyword: string | null;
  keywords: WriterRelatedKeyword[];
  competitors: OpportunityCompetitorDto[];
  opportunityScore: number | null;
  /**
   * Deterministic reason tags behind the score, when the source reported them.
   * Coarse, machine-owned evidence - never a model-produced explanation.
   */
  reasons?: OpportunityReason[];
  /** Observed keyword difficulty (0..100), when the source measured it. */
  difficulty?: number | null;
  /** Deterministic lexical intent, when the source derived one. */
  intent?: OpportunityIntent | null;
  /** Coarse readiness state from KW6, or null when never assessed. */
  knowledgeReadiness: KnowledgeReadinessState | null;
}

/**
 * The one canonical writer input every execution profile consumes. Quick Draft
 * and (later) Deep Write differ only in `mode`.
 */
export interface WriterInput {
  projectId: string;
  /** Optional existing draft to write into; omit to create a new draft. */
  contentId?: string | null;
  topic: WriterTopicBrief;
  primaryKeyword: string | null;
  relatedKeywords: WriterRelatedKeyword[];
  /** Structured KW6 context (bounded). */
  opportunityContext?: WriterOpportunityContext | null;
  /**
   * Derived, human-readable KW6 briefing text. Kept alongside the structured
   * context as a safe migration path; it is reference data, never instructions.
   */
  opportunityContextText?: string | null;
  /** Optional pre-fetched project knowledge. Untrusted reference material. */
  knowledgeContext?: string | null;
  format: WriterFormatId;
  mode: WriterExecutionProfileId;
  userInstruction?: string | null;
  targetLength?: number | null;
  tone?: string | null;
  language?: string | null;
}

// ---------------------------------------------------------------------------
// Compact run summary (derived from the in-memory pass trace)
// ---------------------------------------------------------------------------

/**
 * Small, UI-safe projection of one Writer Engine run. It is derived from the
 * bounded in-memory pass trace - counts, timings and a failed-stage label only -
 * so it can be persisted on a job result without ever storing prompts, bodies
 * or the full trace. `llm_calls` counts only stages that make a model call.
 */
export interface WriterRunSummary {
  mode: WriterExecutionProfileId;
  format: WriterFormatId;
  pass_count: number;
  llm_calls: number;
  duration_ms: number;
  by_kind: Record<string, number>;
  /** Kind of the last failed pass, when the run failed mid-execution. */
  failed_pass?: string;
}

// ---------------------------------------------------------------------------
// Article plan (intermediate representation)
// ---------------------------------------------------------------------------

/**
 * One planned section as a bounded, UI-safe projection: the fixed heading, a
 * short purpose summary (the coverage points the planner chose) and the focus
 * keywords. Deep Write may extend the projection later; W1 does not.
 */
export interface ArticlePlanSection {
  heading: string;
  purpose: string;
  keywords: string[];
}

/** The validated structural plan the engine assembles the article from. */
export interface ArticlePlan {
  title: string;
  intent: string;
  primaryKeyword: string | null;
  format: WriterFormatId;
  sections: ArticlePlanSection[];
}

// ---------------------------------------------------------------------------
// Pure bounding helpers
// ---------------------------------------------------------------------------

function clampText(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Returns a bounded copy of a structured opportunity context. Deterministic and
 * dependency-free so both the API edge and the engine apply the same limits.
 */
export function boundWriterOpportunityContext(context: WriterOpportunityContext): WriterOpportunityContext {
  return {
    topic: clampText(context.topic, WRITER_OPPORTUNITY_TOPIC_MAX_CHARS),
    description: clampText(context.description, WRITER_OPPORTUNITY_DESCRIPTION_MAX_CHARS),
    primaryKeyword: context.primaryKeyword
      ? clampText(context.primaryKeyword, WRITER_PRIMARY_KEYWORD_MAX_CHARS)
      : null,
    keywords: context.keywords
      .slice(0, WRITER_OPPORTUNITY_KEYWORDS_MAX)
      .map((row) => ({
        keyword: clampText(row.keyword, WRITER_RELATED_KEYWORD_MAX_CHARS),
        volume: typeof row.volume === 'number' && Number.isFinite(row.volume) ? row.volume : null,
      }))
      .filter((row) => row.keyword.length > 0),
    competitors: context.competitors.slice(0, WRITER_OPPORTUNITY_COMPETITORS_MAX).map((row) => ({
      domain: clampText(row.domain, 253),
      rank: typeof row.rank === 'number' && Number.isFinite(row.rank) ? row.rank : null,
    })),
    opportunityScore:
      typeof context.opportunityScore === 'number' && Number.isFinite(context.opportunityScore)
        ? Math.min(100, Math.max(0, context.opportunityScore))
        : null,
    reasons: [...new Set(context.reasons ?? [])].filter((reason) =>
      (OPPORTUNITY_REASONS as readonly string[]).includes(reason),
    ),
    difficulty:
      typeof context.difficulty === 'number' && Number.isFinite(context.difficulty)
        ? Math.min(100, Math.max(0, context.difficulty))
        : null,
    intent:
      context.intent && (OPPORTUNITY_INTENTS as readonly string[]).includes(context.intent)
        ? context.intent
        : null,
    knowledgeReadiness: context.knowledgeReadiness ?? null,
  };
}
