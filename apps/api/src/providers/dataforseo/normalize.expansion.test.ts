/**
 * DataForSEO expansion normalization (KW4). Related/ideas items nest their
 * intent under keyword_data.search_intent_info (not the flat
 * search_intent_info the suggestion endpoint used), so that path must be read.
 */
import { describe, expect, it } from 'vitest';
import { normalizeSuggestion } from './normalize.js';

describe('normalizeSuggestion (KW4 nested shapes)', () => {
  it('reads metrics and intent from a nested related/ideas item', () => {
    expect(
      normalizeSuggestion({
        keyword_data: {
          keyword: 'seo tools',
          keyword_info: { search_volume: 2400, cpc: 1.4, competition: 0.8 },
          keyword_properties: { keyword_difficulty: 55 },
          search_intent_info: { main_intent: 'commercial' },
        },
      }),
    ).toMatchObject({
      keyword: 'seo tools',
      search_volume: 2400,
      cpc: 1.4,
      difficulty: 55,
      competition: 'HIGH',
      keyword_intents: ['commercial'],
    });
  });

  it('still tolerates an item without a keyword', () => {
    expect(normalizeSuggestion({ keyword_data: { keyword_info: { search_volume: 10 } } })).toBeNull();
  });
});
