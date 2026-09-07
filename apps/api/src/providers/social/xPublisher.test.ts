import { describe, expect, it } from 'vitest';
import { XPublisher } from './xPublisher.js';
import { PublisherError } from '../publisherError.js';

function silentLogger() {
  const noop = () => undefined;
  return { info: noop, warn: noop, error: noop, debug: noop };
}

function ctx() {
  return {
    projectId: 'p1',
    userId: 'u1',
    config: {},
    credentials: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    logger: silentLogger(),
  };
}

describe('X publisher adapter (Content Studio Phase H6.1 foundation)', () => {
  it('declares only publish_text + schedule (no article/image/video/update/delete)', () => {
    const adapter = new XPublisher({ config: {}, logger: silentLogger() });
    expect(adapter.capabilities).toEqual(['publish_text', 'schedule']);
  });

  it('reports connection/testing as not implemented instead of pretending to be live', async () => {
    const adapter = new XPublisher({ config: {}, logger: silentLogger() });
    const test = await adapter.testConnection(ctx());
    expect(test.ok).toBe(false);
    expect(test.message).toMatch(/not implemented/i);
    const connect = await adapter.connect(ctx());
    expect(connect.ok).toBe(false);
  });

  it('fails publish/update/delete safely with a normalized error - never a fake success', async () => {
    const adapter = new XPublisher({ config: {}, logger: silentLogger() });
    const input = { title: 'Demo', content: 'Hello world' };
    await expect(adapter.publish(ctx(), input)).rejects.toBeInstanceOf(PublisherError);
    await expect(adapter.publish(ctx(), input)).rejects.toMatchObject({ code: 'publisher_not_available', retryable: false });
    await expect(adapter.update(ctx(), 'remote-1', input)).rejects.toMatchObject({ code: 'publisher_not_available' });
    await expect(adapter.delete(ctx(), 'remote-1')).rejects.toMatchObject({ code: 'publisher_not_available' });
  });
});
