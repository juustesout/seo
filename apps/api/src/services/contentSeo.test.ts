import { describe, expect, it } from 'vitest';
import type { TipDoc, TipNode } from '@seo/contracts';
import { evaluateSeo, seoScoreLabel } from '@seo/contracts';

const text = (s: string): TipNode => ({ type: 'text', text: s });
const p = (s: string): TipNode => ({ type: 'paragraph', content: [text(s)] });
const h = (level: 1 | 2 | 3 | 4, s: string): TipNode => ({
  type: 'heading',
  attrs: { level },
  content: [text(s)],
});
const docOf = (...nodes: TipNode[]): TipDoc => ({ type: 'doc', content: nodes });

const META = {
  title: 'A Complete Guide to Building a Content Engine',
  metaTitle: 'Content Engine Guide: A Complete Walkthrough',
  metaDescription: 'Learn how a content engine turns research into publishable articles at a predictable cadence.',
};

function longCopy(kw: string): string {
  const sentence = `The ${kw} approach turns research into articles at volume, keeps the team aligned on topic clusters and produces predictable results over time.`;
  const words = Array.from({ length: 30 }, () => sentence).join(' ');
  return words;
}

describe('seo evaluator (contracts)', () => {
  it('evaluates an empty document with a content failure', () => {
    const result = evaluateSeo({ doc: tiptapEmpty(), meta: { ...META, targetKeyword: 'content engine' } });
    expect(find(result, 'has_content').status).toBe('fail');
    expect(result.stats.words).toBe(0);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('passes a normal article with keyword in title, intro and content', () => {
    const body = longCopy('content engine').split('. ');
    const result = evaluateSeo({
      doc: docOf(
        h(1, 'A Complete Guide to Building a Content Engine'),
        p('Content engine teams publish on a steady cadence.'),
        ...body.slice(0, 6).map((part) => p(`${part}.`)),
        h(2, 'Operating cadence'),
        p('Consistent publishing beats bursts of activity.'),
      ),
      meta: { ...META, targetKeyword: 'content engine' },
    });
    expect(find(result, 'has_content').status).toBe('pass');
    expect(find(result, 'keyword_in_content').status).toBe('pass');
    expect(find(result, 'keyword_in_introduction').status).toBe('pass');
    expect(find(result, 'keyword_in_title').status).toBe('pass');
    expect(find(result, 'single_h1').status).toBe('pass');
    expect(result.score).toBeGreaterThan(80);
  });

  it('fails the title-present check when the title is missing', () => {
    const result = evaluateSeo({
      doc: docOf(h(1, 'A heading'), p('Some body copy that mentions content engine inside this article.')),
      meta: { ...META, title: '', targetKeyword: 'content engine' },
    });
    expect(find(result, 'title_present').status).toBe('fail');
    expect(find(result, 'keyword_in_title').status).toBe('not_applicable');
  });

  it('warns on a bad title length', () => {
    const short = evaluateSeo({ doc: docOf(p('body')), meta: { ...META, title: 'Abc' } });
    const long = evaluateSeo({ doc: docOf(p('body')), meta: { ...META, title: 'x'.repeat(95) } });
    expect(find(short, 'title_length').status).toBe('warn');
    expect(find(long, 'title_length').status).toBe('warn');
  });

  it('flags a missing meta description', () => {
    const result = evaluateSeo({ doc: docOf(p('Body copy here.')), meta: { ...META, metaDescription: '' } });
    expect(find(result, 'meta_description_present').status).toBe('fail');
  });

  it('detects keyword presence and absence in the title', () => {
    const withKw = evaluateSeo({ doc: docOf(p('body')), meta: { ...META, targetKeyword: 'content engine' } });
    expect(find(withKw, 'keyword_in_title').status).toBe('pass');
    const withoutKw = evaluateSeo({
      doc: docOf(p('body')),
      meta: { ...META, title: 'A Random Article That Ignores It', targetKeyword: 'content engine' },
    });
    expect(find(withoutKw, 'keyword_in_title').status).toBe('fail');
  });

  it('detects keyword presence and absence in the introduction', () => {
    const withIntro = evaluateSeo({
      doc: docOf(p('Content engine operations run on a fixed cadence.'), p('More body copy continues below.')),
      meta: { ...META, targetKeyword: 'content engine' },
    });
    expect(find(withIntro, 'keyword_in_introduction').status).toBe('pass');
    const withoutIntro = evaluateSeo({
      doc: docOf(p('This opening paragraph avoids the phrase completely.'), p('Content engine appears much later.')),
      meta: { ...META, targetKeyword: 'content engine' },
    });
    expect(find(withoutIntro, 'keyword_in_introduction').status).toBe('fail');
  });

  it('warns when keyword repetition becomes excessive', () => {
    const doc = docOf(
      h(1, 'Content Engine Handbook'),
      ...Array.from({ length: 40 }, () => p('The content engine model works because a content engine team runs the content engine daily.')),
    );
    const result = evaluateSeo({ doc, meta: { ...META, targetKeyword: 'content engine' } });
    expect(find(result, 'keyword_repetition').status).toBe('warn');
  });

  it('keeps keyword checks not-applicable without a target keyword and does not unfairly reduce the score', () => {
    const meta = { ...META };
    const without = evaluateSeo({ doc: docOf(p('Some ordinary body copy about the topic.')), meta });
    expect(find(without, 'keyword_in_content').status).toBe('not_applicable');
    expect(find(without, 'keyword_in_title').status).toBe('not_applicable');
    const withMissing = evaluateSeo({
      doc: docOf(p('Some ordinary body copy about the topic.')),
      meta: { ...meta, targetKeyword: 'content engine' },
    });
    expect(withMissing.score).toBeLessThanOrEqual(without.score);
  });

  it('warns when heading levels skip a level', () => {
    const result = evaluateSeo({
      doc: docOf(h(1, 'Top'), h(3, 'Skipped section'), p('Body')),
      meta: { ...META },
    });
    expect(find(result, 'heading_hierarchy').status).toBe('warn');
    const ok = evaluateSeo({
      doc: docOf(h(1, 'Top'), h(2, 'Nested'), p('Body')),
      meta: { ...META },
    });
    expect(find(ok, 'heading_hierarchy').status).toBe('pass');
  });

  it('fails on multiple H1 headings', () => {
    const result = evaluateSeo({
      doc: docOf(h(1, 'First H1'), h(1, 'Second H1'), p('Body')),
      meta: { ...META },
    });
    expect(find(result, 'single_h1').status).toBe('fail');
  });

  it('counts words and reflects content length', () => {
    const doc = docOf(h(1, 'Title'), ...Array.from({ length: 60 }, () => p('One two three four five six seven eight nine ten.')));
    const result = evaluateSeo({ doc, meta: { ...META } });
    expect(result.stats.words).toBe(601);
    expect(find(result, 'content_length').status).toBe('pass');
  });

  it('computes the score from the check points and stays within bounds', () => {
    const result = evaluateSeo({ doc: docOf(p('Body copy.')), meta: { ...META, targetKeyword: 'nonexistent' } });
    const maxTotal = result.checks.reduce((sum, c) => sum + c.maxPoints, 0);
    const earned = result.checks.reduce((sum, c) => sum + c.points, 0);
    expect(result.score).toBe(Math.round((earned / maxTotal) * 100));
    expect(maxTotal).toBe(100);
  });

  it('is deterministic: identical input yields an identical result', () => {
    const doc = docOf(h(1, 'Guide'), p('Content engine teams publish steadily.'), h(2, 'Cadence'), p('Consistent beats bursts.'));
    const meta = { ...META, targetKeyword: 'content engine' };
    const a = evaluateSeo({ doc, meta });
    const b = evaluateSeo({ doc, meta });
    expect(a).toEqual(b);
    expect(a.score).toBe(b.score);
  });

  it('maps scores to readable labels', () => {
    expect(seoScoreLabel(95)).toBe('Excellent');
    expect(seoScoreLabel(85)).toBe('Good');
    expect(seoScoreLabel(70)).toBe('Needs work');
    expect(seoScoreLabel(40)).toBe('Needs attention');
  });
});

describe('seo evaluator image checks (phase F)', () => {
  const image = (alt: string): TipNode => ({
    type: 'image',
    attrs: { mediaId: 'm-1', src: 'https://cdn.example/x.png', alt },
  });
  const withImage = (alt: string) => docOf(p('Body copy mentioning a content engine cadence.'), image(alt));

  it('passes when every image carries descriptive alt text', () => {
    const result = evaluateSeo({
      doc: withImage('A red fox crossing a snowy field at dusk'),
      meta: META,
    });
    expect(result.stats.images).toBe(1);
    expect(result.stats.imagesMissingAlt).toBe(0);
    expect(find(result, 'image_alt_present').status).toBe('pass');
    expect(find(result, 'image_alt_descriptive').status).toBe('pass');
  });

  it('fails when an image has no alt text', () => {
    const result = evaluateSeo({ doc: withImage(''), meta: META });
    expect(result.stats.imagesMissingAlt).toBe(1);
    expect(find(result, 'image_alt_present').status).toBe('fail');
  });

  it('treats generic single-word alts as not descriptive', () => {
    const result = evaluateSeo({ doc: withImage('image'), meta: META });
    expect(find(result, 'image_alt_present').status).toBe('fail');
    expect(find(result, 'image_alt_descriptive').status).toBe('fail');
  });

  it('leaves the checks out entirely when the document has no images', () => {
    const result = evaluateSeo({ doc: docOf(p('Body only')), meta: META });
    expect(result.checks.some((c) => c.code === 'image_alt_present')).toBe(false);
    expect(result.stats.images).toBe(0);
  });
});

function find(result: ReturnType<typeof evaluateSeo>, code: string) {
  const check = result.checks.find((c) => c.code === code);
  if (!check) throw new Error(`check ${code} missing`);
  return check;
}

function tiptapEmpty(): TipDoc {
  return { type: 'doc', content: [{ type: 'paragraph' }] };
}
