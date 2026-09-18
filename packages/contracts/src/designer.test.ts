import { describe, expect, it } from 'vitest';
import {
  CONTENT_REVISION_PREFIX,
  DESIGN_BRIEF_GOAL_MAX_CHARS,
  DESIGNER_INTENT_MAX_METADATA_KEYS,
  DESIGNER_MAX_STEPS,
  contentRevisionOf,
  isValidAgentResult,
  isValidDesignBrief,
  isValidDesignerIntent,
  isValidDesignerPlan,
  isValidDesignerProposal,
  isValidDesignerReview,
  isValidDesignerStep,
} from './designer.js';
import { MARKETING_STORYBOARD_PLAN } from './compositionPlanFixtures.js';
import { compileComposition } from './compositionPlan.js';

const compiled = compileComposition(MARKETING_STORYBOARD_PLAN);

const validBrief = {
  goal: 'Create a landing page for our SEO tool',
  format: 'landing_page',
  audience: 'growth teams',
  topic: 'keyword research',
  constraints: ['no fabricated metrics', 'British spelling'],
};

const validPlan = {
  version: 1,
  brief: validBrief,
  steps: [
    { kind: 'composer.structure', task: { format: 'landing_page' } },
    { kind: 'writer.fillSlots', task: { slots: ['hero.title', 'hero.intro'] } },
    { kind: 'writer.freeText', task: { instruction: 'Write a short value proposition.' } },
    { kind: 'designer.review', criteria: ['document_valid', 'structure_preserved', 'seo'] },
  ],
};

const validProposal = {
  version: 1,
  baseRevision: contentRevisionOf(compiled.document),
  document: compiled.document,
  plan: validPlan,
  review: { ok: true, errors: [], warnings: [], score: 82 },
};

describe('isValidDesignBrief', () => {
  it('accepts a bounded brief', () => {
    expect(isValidDesignBrief(validBrief)).toBe(true);
    expect(isValidDesignBrief({ goal: 'Just a goal' })).toBe(true);
  });

  it('rejects an empty or over-long goal', () => {
    expect(isValidDesignBrief({ goal: '   ' })).toBe(false);
    expect(isValidDesignBrief({ goal: 'x'.repeat(DESIGN_BRIEF_GOAL_MAX_CHARS + 1) })).toBe(false);
  });

  it('rejects an unknown format enum', () => {
    expect(isValidDesignBrief({ goal: 'Goal', format: 'email' })).toBe(false);
  });

  it('rejects unknown keys and malformed constraints', () => {
    expect(isValidDesignBrief({ goal: 'Goal', tone: 'friendly' })).toBe(false);
    expect(isValidDesignBrief({ goal: 'Goal', constraints: ['ok', ''] })).toBe(false);
    expect(isValidDesignBrief({ goal: 'Goal', constraints: 'not-an-array' })).toBe(false);
  });
});

describe('isValidDesignerStep', () => {
  it('accepts every bounded step kind', () => {
    for (const step of validPlan.steps) expect(isValidDesignerStep(step)).toBe(true);
  });

  it('rejects an unknown step kind', () => {
    expect(isValidDesignerStep({ kind: 'writer.doAnything', task: {} })).toBe(false);
  });

  it('rejects a step that smuggles an untyped tool call', () => {
    expect(isValidDesignerStep({ kind: 'writer.freeText', task: { instruction: 'Write', tool: 'search' } })).toBe(false);
    expect(isValidDesignerStep({ kind: 'writer.freeText', instruction: 'Write' })).toBe(false);
  });

  it('validates each payload shape', () => {
    expect(isValidDesignerStep({ kind: 'composer.structure', task: { format: 'article' } })).toBe(true);
    expect(isValidDesignerStep({ kind: 'composer.structure', task: { format: 'podcast' } })).toBe(false);
    expect(isValidDesignerStep({ kind: 'writer.fillSlots', task: { slots: ['hero.title'] } })).toBe(true);
    expect(isValidDesignerStep({ kind: 'writer.fillSlots', task: { slots: ['not a slot'] } })).toBe(false);
    expect(isValidDesignerStep({ kind: 'designer.review', criteria: ['document_valid'] })).toBe(true);
    expect(isValidDesignerStep({ kind: 'designer.review', criteria: [] })).toBe(false);
    expect(isValidDesignerStep({ kind: 'designer.review', criteria: ['document_valid', 'document_valid'] })).toBe(false);
  });
});

describe('isValidDesignerPlan', () => {
  it('accepts a bounded plan', () => {
    expect(isValidDesignerPlan(validPlan)).toBe(true);
    expect(isValidDesignerPlan({ version: 1, steps: [{ kind: 'designer.review', criteria: ['seo'] }] })).toBe(true);
  });

  it('rejects a wrong version, empty steps or unknown keys', () => {
    expect(isValidDesignerPlan({ version: 2, steps: validPlan.steps })).toBe(false);
    expect(isValidDesignerPlan({ version: 1, steps: [] })).toBe(false);
    expect(isValidDesignerPlan({ version: 1, steps: validPlan.steps, runtime: {} })).toBe(false);
  });

  it('rejects an over-long or malformed step list', () => {
    const tooMany = Array.from({ length: DESIGNER_MAX_STEPS + 1 }, () => ({
      kind: 'designer.review',
      criteria: ['seo'],
    }));
    expect(isValidDesignerPlan({ version: 1, steps: tooMany })).toBe(false);
    expect(isValidDesignerPlan({ version: 1, steps: [{ kind: 'writer.freeText', task: { instruction: '' } }] })).toBe(false);
  });
});

describe('isValidAgentResult', () => {
  it('accepts a composer result with its slot map', () => {
    expect(isValidAgentResult({ role: 'composer', document: compiled.document, slots: compiled.slots })).toBe(true);
  });

  it('accepts a writer result with filled and unfilled slots', () => {
    expect(
      isValidAgentResult({
        role: 'writer',
        document: compiled.document,
        filled: ['hero.title'],
        unfilled: ['hero.media'],
      }),
    ).toBe(true);
  });

  it('rejects a bad role or a non-canonical document', () => {
    expect(isValidAgentResult({ role: 'designer', document: compiled.document })).toBe(false);
    expect(isValidAgentResult({ role: 'writer', document: { version: 1, blocks: 'nope' } })).toBe(false);
  });

  it('rejects unknown keys and a malformed slot map', () => {
    expect(isValidAgentResult({ role: 'writer', document: compiled.document, notes: 'hi' })).toBe(false);
    expect(
      isValidAgentResult({ role: 'composer', document: compiled.document, slots: { slots: [{ slot: 'x' }] } }),
    ).toBe(false);
  });
});

describe('isValidDesignerReview', () => {
  it('accepts a deterministic review', () => {
    expect(isValidDesignerReview({ ok: false, errors: [{ code: 'stale', message: 'Revision changed', step: 1 }], warnings: [] })).toBe(true);
    expect(isValidDesignerReview({ ok: true, errors: [], warnings: [], score: 0 })).toBe(true);
  });

  it('rejects malformed issues and scores', () => {
    expect(isValidDesignerReview({ ok: true, errors: [{ code: '', message: 'x' }], warnings: [] })).toBe(false);
    expect(isValidDesignerReview({ ok: 'yes', errors: [], warnings: [] })).toBe(false);
    expect(isValidDesignerReview({ ok: true, errors: [], warnings: [], score: Number.NaN })).toBe(false);
  });
});

describe('isValidDesignerProposal', () => {
  it('accepts a complete proposal', () => {
    expect(isValidDesignerProposal(validProposal)).toBe(true);
  });

  it('accepts a minimal proposal without plan or review', () => {
    expect(isValidDesignerProposal({ version: 1, baseRevision: 'rev1:abc', document: compiled.document })).toBe(true);
  });

  it('rejects a missing or empty baseRevision', () => {
    expect(isValidDesignerProposal({ version: 1, document: compiled.document })).toBe(false);
    expect(isValidDesignerProposal({ version: 1, baseRevision: '  ', document: compiled.document })).toBe(false);
  });

  it('rejects an invalid document, plan or review', () => {
    expect(isValidDesignerProposal({ version: 1, baseRevision: 'rev1:abc', document: { version: 9, blocks: [] } })).toBe(false);
    expect(
      isValidDesignerProposal({ version: 1, baseRevision: 'rev1:abc', document: compiled.document, plan: { version: 1, steps: [] } }),
    ).toBe(false);
    expect(
      isValidDesignerProposal({ version: 1, baseRevision: 'rev1:abc', document: compiled.document, review: { ok: 'nope' } }),
    ).toBe(false);
  });
});

describe('contentRevisionOf', () => {
  it('is stable across object key order', () => {
    const a = { title: 'Title', blocks: [{ type: 'paragraph', attrs: { level: 1 } }] };
    const b = { blocks: [{ attrs: { level: 1 }, type: 'paragraph' }], title: 'Title' };
    expect(contentRevisionOf(a)).toBe(contentRevisionOf(b));
  });

  it('changes when content changes and respects array order', () => {
    expect(contentRevisionOf({ a: 1 })).not.toBe(contentRevisionOf({ a: 2 }));
    expect(contentRevisionOf([1, 2])).not.toBe(contentRevisionOf([2, 1]));
  });

  it('carries the revision scheme prefix', () => {
    expect(contentRevisionOf({})).toMatch(new RegExp(`^${CONTENT_REVISION_PREFIX}:[0-9a-f]{16}$`));
  });
});

describe('isValidDesignerIntent', () => {
  const projectId = '11111111-1111-4111-8111-111111111111';
  const contentId = '22222222-2222-4222-8222-222222222222';

  it('accepts a minimal intent', () => {
    expect(isValidDesignerIntent({ instruction: 'Write a landing page', projectId })).toBe(true);
  });

  it('accepts a full intent with brief and context', () => {
    expect(
      isValidDesignerIntent({
        instruction: 'Write a landing page',
        projectId,
        contentId,
        brief: validBrief,
        context: { selection: { from: 1, to: 4 }, metadata: { tone: 'confident' } },
      }),
    ).toBe(true);
  });

  it('rejects missing or empty required fields', () => {
    expect(isValidDesignerIntent({ projectId })).toBe(false);
    expect(isValidDesignerIntent({ instruction: 'Write', projectId: '' })).toBe(false);
    expect(isValidDesignerIntent({ instruction: '   ', projectId })).toBe(false);
    expect(isValidDesignerIntent({ instruction: 42, projectId })).toBe(false);
  });

  it('rejects non-uuid identity fields', () => {
    expect(isValidDesignerIntent({ instruction: 'Write', projectId: 'p1' })).toBe(false);
    expect(isValidDesignerIntent({ instruction: 'Write', projectId, contentId: 'nope' })).toBe(false);
  });

  it('rejects unknown keys and malformed context', () => {
    expect(isValidDesignerIntent({ instruction: 'Write', projectId, plan: {} })).toBe(false);
    expect(isValidDesignerIntent({ instruction: 'Write', projectId, context: { tool: 'search' } })).toBe(false);
    expect(
      isValidDesignerIntent({
        instruction: 'Write',
        projectId,
        context: { metadata: Object.fromEntries(Array.from({ length: DESIGNER_INTENT_MAX_METADATA_KEYS + 1 }, (_, i) => [`k${i}`, i])) },
      }),
    ).toBe(false);
  });
});
