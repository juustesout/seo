/**
 * Cosmos AI editor service: the model must return a validated
 * `replace_selection` operation, the backend must gather the context (including
 * Cosmos) itself, and the stored article must never be written.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { ServiceContainer } from '../context.js';
import {
  ContentAiEditService,
  buildContentAiEditPrompt,
  nearbyContext,
  parseAiEditOutput,
} from './contentAiEditService.js';

const mock = vi.hoisted(() => ({
  calls: [] as Array<{ messages: Array<{ role: string; content: string }> }>,
  response: '',
  provider: {
    id: 'openai',
    isConfigured: () => true,
    chat: async (req: { messages: Array<{ role: string; content: string }> }) => {
      mock.calls.push(req);
      return { content: mock.response };
    },
    models: () => [],
    capabilities: [] as string[],
  },
}));

vi.mock('./aiService.js', () => ({
  AIService: class {
    async resolve() {
      return { provider: mock.provider, configured: true, keySource: 'project' as const };
    }
  },
}));

const PROJECT = 'p1';
const CONTENT = 'c1';

const DOC = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Blue widgets are sturdy.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Blue widgets are affordable.' }] },
  ],
};

const ROW = {
  id: CONTENT,
  project_id: PROJECT,
  title: 'Blue widgets',
  target_keyword: 'blue widgets',
  meta_title: null,
  meta_description: null,
  language: 'en',
  content_json: DOC,
};

function makeContainer(settings: Record<string, unknown> = {}) {
  const updates: Array<{ table: string; payload: unknown }> = [];
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: chain,
      eq: chain,
      neq: chain,
      limit: chain,
      maybeSingle: async () => {
        if (table === 'seo_content') return { data: ROW, error: null };
        if (table === 'seo_projects') return { data: { settings }, error: null };
        return { data: null, error: null };
      },
      update: (payload: unknown) => {
        updates.push({ table, payload });
        return { eq: async () => ({ error: null }) };
      },
    });
    return b;
  };
  const container = {
    sb: { from: (table: string) => builder(table) },
    config: { env: {} },
    registry: { getKnowledge: () => undefined },
    credentials: {},
  } as unknown as ServiceContainer;
  return { container, updates };
}

function validResponse(text = 'Tighter copy.') {
  return JSON.stringify({
    operation: 'replace_selection',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    reason: 'tightened',
  });
}

beforeEach(() => {
  mock.calls.length = 0;
  mock.response = validResponse();
});

describe('parseAiEditOutput', () => {
  it('accepts a valid replace_selection operation', () => {
    const out = parseAiEditOutput(validResponse('Hello.'));
    expect(out.reason).toBe('tightened');
    expect(out.content).toHaveLength(1);
    expect(out.content[0]!.type).toBe('paragraph');
  });

  it('accepts a doc-wrapped block array', () => {
    const out = parseAiEditOutput(
      JSON.stringify({ operation: 'replace_selection', content: { type: 'doc', content: DOC.content } }),
    );
    expect(out.content).toHaveLength(2);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseAiEditOutput('not json')).toThrowError(/invalid output/);
  });

  it('rejects a wrong operation', () => {
    expect(() =>
      parseAiEditOutput(JSON.stringify({ operation: 'replace_document', content: DOC.content })),
    ).toThrowError(/unsupported operation/);
  });

  it('rejects an empty edit', () => {
    expect(() => parseAiEditOutput(JSON.stringify({ operation: 'replace_selection', content: [] }))).toThrowError(
      /empty edit/,
    );
  });

  it('rejects unsupported node types', () => {
    const withImage = JSON.stringify({
      operation: 'replace_selection',
      content: [{ type: 'image', attrs: { mediaId: 'm1' } }],
    });
    expect(() => parseAiEditOutput(withImage)).toThrowError(/unsupported edit/);
  });

  it('rejects link marks so the model cannot invent URLs', () => {
    const withLink = JSON.stringify({
      operation: 'replace_selection',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href: 'https://x.example' } }] }],
        },
      ],
    });
    expect(() => parseAiEditOutput(withLink)).toThrowError(/unsupported edit/);
  });

  it('rejects an oversized edit', () => {
    const huge = JSON.stringify({
      operation: 'replace_selection',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(20_001) }] }],
    });
    expect(() => parseAiEditOutput(huge)).toThrowError(/too large/);
  });
});

describe('buildContentAiEditPrompt', () => {
  const base = {
    input: { operation: 'rewrite' as const, selection: { from: 0, to: 4 }, text: 'Old copy.' },
    meta: {
      title: 'Blue widgets',
      targetKeyword: 'blue widgets',
      metaTitle: null,
      metaDescription: null,
      language: 'en',
    },
    contextBefore: 'Before text.',
    contextAfter: 'After text.',
    cosmosText: '',
    seoLines: [],
    knowledge: [],
  };

  it('includes selection, nearby context and metadata', () => {
    const { user, system } = buildContentAiEditPrompt(base);
    expect(user).toContain('Blue widgets');
    expect(user).toContain('<<<SELECTION');
    expect(user).toContain('Old copy.');
    expect(user).toContain('<<<BEFORE');
    expect(user).toContain('<<<AFTER');
    expect(system).toContain('replace_selection');
  });

  it('includes Cosmos when present and omits it when empty', () => {
    const withCosmos = buildContentAiEditPrompt({ ...base, cosmosText: 'Voice:\n- Tone: playful' });
    expect(withCosmos.user).toContain('<<<COSMOS');
    expect(withCosmos.user).toContain('playful');
    const without = buildContentAiEditPrompt(base);
    expect(without.user).not.toContain('COSMOS');
  });

  it('appends a delimited knowledge block only when passages exist', () => {
    const none = buildContentAiEditPrompt(base);
    expect(none.user).not.toContain('<<<KNOWLEDGE');
    const some = buildContentAiEditPrompt({
      ...base,
      knowledge: [{ name: 'Style guide', excerpt: 'Use active voice.' }],
    });
    expect(some.user).toContain('<<<KNOWLEDGE');
    expect(some.user).toContain('Style guide');
  });
});

describe('nearbyContext', () => {
  it('returns the window around the located selection', () => {
    const full = `${'a'.repeat(1000)}SELECTION${'b'.repeat(1000)}`;
    const { before, after } = nearbyContext(full, 'SELECTION');
    expect(before.endsWith('a'.repeat(10))).toBe(true);
    expect(before.length).toBe(800);
    expect(after.startsWith('b'.repeat(10))).toBe(true);
    expect(after.length).toBe(400);
  });

  it('falls back to the document head when the selection is not found', () => {
    const { before, after } = nearbyContext('some document text', 'missing');
    expect(before).toBe('some document text');
    expect(after).toBe('');
  });
});

describe('ContentAiEditService.run', () => {
  it('returns a validated replace_selection and never writes the article', async () => {
    const { container, updates } = makeContainer();
    const service = new ContentAiEditService(container);
    const result = await service.run(PROJECT, CONTENT, {
      operation: 'rewrite',
      selection: { from: 0, to: 4 },
      text: 'Blue widgets',
    });
    expect(result.operation).toBe('replace_selection');
    expect(result.model).toBe('openai');
    expect(result.content[0]!.type).toBe('paragraph');
    // The article is only read; no seo_content write happens.
    expect(updates.filter((u) => u.table === 'seo_content')).toHaveLength(0);
  });

  it('includes the project Cosmos in the prompt context', async () => {
    const { container } = makeContainer({
      cosmos: { identity: { name: 'Acme' }, voice: { tone: 'playful and direct' } },
    });
    const service = new ContentAiEditService(container);
    await service.run(PROJECT, CONTENT, {
      operation: 'improve',
      selection: { from: 0, to: 4 },
      text: 'Blue widgets',
    });
    const user = mock.calls[0]!.messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('<<<COSMOS');
    expect(user).toContain('playful and direct');
  });

  it('rejects malformed model output with a clean 422', async () => {
    mock.response = 'definitely not json';
    const { container } = makeContainer();
    const service = new ContentAiEditService(container);
    await expect(
      service.run(PROJECT, CONTENT, { operation: 'rewrite', selection: { from: 0, to: 4 }, text: 'Blue widgets' }),
    ).rejects.toMatchObject({ status: 422, code: 'agent_invalid_output' });
  });

  it('rejects an unsupported node type from the model', async () => {
    mock.response = JSON.stringify({
      operation: 'replace_selection',
      content: [{ type: 'script', content: [] }],
    });
    const { container } = makeContainer();
    const service = new ContentAiEditService(container);
    await expect(
      service.run(PROJECT, CONTENT, { operation: 'rewrite', selection: { from: 0, to: 4 }, text: 'Blue widgets' }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('requires an instruction for Ask AI', async () => {
    const { container } = makeContainer();
    const service = new ContentAiEditService(container);
    await expect(
      service.run(PROJECT, CONTENT, { operation: 'ask', selection: { from: 0, to: 4 }, text: 'Blue widgets' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects an empty selection before touching the provider', async () => {
    const { container } = makeContainer();
    const service = new ContentAiEditService(container);
    await expect(
      service.run(PROJECT, CONTENT, { operation: 'rewrite', selection: { from: 0, to: 0 }, text: '   ' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mock.calls).toHaveLength(0);
  });
});
