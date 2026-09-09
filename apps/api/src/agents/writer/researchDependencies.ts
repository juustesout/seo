/**
 * Production wiring for the writer's W10.2 research allowlist.
 *
 * W10.2 research reuses the existing W1 read-only context sources - there is
 * no new research engine, no autonomous search and no direct SQL/provider
 * access from the agent. The research boundary degrades honestly per source
 * exactly like gatherContext: a throwing adapter becomes an unavailable (or, on
 * an explicit not_configured ApiError, not_configured) source result, never a
 * crashed gather and never a fabricated item. The `search` source stays part of
 * the canonical vocabulary but is deliberately unwired (not_configured) until an
 * explicit, project-scoped search source exists - deny by default.
 */

import { ApiError } from '../../apiErrors.js';
import type { WriterContextDependencies } from './context.js';
import { contextNoteFromError } from './context.js';
import type {
  WriterContentResult,
  WriterIntelligenceResult,
  WriterKnowledgeResult,
} from './context.js';
import type {
  WriterResearchDependencies,
  WriterResearchRequest,
  WriterResearchResult,
} from './evidence.js';

/** A provider that explicitly signals "not configured" keeps that honest
 *  status instead of being flattened into a generic "unavailable". */
function isNotConfiguredError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'not_configured';
}

function knowledgeFallback(err: unknown): WriterKnowledgeResult {
  return {
    status: isNotConfiguredError(err) ? 'not_configured' : 'unavailable',
    note: contextNoteFromError(err),
    chunks: [],
  };
}

function contentFallback(err: unknown): WriterContentResult {
  return {
    status: isNotConfiguredError(err) ? 'not_configured' : 'unavailable',
    note: contextNoteFromError(err),
    items: [],
  };
}

function intelligenceFallback(err: unknown): WriterIntelligenceResult {
  return {
    status: isNotConfiguredError(err) ? 'not_configured' : 'unavailable',
    note: contextNoteFromError(err),
    keywords: [],
  };
}

/** Builds the production research allowlist over the same read-only context
 *  adapters gatherContext uses. Every read is scoped by the projectId the graph
 *  hands the request; nothing is ever written, published or re-searched. */
export function createWriterResearchDependencies(
  context: WriterContextDependencies,
): WriterResearchDependencies {
  return {
    async research(input: WriterResearchRequest): Promise<WriterResearchResult> {
      const brief = {
        projectId: input.projectId,
        topic: input.topic,
        targetKeyword: input.targetKeyword ?? null,
      };
      const [knowledge, existingContent, intelligence] = await Promise.all([
        context.getKnowledge(brief).catch(knowledgeFallback),
        context.getExistingContent(brief).catch(contentFallback),
        context.getIntelligence(brief).catch(intelligenceFallback),
      ]);
      return {
        purpose: input.purpose,
        knowledge,
        existingContent,
        intelligence,
        search: {
          status: 'not_configured',
          note: 'No explicit, project-scoped search source is wired yet.',
          items: [],
        },
      };
    },
  };
}
