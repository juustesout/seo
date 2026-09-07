/**
 * Application error type + express error middleware. Never leaks secrets or
 * internal stack traces to the client; full details go to the structured log.
 *
 * The shared wire shape is `{ error: { code, message, details? } }` (see
 * CLAUDE.md: validate at the route edge with zod, typed output everywhere).
 * ApiError carries an HTTP status + a stable machine-readable `code` so clients
 * can branch on cause, not on a human message string. The static factories
 * below are the only sanctioned way to raise these - they keep status/code
 * pairs consistent across the codebase.
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from './logger.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** 400 - the request was malformed or violates a business rule. */
  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'bad_request', message, details);
  }
  /** 401 - no/invalid authentication. */
  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'unauthorized', message);
  }
  /** 403 - authenticated but not permitted (missing role/membership). */
  static forbidden(message = 'You do not have permission to do that') {
    return new ApiError(403, 'forbidden', message);
  }
  /** 404 - the resource does not exist in the current scope. */
  static notFound(message = 'Not found') {
    return new ApiError(404, 'not_found', message);
  }
  /** 409 - state conflict (e.g. already published, concurrently edited). */
  static conflict(message: string) {
    return new ApiError(409, 'conflict', message);
  }
  /**
   * 503 - the feature/credential is not configured server-side. Distinct from
   * 500 so the UI can show "set this up first" instead of "something broke".
   */
  static notConfigured(message: string) {
    return new ApiError(503, 'not_configured', message);
  }
}

/** Express 404 for unmatched routes (kept minimal and consistent). */
export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

/**
 * Terminal express error middleware. Zod errors (route-level validation) are
 * flattened to a stable `validation_error`; ApiError passes its status/code
 * through; anything else is logged in full server-side and reported to the
 * client only as a generic `internal_error` so stack traces and internals
 * never leave the process.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Invalid request payload',
        details: err.flatten(),
      },
    });
    return;
  }
  logger.error({ err, method: req.method, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { code: 'internal_error', message: 'An unexpected error occurred' } });
}
