/**
 * Cross-format document conversion bridge (Stage 3).
 *
 * Exposes the interchange paths
 *
 *   WordPress HTML <-> CanonicalDocument <-> Tiptap JSON
 *
 * by composing the Stage 1 (`tiptapAdapter`) and Stage 2 (`wordpressAdapter`)
 * adapters. `CanonicalDocument` is the only intermediary: no format is
 * converted directly to another and no parsing, serialization or mapping logic
 * is duplicated here.
 *
 * Fidelity:
 *   - `wordpressToCanonical` / `canonicalToWordPress` are the lossless Stage 2
 *     adapter and preserve WordPress content (including unknown blocks, raw
 *     HTML and malformed attribute payloads) byte-for-byte on a round trip.
 *   - `tiptapToCanonical` / `canonicalToTiptap` are the Stage 1 adapter and
 *     round-trip everything the current editor schema represents.
 *   - The cross-format helpers inherit both boundaries. Content TipTap cannot
 *     represent is never dropped silently: it survives as visible text or an
 *     explicit `[unsupported:<type>]` marker (see `canonicalToTiptap`). See the
 *     package tests for the explicit loss classification.
 *
 * All functions are deterministic and side-effect free. No DOM, React, network
 * or WordPress dependency.
 */

import type { TipDoc } from './contentDoc.js';
import type { CanonicalDocument } from './canonical.js';
import { canonicalToTiptap, tiptapToCanonical } from './tiptapAdapter.js';
import { parseWordPressBlocks, serializeWordPressBlocks } from './wordpressAdapter.js';

export { canonicalToTiptap, tiptapToCanonical };

/** WordPress `post_content` block markup -> canonical document (lossless). */
export function wordpressToCanonical(html: string): CanonicalDocument {
  return parseWordPressBlocks(html);
}

/** Canonical document -> WordPress `post_content` block markup. */
export function canonicalToWordPress(doc: CanonicalDocument): string {
  return serializeWordPressBlocks(doc);
}

/**
 * WordPress block markup -> canonical -> Tiptap. The result is editor-shaped;
 * content outside the current Tiptap schema is preserved through the canonical
 * fallback, never discarded.
 */
export function wordpressToTipTap(html: string): TipDoc {
  return canonicalToTiptap(parseWordPressBlocks(html));
}

/**
 * Tiptap JSON -> canonical -> WordPress block markup. Unknown Tiptap nodes are
 * carried through the canonical `source` envelope and emitted as WordPress
 * custom blocks where possible.
 */
export function tiptapToWordPress(doc: TipDoc): string {
  return serializeWordPressBlocks(tiptapToCanonical(doc));
}
