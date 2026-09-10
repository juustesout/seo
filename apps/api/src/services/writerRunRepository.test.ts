/**
 * SupabaseWriterRunRepository transport tests.
 *
 * The durable writer run row keeps its safe snapshot in a jsonb column, so the
 * payload handed to the Supabase client must be the snapshot object itself.
 * Passing `JSON.stringify(snapshot)` stores a JSON string scalar in jsonb and
 * every later read fails the strict snapshot schema with
 * `writer_run_state_invalid`; these tests pin the object shape at the transport
 * boundary so that regression cannot come back silently.
 */
import { describe, expect, it } from 'vitest';
import { SupabaseWriterRunRepository } from './writerRunRepository.js';

interface Captured {
  insert?: Record<string, unknown>;
  update?: Record<string, unknown>;
}

/** Minimal chainable stand-in for the Supabase query builder covering exactly
 *  the calls the repository makes, while capturing the write payloads. */
function capturingClient() {
  const captured: Captured = {};
  const selectThenable = () => ({
    eq: () => selectThenable(),
    in: () => selectThenable(),
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (value: { data: { id: string }[]; error: null }) => unknown) =>
      Promise.resolve({ data: [{ id: 'row-1' }], error: null }).then(resolve),
  });
  const from = () => ({
    insert: (payload: Record<string, unknown>) => {
      captured.insert = payload;
      return { select: () => selectThenable() };
    },
    update: (payload: Record<string, unknown>) => {
      captured.update = payload;
      const chain = {
        eq: () => chain,
        in: () => chain,
        select: () => selectThenable(),
      };
      return chain;
    },
    select: () => selectThenable(),
  });
  return { sb: { from } as never, captured };
}

const SNAPSHOT = {
  runId: 'wr_11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  status: 'awaiting_approval',
};

describe('SupabaseWriterRunRepository', () => {
  it('inserts state_json as a jsonb object, never a JSON string', async () => {
    const { sb, captured } = capturingClient();
    const repo = new SupabaseWriterRunRepository(sb);

    await repo.insert({
      runId: SNAPSHOT.runId as never,
      accountId: null,
      projectId: SNAPSHOT.projectId,
      contentId: '33333333-3333-4333-8333-333333333333',
      userId: '44444444-4444-4444-8444-444444444444',
      status: 'awaiting_approval',
      snapshot: SNAPSHOT as never,
    });

    expect(captured.insert?.state_json).toBe(SNAPSHOT);
    expect(typeof captured.insert?.state_json).not.toBe('string');
  });

  it('updates state_json as a jsonb object, never a JSON string', async () => {
    const { sb, captured } = capturingClient();
    const repo = new SupabaseWriterRunRepository(sb);

    await repo.transition({
      runId: SNAPSHOT.runId as never,
      projectId: SNAPSHOT.projectId,
      contentId: '33333333-3333-4333-8333-333333333333',
      from: ['awaiting_approval'],
      to: 'writing',
      snapshot: SNAPSHOT as never,
      completedAt: null,
    });

    expect(captured.update?.state_json).toBe(SNAPSHOT);
    expect(typeof captured.update?.state_json).not.toBe('string');
  });
});
