/**
 * Writer format registry tests (W1): the registry is code-owned and closed
 * (only known format ids resolve), every format's declared bounds are
 * consistent, and the deterministic validator is the deny-by-default gate on a
 * produced plan - it rejects an out-of-range section count, a duplicate or
 * empty heading and a missing title without touching any AI. The composed
 * outline guidance always carries the format's own rules plus one bounded word
 * target.
 */

import { describe, expect, it } from 'vitest';
import type { ArticlePlan } from '@seo/contracts';
import {
  getWriterFormat,
  isFormatDefinitionConsistent,
  listWriterFormats,
  outlineGuidanceFor,
} from './formats.js';

function plan(sectionCount: number, overrides: Partial<ArticlePlan> = {}): ArticlePlan {
  return {
    title: 'Blue widgets explained',
    intent: 'Explain blue widgets',
    primaryKeyword: 'blue widgets',
    format: 'short_article',
    sections: Array.from({ length: sectionCount }, (_, index) => ({
      heading: `Section ${index + 1}`,
      purpose: `Purpose ${index + 1}`,
      keywords: [`kw${index + 1}`],
    })),
    ...overrides,
  };
}

describe('writer format registry', () => {
  it('resolves only registered formats', () => {
    expect(getWriterFormat('short_article')?.id).toBe('short_article');
    expect(getWriterFormat('explainer')?.id).toBe('explainer');
    expect(getWriterFormat('nope')).toBeNull();
  });

  it('ships only consistent format definitions', () => {
    const formats = listWriterFormats();
    expect(formats.map((format) => format.id).sort()).toEqual(['explainer', 'short_article']);
    for (const format of formats) {
      expect(isFormatDefinitionConsistent(format)).toBe(true);
      expect(format.outlineGuidance.length).toBeGreaterThan(0);
    }
  });

  it('accepts a plan within the format bounds', () => {
    const format = getWriterFormat('short_article')!;
    expect(format.validate(plan(3))).toEqual({ ok: true, note: null });
    expect(format.validate(plan(5))).toEqual({ ok: true, note: null });
  });

  it('rejects a plan outside the format section bounds', () => {
    const format = getWriterFormat('short_article')!;
    const tooFew = format.validate(plan(2));
    const tooMany = format.validate(plan(6));
    expect(tooFew.ok).toBe(false);
    expect(tooMany.ok).toBe(false);
  });

  it('rejects a plan without a title', () => {
    const format = getWriterFormat('explainer')!;
    expect(format.validate(plan(4, { title: '   ' })).ok).toBe(false);
  });

  it('rejects duplicate or empty headings', () => {
    const format = getWriterFormat('explainer')!;
    const duplicate = plan(4);
    duplicate.sections[1]!.heading = duplicate.sections[0]!.heading;
    expect(format.validate(duplicate).ok).toBe(false);

    const empty = plan(4);
    empty.sections[0]!.heading = '  ';
    expect(format.validate(empty).ok).toBe(false);
  });

  it('composes the format rules with a bounded word target', () => {
    const format = getWriterFormat('explainer')!;
    const defaulted = outlineGuidanceFor(format);
    expect(defaulted).toContain(format.outlineGuidance);
    expect(defaulted).toContain(String(format.recommendedTargetLength));

    const requested = outlineGuidanceFor(format, 1500);
    expect(requested).toContain('1500');

    const ignored = outlineGuidanceFor(format, Number.NaN);
    expect(ignored).toContain(String(format.recommendedTargetLength));
  });
});
