/**
 * Hero visual target resolution (R4.3).
 *
 * R4.1 gave visuals a vocabulary, R4.2 made the `section` role real; R4.3 is the
 * first hero-specific capability. This module is the dependency-free, pure core:
 * it reconciles a hero target with a canonical document snapshot and derives the
 * bounded hero context the search uses, so the API and the editor agree on what
 * "the hero" means.
 *
 * Meaning of a hero in the actual document model (no new abstraction, no second
 * document model):
 *   - an explicit composition `hero` block (editor `compositionHero`) that
 *     contains a heading, or
 *   - a heading-delimited page hero: the first top-level heading plus the copy
 *     that follows it until the next heading of any level.
 *
 * The module never invents structure: if the anchor is not a heading, or an
 * explicit hero path does not contain it, resolution returns null so the caller
 * can ask instead of guessing. Pure and deterministic; no model, no mutation, no
 * persistence.
 */

import type { CanonicalBlock, CanonicalDocument } from './canonical.js';
import {
  canonicalBlockContainsImage,
  canonicalBlockText,
  normalizeCanonicalText,
  resolveCanonicalPath,
  sameCanonicalPath,
} from './canonicalText.js';
import {
  IMAGE_INSERTION_HERO_SUPPORTING_MAX_CHARS,
  IMAGE_INSERTION_TITLE_MAX_CHARS,
  type ImageInsertionHeroTarget,
} from './imageInsertion.js';

/** Canonical block type that represents an explicit hero container. */
export const HERO_BLOCK_TYPE = 'hero';

/**
 * The editor node type that hosts a hero. Kept here so the editor and the API
 * agree on the structural hint without importing editor code into contracts.
 */
export const HERO_EDITOR_NODE_TYPE = 'compositionHero';

/** The resolved meaning of a hero target for one document snapshot. */
export interface ResolvedHeroVisual {
  heroPath: number[];
  anchorPath: number[];
  /** Canonical block type of the hero host (`hero` or `heading`). */
  nodeType: string;
  /** The hero heading, bounded. */
  heading: string;
  /** Bounded plain text of the supporting copy after the heading. */
  supportingText: string;
  /** True when the hero already contains an image block. */
  hasImage: boolean;
}

/**
 * Resolves a hero target against a canonical document, or null when the target
 * no longer maps to a real heading / explicit hero. The caller turns null into an
 * honest "could not anchor the hero image" result, never an arbitrary block.
 * Pure.
 */
export function resolveHeroVisual(
  document: CanonicalDocument,
  target: ImageInsertionHeroTarget,
): ResolvedHeroVisual | null {
  const anchor = resolveCanonicalPath(document.blocks, target.anchorPath);
  if (!anchor || anchor.block.type !== 'heading') return null;
  const heading = canonicalBlockText(anchor.block).slice(0, IMAGE_INSERTION_TITLE_MAX_CHARS);
  if (!heading) return null;

  const isContainer = !sameCanonicalPath(target.heroPath, target.anchorPath);
  let siblings: CanonicalBlock[];
  let headingIndex: number;
  let nodeType: string;
  let hostHasImage = false;

  if (!isContainer) {
    siblings = anchor.siblings;
    headingIndex = anchor.index;
    nodeType = 'heading';
  } else {
    const host = resolveCanonicalPath(document.blocks, target.heroPath);
    if (!host || host.block.type !== HERO_BLOCK_TYPE) return null;
    const expected = [...target.heroPath, anchor.index];
    if (!sameCanonicalPath(expected, target.anchorPath)) return null;
    const children = host.block.children ?? [];
    if (children[anchor.index] !== anchor.block) return null;
    siblings = children;
    headingIndex = anchor.index;
    nodeType = HERO_BLOCK_TYPE;
    hostHasImage = canonicalBlockContainsImage(host.block);
  }

  const parts: string[] = [];
  let regionHasImage = false;
  for (let index = headingIndex + 1; index < siblings.length; index += 1) {
    const child = siblings[index]!;
    // A heading-delimited page hero ends at the first following heading of any
    // level: the next heading starts the page body. An explicit hero container is
    // a single region, so all of its copy is supporting text.
    if (!isContainer && child.type === 'heading') break;
    if (canonicalBlockContainsImage(child)) regionHasImage = true;
    const text = canonicalBlockText(child);
    if (text) parts.push(text);
  }
  const supportingText = normalizeCanonicalText(parts.join(' ')).slice(0, IMAGE_INSERTION_HERO_SUPPORTING_MAX_CHARS);

  return {
    heroPath: [...target.heroPath],
    anchorPath: [...target.anchorPath],
    nodeType,
    heading,
    supportingText,
    hasImage: hostHasImage || regionHasImage,
  };
}
