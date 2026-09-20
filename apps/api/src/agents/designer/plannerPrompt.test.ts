/**
 * Designer planner prompt tests (Stage 8E.6, Phase 3.2).
 *
 * The prompt is the only place model-visible policy lives, so these tests pin
 * the invariants: bounded/untrusted context is delimited, the output contract
 * only offers dispatchable step kinds, and internal identifiers never leak.
 */
import { describe, expect, it } from 'vitest';
import type { DesignerIntent } from '@seo/contracts';
import { buildDesignerPlannerPrompt } from './plannerPrompt.js';
import type { DesignerPlannerContext } from './plannerContext.js';

const INTENT: DesignerIntent = {
  projectId: '11111111-1111-4111-8111-111111111111',
  instruction: 'Rewrite the introduction to be more concrete',
  contentId: '33333333-3333-4333-8333-333333333333',
  brief: { goal: 'Improve clarity', format: 'article', topic: 'analytics' },
};

const CONTEXT: DesignerPlannerContext = {
  projectId: INTENT.projectId,
  cosmosText: 'Brand voice: plain, factual.',
  document: {
    contentId: INTENT.contentId!,
    title: 'Old title',
    targetKeyword: 'analytics',
    language: 'en',
    revision: 'rev1:abcdef0123456789',
    wordCount: 120,
    headings: [{ level: 2, text: 'Why analytics' }],
    blocks: [{ ref: 'b1', type: 'paragraph', text: 'Old intro copy' }],
  },
};

describe('buildDesignerPlannerPrompt', () => {
  const { system, user } = buildDesignerPlannerPrompt(INTENT, CONTEXT);

  it('delimits untrusted reference material', () => {
    expect(system).toContain('UNTRUSTED REFERENCE MATERIAL');
    expect(user).toContain('UNTRUSTED REFERENCE MATERIAL');
    expect(user).toContain('Brand voice: plain, factual.');
    expect(user).toContain('Old intro copy');
  });

  it('offers only dispatchable step kinds in the output contract', () => {
    expect(user).toContain('composer.structure');
    expect(user).toContain('writer.fillSlots');
    expect(user).toContain('writer.revise');
    expect(user).toContain('visual.apply');
    expect(user).toContain('designer.review');
  });

  it('constrains visual.apply to an open, server-resolved asset selection', () => {
    expect(user).toContain('"select": {}');
    expect(user).toContain('NEVER name an asset id, media id, filename, url or image block id');
    expect(user).toContain('Do not promise backgrounds, CSS, cropping, image generation or uploads');
  });

  it('never exposes the project id or internal revision machinery to the prompt', () => {
    expect(user).not.toContain(INTENT.projectId);
    expect(system).not.toContain(INTENT.projectId);
  });

  it('carries the intent instruction and brief into the user message', () => {
    expect(user).toContain(INTENT.instruction);
    expect(user).toContain('Improve clarity');
    expect(user).toContain('analytics');
  });
});
