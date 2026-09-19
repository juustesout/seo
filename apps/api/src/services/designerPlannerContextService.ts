/**
 * Designer planner context loader (Stage 8E.6, Phase 3.2).
 *
 * Assembles the bounded `DesignerPlannerContext` the LLM planner reasons over.
 * It reuses the existing content read path (`ContentService.get`) and the
 * canonical bridge, so the planner sees the same writable block references a
 * `writer.revise` step would edit - never raw `content_json` and never an
 * unbounded selection. Reads only; it never writes content or calls a model.
 */

import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import {
  DesignerRevisionError,
  asTipDoc,
  contentRevisionOf,
  docHeadings,
  docWordCount,
  editorDocumentToCanonical,
  resolveDesignerRevisionTargets,
} from '@seo/contracts';
import type { DesignerIntent } from '@seo/contracts';
import { ContentService } from './contentService.js';
import { getCosmosContext } from './cosmosService.js';
import {
  PLANNER_CONTEXT_COSMOS_MAX_CHARS,
  boundDesignerPlannerBlocks,
  boundDesignerPlannerHeadings,
  type DesignerPlannerBlock,
  type DesignerPlannerContext,
  type DesignerPlannerDocumentContext,
} from '../agents/designer/plannerContext.js';

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export class DesignerPlannerContextService {
  constructor(private readonly container: ServiceContainer) {}

  /** Loads the bounded context for one intent (project Cosmos + optional doc). */
  async load(intent: DesignerIntent): Promise<DesignerPlannerContext> {
    const cosmosText = (await getCosmosContext(this.container, intent.projectId)).text.slice(
      0,
      PLANNER_CONTEXT_COSMOS_MAX_CHARS,
    );
    const context: DesignerPlannerContext = { projectId: intent.projectId, cosmosText };
    if (intent.brief !== undefined) context.brief = intent.brief;
    if (intent.contentId !== undefined) {
      context.document = await this.loadDocument(intent.projectId, intent.contentId);
    }
    return context;
  }

  private async loadDocument(projectId: string, contentId: string): Promise<DesignerPlannerDocumentContext> {
    const row = await new ContentService(this.container.sb).get(projectId, contentId);
    const raw = row.content_json;
    const tip = asTipDoc(raw);

    let blocks: DesignerPlannerBlock[];
    try {
      const canonical = editorDocumentToCanonical(raw);
      const refs = resolveDesignerRevisionTargets(canonical, { kind: 'document' });
      blocks = boundDesignerPlannerBlocks(
        refs.map((ref) => ({
          ref: ref.ref,
          type: ref.type,
          text: ref.text ?? ref.items?.join('; ') ?? '',
        })),
      );
    } catch (err) {
      if (err instanceof DesignerRevisionError) {
        throw new ApiError(422, 'designer_planner_context_invalid', `The target content could not be summarized: ${err.message}`);
      }
      throw err;
    }

    return {
      contentId,
      title: asString(row.title),
      targetKeyword: asString(row.target_keyword),
      language: asString(row.language),
      revision: contentRevisionOf(raw),
      wordCount: docWordCount(tip),
      headings: boundDesignerPlannerHeadings(docHeadings(tip).map((heading) => ({ level: heading.level, text: heading.text }))),
      blocks,
    };
  }
}
