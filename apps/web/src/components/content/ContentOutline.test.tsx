/**
 * R5.6.3: the Outline is the Intelligence Rail's contextual navigation. It reads
 * the current document's headings (`docHeadings`, which lists only headings with
 * text) and clicking an item must jump to that same heading in the editor, even
 * when the document contains empty headings the outline never lists.
 */
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { docHeadings, type TipDoc } from '@seo/contracts';
import { ContentOutline } from './ContentOutline';
import { RichTextEditor, type RichTextEditorHandle } from './RichTextEditor';

const DOC: TipDoc = {
  type: 'doc',
  content: [
    // An empty heading precedes the listed ones on purpose: `docHeadings`
    // ignores it, so outline indices must ignore it too.
    { type: 'heading', attrs: { level: 2 }, content: [] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'First' }] },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Second' }] },
  ],
};

function Harness({ onEditor }: { onEditor?: (editor: Editor | null) => void }) {
  const ref = useRef<RichTextEditorHandle | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  return (
    <>
      <ContentOutline items={docHeadings(DOC)} onSelect={(index) => ref.current?.selectHeading(index)} />
      <RichTextEditor
        ref={ref}
        initialDoc={DOC}
        onEditor={(next) => {
          setEditor(next);
          onEditor?.(next);
        }}
      />
      <span data-testid="ready">{editor ? 'yes' : 'no'}</span>
    </>
  );
}

describe('ContentOutline', () => {
  it('lists the document headings and reports the clicked index', () => {
    const onSelect = vi.fn();
    render(<ContentOutline items={[{ level: 1, text: 'Intro' }, { level: 2, text: 'Details' }]} onSelect={onSelect} />);
    expect(screen.getByRole('button', { name: 'Intro' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('shows an honest empty state when the document has no headings', () => {
    render(<ContentOutline items={[]} onSelect={() => {}} />);
    expect(screen.getByText(/No headings yet/)).toBeTruthy();
  });

  it('jumps to the same heading the outline lists, skipping empty headings', async () => {
    let editor: Editor | null = null;
    render(<Harness onEditor={(next) => { editor = next; }} />);
    await waitFor(() => expect(editor).not.toBeNull());

    // Index 1 in the outline is "Second"; an empty heading sits before the
    // listed headings in the document and must not shift the target.
    fireEvent.click(screen.getByRole('button', { name: 'Second' }));
    expect(editor!.state.selection.$from.parent.textContent).toBe('Second');

    fireEvent.click(screen.getByRole('button', { name: 'First' }));
    expect(editor!.state.selection.$from.parent.textContent).toBe('First');
  });
});
