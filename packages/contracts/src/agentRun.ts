/**
 * Durable agent run contracts (Stage 8E.6, ADR Phase 4 Part 1).
 *
 * A run is the durable, project-scoped lifecycle record of an agent request.
 * It is deliberately NOT a job: a job is executable work in the shared queue,
 * while a run owns the request, the terminal result and the failure facts a
 * caller can poll. The two are associated (a run records the job that carries
 * its execution) but neither is a second queue, retry model or worker.
 *
 * Part 1 (this module + `seo_agent_runs`) is the durable submission boundary:
 * validate -> authorize -> idempotency -> persist the run and associate the
 * job. Execution and the status API are Phase 4 Part 2 and are intentionally
 * absent here.
 *
 * Dependency-free by convention: plain types with hand-rolled `isValid...`
 * guards. Zod stays at the API route edge.
 */

import {
  DESIGNER_BASE_REVISION_MAX_CHARS,
  isValidDesignBrief,
  isValidDesignerIntent,
  isValidDesignerPlan,
  isValidDesignerProposal,
  type DesignBrief,
  type DesignerIntent,
  type DesignerPlan,
  type DesignerProposal,
} from './designer.js';

/** External run id prefix; the id is opaque to callers (mirrors `wr_`). */
export const AGENT_RUN_ID_PREFIX = 'ar_';
export type AgentRunId = `${typeof AGENT_RUN_ID_PREFIX}${string}`;

/** Run kinds the platform can durably accept. One kind today, no speculation. */
export const AGENT_RUN_KINDS = ['design'] as const;
export type AgentRunKind = (typeof AGENT_RUN_KINDS)[number];

/**
 * Safe external lifecycle vocabulary (matches the `seo_agent_runs.status`
 * CHECK constraint). The minimum from the ADR: queued -> running -> succeeded
 * or failed. A run is never `succeeded` before its result is durably persisted.
 */
export const AGENT_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** Terminal resting statuses; no transition leaves them. */
export const AGENT_RUN_TERMINAL_STATUSES = ['succeeded', 'failed'] as const;

export const AGENT_RUN_ERROR_CODE_MAX_CHARS = 80;
export const AGENT_RUN_ERROR_MESSAGE_MAX_CHARS = 2000;
export const AGENT_RUN_IDEMPOTENCY_KEY_MAX_CHARS = 200;

/** A bounded, secret-free failure fact recorded on a failed run. */
export interface AgentRunError {
  code: string;
  message: string;
  /** Whether a retry could plausibly succeed; omitted when unknown. */
  retryable?: boolean;
}

/**
 * Durable input for an explicit, already-validated plan. Mirrors the fields the
 * synchronous `/designer/execute` route accepts.
 */
export interface AgentRunPlanInput {
  mode: 'plan';
  plan: DesignerPlan;
  brief?: DesignBrief;
  contentId?: string;
  baseRevision?: string;
}

/**
 * Durable input for a natural-language intent. The intent carries its own
 * `projectId`, `contentId` and `brief`; `baseRevision` is the explicit creation
 * revision (never supplied alongside a `contentId`, matching the route rule).
 */
export interface AgentRunIntentInput {
  mode: 'intent';
  intent: DesignerIntent;
  baseRevision?: string;
}

export type AgentRunInput = AgentRunPlanInput | AgentRunIntentInput;

/**
 * The durable run as returned to an authorized caller. `result` holds the
 * validated `DesignerProposal` once the run succeeds; it stays null until then.
 */
export interface AgentRun {
  runId: AgentRunId;
  kind: AgentRunKind;
  projectId: string;
  status: AgentRunStatus;
  input: AgentRunInput;
  result: DesignerProposal | null;
  error: AgentRunError | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

const RUN_ID_RE = /^ar_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[a-z0-9_]+$/;

const RUN_KEYS: ReadonlySet<string> = new Set([
  'runId',
  'kind',
  'projectId',
  'status',
  'input',
  'result',
  'error',
  'createdAt',
  'updatedAt',
  'completedAt',
]);
const PLAN_INPUT_KEYS: ReadonlySet<string> = new Set([
  'mode',
  'plan',
  'brief',
  'contentId',
  'baseRevision',
]);
const INTENT_INPUT_KEYS: ReadonlySet<string> = new Set(['mode', 'intent', 'baseRevision']);
const ERROR_KEYS: ReadonlySet<string> = new Set(['code', 'message', 'retryable']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isNullableBoundedText(value: unknown, max: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= max);
}

/** True when `value` is a well-formed external agent run id (`ar_<uuid>`). */
export function isAgentRunId(value: unknown): value is AgentRunId {
  return typeof value === 'string' && RUN_ID_RE.test(value);
}

/** True when `value` is one of the safe external run statuses. */
export function isValidAgentRunStatus(value: unknown): value is AgentRunStatus {
  return typeof value === 'string' && (AGENT_RUN_STATUSES as readonly string[]).includes(value);
}

/** True when the status is a terminal resting point. */
export function isTerminalAgentRunStatus(value: unknown): value is AgentRunStatus {
  return isValidAgentRunStatus(value) && (AGENT_RUN_TERMINAL_STATUSES as readonly string[]).includes(value);
}

/** True when `value` is a bounded, secret-free run error. */
export function isValidAgentRunError(value: unknown): value is AgentRunError {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ERROR_KEYS)) return false;
  if (typeof value.code !== 'string' || value.code.length === 0) return false;
  if (value.code.length > AGENT_RUN_ERROR_CODE_MAX_CHARS || !CODE_RE.test(value.code)) return false;
  if (!isBoundedText(value.message, AGENT_RUN_ERROR_MESSAGE_MAX_CHARS)) return false;
  if (value.retryable !== undefined && typeof value.retryable !== 'boolean') return false;
  return true;
}

/**
 * True when `value` is a valid durable input. Plan mode reuses the existing
 * `DesignerPlan`/`DesignBrief` validators; intent mode reuses
 * `isValidDesignerIntent`. `baseRevision` is bounded by the shared constant and
 * must never accompany a `contentId` (the server derives the revision).
 */
export function isValidAgentRunInput(value: unknown): value is AgentRunInput {
  if (!isPlainObject(value)) return false;
  if (value.mode === 'plan') {
    if (!hasOnlyKeys(value, PLAN_INPUT_KEYS)) return false;
    if (!isValidDesignerPlan(value.plan)) return false;
    if (value.brief !== undefined && !isValidDesignBrief(value.brief)) return false;
    if (value.contentId !== undefined && (typeof value.contentId !== 'string' || !UUID_RE.test(value.contentId))) {
      return false;
    }
  } else if (value.mode === 'intent') {
    if (!hasOnlyKeys(value, INTENT_INPUT_KEYS)) return false;
    if (!isValidDesignerIntent(value.intent)) return false;
  } else {
    return false;
  }
  if (
    value.baseRevision !== undefined &&
    !isBoundedText(value.baseRevision, DESIGNER_BASE_REVISION_MAX_CHARS)
  ) {
    return false;
  }
  if (value.baseRevision !== undefined) {
    const contentId = value.mode === 'plan' ? value.contentId : (value.intent as DesignerIntent).contentId;
    if (contentId !== undefined) return false;
  }
  return true;
}

/**
 * True when `value` is a complete, well-formed durable run. Shape only: a
 * `succeeded` run without a persisted result is rejected here because that is
 * the core lifecycle invariant (never report success before the result is
 * durable). The inverse (a failed run that also carries a partial result) is
 * allowed, matching the job model's bounded failure summary.
 */
export function isValidAgentRun(value: unknown): value is AgentRun {
  if (!isPlainObject(value) || !hasOnlyKeys(value, RUN_KEYS)) return false;
  if (!isAgentRunId(value.runId)) return false;
  if (typeof value.kind !== 'string' || !(AGENT_RUN_KINDS as readonly string[]).includes(value.kind)) return false;
  if (typeof value.projectId !== 'string' || !UUID_RE.test(value.projectId)) return false;
  if (!isValidAgentRunStatus(value.status)) return false;
  if (!isValidAgentRunInput(value.input)) return false;
  if (value.result !== null && !isValidDesignerProposal(value.result)) return false;
  if (value.error !== null && !isValidAgentRunError(value.error)) return false;
  if (value.status === 'succeeded' && value.result === null) return false;
  if (value.status === 'failed' && value.error === null) return false;
  if (!isBoundedText(value.createdAt, 100) || !isBoundedText(value.updatedAt, 100)) return false;
  if (!isNullableBoundedText(value.completedAt, 100)) return false;
  return true;
}
