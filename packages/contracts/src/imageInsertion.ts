/**
 * Context-aware image insertion contract (R3.1).
 *
 * The first Editor-native Designer action: the user places the cursor (or
 * selects text/a block) and asks for a suitable image. This module is the typed,
 * dependency-free contract for that vertical slice plus the deterministic
 * helpers both the API and the editor reuse, so the two sides can never drift:
 *
 *   - `ImageInsertionContext` is the bounded editor context the editor sends to
 *     the backend: the canonical document snapshot, its revision, the resolved
 *     location and the surrounding text that drives the search. It carries no
 *     Tiptap instance, DOM node or unserializable runtime state.
 *   - `InsertImageOperation` is the typed result: what is inserted, where, with
 *     which metadata, and why. The editor applies it as one editor transaction;
 *     the backend never writes the document.
 *   - `isImageInsertionInstruction` / `buildImageInsertionQuery` /
 *     `selectImageInsertionCandidate` are deterministic and inspectable, so a
 *     test can assert exactly which query a piece of context produces and which
 *     existing project asset it selects.
 *
 * Deliberate boundaries:
 *   - Only existing project media assets are sourced (the media library is the
 *     simplest already-supported source). Nothing here generates an image or
 *     invents a URL.
 *   - The matcher reasons only over metadata that actually exists today (alt,
 *     caption, filename); it never infers visual content.
 *   - A location is a location hint for one document snapshot, never a durable
 *     block identity; the editor re-validates it against the live document
 *     before applying.
 *   - Dependency-free by convention: plain types plus hand-rolled `isValid...`
 *     guards, no Zod, no runtime dependencies.
 */

import { isValidCanonicalDoc, type CanonicalBlock, type CanonicalDocument } from './canonical.js';
import {
  VISUAL_ASSET_DEFAULT_MIN_SCORE,
  rankVisualAssetCandidates,
  type VisualAssetCandidate,
} from './visualAssetSelection.js';
import { isValidVisualDesignIntent, visualAltTextForRole, type VisualDesignIntent } from './visualVocabulary.js';
import {
  isImageSourceKind,
  isValidImageSourcePolicy,
  type ImageSourceKind,
  type ImageSourcePolicy,
} from './mediaSource.js';

/** The single operation type this phase produces. */
export const IMAGE_INSERTION_OPERATION_TYPE = 'insert_image' as const;

// ---------------------------------------------------------------------------
// Bounds (single source of truth for the contract and its validator)
// ---------------------------------------------------------------------------

export const IMAGE_INSERTION_REVISION_MAX_CHARS = 200;
export const IMAGE_INSERTION_MAX_POSITION = 5_000_000;
export const IMAGE_INSERTION_MAX_PATH_DEPTH = 64;
export const IMAGE_INSERTION_MAX_PATH_INDEX = 100_000;
export const IMAGE_INSERTION_URL_MAX_CHARS = 4096;
export const IMAGE_INSERTION_ALT_MAX_CHARS = 500;
export const IMAGE_INSERTION_CAPTION_MAX_CHARS = 2000;
export const IMAGE_INSERTION_CREDIT_MAX_CHARS = 300;
export const IMAGE_INSERTION_SOURCE_URL_MAX_CHARS = 4096;
export const IMAGE_INSERTION_RATIONALE_MAX_CHARS = 300;
export const IMAGE_INSERTION_MAX_TEXT_CHARS = 2000;
export const IMAGE_INSERTION_NEARBY_MAX_CHARS = 600;
export const IMAGE_INSERTION_TITLE_MAX_CHARS = 300;
export const IMAGE_INSERTION_LANGUAGE_MAX_CHARS = 40;
/** Bound for the canonical/editor node type the selection sits on (R4.1 role hint). */
export const IMAGE_INSERTION_NODE_TYPE_MAX_CHARS = 100;
/** Serialized-size ceiling for the whole context, enforced at the API edge. */
export const IMAGE_INSERTION_CONTEXT_MAX_CHARS = 100_000;
export const IMAGE_INSERTION_DEFAULT_MIN_SCORE = VISUAL_ASSET_DEFAULT_MIN_SCORE;

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/** How the user expressed the insertion location in the current document. */
export const IMAGE_INSERTION_TARGET_KINDS = ['cursor', 'text-selection', 'block', 'section', 'hero'] as const;
export type ImageInsertionTargetKind = (typeof IMAGE_INSERTION_TARGET_KINDS)[number];

/**
 * The one placement a section image supports today: a contained image inside the
 * section. R4.2 deliberately does not host full-bleed or overlay placements, so a
 * resolved section intent with any other placement is refused rather than
 * silently rendered as something it is not.
 */
export const IMAGE_INSERTION_SECTION_PLACEMENT = 'contained' as const;

/**
 * The one placement a hero image supports today: a full-bleed image in the hero
 * region. R4.3 deliberately does not host overlay/side-by-side hero treatments,
 * so a resolved hero intent with any other placement is refused rather than
 * downgraded into a section image.
 */
export const IMAGE_INSERTION_HERO_PLACEMENT = 'full_bleed' as const;

/** Bounded supporting copy derived from a hero and used for hero retrieval. */
export const IMAGE_INSERTION_HERO_SUPPORTING_MAX_CHARS = 600;

/**
 * R4.4: the host region a background visual belongs to. This is deliberately a
 * separate dimension from `VisualPlacement`: `section` and `hero` name the region
 * that hosts the background, while its layout placement stays `full_bleed`. These
 * values are never added to `VISUAL_PLACEMENTS`.
 */
export const IMAGE_INSERTION_BACKGROUND_HOST_REGIONS = ['section', 'hero'] as const;
export type ImageInsertionBackgroundHostRegion = (typeof IMAGE_INSERTION_BACKGROUND_HOST_REGIONS)[number];

/**
 * The one layout placement a background visual supports today: a real image
 * block filling its host region. R4.4 deliberately does not implement a CSS
 * `background-image` treatment, so any other placement is refused rather than
 * silently rendered as something it is not.
 */
export const IMAGE_INSERTION_BACKGROUND_PLACEMENT = 'full_bleed' as const;

/** An insertion point at the caret (editor document position). */
export interface ImageInsertionCursorTarget {
  kind: 'cursor';
  position: number;
}

/** An insertion associated with a selected text range (editor positions). */
export interface ImageInsertionTextSelectionTarget {
  kind: 'text-selection';
  from: number;
  to: number;
}

/**
 * An insertion associated with a selected block. `path` is a structural index
 * path for the current document snapshot only - a location hint, not a durable
 * identity.
 */
export interface ImageInsertionBlockTarget {
  kind: 'block';
  path: number[];
}

/**
 * R4.2: a section visual target. A "section" is either an explicit composition
 * `section` container or a heading-delimited content region; both are addressed
 * by structural index paths for one document snapshot only.
 *
 * `sectionPath` identifies the addressed section (the container block, or the
 * heading block that starts a region). `anchorPath` identifies the heading block
 * the image is inserted after, so the insertion is deterministic
 * ("after the section heading, before its first content block"). Paths are
 * location hints, never durable identities; the editor re-validates them.
 */
export interface ImageInsertionSectionTarget {
  kind: 'section';
  sectionPath: number[];
  anchorPath: number[];
  /** Bounded resolved heading text, as a context hint; the editor re-reads it. */
  heading?: string;
}

/**
 * R4.3: a hero visual target. A "hero" is either an explicit composition `hero`
 * container or the heading-delimited page hero; both are addressed by structural
 * index paths for one document snapshot only.
 *
 * `heroPath` identifies the addressed hero (the container block, or the heading
 * block that starts a page hero). `anchorPath` identifies the heading block the
 * image is inserted after, so the insertion is deterministic ("after the hero
 * heading, before its supporting copy"). `placement` is fixed to the one hero
 * treatment R4.3 hosts. Paths are location hints, never durable identities; the
 * editor and the API both re-validate them against the live document.
 */
export interface ImageInsertionHeroTarget {
  kind: 'hero';
  heroPath: number[];
  anchorPath: number[];
  /** Canonical/editor node type of the hero host, as a context hint. */
  nodeType: string;
  placement: typeof IMAGE_INSERTION_HERO_PLACEMENT;
  /** Bounded resolved heading text, as a context hint; the editor re-reads it. */
  heading?: string;
  /** Bounded supporting copy after the heading, as a context hint. */
  supportingText?: string;
}

export type ImageInsertionTarget =
  | ImageInsertionCursorTarget
  | ImageInsertionTextSelectionTarget
  | ImageInsertionBlockTarget
  | ImageInsertionSectionTarget
  | ImageInsertionHeroTarget;

/**
 * R4.4: a background visual is hosted inside a section or the hero. Rather than a
 * new target shape it reuses the R4.2/R4.3 host targets and adds only the
 * host-region discriminator, which is the reused target's `kind`. The operation's
 * target is therefore a `section` or `hero` target carrying `visual.role =
 * "background"`; host region and layout placement stay separate dimensions.
 */
export type ImageInsertionBackgroundTarget = ImageInsertionSectionTarget | ImageInsertionHeroTarget;

// ---------------------------------------------------------------------------
// Candidate
// ---------------------------------------------------------------------------

/**
 * The resolved asset to insert. `assetId` is required for insertion because the
 * editor node only ever references a project media-library row; `url` is the
 * server-resolved public URL the editor previews, never raw bytes.
 */
export interface ImageInsertionCandidate {
  assetId?: string;
  url: string;
  alt: string;
  caption?: string;
  credit?: string;
  sourceUrl?: string;
  /**
   * R4.5: the runtime source of the asset (`project_media`, `unsplash`, ...).
   * A presentation/provenance hint for the editor; the asset itself is always a
   * project media-library reference (`assetId`).
   */
  source?: ImageSourceKind;
  width?: number;
  height?: number;
}

/** The typed, deterministic insertion operation the editor applies. */
export interface InsertImageOperation {
  type: typeof IMAGE_INSERTION_OPERATION_TYPE;
  target: ImageInsertionTarget;
  image: ImageInsertionCandidate;
  /**
   * R4.1: the resolved visual design intent (role/purpose/placement) behind the
   * insertion. It is usage intent, not asset metadata, and is kept structured so
   * review, alt policy and future design tools read the same thing. Optional so
   * R3.1 operations remain valid.
   */
  visual?: VisualDesignIntent;
  rationale?: string;
}

// ---------------------------------------------------------------------------
// Editor context
// ---------------------------------------------------------------------------

/**
 * The bounded editor context transmitted to the backend. Every field is
 * serializable; nothing here is a live editor object.
 */
export interface ImageInsertionContext {
  /** Stable revision of the local document (same scheme as the apply guard). */
  revision: string;
  /**
   * The canonical snapshot the location and nearby text were derived from. It is
   * bounded at the API edge; the backend uses it to validate the location and
   * never writes it.
   */
  document: CanonicalDocument;
  /** The resolved insertion location. */
  target: ImageInsertionTarget;
  /**
   * R4.2: the section the selection currently sits in, when the editor could
   * resolve one. It is a structural hint for the `section` role only: the editor
   * always sends the real caret/selection as `target`, and this carries the
   * addressed section so the backend can anchor a section image without
   * re-deriving the editor's structure. Validated against the canonical snapshot
   * before use; ignored for non-section roles.
   */
  sectionTarget?: ImageInsertionSectionTarget;
  /**
   * R4.3: the hero the request addresses, when the editor could resolve one. It
   * is a structural hint for the `hero` role only: the editor always sends the
   * real caret/selection as `target`, and this carries the addressed hero so the
   * backend can anchor a hero image without re-deriving the editor's structure.
   * Validated against the canonical snapshot before use; ignored for non-hero
   * roles.
   */
  heroTarget?: ImageInsertionHeroTarget;
  /**
   * R4.4: the host region a background request addresses, when the editor could
   * resolve one. It reuses the R4.2/R4.3 section/hero targets, so `kind` is the
   * host-region discriminator; it is a structural hint for the `background` role
   * only and is ignored for other roles. Validated against the canonical snapshot
   * before use.
   */
  backgroundTarget?: ImageInsertionBackgroundTarget;
  /** The user's selected text, when the target is a text selection. */
  selectedText?: string;
  /** Bounded surrounding copy (current block plus nearby blocks). */
  nearbyText: string;
  /** Document title, when the snapshot has one. */
  documentTitle?: string;
  /** Nearest preceding heading, when one exists. */
  sectionHeading?: string;
  /** Document language, when the snapshot has one. */
  language?: string;
  /**
   * R4.1: canonical/editor node type the selection sits on (e.g. `heading`,
   * `compositionHero`). A bounded contextual hint for role resolution; the
   * resolver only uses it when the instruction names no role itself.
   */
  targetNodeType?: string;
  /**
   * R4.5: the caller's explicit source policy for this request. Absent means the
   * conservative default (project media only, no generation). Validated at the
   * API edge so the client is never the only guard.
   */
  sourcePolicy?: ImageSourcePolicy;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const CURSOR_KEYS: ReadonlySet<string> = new Set(['kind', 'position']);
const TEXT_SELECTION_KEYS: ReadonlySet<string> = new Set(['kind', 'from', 'to']);
const BLOCK_KEYS: ReadonlySet<string> = new Set(['kind', 'path']);
const SECTION_KEYS: ReadonlySet<string> = new Set(['kind', 'sectionPath', 'anchorPath', 'heading']);
const HERO_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'heroPath',
  'anchorPath',
  'nodeType',
  'placement',
  'heading',
  'supportingText',
]);
const CANDIDATE_KEYS: ReadonlySet<string> = new Set([
  'assetId',
  'url',
  'alt',
  'caption',
  'credit',
  'sourceUrl',
  'source',
  'width',
  'height',
]);
const OPERATION_KEYS: ReadonlySet<string> = new Set(['type', 'target', 'image', 'visual', 'rationale']);
const CONTEXT_KEYS: ReadonlySet<string> = new Set([
  'revision',
  'document',
  'target',
  'sectionTarget',
  'heroTarget',
  'backgroundTarget',
  'selectedText',
  'nearbyText',
  'documentTitle',
  'sectionHeading',
  'language',
  'targetNodeType',
  'sourcePolicy',
]);

const TARGET_KIND_SET: ReadonlySet<string> = new Set(IMAGE_INSERTION_TARGET_KINDS);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function isOptionalBoundedString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= max);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isPosition(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= IMAGE_INSERTION_MAX_POSITION;
}

function isBlockPath(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > IMAGE_INSERTION_MAX_PATH_DEPTH) return false;
  return value.every(
    (entry) => typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry <= IMAGE_INSERTION_MAX_PATH_INDEX,
  );
}

function isOptionalPositiveInt(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0);
}

/** True when `value` is a bounded, well-formed insertion location. */
export function isValidImageInsertionTarget(value: unknown): value is ImageInsertionTarget {
  if (!isPlainObject(value)) return false;
  if (typeof value.kind !== 'string' || !TARGET_KIND_SET.has(value.kind)) return false;
  switch (value.kind as ImageInsertionTargetKind) {
    case 'cursor':
      return hasOnlyKeys(value, CURSOR_KEYS) && isPosition(value.position);
    case 'text-selection':
      return hasOnlyKeys(value, TEXT_SELECTION_KEYS) && isPosition(value.from) && isPosition(value.to) && value.from <= value.to;
    case 'block':
      return hasOnlyKeys(value, BLOCK_KEYS) && isBlockPath(value.path);
    case 'section':
      return (
        hasOnlyKeys(value, SECTION_KEYS) &&
        isBlockPath(value.sectionPath) &&
        isBlockPath(value.anchorPath) &&
        isOptionalBoundedString(value.heading, IMAGE_INSERTION_TITLE_MAX_CHARS)
      );
    case 'hero':
      return (
        hasOnlyKeys(value, HERO_KEYS) &&
        isBlockPath(value.heroPath) &&
        isBlockPath(value.anchorPath) &&
        isBoundedString(value.nodeType, IMAGE_INSERTION_NODE_TYPE_MAX_CHARS) &&
        value.placement === IMAGE_INSERTION_HERO_PLACEMENT &&
        isOptionalBoundedString(value.heading, IMAGE_INSERTION_TITLE_MAX_CHARS) &&
        isOptionalBoundedString(value.supportingText, IMAGE_INSERTION_HERO_SUPPORTING_MAX_CHARS)
      );
    default:
      return false;
  }
}

/** True when `value` is a bounded, well-formed resolved image candidate. */
export function isValidImageInsertionCandidate(value: unknown): value is ImageInsertionCandidate {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, CANDIDATE_KEYS)) return false;
  if (value.assetId !== undefined && !(typeof value.assetId === 'string' && value.assetId.length > 0 && value.assetId.length <= 128 && ID_RE.test(value.assetId))) {
    return false;
  }
  if (typeof value.url !== 'string' || value.url.length === 0 || value.url.length > IMAGE_INSERTION_URL_MAX_CHARS) return false;
  if (!isBoundedString(value.alt, IMAGE_INSERTION_ALT_MAX_CHARS)) return false;
  if (!isOptionalBoundedString(value.caption, IMAGE_INSERTION_CAPTION_MAX_CHARS)) return false;
  if (!isOptionalBoundedString(value.credit, IMAGE_INSERTION_CREDIT_MAX_CHARS)) return false;
  if (!isOptionalBoundedString(value.sourceUrl, IMAGE_INSERTION_SOURCE_URL_MAX_CHARS)) return false;
  if (value.source !== undefined && !isImageSourceKind(value.source)) return false;
  if (!isOptionalPositiveInt(value.width)) return false;
  return isOptionalPositiveInt(value.height);
}

/** True when `value` is a bounded, well-formed `insert_image` operation. */
export function isValidInsertImageOperation(value: unknown): value is InsertImageOperation {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, OPERATION_KEYS)) return false;
  if (value.type !== IMAGE_INSERTION_OPERATION_TYPE) return false;
  if (!isValidImageInsertionTarget(value.target)) return false;
  if (!isValidImageInsertionCandidate(value.image)) return false;
  if (value.visual !== undefined && !isValidVisualDesignIntent(value.visual)) return false;

  const target = value.target;
  const visual = value.visual as VisualDesignIntent | undefined;
  const role = visual?.role;
  // R4.2/R4.3/R4.4: the resolved role and the target kind must agree. A section
  // or hero target without a matching host role (or vice versa) is a mismatched
  // operation, and the role may only carry the one placement its host supports. A
  // background is hosted in a section or the hero, so it is the one role allowed
  // over either host target; it is never downgraded into a section/hero role.
  if (target.kind === 'section' && role !== 'section' && role !== 'background') return false;
  if (target.kind === 'hero' && role !== 'hero' && role !== 'background') return false;
  if (role === 'section' && target.kind !== 'section') return false;
  if (role === 'hero' && target.kind !== 'hero') return false;
  if (role === 'background' && target.kind !== 'section' && target.kind !== 'hero') return false;
  if (role === 'section' && visual?.placement !== undefined && visual.placement !== IMAGE_INSERTION_SECTION_PLACEMENT) {
    return false;
  }
  if (role === 'hero' && visual?.placement !== IMAGE_INSERTION_HERO_PLACEMENT) return false;
  if (role === 'background' && visual?.placement !== IMAGE_INSERTION_BACKGROUND_PLACEMENT) return false;

  return isOptionalBoundedString(value.rationale, IMAGE_INSERTION_RATIONALE_MAX_CHARS);
}

/** True when `value` is a bounded, well-formed editor insertion context. */
export function isValidImageInsertionContext(value: unknown): value is ImageInsertionContext {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, CONTEXT_KEYS)) return false;
  if (
    typeof value.revision !== 'string' ||
    value.revision.length === 0 ||
    value.revision.length > IMAGE_INSERTION_REVISION_MAX_CHARS
  ) {
    return false;
  }
  if (!isValidCanonicalDoc(value.document)) return false;
  if (!isValidImageInsertionTarget(value.target)) return false;
  if (
    value.sectionTarget !== undefined &&
    !(isValidImageInsertionTarget(value.sectionTarget) && value.sectionTarget.kind === 'section')
  ) {
    return false;
  }
  if (
    value.heroTarget !== undefined &&
    !(isValidImageInsertionTarget(value.heroTarget) && value.heroTarget.kind === 'hero')
  ) {
    return false;
  }
  if (
    value.backgroundTarget !== undefined &&
    !(
      isValidImageInsertionTarget(value.backgroundTarget) &&
      (value.backgroundTarget.kind === 'section' || value.backgroundTarget.kind === 'hero')
    )
  ) {
    return false;
  }
  if (!isOptionalBoundedString(value.selectedText, IMAGE_INSERTION_MAX_TEXT_CHARS)) return false;
  if (!isBoundedString(value.nearbyText, IMAGE_INSERTION_NEARBY_MAX_CHARS)) return false;
  if (!isOptionalBoundedString(value.documentTitle, IMAGE_INSERTION_TITLE_MAX_CHARS)) return false;
  if (!isOptionalBoundedString(value.sectionHeading, IMAGE_INSERTION_TITLE_MAX_CHARS)) return false;
  if (!isOptionalBoundedString(value.targetNodeType, IMAGE_INSERTION_NODE_TYPE_MAX_CHARS)) return false;
  if (value.sourcePolicy !== undefined && !isValidImageSourcePolicy(value.sourcePolicy)) return false;
  return isOptionalBoundedString(value.language, IMAGE_INSERTION_LANGUAGE_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Deterministic intent, query and selection
// ---------------------------------------------------------------------------

/** Nouns that name an image in the supported instruction vocabulary. */
const IMAGE_NOUNS: readonly string[] = [
  'afbeelding',
  'afbeeldingen',
  'foto',
  'fotos',
  "foto's",
  'fotografie',
  'illustratie',
  'plaatje',
  'image',
  'images',
  'picture',
  'pictures',
  'photo',
  'photos',
  'illustration',
  'graphic',
];

/**
 * Verbs/requests that name a different job on an image (describing, reviewing,
 * writing alt text). These are explicitly not insertion requests, so a request
 * that happens to mention an image is not misrouted into insertion.
 */
const IMAGE_NON_INSERTION_HINTS: readonly string[] = [
  'alt text',
  'alt-tekst',
  'alttekst',
  'beschrijf',
  'beschrijving',
  'beschrijf de afbeelding',
  'analyseer',
  'analyse',
  'beoordeel',
  'review',
  'wat staat er op',
  'what is in',
];

/**
 * Deterministic first-slice classifier: an instruction is an image-insertion
 * request when it names an image and does not ask for a different image job.
 * Localized (Dutch + English) and inspectable so it can be unit tested; the
 * backend re-runs the same function, so the editor and the API agree.
 */
export function isImageInsertionInstruction(instruction: string): boolean {
  const text = instruction.toLowerCase();
  if (!IMAGE_NOUNS.some((noun) => text.includes(noun))) return false;
  return !IMAGE_NON_INSERTION_HINTS.some((hint) => text.includes(hint));
}

/**
 * Builds the bounded, deterministic search query from the transmitted context.
 * Selected text takes precedence (the user named that text), then the section
 * heading, then the surrounding copy, then the document title. Empty parts are
 * dropped rather than padding the query; the result is capped at
 * `IMAGE_INSERTION_MAX_TEXT_CHARS`.
 */
export function buildImageInsertionQuery(
  context: Pick<ImageInsertionContext, 'selectedText' | 'sectionHeading' | 'nearbyText' | 'documentTitle'>,
): string {
  const parts = [context.selectedText, context.sectionHeading, context.nearbyText, context.documentTitle]
    .map((part) => (typeof part === 'string' ? part.replace(/\s+/g, ' ').trim() : ''))
    .filter((part) => part.length > 0);
  return parts.join(' ').slice(0, IMAGE_INSERTION_MAX_TEXT_CHARS);
}

export interface ImageInsertionSelection {
  candidate: VisualAssetCandidate;
  score: number;
  rationale: string;
}

/**
 * Selects at most one existing project asset for the context. Assets already
 * referenced by an image block in the supplied snapshot are excluded so the same
 * picture is not inserted twice. Returns null when nothing clears the relevance
 * floor - the caller must report an honest "no suitable image", never fall back
 * to an arbitrary asset. Pure and deterministic.
 */
export function selectImageInsertionCandidate(
  context: ImageInsertionContext,
  candidates: readonly VisualAssetCandidate[],
  options: { minScore?: number; visual?: VisualDesignIntent } = {},
): ImageInsertionSelection | null {
  const taken = new Set<string>();
  collectUsedMediaIds(context.document.blocks, taken);
  const pool = candidates.filter((candidate) => !taken.has(candidate.mediaId));
  const minScore = options.minScore ?? IMAGE_INSERTION_DEFAULT_MIN_SCORE;
  const best = rankVisualAssetCandidates(
    buildImageInsertionQuery(context),
    pool,
    options.visual ? { visual: options.visual } : undefined,
  )[0];
  if (!best || best.score < minScore) return null;
  return { candidate: best.candidate, score: best.score, rationale: best.rationale };
}

/**
 * Applies the R4.1 role's alt-text policy to a resolved insertion. Decorative and
 * background visuals get an empty alt (marked decorative) instead of a
 * descriptor that would mislead a screen reader; content-bearing roles keep the
 * descriptive text and fall back to the filename only when none was provided.
 */
export function imageInsertionAltForIntent(intent: VisualDesignIntent | undefined, alt: string, fallback = ''): string {
  if (!intent) {
    const trimmed = alt.trim();
    return trimmed.length > 0 ? trimmed : fallback.trim();
  }
  return visualAltTextForRole(intent.role, alt, fallback);
}

function collectUsedMediaIds(blocks: readonly CanonicalBlock[], out: Set<string>): void {
  for (const block of blocks) {
    if (block.type === 'image' && typeof block.attrs?.mediaId === 'string' && block.attrs.mediaId) {
      out.add(block.attrs.mediaId);
    }
    if (block.children) collectUsedMediaIds(block.children, out);
  }
}
