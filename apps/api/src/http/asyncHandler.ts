/** Async route wrapper so thrown errors reach the error handler. */

import type { RequestHandler } from 'express';

export function asyncHandler(fn: (...args: Parameters<RequestHandler>) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
