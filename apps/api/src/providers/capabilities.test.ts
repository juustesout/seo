import { describe, expect, it } from 'vitest';
import { normalizePublisherCapabilities, publisherCanPublishContent } from '@seo/contracts';

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

  it('treats article content as accepted by article and text channels', () => {
    expect(publisherCanPublishContent('article', ['publish_article'])).toBe(true);
    expect(publisherCanPublishContent('article', ['publish_text'])).toBe(true);
    expect(publisherCanPublishContent('article', ['post'])).toBe(true);
    expect(publisherCanPublishContent('article', ['publish_image', 'publish_video'])).toBe(false);
    expect(publisherCanPublishContent('article', ['publish_video'])).toBe(false);
  });

  it('requires the exact token for image/video kinds', () => {
    expect(publisherCanPublishContent('image', ['publish_image'])).toBe(true);
    expect(publisherCanPublishContent('image', ['publish_article'])).toBe(false);
    expect(publisherCanPublishContent('image', ['media'])).toBe(true);
    expect(publisherCanPublishContent('video', ['publish_video'])).toBe(true);
    expect(publisherCanPublishContent('video', ['publish_text'])).toBe(false);
  });

  it('stays permissive for empty or unknown-only snapshots (legacy rows keep working)', () => {
    expect(publisherCanPublishContent('article', [])).toBe(true);
    expect(publisherCanPublishContent('article', undefined as unknown as string[])).toBe(true);
    expect(publisherCanPublishContent('article', ['unknown_token'])).toBe(true);
  });
});
