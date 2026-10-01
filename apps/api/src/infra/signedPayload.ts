/**
 * HMAC-signed URL-safe payloads for OAuth state tokens.
 *
 * The callback URL can only carry public query parameters, so every OAuth
 * flow (GSC account/integration connect, publisher connect-by-consent) signs
 * its state with the encryption key before sending the browser to the consent
 * screen. Verifying on the way back prevents both CSRF and tampering of the
 * project/publisher the callback would otherwise trust.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Default lifetime for a signed payload. OAuth states are short-lived by
 *  nature (start consent -> callback); anything older is treated as replayed. */
export const SIGNED_PAYLOAD_TTL_MS = 30 * 60 * 1000;

/** Encode + sign a JSON-serializable payload as `<base64url>.<base64url-sig>`.
 *  Adds `iat`/`exp` so a captured token cannot be replayed indefinitely. */
export function signJsonPayload(payload: object, secret: string, options: { ttlMs?: number } = {}): string {
  const now = Date.now();
  const body = { ...payload, iat: now, exp: now + (options.ttlMs ?? SIGNED_PAYLOAD_TTL_MS) };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

/** Verify + decode a signed payload. Throws on malformed/tampered input and on
 *  an expired payload (when it carries an `exp` claim). */
export function verifyJsonPayload<T extends object>(token: string, secret: string): T {
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) throw new Error('Invalid signed payload');
  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid signed payload signature');
  }
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T & { exp?: unknown };
  if (typeof parsed.exp === 'number' && Date.now() > parsed.exp) {
    throw new Error('Expired signed payload');
  }
  return parsed;
}
