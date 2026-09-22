import { describe, expect, it } from 'vitest';
import { MediaService, mapMediaRow, MEDIA_ALT_MAX, sanitizeFilename } from './mediaService.js';
import type { MediaObjectStore } from '../infra/mediaStorage.js';
import type { SupabaseClient } from '@supabase/supabase-js';

function pngBuffer(w = 800, h = 600): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(w, 16);
  buf.writeUInt32BE(h, 20);
  return buf;
}

function fakeStore(): MediaObjectStore & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    upload: (args) => Promise.resolve({ key: `p-1/${args.ext}-from-store.${args.ext}`, url: `https://cdn/p-1/${args.ext}` }),
    remove: (key) => {
      removed.push(key);
      return Promise.resolve();
    },
    urlFor: (key) => `https://cdn/${key}`,
  };
}

function fakeSb(error: unknown = null): { sb: SupabaseClient; inserted: Record<string, unknown>[] } {
  const inserted: Record<string, unknown>[] = [];
  const sb = {
    from: () => ({
      insert: (payload: Record<string, unknown>) => {
        inserted.push(payload);
        return {
          select: () => ({
            single: () =>
              Promise.resolve({
                data: error ? null : { id: 'm-1', created_at: 't', updated_at: 't', ...payload },
                error,
              }),
          }),
        };
      },
    }),
  } as unknown as SupabaseClient;
  return { sb, inserted };
}


function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    project_id: 'p-1',
    filename: 'photo.png',
    mime_type: 'image/png',
    size: 1024,
    storage_key: 'p-1/123.png',
    width: 800,
    height: 600,
    alt_text: 'Red fox',
    caption: '',
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('sanitizeFilename (phase F)', () => {
  it('strips path traversal separators and leading dots', () => {
    expect(sanitizeFilename('../../etc/passwd.png')).toBe('passwd.png');
    expect(sanitizeFilename('..\\..\\win.png')).toBe('win.png');
    expect(sanitizeFilename('.../../secret.png')).toBe('secret.png');
  });

  it('removes control characters and spaces excessive, truncates long names', () => {
    const dirty = `na\tme\x00.png`;
    expect(sanitizeFilename(dirty)).toBe('name.png');
    expect(sanitizeFilename('a'.repeat(500) + '.png').length).toBeLessThanOrEqual(180);
  });

  it('never returns an empty or traversal-looking name', () => {
    expect(sanitizeFilename('')).toBe('image');
    expect(sanitizeFilename(null)).toBe('image');
    expect(sanitizeFilename('....')).toBe('image');
    expect(sanitizeFilename('/')).toBe('image');
    expect(sanitizeFilename('..')).toBe('image');
  });
});

describe('mapMediaRow (phase F)', () => {
  it('maps a row to the wire dto and derives the url from the object store', () => {
    const store: MediaObjectStore = {
      upload: () => Promise.reject(new Error('not used')),
      remove: () => Promise.resolve(),
      urlFor: (key: string) => `https://cdn/${key}`,
    };
    const dto = mapMediaRow(row(), store, 3);
    expect(dto).toMatchObject({
      id: 'm-1',
      project_id: 'p-1',
      mime_type: 'image/png',
      url: 'https://cdn/p-1/123.png',
      width: 800,
      height: 600,
      usage_count: 3,
      alt_text: 'Red fox',
    });
    expect(dto.size).toBe(1024);
  });

  it('defaults usage count to zero and tolerates null dimensions', () => {
    const store: MediaObjectStore = {
      upload: () => Promise.reject(new Error('not used')),
      remove: () => Promise.resolve(),
      urlFor: (key: string) => key,
    };
    const dto = mapMediaRow(row({ width: null, height: null }), store);
    expect(dto.usage_count).toBe(0);
    expect(dto.width).toBeNull();
    expect(dto.height).toBeNull();
  });

  it('caps alt text at the shared limit', () => {
    expect(MEDIA_ALT_MAX).toBe(500);
  });

  it('defaults provenance to upload with empty meta for legacy rows (R4.5A)', () => {
    const store = fakeStore();
    const dto = mapMediaRow(row(), store);
    expect(dto.source).toBe('upload');
    expect(dto.source_meta).toEqual({});
  });

  it('passes through valid external provenance and drops malformed meta (R4.5A)', () => {
    const store = fakeStore();
    const dto = mapMediaRow(
      row({
        source: 'unsplash',
        source_meta: { provider: 'unsplash', sourceAssetId: 'abc', author: 'Ada', sourceUrl: 'https://u/p' },
      }),
      store,
    );
    expect(dto.source).toBe('unsplash');
    expect(dto.source_meta).toEqual({ provider: 'unsplash', sourceAssetId: 'abc', author: 'Ada', sourceUrl: 'https://u/p' });

    const bad = mapMediaRow(row({ source: 'nope', source_meta: { secretKey: 'x' } }), store);
    expect(bad.source).toBe('upload');
    expect(bad.source_meta).toEqual({});
  });
});

describe('importExternal (R4.5A)', () => {
  it('stores external bytes as an ordinary library row with provenance', async () => {
    const store = fakeStore();
    const { sb, inserted } = fakeSb();
    const service = new MediaService(sb, store);

    const dto = await service.importExternal('p-1', 'u-1', {
      bytes: pngBuffer(1200, 800),
      source: 'unsplash',
      sourceMeta: { provider: 'unsplash', sourceAssetId: 'abc', author: 'Ada', sourceUrl: 'https://u/p' },
      filename: 'Stock photo.png',
      alt: 'Solar panels',
      caption: 'Photograph by Ada',
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      project_id: 'p-1',
      filename: 'Stock photo.png',
      mime_type: 'image/png',
      size: pngBuffer().length,
      width: 1200,
      height: 800,
      alt_text: 'Solar panels',
      caption: 'Photograph by Ada',
      source: 'unsplash',
      created_by: 'u-1',
    });
    expect(inserted[0].source_meta).toEqual({
      provider: 'unsplash',
      sourceAssetId: 'abc',
      author: 'Ada',
      sourceUrl: 'https://u/p',
    });
    expect(dto.source).toBe('unsplash');
  });

  it('refuses empty and unsupported downloaded bytes', async () => {
    const store = fakeStore();
    const { sb } = fakeSb();
    const service = new MediaService(sb, store);

    await expect(
      service.importExternal('p-1', null, { bytes: Buffer.alloc(0), source: 'unsplash', sourceMeta: {} }),
    ).rejects.toThrow();
    await expect(
      service.importExternal('p-1', null, {
        bytes: Buffer.from('<svg></svg>'),
        source: 'unsplash',
        sourceMeta: {},
      }),
    ).rejects.toThrow();
    expect(store.removed).toHaveLength(0);
  });

  it('best-effort removes the object when the metadata insert fails', async () => {
    const store = fakeStore();
    const { sb } = fakeSb({ message: 'boom' });
    const service = new MediaService(sb, store);

    await expect(
      service.importExternal('p-1', null, { bytes: pngBuffer(), source: 'unsplash', sourceMeta: {} }),
    ).rejects.toThrow();
    expect(store.removed).toHaveLength(1);
  });
});
