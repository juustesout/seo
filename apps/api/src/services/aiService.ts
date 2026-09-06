/**
 * AI application service (SEO Core).
 *
 * Resolves the active AI provider + models for a project, merging three
 * server-side sources in priority order:
 *   1. Account-scoped BYOK key (encrypted, stored under the account's
 *      seo_integrations row for the provider, like the Stage 4 GSC vault)
 *   2. Project-scoped BYOK key (encrypted, stored per project in
 *      seo_credentials under the 'ai' owner scope)
 *   3. Server environment key (OPENAI_API_KEY)
 *   4. nothing -> "not configured"
 *
 * The account owns the AI key and every project under it can use it; projects
 * may still override with their own key. Nothing here ever sends a stored key
 * (or any credential) to the browser.
 */

import type {
  AccountAiProviderDto,
  AccountAiStatusDto,
  AIProvider,
  AiKeySource,
  ProjectAiSettingsInput,
  ProjectAiStatusDto,
  ProviderDescriptor,
} from '@seo/contracts';
import { OpenAIProvider } from '../providers/ai/openai.js';
import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';
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

interface ProjectAiRow {
  account_id: string | null;
  settings: Record<string, unknown>;
}

type AiDescriptor = ProviderDescriptor<'ai'>;

export class AIService {
  constructor(private readonly container: ServiceContainer) {}

  // -------------------------------------------------------------------------
  // Project settings
  // -------------------------------------------------------------------------

  private async readProjectRow(projectId: string): Promise<ProjectAiRow> {
    const { data, error } = await this.container.sb
      .from('seo_projects')
      .select('account_id, settings')
      .eq('id', projectId)
      .maybeSingle<{ account_id: string | null; settings: Record<string, unknown> }>();
    if (error || !data) {
      throw ApiError.notFound('Project not found');
    }
    return { account_id: data.account_id, settings: data.settings ?? {} };
  }

  /** Project non-secret AI settings from seo_projects.settings.ai. */
  private async readSettings(projectId: string): Promise<AiSettings> {
    const row = await this.readProjectRow(projectId);
    const ai = (row.settings.ai ?? {}) as Partial<AiSettings>;
    return {
      provider: ai.provider ?? DEFAULT_PROVIDER,
      chatModel: ai.chatModel,
      embeddingModel: ai.embeddingModel,
    };
  }

  // -------------------------------------------------------------------------
  // Credential reads (encrypted, server-side only)
  // -------------------------------------------------------------------------

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

  /** The account-scoped seo_integrations row holding the AI key, if any. */
  private async accountAiIntegration(
    accountId: string | null,
    providerId: string,
  ): Promise<{ id: string } | null> {
    if (!accountId) return null;
    const { data, error } = await this.container.sb
      .from('seo_integrations')
      .select('id')
      .eq('account_id', accountId)
      .is('project_id', null)
      .eq('provider_type', providerId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();
    if (error) {
      logger.error({ error, providerId }, 'account ai integration lookup failed');
      throw new ApiError(500, 'storage_error', 'Could not read the AI provider connection');
    }
    return data ?? null;
  }

  /** Reads the account-scoped BYOK key for a provider (or null). */
  private async accountApiKey(accountId: string | null, providerId: string): Promise<string | null> {
    const integration = await this.accountAiIntegration(accountId, providerId);
    if (!integration) return null;
    const reader = this.container.credentials.reader({ integrationId: integration.id }, providerId);
    try {
      return await reader.get(AI_CRED_KEY_NAME);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_configured') return null;
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Provider resolution
  // -------------------------------------------------------------------------

  /** Builds an OpenAI provider bound to the effective key for a project. */
  private openAiProvider(effectiveKey: string | null): OpenAIProvider {
    const env = this.container.config.env;
    return new OpenAIProvider({
      config: {
        OPENAI_API_KEY: effectiveKey ?? undefined,
        OPENAI_BASE_URL: env.OPENAI_BASE_URL,
        OPENAI_CHAT_MODEL: env.OPENAI_CHAT_MODEL,
        OPENAI_EMBEDDING_MODEL: env.OPENAI_EMBEDDING_MODEL,
      },
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
  }

  /** Returns the effective AI provider instance for a project. */
  async resolve(
    projectId: string,
  ): Promise<{ provider: AIProvider; configured: boolean; keySource: AiKeySource }> {
    const row = await this.readProjectRow(projectId);
    const settings = (row.settings.ai ?? {}) as Partial<AiSettings>;
    const providerId = settings.provider ?? DEFAULT_PROVIDER;
    const accountKey = await this.accountApiKey(row.account_id, providerId);
    const projectKey = await this.projectApiKey(projectId);
    const envKey = this.container.config.env.OPENAI_API_KEY ?? null;
    const effectiveKey = accountKey ?? projectKey ?? envKey;

    let provider: AIProvider | undefined;
    if (providerId === DEFAULT_PROVIDER) {
      provider = this.openAiProvider(effectiveKey);
    } else {
      provider = this.container.registry.getAI(providerId);
    }

    const keySource: AiKeySource = accountKey ? 'account' : projectKey ? 'project' : envKey ? 'env' : 'none';
    return {
      provider: provider ?? this.openAiProvider(null),
      configured: Boolean(effectiveKey),
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
    const row = await this.readProjectRow(projectId);
    const { error } = await this.container.sb
      .from('seo_projects')
      .update({ settings: { ...row.settings, ai: merged } } as never)
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

  // -------------------------------------------------------------------------
  // Account-level AI configuration (Stage-4 style seo_integrations vault)
  // -------------------------------------------------------------------------

  private friendlyCredentialError(err: unknown): string {
    if (err instanceof ApiError && err.code === 'not_configured') {
      return 'Credential storage is not configured on the server';
    }
    return 'Stored credential could not be read';
  }

  /** Non-secret status of every registered AI provider for an account. */
  async accountStatus(accountId: string): Promise<AccountAiStatusDto> {
    const descriptors = this.container.registry.listAI();
    const providers: AccountAiProviderDto[] = [];
    for (const descriptor of descriptors) {
      const { id: providerId } = descriptor;
      const provider = this.container.registry.getAI(providerId);
      let configured = false;
      let error: string | null = null;
      const integration = await this.accountAiIntegration(accountId, providerId);
      if (integration) {
        const reader = this.container.credentials.reader({ integrationId: integration.id }, providerId);
        try {
          const key = await reader.get(AI_CRED_KEY_NAME);
          configured = Boolean(key);
        } catch (err) {
          error = this.friendlyCredentialError(err);
        }
      }
      providers.push({
        id: providerId,
        name: descriptor.name,
        description: descriptor.description ?? null,
        configured,
        capabilities: [...descriptor.capabilities],
        models: provider?.models() ?? [],
        error,
      });
    }
    return { providers };
  }

  private requireAiDescriptor(providerId: string): AiDescriptor {
    const descriptor = this.container.registry.listAI().find((d) => d.id === providerId);
    if (!descriptor) throw ApiError.badRequest(`Unknown AI provider: ${providerId}`);
    return descriptor;
  }

  /** Upsert (or remove) the account-scoped encrypted key for an AI provider. */
  async setAccountKey(
    accountId: string,
    userId: string,
    providerId: string,
    apiKey: string | null,
  ): Promise<AccountAiStatusDto> {
    const descriptor = this.requireAiDescriptor(providerId);

    if (!apiKey) {
      const integration = await this.accountAiIntegration(accountId, providerId);
      if (integration) {
        const reader = this.container.credentials.reader({ integrationId: integration.id }, providerId);
        await reader.delete(AI_CRED_KEY_NAME);
        const { error } = await this.container.sb.from('seo_integrations').delete().eq('id', integration.id);
        if (error) {
          logger.error({ error }, 'account ai integration delete failed');
          throw new ApiError(500, 'storage_error', 'Could not remove the AI provider connection');
        }
      }
      return this.accountStatus(accountId);
    }

    // Reuse any existing row (any status) so a re-save keeps the same owner.
    let integration = await this.accountAiIntegration(accountId, providerId);
    if (!integration) {
      const insert = await this.container.sb
        .from('seo_integrations')
        .insert({
          account_id: accountId,
          project_id: null,
          provider_type: providerId,
          name: descriptor.name,
          status: 'disconnected',
          capabilities: [...descriptor.capabilities],
          config: {},
          created_by: userId,
        } as never)
        .select()
        .single();
      if (insert.error) {
        logger.error({ error: insert.error }, 'account ai integration create failed');
        throw new ApiError(500, 'storage_error', 'Could not create the AI provider connection');
      }
      integration = { id: (insert.data as { id: string }).id };
    }

    const reader = this.container.credentials.reader({ integrationId: integration.id }, providerId);
    try {
      await reader.set(AI_CRED_KEY_NAME, apiKey, { kind: 'ai', provider: providerId });
    } catch (err) {
      const { error } = await this.container.sb
        .from('seo_integrations')
        .update({ status: 'error', last_error: { message: this.friendlyCredentialError(err) } } as never)
        .eq('id', integration.id);
      if (error) logger.error({ error }, 'account ai integration error state failed');
      throw err;
    }

    const { error: updateError } = await this.container.sb
      .from('seo_integrations')
      .update({ status: 'connected', last_error: null } as never)
      .eq('id', integration.id);
    if (updateError) {
      logger.error({ error: updateError }, 'account ai integration status update failed');
      throw new ApiError(500, 'storage_error', 'Could not update the AI provider connection');
    }

    return this.accountStatus(accountId);
  }
}
