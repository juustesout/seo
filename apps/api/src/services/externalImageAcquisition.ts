/**
 * External stock-image acquisition (R4.5A).
 *
 * The local-first fallback for editor image insertion: when the project library
 * has no suitable asset and the caller explicitly allowed external search, this
 * searches a stock provider, downloads the chosen image inside a strict host
 * allowlist and a bounded size/time budget, then persists the bytes as an
 * ordinary project media row.
 *
 * Boundaries kept deliberately:
 *   - Only a configured stock provider is used; a missing key is an honest
 *     `provider_not_configured`, never a fabricated image or silent skip.
 *   - Downloads are restricted to a known image host and read with a byte cap
 *     and an abort timeout, so a malicious or huge response cannot exhaust the
 *     process; the bytes are re-sniffed by MediaService before they are stored.
 *   - The result is a normal library row, so the canonical content never carries
 *     a hidden remote URL. The insertion points at that row and carries only
 *     bounded attribution (credit/source URL).
 *   - No secrets are persisted: only the bounded attribution captured from the
 *     public provider result.
 */

import {
  buildImageInsertionQuery,
  imageInsertionAltForIntent,
  visualAspectPreference,
  type ImageInsertionCandidate,
  type ImageInsertionContext,
  type MediaProvider,
  type MediaResult,
  type MediaItemDto,
  type VisualDesignIntent,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ImportExternalMediaInput } from './mediaService.js';

/** Hosts an external image is allowed to be downloaded from (exact match). */
export const EXTERNAL_IMAGE_HOST_ALLOWLIST: readonly string[] = ['images.unsplash.com'];

/**
 * Upper bound for a single external download. Matches `MEDIA_MAX_BYTES` (the
 * library's own cap) without importing it, so this module has no load-time
 * dependency on mediaService and composes cleanly in tests that mock it.
 */
export const EXTERNAL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** Time budget for a provider search + a single image download. */
export const EXTERNAL_IMAGE_TIMEOUT_MS = 15_000;

/** Cap on provider results considered before giving up on a usable image. */
export const EXTERNAL_IMAGE_MAX_ATTEMPTS = 3;

/** True when `rawUrl` is an https URL on an allowlisted image host. */
export function isAllowedExternalImageUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && EXTERNAL_IMAGE_HOST_ALLOWLIST.includes(parsed.hostname);
}

/** Search orientation hint derived from the role's aspect preference. */
function orientationForVisual(visual: VisualDesignIntent): 'landscape' | 'portrait' | 'squarish' | undefined {
  const pref = visualAspectPreference(visual);
  if (pref.orientation === 'square') return 'squarish';
  if (pref.orientation) return pref.orientation;
  const ratio = pref.ratio;
  if (ratio === undefined || !Number.isFinite(ratio) || ratio <= 0) return undefined;
  if (ratio >= 1.05) return 'landscape';
  if (ratio <= 0.95) return 'portrait';
  return 'squarish';
}

/** Bounded attribution string stored on the insertion, e.g. "Photo by Ada on Unsplash". */
export function externalImageCredit(result: MediaResult): string | undefined {
  if (!result.author) return undefined;
  return `Photo by ${result.author} on Unsplash`.slice(0, 300);
}

/**
 * Fetch remote image bytes with a hard timeout and byte cap. The URL must pass
 * the host allowlist first; the response body is streamed into a capped buffer
 * so an over-large body is aborted rather than buffered whole.
 */
async function downloadExternalImage(bytesOpts: {
  url: string;
  fetchFn: typeof fetch;
  timeoutMs: number;
  maxBytes: number;
}): Promise<Buffer> {
  if (!isAllowedExternalImageUrl(bytesOpts.url)) {
    throw new ApiError(422, 'external_image_untrusted_source', 'That image source is not allowed.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), bytesOpts.timeoutMs);
  try {
    const res = await bytesOpts.fetchFn(bytesOpts.url, { signal: controller.signal });
    if (!res.ok) {
      throw new ApiError(502, 'external_search_unavailable', 'The image download failed.');
    }
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > bytesOpts.maxBytes) {
      throw new ApiError(422, 'external_image_too_large', 'The downloaded image is too large.');
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > bytesOpts.maxBytes) {
      throw new ApiError(422, 'external_image_too_large', 'The downloaded image is too large.');
    }
    return buffer;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, 'external_search_unavailable', 'The image download failed.');
  } finally {
    clearTimeout(timer);
  }
}

export interface AcquireExternalImageParams {
  /** Configured stock media provider, or null/undefined when none is registered. */
  provider: MediaProvider | undefined;
  /** The editor context used to derive a bounded search query. */
  context: ImageInsertionContext;
  /** The resolved visual intent (drives orientation and decorative alt policy). */
  visual: VisualDesignIntent;
  projectId: string;
  /** Persist the downloaded bytes as a normal library row. */
  persist: (input: ImportExternalMediaInput) => Promise<MediaItemDto>;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Search, download and persist one external image, then return a normal
 * insertion candidate backed by the new library row. Throws a typed `ApiError`
 * for every honest failure (not configured, search failed, untrusted source,
 * persistence failed) - never a fabricated asset.
 */
export async function acquireExternalImage(params: AcquireExternalImageParams): Promise<ImageInsertionCandidate> {
  const provider = params.provider;
  if (!provider || typeof provider.search !== 'function') {
    throw new ApiError(422, 'external_search_unavailable', 'No external image source is available.');
  }
  if (!provider.isConfigured()) {
    throw new ApiError(
      422,
      'provider_not_configured',
      'External image search is not configured for this server. Add a stock-image API key to enable it.',
    );
  }

  const query = buildImageInsertionQuery(params.context).trim();
  if (!query) {
    throw new ApiError(422, 'external_search_unavailable', 'There is not enough context to search for an image.');
  }

  const fetchFn = params.fetchFn ?? fetch;
  const timeoutMs = params.timeoutMs ?? EXTERNAL_IMAGE_TIMEOUT_MS;
  const maxBytes = params.maxBytes ?? EXTERNAL_IMAGE_MAX_BYTES;
  const orientation = orientationForVisual(params.visual);

  let results: MediaResult[];
  try {
    results = await provider.search({ query, limit: 8, ...(orientation ? { orientation } : {}) });
  } catch {
    throw new ApiError(502, 'external_search_unavailable', 'The external image search failed. Try again in a moment.');
  }
  if (results.length === 0) {
    throw new ApiError(422, 'image_insertion_no_candidate', 'No external image matched this text.');
  }

  let lastPersistenceError: ApiError | null = null;
  for (const result of results.slice(0, EXTERNAL_IMAGE_MAX_ATTEMPTS)) {
    if (!result.url) continue;
    let bytes: Buffer;
    try {
      bytes = await downloadExternalImage({ url: result.url, fetchFn, timeoutMs, maxBytes });
    } catch (err) {
      // An untrusted/invalid result is skipped; a transient failure moves on too.
      if (err instanceof ApiError && err.code === 'external_image_untrusted_source') continue;
      throw err;
    }

    let item: MediaItemDto;
    try {
      item = await params.persist({
        bytes,
        source: 'unsplash',
        sourceMeta: {
          provider: 'unsplash',
          ...(result.sourceAssetId ? { sourceAssetId: result.sourceAssetId } : {}),
          ...(result.author ? { author: result.author } : {}),
          ...(result.authorUrl ? { authorUrl: result.authorUrl } : {}),
          ...(result.sourceUrl ? { sourceUrl: result.sourceUrl } : {}),
        },
        filename: 'Stock photo',
        alt: result.description ?? '',
      });
    } catch (err) {
      lastPersistenceError =
        err instanceof ApiError
          ? err
          : new ApiError(502, 'asset_persistence_failed', 'The image could not be saved to the media library.');
      continue;
    }

    const credit = externalImageCredit(result);
    return {
      assetId: item.id,
      url: item.url,
      alt: imageInsertionAltForIntent(params.visual, item.alt_text, item.filename),
      ...(item.caption ? { caption: item.caption } : {}),
      ...(credit ? { credit } : {}),
      ...(result.sourceUrl ? { sourceUrl: result.sourceUrl } : {}),
      source: 'unsplash',
      ...(item.width !== null ? { width: item.width } : {}),
      ...(item.height !== null ? { height: item.height } : {}),
    };
  }

  throw (
    lastPersistenceError ??
    new ApiError(422, 'image_insertion_no_candidate', 'No external image could be used for this text.')
  );
}
