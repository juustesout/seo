import { describe, expect, it } from 'vitest';
import type { SeoResult } from '@seo/contracts';
import {
  aggregateGsc,
  aggregateGscQueries,
  contentPathKeys,
  keywordDemandRecommendation,
  knowledgeRecommendations,
  missingTerms,
  pageCtrRecommendation,
  pageTrendRecommendation,
  pageUrlCandidates,
  queryOpportunityRecommendations,
  relatedQuery,
  seoRecommendations,
  shortHash,
  significantTokens,
  siteHostOf,
} from './contentIntelligence.js';

describe('content intelligence url matching helpers', () => {
  it('parses hosts from url-prefix and sc-domain GSC properties', () => {
    expect(siteHostOf('https://www.example.com/')).toBe('www.example.com');
    expect(siteHostOf('sc-domain:example.com')).toBe('example.com');
    expect(siteHostOf('sc-domain:.example.com')).toBe('example.com');
    expect(siteHostOf('')).toBeNull();
    expect(siteHostOf('not a url')).toBeNull();
  });

  it('derives path candidates from slug and relative/full urls', () => {
    expect(contentPathKeys({ slug: 'hello-world' })).toEqual(['/hello-world']);
    expect(contentPathKeys({ slug: '/hello/' })).toEqual(['/hello']);
    expect(contentPathKeys({ url: 'https://example.com/blog/x/' })).toEqual(['/blog/x']);
    expect(contentPathKeys({ url: '/blog/x' })).toEqual(['/blog/x']);
    expect(contentPathKeys({ url: 'https://example.com/blog/x/', slug: 'hello' })).toEqual(['/blog/x', '/hello']);
  });

  it('builds probe url candidates across property hosts and the raw url', () => {
    const candidates = pageUrlCandidates({ url: 'https://x.io/a', slug: 'hello', hosts: ['example.com', 'other.org'] });
    expect(candidates).toContain('https://example.com/hello');
    expect(candidates).toContain('https://example.com/hello/');
    expect(candidates).toContain('http://other.org/hello');
    expect(candidates).toContain('https://x.io/a');
    expect(candidates).toContain('https://x.io/a/');
  });
});

describe('content intelligence query relevance helpers', () => {
  it('removes stopwords and short tokens', () => {
    expect(significantTokens('the best SEO tools for your site')).toEqual(['best', 'seo', 'tools', 'site']);
  });

  it('flags query terms missing from the document', () => {
    expect(missingTerms('seo writing tips', 'How to use the seo panel')).toEqual(['writing', 'tips']);
    expect(missingTerms('seo panel', 'How to use the seo panel')).toEqual([]);
  });

  it('relates a query when it contains the topic phrase or shares two tokens', () => {
    const tokens = significantTokens('content engine review');
    expect(relatedQuery('content engine review', 'content engine', tokens)).toBe(true);
    expect(relatedQuery('engine review', 'content engine', tokens)).toBe(true);
    expect(relatedQuery('banana recipes', 'content engine', tokens)).toBe(false);
    expect(relatedQuery('any query', '', tokens)).toBe(false);
  });

  it('hashes stably', () => {
    expect(shortHash('seo content')).toBe(shortHash('seo content'));
    expect(shortHash('a')).toHaveLength(4);
  });
});

describe('content intelligence aggregators', () => {
  it('aggregates GSC rows with impression-weighted position', () => {
    const agg = aggregateGsc([
      { clicks: 1, impressions: 100, position: 10 },
      { clicks: 2, impressions: 300, position: 5 },
    ]);
    expect(agg.clicks).toBe(3);
    expect(agg.impressions).toBe(400);
    expect(agg.position).toBeCloseTo(6.25, 5);
    expect(agg.ctr).toBeCloseTo(0.0075, 6);
  });

  it('aggregates daily query rows into per-query totals', () => {
    const aggs = aggregateGscQueries([
      { query: 'seo tools', clicks: 1, impressions: 100, position: 8 },
      { query: 'seo tools', clicks: 2, impressions: 200, position: 6 },
      { query: 'other', clicks: 0, impressions: 10, position: 12 },
    ]);
    const seoTools = aggs.find((a) => a.query === 'seo tools');
    expect(seoTools).toBeDefined();
    expect(seoTools!.impressions).toBe(300);
    expect(seoTools!.position).toBeCloseTo(6.6666, 3);
    expect(aggs.find((a) => a.query === 'other')!.impressions).toBe(10);
  });
});

describe('content intelligence recommendation builders', () => {
  it('maps failing and warning SEO checks to normalized issues', () => {
    const result = {
      score: 40,
      keyword: null,
      checks: [
        { code: 'meta_desc', category: 'Metadata', label: 'Meta description', status: 'fail', points: 0, maxPoints: 10, detail: 'Missing', suggestion: 'Add one' },
        { code: 'headings', category: 'Structure', label: 'Headings', status: 'warn', points: 2, maxPoints: 5, detail: 'Sparse', suggestion: null },
        { code: 'ok', category: 'Content', label: 'Fine', status: 'pass', points: 5, maxPoints: 5, detail: 'Pass', suggestion: null },
      ],
      stats: { words: 10, headings: 1, h1: 0, h2: 1, paragraphs: 2, links: 0, longParagraphs: 0, images: 0, imagesMissingAlt: 0 },
    } as unknown as SeoResult;
    const recs = seoRecommendations(result);
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ id: 'seo:meta_desc', source: 'seo', type: 'issue', priority: 'high' });
    expect(recs[0].action).toEqual({ text: 'Add one' });
    expect(recs[1].priority).toBe('medium');
    expect(recs.some((r) => r.code === 'ok')).toBe(false);
  });

  it('flags page visibility declines only when meaningful', () => {
    const rec = pageTrendRecommendation(
      { clicks: 30, impressions: 1000, ctr: 0.03, position: 8 },
      { clicks: 10, impressions: 500, ctr: 0.02, position: 9 },
      'https://example.com/x',
    );
    expect(rec).not.toBeNull();
    expect(rec!.code).toBe('page_visibility_decline');
    expect(rec!.description).toContain('50.0%');
    expect(rec!.evidence?.some((e) => e.label === 'Page')).toBe(true);

    const stable = pageTrendRecommendation(
      { clicks: 10, impressions: 1000, ctr: 0.01, position: 9 },
      { clicks: 10, impressions: 950, ctr: 0.0105, position: 9 },
    );
    expect(stable).toBeNull();
  });

  it('flags low page CTR only when ranking near the top with volume', () => {
    const rec = pageCtrRecommendation({ clicks: 2, impressions: 500, ctr: 0.004, position: 8 });
    expect(rec).not.toBeNull();
    expect(rec!.type).toBe('opportunity');
    expect(pageCtrRecommendation({ clicks: 2, impressions: 500, ctr: 0.05, position: 8 })).toBeNull();
    expect(pageCtrRecommendation({ clicks: 2, impressions: 500, ctr: 0.004, position: 3 })).toBeNull();
    expect(pageCtrRecommendation({ clicks: 2, impressions: 50, ctr: 0.004, position: 8 })).toBeNull();
  });

  it('recommends coverage for related low-CTR queries missing from the doc', () => {
    const aggs = [
      { query: 'seo content writing tips', clicks: 1, impressions: 500, ctr: 0.002, position: 7.2 },
      { query: 'banana bread recipe', clicks: 1, impressions: 900, ctr: 0.001, position: 6 },
    ];
    const recs = queryOpportunityRecommendations(aggs, {
      topic: 'content engine seo',
      docText: 'How to configure the seo panel for your content.',
    });
    expect(recs).toHaveLength(1);
    expect(recs[0].code).toBe('low_ctr_query');
    expect(recs[0].id).toMatch(/^gsc:low_ctr_query:/);
    expect(recs[0].title).toContain('seo content writing tips');
    expect(recs[0].description).toContain('500');
  });

  it('does not recommend when terms are already covered', () => {
    const recs = queryOpportunityRecommendations(
      [{ query: 'seo panel', clicks: 0, impressions: 500, ctr: 0, position: 7 }],
      { topic: 'seo panel', docText: 'The seo panel is explained here.' },
    );
    expect(recs).toEqual([]);
  });

  it('builds a demand recommendation from real DataForSEO metrics', () => {
    const rec = keywordDemandRecommendation({ keyword: 'content engine', volume: 1000, difficulty: 30, cpc: 1.5 });
    expect(rec).not.toBeNull();
    expect(rec!.type).toBe('opportunity');
    expect(rec!.description).toContain('1,000');
    expect(rec!.description).toContain('30');
    expect(rec!.evidence?.map((e) => e.label)).toEqual(['Volume / month', 'Keyword difficulty', 'CPC']);
    expect(keywordDemandRecommendation({ keyword: 'content engine', volume: 0 })).toBeNull();
  });

  it('builds knowledge health recommendations from source counts', () => {
    expect(knowledgeRecommendations({ total: 0, indexed: 0, error: 0, pending: 0 })[0].code).toBe('no_sources');
    const withError = knowledgeRecommendations({ total: 5, indexed: 3, error: 2, pending: 0 });
    expect(withError).toHaveLength(1);
    expect(withError[0]).toMatchObject({ code: 'source_errors', priority: 'high' });
    expect(knowledgeRecommendations({ total: 3, indexed: 3, error: 0, pending: 0 })).toEqual([]);
  });
});
