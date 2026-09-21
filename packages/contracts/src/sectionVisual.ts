/**
 * Section visual target resolution (R4.2).
 *
 * R4.1 gave visuals a vocabulary; R4.2 turns the `section` role into a real,
 * user-visible capability. This module is the dependency-free, pure core of that
 * capability: it reconciles a section target with a canonical document snapshot
 * and derives the bounded section context the search uses, so the API and the
 * editor agree on what "this section" means.
 *
 * Meaning of a section in the actual document model (no new abstraction):
 *   - an explicit composition `section` block (editor `compositionSection`), or
 *   - a heading-delimited content region: a heading plus the following sibling
 *     blocks until the next heading of the same or higher level.
 *
 * The module never invents structure: if the anchor path is not a heading, or an
 * explicit section path does not contain it, resolution returns null so the
 * caller can ask instead of guessing. Pure and deterministic; no model, no
 * mutation, no persistence.
 */

import type { CanonicalBlock, CanonicalDocument, CanonicalInline } from './canonical.js';
import { IMAGE_INSERTION_TITLE_MAX_CHARS, type ImageInsertionSectionTarget } from './imageInsertion.js';

/** Canonical block type that represents an explicit section container. */
export const SECTION_BLOCK_TYPE = 'section';

/** Bounded length of the derived section body text used for retrieval. */
export const SECTION_VISUAL_MAX_BODY_CHARS = 1200;

/** The resolved meaning of a section target for one document snapshot. */
export interface ResolvedSectionVisual {
  sectionPath: number[];
  anchorPath: number[];
  /** The section heading, bounded. */
  heading: string;
  /** Bounded plain text of the section body after the heading. */
  body: string;
  /** True when the section already contains an image block. */
  hasImage: boolean;
}

interface ResolvedPath {
  siblings: CanonicalBlock[];
  index: number;
  block: CanonicalBlock;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function inlineText(content: readonly CanonicalInline[] | undefined): string {
  if (!content) return '';
  const parts: string[] = [];
  for (const inline of content) {
    if (inline.type === 'text' && typeof inline.text === 'string') parts.push(inline.text);
  }
  return normalize(parts.join(' '));
}

/** Plain text of a block, skipping media/markup so the copy drives retrieval. */
function blockText(block: CanonicalBlock): string {
  if (block.type === 'image' || block.type === 'html' || block.type === 'custom') return '';
  const parts: string[] = [inlineText(block.content)];
  if (block.children) {
    for (const child of block.children) {
      const text = blockText(child);
      if (text) parts.push(text);
    }
  }
  return normalize(parts.join(' '));
}

function containsImage(block: CanonicalBlock): boolean {
  if (block.type === 'image') return true;
  if (!block.children) return false;
  return block.children.some(containsImage);
}

function headingLevel(block: CanonicalBlock): number {
  const level = block.attrs?.level;
  return typeof level === 'number' && Number.isInteger(level) ? level : 6;
}

/** Resolves a structural index path to its block and the sibling array it lives in. */
function resolvePath(blocks: readonly CanonicalBlock[], path: readonly number[]): ResolvedPath | null {
  if (path.length === 0) return null;
  let siblings: readonly CanonicalBlock[] = blocks;
  for (let depth = 0; depth < path.length - 1; depth += 1) {
    const index = path[depth]!;
    const block = siblings[index];
    if (!block || !block.children) return null;
    siblings = block.children;
  }
  const index = path[path.length - 1]!;
  const block = siblings[index];
  if (!block) return null;
  return { siblings: siblings as CanonicalBlock[], index, block };
}

function samePath(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Resolves a section target against a canonical document, or null when the
 * target no longer maps to a real heading / explicit section. The caller turns
 * null into an honest "could not anchor the image" result, never an arbitrary
 * section. Pure.
 */
export function resolveSectionVisual(
  document: CanonicalDocument,
  target: ImageInsertionSectionTarget,
): ResolvedSectionVisual | null {
  const anchor = resolvePath(document.blocks, target.anchorPath);
  if (!anchor || anchor.block.type !== 'heading') return null;
  const heading = blockText(anchor.block).slice(0, IMAGE_INSERTION_TITLE_MAX_CHARS);
  if (!heading) return null;

  const region = samePath(target.sectionPath, target.anchorPath)
    ? null
    : resolvePath(document.blocks, target.sectionPath);
  if (region === null && !samePath(target.sectionPath, target.anchorPath)) return null;

  let siblings: CanonicalBlock[];
  let headingIndex: number;
  let sectionHasImage: boolean;

  if (samePath(target.sectionPath, target.anchorPath)) {
    siblings = anchor.siblings;
    headingIndex = anchor.index;
    sectionHasImage = false;
  } else {
    const section = region!;
    if (section.block.type !== SECTION_BLOCK_TYPE) return null;
    const expected = [...target.sectionPath, anchor.index];
    if (!samePath(expected, target.anchorPath)) return null;
    siblings = section.block.children ?? [];
    headingIndex = anchor.index;
    if (siblings[headingIndex] !== anchor.block) return null;
    sectionHasImage = containsImage(section.block);
  }

  const level = headingLevel(anchor.block);
  const parts: string[] = [];
  let regionHasImage = false;
  for (let index = headingIndex + 1; index < siblings.length; index += 1) {
    const child = siblings[index]!;
    if (child.type === 'heading' && headingLevel(child) <= level) break;
    if (containsImage(child)) regionHasImage = true;
    const text = blockText(child);
    if (text) parts.push(text);
  }
  const body = normalize(parts.join(' ')).slice(0, SECTION_VISUAL_MAX_BODY_CHARS);

  return {
    sectionPath: [...target.sectionPath],
    anchorPath: [...target.anchorPath],
    heading,
    body,
    hasImage: sectionHasImage || regionHasImage,
  };
}
