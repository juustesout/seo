/**
 * AES-256-GCM encryption for secrets stored in seo_credentials.
 * Key: 32 random bytes supplied as base64 via CREDENTIALS_ENCRYPTION_KEY.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32;

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
}

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

export function decryptSecret(key: Buffer, payload: EncryptedPayload): string {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
}

export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}
