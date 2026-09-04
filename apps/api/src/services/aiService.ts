/**
 * AI application service (SEO Core).
 *
 * Resolves the active AI provider + models for a project, merging three
 * server-side sources in priority order:
 *   1. Project-scoped BYOK key (encrypted, stored per project in
 *      seo_credentials under the 'ai' owner scope)
 *   2. Server environment key (OPENAI_API_KEY)
 *   3. nothing -> "not configured"
 *
 * Nothing here ever sends a stored key (or any credential) to the browser.
 */

import type {
  AIProvider,
  AiKeySource,
  ProjectAiSettingsInput,
  ProjectAiStatusDto,
} from '@seo/contracts';
import { OpenAIProvider } from '../providers/ai/openai.js';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';

export const AI_OWNER_SCOPE = 'ai' as const;
export const AI_CRED_KEY_NAME = 'OPENAI_API_KEY';
const DEFAULT_PROVIDER = 'openai';
const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

interface AiSettings {
  provider: string;
  chatModel?: string;
  embeddingModel?: string;
}

export class AIService {
  constructor(private readonly container: ServiceContainer) {}

  /** Project non-secret AI settings from seo_projects.settings.ai. */
  private async readSettings(projectId: string): Promise<AiSettings> {
    const { data, error } = await this.container.sb
      .from('seo_projects')
      .select('settings')
      .eq('id', projectId)
      .maybeSingle<{ settings: Record<string, unknown> }>();
    if (error || !data) {
      throw ApiError.notFound('Project not found');
    }
    const ai = (data.settings?.ai ?? {}) as Partial<AiSettings>;
    return {
      provider: ai.provider ?? DEFAULT_PROVIDER,
      chatModel: ai.chatModel,
      embeddingModel: ai.embeddingModel,
    };
  }

  /** Reads the per-project BYOK key (decrypted server-side only). */
  private async projectApiKey(projectId: string): Promise<string | null> {
    const reader = this.container.credentials.reader(
      { projectId, scope: AI_OWNER_SCOPE },
      AI_OWNER_SCOPE,
    );
    try {
      return await reader.get(AI_CRED_KEY_NAME);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_configured') return null;
      throw err;
    }
  }

  /** Builds an OpenAI provider bound to the effective key for a project. */
  private openAiProvider(projectApiKey: string | null): OpenAIProvider {
    const env = this.container.config.env;
    return new OpenAIProvider({
      config: {
        OPENAI_API_KEY: projectApiKey ?? env.OPENAI_API_KEY,
        OPENAI_BASE_URL: env.OPENAI_BASE_URL,
        OPENAI_CHAT_MODEL: env.OPENAI_CHAT_MODEL,
        OPENAI_EMBEDDING_MODEL: env.OPENAI_EMBEDDING_MODEL,
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
  }

  /** Returns the effective AI provider instance for a project. */
  async resolve(projectId: string): Promise<{ provider: AIProvider; configured: boolean; keySource: AiKeySource }> {
    const settings = await this.readSettings(projectId);
    const projectKey = await this.projectApiKey(projectId);
    const envKey = this.container.config.env.OPENAI_API_KEY;

    let provider: AIProvider | undefined;
    if (settings.provider === DEFAULT_PROVIDER) {
      provider = this.openAiProvider(projectKey);
    } else {
      provider = this.container.registry.getAI(settings.provider);
    }

    const keySource: AiKeySource = projectKey ? 'project' : envKey ? 'env' : 'none';
    return {
      provider: provider ?? this.openAiProvider(null),
      configured: Boolean(projectKey || envKey),
      keySource,
    };
  }

  /** Full non-secret status the UI / future REST + MCP rely on. */
  async status(projectId: string): Promise<ProjectAiStatusDto> {
    const settings = await this.readSettings(projectId);
    const resolved = await this.resolve(projectId);
    const provider = resolved.provider;
    const chatModel = settings.chatModel ?? provider.models().find((m) => m.kind === 'chat')?.id ?? DEFAULT_CHAT_MODEL;
    const embeddingModel =
      settings.embeddingModel ?? provider.models().find((m) => m.kind === 'embedding')?.id ?? DEFAULT_EMBEDDING_MODEL;
    return {
      provider: provider.id,
      providerConfigured: provider.isConfigured(),
      chatModel,
      embeddingModel,
      configured: resolved.configured && provider.isConfigured(),
      keySource: resolved.keySource,
      models: provider.models(),
      capabilities: [...provider.capabilities],
    };
  }

  async updateSettings(projectId: string, input: ProjectAiSettingsInput): Promise<ProjectAiStatusDto> {
    const current = await this.readSettings(projectId);
    const providerId = input.provider ?? current.provider;
    if (providerId !== DEFAULT_PROVIDER && !this.container.registry.getAI(providerId)) {
      throw ApiError.badRequest(`Unknown AI provider: ${providerId}`);
    }
    const merged: AiSettings = {
      provider: providerId,
      chatModel: input.chatModel ?? current.chatModel,
      embeddingModel: input.embeddingModel ?? current.embeddingModel,
    };
    const { data } = await this.container.sb
      .from('seo_projects')
      .select('settings')
      .eq('id', projectId)
      .maybeSingle<{ settings: Record<string, unknown> }>();
    if (!data) throw ApiError.notFound('Project not found');
    const { error } = await this.container.sb
      .from('seo_projects')
      .update({ settings: { ...data.settings, ai: merged } } as never)
      .eq('id', projectId);
    if (error) {
      throw ApiError.badRequest('Could not update AI settings');
    }
    return this.status(projectId);
  }

  /** Set (or with null, remove) the project BYOK key. Stored encrypted. */
  async setApiKey(projectId: string, apiKey: string | null): Promise<ProjectAiStatusDto> {
    const reader = this.container.credentials.reader(
      { projectId, scope: AI_OWNER_SCOPE },
      AI_OWNER_SCOPE,
    );
    if (apiKey) {
      await reader.set(AI_CRED_KEY_NAME, apiKey, { kind: 'ai' });
    } else {
      await this.container.credentials.clearForOwner({ projectId, scope: AI_OWNER_SCOPE });
    }
    return this.status(projectId);
  }
}
