/**
 * R5.2.9 G1: adopting the first persisted id of a brand-new document is not a
 * document boundary.
 *
 * The harness composes the real session, the real identity-keyed loader, the
 * real canonical lifecycle, the real document-scoped workspace state owner and
 * a real Tiptap editor keyed by the frozen `session.boundary`, mirroring how
 * `Content.tsx` wires them. Adoption must not remount the editor, reset its
 * undo history, drop workspace UI state, refetch or flash the loading screen -
 * only the persistent identity advances.
 */
import { useMemo, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { asTipDoc, tiptapEmptyDoc, type TipDoc } from '@seo/contracts';
import { RichTextEditor } from '../RichTextEditor';
import { EditorContextProvider, useEditorContext } from '../editor/EditorContext';
import { EditorSelectionProvider } from '../editor/EditorSelectionContext';
import { useDocumentScopedState } from '../workspace/workspaceState';
import { WorkspaceStateProvider } from '../workspace/workspaceState';
import { documentLifecycle, useDocumentSession, type DocumentLifecycleStatus, type SwitchResult } from './useDocumentSession';
import { useDocumentLoad } from './useDocumentLoad';

interface Row {
  id: string;
  content_json: TipDoc;
}

interface HarnessApi {
  createNew: () => Promise<SwitchResult>;
  adopt: (id: string) => void;
  editor: () => Editor | null;
  generation: () => number;
  boundary: () => string;
  lifecycle: () => DocumentLifecycleStatus;
  documentId: () => string | null;
  creating: () => boolean;
  loadCalls: () => string[];
  scoped: () => { value: number; set: (next: number) => void };
  context: () => ReturnType<typeof useEditorContext>;
}

function ScopedProbe({ api }: { api: HarnessApi }) {
  const [value, setValue] = useDocumentScopedState(0);
  api.scoped = () => ({ value, set: setValue });
  return null;
}

function ContextProbe({ api }: { api: HarnessApi }) {
  const context = useEditorContext();
  api.context = () => context;
  return null;
}

function Harness({ flush, load, api }: { flush: () => Promise<boolean>; load: (id: string) => Promise<Row>; api: HarnessApi }) {
  const session = useDocumentSession({ flush });
  const detail = useDocumentLoad<Row>(session.identity.documentId, load);
  const lifecycle = documentLifecycle(session.identity, detail);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [doc, setDoc] = useState<TipDoc>(() => tiptapEmptyDoc());

  api.createNew = session.requestNewDocument;
  api.adopt = (id) => {
    session.adoptDocumentId(id);
    detail.adopt(id);
  };
  api.editor = () => editor;
  api.generation = () => session.generation;
  api.boundary = () => session.boundary;
  api.lifecycle = () => lifecycle.status;
  api.documentId = () => session.identity.documentId;
  api.creating = () => session.identity.creating;

  const initialDoc = useMemo(
    () => (session.identity.creating ? tiptapEmptyDoc() : asTipDoc(detail.data?.content_json)),
    [session.identity.creating, detail.data],
  );

  return (
    <WorkspaceStateProvider documentKey={session.boundary}>
      <ScopedProbe api={api} />
      <EditorSelectionProvider editor={editor} documentId={session.identity.documentId}>
        <EditorContextProvider
          projectId="p1"
          contentId={session.identity.documentId}
          ready
          doc={doc}
          dirty={false}
          editor={editor}
        >
          <ContextProbe api={api} />
          {session.hasDocument && lifecycle.status === 'ready' && (
            <RichTextEditor key={session.boundary} initialDoc={initialDoc} onDocChange={setDoc} onEditor={setEditor} />
          )}
        </EditorContextProvider>
      </EditorSelectionProvider>
    </WorkspaceStateProvider>
  );
}

function makeApi(): HarnessApi {
  return {
    createNew: async () => ({ status: 'switched' }),
    adopt: () => undefined,
    editor: () => null,
    generation: () => 0,
    boundary: () => '',
    lifecycle: () => 'idle',
    documentId: () => null,
    creating: () => false,
    loadCalls: () => [],
    scoped: () => ({ value: 0, set: () => undefined }),
    context: () => null,
  };
}

async function startNew(api: HarnessApi): Promise<void> {
  await act(async () => {
    await api.createNew();
  });
}

function makeLoad(calls: string[], rows: Record<string, Row>): (id: string) => Promise<Row> {
  return (id) => {
    calls.push(id);
    const row = rows[id];
    return row ? Promise.resolve(row) : Promise.reject(new Error(`no row for ${id}`));
  };
}

describe('R5.2.9 G1: id adoption is not a document boundary', () => {
  it('1. keeps the same editor instance and preserves undo history', async () => {
    const api = makeApi();
    const calls: string[] = [];
    render(<Harness flush={async () => true} load={makeLoad(calls, {})} api={api} />);
    await startNew(api);

    const editorBefore = api.editor()!;
    expect(editorBefore).toBeTruthy();
    act(() => {
      editorBefore.commands.insertContent('Draft');
    });
    expect(editorBefore.can().undo()).toBe(true);

    act(() => api.adopt('doc-1'));

    expect(api.editor()).toBe(editorBefore);
    expect(api.editor()!.can().undo()).toBe(true);
  });

  it('2. keeps the frozen boundary and generation stable', async () => {
    const api = makeApi();
    const calls: string[] = [];
    render(<Harness flush={async () => true} load={makeLoad(calls, {})} api={api} />);
    await startNew(api);
    const boundaryBefore = api.boundary();
    const generationBefore = api.generation();

    act(() => api.adopt('doc-1'));

    expect(api.boundary()).toBe(boundaryBefore);
    expect(api.generation()).toBe(generationBefore);
    expect(api.documentId()).toBe('doc-1');
    expect(api.creating()).toBe(false);
  });

  it('3. preserves document-scoped workspace UI state', async () => {
    const api = makeApi();
    const calls: string[] = [];
    render(<Harness flush={async () => true} load={makeLoad(calls, {})} api={api} />);
    await startNew(api);

    act(() => api.scoped().set(7));
    expect(api.scoped().value).toBe(7);

    act(() => api.adopt('doc-1'));

    expect(api.scoped().value).toBe(7);
  });

  it('4. does not refetch the document or enter the loading lifecycle', async () => {
    const api = makeApi();
    const calls: string[] = [];
    render(
      <Harness
        flush={async () => true}
        load={makeLoad(calls, { 'doc-1': { id: 'doc-1', content_json: tiptapEmptyDoc() } })}
        api={api}
      />,
    );
    await startNew(api);
    expect(api.lifecycle()).toBe('ready');
    expect(calls).toEqual([]);

    act(() => api.adopt('doc-1'));

    expect(calls).toEqual([]);
    expect(api.lifecycle()).toBe('ready');
    expect(api.editor()).not.toBeNull();
  });
});
