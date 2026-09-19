/**
 * Designer bounded revision contract (Stage 8E.6, Phase 3.2).
 *
 * The Phase 2 executor can fill the slots a Composer declared, but it has no
 * path to edit an *existing* document: `composer.structure` always compiles a
 * fresh skeleton and `writer.fillSlots` only resolves compiled slot addresses.
 * `writer.revise` closes that gap with a bounded, structure-preserving edit:
 *
 *   1. a `DesignerRevisionTarget` names a server-side scope (`document`,
 *      `introduction`, `section`, `block`) - never a DOM selector or a free
 *      tool call;
 *   2. `resolveDesignerRevisionTargets` turns that scope into concrete writable
 *      block references, each addressed by its canonical block id (or a
 *      deterministic positional `#a.b` ref when the block has no id), so a model
 *      can only ever reference blocks the server handed it;
 *   3. `applyDesignerRevision` - pure and deterministic - validates the model's
 *      fills against that reference set, writes them into a *copy* of the
 *      document and proves the canonical structure is unchanged.
 *
 * The model never sees or returns structure, ids or block types. It only returns
 * copy for references the resolver produced. This module is pure types plus pure
 * transforms - no AI, no providers, no persistence.
 */

import { isValidCanonicalDoc, type CanonicalBlock, type CanonicalDocument, type CanonicalInline } from './canonical.js';
import { isCanonicalStructurePreserved } from './compositionWriter.js';

// ---------------------------------------------------------------------------
// Bounds (single source of truth for the contract and its validator)
// ---------------------------------------------------------------------------

export const DESIGNER_REVISION_INSTRUCTION_MAX_CHARS = 2000;
export const DESIGNER_REVISION_TEXT_MAX_CHARS = 2000;
export const DESIGNER_REVISION_ITEM_MAX_CHARS = 300;
export const DESIGNER_REVISION_MAX_ITEMS = 12;
export const DESIGNER_REVISION_MAX_TARGETS = 200;
export const DESIGNER_REVISION_REF_MAX_CHARS = 120;

/**
 * Block types a revision may rewrite. Mirrors the writable composition slot
 * vocabulary: media, measured values and attributions are never revision
 * targets because the model must not invent an asset, metric or source.
 */
export const DESIGNER_REVISION_WRITABLE_TYPES = [
  'heading',
  'paragraph',
  'quote',
  'code',
  'list',
  'badge',
  'button',
  'statItem',
] as const;

/** Bounded scopes a revision target may name. */
export const DESIGNER_REVISION_TARGET_KINDS = ['document', 'introduction', 'section', 'block'] as const;
export type DesignerRevisionTargetKind = (typeof DESIGNER_REVISION_TARGET_KINDS)[number];

/**
 * Server-side edit scope. `section` and `block` require a `ref` the resolver
 * handed out (a canonical block id, or a positional `#a.b` fallback); the
 * document-wide scopes must not carry one.
 */
export interface DesignerRevisionTarget {
  kind: DesignerRevisionTargetKind;
  ref?: string;
}

/** One concrete writable block the resolver selected, with its current copy. */
export interface DesignerRevisionTargetRef {
  /** Canonical block id when present, else a positional `#a.b` reference. */
  ref: string;
  type: string;
  /** Index path from the document root; re-resolved, never a DOM selector. */
  path: number[];
  /** Current plain text, for text-bearing blocks. */
  text?: string;
  /** Current items, for `list` blocks. */
  items?: string[];
}

/**
 * One model-proposed revision. `ref` must be one of the resolved target refs;
 * `text` is plain inline copy and `items` are plain `list` entries. Exactly one
 * of the two is present and it must match the target block type.
 */
export interface DesignerRevisionFill {
  ref: string;
  text?: string;
  items?: string[];
}

export interface DesignerRevisionApplyResult {
  document: CanonicalDocument;
  /** Refs the fills actually rewrote, in fill order. */
  revised: string[];
}

export type DesignerRevisionErrorCode =
  | 'invalid_target'
  | 'unknown_target'
  | 'invalid_fill'
  | 'invalid_document'
  | 'structure_changed';

/** Raised when a revision cannot be resolved or applied without breaking a contract. */
export class DesignerRevisionError extends Error {
  readonly code: DesignerRevisionErrorCode;

  constructor(code: DesignerRevisionErrorCode, message: string) {
    super(message);
    this.name = 'DesignerRevisionError';
    this.code = code;
  }
}

const REVISION_REF_RE = /^(?:[A-Za-z0-9][A-Za-z0-9_-]*|#[0-9]+(?:\.[0-9]+)*)$/;
const TARGET_KIND_SET: ReadonlySet<string> = new Set(DESIGNER_REVISION_TARGET_KINDS);
const WRITABLE_TYPE_SET: ReadonlySet<string> = new Set(DESIGNER_REVISION_WRITABLE_TYPES);
const TARGET_KEYS: ReadonlySet<string> = new Set(['kind', 'ref']);
const FILL_KEYS: ReadonlySet<string> = new Set(['ref', 'text', 'items']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** True when `value` is a bounded revision reference token. */
export function isValidDesignerRevisionRef(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= DESIGNER_REVISION_REF_MAX_CHARS && REVISION_REF_RE.test(value)
  );
}

/** Validates a revision target: a known scope plus a ref exactly when required. */
export function isValidDesignerRevisionTarget(value: unknown): value is DesignerRevisionTarget {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, TARGET_KEYS)) return false;
  if (typeof value.kind !== 'string' || !TARGET_KIND_SET.has(value.kind)) return false;
  const requiresRef = value.kind === 'section' || value.kind === 'block';
  if (requiresRef) return isValidDesignerRevisionRef(value.ref);
  return value.ref === undefined;
}

/** True when `block` is a block type a revision may rewrite. */
export function isWritableDesignerRevisionBlock(block: CanonicalBlock): boolean {
  return WRITABLE_TYPE_SET.has(block.type);
}

/** Canonical block id when present, else a deterministic positional reference. */
export function designerRevisionRefOf(block: CanonicalBlock, path: readonly number[]): string {
  return block.id !== undefined ? block.id : `#${path.join('.')}`;
}

function inlinePlainText(content: readonly CanonicalInline[] | undefined): string {
  if (!content) return '';
  return content
    .map((inline) => (inline.type === 'text' ? inline.text : ''))
    .join('')
    .trim();
}

function blockPlainText(block: CanonicalBlock): string {
  return inlinePlainText(block.content);
}

interface WritableWalkEntry {
  block: CanonicalBlock;
  path: number[];
}

function collectWritable(blocks: readonly CanonicalBlock[], basePath: number[], out: WritableWalkEntry[]): void {
  blocks.forEach((block, index) => {
    const path = [...basePath, index];
    if (isWritableDesignerRevisionBlock(block)) out.push({ block, path });
    if (block.children && block.children.length > 0) collectWritable(block.children, path, out);
  });
}

function toTargetRef(entry: WritableWalkEntry): DesignerRevisionTargetRef {
  const { block, path } = entry;
  const ref: DesignerRevisionTargetRef = { ref: designerRevisionRefOf(block, path), type: block.type, path };
  if (block.type === 'list') {
    const items = (block.children ?? [])
      .map((child) => inlinePlainText(child.content))
      .filter((item) => item.length > 0);
    if (items.length > 0) ref.items = items;
  } else {
    const text = blockPlainText(block);
    if (text.length > 0) ref.text = text;
  }
  return ref;
}

function collectWritableRefs(blocks: readonly CanonicalBlock[], basePath: number[]): DesignerRevisionTargetRef[] {
  const entries: WritableWalkEntry[] = [];
  collectWritable(blocks, basePath, entries);
  return entries.map(toTargetRef);
}

/** Writable refs for one block and its whole subtree (the block itself included). */
function collectSubtreeWritableRefs(block: CanonicalBlock, path: number[]): DesignerRevisionTargetRef[] {
  const entries: WritableWalkEntry[] = [];
  if (isWritableDesignerRevisionBlock(block)) entries.push({ block, path });
  if (block.children && block.children.length > 0) collectWritable(block.children, path, entries);
  return entries.map(toTargetRef);
}

interface FoundBlock {
  block: CanonicalBlock;
  path: number[];
}

function findBlockByRef(blocks: readonly CanonicalBlock[], basePath: number[], ref: string): FoundBlock | null {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    const path = [...basePath, index];
    if (designerRevisionRefOf(block, path) === ref) return { block, path };
    if (block.children && block.children.length > 0) {
      const nested = findBlockByRef(block.children, path, ref);
      if (nested) return nested;
    }
  }
  return null;
}

function assertUniqueRefs(refs: readonly DesignerRevisionTargetRef[]): void {
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref.ref)) {
      throw new DesignerRevisionError('invalid_target', `Revision reference "${ref.ref}" is ambiguous in this document.`);
    }
    seen.add(ref.ref);
  }
}

/**
 * Resolves a revision target to the concrete writable blocks it covers:
 *   - `document` covers every writable block;
 *   - `introduction` covers the first top-level block and its subtree (falling
 *     back to the first writable block when that yields none);
 *   - `section` covers the subtree of the block named by `ref`;
 *   - `block` covers exactly the writable block named by `ref`.
 * Throws `DesignerRevisionError` for a malformed target, an unknown ref or an
 * ambiguous (duplicate) reference.
 */
export function resolveDesignerRevisionTargets(
  document: CanonicalDocument,
  target: unknown,
): DesignerRevisionTargetRef[] {
  if (!isValidDesignerRevisionTarget(target)) {
    throw new DesignerRevisionError('invalid_target', 'The revision target is not valid.');
  }

  let refs: DesignerRevisionTargetRef[];
  switch (target.kind) {
    case 'document':
      refs = collectWritableRefs(document.blocks, []);
      break;
    case 'introduction': {
      const first = document.blocks[0];
      const leading = first ? collectSubtreeWritableRefs(first, [0]) : [];
      refs = leading.length > 0 ? leading : collectWritableRefs(document.blocks, []).slice(0, 1);
      break;
    }
    case 'section': {
      const found = findBlockByRef(document.blocks, [], target.ref as string);
      if (!found) {
        throw new DesignerRevisionError('unknown_target', `No block matches the revision reference "${target.ref}".`);
      }
      refs = collectSubtreeWritableRefs(found.block, found.path);
      break;
    }
    case 'block': {
      const found = findBlockByRef(document.blocks, [], target.ref as string);
      if (!found || !isWritableDesignerRevisionBlock(found.block)) {
        throw new DesignerRevisionError('unknown_target', `No writable block matches the revision reference "${target.ref}".`);
      }
      refs = [toTargetRef({ block: found.block, path: found.path })];
      break;
    }
    default:
      throw new DesignerRevisionError('invalid_target', 'The revision target is not valid.');
  }

  assertUniqueRefs(refs);
  return refs;
}

/**
 * Semantic validation of model-proposed revisions against the resolved target
 * set: every fill references a resolved target, at most once, the value shape
 * matching the block type and within bounds. Returns human-readable issues
 * (empty means valid) so an AI boundary can retry with actionable feedback.
 */
export function validateDesignerRevisionFills(
  targets: readonly DesignerRevisionTargetRef[],
  fills: readonly DesignerRevisionFill[],
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const byRef = new Map<string, DesignerRevisionTargetRef>();
  for (const target of targets) {
    if (!isValidDesignerRevisionRef(target.ref)) {
      issues.push(`target reference "${target.ref}" is not usable`);
      continue;
    }
    if (byRef.has(target.ref)) {
      issues.push(`target reference "${target.ref}" is ambiguous`);
      continue;
    }
    byRef.set(target.ref, target);
  }

  const seen = new Set<string>();
  for (const fill of fills) {
    if (!isPlainObject(fill) || !hasOnlyKeys(fill, FILL_KEYS)) {
      issues.push('a revision must be an object with "ref" and exactly one value');
      continue;
    }
    if (!isValidDesignerRevisionRef(fill.ref)) {
      issues.push('a revision carries an invalid reference');
      continue;
    }
    const target = byRef.get(fill.ref);
    if (!target) {
      issues.push(`unknown target reference "${fill.ref}"`);
      continue;
    }
    if (seen.has(fill.ref)) {
      issues.push(`duplicate revision for "${fill.ref}"`);
      continue;
    }
    seen.add(fill.ref);

    if (target.type === 'list') {
      if (!Array.isArray(fill.items) || fill.items.length === 0 || fill.items.length > DESIGNER_REVISION_MAX_ITEMS) {
        issues.push(`"${fill.ref}" is a list and needs 1..${DESIGNER_REVISION_MAX_ITEMS} items`);
      } else if (!fill.items.every((item) => isBoundedText(item, DESIGNER_REVISION_ITEM_MAX_CHARS))) {
        issues.push(`every item of "${fill.ref}" must be non-empty`);
      }
      if (fill.text !== undefined) issues.push(`"${fill.ref}" is a list and must not carry "text"`);
    } else {
      if (!isBoundedText(fill.text, DESIGNER_REVISION_TEXT_MAX_CHARS)) {
        issues.push(`"${fill.ref}" needs a non-empty "text" (<= ${DESIGNER_REVISION_TEXT_MAX_CHARS} chars)`);
      }
      if (fill.items !== undefined) issues.push(`"${fill.ref}" is a text block and must not carry "items"`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function cloneDocument(document: CanonicalDocument): CanonicalDocument {
  return JSON.parse(JSON.stringify(document)) as CanonicalDocument;
}

function blockAtPath(document: CanonicalDocument, path: readonly number[]): CanonicalBlock | undefined {
  let cursor: CanonicalBlock[] = document.blocks;
  let block: CanonicalBlock | undefined;
  for (const index of path) {
    block = cursor[index];
    if (!block) return undefined;
    cursor = block.children ?? [];
  }
  return block;
}

/**
 * Applies validated revision fills to a copy of `document`. Pure: the input is
 * never mutated. Each target is re-resolved by path and must still carry the
 * same ref and block type, so a target set resolved against a different
 * document can never silently edit the wrong block by position. Throws
 * `DesignerRevisionError` for an unknown/duplicate ref or malformed fill
 * (`invalid_fill`), when the result is not a valid canonical document
 * (`invalid_document`) or when a fill changed the structure
 * (`structure_changed`) - never a silently restructured document.
 */
export function applyDesignerRevision(
  document: CanonicalDocument,
  targets: readonly DesignerRevisionTargetRef[],
  fills: readonly DesignerRevisionFill[],
): DesignerRevisionApplyResult {
  if (targets.length > DESIGNER_REVISION_MAX_TARGETS) {
    throw new DesignerRevisionError('invalid_target', 'Too many revision targets for one step.');
  }
  const validation = validateDesignerRevisionFills(targets, fills);
  if (!validation.ok) {
    throw new DesignerRevisionError('invalid_fill', validation.issues.join('; '));
  }

  const byRef = new Map<string, DesignerRevisionTargetRef>();
  for (const target of targets) byRef.set(target.ref, target);

  const next = cloneDocument(document);
  for (const fill of fills) {
    const target = byRef.get(fill.ref) as DesignerRevisionTargetRef;
    const block = blockAtPath(next, target.path);
    if (!block || designerRevisionRefOf(block, target.path) !== target.ref || block.type !== target.type) {
      throw new DesignerRevisionError('unknown_target', `Revision reference "${fill.ref}" no longer resolves in the document.`);
    }
    if (target.type === 'list') {
      block.children = (fill.items ?? []).map((item) => ({ type: 'listItem', content: [{ type: 'text', text: item }] }));
    } else {
      block.content = [{ type: 'text', text: fill.text ?? '' }];
    }
  }

  if (!isValidCanonicalDoc(next)) {
    throw new DesignerRevisionError('invalid_document', 'The revised document is not a valid canonical document.');
  }
  if (!isCanonicalStructurePreserved(document, next)) {
    throw new DesignerRevisionError('structure_changed', 'The revision changed the document structure.');
  }
  return { document: next, revised: fills.map((fill) => fill.ref) };
}
