import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { documentScopeKey, editorHistoryKey, useDocumentSession, type SwitchResult } from './useDocumentSession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mount(flush: () => Promise<boolean>) {
  return renderHook(() => useDocumentSession({ flush }));
}

/** Runs a switch and captures its result, letting the caller assert the interim. */
function startSwitch(result: { current: ReturnType<typeof useDocumentSession> }, documentId: string) {
  const captured: { outcome?: SwitchResult } = {};
  act(() => {
    void result.current.requestDocumentSwitch(documentId).then((r) => {
      captured.outcome = r;
    });
  });
  return captured;
}

describe('useDocumentSession save barrier', () => {
  it('switches immediately for a clean document without an unnecessary save', async () => {
    const flush = vi.fn(async () => true);
    const { result } = mount(flush);

    const captured: { outcome?: SwitchResult } = {};
    await act(async () => {
      captured.outcome = await result.current.requestDocumentSwitch('doc-b');
    });

    expect(flush).toHaveBeenCalledTimes(1);
    expect(captured.outcome).toEqual({ status: 'switched' });
    expect(result.current.identity).toEqual({ documentId: 'doc-b', creating: false });
  });

  it('flushes a dirty document before switching, keeping it current while saving', async () => {
    const flush = deferred<boolean>();
    const { result } = mount(() => flush.promise);

    act(() => result.current.adoptDocumentId('doc-a'));
    expect(result.current.identity.documentId).toBe('doc-a');

    const captured = startSwitch(result, 'doc-b');
    await act(async () => {
      await Promise.resolve();
    });

    // The barrier has not resolved: A is still authoritative.
    expect(result.current.identity.documentId).toBe('doc-a');
    expect(captured.outcome).toBeUndefined();

    await act(async () => {
      flush.resolve(true);
      await flush.promise;
      await Promise.resolve();
    });

    expect(result.current.identity.documentId).toBe('doc-b');
    expect(captured.outcome).toEqual({ status: 'switched' });
  });

  it('blocks the switch and keeps the current document when the save fails', async () => {
    const { result } = mount(async () => false);
    act(() => result.current.adoptDocumentId('doc-a'));

    let outcome: SwitchResult | undefined;
    await act(async () => {
      outcome = await result.current.requestDocumentSwitch('doc-b');
    });

    expect(outcome).toEqual({ status: 'blocked', reason: 'save_failed' });
    expect(result.current.identity.documentId).toBe('doc-a');
  });

  it('does not replace the document when a deferred flush later rejects', async () => {
    const flush = deferred<boolean>();
    const { result } = mount(() => flush.promise);
    act(() => result.current.adoptDocumentId('doc-a'));

    const captured = startSwitch(result, 'doc-b');
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.identity.documentId).toBe('doc-a');

    await act(async () => {
      flush.reject(new Error('offline'));
      await flush.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(captured.outcome).toEqual({ status: 'blocked', reason: 'save_failed' });
    expect(result.current.identity.documentId).toBe('doc-a');
  });

  it('refuses a second switch while a save barrier is already running', async () => {
    const flush = deferred<boolean>();
    const { result } = mount(() => flush.promise);
    act(() => result.current.adoptDocumentId('doc-a'));

    const first = startSwitch(result, 'doc-b');
    await act(async () => {
      await Promise.resolve();
    });

    let second: SwitchResult | undefined;
    await act(async () => {
      second = await result.current.requestDocumentSwitch('doc-c');
    });
    expect(second).toEqual({ status: 'blocked', reason: 'save_in_progress' });

    await act(async () => {
      flush.resolve(true);
      await flush.promise;
      await Promise.resolve();
    });

    expect(first.outcome).toEqual({ status: 'switched' });
    expect(result.current.identity.documentId).toBe('doc-b');
  });

  it('starts a new document and closes to the list through the same barrier', async () => {
    const flush = vi.fn(async () => true);
    const { result } = mount(flush);
    act(() => result.current.adoptDocumentId('doc-a'));

    await act(async () => {
      await result.current.requestNewDocument();
    });
    expect(result.current.identity).toEqual({ documentId: null, creating: true });

    await act(async () => {
      await result.current.requestCloseDocument();
    });
    expect(result.current.identity).toEqual({ documentId: null, creating: false });
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('adopts a server id and discards a deleted document without a flush', () => {
    const flush = vi.fn(async () => true);
    const { result } = mount(flush);

    act(() => result.current.adoptDocumentId('doc-a'));
    expect(result.current.identity).toEqual({ documentId: 'doc-a', creating: false });
    expect(flush).not.toHaveBeenCalled();

    act(() => result.current.discardDocument());
    expect(result.current.identity).toEqual({ documentId: null, creating: false });
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('useDocumentSession history generation (R5.2.5)', () => {
  it('advances the generation only on a successful document change', async () => {
    const flush = vi.fn(async () => true);
    const { result } = mount(flush);

    expect(result.current.generation).toBe(0);

    await act(async () => {
      await result.current.requestDocumentSwitch('doc-b');
    });
    expect(result.current.generation).toBe(1);

    await act(async () => {
      await result.current.requestNewDocument();
    });
    expect(result.current.generation).toBe(2);
  });

  it('does not advance the generation when the save barrier blocks the switch', async () => {
    const { result } = mount(async () => false);
    act(() => result.current.adoptDocumentId('doc-a'));

    let outcome: SwitchResult | undefined;
    await act(async () => {
      outcome = await result.current.requestDocumentSwitch('doc-b');
    });

    expect(outcome).toEqual({ status: 'blocked', reason: 'save_failed' });
    expect(result.current.identity.documentId).toBe('doc-a');
    expect(result.current.generation).toBe(0);
  });

  it('does not advance the generation for adoption or discard', () => {
    const { result } = mount(async () => true);
    act(() => result.current.adoptDocumentId('doc-a'));
    expect(result.current.generation).toBe(0);
    act(() => result.current.discardDocument());
    expect(result.current.generation).toBe(0);
  });

  it('keys the editor instance by identity and generation', () => {
    const a = { documentId: 'doc-a', creating: false };
    const b = { documentId: 'doc-b', creating: false };
    const draft = { documentId: null, creating: true };

    // A different document at the same generation is a different boundary.
    expect(editorHistoryKey(a, 1)).not.toBe(editorHistoryKey(b, 1));
    // The same document at a later generation is a different boundary.
    expect(editorHistoryKey(a, 1)).not.toBe(editorHistoryKey(a, 2));
    // The same document and generation is the same boundary.
    expect(editorHistoryKey(a, 1)).toBe(editorHistoryKey(a, 1));
    expect(editorHistoryKey(draft, 0)).not.toBe(editorHistoryKey(a, 0));
  });

  it('exposes one document boundary key shared with workspace UI scoping (R5.2.7)', () => {
    const a = { documentId: 'doc-a', creating: false };
    const b = { documentId: 'doc-b', creating: false };
    const draft = { documentId: null, creating: true };
    const closed = { documentId: null, creating: false };

    // Editor history and workspace UI scope are the same epoch.
    expect(documentScopeKey(a, 3)).toBe(editorHistoryKey(a, 3));
    expect(documentScopeKey(a, 1)).not.toBe(documentScopeKey(b, 1));
    expect(documentScopeKey(a, 1)).not.toBe(documentScopeKey(a, 2));
    expect(documentScopeKey(draft, 0)).toBe('new#0');
    expect(documentScopeKey(closed, 1)).toBe('closed#1');
  });
});
