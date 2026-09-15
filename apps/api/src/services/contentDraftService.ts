/**
 * Agent Controls: start a Writer Engine draft from an existing article.
 *
 * One thin service behind the article-scoped draft endpoint. It reads the
 * source article, builds the canonical WriterInput (topic from the title,
 * primaryKeyword from target_keyword) and reuses the opportunity context that a
 * prior content_write job already captured, when one exists. It then enqueues
 * the existing content_write job - no new pipeline and no new tables.
 *
 * It ALWAYS sets `contentId: null`: a run creates a new draft and can never
 * mutate the article the user is editing. The source row is only ever read.
 */

import type { ServiceContainer } from '../context.js';
import type { JobRecord } from '../jobs/types.js';
import {
  boundWriterOpportunityContext,
  WRITER_LANGUAGE_MAX_CHARS,
  WRITER_PRIMARY_KEYWORD_MAX_CHARS,
  WRITER_RELATED_KEYWORD_MAX_CHARS,
  WRITER_RELATED_KEYWORDS_MAX,
  WRITER_TOPIC_DESCRIPTION_MAX_CHARS,
  WRITER_TOPIC_NAME_MAX_CHARS,
  type WriterExecutionProfileId,
  type WriterFormatId,
  type WriterOpportunityContext,
  type WriterRelatedKeyword,
} from '@seo/contracts';
import { parseWriterInput } from '../agents/writer/engine.js';
import { ContentService } from './contentService.js';

/** Prefix of the deterministic idempotency key for article-scoped drafts. */
export const CONTENT_DRAFT_JOB_PREFIX = 'content_draft';
/** How far back to scan a project's jobs for this article's writer context. */
const DRAFT_LOOKBACK_JOBS = 100;

export interface StartContentDraftOptions {
  projectId: string;
  contentId: string;
  userId: string;
  mode?: WriterExecutionProfileId;
  format?: WriterFormatId;
  /** Optional client token that makes a double-submit collapse into one job. */
  idempotencyToken?: string | null;
}

export interface StartContentDraftResult {
  job: JobRecord;
  /** True when an equivalent queued/running job was reused instead of a new one. */
  reused: boolean;
}

interface RecoveredWriterContext {
  opportunityContext: WriterOpportunityContext | null;
  opportunityContextText: string | null;
  relatedKeywords: WriterRelatedKeyword[];
}

/** One project's recent content_write jobs, newest first (bounded lookback). */
async function recentContentWriteJobs(container: ServiceContainer, projectId: string): Promise<JobRecord[]> {
  const jobs = await container.jobStore.list(projectId, DRAFT_LOOKBACK_JOBS);
  return jobs.filter((job) => job.job_type === 'content_write');
}

function safeBoundOpportunity(value: unknown): WriterOpportunityContext | null {
  if (!value || typeof value !== 'object') return null;
  try {
    return boundWriterOpportunityContext(value as WriterOpportunityContext);
  } catch {
    return null;
  }
}

/**
 * The opportunity context already captured on whichever content_write job
 * produced this article, if any. Recovering only from existing job data keeps
 * the endpoint's promise: it never rediscovers an opportunity or reads a
 * provider, it reuses what a real run already recorded.
 */
async function recoverWriterContext(
  container: ServiceContainer,
  projectId: string,
  contentId: string,
): Promise<RecoveredWriterContext | null> {
  const jobs = await recentContentWriteJobs(container, projectId);
  const source = jobs.find((job) => {
    const result = job.result;
    return Boolean(result && result.content_id === contentId && job.params && job.params.writer_input);
  });
  if (!source) return null;
  const writerInput = (source.params ?? {}).writer_input as Record<string, unknown>;
  return {
    opportunityContext: safeBoundOpportunity(writerInput.opportunityContext),
    opportunityContextText:
      typeof writerInput.opportunityContextText === 'string' ? writerInput.opportunityContextText : null,
    relatedKeywords: Array.isArray(writerInput.relatedKeywords)
      ? (writerInput.relatedKeywords as WriterRelatedKeyword[])
      : [],
  };
}

/** Id of the most recent Agent Controls run for this article, or null. */
async function latestAgentDraftJobId(
  container: ServiceContainer,
  projectId: string,
  contentId: string,
): Promise<string | null> {
  const jobs = await recentContentWriteJobs(container, projectId);
  return jobs.find((job) => job.params?.source_content_id === contentId)?.id ?? null;
}

/** A queued/running Agent Controls run for this article, or null. */
async function activeAgentDraftJob(
  container: ServiceContainer,
  projectId: string,
  contentId: string,
): Promise<JobRecord | null> {
  const jobs = await recentContentWriteJobs(container, projectId);
  return (
    jobs.find(
      (job) =>
        job.params?.source_content_id === contentId && (job.status === 'queued' || job.status === 'running'),
    ) ?? null
  );
}

/**
 * Builds the canonical WriterInput for a new draft from an existing article and
 * enqueues the existing content_write job. Never writes to the source article.
 */
export async function startContentDraft(
  container: ServiceContainer,
  opts: StartContentDraftOptions,
): Promise<StartContentDraftResult> {
  const { projectId, contentId, userId } = opts;
  const mode = opts.mode ?? 'quick_draft';
  const format = opts.format ?? 'short_article';

  const content = new ContentService(container.sb);
  const article = await content.get(projectId, contentId);

  const recovered = await recoverWriterContext(container, projectId, contentId);
  const title = typeof article.title === 'string' ? article.title.trim() : '';
  const description = typeof article.excerpt === 'string' ? article.excerpt.trim() : '';
  const targetKeyword = typeof article.target_keyword === 'string' ? article.target_keyword.trim() : '';
  const language = typeof article.language === 'string' ? article.language.trim() : '';

  // parseWriterInput is the same fail-closed gate the executor uses, so the
  // stored params are already valid and bounded when the engine consumes them.
  const writerInput = parseWriterInput({
    projectId,
    contentId: null,
    topic: {
      name: (title || 'Untitled article').slice(0, WRITER_TOPIC_NAME_MAX_CHARS),
      description: description.slice(0, WRITER_TOPIC_DESCRIPTION_MAX_CHARS),
    },
    primaryKeyword: targetKeyword ? targetKeyword.slice(0, WRITER_PRIMARY_KEYWORD_MAX_CHARS) : null,
    relatedKeywords: (recovered?.relatedKeywords ?? [])
      .slice(0, WRITER_RELATED_KEYWORDS_MAX)
      .map((row) => ({
        keyword: String(row?.keyword ?? '').slice(0, WRITER_RELATED_KEYWORD_MAX_CHARS),
        volume: typeof row?.volume === 'number' && Number.isFinite(row.volume) ? row.volume : null,
      }))
      .filter((row) => row.keyword.length > 0),
    opportunityContext: recovered?.opportunityContext ?? null,
    opportunityContextText: recovered?.opportunityContextText ?? null,
    format,
    mode,
    language: language ? language.slice(0, WRITER_LANGUAGE_MAX_CHARS) : null,
  });

  const predecessor = await latestAgentDraftJobId(container, projectId, contentId);
  const idempotencyKey = `${CONTENT_DRAFT_JOB_PREFIX}:${projectId}:${contentId}:${
    opts.idempotencyToken ?? predecessor ?? 'initial'
  }`;

  try {
    const job = await container.jobStore.enqueue({
      project_id: projectId,
      provider: 'content',
      job_type: 'content_write',
      params: { source_content_id: contentId, agent_draft: true, writer_input: writerInput },
      created_by: userId,
      idempotency_key: idempotencyKey,
    });
    return { job, reused: false };
  } catch (err) {
    // A concurrent trigger won the idempotency key; reuse its active run.
    const active = await activeAgentDraftJob(container, projectId, contentId);
    if (active) return { job: active, reused: true };
    throw err;
  }
}
