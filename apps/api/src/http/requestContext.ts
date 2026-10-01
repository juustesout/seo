/**
 * Per-request correlation context. A `x-request-id` is accepted from the caller
 * when it is a safe identifier, otherwise generated; it is echoed on the
 * response and stored in AsyncLocalStorage so the logger and error handler can
 * tag every line/response from this request with the same id without threading
 * it through every function signature. This is what lets a client report a
 * failed request id and have it map to the exact server log lines.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Max accepted length and charset for a caller-supplied request id. */
const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** The request id for the current async execution, or undefined outside a request. */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Attach a correlation id to the request/response and run the remaining
 * middleware chain inside its async context. A caller-supplied id is only
 * trusted when it matches a strict identifier pattern (so header content can
 * never be reflected as an injection vector).
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', requestId);
  storage.run({ requestId }, () => next());
}
