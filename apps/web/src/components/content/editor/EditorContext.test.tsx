import { afterEach, describe, expect, it } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Editor } from '@tiptap/core';
import { CANONICAL_DOCUMENT_VERSION, contentRevisionOf, type CanonicalDocument, type TipDoc } from '@seo/contracts';
import { createEditorExtensions } from './extensions';
import { EditorContextProvider, useEditorContext } from './EditorContext';
import type { ExternalEditorDocumentResult } from './editorContext';

const editors: Editor[] = [];

function makeEditor(content: TipDoc): Editor {
  const editor = new Editor({ extensions: createEditorExtensions({ nodeViews: false }), content });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  while (editors.length > 0) editors.pop()!.destroy();
});

const DOC: TipDoc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
};

const APPLIED: CanonicalDocument = {
  version: CANONICAL_DOCUMENT_VERSION,
  blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Applied' }] }],
};

function Probe() {
  const context = useEditorContext();
  const snapshot = context?.snapshot;
  return (
    <div>
      <span data-testid="ids">{snapshot ? `${snapshot.projectId}/${snapshot.contentId}` : 'none'}</span>
      <span data-testid="ready">{String(snapshot?.ready)}</span>
      <span data-testid="revision">{snapshot?.document.revision ?? 'none'}</span>
      <span data-testid="dirty">{String(snapshot?.document.dirty)}</span>
      <span data-testid="canonical">{snapshot?.document.canonical ? 'yes' : 'no'}</span>
      <span data-testid="selection">{snapshot?.selection.type ?? 'none'}</span>
      <span data-testid="nodeType">{snapshot?.selection.nodeType ?? ''}</span>
      <span data-testid="from">{String(snapshot?.selection.from ?? -1)}</span>
    </div>
  );
}

function Harness({
  editor,
  doc,
  contentId = 'c1',
  dirty = false,
  ready = true,
}: {
  editor: Editor | null;
  doc: TipDoc;
  contentId?: string | null;
  dirty?: boolean;
  ready?: boolean;
}) {
  return (
    <EditorContextProvider projectId="p1" contentId={contentId} ready={ready} doc={doc} dirty={dirty} editor={editor}>
      <Probe />
    </EditorContextProvider>
  );
}

function wrapperFor(editor: Editor | null, doc: TipDoc, ready = true) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <EditorContextProvider projectId="p1" contentId="c1" ready={ready} doc={doc} dirty={false} editor={editor}>
        {children}
      </EditorContextProvider>
    );
  };
}

describe('EditorContextProvider snapshot', () => {
  it('exposes identity, revision and the canonical document', async () => {
    const editor = makeEditor(DOC);
    render(<Harness editor={editor} doc={DOC} />);

    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('p1/c1'));
    expect(screen.getByTestId('ready').textContent).toBe('true');
    expect(screen.getByTestId('revision').textContent).toBe(contentRevisionOf(DOC));
    expect(screen.getByTestId('canonical').textContent).toBe('yes');
    expect(screen.getByTestId('dirty').textContent).toBe('false');
  });

  it('is inert while not ready', async () => {
    const editor = makeEditor(DOC);
    render(<Harness editor={editor} doc={DOC} ready={false} />);

    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('false'));
    expect(screen.getByTestId('revision').textContent).toBe('none');
    expect(screen.getByTestId('canonical').textContent).toBe('no');
    expect(screen.getByTestId('dirty').textContent).toBe('false');
  });

  it('tracks dirty state from the document owner', async () => {
    const editor = makeEditor(DOC);
    const { rerender } = render(<Harness editor={editor} doc={DOC} dirty={false} />);
    await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe('false'));

    rerender(<Harness editor={editor} doc={DOC} dirty />);
    await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe('true'));
  });

  it('normalizes cursor and text selections from the editor', async () => {
    const editor = makeEditor(DOC);
    render(<Harness editor={editor} doc={DOC} />);

    act(() => {
      editor.commands.setTextSelection(3);
    });
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('cursor'));
    expect(screen.getByTestId('nodeType').textContent).toBe('paragraph');
    expect(screen.getByTestId('from').textContent).toBe('3');

    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });
    await waitFor(() => expect(screen.getByTestId('selection').textContent).toBe('text'));
  });

  it('does not carry a selection from a previous document', async () => {
    const editorA = makeEditor(DOC);
    const { rerender } = render(<Harness editor={editorA} doc={DOC} contentId="c1" />);
    act(() => {
      editorA.commands.setTextSelection(8);
    });
    await waitFor(() => expect(screen.getByTestId('from').textContent).toBe('8'));

    const editorB = makeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New doc' }] }] });
    rerender(
      <Harness
        editor={editorB}
        doc={{ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New doc' }] }] }}
        contentId="c2"
      />,
    );

    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('p1/c2'));
    expect(screen.getByTestId('from').textContent).not.toBe('8');
  });
});

describe('EditorContextProvider applyExternalDocument', () => {
  it('applies a matching document through the editor', () => {
    const editor = makeEditor(DOC);
    const { result } = renderHook(() => useEditorContext(), { wrapper: wrapperFor(editor, DOC) });

    let outcome: ExternalEditorDocumentResult | undefined;
    act(() => {
      outcome = result.current!.applyExternalDocument({ canonical: APPLIED, expectedRevision: contentRevisionOf(DOC) });
    });

    expect(outcome).toEqual({ ok: true });
    expect(editor.getText()).toBe('Applied');
  });

  it('rejects a stale revision without touching the editor', () => {
    const editor = makeEditor(DOC);
    const { result } = renderHook(() => useEditorContext(), { wrapper: wrapperFor(editor, DOC) });

    let outcome: ExternalEditorDocumentResult | undefined;
    act(() => {
      outcome = result.current!.applyExternalDocument({
        canonical: APPLIED,
        expectedRevision: 'rev1:0000000000000000',
      });
    });

    expect(outcome).toEqual({ ok: false, reason: 'stale-revision' });
    expect(editor.getText()).toBe('Hello world');
  });

  it('rejects a document it cannot represent', () => {
    const editor = makeEditor(DOC);
    const { result } = renderHook(() => useEditorContext(), { wrapper: wrapperFor(editor, DOC) });

    let outcome: ExternalEditorDocumentResult | undefined;
    act(() => {
      outcome = result.current!.applyExternalDocument({
        canonical: { version: 1, blocks: 'nope' } as unknown as CanonicalDocument,
        expectedRevision: contentRevisionOf(DOC),
      });
    });

    expect(outcome).toEqual({ ok: false, reason: 'unrepresentable' });
    expect(editor.getText()).toBe('Hello world');
  });

  it('reports no editor and a not-ready context', () => {
    const noEditor = renderHook(() => useEditorContext(), { wrapper: wrapperFor(null, DOC) });
    let outcome: ExternalEditorDocumentResult | undefined;
    act(() => {
      outcome = noEditor.result.current!.applyExternalDocument({
        canonical: APPLIED,
        expectedRevision: contentRevisionOf(DOC),
      });
    });
    expect(outcome).toEqual({ ok: false, reason: 'no-editor' });

    const editor = makeEditor(DOC);
    const notReady = renderHook(() => useEditorContext(), { wrapper: wrapperFor(editor, DOC, false) });
    let notReadyOutcome: ExternalEditorDocumentResult | undefined;
    act(() => {
      notReadyOutcome = notReady.result.current!.applyExternalDocument({
        canonical: APPLIED,
        expectedRevision: contentRevisionOf(DOC),
      });
    });
    expect(notReadyOutcome).toEqual({ ok: false, reason: 'not-ready' });
  });
});
