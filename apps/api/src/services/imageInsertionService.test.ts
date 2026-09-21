/**
 * Image insertion service tests (R3.1).
 *
 * The service is the Editor-native bridge between a transmitted editor context
 * and the existing Designer proposal envelope. These tests pin the contract:
 * it only ever selects an existing project asset, it is revision-guarded, it
 * fails honestly when nothing matches, and it never writes content.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../context.js';
import type { CanonicalDocument, DesignerIntent, ImageInsertionContext } from '@seo/contracts';
import { canonicalDocumentToEditorDocument, contentRevisionOf, editorDocumentToCanonical } from '@seo/contracts';
import { ImageInsertionService, imageInsertionContextOf } from './imageInsertionService.js';

const mock = vi.hoisted(() => ({
  contentJson: null as unknown,
  getCalls: 0,
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
  mediaListCalls: [] as string[],
}));

vi.mock('./contentService.js', () => ({
  ContentService: class {
    async get() {
      mock.getCalls += 1;
      return { id: 'c1', content_json: mock.contentJson };
    }
  },
}));

vi.mock('./mediaService.js', () => ({
  MediaService: class {
    async list(projectId: string) {
      mock.mediaListCalls.push(projectId);
      return mock.media;
    }
  },
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
    instruction: 'Zet hier een passende afbeelding.',
    projectId: PROJECT_ID,
    contentId: CONTENT_ID,
    ...over,
  };
}

const container = { sb: {} } as unknown as ServiceContainer;
const service = new ImageInsertionService(container);

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
  mock.getCalls = 0;
  mock.mediaListCalls = [];
  mock.media = [
    {
      id: 'm_solar',
      filename: 'solar-panels.png',
      mime_type: 'image/png',
      url: 'https://cdn.test/solar-panels.png',
      alt_text: 'Solar panels on a roof',
      caption: 'Clean energy',
      width: 1600,
      height: 900,
      usage_count: 0,
    },
    {
      id: 'm_team',
      filename: 'team.jpg',
      mime_type: 'image/jpeg',
      url: 'https://cdn.test/team.jpg',
      alt_text: 'Our installation team',
      caption: '',
      width: 1200,
      height: 800,
      usage_count: 0,
    },
  ];
});

describe('imageInsertionContextOf', () => {
  it('reads a valid context out of the opaque intent selection and rejects malformed ones', () => {
    expect(imageInsertionContextOf(intent({ context: { selection: context() } }))?.revision).toBe(
      contentRevisionOf(editorDocument),
    );
    expect(imageInsertionContextOf(intent())).toBeNull();
    expect(imageInsertionContextOf(intent({ context: { selection: { revision: '' } } }))).toBeNull();
  });
});

describe('ImageInsertionService.buildProposal', () => {
  it('builds a revision-guarded insert_image proposal from an existing asset', async () => {
    const proposal = await service.buildProposal(PROJECT_ID, intent(), context());
    expect(proposal.baseRevision).toBe(contentRevisionOf(editorDocument));
    expect(proposal.document).toEqual(editorDocumentToCanonical(editorDocument));
    expect(proposal.insertion?.type).toBe('insert_image');
    expect(proposal.insertion?.image).toMatchObject({
      assetId: 'm_solar',
      url: 'https://cdn.test/solar-panels.png',
      alt: 'Solar panels on a roof',
      caption: 'Clean energy',
      width: 1600,
      height: 900,
    });
    expect(proposal.insertion?.target).toEqual({ kind: 'cursor', position: 3 });
    expect(mock.mediaListCalls).toEqual([PROJECT_ID]);
  });

  it('falls back to the filename when alt text is empty', async () => {
    mock.media = [{ ...mock.media[0]!, alt_text: '' }];
    const proposal = await service.buildProposal(PROJECT_ID, intent(), context());
    expect(proposal.insertion?.image.alt).toBe('solar-panels.png');
  });

  it('refuses an instruction that is not an image insertion', async () => {
    const err = await expectApiError(
      service.buildProposal(PROJECT_ID, intent({ instruction: 'Tighten the introduction' }), context()),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('image_insertion_unrecognized_instruction');
    expect(mock.getCalls).toBe(0);
  });

  it('requires a saved document', async () => {
    const err = await expectApiError(service.buildProposal(PROJECT_ID, intent({ contentId: undefined }), context()));
    expect(err.status).toBe(422);
    expect(err.code).toBe('image_insertion_requires_saved_document');
  });

  it('refuses a stale editor context before selecting an asset', async () => {
    const err = await expectApiError(
      service.buildProposal(PROJECT_ID, intent(), context({ revision: 'rev1:0000000000000000' })),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe('stale_editor_context');
    expect(mock.mediaListCalls).toEqual([]);
  });

  it('reports honestly when no existing asset matches', async () => {
    const err = await expectApiError(
      service.buildProposal(PROJECT_ID, intent(), context({ nearbyText: 'quarterly finance report' })),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('image_insertion_no_candidate');
  });
});
