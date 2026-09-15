/**
 * Writer format registry (W1: Shared Writer Engine).
 *
 * A format is a small, code-owned structure definition: how many sections the
 * article has, what shape those sections take and a deterministic validator
 * that the produced plan must satisfy before any section is written. Formats
 * are deliberately NOT part of the external provider registry - they are not
 * pluggable vendor capability, they are the product's editorial contract.
 *
 * The registry is the only place a format id becomes behaviour: the engine
 * never hardcodes a format, and the model never invents arbitrary structure -
 * the format's `outlineGuidance` is authoritative prompt input and its
 * `validate` is the deny-by-default gate on the model's plan.
 */

import type { ArticlePlan, WriterFormatId } from '@seo/contracts';
import { WRITER_MAX_SECTIONS } from '@seo/contracts';

export interface WriterFormatValidation {
  ok: boolean;
  note: string | null;
}

export interface WriterFormatDefinition {
  id: WriterFormatId;
  name: string;
  description: string;
  minSections: number;
  maxSections: number;
  /** Word target used when the caller did not request a specific length. */
  recommendedTargetLength: number;
  /** Authoritative structure guidance injected into the outline prompt. */
  outlineGuidance: string;
  /** Deterministic validation of a produced plan against this format. */
  validate(plan: ArticlePlan): WriterFormatValidation;
}

function valid(): WriterFormatValidation {
  return { ok: true, note: null };
}

function invalid(note: string): WriterFormatValidation {
  return { ok: false, note };
}

/**
 * Shared structural validation: title present, section count in range and
 * every heading non-empty and unique (case-insensitive). Used by every format
 * so a new format only declares its own bounds and prose.
 */
function validateStructure(
  plan: ArticlePlan,
  minSections: number,
  maxSections: number,
): WriterFormatValidation {
  const title = plan.title.trim();
  if (!title) return invalid('The plan is missing a title.');
  if (plan.sections.length < minSections || plan.sections.length > maxSections) {
    return invalid(
      `The plan has ${plan.sections.length} sections; this format requires ${minSections}..${maxSections}.`,
    );
  }
  const seen = new Set<string>();
  for (const section of plan.sections) {
    const heading = section.heading.trim();
    if (!heading) return invalid('Every planned section must have a heading.');
    const key = heading.toLowerCase();
    if (seen.has(key)) return invalid(`Planned heading "${heading}" is used more than once.`);
    seen.add(key);
  }
  return valid();
}

const SHORT_ARTICLE: WriterFormatDefinition = {
  id: 'short_article',
  name: 'Short article',
  description: 'A focused, direct article that answers the topic without filler.',
  minSections: 3,
  maxSections: 5,
  recommendedTargetLength: 700,
  outlineGuidance:
    'Format: a focused short article with 3..5 top-level sections. Lead directly with the answer the reader needs; do not plan a separate introduction or conclusion section; keep each section tight and scannable.',
  validate: (plan) => validateStructure(plan, 3, 5),
};

const EXPLAINER: WriterFormatDefinition = {
  id: 'explainer',
  name: 'Explainer',
  description: 'A structured explanation that moves from what and why to how.',
  minSections: 4,
  maxSections: 7,
  recommendedTargetLength: 1200,
  outlineGuidance:
    'Format: an explainer with 4..7 sections that progresses from what and why to how; include at least one concrete example and finish with a practical takeaways section.',
  validate: (plan) => validateStructure(plan, 4, 7),
};

const FORMATS: Record<WriterFormatId, WriterFormatDefinition> = {
  short_article: SHORT_ARTICLE,
  explainer: EXPLAINER,
};

/** The definition for a format id, or null when it is not registered. */
export function getWriterFormat(id: string): WriterFormatDefinition | null {
  return (FORMATS as Record<string, WriterFormatDefinition | undefined>)[id] ?? null;
}

/** Every registered format, in stable declaration order. */
export function listWriterFormats(): WriterFormatDefinition[] {
  return Object.values(FORMATS);
}

/**
 * Composes the authoritative outline guidance for one call: the format's own
 * structure rules plus, when the caller asked for a length, the requested body
 * size. Bounded so a caller-supplied number can never bloat the prompt.
 */
export function outlineGuidanceFor(format: WriterFormatDefinition, targetLength?: number | null): string {
  const length =
    typeof targetLength === 'number' && Number.isFinite(targetLength) && targetLength > 0
      ? Math.round(targetLength)
      : format.recommendedTargetLength;
  return `${format.outlineGuidance} Plan for roughly ${length} words of body copy in total.`;
}

/** Sanity guard so a future format cannot declare impossible bounds. */
export function isFormatDefinitionConsistent(format: WriterFormatDefinition): boolean {
  return (
    format.minSections >= 1 &&
    format.minSections <= format.maxSections &&
    format.maxSections <= WRITER_MAX_SECTIONS &&
    format.outlineGuidance.trim().length > 0
  );
}
