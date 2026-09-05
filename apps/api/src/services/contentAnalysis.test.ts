import { describe, expect, it } from 'vitest';
import type { ContentBlock } from '@seo/contracts';
import { analyzeContent } from './contentAnalysis.js';

const blocks: ContentBlock[] = [
  { type: 'heading', attrs: { level: 2, text: 'Why content engines scale' } },
  { type: 'paragraph', attrs: { text: 'A content engine turns research into articles at volume.' } },
  { type: 'heading', attrs: { level: 2, text: 'Operating cadence' } },
  { type: 'paragraph', attrs: { text: 'Consistent publishing beats bursts of activity.' } },
  { type: 'paragraph', attrs: { text: 'Teams align on topic clusters and measure results.' } },
];

describe('contentAnalysis', () => {
  it('returns a stable report shape with summary counts', () => {
    const report = analyzeContent(blocks, {
      title: 'Build a Content Engine',
      metaTitle: 'Build a Content Engine in 2026',
      metaDescription: 'A practical playbook for standing up a content engine that compounds traffic.',
      targetKeyword: 'content engine',
    });
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(report.summary.words).toBeGreaterThan(0);
    expect(report.summary.headings).toBe(2);
    expect(report.issues).toEqual(expect.any(Array));
    expect(report.recommendations).toEqual(expect.any(Array));
  });

  it('flags a missing keyword and thin copy', () => {
    const report = analyzeContent(
      [{ type: 'paragraph', attrs: { text: 'Short article here.' } }],
      { title: 'Whatever', metaTitle: 'Whatever', metaDescription: 'A short description for metadata testing purposes here.', targetKeyword: 'zerfobber' },
    );
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('keyword_not_in_body');
    expect(codes).toContain('too_short');
    expect(codes).toContain('no_headings');
  });

  it('warns on unresolved media placeholders', () => {
    const withPlaceholder: ContentBlock[] = [
      { type: 'heading', attrs: { level: 2, text: 'Section' } },
      { type: 'paragraph', attrs: { text: 'A reasonably long paragraph that explains the core idea in a single flowing sentence.' } },
      { type: 'paragraph', attrs: { text: 'A second paragraph adding more useful detail to the discussion and to the word count.' } },
      { type: 'media', attrs: { kind: 'placeholder', alt: 'diagram', caption: 'Diagram' } },
    ];
    const report = analyzeContent(withPlaceholder, {
      title: 'Topic', metaTitle: 'Topic Meta Title', metaDescription: 'Some meta description content that is long enough for the check to pass.' ,
    });
    expect(report.issues.map((i) => i.code)).toContain('media_placeholder_unresolved');
  });

  it('detects H1 usage inside the body', () => {
    const withH1: ContentBlock[] = [{ type: 'heading', attrs: { level: 1, text: 'Big heading' } }];
    const report = analyzeContent(withH1, {
      title: 'Topic', metaTitle: 'Topic', metaDescription: 'Long enough meta description used for this particular unit test case here.',
    });
    expect(report.issues.map((i) => i.code)).toContain('h1_used');
  });
});
