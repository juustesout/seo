import { describe, expect, it } from 'vitest';
import { normalizePublisherCapabilities, publisherCanPublishKind, publisherKindsFor } from '@seo/contracts';

describe('publisher capability normalization (Content Studio Phase H5)', () => {
  it('maps legacy tokens to their canonical vocabulary', () => {
    expect(normalizePublisherCapabilities(['post', 'update', 'delete'])).toEqual(['publish_article', 'update', 'delete']);
    expect(normalizePublisherCapabilities(['media', 'schedule'])).toEqual(['publish_image', 'schedule']);
  });

  it('passes canonical tokens through unchanged and drops unknown strings', () => {
    expect(normalizePublisherCapabilities(['publish_text', 'nonsense', 'update'])).toEqual(['publish_text', 'update']);
  });

  it('deduplicates after alias expansion', () => {
    expect(normalizePublisherCapabilities(['post', 'publish_article', 'delete'])).toEqual(['publish_article', 'delete']);
  });
});

describe('publish-kind capability gate (Content Studio Phase H6.1)', () => {
  it('maps each kind to exactly one capability with no article-as-text fallback', () => {
    expect(publisherCanPublishKind('article', ['publish_article'])).toBe(true);
    expect(publisherCanPublishKind('article', ['publish_text'])).toBe(false);
    expect(publisherCanPublishKind('article', ['post'])).toBe(true);
    expect(publisherCanPublishKind('article', ['publish_image', 'publish_video'])).toBe(false);
    expect(publisherCanPublishKind('text', ['publish_text'])).toBe(true);
    expect(publisherCanPublishKind('text', ['publish_article'])).toBe(false);
  });

  it('accepts a text-only social publisher for text intents only', () => {
    expect(publisherCanPublishKind('text', ['publish_text', 'schedule'])).toBe(true);
    expect(publisherCanPublishKind('article', ['publish_text', 'schedule'])).toBe(false);
  });

  it('requires the exact token for image/video kinds', () => {
    expect(publisherCanPublishKind('image', ['publish_image'])).toBe(true);
    expect(publisherCanPublishKind('image', ['publish_article'])).toBe(false);
    expect(publisherCanPublishKind('image', ['media'])).toBe(true);
    expect(publisherCanPublishKind('video', ['publish_video'])).toBe(true);
    expect(publisherCanPublishKind('video', ['publish_text'])).toBe(false);
  });

  it('stays permissive for empty or unknown-only snapshots (legacy rows keep working)', () => {
    expect(publisherCanPublishKind('article', [])).toBe(true);
    expect(publisherCanPublishKind('text', undefined as unknown as string[])).toBe(true);
    expect(publisherCanPublishKind('article', ['unknown_token'])).toBe(true);
  });

  it('lists the kinds a publisher can carry in a stable order', () => {
    expect(publisherKindsFor(['publish_article', 'update', 'delete'])).toEqual(['article']);
    expect(publisherKindsFor(['publish_text', 'schedule'])).toEqual(['text']);
    expect(publisherKindsFor(['post'])).toEqual(['article']);
    expect(publisherKindsFor(['media'])).toEqual(['image']);
    expect(publisherKindsFor(['publish_article', 'publish_text'])).toEqual(['article', 'text']);
    expect(publisherKindsFor([])).toEqual(['article', 'text', 'image', 'video']);
    expect(publisherKindsFor(['unknown_token'])).toEqual(['article', 'text', 'image', 'video']);
  });
});
