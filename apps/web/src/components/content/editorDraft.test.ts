import { describe, expect, it } from 'vitest';
import { CANONICAL_DOCUMENT_VERSION, type CanonicalBlock } from '@seo/contracts';
import { CONTENT_TITLE_MAX_CHARS, editorDraftFromCanonical } from './editorDraft';

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
