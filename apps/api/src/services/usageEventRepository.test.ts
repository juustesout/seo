import { describe, expect, it } from 'vitest';
import type { NewUsageEvent } from '@seo/contracts';
import { InMemoryUsageEventStore } from './usageEventRepository.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';

function event(overrides: Partial<NewUsageEvent> = {}): NewUsageEvent {
  return {
    accountId: null,
    projectId: PROJECT,
    userId: '33333333-3333-4333-8333-333333333333',
    category: 'ai',
    provider: 'openai',
    operation: 'chat',
    quantity: 100,
    unit: 'input_token',
    success: true,
    sourceId: null,
    ...overrides,
  };
}

describe('InMemoryUsageEventStore', () => {
  it('fills defaults for id, occurredAt and metadata', async () => {
    const store = new InMemoryUsageEventStore();
    const result = await store.append([event()]);
    expect(result).toEqual({ inserted: 1, duplicates: 0 });

    const [stored] = await store.list({ projectId: PROJECT });
    expect(stored.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(typeof stored.occurredAt).toBe('string');
    expect(stored.metadata).toEqual({});
    expect(stored.quantity).toBe(100);
  });

  it('derives the key from sourceId and drops a duplicate append', async () => {
    const store = new InMemoryUsageEventStore();
    const facts = event({ sourceId: 'dataforseo-task-1' });
    expect(await store.append([facts])).toEqual({ inserted: 1, duplicates: 0 });
    expect(await store.append([facts])).toEqual({ inserted: 0, duplicates: 1 });
    expect(await store.append([facts])).toEqual({ inserted: 0, duplicates: 1 });
    expect(await store.list({ projectId: PROJECT })).toHaveLength(1);
  });

  it('does not deduplicate without a stable sourceId or explicit key', async () => {
    const store = new InMemoryUsageEventStore();
    await store.append([event()]);
    await store.append([event()]);
    expect(await store.list({ projectId: PROJECT })).toHaveLength(2);
  });

  it('honours an explicit idempotency key override', async () => {
    const store = new InMemoryUsageEventStore();
    await store.append([event({ sourceId: null, idempotencyKey: 'custom|1' })]);
    await store.append([event({ sourceId: 'different-source', idempotencyKey: 'custom|1' })]);
    expect(await store.list({ projectId: PROJECT })).toHaveLength(1);
  });

  it('scopes the derived key per project', async () => {
    const store = new InMemoryUsageEventStore();
    await store.append([event({ projectId: PROJECT, sourceId: 'same' })]);
    await store.append([event({ projectId: OTHER_PROJECT, sourceId: 'same' })]);
    const projectRows = await store.list({ projectId: PROJECT });
    const otherRows = await store.list({ projectId: OTHER_PROJECT });
    expect(projectRows).toHaveLength(1);
    expect(otherRows).toHaveLength(1);
  });

  it('deduplicates account-scoped events', async () => {
    const store = new InMemoryUsageEventStore();
    const facts = event({ projectId: null, accountId: ACCOUNT, sourceId: 'acct' });
    expect(await store.append([facts])).toEqual({ inserted: 1, duplicates: 0 });
    expect(await store.append([facts])).toEqual({ inserted: 0, duplicates: 1 });
  });

  it('fails closed on a malformed event', async () => {
    const store = new InMemoryUsageEventStore();
    await expect(
      store.append([event({ quantity: 1.5 as unknown as number })]),
    ).rejects.toMatchObject({ code: 'usage_event_invalid' });
    await expect(
      store.append([event({ provider: 'Not Valid' })]),
    ).rejects.toMatchObject({ code: 'usage_event_invalid' });
    await expect(
      store.append([event({ category: 'billing' as unknown as NewUsageEvent['category'] })]),
    ).rejects.toMatchObject({ code: 'usage_event_invalid' });
  });

  it('requires a scope to list', async () => {
    const store = new InMemoryUsageEventStore();
    await expect(store.list({})).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('filters and dedupes ordering by occurredAt desc with a bounded limit', async () => {
    const store = new InMemoryUsageEventStore();
    await store.append([
      event({ occurredAt: '2026-01-01T00:00:00.000Z', unit: 'input_token' }),
      event({ occurredAt: '2026-02-01T00:00:00.000Z', unit: 'output_token' }),
      event({ occurredAt: '2026-03-01T00:00:00.000Z', unit: 'output_token', success: false }),
    ]);

    const all = await store.list({ projectId: PROJECT });
    expect(all.map((e) => e.unit)).toEqual(['output_token', 'output_token', 'input_token']);

    const onlyOutput = await store.list({ projectId: PROJECT, unit: 'output_token' });
    expect(onlyOutput).toHaveLength(2);

    const failed = await store.list({ projectId: PROJECT, success: false });
    expect(failed).toHaveLength(1);

    const windowed = await store.list({
      projectId: PROJECT,
      occurredFrom: '2026-02-01T00:00:00.000Z',
      occurredTo: '2026-03-01T00:00:00.000Z',
    });
    expect(windowed).toHaveLength(1);
    expect(windowed[0].occurredAt).toBe('2026-02-01T00:00:00.000Z');

    const limited = await store.list({ projectId: PROJECT, limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('aggregates by the fixed category/provider/operation/unit dimensions', async () => {
    const store = new InMemoryUsageEventStore();
    await store.append([
      event({ quantity: 10, unit: 'input_token' }),
      event({ quantity: 5, unit: 'input_token' }),
      event({ quantity: 7, unit: 'output_token', provider: 'openai', operation: 'chat' }),
      event({ quantity: 3, category: 'dataforseo', provider: 'dataforseo', operation: 'serp_live', unit: 'serp_request' }),
    ]);

    const totals = await store.aggregate({ actorUserId: '33333333-3333-4333-8333-333333333333', projectId: PROJECT });
    expect(totals).toEqual([
      { category: 'ai', provider: 'openai', operation: 'chat', unit: 'input_token', quantity: 15, eventCount: 2 },
      { category: 'ai', provider: 'openai', operation: 'chat', unit: 'output_token', quantity: 7, eventCount: 1 },
      { category: 'dataforseo', provider: 'dataforseo', operation: 'serp_live', unit: 'serp_request', quantity: 3, eventCount: 1 },
    ]);
  });

  it('applies filters to aggregation and never mixes scopes', async () => {
    const store = new InMemoryUsageEventStore();
    await store.append([
      event({ quantity: 10, unit: 'input_token' }),
      event({ quantity: 4, unit: 'output_token' }),
      event({ quantity: 999, projectId: OTHER_PROJECT, unit: 'input_token' }),
    ]);

    const totals = await store.aggregate({ actorUserId: '33333333-3333-4333-8333-333333333333', projectId: PROJECT });
    expect(totals.reduce((sum, row) => sum + row.quantity, 0)).toBe(14);

    const outputOnly = await store.aggregate({ actorUserId: '33333333-3333-4333-8333-333333333333', projectId: PROJECT, unit: 'output_token' });
    expect(outputOnly).toEqual([
      { category: 'ai', provider: 'openai', operation: 'chat', unit: 'output_token', quantity: 4, eventCount: 1 },
    ]);

    await expect(store.aggregate({ actorUserId: '33333333-3333-4333-8333-333333333333' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('returns copies so callers cannot mutate the ledger', async () => {
    const store = new InMemoryUsageEventStore();
    await store.append([event({ sourceId: 's1' })]);
    const [first] = await store.list({ projectId: PROJECT });
    first.quantity = 9999;
    const [again] = await store.list({ projectId: PROJECT });
    expect(again.quantity).toBe(100);
  });
});
