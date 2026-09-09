/**
 * Writer Agent research & evidence layer (W10.2).
 *
 * Research is a controlled, read-only, user-triggered operation: while a run
 * rests on `review_ready` the human can gather bounded, project-scoped evidence
 * for the article topic. This module owns EVERYTHING about that evidence short
 * of the graph wiring:
 *
 *   - the canonical source/status vocabulary and the hard bounds an evidence
 *     payload must obey (item counts, per-item text, total payload);
 *   - the request vocabulary (`purpose`) and the strict review-session resume
 *     value `{ action: "research" }` that starts a gather from the resting
 *     review session;
 *   - the explicit, deny-by-default dependency boundary (WriterResearchDependencies)
 *     the writer graph may call - never direct SQL, provider calls, API keys or
 *     service-role secrets;
 *   - `boundEvidence`: the single gate that turns raw adapter results into the
 *     bounded, sanitized, provenance-labelled WriterEvidence a run stores and
 *     later revision/magic rounds may read.
 *
 * Security model (W10.2):
 *   - retrieved research is DATA, never instructions: every stored item carries
 *     `trust: "untrusted"` set here at the boundary (never by an adapter), and
 *     prompt builders place it in a dedicated UNTRUSTED RESEARCH MATERIAL data
 *     block far from the system rules and output contract;
 *   - evidence is bounded: a source (or hostile text behind it) can never grow
 *     the run state without limit - counts, per-item text, titles and the total
 *     payload are hard-capped below, and empty results stay honestly empty;
 *   - provenance is never invented: an item only carries a url/retrievedAt when
 *     the adapter provided one, otherwise the field stays null;
 *   - deny by default: an unwired research source reports not_configured; an
 *     unwired research boundary answers not_configured for every source. No
 *     fabricated fallback evidence ever enters state.
 *
 * Research NEVER publishes, saves content, reads credentials, drives workflows,
 * runs autonomous searches or triggers further actions on its own - it only
 * ever produces this bounded, labelled evidence.
 */

import { z } from 'zod';
import type {
  WriterContentResult,
  WriterIntelligenceResult,
  WriterKnowledgeResult,
} from './context.js';
import { WRITER_CONTEXT_TRUST, contextNoteFromError } from './context.js';

// --- canonical vocabulary ----------------------------------------------------

/** Safe, project-scoped reads a piece of evidence may come from. */
export const WRITER_EVIDENCE_SOURCES = [
  'knowledge',
  'existing_content',
  'search',
  'intelligence',
] as const;
export type WriterEvidenceSource = (typeof WRITER_EVIDENCE_SOURCES)[number];

/** Honest availability of one research source. */
export const WRITER_EVIDENCE_STATUSES = [
  'available',
  'empty',
  'not_configured',
  'unavailable',
] as const;
export type WriterEvidenceStatus = (typeof WRITER_EVIDENCE_STATUSES)[number];

/** Every evidence item is untrusted input from outside the run's control. */
export const WRITER_EVIDENCE_TRUST = WRITER_CONTEXT_TRUST;

/** Why the human triggered a research gather. Vocabulary only for now: the
 *  first W10.2 integration runs from the resting review session, and no
 *  autonomous planner branches on purpose yet. */
export const WRITER_RESEARCH_PURPOSES = ['planning', 'section_magic', 'revision'] as const;
export type WriterResearchPurpose = (typeof WRITER_RESEARCH_PURPOSES)[number];

// --- hard bounds -------------------------------------------------------------

/** Max evidence items kept per research source. */
export const WRITER_MAX_EVIDENCE_SOURCE_ITEMS = 6;
/** Max evidence items kept in total across all sources. */
export const WRITER_MAX_EVIDENCE_ITEMS = 20;
/** Max characters kept per evidence item text. */
export const WRITER_MAX_EVIDENCE_ITEM_TEXT_CHARS = 1_500;
/** Max characters kept per evidence item title. */
export const WRITER_MAX_EVIDENCE_TITLE_CHARS = 200;
/** Max total text characters across all retained evidence items. */
export const WRITER_MAX_EVIDENCE_TOTAL_CHARS = 16_000;
/** Max characters kept for any per-source note (secret-free by construction). */
export const WRITER_MAX_EVIDENCE_NOTE_CHARS = 300;
/** Max characters of a single metadata value string. */
export const WRITER_MAX_EVIDENCE_METADATA_STR_CHARS = 100;

// --- stored evidence shapes --------------------------------------------------

/** One bounded, sanitized, labelled evidence item (the durable state/snapshot
 *  shape; the API DTO mirrors it). metadata is always rebuilt from allowlisted
 *  source fields - never a passthrough of raw provider output. */
export interface WriterEvidenceItem {
  id: string;
  source: WriterEvidenceSource;
  title: string | null;
  text: string;
  url: string | null;
  retrievedAt: string | null;
  trust: typeof WRITER_EVIDENCE_TRUST;
  metadata?: Record<string, string | number | boolean | null>;
}

/** One research source with its honest status and bounded, labelled items. */
export interface WriterEvidenceSourceSection {
  source: WriterEvidenceSource;
  status: WriterEvidenceStatus;
  note: string | null;
  items: WriterEvidenceItem[];
}

/** The durable research context of a run: per-source honest results of the
 *  last explicit research operation. `null` gatheredAt means research never
 *  ran; once gathered the object is non-null even when every source is
 *  empty/not_configured - research results are honest, never fabricated. */
export interface WriterEvidence {
  gatheredAt: string | null;
  sources: WriterEvidenceSourceSection[];
}

/** Deterministic canonical source order used by boundEvidence and the empty
 *  default so state/snapshot/prompt stay stable across runs. */
export const WRITER_EVIDENCE_SOURCE_ORDER: readonly WriterEvidenceSource[] = [
  'knowledge',
  'existing_content',
  'search',
  'intelligence',
];

/** Number of research sources in the canonical vocabulary (bounds the persisted
 *  snapshot: a corrupt snapshot cannot grow more sections than this). */
export const WRITER_MAX_EVIDENCE_SOURCES = WRITER_EVIDENCE_SOURCE_ORDER.length;

/** Evidence with nothing gathered yet: every source not configured. */
export function emptyWriterEvidence(): WriterEvidence {
  return {
    gatheredAt: null,
    sources: WRITER_EVIDENCE_SOURCE_ORDER.map((source) => ({
      source,
      status: 'not_configured',
      note: 'No research has been gathered for this run.',
      items: [],
    })),
  };
}

// --- research request + dependency boundary -----------------------------------

/** The bounded, explicit research request a gather resolves. projectId is
 *  always the immutable state value; adapters must scope every read to it. */
export interface WriterResearchRequest {
  projectId: string;
  topic: string;
  targetKeyword: string | null;
  purpose: WriterResearchPurpose;
}

/** A single `search` source row (an explicit, project-scoped search provider
 *  may be wired later; deny by default until then). */
export interface WriterSearchItem {
  title: string | null;
  text: string;
  url: string | null;
}

export type WriterSearchResult =
  | { status: 'available' | 'empty'; note: string | null; items: WriterSearchItem[] }
  | { status: 'not_configured' | 'unavailable'; note: string | null; items: [] };

/** Raw, unbounded per-source results a research adapter returns. The existing
 *  W1 read-only context result shapes are reused so research builds on the
 *  same service boundaries instead of duplicating provider access. */
export interface WriterResearchSources {
  knowledge: WriterKnowledgeResult;
  existingContent: WriterContentResult;
  intelligence: WriterIntelligenceResult;
  search: WriterSearchResult;
}

/** What a research adapter returns: the source results for one bounded request.
 *  Nothing here is ever stored as-is - boundEvidence sanitizes + bounds it. */
export interface WriterResearchResult extends WriterResearchSources {
  purpose: WriterResearchPurpose;
}

/** The explicit, dependency-injected allowlist a writer run may use for
 *  research. The graph never talks to Supabase, Qdrant, GSC or DataForSEO
 *  directly - it only calls research(), and only a gather node may call it. */
export interface WriterResearchDependencies {
  research(input: WriterResearchRequest): Promise<WriterResearchResult>;
}

/** Research dependencies with no sources wired: every source reports
 *  not_configured so an unwired research run degrades honestly instead of
 *  failing or fabricating. Deny by default. */
export const NO_RESEARCH_DEPENDENCIES: WriterResearchDependencies = {
  async research(input) {
    return {
      purpose: input.purpose,
      knowledge: {
        status: 'not_configured',
        note: 'No knowledge adapter is wired for this run.',
        chunks: [],
      },
      existingContent: {
        status: 'not_configured',
        note: 'No content adapter is wired for this run.',
        items: [],
      },
      intelligence: {
        status: 'not_configured',
        note: 'No intelligence adapter is wired for this run.',
        keywords: [],
      },
      search: {
        status: 'not_configured',
        note: 'No search adapter is wired for this run.',
        items: [],
      },
    };
  },
};

// --- review-session resume value for research ---------------------------------

/** Strict research session resume: `{ action: "research" }` plus an optional
 *  bounded purpose. Used both by the shared review-session gate (magic.ts) and
 *  by the route/service to validate a research request. */
export const writerResearchSessionSchema = z
  .object({
    action: z.literal('research'),
    /** Which later writer action the evidence is intended for (vocabulary;
     *  never steers the workflow today). */
    purpose: z.enum(WRITER_RESEARCH_PURPOSES).optional(),
  })
  .strict();

export type WriterResearchSessionDecision = z.infer<typeof writerResearchSessionSchema>;

export type WriterResearchParse =
  | { ok: true; purpose: WriterResearchPurpose }
  | { ok: false; note: string };

/** True when the value is a valid research session resume. */
export function isWriterResearchSessionDecision(value: unknown): value is WriterResearchSessionDecision {
  return writerResearchSessionSchema.safeParse(value).success;
}

/** The single validation gate for a research request body / session resume.
 *  Strict: only { action: "research" } plus an optional bounded purpose. */
export function parseWriterResearchRequest(value: unknown): WriterResearchParse {
  const parsed = writerResearchSessionSchema.safeParse(value);
  if (parsed.success) return { ok: true, purpose: parsed.data.purpose ?? 'revision' };
  return {
    ok: false,
    note: 'Research must be requested with { action: "research" } and an optional purpose from the bounded vocabulary.',
  };
}

// --- adapter output helpers ---------------------------------------------------

/** A source whose adapter threw degrades to an honest unavailable result
 *  (never a throw that could crash a gather; never a fabricated item). */
export function evidenceFallback(source: WriterEvidenceSource, err: unknown): WriterResearchSources[keyof WriterResearchSources] {
  const note = contextNoteFromError(err);
  switch (source) {
    case 'knowledge':
      return { status: 'unavailable', note, chunks: [] };
    case 'existing_content':
      return { status: 'unavailable', note, items: [] };
    case 'intelligence':
      return { status: 'unavailable', note, keywords: [] };
    case 'search':
      return { status: 'unavailable', note, items: [] };
  }
}

/** Degrades a whole thrown research call to honest not_configured results so a
 *  gather always rests back on review_ready with a truthful per-source state. */
export function degradedResearchResult(purpose: WriterResearchPurpose): WriterResearchResult {
  return {
    purpose,
    knowledge: { status: 'unavailable', note: 'Research could not run right now.', chunks: [] },
    existingContent: { status: 'unavailable', note: 'Research could not run right now.', items: [] },
    intelligence: { status: 'unavailable', note: 'Research could not run right now.', keywords: [] },
    search: { status: 'unavailable', note: 'Research could not run right now.', items: [] },
  };
}

// --- bounding + sanitizing ----------------------------------------------------

type PreBoundItem = {
  title: string | null;
  text: string;
  url: string | null;
  retrievedAt: string | null;
  metadata?: Record<string, string | number | boolean | null>;
};

function capNullable(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function capNote(value: string | null): string | null {
  return capNullable(value, WRITER_MAX_EVIDENCE_NOTE_CHARS);
}

function capMetadataValue(value: string): string {
  return value.slice(0, WRITER_MAX_EVIDENCE_METADATA_STR_CHARS);
}

/** Knowledge chunks -> pre-bound evidence candidates. Only allowlisted fields
 *  travel; the Qdrant hit id becomes small metadata, never a raw blob. */
function knowledgeCandidates(result: WriterKnowledgeResult): PreBoundItem[] {
  return result.chunks.map((chunk) => ({
    title: capNullable(chunk.title, WRITER_MAX_EVIDENCE_TITLE_CHARS),
    text: chunk.text,
    url: null,
    retrievedAt: null,
    metadata: { sourceId: capMetadataValue(chunk.sourceId) },
  }));
}

/** Existing-content rows -> candidates. No body text is fetched or invented,
 *  so text stays empty and the row's real fields travel as small metadata. */
function contentCandidates(result: WriterContentResult): PreBoundItem[] {
  return result.items.map((item) => ({
    title: capNullable(item.title, WRITER_MAX_EVIDENCE_TITLE_CHARS) ?? '',
    text: '',
    url: null,
    retrievedAt: null,
    metadata: {
      slug: capNullable(item.slug, WRITER_MAX_EVIDENCE_TITLE_CHARS),
      targetKeyword: capNullable(item.targetKeyword, WRITER_MAX_EVIDENCE_TITLE_CHARS),
      status: item.status,
    },
  }));
}

/** Intelligence keyword rows -> candidates with measured demand as metadata. */
function intelligenceCandidates(result: WriterIntelligenceResult): PreBoundItem[] {
  return result.keywords.map((row) => ({
    title: capNullable(row.keyword, WRITER_MAX_EVIDENCE_TITLE_CHARS) ?? '',
    text: '',
    url: null,
    retrievedAt: row.lastSeenAt ? capNullable(row.lastSeenAt, WRITER_MAX_EVIDENCE_NOTE_CHARS) : null,
    metadata: {
      volume: row.volume,
      difficulty: row.difficulty,
      cpc: row.cpc,
      provider: row.provider ? capMetadataValue(row.provider) : null,
    },
  }));
}

function searchCandidates(result: WriterSearchResult): PreBoundItem[] {
  return result.items.map((item) => ({
    title: capNullable(item.title, WRITER_MAX_EVIDENCE_TITLE_CHARS),
    text: item.text,
    url: capNullable(item.url, WRITER_MAX_EVIDENCE_TOTAL_CHARS),
    retrievedAt: null,
  }));
}

/** Maps one source result to a candidate list + the honest status derived from
 *  the raw result (an "available with no rows" source becomes empty). */
/** Maps a canonical evidence source onto the matching raw research result
 *  field (the evidence source is named "existing_content"; the result carries
 *  the W1 field name "existingContent"). */
export function researchSourceResult(
  result: WriterResearchResult,
  source: WriterEvidenceSource,
): WriterResearchSources[keyof WriterResearchSources] {
  switch (source) {
    case 'knowledge':
      return result.knowledge;
    case 'existing_content':
      return result.existingContent;
    case 'search':
      return result.search;
    case 'intelligence':
      return result.intelligence;
  }
}

function candidatesFor(
  source: WriterEvidenceSource,
  result: WriterResearchSources[keyof WriterResearchSources],
): { candidates: PreBoundItem[]; status: WriterEvidenceStatus; note: string | null } {
  switch (source) {
    case 'knowledge': {
      const r = result as WriterKnowledgeResult;
      const candidates = knowledgeCandidates(r);
      return {
        candidates,
        status: r.status === 'available' && candidates.length === 0 ? 'empty' : r.status,
        note: capNote(r.note),
      };
    }
    case 'existing_content': {
      const r = result as WriterContentResult;
      const candidates = contentCandidates(r);
      return {
        candidates,
        status: r.status === 'available' && candidates.length === 0 ? 'empty' : r.status,
        note: capNote(r.note),
      };
    }
    case 'search': {
      const r = result as WriterSearchResult;
      const candidates = searchCandidates(r);
      return {
        candidates,
        status: r.status === 'available' && candidates.length === 0 ? 'empty' : r.status,
        note: capNote(r.note),
      };
    }
    case 'intelligence': {
      const r = result as WriterIntelligenceResult;
      const candidates = intelligenceCandidates(r);
      return {
        candidates,
        status: r.status === 'configured' ? 'available' : r.status === 'no_data' ? 'empty' : r.status,
        note: capNote(r.note),
      };
    }
  }
}

/**
 * The single gate that turns raw research results into bounded, sanitized,
 * provenance-labelled evidence. Every item is capped (per-source count, text,
 * title), the total text payload is hard-bounded (trailing items are dropped
 * deterministically when a source floods the budget), trust is always
 * "untrusted", ids are deterministic per source, and an item only carries a
 * url/retrievedAt when the source really provided one - never invented. Empty
 * and not-configured sources stay honestly labelled with no fabricated items.
 */
export function boundEvidence(
  gatheredAt: string,
  result: WriterResearchResult,
): WriterEvidence {
  const staged: Array<{
    source: WriterEvidenceSource;
    status: WriterEvidenceStatus;
    note: string | null;
    candidates: PreBoundItem[];
  }> = WRITER_EVIDENCE_SOURCE_ORDER.map((source) => {
    const sourceResult = researchSourceResult(result, source);
    return { source, ...candidatesFor(source, sourceResult) };
  });

  // Total-payload budget: walk sources in canonical order, keep candidates
  // (text already item-capped later) while the running totals fit. Text is
  // measured AFTER the per-item cap so the bound is deterministic. Every
  // source section is always retained (empty when its items were all dropped
  // by the budget), so the stored evidence keeps the canonical per-source
  // honesty the UI and snapshot rely on.
  const capped: typeof staged = [];
  let totalText = 0;
  let totalItems = 0;
  for (const section of staged) {
    const kept: PreBoundItem[] = [];
    for (const candidate of section.candidates.slice(0, WRITER_MAX_EVIDENCE_SOURCE_ITEMS)) {
      if (totalItems >= WRITER_MAX_EVIDENCE_ITEMS) {
        break;
      }
      const text = candidate.text.slice(0, WRITER_MAX_EVIDENCE_ITEM_TEXT_CHARS);
      if (totalText + text.length > WRITER_MAX_EVIDENCE_TOTAL_CHARS) {
        break;
      }
      totalText += text.length;
      totalItems += 1;
      kept.push({ ...candidate, text });
    }
    capped.push({ ...section, candidates: kept });
  }

  const sources: WriterEvidenceSourceSection[] = capped.map((section) => {
    const items: WriterEvidenceItem[] = section.candidates.map((candidate, index) => ({
      id: `${section.source}:${index}`,
      source: section.source,
      title: candidate.title,
      text: candidate.text,
      url: candidate.url,
      retrievedAt: candidate.retrievedAt,
      trust: WRITER_EVIDENCE_TRUST,
      ...(candidate.metadata !== undefined ? { metadata: candidate.metadata } : {}),
    }));
    // An available source whose items were entirely dropped by the payload
    // budget must not claim "available": it has no retained evidence.
    const status: WriterEvidenceStatus =
      section.status === 'available' && items.length === 0 ? 'empty' : section.status;
    return { source: section.source, status, note: section.note, items };
  });

  return { gatheredAt, sources };
}

/** Total items across all sources (a helper for tests and honest UI counts). */
export function evidenceItemCount(evidence: WriterEvidence): number {
  return evidence.sources.reduce((sum, source) => sum + source.items.length, 0);
}

/** Total text characters across all evidence items. */
export function evidenceTextLength(evidence: WriterEvidence): number {
  return evidence.sources.reduce(
    (sum, source) => sum + source.items.reduce((s, item) => s + item.text.length, 0),
    0,
  );
}

/** Evidence containing only the not_configured default (research never ran or
 *  nothing is wired). */
export function isNotConfiguredEvidence(evidence: WriterEvidence): boolean {
  return (
    evidence.sources.length > 0 &&
    evidence.sources.every((source) => source.status === 'not_configured' && source.items.length === 0)
  );
}

/** Human label for a research source (prompts + honest UI). */
export function evidenceSourceLabel(source: WriterEvidenceSource): string {
  switch (source) {
    case 'knowledge':
      return 'knowledge';
    case 'existing_content':
      return 'existing content';
    case 'search':
      return 'search';
    case 'intelligence':
      return 'intelligence';
  }
}
