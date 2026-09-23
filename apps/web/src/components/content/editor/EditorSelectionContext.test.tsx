/**
 * R5.2.4 canonical selection acceptance tests.
 *
 * One owner (the selection provider) publishes a normalized, document-scoped
 * selection. EditorContext and the composition surface derive from it, and the
 * selection is cleared - never carried - when the document identity changes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Editor } from '@tiptap/core';
import { type DocumentOperationBatch, type TipDoc } from '@seo/contracts';
import { createEditorExtensions } from './extensions';
import { EditorSelectionProvider, useEditorSelection } from './EditorSelectionContext';
import { EditorContextProvider, useEditorContext } from './EditorContext';
import { snapshotHasSelection } from './selection';
import { documentRevisionOf } from '../documentRevision';

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

const HERO_DOC: TipDoc = {
  type: 'doc',
  content: [
    {
      type: 'compositionHero',
      content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hero title' }] }],
    },
  ],
};

function Probe() {
  const shared = useEditorSelection();
  const context = useEditorContext();
  return (
    <div>
      <span data-testid="canonical">{shared?.selection.type ?? 'none'}</span>
      <span data-testid="element">{shared?.element?.type ?? 'none'}</span>
      <span data-testid="has">{shared ? String(snapshotHasSelection(shared.selection)) : 'none'}</span>
      <span data-testid="context">{context?.snapshot.selection.type ?? 'none'}</span>
      <span data-testid="context-from">{String(context?.snapshot.selection.from ?? -1)}</span>
    </div>
  );
}

function Harness({
  editor,
  documentId = 'c1',
}: {
  editor: Editor | null;
  documentId?: string | null;
}) {
  return (
    <EditorSelectionProvider editor={editor} documentId={documentId}>
      <EditorContextProvider projectId="p1" contentId={documentId} ready doc={DOC} dirty={false} editor={editor}>
        <Probe />
      </EditorContextProvider>
    </EditorSelectionProvider>
  );
}

function wrapperFor(editor: Editor | null, documentId = 'c1') {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <EditorSelectionProvider editor={editor} documentId={documentId}>
        <EditorContextProvider projectId="p1" contentId={documentId} ready doc={DOC} dirty={false} editor={editor}>
          {children}
        </EditorContextProvider>
      </EditorSelectionProvider>
    );
  };
}

describe('R5.2.4 canonical selection', () => {
  it('1. selects a block: one canonical value, the EditorContext projection and true', async () => {
    const editor = makeEditor(HERO_DOC);
    render(<Harness editor={editor} />);
    await waitFor(() => expect(screen.getByTestId('canonical').textContent).toBe('cursor'));

    act(() => {
      editor.commands.setNodeSelection(0);
    });

    await waitFor(() => expect(screen.getByTestId('canonical').textContent).toBe('node'));
    expect(screen.getByTestId('element').textContent).toBe('compositionHero');
    expect(screen.getByTestId('has').textContent).toBe('true');
    // EditorContext is a projection of the same value, not a second selection.
    expect(screen.getByTestId('context').textContent).toBe('node');
  });

  it('2. clears to an empty canonical value, no projection and false', async () => {
    const editor = makeEditor(DOC);
    const { rerender } = render(<Harness editor={editor} />);
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });
    await waitFor(() => expect(screen.getByTestId('has').textContent).toBe('true'));

    // A collapsed cursor is not a selection: the derived flag goes false.
    act(() => {
      editor.commands.setTextSelection(1);
    });
    await waitFor(() => expect(screen.getByTestId('canonical').textContent).toBe('cursor'));
    expect(screen.getByTestId('has').textContent).toBe('false');

    // Losing the editor clears the canonical value end to end.
    rerender(<Harness editor={null} />);
    await waitFor(() => expect(screen.getByTestId('canonical').textContent).toBe('none'));
    expect(screen.getByTestId('element').textContent).toBe('none');
    expect(screen.getByTestId('has').textContent).toBe('false');
    expect(screen.getByTestId('context').textContent).toBe('none');
  });

  it('3. changing the selection never leaves stale ownership', async () => {
    const editor = makeEditor(HERO_DOC);
    render(<Harness editor={editor} />);
    await waitFor(() => expect(screen.getByTestId('canonical').textContent).toBe('cursor'));

    act(() => {
      editor.commands.setTextSelection(3);
    });
    await waitFor(() => expect(screen.getByTestId('element').textContent).toBe('heading'));

    // Move onto the hero node: the previous cursor context is replaced wholesale.
    act(() => {
      editor.commands.setNodeSelection(0);
    });
    await waitFor(() => expect(screen.getByTestId('canonical').textContent).toBe('node'));
    expect(screen.getByTestId('element').textContent).toBe('compositionHero');
    expect(screen.getByTestId('context').textContent).toBe('node');
  });

  it('4. switching documents clears the selection instead of carrying it over', async () => {
    const editor = makeEditor(DOC);
    const { rerender } = render(<Harness editor={editor} documentId="doc-A" />);
    act(() => {
      editor.commands.setTextSelection({ from: 1, to: 6 });
    });
    await waitFor(() => expect(screen.getByTestId('has').textContent).toBe('true'));

    rerender(<Harness editor={editor} documentId="doc-B" />);
    await waitFor(() => expect(screen.getByTestId('canonical').textContent).toBe('none'));
    expect(screen.getByTestId('element').textContent).toBe('none');
    expect(screen.getByTestId('has').textContent).toBe('false');
    expect(screen.getByTestId('context').textContent).toBe('none');
  });

  it('5. a switch that does not change identity preserves the selection', async () => {
    const editor = makeEditor(DOC);
    const { rerender } = render(<Harness editor={editor} documentId="doc-A" />);
    act(() => {
      editor.commands.setTextSelection(8);
    });
    await waitFor(() => expect(screen.getByTestId('context-from').textContent).toBe('8'));

    // A failed switch keeps the same document identity, so nothing clears.
    rerender(<Harness editor={editor} documentId="doc-A" />);
    expect(screen.getByTestId('context-from').textContent).toBe('8');
    expect(screen.getByTestId('has').textContent).toBe('false');
  });

  it('6. a selection-aware editor operation updates the canonical selection', async () => {
    const editor = makeEditor(DOC);
    const batch: DocumentOperationBatch = {
      version: 1,
      baseRevision: documentRevisionOf(DOC),
      operations: [
        { type: 'insert_section', ref: 's1', section: { kind: 'hero' }, position: { mode: 'document_start' } },
        {
          type: 'insert_image',
          target: { mode: 'ref', ref: 's1' },
          image: { assetId: 'm1', url: 'https://cdn.test/amsterdam.png', alt: 'Amsterdam' },
        },
      ],
    };

    const { result } = renderHook(
      () => ({ context: useEditorContext(), shared: useEditorSelection() }),
      { wrapper: wrapperFor(editor) },
    );

    act(() => {
      const outcome = result.current.context!.applyDocumentOperations(batch, documentRevisionOf(DOC));
      expect(outcome).toEqual({ ok: true });
    });

    await waitFor(() => expect(result.current.shared?.element?.type).toBe('image'));
    expect(snapshotHasSelection(result.current.shared!.selection)).toBe(true);
    expect(result.current.context!.snapshot.selection.type).toBe('node');
  });
});
