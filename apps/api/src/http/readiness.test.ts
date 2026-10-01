import { describe, expect, it, vi } from 'vitest';
import { checkReadiness } from './readiness.js';
import type { ServiceContainer } from '../context.js';

function containerWith(sb: unknown, pgPool: unknown = null): ServiceContainer {
  return { sb, pgPool } as unknown as ServiceContainer;
}

function fakeSb(result: { error: unknown }) {
  return { from: () => ({ select: () => ({ limit: async () => result }) }) };
}

describe('checkReadiness', () => {
  it('passes when the Supabase ping succeeds', async () => {
    await expect(checkReadiness(containerWith(fakeSb({ error: null })))).resolves.toBeUndefined();
  });

  it('throws 503 not_ready when the Supabase ping fails', async () => {
    await expect(checkReadiness(containerWith(fakeSb({ error: { message: 'boom' } })))).rejects.toMatchObject({
      status: 503,
      code: 'not_ready',
    });
  });

  it('prefers the direct Postgres pool when present', async () => {
    const query = vi.fn(async () => ({}));
    await checkReadiness(containerWith({}, { query }));
    expect(query).toHaveBeenCalledWith('select 1');
  });
});
