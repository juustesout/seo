/**
 * Durable writer checkpoint host (W7).
 *
 * A writer run's LangGraph thread needs a checkpointer that survives process
 * restarts for crash recovery to work. This module owns that decision and its
 * honesty rules:
 *
 *   - with a direct Postgres pool (SUPABASE_DB_URL configured) the official
 *     @langchain/langgraph-checkpoint-postgres PostgresSaver is used. One
 *     saver is created lazily per pool and shared process-wide (so every route
 *     instance's compiled graphs read/write the same threads); .setup() runs
 *     once and is idempotent. A setup failure degrades loudly to the in-memory
 *     fallback and disables restart recovery for the rest of the process
 *     rather than pretending checkpoints are durable.
 *   - without a pool, a process-local MemorySaver is used (tests, hosted
 *     Supabase with no direct connection). Runs are then process-local: a
 *     restart loses threads and a durable row whose thread is gone is failed
 *     honestly by the service - never silently restarted from START.
 *
 * The host never touches seo_writer_runs; it only answers "which checkpointer
 * do compiled writer graphs share?".
 */

import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Pool } from 'pg';
import { logger } from '../logger.js';

/** Resolves the process-wide checkpointer writer graphs should share. */
export interface WriterCheckpointProvider {
  saver(): Promise<BaseCheckpointSaver>;
}

/** Process-local fallback used when there is no direct Postgres pool. */
const memoryFallback = new MemorySaver();

/**
 * Creates a provider over a direct Postgres pool (PostgresSaver + idempotent
 * .setup()) or, when the pool is absent, the in-memory fallback. Per-pool
 * PostgresSaver instances are cached and shared process-wide so graphs created
 * by different service instances (one per HTTP request) address the same
 * threads; distinct pools in tests stay isolated.
 */
export function createWriterCheckpointProvider(pool: Pool | null): WriterCheckpointProvider {
  if (!pool) {
    return { saver: async () => memoryFallback };
  }

  let cached: Promise<BaseCheckpointSaver> | null = null;
  return {
    saver(): Promise<BaseCheckpointSaver> {
      if (!cached) {
        cached = (async () => {
          const saver = new PostgresSaver(pool);
          await saver.setup();
          return saver;
        })().catch((err: unknown) => {
          logger.error(
            { err },
            'writer checkpoint PostgresSaver setup failed; falling back to in-memory checkpoints (writer runs will not survive a restart)',
          );
          cached = null;
          return memoryFallback;
        });
      }
      return cached;
    },
  };
}

const providersByPool = new WeakMap<object, WriterCheckpointProvider>();

/**
 * Default provider for a live service container: the container's direct
 * Postgres pool when present, else the process-local MemorySaver. The provider
 * is cached per pool so all HTTP/worker service instances in the process share
 * one PostgresSaver (and therefore one durable checkpoint namespace).
 */
export function defaultWriterCheckpointProvider(pool: Pool | null): WriterCheckpointProvider {
  if (!pool) {
    return createWriterCheckpointProvider(null);
  }
  let provider = providersByPool.get(pool);
  if (!provider) {
    provider = createWriterCheckpointProvider(pool);
    providersByPool.set(pool, provider);
  }
  return provider;
}
