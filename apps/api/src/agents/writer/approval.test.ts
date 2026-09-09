/**
 * Writer Agent W3/W4/W5/W8 approval + session-resume tests.
 *
 * A proposed plan pauses the graph at the awaitApproval interrupt
 * (awaiting_approval / approval "pending"); only an explicit, strictly
 * validated approve/reject decision - delivered through resumeWriterRun on
 * the exact same thread/checkpoint - moves the run on. Since W4, an approve
 * continues the same run into the writing phase (approval is the hard gate
 * before any writing) and, since W5, through the deterministic review into a
 * resting `review_ready` state at the W8 review-session interrupt: with a wired
 * section writer the run carries one written section per approved plan section
 * plus the canonical WriterReview artifact, and only an explicit session accept
 * (resumeWriterSession) reaches the terminal `completed`. These tests pin the
 * vocabulary validation, the deny-by-default resume rules (bad decision, unknown
 * run, wrong lifecycle state, cross-run isolation), the no-replanning guarantee
 * (resume never calls the planner or the context adapters again) and the
 * restart honesty of the in-memory run registry (a registry without the run
 * fails with writer_run_not_found instead of silently re-running from START).
 */

import { describe, expect, it } from 'vitest';
import { Command } from '@langchain/langgraph';
import { ApiError } from '../../apiErrors.js';
import {
  WRITER_MAX_APPROVAL_REASON_CHARS,
  isWriterApprovalDecision,
  parseWriterApprovalDecision,
} from './approval.js';
import {
  createWriterRunId,
  createWriterRunRegistry,
  createWriterGraph,
  isWriterRunId,
  resumeWriterRun,
  resumeWriterSession,
  runWriterOnce,
  type WriterRunId,
  type WriterPlan,
  type WriterRunRequest,
} from './index.js';
import type { WriterPlanInput, WriterPlannerDependencies, WriterPlanOutcome } from './planner.js';
import type { WriterSectionDependencies, WriterSectionInput } from './sectionWriter.js';
import type { WriterContextDependencies, WriterKnowledgeResult } from './context.js';

const projectId = 'c00162dd-d23e-4904-85ca-76cccc6d8c90';
const topic = 'SEO content ops with LangGraph';

const AVAILABLE_KNOWLEDGE: WriterKnowledgeResult = {
  status: 'available',
  note: null,
  chunks: [{ sourceId: 'k1', title: 'LangGraph guide', text: 'Knowledge chunk about orchestration.' }],
};

function planFixture(title = 'Running SEO content ops on LangGraph'): WriterPlan {
  return {
    title,
    metaDescription: 'How to orchestrate SEO content operations with LangGraph.',
    introductionPurpose: 'Frame why teams automate content operations and what this guide covers.',
    sections: [{ heading: 'Why LangGraph', keyPoints: ['orchestration fits content ops'], suggestedKeywords: [] }],
  };
}

const okPlanner = (plan: WriterPlan = planFixture()): WriterPlannerDependencies => ({
  plan: async () => ({ ok: true, plan }),
});

function recordingPlanner(respond: (input: WriterPlanInput) => WriterPlanOutcome): {
  deps: WriterPlannerDependencies;
  inputs: WriterPlanInput[];
} {
  const inputs: WriterPlanInput[] = [];
  return {
    inputs,
    deps: {
      async plan(input: WriterPlanInput): Promise<WriterPlanOutcome> {
        inputs.push(input);
        return respond(input);
      },
    },
  };
}

function recordingContext(knowledge: WriterKnowledgeResult): {
  deps: WriterContextDependencies;
  tally: { count: number };
} {
  const tally = { count: 0 };
  return {
    tally,
    deps: {
      getKnowledge: async () => {
        tally.count += 1;
        return knowledge;
      },
      getExistingContent: async () => ({ status: 'not_configured' as const, note: null, items: [] }),
      getIntelligence: async () => ({ status: 'not_configured' as const, note: null, keywords: [] }),
    },
  };
}

/** A recording section writer that returns valid content per approved section,
 *  so an approve resume can run through the whole writing phase. */
function okSectionWriter(): { deps: WriterSectionDependencies; calls: WriterSectionInput[] } {
  const calls: WriterSectionInput[] = [];
  return {
    calls,
    deps: {
      async writeSection(input: WriterSectionInput) {
        calls.push(input);
        return { ok: true, content: `Body content for ${input.section.heading}.` };
      },
    },
  };
}

function startRequest(runId?: WriterRunId): WriterRunRequest {
  return { runId, projectId, requestId: 'req-approval', topic };
}

async function expectApiError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  try {
    await promise;
    expect.fail(`expected ApiError ${status}/${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(status);
    expect((err as ApiError).code).toBe(code);
  }
}

describe('writer approval decision validation', () => {
  it('accepts exactly the approve and reject vocabulary', () => {
    expect(parseWriterApprovalDecision({ decision: 'approve' })).toEqual({
      ok: true,
      decision: { decision: 'approve' },
    });
    expect(parseWriterApprovalDecision({ decision: 'reject' })).toEqual({
      ok: true,
      decision: { decision: 'reject' },
    });
    expect(parseWriterApprovalDecision({ decision: 'reject', reason: '  keep it aligned with the pillar  ' })).toEqual({
      ok: true,
      decision: { decision: 'reject', reason: 'keep it aligned with the pillar' },
    });
    expect(parseWriterApprovalDecision({ decision: 'reject', reason: '   ' }).ok).toBe(true);
    expect(isWriterApprovalDecision({ decision: 'approve' })).toBe(true);
  });

  it('rejects anything outside the decision vocabulary', () => {
    const invalid = [
      {},
      { decision: 'continue' },
      { decision: 'approve', reason: 'nope' },
      { decision: 'reject', reason: 42 },
      { decision: 'reject', reason: 'x'.repeat(WRITER_MAX_APPROVAL_REASON_CHARS + 1) },
      { decision: 'reject', extra: 'x' },
      true,
      null,
      'approve',
    ];
    for (const value of invalid) {
      const parsed = parseWriterApprovalDecision(value);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? '' : parsed.note).toContain('exactly');
      expect(isWriterApprovalDecision(value)).toBe(false);
    }
  });
});

describe('writer resume happy paths', () => {
  it('approves a paused run on the same thread and writes the approved sections', async () => {
    const registry = createWriterRunRegistry();
    const writer = okSectionWriter();
    const run = await runWriterOnce(
      startRequest(),
      { context: recordingContext(AVAILABLE_KNOWLEDGE).deps, planner: okPlanner(), sectionWriter: writer.deps },
      registry,
    );

    expect(run.status).toBe('awaiting_approval');
    expect(run.approval).toBe('pending');
    expect(run.approvalReason).toBeNull();
    expect(registry.has(run.runId)).toBe(true);

    const resumed = await resumeWriterRun({ runId: run.runId, decision: { decision: 'approve' } }, registry);

    expect(resumed.runId).toBe(run.runId);
    expect(resumed.status).toBe('review_ready');
    expect(resumed.reviewStatus).toBe('completed');
    expect(resumed.approval).toBe('approved');
    expect(resumed.approvalReason).toBeNull();
    expect(resumed.plan?.title).toBe(planFixture().title);
    expect(resumed.writtenSections).toHaveLength(1);
    expect(resumed.writtenSections[0].sectionId).toBe('section_0');
    expect(resumed.writtenSections[0].content).toContain('Why LangGraph');
    expect(writer.calls).toHaveLength(1);
    expect(resumed.context.knowledge.status).toBe('available');
    expect(resumed.context.knowledge.chunks[0].sourceId).toBe('k1');
    expect(resumed.projectId).toBe(projectId);
    expect(resumed.topic).toBe(topic);

    // W8: the review session is the only way to finish; an explicit accept
    // moves the resting review_ready run to the terminal completed state.
    const completed = await resumeWriterSession({ runId: resumed.runId, decision: { action: 'accept' } }, registry);
    expect(completed.status).toBe('completed');
    expect(completed.reviewStatus).toBe('completed');
  });

  it('rejects a paused run and stores the bounded optional reason', async () => {
    const registry = createWriterRunRegistry();
    const run = await runWriterOnce(startRequest(), { planner: okPlanner() }, registry);

    const resumed = await resumeWriterRun(
      { runId: run.runId, decision: { decision: 'reject', reason: 'Conflicts with our pillar page' } },
      registry,
    );

    expect(resumed.status).toBe('rejected');
    expect(resumed.approval).toBe('rejected');
    expect(resumed.approvalReason).toBe('Conflicts with our pillar page');
    expect(resumed.plan?.title).toBe(planFixture().title);
  });

  it('an explicit runId is kept and resumes on that exact thread', async () => {
    const registry = createWriterRunRegistry();
    const runId = createWriterRunId();
    const run = await runWriterOnce(
      startRequest(runId),
      { planner: okPlanner(), sectionWriter: okSectionWriter().deps },
      registry,
    );

    expect(run.runId).toBe(runId);
    const resumed = await resumeWriterRun({ runId, decision: { decision: 'approve' } }, registry);
    expect(resumed.runId).toBe(runId);
    expect(resumed.status).toBe('review_ready');
  });

  it('the graph pauses with a bounded, human-readable interrupt request', async () => {
    const runId = createWriterRunId();
    const graph = createWriterGraph({ planner: okPlanner() });
    const paused = await graph.invoke(
      { projectId, requestId: 'req-interrupt', topic },
      { configurable: { thread_id: runId } },
    );

    const interrupts = (paused as unknown as { __interrupt__?: Array<{ value: unknown }> }).__interrupt__;
    expect(interrupts).toBeDefined();
    expect(interrupts).toHaveLength(1);
    expect(interrupts?.[0].value).toMatchObject({
      request: 'Approve or reject the proposed article plan before any writing starts.',
      runId,
      status: 'awaiting_approval',
      planTitle: planFixture().title,
    });
  });
});

describe('writer resume deny-by-default', () => {
  it('rejects an invalid runId before touching the registry', async () => {
    await expectApiError(
      resumeWriterRun({ runId: 'not-a-run' as never, decision: { decision: 'approve' } }),
      400,
      'bad_request',
    );
  });

  it('rejects a malformed approval decision with invalid_approval_decision', async () => {
    const registry = createWriterRunRegistry();
    const run = await runWriterOnce(startRequest(), { planner: okPlanner() }, registry);
    await expectApiError(
      resumeWriterRun({ runId: run.runId, decision: { decision: 'continue' } as never }, registry),
      400,
      'invalid_approval_decision',
    );
    await expectApiError(
      resumeWriterRun(
        { runId: run.runId, decision: { decision: 'approve', reason: 'not allowed' } as never },
        registry,
      ),
      400,
      'invalid_approval_decision',
    );
    expect(registry.get(run.runId)).toBeDefined();
  });

  it('fails an unknown runId with writer_run_not_found', async () => {
    const registry = createWriterRunRegistry();
    await expectApiError(
      resumeWriterRun({ runId: createWriterRunId(), decision: { decision: 'approve' } }, registry),
      404,
      'writer_run_not_found',
    );
  });

  it('a registry without the run (restart) fails honestly instead of restarting from START', async () => {
    const started = createWriterRunRegistry();
    const restarted = createWriterRunRegistry();
    const run = await runWriterOnce(startRequest(), { planner: okPlanner() }, started);

    await expectApiError(
      resumeWriterRun({ runId: run.runId, decision: { decision: 'approve' } }, restarted),
      404,
      'writer_run_not_found',
    );
  });

  it('refuses a second resume once a run is terminal (no double approve/approve-after-reject)', async () => {
    const registry = createWriterRunRegistry();
    const approved = await runWriterOnce(startRequest(), { planner: okPlanner() }, registry);
    await resumeWriterRun({ runId: approved.runId, decision: { decision: 'approve' } }, registry);
    await expectApiError(
      resumeWriterRun({ runId: approved.runId, decision: { decision: 'approve' } }, registry),
      409,
      'writer_run_not_awaiting_approval',
    );

    const rejected = await runWriterOnce(startRequest(), { planner: okPlanner() }, registry);
    await resumeWriterRun({ runId: rejected.runId, decision: { decision: 'reject' } }, registry);
    await expectApiError(
      resumeWriterRun({ runId: rejected.runId, decision: { decision: 'approve' } }, registry),
      409,
      'writer_run_not_awaiting_approval',
    );
  });

  it('a run that failed during planning is never resumable', async () => {
    const registry = createWriterRunRegistry();
    const failed = await runWriterOnce(
      startRequest(),
      { planner: { plan: async () => ({ ok: false as const, code: 'ai_error' as const, note: 'boom' }) } },
      registry,
    );

    expect(failed.status).toBe('failed');
    expect(registry.has(failed.runId)).toBe(false);
    await expectApiError(
      resumeWriterRun({ runId: failed.runId, decision: { decision: 'approve' } }, registry),
      404,
      'writer_run_not_found',
    );
  });

  it('degrades an out-of-band invalid resume inside the graph to a failed run', async () => {
    const registry = createWriterRunRegistry();
    const runId = createWriterRunId();
    const run = await runWriterOnce(startRequest(runId), { planner: okPlanner() }, registry);
    expect(run.status).toBe('awaiting_approval');

    const graph = registry.get(runId);
    expect(graph).toBeDefined();
    const finalState = await graph?.invoke(new Command({ resume: { decision: 'evil' } }), {
      configurable: { thread_id: runId },
    });

    expect(finalState?.status).toBe('failed');
    expect((finalState as { planNote?: string } | undefined)?.planNote).toContain(
      'The approval resume input was invalid',
    );
    await expectApiError(
      resumeWriterRun({ runId, decision: { decision: 'approve' } }, registry),
      409,
      'writer_run_not_awaiting_approval',
    );
  });
});

describe('writer resume isolation and honesty', () => {
  it('approving run A never affects run B (cross-run isolation)', async () => {
    const registry = createWriterRunRegistry();
    const runA = await runWriterOnce(
      { projectId, requestId: 'req-A', topic: 'Topic A' },
      { planner: okPlanner(planFixture('Plan A')), sectionWriter: okSectionWriter().deps },
      registry,
    );
    const runB = await runWriterOnce(
      { projectId, requestId: 'req-B', topic: 'Topic B' },
      { planner: okPlanner(planFixture('Plan B')) },
      registry,
    );

    const resumedA = await resumeWriterRun({ runId: runA.runId, decision: { decision: 'approve' } }, registry);
    expect(resumedA.status).toBe('review_ready');
    expect(resumedA.reviewStatus).toBe('completed');
    expect(resumedA.approval).toBe('approved');
    expect(resumedA.plan?.title).toBe('Plan A');

    const completedA = await resumeWriterSession({ runId: runA.runId, decision: { action: 'accept' } }, registry);
    expect(completedA.status).toBe('completed');

    const resumedB = await resumeWriterRun(
      { runId: runB.runId, decision: { decision: 'reject', reason: 'not for B' } },
      registry,
    );
    expect(resumedB.status).toBe('rejected');
    expect(resumedB.plan?.title).toBe('Plan B');
    expect(resumedB.approvalReason).toBe('not for B');
  });

  it('resuming never re-runs the planner or the context adapters', async () => {
    const registry = createWriterRunRegistry();
    const context = recordingContext(AVAILABLE_KNOWLEDGE);
    const planner = recordingPlanner(() => ({ ok: true, plan: planFixture() }));
    const writer = okSectionWriter();

    const run = await runWriterOnce(
      startRequest(),
      { context: context.deps, planner: planner.deps, sectionWriter: writer.deps },
      registry,
    );
    expect(planner.inputs).toHaveLength(1);

    const resumed = await resumeWriterRun({ runId: run.runId, decision: { decision: 'approve' } }, registry);
    expect(resumed.status).toBe('review_ready');
    expect(planner.inputs).toHaveLength(1);
    expect(context.tally.count).toBe(1);
    expect(writer.calls).toHaveLength(1);
  });

  it('a graph registered for a runId without a checkpoint for it cannot resume', async () => {
    const registry = createWriterRunRegistry();
    const runId = createWriterRunId();
    const freshGraph = createWriterGraph({ planner: okPlanner() });
    registry.register(runId, freshGraph);

    const snapshot = await freshGraph.getState({ configurable: { thread_id: runId } });
    expect(Object.keys(snapshot.values)).toHaveLength(0);
    await expectApiError(
      resumeWriterRun({ runId, decision: { decision: 'approve' } }, registry),
      404,
      'writer_run_not_found',
    );
  });
});

describe('writer default registry plumbing', () => {
  it('runWriterOnce and resumeWriterRun share the default in-memory registry', async () => {
    const run = await runWriterOnce(
      startRequest(),
      { planner: okPlanner(), sectionWriter: okSectionWriter().deps },
    );
    expect(run.status).toBe('awaiting_approval');
    expect(isWriterRunId(run.runId)).toBe(true);

    const resumed = await resumeWriterRun({ runId: run.runId, decision: { decision: 'approve' } });
    expect(resumed.status).toBe('review_ready');
  });
});
