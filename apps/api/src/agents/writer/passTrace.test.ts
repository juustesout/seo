/**
 * Writer pass trace tests (W2a): the recorder is bounded (oldest entries drop
 * first), `tracePass` records identity/timing/outcome for both success and
 * failure and rethrows, and a failure note is bounded and secret-free. The
 * trace carries no prompts or generated bodies by construction.
 */

import { describe, expect, it } from 'vitest';
import { WRITER_DEEP_MAX_PASS_TRACE_ENTRIES } from '@seo/contracts';
import { ApiError } from '../../apiErrors.js';
import { createWriterPassTrace, tracePass, type WriterPassTraceEntry } from './passTrace.js';

function entry(overrides: Partial<WriterPassTraceEntry> = {}): WriterPassTraceEntry {
  return {
    id: 'architecture:1',
    kind: 'architecture',
    unit: null,
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
    durationMs: 1,
    ok: true,
    note: null,
    ...overrides,
  };
}

describe('tracePass', () => {
  it('records an ok entry with the pass identity and returns the value', async () => {
    const trace = createWriterPassTrace();
    const value = await tracePass(trace, 'context', null, async () => 'ok');
    expect(value).toBe('ok');

    const [recorded] = trace.snapshot();
    expect(recorded).toMatchObject({ kind: 'context', unit: null, ok: true, note: null });
    expect(recorded!.durationMs).toBeGreaterThanOrEqual(0);
    expect(trace.length).toBe(1);
  });

  it('records a bounded failure note and rethrows', async () => {
    const trace = createWriterPassTrace();
    await expect(
      tracePass(trace, 'section_generation', 'section_0:p0', async () => {
        throw ApiError.notConfigured('Project AI is not configured.');
      }),
    ).rejects.toMatchObject({ code: 'not_configured' });

    const [recorded] = trace.snapshot();
    expect(recorded).toMatchObject({ kind: 'section_generation', unit: 'section_0:p0', ok: false });
    expect(recorded!.note).toContain('not configured');
    expect(recorded!.note!.length).toBeLessThan(400);
  });

  it('generates deterministic ids in execution order', () => {
    const trace = createWriterPassTrace();
    expect(trace.nextId('architecture', null)).toBe('architecture:1');
    expect(trace.nextId('section_planning', 'section_0')).toBe('section_planning:section_0:2');
  });
});

describe('WriterPassTraceRecorder', () => {
  it('is bounded and drops the oldest entries first', () => {
    const trace = createWriterPassTrace();
    for (let index = 0; index < WRITER_DEEP_MAX_PASS_TRACE_ENTRIES + 5; index += 1) {
      trace.record(entry({ id: `pass:${index}` }));
    }
    const snapshot = trace.snapshot();
    expect(snapshot).toHaveLength(WRITER_DEEP_MAX_PASS_TRACE_ENTRIES);
    expect(snapshot[0]!.id).toBe('pass:5');
    expect(snapshot[snapshot.length - 1]!.id).toBe(`pass:${WRITER_DEEP_MAX_PASS_TRACE_ENTRIES + 4}`);
  });

  it('snapshots are copies', () => {
    const trace = createWriterPassTrace();
    trace.record(entry());
    const snapshot = trace.snapshot();
    snapshot[0]!.ok = false;
    expect(trace.snapshot()[0]!.ok).toBe(true);
  });
});
