/**
 * Shared Writer Engine + Quick Draft profile (W1).
 *
 * One engine turns the canonical `WriterInput` into a persisted Content Studio
 * draft. It is the single writing brain behind both REST and (later) MCP: the
 * engine never reads Postgres, never calls a provider and never touches
 * credentials directly - it composes the existing, already-bounded writer
 * phases through explicit dependency seams:
 *
 *   context  -> gather bounded, project-scoped reference material
 *   planner  -> one AI call producing a validated structural plan
 *   format   -> deterministic structure gate owned by the format registry
 *   sections -> one AI call per planned section, in plan order
 *   review   -> deterministic assembly of the canonical TipDoc + SEO score
 *   persist  -> ContentService, the ONLY canonical writer of seo_content
 *
 * Quick Draft is the W1 execution depth: a bounded, non-durable run with no
 * interrupts, no revision loop and no pass trace. Deep Write (later) differs
 * only in `mode`, consuming the exact same input and article model.
 *
 * Honesty rules: an unconfigured or failing AI never yields a fabricated
 * article. Planning/section/review failures are surfaced as errors (the job
 * fails), the engine returns success only when a real draft was written, and
 * the deterministic @seo/contracts evaluator - not the model - owns the score.
 */

import { z } from 'zod';
import {
  asContentBlocks,
  boundWriterOpportunityContext,
  contentWordCount,
  KNOWLEDGE_READINESS_STATES,
  WRITER_EXECUTION_PROFILE_IDS,
  WRITER_FORMAT_IDS,
  WRITER_LANGUAGE_MAX_CHARS,
  WRITER_OPPORTUNITY_COMPETITORS_MAX,
  WRITER_OPPORTUNITY_DESCRIPTION_MAX_CHARS,
  WRITER_OPPORTUNITY_KEYWORDS_MAX,
  WRITER_OPPORTUNITY_TEXT_MAX_CHARS,
  WRITER_OPPORTUNITY_TOPIC_MAX_CHARS,
  WRITER_PRIMARY_KEYWORD_MAX_CHARS,
  WRITER_RELATED_KEYWORD_MAX_CHARS,
  WRITER_RELATED_KEYWORDS_MAX,
  WRITER_TARGET_LENGTH_MAX,
  WRITER_TARGET_LENGTH_MIN,
  WRITER_TONE_MAX_CHARS,
  WRITER_TOPIC_DESCRIPTION_MAX_CHARS,
  WRITER_TOPIC_NAME_MAX_CHARS,
  WRITER_USER_INSTRUCTION_MAX_CHARS,
  type ArticlePlan,
  type WriterExecutionProfileId,
  type WriterFormatId,
  type WriterInput,
} from '@seo/contracts';
import { ApiError } from '../../apiErrors.js';
import type { ServiceContainer } from '../../context.js';
import { logger } from '../../logger.js';
import { AIService } from '../../services/aiService.js';
import { ContentService, type ContentInput, type ContentPatch } from '../../services/contentService.js';
import {
  boundWriterContext,
  contextNoteFromError,
  WRITER_MAX_KNOWLEDGE_CHUNKS,
  type WriterContext,
  type WriterContextDependencies,
  type WriterContentResult,
  type WriterIntelligenceResult,
  type WriterKnowledgeContextChunk,
  type WriterKnowledgeResult,
} from './context.js';
import { createWriterContextDependencies } from './contextDependencies.js';
import {
  createAiDeepWriteDependencies,
  runDeepWriteGeneration,
  type DeepWriteDependencies,
} from './deepWrite.js';
import { getWriterFormat, outlineGuidanceFor, type WriterFormatDefinition } from './formats.js';
import { createWriterPassTrace, tracePass, type WriterPassTraceEntry } from './passTrace.js';
import { throwPhaseFailure } from './phaseFailure.js';
import { createAiWriterPlanner, type WriterAiResolver, type WriterPlannerDependencies } from './planner.js';
import { planToArticlePlan } from './projection.js';
import {
  DEFAULT_WRITER_REVIEW_DEPENDENCIES,
  reviewWriterContent,
  type WriterReviewDependencies,
} from './review.js';
import { createAiWriterSectionWriter, type WriterSectionDependencies } from './sectionWriter.js';
import { writerSectionIdFor, type WriterPlan, type WriterReview, type WriterWrittenSection } from './state.js';

export { planToArticlePlan } from './projection.js';

// ---------------------------------------------------------------------------
// Input parsing (bounded at the executor edge; the engine consumes typed input)
// ---------------------------------------------------------------------------

const relatedKeywordSchema = z.object({
  keyword: z.string().trim().min(1).max(WRITER_RELATED_KEYWORD_MAX_CHARS),
  volume: z.number().finite().nullable().optional(),
});

const opportunityContextSchema = z.object({
  topic: z.string().trim().min(1).max(WRITER_OPPORTUNITY_TOPIC_MAX_CHARS),
  description: z.string().trim().max(WRITER_OPPORTUNITY_DESCRIPTION_MAX_CHARS).default(''),
  primaryKeyword: z.string().trim().max(WRITER_PRIMARY_KEYWORD_MAX_CHARS).nullable().optional(),
  keywords: z.array(relatedKeywordSchema).max(WRITER_OPPORTUNITY_KEYWORDS_MAX).optional(),
  competitors: z
    .array(
      z.object({
        domain: z.string().trim().min(1).max(253),
        rank: z.number().int().min(1).nullable().optional(),
      }),
    )
    .max(WRITER_OPPORTUNITY_COMPETITORS_MAX)
    .optional(),
  opportunityScore: z.number().min(0).max(100).nullable().optional(),
  knowledgeReadiness: z.enum(KNOWLEDGE_READINESS_STATES).nullable().optional(),
});

const writerInputSchema = z.object({
  projectId: z.string().trim().min(1),
  contentId: z.string().trim().min(1).nullable().optional(),
  topic: z.object({
    name: z.string().trim().min(1).max(WRITER_TOPIC_NAME_MAX_CHARS),
    description: z.string().trim().max(WRITER_TOPIC_DESCRIPTION_MAX_CHARS).default(''),
  }),
  primaryKeyword: z.string().trim().max(WRITER_PRIMARY_KEYWORD_MAX_CHARS).nullable().optional(),
  relatedKeywords: z.array(relatedKeywordSchema).max(WRITER_RELATED_KEYWORDS_MAX).optional(),
  opportunityContext: opportunityContextSchema.nullable().optional(),
  opportunityContextText: z.string().max(WRITER_OPPORTUNITY_TEXT_MAX_CHARS).nullable().optional(),
  format: z.enum(WRITER_FORMAT_IDS).optional(),
  mode: z.enum(WRITER_EXECUTION_PROFILE_IDS).optional(),
  userInstruction: z.string().trim().max(WRITER_USER_INSTRUCTION_MAX_CHARS).nullable().optional(),
  targetLength: z.number().int().min(WRITER_TARGET_LENGTH_MIN).max(WRITER_TARGET_LENGTH_MAX).nullable().optional(),
  tone: z.string().trim().max(WRITER_TONE_MAX_CHARS).nullable().optional(),
  language: z.string().trim().max(WRITER_LANGUAGE_MAX_CHARS).nullable().optional(),
});

/** Validates and bounds untrusted writer input (e.g. a job's params) into the
 *  canonical `WriterInput`. Fails closed with a 400 rather than half-running. */
export function parseWriterInput(raw: unknown): WriterInput {
  const parsed = writerInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.badRequest(
      'Invalid writer input',
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  const data = parsed.data;
  return {
    projectId: data.projectId,
    contentId: data.contentId ?? null,
    topic: data.topic,
    primaryKeyword: data.primaryKeyword ?? null,
    relatedKeywords: (data.relatedKeywords ?? []).map((row) => ({
      keyword: row.keyword,
      volume: row.volume ?? null,
    })),
    opportunityContext: data.opportunityContext
      ? boundWriterOpportunityContext({
          topic: data.opportunityContext.topic,
          description: data.opportunityContext.description ?? '',
          primaryKeyword: data.opportunityContext.primaryKeyword ?? null,
          keywords: (data.opportunityContext.keywords ?? []).map((row) => ({
            keyword: row.keyword,
            volume: row.volume ?? null,
          })),
          competitors: (data.opportunityContext.competitors ?? []).map((row) => ({
            domain: row.domain,
            rank: row.rank ?? null,
          })),
          opportunityScore: data.opportunityContext.opportunityScore ?? null,
          knowledgeReadiness: data.opportunityContext.knowledgeReadiness ?? null,
        })
      : null,
    opportunityContextText: data.opportunityContextText ?? null,
    format: data.format ?? 'short_article',
    mode: data.mode ?? 'quick_draft',
    userInstruction: data.userInstruction ?? null,
    targetLength: data.targetLength ?? null,
    tone: data.tone ?? null,
    language: data.language ?? null,
  };
}

// ---------------------------------------------------------------------------
// Dependency seams
// ---------------------------------------------------------------------------

/** The persistence port the engine writes through. Production binds it to
 *  `ContentService`; tests inject a fake. The engine never writes SQL. */
export interface WriterPersistence {
  create(projectId: string, userId: string | null, input: ContentInput): Promise<Record<string, unknown>>;
  update(projectId: string, userId: string | null, id: string, input: ContentPatch): Promise<Record<string, unknown>>;
}

export interface WriterEngineDependencies {
  planner: WriterPlannerDependencies;
  sectionWriter: WriterSectionDependencies;
  review: WriterReviewDependencies;
  context: WriterContextDependencies;
  content: WriterPersistence;
  /** The Deep Write pass seams; required only when `mode` is `deep_write`. */
  deep?: DeepWriteDependencies;
}

export interface WriterEngineOptions {
  userId?: string | null;
  onStage?: (label: string, progress: number) => Promise<void> | void;
}

/** The successful result of one engine run. The score is the deterministic
 *  evaluator's, never a model-produced number. `passes` is the bounded in-memory
 *  trace of every stage the run executed (identity/timing/outcome only). */
export interface WriterEngineResult {
  contentId: string;
  title: string;
  slug: string | null;
  format: WriterFormatId;
  mode: WriterExecutionProfileId;
  sectionCount: number;
  wordCount: number;
  seoScore: number;
  plan: ArticlePlan;
  passes: WriterPassTraceEntry[];
}

// ---------------------------------------------------------------------------
// Context gathering
// ---------------------------------------------------------------------------

async function safeKnowledge(fn: () => Promise<WriterKnowledgeResult>): Promise<WriterKnowledgeResult> {
  try {
    return await fn();
  } catch (err) {
    return { status: 'unavailable', note: contextNoteFromError(err), chunks: [] };
  }
}

async function safeContent(fn: () => Promise<WriterContentResult>): Promise<WriterContentResult> {
  try {
    return await fn();
  } catch (err) {
    return { status: 'unavailable', note: contextNoteFromError(err), items: [] };
  }
}

async function safeIntelligence(fn: () => Promise<WriterIntelligenceResult>): Promise<WriterIntelligenceResult> {
  try {
    return await fn();
  } catch (err) {
    return { status: 'unavailable', note: contextNoteFromError(err), keywords: [] };
  }
}

/** Deterministic, bounded text form of the structured opportunity context. */
function opportunityBriefingText(input: WriterInput): string | null {
  if (input.opportunityContext) {
    const ctx = boundWriterOpportunityContext(input.opportunityContext);
    const lines: string[] = [`Topic: ${ctx.topic}`];
    if (ctx.description) lines.push(`Topic description: ${ctx.description}`);
    if (ctx.primaryKeyword) lines.push(`Primary keyword: ${ctx.primaryKeyword}`);
    if (ctx.keywords.length > 0) {
      lines.push(
        `Matching keywords: ${ctx.keywords
          .map((row) => (row.volume != null ? `${row.keyword} (${row.volume}/mo)` : row.keyword))
          .join(', ')}`,
      );
    }
    if (ctx.competitors.length > 0) {
      lines.push(
        `Competitor evidence: ${ctx.competitors
          .map((row) => (row.rank != null ? `${row.domain} #${row.rank}` : row.domain))
          .join(', ')}`,
      );
    }
    if (ctx.opportunityScore != null) lines.push(`Opportunity score: ${ctx.opportunityScore}/100`);
    if (ctx.knowledgeReadiness) lines.push(`Knowledge readiness: ${ctx.knowledgeReadiness}`);
    return lines.join('\n').slice(0, WRITER_OPPORTUNITY_TEXT_MAX_CHARS);
  }
  const text = input.opportunityContextText?.trim();
  return text ? text.slice(0, WRITER_OPPORTUNITY_TEXT_MAX_CHARS) : null;
}

/**
 * Gathers the bounded, source-labelled context for one run. Each source
 * degrades honestly and independently, and the opportunity briefing (derived
 * facts, not instructions) is carried as one extra untrusted reference chunk so
 * the writer never has to rediscover the opportunity.
 */
async function gatherContext(deps: WriterContextDependencies, input: WriterInput): Promise<WriterContext> {
  const contextInput = {
    projectId: input.projectId,
    topic: input.topic.name,
    targetKeyword: input.primaryKeyword,
  };
  const [knowledge, content, intelligence] = await Promise.all([
    safeKnowledge(() => deps.getKnowledge(contextInput)),
    safeContent(() => deps.getExistingContent(contextInput)),
    safeIntelligence(() => deps.getIntelligence(contextInput)),
  ]);
  const bound = boundWriterContext({ knowledge, content, intelligence });

  const briefing = opportunityBriefingText(input);
  if (!briefing) return bound;
  const chunk: WriterKnowledgeContextChunk = {
    sourceId: 'opportunity',
    title: 'Opportunity briefing',
    text: briefing,
    source: 'knowledge',
    trust: 'untrusted',
  };
  return {
    ...bound,
    knowledge: {
      ...bound.knowledge,
      status: 'available',
      chunks: [chunk, ...bound.knowledge.chunks].slice(0, WRITER_MAX_KNOWLEDGE_CHUNKS),
    },
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Persists the reviewed article through the injected port (ContentService in
 *  production). Shared by both execution profiles so "a saved article" is one
 *  definition: a draft with the canonical TipDoc, derived HTML/outline and the
 *  deterministic SEO score. */
async function persistArticle(
  content: WriterPersistence,
  input: WriterInput,
  userId: string | null,
  plan: WriterPlan,
  review: WriterReview,
): Promise<Record<string, unknown>> {
  const writeInput: ContentInput = {
    title: plan.title,
    targetKeyword: input.primaryKeyword,
    metaDescription: plan.metaDescription ?? null,
    language: input.language?.trim() || 'en',
    status: 'draft',
    contentJson: review.contentJson,
  };
  return input.contentId
    ? content.update(input.projectId, userId, input.contentId, writeInput)
    : content.create(input.projectId, userId, writeInput);
}

interface QuickDraftResult {
  plan: WriterPlan;
  articlePlan: ArticlePlan;
  writtenSections: WriterWrittenSection[];
  review: WriterReview;
}

/**
 * Runs the Quick Draft depth: one plan call, one call per section in plan order,
 * then the deterministic review. Exactly the W1 behavior, now traced.
 */
async function runQuickDraft(
  input: WriterInput,
  context: WriterContext,
  format: WriterFormatDefinition,
  deps: WriterEngineDependencies,
  trace: WriterPassTraceRecorderLike,
  report: (label: string, progress: number) => Promise<void>,
): Promise<QuickDraftResult> {
  await report('outline', 25);
  const architecture = await tracePass(trace, 'architecture', null, async () => {
    const planOutcome = await deps.planner.plan({
      projectId: input.projectId,
      topic: input.topic.description ? `${input.topic.name} - ${input.topic.description}` : input.topic.name,
      targetKeyword: input.primaryKeyword,
      context,
      formatGuidance: outlineGuidanceFor(format, input.targetLength),
    });
    if (!planOutcome.ok) throwPhaseFailure('planning', planOutcome);
    const projected = planToArticlePlan(planOutcome.plan, input);
    const validation = format.validate(projected);
    if (!validation.ok) {
      throw new ApiError(422, 'agent_invalid_output', validation.note ?? 'The plan did not match the requested format.');
    }
    return { plan: planOutcome.plan, articlePlan: projected };
  });
  const { plan, articlePlan } = architecture;

  const writtenSections: WriterWrittenSection[] = [];
  const total = plan.sections.length;
  for (let index = 0; index < total; index += 1) {
    const section = plan.sections[index];
    const content = await tracePass(trace, 'section_generation', writerSectionIdFor(index), async () => {
      const outcome = await deps.sectionWriter.writeSection({
        projectId: input.projectId,
        topic: input.topic.name,
        targetKeyword: input.primaryKeyword,
        articleTitle: plan.title,
        sectionIndex: index,
        section,
        context,
        previousSectionContent: writtenSections.length > 0 ? writtenSections[writtenSections.length - 1]!.content : null,
      });
      if (!outcome.ok) throwPhaseFailure(`writing (section ${index + 1})`, outcome);
      return outcome.content;
    });
    writtenSections.push({ sectionId: writerSectionIdFor(index), content });
    await report(`writing ${index + 1}/${total}`, 25 + Math.round(((index + 1) / total) * 55));
  }

  await report('review', 88);
  const review = await tracePass(trace, 'editorial_validation', null, async () => {
    const reviewOutcome = reviewWriterContent(deps.review, {
      plan,
      writtenSections,
      targetKeyword: input.primaryKeyword,
    });
    if (!reviewOutcome.ok) {
      throw new ApiError(422, 'agent_invalid_output', `The assembled article failed review: ${reviewOutcome.note}`);
    }
    return reviewOutcome.review;
  });

  return { plan, articlePlan, writtenSections, review };
}

/** Structural type of the pass recorder; avoids a hard import cycle. */
type WriterPassTraceRecorderLike = ReturnType<typeof createWriterPassTrace>;

/**
 * Runs one writer engine execution for the requested depth. Both profiles share
 * context gathering, the plan projection, the deterministic editorial review and
 * the single ContentService persistence path; they differ only in how many
 * bounded AI passes generate the section bodies. Throws ApiError on any honest
 * failure; it never records a partial, fabricated article as success.
 */
export async function runWriterEngine(
  input: WriterInput,
  deps: WriterEngineDependencies,
  options: WriterEngineOptions = {},
): Promise<WriterEngineResult> {
  const format = requireFormat(input.format);
  const trace = createWriterPassTrace();
  const report = (label: string, progress: number) => Promise.resolve(options.onStage?.(label, progress));
  const userId = options.userId ?? null;

  await report('research', 5);
  const context = await tracePass(trace, 'context', null, () => gatherContext(deps.context, input));

  let generated: QuickDraftResult;
  try {
    if (input.mode === 'deep_write') {
      if (!deps.deep) {
        throw new ApiError(500, 'internal_error', 'Deep Write is not wired for this engine instance.');
      }
      generated = await runDeepWriteGeneration(
        { input, context, format, trace },
        { planner: deps.planner, review: deps.review, deep: deps.deep },
        options,
      );
    } else {
      generated = await runQuickDraft(input, context, format, deps, trace, report);
    }
  } catch (err) {
    const passes = trace.snapshot();
    const failed = passes.filter((pass) => !pass.ok);
    logger.warn(
      { err, projectId: input.projectId, mode: input.mode, passCount: passes.length, failedPass: failed[failed.length - 1] ?? null },
      'writer engine run failed',
    );
    throw err;
  }

  await report('persist', 94);
  const row = await tracePass(trace, 'persist', null, () =>
    persistArticle(deps.content, input, userId, generated.plan, generated.review),
  );

  const contentJson = row.content_json ?? generated.review.contentJson;
  return {
    contentId: String(row.id),
    title: String(row.title ?? generated.plan.title),
    slug: typeof row.slug === 'string' ? row.slug : null,
    format: input.format,
    mode: input.mode,
    sectionCount: generated.plan.sections.length,
    wordCount: contentWordCount(asContentBlocks(contentJson)),
    seoScore: generated.review.seo.score,
    plan: generated.articlePlan,
    passes: trace.snapshot(),
  };
}

function requireFormat(id: string): WriterFormatDefinition {
  const format = getWriterFormat(id);
  if (!format) throw ApiError.badRequest(`Unknown writer format: ${id}`);
  return format;
}

/**
 * Wires the production engine onto a service container: the real context
 * adapters (project-scoped, bounded), the real AI resolver (the single BYOK
 * gate), the canonical review allowlist and ContentService as the writer.
 */
export function createWriterEngine(container: ServiceContainer) {
  const ai = new AIService(container);
  const resolver: WriterAiResolver = (projectId) => ai.resolve(projectId);
  const contentService = new ContentService(container.sb);
  const deps: WriterEngineDependencies = {
    planner: createAiWriterPlanner(resolver),
    sectionWriter: createAiWriterSectionWriter(resolver),
    review: DEFAULT_WRITER_REVIEW_DEPENDENCIES,
    context: createWriterContextDependencies(container),
    content: {
      create: (projectId, userId, input) => contentService.create(projectId, userId, input),
      update: (projectId, userId, id, input) => contentService.update(projectId, userId, id, input),
    },
    deep: createAiDeepWriteDependencies(resolver),
  };
  return {
    run: (input: WriterInput, options?: WriterEngineOptions) => runWriterEngine(input, deps, options),
  };
}
