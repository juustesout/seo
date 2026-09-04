/** Express auth helpers: verify Supabase bearer JWTs and load the container. */

import type { NextFunction, Request, Response } from 'express';
import { getContainer, type ServiceContainer } from '../context.js';
import { ApiError } from '../apiErrors.js';
import { bearerToken, verifyAccessToken, type VerifiedUser } from '../auth/jwt.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: VerifiedUser;
      container: ServiceContainer;
    }
  }
}

export function resolveContainer(req: Request, _res: Response, next: NextFunction) {
  try {
    req.container = getContainer();
    next();
  } catch (err) {
    next(err instanceof ApiError ? err : ApiError.notConfigured('Server is not configured'));
  }
}

/** Attach req.user when a valid bearer token is present (never blocks). */
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

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    next(ApiError.unauthorized());
    return;
  }
  next();
}

export function requireConfigured(container: ServiceContainer, flag: boolean, label: string) {
  if (!flag) {
    throw ApiError.notConfigured(`${label} is not configured on the server`);
  }
}
