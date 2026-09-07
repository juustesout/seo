import { describe, expect, it } from 'vitest';
import { PublisherError, publisherErrorFromStatus, publisherRejected } from './publisherError.js';
import { jobErrorPayload } from '../jobs/types.js';

describe('PublisherError normalization (Content Studio Phase H5)', () => {
  it('maps HTTP 429 to a retryable rate-limit error', () => {
    const err = publisherErrorFromStatus(429, 'Slow down');
    expect(err).toBeInstanceOf(PublisherError);
    expect(err.code).toBe('publisher_rate_limited');
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
  });

  it('maps HTTP 401/403 to a non-retryable auth error', () => {
    const err = publisherErrorFromStatus(401);
    expect(err.code).toBe('publisher_auth_failed');
    expect(err.retryable).toBe(false);
  });

  it('maps other 4xx to rejected-content (non-retryable)', () => {
    const err = publisherErrorFromStatus(422, 'bad message');
    expect(err.code).toBe('publisher_rejected_content');
    expect(err.retryable).toBe(false);
  });

  it('maps 5xx to a retryable remote error', () => {
    const err = publisherErrorFromStatus(502);
    expect(err.code).toBe('publisher_remote_error');
    expect(err.retryable).toBe(true);
  });

  it('rejects content before publishing with a stable, non-retryable error', () => {
    const err = publisherRejected('video files are not supported by this channel');
    expect(err.code).toBe('publisher_rejected_content');
    expect(err.retryable).toBe(false);
  });

  it('surfaces through jobErrorPayload with code + safe message (no headers/tokens)', () => {
    const original = new PublisherError('publisher_auth_failed', 'Remote rejected the credential', { status: 401 });
    const { error, retryable } = jobErrorPayload(original, {
      provider: 'x',
      operation: 'publish',
      project_id: 'p1',
      job_type: 'publish',
    });
    expect(retryable).toBe(false);
    expect(error.code).toBe('publisher_auth_failed');
    expect(error.message).toBe('Remote rejected the credential');
    expect(error.http_status).toBe(401);
    expect(JSON.stringify(error)).not.toMatch(/"headers"/i);
    expect(JSON.stringify(error)).not.toMatch(/authorization|password|secret/i);
  });
});
