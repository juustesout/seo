/**
 * Designer Agent contracts (Stage 8E.6, Phase 1).
 *
 * The Designer is a thin orchestration agent above the existing Writer and
 * Composer. It turns a user brief into a bounded, ordered plan of typed steps
 * and coordinates the specialists; it never writes copy or structure itself.
 * This module is contracts plus pure validators only - no service, no AI call,
 * no orchestration, no persistence. Stage 8E.6 Phase 1 deliberately stops at the
 * boundary so the runtime can be added behind a stable contract.
 *
 * Two rules shape the design:
 *   1. `CanonicalDocument` is the only document format at the agent boundary.
 *      Writer and Composer results always carry one; there is no second model.
 *   2. A step carries a typed, bounded payload, never a free tool-call schema.
 *      The Designer decides *what* must happen, not how an agent works inside.
 *
 * Everything here follows the dependency-free `@seo/contracts` convention:
 * plain TypeScript types with hand-rolled `isValid...` guards, matching
 * `isValidCanonicalDoc` and `isValidCompositionPlan`. Zod stays at the API route
 * edge where request bodies are parsed.
 */

import { isValidCanonicalDoc, type CanonicalDocument } from './canonical.js';
import {
  isValidCompositionSlotMap,
  isValidCompositionSlot,
  type CompositionSlotMap,
} from './compositionPlan.js';

export const DESIGNER_PLAN_VERSION = 1 as const;
export const DESIGNER_PROPOSAL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Bounds (single source of truth for the contract and its validator)
// ---------------------------------------------------------------------------

export const DESIGN_BRIEF_GOAL_MAX_CHARS = 2000;
export const DESIGNER_MAX_STEPS = 32;
export const DESIGNER_MAX_CONSTRAINTS = 20;
export const DESIGNER_MAX_SLOTS_PER_STEP = 200;
export const DESIGNER_MAX_REVIEW_ISSUES = 100;
export const DESIGNER_BASE_REVISION_MAX_CHARS = 200;

const MAX_SHORT_TEXT = 300;
const MAX_ISSUE_CODE_LENGTH = 80;
const MAX_ISSUE_MESSAGE_LENGTH = 1000;
const MAX_STEP_INDEX = 10000;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Document formats a Designer plan can target. Bounded on purpose: these are the
 * formats the existing Composer already compiles (`article`, `landing_page`).
 */
export const DESIGNER_FORMAT_IDS = ['article', 'landing_page'] as const;
export type DesignBriefFormat = (typeof DESIGNER_FORMAT_IDS)[number];

/** The four typed orchestration steps a Designer plan may contain. */
export const DESIGNER_STEP_KINDS = [
  'writer.freeText',
  'writer.fillSlots',
  'composer.structure',
  'designer.review',
] as const;
export type DesignerStepKind = (typeof DESIGNER_STEP_KINDS)[number];

/** Deterministic checks a `designer.review` step must run. */
export const DESIGNER_REVIEW_CRITERIA = [
  'document_valid',
  'structure_preserved',
  'slots_filled',
  'seo',
] as const;
export type DesignerReviewCriterion = (typeof DESIGNER_REVIEW_CRITERIA)[number];

/** Specialist roles that can return an `AgentResult` to the Designer. */
export const DESIGNER_AGENT_ROLES = ['writer', 'composer'] as const;
export type DesignerAgentRole = (typeof DESIGNER_AGENT_ROLES)[number];

// ---------------------------------------------------------------------------
// Design brief
// ---------------------------------------------------------------------------

/**
 * The user intent the Designer must interpret. It describes *what* the user
 * wants, never how to build it: no provider ids, no tool names, no schemas.
 */
export interface DesignBrief {
  goal: string;
  format?: DesignBriefFormat;
  audience?: string;
  topic?: string;
  constraints?: string[];
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Writer task: answer one bounded free-text instruction. */
export interface WriterFreeTextTask {
  instruction: string;
}

/** Writer task: fill the named compiled slot addresses (empty = every writable slot). */
export interface WriterFillSlotsTask {
  slots: string[];
}

/** Composer task: build the structure for one bounded format. */
export interface ComposerStructureTask {
  format: DesignBriefFormat;
}

export interface WriterFreeTextStep {
  kind: 'writer.freeText';
  task: WriterFreeTextTask;
}

export interface WriterFillSlotsStep {
  kind: 'writer.fillSlots';
  task: WriterFillSlotsTask;
}

export interface ComposerStructureStep {
  kind: 'composer.structure';
  task: ComposerStructureTask;
}

export interface DesignerReviewStep {
  kind: 'designer.review';
  criteria: DesignerReviewCriterion[];
}

export type DesignerStep =
  | WriterFreeTextStep
  | WriterFillSlotsStep
  | ComposerStructureStep
  | DesignerReviewStep;

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/**
 * What the Designer decided to do. It records structure and intent only - no
 * runtime state, no persisted content, no compiled document. The `brief` is
 * echoed so a run is self-describing.
 */
export interface DesignerPlan {
  version: typeof DESIGNER_PLAN_VERSION;
  brief?: DesignBrief;
  steps: DesignerStep[];
}

// ---------------------------------------------------------------------------
// Agent results
// ---------------------------------------------------------------------------

/**
 * Common result contract Writer and Composer return to the Designer. The
 * document is always a `CanonicalDocument`; the optional fields report what the
 * specialist actually produced. A result never mutates `seo_content`.
 */
export interface AgentResult {
  role: DesignerAgentRole;
  document: CanonicalDocument;
  /** Present for the Composer: the deterministic slot map of the skeleton. */
  slots?: CompositionSlotMap;
  /** Present for the Writer: slot addresses actually filled. */
  filled?: string[];
  /** Present for the Writer: writable slots left empty (e.g. media/evidence). */
  unfilled?: string[];
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

export interface DesignerReviewIssue {
  code: string;
  message: string;
  /** Index into `DesignerPlan.steps` the issue belongs to, when known. */
  step?: number;
}

/**
 * Deterministic review result. The Designer computes this; a later AI reviewer
 * is a separate capability, not part of this contract.
 */
export interface DesignerReview {
  ok: boolean;
  errors: DesignerReviewIssue[];
  warnings: DesignerReviewIssue[];
  /** Deterministic SEO score when the review ran the `seo` criterion. */
  score?: number;
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

/**
 * A complete, reviewable Designer output. It is a proposal, never persisted
 * `seo_content`: the editor remains the human approval layer. `baseRevision`
 * guards against applying a proposal that was generated for an older document.
 */
export interface DesignerProposal {
  version: typeof DESIGNER_PROPOSAL_VERSION;
  baseRevision: string;
  document: CanonicalDocument;
  plan?: DesignerPlan;
  review?: DesignerReview;
}

// ---------------------------------------------------------------------------
// Stable content revision (backs `DesignerProposal.baseRevision`)
// ---------------------------------------------------------------------------

/**
 * Deterministic, dependency-free revision of a stored content value. Content is
 * serialized with sorted object keys so two structurally equal values produce
 * the same revision regardless of key insertion order, then hashed with FNV-1a
 * (64-bit) and prefixed with the revision scheme. This is the stable basis the
 * concurrency guard compares against; it is not a client timestamp.
 */
export const CONTENT_REVISION_PREFIX = 'rev1';

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

function stableJson(value: unknown, seen: WeakSet<object>): string {
  if (value === null || value === undefined) return 'null';
  const kind = typeof value;
  if (kind === 'number') return Number.isFinite(value as number) ? String(value) : 'null';
  if (kind === 'boolean') return value ? 'true' : 'false';
  if (kind === 'string') return JSON.stringify(value);
  if (kind === 'bigint') return `${(value as bigint).toString()}n`;
  if (kind !== 'object') return 'null';

  if (seen.has(value as object)) throw new Error('Cannot revision a cyclic value');
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stableJson(entry, seen)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key], seen)}`).join(',')}}`;
  } finally {
    seen.delete(value as object);
  }
}

function fnv1a64(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Stable revision token for a stored content value (e.g. `content_json`). */
export function contentRevisionOf(value: unknown): string {
  return `${CONTENT_REVISION_PREFIX}:${fnv1a64(stableJson(value, new WeakSet<object>()))}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const BRIEF_KEYS: ReadonlySet<string> = new Set(['goal', 'format', 'audience', 'topic', 'constraints']);
const PLAN_KEYS: ReadonlySet<string> = new Set(['version', 'brief', 'steps']);
const PROPOSAL_KEYS: ReadonlySet<string> = new Set(['version', 'baseRevision', 'document', 'plan', 'review']);
const REVIEW_KEYS: ReadonlySet<string> = new Set(['ok', 'errors', 'warnings', 'score']);
const REVIEW_ISSUE_KEYS: ReadonlySet<string> = new Set(['code', 'message', 'step']);
const STEP_TASK_KEYS: ReadonlySet<string> = new Set(['kind', 'task']);
const FREE_TEXT_TASK_KEYS: ReadonlySet<string> = new Set(['instruction']);
const FILL_SLOTS_TASK_KEYS: ReadonlySet<string> = new Set(['slots']);
const STRUCTURE_TASK_KEYS: ReadonlySet<string> = new Set(['format']);
const REVIEW_STEP_KEYS: ReadonlySet<string> = new Set(['kind', 'criteria']);
const AGENT_RESULT_KEYS: ReadonlySet<string> = new Set(['role', 'document', 'slots', 'filled', 'unfilled']);

const FORMAT_SET: ReadonlySet<string> = new Set(DESIGNER_FORMAT_IDS);
const STEP_KIND_SET: ReadonlySet<string> = new Set(DESIGNER_STEP_KINDS);
const REVIEW_CRITERIA_SET: ReadonlySet<string> = new Set(DESIGNER_REVIEW_CRITERIA);
const AGENT_ROLE_SET: ReadonlySet<string> = new Set(DESIGNER_AGENT_ROLES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isValidFormat(value: unknown): value is DesignBriefFormat {
  return typeof value === 'string' && FORMAT_SET.has(value);
}

function isValidConstraintList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > DESIGNER_MAX_CONSTRAINTS) return false;
  return value.every((entry) => isBoundedText(entry, MAX_SHORT_TEXT));
}

function isValidReviewIssue(value: unknown): value is DesignerReviewIssue {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, REVIEW_ISSUE_KEYS)) return false;
  if (!isBoundedText(value.code, MAX_ISSUE_CODE_LENGTH)) return false;
  if (!isBoundedText(value.message, MAX_ISSUE_MESSAGE_LENGTH)) return false;
  if (value.step !== undefined) {
    if (typeof value.step !== 'number' || !Number.isInteger(value.step) || value.step < 0 || value.step > MAX_STEP_INDEX) {
      return false;
    }
  }
  return true;
}

function isValidIssueList(value: unknown): value is DesignerReviewIssue[] {
  if (!Array.isArray(value) || value.length > DESIGNER_MAX_REVIEW_ISSUES) return false;
  return value.every(isValidReviewIssue);
}

function isValidSlotList(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > DESIGNER_MAX_SLOTS_PER_STEP) return false;
  return value.every((entry) => isValidCompositionSlot(entry));
}

/** Validates one DesignBrief. Exported for the API edge and Phase 2 service. */
export function isValidDesignBrief(value: unknown): value is DesignBrief {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, BRIEF_KEYS)) return false;
  if (!isBoundedText(value.goal, DESIGN_BRIEF_GOAL_MAX_CHARS)) return false;
  if (value.format !== undefined && !isValidFormat(value.format)) return false;
  if (value.audience !== undefined && !isBoundedText(value.audience, MAX_SHORT_TEXT)) return false;
  if (value.topic !== undefined && !isBoundedText(value.topic, MAX_SHORT_TEXT)) return false;
  if (value.constraints !== undefined && !isValidConstraintList(value.constraints)) return false;
  return true;
}

/**
 * Validates one DesignerStep: a known kind plus a typed, exactly-shaped payload.
 * Unknown kinds and extra keys are rejected so the step can never smuggle a free
 * tool call or unvalidated context.
 */
export function isValidDesignerStep(value: unknown): value is DesignerStep {
  if (!isPlainObject(value)) return false;
  if (typeof value.kind !== 'string' || !STEP_KIND_SET.has(value.kind)) return false;

  switch (value.kind as DesignerStepKind) {
    case 'writer.freeText': {
      if (!hasOnlyKeys(value, STEP_TASK_KEYS)) return false;
      const task = value.task;
      if (!isPlainObject(task) || !hasOnlyKeys(task, FREE_TEXT_TASK_KEYS)) return false;
      return isBoundedText(task.instruction, DESIGN_BRIEF_GOAL_MAX_CHARS);
    }
    case 'writer.fillSlots': {
      if (!hasOnlyKeys(value, STEP_TASK_KEYS)) return false;
      const task = value.task;
      if (!isPlainObject(task) || !hasOnlyKeys(task, FILL_SLOTS_TASK_KEYS)) return false;
      return isValidSlotList(task.slots);
    }
    case 'composer.structure': {
      if (!hasOnlyKeys(value, STEP_TASK_KEYS)) return false;
      const task = value.task;
      if (!isPlainObject(task) || !hasOnlyKeys(task, STRUCTURE_TASK_KEYS)) return false;
      return isValidFormat(task.format);
    }
    case 'designer.review': {
      if (!hasOnlyKeys(value, REVIEW_STEP_KEYS)) return false;
      const criteria = value.criteria;
      if (!Array.isArray(criteria) || criteria.length === 0) return false;
      const seen = new Set<string>();
      for (const criterion of criteria) {
        if (typeof criterion !== 'string' || !REVIEW_CRITERIA_SET.has(criterion) || seen.has(criterion)) return false;
        seen.add(criterion);
      }
      return true;
    }
    default:
      return false;
  }
}

/** Validates a DesignerPlan: version, optional brief and a bounded step list. */
export function isValidDesignerPlan(value: unknown): value is DesignerPlan {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, PLAN_KEYS)) return false;
  if (value.version !== DESIGNER_PLAN_VERSION) return false;
  if (value.brief !== undefined && !isValidDesignBrief(value.brief)) return false;
  if (!Array.isArray(value.steps)) return false;
  if (value.steps.length === 0 || value.steps.length > DESIGNER_MAX_STEPS) return false;
  return value.steps.every(isValidDesignerStep);
}

/**
 * Validates an AgentResult. The document is the shared interchange format, so it
 * must be a valid CanonicalDocument; optional slot/filled/unfilled fields are
 * checked when present.
 */
export function isValidAgentResult(value: unknown): value is AgentResult {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, AGENT_RESULT_KEYS)) return false;
  if (typeof value.role !== 'string' || !AGENT_ROLE_SET.has(value.role)) return false;
  if (!isValidCanonicalDoc(value.document)) return false;
  if (value.slots !== undefined && !isValidCompositionSlotMap(value.slots)) return false;
  if (value.filled !== undefined && !isValidSlotList(value.filled)) return false;
  if (value.unfilled !== undefined && !isValidSlotList(value.unfilled)) return false;
  return true;
}

/** Validates a deterministic review result. */
export function isValidDesignerReview(value: unknown): value is DesignerReview {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, REVIEW_KEYS)) return false;
  if (typeof value.ok !== 'boolean') return false;
  if (!isValidIssueList(value.errors)) return false;
  if (!isValidIssueList(value.warnings)) return false;
  if (value.score !== undefined && (typeof value.score !== 'number' || !Number.isFinite(value.score))) return false;
  return true;
}

/**
 * Validates a DesignerProposal: a reviewable output envelope, never persistence.
 * `baseRevision` must be a bounded non-empty token; `document` must be a valid
 * CanonicalDocument.
 */
export function isValidDesignerProposal(value: unknown): value is DesignerProposal {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, PROPOSAL_KEYS)) return false;
  if (value.version !== DESIGNER_PROPOSAL_VERSION) return false;
  if (!isBoundedText(value.baseRevision, DESIGNER_BASE_REVISION_MAX_CHARS)) return false;
  if (!isValidCanonicalDoc(value.document)) return false;
  if (value.plan !== undefined && !isValidDesignerPlan(value.plan)) return false;
  if (value.review !== undefined && !isValidDesignerReview(value.review)) return false;
  return true;
}
