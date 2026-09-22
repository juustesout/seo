/**
 * Media provenance and acquisition policy contracts (R4.5A).
 *
 * Pins the stored `seo_media.source` values, the runtime presentation kinds, the
 * bounded/secret-free metadata shape and the conservative default source policy.
 * Both the API (persistence/validation) and the editor (display) read these, so
 * the values and their guards are asserted explicitly.
 */
import { describe, expect, it } from 'vitest';
import {
  IMAGE_SOURCE_KINDS,
  IMAGE_SOURCE_POLICY_DEFAULT,
  MEDIA_SOURCE_META_MAX_CHARS,
  MEDIA_SOURCE_META_MAX_KEYS,
  MEDIA_SOURCES,
  imageSourceKindOf,
  isImageSourceKind,
  isMediaSource,
  isValidImageSourcePolicy,
  isValidMediaAttribution,
  isValidMediaSourceMeta,
} from './mediaSource.js';

describe('media provenance', () => {
  it('stores upload, unsplash and openai_generated sources', () => {
    expect(MEDIA_SOURCES).toEqual(['upload', 'unsplash', 'openai_generated']);
  });

  it('presents upload assets as project_media at runtime', () => {
    expect(imageSourceKindOf('upload')).toBe('project_media');
    expect(imageSourceKindOf('unsplash')).toBe('unsplash');
    expect(imageSourceKindOf('openai_generated')).toBe('openai_generated');
  });

  it('does not treat project_media as a stored source', () => {
    expect(isMediaSource('project_media')).toBe(false);
    expect(isMediaSource('upload')).toBe(true);
    expect(isMediaSource('nope')).toBe(false);
    expect(isMediaSource(42)).toBe(false);
  });

  it('validates runtime presentation kinds', () => {
    expect(IMAGE_SOURCE_KINDS).toEqual(['project_media', 'unsplash', 'openai_generated']);
    expect(isImageSourceKind('project_media')).toBe(true);
    expect(isImageSourceKind('openai_generated')).toBe(true);
    expect(isImageSourceKind('upload')).toBe(false);
  });
});

describe('media attribution', () => {
  it('accepts an empty or partial attribution with bounded strings', () => {
    expect(isValidMediaAttribution({})).toBe(true);
    expect(isValidMediaAttribution({ author: 'Ada' })).toBe(true);
    expect(
      isValidMediaAttribution({ author: 'Ada', authorUrl: 'https://u/a', sourceUrl: 'https://u/p' }),
    ).toBe(true);
  });

  it('rejects unknown keys, non-strings and overlong values', () => {
    expect(isValidMediaAttribution({ license: 'MIT' })).toBe(false);
    expect(isValidMediaAttribution({ author: 12 })).toBe(false);
    expect(isValidMediaAttribution({ author: 'x'.repeat(MEDIA_SOURCE_META_MAX_CHARS + 1) })).toBe(false);
    expect(isValidMediaAttribution(null)).toBe(false);
    expect(isValidMediaAttribution([])).toBe(false);
  });
});

describe('media source meta', () => {
  it('accepts known provider keys within bounds', () => {
    expect(isValidMediaSourceMeta({})).toBe(true);
    expect(
      isValidMediaSourceMeta({
        provider: 'unsplash',
        sourceAssetId: 'abc123',
        author: 'Ada',
        authorUrl: 'https://unsplash.com/@ada',
        sourceUrl: 'https://unsplash.com/photos/abc123',
      }),
    ).toBe(true);
    expect(isValidMediaSourceMeta({ provider: 'openai', model: 'dall-e-3' })).toBe(true);
  });

  it('rejects unknown keys and too many keys', () => {
    expect(isValidMediaSourceMeta({ secretKey: 'sk-123' })).toBe(false);
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < MEDIA_SOURCE_META_MAX_KEYS + 1; i += 1) tooMany[`k${i}`] = 'v';
    expect(isValidMediaSourceMeta(tooMany)).toBe(false);
  });

  it('rejects overlong values and non-objects', () => {
    expect(isValidMediaSourceMeta({ author: 'x'.repeat(MEDIA_SOURCE_META_MAX_CHARS + 1) })).toBe(false);
    expect(isValidMediaSourceMeta('unsplash')).toBe(false);
    expect(isValidMediaSourceMeta(null)).toBe(false);
  });
});

describe('image source policy', () => {
  it('defaults to conservative: no external search, no generation, confirm generation', () => {
    expect(IMAGE_SOURCE_POLICY_DEFAULT).toEqual({
      allowExternalSearch: false,
      allowGeneration: false,
      requireGenerationConfirmation: true,
    });
  });

  it('requires exactly the three boolean fields', () => {
    expect(isValidImageSourcePolicy(IMAGE_SOURCE_POLICY_DEFAULT)).toBe(true);
    expect(isValidImageSourcePolicy({ allowExternalSearch: true, allowGeneration: false })).toBe(false);
    expect(
      isValidImageSourcePolicy({
        allowExternalSearch: false,
        allowGeneration: false,
        requireGenerationConfirmation: true,
        extra: true,
      }),
    ).toBe(false);
    expect(
      isValidImageSourcePolicy({
        allowExternalSearch: 'yes',
        allowGeneration: false,
        requireGenerationConfirmation: true,
      }),
    ).toBe(false);
    expect(isValidImageSourcePolicy(null)).toBe(false);
  });
});
