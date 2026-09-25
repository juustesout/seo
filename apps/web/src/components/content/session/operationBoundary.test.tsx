/**
 * R5.2.9 G2: a per-document async operation must not apply its late result
 * after the active document changed.
 *
 * The harness mirrors how `Content.tsx` runs inline AI: it starts the request,
 * captures the document boundary via `useOperationBoundary`, resets pending AI
 * state on a successful switch, and only promotes a result when the boundary
 * still matches. `runAi`/`runAiEdit` use exactly this guard. The harness
 * component (and therefore the guard) stays mounted across transitions, so the
 * tests prove the boundary - not React unmounting - is what invalidates the
 * operation.
 */
import { useMemo, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { tiptapEmptyDoc, type TipDoc } from '@seo/contracts';
import { RichTextEditor } from '../RichTextEditor';
import { EditorContextProvider } from '../editor/EditorContext';
import { EditorSelectionProvider } from '../editor/EditorSelectionContext';
import { useDocumentSession, type SwitchResult } from './useDocumentSession';
import { useOperationBoundary } from './useOperationBoundary';

const DOCS: Record<string, TipDoc> = {
  a: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha' }] }] },
  b: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bravo' }] }] },
};

interface HarnessApi {
  open: (id: string) => Promise<SwitchResult>;
  newDoc: () => Promise<SwitchResult>;
  close: () => Promise<SwitchResult>;
  start: (request: Promise<string>) => void;
  apply: () => void;
  editor: () => Editor | null;
  result: () => string | null;
  error: () => string | null;
  busy: () => boolean;
}

function makeApi(): HarnessApi {
  return {
    open: async () => ({ status: 'switched' }),
    newDoc: async () => ({ status: 'switched' }),
    close: async () => ({ status: 'switched' }),
    start: () => undefined,
    apply: () => undefined,
    editor: () => null,
    result: () => null,
    error: () => null,
    busy: () => false,
  };
}

function Harness({ flush, api }: { flush: () => Promise<boolean>; api: HarnessApi }) {
  const session = useDocumentSession({ flush });
  const beginOperation = useOperationBoundary(session.boundary);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [doc, setDoc] = useState<TipDoc>(() => tiptapEmptyDoc());

  const resetAi = () => {
    setBusy(false);
    setResult(null);
    setError(null);
  };

  const switchTo = async (pending: Promise<SwitchResult>): Promise<SwitchResult> => {
    const outcome = await pending;
    if (outcome.status === 'switched') resetAi();
    return outcome;
  };

  api.open = (id) => switchTo(session.requestDocumentSwitch(id));
  api.newDoc = () => switchTo(session.requestNewDocument());
  api.close = () => switchTo(session.requestCloseDocument());
  api.start = (request) => {
    const operation = beginOperation();
    setBusy(true);
    setError(null);
    setResult(null);
    void request
      .then((data) => {
        if (operation.isStale()) return;
        setResult(data);
      })
      .catch((e: unknown) => {
        if (operation.isStale()) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!operation.isStale()) setBusy(false);
      });
  };
  api.apply = () => {
    if (!result || !editor) return;
    editor.chain().focus().insertContentAt(editor.state.doc.content.size, result).run();
    setResult(null);
  };
  api.editor = () => editor;
  api.result = () => result;
  api.error = () => error;
  api.busy = () => busy;

  const { identity } = session;
  const active = identity.creating || identity.documentId !== null;
  const initialDoc = useMemo(
    () => (identity.creating ? tiptapEmptyDoc() : DOCS[identity.documentId ?? ''] ?? tiptapEmptyDoc()),
    [identity.creating, identity.documentId],
  );

  return (
    <EditorSelectionProvider editor={editor} documentId={identity.documentId}>
      <EditorContextProvider projectId="p1" contentId={identity.documentId} ready doc={doc} dirty={false} editor={editor}>
        {active && (
          <RichTextEditor key={session.boundary} initialDoc={initialDoc} onDocChange={setDoc} onEditor={setEditor} />
        )}
      </EditorContextProvider>
    </EditorSelectionProvider>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function run(fn: () => Promise<unknown>): Promise<void> {
  await act(async () => {
    await fn();
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('R5.2.9 G2: late async results are dropped after a document change', () => {
  it('1. a response for the outgoing document is not promoted on the current one', async () => {
    const api = makeApi();
    render(<Harness flush={async () => true} api={api} />);
    await run(() => api.open('a'));

    const request = deferred<string>();
    api.start(request.promise);
    await run(() => api.open('b'));

    request.resolve('suggestion-for-A');
    await settle();

    expect(api.result()).toBeNull();
    expect(api.error()).toBeNull();
  });

  it('2. a failure for the outgoing document does not surface on the current one', async () => {
    const api = makeApi();
    render(<Harness flush={async () => true} api={api} />);
    await run(() => api.open('a'));

    const request = deferred<string>();
    api.start(request.promise);
    await run(() => api.open('b'));

    request.reject(new Error('upstream exploded for A'));
    await settle();

    expect(api.error()).toBeNull();
    expect(api.result()).toBeNull();
  });

  it('3. a late response for A does not clear the busy state of B', async () => {
    const api = makeApi();
    render(<Harness flush={async () => true} api={api} />);
    await run(() => api.open('a'));

    const requestA = deferred<string>();
    api.start(requestA.promise);
    await run(() => api.open('b'));

    const requestB = deferred<string>();
    act(() => api.start(requestB.promise));
    expect(api.busy()).toBe(true);

    requestA.resolve('suggestion-for-A');
    await settle();
    expect(api.busy()).toBe(true);

    requestB.resolve('suggestion-for-B');
    await settle();
    expect(api.result()).toBe('suggestion-for-B');
    expect(api.busy()).toBe(false);
  });

  it('4. a late edit result cannot mutate the active editor', async () => {
    const api = makeApi();
    render(<Harness flush={async () => true} api={api} />);
    await run(() => api.open('a'));

    const request = deferred<string>();
    api.start(request.promise);
    await run(() => api.open('b'));
    const before = api.editor()!.getText();

    request.resolve('EDITED');
    await settle();

    act(() => api.apply());
    expect(api.editor()!.getText()).toBe(before);
    expect(api.editor()!.getText()).toBe('Bravo');
  });

  it('5. the boundary invalidates on a new document and a close, without relying on unmounting', async () => {
    const api = makeApi();
    render(<Harness flush={async () => true} api={api} />);
    await run(() => api.open('a'));

    const onNew = deferred<string>();
    api.start(onNew.promise);
    await run(() => api.newDoc());
    onNew.resolve('suggestion-for-A');
    await settle();
    expect(api.result()).toBeNull();

    const onCreate = deferred<string>();
    api.start(onCreate.promise);
    await run(() => api.close());
    onCreate.resolve('suggestion-for-new');
    await settle();
    expect(api.result()).toBeNull();
    expect(api.error()).toBeNull();
  });
});
