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

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai';
  readonly name = 'OpenAI';
  readonly description = 'Chat, generation and embeddings via the OpenAI API';
  readonly capabilities: readonly AICapability[] = ['chat', 'generate', 'embed', 'models'];

  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: OpenAiProviderDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

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

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

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

  private assertConfigured(): void {
    if (!this.apiKey) {
      throw new Error('OpenAI is not configured. Set OPENAI_API_KEY in the server environment.');
    }
  }

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
