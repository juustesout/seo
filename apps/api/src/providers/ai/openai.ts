/**
 * OpenAI provider adapter implementing the contracts AIProvider interface.
 *
 * Configuration is read from server-side environment only (apps/api/.env):
 *   OPENAI_API_KEY            - the account key (BYOK; never from the browser)
 *   OPENAI_BASE_URL           - optional, defaults to https://api.openai.com/v1
 *   OPENAI_CHAT_MODEL         - default chat/generation model
 *   OPENAI_EMBEDDING_MODEL    - default embedding model
 *
 * When OPENAI_API_KEY is missing the provider reports itself as not
 * configured and every call fails with a clear error - never fake output.
 */

import type {
  AIEmbeddingRequest,
  AIEmbeddingResult,
  AIGenerateRequest,
  AICapability,
  AIProvider,
  AIChatRequest,
  AIChatResult,
  AIModelInfo,
  ProviderLogger,
} from '@seo/contracts';

export interface OpenAiProviderDeps {
  config: Record<string, string | undefined>;
  logger: ProviderLogger;
  fetchFn?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';
const CHAT_MODELS: AIModelInfo[] = [
  { id: 'gpt-4o', name: 'GPT-4o', kind: 'chat' },
  { id: 'gpt-4o-mini', name: 'GPT-4o mini', kind: 'chat' },
];
const EMBEDDING_MODELS: AIModelInfo[] = [
  { id: 'text-embedding-3-small', name: 'text-embedding-3-small', kind: 'embedding' },
  { id: 'text-embedding-3-large', name: 'text-embedding-3-large', kind: 'embedding' },
];

/**
 * OpenAI provider adapter behind the contracts AIProvider interface.
 *
 * Instantiated once at container boot and registered in the provider registry;
 * project AI settings (AIService) resolve to this instance, so a single
 * server-side OpenAI credential serves every project. The adapter is
 * stateless apart from its config + injected fetch, which keeps it safe to
 * share across concurrent job/HTTP calls. BYOK lives here too: project-level
 * keys are read out of the encrypted credential store by AIService and passed
 * in via deps.config on a per-call basis, never mixed into shared state.
 */
export class OpenAIProvider implements AIProvider {
  readonly id = 'openai';
  readonly name = 'OpenAI';
  readonly description = 'Chat, generation and embeddings via the OpenAI API';
  readonly capabilities: readonly AICapability[] = ['chat', 'generate', 'embed', 'models'];

  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: OpenAiProviderDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  /**
   * Server-side account key. Read from deps.config rather than an ambient
   * process variable so tests and BYOK callers can inject it per instance.
   */
  private get apiKey(): string | undefined {
    return this.deps.config.OPENAI_API_KEY;
  }

  private get baseUrl(): string {
    return this.deps.config.OPENAI_BASE_URL ?? DEFAULT_BASE_URL;
  }

  private get chatModel(): string {
    return this.deps.config.OPENAI_CHAT_MODEL ?? DEFAULT_CHAT_MODEL;
  }

  private get embeddingModel(): string {
    return this.deps.config.OPENAI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  }

  /**
   * True when a server key is present. The UI reports "not configured" from
   * this rather than probing the API - honesty over fabricated capability.
   */
  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * Capability-model list for the AI settings UI. The configured default
   * models are surfaced first so callers can rely on a sensible default
   * without hardcoding provider-specific model ids.
   */
  models(): AIModelInfo[] {
    const list: AIModelInfo[] = [];
    const chat = this.chatModel;
    const embedding = this.embeddingModel;
    for (const m of CHAT_MODELS) {
      if (m.id === chat) {
        list.unshift(m);
        break;
      }
    }
    if (!list.some((m) => m.id === chat)) {
      list.unshift({ id: chat, name: chat, kind: 'chat' });
    }
    const embed = this.embeddingModel;
    if (!EMBEDDING_MODELS.some((m) => m.id === embed)) {
      list.push({ id: embed, name: embed, kind: 'embedding' });
    } else {
      list.push(...EMBEDDING_MODELS.filter((m) => m.id === embed));
    }
    list.push(...CHAT_MODELS.filter((m) => m.id !== chat && !list.some((l) => l.id === m.id)));
    list.push(...EMBEDDING_MODELS.filter((m) => m.id !== embed && !list.some((l) => l.id === m.id)));
    return list;
  }

  /**
   * Guard every remote call: without a key any request would 401 with a
   * confusing vendor error, so we fail fast with a server-actionable message
   * (which one of the OPENAI_* env vars to set).
   */
  private assertConfigured(): void {
    if (!this.apiKey) {
      throw new Error('OpenAI is not configured. Set OPENAI_API_KEY in the server environment.');
    }
  }

  /**
   * Shared POST helper. Non-ok responses are converted to Error carrying a
   * truncated vendor message (300 chars) - enough to debug, never the whole
   * body, so provider internals cannot leak into job/HTTP error surfaces.
   */
  private async postJson(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertConfigured();
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI API ${res.status} on ${path}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Chat completion. Response_format json_object is requested instead of the
   * deprecated JSON mode because it yields a guaranteed JSON shape without an
   * extra pre-flight pass. An empty completion is treated as a failure - a
   * hallucinated blank answer must not be persisted as content.
   */
  async chat(req: AIChatRequest): Promise<AIChatResult> {
    const payload: Record<string, unknown> = {
      model: req.model ?? this.chatModel,
      messages: req.messages,
    };
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.maxTokens !== undefined) payload.max_tokens = req.maxTokens;
    if (req.json) payload.response_format = { type: 'json_object' };

    const json = await this.postJson('/chat/completions', payload);
    const choices = (json.choices ?? []) as Array<{ message?: { content?: string } }>;
    const content = choices[0]?.message?.content ?? '';
    const usageRaw = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    if (!content) {
      throw new Error('OpenAI returned an empty chat completion');
    }
    return {
      content,
      model: (json.model as string) ?? req.model ?? this.chatModel,
      usage: usageRaw
        ? { inputTokens: usageRaw.prompt_tokens, outputTokens: usageRaw.completion_tokens }
        : undefined,
    };
  }

  /**
   * Single-shot generation. model/temperature/maxTokens/json map 1:1 onto the
   * chat surface because OpenAI implements both with /chat/completions; this
   * convenience only wraps the prompt into a single user message (plus an
   * optional system preamble) so callers never assemble message arrays.
   */
  async generate(req: AIGenerateRequest): Promise<AIChatResult> {
    const messages: AIChatRequest['messages'] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.prompt });
    return this.chat({
      messages,
      model: req.model,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      json: req.json,
    });
  }

  /**
   * Embed a string or batch. OpenAI caps the input count per request, so
   * inputs are chunked in batches of 16 and results concatenated - this keeps
   * the caller's contract ("all these texts embedded") true regardless of
   * batch size, at the cost of a token-usage sum across the batches.
   */
  async embed(req: AIEmbeddingRequest): Promise<AIEmbeddingResult> {
    const model = req.model ?? this.embeddingModel;
    const input = Array.isArray(req.input) ? req.input : [req.input];
    const vectors: number[][] = [];
    let inputTokens = 0;

    for (let i = 0; i < input.length; i += 16) {
      const batch = input.slice(i, i + 16).filter((t) => t.length > 0);
      if (batch.length === 0) continue;
      const json = await this.postJson('/embeddings', { model, input: batch });
      const data = (json.data ?? []) as Array<{ embedding: number[] }>;
      if (data.length !== batch.length) {
        throw new Error('OpenAI returned fewer embeddings than requested');
      }
      for (const item of data) vectors.push(item.embedding);
      const usageRaw = json.usage as { prompt_tokens?: number } | undefined;
      if (usageRaw?.prompt_tokens) inputTokens += usageRaw.prompt_tokens;
    }
    return { vectors, model, usage: inputTokens ? { inputTokens } : undefined };
  }
}
