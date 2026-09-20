/**
 * Visual asset selection (Stage 8E.6, ADR Phase 5.3.1).
 *
 * Phase 5.3 gave the Visual Design domain a strict proposal contract that can
 * compose *explicitly named* assets. This module is the first intelligence
 * layer above it: given a canonical document, its surrounding text and the
 * metadata of existing project assets, it decides which existing asset belongs
 * in which image block and emits a validated `VisualDesignProposal`.
 *
 * Deliberate boundaries:
 *   - It only ever ranks existing project assets. Assets from another project
 *     are the caller's responsibility to exclude (retrieval stays
 *     project-scoped); this module never reaches past the candidate list it is
 *     handed.
 *   - It reasons only over metadata that actually exists today: filename,
 *     alt text, caption, MIME type, pixel dimensions and usage count. It never
 *     infers colour, mood, subject or "professionalism" - those are not in the
 *     data and would be fabricated.
 *   - It is pure and deterministic: the same document + candidates + options
 *     always produce the same selections, independent of iteration accidents.
 *   - It never persists, applies or mutates content; it produces a proposal
 *     that the existing review/apply choke point still has to accept.
 *
 * Reuse notes (Phase 5.3.1 recon): the repository has no media search index -
 * `seo_media` is neither lexically indexed nor embedded in the vector store.
 * The project-scoped `MediaService.list` (bounded to 200 rows) is the existing
 * retrieval path, so candidates are ranked in memory rather than by adding a
 * second search/indexing system.
 *
 * Dependency-free by convention: plain types plus hand-rolled `isValid...`
 * guards, no Zod, no runtime dependencies.
 */

import {
  isValidCanonicalDoc,
  type CanonicalBlock,
  type CanonicalDocument,
  type CanonicalInline,
} from './canonical.js';
import {
  VISUAL_DESIGN_MAX_OPERATIONS,
  VISUAL_DESIGN_MAX_RATIONALE,
  VISUAL_DESIGN_MAX_UNMATCHED,
  VISUAL_DESIGN_PROPOSAL_KIND,
  VISUAL_DESIGN_PROPOSAL_VERSION,
  VISUAL_DESIGN_RATIONALE_MAX_CHARS,
  VisualDesignError,
  isValidVisualNoSuitableAsset,
  type VisualDesignOperation,
  type VisualDesignProposal,
  type VisualNoSuitableAsset,
} from './visualDesign.js';

/**
 * Visual roles the canonical model can actually host today. Only `image` blocks
 * accept an asset reference; there is no background/media-role field, so no
 * other role is invented here.
 */
export const VISUAL_ASSET_ROLES = ['image'] as const;
export type VisualAssetRole = (typeof VISUAL_ASSET_ROLES)[number];

/** MIME types the media library accepts; anything else is not selectable. */
export const VISUAL_ASSET_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export const VISUAL_ASSET_MAX_CANDIDATES = 200;
export const VISUAL_ASSET_MAX_TARGETS = 100;
export const VISUAL_ASSET_MAX_QUERY_CHARS = 2000;
export const VISUAL_ASSET_DEFAULT_MIN_SCORE = 1;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const TOKEN_RE = /[a-z0-9]+/g;

/**
 * Metadata for one existing project asset, as the matcher is allowed to see it.
 * It mirrors the media library DTO's descriptive fields and never carries bytes
 * or a storage key.
 */
export interface VisualAssetCandidate {
  mediaId: string;
  filename: string;
  alt?: string;
  caption?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  usageCount?: number;
}

/**
 * One resolved asset -> target decision. `score` is retained because the
 * proposal rationale and audit trail benefit from it, but it is a match score
 * over textual metadata, not a claim about the image's visual content.
 */
export interface VisualAssetSelection {
  assetId: string;
  targetBlockId: string;
  role: VisualAssetRole;
  score: number;
  rationale: string;
}

export interface VisualAssetSelectionResult {
  selections: VisualAssetSelection[];
  unmatched: VisualNoSuitableAsset[];
}

/**
 * Caller-supplied selection options. `targets` names specific canonical block
 * ids (an explicit request); when absent, every image block with an id is a
 * candidate target. `minScore` overrides the default relevance floor.
 */
export interface VisualAssetSelectionRequest {
  targets?: string[];
  minScore?: number;
}

/** One image block the matcher may fill, with its surrounding text context. */
export interface VisualTarget {
  blockId: string;
  role: VisualAssetRole;
  /** Document context (title, section heading, parent copy, existing alt). */
  context: string;
}

export interface VisualTargetCollection {
  targets: VisualTarget[];
  skipped: VisualNoSuitableAsset[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const CANDIDATE_KEYS: ReadonlySet<string> = new Set([
  'mediaId',
  'filename',
  'alt',
  'caption',
  'mimeType',
  'width',
  'height',
  'usageCount',
]);
const SELECTION_KEYS: ReadonlySet<string> = new Set(['assetId', 'targetBlockId', 'role', 'score', 'rationale']);
const REQUEST_KEYS: ReadonlySet<string> = new Set(['targets', 'minScore']);
const ROLE_SET: ReadonlySet<string> = new Set(VISUAL_ASSET_ROLES);
const MIME_SET: ReadonlySet<string> = new Set(VISUAL_ASSET_MIME_TYPES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function isValidId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && ID_RE.test(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isOptionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || isBoundedString(value, max);
}

function isOptionalPositiveInt(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0);
}

function isOptionalNonNegativeInt(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

/** True when `mimeType` is absent (unknown) or an accepted image type. */
export function isSelectableVisualMimeType(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && MIME_SET.has(value));
}

/** True when `value` is a bounded, well-formed candidate asset. */
export function isValidVisualAssetCandidate(value: unknown): value is VisualAssetCandidate {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, CANDIDATE_KEYS)) return false;
  if (!isValidId(value.mediaId)) return false;
  if (typeof value.filename !== 'string' || value.filename.length === 0 || value.filename.length > 256) return false;
  if (!isOptionalBoundedString(value.alt, 500)) return false;
  if (!isOptionalBoundedString(value.caption, 2000)) return false;
  if (!isSelectableVisualMimeType(value.mimeType)) return false;
  if (!isOptionalPositiveInt(value.width)) return false;
  if (!isOptionalPositiveInt(value.height)) return false;
  return isOptionalNonNegativeInt(value.usageCount);
}

export function isValidVisualAssetSelection(value: unknown): value is VisualAssetSelection {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, SELECTION_KEYS)) return false;
  if (!isValidId(value.assetId) || !isValidId(value.targetBlockId)) return false;
  if (typeof value.role !== 'string' || !ROLE_SET.has(value.role)) return false;
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0) return false;
  return isBoundedString(value.rationale, VISUAL_DESIGN_RATIONALE_MAX_CHARS);
}

export function isValidVisualAssetSelectionRequest(value: unknown): value is VisualAssetSelectionRequest {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, REQUEST_KEYS)) return false;
  if (value.targets !== undefined) {
    if (!Array.isArray(value.targets) || value.targets.length === 0) return false;
    if (value.targets.length > VISUAL_ASSET_MAX_TARGETS) return false;
    if (!value.targets.every(isValidId)) return false;
  }
  if (value.minScore !== undefined) {
    if (typeof value.minScore !== 'number' || !Number.isFinite(value.minScore) || value.minScore < 0) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Document context
// ---------------------------------------------------------------------------

/** Plain text of inline content, concatenated. */
function inlineText(content: readonly CanonicalInline[] | undefined): string {
  if (!content) return '';
  const parts: string[] = [];
  for (const inline of content) {
    if (inline.type === 'text' && typeof inline.text === 'string') parts.push(inline.text);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Plain text of a block, recursively, skipping image/html/custom blocks so a
 * container's copy - not its media - forms the context. Bounded by the query
 * cap at the call site.
 */
function blockText(block: CanonicalBlock): string {
  if (block.type === 'image' || block.type === 'html' || block.type === 'custom') return '';
  const parts: string[] = [inlineText(block.content)];
  if (block.children) {
    for (const child of block.children) {
      const text = blockText(child);
      if (text) parts.push(text);
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function boundQuery(text: string): string {
  return text.slice(0, VISUAL_ASSET_MAX_QUERY_CHARS);
}

/**
 * Collects the image blocks that can receive an asset, in document order, with
 * the surrounding text context that drives matching (document title, the most
 * recent preceding heading, the enclosing container's copy and the block's own
 * existing alt text). When `targets` is given, only those ids are collected and
 * every unresolved/unsupported id is reported explicitly instead of ignored.
 */
export function collectVisualTargets(document: unknown, targets?: readonly string[]): VisualTargetCollection {
  if (!isValidCanonicalDoc(document)) {
    throw new VisualDesignError('invalid_document', 'The document is not a valid canonical document.');
  }
  const requested = targets ? new Set(targets) : null;
  if (targets) {
    for (const id of targets) {
      if (!isValidId(id)) {
        throw new VisualDesignError('invalid_visual_proposal', `Requested visual target "${id}" is not a valid block id.`);
      }
    }
  }

  const found = new Map<string, VisualTarget>();
  const title = typeof document.meta?.title === 'string' ? document.meta.title.trim() : '';

  const walkWithParent = (blocks: readonly CanonicalBlock[], heading: string | undefined, parentText: string): void => {
    let currentHeading = heading;
    for (const block of blocks) {
      if (block.type === 'heading') {
        const text = inlineText(block.content);
        if (text) currentHeading = text;
      }
      if (block.type === 'image' && isValidId(block.id)) {
        if (!requested || requested.has(block.id)) {
          const ownAlt = typeof block.attrs?.alt === 'string' ? block.attrs.alt : '';
          const context = boundQuery([title, currentHeading ?? '', parentText, ownAlt].filter(Boolean).join(' '));
          if (!found.has(block.id)) found.set(block.id, { blockId: block.id, role: 'image', context });
        }
      }
      if (block.children && block.children.length > 0) {
        walkWithParent(block.children, currentHeading, blockText(block));
      }
    }
  };

  walkWithParent(document.blocks, undefined, '');

  const targetsOut = [...found.values()];
  const skipped: VisualNoSuitableAsset[] = [];
  if (requested) {
    const imageIds = new Set<string>();
    const collectIds = (blocks: readonly CanonicalBlock[]): void => {
      for (const block of blocks) {
        if (isValidId(block.id)) imageIds.add(block.id);
        if (block.children) collectIds(block.children);
      }
    };
    collectIds(document.blocks);
    for (const id of targets ?? []) {
      if (!found.has(id)) {
        skipped.push({ targetBlockId: id, reason: imageIds.has(id) ? 'unsupported_target' : 'unknown_target' });
      }
    }
  }
  return { targets: targetsOut, skipped };
}

// ---------------------------------------------------------------------------
// Matching (deterministic; metadata only)
// ---------------------------------------------------------------------------

const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'your',
  'you',
  'our',
  'are',
  'was',
  'has',
  'have',
  'its',
  'into',
  'over',
  'under',
  'about',
  'above',
  'after',
  'before',
  'when',
  'what',
  'which',
  'who',
  'how',
  'why',
  'not',
  'but',
  'all',
  'any',
  'can',
  'will',
  'just',
  'than',
  'then',
  'them',
  'they',
  'their',
  'his',
  'her',
  'him',
  'she',
  'out',
  'get',
  'got',
  'use',
  'used',
  'using',
]);

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(TOKEN_RE) ?? [];
  const out: string[] = [];
  for (const token of matches) {
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

function tokenSet(text: string | undefined): Set<string> {
  return new Set(tokenize(text ?? ''));
}

function areaOf(candidate: VisualAssetCandidate): number {
  return (candidate.width ?? 0) * (candidate.height ?? 0);
}

/** Field weight: alt text is the strongest human-authored signal, filename the weakest. */
function matchScore(queryTokens: readonly string[], candidate: VisualAssetCandidate): number {
  const alt = tokenSet(candidate.alt);
  const caption = tokenSet(candidate.caption);
  const filename = tokenSet(candidate.filename.replace(/[._-]/g, ' '));
  let score = 0;
  for (const token of queryTokens) {
    if (alt.has(token)) score += 3;
    else if (caption.has(token)) score += 2;
    else if (filename.has(token)) score += 1;
  }
  return score;
}

function matchedTokens(queryTokens: readonly string[], candidate: VisualAssetCandidate): string[] {
  const fields = [candidate.alt, candidate.caption, candidate.filename.replace(/[._-]/g, ' ')].join(' ').toLowerCase();
  const out: string[] = [];
  for (const token of queryTokens) {
    if (fields.includes(token) && !out.includes(token)) out.push(token);
  }
  return out;
}

function rationaleFor(score: number, tokens: readonly string[]): string {
  const reason = tokens.length > 0 ? `Matched metadata on "${tokens.slice(0, 6).join(', ')}".` : 'Metadata match.';
  return reason.slice(0, VISUAL_DESIGN_RATIONALE_MAX_CHARS);
}

function compareCandidates(a: VisualAssetCandidate, b: VisualAssetCandidate, scores: Map<string, number>): number {
  const scoreDelta = (scores.get(b.mediaId) ?? 0) - (scores.get(a.mediaId) ?? 0);
  if (scoreDelta !== 0) return scoreDelta;
  const areaDelta = areaOf(b) - areaOf(a);
  if (areaDelta !== 0) return areaDelta;
  const usageDelta = (a.usageCount ?? 0) - (b.usageCount ?? 0);
  if (usageDelta !== 0) return usageDelta;
  return a.mediaId < b.mediaId ? -1 : a.mediaId > b.mediaId ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Ranks the project's existing assets against each visual target and selects at
 * most one asset per target. Assets already assigned to another image block in
 * the document are treated as conflicting and skipped, so one asset is never
 * silently duplicated across two blocks. A target with no candidate above the
 * relevance floor is reported in `unmatched` - never filled with a guess. Pure
 * and deterministic.
 */
export function selectVisualAssets(
  document: unknown,
  candidates: readonly VisualAssetCandidate[],
  request: VisualAssetSelectionRequest = {},
): VisualAssetSelectionResult {
  if (!isValidCanonicalDoc(document)) {
    throw new VisualDesignError('invalid_document', 'The document is not a valid canonical document.');
  }
  if (!isValidVisualAssetSelectionRequest(request)) {
    throw new VisualDesignError('invalid_visual_proposal', 'The visual asset selection request is not valid.');
  }

  const { targets, skipped } = collectVisualTargets(document, request.targets);
  const unmatched: VisualNoSuitableAsset[] = [...skipped];

  const usable: VisualAssetCandidate[] = [];
  for (const candidate of candidates) {
    if (!isValidVisualAssetCandidate(candidate)) continue;
    if (!isSelectableVisualMimeType(candidate.mimeType)) continue;
    usable.push(candidate);
    if (usable.length >= VISUAL_ASSET_MAX_CANDIDATES) break;
  }

  // Assets already referenced elsewhere in the document must not be re-used.
  const taken = new Set<string>();
  const collectAssigned = (blocks: readonly CanonicalBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'image' && typeof block.attrs?.mediaId === 'string' && block.attrs.mediaId) {
        taken.add(block.attrs.mediaId);
      }
      if (block.children) collectAssigned(block.children);
    }
  };
  collectAssigned(document.blocks);

  const minScore = request.minScore ?? VISUAL_ASSET_DEFAULT_MIN_SCORE;
  const selections: VisualAssetSelection[] = [];

  for (const target of targets) {
    const ownAssigned = findImageMediaId(document.blocks, target.blockId);
    const pool = usable.filter((candidate) => candidate.mediaId === ownAssigned || !taken.has(candidate.mediaId));
    if (pool.length === 0) {
      unmatched.push({
        targetBlockId: target.blockId,
        reason: usable.length === 0 ? 'no_candidates' : 'all_conflicting',
      });
      continue;
    }

    const queryTokens = tokenize(target.context);
    const scores = new Map<string, number>();
    for (const candidate of pool) scores.set(candidate.mediaId, matchScore(queryTokens, candidate));
    const ranked = [...pool].sort((a, b) => compareCandidates(a, b, scores));
    const best = ranked[0];
    const bestScore = best ? (scores.get(best.mediaId) ?? 0) : 0;
    if (!best || bestScore < minScore) {
      unmatched.push({ targetBlockId: target.blockId, reason: 'below_threshold' });
      continue;
    }

    const tokens = matchedTokens(queryTokens, best);
    selections.push({
      assetId: best.mediaId,
      targetBlockId: target.blockId,
      role: target.role,
      score: bestScore,
      rationale: rationaleFor(bestScore, tokens),
    });
    if (best.mediaId !== ownAssigned) taken.add(best.mediaId);
  }

  return { selections, unmatched };
}

function findImageMediaId(blocks: readonly CanonicalBlock[], id: string): string | undefined {
  for (const block of blocks) {
    if (block.id === id && block.type === 'image' && typeof block.attrs?.mediaId === 'string') return block.attrs.mediaId;
    if (block.children) {
      const nested = findImageMediaId(block.children, id);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/**
 * Converts selections into the existing Visual Design proposal shape, so the
 * intelligence layer feeds the exact same pipeline as an explicit proposal.
 * Rejects a duplicate target or a duplicated asset rather than letting the
 * composition step fail opaquely later.
 */
export function visualDesignProposalFromSelections(
  selections: readonly VisualAssetSelection[],
  rationale?: readonly string[],
  unmatched?: readonly VisualNoSuitableAsset[],
): VisualDesignProposal {
  if (selections.length > VISUAL_DESIGN_MAX_OPERATIONS) {
    throw new VisualDesignError('invalid_visual_proposal', 'Too many visual asset selections.');
  }
  const seenTargets = new Set<string>();
  const seenAssets = new Set<string>();
  const operations: VisualDesignOperation[] = [];
  for (const selection of selections) {
    if (!isValidVisualAssetSelection(selection)) {
      throw new VisualDesignError('invalid_visual_proposal', 'A visual asset selection is not valid.');
    }
    if (seenTargets.has(selection.targetBlockId)) {
      throw new VisualDesignError(
        'duplicate_operation',
        `Conflicting visual selections: "${selection.targetBlockId}" is selected more than once.`,
      );
    }
    if (seenAssets.has(selection.assetId)) {
      throw new VisualDesignError(
        'duplicate_operation',
        `Conflicting visual selections: asset "${selection.assetId}" is selected more than once.`,
      );
    }
    seenTargets.add(selection.targetBlockId);
    seenAssets.add(selection.assetId);
    operations.push({ op: 'select_asset', target: selection.targetBlockId, mediaId: selection.assetId });
  }

  const proposal: VisualDesignProposal = {
    kind: VISUAL_DESIGN_PROPOSAL_KIND,
    version: VISUAL_DESIGN_PROPOSAL_VERSION,
    operations,
  };
  const reasons = (rationale ?? selections.map((selection) => selection.rationale)).filter(
    (entry) => typeof entry === 'string' && entry.length > 0,
  );
  if (reasons.length > 0) {
    proposal.rationale = reasons.slice(0, VISUAL_DESIGN_MAX_RATIONALE).map((entry) =>
      entry.slice(0, VISUAL_DESIGN_RATIONALE_MAX_CHARS),
    );
  }
  if (unmatched !== undefined && unmatched.length > 0) {
    if (!unmatched.every(isValidVisualNoSuitableAsset)) {
      throw new VisualDesignError('invalid_visual_proposal', 'An unmatched visual target result is not valid.');
    }
    proposal.unmatched = unmatched
      .slice(0, VISUAL_DESIGN_MAX_UNMATCHED)
      .map((entry) => ({ targetBlockId: entry.targetBlockId, reason: entry.reason }));
  }
  return proposal;
}
