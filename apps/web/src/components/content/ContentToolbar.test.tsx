/**
 * R5.6.2: the content toolbar keeps a deliberately calm persistent bar (bold,
 * italic, undo/redo) and folds every block/structural command into one `Format`
 * overflow. These tests pin both halves of that contract: nothing permanent is
 * lost, and the overflow still runs the same chain commands.
 */
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { tiptapEmptyDoc } from '@seo/contracts';
import { ContentToolbar } from './ContentToolbar';
import { RichTextEditor } from './RichTextEditor';

function Harness({ ai = false, onEditor }: { ai?: boolean; onEditor?: (editor: Editor | null) => void }) {
  const [editor, setEditor] = useState<Editor | null>(null);
  return (
    <>
      <ContentToolbar
        editor={editor}
        ai={ai ? { configured: true, busy: false, hasSelection: false, onAction: () => {} } : undefined}
      />
      <RichTextEditor
        initialDoc={tiptapEmptyDoc()}
        onEditor={(next) => {
          setEditor(next);
          onEditor?.(next);
        }}
      />
    </>
  );
}

async function mountedEditor() {
  await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy());
}

describe('ContentToolbar', () => {
  it('renders only the high-frequency controls persistently', async () => {
    render(<Harness />);
    await mountedEditor();

    expect(screen.getByTitle('Bold')).toBeTruthy();
    expect(screen.getByTitle('Italic')).toBeTruthy();
    expect(screen.getByTitle('Undo')).toBeTruthy();
    expect(screen.getByTitle('Redo')).toBeTruthy();
    expect(screen.getByText('Format')).toBeTruthy();
  });

  it('keeps every block and structural command reachable in the Format overflow', async () => {
    render(<Harness />);
    await mountedEditor();

    for (const name of [
      'Strikethrough',
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Heading 4',
      'Bullet list',
      'Numbered list',
      'Blockquote',
      'Code block',
      'Link',
      'Horizontal rule',
    ]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('runs a block command from the overflow against the live editor', async () => {
    let editor: Editor | null = null;
    render(<Harness onEditor={(next) => { editor = next; }} />);
    await waitFor(() => expect(editor).not.toBeNull());

    act(() => {
      editor!.commands.insertContent('Hello');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Heading 1' }));
    expect(editor!.isActive('heading', { level: 1 })).toBe(true);
  });

  it('runs an inline mark from the persistent bar against the live editor', async () => {
    let editor: Editor | null = null;
    render(<Harness onEditor={(next) => { editor = next; }} />);
    await waitFor(() => expect(editor).not.toBeNull());

    act(() => {
      editor!.commands.insertContent('Hello');
    });
    act(() => {
      editor!.commands.setTextSelection({ from: 1, to: 6 });
    });
    fireEvent.click(screen.getByTitle('Bold'));
    expect(editor!.isActive('bold')).toBe(true);
  });

  it('shows the AI menu only when an AI descriptor is provided', async () => {
    const { rerender } = render(<Harness />);
    await waitFor(() => expect(document.querySelector('.ProseMirror')).toBeTruthy());
    expect(screen.queryByText('AI')).toBeNull();

    rerender(<Harness ai />);
    expect(screen.getByText('AI')).toBeTruthy();
  });

  it('renders a loading state before the editor initializes', () => {
    render(<ContentToolbar editor={null} />);
    expect(screen.getByText('Loading editor…')).toBeTruthy();
  });
});
