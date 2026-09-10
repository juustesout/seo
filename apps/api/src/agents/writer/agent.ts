/**
 * Writer Agent coordinator boundary (W10.4).
 *
 * W10.1-W10.3 built separate, safe capabilities that only ever run on an
 * explicit human decision. W10.4 adds a *bounded* coordinator on top of them:
 * the agent may choose which of its EXISTING, allowlisted actions to run next,
 * but it gains no new power. It cannot add tools, call providers or the database
 * directly, change its own limits, skip approval, publish, or apply a final
 * article. This module owns only the safe vocabulary + the deterministic
 * decision gate; execution happens in the graph by calling the exact same
 * boundaries a human-triggered action uses (research gather, intelligence
 * gather, the controlled revision writer, the deterministic review).
 *
 * Hard bounds (all configurable constants, all tested):
 *   - MAX_AGENT_STEPS       - the whole loop stops after N steps;
 *   - per-action budgets    - research/intelligence/magic/revision/review are
 *                             each capped (spec: MAX_*_ACTIONS = 2).
 * When a bound is hit the agent ends as `limit_reached`; it never silently
 * keeps going. `completed` is reserved for an explicit `finish` decision.
 *
 * Deny by default: a decision is only allowed when the action exists in the
 * fixed registry, the run is `review_ready`, the action budget is available and
 * every selected section id exists in the approved plan. An unknown action is
 * rejected outright (`agent_invalid_action`); there is no fallback to "do
 * something else".
 *
 * The AI (when wired) only *proposes*; an action never executes because a model
 * said so. Every proposal is parsed by a strict schema and then re-validated
 * deterministically against the immutable run state here. Retrieved content is
 * data, never instructions: hostile text inside evidence/intelligence/article
 * content can at most make the agent pick a normal allowlisted action - it can
 * never widen the vocabulary, limits, approval or scope.
 */

import { z } from 'zod';
import type {
  WriterAgentAction,
  WriterAgentGoal,
  WriterAgentStatus,
  WriterAgentStepStatus,
} from '@seo/contracts';
import type { WriterEvidence } from './evidence.js';
import type { WriterIntelligence } from './intelligence.js';
import { validateRevisionSectionIds } from './revision.js';
import type { WriterPlan, WriterStatus } from './state.js';

// --- vocabulary --------------------------------------------------------------

/** The only actions the coordinator can choose. */
export const WRITER_AGENT_ACTIONS = [
  'research',
  'intelligence',
  'magic',
  'revision',
  'review',
  'finish',
] as const satisfies readonly WriterAgentAction[];
export type WriterAgentActionName = (typeof WRITER_AGENT_ACTIONS)[number];

/** Bounded agent lifecycle. `awaiting_approval` is reserved for a future
 *  explicit approval gate and is never fabricated. */
export const WRITER_AGENT_STATUSES = [
  'idle',
  'running',
  'awaiting_approval',
  'completed',
  'limit_reached',
  'failed',
] as const satisfies readonly WriterAgentStatus[];
export type WriterAgentStatusName = (typeof WRITER_AGENT_STATUSES)[number];

/** Bounded goal vocabulary; there is no free-form autonomy. */
export const WRITER_AGENT_GOALS = [
  'improve_evidence',
  'improve_seo',
  'improve_clarity',
  'deep_research',
  'section_improvement',
] as const satisfies readonly WriterAgentGoal[];
export type WriterAgentGoalName = (typeof WRITER_AGENT_GOALS)[number];

export const WRITER_AGENT_STEP_STATUSES = ['planned', 'running', 'completed', 'failed'] as const satisfies readonly WriterAgentStepStatus[];
export type WriterAgentStepStatusName = (typeof WRITER_AGENT_STEP_STATUSES)[number];

// --- hard bounds -------------------------------------------------------------

/** Whole-loop step budget ceiling (server-side; the request can only lower it). */
export const WRITER_AGENT_MAX_STEPS = 5;
/** Default step budget when the request does not choose one. */
export const WRITER_AGENT_DEFAULT_STEPS = 5;
export const WRITER_AGENT_MIN_STEPS = 1;
/** Per-action budget for every non-terminal action (spec: MAX_*_ACTIONS = 2). */
export const WRITER_AGENT_ACTION_BUDGET = 2;
export const WRITER_AGENT_MAX_INSTRUCTION_CHARS = 500;
export const WRITER_AGENT_MAX_REASON_CHARS = 500;
export const WRITER_AGENT_MAX_STEP_SUMMARY_CHARS = 300;
export const WRITER_AGENT_MAX_NOTE_CHARS = 300;
export const WRITER_AGENT_MAX_SECTIONS = 3;
export const WRITER_AGENT_MAX_STEPS_STORED = WRITER_AGENT_MAX_STEPS;

/** Explicit action registry. `finish` is always available and consumes no
 *  budget; every other action is deny-by-default and capped. */
export const WRITER_AGENT_ACTIONS_REGISTRY: Record<WriterAgentActionName, { maxCalls: number; mutatesContent: boolean }> = {
  research: { maxCalls: WRITER_AGENT_ACTION_BUDGET, mutatesContent: false },
  intelligence: { maxCalls: WRITER_AGENT_ACTION_BUDGET, mutatesContent: false },
  magic: { maxCalls: WRITER_AGENT_ACTION_BUDGET, mutatesContent: true },
  revision: { maxCalls: WRITER_AGENT_ACTION_BUDGET, mutatesContent: true },
  review: { maxCalls: WRITER_AGENT_ACTION_BUDGET, mutatesContent: false },
  finish: { maxCalls: 0, mutatesContent: false },
};

export function emptyWriterAgentActionCounts(): Record<WriterAgentActionName, number> {
  return { research: 0, intelligence: 0, magic: 0, revision: 0, review: 0, finish: 0 };
}

// --- stored agent state ------------------------------------------------------

/** One safe agent step. Only the action, status and a bounded summary - never
 *  prompts, chain-of-thought or raw payloads. */
export interface WriterAgentStep {
  index: number;
  action: WriterAgentActionName;
  status: WriterAgentStepStatusName;
  summary: string | null;
}

/** The durable W10.4 agent state. It is a safe progress record, not a reasoning
 *  trace, and is strictly re-validated when a snapshot is read. */
export interface WriterAgentState {
  status: WriterAgentStatusName;
  goal: WriterAgentGoalName;
  instruction: string | null;
  maxSteps: number;
  stepCount: number;
  steps: WriterAgentStep[];
  actionCounts: Record<WriterAgentActionName, number>;
  preferredSections: string[];
  note: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** A resting, never-started agent state. */
export function emptyWriterAgent(): WriterAgentState {
  return {
    status: 'idle',
    goal: 'improve_clarity',
    instruction: null,
    maxSteps: WRITER_AGENT_DEFAULT_STEPS,
    stepCount: 0,
    steps: [],
    actionCounts: emptyWriterAgentActionCounts(),
    preferredSections: [],
    note: null,
    startedAt: null,
    finishedAt: null,
  };
}

function capSummary(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, WRITER_AGENT_MAX_STEP_SUMMARY_CHARS) : null;
}

/** Records one completed/failed step and increments the matching budget counter
 *  on completion. The stored array is hard-capped at the max step budget. */
export function recordWriterAgentStep(
  agent: WriterAgentState,
  action: WriterAgentActionName,
  status: WriterAgentStepStatusName,
  summary: string | null,
): WriterAgentState {
  const step: WriterAgentStep = {
    index: agent.steps.length,
    action,
    status,
    summary: capSummary(summary),
  };
  const steps = [...agent.steps, step].slice(0, WRITER_AGENT_MAX_STEPS_STORED);
  const actionCounts =
    status === 'completed'
      ? { ...agent.actionCounts, [action]: (agent.actionCounts[action] ?? 0) + 1 }
      : { ...agent.actionCounts };
  return { ...agent, steps, stepCount: steps.length, actionCounts };
}

/** Builds the initial running agent state from a validated session intent. */
export function initialWriterAgent(
  intent: { goal: WriterAgentGoalName; maxSteps: number; instruction: string | null; sections: string[] },
  startedAt: string,
): WriterAgentState {
  return {
    status: 'running',
    goal: intent.goal,
    instruction: intent.instruction,
    maxSteps: Math.min(Math.max(intent.maxSteps, WRITER_AGENT_MIN_STEPS), WRITER_AGENT_MAX_STEPS),
    stepCount: 0,
    steps: [],
    actionCounts: emptyWriterAgentActionCounts(),
    preferredSections: intent.sections.slice(0, WRITER_AGENT_MAX_SECTIONS),
    note: null,
    startedAt,
    finishedAt: null,
  };
}

/** Finalizes the agent with an honest terminal status + bounded note. */
export function finalizeWriterAgent(
  agent: WriterAgentState,
  status: WriterAgentStatusName,
  note: string | null,
  finishedAt: string,
): WriterAgentState {
  return {
    ...agent,
    status,
    note: note ? note.slice(0, WRITER_AGENT_MAX_NOTE_CHARS) : null,
    finishedAt,
  };
}

// --- schemas -----------------------------------------------------------------

const agentActionSchema = z.enum(WRITER_AGENT_ACTIONS);
const agentGoalSchema = z.enum(WRITER_AGENT_GOALS);
const agentSectionIdSchema = z.string().regex(/^section_\d+$/);

/** Strict user-facing start request. Only { goal, max_steps?, instruction?,
 *  sections? }; no workflow-control fields are ever accepted. */
export const writerAgentRequestBodySchema = z
  .object({
    goal: agentGoalSchema,
    max_steps: z.number().int().min(WRITER_AGENT_MIN_STEPS).max(WRITER_AGENT_MAX_STEPS).optional(),
    instruction: z.string().trim().min(1).max(WRITER_AGENT_MAX_INSTRUCTION_CHARS).optional(),
    sections: z.array(agentSectionIdSchema).max(WRITER_AGENT_MAX_SECTIONS).optional(),
  })
  .strict();

export type WriterAgentRequestBody = z.infer<typeof writerAgentRequestBodySchema>;

export interface WriterAgentStartIntent {
  goal: WriterAgentGoalName;
  maxSteps: number;
  instruction: string | null;
  sections: string[];
}

export type WriterAgentRequestParse =
  | { ok: true; request: WriterAgentStartIntent }
  | { ok: false; note: string };

/** The single validation gate for an agent start request body. */
export function parseWriterAgentRequest(value: unknown): WriterAgentRequestParse {
  const parsed = writerAgentRequestBodySchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      note: `An agent request must be { goal: "<one of ${WRITER_AGENT_GOALS.join('|')}>", max_steps?, instruction?, sections? } within bounds.`,
    };
  }
  const sections = parsed.data.sections ?? [];
  if (new Set(sections).size !== sections.length) {
    return { ok: false, note: 'Agent sections must not contain duplicates.' };
  }
  return {
    ok: true,
    request: {
      goal: parsed.data.goal,
      maxSteps: parsed.data.max_steps ?? WRITER_AGENT_DEFAULT_STEPS,
      instruction: parsed.data.instruction ?? null,
      sections,
    },
  };
}

/** Strict review-session resume value for starting the coordinator. Shares the
 *  same bounds as the request body but is used inside the graph. */
export const writerAgentSessionSchema = z
  .object({
    action: z.literal('agent'),
    goal: agentGoalSchema,
    maxSteps: z.number().int().min(WRITER_AGENT_MIN_STEPS).max(WRITER_AGENT_MAX_STEPS),
    instruction: z.string().trim().min(1).max(WRITER_AGENT_MAX_INSTRUCTION_CHARS).optional(),
    sections: z.array(agentSectionIdSchema).max(WRITER_AGENT_MAX_SECTIONS).optional(),
  })
  .strict();

export type WriterAgentSessionDecision = z.infer<typeof writerAgentSessionSchema>;

export function isWriterAgentSessionDecision(value: unknown): value is WriterAgentSessionDecision {
  return writerAgentSessionSchema.safeParse(value).success;
}

/** Strict decision schema the AI proposal is parsed against. `.strict()` means
 *  a model cannot smuggle extra fields (tools, limits, approval...) in. */
export const writerAgentDecisionSchema = z
  .object({
    action: agentActionSchema,
    reason: z.string().trim().min(1).max(WRITER_AGENT_MAX_REASON_CHARS),
    sections: z.array(agentSectionIdSchema).max(WRITER_AGENT_MAX_SECTIONS).optional(),
  })
  .strict();

export interface WriterAgentDecision {
  action: WriterAgentActionName;
  reason: string;
  sections: string[];
}

export type WriterAgentDecisionRejectionCode = 'invalid_action' | 'invalid_section' | 'budget_exhausted' | 'not_allowed';

export type WriterAgentDecisionValidation =
  | { ok: true; decision: WriterAgentDecision }
  | { ok: false; code: WriterAgentDecisionRejectionCode; note: string };

/** The deterministic gate: the AI proposes, this decides whether the action is
 *  actually allowed. Deny by default; unknown action -> invalid_action. */
export function validateWriterAgentDecision(input: {
  raw: unknown;
  agent: WriterAgentState;
  plan: WriterPlan | null;
  runStatus: WriterStatus;
}): WriterAgentDecisionValidation {
  const parsed = writerAgentDecisionSchema.safeParse(input.raw);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_action',
      note: 'The agent proposed a decision outside the allowed action vocabulary.',
    };
  }
  const { action, reason } = parsed.data;
  const sections = parsed.data.sections ?? [];
  if (new Set(sections).size !== sections.length) {
    return { ok: false, code: 'invalid_section', note: 'Agent sections must not contain duplicates.' };
  }
  if (action === 'finish') {
    return { ok: true, decision: { action, reason, sections: [] } };
  }
  if (input.runStatus !== 'review_ready' || !input.plan) {
    return {
      ok: false,
      code: 'not_allowed',
      note: 'The agent can only act on a review_ready run with an approved plan.',
    };
  }
  const budget = WRITER_AGENT_ACTIONS_REGISTRY[action].maxCalls;
  if ((input.agent.actionCounts[action] ?? 0) >= budget) {
    return { ok: false, code: 'budget_exhausted', note: `The agent reached its ${action} action budget.` };
  }
  if ((action === 'magic' || action === 'revision') && sections.length === 0) {
    return {
      ok: false,
      code: 'invalid_section',
      note: `The ${action} action requires at least one approved-plan section.`,
    };
  }
  if (sections.length > 0) {
    const validated = validateRevisionSectionIds(input.plan, sections);
    if (!validated.ok) {
      return { ok: false, code: 'invalid_section', note: validated.note };
    }
    return { ok: true, decision: { action, reason, sections: validated.sectionIds } };
  }
  return { ok: true, decision: { action, reason, sections: [] } };
}

// --- resume helpers ----------------------------------------------------------

/** Builds the validated session resume from a stored running agent (used by the
 *  durable recovery path to re-issue an agent that never started). */
export function agentResumeFromState(agent: WriterAgentState): WriterAgentSessionDecision {
  return {
    action: 'agent',
    goal: agent.goal,
    maxSteps: agent.maxSteps,
    ...(agent.instruction !== null ? { instruction: agent.instruction } : {}),
    ...(agent.preferredSections.length > 0 ? { sections: agent.preferredSections } : {}),
  };
}

// --- decision boundary -------------------------------------------------------

/** One approved-plan section shown to the coordinator (id + heading only). */
export interface WriterAgentSectionSummary {
  id: string;
  heading: string;
}

/** Everything the coordinator boundary receives to make one decision. All
 *  content fields are already bounded/sanitized; the runtime prompt builder
 *  places evidence/intelligence in delimited untrusted blocks. */
export interface WriterAgentDecisionInput {
  projectId: string;
  topic: string;
  targetKeyword: string | null;
  goal: WriterAgentGoalName;
  instruction: string | null;
  stepIndex: number;
  maxSteps: number;
  sections: WriterAgentSectionSummary[];
  preferredSections: string[];
  remaining: Record<WriterAgentActionName, number>;
  evidence: WriterEvidence | null;
  intelligence: WriterIntelligence | null;
  reviewSeoScore: number | null;
  revisionCount: number;
}

/** The injected coordinator allowlist. The graph never talks to AI, providers
 *  or credentials directly - it only calls decide() and then re-validates the
 *  reply. */
export interface WriterAgentDependencies {
  decide(input: WriterAgentDecisionInput): Promise<unknown>;
}

/** No coordinator wired: the loop finishes immediately, honestly, instead of
 *  guessing. Deny by default. */
export const NO_AGENT_DEPENDENCIES: WriterAgentDependencies = {
  async decide() {
    return { action: 'finish', reason: 'No agent coordinator is wired for this run.' };
  },
};

/** Human label of an agent action (shared by the UI, kept in sync here). */
export function agentActionLabel(action: WriterAgentActionName): string {
  switch (action) {
    case 'research':
      return 'Research';
    case 'intelligence':
      return 'Intelligence';
    case 'magic':
      return 'Section Magic';
    case 'revision':
      return 'Revision';
    case 'review':
      return 'Review';
    case 'finish':
      return 'Finish';
  }
}

/** Human label of a bounded agent goal. */
export function agentGoalLabel(goal: WriterAgentGoalName): string {
  switch (goal) {
    case 'improve_evidence':
      return 'Improve evidence coverage';
    case 'improve_seo':
      return 'Improve SEO quality';
    case 'improve_clarity':
      return 'Improve clarity';
    case 'deep_research':
      return 'Deep research';
    case 'section_improvement':
      return 'Improve selected sections';
  }
}

/** Human label of an agent status. */
export function agentStatusLabel(status: WriterAgentStatusName): string {
  switch (status) {
    case 'idle':
      return 'Not started';
    case 'running':
      return 'Working';
    case 'awaiting_approval':
      return 'Awaiting approval';
    case 'completed':
      return 'Completed';
    case 'limit_reached':
      return 'Limit reached';
    case 'failed':
      return 'Failed';
  }
}
