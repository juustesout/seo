/**
 * Cosmos service (SEO Core).
 *
 * Reads/writes the project's Cosmos configuration and - the important part -
 * turns it into one bounded, deterministic context block that every AI feature
 * (editor edit, and future writer/reviewer integrations) can reuse. Cosmos
 * itself never calls a model; it is configuration.
 *
 * Project scoping is enforced by always reading the row via its id; empty
 * fields are omitted; the rendered block is hard-capped so it can never blow up
 * a prompt. No secrets or other projects' data are ever included.
 */

import {
  COSMOS_CONTEXT_MAX_CHARS,
  cosmosDesignSystemRef,
  emptyCosmosConfig,
  isEmptyCosmosConfig,
  parseCosmosConfig,
  type CanonicalDesignSystemRef,
  type CosmosConfig,
} from '@seo/contracts';
import type { ServiceContainer } from '../context.js';
import { readProjectSettings, writeProjectSettings } from './projectSettings.js';

export interface CosmosContext {
  /** Rendered, bounded context block. Empty string when Cosmos has no guidance. */
  text: string;
  /** True when at least one field carried guidance. */
  hasContent: boolean;
  /** Whether project knowledge may be offered to the model (Cosmos default true). */
  useProjectKnowledge: boolean;
  /**
   * Identity reference for the project's design tokens, when configured. This is
   * what a canonical document records in `meta.designSystem`; absent means the
   * renderer uses the built-in defaults.
   */
  designSystemRef?: CanonicalDesignSystemRef;
}

/** Reads the stored Cosmos config for one project (normalized, never null). */
export async function readCosmosConfig(
  container: ServiceContainer,
  projectId: string,
): Promise<CosmosConfig> {
  const settings = await readProjectSettings(container, projectId);
  return parseCosmosConfig(settings.cosmos);
}

/** Replaces the project's Cosmos config, preserving every sibling settings key. */
export async function writeCosmosConfig(
  container: ServiceContainer,
  projectId: string,
  input: unknown,
): Promise<CosmosConfig> {
  const config = parseCosmosConfig(input);
  await writeProjectSettings(container, projectId, { cosmos: config });
  return config;
}

interface SectionSpec {
  title: string;
  fields: Array<[label: string, value: string]>;
}

/** Fixed section/field order - the representation is stable for logging/tests. */
function sectionSpecs(config: CosmosConfig): SectionSpec[] {
  return [
    {
      title: 'Brand identity',
      fields: [
        ['Name', config.identity.name],
        ['Positioning', config.identity.description],
        ['Audience', config.identity.audience],
      ],
    },
    {
      title: 'Voice',
      fields: [
        ['Tone', config.voice.tone],
        ['Formality', config.voice.formality],
        ['Personality', config.voice.personality],
        ['Preferred vocabulary', config.voice.vocabulary],
      ],
    },
    {
      title: 'Editorial guidance',
      fields: [
        ['Writing rules', config.editorial.writingRules],
        ['Preferred structure', config.editorial.preferredStructure],
        ['Article characteristics', config.editorial.articleCharacteristics],
        ['Forbidden patterns', config.editorial.forbidden],
      ],
    },
    {
      title: 'SEO guidance',
      fields: [
        ['Rules', config.seo.rules],
        ['Search intent', config.seo.searchIntent],
        ['Internal linking', config.seo.internalLinking],
      ],
    },
    {
      title: 'Knowledge guidance',
      fields: [['Notes', config.knowledge.notes]],
    },
  ];
}

/**
 * Pure, deterministic render of a Cosmos config into a bounded context block.
 * Empty fields/sections are omitted; the result is capped at
 * COSMOS_CONTEXT_MAX_CHARS. Exported for direct unit testing.
 */
export function renderCosmosContext(config: CosmosConfig): string {
  const blocks: string[] = [];
  for (const spec of sectionSpecs(config)) {
    const lines = spec.fields
      .filter(([, value]) => value.trim().length > 0)
      .map(([label, value]) => `- ${label}: ${value.trim()}`);
    if (lines.length > 0) blocks.push(`${spec.title}:\n${lines.join('\n')}`);
  }
  const text = blocks.join('\n\n');
  return text.length > COSMOS_CONTEXT_MAX_CHARS ? text.slice(0, COSMOS_CONTEXT_MAX_CHARS) : text;
}

/**
 * The single reusable Cosmos context entry point. Reads the project config and
 * returns the rendered block plus the knowledge-usage flag. Callers pass the
 * text into a prompt; they never re-implement the formatting.
 */
export async function getCosmosContext(
  container: ServiceContainer,
  projectId: string,
): Promise<CosmosContext> {
  const config = await readCosmosConfig(container, projectId);
  const text = renderCosmosContext(config);
  const designSystemRef = cosmosDesignSystemRef(config);
  return {
    text,
    hasContent: !isEmptyCosmosConfig(config),
    useProjectKnowledge: config.knowledge.useProjectKnowledge,
    ...(designSystemRef ? { designSystemRef } : {}),
  };
}

export { emptyCosmosConfig };
