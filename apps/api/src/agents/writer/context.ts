/**
 * Writer context model and bounded-context rules (W1).
 *
 * gatherContext stores everything the writer may later reason about in one
 * small, typed WriterContext. Retrieved content is data, never instructions:
 * every stored entry carries a source label and an explicit trust marker
 * ("untrusted") that is added by the graph boundary, not by the adapter, so
 * hostile retrieval text (prompt-injection strings and all) arrives in state
 * as plainly labelled data that no later phase can mistake for its own system
 * instructions.
 *
 * Every source degrades honestly instead of failing or fabricating:
 *   knowledge  available | empty | not_configured | unavailable
 *   content    available | empty | not_configured | unavailable
 *   intelligence configured | no_data | not_configured | unavailable
 * A source that is not wired or configured is reported as such, never padded
 * with invented fallback data.
 *
 * Context is always bounded: chunk/item/keyword counts and per-field lengths
 * are hard-capped below, so no retrieval result can grow the writer state
 * without limit.
 */

import type { ContentStatus } from '@seo/contracts';

/** Which retrieval source produced an entry. */
export type WriterSourceKind = 'knowledge' | 'content' | 'intelligence';

/** Every context entry is untrusted input from outside the run's control. */
export const WRITER_CONTEXT_TRUST = 'untrusted' as const;
export type WriterContextTrust = typeof WRITER_CONTEXT_TRUST;

// --- honest per-source availability vocabularies ---------------------------

export type WriterKnowledgeStatus = 'available' | 'empty' | 'not_configured' | 'unavailable';
export type WriterContentStatus = 'available' | 'empty' | 'not_configured' | 'unavailable';
export type WriterIntelligenceStatus = 'configured' | 'no_data' | 'not_configured' | 'unavailable';

// --- source result shapes (what an adapter returns; unbounded) --------------

export interface WriterKnowledgeChunk {
  sourceId: string;
  title?: string;
  text: string;
}

export interface WriterKnowledgeResult {
  status: WriterKnowledgeStatus;
  note: string | null;
  chunks: WriterKnowledgeChunk[];
}

export interface WriterContentItem {
  id: string;
  title: string;
  slug: string | null;
  targetKeyword: string | null;
  status: ContentStatus;
}

export interface WriterContentResult {
  status: WriterContentStatus;
  note: string | null;
  items: WriterContentItem[];
}

export interface WriterIntelligenceKeyword {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  provider: string | null;
  lastSeenAt: string | null;
}

export interface WriterIntelligenceResult {
  status: WriterIntelligenceStatus;
  note: string | null;
  keywords: WriterIntelligenceKeyword[];
}

// --- bounded, source-labelled state sections --------------------------------

export interface WriterKnowledgeContextChunk extends WriterKnowledgeChunk {
  source: 'knowledge';
  trust: WriterContextTrust;
}

export interface WriterContentContextItem extends WriterContentItem {
  source: 'content';
  trust: WriterContextTrust;
}

export interface WriterIntelligenceContextKeyword extends WriterIntelligenceKeyword {
  source: 'intelligence';
  trust: WriterContextTrust;
}

export interface WriterKnowledgeSection {
  status: WriterKnowledgeStatus;
  note: string | null;
  chunks: WriterKnowledgeContextChunk[];
}

export interface WriterContentSection {
  status: WriterContentStatus;
  note: string | null;
  items: WriterContentContextItem[];
}

export interface WriterIntelligenceSection {
  status: WriterIntelligenceStatus;
  note: string | null;
  keywords: WriterIntelligenceContextKeyword[];
}

export interface WriterContext {
  knowledge: WriterKnowledgeSection;
  content: WriterContentSection;
  intelligence: WriterIntelligenceSection;
}

/** Input every read-only context adapter receives. projectId is always the
 *  immutable state value; adapters must scope their reads to it themselves. */
export interface WriterContextInput {
  projectId: string;
  topic: string;
  targetKeyword: string | null;
}

/**
 * The explicit, dependency-injected read-only allowlist a writer run may use.
 * The graph never talks to Supabase, Qdrant, GSC or DataForSEO directly - it
 * only calls these methods, and only gatherContext may call them.
 */
export interface WriterContextDependencies {
  getKnowledge(input: WriterContextInput): Promise<WriterKnowledgeResult>;
  getExistingContent(input: WriterContextInput): Promise<WriterContentResult>;
  getIntelligence(input: WriterContextInput): Promise<WriterIntelligenceResult>;
}

// --- hard bounds ------------------------------------------------------------

/** Max knowledge chunks kept per run. */
export const WRITER_MAX_KNOWLEDGE_CHUNKS = 6;
/** Max characters kept per knowledge chunk text. */
export const WRITER_MAX_CHUNK_TEXT_CHARS = 2000;
/** Max characters kept per knowledge chunk title. */
export const WRITER_MAX_CHUNK_TITLE_CHARS = 200;
/** Max existing-content rows kept per run. */
export const WRITER_MAX_CONTENT_ITEMS = 20;
/** Max characters kept per content title. */
export const WRITER_MAX_CONTENT_TITLE_CHARS = 300;
/** Max intelligence keyword rows kept per run. */
export const WRITER_MAX_INTELLIGENCE_KEYWORDS = 20;
/** Max characters kept per intelligence keyword. */
export const WRITER_MAX_KEYWORD_CHARS = 200;
/** Max characters kept for any context note (secret-free by construction). */
export const WRITER_MAX_NOTE_CHARS = 300;

function capText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function capNullable(value: string | null, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function capNote(value: string | null): string | null {
  return capNullable(value, WRITER_MAX_NOTE_CHARS);
}

/** A secret-free, bounded note built from an error message (never a stack). */
export function contextNoteFromError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return capNullable(message, WRITER_MAX_NOTE_CHARS) ?? 'The source failed.';
}

/** Context with every source reported not configured and nothing else. */
export function emptyWriterContext(): WriterContext {
  return {
    knowledge: { status: 'not_configured', note: 'No knowledge adapter is wired for this run.', chunks: [] },
    content: { status: 'not_configured', note: 'No content adapter is wired for this run.', items: [] },
    intelligence: {
      status: 'not_configured',
      note: 'No intelligence adapter is wired for this run.',
      keywords: [],
    },
  };
}

/** Dependencies with no adapters: every source answers "not configured" so an
 *  unwired run still completes honestly instead of failing. */
export const NO_ADAPTER_DEPENDENCIES: WriterContextDependencies = {
  async getKnowledge() {
    return { status: 'not_configured', note: 'No knowledge adapter is wired for this run.', chunks: [] };
  },
  async getExistingContent() {
    return { status: 'not_configured', note: 'No content adapter is wired for this run.', items: [] };
  },
  async getIntelligence() {
    return { status: 'not_configured', note: 'No intelligence adapter is wired for this run.', keywords: [] };
  },
};

/**
 * Normalises a raw knowledge result into the bounded, labelled state section.
 * The graph boundary truncates counts/lengths here so an adapter (or a hostile
 * source behind it) can never grow the state unboundedly, and rewrites an
 * inconsistent "available with no chunks" result to the honest "empty".
 */
export function boundKnowledge(result: WriterKnowledgeResult): WriterKnowledgeSection {
  const chunks = result.chunks.slice(0, WRITER_MAX_KNOWLEDGE_CHUNKS).map(
    (chunk): WriterKnowledgeContextChunk => ({
      sourceId: chunk.sourceId,
      title: capText(chunk.title, WRITER_MAX_CHUNK_TITLE_CHARS),
      text: chunk.text.slice(0, WRITER_MAX_CHUNK_TEXT_CHARS),
      source: 'knowledge',
      trust: WRITER_CONTEXT_TRUST,
    }),
  );
  const status = result.status === 'available' && chunks.length === 0 ? 'empty' : result.status;
  return { status, note: capNote(result.note), chunks };
}

/** Bounds and labels existing-content rows the same way as knowledge chunks. */
export function boundContent(result: WriterContentResult): WriterContentSection {
  const items = result.items.slice(0, WRITER_MAX_CONTENT_ITEMS).map(
    (item): WriterContentContextItem => ({
      id: item.id,
      title: item.title.slice(0, WRITER_MAX_CONTENT_TITLE_CHARS),
      slug: capNullable(item.slug, WRITER_MAX_CONTENT_TITLE_CHARS),
      targetKeyword: capNullable(item.targetKeyword, WRITER_MAX_KEYWORD_CHARS),
      status: item.status,
      source: 'content',
      trust: WRITER_CONTEXT_TRUST,
    }),
  );
  const status = result.status === 'available' && items.length === 0 ? 'empty' : result.status;
  return { status, note: capNote(result.note), items };
}

/** Bounds and labels intelligence keyword rows. */
export function boundIntelligence(result: WriterIntelligenceResult): WriterIntelligenceSection {
  const keywords = result.keywords.slice(0, WRITER_MAX_INTELLIGENCE_KEYWORDS).map(
    (row): WriterIntelligenceContextKeyword => ({
      keyword: row.keyword.slice(0, WRITER_MAX_KEYWORD_CHARS),
      volume: row.volume,
      difficulty: row.difficulty,
      cpc: row.cpc,
      provider: capNullable(row.provider, WRITER_MAX_KEYWORD_CHARS),
      lastSeenAt: capNullable(row.lastSeenAt, WRITER_MAX_KEYWORD_CHARS),
      source: 'intelligence',
      trust: WRITER_CONTEXT_TRUST,
    }),
  );
  const status = result.status === 'configured' && keywords.length === 0 ? 'no_data' : result.status;
  return { status, note: capNote(result.note), keywords };
}

/** Applies the bounded-context rules to one full gather step. */
export function boundWriterContext(sources: {
  knowledge: WriterKnowledgeResult;
  content: WriterContentResult;
  intelligence: WriterIntelligenceResult;
}): WriterContext {
  return {
    knowledge: boundKnowledge(sources.knowledge),
    content: boundContent(sources.content),
    intelligence: boundIntelligence(sources.intelligence),
  };
}
