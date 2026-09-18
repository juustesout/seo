/**
 * Composition <-> editor handoff adapter (Stage 8E.4).
 *
 * The Composer/Writer produce a CanonicalDocument whose top-level vocabulary is
 * semantic composition (`hero`, `section`, `featureGrid`, `featureCard`, `cta`,
 * `button`, ...). The Content Studio editor speaks Tiptap and, as of Stage 8,
 * has real composition containers. This module is the bridge: it maps the
 * composition vocabulary onto those editor nodes and back, instead of flattening
 * the structure into article text.
 *
 * Mapping (canonical -> editor -> canonical):
 *   hero        <-> compositionHero
 *   section     <-> compositionSection
 *   featureGrid <-> compositionFeatureGrid
 *   featureCard <-> compositionFeatureCard
 *   cta         <-> compositionCta
 *   button      <-> compositionButton (structural label + href/variant)
 *
 * How it stays honest:
 *   - Containers that have no editor node (callout, testimonial, stats,
 *     mediaText, footer) keep their children rather than becoming an
 *     `[unsupported:...]` marker. Only that one node is degraded; the rest of
 *     the document keeps its structure.
 *   - An editor `image` node must carry a `mediaId` (see `isValidDocStructure`).
 *     An unfilled Composer media slot has none, so it is omitted rather than
 *     persisted as an invalid node. No placeholder media is ever fabricated.
 *   - Empty containers and leaves produce no node; nothing is invented.
 *   - Bounded attrs (`variant`, `layout`, `icon`, `href`) are carried exactly
 *     when the source has them, never synthesized.
 *
 * The transform is pure and never mutates its input: composing a document can
 * feed the renderer (preview) and this adapter (editor) from the same value.
 * No AI call, no network, no DOM.
 */

import type { CanonicalBlock, CanonicalDocument, CanonicalInline } from './canonical.js';
import {
  CANONICAL_COMPOSITION_ATTR_KEYS,
  CANONICAL_COMPOSITION_BLOCK_TYPES,
  CANONICAL_COMPOSITION_LEAF_BLOCK_TYPES,
  CANONICAL_DOCUMENT_VERSION,
} from './canonical.js';
import type { TipDoc } from './contentDoc.js';
import { canonicalToTiptap, tiptapToCanonical } from './tiptapAdapter.js';

const CONTAINER_TYPES: ReadonlySet<string> = new Set(CANONICAL_COMPOSITION_BLOCK_TYPES);
const LEAF_TYPES: ReadonlySet<string> = new Set(CANONICAL_COMPOSITION_LEAF_BLOCK_TYPES);

type CompositionType = keyof typeof CANONICAL_COMPOSITION_ATTR_KEYS;

/** Canonical composition type -> editor node name. */
const EDITOR_NODE_BY_TYPE: Record<string, string> = {
  hero: 'compositionHero',
  section: 'compositionSection',
  featureGrid: 'compositionFeatureGrid',
  featureCard: 'compositionFeatureCard',
  cta: 'compositionCta',
  button: 'compositionButton',
};

/** Editor node name -> canonical composition type. */
const TYPE_BY_EDITOR_NODE: Record<string, CompositionType> = Object.fromEntries(
  Object.entries(EDITOR_NODE_BY_TYPE).map(([canonical, editor]) => [editor, canonical]),
) as Record<string, CompositionType>;

/** Canonical attrs each editor composition node can carry. */
const EDITOR_ATTR_KEYS: Record<string, readonly string[]> = {
  compositionHero: CANONICAL_COMPOSITION_ATTR_KEYS.hero,
  compositionSection: CANONICAL_COMPOSITION_ATTR_KEYS.section,
  compositionFeatureGrid: CANONICAL_COMPOSITION_ATTR_KEYS.featureGrid,
  compositionFeatureCard: CANONICAL_COMPOSITION_ATTR_KEYS.featureCard,
  compositionCta: CANONICAL_COMPOSITION_ATTR_KEYS.cta,
  compositionButton: CANONICAL_COMPOSITION_ATTR_KEYS.button,
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function pickAttrs(
  source: Record<string, unknown> | undefined,
  keys: readonly string[] | undefined,
): Record<string, unknown> | undefined {
  if (!source || !keys) return undefined;
  const out: Record<string, unknown> = {};
  let any = false;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      out[key] = source[key];
      any = true;
    }
  }
  return any ? out : undefined;
}

function paragraphOf(content: CanonicalInline[]): CanonicalBlock {
  return { type: 'paragraph', content: [...content] };
}

/** Canonical block carrying an editor TipTap node as its `source`, so the
 *  generic adapter reconstructs it without this module duplicating conversion. */
function customOf(editorType: string, attrs: Record<string, unknown> | undefined): CanonicalBlock {
  const source = { cms: 'tiptap' as const, type: editorType };
  return attrs ? { type: 'custom', source: { ...source, attrs } } : { type: 'custom', source };
}

/**
 * Canonical composition -> canonical blocks whose composition nodes carry an
 * editor TipTap source. Runs before `canonicalToTiptap`, which then rebuilds the
 * exact editor nodes. Non-composition blocks pass through unchanged.
 */
function toEditorBlock(block: CanonicalBlock): CanonicalBlock[] {
  const editorType = EDITOR_NODE_BY_TYPE[block.type];

  if (editorType === 'compositionButton') {
    const content = block.content ?? [];
    if (content.length === 0) return [];
    const out = customOf(editorType, pickAttrs(block.attrs, EDITOR_ATTR_KEYS[editorType]));
    out.content = [...content];
    return [out];
  }

  if (editorType) {
    const children = (block.children ?? []).flatMap(toEditorBlock);
    if (children.length > 0) {
      const out = customOf(editorType, pickAttrs(block.attrs, EDITOR_ATTR_KEYS[editorType]));
      out.children = children;
      return [out];
    }
    if (block.content && block.content.length > 0) {
      const out = customOf(editorType, pickAttrs(block.attrs, EDITOR_ATTR_KEYS[editorType]));
      out.children = [paragraphOf(block.content)];
      return [out];
    }
    return [];
  }

  if (LEAF_TYPES.has(block.type)) {
    const out: CanonicalBlock[] = [];
    if (block.type === 'statItem' && isNonEmptyString(block.attrs?.value)) {
      out.push({ type: 'paragraph', content: [{ type: 'text', text: block.attrs.value }] });
    }
    if (block.content && block.content.length > 0) out.push(paragraphOf(block.content));
    return out;
  }

  if (CONTAINER_TYPES.has(block.type)) {
    const children = (block.children ?? []).flatMap(toEditorBlock);
    if (children.length > 0) return children;
    if (block.content && block.content.length > 0) return [paragraphOf(block.content)];
    return [];
  }

  if (block.type === 'list' || block.type === 'listItem') {
    const children = (block.children ?? []).flatMap(toEditorBlock);
    if (children.length > 0) return [{ ...block, children }];
    if (block.type === 'listItem' && block.content && block.content.length > 0) {
      return [{ ...block, content: [...block.content] }];
    }
    return [];
  }

  if (block.type === 'image') {
    return isNonEmptyString(block.attrs?.mediaId) ? [block] : [];
  }

  return [block];
}

/** A valid, editable empty document (matches `tiptapEmptyDoc`). */
function emptyEditorDoc(): TipDoc {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

/**
 * Converts a CanonicalDocument into an editor-ready Tiptap document without
 * mutating the source. Composition stays structured: containers become their
 * `composition*` editor nodes and `button` becomes a structural
 * `compositionButton`. The result is always structurally valid for
 * `isValidDocStructure` and never contains `[unsupported:...]` markers.
 */
export function canonicalDocumentToEditorDocument(document: CanonicalDocument): TipDoc {
  const blocks = Array.isArray(document?.blocks) ? document.blocks : [];
  const normalized: CanonicalDocument = { version: document.version, blocks: blocks.flatMap(toEditorBlock) };
  if (document.meta) normalized.meta = document.meta;
  const doc = canonicalToTiptap(normalized);
  return doc.content && doc.content.length > 0 ? doc : emptyEditorDoc();
}

/** Editor block carrying a canonical composition `source` -> canonical block. */
function toCanonicalBlock(block: CanonicalBlock): CanonicalBlock[] {
  if (block.type === 'custom' && block.source?.cms === 'tiptap') {
    const canonicalType = TYPE_BY_EDITOR_NODE[block.source.type as string];
    if (canonicalType) {
      const out: CanonicalBlock = { type: canonicalType };
      if (block.id !== undefined) out.id = block.id;
      const attrs = pickAttrs(
        block.source.attrs as Record<string, unknown> | undefined,
        CANONICAL_COMPOSITION_ATTR_KEYS[canonicalType],
      );
      if (attrs) out.attrs = attrs;
      if (block.children && block.children.length > 0) {
        out.children = block.children.flatMap(toCanonicalBlock);
      } else if (block.content && block.content.length > 0) {
        out.content = block.content;
      }
      return [out];
    }
  }
  if (block.children && block.children.length > 0) {
    return [{ ...block, children: block.children.flatMap(toCanonicalBlock) }];
  }
  return [block];
}

/**
 * Converts an editor Tiptap document back to a CanonicalDocument, restoring the
 * composition vocabulary (`compositionHero` -> `hero`, ...). Inverse of
 * {@link canonicalDocumentToEditorDocument} for the composition subset; other
 * content is handled by the Stage 1 adapter.
 */
export function editorDocumentToCanonical(doc: TipDoc | unknown): CanonicalDocument {
  const canonical = tiptapToCanonical(doc);
  return {
    version: CANONICAL_DOCUMENT_VERSION,
    blocks: canonical.blocks.flatMap(toCanonicalBlock),
  };
}
