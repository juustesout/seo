/**
 * R5.3.2: `EditorWorkspace` is the editor canvas only. Workspace chrome
 * (document header, save status, assistant entry) and the editor context
 * providers are owned by `ProjectWorkspaceShell`, so this suite covers the
 * canvas: merged toolbar, preview toggle, insert rail and selection.
 */
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { evaluateSeo, tiptapEmptyDoc, type TipDoc } from '@seo/contracts';
import { RichTextEditor, type RichTextEditorHandle } from '../RichTextEditor';
import { EditorShell } from '../editor/EditorShell';
import { EditorSelectionProvider, useEditorSelection } from '../editor/EditorSelectionContext';
import { EditorWorkspace } from './EditorWorkspace';

const DOC: TipDoc = tiptapEmptyDoc();

function Harness({
  preview = false,
  railOpen = false,
  onEditor,
}: {
  preview?: boolean;
  railOpen?: boolean;
  onEditor?: (editor: Editor | null) => void;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef<RichTextEditorHandle | null>(null);
  return (
    <EditorSelectionProvider editor={editor}>
      <EditorWorkspace
        doc={DOC}
        editor={editor}
        preview={preview}
        railOpen={railOpen}
        toolbarAi={{ configured: true, busy: false, hasSelection: false, onAction: () => {} }}
        writing={{
          editorKey: 'test',
          editorRef,
          initialDoc: DOC,
          onDocChange: () => {},
          onEditor: (next) => {
            setEditor(next);
            onEditor?.(next);
          },
        }}
        rail={{
          outline: [],
          onSelectHeading: () => {},
          seo: {
            result: evaluateSeo({
              doc: DOC,
              meta: { title: 'My article', targetKeyword: null, metaTitle: null, metaDescription: null },
            }),
            targetKeyword: '',
            metaTitle: '',
            metaDescription: '',
            onKeywordChange: () => {},
            onMetaTitleChange: () => {},
            onMetaDescriptionChange: () => {},
          },
        }}
      />
    </EditorSelectionProvider>
  );
}

describe('EditorWorkspace canvas', () => {
  it('renders the merged toolbar and canvas without workspace chrome', async () => {
    render(<Harness />);
    expect(screen.getByTestId('editor-workspace')).toBeTruthy();
    expect(screen.getByTestId('intelligence-rail')).toBeTruthy();
    // The header, save indicator and assistant entry belong to the shell now.
    expect(screen.queryByTestId('document-header')).toBeNull();
    expect(screen.queryByTestId('document-save-state')).toBeNull();
    expect(screen.queryByTestId('inline-assistant')).toBeNull();
    // The merged toolbar replaces the composition toolbar, so there is no second
    // toolbar (and therefore no second save label) in the product.
    expect(screen.queryByTestId('editor-toolbar')).toBeNull();
    expect(screen.queryByTestId('editor-toolbar-save')).toBeNull();
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy());
  });

  it('hides the canvas and shows the rendered preview when the shell toggles preview', async () => {
    const { rerender } = render(<Harness />);
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy());
    expect(screen.queryByTestId('preview-pane')).toBeNull();
    rerender(<Harness preview />);
    expect(screen.getByTestId('preview-pane')).toBeTruthy();
  });

  it('shows the insert rail only when the shell opens it', () => {
    const { rerender } = render(<Harness />);
    expect(screen.queryByTestId('editor-sidebar')).toBeNull();
    rerender(<Harness railOpen />);
    expect(screen.getByTestId('editor-sidebar')).toBeTruthy();
  });
});

function Probe() {
  const shared = useEditorSelection();
  return <span data-testid="selection-probe">{shared?.element?.type ?? 'none'}</span>;
}

function SelectionHarness() {
  const [editor, setEditor] = useState<Editor | null>(null);
  return (
    <EditorSelectionProvider editor={editor}>
      <Probe />
      <EditorShell editor={editor}>
        <RichTextEditor initialDoc={DOC} onEditor={setEditor} />
      </EditorShell>
    </EditorSelectionProvider>
  );
}

describe('EditorWorkspace selection', () => {
  it('lifts the active element out of the composition surface into shared context', async () => {
    render(<SelectionHarness />);
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Hero' }));
    await waitFor(() => expect(screen.getByTestId('selection-probe').textContent).toBe('compositionHero'));
  });

  it('derives AI selection availability from the canonical selection, not a view-owned flag', async () => {
    let editor: Editor | null = null;
    render(<Harness onEditor={(next) => { editor = next; }} />);
    await waitFor(() => expect(editor).not.toBeNull());

    // The view passed hasSelection:false; the workspace must ignore that stale
    // flag and follow the canonical selection instead.
    const rewrite = () => screen.getByRole('button', { name: /^Rewrite/ }) as HTMLButtonElement;
    expect(rewrite().disabled).toBe(true);

    act(() => {
      editor!.commands.insertContent('Hello world');
    });
    act(() => {
      editor!.commands.setTextSelection({ from: 1, to: 6 });
    });
    await waitFor(() => expect(rewrite().disabled).toBe(false));

    act(() => {
      editor!.commands.setTextSelection(1);
    });
    await waitFor(() => expect(rewrite().disabled).toBe(true));
  });
});
