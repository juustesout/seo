/**
 * DataForSEO adapter usage instrumentation (R5.10.4).
 *
 * Pins that logical provider operations - not HTTP calls, retries, polling or
 * credential probes - become usage facts, that batch quantities are counted
 * correctly, and that one execution's repeated operations do not collide.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderContext, ProviderLogger } from '@seo/contracts';
import { InMemoryUsageEventStore } from '../../services/usageEventRepository.js';
import { DataForSeoDataSource } from './dataSource.js';

const h = vi.hoisted(() => ({
  behavior: {} as Record<string, (...args: any[]) => any>,
  ready: [] as Array<{ id: string }>,
}));

vi.mock('./dataForSeoClient.js', () => ({
  DataForSeoClient: class {
    keywordSuggestions(seed: string, opts: unknown) {
      return h.behavior.keywordSuggestions!(seed, opts);
    }
    relatedKeywords(seed: string, opts: unknown) {
      return h.behavior.relatedKeywords!(seed, opts);
    }
    keywordIdeas(seeds: string[], opts: unknown) {
      return h.behavior.keywordIdeas!(seeds, opts);
    }
    serpLiveOrganic(keyword: string, opts: unknown) {
      return h.behavior.serpLiveOrganic!(keyword, opts);
    }
    postSerpOrganicTasks(items: Array<{ keyword: string }>) {
      return h.behavior.postSerpOrganicTasks!(items);
    }
    serpTasksReady() {
      return h.behavior.serpTasksReady!();
    }
    serpTaskGet(id: string) {
      return h.behavior.serpTaskGet!(id);
    }
    competitorDomains(domain: string, opts: unknown) {
      return h.behavior.competitorDomains!(domain, opts);
    }
    domainIntersection(a: string, b: string, opts: unknown) {
      return h.behavior.domainIntersection!(a, b, opts);
    }
  },
}));

vi.mock('../../util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../util.js')>();
  return { ...actual, delay: async () => {} };
});

const PROJECT = '11111111-1111-4111-8111-111111111111';
const JOB = 'job-r5-104';
const noopLogger: ProviderLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function adapter(config: Record<string, string | undefined> = { DATAFORSEO_BASE64: 'x' }) {
  return new DataForSeoDataSource({ config, logger: noopLogger });
}

function usageCtx(store: InMemoryUsageEventStore): ProviderContext {
  const occurrences = new Map<string, number>();
  return {
    projectId: PROJECT,
    userId: null,
    config: {},
    credentials: { get: async () => null, set: async () => {}, delete: async () => {} },
    logger: noopLogger,
    usage: {
      sink: store,
      sourceId: JOB,
      nextOccurrence: (op) => {
        const next = occurrences.get(op) ?? 0;
        occurrences.set(op, next + 1);
        return next;
      },
    },
  };
}

function byUnit(events: Array<{ unit: string }>): Record<string, { unit: string }> {
  return Object.fromEntries(events.map((e) => [e.unit, e]));
}

beforeEach(() => {
  h.ready = [];
  h.behavior = {
    keywordSuggestions: async () => [],
    relatedKeywords: async () => [],
    keywordIdeas: async () => [],
    serpLiveOrganic: async (keyword: string) => ({ keyword, items: [] }),
    postSerpOrganicTasks: async (items: Array<{ keyword: string }>) => {
      const tasks = items.map((it, i) => ({ id: `t${h.ready.length + i}`, keyword: it.keyword }));
      h.ready.push(...tasks.map((t) => ({ id: t.id })));
      return tasks;
    },
    serpTasksReady: async () => {
      const ready = h.ready;
      h.ready = [];
      return ready;
    },
    serpTaskGet: async (id: string) => ({ keyword: id, result: [{ keyword: id, items: [] }] }),
    competitorDomains: async () => [],
    domainIntersection: async () => [],
  };
});

describe('DataForSeoDataSource usage - keyword research', () => {
  it('records one request and the submitted seed count for suggestions', async () => {
    const store = new InMemoryUsageEventStore();
    await adapter().researchKeywords(usageCtx(store), ['a', 'b', 'c', 'd']);
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(2);
    expect(byUnit(events).request).toMatchObject({
      category: 'dataforseo',
      provider: 'dataforseo',
      operation: 'keyword_research',
      quantity: 1,
      unit: 'request',
      success: true,
      sourceId: JOB,
      projectId: PROJECT,
      userId: null,
    });
    expect(byUnit(events).keyword).toMatchObject({ operation: 'keyword_research', quantity: 4, unit: 'keyword' });
  });

  it('keeps repeated related calls as distinct facts via occurrences', async () => {
    const store = new InMemoryUsageEventStore();
    const a = adapter();
    const ctx = usageCtx(store);
    await a.relatedKeywords(ctx, 'alpha');
    await a.relatedKeywords(ctx, 'beta');
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(4);
    expect(events.filter((e) => e.unit === 'request')).toHaveLength(2);
    expect(events.filter((e) => e.unit === 'keyword')).toHaveLength(2);
    expect(events.every((e) => e.operation === 'keyword_related' && e.quantity === 1)).toBe(true);
  });

  it('records one request and every submitted seed for ideas', async () => {
    const store = new InMemoryUsageEventStore();
    await adapter().keywordIdeas(usageCtx(store), ['a', 'b', 'c']);
    const events = await store.list({ projectId: PROJECT });
    expect(byUnit(events).request).toMatchObject({ operation: 'keyword_ideas', quantity: 1 });
    expect(byUnit(events).keyword).toMatchObject({ operation: 'keyword_ideas', quantity: 3 });
  });

  it('records a failed attempt and rethrows the provider error', async () => {
    h.behavior.keywordSuggestions = async () => {
      throw new Error('vendor 500');
    };
    const store = new InMemoryUsageEventStore();
    await expect(adapter().researchKeywords(usageCtx(store), ['a', 'b'])).rejects.toThrow('vendor 500');
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.success === false)).toBe(true);
    expect(events.map((e) => e.quantity).sort()).toEqual([1, 2]);
  });

  it('records nothing when the provider is not configured', async () => {
    const store = new InMemoryUsageEventStore();
    const ctx = usageCtx(store);
    await expect(adapter({}).researchKeywords(ctx, ['a'])).rejects.toThrow();
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });
});

describe('DataForSeoDataSource usage - SERP', () => {
  it('records the submitted SERP request and keyword counts for live SERP', async () => {
    const store = new InMemoryUsageEventStore();
    await adapter().fetchLiveSerp(usageCtx(store), ['a', 'b', 'c'], { depth: 20 });
    const events = await store.list({ projectId: PROJECT });
    expect(byUnit(events).serp_request).toMatchObject({ operation: 'serp_live', quantity: 3, unit: 'serp_request' });
    expect(byUnit(events).keyword).toMatchObject({ operation: 'serp_live', quantity: 3, unit: 'keyword' });
  });

  it('caps live SERP usage at the adapter limit', async () => {
    const store = new InMemoryUsageEventStore();
    await adapter().fetchLiveSerp(
      usageCtx(store),
      Array.from({ length: 60 }, (_, i) => `k${i}`),
      { depth: 20 },
    );
    const events = await store.list({ projectId: PROJECT });
    expect(byUnit(events).serp_request).toMatchObject({ quantity: 50 });
    expect(byUnit(events).keyword).toMatchObject({ quantity: 50 });
  });

  it('records keywords, created tasks and SERP requests for task SERP without inflating polling', async () => {
    const store = new InMemoryUsageEventStore();
    await adapter().fetchTaskSerp(
      usageCtx(store),
      Array.from({ length: 120 }, (_, i) => `k${i}`),
    );
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(3);
    expect(byUnit(events).keyword).toMatchObject({ operation: 'serp_task', quantity: 120 });
    expect(byUnit(events).task).toMatchObject({ operation: 'serp_task', quantity: 3, unit: 'task' });
    expect(byUnit(events).serp_request).toMatchObject({ operation: 'serp_task', quantity: 120 });
  });
});

describe('DataForSeoDataSource usage - competitors', () => {
  it('records one request for discovery', async () => {
    const store = new InMemoryUsageEventStore();
    await adapter().discoverCompetitors(usageCtx(store), 'example.com');
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operation: 'competitor_discovery',
      unit: 'request',
      quantity: 1,
      success: true,
    });
  });

  it('records one request per competitor intersection for gap analysis', async () => {
    const store = new InMemoryUsageEventStore();
    await adapter().findCompetitorKeywordGaps(usageCtx(store), 'example.com', ['a.com', 'b.com', 'c.com']);
    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: 'competitor_gap', unit: 'request', quantity: 3 });
  });
});

describe('DataForSeoDataSource usage - probes are not usage', () => {
  it('emits nothing for connect or testConnection', async () => {
    const store = new InMemoryUsageEventStore();
    const a = adapter();
    const ctx = usageCtx(store);
    await a.connect(ctx);
    await a.testConnection(ctx);
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });
});
