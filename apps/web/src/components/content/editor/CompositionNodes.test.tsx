import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import type { TipDoc, TipNode } from '@seo/contracts';
import { RichTextEditor } from '../RichTextEditor';
import { EditorShell } from './EditorShell';
import { createEditorExtensions } from './extensions';
import { insertComposition } from './insertComposition';
import { readCanvasSelection } from './selection';
import type { Editor as TiptapEditor } from '@tiptap/react';

const editors: Editor[] = [];

function makeEditor(content: TipDoc): Editor {
  const editor = new Editor({
    extensions: createEditorExtensions({ nodeViews: false }),
    content,
  });
  editors.push(editor);
  return editor;
}

function card(title: string, body: string): TipNode {
  return {
    type: 'compositionFeatureCard',
    content: [
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: title }] },
      { type: 'paragraph', content: [{ type: 'text', text: body }] },
    ],
  };
}

function nestedDoc(): TipDoc {
  return {
    type: 'doc',
    content: [
      {
        type: 'compositionHero',
        content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hero title' }] }],
      },
      {
        type: 'compositionSection',
        content: [
          {
            type: 'compositionFeatureGrid',
            content: [card('One', 'First'), card('Two', 'Second'), card('Three', 'Third')],
          },
        ],
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

function posOfType(editor: TiptapEditor, type: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found !== -1) return false;
    if (node.type.name === type) found = pos;
    return true;
  });
  return found;
}

afterEach(() => {
  while (editors.length > 0) editors.pop()!.destroy();
});

describe('composition NodeViews', () => {
  it('renders hero, section, feature grid, feature card and cta', async () => {
    const { container } = render(<ShellHarness initialDoc={nestedDoc()} />);
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy());
    expect(container.querySelector('[data-composition="compositionHero"]')?.textContent).toContain('Hero title');
    expect(container.querySelector('[data-composition="compositionSection"]')).toBeTruthy();
    expect(container.querySelector('[data-composition="compositionFeatureGrid"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-composition="compositionFeatureCard"]')).toHaveLength(3);
    expect(container.querySelector('[data-composition="compositionCta"]')?.textContent).toContain('Get started');
  });

  it('keeps FeatureCard copy as editable Tiptap content', async () => {
    const { container } = render(<ShellHarness initialDoc={nestedDoc()} />);
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy());
    const firstCard = container.querySelector('[data-composition="compositionFeatureCard"]');
    expect(firstCard?.querySelector('h3')?.textContent).toBe('One');
    expect(firstCard?.querySelector('p')?.textContent).toBe('First');
    expect(firstCard?.querySelector('.seo-composition__content')).toBeTruthy();
  });

  it('marks a selected composition node visually', async () => {
    let live: TiptapEditor | null = null;
    const { container } = render(<ShellHarness initialDoc={nestedDoc()} onEditor={(e) => { live = e; }} />);
    await waitFor(() => expect(live).toBeTruthy());
    live!.commands.setNodeSelection(posOfType(live!, 'compositionHero'));
    await waitFor(() =>
      expect(container.querySelector('[data-composition="compositionHero"]')?.getAttribute('data-selected')).toBe(
        'true',
      ),
    );
    expect(container.querySelector('.seo-composition-selected')).toBeTruthy();
  });

  it('reports composition type and path to EditorShell', async () => {
    const onSelectionChange = vi.fn();
    let live: TiptapEditor | null = null;
    render(
      <ShellHarness
        initialDoc={nestedDoc()}
        onSelectionChange={onSelectionChange}
        onEditor={(e) => {
          live = e;
        }}
      />,
    );
    await waitFor(() => expect(live).toBeTruthy());
    live!.commands.setNodeSelection(posOfType(live!, 'compositionFeatureCard'));
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'compositionFeatureCard', path: [1, 0, 0] }),
      ),
    );
    expect(screen.getByTestId('editor-shell').getAttribute('data-selected-type')).toBe('compositionFeatureCard');
  });
});

describe('composition JSON roundtrip', () => {
  it('preserves nested Section / FeatureGrid / FeatureCard structure', () => {
    const editor = makeEditor(nestedDoc());
    const json = editor.getJSON() as TipDoc;
    const again = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: json,
    });
    editors.push(again);
    expect(again.getJSON()).toEqual(json);
    expect(json.content?.[1]?.type).toBe('compositionSection');
    expect(json.content?.[1]?.content?.[0]?.type).toBe('compositionFeatureGrid');
    expect(json.content?.[1]?.content?.[0]?.content?.map((node) => node.type)).toEqual([
      'compositionFeatureCard',
      'compositionFeatureCard',
      'compositionFeatureCard',
    ]);
  });

  it('lets FeatureCard text be edited without dropping the structure', () => {
    const editor = makeEditor(nestedDoc());
    editor.commands.setTextSelection(editor.state.doc.content.size - 8);
    editor.commands.insertContent(' now');
    const json = editor.getJSON() as TipDoc;
    expect(json.content?.[1]?.content?.[0]?.type).toBe('compositionFeatureGrid');
    expect(editor.getText()).toContain('now');
  });
});

describe('composition selection paths', () => {
  it('returns type and path for a nested FeatureCard', () => {
    const editor = makeEditor(nestedDoc());
    let cardPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (cardPos !== -1) return false;
      if (node.type.name === 'compositionFeatureCard') cardPos = pos;
      return true;
    });
    editor.commands.setNodeSelection(cardPos);
    expect(readCanvasSelection(editor)).toEqual(
      expect.objectContaining({ type: 'compositionFeatureCard', path: [1, 0, 0] }),
    );
  });
});

describe('composition insertion commands', () => {
  it('inserts a Section that can hold a FeatureGrid', () => {
    const editor = makeEditor({ type: 'doc', content: [{ type: 'paragraph' }] });
    expect(insertComposition(editor, 'compositionSection')).toBe(true);
    expect(insertComposition(editor, 'compositionFeatureGrid')).toBe(true);
    const json = editor.getJSON() as TipDoc;
    const section = json.content?.find((node) => node.type === 'compositionSection');
    const grid = json.content?.find((node) => node.type === 'compositionFeatureGrid')
      ?? section?.content?.find((node) => node.type === 'compositionFeatureGrid');
    expect(grid?.type).toBe('compositionFeatureGrid');
    expect(grid?.content?.every((node) => node.type === 'compositionFeatureCard')).toBe(true);
  });
});

describe('composition editor UX', () => {
  it('opens settings for a nested FeatureCard and can return to elements', async () => {
    const onSelectionChange = vi.fn();
    let live: TiptapEditor | null = null;
    render(
      <ShellHarness
        initialDoc={nestedDoc()}
        onSelectionChange={onSelectionChange}
        onEditor={(e) => {
          live = e;
        }}
      />,
    );
    await waitFor(() => expect(live).toBeTruthy());
    live!.commands.setNodeSelection(posOfType(live!, 'compositionFeatureCard'));
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'compositionFeatureCard', path: [1, 0, 0] }),
      ),
    );
    expect(screen.getByTestId('editor-shell').getAttribute('data-selected-path')).toBe('1.0.0');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByTestId('element-settings').textContent).toContain('Type: Feature Card');
    fireEvent.click(screen.getByTestId('back-to-elements'));
    expect(screen.getByTestId('element-browser')).toBeTruthy();
  });
});
