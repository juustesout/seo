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

  it('rejects unknown publishers (registry returns nothing, no adapter)', () => {
    const r = registry({ ENABLE_TEST_PUBLISHERS: 'true' });
    expect(r.getPublisher('linkedin')).toBeUndefined();
    expect(r.getPublisher('not-a-provider')).toBeUndefined();
  });
});
