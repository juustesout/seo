/**
 * Central environment configuration - the only module that reads process env
 * vars, and therefore the only place secrets enter the API process.
 *
 * Secrets vs non-secrets: values such as SUPABASE_SERVICE_ROLE_KEY,
 * GOOGLE_CLIENT_SECRET, DATAFORSEO_BASE64 and CREDENTIALS_ENCRYPTION_KEY are
 * read here and handed to services by reference; they are never logged, echoed
 * or sent to the browser. Only the derived *Configured presence flags below are
 * safe to expose (the /api/health endpoint and catalog reflect them), and they
 * mean "the server holds credentials" - never that an upstream is reachable.
 *
 * Every variable is optional in the zod schema (barring defaults) so a bare
 * deploy boots and reports each capability as "not configured" (honesty rule)
 * instead of crashing. loadConfig() runs once at process start and throws on
 * an *invalid* value (malformed URL, non-numeric PORT, unknown NODE_ENV), so a
 * typo fails fast at boot rather than misbehaving halfway through a run.
 * Defaults: NODE_ENV=development, PORT=3001, LOG_LEVEL=info,
 * ENABLE_TEST_PUBLISHERS=false.
 */

import { z } from 'zod';

/**
 * zod schema - the source of truth for every env var name, format and default.
 * New configuration belongs here first; AppEnv and loadConfig then follow it.
 * Grouped by concern (Supabase, OAuth providers, AI/BYOK, ...) to mirror how a
 * feature is wired up. `z.coerce` on PORT lets a stringified port pass through.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),

  // Supabase (system of record). The service role key is the ONLY privileged
  // credential and it never leaves the server.
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  /** Direct Postgres connection URL (optional). Enables LISTEN/NOTIFY worker. */
  SUPABASE_DB_URL: z.string().optional(),
  /** Legacy HS256 signing secret (optional; JWKS discovery is used otherwise). */
  SUPABASE_JWT_SECRET: z.string().optional(),

  /** Public base URL of the app (used to build Google OAuth redirect URIs). */
  PUBLIC_APP_URL: z.string().url().optional(),
  /** Extra CORS origins beyond the app URL, comma separated. */
  CORS_ORIGINS: z.string().default(''),

  // Google (Search Console integration - separate from Supabase login OAuth).
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // X (publisher OAuth, public PKCE client - client id only, no secret).
  X_OAUTH_CLIENT_ID: z.string().optional(),

  // DataForSEO. Prefer DATAFORSEO_BASE64 (base64 of "login:password"); the raw
  // login/password pair is accepted as a fallback.
  DATAFORSEO_BASE64: z.string().optional(),
  DATAFORSEO_LOGIN: z.string().optional(),
  DATAFORSEO_PASSWORD: z.string().optional(),

  // Qdrant
  QDRANT_URL: z.string().url().optional(),
  QDRANT_API_KEY: z.string().optional(),

  // OpenAI (AI chat/generation/embeddings - BYOK key, server-side only).
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_CHAT_MODEL: z.string().optional(),
  OPENAI_EMBEDDING_MODEL: z.string().optional(),
  OPENAI_IMAGE_MODEL: z.string().optional(),

  // Unsplash (stock image search for content).
  UNSPLASH_ACCESS_KEY: z.string().optional(),

  // AES-256 key (base64, 32 bytes) used to encrypt seo_credentials at rest.
  CREDENTIALS_ENCRYPTION_KEY: z.string().optional(),

  // Opt-in test/demo providers (e.g. the mock social publisher). Defaults off
  // so non-real channels never appear in production catalogs.
  ENABLE_TEST_PUBLISHERS: z.enum(['true', 'false']).default('false'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

/** Parsed + validated environment (zod output; every non-optional key has a default). */
export type AppEnv = z.infer<typeof envSchema>;

/**
 * Resolved runtime config handed to services. `env` carries the raw validated
 * values; the booleans are cheap "is this integration wired up?" answers
 * derived from presence of the required env vars, so feature code can branch on
 * a flag instead of re-checking partial env state in dozens of places.
 */
export interface AppConfig {
  env: AppEnv;
  isProduction: boolean;
  supabaseConfigured: boolean;
  googleConfigured: boolean;
  /** True when an X OAuth client id is present (X publisher connect usable). */
  xConfigured: boolean;
  dataforseoConfigured: boolean;
  qdrantConfigured: boolean;
  /** True when an OpenAI key is present server-side (AI + embeddings usable). */
  aiConfigured: boolean;
  /** null when the encryption key is missing (credential storage disabled). */
  encryptionConfigured: boolean;
  publicAppUrl: string | null;
}

/**
 * Validate process.env against envSchema and derive the capability flags. Kept
 * a pure function of its input so tests can pass a synthetic env. Throws
 * ZodError on malformed values (fail fast at boot); absent-but-valid values
 * simply yield the schema defaults and a *Configured flag of false.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    env: parsed,
    isProduction: parsed.NODE_ENV === 'production',
    supabaseConfigured: Boolean(parsed.SUPABASE_URL && parsed.SUPABASE_SERVICE_ROLE_KEY),
    googleConfigured: Boolean(parsed.GOOGLE_CLIENT_ID && parsed.GOOGLE_CLIENT_SECRET),
    xConfigured: Boolean(parsed.X_OAUTH_CLIENT_ID),
    dataforseoConfigured: Boolean(
      parsed.DATAFORSEO_BASE64 || (parsed.DATAFORSEO_LOGIN && parsed.DATAFORSEO_PASSWORD),
    ),
    qdrantConfigured: Boolean(parsed.QDRANT_URL && parsed.QDRANT_API_KEY),
    aiConfigured: Boolean(parsed.OPENAI_API_KEY),
    encryptionConfigured: Boolean(parsed.CREDENTIALS_ENCRYPTION_KEY),
    publicAppUrl: parsed.PUBLIC_APP_URL ?? null,
  };
}
