import { describe, expect, it } from 'vitest';
import { OpenAIProvider } from './openai.js';

function makeProvider(config: Record<string, string | undefined>, fetchFn?: typeof fetch) {
  return new OpenAIProvider({ config, logger: console, fetchFn });
}

describe('OpenAIProvider', () => {
  it('reports not configured without an API key', () => {
    const p = makeProvider({});
    expect(p.isConfigured()).toBe(false);
    expect(p.models().length).toBeGreaterThan(0);
  });

  it('throws a clear error when called while not configured', async () => {
    const p = makeProvider({});
    await expect(p.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      'OpenAI is not configured',
    );
  });

  it('exposes configured defaults first in models()', () => {
    const p = makeProvider({
      OPENAI_API_KEY: 'k',
      OPENAI_CHAT_MODEL: 'gpt-4o',
      OPENAI_EMBEDDING_MODEL: 'text-embedding-3-large',
    });
    const models = p.models();
    expect(models[0]).toMatchObject({ id: 'gpt-4o', kind: 'chat' });
    expect(models.some((m) => m.kind === 'embedding' && m.id === 'text-embedding-3-large')).toBe(true);
  });

  it('calls chat completions and returns the assistant message', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchFn = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = String(init?.body);
      calls.push({ url: String(url), body });
      return new Response(
        JSON.stringify({
          model: 'gpt-4o-mini',
          choices: [{ message: { content: 'Hello from model' } }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const p = makeProvider({ OPENAI_API_KEY: 'k' }, fetchFn);
    const result = await p.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.content).toBe('Hello from model');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(calls[0].url).toContain('/chat/completions');
    const sent = JSON.parse(calls[0].body);
    expect(sent.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(sent.model).toBe('gpt-4o-mini');
  });

  it('embeds text in batches through /embeddings', async () => {
    const fetchFn = async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          model: body.model,
          data: (body.input as string[]).map((_t: string, i: number) => ({ embedding: [i, 0] })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const p = makeProvider({ OPENAI_API_KEY: 'k', OPENAI_EMBEDDING_MODEL: 'text-embedding-3-small' }, fetchFn);
    const result = await p.embed({ input: ['a', 'b'] });
    expect(result.vectors).toHaveLength(2);
    expect(result.model).toBe('text-embedding-3-small');
  });
});
