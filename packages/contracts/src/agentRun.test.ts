import { describe, expect, it } from 'vitest';
import {
  AGENT_RUN_ERROR_MESSAGE_MAX_CHARS,
  isAgentRunId,
  isTerminalAgentRunStatus,
  isValidAgentRun,
  isValidAgentRunError,
  isValidAgentRunInput,
  isValidAgentRunStatus,
  type AgentRun,
  type AgentRunInput,
} from './agentRun.js';
import type { DesignerPlan, DesignerProposal } from './designer.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const CONTENT = '33333333-3333-4333-8333-333333333333';
const RUN_ID = 'ar_22222222-2222-4222-8222-222222222222';

const plan: DesignerPlan = {
  version: 1,
  steps: [{ kind: 'designer.review', criteria: ['document_valid'] }],
};

const proposal: DesignerProposal = {
  version: 1,
  baseRevision: 'rev1:abc',
  document: { version: 1, blocks: [{ type: 'paragraph' }] },
};

function baseRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: RUN_ID,
    kind: 'design',
    projectId: PROJECT,
    status: 'queued',
    input: { mode: 'plan', plan },
    result: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

describe('agent run id + status', () => {
  it('accepts only ar_<uuid> run ids', () => {
    expect(isAgentRunId(RUN_ID)).toBe(true);
    expect(isAgentRunId('wr_22222222-2222-4222-8222-222222222222')).toBe(false);
    expect(isAgentRunId('ar_not-a-uuid')).toBe(false);
    expect(isAgentRunId(null)).toBe(false);
  });

  it('validates the lifecycle vocabulary and terminal membership', () => {
    expect(isValidAgentRunStatus('queued')).toBe(true);
    expect(isValidAgentRunStatus('running')).toBe(true);
    expect(isValidAgentRunStatus('succeeded')).toBe(true);
    expect(isValidAgentRunStatus('failed')).toBe(true);
    expect(isValidAgentRunStatus('completed')).toBe(false);
    expect(isTerminalAgentRunStatus('succeeded')).toBe(true);
    expect(isTerminalAgentRunStatus('failed')).toBe(true);
    expect(isTerminalAgentRunStatus('running')).toBe(false);
  });
});

describe('agent run error', () => {
  it('accepts a bounded, code-shaped error', () => {
    expect(isValidAgentRunError({ code: 'planner_failed', message: 'boom', retryable: true })).toBe(true);
    expect(isValidAgentRunError({ code: 'x', message: 'no retryable' })).toBe(true);
  });

  it('rejects malformed codes, unbounded messages and unknown keys', () => {
    expect(isValidAgentRunError({ code: 'Not A Code', message: 'x' })).toBe(false);
    expect(isValidAgentRunError({ code: '', message: 'x' })).toBe(false);
    expect(isValidAgentRunError({ code: 'x', message: '' })).toBe(false);
    expect(
      isValidAgentRunError({ code: 'x', message: 'a'.repeat(AGENT_RUN_ERROR_MESSAGE_MAX_CHARS + 1) }),
    ).toBe(false);
    expect(isValidAgentRunError({ code: 'x', message: 'y', retryable: 'yes' })).toBe(false);
    expect(isValidAgentRunError({ code: 'x', message: 'y', extra: 1 })).toBe(false);
  });
});

describe('agent run input', () => {
  it('validates plan mode with an optional brief and base revision', () => {
    const input: AgentRunInput = { mode: 'plan', plan, brief: { goal: 'Design a page' }, baseRevision: 'rev1:abc' };
    expect(isValidAgentRunInput(input)).toBe(true);
    expect(isValidAgentRunInput({ mode: 'plan', plan, contentId: CONTENT })).toBe(true);
  });

  it('validates intent mode by reusing the Designer intent guard', () => {
    const input: AgentRunInput = {
      mode: 'intent',
      intent: { instruction: 'Make it punchier', projectId: PROJECT },
      baseRevision: 'rev1:abc',
    };
    expect(isValidAgentRunInput(input)).toBe(true);
    expect(
      isValidAgentRunInput({ mode: 'intent', intent: { instruction: 'x', projectId: CONTENT, contentId: CONTENT } }),
    ).toBe(true);
  });

  it('rejects invalid plans, unknown keys and unknown modes', () => {
    expect(isValidAgentRunInput({ mode: 'plan', plan: { version: 1, steps: [] } })).toBe(false);
    expect(isValidAgentRunInput({ mode: 'plan', plan, extra: true })).toBe(false);
    expect(isValidAgentRunInput({ mode: 'intent', intent: { instruction: 'x' } })).toBe(false);
    expect(isValidAgentRunInput({ mode: 'other' })).toBe(false);
    expect(isValidAgentRunInput(null)).toBe(false);
  });

  it('rejects a base revision combined with a content id', () => {
    expect(isValidAgentRunInput({ mode: 'plan', plan, contentId: CONTENT, baseRevision: 'rev1:abc' })).toBe(false);
    expect(
      isValidAgentRunInput({
        mode: 'intent',
        intent: { instruction: 'x', projectId: PROJECT, contentId: CONTENT },
        baseRevision: 'rev1:abc',
      }),
    ).toBe(false);
  });
});

describe('agent run envelope', () => {
  it('accepts a queued run with no result or error', () => {
    expect(isValidAgentRun(baseRun())).toBe(true);
  });

  it('accepts a succeeded run only with a valid persisted result', () => {
    expect(isValidAgentRun(baseRun({ status: 'succeeded', result: proposal }))).toBe(true);
    expect(isValidAgentRun(baseRun({ status: 'succeeded' }))).toBe(false);
  });

  it('accepts a failed run only with failure info', () => {
    expect(
      isValidAgentRun(baseRun({ status: 'failed', error: { code: 'ai_error', message: 'nope', retryable: false } })),
    ).toBe(true);
    expect(isValidAgentRun(baseRun({ status: 'failed' }))).toBe(false);
  });

  it('rejects unknown keys, bad status and bad project ids', () => {
    expect(isValidAgentRun({ ...baseRun(), extra: 1 })).toBe(false);
    expect(isValidAgentRun(baseRun({ status: 'completed' as never }))).toBe(false);
    expect(isValidAgentRun(baseRun({ projectId: 'not-uuid' }))).toBe(false);
    expect(isValidAgentRun(null)).toBe(false);
  });
});
