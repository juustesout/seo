/**
 * Confirmed AI image generation (R4.5B).
 *
 * The last, and the only spending, source for editor image insertion: when the
 * project library and external search both have no suitable asset *and* the
 * caller explicitly confirmed generation, this generates one image through the
 * configured media provider, persists the bytes as an ordinary project media row
 * and returns a normal insertion candidate.
 *
 * Boundaries kept deliberately:
 *   - Generation never happens here on its own. The caller resolves the source
 *     policy and the user's explicit confirmation first; this module only runs
 *     once both are true. It is never reachable from a silent fallback.
 *   - The provider is bound to the *effective* BYOK credential the caller
 *     resolved through `AIService` - never a hardcoded or browser-supplied key.
 *   - The result is stored like any other library row (`source:
 *     'openai_generated'`), so content never references a transient provider URL.
 *     Only bounded, non-secret provenance (provider + model) is persisted.
 *   - Every failure is a typed, honest `ApiError`; there is no placeholder image.
 */

import {
  buildImageInsertionQuery,
  imageInsertionAltForIntent,
  visualAspectPreference,
  type ImageInsertionCandidate,
  type ImageInsertionContext,
  type MediaGenerateOptions,
  type MediaItemDto,
  type MediaProvider,
  type VisualDesignIntent,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import { OpenAiMediaProvider } from '../providers/media/openaiMedia.js';
import type { ImportExternalMediaInput } from './mediaService.js';

/** Default generation model; matches the OpenAI media provider fallback. */
export const IMAGE_GENERATION_DEFAULT_MODEL = 'dall-e-3';

/**
 * Time budget for one generation request. Image generation is slow relative to
 * a text call, so this is generous but still bounded.
 */
export const IMAGE_GENERATION_TIMEOUT_MS = 60_000;

/** Upper bound for a downloaded generated image; matches the library cap. */
export const IMAGE_GENERATION_MAX_BYTES = 8 * 1024 * 1024;

/** Bounded prompt length; OpenAI caps dall-e-3 prompts around 4000 chars. */
export const IMAGE_GENERATION_PROMPT_MAX_CHARS = 900;

const NOOP_LOGGER = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/**
 * Await `promise` but reject with `onTimeout()` after `ms`. The timer is always
 * cleared so a fast success never leaves a dangling timer behind.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => ApiError): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The generation model an acquisition request reports (fixed server-side). */
export function imageGenerationModel(override?: string): string {
  const model = override?.trim();
  return model ? model : IMAGE_GENERATION_DEFAULT_MODEL;
}

/**
 * A deterministic, bounded image prompt built from the same context search uses,
 * plus a role-aware photographic style. A subject named in the instruction leads
 * the prompt so a generated image depicts what the user asked for. It asks for
 * text-free imagery so a generated asset never ships embedded copy that the
 * editor cannot edit.
 */
export function buildImageGenerationPrompt(
  context: ImageInsertionContext,
  visual: VisualDesignIntent,
  subject?: string,
): string {
  const description = buildImageInsertionQuery(context, subject).replace(/\s+/g, ' ').trim();
  const style =
    visual.role === 'hero'
      ? 'wide editorial hero photograph'
      : visual.role === 'background'
        ? 'subtle, unobtrusive background photograph'
        : 'editorial photograph';
  const body = description ? `${style} for: ${description}` : style;
  return `${body}. No text, no watermark, no logos.`.slice(0, IMAGE_GENERATION_PROMPT_MAX_CHARS);
}

/** Generation size hint derived from the role's aspect preference. */
function sizeForVisual(visual: VisualDesignIntent): NonNullable<MediaGenerateOptions['size']> {
  const pref = visualAspectPreference(visual);
  if (pref.orientation === 'portrait') return '1024x1792';
  if (pref.orientation === 'landscape') return '1792x1024';
  const ratio = pref.ratio;
  if (ratio !== undefined && Number.isFinite(ratio) && ratio > 0) {
    if (ratio >= 1.05) return '1792x1024';
    if (ratio <= 0.95) return '1024x1792';
  }
  return '1024x1024';
}

/** Decode a `data:<mime>;base64,...` payload, or null when it is not one. */
function decodeInlineImage(url: string): Buffer | null {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(url);
  if (!match) return null;
  try {
    const buffer = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

/**
 * Fetch generated bytes from a provider-hosted URL with a hard timeout and byte
 * cap. Unlike external search this is a URL *we* asked the provider for, so it
 * is not passed through the stock-photo host allowlist, but it must still be
 * https and stay within the same size budget.
 */
async function downloadGeneratedImage(opts: {
  url: string;
  fetchFn: typeof fetch;
  timeoutMs: number;
  maxBytes: number;
}): Promise<Buffer> {
  if (!opts.url.startsWith('https://')) {
    throw new ApiError(502, 'image_generation_failed', 'The generated image could not be retrieved.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await opts.fetchFn(opts.url, { signal: controller.signal });
    if (!res.ok) {
      throw new ApiError(502, 'image_generation_failed', 'The generated image could not be retrieved.');
    }
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      throw new ApiError(422, 'generated_image_too_large', 'The generated image is too large.');
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > opts.maxBytes) {
      throw new ApiError(422, 'generated_image_too_large', 'The generated image is too large.');
    }
    return buffer;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, 'image_generation_failed', 'The generated image could not be retrieved.');
  } finally {
    clearTimeout(timer);
  }
}

export interface AcquireGeneratedImageParams {
  projectId: string;
  context: ImageInsertionContext;
  /** Subject named in the instruction; leads the generation prompt when present. */
  subject?: string;
  visual: VisualDesignIntent;
  /**
   * Effective OpenAI credential resolved through the BYOK chain, or null when
   * generation is not configured. The key is never logged or persisted.
   */
  apiKey: string | null;
  /** Optional server-env overrides for the provider. */
  baseUrl?: string;
  model?: string;
  /** Persist the generated bytes as a normal library row. */
  persist: (input: ImportExternalMediaInput) => Promise<MediaItemDto>;
  /** Test seam; defaults to a real OpenAI media provider bound to `apiKey`. */
  provider?: MediaProvider;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Generate, download and persist one image, then return a normal insertion
 * candidate backed by the new library row. Throws a typed `ApiError` for every
 * honest failure (not configured, generation failed, too large, persistence
 * failed) - never a fabricated asset.
 */
export async function acquireGeneratedImage(
  params: AcquireGeneratedImageParams,
): Promise<ImageInsertionCandidate> {
  const model = imageGenerationModel(params.model);
  const provider =
    params.provider ??
    new OpenAiMediaProvider({
      config: {
        OPENAI_API_KEY: params.apiKey ?? undefined,
        OPENAI_BASE_URL: params.baseUrl,
        OPENAI_IMAGE_MODEL: model,
      },
      logger: NOOP_LOGGER,
      ...(params.fetchFn ? { fetchFn: params.fetchFn } : {}),
    });
  if (typeof provider.generate !== 'function' || !provider.isConfigured()) {
    throw new ApiError(
      422,
      'image_generation_not_configured',
      'Image generation is not configured. Add an OpenAI API key to enable it.',
    );
  }

  const prompt = buildImageGenerationPrompt(params.context, params.visual, params.subject);
  const fetchFn = params.fetchFn ?? fetch;
  const timeoutMs = params.timeoutMs ?? IMAGE_GENERATION_TIMEOUT_MS;
  const maxBytes = params.maxBytes ?? IMAGE_GENERATION_MAX_BYTES;

  let result;
  try {
    result = await withTimeout(
      provider.generate({ prompt, size: sizeForVisual(params.visual) }),
      timeoutMs,
      () => new ApiError(502, 'image_generation_failed', 'The image could not be generated. Try again in a moment.'),
    );
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, 'image_generation_failed', 'The image could not be generated. Try again in a moment.');
  }
  if (!result.url) {
    throw new ApiError(502, 'image_generation_failed', 'The image could not be generated. Try again in a moment.');
  }

  const inline = decodeInlineImage(result.url);
  const bytes = inline ?? (await downloadGeneratedImage({ url: result.url, fetchFn, timeoutMs, maxBytes }));
  if (bytes.length > maxBytes) {
    throw new ApiError(422, 'generated_image_too_large', 'The generated image is too large.');
  }

  let item: MediaItemDto;
  try {
    item = await params.persist({
      bytes,
      source: 'openai_generated',
      sourceMeta: { provider: 'openai', model },
      filename: 'Generated image',
      alt: result.description ?? '',
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, 'asset_persistence_failed', 'The image could not be saved to the media library.');
  }

  return {
    assetId: item.id,
    url: item.url,
    alt: imageInsertionAltForIntent(params.visual, item.alt_text, item.filename),
    ...(item.caption ? { caption: item.caption } : {}),
    source: 'openai_generated',
    ...(item.width !== null ? { width: item.width } : {}),
    ...(item.height !== null ? { height: item.height } : {}),
  };
}
