import { useMemo, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useDocumentSession } from './useDocumentSession';
import {
  DocumentSessionProvider,
  useRequiredDocumentSession,
  type DocumentSessionValue,
} from './documentSessionContext';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A consumer that reads only the shared session context. */
function Consumer() {
  const session = useRequiredDocumentSession();
  return (
    <div>
      <span data-testid="doc-id">{session.documentId ?? 'none'}</span>
      <span data-testid="is-new">{String(session.isNew)}</span>
      <span data-testid="has-doc">{String(session.hasDocument)}</span>
    </div>
  );
}

/**
 * Owns the single session authority (like the content view does), distributes
 * it, and models destination state that may only be applied after a successful
 * transition.
 */
function SessionHarness({ flush }: { flush: () => Promise<boolean> }) {
  const session = useDocumentSession({ flush });
  const [destination, setDestination] = useState('none');

  const value = useMemo<DocumentSessionValue>(
    () => ({
      projectId: 'p1',
      documentId: session.identity.documentId,
      isNew: session.identity.creating,
      hasDocument: session.hasDocument,
      lifecycle: { status: 'ready', documentId: session.identity.documentId, error: null },
      dirty: false,
      saveState: 'saved',
      requestDocumentSwitch: session.requestDocumentSwitch,
      requestNewDocument: session.requestNewDocument,
      requestCloseDocument: session.requestCloseDocument,
      adoptDocumentId: session.adoptDocumentId,
      discardDocument: session.discardDocument,
    }),
    [
      session.identity,
      session.hasDocument,
      session.requestDocumentSwitch,
      session.requestNewDocument,
      session.requestCloseDocument,
      session.adoptDocumentId,
      session.discardDocument,
    ],
  );

  const runSwitch = async (id: string) => {
    const result = await session.requestDocumentSwitch(id);
    if (result.status === 'switched') setDestination(id);
  };
  const runNew = async () => {
    const result = await session.requestNewDocument();
    if (result.status === 'switched') setDestination('new');
  };
  const runClose = async () => {
    const result = await session.requestCloseDocument();
    if (result.status === 'switched') setDestination('none');
  };

  return (
    <DocumentSessionProvider value={value}>
      <Consumer />
      <button data-testid="open-a" onClick={() => void runSwitch('doc-a')} />
      <button data-testid="open-b" onClick={() => void runSwitch('doc-b')} />
      <button data-testid="new" onClick={() => void runNew()} />
      <button data-testid="close" onClick={() => void runClose()} />
      <span data-testid="destination">{destination}</span>
    </DocumentSessionProvider>
  );
}

function click(testId: string) {
  fireEvent.click(screen.getByTestId(testId));
}

describe('document session context', () => {
  it('exposes one authoritative identity that consumers derive from the session', async () => {
    const { container } = render(<SessionHarness flush={async () => true} />);

    // No document yet: the consumer reports the session's inert identity.
    expect(screen.getByTestId('doc-id').textContent).toBe('none');
    expect(screen.getByTestId('has-doc').textContent).toBe('false');

    await act(async () => {
      click('open-a');
    });

    // Consumer observes the transition; there is no competing identity source.
    await waitFor(() => expect(screen.getByTestId('doc-id').textContent).toBe('doc-a'));
    expect(container.querySelectorAll('[data-testid="doc-id"]')).toHaveLength(1);
    expect(screen.getByTestId('has-doc').textContent).toBe('true');
  });

  it('switches identity and applies destination state only after the barrier succeeds', async () => {
    const flush = deferred<boolean>();
    let defer = false;
    render(<SessionHarness flush={() => (defer ? flush.promise : Promise.resolve(true))} />);

    await act(async () => {
      click('open-a');
    });
    await waitFor(() => expect(screen.getByTestId('doc-id').textContent).toBe('doc-a'));
    expect(screen.getByTestId('destination').textContent).toBe('doc-a');

    defer = true;
    await act(async () => {
      click('open-b');
    });
    // Barrier is pending: A stays authoritative and B's destination is not applied.
    expect(screen.getByTestId('doc-id').textContent).toBe('doc-a');
    expect(screen.getByTestId('destination').textContent).toBe('doc-a');

    await act(async () => {
      flush.resolve(true);
      await flush.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('doc-id').textContent).toBe('doc-b'));
    expect(screen.getByTestId('destination').textContent).toBe('doc-b');
  });

  it('keeps the current identity and destination when the save barrier fails', async () => {
    let fail = false;
    render(<SessionHarness flush={() => Promise.resolve(!fail)} />);

    await act(async () => {
      click('open-a');
    });
    await waitFor(() => expect(screen.getByTestId('doc-id').textContent).toBe('doc-a'));

    fail = true;
    await act(async () => {
      click('open-b');
      await Promise.resolve();
    });

    expect(screen.getByTestId('doc-id').textContent).toBe('doc-a');
    expect(screen.getByTestId('destination').textContent).toBe('doc-a');
    expect(screen.getByTestId('has-doc').textContent).toBe('true');
  });

  it('creates a new document through the same barrier', async () => {
    const flush = deferred<boolean>();
    let defer = false;
    render(<SessionHarness flush={() => (defer ? flush.promise : Promise.resolve(true))} />);

    await act(async () => {
      click('open-a');
    });
    await waitFor(() => expect(screen.getByTestId('doc-id').textContent).toBe('doc-a'));

    defer = true;
    await act(async () => {
      click('new');
    });
    // Still on A while the barrier protects its pending edits.
    expect(screen.getByTestId('doc-id').textContent).toBe('doc-a');

    await act(async () => {
      flush.resolve(true);
      await flush.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('is-new').textContent).toBe('true'));
    expect(screen.getByTestId('doc-id').textContent).toBe('none');
    expect(screen.getByTestId('has-doc').textContent).toBe('true');
    expect(screen.getByTestId('destination').textContent).toBe('new');
  });

  it('closes to the no-document state without leaving a stale identity', async () => {
    render(<SessionHarness flush={async () => true} />);

    await act(async () => {
      click('open-a');
    });
    await waitFor(() => expect(screen.getByTestId('doc-id').textContent).toBe('doc-a'));

    await act(async () => {
      click('close');
    });

    await waitFor(() => expect(screen.getByTestId('doc-id').textContent).toBe('none'));
    expect(screen.getByTestId('has-doc').textContent).toBe('false');
    expect(screen.getByTestId('is-new').textContent).toBe('false');
    expect(screen.getByTestId('destination').textContent).toBe('none');
  });

  it('reports the derived contract consistently to every consumer', () => {
    const flush = vi.fn(async () => true);
    render(<SessionHarness flush={flush} />);
    expect(screen.getByTestId('has-doc').textContent).toBe('false');
    expect(screen.getByTestId('is-new').textContent).toBe('false');
    expect(flush).not.toHaveBeenCalled();
  });
});
