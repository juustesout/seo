/**
 * Visual Design domain contract (Stage 8E.6, ADR Phase 5.3).
 *
 * The Designer orchestrator coordinates specialized domains (layout, content,
 * visual). Visual reasoning - asset selection, image placement, visual
 * hierarchy and bounded presentation intent - is its own domain, not an
 * informal duty of the central orchestrator. This module is that domain's
 * proposal contract plus the pure, deterministic composition that folds a
 * validated visual proposal into a `CanonicalDocument`.
 *
 * Two hard rules shape it:
 *   1. A visual proposal references assets, never bytes. `select_asset` names a
 *      project media id; the resolved metadata (url/alt/caption/dimensions) is
 *      supplied at composition time by the media infrastructure, never embedded.
 *   2. A visual proposal only expresses operations the canonical model already
 *      supports. The current canonical model has exactly two relevant shapes:
 *      an `image` block's media reference (`mediaId`/`src`/`alt`/`caption`) and a
 *      bounded semantic `variant` on a composition block. There is no
 *      background, role or free-form style field, so none is invented here.
 *
 * Composition is pure and total: it clones the document, applies each operation
 * by a stable canonical block id, and fails with a typed `VisualDesignError`
 * (unknown target, unsupported target, unknown asset, unsupported variant,
 * duplicate operation, invalid document) rather than silently overwriting.
 * Nothing here persists, publishes or approves anything - the orchestrator owns
 * that, and human review remains the only path to `seo_content`.
 *
 * Dependency-free by convention: plain types plus hand-rolled `isValid...`
 * guards, no Zod, no runtime dependencies.
 */

import {
  CANONICAL_BLOCK_VARIANTS,
  isValidCanonicalDoc,
  type CanonicalBlock,
  type CanonicalDocument,
} from './canonical.js';

export const VISUAL_DESIGN_PROPOSAL_KIND = 'visual_design_proposal' as const;
export const VISUAL_DESIGN_PROPOSAL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Bounds (single source of truth for the contract and its validator)
// ---------------------------------------------------------------------------

export const VISUAL_DESIGN_MAX_OPERATIONS = 200;
export const VISUAL_DESIGN_MAX_RATIONALE = 50;
export const VISUAL_DESIGN_MAX_UNMATCHED = 100;
export const VISUAL_DESIGN_RATIONALE_MAX_CHARS = 300;
export const VISUAL_DESIGN_TARGET_MAX_CHARS = 128;
export const VISUAL_DESIGN_MEDIA_ID_MAX_CHARS = 128;
export const VISUAL_DESIGN_URL_MAX_CHARS = 4096;

/** Operation kinds the current canonical model can actually express. */
export const VISUAL_DESIGN_OPERATION_KINDS = ['select_asset', 'set_variant'] as const;
export type VisualDesignOperationKind = (typeof VISUAL_DESIGN_OPERATION_KINDS)[number];

/** Why no existing asset could be selected for a requested visual target. */
export const VISUAL_NO_SUITABLE_ASSET_REASONS = [
  'unknown_target',
  'unsupported_target',
  'no_candidates',
  'below_threshold',
  'all_conflicting',
] as const;
export type VisualNoSuitableAssetReason = (typeof VISUAL_NO_SUITABLE_ASSET_REASONS)[number];

/**
 * One visual target the selection could not fill, with the honest reason. It is
 * review provenance: `applyVisualDesignProposal` ignores it and it is never a
 * mutation instruction.
 */
export interface VisualNoSuitableAsset {
  targetBlockId: string;
  reason: VisualNoSuitableAssetReason;
}

/**
 * Assign an existing project media asset to one image block. `target` is the
 * canonical block id; `mediaId` is a project media-library id resolved by the
 * media service at composition time. The operation carries no url or bytes.
 */
export interface VisualSelectAssetOperation {
  op: 'select_asset';
  target: string;
  mediaId: string;
}

/**
 * Set a bounded semantic variant on one composition block (e.g. a `section`
 * `muted`/`inverted`, or a `mediaText` `image-left`). The variant must belong to
 * the block type's canonical variant vocabulary - never a colour, size or CSS.
 */
export interface VisualSetVariantOperation {
  op: 'set_variant';
  target: string;
  variant: string;
}

export type VisualDesignOperation = VisualSelectAssetOperation | VisualSetVariantOperation;

/**
 * A validated visual domain proposal. It is a proposal record, not persistence:
 * the orchestrator composes it into a document and the existing review/apply
 * flow remains the only approval path.
 */
export interface VisualDesignProposal {
  kind: typeof VISUAL_DESIGN_PROPOSAL_KIND;
  version: typeof VISUAL_DESIGN_PROPOSAL_VERSION;
  operations: VisualDesignOperation[];
  /** Optional bounded, human-readable reason per pool of operations. */
  rationale?: string[];
  /**
   * Targets the selection could not fill, with the honest reason. Provenance for
   * review only: composition ignores it and it is never applied.
   */
  unmatched?: VisualNoSuitableAsset[];
}

/**
 * Resolved metadata for one existing media asset, supplied by the media
 * infrastructure at composition time. It never carries bytes; the media
 * service owns uploads, storage and MIME validation.
 */
export interface VisualAssetRef {
  mediaId: string;
  url: string;
  alt?: string;
  caption?: string;
  width?: number;
  height?: number;
}

export interface VisualDesignCompositionResult {
  document: CanonicalDocument;
  /** Applied operation labels (`select_asset:<target>`) in input order. */
  applied: string[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type VisualDesignErrorCode =
  | 'invalid_visual_proposal'
  | 'unknown_target'
  | 'unsupported_target'
  | 'unknown_asset'
  | 'unsupported_variant'
  | 'duplicate_operation'
  | 'invalid_document';

/** Typed, deterministic rejection raised by visual validation/composition. */
export class VisualDesignError extends Error {
  readonly code: VisualDesignErrorCode;

  constructor(code: VisualDesignErrorCode, message: string) {
    super(message);
    this.name = 'VisualDesignError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PROPOSAL_KEYS: ReadonlySet<string> = new Set(['kind', 'version', 'operations', 'rationale', 'unmatched']);
const SELECT_ASSET_KEYS: ReadonlySet<string> = new Set(['op', 'target', 'mediaId']);
const SET_VARIANT_KEYS: ReadonlySet<string> = new Set(['op', 'target', 'variant']);
const ASSET_REF_KEYS: ReadonlySet<string> = new Set(['mediaId', 'url', 'alt', 'caption', 'width', 'height']);
const UNMATCHED_KEYS: ReadonlySet<string> = new Set(['targetBlockId', 'reason']);

const OPERATION_KIND_SET: ReadonlySet<string> = new Set(VISUAL_DESIGN_OPERATION_KINDS);
const UNMATCHED_REASON_SET: ReadonlySet<string> = new Set(VISUAL_NO_SUITABLE_ASSET_REASONS);
const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

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

function isValidTarget(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= VISUAL_DESIGN_TARGET_MAX_CHARS && TARGET_RE.test(value)
  );
}

function isOptionalBoundedText(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= max);
}

function isOptionalDimension(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0);
}

/** True when `value` is a bounded, well-formed resolved asset reference. */
export function isValidVisualAssetRef(value: unknown): value is VisualAssetRef {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, ASSET_REF_KEYS)) return false;
  if (!isValidTarget(value.mediaId)) return false;
  if (!isBoundedText(value.url, VISUAL_DESIGN_URL_MAX_CHARS)) return false;
  if (!isOptionalBoundedText(value.alt, VISUAL_DESIGN_RATIONALE_MAX_CHARS)) return false;
  if (!isOptionalBoundedText(value.caption, VISUAL_DESIGN_RATIONALE_MAX_CHARS)) return false;
  if (!isOptionalDimension(value.width)) return false;
  if (!isOptionalDimension(value.height)) return false;
  return true;
}

/**
 * Validates one visual operation: a known kind plus an exactly-shaped payload.
 * Unknown kinds and extra keys are rejected so an operation can never smuggle
 * arbitrary CSS, a provider call or an unvalidated target.
 */
export function isValidVisualDesignOperation(value: unknown): value is VisualDesignOperation {
  if (!isPlainObject(value)) return false;
  if (typeof value.op !== 'string' || !OPERATION_KIND_SET.has(value.op)) return false;

  switch (value.op as VisualDesignOperationKind) {
    case 'select_asset': {
      if (!hasOnlyKeys(value, SELECT_ASSET_KEYS)) return false;
      if (!isValidTarget(value.target)) return false;
      return (
        typeof value.mediaId === 'string' &&
        value.mediaId.length > 0 &&
        value.mediaId.length <= VISUAL_DESIGN_MEDIA_ID_MAX_CHARS
      );
    }
    case 'set_variant': {
      if (!hasOnlyKeys(value, SET_VARIANT_KEYS)) return false;
      if (!isValidTarget(value.target)) return false;
      return isBoundedText(value.variant, VISUAL_DESIGN_RATIONALE_MAX_CHARS);
    }
    default:
      return false;
  }
}

/**
 * Validates one review-only unmatched target. Unknown keys or an unlisted
 * reason are rejected so the provenance can never smuggle a mutation payload.
 */
export function isValidVisualNoSuitableAsset(value: unknown): value is VisualNoSuitableAsset {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, UNMATCHED_KEYS)) return false;
  if (!isValidTarget(value.targetBlockId)) return false;
  return typeof value.reason === 'string' && UNMATCHED_REASON_SET.has(value.reason);
}

/**
 * Strict validation of a VisualDesignProposal. Rejects a wrong discriminator,
 * an unsupported version, unknown keys, a malformed/duplicated operation list
 * and malformed rationale. Pure and non-mutating.
 */
export function isValidVisualDesignProposal(value: unknown): value is VisualDesignProposal {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, PROPOSAL_KEYS)) return false;
  if (value.kind !== VISUAL_DESIGN_PROPOSAL_KIND) return false;
  if (value.version !== VISUAL_DESIGN_PROPOSAL_VERSION) return false;
  if (!Array.isArray(value.operations)) return false;
  if (value.operations.length > VISUAL_DESIGN_MAX_OPERATIONS) return false;
  if (!value.operations.every(isValidVisualDesignOperation)) return false;
  if (value.rationale !== undefined) {
    if (!Array.isArray(value.rationale) || value.rationale.length > VISUAL_DESIGN_MAX_RATIONALE) return false;
    if (!value.rationale.every((entry) => isBoundedText(entry, VISUAL_DESIGN_RATIONALE_MAX_CHARS))) return false;
  }
  if (value.unmatched !== undefined) {
    if (!Array.isArray(value.unmatched) || value.unmatched.length > VISUAL_DESIGN_MAX_UNMATCHED) return false;
    if (!value.unmatched.every(isValidVisualNoSuitableAsset)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Composition (pure; visual proposal + resolved assets -> canonical document)
// ---------------------------------------------------------------------------

function cloneDocument(document: CanonicalDocument): CanonicalDocument {
  return JSON.parse(JSON.stringify(document)) as CanonicalDocument;
}

/** Index every block that carries a canonical id, by id. */
function indexBlocksById(blocks: readonly CanonicalBlock[], out: Map<string, CanonicalBlock>): void {
  for (const block of blocks) {
    if (block.id !== undefined && !out.has(block.id)) out.set(block.id, block);
    if (block.children && block.children.length > 0) indexBlocksById(block.children, out);
  }
}

function assetCatalog(assets: readonly VisualAssetRef[]): Map<string, VisualAssetRef> {
  const map = new Map<string, VisualAssetRef>();
  for (const asset of assets) map.set(asset.mediaId, asset);
  return map;
}

function applySelectAsset(
  op: VisualSelectAssetOperation,
  block: CanonicalBlock,
  assets: Map<string, VisualAssetRef>,
): void {
  if (block.type !== 'image') {
    throw new VisualDesignError(
      'unsupported_target',
      `Visual target "${op.target}" is a "${block.type}" block; only image blocks accept an asset.`,
    );
  }
  const asset = assets.get(op.mediaId);
  if (!asset) {
    throw new VisualDesignError('unknown_asset', `No asset "${op.mediaId}" exists in this project's media library.`);
  }
  const attrs: Record<string, unknown> = {
    ...(block.attrs ?? {}),
    mediaId: asset.mediaId,
    src: asset.url,
    alt: asset.alt ?? '',
    caption: asset.caption ?? '',
  };
  if (asset.width !== undefined) attrs.width = asset.width;
  if (asset.height !== undefined) attrs.height = asset.height;
  block.attrs = attrs;
}

function applySetVariant(op: VisualSetVariantOperation, block: CanonicalBlock): void {
  const allowed = (CANONICAL_BLOCK_VARIANTS as Record<string, readonly string[]>)[block.type];
  if (!allowed) {
    throw new VisualDesignError(
      'unsupported_target',
      `Visual target "${op.target}" is a "${block.type}" block, which has no supported visual variants.`,
    );
  }
  if (!allowed.includes(op.variant)) {
    throw new VisualDesignError(
      'unsupported_variant',
      `Variant "${op.variant}" is not supported by "${block.type}"; allowed: ${allowed.join(', ')}.`,
    );
  }
  block.attrs = { ...(block.attrs ?? {}), variant: op.variant };
}

/**
 * Folds a validated visual proposal into a copy of `document`, resolving image
 * assets from `assets` (metadata only, never bytes). Pure: the input document
 * and assets are never mutated. Fails explicitly with a typed
 * `VisualDesignError` for an invalid proposal/document, an unknown target, a
 * target that cannot host the operation, a missing asset, an unsupported
 * variant or two operations that touch the same target and property. The result
 * always passes `isValidCanonicalDoc`.
 */
export function applyVisualDesignProposal(
  document: unknown,
  proposal: unknown,
  assets: readonly VisualAssetRef[] = [],
): VisualDesignCompositionResult {
  if (!isValidCanonicalDoc(document)) {
    throw new VisualDesignError('invalid_document', 'The base document is not a valid canonical document.');
  }
  if (!isValidVisualDesignProposal(proposal)) {
    throw new VisualDesignError('invalid_visual_proposal', 'The visual design proposal is not valid.');
  }
  for (const asset of assets) {
    if (!isValidVisualAssetRef(asset)) {
      throw new VisualDesignError('invalid_visual_proposal', 'A resolved asset reference is not valid.');
    }
  }

  const next = cloneDocument(document);
  const byId = new Map<string, CanonicalBlock>();
  indexBlocksById(next.blocks, byId);
  const catalog = assetCatalog(assets);
  const seen = new Set<string>();
  const applied: string[] = [];

  for (const operation of proposal.operations) {
    const key = `${operation.op}:${operation.target}`;
    if (seen.has(key)) {
      throw new VisualDesignError(
        'duplicate_operation',
        `Conflicting visual operations: "${operation.op}" targets "${operation.target}" more than once.`,
      );
    }
    seen.add(key);

    const block = byId.get(operation.target);
    if (!block) {
      throw new VisualDesignError(
        'unknown_target',
        `Visual target "${operation.target}" does not resolve to a block in the document.`,
      );
    }

    if (operation.op === 'select_asset') applySelectAsset(operation, block, catalog);
    else applySetVariant(operation, block);

    applied.push(`${operation.op}:${operation.target}`);
  }

  if (!isValidCanonicalDoc(next)) {
    throw new VisualDesignError('invalid_document', 'The composed document is not a valid canonical document.');
  }
  return { document: next, applied };
}
