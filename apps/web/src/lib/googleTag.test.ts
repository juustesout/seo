/**
 * Public Google tag loader tests.
 *
 * The tag must be injected at most once, respect an existing tag, and only
 * load while a public surface is enabled.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

function gtagScripts(): NodeListOf<HTMLScriptElement> {
  return document.head.querySelectorAll('script[data-seo-gtag]');
}

afterEach(() => {
  document.head.querySelectorAll('script[data-seo-gtag]').forEach((s) => s.remove());
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('resolvedGoogleTagId', () => {
  it('falls back to the built-in measurement id', async () => {
    const { resolvedGoogleTagId } = await import('./googleTag');
    expect(resolvedGoogleTagId()).toBe('G-X60HNL48JV');
  });

  it('is disabled by an empty override', async () => {
    vi.stubEnv('VITE_GOOGLE_TAG_ID', '');
    const { resolvedGoogleTagId } = await import('./googleTag');
    expect(resolvedGoogleTagId()).toBeNull();
  });

  it('honours a custom override', async () => {
    vi.stubEnv('VITE_GOOGLE_TAG_ID', 'G-CUSTOM99');
    const { resolvedGoogleTagId } = await import('./googleTag');
    expect(resolvedGoogleTagId()).toBe('G-CUSTOM99');
  });
});

describe('loadGoogleTag', () => {
  it('injects the loader and config exactly once', async () => {
    const { loadGoogleTag } = await import('./googleTag');
    expect(loadGoogleTag('G-TEST123')).toBe(true);
    expect(loadGoogleTag('G-TEST123')).toBe(true);
    expect(gtagScripts().length).toBe(2);
    const loader = document.head.querySelector<HTMLScriptElement>('script[data-seo-gtag="loader"]');
    expect(loader?.getAttribute('src')).toContain('id=G-TEST123');
  });

  it('does nothing when disabled', async () => {
    const { loadGoogleTag } = await import('./googleTag');
    expect(loadGoogleTag(null)).toBe(false);
    expect(gtagScripts().length).toBe(0);
  });

  it('does not re-add when a tag already exists on the page', async () => {
    const existing = document.createElement('script');
    existing.dataset.seoGtag = 'loader';
    document.head.appendChild(existing);
    const { loadGoogleTag } = await import('./googleTag');
    loadGoogleTag('G-TEST123');
    expect(gtagScripts().length).toBe(1);
  });
});

describe('useGoogleTag', () => {
  it('injects only while a public surface is enabled', async () => {
    const { useGoogleTag } = await import('./googleTag');
    const { rerender } = renderHook(({ enabled }: { enabled: boolean }) => useGoogleTag(enabled), {
      initialProps: { enabled: false },
    });
    expect(gtagScripts().length).toBe(0);
    rerender({ enabled: true });
    expect(gtagScripts().length).toBe(2);
  });
});
