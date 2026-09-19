/**
 * Designer revision Writer tests (Stage 8E.6, Phase 3.2).
 *
 * The AI boundary may only return copy for the refs the resolver handed it.
 * These tests drive a fake provider so every honest-failure path is covered:
 * missing AI, transport/resolution errors, and malformed/unknown refs with one
 * bounded corrective retry. The module never returns a document, so structure
 * cannot leak.
 */
import { describe, expect, it } from 'vitest';
import type { AIProvider, CanonicalDocument } from '@seo/contracts';
import { resolveDesignerRevisionTargets } from '@seo/contracts';
import {
  DESIGNER_REVISION_WRITE_MAX_ATTEMPTS,
  buildDesignerRevisionPrompt,
  createAiDesignerRevisionWriter,
} from './revisionWriter.js';

interface ChatCall {
  messages: Array<{ role: string; content: string }>;
  json?: boolean;
}

function fakeProvider(chat: (call: ChatCall) => Promise<{ content: string }>): {
  provider: AIProvider;
  calls: ChatCall[];
} {
  const calls: ChatCall[] = [];
  const provider = {
    id: 'openai',
    isConfigured: () => true,
    chat: (req: ChatCall) => {
      calls.push(req);
      return chat(req);
    },
    models: () => [],
    capabilities: [],
  } as unknown as AIProvider;
  return { provider, calls };
}

function configuredResolver(provider: AIProvider) {
  return async () => ({ provider, configured: true });
}

const document: CanonicalDocument = {
  version: 1,
  blocks: [
    { id: 'hero__title', type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Old title' }] },
    { id: 'hero__intro', type: 'paragraph', content: [{ type: 'text', text: 'Old intro' }] },
    {
      id: 'features',
      type: 'list',
      attrs: { ordered: false },
      children: [{ type: 'listItem', content: [{ type: 'text', text: 'One' }] }],
    },
  ],
};

const targets = resolveDesignerRevisionTargets(document, { kind: 'document' });

const INPUT = {
  projectId: 'p1',
  brief: 'Launch a landing page for our analytics tool.',
  instruction: 'Tighten the copy and make it more concrete.',
  targets,
};

const VALID = JSON.stringify({
  revisions: [
    { ref: 'hero__title', text: 'Sharper title' },
    { ref: 'features', items: ['Alpha', 'Beta'] },
  ],
});

describe('designer revision writer agent', () => {
  it('returns validated fills from valid model JSON', async () => {
    const { provider } = fakeProvider(async () => ({ content: VALID }));
    const outcome = await createAiDesignerRevisionWriter(configuredResolver(provider)).revise(INPUT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.fills).toEqual([
      { ref: 'hero__title', text: 'Sharper title' },
      { ref: 'features', items: ['Alpha', 'Beta'] },
    ]);
  });

  it('accepts fills wrapped in a markdown code fence', async () => {
    const { provider } = fakeProvider(async () => ({ content: '```json\n' + VALID + '\n```' }));
    const outcome = await createAiDesignerRevisionWriter(configuredResolver(provider)).revise(INPUT);
    expect(outcome.ok).toBe(true);
  });

  it('retries once when a ref is not a resolved target, then accepts the correction', async () => {
    let call = 0;
    const { provider, calls } = fakeProvider(async () => {
      call += 1;
      if (call === 1) return { content: JSON.stringify({ revisions: [{ ref: 'hero__bogus', text: 'x' }] }) };
      return { content: JSON.stringify({ revisions: [{ ref: 'hero__intro', text: 'Rewritten intro' }] }) };
    });
    const outcome = await createAiDesignerRevisionWriter(configuredResolver(provider)).revise(INPUT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.fills).toEqual([{ ref: 'hero__intro', text: 'Rewritten intro' }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages[1]!.content).toContain('did not satisfy the output contract');
  });

  it('fails honestly when the model keeps returning invalid output', async () => {
    const { provider, calls } = fakeProvider(async () => ({ content: '{"revisions":[]}' }));
    const outcome = await createAiDesignerRevisionWriter(configuredResolver(provider)).revise(INPUT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('invalid_output');
    expect(calls).toHaveLength(DESIGNER_REVISION_WRITE_MAX_ATTEMPTS);
  });

  it('rejects a list revision that carries text instead of items', async () => {
    const { provider } = fakeProvider(async () => ({
      content: JSON.stringify({ revisions: [{ ref: 'features', text: 'not a list' }] }),
    }));
    const outcome = await createAiDesignerRevisionWriter(configuredResolver(provider)).revise(INPUT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('invalid_output');
  });

  it('reports not_configured without calling the model', async () => {
    const { provider, calls } = fakeProvider(async () => ({ content: VALID }));
    const outcome = await createAiDesignerRevisionWriter(async () => ({ provider, configured: false })).revise(INPUT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('not_configured');
    expect(calls).toHaveLength(0);
  });

  it('maps a transport failure to ai_error', async () => {
    const { provider } = fakeProvider(async () => {
      throw new Error('socket hang up');
    });
    const outcome = await createAiDesignerRevisionWriter(configuredResolver(provider)).revise(INPUT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('ai_error');
  });

  it('maps a resolution failure to ai_error', async () => {
    const { provider } = fakeProvider(async () => ({ content: VALID }));
    const outcome = await createAiDesignerRevisionWriter(async () => {
      throw new Error('no key');
    }).revise(INPUT);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('ai_error');
  });

  it('skips the AI entirely when there are no resolved targets', async () => {
    const { provider, calls } = fakeProvider(async () => ({ content: VALID }));
    const outcome = await createAiDesignerRevisionWriter(configuredResolver(provider)).revise({
      ...INPUT,
      targets: [],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('invalid_target');
    expect(calls).toHaveLength(0);
  });
});

describe('buildDesignerRevisionPrompt', () => {
  it('lists every resolved target with its current copy inside the untrusted block', () => {
    const { user } = buildDesignerRevisionPrompt({ ...INPUT, cosmosText: 'Cosmos facts' });
    expect(user).toContain('"hero__title"');
    expect(user).toContain('"hero__intro"');
    expect(user).toContain('"features"');
    expect(user).toContain('Old title');
    expect(user.indexOf('UNTRUSTED REFERENCE MATERIAL')).toBeLessThan(user.lastIndexOf('Old title'));
  });

  it('carries the immutable-target and anti-fabrication rules and omits projectId', () => {
    const { system, user } = buildDesignerRevisionPrompt(INPUT);
    expect(user).toContain('revise ONLY these references');
    expect(user).toContain('never fabricate statistics');
    expect(`${system}\n${user}`).not.toContain('p1');
  });

  it('places Cosmos context only inside the untrusted reference block', () => {
    const { user } = buildDesignerRevisionPrompt({ ...INPUT, cosmosText: 'UNIQUE_COSMOS_FACT' });
    expect(user).toContain('UNIQUE_COSMOS_FACT');
    expect(user.indexOf('UNTRUSTED REFERENCE MATERIAL')).toBeLessThan(user.indexOf('UNIQUE_COSMOS_FACT'));
  });
});
