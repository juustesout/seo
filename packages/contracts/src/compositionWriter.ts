/**
 * Composition Writer contract (Stage 8B).
 *
 * The Writer stage fills the content slots a `CompositionPlan` declared. It is
 * deliberately split in two halves so the AI boundary can only ever propose
 * copy, never structure:
 *
 *   1. the model returns opaque slot fills (`{ slot, text }` / `{ slot, items }`);
 *   2. `applyCompositionSlotFills` - pure and deterministic - validates those
 *      fills against the compiled slot map and writes them into a *copy* of the
 *      compiled `CanonicalDocument`, then proves the structure is unchanged.
 *
 * The document skeleton (node ids, types, heading levels, order, nesting) comes
 * from `compileComposition`; only inline content (and `list` item children,
 * which the renderer requires) may be added. This module is pure types plus
 * pure transforms - no LLM, no providers, no persistence.
 */

import {
  type CompositionRequirementRole,
  type CompositionSlotRef,
  type CompiledComposition,
} from './compositionPlan.js';
import { isValidCanonicalDoc, type CanonicalBlock, type CanonicalDocument, type CanonicalInline } from './canonical.js';

/** Bounds (single source of truth for the AI boundary and this validator). */
export const COMPOSITION_SLOT_TEXT_MAX_CHARS = 2000;
export const COMPOSITION_SLOT_ITEM_MAX_CHARS = 300;
export const COMPOSITION_SLOT_MAX_ITEMS = 12;

/** Which value shape a writable slot expects. */
export type CompositionSlotKind = 'text' | 'items';

/**
 * One model-proposed slot fill. `text` is plain inline text for a text-bearing
 * slot; `items` are the plain-text entries of a `list` slot. Exactly one of the
 * two must be present, matching the slot kind. Never markdown, HTML or JSON.
 */
export interface CompositionSlotFill {
  slot: string;
  text?: string;
  items?: string[];
}

export interface CompositionFillResult {
  document: CanonicalDocument;
  /** Slots the fills actually supplied, in plan (document) order. */
  filled: string[];
  /** Writable slots left empty (e.g. media/measured values are not writable). */
  unfilled: string[];
}

export type CompositionFillErrorCode =
  | 'invalid_fill'
  | 'unknown_slot'
  | 'duplicate_slot'
  | 'wrong_shape'
  | 'structure_changed'
  | 'invalid_document';

/** Raised when fills cannot be applied without breaking a contract. */
export class CompositionFillError extends Error {
  readonly code: CompositionFillErrorCode;

  constructor(code: CompositionFillErrorCode, message: string) {
    super(message);
    this.name = 'CompositionFillError';
    this.code = code;
  }
}

const WRITABLE_SLOT_TYPES: ReadonlySet<string> = new Set([
  'heading',
  'paragraph',
  'quote',
  'code',
  'list',
  'badge',
  'button',
  'statItem',
]);
const NON_WRITABLE_ROLES: ReadonlySet<CompositionRequirementRole> = new Set(['media', 'value', 'attribution']);

/**
 * The value kind a slot expects, or null when the slot is not writable.
 *
 * Media slots need a real asset, measured `value` slots and `attribution`
 * slots need real evidence - the Writer must never invent a metric, a source
 * or a person. Those stay empty until real data exists, so the preview is
 * honest rather than plausible.
 */
export function compositionSlotKindOf(ref: Pick<CompositionSlotRef, 'type' | 'role'>): CompositionSlotKind | null {
  if (ref.type === 'image') return null;
  if (ref.role !== undefined && NON_WRITABLE_ROLES.has(ref.role)) return null;
  if (!WRITABLE_SLOT_TYPES.has(ref.type)) return null;
  return ref.type === 'list' ? 'items' : 'text';
}

/** True when the Writer is allowed to fill this slot. */
export function isWritableCompositionSlot(ref: Pick<CompositionSlotRef, 'type' | 'role'>): boolean {
  return compositionSlotKindOf(ref) !== null;
}

function isNonEmptyText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/**
 * Semantic validation of model-proposed fills against the compiled slot map:
 * only writable slots, each at most once, the value shape matching the slot
 * kind, within bounds, and every writable slot covered. Returns a list of
 * human-readable issues (empty means valid) so the AI boundary can retry with
 * actionable feedback instead of silently dropping content.
 */
export function validateCompositionSlotFills(
  slots: readonly CompositionSlotRef[],
  fills: readonly CompositionSlotFill[],
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const bySlot = new Map<string, CompositionSlotRef>();
  for (const ref of slots) bySlot.set(ref.slot, ref);

  const seen = new Set<string>();
  for (const fill of fills) {
    if (typeof fill?.slot !== 'string') {
      issues.push('a fill is missing its "slot" string');
      continue;
    }
    const ref = bySlot.get(fill.slot);
    if (!ref) {
      issues.push(`unknown slot "${fill.slot}" (not in the plan)`);
      continue;
    }
    if (seen.has(fill.slot)) {
      issues.push(`duplicate slot "${fill.slot}"`);
      continue;
    }
    seen.add(fill.slot);

    const kind = compositionSlotKindOf(ref);
    if (kind === null) {
      issues.push(`slot "${fill.slot}" is not writable (${ref.type}${ref.role ? `/${ref.role}` : ''})`);
      continue;
    }
    if (kind === 'text') {
      if (!isNonEmptyText(fill.text, COMPOSITION_SLOT_TEXT_MAX_CHARS)) {
        issues.push(`slot "${fill.slot}" needs a non-empty "text" (<= ${COMPOSITION_SLOT_TEXT_MAX_CHARS} chars)`);
      }
      if (fill.items !== undefined) issues.push(`slot "${fill.slot}" is a text slot and must not carry "items"`);
    } else {
      if (!Array.isArray(fill.items) || fill.items.length === 0) {
        issues.push(`slot "${fill.slot}" needs a non-empty "items" array`);
      } else if (fill.items.length > COMPOSITION_SLOT_MAX_ITEMS) {
        issues.push(`slot "${fill.slot}" allows at most ${COMPOSITION_SLOT_MAX_ITEMS} items`);
      } else if (!fill.items.every((item) => isNonEmptyText(item, COMPOSITION_SLOT_ITEM_MAX_CHARS))) {
        issues.push(`every item of "${fill.slot}" must be non-empty (<= ${COMPOSITION_SLOT_ITEM_MAX_CHARS} chars)`);
      }
      if (fill.text !== undefined) issues.push(`slot "${fill.slot}" is an items slot and must not carry "text"`);
    }
  }

  for (const ref of slots) {
    if (isWritableCompositionSlot(ref) && !seen.has(ref.slot)) {
      issues.push(`missing fill for slot "${ref.slot}"`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function inlineText(value: string): CanonicalInline[] {
  return [{ type: 'text', text: value }];
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

function applyFill(block: CanonicalBlock, ref: CompositionSlotRef, fill: CompositionSlotFill): void {
  const kind = compositionSlotKindOf(ref);
  if (kind === 'items') {
    block.children = (fill.items ?? []).map((item) => ({ type: 'listItem', content: inlineText(item) }));
    return;
  }
  block.content = inlineText(fill.text ?? '');
}

// ---------------------------------------------------------------------------
// Structure preservation
// ---------------------------------------------------------------------------

/**
 * Canonical, order-independent signature of a document's *structure*: node id,
 * type, attributes (minus content-only attributes) and child structure. Inline
 * `content` is deliberately excluded, and a `list` ignores its item children
 * because list items are content, not structure. Two documents with the same
 * signature differ only in copy.
 */
function structureSignature(block: CanonicalBlock): unknown {
  const attrs = block.attrs ?? {};
  const attrsSorted: Record<string, unknown> = {};
  for (const key of Object.keys(attrs).sort()) {
    if (key === 'value') continue;
    attrsSorted[key] = attrs[key];
  }
  const children = block.type === 'list' ? [] : (block.children ?? []).map(structureSignature);
  return { id: block.id ?? null, type: block.type, attrs: attrsSorted, children };
}

/** Deterministic structural signature; exported for diagnostics and tests. */
export function compositionStructureSignature(document: CanonicalDocument): string {
  return JSON.stringify(document.blocks.map(structureSignature));
}

/** True when `filled` has exactly `skeleton`'s structure (only copy changed). */
export function isCanonicalStructurePreserved(skeleton: CanonicalDocument, filled: CanonicalDocument): boolean {
  return compositionStructureSignature(skeleton) === compositionStructureSignature(filled);
}

// ---------------------------------------------------------------------------
// Deterministic fill application
// ---------------------------------------------------------------------------

function cloneDocument(document: CanonicalDocument): CanonicalDocument {
  return JSON.parse(JSON.stringify(document)) as CanonicalDocument;
}

/**
 * Applies validated slot fills to a copy of the compiled document. Pure: the
 * input `CompiledComposition` is never mutated. Throws `CompositionFillError`
 * when a fill is unknown/duplicated/malformed (`invalid_fill`), when the result
 * is not a valid canonical document (`invalid_document`) or when the fill
 * changed the document structure (`structure_changed`). Callers therefore get
 * an honest failure instead of a silently restructured document.
 */
export function applyCompositionSlotFills(
  compiled: CompiledComposition,
  fills: readonly CompositionSlotFill[],
): CompositionFillResult {
  const validation = validateCompositionSlotFills(compiled.slots.slots, fills);
  if (!validation.ok) {
    throw new CompositionFillError('invalid_fill', validation.issues.join('; '));
  }

  const document = cloneDocument(compiled.document);
  const bySlot = new Map(fills.map((fill) => [fill.slot, fill]));
  const filled: string[] = [];
  const unfilled: string[] = [];

  for (const ref of compiled.slots.slots) {
    if (!isWritableCompositionSlot(ref)) continue;
    const fill = bySlot.get(ref.slot);
    if (!fill) {
      unfilled.push(ref.slot);
      continue;
    }
    const block = blockAtPath(document, ref.path);
    if (!block) {
      throw new CompositionFillError('unknown_slot', `Slot "${ref.slot}" no longer resolves in the document.`);
    }
    applyFill(block, ref, fill);
    filled.push(ref.slot);
  }

  if (!isValidCanonicalDoc(document)) {
    throw new CompositionFillError('invalid_document', 'Filled document is not a valid canonical document.');
  }
  if (!isCanonicalStructurePreserved(compiled.document, document)) {
    throw new CompositionFillError('structure_changed', 'Filling changed the document structure.');
  }
  return { document, filled, unfilled };
}
