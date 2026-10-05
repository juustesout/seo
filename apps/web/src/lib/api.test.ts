/**
 * Resource-protection error messaging (P9). The API returns a stable code for a
 * bounded operation; the web helper turns it into consistent wait/retry copy.
 */
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api';
import { resourceErrorMessage } from './resourceErrors';

describe('resourceErrorMessage', () => {
  it('returns actionable wait/retry text for each resource error code', () => {
    expect(resourceErrorMessage(new ApiRequestError('queue_limit', 'x', 429))).toContain('queued');
    expect(resourceErrorMessage(new ApiRequestError('resource_concurrency', 'x', 429))).toContain('running');
    expect(resourceErrorMessage(new ApiRequestError('resource_limit', 'x', 429))).toContain('short time');
  });

  it('returns null for unrelated errors so callers keep their own handling', () => {
    expect(resourceErrorMessage(new ApiRequestError('forbidden', 'x', 403))).toBeNull();
    expect(resourceErrorMessage(new Error('boom'))).toBeNull();
    expect(resourceErrorMessage(null)).toBeNull();
  });
});
