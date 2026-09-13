/**
 * Internal hybrid retrieval model (KB10/KB10.2).
 *
 * These types are private to the knowledge retrieval boundary: they are the
 * vocabulary the vector adapter, the lexical adapter, the reconcile step, the
 * fusion step and the pipeline share while assembling candidates. They are
 * deliberately NOT part of `@seo/contracts` - a candidate's origin and
 * origin-local score never leak to the API surface. `KnowledgeService.search`
 * remains the only public owner and maps fused candidates back onto the stable
 * search DTO (the fused score is the only score exposed, and it is still just a
 * ranking signal).
 */

import type { ManagedSourceFacts } from './sourceFacts.js';

/**
 * How candidates are gathered for a request.
 *   - `vector`: the previous vector-only behavior (safe fallback).
 *   - `hybrid`: vector + lexical candidates fused with reciprocal rank fusion.
 */
export type RetrievalMode = 'vector' | 'hybrid';

/** Which retrieval path produced a candidate. */
export type RetrievalOrigin = 'vector' | 'lexical';

/** One retrieval hit before attribution and before the public mapping. */
export interface KnowledgeCandidate {
  /** Canonical identity `${sourceId}::${chunkId}` (dedup key, never content). */
  key: string;
  /** Managed source UUID, or the provider external id for system knowledge. */
  sourceId: string;
  /** Chunk identity within the source, or null for source-granular hits. */
  chunkId: string | null;
  origin: RetrievalOrigin;
  /** Untrusted plain text of the hit (bounded by the retrieval limits). */
  content: string;
  /** Origin-local score. Only meaningful within one origin; fusion replaces it. */
  score: number;
  /** Provider payload for vector hits, synthesized payload for lexical hits. */
  payload: Record<string, unknown>;
}

/**
 * Internal, non-public retrieval diagnostics. Used for logging only; the
 * public `KnowledgeSearchDiagnosticsDto` stays unchanged (no origin names,
 * candidate counts or provider internals reach the browser).
 */
export interface RetrievalDiagnostics {
  mode: RetrievalMode;
  vectorCandidates: number;
  lexicalCandidates: number;
  fused: boolean;
  vectorFailed: boolean;
  lexicalFailed: boolean;
  /** True when a derived (freshness) filter was honoured via a source allowlist. */
  derivedScope: boolean;
  /** True when a configured reranker returned a usable ranking (KB10.3). */
  rerankApplied: boolean;
  /** True when a reranker was configured, tried and failed (RRF fallback used). */
  rerankFailed: boolean;
}

/** Fused candidates, resolved managed-source facts and internal diagnostics. */
export interface RetrievalOutcome {
  candidates: KnowledgeCandidate[];
  /** Facts for every managed source referenced by the reconciled candidates. */
  sourceFacts: Map<string, ManagedSourceFacts>;
  diagnostics: RetrievalDiagnostics;
}
