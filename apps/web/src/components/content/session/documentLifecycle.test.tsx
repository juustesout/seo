/**
 * R5.2.6 active-document loading/error lifecycle.
 *
 * The harness composes the real session boundary (`useDocumentSession`), the
 * real identity-keyed loader (`useDocumentLoad`) and the canonical lifecycle
 * projection (`documentLifecycle`), then mounts a real Tiptap editor exactly
 * like `Content.tsx` does: only once the active document is `ready`. That makes
 * the acceptance tests assert the real invariant - a stale load can never make
 * the active document ready, and a failed load can never leave the previous
 * document's editor on screen.
 */
import { useMemo, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { asTipDoc, tiptapEmptyDoc, type TipDoc } from '@seo/contracts';
import { RichTextEditor } from '../RichTextEditor';
import { EditorContextProvider } from '../editor/EditorContext';
import { EditorSelectionProvider } from '../editor/EditorSelectionContext';
import {
  documentLifecycle,
  editorHistoryKey,
  useDocumentLoad,
  useDocumentSession,
  type DocumentIdentity,
  type DocumentLoadState,
  type SwitchResult,
} from './index';

interface Row {
  id: string;
  title: string;
  content_json: TipDoc;
}

const ROWS = {
  a: makeRow('a', 'Alpha'),
  b: makeRow('b', 'Bravo'),
};

function makeRow(id: string, text: string): Row {
  return {
    id,
    title: text,
    content_json: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('documentLifecycle (contract)', () => {
  const identity = (documentId: string | null, creating = false): DocumentIdentity => ({ documentId, creating });
  const load = (documentId: string | null, status: DocumentLoadState['status'], error: string | null = null): DocumentLoadState => ({
    documentId,
    status,
    error,
  });

  it('is idle with no active document', () => {
    expect(documentLifecycle(identity(null))).toEqual({ status: 'idle', documentId: null, error: null });
  });

  it('treats a brand-new document as ready without a load', () => {
    expect(documentLifecycle(identity(null, true))).toEqual({ status: 'ready', documentId: null, error: null });
  });

  it('stays loading until the loader describes the active identity', () => {
    expect(documentLifecycle(identity('b'), load('a', 'ready')).status).toBe('loading');
    expect(documentLifecycle(identity('b'), load(null, 'idle')).status).toBe('loading');
  });

  it('is ready exactly when the loader matches the active identity', () => {
    expect(documentLifecycle(identity('b'), load('b', 'ready'))).toEqual({ status: 'ready', documentId: 'b', error: null });
  });

  it('surfaces a load failure only for the active identity, never a stale one', () => {
    expect(documentLifecycle(identity('b'), load('b', 'error', 'boom'))).toEqual({ status: 'error', documentId: 'b', error: 'boom' });
    // A late error for the previous document is not the active document's error.
    expect(documentLifecycle(identity('b'), load('a', 'error', 'boom')).status).toBe('loading');
  });
});

interface HarnessApi {
  open: (id: string) => Promise<SwitchResult>;
  identity: () => DocumentIdentity;
  lifecycle: () => string;
  error: () => string | null;
  editor: () => Editor | null;
  setAiError: (message: string | null) => void;
  setSaveFailed: (failed: boolean) => void;
}

function makeApi(): HarnessApi {
  return {
    open: async () => ({ status: 'blocked', reason: 'save_in_progress' }),
    identity: () => ({ documentId: null, creating: false }),
    lifecycle: () => 'idle',
    error: () => null,
    editor: () => null,
    setAiError: () => {},
    setSaveFailed: () => {},
  };
}

function Harness({ load, flush, api }: { load: (id: string) => Promise<Row>; flush: () => Promise<boolean>; api: HarnessApi }) {
  const session = useDocumentSession({ flush });
  const detail = useDocumentLoad<Row>(session.identity.documentId, load);
  const lifecycle = documentLifecycle(session.identity, detail);
  const [doc, setDoc] = useState<TipDoc>(() => tiptapEmptyDoc());
  const [editor, setEditor] = useState<Editor | null>(null);
  // AI and save errors are deliberately held here, outside the lifecycle, to
  // prove they cannot influence it.
  const [, setAiError] = useState<string | null>(null);
  const [, setSaveFailed] = useState(false);

  api.open = (id) => session.requestDocumentSwitch(id);
  api.identity = () => session.identity;
  api.lifecycle = () => lifecycle.status;
  api.error = () => lifecycle.error;
  api.editor = () => editor;
  api.setAiError = setAiError;
  api.setSaveFailed = setSaveFailed;

  const ready = lifecycle.status === 'ready';
  const initialDoc = useMemo(
    () => (session.identity.creating ? tiptapEmptyDoc() : asTipDoc(detail.data?.content_json)),
    [session.identity.creating, detail.data],
  );

  return (
    <EditorSelectionProvider editor={editor} documentId={session.identity.documentId}>
      <EditorContextProvider projectId="p1" contentId={session.identity.documentId} ready={ready} doc={doc} dirty={false} editor={editor}>
        {session.hasDocument && ready && (
          <div data-testid="editor-slot">
            <RichTextEditor
              key={editorHistoryKey(session.identity, session.generation)}
              initialDoc={initialDoc}
              onDocChange={setDoc}
              onEditor={setEditor}
            />
          </div>
        )}
      </EditorContextProvider>
    </EditorSelectionProvider>
  );
}

function makeLoad() {
  const pending = new Map<string, ReturnType<typeof deferred<Row>>>();
  const calls: string[] = [];
  const load = (id: string) => {
    calls.push(id);
    const d = deferred<Row>();
    pending.set(id, d);
    return d.promise;
  };
  return { load, pending, calls };
}

async function open(api: HarnessApi, id: string): Promise<void> {
  await act(async () => {
    await api.open(id);
  });
}

async function settle(id: string, pending: Map<string, ReturnType<typeof deferred<Row>>>, row: Row): Promise<void> {
  await act(async () => {
    pending.get(id)!.resolve(row);
  });
}

async function fail(id: string, pending: Map<string, ReturnType<typeof deferred<Row>>>, message: string): Promise<void> {
  await act(async () => {
    pending.get(id)!.reject(new Error(message));
  });
}

describe('R5.2.6 document lifecycle', () => {
  it('1. a successful switch makes B active and is loading before ready', async () => {
    const { load, pending } = makeLoad();
    const api = makeApi();
    render(<Harness load={load} flush={async () => true} api={api} />);

    await open(api, 'a');
    await settle('a', pending, ROWS.a);
    expect(api.lifecycle()).toBe('ready');

    await open(api, 'b');
    // Identity advances immediately, but the loader has not aligned yet.
    expect(api.identity()).toEqual({ documentId: 'b', creating: false });
    expect(api.lifecycle()).toBe('loading');
    expect(screen.queryByTestId('editor-slot')).toBeNull();
  });

  it('2. B reaches ready once its load resolves', async () => {
    const { load, pending } = makeLoad();
    const api = makeApi();
    render(<Harness load={load} flush={async () => true} api={api} />);

    await open(api, 'a');
    await settle('a', pending, ROWS.a);
    await open(api, 'b');
    await settle('b', pending, ROWS.b);

    expect(api.lifecycle()).toBe('ready');
    expect(screen.getByTestId('editor-slot')).toBeTruthy();
    expect(api.editor()?.getText()).toBe('Bravo');
  });

  it('3. a B load failure yields lifecycle error and never shows the stale A editor', async () => {
    const { load, pending } = makeLoad();
    const api = makeApi();
    render(<Harness load={load} flush={async () => true} api={api} />);

    await open(api, 'a');
    await settle('a', pending, ROWS.a);
    expect(api.editor()?.getText()).toBe('Alpha');

    await open(api, 'b');
    await fail('b', pending, 'load boom');

    expect(api.identity()).toEqual({ documentId: 'b', creating: false });
    expect(api.lifecycle()).toBe('error');
    expect(api.error()).toBe('load boom');
    // The workspace (and therefore A's editor) is gone, not merely hidden.
    expect(screen.queryByTestId('editor-slot')).toBeNull();
    expect(screen.queryByText('Alpha')).toBeNull();
  });

  it('4. a failed switch preserves A and never starts the B load', async () => {
    const { load, pending, calls } = makeLoad();
    const api = makeApi();
    let flushes = 0;
    const flush = async () => {
      flushes += 1;
      return flushes === 1;
    };
    render(<Harness load={load} flush={flush} api={api} />);

    await open(api, 'a');
    await settle('a', pending, ROWS.a);

    let outcome: SwitchResult | undefined;
    await act(async () => {
      outcome = await api.open('b');
    });

    expect(outcome).toEqual({ status: 'blocked', reason: 'save_failed' });
    expect(api.identity()).toEqual({ documentId: 'a', creating: false });
    expect(api.lifecycle()).toBe('ready');
    expect(calls).toEqual(['a']);
    expect(screen.getByTestId('editor-slot')).toBeTruthy();
    expect(api.editor()?.getText()).toBe('Alpha');
  });

  it('5. a stale response for the previous document cannot alter B', async () => {
    const { load, pending } = makeLoad();
    const api = makeApi();
    render(<Harness load={load} flush={async () => true} api={api} />);

    // A is still loading when we switch away.
    await open(api, 'a');
    await open(api, 'b');
    expect(api.lifecycle()).toBe('loading');

    // A's late response must not become B's document.
    await settle('a', pending, ROWS.a);
    expect(api.identity()).toEqual({ documentId: 'b', creating: false });
    expect(api.lifecycle()).toBe('loading');
    expect(screen.queryByTestId('editor-slot')).toBeNull();

    await settle('b', pending, ROWS.b);
    expect(api.lifecycle()).toBe('ready');
    expect(api.editor()?.getText()).toBe('Bravo');
  });

  it('6. AI errors remain outside the document lifecycle', async () => {
    const { load, pending } = makeLoad();
    const api = makeApi();
    render(<Harness load={load} flush={async () => true} api={api} />);

    await open(api, 'a');
    await settle('a', pending, ROWS.a);

    act(() => {
      api.setAiError('AI request failed');
    });

    expect(api.lifecycle()).toBe('ready');
    expect(api.error()).toBeNull();
    expect(screen.getByTestId('editor-slot')).toBeTruthy();
  });

  it('7. save failures stay distinct from document load failures', async () => {
    const { load, pending } = makeLoad();
    const api = makeApi();
    render(<Harness load={load} flush={async () => true} api={api} />);

    await open(api, 'a');
    await settle('a', pending, ROWS.a);

    act(() => {
      api.setSaveFailed(true);
    });

    expect(api.lifecycle()).toBe('ready');
    expect(api.error()).toBeNull();
  });
});
