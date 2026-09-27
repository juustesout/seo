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
import { act, render, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import {
  CANONICAL_DOCUMENT_VERSION,
  DESIGNER_PROPOSAL_VERSION,
  DOCUMENT_OPERATIONS_VERSION,
  composeOperationBatch,
  tiptapEmptyDoc,
  type CanonicalDocument,
  type DesignerProposal,
  type InsertImageOperation,
  type TipDoc,
} from '@seo/contracts';
import { createEditorExtensions } from '../components/content/editor/extensions';
import { EditorContextProvider } from '../components/content/editor/EditorContext';
import { EditorSelectionProvider } from '../components/content/editor/EditorSelectionContext';
import { documentRevisionOf } from '../components/content/documentRevision';
import type { WorkspaceSessionValue } from './workspaceSession';
import { WorkspaceSessionProvider } from './workspaceSession';
import {
  CompositionApplyBridge,
  pendingAppendCompositionFromBatch,
  pendingAppendCompositionOf,
  pendingCompositionOf,
  pendingDesignerMutation,
  type CompositionApplyOutcome,
  type PendingComposition,
} from './CompositionApplyBridge';

const EMPTY = tiptapEmptyDoc();

/** A non-empty editor seed; image insertion needs a real block to anchor to. */
const SEEDED: TipDoc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Existing content' }] }],
};

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

const SECTIONED: CanonicalDocument = {
  version: CANONICAL_DOCUMENT_VERSION,
  blocks: [
    {
      type: 'section',
      children: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Composed heading' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Body copy' }] },
      ],
    },
  ],
};

const STALE_REVISION = 'rev1:0000000000000000';
const CURRENT_BOUNDARY = 'doc-1#4';

const INSERTION: InsertImageOperation = {
  type: 'insert_image',
  target: { kind: 'cursor', position: 1 },
  image: { assetId: 'm_1', url: 'https://cdn.test/x.png', alt: 'X' },
};

/** A representable Designer proposal carrying the existing operation vocabulary. */
function designerOperationsProposal(baseRevision = documentRevisionOf(EMPTY)): DesignerProposal {
  return {
    version: DESIGNER_PROPOSAL_VERSION,
    baseRevision,
    document: EXISTING,
    operations: { version: DOCUMENT_OPERATIONS_VERSION, baseRevision, operations: APPEND_OPERATIONS },
  };
}

/** A representable Designer proposal carrying the existing image insertion. */
function designerInsertionProposal(baseRevision = documentRevisionOf(EMPTY)): DesignerProposal {
  return { version: DESIGNER_PROPOSAL_VERSION, baseRevision, document: EXISTING, insertion: INSERTION };
}

const editors: Editor[] = [];

function makeEditor(content: TipDoc = EMPTY): Editor {
  const editor = new Editor({ extensions: createEditorExtensions({ nodeViews: false }), content });
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

  it('applies a Composer operation batch staged for the bridge', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    const batch = composeOperationBatch(SECTIONED);
    render(
      <Bridge
        editor={editor}
        pending={pendingAppendCompositionFromBatch(batch, EXISTING, documentRevisionOf(EMPTY), CURRENT_BOUNDARY)}
        onResult={onResult}
      />,
    );

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'applied' }));
    expect(editor.getText()).toContain('Composed heading');
    expect(editor.getText()).toContain('Body copy');
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

  it('applies a Designer operation proposal through the document operation path', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    render(
      <Bridge
        editor={editor}
        pending={pendingDesignerMutation(designerOperationsProposal(), 'operations', CURRENT_BOUNDARY, 'doc-1')}
        onResult={onResult}
      />,
    );

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'applied' }));
    expect(editor.getText()).toContain('Composed heading');
    expect(editor.getText()).toContain('Body copy');
  });

  it('applies a Designer insertion proposal through the insertion path', async () => {
    const editor = makeEditor(SEEDED);
    const onResult = vi.fn();
    render(
      <Bridge
        editor={editor}
        pending={pendingDesignerMutation(
          designerInsertionProposal(documentRevisionOf(SEEDED)),
          'insertion',
          CURRENT_BOUNDARY,
          'doc-1',
        )}
        onResult={onResult}
      />,
    );

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'applied' }));
    expect(editor.getJSON()).toEqual(
      expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ type: 'image' })]) }),
    );
  });

  it('refuses a Designer proposal targeting a different document even at the same revision', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    render(
      <Bridge
        editor={editor}
        pending={pendingDesignerMutation(designerOperationsProposal(), 'operations', CURRENT_BOUNDARY, 'other-doc')}
        onResult={onResult}
      />,
    );

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'stale-document' }));
    expect(editor.getText()).not.toContain('Composed heading');
  });

  it('refuses a Designer proposal whose base revision is stale', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    render(
      <Bridge
        editor={editor}
        pending={pendingDesignerMutation(designerInsertionProposal(STALE_REVISION), 'insertion', CURRENT_BOUNDARY, 'doc-1')}
        onResult={onResult}
      />,
    );

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'stale-document' }));
  });

  it('fails a staged mode whose proposal does not carry that instruction', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    // A truly empty proposal body: no operations, no insertion, no document-only
    // replacement should ever be reached for a Designer-mode staging.
    const malformed = {
      version: DESIGNER_PROPOSAL_VERSION,
      baseRevision: documentRevisionOf(EMPTY),
      document: EXISTING,
    } as DesignerProposal;
    render(
      <Bridge
        editor={editor}
        pending={pendingDesignerMutation(malformed, 'insertion', CURRENT_BOUNDARY, 'doc-1')}
        onResult={onResult}
      />,
    );

    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'failed' }));
  });
});

/**
 * R5.6.4: immediate-change hardening. The apply is a normal editor transaction,
 * so these tests pin the behaviour the shell relies on - one undoable step, one
 * emitted update for the existing autosave boundary, and exactly one apply per
 * staged mutation - without introducing any new mechanism. The shell-level
 * "staged while the editor is already mounted" variant is unreachable by
 * construction: staging only happens in Composer/Designer, which unmount the
 * editor (section 8 of `docs/r5.6.0-editor-integration-recon.md`).
 */
describe('CompositionApplyBridge immediate-change hardening (R5.6.4)', () => {
  it('applies the composed document as one undoable, redoable transaction', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    render(
      <Bridge
        editor={editor}
        pending={pendingCompositionOf(COMPOSED, documentRevisionOf(EMPTY), CURRENT_BOUNDARY)}
        onResult={onResult}
      />,
    );
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'applied' }));

    // The whole composed page is a single history step within the live editor.
    expect(editor.can().undo()).toBe(true);
    act(() => {
      editor.commands.undo();
    });
    expect(editor.getText()).not.toContain('Composed heading');
    act(() => {
      editor.commands.redo();
    });
    expect(editor.getText()).toContain('Composed heading');
  });

  it('emits one normal document update so the existing autosave boundary persists it', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    const updates: TipDoc[] = [];
    editor.on('update', () => updates.push(editor.getJSON() as unknown as TipDoc));
    render(
      <Bridge
        editor={editor}
        pending={pendingCompositionOf(COMPOSED, documentRevisionOf(EMPTY), CURRENT_BOUNDARY)}
        onResult={onResult}
      />,
    );
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'applied' }));

    expect(updates).toHaveLength(1);
    expect(JSON.stringify(updates[0])).toContain('Composed heading');
  });

  it('applies a staged mutation exactly once and ignores a re-render with the same pending', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    const pending = pendingCompositionOf(COMPOSED, documentRevisionOf(EMPTY), CURRENT_BOUNDARY);
    const { rerender } = render(<Bridge editor={editor} pending={pending} onResult={onResult} />);
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult).toHaveBeenCalledWith({ status: 'applied' });

    // A context re-render must not replay the apply or report a spurious result.
    rerender(<Bridge editor={editor} pending={pending} onResult={onResult} />);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('applies a second, distinct staged mutation after the first', async () => {
    const editor = makeEditor();
    const onResult = vi.fn();
    const first = pendingCompositionOf(COMPOSED, documentRevisionOf(EMPTY), CURRENT_BOUNDARY);
    const { rerender } = render(<Bridge editor={editor} pending={first} onResult={onResult} />);
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ status: 'applied' }));

    // A following handoff is bound to the document as it now stands.
    const second = pendingAppendCompositionOf(
      EXISTING,
      APPEND_OPERATIONS,
      documentRevisionOf(editor.getJSON() as unknown as TipDoc),
      CURRENT_BOUNDARY,
    );
    rerender(<Bridge editor={editor} pending={second} onResult={onResult} />);

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(2));
    expect(onResult).toHaveBeenLastCalledWith({ status: 'applied' });
    expect(editor.getText()).toContain('Body copy');
  });
});
