/**
 * Bounded Designer planner context (Stage 8E.6, Phase 3.2).
 *
 * The LLM planner only ever sees a small, server-assembled summary: the
 * project's bounded Cosmos text plus, when the intent targets existing content,
 * a bounded list of writable block references (the same refs a `writer.revise`
 * step may edit) and heading/word metadata. It never sees raw `content_json`,
 * arbitrary project rows or an unbounded selection, so a malicious document
 * cannot smuggle instructions or blow up the prompt.
 *
 * Types and pure bounds live here; the service that reads Postgres lives in
 * `services/designerPlannerContextService.ts`.
 */

import type { DesignBrief } from '@seo/contracts';

/** Bounds (single source of truth for the loader and the prompt). */
export const PLANNER_CONTEXT_MAX_BLOCKS = 60;
export const PLANNER_CONTEXT_BLOCK_TEXT_MAX_CHARS = 400;
export const PLANNER_CONTEXT_MAX_HEADINGS = 40;
export const PLANNER_CONTEXT_HEADING_TEXT_MAX_CHARS = 200;
export const PLANNER_CONTEXT_COSMOS_MAX_CHARS = 4000;

/** One writable block the planner may propose a `writer.revise` target for. */
export interface DesignerPlannerBlock {
  ref: string;
  type: string;
  text: string;
}

export interface DesignerPlannerHeading {
  level: number;
  text: string;
}

/** Bounded summary of the existing document an intent targets. */
export interface DesignerPlannerDocumentContext {
  contentId: string;
  title: string | null;
  targetKeyword: string | null;
  language: string | null;
  revision: string;
  wordCount: number;
  headings: DesignerPlannerHeading[];
  blocks: DesignerPlannerBlock[];
}

/** Everything the LLM planner is allowed to reason over. */
export interface DesignerPlannerContext {
  projectId: string;
  brief?: DesignBrief;
  /** Bounded, untrusted project context; data, never commands. */
  cosmosText: string;
  document?: DesignerPlannerDocumentContext;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Bounds the block list: at most `PLANNER_CONTEXT_MAX_BLOCKS`, each text capped. */
export function boundDesignerPlannerBlocks(blocks: readonly DesignerPlannerBlock[]): DesignerPlannerBlock[] {
  return blocks.slice(0, PLANNER_CONTEXT_MAX_BLOCKS).map((block) => ({
    ref: block.ref,
    type: block.type,
    text: truncate(block.text, PLANNER_CONTEXT_BLOCK_TEXT_MAX_CHARS),
  }));
}

/** Bounds the heading list: at most `PLANNER_CONTEXT_MAX_HEADINGS`, each capped. */
export function boundDesignerPlannerHeadings(headings: readonly DesignerPlannerHeading[]): DesignerPlannerHeading[] {
  return headings.slice(0, PLANNER_CONTEXT_MAX_HEADINGS).map((heading) => ({
    level: heading.level,
    text: truncate(heading.text, PLANNER_CONTEXT_HEADING_TEXT_MAX_CHARS),
  }));
}
