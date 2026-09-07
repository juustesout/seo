/**
 * Project + account (master) API keys.
 *
 * Two kinds live in one seo_api_keys table: project keys are bound to exactly
 * one project (project_id set); account keys (project_id = NULL) belong to the
 * creating user and may address any project that user is a member of, never
 * stronger than that membership - the caller ANDs the key's read/write scopes
 * with the resolved per-project role on every request.
 *
 * Security model: only a SHA-256 hash of each key is stored (key_hash, unique)
 * and the plaintext is returned exactly once at creation. Authentication looks
 * the candidate row up by its 16-char key_prefix (a bounded index lookup), then
 * compares the full hash - so a leaked table yields only hashes and prefixes,
 * never usable keys. Revocation is a soft delete (revoked_at) that leaves the
 * row and name intact but makes authenticate() return null. Uniqueness is
 * enforced by the schema, not the app: key_hash is globally unique and names
 * are unique per (project, name) / per (created_by, name) for account keys.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from '../apiErrors.js';

/** Entropy of a generated key (24 random bytes base64url-encoded). */
const TOKEN_BYTES = 24;
/** Length of the stored lookup prefix (also what the UI shows). */
const PREFIX_CHARS = 16;

/** What an API key is allowed to do. read/write is the whole vocabulary. */
export type ApiKeyScope = 'read' | 'write';

export interface ApiKeyRecord {
  id: string;
  /** NULL means this is an account (master) key bound to the owning user. */
  project_id: string | null;
  name: string;
  key_prefix: string;
  scopes: ApiKeyScope[];
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * Generate a new plaintext key: `seo_live_` + 24 random bytes in base64url.
 * The prefix makes keys self-describing (they are never mistaken for a JWT),
 * and 192 bits of entropy make guessing or colliding effectively impossible.
 * The plaintext is shown once at creation and never stored.
 */
export function generateApiKey(): string {
  return `seo_live_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

/**
 * One-way SHA-256 of a key. This is all that is ever persisted, so a database
 * leak cannot be turned back into usable keys. Used both at create time (to
 * store) and at authenticate time (to compare), so the full plaintext is the
 * only thing that can ever match a row.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * First PREFIX_CHARS characters of a key - the indexed lookup column. Because
 * it is only a prefix, it can be shown in the UI and used to find the (usually
 * single) candidate row cheaply before the full-hash comparison runs.
 */
export function keyPrefix(key: string): string {
  return key.slice(0, PREFIX_CHARS);
}

/**
 * Cheap format gate: a key must carry the seo_live_ prefix and be at least
 * prefix-length. Lets the auth boundary tell API keys apart from Supabase user
 * JWTs and from garbage without hashing anything, and keeps authenticate() from
 * hashing arbitrary attacker-controlled strings against the table.
 */
export function isApiKeyFormat(key: string): boolean {
  return key.length >= PREFIX_CHARS && key.startsWith('seo_live_');
}

/**
 * The exact columns surfaced for management/display. key_hash is deliberately
 * absent so a list/create/read can never accidentally return a hash to the UI;
 * authenticate() re-selects it explicitly only for the in-memory comparison.
 */
const PUBLIC_COLUMNS =
  'id, project_id, name, key_prefix, scopes, created_by, created_at, last_used_at, revoked_at';

type Row = Record<string, unknown>;

/**
 * CRUD + authentication for seo_api_keys over the service-role client.
 * Management calls (list/create/revoke) are scoped by project id or owner so
 * one caller can never touch another project's or another user's keys, even
 * though the service-role client bypasses RLS. Authentication is prefix lookup
 * followed by a full-hash compare, with revoked rows rejected.
 */
export class ApiKeyStore {
  constructor(private readonly sb: SupabaseClient) {}

  /** Project keys of one project, newest first (management UI + admin list). */
  async list(projectId: string): Promise<ApiKeyRecord[]> {
    const { data, error } = await this.sb
      .from('seo_api_keys')
      .select(PUBLIC_COLUMNS)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });
    if (error) throw ApiError.badRequest('Could not list API keys');
    return (data ?? []) as unknown as ApiKeyRecord[];
  }

  /** Account (master) keys owned by a user (project_id is NULL). */
  async listAccountKeys(userId: string): Promise<ApiKeyRecord[]> {
    const { data, error } = await this.sb
      .from('seo_api_keys')
      .select(PUBLIC_COLUMNS)
      .is('project_id', null)
      .eq('created_by', userId)
      .order('created_at', { ascending: false });
    if (error) throw ApiError.badRequest('Could not list API keys');
    return (data ?? []) as unknown as ApiKeyRecord[];
  }

  /**
   * Creates a key and returns it exactly once (plaintext). projectId null
   * creates an account (master) key owned by the user.
   */
  async create(
    projectId: string | null,
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

  /**
   * Revokes a project key. Soft delete: sets revoked_at rather than deleting,
   * so the name/row stays visible in management history but authenticate()
   * rejects the key from then on. The update is scoped to both project_id and
   * id, so a caller who is a member of several projects can only ever revoke a
   * key that actually belongs to the project they name.
   */
  async revoke(projectId: string, id: string): Promise<void> {
    const { error } = await this.sb
      .from('seo_api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('project_id', projectId)
      .eq('id', id);
    if (error) throw ApiError.badRequest('Could not revoke API key');
  }

  /** Revokes one of the user's own account (master) keys (same soft-delete semantics). */
  async revokeAccountKey(userId: string, id: string): Promise<void> {
    const { error } = await this.sb
      .from('seo_api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .is('project_id', null)
      .eq('created_by', userId)
      .eq('id', id);
    if (error) throw ApiError.badRequest('Could not revoke API key');
  }

  /**
   * Resolve a bearer token to its (non-secret) record, or null when it is not a
   * known, live API key. Steps: reject non-seo_live_ strings without hashing;
   * find the candidate row by prefix; compare the full hash; reject revoked
   * keys. Only then is the request authenticated. last_used_at is touched
   * best-effort afterwards - a failure there is ignored because it must never
   * fail an otherwise valid authenticated request.
   */
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

  /** Scope check used by the API/MCP boundaries before honoring a request. */
  hasScope(record: ApiKeyRecord, scope: ApiKeyScope): boolean {
    return record.scopes.includes(scope);
  }
}
