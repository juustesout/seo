/**
 * content_images media usage wiring (R5.10.7).
 *
 * The executor must hand one retry-aware usage scope to the media provider so
 * every physical search/generation it fans out is counted exactly once. The
 * provider owns the meter, so this test drives a provider-shaped fake that
 * records through the real `emitMediaUsage` seam and asserts the executor never
 * collapses multiple physical requests into one fact.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaProvider, MediaSearchOptions, MediaResult } from '@seo/contracts';
import { getExecutor } from './executors.js';
import { ContentService } from '../services/contentService.js';
import { InMemoryUsageEventStore } from '../services/usageEventRepository.js';
import { emitMediaUsage } from '../providers/media/mediaUsage.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';

function contentRow(placeholders: number) {
  return {
    title: 'Solar energy',
    content_json: Array.from({ length: placeholders }, (_, i) => ({
      type: 'media',
      attrs: { kind: 'placeholder', alt: `alt ${i}` },
    })),
  };
}

function result(url: string): MediaResult {
  return { id: url, url, width: 1, height: 1, source: 'unsplash' };
}

function recordingMedia(_store: InMemoryUsageEventStore): MediaProvider {
  return {
    id: 'unsplash',
    name: 'Unsplash',
    description: 'search',
    capabilities: ['search'],
    isConfigured: () => true,
    search: async (opts: MediaSearchOptions) => {
      await emitMediaUsage({ scope: opts.usage!, provider: 'unsplash', operation: 'media_search', success: true });
      return [result('https://u/x.jpg')];
    },
  };
}

function context(container: unknown, retryCount: number) {
  return {
    container: {
      // P14: each media request is admitted against the product allowance. These
      // tests exercise the usage meter, so the admission seam runs unchanged.
      entitlements: { withAdmission: async <T>(_req: unknown, fn: () => Promise<T>) => fn() },
      ...(container as Record<string, unknown>),
    },
    job: {
      id: 'job-content-images',
      project_id: PROJECT,
      created_by: USER,
      retry_count: retryCount,
      params: { content_id: 'c1', image_provider: 'unsplash', limit: 6 },
    },
    writer: {},
    report: vi.fn(async () => undefined),
  } as never;
}

/** Each call must return a fresh row: the executor mutates the block array. */
function mockContent(placeholders: number) {
  vi.spyOn(ContentService.prototype, 'get').mockImplementation(async () => contentRow(placeholders) as never);
  vi.spyOn(ContentService.prototype, 'update').mockResolvedValue(undefined as never);
}

describe('content_images media usage (R5.10.7)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('meters each physical search as its own occurrence', async () => {
    mockContent(3);
    const store = new InMemoryUsageEventStore();

    await getExecutor('content_images')!(
      context({ usageEvents: store, registry: { getMedia: () => recordingMedia(store) }, sb: {} }, 0),
    );

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.operation === 'media_search' && e.sourceId === 'job-content-images')).toBe(true);
  });

  it('seeds the occurrence counter from the job retry count', async () => {
    mockContent(1);
    const store = new InMemoryUsageEventStore();

    // First execution records occurrence 0; a retry that really searches again
    // must not be deduplicated against it.
    await getExecutor('content_images')!(
      context({ usageEvents: store, registry: { getMedia: () => recordingMedia(store) }, sb: {} }, 0),
    );
    await getExecutor('content_images')!(
      context({ usageEvents: store, registry: { getMedia: () => recordingMedia(store) }, sb: {} }, 1),
    );

    const events = await store.list({ projectId: PROJECT });
    expect(events).toHaveLength(2);
  });

  it('records nothing when the provider is not configured', async () => {
    mockContent(1);
    const store = new InMemoryUsageEventStore();
    const media: MediaProvider = { ...recordingMedia(store), isConfigured: () => false };

    await expect(
      getExecutor('content_images')!(
        context({ usageEvents: store, registry: { getMedia: () => media }, sb: {} }, 0),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(await store.list({ projectId: PROJECT })).toHaveLength(0);
  });
});
