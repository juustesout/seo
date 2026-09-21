/**
 * Canonical document text and path helpers (shared by the visual resolvers).
 *
 * R4.2 introduced a section resolver that had to read plain text and structural
 * index paths out of a canonical snapshot; R4.3 needs exactly the same reads for
 * the hero. This module holds those pure helpers once so the two resolvers cannot
 * drift: `resolveSectionVisual` and `resolveHeroVisual` disagree only about what
 * a region means, never about how a path is walked or how text is flattened.
 *
 * Dependency-free by convention: plain types plus hand-rolled helpers. It reads a
 * canonical document and returns values; it never mutates and never invents
 * structure.
 */

import type { CanonicalBlock, CanonicalInline } from './canonical.js';

/** Collapses whitespace and trims, so text comparisons and queries are stable. */
export function normalizeCanonicalText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Concatenates the text inlines of a block, collapsing whitespace. */
export function canonicalInlineText(content: readonly CanonicalInline[] | undefined): string {
  if (!content) return '';
  const parts: string[] = [];
  for (const inline of content) {
    if (inline.type === 'text' && typeof inline.text === 'string') parts.push(inline.text);
  }
  return normalizeCanonicalText(parts.join(' '));
}

/** Plain text of a block, skipping media/markup so the copy drives retrieval. */
export function canonicalBlockText(block: CanonicalBlock): string {
  if (block.type === 'image' || block.type === 'html' || block.type === 'custom') return '';
  const parts: string[] = [canonicalInlineText(block.content)];
  if (block.children) {
    for (const child of block.children) {
      const text = canonicalBlockText(child);
      if (text) parts.push(text);
    }
  }
  return normalizeCanonicalText(parts.join(' '));
}

/** True when a block, or anything nested below it, is an image block. */
export function canonicalBlockContainsImage(block: CanonicalBlock): boolean {
  if (block.type === 'image') return true;
  if (!block.children) return false;
  return block.children.some(canonicalBlockContainsImage);
}

/** The heading level of a block, defaulting to the deepest level when unnamed. */
export function canonicalHeadingLevel(block: CanonicalBlock): number {
  const level = block.attrs?.level;
  return typeof level === 'number' && Number.isInteger(level) ? level : 6;
}

/** A resolved structural index path plus the sibling array it lives in. */
export interface CanonicalPath {
  siblings: CanonicalBlock[];
  index: number;
  block: CanonicalBlock;
}

/** Resolves a structural index path to its block and the sibling array it lives in. */
export function resolveCanonicalPath(blocks: readonly CanonicalBlock[], path: readonly number[]): CanonicalPath | null {
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

/** True when two structural index paths address the same position. */
export function sameCanonicalPath(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
