/**
 * Writer Agent intelligence layer (W10.3).
 *
 * W10.2 research gathers bounded, project-scoped evidence. W10.3 adds a deeper,
 * still fully controlled intelligence operation on top of it: while a run rests
 * on `review_ready` the human can combine several of the project's EXISTING
 * sources into a bounded set of findings. This module owns every rule of that
 * operation short of the graph wiring:
 *
 *   - the canonical source / finding-type / status vocabulary and the hard
 *     bounds an intelligence payload must obey (finding counts, per-source
 *     counts, summary length, evidence references, total findings);
 *   - the strict request contract (`{ purpose, focus?, sections? }`) plus the
 *     session resume value `{ action: "intelligence", ... }` that starts a
 *     gather from the resting review session;
 *   - the explicit, deny-by-default dependency boundary
 *     (WriterIntelligenceDependencies) the writer graph may call - never direct
 *     SQL, provider calls, API keys or service-role secrets;
 *   - `boundIntelligence`: the single gate that turns raw per-source readings
 *     into the bounded, sanitized, deduplicated, trust-labelled
 *     WriterIntelligence a run stores and later revision/magic rounds may read.
 *
 * Security model (W10.3), mirroring W1/W10.2:
 *   - combined signals are DATA, never instructions: every stored finding
 *     carries `trust: "untrusted"` set here at the boundary (never by an
 *     adapter), and prompt builders place findings in a dedicated data block
 *     far from the system rules and output contract;
 *   - intelligence is bounded: a source (or hostile text behind it) can never
 *     grow the run state without limit - counts, per-source counts and summary
 *     length are hard-capped below, and empty results stay honestly empty;
 *   - provenance is never invented: a finding only ever carries the evidence
 *     references its adapter provided; numbers travel only when a source really
 *     measured them;
 *   - deny by default: an unwired source reports not_configured; an unwired
 *     intelligence boundary answers not_configured for every source. No
 *     fabricated fallback finding ever enters state.
 *
 * Intelligence NEVER publishes, saves content, reads credentials, drives
 * workflows, browses the web, runs autonomous loops or triggers further actions
 * on its own - it only ever produces this bounded, labelled snapshot.
 */

import { z } from 'zod';
import type { WriterContextTrust } from './context.js';
import { WRITER_CONTEXT_TRUST, contextNoteFromError } from './context.js';

// --- canonical vocabulary ----------------------------------------------------

/** Safe, project-scoped sources intelligence may be combined from. */
export const WRITER_INTELLIGENCE_SOURCES = [
  'knowledge',
  'existing_content',
  'dataforseo',
  'gsc',
  'content_intelligence',
] as const;
export type WriterIntelligenceSource = (typeof WRITER_INTELLIGENCE_SOURCES)[number];

/** Honest availability of one intelligence source. */
export const WRITER_INTELLIGENCE_SOURCE_STATUSES = [
  'available',
  'empty',
  'not_configured',
  'unavailable',
] as const;
export type WriterIntelligenceSourceStatus = (typeof WRITER_INTELLIGENCE_SOURCE_STATUSES)[number];

/** The kind of signal a finding represents. */
export const WRITER_INTELLIGENCE_FINDING_TYPES = [
  'keyword',
  'opportunity',
  'overlap',
  'knowledge',
  'content',
] as const;
export type WriterIntelligenceFindingType = (typeof WRITER_INTELLIGENCE_FINDING_TYPES)[number];

/** Overall honesty of a gather. */
export const WRITER_INTELLIGENCE_STATUSES = [
  'available',
  'partial',
  'empty',
  'not_configured',
  'unavailable',
] as const;
export type WriterIntelligenceStatus = (typeof WRITER_INTELLIGENCE_STATUSES)[number];

/** Why the human triggered an intelligence gather (bounded vocabulary; never
 *  steers the workflow). */
export const WRITER_INTELLIGENCE_PURPOSES = ['deep_research', 'planning', 'section_magic', 'revision'] as const;
export type WriterIntelligencePurpose = (typeof WRITER_INTELLIGENCE_PURPOSES)[number];

/** Every intelligence finding is untrusted input from outside the run's control. */
export const WRITER_INTELLIGENCE_TRUST = WRITER_CONTEXT_TRUST;
export type WriterIntelligenceTrust = WriterContextTrust;

// --- hard bounds -------------------------------------------------------------

/** Max findings kept per intelligence source. */
export const WRITER_MAX_INTELLIGENCE_SOURCE_FINDINGS = 8;
/** Max findings kept in total across all sources. */
export const WRITER_MAX_INTELLIGENCE_FINDINGS = 20;
/** Max characters kept per finding summary. */
export const WRITER_MAX_INTELLIGENCE_SUMMARY_CHARS = 500;
/** Max characters kept for any per-source note (secret-free by construction). */
export const WRITER_MAX_INTELLIGENCE_NOTE_CHARS = 300;
/** Max characters kept for the optional human focus string. */
export const WRITER_MAX_INTELLIGENCE_FOCUS_CHARS = 300;
/** Max evidence references kept per finding. */
export const WRITER_MAX_INTELLIGENCE_EVIDENCE_IDS = 6;
/** Max characters kept per evidence reference id. */
export const WRITER_MAX_INTELLIGENCE_EVIDENCE_ID_CHARS = 120;
/** Max sections an intelligence request may focus on. */
export const WRITER_MAX_INTELLIGENCE_SECTIONS = 12;

/** Deterministic canonical source order used by boundIntelligence and the empty
 *  default so state/snapshot/prompt stay stable across runs. */
export const WRITER_INTELLIGENCE_SOURCE_ORDER: readonly WriterIntelligenceSource[] = [
  'knowledge',
  'existing_content',
  'dataforseo',
  'gsc',
  'content_intelligence',
];

/** Number of intelligence sources in the canonical vocabulary (bounds the
 *  persisted snapshot: a corrupt snapshot cannot grow more sections than this). */
export const WRITER_MAX_INTELLIGENCE_SOURCES = WRITER_INTELLIGENCE_SOURCE_ORDER.length;

// --- stored intelligence shapes ----------------------------------------------

/** One bounded, sanitized, labelled finding (the durable state/snapshot shape;
 *  the API DTO mirrors it). */
export interface WriterIntelligenceFinding {
  id: string;
  type: WriterIntelligenceFindingType;
  summary: string;
  evidenceIds: string[];
  trust: typeof WRITER_INTELLIGENCE_TRUST;
}

/** One intelligence source with its honest status and bounded finding count. */
export interface WriterIntelligenceSourceSection {
  source: WriterIntelligenceSource;
  status: WriterIntelligenceSourceStatus;
  note: string | null;
  findingCount: number;
}

/** The durable intelligence snapshot of a run: the honest status plus the
 *  bounded, deduplicated findings of the last explicit intelligence operation.
 *  `null` gatheredAt means intelligence never ran. */
export interface WriterIntelligence {
  gatheredAt: string | null;
  status: WriterIntelligenceStatus;
  findings: WriterIntelligenceFinding[];
  sources: WriterIntelligenceSourceSection[];
  note: string | null;
}

/** Intelligence with nothing gathered yet: every source not configured. */
export function emptyWriterIntelligence(): WriterIntelligence {
  return {
    gatheredAt: null,
    status: 'not_configured',
    findings: [],
    sources: WRITER_INTELLIGENCE_SOURCE_ORDER.map((source) => ({
      source,
      status: 'not_configured',
      note: 'No intelligence has been gathered for this run.',
      findingCount: 0,
    })),
    note: 'No intelligence has been gathered for this run.',
  };
}

// --- request + dependency boundary -------------------------------------------

/** The bounded, explicit intelligence request a gather resolves. projectId and
 *  contentId are always the immutable run binding; adapters must scope every
 *  read to them. */
export interface WriterIntelligenceRequest {
  projectId: string;
  contentId: string;
  topic: string;
  targetKeyword: string | null;
  purpose: WriterIntelligencePurpose;
  focus: string | null;
  /** Validated section ids from the approved plan, ascending; empty means the
   *  whole draft. Re-validated against the plan before the graph is reached. */
  sections: string[];
}

/** Raw, unbounded finding an adapter returns. Nothing here is ever stored as-is
 *  - boundIntelligence sanitizes + bounds it. */
export interface WriterIntelligenceRawFinding {
  type: WriterIntelligenceFindingType;
  summary: string;
  evidenceIds: string[];
}

/** Honest per-source reading an adapter returns for one bounded request. */
export interface WriterIntelligenceSourceReading {
  status: WriterIntelligenceSourceStatus;
  note: string | null;
  findings: WriterIntelligenceRawFinding[];
}

/** Raw per-source readings a research adapter returns. */
export interface WriterIntelligenceReading {
  knowledge: WriterIntelligenceSourceReading;
  existingContent: WriterIntelligenceSourceReading;
  dataforseo: WriterIntelligenceSourceReading;
  gsc: WriterIntelligenceSourceReading;
  contentIntelligence: WriterIntelligenceSourceReading;
}

/** The explicit, dependency-injected allowlist a writer run may use for
 *  intelligence. The graph never talks to Supabase, Qdrant, GSC or DataForSEO
 *  directly - it only calls gather(), and only the intelligence node may. */
export interface WriterIntelligenceDependencies {
  gather(input: WriterIntelligenceRequest): Promise<WriterIntelligenceReading>;
}

function notConfiguredReading(note: string): WriterIntelligenceSourceReading {
  return { status: 'not_configured', note, findings: [] };
}

/** Intelligence dependencies with no sources wired: every source reports
 *  not_configured so an unwired run degrades honestly instead of failing or
 *  fabricating. Deny by default. */
export const NO_INTELLIGENCE_DEPENDENCIES: WriterIntelligenceDependencies = {
  async gather() {
    return {
      knowledge: notConfiguredReading('No knowledge adapter is wired for this run.'),
      existingContent: notConfiguredReading('No content adapter is wired for this run.'),
      dataforseo: notConfiguredReading('No keyword adapter is wired for this run.'),
      gsc: notConfiguredReading('No Search Console adapter is wired for this run.'),
      contentIntelligence: notConfiguredReading('No content intelligence adapter is wired for this run.'),
    };
  },
};

/** Degrades a whole thrown intelligence call to honest unavailable readings so
 *  a gather always rests back on review_ready with a truthful source state. */
export function degradedIntelligenceReading(): WriterIntelligenceReading {
  const unavailable = (): WriterIntelligenceSourceReading => ({
    status: 'unavailable',
    note: 'Intelligence could not be gathered right now.',
    findings: [],
  });
  return {
    knowledge: unavailable(),
    existingContent: unavailable(),
    dataforseo: unavailable(),
    gsc: unavailable(),
    contentIntelligence: unavailable(),
  };
}

/** Maps a canonical intelligence source onto its raw reading field. */
export function intelligenceSourceReading(
  reading: WriterIntelligenceReading,
  source: WriterIntelligenceSource,
): WriterIntelligenceSourceReading {
  switch (source) {
    case 'knowledge':
      return reading.knowledge;
    case 'existing_content':
      return reading.existingContent;
    case 'dataforseo':
      return reading.dataforseo;
    case 'gsc':
      return reading.gsc;
    case 'content_intelligence':
      return reading.contentIntelligence;
  }
}

// --- request gate ------------------------------------------------------------

/** Strict user-facing intelligence request body. `purpose` is required and
 *  bounded; `focus` is optional and bounded; `sections` are optional stable
 *  section ids (re-validated against the approved plan by the caller). No
 *  workflow-control fields are ever accepted. */
export const writerIntelligenceRequestBodySchema = z
  .object({
    purpose: z.enum(WRITER_INTELLIGENCE_PURPOSES),
    focus: z.string().trim().min(1).max(WRITER_MAX_INTELLIGENCE_FOCUS_CHARS).optional(),
    sections: z
      .array(z.string().regex(/^section_\d+$/))
      .max(WRITER_MAX_INTELLIGENCE_SECTIONS)
      .optional(),
  })
  .strict();

export type WriterIntelligenceRequestBody = z.infer<typeof writerIntelligenceRequestBodySchema>;

export type WriterIntelligenceRequestParse =
  | { ok: true; request: { purpose: WriterIntelligencePurpose; focus: string | null; sections: string[] } }
  | { ok: false; note: string };

/** The single validation gate for an intelligence request body. Strict: only
 *  { purpose, focus?, sections? }. Duplicate sections are rejected here (the
 *  caller additionally rejects unknown sections against the plan). */
export function parseWriterIntelligenceRequest(value: unknown): WriterIntelligenceRequestParse {
  const parsed = writerIntelligenceRequestBodySchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      note: 'Intelligence must be requested with { purpose, focus?, sections? } using the bounded vocabulary.',
    };
  }
  const sections = parsed.data.sections ?? [];
  if (new Set(sections).size !== sections.length) {
    return { ok: false, note: 'Intelligence sections must not contain duplicates.' };
  }
  return {
    ok: true,
    request: { purpose: parsed.data.purpose, focus: parsed.data.focus ?? null, sections },
  };
}

/** Strict review-session resume value for an intelligence gather. Used both by
 *  the shared review-session gate (magic.ts) and by the route/service to build
 *  the durable resume. */
export const writerIntelligenceSessionSchema = z
  .object({
    action: z.literal('intelligence'),
    purpose: z.enum(WRITER_INTELLIGENCE_PURPOSES),
    focus: z.string().trim().min(1).max(WRITER_MAX_INTELLIGENCE_FOCUS_CHARS).optional(),
    sections: z
      .array(z.string().regex(/^section_\d+$/))
      .max(WRITER_MAX_INTELLIGENCE_SECTIONS)
      .optional(),
  })
  .strict();

export type WriterIntelligenceSessionDecision = z.infer<typeof writerIntelligenceSessionSchema>;

/** True when the value is a valid intelligence session resume. */
export function isWriterIntelligenceSessionDecision(
  value: unknown,
): value is WriterIntelligenceSessionDecision {
  return writerIntelligenceSessionSchema.safeParse(value).success;
}

// --- bounding + sanitizing ---------------------------------------------------

function capNullable(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function capNote(value: string | null): string | null {
  return capNullable(value, WRITER_MAX_INTELLIGENCE_NOTE_CHARS);
}

function normalizeSummary(summary: string): string {
  return summary.replace(/\s+/g, ' ').trim().toLowerCase();
}

function capEvidenceIds(ids: string[]): string[] {
  return ids
    .map((id) => capNullable(id, WRITER_MAX_INTELLIGENCE_EVIDENCE_ID_CHARS))
    .filter((id): id is string => id !== null)
    .slice(0, WRITER_MAX_INTELLIGENCE_EVIDENCE_IDS);
}

/** Computes the honest overall status from the bounded per-source sections. */
function overallIntelligenceStatus(sources: WriterIntelligenceSourceSection[]): WriterIntelligenceStatus {
  const successful = sources.filter((s) => s.status === 'available' || s.status === 'empty');
  const totalFindings = sources.reduce((sum, s) => sum + s.findingCount, 0);
  if (successful.length === 0) {
    return sources.some((s) => s.status === 'not_configured') ? 'not_configured' : 'unavailable';
  }
  if (totalFindings === 0) return 'empty';
  const degraded = sources.some((s) => s.status === 'unavailable' || s.status === 'not_configured');
  return degraded ? 'partial' : 'available';
}

/** Honest, secret-free note for the overall status. */
function overallIntelligenceNote(status: WriterIntelligenceStatus): string | null {
  switch (status) {
    case 'available':
      return 'Intelligence gathered from this project’s sources.';
    case 'partial':
      return 'Intelligence gathered from some sources; other sources were empty or unavailable.';
    case 'empty':
      return 'No intelligence signals were found in the available sources.';
    case 'not_configured':
      return 'No intelligence sources are configured for this project yet.';
    case 'unavailable':
      return 'Intelligence sources could not be read right now.';
  }
}

/**
 * The single gate that turns raw per-source readings into the bounded,
 * sanitized, deduplicated, trust-labelled WriterIntelligence. Every finding is
 * capped (per-source count, summary length, evidence references), duplicate
 * summaries are dropped deterministically (first occurrence in canonical source
 * order wins), and the total finding count is hard-bounded. Trust is always
 * "untrusted", ids are deterministic per source, and empty / not-configured /
 * unavailable sources stay honestly labelled with no fabricated finding.
 */
export function boundIntelligence(gatheredAt: string, reading: WriterIntelligenceReading): WriterIntelligence {
  const seen = new Set<string>();
  const findings: WriterIntelligenceFinding[] = [];
  const sources: WriterIntelligenceSourceSection[] = [];

  for (const source of WRITER_INTELLIGENCE_SOURCE_ORDER) {
    const raw = intelligenceSourceReading(reading, source);
    const kept: WriterIntelligenceFinding[] = [];
    for (const candidate of raw.findings) {
      if (findings.length >= WRITER_MAX_INTELLIGENCE_FINDINGS) break;
      if (kept.length >= WRITER_MAX_INTELLIGENCE_SOURCE_FINDINGS) break;
      const summary = candidate.summary.replace(/\s+/g, ' ').trim().slice(0, WRITER_MAX_INTELLIGENCE_SUMMARY_CHARS);
      if (!summary) continue;
      const key = normalizeSummary(summary);
      if (seen.has(key)) continue;
      seen.add(key);
      const finding: WriterIntelligenceFinding = {
        id: `${source}:${kept.length}`,
        type: candidate.type,
        summary,
        evidenceIds: capEvidenceIds(candidate.evidenceIds),
        trust: WRITER_INTELLIGENCE_TRUST,
      };
      kept.push(finding);
      findings.push(finding);
    }
    // An available source whose findings were entirely dropped (duplicates or
    // the total budget) must not claim "available": it has no retained finding.
    const status: WriterIntelligenceSourceStatus =
      raw.status === 'available' && kept.length === 0 ? 'empty' : raw.status;
    sources.push({ source, status, note: capNote(raw.note), findingCount: kept.length });
  }

  const status = overallIntelligenceStatus(sources);
  return { gatheredAt, status, findings, sources, note: overallIntelligenceNote(status) };
}

/** Total findings across all sources (helper for tests and honest UI counts). */
export function intelligenceFindingCount(intelligence: WriterIntelligence): number {
  return intelligence.findings.length;
}

/** Intelligence containing only the not_configured default (never ran or
 *  nothing is wired). */
export function isNotConfiguredIntelligence(intelligence: WriterIntelligence): boolean {
  return (
    intelligence.sources.length > 0 &&
    intelligence.sources.every((source) => source.status === 'not_configured' && source.findingCount === 0)
  );
}

/** Human label for an intelligence source (prompts + honest UI). */
export function intelligenceSourceLabel(source: WriterIntelligenceSource): string {
  switch (source) {
    case 'knowledge':
      return 'knowledge';
    case 'existing_content':
      return 'existing content';
    case 'dataforseo':
      return 'keyword demand';
    case 'gsc':
      return 'Search Console';
    case 'content_intelligence':
      return 'content intelligence';
  }
}

/** Human label for a finding type. */
export function intelligenceFindingTypeLabel(type: WriterIntelligenceFindingType): string {
  switch (type) {
    case 'keyword':
      return 'keyword';
    case 'opportunity':
      return 'opportunity';
    case 'overlap':
      return 'overlap';
    case 'knowledge':
      return 'knowledge';
    case 'content':
      return 'content';
  }
}

/** Bounded note built from an error message (never a stack). */
export function intelligenceNoteFromError(err: unknown): string {
  return capNullable(contextNoteFromError(err), WRITER_MAX_INTELLIGENCE_NOTE_CHARS) ?? 'The source failed.';
}
