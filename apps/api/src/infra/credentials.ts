/**
 * Encrypted credential store backed by seo_credentials. Implements the
 * CredentialReader contract providers receive per project/integration (or per
 * publisher), so secrets can be read/written by name without the browser ever
 * seeing them. Credential rows are owned by exactly one of an integration or a
 * publisher (enforced by a DB check constraint).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from '../apiErrors.js';
import { decryptSecret, encryptSecret, type EncryptedPayload } from '../crypto.js';
import type { CredentialReader } from '@seo/contracts';
import { logger } from '../logger.js';

type Owner = { integrationId: string } | { publisherId: string } | { projectId: string; scope: 'ai' };

/**
 * The DB column that owns a credential row. Integrations and publishers have
 * their own owner column + unique constraint so a key name is only unique
 * within one owner, never globally.
 */
function ownerColumn(owner: Owner): string {
  if ('integrationId' in owner) return 'integration_id';
  if ('publisherId' in owner) return 'publisher_id';
  return 'project_id';
}

/** The { owner_column: owner_id } pair used to match rows in WHERE clauses. */
function ownerMatch(owner: Owner): Record<string, string> {
  if ('integrationId' in owner) return { integration_id: owner.integrationId };
  if ('publisherId' in owner) return { publisher_id: owner.publisherId };
  return { project_id: owner.projectId };
}

/** Column pair the per-owner unique constraint spans (for upsert onConflict). */
function ownerConflict(owner: Owner): string {
  if ('integrationId' in owner) return 'integration_id,key_name';
  if ('publisherId' in owner) return 'publisher_id,key_name';
  return 'project_id,key_name';
}

/**
 * AES-encrypted credential store over seo_credentials. All writes go through
 * Supabase as the service-role user, so RLS still applies; rows are scoped by
 * owner column and never fetched across owners. A null key means the store is
 * unusable and every operation fails with a "not configured" ApiError rather
 * than silently storing plaintext.
 */
export class CredentialStore {
  constructor(
    private readonly sb: SupabaseClient,
    private readonly key: Buffer | null,
  ) {}

  /**
   * Fail fast when CREDENTIALS_ENCRYPTION_KEY is absent. This guard is the
   * reason a misconfigured server can never degrade into writing secrets in
   * the clear.
   */
  private requireKey(): Buffer {
    if (!this.key) {
      throw ApiError.notConfigured(
        'Credential storage is not configured: set CREDENTIALS_ENCRYPTION_KEY (base64, 32 bytes)',
      );
    }
    return this.key;
  }

  /**
   * The CredentialReader surface providers receive (via ProviderContext /
   * publisher context). Each reader is bound to exactly one owner + provider
   * type, so provider code cannot read across owners even if it tried.
   */
  reader(owner: Owner, providerType: string): CredentialReader {
    return {
      get: (key) => this.get(owner, providerType, key),
      set: (key, value, meta) => this.set(owner, providerType, key, value, meta),
      delete: (key) => this.delete(owner, providerType, key),
    };
  }

  /**
   * Read + decrypt one credential. Ciphertext columns are fetched for the
   * exact owner row; a missing row yields null (callers treat that as "not
   * connected"), a decryption failure is a hard error because tampered or
   * wrongly-keyed ciphertext must never surface as a plausible secret.
   */
  private async get(owner: Owner, providerType: string, keyName: string): Promise<string | null> {
    const query = this.sb
      .from('seo_credentials')
      .select('ciphertext, iv, auth_tag')
      .eq('provider_type', providerType)
      .eq('key_name', keyName);
    const { data, error } = await query
      .eq(ownerColumn(owner), ownerMatch(owner)[ownerColumn(owner)])
      .maybeSingle<{ ciphertext: string; iv: string; auth_tag: string | null }>();
    if (error) {
      logger.error({ error, keyName }, 'credential read failed');
      throw ApiError.badRequest('Could not read credential');
    }
    if (!data) return null;
    try {
      return decryptSecret(this.requireKey(), {
        ciphertext: data.ciphertext,
        iv: data.iv,
        authTag: data.auth_tag ?? '',
      });
    } catch {
      logger.error({ keyName }, 'credential decryption failed');
      throw ApiError.badRequest('Stored credential could not be decrypted');
    }
  }

  /**
   * Encrypt + upsert one credential under its owner's unique (owner, key_name)
   * constraint. meta carries non-secret context (e.g. OAuth scope) that the UI
   * may read; the value itself only ever exists server-side in ciphertext.
   */
  private async set(
    owner: Owner,
    providerType: string,
    keyName: string,
    value: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const encrypted: EncryptedPayload = encryptSecret(this.requireKey(), value);
    const { error } = await this.sb.from('seo_credentials').upsert(
      {
        ...ownerMatch(owner),
        provider_type: providerType,
        key_name: keyName,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        auth_tag: encrypted.authTag,
        meta: meta ?? {},
      } as never,
      { onConflict: ownerConflict(owner) },
    );
    if (error) {
      logger.error({ error, keyName }, 'credential write failed');
      throw ApiError.badRequest('Could not store credential');
    }
  }

  /** Remove a single credential (used when a token is rotated away or a scope dropped). */
  private async delete(owner: Owner, providerType: string, keyName: string): Promise<void> {
    const { error } = await this.sb
      .from('seo_credentials')
      .delete()
      .eq('provider_type', providerType)
      .eq('key_name', keyName)
      .eq(ownerColumn(owner), ownerMatch(owner)[ownerColumn(owner)]);
    if (error) {
      logger.error({ error }, 'credential delete failed');
      throw ApiError.badRequest('Could not delete credential');
    }
  }

  /** Remove every credential row belonging to an owner (disconnect). */
  async clearForOwner(owner: Owner): Promise<void> {
    const { error } = await this.sb
      .from('seo_credentials')
      .delete()
      .eq(ownerColumn(owner), ownerMatch(owner)[ownerColumn(owner)]);
    if (error) {
      logger.error({ error }, 'credential clear failed');
      throw ApiError.badRequest('Could not clear credentials');
    }
  }
}
