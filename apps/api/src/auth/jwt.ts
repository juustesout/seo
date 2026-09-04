/**
 * Supabase JWT verification.
 *
 * Prefers JWKS discovery (modern Supabase, RS256). Falls back to HS256 shared
 * secret verification when SUPABASE_JWT_SECRET is configured. On success it
 * returns the verified claims; route code then performs its own membership /
 * role authorization per project.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';

export interface VerifiedUser {
  sub: string;
  email: string | null;
  claims: JWTPayload;
}

let remoteJwks:
  | { get: ReturnType<typeof createRemoteJWKSet>; url: string }
  | undefined;

function getRemoteJwks(supabaseUrl: string) {
  if (remoteJwks && remoteJwks.url === supabaseUrl) return remoteJwks.get;
  const wellKnown = new URL(`/auth/v1/.well-known/jwks.json`, supabaseUrl).toString();
  remoteJwks = { url: supabaseUrl, get: createRemoteJWKSet(new URL(wellKnown)) };
  return remoteJwks.get;
}

export async function verifyAccessToken(
  token: string,
  opts: { supabaseUrl: string; jwtSecret?: string },
): Promise<VerifiedUser> {
  if (!token) throw ApiError.unauthorized();

  try {
    if (opts.jwtSecret) {
      const secretKey = new TextEncoder().encode(opts.jwtSecret);
      const { payload } = await jwtVerify(token, secretKey, {
        issuer: `https://${new URL(opts.supabaseUrl).host}/auth/v1`,
        audience: 'authenticated',
      });
      return toVerifiedUser(payload);
    }

    const { payload } = await jwtVerify(token, getRemoteJwks(opts.supabaseUrl), {
      issuer: `https://${new URL(opts.supabaseUrl).host}/auth/v1`,
      audience: 'authenticated',
    });
    return toVerifiedUser(payload);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'token verification failed');
    throw ApiError.unauthorized('Invalid or expired session');
  }
}

function toVerifiedUser(payload: JWTPayload): VerifiedUser {
  const sub = payload.sub;
  if (!sub) throw ApiError.unauthorized('Token missing subject');
  return {
    sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    claims: payload,
  };
}

export function bearerToken(header?: string): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}
