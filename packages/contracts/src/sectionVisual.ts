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

import type { CanonicalBlock, CanonicalDocument } from './canonical.js';
import {
  canonicalBlockContainsImage,
  canonicalBlockText,
  canonicalHeadingLevel,
  normalizeCanonicalText,
  resolveCanonicalPath,
  sameCanonicalPath,
} from './canonicalText.js';
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
  const anchor = resolveCanonicalPath(document.blocks, target.anchorPath);
  if (!anchor || anchor.block.type !== 'heading') return null;
  const heading = canonicalBlockText(anchor.block).slice(0, IMAGE_INSERTION_TITLE_MAX_CHARS);
  if (!heading) return null;

  const region = sameCanonicalPath(target.sectionPath, target.anchorPath)
    ? null
    : resolveCanonicalPath(document.blocks, target.sectionPath);
  if (region === null && !sameCanonicalPath(target.sectionPath, target.anchorPath)) return null;

  let siblings: CanonicalBlock[];
  let headingIndex: number;
  let sectionHasImage: boolean;

  if (sameCanonicalPath(target.sectionPath, target.anchorPath)) {
    siblings = anchor.siblings;
    headingIndex = anchor.index;
    sectionHasImage = false;
  } else {
    const section = region!;
    if (section.block.type !== SECTION_BLOCK_TYPE) return null;
    const expected = [...target.sectionPath, anchor.index];
    if (!sameCanonicalPath(expected, target.anchorPath)) return null;
    siblings = section.block.children ?? [];
    headingIndex = anchor.index;
    if (siblings[headingIndex] !== anchor.block) return null;
    sectionHasImage = canonicalBlockContainsImage(section.block);
  }

  const level = canonicalHeadingLevel(anchor.block);
  const parts: string[] = [];
  let regionHasImage = false;
  for (let index = headingIndex + 1; index < siblings.length; index += 1) {
    const child = siblings[index]!;
    if (child.type === 'heading' && canonicalHeadingLevel(child) <= level) break;
    if (canonicalBlockContainsImage(child)) regionHasImage = true;
    const text = canonicalBlockText(child);
    if (text) parts.push(text);
  }
  const body = normalizeCanonicalText(parts.join(' ')).slice(0, SECTION_VISUAL_MAX_BODY_CHARS);

  return {
    sectionPath: [...target.sectionPath],
    anchorPath: [...target.anchorPath],
    heading,
    body,
    hasImage: sectionHasImage || regionHasImage,
  };
}
