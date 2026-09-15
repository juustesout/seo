/**
 * Writer execution pass trace (W2a).
 *
 * A bounded, in-memory record of every stage a writer run executes: what kind
 * of pass it was, which plan unit it addressed, when it ran, how long it took
 * and whether it succeeded. It exists so a deep_write run can be inspected and
 * tested without replaying the AI calls.
 *
 * It deliberately carries NO prompts and NO generated bodies: entries are
 * identity, timing and a bounded, secret-free failure note only. The recorder
 * is capped by WRITER_DEEP_MAX_PASS_TRACE_ENTRIES and drops the oldest entries
 * first, so a trace can never grow without limit. Nothing here is persisted;
 * a run that fails surfaces the trace to the caller/logs, and the engine result
 * carries it on success.
 */

import { WRITER_DEEP_MAX_PASS_TRACE_ENTRIES } from '@seo/contracts';
import { contextNoteFromError } from './context.js';

/** Every stage kind a writer run can trace. Kept closed so a new stage is an
 *  explicit addition here rather than an untyped string. */
export const WRITER_PASS_KINDS = [
  'context',
  'architecture',
  'section_planning',
  'section_generation',
  'paragraph_refinement',
  'coherence',
  'editorial_validation',
  'persist',
] as const;
export type WriterPassKind = (typeof WRITER_PASS_KINDS)[number];

/** One traced pass. `unit` is a deterministic, non-secret plan locator such as
 *  `section_3` or `section_3:p1`; `note` is a bounded failure description and
 *  is null when the pass succeeded. */
export interface WriterPassTraceEntry {
  id: string;
  kind: WriterPassKind;
  unit: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  ok: boolean;
  note: string | null;
}

/** The append-only recorder the engine and profiles write through. */
export class WriterPassTraceRecorder {
  private entries: WriterPassTraceEntry[] = [];
  private sequence = 0;

  /** Deterministic id for the next pass of a kind/unit; stable for a given
   *  execution order so tests can assert the stage sequence. */
  nextId(kind: WriterPassKind, unit: string | null): string {
    this.sequence += 1;
    return unit ? `${kind}:${unit}:${this.sequence}` : `${kind}:${this.sequence}`;
  }

  record(entry: WriterPassTraceEntry): void {
    this.entries.push(entry);
    if (this.entries.length > WRITER_DEEP_MAX_PASS_TRACE_ENTRIES) {
      this.entries.splice(0, this.entries.length - WRITER_DEEP_MAX_PASS_TRACE_ENTRIES);
    }
  }

  get length(): number {
    return this.entries.length;
  }

  snapshot(): WriterPassTraceEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}

/** Creates an empty trace recorder. */
export function createWriterPassTrace(): WriterPassTraceRecorder {
  return new WriterPassTraceRecorder();
}

/**
 * Runs one pass, records its identity/timing/outcome and rethrows on failure so
 * a failed run still stops honestly. A pass that completes without throwing is
 * recorded ok; a phase failure (ApiError) is recorded ok:false with a bounded,
 * secret-free note and surfaced unchanged to the caller.
 */
export async function tracePass<T>(
  trace: WriterPassTraceRecorder,
  kind: WriterPassKind,
  unit: string | null,
  fn: () => Promise<T> | T,
): Promise<T> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  try {
    const value = await fn();
    const endedAtMs = Date.now();
    trace.record({
      id: trace.nextId(kind, unit),
      kind,
      unit,
      startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: endedAtMs - startedAtMs,
      ok: true,
      note: null,
    });
    return value;
  } catch (err) {
    const endedAtMs = Date.now();
    trace.record({
      id: trace.nextId(kind, unit),
      kind,
      unit,
      startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: endedAtMs - startedAtMs,
      ok: false,
      note: contextNoteFromError(err),
    });
    throw err;
  }
}
