/**
 * Cosmos: project-level editorial/brand configuration.
 *
 * Cosmos is configuration, not an agent - it never generates content. It holds
 * bounded, human-authored guidance (identity, voice, editorial rules, SEO
 * defaults, knowledge usage) that AI features read as context. It is stored in
 * `seo_projects.settings.cosmos` so it needs no schema migration and stays
 * separate from Core Topics (`settings.coreTopics`) and the article itself.
 *
 * The normalizer is intentionally forgiving: unknown/extra keys are dropped,
 * non-strings become empty, and every field is capped - so a hand-edited row can
 * never blow up an AI prompt or leak unrelated state.
 */

export const COSMOS_SECTION_IDS = ['identity', 'voice', 'editorial', 'seo', 'knowledge'] as const;
export type CosmosSectionId = (typeof COSMOS_SECTION_IDS)[number];

/** Per-field character cap. Bounded so Cosmos always fits a small, cheap prompt. */
export const COSMOS_FIELD_MAX_CHARS = 2000;

/** Hard cap on the rendered Cosmos context block handed to the AI. */
export const COSMOS_CONTEXT_MAX_CHARS = 4000;

export interface CosmosIdentity {
  /** Site/project name as it should appear to readers. */
  name: string;
  /** Positioning / what the site is about. */
  description: string;
  /** Who the content is written for. */
  audience: string;
}

export interface CosmosVoice {
  tone: string;
  formality: string;
  personality: string;
  /** Preferred vocabulary / terms to favour. */
  vocabulary: string;
}

export interface CosmosEditorial {
  writingRules: string;
  preferredStructure: string;
  articleCharacteristics: string;
  /** Forbidden patterns / terminology. */
  forbidden: string;
}

export interface CosmosSeo {
  rules: string;
  searchIntent: string;
  internalLinking: string;
}

export interface CosmosKnowledge {
  /** Free-form guidance on how knowledge should be used. */
  notes: string;
  /** When true (default), project knowledge may be offered as reference. */
  useProjectKnowledge: boolean;
}

// ---------------------------------------------------------------------------
// Design system tokens (Stage 5)
// ---------------------------------------------------------------------------

/**
 * Bounded, semantic visual intent. Cosmos never carries raw CSS: values are a
 * hex palette, a font family (safe charset, bounded length), a font weight from
 * a fixed set, and spacing/radius/elevation presets. The renderer expands these
 * over safe defaults into concrete `--cosmos-*` custom properties, so one
 * Canonical document can take on a project's brand without changing.
 */
export const COSMOS_DESIGN_COLOR_KEYS = [
  'primary',
  'secondary',
  'accent',
  'background',
  'surface',
  'text',
  'muted',
  'border',
  'success',
  'warning',
  'danger',
] as const;

export type CosmosDesignColorKey = (typeof COSMOS_DESIGN_COLOR_KEYS)[number];
export type CosmosDesignColors = Partial<Record<CosmosDesignColorKey, string>>;

export const COSMOS_FONT_WEIGHTS = [300, 400, 500, 600, 700, 800] as const;
export type CosmosFontWeight = (typeof COSMOS_FONT_WEIGHTS)[number];

export const COSMOS_HEADING_SCALES = ['compact', 'default', 'large'] as const;
export type CosmosHeadingScale = (typeof COSMOS_HEADING_SCALES)[number];

export const COSMOS_BODY_SIZES = ['sm', 'md', 'lg'] as const;
export type CosmosBodySize = (typeof COSMOS_BODY_SIZES)[number];

export interface CosmosDesignTypography {
  headingFamily?: string;
  bodyFamily?: string;
  headingWeight?: CosmosFontWeight;
  bodyWeight?: CosmosFontWeight;
  headingScale?: CosmosHeadingScale;
  bodySize?: CosmosBodySize;
  /** Unitless line height, bounded to a readable range (1.0 - 2.2). */
  lineHeight?: number;
}

export const COSMOS_SPACING_SCALES = ['compact', 'comfortable', 'spacious'] as const;
export type CosmosSpacingScale = (typeof COSMOS_SPACING_SCALES)[number];

export const COSMOS_RADIUS_SCALES = ['none', 'small', 'medium', 'large'] as const;
export type CosmosRadiusScale = (typeof COSMOS_RADIUS_SCALES)[number];

export const COSMOS_ELEVATIONS = ['none', 'subtle', 'medium', 'strong'] as const;
export type CosmosElevation = (typeof COSMOS_ELEVATIONS)[number];

export interface CosmosDesign {
  colors?: CosmosDesignColors;
  typography?: CosmosDesignTypography;
  spacingScale?: CosmosSpacingScale;
  radiusScale?: CosmosRadiusScale;
  elevation?: CosmosElevation;
}

/** Max font-family length; the charset is restricted so it can never carry CSS. */
export const COSMOS_FONT_FAMILY_MAX_CHARS = 120;

const COSMOS_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const COSMOS_FONT_FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 ,"'-]*$/;
const COSMOS_MIN_LINE_HEIGHT = 1;
const COSMOS_MAX_LINE_HEIGHT = 2.2;

export interface CosmosConfig {
  identity: CosmosIdentity;
  voice: CosmosVoice;
  editorial: CosmosEditorial;
  seo: CosmosSeo;
  knowledge: CosmosKnowledge;
  design: CosmosDesign;
}

/** A blank, fully-populated Cosmos config (never null/undefined fields). */
export function emptyCosmosConfig(): CosmosConfig {
  return {
    identity: { name: '', description: '', audience: '' },
    voice: { tone: '', formality: '', personality: '', vocabulary: '' },
    editorial: { writingRules: '', preferredStructure: '', articleCharacteristics: '', forbidden: '' },
    seo: { rules: '', searchIntent: '', internalLinking: '' },
    knowledge: { notes: '', useProjectKnowledge: true },
    design: {},
  };
}

function boundedString(value: unknown, max = COSMOS_FIELD_MAX_CHARS): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function section(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function boundedEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function boundedFontWeight(value: unknown): CosmosFontWeight | undefined {
  return typeof value === 'number' && (COSMOS_FONT_WEIGHTS as readonly number[]).includes(value)
    ? (value as CosmosFontWeight)
    : undefined;
}

function boundedColor(value: unknown): string | undefined {
  return typeof value === 'string' && COSMOS_COLOR_RE.test(value) ? value : undefined;
}

function boundedFontFamily(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > COSMOS_FONT_FAMILY_MAX_CHARS) return undefined;
  return COSMOS_FONT_FAMILY_RE.test(trimmed) ? trimmed : undefined;
}

function boundedLineHeight(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= COSMOS_MIN_LINE_HEIGHT &&
    value <= COSMOS_MAX_LINE_HEIGHT
    ? value
    : undefined;
}

/**
 * Bounds and normalizes the design section. Only known keys survive and every
 * value is validated, so a hand-edited row can never smuggle CSS into the
 * renderer-facing token model.
 */
export function parseCosmosDesign(value: unknown): CosmosDesign {
  const root = section(value);
  const design: CosmosDesign = {};

  const colorsIn = section(root.colors);
  const colors: CosmosDesignColors = {};
  for (const key of COSMOS_DESIGN_COLOR_KEYS) {
    const color = boundedColor(colorsIn[key]);
    if (color !== undefined) colors[key] = color;
  }
  if (Object.keys(colors).length > 0) design.colors = colors;

  const typographyIn = section(root.typography);
  const typography: CosmosDesignTypography = {};
  const headingFamily = boundedFontFamily(typographyIn.headingFamily);
  if (headingFamily !== undefined) typography.headingFamily = headingFamily;
  const bodyFamily = boundedFontFamily(typographyIn.bodyFamily);
  if (bodyFamily !== undefined) typography.bodyFamily = bodyFamily;
  const headingWeight = boundedFontWeight(typographyIn.headingWeight);
  if (headingWeight !== undefined) typography.headingWeight = headingWeight;
  const bodyWeight = boundedFontWeight(typographyIn.bodyWeight);
  if (bodyWeight !== undefined) typography.bodyWeight = bodyWeight;
  const headingScale = boundedEnum(typographyIn.headingScale, COSMOS_HEADING_SCALES);
  if (headingScale !== undefined) typography.headingScale = headingScale;
  const bodySize = boundedEnum(typographyIn.bodySize, COSMOS_BODY_SIZES);
  if (bodySize !== undefined) typography.bodySize = bodySize;
  const lineHeight = boundedLineHeight(typographyIn.lineHeight);
  if (lineHeight !== undefined) typography.lineHeight = lineHeight;
  if (Object.keys(typography).length > 0) design.typography = typography;

  const spacingScale = boundedEnum(root.spacingScale, COSMOS_SPACING_SCALES);
  if (spacingScale !== undefined) design.spacingScale = spacingScale;
  const radiusScale = boundedEnum(root.radiusScale, COSMOS_RADIUS_SCALES);
  if (radiusScale !== undefined) design.radiusScale = radiusScale;
  const elevation = boundedEnum(root.elevation, COSMOS_ELEVATIONS);
  if (elevation !== undefined) design.elevation = elevation;

  return design;
}

/** True when the design section carries no token at all. */
export function isEmptyCosmosDesign(design: CosmosDesign): boolean {
  return (
    (!design.colors || Object.keys(design.colors).length === 0) &&
    (!design.typography || Object.keys(design.typography).length === 0) &&
    design.spacingScale === undefined &&
    design.radiusScale === undefined &&
    design.elevation === undefined
  );
}

/**
 * Normalizes an arbitrary stored/request value into a complete CosmosConfig.
 * Missing sections and fields become empty strings; `useProjectKnowledge`
 * defaults to true only when it is not an explicit boolean.
 */
export function parseCosmosConfig(value: unknown): CosmosConfig {
  const root = section(value);
  const identity = section(root.identity);
  const voice = section(root.voice);
  const editorial = section(root.editorial);
  const seo = section(root.seo);
  const knowledge = section(root.knowledge);
  return {
    identity: {
      name: boundedString(identity.name),
      description: boundedString(identity.description),
      audience: boundedString(identity.audience),
    },
    voice: {
      tone: boundedString(voice.tone),
      formality: boundedString(voice.formality),
      personality: boundedString(voice.personality),
      vocabulary: boundedString(voice.vocabulary),
    },
    editorial: {
      writingRules: boundedString(editorial.writingRules),
      preferredStructure: boundedString(editorial.preferredStructure),
      articleCharacteristics: boundedString(editorial.articleCharacteristics),
      forbidden: boundedString(editorial.forbidden),
    },
    seo: {
      rules: boundedString(seo.rules),
      searchIntent: boundedString(seo.searchIntent),
      internalLinking: boundedString(seo.internalLinking),
    },
    knowledge: {
      notes: boundedString(knowledge.notes),
      useProjectKnowledge:
        typeof knowledge.useProjectKnowledge === 'boolean' ? knowledge.useProjectKnowledge : true,
    },
    design: parseCosmosDesign(root.design),
  };
}

/** True when the config carries no guidance at all (empty strings + default flag). */
export function isEmptyCosmosConfig(config: CosmosConfig): boolean {
  const { knowledge, design, ...sections } = config;
  return (
    Object.values(sections).every((fields) => Object.values(fields).every((field) => field === '')) &&
    knowledge.notes === '' &&
    knowledge.useProjectKnowledge &&
    isEmptyCosmosDesign(design)
  );
}
