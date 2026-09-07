/**
 * AES-256-GCM encryption for secrets stored in seo_credentials.
 * Key: 32 random bytes supplied as base64 via CREDENTIALS_ENCRYPTION_KEY.
 *
 * Encryption happens in the API process (never SQL-side) so a database backup
 * or read-only leak of seo_credentials stays ciphertext without the key. GCM
 * authenticates the ciphertext, so tampered rows fail decryption instead of
 * silently decrypting to garbage. Each row stores a fresh random 12-byte IV
 * plus the 16-byte auth tag next to the ciphertext.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;

/** Base64 ciphertext + IV + GCM auth tag, stored on the credential row. */
export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/**
 * Decode + validate the base64 CREDENTIALS_ENCRYPTION_KEY. Returns null (not an
 * exception) when unset or not exactly 32 bytes, because callers treat null as
 * "credential storage is not configured" and can produce a clean not_configured
 * error instead of crashing at boot.
 */
export function normalizeKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length !== KEY_BYTES) return null;
    return decoded;
  } catch {
    return null;
  }
}

/** Encrypt a plaintext secret with a fresh random IV (nonce reuse impossible). */
export function encryptSecret(key: Buffer, plaintext: string): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/** Decrypt a payload previously produced by encryptSecret (throws on tamper). */
export function decryptSecret(key: Buffer, payload: EncryptedPayload): string {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

/** Generate a fresh 32-byte base64 key for CREDENTIALS_ENCRYPTION_KEY. */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
