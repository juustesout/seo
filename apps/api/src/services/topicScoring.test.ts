/**
 * Topic scoring tests (KW6). These lock the deterministic rules behind the
 * topics layer: similarity maps to a coarse state (never a percentage),
 * retrieval hits map to a readiness state using only signals the retrieval
 * pipeline already returns, and the decision table is Research vs Create
 * article vs not actionable.
 */
import { describe, expect, it } from 'vitest';
import {
  candidateRank,
  clamp01,
  cosineSimilarity,
  decideRecommendation,
  isMeaningfulOpportunity,
  knowledgeReadinessState,
  recommendationRank,
  relevanceState,
} from './topicScoring.js';

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it('never produces a value outside 0..1 for non-negative vectors', () => {
    const score = cosineSimilarity([0.2, 0.5, 0.1], [0.4, 0.1, 0.9]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns 0 for degenerate or mismatched inputs', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });
});

describe('relevanceState', () => {
  it('buckets embedding similarity by the embedding thresholds', () => {
    expect(relevanceState(0.9, 'embedding')).toBe('strong');
    expect(relevanceState(0.55, 'embedding')).toBe('strong');
    expect(relevanceState(0.5, 'embedding')).toBe('moderate');
    expect(relevanceState(0.4, 'embedding')).toBe('weak');
    expect(relevanceState(0.34, 'embedding')).toBe('no_match');
  });

  it('buckets lexical coverage by the lexical thresholds', () => {
    expect(relevanceState(0.7, 'lexical')).toBe('strong');
    expect(relevanceState(0.4, 'lexical')).toBe('moderate');
    expect(relevanceState(0.25, 'lexical')).toBe('weak');
    expect(relevanceState(0.1, 'lexical')).toBe('no_match');
  });

  it('treats a non-finite score as no match', () => {
    expect(relevanceState(Number.NaN, 'embedding')).toBe('no_match');
  });
});

describe('knowledgeReadinessState', () => {
  it('is none when retrieval returned nothing', () => {
    expect(knowledgeReadinessState([])).toBe('none');
  });

  it('is weak for a single thin hit', () => {
    expect(knowledgeReadinessState([{ source_id: 's1', score: 0.9 }])).toBe('weak');
  });

  it('is moderate for two distinct sources or three hits', () => {
    expect(
      knowledgeReadinessState([
        { source_id: 's1', score: 0.9 },
        { source_id: 's2', score: 0.8 },
      ]),
    ).toBe('moderate');
    expect(
      knowledgeReadinessState([
        { source_id: 's1', score: 0.9 },
        { source_id: 's1', score: 0.8 },
        { source_id: 's1', score: 0.7 },
      ]),
    ).toBe('moderate');
  });

  it('is strong for three distinct sources or two sources with six hits', () => {
    expect(
      knowledgeReadinessState([
        { source_id: 's1', score: 0.9 },
        { source_id: 's2', score: 0.8 },
        { source_id: 's3', score: 0.7 },
      ]),
    ).toBe('strong');
    expect(
      knowledgeReadinessState(
        Array.from({ length: 6 }, (_v, i) => ({ source_id: i % 2 === 0 ? 's1' : 's2', score: 0.8 })),
      ),
    ).toBe('strong');
  });
});

describe('candidateRank / recommendationRank', () => {
  const base = { relevanceScore: 0.6, bestOpportunityScore: 70, totalVolume: 5000, competitorCount: 2 };

  it('is deterministic and bounded to 0..1', () => {
    const a = candidateRank(base);
    expect(a).toBe(candidateRank(base));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(1);
  });

  it('rewards relevance, opportunity, volume and competitor breadth', () => {
    const low = candidateRank({ ...base, relevanceScore: 0.4, bestOpportunityScore: 30, totalVolume: 100, competitorCount: 0 });
    const high = candidateRank({ ...base, relevanceScore: 0.9, bestOpportunityScore: 90, totalVolume: 50_000, competitorCount: 3 });
    expect(high).toBeGreaterThan(low);
  });

  it('breaks ties on readiness in the final rank', () => {
    expect(recommendationRank(base, 'strong')).toBeGreaterThan(recommendationRank(base, 'none'));
    expect(recommendationRank(base, 'strong')).toBeGreaterThan(recommendationRank(base, 'weak'));
  });
});

describe('isMeaningfulOpportunity', () => {
  it('accepts a strong score or a substantial combined volume', () => {
    expect(isMeaningfulOpportunity(40, 0)).toBe(true);
    expect(isMeaningfulOpportunity(0, 150)).toBe(true);
  });

  it('rejects a thin opportunity on both axes', () => {
    expect(isMeaningfulOpportunity(10, 20)).toBe(false);
  });
});

describe('decideRecommendation', () => {
  const meaningful = { bestOpportunityScore: 70, totalVolume: 5000 };

  it('recommends create article when relevance and readiness are enough', () => {
    expect(decideRecommendation({ relevance: 'strong', readiness: 'strong', ...meaningful })).toBe('create_article');
    expect(decideRecommendation({ relevance: 'moderate', readiness: 'moderate', ...meaningful })).toBe(
      'create_article',
    );
  });

  it('recommends research when the knowledge base is thin', () => {
    expect(decideRecommendation({ relevance: 'strong', readiness: 'none', ...meaningful })).toBe('research');
    expect(decideRecommendation({ relevance: 'moderate', readiness: 'weak', ...meaningful })).toBe('research');
  });

  it('is not actionable for weak relevance or a thin opportunity', () => {
    expect(decideRecommendation({ relevance: 'weak', readiness: 'strong', ...meaningful })).toBeNull();
    expect(decideRecommendation({ relevance: 'no_match', readiness: 'strong', ...meaningful })).toBeNull();
    expect(
      decideRecommendation({ relevance: 'strong', readiness: 'strong', bestOpportunityScore: 5, totalVolume: 10 }),
    ).toBeNull();
  });
});

describe('clamp01', () => {
  it('clamps and neutralizes non-finite input', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});
