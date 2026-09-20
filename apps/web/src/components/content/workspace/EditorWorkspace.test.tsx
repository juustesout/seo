import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { evaluateSeo, tiptapEmptyDoc, type TipDoc } from '@seo/contracts';
import { RichTextEditor, type RichTextEditorHandle } from '../RichTextEditor';
import { EditorShell } from '../editor/EditorShell';
import { EditorSelectionProvider, useEditorSelection } from '../editor/EditorSelectionContext';
import { EditorWorkspace } from './EditorWorkspace';

const DOC: TipDoc = tiptapEmptyDoc();

function Harness({ onSaveNow = () => {} }: { onSaveNow?: () => void }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef<RichTextEditorHandle | null>(null);
  return (
    <EditorWorkspace
      doc={DOC}
      editor={editor}
      header={{
        title: 'My article',
        onTitleChange: () => {},
        status: 'draft',
        onStatusChange: () => {},
        saveState: 'saved',
        wordCount: 0,
        slug: 'my-article',
        savedAt: '2026-01-01T00:00:00.000Z',
        canEdit: true,
        canDelete: true,
        busy: false,
        onSaveNow,
        onDelete: () => {},
        onBack: () => {},
      }}
      toolbarAi={{ configured: true, busy: false, hasSelection: false, onAction: () => {} }}
      writing={{
        editorKey: 'test',
        editorRef,
        initialDoc: DOC,
        onDocChange: () => {},
        onEditor: setEditor,
      }}
      assistant={{ configured: true, busy: false }}
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
  );
}

describe('EditorWorkspace', () => {
  it('renders one header, one merged toolbar and a single save indicator', async () => {
    render(<Harness />);
    expect(screen.getByTestId('editor-workspace')).toBeTruthy();
    expect(screen.getByTestId('document-header')).toBeTruthy();
    expect(screen.getByTestId('document-save-state').textContent).toContain('Saved');
    expect(screen.getByTestId('intelligence-rail')).toBeTruthy();
    // The merged toolbar replaces the composition toolbar, so there is no second
    // toolbar (and therefore no second save label) in the product.
    expect(screen.queryByTestId('editor-toolbar')).toBeNull();
    expect(screen.queryByTestId('editor-toolbar-save')).toBeNull();
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy());
  });

  it('keeps the insert rail on-demand and toggled from the header', () => {
    render(<Harness />);
    expect(screen.queryByTestId('editor-sidebar')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Insert' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByTestId('editor-sidebar')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Insert' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    expect(screen.queryByTestId('editor-sidebar')).toBeNull();
  });

  it('saves with Ctrl/Cmd+S', () => {
    const onSaveNow = vi.fn();
    render(<Harness onSaveNow={onSaveNow} />);
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(onSaveNow).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    expect(onSaveNow).toHaveBeenCalledTimes(2);
  });

  it('toggles an in-editor preview without leaving the workspace', async () => {
    render(<Harness />);
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByTestId('preview-pane')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Editing' }));
    expect(screen.queryByTestId('preview-pane')).toBeNull();
  });

  it('exposes one reserved, keyboard-reachable AI place', () => {
    render(<Harness />);
    const slot = screen.getByTestId('inline-assistant');
    expect(slot).toBeTruthy();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(slot);
  });
});

function Probe() {
  const shared = useEditorSelection();
  return <span data-testid="selection-probe">{shared?.selection?.type ?? 'none'}</span>;
}

function SelectionHarness() {
  const [editor, setEditor] = useState<Editor | null>(null);
  return (
    <EditorSelectionProvider>
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
});
