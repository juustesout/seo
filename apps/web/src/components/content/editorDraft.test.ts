import { describe, expect, it } from 'vitest';
import {
  CANONICAL_DOCUMENT_VERSION,
  canonicalDocumentToEditorDocument,
  isValidCanonicalDoc,
  tiptapEmptyDoc,
  type CanonicalBlock,
  type TipDoc,
} from '@seo/contracts';
import { CONTENT_TITLE_MAX_CHARS, canonicalFromEditorDocument, editorDraftFromCanonical } from './editorDraft';

function doc(blocks: CanonicalBlock[]) {
  return { version: CANONICAL_DOCUMENT_VERSION, blocks };
}

function heading(level: number, text: string): CanonicalBlock {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

describe('editorDraftFromCanonical', () => {
  it('uses the hero heading as the content title', () => {
    const draft = editorDraftFromCanonical(
      doc([
        {
          type: 'hero',
          children: [heading(1, 'Ship SEO faster'), { type: 'paragraph', content: [{ type: 'text', text: 'Intro copy' }] }],
        },
      ]),
      'a fallback brief',
    );
    expect(draft.title).toBe('Ship SEO faster');
    const hero = draft.doc.content?.find((node) => node.type === 'compositionHero');
    expect(hero).toBeTruthy();
    expect(hero?.content?.some((node) => node.type === 'paragraph')).toBe(true);
  });

  it('falls back to the first heading of any level', () => {
    const draft = editorDraftFromCanonical(doc([heading(2, 'Section title')]), 'brief');
    expect(draft.title).toBe('Section title');
  });

  it('falls back to the brief when the document has no headings', () => {
    const draft = editorDraftFromCanonical(
      doc([{ type: 'paragraph', content: [{ type: 'text', text: 'Just a paragraph' }] }]),
      'A user brief',
    );
    expect(draft.title).toBe('A user brief');
  });

  it('bounds the title to the content model limit', () => {
    const draft = editorDraftFromCanonical(doc([heading(1, 'x'.repeat(400))]), 'brief');
    expect(draft.title.length).toBe(CONTENT_TITLE_MAX_CHARS);
  });

  it('does not mutate the canonical document', () => {
    const value = doc([
      {
        type: 'hero',
        children: [heading(1, 'Title'), { type: 'image' }, { type: 'button', content: [{ type: 'text', text: 'Go' }] }],
      },
    ]);
    const before = structuredClone(value);
    editorDraftFromCanonical(value, 'brief');
    expect(value).toEqual(before);
  });
});

describe('canonicalFromEditorDocument (editor save reverse bridge)', () => {
  it('returns a valid canonical document that keeps composition structure', () => {
    const canonical = doc([
      {
        type: 'hero',
        attrs: { variant: 'centered' },
        children: [heading(1, 'Title'), { type: 'paragraph', content: [{ type: 'text', text: 'Intro' }] }],
      },
      {
        type: 'featureGrid',
        attrs: { layout: { columns: 2 } },
        children: [{ type: 'featureCard', attrs: { variant: 'elevated' }, children: [heading(3, 'Fast')] }],
      },
    ]);

    const back = canonicalFromEditorDocument(canonicalDocumentToEditorDocument(canonical));

    expect(isValidCanonicalDoc(back)).toBe(true);
    expect(back.blocks.map((block) => block.type)).toEqual(['hero', 'featureGrid']);
    expect(back.blocks[0]?.attrs).toEqual({ variant: 'centered' });
    expect(back.blocks[1]?.children?.[0]?.attrs).toEqual({ variant: 'elevated' });
  });

  it('saves a document holding a just-inserted image and composition node', () => {
    const editor: TipDoc = {
      type: 'doc',
      content: [
        {
          type: 'compositionHero',
          attrs: { variant: null, layout: null },
          content: [
            { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Halleluja' }] },
            {
              type: 'image',
              attrs: { mediaId: 'media-1', src: 'https://cdn/x.png', alt: '', caption: '', width: null, height: null },
            },
          ],
        },
      ],
    };

    const back = canonicalFromEditorDocument(editor);

    expect(isValidCanonicalDoc(back)).toBe(true);
    const hero = back.blocks[0];
    expect(hero?.type).toBe('hero');
    expect(hero?.children?.[1]).toMatchObject({ type: 'image', attrs: { mediaId: 'media-1' } });
  });

  it('returns a valid canonical document for plain and empty editor documents', () => {    expect(isValidCanonicalDoc(canonicalFromEditorDocument(tiptapEmptyDoc()))).toBe(true);
    expect(
      isValidCanonicalDoc(
        canonicalFromEditorDocument({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }] }),
      ),
    ).toBe(true);
  });

  it('refuses a document the canonical model cannot represent', () => {
    const invalid = { type: 'doc', content: [{ type: '1bad' }] } as unknown as TipDoc;
    expect(() => canonicalFromEditorDocument(invalid)).toThrow(/CanonicalDocument/);
  });
});
