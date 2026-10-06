/**
 * Resource/entitlement error messaging (P9, P14/P15).
 *
 * The helper maps server denial codes to actionable copy and returns null for
 * anything else, so callers keep their normal error handling. P15 added the
 * plan `entitlement_limit` (403, not a retryable 429) case.
 */
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api';
import { resourceErrorMessage } from './resourceErrors';

describe('resourceErrorMessage', () => {
  it('maps transient P9/P11 resource denials to wait-and-retry copy', () => {
    expect(resourceErrorMessage(new ApiRequestError('queue_limit', 'x', 429))).toContain('too many jobs queued');
    expect(resourceErrorMessage(new ApiRequestError('resource_concurrency', 'x', 429))).toContain('too many jobs running');
    expect(resourceErrorMessage(new ApiRequestError('resource_limit', 'x', 429))).toContain('Wait a moment');
  });

  it('maps a P14/P15 plan allowance denial to plan-aware copy', () => {
    const message = resourceErrorMessage(new ApiRequestError('entitlement_limit', 'x', 403));
    expect(message).toContain('plan');
    expect(message).toContain('your own provider key');
  });

  it('returns null for unrelated errors so callers keep their handling', () => {
    expect(resourceErrorMessage(new ApiRequestError('not_found', 'x', 404))).toBeNull();
    expect(resourceErrorMessage(new Error('boom'))).toBeNull();
    expect(resourceErrorMessage(null)).toBeNull();
  });
});
