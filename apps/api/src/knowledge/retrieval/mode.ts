/**
 * Retrieval mode resolution (KB10).
 *
 * The mode is read once from validated server config and passed explicitly
 * through the pipeline - there are no per-adapter or per-call feature flags.
 * An absent value resolves to `hybrid`; an invalid value fails fast at boot in
 * config validation (never a silent fallback). `vector` is the explicit, safe
 * fallback mode.
 */

import type { RetrievalMode } from './types.js';

export const KNOWLEDGE_RETRIEVAL_MODES: readonly RetrievalMode[] = ['vector', 'hybrid'];

/** Resolve the configured retrieval mode from the validated env object. */
export function resolveRetrievalMode(env: { KNOWLEDGE_RETRIEVAL_MODE?: unknown }): RetrievalMode {
  const raw = typeof env.KNOWLEDGE_RETRIEVAL_MODE === 'string' ? env.KNOWLEDGE_RETRIEVAL_MODE.trim().toLowerCase() : '';
  return raw === 'vector' ? 'vector' : 'hybrid';
}
