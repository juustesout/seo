/**
 * Media provenance and image acquisition source policy (R4.5A).
 *
 * The project media library (`seo_media`) is the single asset system: uploads
 * and externally acquired images (stock search today, generation in R4.5B) all
 * become ordinary library rows so they are reusable, manageable and deletable
 * through the existing media management. Provenance is kept on the row instead
 * of a parallel table: a stable `source` discriminator for filtering and a
 * bounded, secret-free `source_meta` object for provider specifics.
 *
 * Dependency-free (hand-rolled guards) like the rest of this package.
 */

/**
 * Bounded attribution a stock provider returns so credit can be stored on the
 * media row and rendered with the insertion. All fields are optional: an asset
 * without known authorship still has valid provenance.
 */
export interface MediaAttribution {
  /** Photographer/creator display name. */
  author?: string;
  /** Creator profile/page URL. */
  authorUrl?: string;
  /** Canonical human-facing page for the asset (Unsplash photo page). */
  sourceUrl?: string;
}

/**
 * Stable `seo_media.source` values. `upload` covers every user upload
 * (historically the only source); `project_media` is deliberately NOT a stored
 * value - it is how the insertion layer presents `upload` assets at runtime
 * (see `imageSourceKindOf`).
 */
export const MEDIA_SOURCES = ['upload', 'unsplash', 'openai_generated'] as const;
export type MediaSource = (typeof MEDIA_SOURCES)[number];

/** Runtime/presentation source of an insertion candidate. */
export const IMAGE_SOURCE_KINDS = ['project_media', 'unsplash', 'openai_generated'] as const;
export type ImageSourceKind = (typeof IMAGE_SOURCE_KINDS)[number];

/** Per-string and per-object bounds for persisted provider metadata. */
export const MEDIA_SOURCE_META_MAX_CHARS = 500;
export const MEDIA_SOURCE_META_MAX_KEYS = 8;

/**
 * Provider-specific, secret-free metadata persisted in `seo_media.source_meta`.
 * Only known keys are accepted; values are bounded strings. Never credentials.
 */
export interface MediaSourceMeta extends MediaAttribution {
  /** Provider id that produced the asset (e.g. `unsplash`, `openai`). */
  provider?: string;
  /** Original provider asset id (e.g. the Unsplash photo id). */
  sourceAssetId?: string;
  /** Generation model id for generated assets (R4.5B). */
  model?: string;
}

interface PlainRecord {
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is PlainRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalBoundedString(value: unknown, max: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= max);
}

const ATTRIBUTION_KEYS = ['author', 'authorUrl', 'sourceUrl'] as const;
const SOURCE_META_KEYS: readonly string[] = [...ATTRIBUTION_KEYS, 'provider', 'sourceAssetId', 'model'];

/** True when `value` is a valid source discriminator. */
export function isMediaSource(value: unknown): value is MediaSource {
  return typeof value === 'string' && (MEDIA_SOURCES as readonly string[]).includes(value);
}

/** True when `value` is a valid runtime presentation source kind. */
export function isImageSourceKind(value: unknown): value is ImageSourceKind {
  return typeof value === 'string' && (IMAGE_SOURCE_KINDS as readonly string[]).includes(value);
}

/** Maps a stored source to the kind the insertion layer presents. */
export function imageSourceKindOf(source: MediaSource): ImageSourceKind {
  return source === 'upload' ? 'project_media' : source;
}

/** True when `value` is a bounded attribution object. */
export function isValidMediaAttribution(value: unknown): value is MediaAttribution {
  if (!isPlainObject(value)) return false;
  if (!Object.keys(value).every((key) => (ATTRIBUTION_KEYS as readonly string[]).includes(key))) return false;
  return ATTRIBUTION_KEYS.every((key) => isOptionalBoundedString(value[key], MEDIA_SOURCE_META_MAX_CHARS));
}

/** True when `value` is a bounded, secret-free provider metadata object. */
export function isValidMediaSourceMeta(value: unknown): value is MediaSourceMeta {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length > MEDIA_SOURCE_META_MAX_KEYS) return false;
  if (!keys.every((key) => SOURCE_META_KEYS.includes(key))) return false;
  return keys.every((key) => isOptionalBoundedString(value[key], MEDIA_SOURCE_META_MAX_CHARS));
}

/**
 * Typed fallback policy for external image acquisition. Default is conservative:
 * the project library is always used, external search is opt-in per request, and
 * generation is never silent and always confirmed. The API validates this
 * server-side; the client is never the only guard.
 */
export interface ImageSourcePolicy {
  allowExternalSearch: boolean;
  allowGeneration: boolean;
  requireGenerationConfirmation: boolean;
}

export const IMAGE_SOURCE_POLICY_DEFAULT: ImageSourcePolicy = {
  allowExternalSearch: false,
  allowGeneration: false,
  requireGenerationConfirmation: true,
};

/** True when `value` is a complete, well-formed source policy. */
export function isValidImageSourcePolicy(value: unknown): value is ImageSourcePolicy {
  if (!isPlainObject(value)) return false;
  if (Object.keys(value).length !== 3) return false;
  return (
    typeof value.allowExternalSearch === 'boolean' &&
    typeof value.allowGeneration === 'boolean' &&
    typeof value.requireGenerationConfirmation === 'boolean'
  );
}
