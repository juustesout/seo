/**
 * Visual design vocabulary (R4.1).
 *
 * R3.1 can insert a suitable image. R4.1 gives the system a shared language for
 * graphics before any further visuals are built: three separate, validated
 * concepts that are routinely conflated but mean different things.
 *
 *   - `VisualAssetRole` - where/how the visual is used (hero, section, inline,
 *     background, illustration, icon, logo, decorative, thumbnail, avatar).
 *   - `VisualIntent` - what the visual is meant to accomplish (explain, reinforce,
 *     atmosphere, emphasis, attention, context, brand, decoration).
 *   - `VisualPlacement` - how it participates in the layout (inline, contained,
 *     full_bleed, side_by_side, card, overlay).
 *
 * These are deliberately NOT collapsed into one type field, and deliberately not
 * stored as intrinsic asset metadata: an asset is a fact ("solar-panels.png,
 * 1600x900"), its use in a document is an intent ("hero / atmosphere /
 * full_bleed"). The same asset can be a hero in one document and a card
 * thumbnail in another, so usage intent is a property of the placement, not of
 * the picture.
 *
 * This module is dependency-free by convention (plain types plus hand-rolled
 * `isValid...` guards, no Zod, no runtime dependencies) so it can be imported by
 * the canonical asset ranker without creating a cycle. The instruction ->
 * intent resolution layer that consumes it lives in `visualIntent.ts`.
 *
 * Kept intentionally small: enough vocabulary to name the visuals the platform
 * will support, not an entire graphics engine and not a taxonomy of arbitrary
 * strings.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Where/how a visual is used in a document. */
export const VISUAL_ASSET_ROLES = [
  'hero',
  'section',
  'inline',
  'background',
  'illustration',
  'icon',
  'logo',
  'decorative',
  'thumbnail',
  'avatar',
] as const;
export type VisualAssetRole = (typeof VISUAL_ASSET_ROLES)[number];

/** What a visual is meant to accomplish. */
export const VISUAL_INTENTS = [
  'explain',
  'reinforce',
  'atmosphere',
  'emphasis',
  'attention',
  'context',
  'brand',
  'decoration',
] as const;
export type VisualIntent = (typeof VISUAL_INTENTS)[number];

/** How a visual participates in the layout. */
export const VISUAL_PLACEMENTS = ['inline', 'contained', 'full_bleed', 'side_by_side', 'card', 'overlay'] as const;
export type VisualPlacement = (typeof VISUAL_PLACEMENTS)[number];

export const VISUAL_SUBJECT_MAX_CHARS = 160;
export const VISUAL_MOOD_MAX_CHARS = 80;
export const VISUAL_ASPECT_RATIO_MAX_CHARS = 20;
export const VISUAL_REASON_MAX_CHARS = 300;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ASPECT_RATIO_RE = /^\d{1,4}:\d{1,4}$/;

const ROLE_SET: ReadonlySet<string> = new Set(VISUAL_ASSET_ROLES);
const INTENT_SET: ReadonlySet<string> = new Set(VISUAL_INTENTS);
const PLACEMENT_SET: ReadonlySet<string> = new Set(VISUAL_PLACEMENTS);

/**
 * The typed visual intent: role plus purpose plus optional layout and retrieval
 * hints. Every field is optional except the two axes that define the concept;
 * `subject`/`mood`/`aspectRatio` only ever carry what the instruction or the
 * editor context justified, never an inferred aesthetic claim.
 */
export interface VisualDesignIntent {
  role: VisualAssetRole;
  intent: VisualIntent;
  placement?: VisualPlacement;
  subject?: string;
  mood?: string;
  aspectRatio?: string;
  /**
   * True when the visual carries information a reader needs (and therefore
   * needs meaningful alt text); false for decorative/background visuals.
   */
  accessibilityRequired?: boolean;
}

const INTENT_KEYS: ReadonlySet<string> = new Set([
  'role',
  'intent',
  'placement',
  'subject',
  'mood',
  'aspectRatio',
  'accessibilityRequired',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function isBoundedOptionalString(value: unknown, max: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= max);
}

/** True when `value` is one of the supported visual roles. */
export function isValidVisualAssetRole(value: unknown): value is VisualAssetRole {
  return typeof value === 'string' && ROLE_SET.has(value);
}

/** True when `value` is one of the supported visual intents. */
export function isValidVisualIntent(value: unknown): value is VisualIntent {
  return typeof value === 'string' && INTENT_SET.has(value);
}

/** True when `value` is one of the supported placements. */
export function isValidVisualPlacement(value: unknown): value is VisualPlacement {
  return typeof value === 'string' && PLACEMENT_SET.has(value);
}

/** True when `value` is a bounded `W:H` aspect ratio. */
export function isValidAspectRatio(value: unknown): value is string {
  return typeof value === 'string' && value.length <= VISUAL_ASPECT_RATIO_MAX_CHARS && ASPECT_RATIO_RE.test(value);
}

/** True when `value` is a bounded, well-formed visual design intent. */
export function isValidVisualDesignIntent(value: unknown): value is VisualDesignIntent {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, INTENT_KEYS)) return false;
  if (!isValidVisualAssetRole(value.role)) return false;
  if (!isValidVisualIntent(value.intent)) return false;
  if (value.placement !== undefined && !isValidVisualPlacement(value.placement)) return false;
  if (!isBoundedOptionalString(value.subject, VISUAL_SUBJECT_MAX_CHARS)) return false;
  if (!isBoundedOptionalString(value.mood, VISUAL_MOOD_MAX_CHARS)) return false;
  if (value.aspectRatio !== undefined && !isValidAspectRatio(value.aspectRatio)) return false;
  return value.accessibilityRequired === undefined || typeof value.accessibilityRequired === 'boolean';
}

// ---------------------------------------------------------------------------
// Role defaults
// ---------------------------------------------------------------------------

/** The placement a role falls back to when the instruction names none. */
export const VISUAL_ROLE_DEFAULT_PLACEMENT: Readonly<Record<VisualAssetRole, VisualPlacement>> = {
  hero: 'full_bleed',
  section: 'contained',
  inline: 'inline',
  background: 'full_bleed',
  illustration: 'contained',
  icon: 'inline',
  logo: 'inline',
  decorative: 'overlay',
  thumbnail: 'card',
  avatar: 'inline',
};

/** The purpose a role implies when the instruction names no competing one. */
export const VISUAL_ROLE_DEFAULT_INTENT: Readonly<Record<VisualAssetRole, VisualIntent>> = {
  hero: 'emphasis',
  section: 'reinforce',
  inline: 'reinforce',
  background: 'atmosphere',
  illustration: 'explain',
  icon: 'reinforce',
  logo: 'brand',
  decorative: 'decoration',
  thumbnail: 'reinforce',
  avatar: 'context',
};

/**
 * The visual roles the canonical model can actually host today. An `image` block
 * plus, since R4.2/R4.3, a section region and a hero region give these roles a
 * real, addressable home; R4.4 adds the `background`, which reuses those two host
 * regions as a real image block. Roles that need a layout host we still do not
 * have (card thumbnails, avatars, icons) resolve as vocabulary but are not
 * insertable. Declaring that here, once, is what keeps the API from faking an
 * insertion it cannot perform.
 */
export const VISUAL_INSERTABLE_ROLES = ['inline', 'section', 'hero', 'background', 'illustration', 'decorative'] as const;

/** True when the current capabilities can place this role as a real, hostable visual. */
export function isVisualInsertableRole(role: VisualAssetRole): boolean {
  return (VISUAL_INSERTABLE_ROLES as readonly string[]).includes(role);
}

// ---------------------------------------------------------------------------
// Accessibility semantics
// ---------------------------------------------------------------------------

/**
 * Roles whose visual is decorative or ambient rather than content-bearing. They
 * get no descriptive alt text; content-bearing roles keep the alt-text
 * requirement. Role alone can never guarantee correct alt text, so the user (or
 * later AI logic) can still refine it.
 */
export const VISUAL_DECORATIVE_ROLES: readonly VisualAssetRole[] = ['decorative', 'background'];

/** True when the role's visual contributes information and needs real alt text. */
export function visualRoleRequiresDescriptiveAlt(role: VisualAssetRole): boolean {
  return !VISUAL_DECORATIVE_ROLES.includes(role);
}

/**
 * Applies the role's alt-text policy to a resolved alt value. Content-bearing
 * roles keep the descriptive text (falling back to the provided default when it
 * is empty); decorative/background visuals are marked decorative with an empty
 * alt so a screen reader does not announce meaningless copy.
 */
export function visualAltTextForRole(role: VisualAssetRole, alt: string, fallback = ''): string {
  if (!visualRoleRequiresDescriptiveAlt(role)) return '';
  const trimmed = alt.trim();
  return trimmed.length > 0 ? trimmed : fallback.trim();
}

// ---------------------------------------------------------------------------
// Aspect / orientation preferences
// ---------------------------------------------------------------------------

export type VisualOrientation = 'landscape' | 'portrait' | 'square';

/** The shape a role tends to need, used only as a ranking signal, never a claim. */
export interface VisualAspectPreference {
  orientation?: VisualOrientation;
  /** Preferred width:height ratio, when the role has a conventional one. */
  ratio?: number;
}

const ROLE_ASPECT_PREFERENCES: Readonly<Record<VisualAssetRole, VisualAspectPreference>> = {
  hero: { orientation: 'landscape', ratio: 16 / 9 },
  section: { orientation: 'landscape', ratio: 3 / 2 },
  inline: {},
  background: { orientation: 'landscape', ratio: 16 / 9 },
  illustration: { orientation: 'landscape', ratio: 4 / 3 },
  icon: { orientation: 'square', ratio: 1 },
  logo: { orientation: 'square', ratio: 1 },
  decorative: {},
  thumbnail: { orientation: 'landscape', ratio: 16 / 9 },
  avatar: { orientation: 'square', ratio: 1 },
};

/**
 * The aspect preference for an intent. An explicit `aspectRatio` on the intent
 * overrides the role default, so "een 4:3 afbeelding" is respected. Pure.
 */
export function visualAspectPreference(intent: Pick<VisualDesignIntent, 'role' | 'aspectRatio'>): VisualAspectPreference {
  const explicit = intent.aspectRatio ? parseAspectRatio(intent.aspectRatio) : null;
  if (explicit !== null) return { ratio: explicit };
  return ROLE_ASPECT_PREFERENCES[intent.role];
}

/** Parses a `W:H` ratio to a number, or null when it is malformed or zero. */
export function parseAspectRatio(value: string): number | null {
  if (!isValidAspectRatio(value)) return null;
  const [width, height] = value.split(':').map((part) => Number.parseInt(part, 10));
  if (!width || !height || width <= 0 || height <= 0) return null;
  return width / height;
}

/** The orientation of a real pixel size, or null when dimensions are unknown. */
export function orientationOf(width: unknown, height: unknown): VisualOrientation | null {
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) return null;
  const ratio = width / height;
  if (ratio > 1.05) return 'landscape';
  if (ratio < 0.95) return 'portrait';
  return 'square';
}

/** True when `value` is a bounded, well-formed subject/mood/reason string. */
export function isBoundedVisualString(value: unknown, max = VISUAL_SUBJECT_MAX_CHARS): value is string {
  return typeof value === 'string' && value.length <= max;
}

/** True for a bounded id-like token (used for role/candidate references in errors). */
export function isVisualToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && ID_RE.test(value);
}
