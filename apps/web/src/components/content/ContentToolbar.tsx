import type { ReactNode } from 'react';
import type { Editor } from '@tiptap/react';

interface ToolbarButtonProps {
  title: string;
  label: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

function ToolbarButton({ title, label, active, disabled, onClick }: ToolbarButtonProps) {
  return (
    <button type="button" className={`tb${active ? ' active' : ''}`} title={title} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

/** Markdown-style content controls bound to the Tiptap editor instance. */
export function ContentToolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return <div className="etoolbar muted">Loading editor…</div>;

  const cmd = (fn: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => {
    fn(editor.chain().focus()).run();
  };

  const setHeading = (level: 1 | 2 | 3 | 4) => {
    if (editor.isActive('heading', { level })) {
      cmd((c) => c.setParagraph());
    } else {
      cmd((c) => c.toggleHeading({ level }));
    }
  };

  const setLink = () => {
    const current = editor.getAttributes('link').href as string | undefined;
    const href = window.prompt('Link URL', current ?? 'https://');
    if (href === null) return;
    if (!href.trim()) {
      cmd((c) => c.unsetLink());
      return;
    }
    cmd((c) => c.extendMarkRange('link').setLink({ href: href.trim() }));
  };

  const run = (fn: () => void) => () => fn();

  return (
    <div className="etoolbar">
      <ToolbarButton title="Bold" label={<strong>B</strong>} active={editor.isActive('bold')} onClick={run(() => cmd((c) => c.toggleBold()))} />
      <ToolbarButton title="Italic" label={<em>I</em>} active={editor.isActive('italic')} onClick={run(() => cmd((c) => c.toggleItalic()))} />
      <ToolbarButton title="Strikethrough" label={<s>S</s>} active={editor.isActive('strike')} onClick={run(() => cmd((c) => c.toggleStrike()))} />
      <span className="tb-sep" />
      <ToolbarButton title="Heading 1" label="H1" active={editor.isActive('heading', { level: 1 })} onClick={run(() => setHeading(1))} />
      <ToolbarButton title="Heading 2" label="H2" active={editor.isActive('heading', { level: 2 })} onClick={run(() => setHeading(2))} />
      <ToolbarButton title="Heading 3" label="H3" active={editor.isActive('heading', { level: 3 })} onClick={run(() => setHeading(3))} />
      <ToolbarButton title="Heading 4" label="H4" active={editor.isActive('heading', { level: 4 })} onClick={run(() => setHeading(4))} />
      <span className="tb-sep" />
      <ToolbarButton title="Bullet list" label="• list" active={editor.isActive('bulletList')} onClick={run(() => cmd((c) => c.toggleBulletList()))} />
      <ToolbarButton title="Numbered list" label="1. list" active={editor.isActive('orderedList')} onClick={run(() => cmd((c) => c.toggleOrderedList()))} />
      <ToolbarButton title="Blockquote" label={'"quote"'} active={editor.isActive('blockquote')} onClick={run(() => cmd((c) => c.toggleBlockquote()))} />
      <ToolbarButton title="Code block" label="</>" active={editor.isActive('codeBlock')} onClick={run(() => cmd((c) => c.toggleCodeBlock()))} />
      <span className="tb-sep" />
      <ToolbarButton title="Link" label="Link" active={editor.isActive('link')} onClick={setLink} />
      <ToolbarButton title="Horizontal rule" label="—" onClick={run(() => cmd((c) => c.setHorizontalRule()))} />
      <span className="tb-sep" />
      <ToolbarButton title="Undo" label="undo" disabled={!editor.can().undo()} onClick={run(() => cmd((c) => c.undo()))} />
      <ToolbarButton title="Redo" label="redo" disabled={!editor.can().redo()} onClick={run(() => cmd((c) => c.redo()))} />
    </div>
  );
}
