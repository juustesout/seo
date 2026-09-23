import { describe, expect, it } from 'vitest';
import { contentRevisionOf, type TipDoc } from '@seo/contracts';
import { documentRevisionOf, workspaceRevisionOf, workspaceSnapshotOf } from './documentRevision';

const DOC_A: TipDoc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha' }] }],
};

const DOC_B: TipDoc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bravo' }] }],
};

const BASE = {
  doc: DOC_A,
  title: 'Title',
  status: 'draft',
  targetKeyword: 'seo',
  metaTitle: 'Meta',
  metaDescription: 'Description',
};

describe('documentRevisionOf', () => {
  it('is the same canonical revision the contracts module derives', () => {
    expect(documentRevisionOf(DOC_A)).toBe(contentRevisionOf(DOC_A));
    expect(documentRevisionOf(DOC_A)).toMatch(/^rev1:[0-9a-f]{16}$/);
  });

  it('changes when the document changes and is stable when it does not', () => {
    expect(documentRevisionOf(DOC_A)).not.toBe(documentRevisionOf(DOC_B));
    expect(documentRevisionOf({ ...DOC_A })).toBe(documentRevisionOf(DOC_A));
  });
});

describe('workspaceRevisionOf', () => {
  it('is stable for identical workspace state', () => {
    expect(workspaceRevisionOf({ ...BASE })).toBe(workspaceRevisionOf({ ...BASE }));
  });

  it('changes when the document changes, like the document revision', () => {
    expect(workspaceRevisionOf(BASE)).not.toBe(workspaceRevisionOf({ ...BASE, doc: DOC_B }));
  });

  it('changes on a metadata-only edit even though the document revision does not', () => {
    const metadataEdited = { ...BASE, title: 'Another title' };
    expect(documentRevisionOf(metadataEdited.doc)).toBe(documentRevisionOf(BASE.doc));
    expect(workspaceRevisionOf(metadataEdited)).not.toBe(workspaceRevisionOf(BASE));
  });

  it('embeds the document revision so the two cannot diverge', () => {
    const sameDoc = { ...BASE, metaDescription: 'Other description' };
    expect(documentRevisionOf(sameDoc.doc)).toBe(documentRevisionOf(BASE.doc));
    expect(workspaceRevisionOf(sameDoc)).not.toBe(workspaceRevisionOf(BASE));
    expect(workspaceRevisionOf({ ...BASE, doc: DOC_B })).not.toBe(workspaceRevisionOf(BASE));
  });
});

describe('workspaceSnapshotOf', () => {
  it('serializes the exact payload autosave persists', () => {
    const snapshot = workspaceSnapshotOf(BASE);
    expect(JSON.parse(snapshot)).toEqual({
      t: 'Title',
      s: 'draft',
      d: DOC_A,
      k: 'seo',
      mt: 'Meta',
      md: 'Description',
    });
    expect(workspaceSnapshotOf({ ...BASE })).toBe(snapshot);
    expect(workspaceSnapshotOf({ ...BASE, status: 'published' })).not.toBe(snapshot);
  });
});
