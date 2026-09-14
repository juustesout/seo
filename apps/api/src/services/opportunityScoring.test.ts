/**
 * Opportunity scoring tests (KW5). The score must be deterministic, bounded
 * 0-100, monotonic in the expected direction and honest about missing metrics
 * (neutral contribution, no fabricated reason).
 */
import { describe, expect, it } from 'vitest';
import { scoreOpportunity } from './opportunityScoring.js';

const base = { searchVolume: 1000, difficulty: 50, cpc: 1, competitorCount: 1, bestRank: 8 };

describe('scoreOpportunity', () => {
  it('scores higher volume above an otherwise identical lower volume', () => {
    const low = scoreOpportunity({ ...base, searchVolume: 100 });
    const high = scoreOpportunity({ ...base, searchVolume: 50_000 });
    expect(high.score).toBeGreaterThan(low.score);
  });

  it('scores lower difficulty above an otherwise identical higher difficulty', () => {
    const easy = scoreOpportunity({ ...base, difficulty: 10 });
    const hard = scoreOpportunity({ ...base, difficulty: 90 });
    expect(easy.score).toBeGreaterThan(hard.score);
  });

  it('gives a small positive signal for CPC without letting it dominate', () => {
    const noCpc = scoreOpportunity({ ...base, cpc: null });
    const highCpc = scoreOpportunity({ ...base, cpc: 25 });
    expect(highCpc.score).toBeGreaterThan(noCpc.score);
    expect(highCpc.score - noCpc.score).toBeLessThanOrEqual(15);
  });

  it('caps the competitor validation effect', () => {
    const three = scoreOpportunity({ ...base, competitorCount: 3 });
    const ten = scoreOpportunity({ ...base, competitorCount: 10 });
    expect(ten.score).toBe(three.score);
  });

  it('keeps a missing metric neutral and adds no reason for it', () => {
    const missing = scoreOpportunity({ searchVolume: null, difficulty: null, cpc: null, competitorCount: 0, bestRank: null });
    expect(Number.isFinite(missing.score)).toBe(true);
    expect(missing.reasons).toEqual([]);
    expect(missing.reasons).not.toContain('commercial_value');
  });

  it('always returns an integer score within 0-100', () => {
    const inputs = [
      { searchVolume: 0, difficulty: 0, cpc: 0, competitorCount: 0, bestRank: null },
      { searchVolume: 10_000_000, difficulty: 0, cpc: 999, competitorCount: 100, bestRank: 1 },
      { searchVolume: null, difficulty: null, cpc: null, competitorCount: 2, bestRank: 2 },
    ];
    for (const input of inputs) {
      const { score } = scoreOpportunity(input);
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it('emits explainable reasons for strong signals', () => {
    const { reasons } = scoreOpportunity({
      searchVolume: 50_000,
      difficulty: 20,
      cpc: 5,
      competitorCount: 3,
      bestRank: 2,
    });
    expect(reasons).toContain('high_volume');
    expect(reasons).toContain('low_difficulty');
    expect(reasons).toContain('commercial_value');
    expect(reasons).toContain('multiple_competitors_rank');
    expect(reasons).toContain('top_competitor_rank');
  });

  it('is a pure function: identical input yields identical output', () => {
    expect(scoreOpportunity(base)).toEqual(scoreOpportunity(base));
  });
});
