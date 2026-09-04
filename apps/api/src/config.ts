/**
 * Central environment configuration. All application secrets come from the
 * environment - never from code or from client requests.
 */

import { z } from 'zod';

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

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

export type AppEnv = z.infer<typeof envSchema>;

export interface AppConfig {
  env: AppEnv;
  isProduction: boolean;
  supabaseConfigured: boolean;
  googleConfigured: boolean;
  dataforseoConfigured: boolean;
  qdrantConfigured: boolean;
  /** True when an OpenAI key is present server-side (AI + embeddings usable). */
  aiConfigured: boolean;
  /** null when the encryption key is missing (credential storage disabled). */
  encryptionConfigured: boolean;
  publicAppUrl: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  return {
    env: parsed,
    isProduction: parsed.NODE_ENV === 'production',
    supabaseConfigured: Boolean(parsed.SUPABASE_URL && parsed.SUPABASE_SERVICE_ROLE_KEY),
    googleConfigured: Boolean(parsed.GOOGLE_CLIENT_ID && parsed.GOOGLE_CLIENT_SECRET),
    dataforseoConfigured: Boolean(
      parsed.DATAFORSEO_BASE64 || (parsed.DATAFORSEO_LOGIN && parsed.DATAFORSEO_PASSWORD),
    ),
    qdrantConfigured: Boolean(parsed.QDRANT_URL && parsed.QDRANT_API_KEY),
    aiConfigured: Boolean(parsed.OPENAI_API_KEY),
    encryptionConfigured: Boolean(parsed.CREDENTIALS_ENCRYPTION_KEY),
    publicAppUrl: parsed.PUBLIC_APP_URL ?? null,
  };
}
