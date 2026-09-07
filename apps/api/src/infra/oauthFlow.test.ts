import { describe, expect, it } from 'vitest';
import { codeChallenge, createPkcePair, randomCodeVerifier } from './oauthPkce.js';
import { signJsonPayload, verifyJsonPayload } from './signedPayload.js';

describe('OAuth PKCE primitives (RFC 7636)', () => {
  it('mints verifiers within the RFC 43-128 character window', () => {
    for (let i = 0; i < 20; i++) {
      const v = randomCodeVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
      expect(v).toMatch(/^[A-Za-z0-9\-_]+$/);
    }
  });

  it('produces a deterministic S256 base64url challenge for a verifier', () => {
    const pair = createPkcePair();
    expect(pair.codeChallenge).toBe(codeChallenge(pair.codeVerifier));
    expect(pair.codeChallenge).not.toBe(pair.codeVerifier);
    expect(codeChallenge('a')).toBe(codeChallenge('a'));
    expect(codeChallenge('a')).not.toBe(codeChallenge('b'));
  });

  it('generates a fresh pair per request', () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.codeChallenge).not.toBe(b.codeChallenge);
  });
});

describe('HMAC-signed state payloads', () => {
  it('round-trips a payload through sign + verify', () => {
    const state = { projectId: 'p1', publisherId: 'pub1', nonce: 'n' };
    const token = signJsonPayload(state, 'secret');
    expect(verifyJsonPayload<typeof state>(token, 'secret')).toEqual(state);
  });

  it('rejects tampered tokens and wrong secrets', () => {
    const token = signJsonPayload({ a: 1 }, 'secret');
    expect(() => verifyJsonPayload(token, 'other')).toThrow();
    const [payload, sig] = token.split('.');
    const tampered = `${Buffer.from(JSON.stringify({ a: 2 })).toString('base64url')}.${sig}`;
    expect(() => verifyJsonPayload(tampered, 'secret')).toThrow();
    expect(() => verifyJsonPayload('not-a-valid-token', 'secret')).toThrow();
  });
});
