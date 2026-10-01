/**
 * OpenAI image generation media provider (MediaProvider.generate).
 *
 * Uses the server-side OPENAI_API_KEY to produce an image via the images API.
 * Not configured when the key is missing.
 *
 * Note on media rules: OpenAI's images endpoint answers with a URL OR a
 * base64 payload (b64_json), never both reliably. A b64 payload is only ever
 * used as a fallback when no URL comes back - the caller stores it in the
 * media library, which never treats inline data-URLs as a primary asset path.
 */

import type {
  MediaGenerateOptions,
  MediaProvider,
  MediaResult,
  MediaCapability,
  MediaUsageScope,
  ProviderLogger,
} from '@seo/contracts';
import { fetchWithTimeout } from '../../http/fetchTimeout.js';
import { emitMediaUsage } from './mediaUsage.js';

export interface OpenAiMediaProviderDeps {
  config: Record<string, string | undefined>;
  logger: ProviderLogger;
  fetchFn?: typeof fetch;
}

/**
 * Generation-only OpenAI media adapter. Stateless apart from config; the key
 * is read server-side per call and never exposed to the browser.
 */
export class OpenAiMediaProvider implements MediaProvider {
  readonly id = 'openai_media';
  readonly name = 'OpenAI images';
  readonly description = 'Generate images from a prompt (OpenAI images API)';
  readonly capabilities: readonly MediaCapability[] = ['generate'];

  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: OpenAiMediaProviderDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.deps.config.OPENAI_API_KEY);
  }

  private get baseUrl(): string {
    return this.deps.config.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  }

  /**
   * Report one external generation request outcome, best-effort (R5.10.7). A
   * misbehaving usage sink never fails the generation; a missing key issues no
   * request and records nothing.
   */
  private async reportUsage(scope: MediaUsageScope | undefined, success: boolean, model: string): Promise<void> {
    if (!scope) return;
    try {
      await emitMediaUsage({ scope, provider: this.id, operation: 'image_generate', success, model });
    } catch {
      // Usage is observability, never the request's transaction boundary.
    }
  }

  /**
   * Generate one image. The prompt doubles as the description (truncated) so
   * the media library has meaningful alt/caption text without an extra call.
   * A response with neither URL nor b64_json is treated as a failure - an
   * empty image must never be stored as a successful generation.
   */
  async generate(opts: MediaGenerateOptions): Promise<MediaResult> {
    if (!this.isConfigured()) {
      throw new Error('OpenAI images are not configured: set OPENAI_API_KEY');
    }
    const model = this.deps.config.OPENAI_IMAGE_MODEL ?? 'dall-e-3';
    const size = this.normalizeSize(opts.size, model);
    let res: Response;
    try {
      res = await fetchWithTimeout(this.fetchFn, `${this.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.deps.config.OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model, prompt: opts.prompt, size, n: 1 }),
      });
    } catch (err) {
      // The request was initiated but did not complete; record the attempt.
      await this.reportUsage(opts.usage, false, model);
      throw err;
    }
    if (!res.ok) {
      await this.reportUsage(opts.usage, false, model);
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI images API ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
    const item = json.data?.[0];
    const url = item?.url ?? null;
    const b64 = item?.b64_json ?? null;
    if (!url && !b64) {
      await this.reportUsage(opts.usage, false, model);
      throw new Error('OpenAI images returned no image');
    }
    await this.reportUsage(opts.usage, true, model);
    return {
      id: `openai:${Date.now()}`,
      url: url ?? `data:image/png;base64,${b64}`,
      description: opts.prompt.slice(0, 300),
      source: 'openai',
    };
  }

  /** gpt-image models expose 1536x1024 / 1024x1536 instead of the 1792x1024 dall-e sizes. */
  private normalizeSize(size: string | undefined, model: string): string {
    const requested = size ?? '1024x1024';
    if (model.includes('gpt-image')) {
      if (requested === '1792x1024') return '1536x1024';
      if (requested === '1024x1792') return '1024x1536';
      return '1024x1024';
    }
    return requested;
  }
}
