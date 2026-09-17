/**
 * Composition -> editor handoff adapter (Stage 8D).
 *
 * The Composer/Writer produce a CanonicalDocument whose top-level vocabulary is
 * semantic composition (`hero`, `section`, `featureGrid`, `featureCard`, `cta`,
 * `footer`, ...) plus composition leaf blocks (`button`, `badge`, `statItem`).
 * The Content Studio editor speaks Tiptap. This module is the minimal bridge
 * between the two, layered on top of the existing Stage 1 `canonicalToTiptap`
 * adapter so the actual block conversion is never duplicated.
 *
 * Why a composition-aware pre-pass is required:
 *   - The generic adapter is intentionally lossless and would surface an unknown
 *     composition block as an explicit `[unsupported:<type>]` marker. That is
 *     correct for arbitrary documents, but writing those markers into a real
 *     article would invent copy, so containers are flattened to their children
 *     and empty leaves simply contribute nothing.
 *   - An editor `image` node must carry a `mediaId` (see `isValidDocStructure`).
 *     An unfilled Composer media slot has none, so it is omitted rather than
 *     persisted as an invalid node. No placeholder media is ever fabricated.
 *   - An empty `list`/`listItem` would serialize to an invalid Tiptap node, so
 *     empty list scaffolding is dropped.
 *
 * The transform is pure and never mutates its input: composing a document can
 * feed the renderer (preview) and this adapter (editor) from the same value.
 * No AI call, no network, no DOM.
 */

import type { CanonicalBlock, CanonicalDocument } from './canonical.js';
import {
  CANONICAL_COMPOSITION_BLOCK_TYPES,
  CANONICAL_COMPOSITION_LEAF_BLOCK_TYPES,
} from './canonical.js';
import type { TipDoc } from './contentDoc.js';
import { canonicalToTiptap } from './tiptapAdapter.js';

const CONTAINER_TYPES: ReadonlySet<string> = new Set(CANONICAL_COMPOSITION_BLOCK_TYPES);
const LEAF_TYPES: ReadonlySet<string> = new Set(CANONICAL_COMPOSITION_LEAF_BLOCK_TYPES);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A composition leaf block (`button` / `badge`) carries an inline label; the
 * editor has no equivalent node, so it becomes a paragraph only when it has
 * text. `statItem` also carries an optional measured `value`. Nothing is
 * invented: empty leaves produce no node.
 */
function normalizeLeaf(block: CanonicalBlock): CanonicalBlock[] {
  const out: CanonicalBlock[] = [];
  if (block.type === 'statItem' && isNonEmptyString(block.attrs?.value)) {
    out.push({ type: 'paragraph', content: [{ type: 'text', text: block.attrs.value }] });
  }
  if (block.content && block.content.length > 0) {
    out.push({ type: 'paragraph', content: [...block.content] });
  }
  return out;
}

function normalizeBlocks(blocks: CanonicalBlock[]): CanonicalBlock[] {
  const out: CanonicalBlock[] = [];
  for (const block of blocks) {
    if (CONTAINER_TYPES.has(block.type)) {
      const children = normalizeBlocks(block.children ?? []);
      if (children.length > 0) {
        out.push(...children);
      } else if (block.content && block.content.length > 0) {
        out.push({ type: 'paragraph', content: [...block.content] });
      }
      continue;
    }
    if (LEAF_TYPES.has(block.type)) {
      out.push(...normalizeLeaf(block));
      continue;
    }
    if (block.type === 'list' || block.type === 'listItem') {
      const children = normalizeBlocks(block.children ?? []);
      if (children.length > 0) {
        out.push({ ...block, children });
      } else if (block.type === 'listItem' && block.content && block.content.length > 0) {
        out.push({ ...block, content: [...block.content] });
      }
      continue;
    }
    if (block.type === 'image') {
      // The editor schema requires a project media reference; an unfilled media
      // slot stays empty instead of becoming an invalid node or a fake image.
      if (isNonEmptyString(block.attrs?.mediaId)) out.push(block);
      continue;
    }
    out.push(block);
  }
  return out;
}

/** A valid, editable empty document (matches `tiptapEmptyDoc`). */
function emptyEditorDoc(): TipDoc {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}

/**
 * Converts a CanonicalDocument into an editor-ready Tiptap document without
 * mutating the source. The result is always structurally valid for
 * `isValidDocStructure` and never contains `[unsupported:...]` markers.
 */
export function canonicalDocumentToEditorDocument(document: CanonicalDocument): TipDoc {
  const blocks = Array.isArray(document?.blocks) ? document.blocks : [];
  const normalized: CanonicalDocument = { version: document.version, blocks: normalizeBlocks(blocks) };
  if (document.meta) normalized.meta = document.meta;
  const doc = canonicalToTiptap(normalized);
  return doc.content && doc.content.length > 0 ? doc : emptyEditorDoc();
}
