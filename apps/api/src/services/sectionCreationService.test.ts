/**
 * Section creation service tests (Part B Slice 2).
 *
 * The service builds one operation batch from a create-a-new-hero/section
 * instruction: it resolves semantic placement into a concrete path, reuses the
 * shared image acquisition seam, never invents a title, and never writes
 * content. These tests pin the batch shape, the honest failures and the fact
 * that the executor can actually apply what the service produces.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../context.js';
import type { CanonicalDocument, DesignerIntent, ImageInsertionContext } from '@seo/contracts';
import {
  applyDocumentOperations,
  canonicalDocumentToEditorDocument,
  contentRevisionOf,
  editorDocumentToCanonical,
  isValidCanonicalDoc,
} from '@seo/contracts';
import { SectionCreationService } from './sectionCreationService.js';

const mock = vi.hoisted(() => ({
  contentJson: null as unknown,
  media: [] as Array<{
    id: string;
    filename: string;
    mime_type: string;
    url: string;
    alt_text: string;
    caption: string;
    width: number | null;
    height: number | null;
    usage_count: number;
  }>,
}));

vi.mock('./contentService.js', () => ({
  ContentService: class {
    async get() {
      return { id: 'c1', content_json: mock.contentJson };
    }
  },
}));

vi.mock('./mediaService.js', () => ({
  MEDIA_MAX_BYTES: 8 * 1024 * 1024,
  MediaService: class {
    async list() {
      return mock.media;
    }
  },
}));

vi.mock('./aiService.js', () => ({
  AIService: class {
    async resolveImageGeneration() {
      return { configured: true, apiKey: 'sk-test-key', keySource: 'project' as const };
    }
  },
}));

vi.mock('./externalImageAcquisition.js', () => ({
  acquireExternalImage: async () => {
    throw new Error('external acquisition should not run in these tests');
  },
}));

vi.mock('./imageGenerationAcquisition.js', () => ({
  imageGenerationModel: (override?: string) => (override && override.trim() ? override : 'dall-e-3'),
  acquireGeneratedImage: async () => ({
    assetId: 'm_generated',
    url: 'https://cdn.test/generated.png',
    alt: 'Generated image',
    source: 'openai_generated',
    width: 1024,
    height: 1024,
  }),
}));

vi.mock('../infra/mediaStorage.js', () => ({
  SupabaseStorageStore: class {},
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const CONTENT_ID = '22222222-2222-4222-8222-222222222222';

const canonical: CanonicalDocument = {
  version: 1,
  meta: { title: 'Solar for every roof' },
  blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Solar panels store energy.' }] }],
};
const editorDocument = canonicalDocumentToEditorDocument(canonical);

function context(over: Partial<ImageInsertionContext> = {}): ImageInsertionContext {
  return {
    revision: contentRevisionOf(editorDocument),
    document: canonical,
    target: { kind: 'cursor', position: 3 },
    nearbyText: 'We install solar panels on residential roofs.',
    ...over,
  };
}

function intent(over: Partial<DesignerIntent> = {}): DesignerIntent {
  return {
    instruction: "add a hero section with the title 'Halleluja' and a background image of Amsterdam",
    projectId: PROJECT_ID,
    contentId: CONTENT_ID,
    ...over,
  };
}

const container = { sb: {}, config: { env: {} } } as unknown as ServiceContainer;
const service = new SectionCreationService(container);

async function expectApiError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status: number; code: string };
  }
  throw new Error('Expected the service to throw');
}

beforeEach(() => {
  mock.contentJson = editorDocument;
  mock.media = [
    {
      id: 'm_amsterdam',
      filename: 'amsterdam.png',
      mime_type: 'image/png',
      url: 'https://cdn.test/amsterdam.png',
      alt_text: 'Amsterdam canal houses',
      caption: '',
      width: 1600,
      height: 900,
      usage_count: 0,
    },
  ];
});

describe('SectionCreationService.buildProposal', () => {
  it('builds a hero, heading and image batch and produces an applicable document', async () => {
    const proposal = await service.buildProposal(PROJECT_ID, intent(), context(), {
      kind: 'hero',
      expectsHeading: true,
      heading: 'Halleluja',
    });

    expect(proposal.baseRevision).toBe(contentRevisionOf(editorDocument));
    expect(proposal.document).toEqual(editorDocumentToCanonical(editorDocument));
    expect(proposal.operations?.operations).toEqual([
      { type: 'insert_section', ref: 'section-1', section: { kind: 'hero' }, position: { mode: 'document_start' } },
      {
        type: 'insert_text',
        target: { mode: 'ref', ref: 'section-1', at: 'start' },
        block: { type: 'heading', level: 1, text: 'Halleluja' },
      },
      {
        type: 'insert_image',
        target: { mode: 'ref', ref: 'section-1' },
        image: expect.objectContaining({
          assetId: 'm_amsterdam',
          url: 'https://cdn.test/amsterdam.png',
          width: 1600,
          height: 900,
        }),
        visual: expect.objectContaining({ role: 'background', placement: 'full_bleed' }),
        rationale: expect.any(String),
      },
    ]);

    const applied = applyDocumentOperations(proposal.document, proposal.operations!);
    expect(isValidCanonicalDoc(applied)).toBe(true);
    const hero = applied.blocks[0]!;
    expect(hero.type).toBe('hero');
    expect(hero.children?.map((child) => child.type)).toEqual(['heading', 'image']);
    expect(hero.children?.[0]?.content?.[0]).toEqual({ type: 'text', text: 'Halleluja' });
  });

  it('creates structure only when no image is named', async () => {
    const proposal = await service.buildProposal(
      PROJECT_ID,
      intent({ instruction: "add a hero section with the title 'Welkom'" }),
      context(),
      { kind: 'hero', expectsHeading: true, heading: 'Welkom' },
    );
    expect(proposal.operations?.operations.map((operation) => operation.type)).toEqual(['insert_section', 'insert_text']);
  });

  it('resolves a section placement to a concrete after_block path', async () => {
    const proposal = await service.buildProposal(
      PROJECT_ID,
      intent({ instruction: "add a section titled 'About' with a background image of Amsterdam" }),
      context({
        sectionTarget: { kind: 'section', sectionPath: [0], anchorPath: [0], heading: 'Intro' },
      }),
      { kind: 'section', expectsHeading: true, heading: 'About' },
    );
    const first = proposal.operations?.operations[0];
    expect(first).toMatchObject({ type: 'insert_section', section: { kind: 'section' } });
    expect(first?.type === 'insert_section' ? first.position : null).toEqual({ mode: 'after_block', path: [0] });

    const applied = applyDocumentOperations(proposal.document, proposal.operations!);
    expect(applied.blocks.map((block) => block.type)).toEqual(['paragraph', 'section']);
  });

  it('offers generation instead of a batch when an image cannot be sourced yet', async () => {
    mock.media = [];
    const proposal = await service.buildProposal(
      PROJECT_ID,
      intent({
        instruction: "add a hero section with the title 'Welkom' and an image",
      }),
      context({ sourcePolicy: { allowExternalSearch: false, allowGeneration: true, requireGenerationConfirmation: true } }),
      { kind: 'hero', expectsHeading: true, heading: 'Welkom' },
    );
    expect(proposal.acquisition?.kind).toBe('generation_required');
    expect(proposal.operations).toBeUndefined();
  });

  it('refuses an asked-for title it cannot read', async () => {
    const err = await expectApiError(
      service.buildProposal(PROJECT_ID, intent({ instruction: 'add a hero section with a title' }), context(), {
        kind: 'hero',
        expectsHeading: true,
      }),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('section_heading_unresolved');
  });

  it('refuses an empty section with neither a title nor an image', async () => {
    const err = await expectApiError(
      service.buildProposal(PROJECT_ID, intent({ instruction: 'add a new section' }), context(), {
        kind: 'section',
        expectsHeading: false,
      }),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('section_creation_needs_content');
  });

  it('requires a saved document and a matching revision', async () => {
    const noContent = await expectApiError(
      service.buildProposal(PROJECT_ID, intent({ contentId: undefined }), context(), {
        kind: 'hero',
        expectsHeading: true,
        heading: 'X',
      }),
    );
    expect(noContent.status).toBe(422);
    expect(noContent.code).toBe('section_creation_requires_saved_document');

    const stale = await expectApiError(
      service.buildProposal(PROJECT_ID, intent(), context({ revision: 'rev1:stale' }), {
        kind: 'hero',
        expectsHeading: true,
        heading: 'X',
      }),
    );
    expect(stale.status).toBe(409);
    expect(stale.code).toBe('stale_editor_context');
  });
});
