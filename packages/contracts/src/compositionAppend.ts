/**
 * Composer -> document-operation mapping (R5.4.3.4).
 *
 * A composed page is a full `CanonicalDocument`. When the currently open
 * workspace document is non-empty, that page cannot replace it; the supported
 * parts must instead be appended through the existing operation-batch model. This
 * module is the pure, deterministic bridge between the two: it maps the composed
 * document onto the R2 operation vocabulary and reports every structure it could
 * not represent as an explicit gap.
 *
 * Boundaries (deliberate):
 *   - No React, EditorContext, session, API, persistence or Tiptap dependency.
 *   - Only existing operation kinds are emitted; this module adds no vocabulary.
 *   - Unsupported structures are never dropped silently and never approximated.
 *   - The input document is only read, never mutated.
 */

import {
  CANONICAL_BLOCK_VARIANTS,
  isValidCanonicalLayoutIntent,
  type CanonicalBlock,
  type CanonicalDocument,
  type CanonicalLayoutIntent,
} from './canonical.js';
import {
  DOCUMENT_OPERATION_MAX_OPS,
  DOCUMENT_OPERATION_TEXT_MAX_CHARS,
  type DocumentOperation,
  type DocumentOperationSectionKind,
} from './documentOperations.js';
import { isValidImageInsertionCandidate, type ImageInsertionCandidate } from './imageInsertion.js';

/** Why one composed structure could not be appended. Kept deliberately small. */
export type CompositionGapCode =
  | 'unsupported_block'
  | 'unsupported_content'
  | 'image_without_asset'
  | 'empty_container'
  | 'operation_limit';

/** One composed structure that the operation vocabulary cannot represent. */
export interface CompositionGap {
  /** Structural path in the composed document (top-level index, then child index). */
  path: number[];
  /** Canonical block type that could not be appended. */
  type: string;
  code: CompositionGapCode;
  /** Short, deterministic, user-facing explanation. */
  message: string;
}

/** The appendable result of mapping a composed document. */
export interface CompositionAppendMapping {
  /** Existing operation kinds, in document order, ready for a batch. */
  operations: DocumentOperation[];
  /** Composed structures that were not appended, with the reason. */
  gaps: CompositionGap[];
}

const BLOCK_LABELS: Readonly<Record<string, string>> = {
  hero: 'Hero section',
  section: 'Section',
  featureGrid: 'Feature grid',
  featureCard: 'Feature card',
  cta: 'CTA section',
  callout: 'Callout',
  testimonial: 'Testimonial',
  stats: 'Stats section',
  mediaText: 'Media text section',
  footer: 'Footer',
  badge: 'Badge',
  button: 'Button',
  statItem: 'Stat item',
  list: 'List',
  listItem: 'List item',
  quote: 'Quote',
  code: 'Code block',
  image: 'Image',
  heading: 'Heading',
  paragraph: 'Paragraph',
};

function labelOf(type: string): string {
  return BLOCK_LABELS[type] ?? type;
}

/** Concatenates the block's plain text, or null when it has non-text content. */
function textOf(block: CanonicalBlock): string | null {
  const content = block.content ?? [];
  if (content.length === 0) return null;
  let text = '';
  for (const inline of content) {
    if (inline.type !== 'text') return null;
    text += inline.text;
  }
  return text;
}

function isAppendableText(text: string | null): text is string {
  return text !== null && text.trim().length > 0 && text.length <= DOCUMENT_OPERATION_TEXT_MAX_CHARS;
}

function isSectionKind(type: string): type is DocumentOperationSectionKind {
  return type === 'hero' || type === 'section';
}

function sectionOf(block: CanonicalBlock): {
  kind: DocumentOperationSectionKind;
  variant?: string;
  layout?: CanonicalLayoutIntent;
} {
  const kind = block.type as DocumentOperationSectionKind;
  const spec: { kind: DocumentOperationSectionKind; variant?: string; layout?: CanonicalLayoutIntent } = { kind };
  const variant = block.attrs?.variant;
  const allowed = (CANONICAL_BLOCK_VARIANTS as Record<string, readonly string[] | undefined>)[kind];
  if (typeof variant === 'string' && allowed?.includes(variant)) spec.variant = variant;
  const layout = block.attrs?.layout;
  if (isValidCanonicalLayoutIntent(layout)) spec.layout = layout;
  return spec;
}

function imageCandidateOf(block: CanonicalBlock): ImageInsertionCandidate | null {
  const attrs = block.attrs ?? {};
  const { mediaId, src, alt } = attrs;
  if (typeof mediaId !== 'string' || mediaId.length === 0) return null;
  if (typeof src !== 'string' || src.length === 0) return null;
  if (typeof alt !== 'string' || alt.trim().length === 0) return null;
  const candidate: ImageInsertionCandidate = { assetId: mediaId, url: src, alt };
  if (typeof attrs.caption === 'string') candidate.caption = attrs.caption;
  if (typeof attrs.width === 'number' && Number.isInteger(attrs.width) && attrs.width > 0) candidate.width = attrs.width;
  if (typeof attrs.height === 'number' && Number.isInteger(attrs.height) && attrs.height > 0) candidate.height = attrs.height;
  return isValidImageInsertionCandidate(candidate) ? candidate : null;
}

type ChildMapping = { operations: DocumentOperation[]; gaps: CompositionGap[] };

/** Maps one child of a hero/section container, or records why it cannot be. */
function mapChild(block: CanonicalBlock, ref: string, path: number[]): ChildMapping {
  if (block.type === 'heading' || block.type === 'paragraph') {
    const text = textOf(block);
    if (!isAppendableText(text)) {
      return {
        operations: [],
        gaps: [
          {
            path,
            type: block.type,
            code: 'unsupported_content',
            message: `${labelOf(block.type)} could not be added because its text is not representable`,
          },
        ],
      };
    }
    if (block.type === 'heading') {
      const level = block.attrs?.level;
      if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6) {
        return {
          operations: [],
          gaps: [
            {
              path,
              type: block.type,
              code: 'unsupported_content',
              message: 'Heading could not be added because it has no representable level',
            },
          ],
        };
      }
      return {
        operations: [{ type: 'insert_text', target: { mode: 'ref', ref }, block: { type: 'heading', level: level as 1 | 2 | 3 | 4 | 5 | 6, text } }],
        gaps: [],
      };
    }
    return {
      operations: [{ type: 'insert_text', target: { mode: 'ref', ref }, block: { type: 'paragraph', text } }],
      gaps: [],
    };
  }

  if (block.type === 'image') {
    const candidate = imageCandidateOf(block);
    if (!candidate) {
      return {
        operations: [],
        gaps: [{ path, type: block.type, code: 'image_without_asset', message: 'Image has no assetId and was not added' }],
      };
    }
    return {
      operations: [{ type: 'insert_image', target: { mode: 'ref', ref }, image: candidate }],
      gaps: [],
    };
  }

  return {
    operations: [],
    gaps: [
      {
        path,
        type: block.type,
        code: 'unsupported_block',
        message: `${labelOf(block.type)} could not be added`,
      },
    ],
  };
}

/**
 * Maps a composed document onto append operations for a non-empty document.
 * Appendable hero/section containers and their heading/paragraph/asset-image
 * children become `insert_section` / `insert_text` / `insert_image` at
 * `document_end`, in document order; everything else becomes a gap. Pure and
 * deterministic: the input is never mutated.
 */
export function mapCompositionToAppendOperations(composed: CanonicalDocument): CompositionAppendMapping {
  const operations: DocumentOperation[] = [];
  const gaps: CompositionGap[] = [];
  const blocks = Array.isArray(composed?.blocks) ? composed.blocks : [];
  let sectionCount = 0;

  blocks.forEach((block, index) => {
    if (!isSectionKind(block.type)) {
      gaps.push({
        path: [index],
        type: block.type,
        code: 'unsupported_block',
        message: `${labelOf(block.type)} could not be added`,
      });
      return;
    }

    const ref = `section-${sectionCount + 1}`;
    const children = block.children ?? [];
    const childOperations: DocumentOperation[] = [];
    const childGaps: CompositionGap[] = [];
    children.forEach((child, childIndex) => {
      const mapped = mapChild(child, ref, [index, childIndex]);
      childOperations.push(...mapped.operations);
      childGaps.push(...mapped.gaps);
    });

    if (childOperations.length === 0) {
      gaps.push({
        path: [index],
        type: block.type,
        code: 'empty_container',
        message: `${labelOf(block.type)} had no supported content and was not added`,
      });
      return;
    }

    if (operations.length + 1 + childOperations.length > DOCUMENT_OPERATION_MAX_OPS) {
      gaps.push({
        path: [index],
        type: block.type,
        code: 'operation_limit',
        message: `${labelOf(block.type)} was not added because the operation limit was reached`,
      });
      return;
    }

    sectionCount += 1;
    operations.push({ type: 'insert_section', ref, section: sectionOf(block), position: { mode: 'document_end' } });
    operations.push(...childOperations);
    gaps.push(...childGaps);
  });

  return { operations, gaps };
}
