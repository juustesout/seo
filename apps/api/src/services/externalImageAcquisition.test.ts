/**
 * External image acquisition tests (R4.5A).
 *
 * Pins the local-first fallback contract: only a configured provider is used, the
 * agent never invents an asset, downloads are restricted to an allowlisted host
 * with a byte cap, the downloaded bytes are persisted as an ordinary library row
 * with bounded attribution, and every failure is an honest typed error.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ImageInsertionContext, MediaItemDto, MediaProvider, MediaResult, VisualDesignIntent } from '@seo/contracts';
import {
  acquireExternalImage,
  externalImageCredit,
  isAllowedExternalImageUrl,
} from './externalImageAcquisition.js';
import type { ImportExternalMediaInput } from './mediaService.js';

function pngBuffer(w = 800, h = 600): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

const context: ImageInsertionContext = {
  revision: 'rev1:abcdef0123456789',
  document: { version: 1, blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Solar panels.' }] }] },
  target: { kind: 'cursor', position: 3 },
  nearbyText: 'We install solar panels on residential roofs.',
};

const visual: VisualDesignIntent = { role: 'inline', intent: 'reinforce' };

const result: MediaResult = {
  id: 'u1',
  sourceAssetId: 'u1',
  url: 'https://images.unsplash.com/photo-1.jpg',
  width: 4000,
  height: 3000,
  description: 'Office desk',
  author: 'Ada',
  authorUrl: 'https://unsplash.com/@ada',
  sourceUrl: 'https://unsplash.com/photos/u1',
  source: 'unsplash',
};

function item(over: Partial<MediaItemDto> = {}): MediaItemDto {
  return {
    id: 'm-1',
    project_id: 'p-1',
    filename: 'Stock photo.png',
    mime_type: 'image/png',
    size: 24,
    url: 'https://cdn/p-1/stock.png',
    width: 800,
    height: 600,
    alt_text: 'Office desk',
    caption: '',
    source: 'unsplash',
    source_meta: { provider: 'unsplash' },
    usage_count: 0,
    created_at: 't',
    updated_at: 't',
    ...over,
  };
}

function provider(search: MediaProvider['search'], configured = true): MediaProvider {
  return {
    id: 'unsplash',
    name: 'Unsplash',
    description: 'stock',
    capabilities: ['search'],
    isConfigured: () => configured,
    search,
  };
}

function okFetch(bytes: Buffer, contentType = 'image/png'): typeof fetch {
  return (async () =>
    new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { 'content-type': contentType, 'content-length': String(bytes.length) },
    })) as unknown as typeof fetch;
}

async function expectApiError(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await promise;
  } catch (err) {
    return err as { status: number; code: string };
  }
  throw new Error('Expected the acquisition to throw');
}

describe('isAllowedExternalImageUrl', () => {
  it('only allows https image hosts on the allowlist', () => {
    expect(isAllowedExternalImageUrl('https://images.unsplash.com/photo-1.jpg')).toBe(true);
    expect(isAllowedExternalImageUrl('http://images.unsplash.com/photo-1.jpg')).toBe(false);
    expect(isAllowedExternalImageUrl('https://evil.example/photo.jpg')).toBe(false);
    expect(isAllowedExternalImageUrl('https://images.unsplash.com.evil.example/x.jpg')).toBe(false);
    expect(isAllowedExternalImageUrl('not a url')).toBe(false);
  });
});

describe('externalImageCredit', () => {
  it('builds a bounded Unsplash credit when an author is known', () => {
    expect(externalImageCredit(result)).toBe('Photo by Ada on Unsplash');
    expect(externalImageCredit({ ...result, author: undefined })).toBeUndefined();
  });
});

describe('acquireExternalImage', () => {
  it('refuses when no provider is available', async () => {
    const err = await expectApiError(
      acquireExternalImage({ provider: undefined, context, visual, projectId: 'p-1', persist: vi.fn() }),
    );
    expect(err).toMatchObject({ status: 422, code: 'external_search_unavailable' });
  });

  it('refuses when the provider is registered but not configured', async () => {
    const err = await expectApiError(
      acquireExternalImage({
        provider: provider(async () => [result], false),
        context,
        visual,
        projectId: 'p-1',
        persist: vi.fn(),
      }),
    );
    expect(err).toMatchObject({ status: 422, code: 'provider_not_configured' });
  });

  it('reports an honest error when the provider search fails', async () => {
    const err = await expectApiError(
      acquireExternalImage({
        provider: provider(async () => {
          throw new Error('boom');
        }),
        context,
        visual,
        projectId: 'p-1',
        persist: vi.fn(),
        fetchFn: okFetch(pngBuffer()),
      }),
    );
    expect(err).toMatchObject({ status: 502, code: 'external_search_unavailable' });
  });

  it('downloads, persists and returns a normal library-backed candidate', async () => {
    const persist = vi.fn(async (input: ImportExternalMediaInput) => item({ alt_text: input.alt ?? '' }));
    const bytes = pngBuffer();
    const candidate = await acquireExternalImage({
      provider: provider(async () => [result]),
      context,
      visual,
      projectId: 'p-1',
      persist,
      fetchFn: okFetch(bytes),
    });

    expect(persist).toHaveBeenCalledTimes(1);
    const input = persist.mock.calls[0][0];
    expect(input.source).toBe('unsplash');
    expect(input.bytes).toHaveLength(bytes.length);
    expect(input.sourceMeta).toEqual({
      provider: 'unsplash',
      sourceAssetId: 'u1',
      author: 'Ada',
      authorUrl: 'https://unsplash.com/@ada',
      sourceUrl: 'https://unsplash.com/photos/u1',
    });

    expect(candidate).toMatchObject({
      assetId: 'm-1',
      url: 'https://cdn/p-1/stock.png',
      alt: 'Office desk',
      credit: 'Photo by Ada on Unsplash',
      sourceUrl: 'https://unsplash.com/photos/u1',
      source: 'unsplash',
      width: 800,
      height: 600,
    });
  });

  it('skips an untrusted source host and falls through to the next result', async () => {
    const bad: MediaResult = { ...result, id: 'u0', url: 'https://evil.example/x.jpg' };
    const persist = vi.fn(async () => item());
    const candidate = await acquireExternalImage({
      provider: provider(async () => [bad, result]),
      context,
      visual,
      projectId: 'p-1',
      persist,
      fetchFn: okFetch(pngBuffer()),
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(candidate.source).toBe('unsplash');
  });

  it('reports an honest error when persistence fails', async () => {
    const err = await expectApiError(
      acquireExternalImage({
        provider: provider(async () => [result]),
        context,
        visual,
        projectId: 'p-1',
        persist: async () => {
          throw new Error('db down');
        },
        fetchFn: okFetch(pngBuffer()),
      }),
    );
    expect(err).toMatchObject({ status: 502, code: 'asset_persistence_failed' });
  });

  it('refuses an over-large declared download', async () => {
    const fetchFn = (async () =>
      new Response(new Uint8Array(pngBuffer()), {
        status: 200,
        headers: { 'content-length': '999999999' },
      })) as unknown as typeof fetch;
    const err = await expectApiError(
      acquireExternalImage({
        provider: provider(async () => [result]),
        context,
        visual,
        projectId: 'p-1',
        persist: vi.fn(),
        fetchFn,
      }),
    );
    expect(err).toMatchObject({ status: 422, code: 'external_image_too_large' });
  });

  it('refuses when there is not enough context to search', async () => {
    const err = await expectApiError(
      acquireExternalImage({
        provider: provider(async () => [result]),
        context: { ...context, nearbyText: '', document: { version: 1, blocks: [] }, documentTitle: undefined },
        visual,
        projectId: 'p-1',
        persist: vi.fn(),
        fetchFn: okFetch(pngBuffer()),
      }),
    );
    expect(err).toMatchObject({ status: 422, code: 'external_search_unavailable' });
  });
});
