/**
 * Proof Key for Code Exchange (RFC 7636) primitives for public OAuth clients.
 *
 * X's publisher connect uses a public (PKCE) client - there is no client
 * secret anywhere in the system, so the code_challenge/verifier pair is the
 * only thing proving the code exchange belongs to the browser flow that
 * started it. Both values are random server-side per authorization request.
 */

import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  /** Sent to the token endpoint when exchanging the code. Never leaves the server. */
  codeVerifier: string;
  /** Sent to the authorize endpoint (S256 of the verifier). */
  codeChallenge: string;
}

/** Random base64url verifier (43 chars - within RFC 7636's 43-128 window). */
export function randomCodeVerifier(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** S256 challenge for a verifier (base64url, unpadded). */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** A ready-to-use PKCE pair for one authorization request. */
export function createPkcePair(): PkcePair {
  const codeVerifier = randomCodeVerifier();
  return { codeVerifier, codeChallenge: codeChallenge(codeVerifier) };
}
