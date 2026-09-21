/**
 * Editor-native image insertion helpers (R3.1).
 *
 * Pure, deterministic glue between the R1.2 editor context and the R3.1
 * `insert_image` contract. It builds the bounded context the backend reasons
 * over, re-validates the returned location against the live document, and
 * applies the insertion as one undoable editor transaction through the existing
 * `insertMedia` command (the same command the media picker uses).
 *
 * Deliberate boundaries:
 *   - The location is a per-snapshot hint; it is re-validated here before any
 *     mutation. An unresolvable target fails honestly instead of inserting at an
 *     arbitrary position.
 *   - Only a library-backed image (`assetId`) is insertable: the image node's
 *     canonical value is the media reference, so a candidate without one is
 *     refused rather than rendered as a broken image.
 *   - This module reads the live editor only for semantics/location; it never
 *     owns document state and never persists.
 */
import type { Editor } from '@tiptap/react';
import type { Node as PmNode } from '@tiptap/pm/model';
import {
  IMAGE_INSERTION_HERO_PLACEMENT,
  IMAGE_INSERTION_HERO_SUPPORTING_MAX_CHARS,
  IMAGE_INSERTION_LANGUAGE_MAX_CHARS,
  IMAGE_INSERTION_MAX_TEXT_CHARS,
  IMAGE_INSERTION_NEARBY_MAX_CHARS,
  IMAGE_INSERTION_NODE_TYPE_MAX_CHARS,
  IMAGE_INSERTION_TITLE_MAX_CHARS,
  isValidImageInsertionContext,
  type ImageInsertionContext,
  type ImageInsertionHeroTarget,
  type ImageInsertionSectionTarget,
  type ImageInsertionTarget,
  type InsertImageOperation,
} from '@seo/contracts';
import type { EditorContextSnapshot, EditorSelectionSnapshot } from './editorContext';

/** The semantic context derived from the live editor for one insertion. */
export interface EditorImageSemantics {
  selectedText?: string;
  nearbyText: string;
  sectionHeading?: string;
  /** The top-level node type the selection sits on, a role hint for R4.1. */
  targetNodeType?: string;
  /**
   * R4.2: the section the selection sits in, when one can be resolved. It is a
   * structural hint for the `section` role; the backend validates it against the
   * canonical snapshot and the editor re-validates it before inserting.
   */
  sectionTarget?: ImageInsertionSectionTarget;
  /**
   * R4.3: the hero the request addresses, when one can be resolved. It is a
   * structural hint for the `hero` role; the backend validates it against the
   * canonical snapshot and the editor re-validates it before inserting.
   */
  heroTarget?: ImageInsertionHeroTarget;
}

/** Editor node names that describe a section for R4.2 and a hero for R4.3. */
const SECTION_NODE_TYPE = 'compositionSection';
const HERO_NODE_TYPE = 'compositionHero';
const HEADING_NODE_TYPE = 'heading';

/** Why an insertion could not be applied. Product copy maps these, they are not shown raw. */
export type ImageInsertionApplyReason =
  | 'no-editor'
  | 'not-ready'
  | 'stale-revision'
  | 'unresolved-target'
  | 'missing-asset'
  | 'apply-failed';

export type ImageInsertionApplyResult = { ok: true } | { ok: false; reason: ImageInsertionApplyReason };

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clamp(value: string, max: number): string {
  return normalize(value).slice(0, max);
}

/**
 * Maps the normalized selection onto an insertion target, or null when there is
 * no reliable point. A selected image is deliberately not a target: replacement
 * is out of scope for R3.1 and must not silently become a duplicate insertion.
 */
export function imageInsertionTargetFromSelection(selection: EditorSelectionSnapshot): ImageInsertionTarget | null {
  if (selection.type === 'cursor' && typeof selection.from === 'number') {
    return { kind: 'cursor', position: selection.from };
  }
  if (
    selection.type === 'text' &&
    typeof selection.from === 'number' &&
    typeof selection.to === 'number' &&
    selection.from < selection.to
  ) {
    return { kind: 'text-selection', from: selection.from, to: selection.to };
  }
  if (
    selection.type === 'node' &&
    selection.nodeType !== 'image' &&
    selection.nodePath &&
    selection.nodePath.length > 0
  ) {
    return { kind: 'block', path: [...selection.nodePath] };
  }
  return null;
}

function headingText(node: PmNode): string {
  return normalize(node.textContent).slice(0, IMAGE_INSERTION_TITLE_MAX_CHARS);
}

/** Index of the first non-empty heading among a container's children, or null. */
function firstHeadingIndex(container: PmNode): number | null {
  for (let index = 0; index < container.childCount; index += 1) {
    const child = container.child(index);
    if (child.type.name === HEADING_NODE_TYPE && headingText(child).length > 0) return index;
  }
  return null;
}

/**
 * Reads the section the current selection sits in, as a structural hint for the
 * `section` visual role. Two shapes are recognized, mirroring the canonical
 * section definition: an explicit `compositionSection` container, or the nearest
 * preceding top-level heading (a heading-delimited region). Returns null when
 * neither exists so the backend can ask instead of guessing. Pure read.
 */
export function readEditorSectionTarget(editor: Editor | null): ImageInsertionSectionTarget | null {
  if (!editor || editor.isDestroyed) return null;
  const { doc, selection } = editor.state;
  if (doc.childCount === 0) return null;

  const topIndex = Math.max(0, Math.min(doc.resolve(selection.from).index(0), doc.childCount - 1));
  const topNode = doc.child(topIndex);

  if (topNode.type.name === SECTION_NODE_TYPE) {
    const headingIndex = firstHeadingIndex(topNode);
    if (headingIndex === null) return null;
    const heading = headingText(topNode.child(headingIndex));
    if (!heading) return null;
    return { kind: 'section', sectionPath: [topIndex], anchorPath: [topIndex, headingIndex], heading };
  }

  for (let index = topIndex; index >= 0; index -= 1) {
    const node = doc.child(index);
    if (node.type.name === HEADING_NODE_TYPE) {
      const heading = headingText(node);
      if (!heading) return null;
      return { kind: 'section', sectionPath: [index], anchorPath: [index], heading };
    }
  }
  return null;
}

/** Bounded supporting copy after `fromIndex`, optionally stopping at a heading. */
function supportingTextAfter(container: PmNode, fromIndex: number, stopAtHeading: boolean): string {
  const parts: string[] = [];
  for (let index = fromIndex + 1; index < container.childCount; index += 1) {
    const child = container.child(index);
    if (stopAtHeading && child.type.name === HEADING_NODE_TYPE) break;
    const text = normalize(child.textContent);
    if (text) parts.push(text);
  }
  return normalize(parts.join(' ')).slice(0, IMAGE_INSERTION_HERO_SUPPORTING_MAX_CHARS);
}

/**
 * Reads the hero the current request addresses, as a structural hint for the
 * `hero` visual role (R4.3). Two shapes are recognized, mirroring the canonical
 * hero definition: an explicit `compositionHero` container (preferring the one
 * the selection sits in, otherwise the first), or the first top-level heading as
 * the page hero. Returns null when neither exists so the backend can ask instead
 * of guessing. Pure read.
 */
export function readEditorHeroTarget(editor: Editor | null): ImageInsertionHeroTarget | null {
  if (!editor || editor.isDestroyed) return null;
  const { doc, selection } = editor.state;
  if (doc.childCount === 0) return null;

  const topIndex = Math.max(0, Math.min(doc.resolve(selection.from).index(0), doc.childCount - 1));

  let heroIndex: number | null = null;
  for (let index = 0; index < doc.childCount; index += 1) {
    if (doc.child(index).type.name !== HERO_NODE_TYPE) continue;
    if (index === topIndex) {
      heroIndex = index;
      break;
    }
    if (heroIndex === null) heroIndex = index;
  }
  if (heroIndex !== null) {
    const host = doc.child(heroIndex);
    const headingIndex = firstHeadingIndex(host);
    if (headingIndex === null) return null;
    const headingNode = host.child(headingIndex);
    const heading = headingText(headingNode);
    if (!heading) return null;
    const supportingText = supportingTextAfter(host, headingIndex, false);
    return {
      kind: 'hero',
      heroPath: [heroIndex],
      anchorPath: [heroIndex, headingIndex],
      nodeType: HERO_NODE_TYPE,
      placement: IMAGE_INSERTION_HERO_PLACEMENT,
      heading,
      ...(supportingText ? { supportingText } : {}),
    };
  }

  for (let index = 0; index < doc.childCount; index += 1) {
    const node = doc.child(index);
    if (node.type.name !== HEADING_NODE_TYPE) continue;
    const heading = headingText(node);
    if (!heading) continue;
    const supportingText = supportingTextAfter(doc, index, true);
    return {
      kind: 'hero',
      heroPath: [index],
      anchorPath: [index],
      nodeType: HEADING_NODE_TYPE,
      placement: IMAGE_INSERTION_HERO_PLACEMENT,
      heading,
      ...(supportingText ? { supportingText } : {}),
    };
  }
  return null;
}

/**
 * Reads bounded semantic context from the live editor: the selected text, the
 * surrounding copy (previous/current/next block) and the nearest preceding
 * heading. It never reads the whole document body and never invents context.
 */
export function readEditorImageSemantics(editor: Editor | null): EditorImageSemantics {
  if (!editor || editor.isDestroyed) return { nearbyText: '' };
  const { doc, selection } = editor.state;

  const selectedText = selection.empty
    ? undefined
    : doc.textBetween(selection.from, selection.to, ' ', ' ').replace(/\s+/g, ' ').trim().slice(0, IMAGE_INSERTION_MAX_TEXT_CHARS);

  const topIndex = Math.max(0, Math.min(doc.resolve(selection.from).index(0), doc.childCount - 1));
  const around: Array<PmNode | null> = [
    topIndex > 0 ? doc.child(topIndex - 1) : null,
    doc.childCount > 0 ? doc.child(topIndex) : null,
    topIndex + 1 < doc.childCount ? doc.child(topIndex + 1) : null,
  ];
  const nearbyText = around
    .filter((node): node is PmNode => node !== null && !node.isLeaf && normalize(node.textContent).length > 0)
    .map((node) => normalize(node.textContent))
    .join(' ')
    .slice(0, IMAGE_INSERTION_NEARBY_MAX_CHARS);

  let sectionHeading: string | undefined;
  doc.nodesBetween(0, selection.from, (node) => {
    if (node.type.name === 'heading' && normalize(node.textContent).length > 0) {
      sectionHeading = normalize(node.textContent).slice(0, IMAGE_INSERTION_TITLE_MAX_CHARS);
    }
  });

  const targetNodeType = doc.childCount > 0 ? doc.child(topIndex).type.name : undefined;
  const sectionTarget = readEditorSectionTarget(editor);
  const heroTarget = readEditorHeroTarget(editor);

  return {
    ...(selectedText ? { selectedText } : {}),
    nearbyText,
    ...(sectionHeading ? { sectionHeading } : {}),
    ...(targetNodeType ? { targetNodeType } : {}),
    ...(sectionTarget ? { sectionTarget } : {}),
    ...(heroTarget ? { heroTarget } : {}),
  };
}

/**
 * Builds the bounded insert context from an editor snapshot. Returns null unless
 * the document is ready, persisted, representable, clean and has a reliable
 * target - the caller turns null into a clarification instead of guessing.
 */
export function imageInsertionContextFromSnapshot(
  snapshot: EditorContextSnapshot,
  semantics: EditorImageSemantics,
): ImageInsertionContext | null {
  if (!snapshot.ready || snapshot.contentId === null) return null;
  if (snapshot.document.unrepresentable || snapshot.document.dirty) return null;
  const canonical = snapshot.document.canonical;
  const revision = snapshot.document.revision;
  if (!canonical || !revision) return null;

  const target = imageInsertionTargetFromSelection(snapshot.selection);
  if (!target) return null;

  const meta = canonical.meta ?? {};
  const context: ImageInsertionContext = {
    revision,
    document: canonical,
    target,
    ...(semantics.selectedText ? { selectedText: clamp(semantics.selectedText, IMAGE_INSERTION_MAX_TEXT_CHARS) } : {}),
    nearbyText: clamp(semantics.nearbyText, IMAGE_INSERTION_NEARBY_MAX_CHARS),
    ...(meta.title ? { documentTitle: clamp(meta.title, IMAGE_INSERTION_TITLE_MAX_CHARS) } : {}),
    ...(semantics.sectionHeading ? { sectionHeading: clamp(semantics.sectionHeading, IMAGE_INSERTION_TITLE_MAX_CHARS) } : {}),
    ...(semantics.targetNodeType
      ? { targetNodeType: clamp(semantics.targetNodeType, IMAGE_INSERTION_NODE_TYPE_MAX_CHARS) }
      : {}),
    ...(semantics.sectionTarget ? { sectionTarget: semantics.sectionTarget } : {}),
    ...(semantics.heroTarget ? { heroTarget: semantics.heroTarget } : {}),
    ...(meta.language ? { language: clamp(meta.language, IMAGE_INSERTION_LANGUAGE_MAX_CHARS) } : {}),
  };
  return isValidImageInsertionContext(context) ? context : null;
}

/** Walks a structural index path to the position immediately before its node. */
function positionBeforePath(doc: PmNode, path: readonly number[]): number | null {
  let node: PmNode = doc;
  let pos = 0;
  for (const index of path) {
    if (!Number.isInteger(index) || index < 0 || index >= node.childCount) return null;
    for (let i = 0; i < index; i += 1) pos += node.child(i).nodeSize;
    node = node.child(index);
    pos += 1;
  }
  return pos - 1;
}

/**
 * Re-validates an insertion target against the live document and resolves it to
 * an editor range. Null means the target no longer maps to a safe position, so
 * the caller must not insert.
 */
export function resolveImageInsertionRange(
  editor: Editor,
  target: ImageInsertionTarget,
): number | { from: number; to: number } | null {
  const size = editor.state.doc.content.size;
  if (target.kind === 'cursor') {
    return Number.isInteger(target.position) && target.position >= 0 && target.position <= size ? target.position : null;
  }
  if (target.kind === 'text-selection') {
    return Number.isInteger(target.from) && target.from >= 0 && target.to >= target.from && target.to <= size
      ? { from: target.from, to: target.to }
      : null;
  }
  if (target.kind === 'section' || target.kind === 'hero') {
    const before = positionBeforePath(editor.state.doc, target.anchorPath);
    if (before === null) return null;
    const heading = editor.state.doc.nodeAt(before);
    if (!heading || heading.type.name !== HEADING_NODE_TYPE) return null;
    const after = before + heading.nodeSize;
    // Anchor inside the heading's text (a valid text position) so `insertMedia`
    // inserts after the heading block; an empty heading falls back to the block
    // boundary. The heading itself is never replaced (a section/hero keeps its
    // title).
    const inside = after - 1;
    if (heading.content.size > 0 && inside > before) return inside;
    return after <= size ? after : null;
  }
  const before = positionBeforePath(editor.state.doc, target.path);
  if (before === null) return null;
  const node = editor.state.doc.nodeAt(before);
  if (!node || node.type.name === 'image') return null;
  const inside = before + 1;
  return inside <= size ? inside : null;
}

/**
 * Applies an `insert_image` operation as one editor transaction. Reuses the
 * existing `insertMedia` command, so the image lands on a valid block boundary
 * and `undo` removes it cleanly. Returns a typed failure instead of mutating on
 * an unresolvable target or a non-library candidate.
 */
export function applyImageInsertionOperation(
  editor: Editor | null,
  operation: InsertImageOperation,
): ImageInsertionApplyResult {
  if (!editor || editor.isDestroyed) return { ok: false, reason: 'no-editor' };
  const assetId = operation.image.assetId;
  if (!assetId) return { ok: false, reason: 'missing-asset' };
  const range = resolveImageInsertionRange(editor, operation.target);
  if (range === null) return { ok: false, reason: 'unresolved-target' };
  try {
    const applied = editor
      .chain()
      .focus()
      .setTextSelection(range)
      .insertMedia({
        mediaId: assetId,
        src: operation.image.url,
        ...(operation.image.alt ? { alt: operation.image.alt } : {}),
        ...(operation.image.caption ? { caption: operation.image.caption } : {}),
      })
      .run();
    return applied ? { ok: true } : { ok: false, reason: 'apply-failed' };
  } catch {
    return { ok: false, reason: 'apply-failed' };
  }
}
