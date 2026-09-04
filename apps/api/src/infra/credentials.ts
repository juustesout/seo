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

type Owner = { integrationId: string } | { publisherId: string };

export class CredentialStore {
  constructor(
    private readonly sb: SupabaseClient,
    private readonly key: Buffer | null,
  ) {}

  private requireKey(): Buffer {
    if (!this.key) {
      throw ApiError.notConfigured(
        'Credential storage is not configured: set CREDENTIALS_ENCRYPTION_KEY (base64, 32 bytes)',
      );
    }
    return this.key;
  }

  private match(owner: Owner) {
    return 'integrationId' in owner
      ? { integration_id: owner.integrationId }
      : { publisher_id: owner.publisherId };
  }

  private onConflict(owner: Owner): string {
    return 'integrationId' in owner ? 'integration_id,key_name' : 'publisher_id,key_name';
  }

  reader(owner: Owner, providerType: string): CredentialReader {
    return {
      get: (key) => this.get(owner, providerType, key),
      set: (key, value, meta) => this.set(owner, providerType, key, value, meta),
      delete: (key) => this.delete(owner, providerType, key),
    };
  }

  private async get(owner: Owner, providerType: string, keyName: string): Promise<string | null> {
    const query = this.sb
      .from('seo_credentials')
      .select('ciphertext, iv, auth_tag')
      .eq('provider_type', providerType)
      .eq('key_name', keyName);
    const { data, error } = await query
      .eq('integration_id' in owner ? 'integration_id' : 'publisher_id', 'integrationId' in owner ? owner.integrationId : owner.publisherId)
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
        ...this.match(owner),
        provider_type: providerType,
        key_name: keyName,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        auth_tag: encrypted.authTag,
        meta: meta ?? {},
      } as never,
      { onConflict: this.onConflict(owner) },
    );
    if (error) {
      logger.error({ error, keyName }, 'credential write failed');
      throw ApiError.badRequest('Could not store credential');
    }
  }

  private async delete(owner: Owner, providerType: string, keyName: string): Promise<void> {
    const { error } = await this.sb
      .from('seo_credentials')
      .delete()
      .eq('provider_type', providerType)
      .eq('key_name', keyName)
      .eq('integration_id' in owner ? 'integration_id' : 'publisher_id', 'integrationId' in owner ? owner.integrationId : owner.publisherId);
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
      .eq('integration_id' in owner ? 'integration_id' : 'publisher_id', 'integrationId' in owner ? owner.integrationId : owner.publisherId);
    if (error) {
      logger.error({ error }, 'credential clear failed');
      throw ApiError.badRequest('Could not clear credentials');
    }
  }
}
