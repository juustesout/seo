/**
 * Service container wiring the API together: config, Supabase service client,
 * access checks, credential store, job store and the provider registry.
 *
 * Everything request handlers and executors need is reached through this one
 * object, so tests can substitute real services with doubles at the container
 * boundary and no component ever constructs its own Supabase/registry.
 */

import { loadConfig, type AppConfig } from './config.js';
import { logger } from './logger.js';
import { AccessService, createAdminClient } from './supabase.js';
import { CredentialStore } from './infra/credentials.js';
import { normalizeKey } from './crypto.js';
import { ApiError } from './apiErrors.js';
import { buildRegistry } from './providers/registry.js';
import { SupabaseJobStore } from './jobs/supabaseJobStore.js';
import { PostgresJobStore } from './jobs/postgresJobStore.js';
import type { JobStore } from './jobs/types.js';
import type { Pool } from 'pg';
import pg from 'pg';
import type { ProviderContext, ProviderRegistry } from '@seo/contracts';

export interface ServiceContainer {
  config: AppConfig;
  /** Supabase service-role client. RLS still applies (auth.uid = your user). */
  sb: ReturnType<typeof createAdminClient>;
  /** Project membership + role authorization for every project-scoped op. */
  access: AccessService;
  /** AES-encrypted credential store (seo_credentials), never exposed to the web. */
  credentials: CredentialStore;
  /** Provider plugin surface (adapters by id). */
  registry: ProviderRegistry;
  /** Durable job queue used by long operations. */
  jobStore: JobStore;
  /** Direct Postgres pool, present when SUPABASE_DB_URL is configured. */
  pgPool: Pool | null;
}

let cached: ServiceContainer | null = null;

/**
 * Build (once) and return the process-wide service container. The container is
 * a singleton per process so the registry, pools and clients are shared; it
 * refuses to start when Supabase is not configured, because without it no
 * request or job can make progress.
 *
 * Job-store selection is an environment decision: with SUPABASE_DB_URL a direct
 * Postgres pool is used (atomic SKIP LOCKED claims + LISTEN/NOTIFY wake-ups);
 * without it, the Supabase polling store is used so the platform still runs on
 * a hosted Supabase where no direct DB connection exists.
 */
export function getContainer(): ServiceContainer {
  if (cached) return cached;
  const config = loadConfig();
  if (!config.supabaseConfigured) {
    throw ApiError.notConfigured(
      'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  const sb = createAdminClient(config.env.SUPABASE_URL!, config.env.SUPABASE_SERVICE_ROLE_KEY!);
  const key = normalizeKey(config.env.CREDENTIALS_ENCRYPTION_KEY);

  let jobStore: JobStore;
  let pgPool: Pool | null = null;
  const dbUrl = config.env.SUPABASE_DB_URL;
  if (dbUrl) {
    pgPool = new pg.Pool({ connectionString: dbUrl, max: 10 });
    jobStore = new PostgresJobStore(pgPool);
    logger.info('using direct-postgres job store (LISTEN/NOTIFY)');
  } else {
    jobStore = new SupabaseJobStore(sb);
    logger.info('using supabase polling job store (set SUPABASE_DB_URL for LISTEN/NOTIFY)');
  }

  const container: ServiceContainer = {
    config,
    sb,
    access: new AccessService(sb),
    credentials: new CredentialStore(sb, key),
    registry: buildRegistry({
      config: {
        GOOGLE_CLIENT_ID: config.env.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: config.env.GOOGLE_CLIENT_SECRET,
        DATAFORSEO_LOGIN: config.env.DATAFORSEO_LOGIN,
        DATAFORSEO_PASSWORD: config.env.DATAFORSEO_PASSWORD,
        DATAFORSEO_BASE64: config.env.DATAFORSEO_BASE64,
        QDRANT_URL: config.env.QDRANT_URL,
        QDRANT_API_KEY: config.env.QDRANT_API_KEY,
        OPENAI_API_KEY: config.env.OPENAI_API_KEY,
        OPENAI_BASE_URL: config.env.OPENAI_BASE_URL,
        OPENAI_CHAT_MODEL: config.env.OPENAI_CHAT_MODEL,
        OPENAI_EMBEDDING_MODEL: config.env.OPENAI_EMBEDDING_MODEL,
        OPENAI_IMAGE_MODEL: config.env.OPENAI_IMAGE_MODEL,
        UNSPLASH_ACCESS_KEY: config.env.UNSPLASH_ACCESS_KEY,
        EMBEDDINGS_BASE_URL: process.env.EMBEDDINGS_BASE_URL,
        EMBEDDINGS_API_KEY: process.env.EMBEDDINGS_API_KEY,
        EMBEDDINGS_MODEL: process.env.EMBEDDINGS_MODEL,
        EMBEDDINGS_DIMENSIONS: process.env.EMBEDDINGS_DIMENSIONS,
        PUBLIC_APP_URL: config.env.PUBLIC_APP_URL,
        X_OAUTH_CLIENT_ID: config.env.X_OAUTH_CLIENT_ID,
        ENABLE_TEST_PUBLISHERS: config.env.ENABLE_TEST_PUBLISHERS,
      },
      logger,
    }),
    jobStore,
    pgPool,
  };
  cached = container;
  return container;
}

/**
 * ProviderContext for an operation bound to a publisher row (WordPress, X,
 * ...): the credential reader is scoped to that publisher so tokens read/write
 * under the publisher's encrypted scope.
 */
export function buildPublisherProviderContext(
  container: ServiceContainer,
  args: { projectId: string; userId: string | null; publisherId: string; providerType: string; config?: Record<string, unknown> },
): ProviderContext {
  return buildProviderContext(container, {
    projectId: args.projectId,
    userId: args.userId,
    owner: { publisherId: args.publisherId, providerType: args.providerType },
    config: args.config,
  });
}

/**
 * Build the ProviderContext passed into adapter calls. It namespaces the logger
 * per project + provider and scopes the credential reader to the owning
 * integration or publisher row, so an adapter can only ever see the secrets of
 * the exact row it is operating on - never another project's or provider's.
 */
export function buildProviderContext(
  container: ServiceContainer,
  args: {
    projectId: string;
    userId: string | null;
    owner: { integrationId: string; providerType: string } | { publisherId: string; providerType: string };
    config?: Record<string, unknown>;
  },
): ProviderContext {
  const providerType =
    'integrationId' in args.owner ? args.owner.providerType : args.owner.providerType;
  const child = logger.child({ projectId: args.projectId, provider: providerType });
  const safeLogger = {
    info: (m: string, meta?: Record<string, unknown>) => child.info(meta ?? {}, m),
    warn: (m: string, meta?: Record<string, unknown>) => child.warn(meta ?? {}, m),
    error: (m: string, meta?: Record<string, unknown>) => child.error(meta ?? {}, m),
    debug: (m: string, meta?: Record<string, unknown>) => child.debug(meta ?? {}, m),
  };
  const credentials =
    'integrationId' in args.owner
      ? container.credentials.reader({ integrationId: args.owner.integrationId }, providerType)
      : container.credentials.reader({ publisherId: args.owner.publisherId }, providerType);
  return {
    projectId: args.projectId,
    userId: args.userId,
    config: args.config ?? {},
    credentials,
    logger: safeLogger,
  };
}
