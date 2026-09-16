/**
 * Resolved, renderer-facing design system (Stage 5).
 *
 * Cosmos carries bounded, semantic visual intent (a hex palette, a font family,
 * a weight, and spacing/radius/elevation presets). This module expands that
 * intent over safe defaults into the concrete values a renderer consumes and
 * emits as `--cosmos-*` CSS custom properties scoped to one rendered document.
 *
 * The renderer owns presentation: Canonical blocks say `hero / split / width=wide`
 * and this model says what those mean visually. Nothing here is ever written
 * back into a CanonicalDocument.
 */

import { COSMOS_DESIGN_COLOR_KEYS, parseCosmosDesign } from './cosmos.js';
import type {
  CosmosBodySize,
  CosmosDesignColorKey,
  CosmosElevation,
  CosmosHeadingScale,
  CosmosRadiusScale,
  CosmosSpacingScale,
} from './cosmos.js';

export type DesignSystemColors = Record<CosmosDesignColorKey, string>;

export interface DesignSystemHeadingScale {
  h1: string;
  h2: string;
  h3: string;
  h4: string;
  h5: string;
  h6: string;
}

export interface DesignSystemTypography {
  headingFamily: string;
  bodyFamily: string;
  headingWeight: number;
  bodyWeight: number;
  /** Font-size tokens per heading level. */
  headingScale: DesignSystemHeadingScale;
  bodySize: string;
  lineHeight: number;
}

export interface DesignSystemSpacing {
  xs: string;
  sm: string;
  md: string;
  lg: string;
  xl: string;
  '2xl': string;
}

export interface DesignSystemShape {
  sm: string;
  card: string;
  button: string;
}

export interface DesignSystemEffects {
  card: string;
  elevated: string;
}

export interface DesignSystemLayout {
  /** Maximum width of the centered document content column. */
  containerWidth: string;
  /** Boundary for readable running text (headings/paragraphs/lists). */
  readingWidth: string;
}

export interface DesignSystem {
  colors: DesignSystemColors;
  typography: DesignSystemTypography;
  spacing: DesignSystemSpacing;
  shape: DesignSystemShape;
  effects: DesignSystemEffects;
  layout: DesignSystemLayout;
}

const SANS_FALLBACK =
  "'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const SPACING_SCALES: Record<CosmosSpacingScale, DesignSystemSpacing> = {
  compact: { xs: '0.25rem', sm: '0.5rem', md: '0.75rem', lg: '1rem', xl: '1.75rem', '2xl': '2.5rem' },
  comfortable: { xs: '0.375rem', sm: '0.625rem', md: '1rem', lg: '1.5rem', xl: '2.5rem', '2xl': '4rem' },
  spacious: { xs: '0.5rem', sm: '0.875rem', md: '1.5rem', lg: '2.25rem', xl: '3.5rem', '2xl': '5.5rem' },
};

const HEADING_SCALES: Record<CosmosHeadingScale, DesignSystemHeadingScale> = {
  compact: { h1: '2rem', h2: '1.5rem', h3: '1.25rem', h4: '1.125rem', h5: '1rem', h6: '0.875rem' },
  default: { h1: '2.5rem', h2: '2rem', h3: '1.5rem', h4: '1.25rem', h5: '1.125rem', h6: '1rem' },
  large: { h1: '3.25rem', h2: '2.5rem', h3: '1.875rem', h4: '1.5rem', h5: '1.25rem', h6: '1.125rem' },
};

const RADIUS_SCALES: Record<CosmosRadiusScale, DesignSystemShape> = {
  none: { sm: '0', card: '0', button: '0' },
  small: { sm: '0.25rem', card: '0.375rem', button: '0.25rem' },
  medium: { sm: '0.375rem', card: '0.625rem', button: '0.5rem' },
  large: { sm: '0.75rem', card: '1rem', button: '9999px' },
};

const ELEVATIONS: Record<CosmosElevation, DesignSystemEffects> = {
  none: { card: 'none', elevated: 'none' },
  subtle: { card: '0 1px 2px rgba(16, 24, 40, 0.06)', elevated: '0 4px 12px rgba(16, 24, 40, 0.10)' },
  medium: { card: '0 1px 3px rgba(16, 24, 40, 0.10)', elevated: '0 10px 24px rgba(16, 24, 40, 0.14)' },
  strong: { card: '0 2px 6px rgba(16, 24, 40, 0.16)', elevated: '0 18px 40px rgba(16, 24, 40, 0.24)' },
};

const BODY_SIZES: Record<CosmosBodySize, string> = {
  sm: '0.9375rem',
  md: '1.0625rem',
  lg: '1.1875rem',
};

const DEFAULT_COLORS: DesignSystemColors = {
  primary: '#2563eb',
  secondary: '#f4f6f8',
  accent: '#eff6ff',
  background: '#ffffff',
  surface: '#ffffff',
  text: '#1d2939',
  muted: '#667085',
  border: '#e5e7eb',
  success: '#16a34a',
  warning: '#d97706',
  danger: '#dc2626',
};

/** The safe fallback used whenever Cosmos supplies nothing (or an invalid value). */
export const DEFAULT_DESIGN_SYSTEM: DesignSystem = {
  colors: DEFAULT_COLORS,
  typography: {
    headingFamily: SANS_FALLBACK,
    bodyFamily: SANS_FALLBACK,
    headingWeight: 600,
    bodyWeight: 400,
    headingScale: HEADING_SCALES.default,
    bodySize: BODY_SIZES.md,
    lineHeight: 1.65,
  },
  spacing: SPACING_SCALES.comfortable,
  shape: RADIUS_SCALES.medium,
  effects: ELEVATIONS.subtle,
  layout: {
    containerWidth: '72rem',
    readingWidth: '42rem',
  },
};

/**
 * Deterministically expands raw Cosmos design input (already bounded by
 * `parseCosmosDesign`, re-parsed here so the resolver is safe on its own) into a
 * complete DesignSystem. Missing or invalid tokens fall back to defaults.
 */
export function resolveDesignSystem(value?: unknown): DesignSystem {
  const design = parseCosmosDesign(value);

  const colors: DesignSystemColors = { ...DEFAULT_DESIGN_SYSTEM.colors };
  if (design.colors) {
    for (const key of COSMOS_DESIGN_COLOR_KEYS) {
      const color = design.colors[key];
      if (typeof color === 'string') colors[key] = color;
    }
  }

  const typography: DesignSystemTypography = {
    ...DEFAULT_DESIGN_SYSTEM.typography,
    headingScale: { ...DEFAULT_DESIGN_SYSTEM.typography.headingScale },
  };
  const raw = design.typography;
  if (raw) {
    if (raw.headingFamily) typography.headingFamily = raw.headingFamily;
    if (raw.bodyFamily) typography.bodyFamily = raw.bodyFamily;
    if (raw.headingWeight) typography.headingWeight = raw.headingWeight;
    if (raw.bodyWeight) typography.bodyWeight = raw.bodyWeight;
    if (raw.lineHeight) typography.lineHeight = raw.lineHeight;
    if (raw.bodySize) typography.bodySize = BODY_SIZES[raw.bodySize];
    if (raw.headingScale) typography.headingScale = { ...HEADING_SCALES[raw.headingScale] };
  }

  return {
    colors,
    typography,
    spacing: { ...SPACING_SCALES[design.spacingScale ?? 'comfortable'] },
    shape: { ...RADIUS_SCALES[design.radiusScale ?? 'medium'] },
    effects: { ...ELEVATIONS[design.elevation ?? 'subtle'] },
    layout: { ...DEFAULT_DESIGN_SYSTEM.layout },
  };
}

/**
 * Maps a resolved design system to the scoped `--cosmos-*` custom properties a
 * renderer container sets. Key order is fixed so the output is byte-stable.
 */
export function designSystemCssVariables(design: DesignSystem): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of COSMOS_DESIGN_COLOR_KEYS) {
    vars[`--cosmos-color-${key}`] = design.colors[key];
  }
  vars['--cosmos-font-heading'] = design.typography.headingFamily;
  vars['--cosmos-font-body'] = design.typography.bodyFamily;
  vars['--cosmos-font-weight-heading'] = String(design.typography.headingWeight);
  vars['--cosmos-font-weight-body'] = String(design.typography.bodyWeight);
  for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const) {
    vars[`--cosmos-font-size-${level}`] = design.typography.headingScale[level];
  }
  vars['--cosmos-font-size-body'] = design.typography.bodySize;
  vars['--cosmos-line-height'] = String(design.typography.lineHeight);
  for (const key of ['xs', 'sm', 'md', 'lg', 'xl', '2xl'] as const) {
    vars[`--cosmos-space-${key}`] = design.spacing[key];
  }
  vars['--cosmos-radius-sm'] = design.shape.sm;
  vars['--cosmos-radius-card'] = design.shape.card;
  vars['--cosmos-radius-button'] = design.shape.button;
  vars['--cosmos-shadow-card'] = design.effects.card;
  vars['--cosmos-shadow-elevated'] = design.effects.elevated;
  vars['--cosmos-container-width'] = design.layout.containerWidth;
  vars['--cosmos-reading-width'] = design.layout.readingWidth;
  return vars;
}
