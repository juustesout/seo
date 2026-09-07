/**
 * Async route adapter. Express 4 does not catch rejected promises from async
 * handlers itself - a rejection would surface as an unhandled rejection (and
 * potentially kill the process) instead of an HTTP error. Wrapping every async
 * route with asyncHandler forwards the rejection to next(err), which funnels it
 * into the single errorHandler mounted in app.ts.
 */

import type { RequestHandler } from 'express';

/**
 * Wrap an async route handler so thrown/rejected errors reach Express's error
 * middleware (Express 4 does not await async handlers on its own). The handler
 * keeps its full RequestHandler signature, so this is invisible to the router.
 */
export function asyncHandler(fn: (...args: Parameters<RequestHandler>) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
