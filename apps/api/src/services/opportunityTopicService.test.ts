/**
 * Opportunity topic service tests (KW6).
 *
 * They prove the topics layer is a pure, bounded read: it assigns the KW5.1 gap
 * opportunities to the project's core topics, derives knowledge readiness from
 * the existing retrieval pipeline (never for more than the strongest few
 * candidates) and returns deterministic Research vs Create-article advice. No
 * DataForSEO call and no derived persistence are involved.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CompetitorGapDto, CoreTopicDto, TopicRecommendationsDto } from '@seo/contracts';
import { TOPIC_CANDIDATE_LIMIT, TOPIC_MAX_RECOMMENDATIONS } from '@seo/contracts';
import {
  getTopicRecommendations,
  parseCoreTopics,
  topicText,
  writeCoreTopics,
} from './opportunityTopicService.js';
import { competitorGapScope, scopeKeyOf } from './sourceScope.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';

type Row = Record<string, unknown>;

function gap(overrides: Partial<CompetitorGapDto> & { keyword: string }): CompetitorGapDto {
  return {
    searchVolume: 1000,
    difficulty: 40,
    cpc: 1.5,
    competitorDomain: 'rival.com',
    position: 3,
    ...overrides,
  };
}

function snapshotRow(projectId: string, gaps: CompetitorGapDto[], competitors = ['rival.com'], domain = 'example.com') {
  const scope = competitorGapScope({ domain, competitors });
  return {
    id: 'snap-1',
    project_id: projectId,
    type: 'competitor_gap',
    provider: 'dataforseo',
    scope,
    scope_key: scopeKeyOf(scope),
    data: { gaps, total: gaps.length },
    fetched_at: new Date().toISOString(),
    source_job_id: null,
  };
}

function settingsRow(coreTopics: CoreTopicDto[]): Row {
  return { id: PROJECT, settings: { coreTopics } };
}

function fakeSb(tables: Record<string, Row[]>) {
  function builderFor(table: string) {
    const rows = tables[table] ?? [];
    const filters: Array<(r: Row) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let limitN = Number.POSITIVE_INFINITY;
    let pending: Row | null = null;

    const builder = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        if (pending) {
          for (const r of rows) if (filters.every((f) => f(r))) Object.assign(r, pending);
          pending = null;
        }
        return builder;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orders.push({ col, asc: opts?.ascending !== false });
        return builder;
      },
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      update: (patch: Row) => {
        pending = patch;
        return builder;
      },
      maybeSingle: async () => {
        let out = rows.filter((r) => filters.every((f) => f(r)));
        for (const { col, asc } of [...orders].reverse()) {
          out = [...out].sort((a, b) => {
            const av = a[col] as string;
            const bv = b[col] as string;
            if (av === bv) return 0;
            return (av < bv ? -1 : 1) * (asc ? 1 : -1);
          });
        }
        return { data: out.slice(0, limitN)[0] ?? null, error: null };
      },
    };
    return builder;
  }

  return { from: (table: string) => builderFor(table), tables };
}

function containerWith(input: {
  settings?: Row[];
  snapshots?: Row[];
}) {
  return {
    sb: fakeSb({
      seo_projects: input.settings ?? [],
      seo_source_snapshots: input.snapshots ?? [],
    }),
    config: { env: {} },
    registry: { getKnowledge: () => null },
  } as never;
}

const SET = ['rival.com'];

function strongSearch(sources: string[]) {
  return vi.fn(async () => ({
    results: sources.map((source_id, i) => ({ source_id, score: 0.9 - i * 0.05 })),
  }));
}

describe('parseCoreTopics', () => {
  it('returns an empty list for a non-array or malformed input', () => {
    expect(parseCoreTopics(undefined)).toEqual([]);
    expect(parseCoreTopics({ name: 'x' })).toEqual([]);
    expect(parseCoreTopics([null, 42, {}, { name: '   ' }])).toEqual([]);
  });

  it('trims, bounds and de-duplicates while dropping empty keyword hints', () => {
    const topics = parseCoreTopics([
      { name: '  Blue Widgets  ', description: '  buyers  ', keywords: ['  widgets ', '', 'widgets'] },
      { name: 'blue widgets', description: 'duplicate canonical' },
    ]);
    expect(topics).toHaveLength(1);
    expect(topics[0]).toEqual({ name: 'Blue Widgets', description: 'buyers', keywords: ['widgets'] });
  });

  it('caps the list', () => {
    const many = Array.from({ length: 60 }, (_v, i) => ({ name: `topic ${i}`, description: '' }));
    expect(parseCoreTopics(many)).toHaveLength(50);
  });
});

describe('writeCoreTopics', () => {
  it('normalizes and merges into settings without dropping other keys', async () => {
    const tables: Record<string, Row[]> = {
      seo_projects: [{ id: PROJECT, settings: { ai: { provider: 'x' }, coreTopics: [{ name: 'old' }] } }],
    };
    const container = { sb: fakeSb(tables) } as never;
    const result = await writeCoreTopics(container, PROJECT, [{ name: '  New topic ', description: '' }]);
    expect(result).toEqual([{ name: 'New topic', description: '' }]);
    const stored = (tables.seo_projects[0]!.settings as Row) ?? {};
    expect(stored.ai).toEqual({ provider: 'x' });
    expect(stored.coreTopics).toEqual([{ name: 'New topic', description: '' }]);
  });
});

describe('topicText', () => {
  it('joins name, description and keyword hints', () => {
    expect(topicText({ name: 'Widgets', description: 'for buyers', keywords: ['blue'] })).toBe('Widgets for buyers blue');
    expect(topicText({ name: 'Widgets', description: '' })).toBe('Widgets');
  });
});

describe('getTopicRecommendations', () => {
  it('reports an honest empty state when no core topics are configured', async () => {
    const search = strongSearch(['s1']);
    const container = containerWith({
      settings: [{ id: PROJECT, settings: {} }],
      snapshots: [snapshotRow(PROJECT, [gap({ keyword: 'blue widgets' })])],
    });
    const result = await getTopicRecommendations(container, PROJECT, SET, 'example.com', { embedder: null, search });
    expect(result.topicsConfigured).toBe(false);
    expect(result.recommendations).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('reports no snapshot when the exact set has no gap snapshot', async () => {
    const search = strongSearch(['s1']);
    const container = containerWith({ settings: [settingsRow([{ name: 'blue widgets', description: '' }])], snapshots: [] });
    const result = await getTopicRecommendations(container, PROJECT, SET, 'example.com', { embedder: null, search });
    expect(result.topicsConfigured).toBe(true);
    expect(result.snapshot).toBeNull();
    expect(result.recommendations).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('recommends a draft when a topic matches with enough knowledge', async () => {
    const container = containerWith({
      settings: [settingsRow([{ name: 'blue widgets', description: 'widgets for buyers' }])],
      snapshots: [snapshotRow(PROJECT, [gap({ keyword: 'blue widgets', position: 3 })])],
    });
    const search = strongSearch(['s1', 's2', 's3']);

    const result = await getTopicRecommendations(container, PROJECT, SET, 'example.com', { embedder: null, search });

    expect(result.recommendations).toHaveLength(1);
    const rec = result.recommendations[0]!;
    expect(rec.topic.name).toBe('blue widgets');
    expect(rec.relevance.state).toBe('strong');
    expect(rec.knowledge.state).toBe('strong');
    expect(rec.knowledge.sources).toBe(3);
    expect(rec.recommendation).toBe('create_article');
    expect(rec.actionAvailable).toBe(true);
    expect(rec.keywords[0]!.keyword).toBe('blue widgets');
    expect(rec.totalVolume).toBe(1000);
    expect(rec.competitorEvidence).toEqual([{ domain: 'rival.com', rank: 3 }]);
    expect(rec.why).toContain('Topic relevance is strong');
  });

  it('recommends research when the knowledge base is thin, without offering the action', async () => {
    const container = containerWith({
      settings: [settingsRow([{ name: 'blue widgets', description: '' }])],
      snapshots: [snapshotRow(PROJECT, [gap({ keyword: 'blue widgets' })])],
    });
    const search = strongSearch(['only-source']);

    const result = await getTopicRecommendations(container, PROJECT, SET, 'example.com', { embedder: null, search });

    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]!.knowledge.state).toBe('weak');
    expect(result.recommendations[0]!.recommendation).toBe('research');
    expect(result.recommendations[0]!.actionAvailable).toBe(false);
  });

  it('drops a topic that does not match the gap keywords at all', async () => {
    const container = containerWith({
      settings: [settingsRow([{ name: 'gardening supplies', description: 'soil and seeds' }])],
      snapshots: [snapshotRow(PROJECT, [gap({ keyword: 'blue widgets' })])],
    });
    const search = strongSearch(['s1', 's2', 's3']);

    const result = await getTopicRecommendations(container, PROJECT, SET, 'example.com', { embedder: null, search });

    expect(result.candidateCount).toBe(0);
    expect(result.recommendations).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('aggregates several keywords into one topic with best rank per competitor', async () => {
    const container = containerWith({
      settings: [settingsRow([{ name: 'blue widgets', description: '' }])],
      snapshots: [
        snapshotRow(PROJECT, [
          gap({ keyword: 'blue widgets', searchVolume: 1000, competitorDomain: 'rival.com', position: 8 }),
          gap({ keyword: 'blue widgets cheap', searchVolume: 2000, competitorDomain: 'rival.com', position: 2 }),
          gap({ keyword: 'buy blue widgets', searchVolume: 500, competitorDomain: 'other.com', position: 5 }),
        ]),
      ],
    });
    const search = strongSearch(['s1', 's2', 's3']);

    const result = await getTopicRecommendations(container, PROJECT, SET, 'example.com', { embedder: null, search });

    const rec = result.recommendations[0]!;
    expect(rec.candidateCount).toBe(3);
    expect(rec.totalVolume).toBe(3500);
    expect(rec.competitorEvidence).toEqual([
      { domain: 'rival.com', rank: 2 },
      { domain: 'other.com', rank: 5 },
    ]);
    expect(rec.keywords.map((k) => k.keyword).sort()).toEqual(['blue widgets', 'blue widgets cheap', 'buy blue widgets']);
  });

  it('searches knowledge for at most the bounded number of candidates', async () => {
    const topics: CoreTopicDto[] = Array.from({ length: 12 }, (_v, i) => ({ name: `topic${i}widgets`, description: '' }));
    const gaps = Array.from({ length: 12 }, (_v, i) => gap({ keyword: `topic${i}widgets stuff`, searchVolume: 5000 }));
    const container = containerWith({ settings: [settingsRow(topics)], snapshots: [snapshotRow(PROJECT, gaps)] });
    const search = strongSearch(['s1']);

    const result = await getTopicRecommendations(container, PROJECT, SET, 'example.com', { embedder: null, search });

    expect(result.candidateCount).toBe(12);
    expect(search.mock.calls.length).toBe(TOPIC_CANDIDATE_LIMIT);
    expect(result.recommendations.length).toBeLessThanOrEqual(TOPIC_MAX_RECOMMENDATIONS);
  });

  it('is deterministic for identical input', async () => {
    const settings = [settingsRow([{ name: 'blue widgets', description: '' }])];
    const snapshots = [snapshotRow(PROJECT, [gap({ keyword: 'blue widgets' })])];
    const runOnce = (): Promise<TopicRecommendationsDto> =>
      getTopicRecommendations(containerWith({ settings, snapshots }), PROJECT, SET, 'example.com', {
        embedder: null,
        search: strongSearch(['s1', 's2', 's3']),
      });
    const first = await runOnce();
    const second = await runOnce();
    expect(second.recommendations).toEqual(first.recommendations);
    expect(second.consideredCount).toBe(first.consideredCount);
    expect(second.candidateCount).toBe(first.candidateCount);
  });

  it('reports knowledge as not configured and recommends research honestly', async () => {
    const container = containerWith({
      settings: [settingsRow([{ name: 'blue widgets', description: '' }])],
      snapshots: [snapshotRow(PROJECT, [gap({ keyword: 'blue widgets' })])],
    });

    const result = await getTopicRecommendations(container, PROJECT, SET, 'example.com', { embedder: null });

    expect(result.knowledgeConfigured).toBe(false);
    const rec = result.recommendations[0]!;
    expect(rec.knowledge.state).toBe('none');
    expect(rec.knowledge.note).toBeTruthy();
    expect(rec.recommendation).toBe('research');
  });
});
