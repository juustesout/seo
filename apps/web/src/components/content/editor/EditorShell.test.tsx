import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import type { TipDoc } from '@seo/contracts';
import { RichTextEditor } from '../RichTextEditor';
import { EditorShell } from './EditorShell';
import { EditorSelectionProvider, useEditorSelection } from './EditorSelectionContext';
import { EditorToolbar } from './EditorToolbar';
import { ElementSettings } from './ElementSettings';
import { createEditorExtensions } from './extensions';
import type { Editor as TiptapEditor } from '@tiptap/react';

const editors: Editor[] = [];

function makeEditor(content: string | TipDoc = '<p>Hello world</p>'): Editor {
  const editor = new Editor({ extensions: createEditorExtensions({ nodeViews: false }), content });
  editors.push(editor);
  return editor;
}

function paragraphDoc(text: string): TipDoc {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function compositionDoc(): TipDoc {
  return {
    type: 'doc',
    content: [
      {
        type: 'compositionHero',
        content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hero title' }] }],
      },
      {
        type: 'compositionCta',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Get started' }] }],
      },
    ],
  };
}

function ShellHarness({
  initialDoc,
  onSelectionChange,
  onEditor,
}: {
  initialDoc: TipDoc;
  onSelectionChange?: (selection: { type: string; path?: number[] } | null) => void;
  onEditor?: (editor: TiptapEditor | null) => void;
}) {
  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  return (
    <EditorShell editor={editor} onSelectionChange={onSelectionChange}>
      <RichTextEditor
        initialDoc={initialDoc}
        onEditor={(next) => {
          setEditor(next);
          onEditor?.(next);
        }}
      />
    </EditorShell>
  );
}

afterEach(() => {
  while (editors.length > 0) editors.pop()!.destroy();
});

describe('EditorShell', () => {
  it('renders the sidebar, toolbar and canvas', () => {
    render(
      <EditorShell>
        <p>Canvas body</p>
      </EditorShell>,
    );
    expect(screen.getByTestId('editor-shell')).toBeTruthy();
    expect(screen.getByTestId('editor-sidebar')).toBeTruthy();
    expect(screen.getByTestId('editor-toolbar')).toBeTruthy();
    expect(screen.getByTestId('editor-canvas')).toBeTruthy();
    expect(screen.getByText('Canvas body')).toBeTruthy();
  });

  it('switches the sidebar between elements and settings', () => {
    render(
      <EditorShell>
        <p>Canvas body</p>
      </EditorShell>,
    );
    expect(screen.getByTestId('element-browser')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByTestId('editor-shell').getAttribute('data-sidebar-mode')).toBe('settings');
    expect(screen.getByTestId('element-settings').textContent).toContain(
      'Select an element on the canvas to edit its settings.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Elements' }));
    expect(screen.getByTestId('editor-shell').getAttribute('data-sidebar-mode')).toBe('elements');
    expect(screen.getByTestId('element-browser')).toBeTruthy();
  });

  it('stores element selection and opens settings for it', () => {
    const onSelectionChange = vi.fn();
    render(
      <EditorShell onSelectionChange={onSelectionChange}>
        <p>Canvas body</p>
      </EditorShell>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hero' }));
    expect(onSelectionChange).toHaveBeenCalledWith({ type: 'compositionHero' });
    expect(screen.getByTestId('editor-shell').getAttribute('data-selected-type')).toBe('compositionHero');
    expect(screen.getByTestId('editor-shell').getAttribute('data-sidebar-mode')).toBe('settings');
    expect(screen.getByTestId('element-settings').textContent).toContain('Type: Hero');
    expect(screen.getByTestId('element-settings').textContent).toContain('No editable settings yet');
  });

  it('returns from settings to the element browser', () => {
    render(
      <EditorShell>
        <p>Canvas body</p>
      </EditorShell>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hero' }));
    expect(screen.getByTestId('element-settings')).toBeTruthy();
    fireEvent.click(screen.getByTestId('back-to-elements'));
    expect(screen.getByTestId('editor-shell').getAttribute('data-sidebar-mode')).toBe('elements');
    expect(screen.getByTestId('element-browser')).toBeTruthy();
  });

  it('switches to settings when a reveal is requested for the live selection', () => {
    function RevealHarness() {
      const shared = useEditorSelection();
      return (
        <EditorShell>
          <button type="button" onClick={() => shared?.requestReveal()}>
            Reveal
          </button>
        </EditorShell>
      );
    }
    render(
      <EditorSelectionProvider>
        <RevealHarness />
      </EditorSelectionProvider>,
    );
    expect(screen.getByTestId('editor-shell').getAttribute('data-sidebar-mode')).toBe('elements');
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(screen.getByTestId('editor-shell').getAttribute('data-sidebar-mode')).toBe('settings');
  });

  it('lists composition elements in the browser', () => {
    render(
      <EditorShell>
        <p>Canvas body</p>
      </EditorShell>,
    );
    expect(screen.getByText('Composition')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hero' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Section' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Feature Grid' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Feature Card' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'CTA' })).toBeTruthy();
  });

  it('updates settings from the current selection', () => {
    const { rerender } = render(<ElementSettings selection={{ type: 'image', id: 'img-1', path: [2] }} />);
    expect(screen.getByTestId('element-settings').textContent).toContain('Media is chosen from the project library.');
    rerender(<ElementSettings selection={{ type: 'compositionFeatureCard', path: [1, 0, 0] }} />);
    expect(screen.getByTestId('element-settings').textContent).toContain('Type: Feature Card');
    expect(screen.getByTestId('element-settings-path').textContent).toContain('1.0.0');
    rerender(<ElementSettings selection={{ type: 'notARealType' }} />);
    expect(screen.getByTestId('element-settings').textContent).toContain('No settings available for this element.');
  });
});

describe('EditorToolbar', () => {
  it('undo and redo stay bound to the Tiptap editor', () => {
    const editor = makeEditor('<p>Hello</p>');
    editor.commands.setTextSelection(6);
    editor.commands.insertContent(' world');
    expect(editor.getText()).toBe('Hello world');

    render(<EditorToolbar editor={editor} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(editor.getText()).toBe('Hello');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(editor.getText()).toContain('Hello world');
  });
});

describe('RichTextEditor inside the shell', () => {
  it('keeps existing text and image editing', async () => {
    const doc: TipDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Existing copy' }] },
        { type: 'image', attrs: { mediaId: 'm1', src: 'https://cdn.example/a.png', alt: 'Alt' } },
      ],
    };
    const { container } = render(<ShellHarness initialDoc={doc} />);
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy());
    expect(container.querySelector('.ProseMirror')?.textContent).toContain('Existing copy');
    expect(container.querySelector('img[data-media-id="m1"]')).toBeTruthy();
  });

  it('renders compositionHero and compositionCta', async () => {
    const { container } = render(<ShellHarness initialDoc={compositionDoc()} />);
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy());
    expect(container.querySelector('[data-composition="compositionHero"]')?.textContent).toContain('Hero title');
    expect(container.querySelector('[data-composition="compositionCta"]')?.textContent).toContain('Get started');
  });

  it('does not crash on unknown element types', async () => {
    const doc: TipDoc = {
      type: 'doc',
      content: [
        { type: 'notARealNode' },
        {
          type: 'featureGrid',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Still here' }] }],
        },
      ],
    };
    const { container } = render(<ShellHarness initialDoc={doc} />);
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy());
    const text = container.querySelector('.ProseMirror')?.textContent ?? '';
    expect(text).toContain('[unsupported:notARealNode]');
    expect(text).toContain('Still here');
  });

  it('selects a canvas element into shell state', async () => {
    const onSelectionChange = vi.fn();
    const { container } = render(
      <ShellHarness initialDoc={paragraphDoc('Click me')} onSelectionChange={onSelectionChange} />,
    );
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy());
    await waitFor(() => {
      fireEvent.pointerUp(screen.getByTestId('editor-canvas'));
      expect(onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({ type: 'paragraph' }));
    });
    expect(screen.getByTestId('editor-shell').getAttribute('data-selected-type')).toBe('paragraph');
  });

  it('inserts Hero from the element browser into the canvas', async () => {
    const { container } = render(<ShellHarness initialDoc={paragraphDoc('Existing copy')} />);
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Hero' }));
    await waitFor(() => expect(container.querySelector('[data-composition="compositionHero"]')).toBeTruthy());
    expect(screen.getByTestId('editor-shell').getAttribute('data-sidebar-mode')).toBe('settings');
    expect(screen.getByTestId('editor-shell').getAttribute('data-selected-type')).toBe('compositionHero');
    expect(screen.getByTestId('element-settings').textContent).toContain('Type: Hero');
  });

  it('inserts Section from the element browser', async () => {
    const { container } = render(<ShellHarness initialDoc={paragraphDoc('Existing copy')} />);
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Section' }));
    await waitFor(() => expect(container.querySelector('[data-composition="compositionSection"]')).toBeTruthy());
    expect(screen.getByTestId('editor-shell').getAttribute('data-selected-type')).toBe('compositionSection');
  });
});
