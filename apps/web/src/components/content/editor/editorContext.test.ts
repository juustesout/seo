import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CANONICAL_DOCUMENT_VERSION, contentRevisionOf, type CanonicalDocument, type TipDoc } from '@seo/contracts';
import { canonicalFromEditorDocument } from '../editorDraft';
import { buildEditorContextSnapshot, EMPTY_EDITOR_SELECTION } from './editorContext';

vi.mock('../editorDraft', () => ({ canonicalFromEditorDocument: vi.fn() }));

const mocked = vi.mocked(canonicalFromEditorDocument);

const DOC: TipDoc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
};
const CANONICAL: CanonicalDocument = {
  version: CANONICAL_DOCUMENT_VERSION,
  blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
};

beforeEach(() => {
  mocked.mockReset();
  mocked.mockReturnValue(CANONICAL);
});

describe('buildEditorContextSnapshot', () => {
  it('is inert and does not convert the document while not ready', () => {
    const snapshot = buildEditorContextSnapshot({
      projectId: 'p1',
      contentId: 'c1',
      ready: false,
      doc: DOC,
      dirty: true,
      selection: { type: 'text', from: 1, to: 4 },
    });

    expect(snapshot).toEqual({
      projectId: 'p1',
      contentId: 'c1',
      ready: false,
      document: { canonical: null, unrepresentable: false, revision: null, dirty: false },
      selection: EMPTY_EDITOR_SELECTION,
    });
    expect(mocked).not.toHaveBeenCalled();
  });

  it('reports identity, revision, dirty state and the canonical document when ready', () => {
    const snapshot = buildEditorContextSnapshot({
      projectId: 'p1',
      contentId: 'c1',
      ready: true,
      doc: DOC,
      dirty: true,
      selection: { type: 'cursor', from: 3, to: 3, nodeType: 'paragraph', nodePath: [0] },
    });

    expect(snapshot.projectId).toBe('p1');
    expect(snapshot.contentId).toBe('c1');
    expect(snapshot.ready).toBe(true);
    expect(snapshot.document.canonical).toBe(CANONICAL);
    expect(snapshot.document.unrepresentable).toBe(false);
    expect(snapshot.document.revision).toBe(contentRevisionOf(DOC));
    expect(snapshot.document.dirty).toBe(true);
    expect(snapshot.selection.type).toBe('cursor');
    expect(mocked).toHaveBeenCalledWith(DOC);
  });

  it('keeps the revision but flags an unrepresentable document instead of guessing', () => {
    mocked.mockImplementation(() => {
      throw new Error('unrepresentable');
    });

    const snapshot = buildEditorContextSnapshot({
      projectId: 'p1',
      contentId: null,
      ready: true,
      doc: DOC,
      dirty: false,
      selection: EMPTY_EDITOR_SELECTION,
    });

    expect(snapshot.contentId).toBeNull();
    expect(snapshot.document.canonical).toBeNull();
    expect(snapshot.document.unrepresentable).toBe(true);
    expect(snapshot.document.revision).toBe(contentRevisionOf(DOC));
  });
});
