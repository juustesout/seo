/**
 * Composition Plan / Storyboard (Stage 6).
 *
 * A target-neutral description of *what a document should contain, how its
 * sections are organized and which semantic components belong in each section*
 * - before any copy exists. It sits between a strategy/brief and a
 * `CanonicalDocument`:
 *
 *   Strategy / brief -> CompositionPlan -> CanonicalDocument -> renderer
 *
 * The plan reuses the existing Canonical composition vocabulary instead of
 * defining a second block taxonomy: containers are exactly the Canonical
 * composition block types and leaf requirements are the Canonical leaf types,
 * so the deterministic compiler only ever emits blocks the renderer already
 * knows.
 *
 * It separates *structure* from *copy*: a requirement declares that a heading
 * or a CTA is required, never what it says. This module is pure types plus a
 * deterministic compiler - no LLM, no providers, no persistence, no jobs.
 */

import {
  CANONICAL_BLOCK_VARIANTS,
  CANONICAL_COMPOSITION_BLOCK_TYPES,
  CANONICAL_COMPOSITION_LEAF_BLOCK_TYPES,
  CANONICAL_DOCUMENT_VERSION,
  isValidCanonicalLayoutIntent,
  normalizeCanonicalLayoutIntent,
  type CanonicalBlock,
  type CanonicalDocument,
  type CanonicalLayoutIntent,
} from './canonical.js';

export const COMPOSITION_PLAN_VERSION = 1 as const;

/** Document formats a plan can target. Additive; consumers must not hardcode. */
export const COMPOSITION_PLAN_FORMAT_IDS = ['article', 'landing_page'] as const;
export type CompositionPlanFormat = (typeof COMPOSITION_PLAN_FORMAT_IDS)[number];

/** Bounded semantic purpose of a section (never an unrestricted taxonomy). */
export const COMPOSITION_SECTION_PURPOSES = [
  'introduction',
  'problem',
  'solution',
  'features',
  'proof',
  'process',
  'comparison',
  'conversion',
  'closing',
] as const;
export type CompositionSectionPurpose = (typeof COMPOSITION_SECTION_PURPOSES)[number];

/** Bounded semantic slot label for a content requirement. */
export const COMPOSITION_REQUIREMENT_ROLES = [
  'title',
  'subtitle',
  'intro',
  'body',
  'media',
  'caption',
  'primaryCta',
  'secondaryCta',
  'label',
  'value',
  'attribution',
] as const;
export type CompositionRequirementRole = (typeof COMPOSITION_REQUIREMENT_ROLES)[number];

/**
 * Composition containers: exactly the Canonical composition block vocabulary.
 * A plan section compiles to one of these blocks.
 */
export const COMPOSITION_CONTAINER_TYPES = CANONICAL_COMPOSITION_BLOCK_TYPES;
/** Leaf blocks a requirement may request: the Canonical leaf vocabulary. */
export const COMPOSITION_LEAF_TYPES = CANONICAL_COMPOSITION_LEAF_BLOCK_TYPES;
/** Ordinary content blocks a requirement may request. */
export const COMPOSITION_CONTENT_TYPES = ['heading', 'paragraph', 'list', 'image', 'quote', 'code'] as const;

export type CompositionContainerType = (typeof COMPOSITION_CONTAINER_TYPES)[number];
export type CompositionLeafType = (typeof COMPOSITION_LEAF_TYPES)[number];
export type CompositionContentType = (typeof COMPOSITION_CONTENT_TYPES)[number];
export type CompositionRequirementType = CompositionContentType | CompositionLeafType;

export const COMPOSITION_HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;
export type CompositionHeadingLevel = (typeof COMPOSITION_HEADING_LEVELS)[number];

/** Bounds (single source of truth for the compiler and the API edge). */
export const COMPOSITION_MAX_SECTIONS = 24;
export const COMPOSITION_MAX_NODES = 400;
export const COMPOSITION_MAX_REQUIREMENTS_PER_NODE = 24;
export const COMPOSITION_MAX_DEPTH = 12;
export const COMPOSITION_MAX_FEATURE_CARDS = 6;
export const COMPOSITION_MAX_STAT_ITEMS = 6;
export const COMPOSITION_PURPOSE_MAX_CHARS = 300;
const MAX_ROLE_LENGTH = 40;
const MAX_FORMAT_LENGTH = 40;
const MAX_SLOT_REF_TYPE_LENGTH = 40;

/**
 * Slot identity (Stage 7). Every content requirement carries a stable,
 * semantic address so a later Writer can request exactly one slot without
 * relying on array position or a DOM selector. The grammar is intentionally
 * narrow: ASCII-only, dot-separated segments (`hero.title`,
 * `features.card.1.title`), no whitespace, no slash, no CSS/provider syntax.
 */
export const COMPOSITION_SLOT_MAX_CHARS = 80;
const COMPOSITION_SLOT_RE = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*$/;

/** True when `value` is a bounded, well-formed composition slot key. */
export function isValidCompositionSlot(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= COMPOSITION_SLOT_MAX_CHARS && COMPOSITION_SLOT_RE.test(value)
  );
}

/**
 * Deterministic canonical block id for a slot. Canonical ids may not contain
 * dots, so each dot segment boundary becomes `__`; the mapping is injective
 * because slot segments are alphanumeric only.
 */
export function compositionSlotId(slot: string): string {
  return slot.replace(/\./g, '__');
}

/**
 * One required piece of content. `type` names the semantic block the writer
 * must fill; `role` is an optional bounded slot label. It declares structure,
 * never copy: the compiler emits an empty placeholder block.
 */
export interface CompositionContentRequirement {
  /** Stable semantic address, unique within the plan (e.g. `hero.primaryCta`). */
  slot: string;
  type: CompositionRequirementType;
  role?: CompositionRequirementRole;
  /** Heading level, only meaningful (and only allowed) for `heading`. */
  level?: CompositionHeadingLevel;
  /** Bounded variant, only for leaf types that declare variants. */
  variant?: string;
}

/**
 * One section of the storyboard. A plan node is a composition container that
 * may require leaf/content blocks (`requiredContent`) and nest other
 * composition nodes (`children`). `purpose`, `role` and planner-only metadata
 * stay on the plan; they are never copied into the Canonical document.
 */
export interface CompositionPlanNode {
  type: CompositionContainerType;
  variant?: string;
  layout?: CanonicalLayoutIntent;
  purpose?: CompositionSectionPurpose;
  requiredContent?: CompositionContentRequirement[];
  children?: CompositionPlanNode[];
}

export interface CompositionPlan {
  version: typeof COMPOSITION_PLAN_VERSION;
  /** Short, bounded description of what the document is for. */
  purpose: string;
  format: CompositionPlanFormat;
  sections: CompositionPlanNode[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PLAN_KEYS: ReadonlySet<string> = new Set(['version', 'purpose', 'format', 'sections']);
const NODE_KEYS: ReadonlySet<string> = new Set(['type', 'variant', 'layout', 'purpose', 'requiredContent', 'children']);
const REQUIREMENT_KEYS: ReadonlySet<string> = new Set(['slot', 'type', 'role', 'level', 'variant']);

const CONTAINER_TYPE_SET: ReadonlySet<string> = new Set(COMPOSITION_CONTAINER_TYPES);
const LEAF_TYPE_SET: ReadonlySet<string> = new Set(COMPOSITION_LEAF_TYPES);
const CONTENT_TYPE_SET: ReadonlySet<string> = new Set(COMPOSITION_CONTENT_TYPES);
const PURPOSE_SET: ReadonlySet<string> = new Set(COMPOSITION_SECTION_PURPOSES);
const ROLE_SET: ReadonlySet<string> = new Set(COMPOSITION_REQUIREMENT_ROLES);
const FORMAT_SET: ReadonlySet<string> = new Set(COMPOSITION_PLAN_FORMAT_IDS);
const HEADING_LEVEL_SET: ReadonlySet<number> = new Set(COMPOSITION_HEADING_LEVELS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

function isValidVariantFor(type: string, variant: unknown): boolean {
  const allowed = (CANONICAL_BLOCK_VARIANTS as Record<string, readonly string[]>)[type];
  if (!allowed) return false;
  return typeof variant === 'string' && allowed.includes(variant);
}

function isValidRequirement(value: unknown, slots: Set<string>): value is CompositionContentRequirement {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, REQUIREMENT_KEYS)) return false;

  if (!isValidCompositionSlot(value.slot)) return false;
  if (slots.has(value.slot)) return false;

  const type = value.type;
  if (typeof type !== 'string') return false;
  const isContent = CONTENT_TYPE_SET.has(type);
  const isLeaf = LEAF_TYPE_SET.has(type);
  if (!isContent && !isLeaf) return false;

  if (value.role !== undefined) {
    if (typeof value.role !== 'string' || value.role.length > MAX_ROLE_LENGTH || !ROLE_SET.has(value.role)) return false;
  }

  if (value.level !== undefined) {
    if (type !== 'heading') return false;
    if (typeof value.level !== 'number' || !HEADING_LEVEL_SET.has(value.level)) return false;
  }

  if (value.variant !== undefined) {
    // Content types have no variants; only leaves that declare them may carry one.
    if (!isLeaf || !isValidVariantFor(type, value.variant)) return false;
  }

  slots.add(value.slot);
  return true;
}

interface WalkState {
  depth: number;
  nodes: number;
  slots: Set<string>;
}

function isValidNode(value: unknown, state: WalkState): value is CompositionPlanNode {
  if (!isPlainObject(value)) return false;
  if (state.depth > COMPOSITION_MAX_DEPTH) return false;
  if (++state.nodes > COMPOSITION_MAX_NODES) return false;
  if (!hasOnlyKeys(value, NODE_KEYS)) return false;

  const type = value.type;
  if (typeof type !== 'string' || !CONTAINER_TYPE_SET.has(type)) return false;

  if (value.variant !== undefined && !isValidVariantFor(type, value.variant)) return false;
  if (value.layout !== undefined && !isValidCanonicalLayoutIntent(value.layout)) return false;
  if (value.purpose !== undefined && (typeof value.purpose !== 'string' || !PURPOSE_SET.has(value.purpose))) {
    return false;
  }

  if (value.requiredContent !== undefined) {
    if (!Array.isArray(value.requiredContent)) return false;
    if (value.requiredContent.length > COMPOSITION_MAX_REQUIREMENTS_PER_NODE) return false;
    if (!value.requiredContent.every((requirement) => isValidRequirement(requirement, state.slots))) return false;
  }

  const children = value.children;
  if (children !== undefined) {
    if (!Array.isArray(children)) return false;
    state.depth += 1;
    for (const child of children) {
      if (!isValidNode(child, state)) return false;
    }
    state.depth -= 1;
  }

  // Bounded structural shape rules: a feature grid contains feature cards and a
  // stats block contains stat items; a card never nests further composition.
  if (type === 'featureCard' && children !== undefined && children.length > 0) return false;
  if (type === 'featureGrid') {
    if (!children || children.length === 0) return false;
    if (children.length > COMPOSITION_MAX_FEATURE_CARDS) return false;
    if (!children.every((child) => isPlainObject(child) && child.type === 'featureCard')) return false;
  }
  if (type === 'stats') {
    if (children !== undefined && children.length > 0) return false;
    const items = value.requiredContent;
    if (!Array.isArray(items) || items.length === 0) return false;
    if (items.length > COMPOSITION_MAX_STAT_ITEMS) return false;
    if (!items.every((item) => isPlainObject(item) && item.type === 'statItem')) return false;
  }

  return true;
}

/**
 * Strict, recursive plan validation. Rejects impossible structures (unbounded
 * nesting, unknown/unsupported vocabulary, malformed layout) so the compiler
 * only ever sees a bounded, well-formed plan. Does not mutate its input.
 */
export function isValidCompositionPlan(value: unknown): value is CompositionPlan {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, PLAN_KEYS)) return false;
  if (value.version !== COMPOSITION_PLAN_VERSION) return false;
  if (typeof value.purpose !== 'string') return false;
  const purpose = value.purpose.trim();
  if (purpose.length === 0 || purpose.length > COMPOSITION_PURPOSE_MAX_CHARS) return false;
  if (typeof value.format !== 'string' || value.format.length > MAX_FORMAT_LENGTH || !FORMAT_SET.has(value.format)) {
    return false;
  }
  if (!Array.isArray(value.sections)) return false;
  if (value.sections.length === 0 || value.sections.length > COMPOSITION_MAX_SECTIONS) return false;

  const state: WalkState = { depth: 0, nodes: 0, slots: new Set<string>() };
  for (const section of value.sections) {
    if (!isValidNode(section, state)) return false;
  }
  return true;
}

const SLOT_REF_KEYS: ReadonlySet<string> = new Set(['slot', 'type', 'id', 'path', 'role', 'level']);

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Structural validation of a slot map. Every ref carries a unique, well-formed
 * slot address, a bounded block type/id and an index path of non-negative
 * integers; optional `role`/`level` must stay inside the plan vocabularies.
 * Used by higher-level contracts (Designer AgentResult) so a slot map coming
 * back from an agent is proven before it is trusted.
 */
export function isValidCompositionSlotMap(value: unknown): value is CompositionSlotMap {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, new Set(['slots']))) return false;
  if (!Array.isArray(value.slots)) return false;
  if (value.slots.length > COMPOSITION_MAX_NODES) return false;

  const seen = new Set<string>();
  for (const ref of value.slots) {
    if (!isPlainObject(ref)) return false;
    if (!hasOnlyKeys(ref, SLOT_REF_KEYS)) return false;
    if (!isValidCompositionSlot(ref.slot)) return false;
    if (seen.has(ref.slot)) return false;
    seen.add(ref.slot);
    if (typeof ref.type !== 'string' || ref.type.length === 0 || ref.type.length > MAX_SLOT_REF_TYPE_LENGTH) return false;
    if (typeof ref.id !== 'string' || ref.id.length === 0 || ref.id.length > COMPOSITION_SLOT_MAX_CHARS) return false;
    if (!Array.isArray(ref.path) || !ref.path.every(isNonNegativeInteger)) return false;
    if (ref.role !== undefined && (typeof ref.role !== 'string' || !ROLE_SET.has(ref.role))) return false;
    if (ref.level !== undefined && (typeof ref.level !== 'number' || !HEADING_LEVEL_SET.has(ref.level))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Deterministic compiler
// ---------------------------------------------------------------------------

export type CompositionPlanErrorCode = 'invalid_composition_plan';

/** Raised when `compileCompositionPlan` receives a plan that is not valid. */
export class CompositionPlanError extends Error {
  readonly code: CompositionPlanErrorCode;

  constructor(code: CompositionPlanErrorCode, message: string) {
    super(message);
    this.name = 'CompositionPlanError';
    this.code = code;
  }
}

/**
 * Default heading level when a plan does not state one. Purely structural - a
 * heading level is never copy, so a deterministic default is safe.
 */
const DEFAULT_HEADING_LEVEL = 2;

/**
 * One resolved slot: the plan address, the canonical block it compiled to, the
 * deterministic block id and the index path from the document root. Consumers
 * resolve a slot through this artifact, never through a DOM selector or by
 * guessing array positions.
 */
export interface CompositionSlotRef {
  slot: string;
  /** Canonical block type the slot compiled to (e.g. `heading`, `button`). */
  type: string;
  /** Canonical block id (see `compositionSlotId`). */
  id: string;
  /** Index path from the document root: `[blockIndex, childIndex, ...]`. */
  path: number[];
  /** Bounded semantic role the plan declared for this slot, when present. */
  role?: CompositionRequirementRole;
  /** Heading level, only for `heading` slots. */
  level?: CompositionHeadingLevel;
}

/** Deterministic slot artifact emitted alongside the compiled document. */
export interface CompositionSlotMap {
  slots: CompositionSlotRef[];
}

export interface CompiledComposition {
  document: CanonicalDocument;
  slots: CompositionSlotMap;
}

function compileRequirement(
  requirement: CompositionContentRequirement,
  path: number[],
  slots: CompositionSlotRef[],
): CanonicalBlock {
  const id = compositionSlotId(requirement.slot);
  const ref: CompositionSlotRef = { slot: requirement.slot, type: requirement.type, id, path };
  if (requirement.role !== undefined) ref.role = requirement.role;
  if (requirement.level !== undefined) ref.level = requirement.level;
  slots.push(ref);
  switch (requirement.type) {
    case 'heading':
      return { id, type: 'heading', attrs: { level: requirement.level ?? DEFAULT_HEADING_LEVEL } };
    case 'list':
      return { id, type: 'list', attrs: { ordered: false }, children: [] };
    case 'image':
      return { id, type: 'image' };
    case 'paragraph':
    case 'quote':
    case 'code':
      return { id, type: requirement.type };
    default:
      // Leaf composition blocks (badge / button / statItem): empty label, no
      // invented href, icon or value.
      return requirement.variant !== undefined
        ? { id, type: requirement.type, attrs: { variant: requirement.variant } }
        : { id, type: requirement.type };
  }
}

function compileNode(node: CompositionPlanNode, path: number[], slots: CompositionSlotRef[]): CanonicalBlock {
  const attrs: Record<string, unknown> = {};
  if (node.variant !== undefined) attrs.variant = node.variant;
  const layout = normalizeCanonicalLayoutIntent(node.layout);
  if (layout !== undefined) attrs.layout = layout;

  const block: CanonicalBlock = { type: node.type };
  if (Object.keys(attrs).length > 0) block.attrs = attrs;

  // Deterministic order: required content blocks first, then nested sections.
  const requiredContent = node.requiredContent ?? [];
  const children: CanonicalBlock[] = requiredContent.map((requirement, index) =>
    compileRequirement(requirement, [...path, index], slots),
  );
  (node.children ?? []).forEach((child, index) => {
    children.push(compileNode(child, [...path, requiredContent.length + index], slots));
  });
  if (children.length > 0) block.children = children;

  return block;
}

/**
 * Converts a storyboard into Canonical structure plus a deterministic slot map.
 * Pure: the same valid plan always yields a structurally identical result, and
 * no content, media or timestamps are invented. Throws `CompositionPlanError`
 * when the plan is invalid.
 */
export function compileComposition(plan: CompositionPlan): CompiledComposition {
  if (!isValidCompositionPlan(plan)) {
    throw new CompositionPlanError('invalid_composition_plan', 'Composition plan is not valid');
  }
  const slots: CompositionSlotRef[] = [];
  const blocks = plan.sections.map((section, index) => compileNode(section, [index], slots));
  return {
    document: { version: CANONICAL_DOCUMENT_VERSION, blocks },
    slots: { slots },
  };
}

/**
 * Converts a storyboard into Canonical structure. Equivalent to
 * `compileComposition(plan).document`; kept as the document-only entry point.
 */
export function compileCompositionPlan(plan: CompositionPlan): CanonicalDocument {
  return compileComposition(plan).document;
}

/**
 * Resolves a compiled slot to its canonical block by walking the slot map's
 * index path. Returns undefined when the slot is unknown or the path no longer
 * matches the document. No DOM selectors, no array-position guessing.
 */
export function findCompiledSlotBlock(compiled: CompiledComposition, slot: string): CanonicalBlock | undefined {
  const ref = compiled.slots.slots.find((entry) => entry.slot === slot);
  if (!ref) return undefined;
  let cursor: CanonicalBlock[] = compiled.document.blocks;
  let block: CanonicalBlock | undefined;
  for (const index of ref.path) {
    block = cursor[index];
    if (!block) return undefined;
    cursor = block.children ?? [];
  }
  return block;
}
