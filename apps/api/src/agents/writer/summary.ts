/**
 * Compact Writer run summary.
 *
 * Projects the bounded, in-memory pass trace into the small shape persisted on
 * a job result. Counts and a failed-stage label only: no prompts, no bodies and
 * no per-pass timings. `llm_calls` counts the pass kinds that make a model call,
 * so a Quick Draft is derived from its real execution path and a Deep Write can
 * use its own bounded call accounting. Nothing is fabricated: a kind with no
 * passes is absent from `by_kind`.
 */

import type { WriterExecutionProfileId, WriterFormatId, WriterRunSummary } from '@seo/contracts';
import type { WriterPassKind, WriterPassTraceEntry } from './passTrace.js';

/** Pass kinds that perform at least one model call in either execution profile. */
const LLM_PASS_KINDS: ReadonlySet<WriterPassKind> = new Set([
  'architecture',
  'section_planning',
  'section_generation',
  'paragraph_refinement',
  'coherence',
]);

/** Counts the model-backed passes in a trace (never a guessed number). */
export function llmCallsFromPasses(passes: WriterPassTraceEntry[]): number {
  return passes.filter((pass) => LLM_PASS_KINDS.has(pass.kind)).length;
}

/**
 * Builds the compact summary for one run. `llmCalls` overrides the trace-derived
 * count when a profile keeps authoritative accounting (Deep Write does); when
 * omitted, the count is derived from the traced model-backed stages.
 */
export function buildWriterRunSummary(args: {
  mode: WriterExecutionProfileId;
  format: WriterFormatId;
  passes: WriterPassTraceEntry[];
  durationMs: number;
  llmCalls?: number;
}): WriterRunSummary {
  const byKind: Record<string, number> = {};
  for (const pass of args.passes) byKind[pass.kind] = (byKind[pass.kind] ?? 0) + 1;
  const failed = args.passes.filter((pass) => !pass.ok);
  const summary: WriterRunSummary = {
    mode: args.mode,
    format: args.format,
    pass_count: args.passes.length,
    llm_calls: args.llmCalls ?? llmCallsFromPasses(args.passes),
    duration_ms: Math.max(0, Math.round(args.durationMs)),
    by_kind: byKind,
  };
  if (failed.length > 0) {
    summary.failed_pass = failed[failed.length - 1]!.kind;
  }
  return summary;
}
