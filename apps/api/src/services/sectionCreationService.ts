/**
 * Section creation service (Part B Slice 2).
 *
 * Turns a create-a-new-hero/section instruction into one reviewable
 * `DesignerProposal` carrying a `DocumentOperationBatch`: it creates the
 * container, adds the requested heading, and (when the instruction also asks for
 * an image) places that image inside the new container. The editor applies the
 * whole batch as its own undoable transaction; `DesignerService.apply` refuses a
 * proposal carrying `operations`, so a batch can never masquerade as an applied
 * change.
 *
 * Boundaries kept deliberately:
 *   - It never writes `seo_content`; the base `document` is the snapshot the
 *     batch was resolved against.
 *   - The operation batch stays structural: the executor knows nothing about
 *     "the current section". Semantic placement (a hero at the document start, a
 *     section after the current region) is resolved here, into a concrete
 *     canonical block path, before the batch is built.
 *   - It reuses the shared image acquisition seam (local -> external ->
 *     confirmed generation) rather than reimplementing the policy.
 *   - It never invents a title: a heading that was asked for but could not be
 *     read is refused with an honest clarification.
 */

import {
  DESIGNER_PROPOSAL_VERSION,
  DOCUMENT_OPERATIONS_VERSION,
  contentRevisionOf,
  editorDocumentToCanonical,
  imageSubjectFromInstruction,
  isImageInsertionInstruction,
  isVisualIntentInsertable,
  isValidDesignerProposal,
  resolveVisualDesignIntent,
  type DesignerIntent,
  type DesignerProposal,
  type DocumentOperation,
  type DocumentOperationBatch,
  type DocumentOperationSectionPosition,
  type ImageInsertionCandidate,
  type ImageInsertionContext,
  type SectionCreationKind,
  type SectionCreationRequest,
  type VisualDesignIntent,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { ContentService } from './contentService.js';
import { ImageInsertionService } from './imageInsertionService.js';

/** Where a new container is spliced into the document for a given kind. */
function sectionPositionFor(
  kind: SectionCreationKind,
  context: ImageInsertionContext,
): DocumentOperationSectionPosition {
  // A hero belongs at the top of the page.
  if (kind === 'hero') return { mode: 'document_start' };
  // A section is created after the region the editor is currently in, resolved
  // from the transmitted structural hint into a concrete canonical block path.
  const sectionPath = context.sectionTarget?.sectionPath;
  if (sectionPath && sectionPath.length > 0) return { mode: 'after_block', path: [...sectionPath] };
  const heroPath = context.heroTarget?.heroPath;
  if (heroPath && heroPath.length > 0) return { mode: 'after_block', path: [...heroPath] };
  return { mode: 'document_end' };
}

export class SectionCreationService {
  constructor(private readonly container: ServiceContainer) {}

  /**
   * Builds one reviewable proposal carrying an operation batch that creates the
   * requested hero/section, its heading and (optionally) an image. Never
   * persists; all failures are honest typed `ApiError`s.
   */
  async buildProposal(
    projectId: string,
    intent: DesignerIntent,
    context: ImageInsertionContext,
    request: SectionCreationRequest,
  ): Promise<DesignerProposal> {
    if (intent.contentId === undefined) {
      throw new ApiError(
        422,
        'section_creation_requires_saved_document',
        'Save the document before asking the Agent to add a section so it can anchor to a saved revision.',
      );
    }
    if (request.expectsHeading && !request.heading) {
      throw new ApiError(
        422,
        'section_heading_unresolved',
        "I couldn't read the title you want for this section. Put it in quotes, for example: add a hero section with the title 'Welcome'.",
      );
    }

    const content = await new ContentService(this.container.sb).get(projectId, intent.contentId);
    const baseRevision = contentRevisionOf(content.content_json);
    if (baseRevision !== context.revision) {
      throw new ApiError(
        409,
        'stale_editor_context',
        'The stored document changed since this context was captured; ask again from the current document.',
        { expected: context.revision, actual: baseRevision },
      );
    }
    const baseDocument = editorDocumentToCanonical(content.content_json);

    // An image is only added when the instruction actually names one; a
    // title-only creation stays structural.
    let visual: VisualDesignIntent | null = null;
    let image: ImageInsertionCandidate | null = null;
    let rationale: string | undefined;
    if (isImageInsertionInstruction(intent.instruction)) {
      const resolution = resolveVisualDesignIntent(intent.instruction, context);
      if (resolution.status === 'needs_clarification') {
        throw new ApiError(422, 'visual_intent_needs_clarification', resolution.question, {
          roles: resolution.candidates.map((candidate) => candidate.role),
        });
      }
      if (resolution.status === 'unsupported') {
        if (resolution.reason === 'background_placement_unsupported') {
          throw new ApiError(
            422,
            'visual_placement_unsupported',
            "That placement isn't supported for a background yet. A background fills its section or the hero.",
          );
        }
        throw new ApiError(
          422,
          'image_insertion_unrecognized_instruction',
          'This instruction is not an image-insertion request.',
        );
      }
      const subject = imageSubjectFromInstruction(intent.instruction);
      visual =
        subject && subject !== resolution.intent.subject
          ? { ...resolution.intent, subject }
          : resolution.intent;
      if (!isVisualIntentInsertable(visual)) {
        throw new ApiError(
          422,
          'visual_role_unsupported',
          `A ${visual.role} visual is not supported in the editor yet.`,
          { role: visual.role },
        );
      }

      const imageContext: ImageInsertionContext = {
        ...context,
        ...(request.heading ? { sectionHeading: request.heading, nearbyText: request.heading } : {}),
      };
      const acquisition = await new ImageInsertionService(this.container).acquireImage({
        projectId,
        context: imageContext,
        visual,
        ...(subject ? { subject } : {}),
        baseRevision,
        baseDocument,
        scope: request.kind === 'hero' ? 'this hero' : 'this section',
      });
      if (acquisition.status === 'generation_required') return acquisition.proposal;
      image = acquisition.image;
      rationale = acquisition.rationale;
    }

    if (!request.heading && !image) {
      throw new ApiError(
        422,
        'section_creation_needs_content',
        "Tell me a title or the image you want for this section and I'll add it.",
      );
    }

    const ref = 'section-1';
    const operations: DocumentOperation[] = [
      { type: 'insert_section', ref, section: { kind: request.kind }, position: sectionPositionFor(request.kind, context) },
    ];
    if (request.heading) {
      operations.push({
        type: 'insert_text',
        target: { mode: 'ref', ref, at: 'start' },
        block: { type: 'heading', level: 1, text: request.heading },
      });
    }
    if (image) {
      operations.push({
        type: 'insert_image',
        target: { mode: 'ref', ref },
        image,
        ...(visual ? { visual } : {}),
        ...(rationale ? { rationale } : {}),
      });
    }

    const batch: DocumentOperationBatch = {
      version: DOCUMENT_OPERATIONS_VERSION,
      baseRevision,
      operations,
    };
    const proposal: DesignerProposal = {
      version: DESIGNER_PROPOSAL_VERSION,
      baseRevision,
      document: baseDocument,
      operations: batch,
    };
    if (!isValidDesignerProposal(proposal)) {
      throw new ApiError(500, 'designer_proposal_invalid', 'The Agent produced an invalid proposal.');
    }
    return proposal;
  }
}
