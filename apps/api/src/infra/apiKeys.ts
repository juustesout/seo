/**
 * Project API keys (REST v1 bearer tokens).
 *
 * Only a SHA-256 hash of each key is stored; the plaintext key is returned
 * once at creation. Lookups go through the short key prefix, then compare the
 * full hash, so a leaked table never reveals usable keys.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from '../apiErrors.js';

const TOKEN_BYTES = 24;
const PREFIX_CHARS = 16;

export type ApiKeyScope = 'read' | 'write';

export interface ApiKeyRecord {
  id: string;
  project_id: string;
  name: string;
  key_prefix: string;
  scopes: ApiKeyScope[];
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function generateApiKey(): string {
  return `seo_live_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function keyPrefix(key: string): string {
  return key.slice(0, PREFIX_CHARS);
}

export function isApiKeyFormat(key: string): boolean {
  return key.length >= PREFIX_CHARS && key.startsWith('seo_live_');
}

const PUBLIC_COLUMNS =
  'id, project_id, name, key_prefix, scopes, created_by, created_at, last_used_at, revoked_at';

type Row = Record<string, unknown>;

export class ApiKeyStore {
  constructor(private readonly sb: SupabaseClient) {}

  async list(projectId: string): Promise<ApiKeyRecord[]> {
    const { data, error } = await this.sb
      .from('seo_api_keys')
      .select(PUBLIC_COLUMNS)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    if (error) throw ApiError.badRequest('Could not list API keys');
    return (data ?? []) as unknown as ApiKeyRecord[];
  }

  /** Creates a key and returns it exactly once (plaintext). */
  async create(
    projectId: string,
    userId: string,
    name: string,
    scopes: ApiKeyScope[],
  ): Promise<{ key: string; record: ApiKeyRecord }> {
    const key = generateApiKey();
    const { data, error } = await this.sb
      .from('seo_api_keys')
      .insert({
        project_id: projectId,
        name,
        key_prefix: keyPrefix(key),
        key_hash: hashApiKey(key),
        scopes,
        created_by: userId,
      })
      .select(PUBLIC_COLUMNS)
      .single();
    if (error) throw ApiError.badRequest('Could not create API key');
    return { key, record: data as unknown as ApiKeyRecord };
  }

  async revoke(projectId: string, id: string): Promise<void> {
    const { error } = await this.sb
      .from('seo_api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('project_id', projectId)
      .eq('id', id);
    if (error) throw ApiError.badRequest('Could not revoke API key');
  }

  /** Resolves a bearer token to its (non-secret) record, or null. */
  async authenticate(token: string): Promise<ApiKeyRecord | null> {
    if (!isApiKeyFormat(token)) return null;
    const { data, error } = await this.sb
      .from('seo_api_keys')
      .select(`${PUBLIC_COLUMNS}, key_hash`)
      .eq('key_prefix', keyPrefix(token))
      .maybeSingle();
    if (error || !data) return null;
    if ((data as Row).key_hash !== hashApiKey(token)) return null;
    const record = data as unknown as ApiKeyRecord;
    if (record.revoked_at) return null;
    // Touch last_used_at best-effort (never blocks the request).
    await this.sb
      .from('seo_api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', record.id);
    return record;
  }

  hasScope(record: ApiKeyRecord, scope: ApiKeyScope): boolean {
    return record.scopes.includes(scope);
  }
}
