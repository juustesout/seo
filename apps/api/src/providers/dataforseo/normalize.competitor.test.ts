/**
 * DataForSEO competitor normalization (KW3). Pure mapping tests: missing metrics
 * become null (never fabricated zeros) and unusable rows are dropped.
 */
import { describe, expect, it } from 'vitest';
import { normalizeCompetitorCandidate, normalizeDomainIntersectionGap } from './normalize.js';

describe('normalizeCompetitorCandidate', () => {
  it('maps a full competitor-domain item', () => {
    expect(
      normalizeCompetitorCandidate({
        domain: 'Rival.com',
        intersections: 1842,
        keywords_count: 5200,
        avg_position: 12.4,
        etv: 900,
      }),
    ).toEqual({ domain: 'rival.com', shared_keywords: 1842, keywords_count: 5200, avg_position: 12.4, etv: 900 });
  });

  it('maps absent metrics to null instead of zero', () => {
    expect(normalizeCompetitorCandidate({ domain: 'rival.com' })).toEqual({
      domain: 'rival.com',
      shared_keywords: null,
      keywords_count: null,
      avg_position: null,
      etv: null,
    });
  });

  it('drops an item without a domain', () => {
    expect(normalizeCompetitorCandidate({ intersections: 3 })).toBeNull();
    expect(normalizeCompetitorCandidate({ domain: '   ' })).toBeNull();
  });
});

describe('normalizeDomainIntersectionGap', () => {
  it('reads metrics from keyword_data and rank from the first domain serp element', () => {
    expect(
      normalizeDomainIntersectionGap(
        {
          keyword_data: {
            keyword: 'blue widgets',
            keyword_info: { search_volume: 2400, cpc: 1.2 },
            keyword_properties: { keyword_difficulty: 42 },
          },
          first_domain_serp_element: { rank_group: 4, type: 'organic' },
        },
        'rival.com',
      ),
    ).toEqual({
      keyword: 'blue widgets',
      search_volume: 2400,
      difficulty: 42,
      cpc: 1.2,
      competitor_domain: 'rival.com',
      position: 4,
    });
  });

  it('tolerates a missing serp element and absent metrics', () => {
    expect(
      normalizeDomainIntersectionGap({ keyword_data: { keyword: 'cheap widgets' } }, 'rival.com'),
    ).toEqual({
      keyword: 'cheap widgets',
      search_volume: null,
      difficulty: null,
      cpc: null,
      competitor_domain: 'rival.com',
      position: null,
    });
  });

  it('drops an item without a keyword', () => {
    expect(normalizeDomainIntersectionGap({ keyword_data: {}, first_domain_serp_element: {} }, 'rival.com')).toBeNull();
  });
});
