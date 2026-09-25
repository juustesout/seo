/**
 * R5.2.9 loader contract: `adopt` lets the first-save id of a new document be
 * reported ready without a fetch, while a later genuine switch to that id still
 * loads normally. The marker is scoped to the active id and cleared as soon as
 * the requested id moves on, so reopening a document never shows adopted-empty
 * state.
 */
import { describe, expect, it } from 'vitest';
import { act, render } from '@testing-library/react';
import { useDocumentLoad, type DocumentLoad } from './useDocumentLoad';

interface Row {
  id: string;
}

interface Api {
  state: () => DocumentLoad<Row>;
}

function Probe({ documentId, load, api }: { documentId: string | null; load: (id: string) => Promise<Row>; api: Api }) {
  const state = useDocumentLoad<Row>(documentId, load);
  api.state = () => state;
  return null;
}

function makeLoad(calls: string[]): (id: string) => Promise<Row> {
  return (id) => {
    calls.push(id);
    return Promise.resolve({ id });
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useDocumentLoad', () => {
  it('loads when the id changes and ignores a late response for a previous id', async () => {
    const calls: string[] = [];
    const api: Api = { state: () => null as unknown as DocumentLoad<Row> };
    const { rerender } = render(<Probe documentId={null} load={makeLoad(calls)} api={api} />);

    rerender(<Probe documentId="doc-1" load={makeLoad(calls)} api={api} />);
    await settle();
    expect(calls).toEqual(['doc-1']);
    expect(api.state().documentId).toBe('doc-1');
    expect(api.state().status).toBe('ready');
  });

  it('adopt reports the id ready without fetching', async () => {
    const calls: string[] = [];
    const api: Api = { state: () => null as unknown as DocumentLoad<Row> };
    const { rerender } = render(<Probe documentId={null} load={makeLoad(calls)} api={api} />);

    act(() => api.state().adopt('doc-1'));
    rerender(<Probe documentId="doc-1" load={makeLoad(calls)} api={api} />);
    await settle();

    expect(calls).toEqual([]);
    expect(api.state().status).toBe('ready');
    expect(api.state().documentId).toBe('doc-1');
  });

  it('reloads an adopted id when it is opened again after leaving', async () => {
    const calls: string[] = [];
    const api: Api = { state: () => null as unknown as DocumentLoad<Row> };
    const load = makeLoad(calls);
    const { rerender } = render(<Probe documentId={null} load={load} api={api} />);

    act(() => api.state().adopt('doc-1'));
    rerender(<Probe documentId="doc-1" load={load} api={api} />);
    await settle();
    expect(calls).toEqual([]);

    rerender(<Probe documentId={null} load={load} api={api} />);
    await settle();

    rerender(<Probe documentId="doc-1" load={load} api={api} />);
    await settle();
    expect(calls).toEqual(['doc-1']);
    expect(api.state().status).toBe('ready');
  });

  it('reload forces a fetch even right after adoption', async () => {
    const calls: string[] = [];
    const api: Api = { state: () => null as unknown as DocumentLoad<Row> };
    const load = makeLoad(calls);
    const { rerender } = render(<Probe documentId={null} load={load} api={api} />);

    act(() => api.state().adopt('doc-1'));
    rerender(<Probe documentId="doc-1" load={load} api={api} />);
    await settle();
    expect(calls).toEqual([]);

    act(() => api.state().reload());
    await settle();
    expect(calls).toEqual(['doc-1']);
  });
});
