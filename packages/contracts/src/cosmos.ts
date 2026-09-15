/**
 * Cosmos: project-level editorial/brand configuration.
 *
 * Cosmos is configuration, not an agent - it never generates content. It holds
 * bounded, human-authored guidance (identity, voice, editorial rules, SEO
 * defaults, knowledge usage) that AI features read as context. It is stored in
 * `seo_projects.settings.cosmos` so it needs no schema migration and stays
 * separate from Core Topics (`settings.coreTopics`) and the article itself.
 *
 * The normalizer is intentionally forgiving: unknown/extra keys are dropped,
 * non-strings become empty, and every field is capped - so a hand-edited row can
 * never blow up an AI prompt or leak unrelated state.
 */

export const COSMOS_SECTION_IDS = ['identity', 'voice', 'editorial', 'seo', 'knowledge'] as const;
export type CosmosSectionId = (typeof COSMOS_SECTION_IDS)[number];

/** Per-field character cap. Bounded so Cosmos always fits a small, cheap prompt. */
export const COSMOS_FIELD_MAX_CHARS = 2000;

/** Hard cap on the rendered Cosmos context block handed to the AI. */
export const COSMOS_CONTEXT_MAX_CHARS = 4000;

export interface CosmosIdentity {
  /** Site/project name as it should appear to readers. */
  name: string;
  /** Positioning / what the site is about. */
  description: string;
  /** Who the content is written for. */
  audience: string;
}

export interface CosmosVoice {
  tone: string;
  formality: string;
  personality: string;
  /** Preferred vocabulary / terms to favour. */
  vocabulary: string;
}

export interface CosmosEditorial {
  writingRules: string;
  preferredStructure: string;
  articleCharacteristics: string;
  /** Forbidden patterns / terminology. */
  forbidden: string;
}

export interface CosmosSeo {
  rules: string;
  searchIntent: string;
  internalLinking: string;
}

export interface CosmosKnowledge {
  /** Free-form guidance on how knowledge should be used. */
  notes: string;
  /** When true (default), project knowledge may be offered as reference. */
  useProjectKnowledge: boolean;
}

export interface CosmosConfig {
  identity: CosmosIdentity;
  voice: CosmosVoice;
  editorial: CosmosEditorial;
  seo: CosmosSeo;
  knowledge: CosmosKnowledge;
}

/** A blank, fully-populated Cosmos config (never null/undefined fields). */
export function emptyCosmosConfig(): CosmosConfig {
  return {
    identity: { name: '', description: '', audience: '' },
    voice: { tone: '', formality: '', personality: '', vocabulary: '' },
    editorial: { writingRules: '', preferredStructure: '', articleCharacteristics: '', forbidden: '' },
    seo: { rules: '', searchIntent: '', internalLinking: '' },
    knowledge: { notes: '', useProjectKnowledge: true },
  };
}

function boundedString(value: unknown, max = COSMOS_FIELD_MAX_CHARS): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function section(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Normalizes an arbitrary stored/request value into a complete CosmosConfig.
 * Missing sections and fields become empty strings; `useProjectKnowledge`
 * defaults to true only when it is not an explicit boolean.
 */
export function parseCosmosConfig(value: unknown): CosmosConfig {
  const root = section(value);
  const identity = section(root.identity);
  const voice = section(root.voice);
  const editorial = section(root.editorial);
  const seo = section(root.seo);
  const knowledge = section(root.knowledge);
  return {
    identity: {
      name: boundedString(identity.name),
      description: boundedString(identity.description),
      audience: boundedString(identity.audience),
    },
    voice: {
      tone: boundedString(voice.tone),
      formality: boundedString(voice.formality),
      personality: boundedString(voice.personality),
      vocabulary: boundedString(voice.vocabulary),
    },
    editorial: {
      writingRules: boundedString(editorial.writingRules),
      preferredStructure: boundedString(editorial.preferredStructure),
      articleCharacteristics: boundedString(editorial.articleCharacteristics),
      forbidden: boundedString(editorial.forbidden),
    },
    seo: {
      rules: boundedString(seo.rules),
      searchIntent: boundedString(seo.searchIntent),
      internalLinking: boundedString(seo.internalLinking),
    },
    knowledge: {
      notes: boundedString(knowledge.notes),
      useProjectKnowledge:
        typeof knowledge.useProjectKnowledge === 'boolean' ? knowledge.useProjectKnowledge : true,
    },
  };
}

/** True when the config carries no guidance at all (empty strings + default flag). */
export function isEmptyCosmosConfig(config: CosmosConfig): boolean {
  const { knowledge, ...sections } = config;
  return (
    Object.values(sections).every((fields) => Object.values(fields).every((field) => field === '')) &&
    knowledge.notes === '' &&
    knowledge.useProjectKnowledge
  );
}
