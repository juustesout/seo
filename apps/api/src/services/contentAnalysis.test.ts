import { describe, expect, it } from 'vitest';
import type { TipDoc } from '@seo/contracts';
import { evaluateSeo } from '@seo/contracts';
import { buildContentAnalysisReport } from './contentAnalysis.js';

const doc: TipDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Build a Content Engine' }] },
    {
      type: 'paragraph',
      content: [{ type: 'text', text: 'A content engine turns research into articles at volume.' }],
    },
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Operating cadence' }],
    },
    { type: 'paragraph', content: [{ type: 'text', text: 'Consistent publishing beats bursts of activity.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Teams align on topic clusters and measure results.' }] },
  ],
};

describe('contentAnalysis report', () => {
  it('shapes the canonical evaluation into a stable report', () => {
    const result = evaluateSeo({
      doc,
      meta: {
        title: 'Build a Content Engine',
        metaTitle: 'Build a Content Engine in 2026',
        metaDescription: 'A practical playbook for standing up a content engine that compounds traffic.',
        targetKeyword: 'content engine',
      },
    });
    const report = buildContentAnalysisReport(result, '2026-01-01T00:00:00.000Z');
    expect(report.score).toBe(result.score);
    expect(report.checks).toEqual(result.checks);
    expect(report.summary.words).toBeGreaterThan(0);
    expect(report.summary.headings).toBe(2);
    expect(report.generated_at).toBe('2026-01-01T00:00:00.000Z');
    expect(report.issues).toEqual(expect.any(Array));
    expect(report.recommendations.length).toBeLessThanOrEqual(6);
  });

  it('flags failing checks as error issues with their canonical code', () => {
    const result = evaluateSeo({
      doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Short.' }] }] },
      meta: { title: 'Whatever', metaTitle: '', metaDescription: '', targetKeyword: 'zerfobber' },
    });
    const report = buildContentAnalysisReport(result);
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('keyword_in_content');
    expect(codes).toContain('meta_title_present');
    expect(codes).toContain('meta_description_present');
  });
});
