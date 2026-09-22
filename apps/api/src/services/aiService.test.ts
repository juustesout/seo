/**
 * AIService image-generation credential resolution (R4.5B).
 *
 * Pins that the generating key comes from the same BYOK chain as every other AI
 * call (account -> project -> server env) so image generation never introduces a
 * second, parallel credential source.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ServiceContainer } from '../context.js';
import { ApiError } from '../apiErrors.js';
import { AIService } from './aiService.js';

const state = {
  accountId: 'acc-1' as string | null,
  accountIntegration: null as { id: string } | null,
  accountKey: null as string | null,
  projectKey: null as string | null,
};

function builder(table: string) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'order', 'limit']) chain[method] = () => chain;
  chain.maybeSingle = async () => {
    if (table === 'seo_projects') {
      return { data: { account_id: state.accountId, settings: {} }, error: null };
    }
    if (table === 'seo_integrations') return { data: state.accountIntegration, error: null };
    return { data: null, error: null };
  };
  return chain;
}

const container = {
  sb: { from: (table: string) => builder(table) },
  credentials: {
    reader: (owner: { integrationId?: string }) => ({
      get: async () => {
        const key = owner.integrationId ? state.accountKey : state.projectKey;
        if (!key) throw new ApiError(422, 'not_configured', 'not configured');
        return key;
      },
    }),
  },
  config: { env: {} },
} as unknown as ServiceContainer;

const service = new AIService(container);

function setEnv(key: string | null) {
  (container as unknown as { config: { env: Record<string, string | undefined> } }).config.env.OPENAI_API_KEY =
    key ?? undefined;
}

beforeEach(() => {
  state.accountId = 'acc-1';
  state.accountIntegration = null;
  state.accountKey = null;
  state.projectKey = null;
  setEnv(null);
});

describe('AIService.resolveImageGeneration', () => {
  it('prefers the account key and reports its source', async () => {
    state.accountIntegration = { id: 'int-1' };
    state.accountKey = 'sk-account';
    state.projectKey = 'sk-project';
    setEnv('sk-env');
    await expect(service.resolveImageGeneration('p-1')).resolves.toEqual({
      configured: true,
      apiKey: 'sk-account',
      keySource: 'account',
    });
  });

  it('falls back to the project key when the account has none', async () => {
    state.projectKey = 'sk-project';
    setEnv('sk-env');
    await expect(service.resolveImageGeneration('p-1')).resolves.toMatchObject({
      configured: true,
      apiKey: 'sk-project',
      keySource: 'project',
    });
  });

  it('falls back to the server env key last', async () => {
    setEnv('sk-env');
    await expect(service.resolveImageGeneration('p-1')).resolves.toMatchObject({
      configured: true,
      apiKey: 'sk-env',
      keySource: 'env',
    });
  });

  it('reports not configured when no key exists anywhere', async () => {
    await expect(service.resolveImageGeneration('p-1')).resolves.toEqual({
      configured: false,
      apiKey: null,
      keySource: 'none',
    });
  });
});
