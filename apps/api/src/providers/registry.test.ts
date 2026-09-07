import { describe, expect, it } from 'vitest';
import { buildRegistry } from './registry.js';
import type { ProviderLogger } from '@seo/contracts';

function silentLogger(): ProviderLogger {
  const noop = () => undefined;
  return { info: noop, warn: noop, error: noop, debug: noop };
}

function registry(flags: Record<string, string> = {}) {
  return buildRegistry({ config: { ...flags }, logger: silentLogger() });
}

describe('provider registry publisher surface (Content Studio Phase H5)', () => {
  it('does not register the demo social publisher by default (production-safe)', () => {
    const r = registry({});
    expect(r.listPublishers().find((p) => p.id === 'mock_social')).toBeUndefined();
    expect(r.getPublisher('mock_social')).toBeUndefined();
  });

  it('registers the demo social publisher only when explicitly enabled', () => {
    const r = registry({ ENABLE_TEST_PUBLISHERS: 'true' });
    const descriptor = r.listPublishers().find((p) => p.id === 'mock_social');
    expect(descriptor).toBeDefined();
    expect(descriptor!.setup?.category).toBe('social');
    expect(descriptor!.capabilities).toContain('publish_text');
    expect(r.getPublisher('mock_social')?.id).toBe('mock_social');
  });

  it('exposes canonical capabilities on the WordPress descriptor', () => {
    const r = registry();
    const wp = r.listPublishers().find((p) => p.id === 'wordpress');
    expect(wp).toBeDefined();
    expect(wp!.capabilities).toEqual(['publish_article', 'update', 'delete']);
    expect(wp!.setup?.category).toBe('website');
    expect(wp!.setup?.credentials?.map((f) => f.key)).toEqual(['wordpress_username', 'wordpress_application_password']);
  });

  it('registers the X publisher as a real text-only social channel with OAuth connect (Phase H6.2)', () => {
    const r = registry({ X_OAUTH_CLIENT_ID: 'x-client' });
    const x = r.listPublishers().find((p) => p.id === 'x');
    expect(x).toBeDefined();
    expect(x!.capabilities).toEqual(['publish_text', 'schedule']);
    expect(x!.setup?.category).toBe('social');
    expect(x!.setup?.auth).toBe('oauth');
    expect(r.getPublisher('x')?.id).toBe('x');
    expect(r.getPublisher('x')?.name).toBe('X');
  });

  it('registers an X OAuth connector that reports configured only when a client id exists', () => {
    const without = registry({});
    expect(without.getPublisherOAuth('x')?.providerId).toBe('x');
    expect(without.getPublisherOAuth('x')?.configured).toBe(false);
    const withId = registry({ X_OAUTH_CLIENT_ID: 'x-client' });
    const connector = withId.getPublisherOAuth('x');
    expect(connector?.configured).toBe(true);
    expect(connector?.scopes).toContain('tweet.write');
    // No OAuth connector is ever claimed by a form-based publisher.
    expect(withId.getPublisherOAuth('wordpress')).toBeUndefined();
    expect(withId.getPublisherOAuth('linkedin')).toBeUndefined();
  });

  it('does not let X claim article/image/video or update/delete capability', () => {
    const r = registry();
    const x = r.getPublisher('x');
    const caps = [...(x?.capabilities ?? [])];
    expect(caps).not.toContain('publish_article');
    expect(caps).not.toContain('publish_image');
    expect(caps).not.toContain('publish_video');
    expect(caps).not.toContain('update');
    expect(caps).not.toContain('delete');
  });

  it('rejects unknown publishers (registry returns nothing, no adapter)', () => {
    const r = registry({ ENABLE_TEST_PUBLISHERS: 'true' });
    expect(r.getPublisher('linkedin')).toBeUndefined();
    expect(r.getPublisher('not-a-provider')).toBeUndefined();
  });
});
