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

/**
 * One required piece of content. `type` names the semantic block the writer
 * must fill; `role` is an optional bounded slot label. It declares structure,
 * never copy: the compiler emits an empty placeholder block.
 */
export interface CompositionContentRequirement {
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
const REQUIREMENT_KEYS: ReadonlySet<string> = new Set(['type', 'role', 'level', 'variant']);

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

function isValidRequirement(value: unknown): value is CompositionContentRequirement {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, REQUIREMENT_KEYS)) return false;

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

  return true;
}

interface WalkState {
  depth: number;
  nodes: number;
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
    if (!value.requiredContent.every(isValidRequirement)) return false;
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

  const state: WalkState = { depth: 0, nodes: 0 };
  for (const section of value.sections) {
    if (!isValidNode(section, state)) return false;
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

function compileRequirement(requirement: CompositionContentRequirement): CanonicalBlock {
  switch (requirement.type) {
    case 'heading':
      return { type: 'heading', attrs: { level: requirement.level ?? DEFAULT_HEADING_LEVEL } };
    case 'list':
      return { type: 'list', attrs: { ordered: false }, children: [] };
    case 'image':
      return { type: 'image' };
    case 'paragraph':
    case 'quote':
    case 'code':
      return { type: requirement.type };
    default:
      // Leaf composition blocks (badge / button / statItem): empty label, no
      // invented href, icon or value.
      return requirement.variant !== undefined
        ? { type: requirement.type, attrs: { variant: requirement.variant } }
        : { type: requirement.type };
  }
}

function compileNode(node: CompositionPlanNode): CanonicalBlock {
  const attrs: Record<string, unknown> = {};
  if (node.variant !== undefined) attrs.variant = node.variant;
  const layout = normalizeCanonicalLayoutIntent(node.layout);
  if (layout !== undefined) attrs.layout = layout;

  const block: CanonicalBlock = { type: node.type };
  if (Object.keys(attrs).length > 0) block.attrs = attrs;

  // Deterministic order: required content blocks first, then nested sections.
  const children: CanonicalBlock[] = [
    ...(node.requiredContent ?? []).map(compileRequirement),
    ...(node.children ?? []).map(compileNode),
  ];
  if (children.length > 0) block.children = children;

  return block;
}

/**
 * Converts a storyboard into Canonical structure. Deterministic and pure: the
 * same valid plan always yields a structurally identical document, and no
 * content, media, ids or timestamps are invented. Throws
 * `CompositionPlanError` when the plan is invalid.
 */
export function compileCompositionPlan(plan: CompositionPlan): CanonicalDocument {
  if (!isValidCompositionPlan(plan)) {
    throw new CompositionPlanError('invalid_composition_plan', 'Composition plan is not valid');
  }
  return {
    version: CANONICAL_DOCUMENT_VERSION,
    blocks: plan.sections.map(compileNode),
  };
}
