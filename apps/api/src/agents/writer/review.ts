/**
 * Writer Agent review and content assembly boundary (W5).
 *
 * The W5 phase is a deterministic, local conveyor belt. It takes the approved
 * plan (immutable) plus the written sections that W4 produced and reassembles
 * them into ONE canonical Content Studio document: the approved title as the
 * H1, then each approved section strictly in plan order as its approved
 * heading plus the written body split into paragraphs. Nothing is invented: no
 * intro copy (there is no authored intro in the plan), no reordering, no new
 * headings. The document is rendered through the existing canonical renderer
 * (renderDocHtml) and scored with the existing Phase C SEO evaluator
 * (evaluateSeo) - both are the @seo/contracts canonical pipeline, so the
 * writer never invents a score and never carries its own content model.
 *
 * The exact-match invariant is enforced here again (deny-by-default) even
 * though W4 already stores only complete, validated sections: writtenSections
 * must correspond exactly to the approved plan sections - no planned section
 * missing, no unknown section, no duplicate section. Any breach fails the
 * review instead of silently skipping, padding or completing.
 *
 * This phase performs no AI call, no provider call, no database write, no job
 * enqueue and no publication: it has no capability to do any of that. A
 * hostile knowledge chunk or a hostile written section is plain data here and
 * can never steer the assembly.
 */

import { evaluateSeo, renderDocHtml, type SeoEvalInput, type SeoResult, type TipDoc, type TipNode } from '@seo/contracts';
import { isValidDocStructure } from '@seo/contracts';
import { logger } from '../../logger.js';
import { isValidSectionContent } from './sectionWriter.js';
import type { WriterPlan, WriterWrittenSection, WriterReview } from './state.js';
import { writerSectionIdFor } from './state.js';

// --- hard bounds -------------------------------------------------------------

/** Longest single authored paragraph kept when splitting a written section
 *  body; longer plain bodies are split deterministically, never truncated. */
export const WRITER_REVIEW_MAX_TOP_LEVEL_NODES = 500;

// --- assembly -----------------------------------------------------------------

/** Why the canonical review could not be produced; every code maps to an
 *  honest reviewStatus "failed". */
export type WriterReviewFailureCode =
  | 'missing_section'
  | 'extra_section'
  | 'invalid_content'
  | 'assembly_failed'
  | 'render_failed'
  | 'evaluate_failed';

/** Everything the deterministic review phase needs from the run: the approved
 *  plan (identity of the outline), the written sections and the run's target
 *  keyword. All are already-bounded run state; nothing else is consulted. */
export interface WriterReviewInput {
  plan: WriterPlan;
  writtenSections: WriterWrittenSection[];
  targetKeyword: string | null;
}

export type WriterReviewOutcome =
  | { ok: true; review: WriterReview }
  | { ok: false; code: WriterReviewFailureCode; note: string };

/** The injected allowlist for the review phase. Production uses the canonical
 *  @seo/contracts evaluator and renderer; tests inject fakes to prove the
 *  phase delegates to them and to nothing else. */
export interface WriterReviewDependencies {
  /** The existing Phase C SEO evaluator (canonical). */
  evaluate(input: SeoEvalInput): SeoResult;
  /** The existing canonical TipTap -> HTML renderer. */
  renderHtml(doc: TipDoc): string;
}

/** The production review dependency allowlist: the real canonical pipeline. */
export const DEFAULT_WRITER_REVIEW_DEPENDENCIES: WriterReviewDependencies = {
  evaluate: evaluateSeo,
  renderHtml: renderDocHtml,
};

function textNode(text: string): TipNode {
  return { type: 'text', text };
}

function headingNode(level: 1 | 2, heading: string): TipNode {
  return { type: 'heading', attrs: { level }, content: [textNode(heading)] };
}

function paragraphNode(text: string): TipNode {
  return { type: 'paragraph', content: [textNode(text)] };
}

/** Splits a plain written body into single-paragraph texts on blank lines and
 *  collapses stray whitespace inside each, so the canonical document only ever
 *  carries clean paragraphs (never stray newlines inside a text node). */
export function contentParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0);
}

/** Assembles ONE canonical TipTap document from the immutable approved plan
 *  and the written sections, matching each written section to its approved
 *  plan section by deterministic index. The document always starts with the
 *  approved title as the H1 and then follows the plan strictly in order.
 *  writtenSections order is never trusted. */
export function assembleReviewDocument(
  plan: WriterPlan,
  writtenSections: WriterWrittenSection[],
): { ok: true; doc: TipDoc } | { ok: false; code: WriterReviewFailureCode; note: string } {
  const expected = new Set(plan.sections.map((_, index) => writerSectionIdFor(index)));
  const byId = new Map<string, WriterWrittenSection>();
  const seen = new Set<string>();
  for (const entry of writtenSections) {
    if (seen.has(entry.sectionId)) {
      return {
        ok: false,
        code: 'extra_section',
        note: `Section ${entry.sectionId} was written more than once; refusing to assemble.`,
      };
    }
    seen.add(entry.sectionId);
    if (!expected.has(entry.sectionId)) {
      return {
        ok: false,
        code: 'extra_section',
        note: `Section ${entry.sectionId} does not belong to the approved plan; refusing to assemble.`,
      };
    }
    if (!isValidSectionContent(entry.content)) {
      return {
        ok: false,
        code: 'invalid_content',
        note: `Section ${entry.sectionId} carries invalid content; refusing to assemble.`,
      };
    }
    byId.set(entry.sectionId, entry);
  }

  const nodes: TipNode[] = [headingNode(1, plan.title)];
  for (let index = 0; index < plan.sections.length; index += 1) {
    const sectionId = writerSectionIdFor(index);
    const entry = byId.get(sectionId);
    if (!entry) {
      return {
        ok: false,
        code: 'missing_section',
        note: `Planned section ${sectionId} ("${plan.sections[index].heading}") was never written; refusing to assemble.`,
      };
    }
    const section = plan.sections[index];
    nodes.push(headingNode(2, section.heading));
    for (const paragraph of contentParagraphs(entry.content)) {
      nodes.push(paragraphNode(paragraph));
    }
  }
  if (nodes.length > WRITER_REVIEW_MAX_TOP_LEVEL_NODES) {
    return { ok: false, code: 'assembly_failed', note: 'Assembled document exceeds the node bound.' };
  }
  const doc: TipDoc = { type: 'doc', content: nodes };
  if (!isValidDocStructure(doc)) {
    return { ok: false, code: 'assembly_failed', note: 'Assembled document is not a valid Tiptap document.' };
  }
  return { ok: true, doc };
}

// --- deterministic review ------------------------------------------------------

/** Runs the full W5 review: assemble the canonical document, render its HTML
 *  through the existing renderer and score it with the existing evaluator.
 *  Pure and local - no AI, no providers, no writes. */
export function reviewWriterContent(
  deps: WriterReviewDependencies,
  input: WriterReviewInput,
): WriterReviewOutcome {
  const assembled = assembleReviewDocument(input.plan, input.writtenSections);
  if (!assembled.ok) {
    return { ok: false, code: assembled.code, note: assembled.note };
  }
  const { doc } = assembled;

  let contentHtml: string;
  try {
    contentHtml = deps.renderHtml(doc);
  } catch (err) {
    logger.warn({ err }, 'writer review HTML render failed');
    return { ok: false, code: 'render_failed', note: 'The canonical HTML renderer failed for the assembled document.' };
  }

  let seo: SeoResult;
  try {
    seo = deps.evaluate({
      doc,
      meta: {
        title: input.plan.title,
        targetKeyword: input.targetKeyword ?? null,
        metaTitle: null,
        metaDescription: input.plan.metaDescription ?? null,
      },
    });
  } catch (err) {
    logger.warn({ err }, 'writer review SEO evaluation failed');
    return { ok: false, code: 'evaluate_failed', note: 'The canonical SEO evaluator failed for the assembled document.' };
  }

  return { ok: true, review: { contentJson: doc, contentHtml, seo } };
}
