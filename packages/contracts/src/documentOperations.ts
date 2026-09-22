/**
 * Document Operation Batch v1.
 *
 * A small, ordered set of structural edits that transform an existing
 * CanonicalDocument into a new one, without ever writing to storage. It is the
 * structural counterpart to the R3.1 `insert_image` operation: where that one
 * places a single image relative to a live editor selection, a batch can create
 * a container (a hero or a section) and then target the newly created structure
 * from later operations.
 *
 * Design boundaries (deliberate):
 *   - Operations carry an operation-local `ref`, never a canonical block `id`.
 *     A `ref` is erased from the resulting document; no persistent identity is
 *     synthesized here. The editor bridge still derives its own ephemeral ids.
 *   - References are strictly backward: an operation may only target a `ref`
 *     created by an earlier operation in the same batch.
 *   - The executor is pure and deterministic: it deep-copies its base, executes
 *     the whole batch in order against the copy, and returns a fresh document.
 *     It throws instead of returning a partial result, so apply is atomic.
 *   - The final document is validated for editor representability so structure
 *     the editor would silently drop (an empty container, an unfilled image) is
 *     refused rather than lost.
 *
 * This module is pure types, validation and a deterministic executor - no LLM,
 * no providers, no persistence, no jobs.
 */

import {
  CANONICAL_BLOCK_VARIANTS,
  isValidCanonicalDoc,
  isValidCanonicalLayoutIntent,
  normalizeCanonicalLayoutIntent,
  type CanonicalBlock,
  type CanonicalDocument,
  type CanonicalLayoutIntent,
} from './canonical.js';
import {
  IMAGE_INSERTION_MAX_PATH_DEPTH,
  IMAGE_INSERTION_MAX_PATH_INDEX,
  IMAGE_INSERTION_RATIONALE_MAX_CHARS,
  IMAGE_INSERTION_REVISION_MAX_CHARS,
  isValidImageInsertionCandidate,
  type ImageInsertionCandidate,
} from './imageInsertion.js';
import { isValidVisualDesignIntent, type VisualDesignIntent } from './visualVocabulary.js';

export const DOCUMENT_OPERATIONS_VERSION = 1 as const;

/** Hard bounds so a hostile or hand-written batch stays cheap to validate. */
export const DOCUMENT_OPERATION_MAX_OPS = 32;
export const DOCUMENT_OPERATION_REF_MAX_CHARS = 64;
export const DOCUMENT_OPERATION_TEXT_MAX_CHARS = 500;

/** Containers this milestone can create. A subset of the canonical vocabulary. */
export const DOCUMENT_OPERATION_SECTION_KINDS = ['hero', 'section'] as const;
export type DocumentOperationSectionKind = (typeof DOCUMENT_OPERATION_SECTION_KINDS)[number];

/**
 * A reference to a container created earlier in the same batch. The string is
 * operation-local: it is unique within the batch, is not a canonical block id,
 * and never appears in the resulting document.
 */
export interface DocumentOperationRefTarget {
  mode: 'ref';
  ref: string;
  /** Insert as the container's first/last child; defaults to `end`. */
  at?: 'start' | 'end';
}

/** A reference to an existing block by its structural index path. */
export interface DocumentOperationBlockTarget {
  mode: 'block';
  path: number[];
}

export type DocumentOperationInsertTarget = DocumentOperationRefTarget | DocumentOperationBlockTarget;

/** Where a newly created section is spliced into the document. */
export type DocumentOperationSectionPosition =
  | { mode: 'document_start' }
  | { mode: 'document_end' }
  | { mode: 'before_block'; path: number[] }
  | { mode: 'after_block'; path: number[] };

export interface InsertSectionOperation {
  type: 'insert_section';
  /** Address later operations in this batch can target. */
  ref: string;
  section: {
    kind: DocumentOperationSectionKind;
    variant?: string;
    layout?: CanonicalLayoutIntent;
  };
  position: DocumentOperationSectionPosition;
}

export interface HeadingTextBlock {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

export interface ParagraphTextBlock {
  type: 'paragraph';
  text: string;
}

export type DocumentOperationTextBlock = HeadingTextBlock | ParagraphTextBlock;

export interface InsertTextOperation {
  type: 'insert_text';
  target: DocumentOperationInsertTarget;
  block: DocumentOperationTextBlock;
}

/**
 * Canonical-relative image placement. Distinct from the R3.1 `insert_image`
 * operation, whose target is a live editor selection; here the target is a
 * `ref`/`block` address in the canonical document.
 */
export interface InsertImageDocumentOperation {
  type: 'insert_image';
  target: DocumentOperationInsertTarget;
  image: ImageInsertionCandidate;
  visual?: VisualDesignIntent;
  rationale?: string;
}

export type DocumentOperation = InsertSectionOperation | InsertTextOperation | InsertImageDocumentOperation;

export interface DocumentOperationBatch {
  version: typeof DOCUMENT_OPERATIONS_VERSION;
  baseRevision: string;
  operations: DocumentOperation[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const BATCH_KEYS: ReadonlySet<string> = new Set(['version', 'baseRevision', 'operations']);
const SECTION_OP_KEYS: ReadonlySet<string> = new Set(['type', 'ref', 'section', 'position']);
const TEXT_OP_KEYS: ReadonlySet<string> = new Set(['type', 'target', 'block']);
const IMAGE_OP_KEYS: ReadonlySet<string> = new Set(['type', 'target', 'image', 'visual', 'rationale']);
const SECTION_SPEC_KEYS: ReadonlySet<string> = new Set(['kind', 'variant', 'layout']);
const REF_TARGET_KEYS: ReadonlySet<string> = new Set(['mode', 'ref', 'at']);
const BLOCK_TARGET_KEYS: ReadonlySet<string> = new Set(['mode', 'path']);
const POSITION_KEYS: ReadonlySet<string> = new Set(['mode', 'path']);
const PARAGRAPH_BLOCK_KEYS: ReadonlySet<string> = new Set(['type', 'text']);
const HEADING_BLOCK_KEYS: ReadonlySet<string> = new Set(['type', 'level', 'text']);

const SECTION_KIND_SET: ReadonlySet<string> = new Set(DOCUMENT_OPERATION_SECTION_KINDS);
const REF_RE = /^[a-zA-Z][A-Za-z0-9_-]*$/;

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

function isRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= DOCUMENT_OPERATION_REF_MAX_CHARS && REF_RE.test(value);
}

function isPath(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > IMAGE_INSERTION_MAX_PATH_DEPTH) return false;
  return value.every(
    (entry) =>
      typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry <= IMAGE_INSERTION_MAX_PATH_INDEX,
  );
}

function isValidInsertTarget(value: unknown): value is DocumentOperationInsertTarget {
  if (!isPlainObject(value)) return false;
  if (value.mode === 'ref') {
    if (!hasOnlyKeys(value, REF_TARGET_KEYS)) return false;
    if (value.at !== undefined && value.at !== 'start' && value.at !== 'end') return false;
    return isRef(value.ref);
  }
  if (value.mode === 'block') {
    return hasOnlyKeys(value, BLOCK_TARGET_KEYS) && isPath(value.path);
  }
  return false;
}

function isValidSectionPosition(value: unknown): value is DocumentOperationSectionPosition {
  if (!isPlainObject(value)) return false;
  if (value.mode === 'document_start' || value.mode === 'document_end') {
    return hasOnlyKeys(value, new Set(['mode']));
  }
  if (value.mode === 'before_block' || value.mode === 'after_block') {
    return hasOnlyKeys(value, POSITION_KEYS) && isPath(value.path);
  }
  return false;
}

function isValidSectionSpec(value: unknown): value is InsertSectionOperation['section'] {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, SECTION_SPEC_KEYS)) return false;
  if (typeof value.kind !== 'string' || !SECTION_KIND_SET.has(value.kind)) return false;
  if (value.variant !== undefined) {
    const allowed = (CANONICAL_BLOCK_VARIANTS as Record<string, readonly string[]>)[value.kind];
    if (!allowed || typeof value.variant !== 'string' || !allowed.includes(value.variant)) return false;
  }
  if (value.layout !== undefined && !isValidCanonicalLayoutIntent(value.layout)) return false;
  return true;
}

function isValidTextBlock(value: unknown): value is DocumentOperationTextBlock {
  if (!isPlainObject(value)) return false;
  if (value.type === 'paragraph') {
    return hasOnlyKeys(value, PARAGRAPH_BLOCK_KEYS) && isBoundedText(value.text, DOCUMENT_OPERATION_TEXT_MAX_CHARS);
  }
  if (value.type === 'heading') {
    if (!hasOnlyKeys(value, HEADING_BLOCK_KEYS)) return false;
    if (typeof value.level !== 'number' || !Number.isInteger(value.level) || value.level < 1 || value.level > 6) {
      return false;
    }
    return isBoundedText(value.text, DOCUMENT_OPERATION_TEXT_MAX_CHARS);
  }
  return false;
}

/**
 * Validates one operation. `refs` is the set of refs created by earlier
 * operations in the same batch; a `ref` target must be a member (forward
 * references are rejected) and an `insert_section` ref must be new.
 */
function isValidDocumentOperation(value: unknown, refs: Set<string>): value is DocumentOperation {
  if (!isPlainObject(value)) return false;
  switch (value.type) {
    case 'insert_section': {
      if (!hasOnlyKeys(value, SECTION_OP_KEYS)) return false;
      if (!isRef(value.ref) || refs.has(value.ref)) return false;
      if (!isValidSectionSpec(value.section)) return false;
      if (!isValidSectionPosition(value.position)) return false;
      refs.add(value.ref);
      return true;
    }
    case 'insert_text': {
      if (!hasOnlyKeys(value, TEXT_OP_KEYS)) return false;
      if (!isValidInsertTarget(value.target)) return false;
      if (value.target.mode === 'ref' && !refs.has(value.target.ref)) return false;
      return isValidTextBlock(value.block);
    }
    case 'insert_image': {
      if (!hasOnlyKeys(value, IMAGE_OP_KEYS)) return false;
      if (!isValidInsertTarget(value.target)) return false;
      if (value.target.mode === 'ref' && !refs.has(value.target.ref)) return false;
      if (!isValidImageInsertionCandidate(value.image) || typeof value.image.assetId !== 'string') return false;
      if (value.visual !== undefined && !isValidVisualDesignIntent(value.visual)) return false;
      if (value.rationale !== undefined && !isBoundedText(value.rationale, IMAGE_INSERTION_RATIONALE_MAX_CHARS)) {
        return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/**
 * Strict, whole-batch validation. Verifies shapes, bounds, ref uniqueness and
 * that every reference points backwards. Does not mutate its input.
 */
export function isValidDocumentOperationBatch(value: unknown): value is DocumentOperationBatch {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, BATCH_KEYS)) return false;
  if (value.version !== DOCUMENT_OPERATIONS_VERSION) return false;
  if (!isBoundedText(value.baseRevision, IMAGE_INSERTION_REVISION_MAX_CHARS)) return false;
  if (!Array.isArray(value.operations)) return false;
  if (value.operations.length === 0 || value.operations.length > DOCUMENT_OPERATION_MAX_OPS) return false;

  const refs = new Set<string>();
  for (const operation of value.operations) {
    if (!isValidDocumentOperation(operation, refs)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export type DocumentOperationErrorCode =
  | 'invalid_batch'
  | 'unresolved_ref'
  | 'unresolved_path'
  | 'result_incomplete'
  | 'result_invalid';

/** Raised when a batch cannot be executed. No partial document is ever returned. */
export class DocumentOperationError extends Error {
  readonly code: DocumentOperationErrorCode;
  /** Index of the operation that failed, when the failure is operation-specific. */
  readonly index?: number;

  constructor(code: DocumentOperationErrorCode, message: string, index?: number) {
    super(message);
    this.name = 'DocumentOperationError';
    this.code = code;
    if (index !== undefined) this.index = index;
  }

  static message(code: DocumentOperationErrorCode, index?: number): string {
    switch (code) {
      case 'invalid_batch':
        return 'The document operation batch is not valid.';
      case 'unresolved_ref':
        return `Operation ${index} targets a reference that does not exist.`;
      case 'unresolved_path':
        return `Operation ${index} targets a path that is not in the document.`;
      case 'result_incomplete':
        return `Operation ${index} left a container with no content.`;
      case 'result_invalid':
        return 'The document operation batch produced an invalid document.';
    }
  }
}

function cloneDocument(document: CanonicalDocument): CanonicalDocument {
  return JSON.parse(JSON.stringify(document)) as CanonicalDocument;
}

/**
 * Locates the array that contains the node at `path` and the node's index in it,
 * so a sibling can be inserted before/after it. Null when the path does not
 * resolve to an existing block. Never mutates.
 */
function findParentArray(
  root: CanonicalBlock[],
  path: readonly number[],
): { array: CanonicalBlock[]; index: number } | null {
  if (path.length === 0) return null;
  let array = root;
  for (let depth = 0; depth < path.length - 1; depth += 1) {
    const segment = path[depth];
    if (segment === undefined) return null;
    const node = array[segment];
    if (!node || !Array.isArray(node.children)) return null;
    array = node.children;
  }
  const index = path[path.length - 1];
  if (index === undefined) return null;
  if (!Number.isInteger(index) || index < 0 || index >= array.length) return null;
  return { array, index };
}

function sectionAttrs(section: InsertSectionOperation['section']): Record<string, unknown> | undefined {
  const attrs: Record<string, unknown> = {};
  if (section.variant !== undefined) attrs.variant = section.variant;
  const layout = normalizeCanonicalLayoutIntent(section.layout);
  if (layout !== undefined) attrs.layout = layout;
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

function textBlockOf(block: DocumentOperationTextBlock): CanonicalBlock {
  if (block.type === 'heading') {
    return { type: 'heading', attrs: { level: block.level }, content: [{ type: 'text', text: block.text }] };
  }
  return { type: 'paragraph', content: [{ type: 'text', text: block.text }] };
}

function imageBlockOf(operation: InsertImageDocumentOperation): CanonicalBlock {
  const image = operation.image;
  const attrs: Record<string, unknown> = { mediaId: image.assetId, src: image.url, alt: image.alt };
  if (image.caption !== undefined) attrs.caption = image.caption;
  if (image.width !== undefined) attrs.width = image.width;
  if (image.height !== undefined) attrs.height = image.height;
  return { type: 'image', attrs };
}

/**
 * Executes a whole operation batch against a copy of `base` and returns the new
 * document. Pure: `base` is never mutated and no partial result is returned.
 * Throws {@link DocumentOperationError} on an invalid batch, an unresolved
 * reference/path, or a result the editor could not represent.
 */
export function applyDocumentOperations(base: CanonicalDocument, batch: DocumentOperationBatch): CanonicalDocument {
  if (!isValidDocumentOperationBatch(batch)) {
    throw new DocumentOperationError('invalid_batch', DocumentOperationError.message('invalid_batch'));
  }

  const document = cloneDocument(base);
  const refs = new Map<string, CanonicalBlock>();
  const createdContainers: Array<{ index: number; block: CanonicalBlock }> = [];

  batch.operations.forEach((operation, index) => {
    if (operation.type === 'insert_section') {
      const block: CanonicalBlock = { type: operation.section.kind };
      const attrs = sectionAttrs(operation.section);
      if (attrs) block.attrs = attrs;

      const position = operation.position;
      if (position.mode === 'document_start') {
        document.blocks.unshift(block);
      } else if (position.mode === 'document_end') {
        document.blocks.push(block);
      } else {
        const found = findParentArray(document.blocks, position.path);
        if (!found) throw new DocumentOperationError('unresolved_path', DocumentOperationError.message('unresolved_path', index), index);
        found.array.splice(position.mode === 'before_block' ? found.index : found.index + 1, 0, block);
      }

      refs.set(operation.ref, block);
      createdContainers.push({ index, block });
      return;
    }

    if (operation.type === 'insert_text') {
      const block = textBlockOf(operation.block);
      insertBlockAtTarget(document.blocks, refs, operation.target, block, index);
      return;
    }

    insertBlockAtTarget(document.blocks, refs, operation.target, imageBlockOf(operation), index);
  });

  for (const entry of createdContainers) {
    if (!entry.block.children || entry.block.children.length === 0) {
      throw new DocumentOperationError(
        'result_incomplete',
        DocumentOperationError.message('result_incomplete', entry.index),
        entry.index,
      );
    }
  }

  if (!isValidCanonicalDoc(document)) {
    throw new DocumentOperationError('result_invalid', DocumentOperationError.message('result_invalid'));
  }
  return document;
}

/** Inserts a block into a ref container or after a block path. Shared by text/image ops. */
function insertBlockAtTarget(
  root: CanonicalBlock[],
  refs: Map<string, CanonicalBlock>,
  target: DocumentOperationInsertTarget,
  block: CanonicalBlock,
  index: number,
): void {
  if (target.mode === 'ref') {
    const container = refs.get(target.ref);
    if (!container) throw new DocumentOperationError('unresolved_ref', DocumentOperationError.message('unresolved_ref', index), index);
    const children = container.children;
    if (!children) {
      container.children = [block];
      return;
    }
    if (target.at === 'start') children.unshift(block);
    else children.push(block);
    return;
  }

  const found = findParentArray(root, target.path);
  if (!found) throw new DocumentOperationError('unresolved_path', DocumentOperationError.message('unresolved_path', index), index);
  found.array.splice(found.index + 1, 0, block);
}
