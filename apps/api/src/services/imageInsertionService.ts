/**
 * Context-aware image insertion service (R3.1).
 *
 * The first Editor-native Designer capability: given an already-resolved editor
 * context (canonical snapshot, revision and insertion location) plus the user's
 * instruction, it selects one existing project media asset and returns a typed
 * `insert_image` operation wrapped in the existing Designer proposal envelope.
 *
 * Boundaries kept deliberately:
 *   - It only ever ranks existing project media (the media library is the
 *     simplest already-supported source); it never generates, downloads or
 *     invents an image, and never inserts a placeholder.
 *   - It never writes `seo_content`: the editor applies the operation as its own
 *     undoable transaction. `DesignerService.apply` refuses a proposal carrying
 *     an `insertion`, so a suggestion can never masquerade as an applied change.
 *   - It reuses the validated revision scheme (`contentRevisionOf`) and refuses a
 *     proposal when the stored document no longer matches the context the editor
 *     transmitted (`stale_editor_context`).
 */

import {
  DESIGNER_PROPOSAL_VERSION,
  contentRevisionOf,
  editorDocumentToCanonical,
  isImageInsertionInstruction,
  isValidDesignerProposal,
  isValidImageInsertionContext,
  isValidInsertImageOperation,
  selectImageInsertionCandidate,
  type DesignerIntent,
  type DesignerProposal,
  type ImageInsertionCandidate,
  type ImageInsertionContext,
  type InsertImageOperation,
  type VisualAssetCandidate,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { SupabaseStorageStore } from '../infra/mediaStorage.js';
import { ContentService } from './contentService.js';
import { MediaService } from './mediaService.js';

/**
 * Reads the typed image-insertion context out of the opaque intent `selection`
 * seam, or null when the intent carries no valid context. The seam stays opaque
 * at the contract level (R2.1 inherited it), so this is the single place that
 * decides whether the transmitted selection is an image-insertion context.
 */
export function imageInsertionContextOf(intent: DesignerIntent): ImageInsertionContext | null {
  const selection = intent.context?.selection;
  return isValidImageInsertionContext(selection) ? selection : null;
}

function toVisualCandidate(item: {
  id: string;
  filename: string;
  alt_text: string;
  caption: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  usage_count: number;
}): VisualAssetCandidate {
  return {
    mediaId: item.id,
    filename: item.filename,
    alt: item.alt_text,
    caption: item.caption,
    mimeType: item.mime_type,
    ...(item.width !== null ? { width: item.width } : {}),
    ...(item.height !== null ? { height: item.height } : {}),
    usageCount: item.usage_count,
  };
}

export class ImageInsertionService {
  constructor(private readonly container: ServiceContainer) {}

  /**
   * Builds one reviewable `DesignerProposal` carrying a typed `insert_image`
   * operation for the transmitted editor context. Never persists. All failures
   * are honest typed `ApiError`s; there is no arbitrary fallback image.
   */
  async buildProposal(
    projectId: string,
    intent: DesignerIntent,
    context: ImageInsertionContext,
  ): Promise<DesignerProposal> {
    if (!isImageInsertionInstruction(intent.instruction)) {
      throw new ApiError(
        422,
        'image_insertion_unrecognized_instruction',
        'This instruction is not an image-insertion request.',
      );
    }
    if (intent.contentId === undefined) {
      throw new ApiError(
        422,
        'image_insertion_requires_saved_document',
        'Save the document before asking for an image so the Agent can anchor it to a saved revision.',
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

    const media = await new MediaService(this.container.sb, new SupabaseStorageStore(this.container.sb)).list(projectId);
    const selection = selectImageInsertionCandidate(context, media.map(toVisualCandidate));
    if (!selection) {
      throw new ApiError(
        422,
        'image_insertion_no_candidate',
        'No existing image in this project matches this section closely enough.',
      );
    }

    const item = media.find((entry) => entry.id === selection.candidate.mediaId);
    if (!item) {
      throw new ApiError(422, 'image_insertion_no_candidate', 'The selected image is no longer in the media library.');
    }

    const image: ImageInsertionCandidate = {
      assetId: item.id,
      url: item.url,
      alt: (item.alt_text || item.filename).trim(),
      ...(item.caption ? { caption: item.caption } : {}),
      ...(item.width !== null ? { width: item.width } : {}),
      ...(item.height !== null ? { height: item.height } : {}),
    };
    const operation: InsertImageOperation = {
      type: 'insert_image',
      target: context.target,
      image,
      ...(selection.rationale ? { rationale: selection.rationale } : {}),
    };
    if (!isValidInsertImageOperation(operation)) {
      throw new ApiError(500, 'image_insertion_operation_invalid', 'The Agent produced an invalid image operation.');
    }

    const proposal: DesignerProposal = {
      version: DESIGNER_PROPOSAL_VERSION,
      baseRevision,
      document: editorDocumentToCanonical(content.content_json),
      insertion: operation,
    };
    if (!isValidDesignerProposal(proposal)) {
      throw new ApiError(500, 'designer_proposal_invalid', 'The Agent produced an invalid proposal.');
    }
    return proposal;
  }
}
