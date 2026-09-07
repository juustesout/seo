/**
 * Supabase JWT verification.
 *
 * Only Supabase-issued access tokens are accepted: the issuer is pinned to the
 * project's /auth/v1 host and the audience to 'authenticated'. Pinning the
 * audience rejects anonymous anon-key tokens and tokens minted for any other
 * audience before any route logic runs, so a token that passes here really
 * belongs to a signed-in Supabase user. Modern Supabase signs RS256 and exposes
 * a JWKS endpoint, which is discovered and cached; older/self-hosted
 * deployments sign HS256 with SUPABASE_JWT_SECRET, verified as a fallback when
 * that variable is configured. On success the verified claims are returned;
 * per-project membership/role authorization happens later in route code
 * (container.access.requireRole), never in this module.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';

/** Minimal verified identity a route can trust after signature/issuer/audience checks. */
export interface VerifiedUser {
  sub: string;
  email: string | null;
  claims: JWTPayload;
}

/**
 * Cache for the remote JWKS, keyed by supabaseUrl so one process can serve
 * more than one auth host. The jose RemoteJWKSet fetches the JWKS lazily and
 * re-fetches only when a token presents an unknown key id, so re-creating it
 * per request would add latency and network churn for no benefit.
 */
let remoteJwks:
  | { get: ReturnType<typeof createRemoteJWKSet>; url: string }
  | undefined;

/**
 * Return the cached JWKS set for a supabaseUrl, creating it on first use.
 * The well-known JWKS URL is derived from the project URL, never configured
 * separately, so there is no way to point verification at a foreign issuer.
 */
function getRemoteJwks(supabaseUrl: string) {
  if (remoteJwks && remoteJwks.url === supabaseUrl) return remoteJwks.get;
  const wellKnown = new URL(`/auth/v1/.well-known/jwks.json`, supabaseUrl).toString();
  remoteJwks = { url: supabaseUrl, get: createRemoteJWKSet(new URL(wellKnown)) };
  return remoteJwks.get;
}

/**
 * Verify a bearer token as a Supabase access token and return its claims.
 * Chooses HS256 shared-secret verification when SUPABASE_JWT_SECRET is set
 * (legacy/self-hosted Supabase) and RS256 JWKS verification otherwise; both
 * paths pin issuer to the auth host and audience to 'authenticated'. Every
 * failure mode - bad signature, expiry, wrong issuer/audience, malformed
 * token - collapses into a single 401 so callers cannot distinguish the cause
 * from outside and so no raw jose error text ever reaches a client.
 */
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

/**
 * Extract the stable VerifiedUser shape from already-verified claims. `sub` is
 * mandatory - it is the user id every membership check keys on - while email is
 * kept only when the token actually carried one. The full payload is retained
 * so route code can read roles/metadata later without re-verifying.
 */
function toVerifiedUser(payload: JWTPayload): VerifiedUser {
  const sub = payload.sub;
  if (!sub) throw ApiError.unauthorized('Token missing subject');
  return {
    sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    claims: payload,
  };
}

/**
 * Pull the raw token out of an Authorization header ("Bearer <token>",
 * case-insensitive on the scheme). Returns null when the header is absent or
 * not in bearer form, so callers can treat "no header" and "not a bearer
 * token" identically (anonymous).
 */
export function bearerToken(header?: string): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}
