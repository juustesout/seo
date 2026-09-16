/**
 * Pure presentation mapping for the canonical renderer.
 *
 * These functions translate bounded semantic intent (variants + the validated
 * layout intent) into renderer-owned class tokens. They contain no CSS values
 * and never mutate the document, so they can be unit-tested deterministically
 * and keep the React renderers thin.
 */

import {
  CANONICAL_MAX_LAYOUT_COLUMNS,
  canonicalLayoutIntentOf,
  canonicalVariantOf,
  type CanonicalBlock,
  type CanonicalLayoutIntent,
} from '@seo/contracts';

/** Join truthy class fragments. */
export function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ');
}

function clampColumns(columns: number): number {
  if (!Number.isFinite(columns)) return 1;
  return Math.min(CANONICAL_MAX_LAYOUT_COLUMNS, Math.max(1, Math.trunc(columns)));
}

/** Target-neutral layout intent to renderer tokens (no raw CSS values). */
export function layoutClassNames(intent: CanonicalLayoutIntent | undefined): string[] {
  if (!intent) return [];
  const out: string[] = [];
  if (intent.align) out.push(`cosmos-align-${intent.align}`);
  if (intent.direction) out.push(`cosmos-direction-${intent.direction}`);
  if (intent.width) out.push(`cosmos-width-${intent.width}`);
  if (intent.density) out.push(`cosmos-density-${intent.density}`);
  if (typeof intent.columns === 'number') out.push(...columnsClassNames(intent.columns));
  return out;
}

/**
 * Renderer-owned responsive strategy: a bounded column count becomes a
 * one-column base, two columns on small screens and the full count on large
 * screens. The CanonicalDocument never carries a breakpoint.
 */
export function responsiveColumnsStrategy(columns: number): { base: number; sm: number; lg: number } {
  const n = clampColumns(columns);
  if (n <= 1) return { base: 1, sm: 1, lg: 1 };
  if (n === 2) return { base: 1, sm: 2, lg: 2 };
  return { base: 1, sm: 2, lg: n };
}

export function columnsClassNames(columns: number): string[] {
  return [`cosmos-columns-${clampColumns(columns)}`];
}

/** Semantic variant to renderer token (`hero` + `split` -> `cosmos-hero--split`). */
export function variantClassNames(type: string, variant: string | undefined): string[] {
  return variant ? [`cosmos-${type}--${variant}`] : [];
}

/** Base + type + validated variant/layout tokens for any block. */
export function blockClassNames(block: CanonicalBlock): string[] {
  const variant = canonicalVariantOf(block);
  const layout = canonicalLayoutIntentOf(block);
  return [
    'cosmos-block',
    `cosmos-${block.type}`,
    ...variantClassNames(block.type, variant),
    ...layoutClassNames(layout),
  ];
}
