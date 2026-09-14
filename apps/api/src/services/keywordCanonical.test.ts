/**
 * Deterministic keyword canonicalization + intent classification tests (KW5).
 * The consolidation must be spelling-only (casing, whitespace, hyphens) and
 * must never invent meaning; intent is a nullable word-list signal.
 */
import { describe, expect, it } from 'vitest';
import { canonicalKeywordKey, chooseCanonicalLabel, classifyIntent } from './keywordCanonical.js';

describe('canonicalKeywordKey', () => {
  it('folds casing, whitespace and hyphen variants of the same concept', () => {
    const variants = ['front end newsletter', 'Front-End Newsletter', 'frontend newsletter', '  FRONT_END   newsletter '];
    const keys = new Set(variants.map(canonicalKeywordKey));
    expect(keys.size).toBe(1);
  });

  it('treats apostrophes as separators without merging distinct punctuation', () => {
    expect(canonicalKeywordKey("don't")).toBe('dont');
    expect(canonicalKeywordKey('c++')).not.toBe(canonicalKeywordKey('c#'));
  });

  it('normalizes unicode compatibility forms', () => {
    expect(canonicalKeywordKey('ＣＲＭ')).toBe(canonicalKeywordKey('crm'));
  });

  it('is stable for the same input', () => {
    expect(canonicalKeywordKey('Blue Widgets')).toBe(canonicalKeywordKey('Blue Widgets'));
  });
});

describe('chooseCanonicalLabel', () => {
  it('prefers the most frequent spelling', () => {
    expect(
      chooseCanonicalLabel([
        { value: 'front end newsletter', count: 1 },
        { value: 'frontend newsletter', count: 3 },
        { value: 'front-end newsletter', count: 2 },
      ]),
    ).toBe('frontend newsletter');
  });

  it('breaks a frequency tie deterministically toward fewer separators', () => {
    expect(
      chooseCanonicalLabel([
        { value: 'front-end newsletter', count: 1 },
        { value: 'frontend newsletter', count: 1 },
      ]),
    ).toBe('frontend newsletter');
  });
});

describe('classifyIntent', () => {
  it('classifies transaction and commerce wording', () => {
    expect(classifyIntent('buy running shoes online')).toBe('transactional');
    expect(classifyIntent('best crm software')).toBe('commercial');
    expect(classifyIntent('how to bake bread')).toBe('informational');
  });

  it('returns null when no signal word is present', () => {
    expect(classifyIntent('frontend newsletter')).toBeNull();
  });

  it('is deterministic', () => {
    expect(classifyIntent('best crm software')).toBe(classifyIntent('best crm software'));
  });
});
