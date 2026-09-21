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
import type { CanonicalDocument, DesignerIntent, ImageInsertionContext, ImageInsertionSectionTarget } from '@seo/contracts';
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

describe('ImageInsertionService visual intent (R4.1)', () => {
  it('resolves and preserves the visual role on the operation', async () => {
    const proposal = await service.buildProposal(
      PROJECT_ID,
      intent({ instruction: 'Voeg een illustratie toe die dit uitlegt.' }),
      context(),
    );
    expect(proposal.insertion?.visual).toMatchObject({ role: 'illustration', intent: 'explain' });
    expect(mock.mediaListCalls).toEqual([PROJECT_ID]);
  });

  it('marks a decorative insertion as non-descriptive (empty alt)', async () => {
    const proposal = await service.buildProposal(
      PROJECT_ID,
      intent({ instruction: 'Plaats hier een decoratieve afbeelding.' }),
      context(),
    );
    expect(proposal.insertion?.visual?.role).toBe('decorative');
    expect(proposal.insertion?.image.alt).toBe('');
  });

  it('refuses a role the editor cannot host yet, before reading content', async () => {
    const err = await expectApiError(
      service.buildProposal(PROJECT_ID, intent({ instruction: 'Maak de hero sterker.' }), context()),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('visual_role_unsupported');
    expect(mock.getCalls).toBe(0);
  });

  it('asks for clarification when several roles are named', async () => {
    const err = await expectApiError(
      service.buildProposal(PROJECT_ID, intent({ instruction: 'Voeg een hero en een achtergrond toe.' }), context()),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('visual_intent_needs_clarification');
    expect(mock.getCalls).toBe(0);
  });

  it('routes an illustration instruction through the role-aware ranker', async () => {
    mock.media = [
      { ...mock.media[0]!, id: 'm_portrait', filename: 'solar-portrait.png', width: 900, height: 1600 },
      { ...mock.media[0]!, id: 'm_landscape', filename: 'solar-landscape.png', width: 1600, height: 900 },
    ];
    const proposal = await service.buildProposal(
      PROJECT_ID,
      intent({ instruction: 'Voeg een illustratie toe die dit uitlegt.' }),
      context(),
    );
    expect(proposal.insertion?.image.assetId).toBe('m_landscape');
  });
});

const SECTION_CANONICAL: CanonicalDocument = {
  version: 1,
  meta: { title: 'Solar for every roof' },
  blocks: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Solar energy' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'We cover residential roofs.' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Wind power' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Turbines capture wind.' }] },
  ],
};

const SECTION_TARGET: ImageInsertionSectionTarget = {
  kind: 'section',
  sectionPath: [0],
  anchorPath: [0],
  heading: 'Solar energy',
};

function sectionContext(over: Partial<ImageInsertionContext> = {}): ImageInsertionContext {
  return context({
    document: SECTION_CANONICAL,
    target: { kind: 'cursor', position: 3 },
    sectionTarget: { ...SECTION_TARGET },
    nearbyText: '',
    sectionHeading: 'Solar energy',
    ...over,
  });
}

describe('ImageInsertionService section visuals (R4.2)', () => {
  it('builds a section-targeted insertion after the section heading', async () => {
    const proposal = await service.buildProposal(
      PROJECT_ID,
      intent({ instruction: 'Geef deze sectie een passende afbeelding.' }),
      sectionContext(),
    );
    expect(proposal.insertion?.visual).toMatchObject({ role: 'section', intent: 'reinforce', placement: 'contained' });
    expect(proposal.insertion?.target).toEqual({ kind: 'section', sectionPath: [0], anchorPath: [0], heading: 'Solar energy' });
    expect(proposal.insertion?.image.assetId).toBe('m_solar');
  });

  it('uses the section heading and body to drive the search, not only the sentence', async () => {
    mock.media = [
      { ...mock.media[0]!, id: 'm_wind', filename: 'wind.png', alt_text: 'Wind turbines', caption: '' },
      { ...mock.media[0]!, id: 'm_solar', filename: 'solar.png', alt_text: 'Solar panels', caption: '' },
    ];
    const proposal = await service.buildProposal(
      PROJECT_ID,
      intent({ instruction: 'Geef deze sectie een afbeelding.' }),
      sectionContext({ documentTitle: 'Installation guide' }),
    );
    expect(proposal.insertion?.image.assetId).toBe('m_solar');
  });

  it('refuses a section request with no resolvable section target', async () => {
    const err = await expectApiError(
      service.buildProposal(
        PROJECT_ID,
        intent({ instruction: 'Geef deze sectie een passende afbeelding.' }),
        context({ sectionHeading: 'Solar energy' }),
      ),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('section_target_unresolved');
    expect(mock.mediaListCalls).toEqual([]);
  });

  it('refuses a section target whose heading no longer exists', async () => {
    const err = await expectApiError(
      service.buildProposal(
        PROJECT_ID,
        intent({ instruction: 'Geef deze sectie een passende afbeelding.' }),
        sectionContext({ sectionTarget: { kind: 'section', sectionPath: [1], anchorPath: [1], heading: 'Solar energy' } }),
      ),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('section_target_unresolved');
  });

  it('refuses to add a second image to a section that already has one', async () => {
    const withImage: CanonicalDocument = {
      version: 1,
      blocks: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Solar energy' }] },
        { type: 'image', attrs: { mediaId: 'm_existing', src: 'https://cdn.test/a.png', alt: 'Panels' } },
      ],
    };
    const err = await expectApiError(
      service.buildProposal(
        PROJECT_ID,
        intent({ instruction: 'Geef deze sectie een passende afbeelding.' }),
        sectionContext({ document: withImage }),
      ),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('section_image_already_present');
  });

  it('refuses a section placement it cannot host', async () => {
    const err = await expectApiError(
      service.buildProposal(
        PROJECT_ID,
        intent({ instruction: 'Geef deze sectie een afbeelding op volledige breedte.' }),
        sectionContext(),
      ),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('visual_placement_unsupported');
  });

  it('asks for clarification for a plural section request', async () => {
    const err = await expectApiError(
      service.buildProposal(
        PROJECT_ID,
        intent({ instruction: 'Voeg ondersteunende beelden toe aan deze sectie.' }),
        sectionContext(),
      ),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('visual_intent_needs_clarification');
    expect(mock.getCalls).toBe(0);
  });
});
