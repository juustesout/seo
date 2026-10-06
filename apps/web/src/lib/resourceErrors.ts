/**
 * Resource-protection error messaging (P9).
 *
 * Kept in its own module (rather than lib/api.ts) so the UI's many tests that
 * mock the api transport do not need to know about it: this helper has no
 * transport side effects. It turns a server-side resource denial into
 * consistent, actionable copy - wait and retry, never "something crashed".
 * Returns null for any other error so callers keep their existing handling.
 */
import { ApiRequestError } from './api';

const RESOURCE_ERROR_MESSAGES: Record<string, string> = {
  queue_limit: 'This account or project already has too many jobs queued. Wait for some to finish, then try again.',
  resource_concurrency:
    'This account or project already has too many jobs running. Wait for some to finish, then try again.',
  resource_limit: 'Too many job requests in a short time. Wait a moment, then try again.',
  // P14/P15: the plan's operator-funded allowance for this period is exhausted,
  // or the resource is not included on the current plan.
  entitlement_limit:
    'You have reached this plan’s allowance for the period. It resets next period, or connect your own provider key to keep going.',
};

export function resourceErrorMessage(error: unknown): string | null {
  if (error instanceof ApiRequestError && error.code in RESOURCE_ERROR_MESSAGES) {
    return RESOURCE_ERROR_MESSAGES[error.code]!;
  }
  return null;
}
