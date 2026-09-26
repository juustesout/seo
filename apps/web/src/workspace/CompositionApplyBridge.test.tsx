/**
 * R5.4.3.2: the Composer -> open document apply bridge.
 *
 * The bridge is the only place a composed page reaches the open document. These
 * tests pin its contract with a real Tiptap editor and the real
 * `EditorContextProvider`: it applies through the single external-document
 * mutation path, refuses to write to a document the session has left, and waits
 * for the editor instead of dropping the staged composition.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { CANONICAL_DOCUMENT_VERSION, tiptapEmptyDoc, type CanonicalDocument } from '@seo/contracts';
import { createEditorExtensions } from '../components/content/editor/extensions';
import { EditorContextProvider } from '../components/content/editor/EditorContext';
import { EditorSelectionProvider } from '../components/content/editor/EditorSelectionContext';
import { documentRevisionOf } from '../components/content/documentRevision';
import type { WorkspaceSessionValue } from './workspaceSession';
import { WorkspaceSessionProvider } from './workspaceSession';
import {
  CompositionApplyBridge,
  pendingAppendCompositionOf,
  pendingCompositionOf,
  type CompositionApplyOutcome,
  type PendingComposition,
} from './CompositionApplyBridge';

const EMPTY = tiptapEmptyDoc();

const EXISTING: CanonicalDocument = {
  version: CANONICAL_DOCUMENT_VERSION,
  blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Existing content' }] }],
};

const APPEND_OPERATIONS = [
  { type: 'insert_section' as const, ref: 'section-1', section: { kind: 'section' as const }, position: { mode: 'document_end' as const } },
  {
    type: 'insert_text' as const,
    target: { mode: 'ref' as const, ref: 'section-1' },
    block: { type: 'heading' as const, level: 1 as const, text: 'Composed heading' },
  },
  {
    type: 'insert_text' as const,
    target: { mode: 'ref' as const, ref: 'section-1' },
    block: { type: 'paragraph' as const, text: 'Body copy' },
  },
];

const COMPOSED: CanonicalDocument = {
  version: CANONICAL_DOCUMENT_VERSION,
  blocks: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Composed heading' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Body copy' }] },
  ],
};

const STALE_REVISION = 'rev1:0000000000000000';
const CURRENT_BOUNDARY = 'doc-1#4';

const editors: Editor[] = [];

function makeEditor(): Editor {
  const editor = new Editor({ extensions: createEditorExtensions({ nodeViews: false }), content: EMPTY });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  while (editors.length > 0) editors.pop()!.destroy();
});

function sessionStub(boundary: string): WorkspaceSessionValue {
  return {
    projectId: 'p1',
    role: 'editor',
    session: { identity: { documentId: 'doc-1', creating: false }, boundary, hasDocument: true },
  } as unknown as WorkspaceSessionValue;
}

function Bridge({
  editor,
  ready = true,
  pending,
  onResult,
  boundary = CURRENT_BOUNDARY,
}: {
  editor: Editor;
  ready?: boolean;
  pending: PendingComposition | null;
  onResult: (outcome: CompositionApplyOutcome) => void;
  boundary?: string;
}) {
  return (
    <WorkspaceSessionProvider value={sessionStub(boundary)}>
      <EditorSelectionProvider editor={editor}>
        <EditorContextProvider projectId="p1" contentId="doc-1" ready doc={EMPTY} dirty={false} editor={editor}>
          <CompositionApplyBridge pending={pending} ready={ready} onResult={onResult} />
        </EditorContextProvider>
      </EditorSelectionProvider>
    </WorkspaceSessionProvider>
  );
}

describe('CompositionApplyBridge', () => {
  it('applies a composed document to the open document through the editor', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    render(
      <Bridge
        editor={editor}
        pending={pendingCompositionOf(COMPOSED, documentRevisionOf(EMPTY), CURRENT_BOUNDARY)}
        onResult={onResult}
      />,
    );

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult).toHaveBeenCalledWith({ status: 'applied' });
    expect(editor.getText()).toContain('Composed heading');
    expect(editor.getText()).toContain('Body copy');
  });

  it('refuses to write when the session document boundary moved', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    render(
      <Bridge
        editor={editor}
        pending={pendingCompositionOf(COMPOSED, documentRevisionOf(EMPTY), 'other#9')}
        onResult={onResult}
      />,
    );

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'stale-document' }));
    expect(editor.getText()).not.toContain('Composed heading');
  });

  it('refuses a base revision that no longer matches the live document', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    render(
      <Bridge
        editor={editor}
        pending={pendingCompositionOf(COMPOSED, STALE_REVISION, CURRENT_BOUNDARY)}
        onResult={onResult}
      />,
    );

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'stale-document' }));
    expect(editor.getText()).not.toContain('Composed heading');
  });

  it('waits for the editor before applying instead of dropping the composition', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    const pending = pendingCompositionOf(COMPOSED, documentRevisionOf(EMPTY), CURRENT_BOUNDARY);
    const { rerender } = render(<Bridge editor={editor} ready={false} pending={pending} onResult={onResult} />);

    expect(onResult).not.toHaveBeenCalled();

    rerender(<Bridge editor={editor} ready pending={pending} onResult={onResult} />);
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'applied' }));
    expect(editor.getText()).toContain('Composed heading');
  });

  it('appends an append proposal through the document operation path', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    render(
      <Bridge
        editor={editor}
        pending={pendingAppendCompositionOf(EXISTING, APPEND_OPERATIONS, documentRevisionOf(EMPTY), CURRENT_BOUNDARY)}
        onResult={onResult}
      />,
    );

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'applied' }));
    expect(editor.getText()).toContain('Composed heading');
    expect(editor.getText()).toContain('Body copy');
    // Operations were applied to the live document, not replaced with the base.
    expect(editor.getText()).not.toContain('Existing content');
  });

  it('refuses to append when the session document boundary moved', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    render(
      <Bridge
        editor={editor}
        pending={pendingAppendCompositionOf(EXISTING, APPEND_OPERATIONS, documentRevisionOf(EMPTY), 'other#9')}
        onResult={onResult}
      />,
    );

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'stale-document' }));
    expect(editor.getText()).not.toContain('Composed heading');
  });

  it('refuses an append whose base revision no longer matches the live document', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    render(
      <Bridge
        editor={editor}
        pending={pendingAppendCompositionOf(EXISTING, APPEND_OPERATIONS, STALE_REVISION, CURRENT_BOUNDARY)}
        onResult={onResult}
      />,
    );

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'stale-document' }));
    expect(editor.getText()).not.toContain('Composed heading');
  });
});
