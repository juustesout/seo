/**
 * Canonical Block Document v1.
 *
 * A CMS-neutral, versioned document model that sits between import/export
 * adapters (WordPress, Shopify, Wix, ...) and our editor/persistence format.
 * Stage 1 is deliberately additive: nothing here is persisted yet and
 * `seo_content.content_json` stays a Tiptap document.
 *
 * Two ideas make this model useful rather than a lowest-common-denominator
 * format:
 *   1. a semantic projection (`type` + semantic `attrs` + inline `content` +
 *      nested `children`) that AI/analytics can reason about, and
 *   2. an optional lossless `source` envelope (original CMS, block/node type,
 *      raw attrs, WP `innerContent`) so an adapter can emit a document back to
 *      its origin without dropping CMS-specific detail.
 *
 * Unknown block/mark types are allowed on purpose: adapters must be able to
 * carry content they do not yet understand (as `custom`) instead of dropping
 * it. Structural validation is still strict.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const CANONICAL_DOCUMENT_VERSION = 1 as const;

/**
 * Stage 4: bounded semantic composition vocabulary.
 *
 * These types describe editorial/marketing *intent* (a hero, a callout, a CTA)
 * without carrying presentation. Emphasis is a bounded `variant`, arrangement is
 * a bounded `layout` intent (see `CanonicalLayoutIntent`), and theme/tokens are
 * referenced once per document via `CanonicalMeta.designSystem`. Content stays
 * structured and addressable through `content`/`children`; these blocks never
 * hold CSS, and unknown composition types remain expressible as `custom`.
 */
export const CANONICAL_COMPOSITION_BLOCK_TYPES = [
  'hero',
  'section',
  'featureGrid',
  'featureCard',
  'cta',
  'callout',
  'testimonial',
  'stats',
  'mediaText',
  'footer',
] as const;

/** Leaf composition blocks carry an inline label (`content`) plus bounded attrs. */
export const CANONICAL_COMPOSITION_LEAF_BLOCK_TYPES = ['badge', 'button', 'statItem'] as const;

export type KnownCanonicalCompositionBlockType = (typeof CANONICAL_COMPOSITION_BLOCK_TYPES)[number];
export type KnownCanonicalCompositionLeafBlockType = (typeof CANONICAL_COMPOSITION_LEAF_BLOCK_TYPES)[number];

/**
 * Semantic block types known to v1. This is documentation + adapter hints, not
 * a closed set: a document may carry any non-empty, well-formed block type, and
 * unknown ones should use `custom` with a `source`. `canonicalBlockTypeOf`
 * reports whether a type is part of the known vocabulary.
 */
export const CANONICAL_BLOCK_TYPES = [
  'paragraph',
  'heading',
  'list',
  'listItem',
  'quote',
  'code',
  'image',
  'divider',
  'table',
  'tableRow',
  'tableCell',
  'group',
  'columns',
  'column',
  'embed',
  'html',
  'custom',
  ...CANONICAL_COMPOSITION_BLOCK_TYPES,
  ...CANONICAL_COMPOSITION_LEAF_BLOCK_TYPES,
] as const;

export type KnownCanonicalBlockType = (typeof CANONICAL_BLOCK_TYPES)[number];

/** Mark types v1 knows how to render. Unknown marks are still structurally
 *  valid so a conversion never silently drops formatting it cannot name. */
export const CANONICAL_MARK_TYPES = [
  'bold',
  'italic',
  'strike',
  'code',
  'underline',
  'sub',
  'sup',
  'link',
] as const;

export type KnownCanonicalMarkType = (typeof CANONICAL_MARK_TYPES)[number];

/**
 * Bounded semantic variants per composition/leaf type. A variant names emphasis
 * or meaning (`callout: 'warning'`), never a colour, size, border or spacing. An
 * absent variant means `'default'`; an unknown variant makes the block invalid.
 */
export const CANONICAL_BLOCK_VARIANTS = {
  hero: ['default', 'centered', 'split', 'minimal', 'banner'],
  section: ['default', 'muted', 'bordered', 'inverted'],
  featureGrid: ['default', 'compact'],
  featureCard: ['default', 'elevated', 'bordered', 'minimal'],
  cta: ['default', 'primary', 'secondary', 'banner'],
  callout: ['default', 'info', 'tip', 'warning', 'success', 'danger'],
  testimonial: ['default', 'card', 'minimal'],
  stats: ['default', 'compact'],
  statItem: ['default'],
  mediaText: ['default', 'image-left', 'image-right'],
  badge: ['default', 'outline', 'solid', 'accent'],
  footer: ['default', 'simple', 'expanded'],
  button: ['default', 'primary', 'secondary', 'ghost'],
} as const;

export type CanonicalVariantHostType = keyof typeof CANONICAL_BLOCK_VARIANTS;

/** Target-neutral layout intent. No grid templates, flex bases or pixel values. */
export const CANONICAL_LAYOUT_ALIGNMENTS = ['left', 'center', 'right'] as const;
export const CANONICAL_LAYOUT_DIRECTIONS = ['row', 'column'] as const;
export const CANONICAL_LAYOUT_WIDTHS = ['narrow', 'standard', 'wide', 'full'] as const;
export const CANONICAL_LAYOUT_DENSITIES = ['compact', 'comfortable', 'spacious'] as const;

/** Hard ceiling on `layout.columns`; beyond this the intent is not expressible. */
export const CANONICAL_MAX_LAYOUT_COLUMNS = 6;

export type CanonicalLayoutAlignment = (typeof CANONICAL_LAYOUT_ALIGNMENTS)[number];
export type CanonicalLayoutDirection = (typeof CANONICAL_LAYOUT_DIRECTIONS)[number];
export type CanonicalLayoutWidth = (typeof CANONICAL_LAYOUT_WIDTHS)[number];
export type CanonicalLayoutDensity = (typeof CANONICAL_LAYOUT_DENSITIES)[number];

export interface CanonicalLayoutIntent {
  align?: CanonicalLayoutAlignment;
  direction?: CanonicalLayoutDirection;
  /** Column count, integer 1..CANONICAL_MAX_LAYOUT_COLUMNS. */
  columns?: number;
  width?: CanonicalLayoutWidth;
  density?: CanonicalLayoutDensity;
}

/**
 * Allowed `attrs` keys per composition type - the CSS firewall. Any other key at
 * all (e.g. `style`, `color`, `margin`, `fontSize`) makes the block invalid.
 */
export const CANONICAL_COMPOSITION_ATTR_KEYS = {
  hero: ['variant', 'layout'],
  section: ['variant', 'layout'],
  featureGrid: ['variant', 'layout'],
  featureCard: ['variant', 'layout', 'icon'],
  cta: ['variant', 'layout'],
  callout: ['variant', 'layout', 'icon'],
  testimonial: ['variant', 'layout'],
  stats: ['variant', 'layout'],
  statItem: ['variant', 'layout', 'value'],
  mediaText: ['variant', 'layout'],
  badge: ['variant', 'layout', 'icon'],
  footer: ['variant', 'layout'],
  button: ['variant', 'layout', 'href'],
} as const;

export type CanonicalCompositionType = keyof typeof CANONICAL_COMPOSITION_ATTR_KEYS;

/**
 * A reference to the document's design system / token set. The tokens themselves
 * live in project configuration (Cosmos), never in the document.
 */
export interface CanonicalDesignSystemRef {
  id?: string;
  variant?: string;
  version?: string;
}

/** Upper bounds keep a hand-edited or hostile document from reaching adapters. */
export const CANONICAL_MAX_BLOCKS = 5000;
const MAX_DEPTH = 200;
const MAX_ID_LENGTH = 128;
const MAX_TYPE_LENGTH = 80;
const MAX_ICON_LENGTH = 80;
const MAX_VALUE_LENGTH = 200;
const MAX_HREF_LENGTH = 4096;
const MAX_DESIGN_SYSTEM_REF_LENGTH = 200;

const KNOWN_BLOCK_TYPES: ReadonlySet<string> = new Set(CANONICAL_BLOCK_TYPES);
const KNOWN_MARK_TYPES: ReadonlySet<string> = new Set(CANONICAL_MARK_TYPES);

const COMPOSITION_ATTR_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>(
  Object.entries(CANONICAL_COMPOSITION_ATTR_KEYS).map(
    ([type, keys]): [string, ReadonlySet<string>] => [type, new Set<string>(keys)],
  ),
);
const FORBIDDEN_CSS_ATTR_KEYS: ReadonlySet<string> = new Set(['style', 'className', 'class', 'css', 'sx']);
const LAYOUT_KEYS: ReadonlySet<string> = new Set(['align', 'direction', 'columns', 'width', 'density']);
const LAYOUT_ALIGNMENT_SET: ReadonlySet<string> = new Set(CANONICAL_LAYOUT_ALIGNMENTS);
const LAYOUT_DIRECTION_SET: ReadonlySet<string> = new Set(CANONICAL_LAYOUT_DIRECTIONS);
const LAYOUT_WIDTH_SET: ReadonlySet<string> = new Set(CANONICAL_LAYOUT_WIDTHS);
const LAYOUT_DENSITY_SET: ReadonlySet<string> = new Set(CANONICAL_LAYOUT_DENSITIES);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** CMS identifier for the origin of a block. Open-ended so future adapters can
 *  add values without a contracts release. */
export type CanonicalSourceCms = 'tiptap' | 'wordpress' | 'shopify' | 'wix' | 'html' | (string & {});

/**
 * Lossless origin envelope. Only populated when the information is not already
 * carried by the semantic projection - primarily for `custom`/unsupported
 * content and for adapters that need the original representation to re-emit.
 */
export interface SourceRef {
  cms: CanonicalSourceCms;
  /** Original node type / block name (e.g. TipTap `mention`, WP `core/group`). */
  type?: string;
  /** Original raw attributes, preserved verbatim when present. */
  attrs?: Record<string, unknown>;
  /** The original attribute payload as text, kept when `attrs` cannot hold it
   *  (malformed or non-object JSON). Serializers should prefer this over
   *  re-encoding `attrs` so nothing is lost at the interchange boundary. */
  attrsRaw?: string;
  /** WordPress `innerContent`: static HTML fragments interleaved with `null`
   *  placeholders at child-block positions. Enables byte-exact WP round trips. */
  innerContent?: Array<string | null>;
}

export interface CanonicalMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface CanonicalText {
  type: 'text';
  text: string;
  marks?: CanonicalMark[];
}

export interface CanonicalBreak {
  type: 'break';
}

/** Escape hatch for inline content an adapter cannot name yet. `raw` holds the
 *  original JSON so a round trip can restore it exactly. */
export interface CanonicalInlineUnsupported {
  type: 'inlineUnsupported';
  raw?: string;
  source?: SourceRef;
}

export type CanonicalInline = CanonicalText | CanonicalBreak | CanonicalInlineUnsupported;

export interface CanonicalBlock {
  /** Stable, bounded address. Deterministic when generated by an adapter. */
  id?: string;
  /** Semantic type; see CANONICAL_BLOCK_TYPES. Open vocabulary. */
  type: string;
  /** Semantic attributes only (e.g. heading `level`, image `mediaId`). Raw
   *  origin attributes live on `source.attrs`. */
  attrs?: Record<string, unknown>;
  /** Inline content for leaf blocks (paragraph, heading, code, ...). */
  content?: CanonicalInline[];
  /** Nested blocks (containers, list items, rows/cells, ...). */
  children?: CanonicalBlock[];
  /** Lossless origin envelope (see SourceRef). */
  source?: SourceRef;
  /** Raw HTML fallback for `html`/`custom` blocks when no structure is known. */
  rawHtml?: string;
}

export interface CanonicalMeta {
  title?: string;
  language?: string | null;
  /** Reference to the design system / token set this document renders against. */
  designSystem?: CanonicalDesignSystemRef;
}

export interface CanonicalDocument {
  version: typeof CANONICAL_DOCUMENT_VERSION;
  blocks: CanonicalBlock[];
  meta?: CanonicalMeta;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** A brand-new empty canonical document (single empty paragraph), mirroring
 *  `tiptapEmptyDoc()` so round trips of an empty article are stable. */
export function canonicalEmptyDoc(): CanonicalDocument {
  return { version: CANONICAL_DOCUMENT_VERSION, blocks: [{ type: 'paragraph' }] };
}

/**
 * Returns a copy of `document` that records the given design-system reference in
 * `meta.designSystem`. Pure and additive: other `meta` fields are preserved, and
 * an absent `ref` returns the document unchanged (nothing is invented, so the
 * renderer keeps its default fallback).
 */
export function withDesignSystemRef(
  document: CanonicalDocument,
  ref: CanonicalDesignSystemRef | undefined,
): CanonicalDocument {
  if (!ref) return document;
  return { ...document, meta: { ...document.meta, designSystem: ref } };
}

/** True when `type` is part of the known v1 semantic vocabulary. */
export function canonicalBlockTypeOf(type: string): type is KnownCanonicalBlockType {
  return KNOWN_BLOCK_TYPES.has(type);
}

/** True when `type` is a known v1 mark type. */
export function canonicalMarkTypeOf(type: string): type is KnownCanonicalMarkType {
  return KNOWN_MARK_TYPES.has(type);
}

/** Validated semantic variant of a block, or undefined when absent/unknown. */
export function canonicalVariantOf(block: CanonicalBlock): string | undefined {
  const variant = block.attrs?.variant;
  if (typeof variant !== 'string') return undefined;
  const allowed = (CANONICAL_BLOCK_VARIANTS as Record<string, readonly string[]>)[block.type];
  return allowed && allowed.includes(variant) ? variant : undefined;
}

/** True when `value` is a structurally valid, bounded layout intent. */
export function isValidCanonicalLayoutIntent(value: unknown): value is CanonicalLayoutIntent {
  return isValidLayoutIntent(value);
}

/**
 * Layout intent with a fixed key order (align, direction, columns, width,
 * density) so serialization is deterministic. Undefined when absent or invalid.
 * Shared by documents and higher-level contracts (e.g. composition plans) so
 * the bounds live in exactly one place.
 */
export function normalizeCanonicalLayoutIntent(value: unknown): CanonicalLayoutIntent | undefined {
  if (!isValidLayoutIntent(value)) return undefined;
  const normalized: CanonicalLayoutIntent = {};
  if (value.align !== undefined) normalized.align = value.align;
  if (value.direction !== undefined) normalized.direction = value.direction;
  if (value.columns !== undefined) normalized.columns = value.columns;
  if (value.width !== undefined) normalized.width = value.width;
  if (value.density !== undefined) normalized.density = value.density;
  return normalized;
}

/** Normalized layout intent of a block, or undefined when absent/invalid. */
export function canonicalLayoutIntentOf(block: CanonicalBlock): CanonicalLayoutIntent | undefined {
  return normalizeCanonicalLayoutIntent(block.attrs?.layout);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const TYPE_RE = /^[a-z][A-Za-z0-9]*(?:[/_-][A-Za-z0-9]+)*$/;
const CMS_RE = /^[a-z][a-z0-9_-]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isValidId(value: unknown): boolean {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && ID_RE.test(value);
}

function isValidType(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TYPE_LENGTH && TYPE_RE.test(value);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function isValidLayoutIntent(value: unknown): value is CanonicalLayoutIntent {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (!LAYOUT_KEYS.has(key)) return false;
  }
  if (value.align !== undefined && !LAYOUT_ALIGNMENT_SET.has(value.align as string)) return false;
  if (value.direction !== undefined && !LAYOUT_DIRECTION_SET.has(value.direction as string)) return false;
  if (value.width !== undefined && !LAYOUT_WIDTH_SET.has(value.width as string)) return false;
  if (value.density !== undefined && !LAYOUT_DENSITY_SET.has(value.density as string)) return false;
  if (value.columns !== undefined) {
    const columns = value.columns;
    if (
      typeof columns !== 'number' ||
      !Number.isInteger(columns) ||
      columns < 1 ||
      columns > CANONICAL_MAX_LAYOUT_COLUMNS
    ) {
      return false;
    }
  }
  return true;
}

function isValidVariant(type: string, variant: unknown): boolean {
  const allowed = (CANONICAL_BLOCK_VARIANTS as Record<string, readonly string[]>)[type];
  if (!allowed) return true;
  return typeof variant === 'string' && allowed.includes(variant);
}

/**
 * Composition attrs must stay inside the per-type whitelist: this is what makes
 * arbitrary CSS (`style`, `color`, `margin`, ...) structurally invalid rather
 * than merely discouraged.
 */
function isValidCompositionAttrs(type: string, attrs: Record<string, unknown>): boolean {
  const allowed = COMPOSITION_ATTR_KEYS.get(type);
  if (!allowed) return false;
  for (const key of Object.keys(attrs)) {
    if (!allowed.has(key)) return false;
  }
  if (attrs.variant !== undefined && !isValidVariant(type, attrs.variant)) return false;
  if (attrs.layout !== undefined && !isValidLayoutIntent(attrs.layout)) return false;
  if (attrs.icon !== undefined && !isBoundedString(attrs.icon, MAX_ICON_LENGTH)) return false;
  if (attrs.value !== undefined && !isBoundedString(attrs.value, MAX_VALUE_LENGTH)) return false;
  if (attrs.href !== undefined) {
    if (!isBoundedString(attrs.href, MAX_HREF_LENGTH) || attrs.href.trim().length === 0) return false;
  }
  return true;
}

function isValidDesignSystemRef(value: unknown): value is CanonicalDesignSystemRef {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (key !== 'id' && key !== 'variant' && key !== 'version') return false;
  }
  if (value.id !== undefined && (!isBoundedString(value.id, MAX_DESIGN_SYSTEM_REF_LENGTH) || value.id.trim().length === 0)) {
    return false;
  }
  if (value.variant !== undefined && !isBoundedString(value.variant, MAX_DESIGN_SYSTEM_REF_LENGTH)) return false;
  if (value.version !== undefined && !isBoundedString(value.version, MAX_DESIGN_SYSTEM_REF_LENGTH)) return false;
  return true;
}

function isValidSourceRef(value: unknown): value is SourceRef {
  if (!isPlainObject(value)) return false;
  const cms = value.cms;
  if (typeof cms !== 'string' || cms.length === 0 || cms.length > 40 || !CMS_RE.test(cms)) return false;
  if (value.type !== undefined && !isValidType(value.type)) return false;
  if (value.attrs !== undefined && !isPlainObject(value.attrs)) return false;
  if (value.attrsRaw !== undefined && typeof value.attrsRaw !== 'string') return false;
  if (value.innerContent !== undefined) {
    if (!Array.isArray(value.innerContent)) return false;
    if (!value.innerContent.every((part) => part === null || typeof part === 'string')) return false;
  }
  return true;
}

function isValidCanonicalMark(value: unknown): value is CanonicalMark {
  if (!isPlainObject(value)) return false;
  if (!isValidType(value.type)) return false;
  if (value.attrs !== undefined && !isPlainObject(value.attrs)) return false;
  if (value.type === 'link') {
    const attrs = value.attrs;
    if (!isPlainObject(attrs)) return false;
    const href = attrs.href;
    if (typeof href !== 'string' || href.trim().length === 0 || href.length > 4096) return false;
    if (attrs.rel !== undefined && typeof attrs.rel !== 'string') return false;
    if (attrs.target !== undefined && typeof attrs.target !== 'string') return false;
  }
  return true;
}

function isValidCanonicalInline(value: unknown): value is CanonicalInline {
  if (!isPlainObject(value)) return false;
  switch (value.type) {
    case 'text':
      if (typeof value.text !== 'string') return false;
      if (value.marks !== undefined) {
        if (!Array.isArray(value.marks) || !value.marks.every(isValidCanonicalMark)) return false;
      }
      return true;
    case 'break':
      return true;
    case 'inlineUnsupported':
      if (value.raw !== undefined && typeof value.raw !== 'string') return false;
      if (value.source !== undefined && !isValidSourceRef(value.source)) return false;
      return true;
    default:
      return false;
  }
}

interface WalkState {
  depth: number;
  blocks: number;
}

function isValidCanonicalBlock(value: unknown, state: WalkState): value is CanonicalBlock {
  if (!isPlainObject(value)) return false;
  if (state.depth > MAX_DEPTH) return false;
  if (++state.blocks > CANONICAL_MAX_BLOCKS) return false;

  if (value.id !== undefined && !isValidId(value.id)) return false;
  const blockType = value.type;
  if (!isValidType(blockType)) return false;
  if (value.attrs !== undefined) {
    if (!isPlainObject(value.attrs)) return false;
    for (const key of Object.keys(value.attrs)) {
      if (FORBIDDEN_CSS_ATTR_KEYS.has(key)) return false;
    }
    if (COMPOSITION_ATTR_KEYS.has(blockType) && !isValidCompositionAttrs(blockType, value.attrs)) return false;
  }
  if (value.rawHtml !== undefined && typeof value.rawHtml !== 'string') return false;
  if (value.source !== undefined && !isValidSourceRef(value.source)) return false;

  if (value.content !== undefined) {
    if (!Array.isArray(value.content) || !value.content.every(isValidCanonicalInline)) return false;
  }
  if (value.children !== undefined) {
    if (!Array.isArray(value.children)) return false;
    state.depth += 1;
    for (const child of value.children) {
      if (!isValidCanonicalBlock(child, state)) return false;
    }
    state.depth -= 1;
  }

  // Semantic shape checks for the types whose attributes drive rendering.
  if (value.type === 'heading') {
    const level = value.attrs?.level;
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6) return false;
  }
  if (value.type === 'list') {
    if (typeof value.attrs?.ordered !== 'boolean') return false;
    const start = value.attrs.start;
    if (start !== undefined && (typeof start !== 'number' || !Number.isInteger(start))) return false;
  }
  if (value.type === 'image') {
    const attrs = value.attrs ?? {};
    if (attrs.mediaId !== undefined && typeof attrs.mediaId !== 'string') return false;
    if (attrs.src !== undefined && typeof attrs.src !== 'string') return false;
    if (attrs.alt !== undefined && typeof attrs.alt !== 'string') return false;
    if (attrs.caption !== undefined && typeof attrs.caption !== 'string') return false;
    if (attrs.width !== undefined && typeof attrs.width !== 'number') return false;
    if (attrs.height !== undefined && typeof attrs.height !== 'number') return false;
  }
  return true;
}

/**
 * Recursive, structural validation. Rejects malformed documents before they
 * reach an adapter while still allowing unknown semantic types (the `custom`
 * escape hatch). Does not mutate its input.
 */
export function isValidCanonicalDoc(value: unknown): value is CanonicalDocument {
  if (!isPlainObject(value)) return false;
  if (value.version !== CANONICAL_DOCUMENT_VERSION) return false;
  if (!Array.isArray(value.blocks)) return false;

  if (value.meta !== undefined) {
    if (!isPlainObject(value.meta)) return false;
    if (value.meta.title !== undefined && typeof value.meta.title !== 'string') return false;
    if (value.meta.language !== undefined && value.meta.language !== null && typeof value.meta.language !== 'string') {
      return false;
    }
    if (value.meta.designSystem !== undefined && !isValidDesignSystemRef(value.meta.designSystem)) return false;
  }

  const state: WalkState = { depth: 0, blocks: 0 };
  for (const block of value.blocks) {
    if (!isValidCanonicalBlock(block, state)) return false;
  }
  return true;
}
