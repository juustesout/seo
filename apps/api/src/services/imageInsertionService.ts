/**
 * Context-aware image insertion service (R3.1).
 *
 * The first Editor-native Designer capability: given an already-resolved editor
 * context (canonical snapshot, revision and insertion location) plus the user's
 * instruction, it selects one existing project media asset and returns a typed
 * `insert_image` operation wrapped in the existing Designer proposal envelope.
 *
 * Boundaries kept deliberately:
 *   - It ranks existing project media first, then (only when the caller's
 *     policy allows it) an external stock search, and finally - only when the
 *     policy allows it *and* the user explicitly confirmed for this run - a
 *     generated image. Generation is never a silent fallback: the first run
 *     returns a `generation_required` proposal and the confirmed rerun spends.
 *   - It never writes `seo_content`: the editor applies the operation as its own
 *     undoable transaction. `DesignerService.apply` refuses a proposal carrying
 *     an `insertion` or an `acquisition`, so a suggestion can never masquerade as
 *     an applied change.
 *   - It reuses the validated revision scheme (`contentRevisionOf`) and refuses a
 *     proposal when the stored document no longer matches the context the editor
 *     transmitted (`stale_editor_context`).
 */

import {
  DESIGNER_PROPOSAL_VERSION,
  IMAGE_INSERTION_BACKGROUND_PLACEMENT,
  IMAGE_INSERTION_HERO_PLACEMENT,
  IMAGE_INSERTION_SECTION_PLACEMENT,
  contentRevisionOf,
  editorDocumentToCanonical,
  imageInsertionAltForIntent,
  imageSourceKindOf,
  imageSubjectFromInstruction,
  isVisualIntentInsertable,
  isValidDesignerProposal,
  isValidImageInsertionContext,
  isValidInsertImageOperation,
  resolveHeroVisual,
  resolveSectionVisual,
  resolveVisualDesignIntent,
  selectImageInsertionCandidate,
  type DesignerIntent,
  type DesignerProposal,
  type ImageInsertionBackgroundHostRegion,
  type ImageInsertionBackgroundTarget,
  type ImageInsertionCandidate,
  type ImageInsertionContext,
  type ImageInsertionHeroTarget,
  type ImageInsertionSectionTarget,
  type InsertImageOperation,
  type VisualAssetCandidate,
  type VisualDesignIntent,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { SupabaseStorageStore } from '../infra/mediaStorage.js';
import { AIService } from './aiService.js';
import { ContentService } from './contentService.js';
import { MediaService } from './mediaService.js';
import { acquireExternalImage } from './externalImageAcquisition.js';
import { acquireGeneratedImage, imageGenerationModel } from './imageGenerationAcquisition.js';

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

/**
 * The section addressed by the transmitted context: the editor's dedicated
 * section hint when present, or a section target used directly as the location
 * (API callers and tests). Null when the context names no section at all.
 */
function sectionTargetOf(context: ImageInsertionContext): ImageInsertionSectionTarget | null {
  if (context.sectionTarget) return context.sectionTarget;
  return context.target.kind === 'section' ? context.target : null;
}

/**
 * The hero addressed by the transmitted context: the editor's dedicated hero hint
 * when present, or a hero target used directly as the location (API callers and
 * tests). Null when the context names no hero at all.
 */
function heroTargetOf(context: ImageInsertionContext): ImageInsertionHeroTarget | null {
  if (context.heroTarget) return context.heroTarget;
  return context.target.kind === 'hero' ? context.target : null;
}

/**
 * The host region a background request addresses: the editor's dedicated
 * background hint when present, or a section/hero target used directly as the
 * location. Null when the context names no host region at all.
 */
function backgroundTargetOf(context: ImageInsertionContext): ImageInsertionBackgroundTarget | null {
  if (context.backgroundTarget) return context.backgroundTarget;
  return context.target.kind === 'section' || context.target.kind === 'hero' ? context.target : null;
}

/**
 * The concrete host target for a background in `region`: the editor's background
 * hint when it already names that region, otherwise the section/hero hint the
 * editor sent (both are always transmitted). Null when the region cannot be
 * resolved, so the caller asks instead of guessing.
 */
function backgroundHostTargetFor(
  context: ImageInsertionContext,
  region: ImageInsertionBackgroundHostRegion,
  hint: ImageInsertionBackgroundTarget | null,
): ImageInsertionBackgroundTarget | null {
  if (hint && hint.kind === region) return hint;
  if (region === 'hero') return context.heroTarget ?? null;
  return context.sectionTarget ?? null;
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
    const resolution = resolveVisualDesignIntent(intent.instruction, context);
    if (resolution.status === 'needs_clarification') {
      throw new ApiError(422, 'visual_intent_needs_clarification', resolution.question, {
        roles: resolution.candidates.map((candidate) => candidate.role),
      });
    }
    if (resolution.status === 'unsupported') {
      // R4.4: a background with a layout placement the editor cannot host (e.g.
      // overlay) is a placement refusal, not an unrecognized instruction.
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
    const instructionSubject = imageSubjectFromInstruction(intent.instruction);
    const visual: VisualDesignIntent =
      instructionSubject && instructionSubject !== resolution.intent.subject
        ? { ...resolution.intent, subject: instructionSubject }
        : resolution.intent;
    if (!isVisualIntentInsertable(visual)) {
      throw new ApiError(
        422,
        'visual_role_unsupported',
        `A ${visual.role} visual is not supported in the editor yet.`,
        { role: visual.role },
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

    const section = visual.role === 'section' ? this.resolveSectionTarget(context, visual) : null;
    const hero = visual.role === 'hero' ? this.resolveHeroTarget(context, visual) : null;
    const background =
      visual.role === 'background' ? this.resolveBackgroundTarget(context, visual, resolution.hostRegion) : null;
    const located = section ?? hero ?? background;
    const operationTarget = located ? located.target : context.target;
    const effectiveContext = located ? located.context : context;

    const mediaService = new MediaService(this.container.sb, new SupabaseStorageStore(this.container.sb));
    const media = await mediaService.list(projectId);
    const selection = selectImageInsertionCandidate(effectiveContext, media.map(toVisualCandidate), {
      visual,
      ...(instructionSubject ? { subject: instructionSubject } : {}),
    });

    let image: ImageInsertionCandidate | null = null;
    let rationale: string | undefined;
    let externalError: ApiError | null = null;
    if (selection) {
      const item = media.find((entry) => entry.id === selection.candidate.mediaId);
      if (!item) {
        throw new ApiError(422, 'image_insertion_no_candidate', 'The selected image is no longer in the media library.');
      }
      image = {
        assetId: item.id,
        url: item.url,
        alt: imageInsertionAltForIntent(visual, item.alt_text, item.filename),
        ...(item.caption ? { caption: item.caption } : {}),
        ...(item.width !== null ? { width: item.width } : {}),
        ...(item.height !== null ? { height: item.height } : {}),
        ...(item.source && item.source !== 'upload' ? { source: imageSourceKindOf(item.source) } : {}),
      };
      rationale = selection.rationale;
    } else if (context.sourcePolicy?.allowExternalSearch) {
      // R4.5A: local-first fallback. Only reached when the library has no
      // suitable asset and the caller explicitly allowed external search; the
      // acquired asset is persisted as a normal library row before insertion.
      // A failure is remembered, not fatal, so a permitted generation can still
      // offer a confirmed source below.
      try {
        image = await acquireExternalImage({
          provider: this.container.registry?.getMedia('unsplash'),
          context: effectiveContext,
          ...(instructionSubject ? { subject: instructionSubject } : {}),
          visual,
          projectId,
          persist: (input) => mediaService.importExternal(projectId, null, input),
        });
        rationale = 'Selected a stock photo for the surrounding text.';
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        externalError = err;
      }
    }

    const policy = context.sourcePolicy;
    if (!image && policy?.allowGeneration) {
      const credentials = await new AIService(this.container).resolveImageGeneration(projectId);
      if (!credentials.configured) {
        throw new ApiError(
          422,
          'image_generation_not_configured',
          'Image generation is not configured. Add an OpenAI API key to enable it.',
        );
      }
      if (policy.requireGenerationConfirmation && !context.generationConfirmed) {
        // R4.5B case 3: generation is available but the user has not confirmed
        // it. Return a *successful* proposal asking for that explicit action; the
        // confirmed rerun performs the generation. Nothing is spent here.
        const acquisitionProposal: DesignerProposal = {
          version: DESIGNER_PROPOSAL_VERSION,
          baseRevision,
          document: editorDocumentToCanonical(content.content_json),
          acquisition: {
            kind: 'generation_required',
            provider: 'openai',
            model: imageGenerationModel(this.container.config.env.OPENAI_IMAGE_MODEL),
          },
        };
        if (!isValidDesignerProposal(acquisitionProposal)) {
          throw new ApiError(500, 'designer_proposal_invalid', 'The Agent produced an invalid proposal.');
        }
        return acquisitionProposal;
      }
      // R4.5B case 4: the user explicitly confirmed generation for this run.
      image = await acquireGeneratedImage({
        projectId,
        context: effectiveContext,
        ...(instructionSubject ? { subject: instructionSubject } : {}),
        visual,
        apiKey: credentials.apiKey,
        baseUrl: this.container.config.env.OPENAI_BASE_URL,
        model: this.container.config.env.OPENAI_IMAGE_MODEL,
        persist: (input) => mediaService.importExternal(projectId, null, input),
      });
      rationale = 'Generated an image for the surrounding text.';
    }

    if (!image) {
      if (externalError) throw externalError;
      const scope = section ? 'this section' : hero ? 'this hero' : background ? 'this background' : 'this text';
      throw new ApiError(
        422,
        'image_insertion_no_candidate',
        `No existing image in this project matches ${scope} closely enough.`,
      );
    }

    const operation: InsertImageOperation = {
      type: 'insert_image',
      target: operationTarget,
      image,
      visual,
      ...(rationale ? { rationale } : {}),
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

  /**
   * Resolves the section context for a `section` visual, or fails honestly.
   *
   * A section image needs a heading-anchored location and section-level copy, so
   * this refuses (never guesses) when the editor sent no section target, the
   * heading can no longer be found, or the section already contains an image
   * (R4.2 does not silently duplicate a visual). The returned context carries the
   * section heading and bounded body so ranking reasons about the whole section,
   * not only the selected sentence.
   */
  private resolveSectionTarget(
    context: ImageInsertionContext,
    visual: VisualDesignIntent,
  ): { target: ImageInsertionSectionTarget; context: ImageInsertionContext } {
    const sectionTarget = sectionTargetOf(context);
    if (!sectionTarget) {
      throw new ApiError(
        422,
        'section_target_unresolved',
        "I couldn't find a section to place the image in. Put the cursor under a section heading and try again.",
      );
    }
    if (visual.placement !== undefined && visual.placement !== IMAGE_INSERTION_SECTION_PLACEMENT) {
      throw new ApiError(
        422,
        'visual_placement_unsupported',
        `A ${visual.placement} section image is not supported in the editor yet.`,
        { placement: visual.placement },
      );
    }
    const section = resolveSectionVisual(context.document, sectionTarget);
    if (!section) {
      throw new ApiError(
        422,
        'section_target_unresolved',
        "I couldn't find that section in the document any more. Put the cursor under a section heading and try again.",
      );
    }
    if (section.hasImage) {
      throw new ApiError(
        422,
        'section_image_already_present',
        'This section already has an image. Remove or replace it first, then ask again.',
      );
    }
    const target: ImageInsertionSectionTarget = {
      kind: 'section',
      sectionPath: section.sectionPath,
      anchorPath: section.anchorPath,
      heading: section.heading,
    };
    return {
      target,
      context: { ...context, target, sectionHeading: section.heading, nearbyText: section.body },
    };
  }

  /**
   * Resolves the hero context for a `hero` visual, or fails honestly.
   *
   * A hero image needs a heading-anchored location and hero-level copy, so this
   * refuses (never guesses) when the editor sent no hero target, the heading can
   * no longer be found, or the hero already contains an image (R4.3 does not
   * silently duplicate or replace a visual). The returned context carries the
   * hero heading and bounded supporting copy so ranking reasons about the whole
   * hero, not only the selected sentence. A placement other than the supported
   * full-bleed is refused rather than downgraded into a section image.
   */
  private resolveHeroTarget(
    context: ImageInsertionContext,
    visual: VisualDesignIntent,
  ): { target: ImageInsertionHeroTarget; context: ImageInsertionContext } {
    const heroTarget = heroTargetOf(context);
    if (!heroTarget) {
      throw new ApiError(
        422,
        'hero_target_unresolved',
        "I couldn't find a hero area on this page. Add a hero section or a heading at the top and try again.",
      );
    }
    if (visual.placement !== undefined && visual.placement !== IMAGE_INSERTION_HERO_PLACEMENT) {
      throw new ApiError(
        422,
        'visual_placement_unsupported',
        `A ${visual.placement} hero image is not supported in the editor yet.`,
        { placement: visual.placement },
      );
    }
    const hero = resolveHeroVisual(context.document, heroTarget);
    if (!hero) {
      throw new ApiError(
        422,
        'hero_target_unresolved',
        "I couldn't find that hero in the document any more. Put the cursor in the hero and try again.",
      );
    }
    if (hero.hasImage) {
      throw new ApiError(
        422,
        'hero_image_already_present',
        'This hero already has an image. Remove or replace it first, then ask again.',
      );
    }
    const target: ImageInsertionHeroTarget = {
      kind: 'hero',
      heroPath: hero.heroPath,
      anchorPath: hero.anchorPath,
      nodeType: hero.nodeType,
      placement: IMAGE_INSERTION_HERO_PLACEMENT,
      heading: hero.heading,
      supportingText: hero.supportingText,
    };
    return {
      target,
      context: { ...context, target, sectionHeading: hero.heading, nearbyText: hero.supportingText },
    };
  }

  /**
   * Resolves the host region for a `background` visual, or fails honestly.
   *
   * A background is a real image block hosted in a section or the hero (never a
   * CSS `background-image`). The host region is the instruction's explicit cue
   * when it named one, otherwise the editor's background/section/hero hint. This
   * refuses (never guesses) when no host region can be resolved, the host heading
   * can no longer be found, or the host already contains an image (R4.4 does not
   * silently duplicate or replace). The returned context carries the host heading
   * and bounded body/supporting copy so ranking reasons about the whole region. A
   * placement other than the supported full-bleed is refused rather than
   * downgraded into a section/hero image.
   */
  private resolveBackgroundTarget(
    context: ImageInsertionContext,
    visual: VisualDesignIntent,
    hostRegion: ImageInsertionBackgroundHostRegion | undefined,
  ): { target: ImageInsertionBackgroundTarget; context: ImageInsertionContext } {
    if (visual.placement !== undefined && visual.placement !== IMAGE_INSERTION_BACKGROUND_PLACEMENT) {
      throw new ApiError(
        422,
        'visual_placement_unsupported',
        `A ${visual.placement} background is not supported in the editor yet.`,
        { placement: visual.placement },
      );
    }
    const hint = backgroundTargetOf(context);
    const region = hostRegion ?? hint?.kind;
    if (!region) {
      throw new ApiError(
        422,
        'background_target_unresolved',
        "I couldn't find a section or hero to place the background in. Put the cursor in a section or the hero and try again.",
      );
    }
    const host = backgroundHostTargetFor(context, region, hint);
    if (!host) {
      throw new ApiError(
        422,
        'background_target_unresolved',
        "I couldn't find that section or hero in the document any more. Put the cursor there and try again.",
      );
    }

    if (region === 'hero') {
      const hero = resolveHeroVisual(context.document, host as ImageInsertionHeroTarget);
      if (!hero) {
        throw new ApiError(
          422,
          'background_target_unresolved',
          "I couldn't find that hero in the document any more. Put the cursor in the hero and try again.",
        );
      }
      if (hero.hasImage) {
        throw new ApiError(
          422,
          'background_image_already_present',
          'This hero already has an image. Remove or replace it first, then ask again.',
        );
      }
      const target: ImageInsertionHeroTarget = {
        kind: 'hero',
        heroPath: hero.heroPath,
        anchorPath: hero.anchorPath,
        nodeType: hero.nodeType,
        placement: IMAGE_INSERTION_HERO_PLACEMENT,
        heading: hero.heading,
        supportingText: hero.supportingText,
      };
      return {
        target,
        context: { ...context, target, sectionHeading: hero.heading, nearbyText: hero.supportingText },
      };
    }

    const section = resolveSectionVisual(context.document, host as ImageInsertionSectionTarget);
    if (!section) {
      throw new ApiError(
        422,
        'background_target_unresolved',
        "I couldn't find that section in the document any more. Put the cursor under a section heading and try again.",
      );
    }
    if (section.hasImage) {
      throw new ApiError(
        422,
        'background_image_already_present',
        'This section already has an image. Remove or replace it first, then ask again.',
      );
    }
    const target: ImageInsertionSectionTarget = {
      kind: 'section',
      sectionPath: section.sectionPath,
      anchorPath: section.anchorPath,
      heading: section.heading,
    };
    return {
      target,
      context: { ...context, target, sectionHeading: section.heading, nearbyText: section.body },
    };
  }
}
