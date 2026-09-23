/**
 * R5.2.5 undo/redo lifecycle boundary.
 *
 * The harness composes the real session boundary (`useDocumentSession`), the
 * real editor-history key (`editorHistoryKey`) and a real Tiptap editor keyed by
 * that key, mirroring how `Content.tsx` wires them. It asserts the invariant
 * that undo/redo history is scoped to the active editor instance and never
 * crosses a document identity boundary.
 */
import { useMemo, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { tiptapEmptyDoc, type DocumentOperationBatch, type TipDoc } from '@seo/contracts';
import { RichTextEditor } from '../RichTextEditor';
import { EditorContextProvider, useEditorContext } from '../editor/EditorContext';
import { EditorSelectionProvider } from '../editor/EditorSelectionContext';
import type { DocumentOperationApplyResult } from '../editor/editorContext';
import { editorHistoryKey, useDocumentSession, type SwitchResult } from './useDocumentSession';

const DOCS: Record<string, TipDoc> = {
  a: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha' }] }] },
  b: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bravo' }] }] },
};

interface HarnessApi {
  open: (id: string) => Promise<SwitchResult>;
  editor: () => Editor | null;
  generation: () => number;
  context: () => ReturnType<typeof useEditorContext>;
}

function makeApi(): HarnessApi {
  return {
    open: async () => ({ status: 'blocked', reason: 'save_in_progress' }),
    editor: () => null,
    generation: () => 0,
    context: () => null,
  };
}

function ContextProbe({ api }: { api: HarnessApi }) {
  const context = useEditorContext();
  api.context = () => context;
  return null;
}

function Harness({ flush, api }: { flush: () => Promise<boolean>; api: HarnessApi }) {
  const session = useDocumentSession({ flush });
  const [editor, setEditor] = useState<Editor | null>(null);
  const [doc, setDoc] = useState<TipDoc>(() => tiptapEmptyDoc());

  api.open = (id) => session.requestDocumentSwitch(id);
  api.editor = () => editor;
  api.generation = () => session.generation;

  const { identity } = session;
  const active = identity.creating || identity.documentId !== null;
  const initialDoc = useMemo(
    () => (identity.creating ? tiptapEmptyDoc() : DOCS[identity.documentId ?? ''] ?? tiptapEmptyDoc()),
    [identity.creating, identity.documentId],
  );

  return (
    <EditorSelectionProvider editor={editor} documentId={identity.documentId}>
      <EditorContextProvider projectId="p1" contentId={identity.documentId} ready doc={doc} dirty={false} editor={editor}>
        <ContextProbe api={api} />
        {active && (
          <RichTextEditor
            key={editorHistoryKey(identity, session.generation)}
            initialDoc={initialDoc}
            onDocChange={setDoc}
            onEditor={setEditor}
          />
        )}
      </EditorContextProvider>
    </EditorSelectionProvider>
  );
}

async function open(api: HarnessApi, id: string): Promise<void> {
  await act(async () => {
    await api.open(id);
  });
}

describe('R5.2.5 undo/redo boundary', () => {
  it('1. undo remains local to the open document', async () => {
    const api = makeApi();
    render(<Harness flush={async () => true} api={api} />);
    await open(api, 'a');

    const editor = api.editor()!;
    const before = editor.getText();
    act(() => {
      editor.commands.insertContent('X');
    });
    expect(editor.getText()).not.toBe(before);

    act(() => {
      editor.commands.undo();
    });
    expect(editor.getText()).toBe(before);
  });

  it('2. undo does not cross a document boundary', async () => {
    const api = makeApi();
    render(<Harness flush={async () => true} api={api} />);
    await open(api, 'a');
    const editorA = api.editor()!;
    act(() => {
      editorA.commands.insertContent('X');
    });

    await open(api, 'b');
    const editorB = api.editor()!;
    expect(editorB).not.toBe(editorA);
    const before = editorB.getText();
    expect(editorB.can().undo()).toBe(false);

    act(() => {
      editorB.commands.undo();
    });
    expect(editorB.getText()).toBe(before);
    expect(editorB.getText()).toBe('Bravo');
  });

  it('3. redo does not cross a document boundary', async () => {
    const api = makeApi();
    render(<Harness flush={async () => true} api={api} />);
    await open(api, 'a');
    const editorA = api.editor()!;
    act(() => {
      editorA.commands.insertContent('X');
    });
    act(() => {
      editorA.commands.undo();
    });
    expect(editorA.can().redo()).toBe(true);

    await open(api, 'b');
    const editorB = api.editor()!;
    const before = editorB.getText();
    expect(editorB.can().redo()).toBe(false);

    act(() => {
      editorB.commands.redo();
    });
    expect(editorB.getText()).toBe(before);
    expect(editorB.getText()).toBe('Bravo');
  });

  it('4. a failed switch keeps document A authoritative and preserves its history', async () => {
    const api = makeApi();
    let calls = 0;
    const flush = async () => {
      calls += 1;
      return calls === 1;
    };
    render(<Harness flush={flush} api={api} />);
    await open(api, 'a');
    const editorA = api.editor()!;
    act(() => {
      editorA.commands.insertContent('X');
    });

    let outcome: SwitchResult | undefined;
    await act(async () => {
      outcome = await api.open('b');
    });

    expect(outcome).toEqual({ status: 'blocked', reason: 'save_failed' });
    // The failed switch did not advance the boundary or replace the editor.
    expect(api.generation()).toBe(1);
    expect(api.editor()).toBe(editorA);

    // A's history is intact: the edit can still be undone.
    act(() => {
      api.editor()!.commands.undo();
    });
    expect(api.editor()!.getText()).toBe('Alpha');
  });

  it('5. a successful switch establishes a clean boundary', async () => {
    const api = makeApi();
    render(<Harness flush={async () => true} api={api} />);
    await open(api, 'a');
    const editorA = api.editor()!;
    act(() => {
      editorA.commands.insertContent('X');
    });

    await open(api, 'b');
    const editorB = api.editor()!;
    expect(editorB).not.toBe(editorA);
    expect(editorB.getText()).toBe('Bravo');
    expect(editorB.can().undo()).toBe(false);
    expect(editorB.can().redo()).toBe(false);
  });

  it('6. switching back creates a fresh boundary instead of restoring history', async () => {
    const api = makeApi();
    render(<Harness flush={async () => true} api={api} />);
    await open(api, 'a');
    const first = api.editor()!;
    act(() => {
      first.commands.insertContent('X');
    });

    await open(api, 'b');
    await open(api, 'a');
    const reopened = api.editor()!;

    // A fresh editor instance/history boundary; the old edit is not undoable.
    expect(reopened).not.toBe(first);
    expect(reopened.can().undo()).toBe(false);
    expect(reopened.getText()).toBe('Alpha');
  });

  it('7. an operation generated for the outgoing document cannot mutate the active one', async () => {
    const api = makeApi();
    render(<Harness flush={async () => true} api={api} />);
    await open(api, 'a');
    const revisionA = api.context()!.snapshot.document.revision!;
    expect(revisionA).toBeTruthy();

    const batch: DocumentOperationBatch = {
      version: 1,
      baseRevision: revisionA,
      operations: [{ type: 'insert_section', ref: 's1', section: { kind: 'hero' }, position: { mode: 'document_start' } }],
    };

    await open(api, 'b');
    const editorB = api.editor()!;
    const before = editorB.getText();

    let outcome: DocumentOperationApplyResult | undefined;
    act(() => {
      outcome = api.context()!.applyDocumentOperations(batch, revisionA);
    });

    expect(outcome).toEqual({ ok: false, reason: 'stale-revision' });
    expect(api.editor()!.getText()).toBe(before);
    expect(api.editor()!.getText()).toBe('Bravo');
  });
});
