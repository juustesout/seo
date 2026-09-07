import { describe, expect, it } from 'vitest';
import { MockSocialPublisher } from './mockSocial.js';
import type { ProviderContext, ProviderDeps } from '@seo/contracts';
import type { PublishInput } from '@seo/contracts';

function noopLogger(): ProviderDeps['logger'] {
  const noop = () => undefined;
  return { info: noop, warn: noop, error: noop, debug: noop };
}

function context(): ProviderContext {
  return {
    projectId: 'p1',
    userId: null,
    config: {},
    credentials: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    logger: noopLogger() as ProviderContext['logger'],
  };
}

function input(overrides: Partial<PublishInput> = {}): PublishInput {
  return { title: 'Demo article', content: '<p>Hello world</p>', ...overrides };
}

describe('MockSocialPublisher (env-gated demo adapter)', () => {
  const adapter = new MockSocialPublisher({ config: {}, logger: noopLogger() });

  it('declares text-post capability (canonical vocabulary)', () => {
    expect(adapter.id).toBe('mock_social');
    expect(adapter.capabilities).toEqual(['publish_text']);
  });

  it('transforms canonical content through the payload builder into a demo remote id', async () => {
    const result = await adapter.publish(context(), input({ title: 'A post', content: '<p>Body</p>' }));
    expect(result.remoteId).toMatch(/^demo:[a-f0-9]+$/);
    expect(result.url).toBeNull();
  });

  it('never claims a real target url', async () => {
    const result = await adapter.publish(context(), input());
    expect(result.url).toBeNull();
  });

  it('connect/testConnection succeed without credentials and are explicit about being a demo', async () => {
    const connect = await adapter.connect(context());
    expect(connect.ok).toBe(true);
    expect(connect.message).toMatch(/demo|test/i);
    const test = await adapter.testConnection(context());
    expect(test.ok).toBe(true);
    expect(test.message).toMatch(/demo|test/i);
  });

  it('update preserves the demo remote id', async () => {
    const first = await adapter.publish(context(), input());
    const updated = await adapter.update(context(), first.remoteId, input({ title: 'Changed' }));
    expect(updated.remoteId).toBe(first.remoteId);
    expect(updated.url).toBeNull();
  });

  it('delete is a safe no-op', async () => {
    await expect(adapter.delete(context(), 'demo:abc')).resolves.toBeUndefined();
  });
});
