/**
 * R5.2.7 document-scoped workspace UI state.
 *
 * The harness composes the real session boundary (`useDocumentSession`) with the
 * real scoping owner (`WorkspaceStateProvider` + `useDocumentScopedState`). The
 * probe stays mounted across every transition, so these tests assert the scope
 * keying itself rather than a component remount. A workspace-global value is
 * held next to the provider, exactly like the Content-level preferences
 * (`useKnowledge`), to prove it is unaffected by a document boundary.
 */
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { WorkspaceStateProvider, useDocumentScopedState } from './workspaceState';
import { documentScopeKey, useDocumentSession, type DocumentIdentity, type SwitchResult } from '../session';

interface HarnessApi {
  open: (documentId: string) => Promise<SwitchResult>;
  createNew: () => Promise<SwitchResult>;
  close: () => Promise<SwitchResult>;
  identity: () => DocumentIdentity;
  scoped: () => boolean;
  setScoped: (value: boolean) => void;
  global: () => boolean;
  setGlobal: (value: boolean) => void;
}

function makeApi(): HarnessApi {
  return {
    open: async () => ({ status: 'blocked', reason: 'save_in_progress' }),
    createNew: async () => ({ status: 'blocked', reason: 'save_in_progress' }),
    close: async () => ({ status: 'blocked', reason: 'save_in_progress' }),
    identity: () => ({ documentId: null, creating: false }),
    scoped: () => false,
    setScoped: () => {},
    global: () => false,
    setGlobal: () => {},
  };
}

function ScopedProbe({ api }: { api: HarnessApi }) {
  const [scoped, setScoped] = useDocumentScopedState(false);
  api.scoped = () => scoped;
  api.setScoped = setScoped;
  return null;
}

function Harness({ flush, api }: { flush: () => Promise<boolean>; api: HarnessApi }) {
  const session = useDocumentSession({ flush });
  // Workspace-global state: outside the document-scoped provider, like Content's
  // knowledge preferences. It must survive every document transition.
  const [global, setGlobal] = useState(false);

  api.open = session.requestDocumentSwitch;
  api.createNew = session.requestNewDocument;
  api.close = session.requestCloseDocument;
  api.identity = () => session.identity;
  api.global = () => global;
  api.setGlobal = setGlobal;

  return (
    <WorkspaceStateProvider documentKey={documentScopeKey(session.identity, session.generation)}>
      <ScopedProbe api={api} />
    </WorkspaceStateProvider>
  );
}

const clean = async () => true;

describe('workspace UI state scoped to the document session (R5.2.7)', () => {
  it('resets document-scoped state on a successful switch', async () => {
    const api = makeApi();
    render(<Harness flush={clean} api={api} />);

    await act(async () => {
      await api.open('a');
    });
    act(() => api.setScoped(true));
    expect(api.scoped()).toBe(true);

    await act(async () => {
      await api.open('b');
    });
    expect(api.identity()).toEqual({ documentId: 'b', creating: false });
    expect(api.scoped()).toBe(false);
  });

  it('preserves state and identity when the save barrier blocks a switch', async () => {
    const api = makeApi();
    let flushes = 0;
    const flush = async () => {
      flushes += 1;
      return flushes === 1;
    };
    render(<Harness flush={flush} api={api} />);

    await act(async () => {
      await api.open('a');
    });
    act(() => api.setScoped(true));

    let outcome: SwitchResult | undefined;
    await act(async () => {
      outcome = await api.open('b');
    });

    expect(outcome).toEqual({ status: 'blocked', reason: 'save_failed' });
    expect(api.identity()).toEqual({ documentId: 'a', creating: false });
    expect(api.scoped()).toBe(true);
  });

  it('does not let a new document inherit the previous document state', async () => {
    const api = makeApi();
    render(<Harness flush={clean} api={api} />);

    await act(async () => {
      await api.open('a');
    });
    act(() => api.setScoped(true));

    await act(async () => {
      await api.createNew();
    });
    expect(api.identity()).toEqual({ documentId: null, creating: true });
    expect(api.scoped()).toBe(false);
  });

  it('drops authority when returning to the list', async () => {
    const api = makeApi();
    render(<Harness flush={clean} api={api} />);

    await act(async () => {
      await api.open('a');
    });
    act(() => api.setScoped(true));

    await act(async () => {
      await api.close();
    });
    expect(api.identity()).toEqual({ documentId: null, creating: false });
    expect(api.scoped()).toBe(false);

    await act(async () => {
      await api.open('b');
    });
    expect(api.scoped()).toBe(false);
  });

  it('starts fresh defaults when reopening the same document', async () => {
    const api = makeApi();
    render(<Harness flush={clean} api={api} />);

    await act(async () => {
      await api.open('a');
    });
    act(() => api.setScoped(true));

    await act(async () => {
      await api.close();
    });
    await act(async () => {
      await api.open('a');
    });

    expect(api.identity()).toEqual({ documentId: 'a', creating: false });
    expect(api.scoped()).toBe(false);
  });

  it('leaves workspace-global state untouched across a switch', async () => {
    const api = makeApi();
    render(<Harness flush={clean} api={api} />);

    act(() => api.setGlobal(true));
    await act(async () => {
      await api.open('a');
    });
    act(() => api.setScoped(true));

    await act(async () => {
      await api.open('b');
    });

    expect(api.global()).toBe(true);
    expect(api.scoped()).toBe(false);
  });

  it('ignores a stale setter replayed after the document boundary moved', async () => {
    const api = makeApi();
    render(<Harness flush={clean} api={api} />);

    await act(async () => {
      await api.open('a');
    });
    act(() => api.setScoped(true));
    const setUnderA = api.setScoped;

    await act(async () => {
      await api.open('b');
    });
    expect(api.scoped()).toBe(false);

    // A late write from the previous document cannot reapply A's state.
    act(() => setUnderA(true));
    expect(api.scoped()).toBe(false);
    expect(api.identity()).toEqual({ documentId: 'b', creating: false });
  });
});
