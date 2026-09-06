import { describe, expect, it } from 'vitest';
import { mapMediaRow, MEDIA_ALT_MAX, sanitizeFilename } from './mediaService.js';
import type { MediaObjectStore } from '../infra/mediaStorage.js';

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
});
