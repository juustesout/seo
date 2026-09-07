/**
 * Express identity middleware shared by every route. resolveContainer attaches
 * the per-request ServiceContainer (503 when the server is not configured);
 * optionalAuth attaches req.user when a valid Supabase bearer token is present;
 * requireAuth rejects requests that reach a protected route anonymously.
 *
 * Per-project *role* authorization is deliberately not done here: a route
 * authorizes itself against the specific resource it touches via
 * container.access.requireRole(user.sub, projectId, role). Keeping identity
 * global and role checks per-project means middleware never needs to know which
 * project a handler is about to touch.
 */

import type { NextFunction, Request, Response } from 'express';
import { getContainer, type ServiceContainer } from '../context.js';
import { ApiError } from '../apiErrors.js';
import { bearerToken, verifyAccessToken, type VerifiedUser } from '../auth/jwt.js';

/**
 * Augment Express.Request so handlers can rely on req.user / req.container
 * existing after resolveContainer + optionalAuth have run at the app level.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: VerifiedUser;
      container: ServiceContainer;
    }
  }
}

/**
 * Attach the process ServiceContainer to the request. Runs before every route
 * so handlers never construct their own container or read global state. When
 * the server is not configured (missing Supabase env), the container cannot be
 * built and the request becomes a uniform 503 not_configured here instead of
 * letting each route fail with its own unrelated error.
 */
export function resolveContainer(req: Request, _res: Response, next: NextFunction) {
  try {
    req.container = getContainer();
    next();
  } catch (err) {
    next(err instanceof ApiError ? err : ApiError.notConfigured('Server is not configured'));
  }
}

/**
 * Best-effort identity: when a Bearer token is present and Supabase is
 * configured, verify it and attach req.user. Never blocks or rejects - an
 * invalid/expired token simply leaves the request anonymous and the guarded
 * routes (requireAuth, or per-project requireRole in the route) decide the
 * outcome. This is what lets open endpoints (catalog, health, the Google OAuth
 * callback) coexist with protected routes on the same app. Verification is
 * skipped entirely when Supabase is not configured, since there is no issuer to
 * check against.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = bearerToken(req.header('authorization'));
    if (token && req.container.config.supabaseConfigured) {
      const url = req.container.config.env.SUPABASE_URL!;
      req.user = await verifyAccessToken(token, {
        supabaseUrl: url,
        jwtSecret: req.container.config.env.SUPABASE_JWT_SECRET,
      });
    }
  } catch (err) {
    // invalid token -> treat as anonymous; strict endpoints reject below
  }
  next();
}

/**
 * Gate for routes that need a signed-in user: 401 when optionalAuth found no
 * valid bearer token. Identity-only - project membership and role are still
 * enforced by the route through container.access.requireRole.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next(ApiError.unauthorized());
    return;
  }
  next();
}

/**
 * Fail-fast capability gate for a route that depends on a server-side feature
 * that is not configured (e.g. an integration with no credentials). Throws 503
 * not_configured so the UI can present "set this up first" rather than a
 * misleading 500, and so unconfigured features never masquerade as broken ones.
 */
export function requireConfigured(container: ServiceContainer, flag: boolean, label: string) {
  if (!flag) {
    throw ApiError.notConfigured(`${label} is not configured on the server`);
  }
}
