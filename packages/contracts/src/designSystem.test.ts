import { describe, expect, it } from 'vitest';
import {
  COSMOS_DESIGN_COLOR_KEYS,
  emptyCosmosConfig,
  isEmptyCosmosConfig,
  parseCosmosConfig,
  parseCosmosDesign,
} from './cosmos.js';
import {
  DEFAULT_DESIGN_SYSTEM,
  designSystemCssVariables,
  resolveDesignSystem,
} from './designSystem.js';

describe('resolveDesignSystem', () => {
  it('returns the safe defaults when Cosmos supplies nothing', () => {
    const ds = resolveDesignSystem();
    expect(ds).toEqual(DEFAULT_DESIGN_SYSTEM);
    expect(ds.colors).toHaveProperty('primary');
    expect(ds.typography.headingScale.h1).toBeTruthy();
    expect(ds.spacing).toHaveProperty('2xl');
    expect(ds.shape).toHaveProperty('card');
    expect(ds.effects).toHaveProperty('elevated');
    expect(ds.layout.containerWidth).toBe(DEFAULT_DESIGN_SYSTEM.layout.containerWidth);
    expect(ds.layout.readingWidth).toBe(DEFAULT_DESIGN_SYSTEM.layout.readingWidth);
  });

  it('applies Cosmos overrides and keeps unspecified tokens at their default', () => {
    const ds = resolveDesignSystem({
      colors: { primary: '#111111', accent: '#222222' },
      typography: { headingFamily: 'Georgia', headingWeight: 700, lineHeight: 1.9 },
      spacingScale: 'spacious',
      radiusScale: 'large',
      elevation: 'strong',
    });
    expect(ds.colors.primary).toBe('#111111');
    expect(ds.colors.accent).toBe('#222222');
    expect(ds.colors.text).toBe(DEFAULT_DESIGN_SYSTEM.colors.text);
    expect(ds.typography.headingFamily).toBe('Georgia');
    expect(ds.typography.bodyFamily).toBe(DEFAULT_DESIGN_SYSTEM.typography.bodyFamily);
    expect(ds.typography.headingWeight).toBe(700);
    expect(ds.typography.lineHeight).toBe(1.9);
    expect(ds.spacing).toEqual(resolveDesignSystem({ spacingScale: 'spacious' }).spacing);
    expect(ds.spacing.md).not.toBe(DEFAULT_DESIGN_SYSTEM.spacing.md);
    expect(ds.shape).toEqual(resolveDesignSystem({ radiusScale: 'large' }).shape);
    expect(ds.effects).toEqual(resolveDesignSystem({ elevation: 'strong' }).effects);
  });

  it('falls back to defaults for invalid or malformed tokens', () => {
    const ds = resolveDesignSystem({
      colors: { primary: 'red; background: url(evil)', surface: 42 },
      typography: { headingFamily: 'Bad; }', headingWeight: 999, lineHeight: 99 },
      spacingScale: 'gigantic',
      radiusScale: 'huge',
      elevation: 'apocalyptic',
    });
    expect(ds.colors.primary).toBe(DEFAULT_DESIGN_SYSTEM.colors.primary);
    expect(ds.colors.surface).toBe(DEFAULT_DESIGN_SYSTEM.colors.surface);
    expect(ds.typography.headingFamily).toBe(DEFAULT_DESIGN_SYSTEM.typography.headingFamily);
    expect(ds.typography.headingWeight).toBe(DEFAULT_DESIGN_SYSTEM.typography.headingWeight);
    expect(ds.typography.lineHeight).toBe(DEFAULT_DESIGN_SYSTEM.typography.lineHeight);
    expect(ds.spacing).toEqual(DEFAULT_DESIGN_SYSTEM.spacing);
    expect(ds.shape).toEqual(DEFAULT_DESIGN_SYSTEM.shape);
    expect(ds.effects).toEqual(DEFAULT_DESIGN_SYSTEM.effects);
  });

  it('is deterministic', () => {
    const input = { colors: { primary: '#0b5fff' }, spacingScale: 'compact' as const };
    expect(resolveDesignSystem(input)).toEqual(resolveDesignSystem(input));
    expect(designSystemCssVariables(resolveDesignSystem(input))).toEqual(
      designSystemCssVariables(resolveDesignSystem(input)),
    );
  });

  it('does not mutate the defaults', () => {
    const before = structuredClone(DEFAULT_DESIGN_SYSTEM);
    const ds = resolveDesignSystem({ colors: { primary: '#000000' }, elevation: 'none' });
    ds.colors.primary = '#ffffff';
    expect(DEFAULT_DESIGN_SYSTEM).toEqual(before);
  });
});

describe('designSystemCssVariables', () => {
  it('emits one scoped custom property per token with a stable key order', () => {
    const vars = designSystemCssVariables(resolveDesignSystem({ colors: { primary: '#123456' } }));
    expect(vars['--cosmos-color-primary']).toBe('#123456');
    expect(vars['--cosmos-space-md']).toBe(DEFAULT_DESIGN_SYSTEM.spacing.md);
    expect(vars['--cosmos-radius-card']).toBe(DEFAULT_DESIGN_SYSTEM.shape.card);
    expect(vars['--cosmos-shadow-elevated']).toBe(DEFAULT_DESIGN_SYSTEM.effects.elevated);
    expect(vars['--cosmos-font-size-h1']).toBe(DEFAULT_DESIGN_SYSTEM.typography.headingScale.h1);
    expect(vars['--cosmos-container-width']).toBe(DEFAULT_DESIGN_SYSTEM.layout.containerWidth);
    expect(vars['--cosmos-reading-width']).toBe(DEFAULT_DESIGN_SYSTEM.layout.readingWidth);
    for (const key of COSMOS_DESIGN_COLOR_KEYS) {
      expect(vars).toHaveProperty(`--cosmos-color-${key}`);
    }
    expect(Object.keys(vars)).toEqual([...Object.keys(designSystemCssVariables(DEFAULT_DESIGN_SYSTEM))]);
  });

  it('reflects token changes without touching the document', () => {
    const a = designSystemCssVariables(resolveDesignSystem({ colors: { primary: '#111111' } }));
    const b = designSystemCssVariables(resolveDesignSystem({ colors: { primary: '#222222' } }));
    expect(a['--cosmos-color-primary']).not.toBe(b['--cosmos-color-primary']);
    expect(Object.keys(a)).toEqual(Object.keys(b));
  });
});

describe('Cosmos design parsing', () => {
  it('keeps the design section on the config and drops unknown keys', () => {
    const config = parseCosmosConfig({
      identity: { name: 'Acme' },
      design: {
        colors: { primary: '#0a0a0a', rogue: '#ffffff' },
        spacingScale: 'compact',
        unknown: 'x',
      },
    });
    expect(config.design.colors?.primary).toBe('#0a0a0a');
    expect(config.design.colors).not.toHaveProperty('rogue');
    expect(config.design.spacingScale).toBe('compact');
    expect(config.design).not.toHaveProperty('unknown');
    expect(Object.keys(config)).toEqual(['identity', 'voice', 'editorial', 'seo', 'knowledge', 'design']);
  });

  it('bounds design values so CSS cannot leak through', () => {
    const design = parseCosmosDesign({
      colors: { primary: 'url(javascript:alert(1))', danger: '#dc2626' },
      typography: { headingFamily: 'x'.repeat(200), bodyFamily: 'Poppins, sans-serif', bodyWeight: 600 },
    });
    expect(design.colors?.primary).toBeUndefined();
    expect(design.colors?.danger).toBe('#dc2626');
    expect(design.typography?.headingFamily).toBeUndefined();
    expect(design.typography?.bodyFamily).toBe('Poppins, sans-serif');
    expect(design.typography?.bodyWeight).toBe(600);
  });

  it('treats a design-only blank config as empty', () => {
    expect(isEmptyCosmosConfig(emptyCosmosConfig())).toBe(true);
    expect(isEmptyCosmosConfig(parseCosmosConfig({ design: {} }))).toBe(true);
    expect(isEmptyCosmosConfig(parseCosmosConfig({ design: { colors: { primary: '#111111' } } }))).toBe(false);
    expect(isEmptyCosmosConfig(parseCosmosConfig({ design: { spacingScale: 'compact' } }))).toBe(false);
  });
});
