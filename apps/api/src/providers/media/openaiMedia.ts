/**
 * OpenAI image generation media provider (MediaProvider.generate).
 *
 * Uses the server-side OPENAI_API_KEY to produce an image via the images API.
 * Not configured when the key is missing.
 */

import type {
  MediaGenerateOptions,
  MediaProvider,
  MediaResult,
  MediaCapability,
  ProviderLogger,
} from '@seo/contracts';

export interface OpenAiMediaProviderDeps {
  config: Record<string, string | undefined>;
  logger: ProviderLogger;
  fetchFn?: typeof fetch;
}

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

  async generate(opts: MediaGenerateOptions): Promise<MediaResult> {
    if (!this.isConfigured()) {
      throw new Error('OpenAI images are not configured: set OPENAI_API_KEY');
    }
    const model = this.deps.config.OPENAI_IMAGE_MODEL ?? 'dall-e-3';
    const size = this.normalizeSize(opts.size, model);
    const res = await this.fetchFn(`${this.baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.deps.config.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, prompt: opts.prompt, size, n: 1 }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI images API ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
    const item = json.data?.[0];
    const url = item?.url ?? null;
    const b64 = item?.b64_json ?? null;
    if (!url && !b64) {
      throw new Error('OpenAI images returned no image');
    }
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
