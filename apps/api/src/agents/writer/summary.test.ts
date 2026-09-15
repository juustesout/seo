/**
 * Compact writer run summary. The projection must be derived from the traced
 * passes only: real counts, an LLM-call count that matches the model-backed
 * stages, and a failed-stage label on failure. No fabricated fields.
 */
import { describe, expect, it } from 'vitest';
import type { WriterPassKind, WriterPassTraceEntry } from './passTrace.js';
import { buildWriterRunSummary, llmCallsFromPasses } from './summary.js';

function pass(kind: WriterPassKind, ok = true): WriterPassTraceEntry {
  return {
    id: `${kind}:1`,
    kind,
    unit: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:00.010Z',
    durationMs: 10,
    ok,
    note: ok ? null : 'boom',
  };
}

describe('buildWriterRunSummary', () => {
  it('counts passes by kind and derives LLM calls from model-backed stages', () => {
    const passes = [
      pass('context'),
      pass('architecture'),
      pass('section_generation'),
      pass('section_generation'),
      pass('editorial_validation'),
      pass('persist'),
    ];
    const summary = buildWriterRunSummary({ mode: 'quick_draft', format: 'short_article', passes, durationMs: 1234.6 });
    expect(summary).toEqual({
      mode: 'quick_draft',
      format: 'short_article',
      pass_count: 6,
      llm_calls: 3,
      duration_ms: 1235,
      by_kind: { context: 1, architecture: 1, section_generation: 2, editorial_validation: 1, persist: 1 },
    });
    expect(summary.failed_pass).toBeUndefined();
  });

  it('prefers an authoritative LLM-call count when one is supplied', () => {
    const summary = buildWriterRunSummary({
      mode: 'deep_write',
      format: 'explainer',
      passes: [pass('architecture'), pass('section_generation')],
      durationMs: 10,
      llmCalls: 7,
    });
    expect(summary.llm_calls).toBe(7);
  });

  it('records the last failed stage and never fabricates a successful field', () => {
    const summary = buildWriterRunSummary({
      mode: 'deep_write',
      format: 'short_article',
      passes: [pass('architecture'), pass('section_generation', false)],
      durationMs: 50,
    });
    expect(summary.failed_pass).toBe('section_generation');
    expect(summary.pass_count).toBe(2);
    expect(summary.llm_calls).toBe(2);
  });

  it('derives LLM calls from passes when no override is given', () => {
    expect(llmCallsFromPasses([pass('context'), pass('coherence'), pass('persist')])).toBe(1);
  });
});
