/**
 * Design Package v1 (Stage 8E.6, ADR Phase 3).
 *
 * A portable, versioned envelope for a *complete design state*: the canonical
 * document (authoritative structure + copy + bounded visual intent), the Cosmos
 * design-system tokens it renders against, a portable package identity, the
 * optional bounded Designer plan that produced it, and portable media
 * references. It is data only - no service, no execution, no persistence, no
 * AI - so it can be validated, serialized, exported and re-imported without the
 * request or session that produced it.
 *
 * Interpretation (ADR §10, resolved deliberately):
 *   - It is a *state*, not a proposal. `DesignerProposal` remains the guarded,
 *     reviewable change envelope for one run (`baseRevision` + review). A
 *     package has no `baseRevision` and never mutates `seo_content`.
 *   - `document` is the authoritative design state, so structure is never
 *     duplicated here: there is no second `CompositionPlan`/variant table. The
 *     variant vocabulary is global contract data (`CANONICAL_BLOCK_VARIANTS`),
 *     not package data.
 *   - `plan` is optional provenance (the bounded `DesignerPlan` that produced
 *     the state); it reuses the existing Designer contract rather than a new
 *     operation model.
 *   - `designSystem` carries portable token *values* (`CosmosDesign`), while
 *     `document.meta.designSystem` stays an identity reference only.
 *
 * Export is lossy on purpose at exactly one boundary: project-scoped media
 * identifiers (`mediaId`/`src`) and CMS `source` envelopes are stripped so a
 * package can cross projects, and the stripped media is recorded as a portable
 * `DesignAssetRef` (target + alt/caption) for the importing project to
 * re-resolve. Import only ever returns a value that passes
 * `isValidDesignPackage`, so imported data cannot bypass canonical validation.
 *
 * Everything here follows the dependency-free `@seo/contracts` convention: plain
 * types plus hand-rolled `isValid...` guards, no Zod, no runtime dependencies.
 */

import { isValidCanonicalDoc, type CanonicalBlock, type CanonicalDocument } from './canonical.js';
import { isValidCosmosDesign, type CosmosDesign } from './cosmos.js';
import {
  isValidDesignerPlan,
  isValidDesignerProposal,
  stableJsonStringify,
  type DesignerPlan,
} from './designer.js';

export const DESIGN_PACKAGE_KIND = 'design_package' as const;
export const DESIGN_PACKAGE_VERSION = 1 as const;

/** Portable asset kinds a package may reference. Additive. */
export const DESIGN_ASSET_KINDS = ['image'] as const;
export type DesignAssetKind = (typeof DESIGN_ASSET_KINDS)[number];

/** Bounds (single source of truth for the contract and its validator). */
export const DESIGN_PACKAGE_ID_MAX_CHARS = 128;
export const DESIGN_PACKAGE_NAME_MAX_CHARS = 200;
export const DESIGN_PACKAGE_DESCRIPTION_MAX_CHARS = 2000;
export const DESIGN_PACKAGE_MAX_TAGS = 20;
export const DESIGN_PACKAGE_TAG_MAX_CHARS = 60;
export const DESIGN_PACKAGE_CREATED_AT_MAX_CHARS = 40;
export const DESIGN_PACKAGE_MAX_ASSETS = 200;
export const DESIGN_PACKAGE_ASSET_TEXT_MAX_CHARS = 300;

/**
 * Portable package identity and interpretation metadata. There is deliberately
 * no project id: a package is project-owned but exportable across projects
 * (ADR H8). `id` is a package-local, filename-safe identifier.
 */
export interface DesignPackageMetadata {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/**
 * A portable media reference. It never carries a project-scoped media id: it
 * names the canonical block it belongs to so the importing project can
 * re-resolve the asset, plus the descriptive text that is portable.
 */
export interface DesignAssetRef {
  /** Canonical block id the asset fills (e.g. `hero__media`). */
  target: string;
  kind: DesignAssetKind;
  alt?: string;
  caption?: string;
}

/**
 * A complete, portable design state. Versioned; `kind` discriminates it from
 * other JSON envelopes so an unrelated object is never mistaken for a package.
 */
export interface DesignPackage {
  kind: typeof DESIGN_PACKAGE_KIND;
  version: typeof DESIGN_PACKAGE_VERSION;
  metadata: DesignPackageMetadata;
  document: CanonicalDocument;
  designSystem: CosmosDesign;
  /** Provenance: the bounded Designer plan that produced this state, if known. */
  plan?: DesignerPlan;
  assets?: DesignAssetRef[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DesignPackageErrorCode =
  | 'invalid_design_package'
  | 'invalid_design_package_json'
  | 'unsupported_design_package_version'
  | 'invalid_designer_proposal';

/** Typed, deterministic rejection raised by export/import and conversion. */
export class DesignPackageError extends Error {
  readonly code: DesignPackageErrorCode;

  constructor(code: DesignPackageErrorCode, message: string) {
    super(message);
    this.name = 'DesignPackageError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PACKAGE_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'version',
  'metadata',
  'document',
  'designSystem',
  'plan',
  'assets',
]);
const METADATA_KEYS: ReadonlySet<string> = new Set(['id', 'name', 'description', 'tags', 'createdAt']);
const ASSET_KEYS: ReadonlySet<string> = new Set(['target', 'kind', 'alt', 'caption']);

const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ASSET_KIND_SET: ReadonlySet<string> = new Set(DESIGN_ASSET_KINDS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function boundedOptionalText(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length <= max;
}

function isValidPackageId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= DESIGN_PACKAGE_ID_MAX_CHARS && PACKAGE_ID_RE.test(value);
}

function isValidTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DESIGN_PACKAGE_CREATED_AT_MAX_CHARS &&
    !Number.isNaN(Date.parse(value))
  );
}

/** True when `value` is a well-formed, bounded package metadata object. */
export function isValidDesignPackageMetadata(value: unknown): value is DesignPackageMetadata {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, METADATA_KEYS)) return false;
  if (!isValidPackageId(value.id)) return false;
  if (!boundedText(value.name, DESIGN_PACKAGE_NAME_MAX_CHARS)) return false;
  if (value.description !== undefined && !boundedOptionalText(value.description, DESIGN_PACKAGE_DESCRIPTION_MAX_CHARS)) {
    return false;
  }
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > DESIGN_PACKAGE_MAX_TAGS) return false;
    const seen = new Set<string>();
    for (const tag of value.tags) {
      if (!boundedText(tag, DESIGN_PACKAGE_TAG_MAX_CHARS)) return false;
      if (seen.has(tag)) return false;
      seen.add(tag);
    }
  }
  return isValidTimestamp(value.createdAt);
}

/** True when `value` is a well-formed, bypass-free portable asset reference. */
export function isValidDesignAssetRef(value: unknown): value is DesignAssetRef {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, ASSET_KEYS)) return false;
  if (!isValidPackageId(value.target)) return false;
  if (typeof value.kind !== 'string' || !ASSET_KIND_SET.has(value.kind)) return false;
  if (value.alt !== undefined && !boundedOptionalText(value.alt, DESIGN_PACKAGE_ASSET_TEXT_MAX_CHARS)) return false;
  if (value.caption !== undefined && !boundedOptionalText(value.caption, DESIGN_PACKAGE_ASSET_TEXT_MAX_CHARS)) {
    return false;
  }
  return true;
}

/**
 * Strict, deterministic validation of a Design Package v1. Rejects a wrong
 * discriminator, any unsupported version, unknown keys, malformed metadata,
 * an invalid nested canonical document, invalid Cosmos tokens, an invalid
 * Designer plan and malformed/duplicate assets. Pure and non-mutating.
 */
export function isValidDesignPackage(value: unknown): value is DesignPackage {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, PACKAGE_KEYS)) return false;
  if (value.kind !== DESIGN_PACKAGE_KIND) return false;
  if (value.version !== DESIGN_PACKAGE_VERSION) return false;
  if (!isValidDesignPackageMetadata(value.metadata)) return false;
  if (!isValidCanonicalDoc(value.document)) return false;
  if (!isValidCosmosDesign(value.designSystem)) return false;
  if (value.plan !== undefined && !isValidDesignerPlan(value.plan)) return false;
  if (value.assets !== undefined) {
    if (!Array.isArray(value.assets) || value.assets.length > DESIGN_PACKAGE_MAX_ASSETS) return false;
    const seen = new Set<string>();
    for (const asset of value.assets) {
      if (!isValidDesignAssetRef(asset)) return false;
      const key = `${asset.target}:${asset.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Media / ID hygiene
// ---------------------------------------------------------------------------

export interface PortableDesignDocument {
  document: CanonicalDocument;
  assets: DesignAssetRef[];
}

function collectAssets(blocks: CanonicalBlock[], assets: DesignAssetRef[]): void {
  for (const block of blocks) {
    // A CMS origin envelope can carry project-specific attrs; it never travels.
    delete block.source;
    if (block.type === 'image' && block.attrs) {
      const { mediaId, src } = block.attrs;
      if (mediaId !== undefined || src !== undefined) {
        if (block.id !== undefined) {
          const asset: DesignAssetRef = { target: block.id, kind: 'image' };
          if (typeof block.attrs.alt === 'string') asset.alt = block.attrs.alt;
          if (typeof block.attrs.caption === 'string') asset.caption = block.attrs.caption;
          assets.push(asset);
        }
        delete block.attrs.mediaId;
        delete block.attrs.src;
      }
    }
    if (block.children) collectAssets(block.children, assets);
  }
}

/**
 * Returns a portable copy of `document`: project-scoped media identifiers
 * (`mediaId`/`src`) and CMS `source` envelopes are removed, and the removed
 * media is recorded as a `DesignAssetRef` (only when the block has a canonical
 * id to target). The input is never mutated.
 */
export function portableDesignDocument(document: CanonicalDocument): PortableDesignDocument {
  const clone = JSON.parse(JSON.stringify(document)) as CanonicalDocument;
  const assets: DesignAssetRef[] = [];
  collectAssets(clone.blocks, assets);
  return { document: clone, assets };
}

function sortAssets(assets: DesignAssetRef[]): DesignAssetRef[] {
  return [...assets].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

/**
 * Returns a portable, validated copy of `pkg`. Applies media/source hygiene and
 * merges the resulting asset refs with any already present (deduped by target,
 * in target order), so exporting is idempotent. Throws `DesignPackageError` when
 * `pkg` is not a valid package.
 */
export function toPortableDesignPackage(pkg: unknown): DesignPackage {
  if (!isValidDesignPackage(pkg)) {
    throw new DesignPackageError('invalid_design_package', 'Design package is not valid');
  }
  const { document, assets } = portableDesignDocument(pkg.document);
  const byTarget = new Map<string, DesignAssetRef>();
  for (const asset of pkg.assets ?? []) byTarget.set(asset.target, asset);
  for (const asset of assets) byTarget.set(asset.target, asset);

  const portable: DesignPackage = {
    kind: DESIGN_PACKAGE_KIND,
    version: DESIGN_PACKAGE_VERSION,
    metadata: pkg.metadata,
    document,
    designSystem: pkg.designSystem,
  };
  if (pkg.plan !== undefined) portable.plan = pkg.plan;
  const merged = sortAssets([...byTarget.values()]);
  if (merged.length > 0) portable.assets = merged;
  return portable;
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

/** Fixed-shape, JSON-safe view with absent optional fields omitted. */
function packageValue(pkg: DesignPackage): Record<string, unknown> {
  const metadata: Record<string, unknown> = { id: pkg.metadata.id, name: pkg.metadata.name };
  if (pkg.metadata.description !== undefined) metadata.description = pkg.metadata.description;
  if (pkg.metadata.tags !== undefined && pkg.metadata.tags.length > 0) metadata.tags = pkg.metadata.tags;
  metadata.createdAt = pkg.metadata.createdAt;

  const value: Record<string, unknown> = {
    kind: pkg.kind,
    version: pkg.version,
    metadata,
    document: pkg.document,
    designSystem: pkg.designSystem,
  };
  if (pkg.plan !== undefined) value.plan = pkg.plan;
  if (pkg.assets !== undefined && pkg.assets.length > 0) value.assets = pkg.assets;
  return value;
}

/**
 * Serializes a package to a deterministic, JSON-compatible string. Applies
 * media/source hygiene first, so the output never carries a project-scoped media
 * id or CMS origin envelope. The same package always produces the same string.
 */
export function exportDesignPackage(pkg: unknown): string {
  const portable = toPortableDesignPackage(pkg);
  // JSON-normalize first so an in-memory `undefined` (which JSON cannot carry)
  // is dropped rather than becoming a literal `null` that would fail validation
  // on import; then serialize with sorted keys for byte-stable output.
  const clean = JSON.parse(JSON.stringify(packageValue(portable))) as unknown;
  return stableJsonStringify(clean);
}

/**
 * Parses and validates a serialized package (a JSON string, or an already
 * parsed value). Rejects malformed JSON, a missing/wrong discriminator, an
 * unsupported version and any invalid nested data with a typed
 * `DesignPackageError`; an unsupported version is never reinterpreted as v1.
 * Returns only a value that passes `isValidDesignPackage`.
 */
export function importDesignPackage(serialized: unknown): DesignPackage {
  let value: unknown = serialized;
  if (typeof serialized === 'string') {
    try {
      value = JSON.parse(serialized) as unknown;
    } catch {
      throw new DesignPackageError('invalid_design_package_json', 'Design package is not valid JSON');
    }
  }
  if (!isPlainObject(value)) {
    throw new DesignPackageError('invalid_design_package', 'Design package must be a JSON object');
  }
  if (value.kind !== DESIGN_PACKAGE_KIND) {
    throw new DesignPackageError('invalid_design_package', 'Design package discriminator is missing or wrong');
  }
  if (value.version !== DESIGN_PACKAGE_VERSION) {
    throw new DesignPackageError(
      'unsupported_design_package_version',
      `Unsupported design package version: ${String(value.version)}`,
    );
  }
  if (!isValidDesignPackage(value)) {
    throw new DesignPackageError('invalid_design_package', 'Design package failed validation');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Designer integration (pure adapter at the proposal boundary)
// ---------------------------------------------------------------------------

export interface DesignPackageFromProposalOptions {
  metadata: DesignPackageMetadata;
  designSystem: CosmosDesign;
}

/**
 * The narrow Designer integration: converts the existing proposal boundary
 * output into a portable package without changing the proposal envelope or
 * forcing every Designer operation to build one. `document` (and the optional
 * `plan`) are preserved exactly; `metadata`/`designSystem` come from the caller
 * because a proposal carries neither. Invalid proposals or options are rejected
 * through this contract boundary, never coerced.
 */
export function designPackageFromProposal(
  proposal: unknown,
  options: DesignPackageFromProposalOptions,
): DesignPackage {
  if (!isValidDesignerProposal(proposal)) {
    throw new DesignPackageError('invalid_designer_proposal', 'Designer proposal is not valid');
  }
  if (!isValidDesignPackageMetadata(options.metadata) || !isValidCosmosDesign(options.designSystem)) {
    throw new DesignPackageError('invalid_design_package', 'Design package metadata or design system is not valid');
  }
  const pkg: DesignPackage = {
    kind: DESIGN_PACKAGE_KIND,
    version: DESIGN_PACKAGE_VERSION,
    metadata: options.metadata,
    document: proposal.document,
    designSystem: options.designSystem,
  };
  if (proposal.plan !== undefined) pkg.plan = proposal.plan;
  if (!isValidDesignPackage(pkg)) {
    throw new DesignPackageError('invalid_design_package', 'Designer proposal could not be represented as a design package');
  }
  return pkg;
}
