/**
 * Writer advanced agent core tests (W10.4).
 *
 * These prove the W10.4 coordinator boundary in isolation: the fixed action /
 * goal / status vocabulary and hard bounds, the strict start-request and
 * AI-decision schemas (deny by default), and the single deterministic gate
 * `validateWriterAgentDecision` that decides whether an AI proposal is allowed.
 * They also prove the persisted agent snapshot fails closed on unknown fields,
 * oversize step arrays, mismatched counters and inconsistent idle state.
 */
import { describe, expect, it } from 'vitest';
import {
  agentResumeFromState,
  emptyWriterAgent,
  finalizeWriterAgent,
  initialWriterAgent,
  NO_AGENT_DEPENDENCIES,
  parseWriterAgentRequest,
  recordWriterAgentStep,
  validateWriterAgentDecision,
  WRITER_AGENT_ACTION_BUDGET,
  WRITER_AGENT_ACTIONS,
  WRITER_AGENT_ACTIONS_REGISTRY,
  WRITER_AGENT_DEFAULT_STEPS,
  WRITER_AGENT_GOALS,
  WRITER_AGENT_MAX_INSTRUCTION_CHARS,
  WRITER_AGENT_MAX_STEPS,
  WRITER_AGENT_STATUSES,
  WRITER_AGENT_STEP_STATUSES,
} from './agent.js';
import { writerAgentSchema } from './snapshot.js';
import type { WriterPlan } from './state.js';

const NOW = '2026-02-01T00:00:00.000Z';

const PLAN: WriterPlan = {
  title: 'On-page SEO',
  metaDescription: null,
  introductionPurpose: 'Frame the controls.',
  sections: [
    { heading: 'Controls', keyPoints: ['copy'], suggestedKeywords: ['seo'] },
    { heading: 'Links', keyPoints: ['authority'], suggestedKeywords: [] },
    { heading: 'Metadata', keyPoints: ['titles'], suggestedKeywords: [] },
  ],
};

function runningAgent(maxSteps = WRITER_AGENT_MAX_STEPS) {
  return initialWriterAgent({ goal: 'improve_clarity', maxSteps, instruction: null, sections: [] }, NOW);
}

describe('writer agent vocabulary + bounds (W10.4)', () => {
  it('keeps the canonical action / goal / status vocabulary and hard bounds', () => {
    expect(WRITER_AGENT_ACTIONS).toEqual(['research', 'intelligence', 'magic', 'revision', 'review', 'finish']);
    expect(WRITER_AGENT_GOALS).toEqual([
      'improve_evidence',
      'improve_seo',
      'improve_clarity',
      'deep_research',
      'section_improvement',
    ]);
    expect(WRITER_AGENT_STATUSES).toEqual([
      'idle',
      'running',
      'awaiting_approval',
      'completed',
      'limit_reached',
      'failed',
    ]);
    expect(WRITER_AGENT_STEP_STATUSES).toEqual(['planned', 'running', 'completed', 'failed']);
    expect(WRITER_AGENT_MAX_STEPS).toBe(5);
    expect(WRITER_AGENT_DEFAULT_STEPS).toBe(5);
    expect(WRITER_AGENT_ACTION_BUDGET).toBe(2);
    expect(WRITER_AGENT_MAX_INSTRUCTION_CHARS).toBe(500);
  });

  it('caps every non-terminal action and leaves finish unbudgeted', () => {
    expect(WRITER_AGENT_ACTIONS_REGISTRY.research.maxCalls).toBe(WRITER_AGENT_ACTION_BUDGET);
    expect(WRITER_AGENT_ACTIONS_REGISTRY.intelligence.maxCalls).toBe(WRITER_AGENT_ACTION_BUDGET);
    expect(WRITER_AGENT_ACTIONS_REGISTRY.magic.maxCalls).toBe(WRITER_AGENT_ACTION_BUDGET);
    expect(WRITER_AGENT_ACTIONS_REGISTRY.revision.maxCalls).toBe(WRITER_AGENT_ACTION_BUDGET);
    expect(WRITER_AGENT_ACTIONS_REGISTRY.review.maxCalls).toBe(WRITER_AGENT_ACTION_BUDGET);
    expect(WRITER_AGENT_ACTIONS_REGISTRY.finish.maxCalls).toBe(0);
    expect(WRITER_AGENT_ACTIONS_REGISTRY.magic.mutatesContent).toBe(true);
    expect(WRITER_AGENT_ACTIONS_REGISTRY.research.mutatesContent).toBe(false);
  });

  it('starts idle with no steps or timestamps (never fabricated progress)', () => {
    const agent = emptyWriterAgent();
    expect(agent.status).toBe('idle');
    expect(agent.steps).toEqual([]);
    expect(agent.stepCount).toBe(0);
    expect(agent.startedAt).toBeNull();
    expect(agent.finishedAt).toBeNull();
    expect(agent.actionCounts).toEqual({ research: 0, intelligence: 0, magic: 0, revision: 0, review: 0, finish: 0 });
  });
});

describe('initialWriterAgent / recordWriterAgentStep', () => {
  it('clamps the step budget to the hard server maximum', () => {
    expect(initialWriterAgent({ goal: 'deep_research', maxSteps: 99, instruction: null, sections: [] }, NOW).maxSteps).toBe(
      WRITER_AGENT_MAX_STEPS,
    );
    expect(initialWriterAgent({ goal: 'deep_research', maxSteps: 0, instruction: null, sections: [] }, NOW).maxSteps).toBe(1);
  });

  it('caps preferred sections and counts only completed steps', () => {
    const agent = initialWriterAgent(
      { goal: 'section_improvement', maxSteps: 3, instruction: 'tighten', sections: ['section_0', 'section_1', 'section_2', 'section_0'] },
      NOW,
    );
    expect(agent.preferredSections).toEqual(['section_0', 'section_1', 'section_2']);

    let next = recordWriterAgentStep(agent, 'research', 'completed', 'found sources');
    next = recordWriterAgentStep(next, 'revision', 'failed', 'writer error');
    expect(next.stepCount).toBe(2);
    expect(next.actionCounts.research).toBe(1);
    expect(next.actionCounts.revision).toBe(0);
    expect(next.steps.map((s) => s.index)).toEqual([0, 1]);
    expect(next.steps[0].summary).toBe('found sources');
  });

  it('hard-caps the stored step array at the global step maximum', () => {
    let agent = initialWriterAgent({ goal: 'improve_seo', maxSteps: WRITER_AGENT_MAX_STEPS, instruction: null, sections: [] }, NOW);
    for (let i = 0; i < WRITER_AGENT_MAX_STEPS + 2; i += 1) {
      agent = recordWriterAgentStep(agent, 'review', 'completed', `step ${i}`);
    }
    expect(agent.steps).toHaveLength(WRITER_AGENT_MAX_STEPS);
    expect(agent.stepCount).toBe(WRITER_AGENT_MAX_STEPS);
  });
});

describe('parseWriterAgentRequest', () => {
  it('accepts a bounded goal and reports the server default budget', () => {
    const parsed = parseWriterAgentRequest({ goal: 'improve_seo' });
    expect(parsed).toEqual({
      ok: true,
      request: { goal: 'improve_seo', maxSteps: WRITER_AGENT_DEFAULT_STEPS, instruction: null, sections: [] },
    });
  });

  it('rejects unknown fields (strict: no workflow-control smuggling)', () => {
    expect(parseWriterAgentRequest({ goal: 'improve_seo', tools: ['publish'] }).ok).toBe(false);
    expect(parseWriterAgentRequest({ goal: 'improve_seo', auto_apply: true }).ok).toBe(false);
  });

  it('rejects an unknown goal, an out-of-range step budget and over-long instruction', () => {
    expect(parseWriterAgentRequest({ goal: 'do_everything' }).ok).toBe(false);
    expect(parseWriterAgentRequest({ goal: 'improve_seo', max_steps: 6 }).ok).toBe(false);
    expect(parseWriterAgentRequest({ goal: 'improve_seo', max_steps: 0 }).ok).toBe(false);
    expect(
      parseWriterAgentRequest({ goal: 'improve_seo', instruction: 'x'.repeat(WRITER_AGENT_MAX_INSTRUCTION_CHARS + 1) }).ok,
    ).toBe(false);
  });

  it('rejects duplicate section ids and non-plan section ids', () => {
    expect(parseWriterAgentRequest({ goal: 'section_improvement', sections: ['section_0', 'section_0'] }).ok).toBe(false);
    expect(parseWriterAgentRequest({ goal: 'section_improvement', sections: ['nope'] }).ok).toBe(false);
  });
});

describe('validateWriterAgentDecision (deny by default)', () => {
  it('accepts a read action on a review_ready run with an approved plan', () => {
    const result = validateWriterAgentDecision({
      raw: { action: 'research', reason: 'gather more sources' },
      agent: runningAgent(),
      plan: PLAN,
      runStatus: 'review_ready',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decision.action).toBe('research');
  });

  it('rejects an unknown action as invalid_action (no fallback)', () => {
    const result = validateWriterAgentDecision({
      raw: { action: 'publish', reason: 'ship it' },
      agent: runningAgent(),
      plan: PLAN,
      runStatus: 'review_ready',
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid_action' });
  });

  it('rejects extra fields smuggled into the decision schema', () => {
    const result = validateWriterAgentDecision({
      raw: { action: 'research', reason: 'x', maxSteps: 99 },
      agent: runningAgent(),
      plan: PLAN,
      runStatus: 'review_ready',
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid_action' });
  });

  it('allows finish unconditionally but refuses other actions off review_ready', () => {
    expect(
      validateWriterAgentDecision({ raw: { action: 'finish', reason: 'done' }, agent: runningAgent(), plan: PLAN, runStatus: 'writing' }).ok,
    ).toBe(true);
    expect(
      validateWriterAgentDecision({ raw: { action: 'research', reason: 'x' }, agent: runningAgent(), plan: PLAN, runStatus: 'writing' }),
    ).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(
      validateWriterAgentDecision({ raw: { action: 'research', reason: 'x' }, agent: runningAgent(), plan: null, runStatus: 'review_ready' }),
    ).toMatchObject({ ok: false, code: 'not_allowed' });
  });

  it('enforces the per-action budget', () => {
    const agent = runningAgent();
    agent.actionCounts.research = WRITER_AGENT_ACTION_BUDGET;
    expect(
      validateWriterAgentDecision({ raw: { action: 'research', reason: 'more' }, agent, plan: PLAN, runStatus: 'review_ready' }),
    ).toMatchObject({ ok: false, code: 'budget_exhausted' });
  });

  it('requires approved-plan sections for magic / revision and rejects unknown sections', () => {
    expect(
      validateWriterAgentDecision({ raw: { action: 'magic', reason: 'polish' }, agent: runningAgent(), plan: PLAN, runStatus: 'review_ready' }),
    ).toMatchObject({ ok: false, code: 'invalid_section' });
    expect(
      validateWriterAgentDecision({
        raw: { action: 'revision', reason: 'tighten', sections: ['section_9'] },
        agent: runningAgent(),
        plan: PLAN,
        runStatus: 'review_ready',
      }),
    ).toMatchObject({ ok: false, code: 'invalid_section' });
  });

  it('validates and normalizes selected sections against the approved plan', () => {
    const result = validateWriterAgentDecision({
      raw: { action: 'revision', reason: 'tighten', sections: ['section_2', 'section_0'] },
      agent: runningAgent(),
      plan: PLAN,
      runStatus: 'review_ready',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decision.sections).toEqual(['section_0', 'section_2']);
  });
});

describe('agentResumeFromState + NO_AGENT_DEPENDENCIES', () => {
  it('re-issues the exact bounded intent for recovery', () => {
    const agent = initialWriterAgent(
      { goal: 'deep_research', maxSteps: 3, instruction: 'be precise', sections: ['section_1'] },
      NOW,
    );
    expect(agentResumeFromState(agent)).toEqual({
      action: 'agent',
      goal: 'deep_research',
      maxSteps: 3,
      instruction: 'be precise',
      sections: ['section_1'],
    });
  });

  it('denies by default by proposing finish', async () => {
    await expect(NO_AGENT_DEPENDENCIES.decide({} as never)).resolves.toEqual({
      action: 'finish',
      reason: 'No agent coordinator is wired for this run.',
    });
  });
});

describe('persisted agent snapshot fails closed', () => {
  it('rejects a valid running agent round-tripped through finalize + steps', () => {
    let agent = runningAgent(3);
    agent = recordWriterAgentStep(agent, 'research', 'completed', 'sources');
    agent = finalizeWriterAgent(agent, 'completed', 'Chose finish.', NOW);
    expect(writerAgentSchema.safeParse(agent).success).toBe(true);
  });

  it('rejects unknown fields, mismatched counters and bad step indices', () => {
    const base = finalizeWriterAgent(recordWriterAgentStep(runningAgent(3), 'research', 'completed', 's'), 'completed', null, NOW);
    expect(writerAgentSchema.safeParse({ ...base, prompt: 'chain of thought' }).success).toBe(false);
    expect(writerAgentSchema.safeParse({ ...base, actionCounts: { ...base.actionCounts, research: 0 } }).success).toBe(false);
    expect(writerAgentSchema.safeParse({ ...base, stepCount: 0 }).success).toBe(false);
    expect(
      writerAgentSchema.safeParse({ ...base, steps: [{ index: 4, action: 'research', status: 'completed', summary: null }] }).success,
    ).toBe(false);
  });

  it('rejects an idle agent that claims steps or a start timestamp', () => {
    const idle = emptyWriterAgent();
    expect(writerAgentSchema.safeParse({ ...idle, startedAt: NOW }).success).toBe(false);
    expect(
      writerAgentSchema.safeParse({ ...idle, steps: [{ index: 0, action: 'finish', status: 'completed', summary: null }], stepCount: 1 }).success,
    ).toBe(false);
  });
});
