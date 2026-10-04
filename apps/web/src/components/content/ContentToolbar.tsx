/**
 * Content Studio editor toolbar. Bound directly to the live Tiptap instance the
 * parent hands in - it reads active marks and runs chain commands, so it has no
 * document state of its own and works identically for every article. The AI
 * dropdown only enables actions the project can actually perform (configured
 * account key + a real text selection), otherwise it explains why it is
 * disabled instead of offering a dead action.
 *
 * Since R5.6.2 the bar is deliberately calm: only the highest-frequency inline
 * controls (bold, italic) and history stay permanently visible, and every
 * block/structural command lives in the `Format` overflow so the writing canvas
 * dominates. No command is removed - the overflow re-derives the same state and
 * runs the same chain commands.
 */
import type { ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import type { ContentAiAction } from '@seo/contracts';
import { AI_ACTION_LABELS, SELECTION_ACTIONS } from './contentAi';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ToolbarButtonProps {
  title: string;
  label: ReactNode;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

function ToolbarButton({ title, label, active, disabled, onClick }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'rounded-[5px] border border-transparent px-1.5 py-0.5 text-xs leading-[1.4] hover:border-primary disabled:cursor-not-allowed disabled:opacity-40',
        active && 'border-primary bg-primary font-bold text-primary-foreground',
      )}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

interface FormatItem {
  title: string;
  label: ReactNode;
  active?: boolean;
  onClick: () => void;
}

/**
 * Overflow menu for the lower-frequency block and structural commands. It is a
 * disclosure (not a second toolbar) so nothing is permanently occupied, and it
 * keeps every original command reachable from the one calm bar.
 */
function FormatMenu({ items }: { items: FormatItem[] }) {
  return (
    <details className="relative inline-block">
      <summary
        className="cursor-pointer list-none rounded-[5px] border border-transparent px-1.5 py-0.5 text-xs leading-[1.4] hover:border-primary [&::-webkit-details-marker]:hidden"
        title="Formatting, headings and blocks"
      >
        Format
      </summary>
      <div className="absolute left-0 top-[calc(100%+6px)] z-20 flex min-w-[190px] flex-col gap-0.5 rounded-lg border bg-card p-1.5 shadow-lg">
        {items.map((item) => (
          <button
            key={item.title}
            type="button"
            title={item.title}
            aria-pressed={item.active}
            className={cn(
              'rounded-md px-2 py-1 text-left text-xs hover:bg-accent',
              item.active && 'bg-secondary font-semibold',
            )}
            onClick={item.onClick}
          >
            {item.label}
          </button>
        ))}
      </div>
    </details>
  );
}

export interface ContentAiToolbar {
  configured: boolean;
  busy: boolean;
  /**
   * Whether the editor currently holds a non-empty text/node selection. Omitted
   * by callers that cannot see the canonical selection; the workspace fills it
   * in from the single selection boundary (R5.2.4).
   */
  hasSelection?: boolean;
  onAction: (action: ContentAiAction) => void;
}

/** Dropdown listing the AI actions; disabled items explain why (config/selection). */
function AiMenu({ ai }: { ai: ContentAiToolbar }) {
  const disabledReason = ai.configured
    ? ai.busy
      ? 'AI is working…'
      : ''
    : 'AI is not configured — add an OpenAI key under Account → Connections.';
  return (
    <details className="relative ml-auto inline-block">
      <summary
        className={cn(
          'cursor-pointer list-none rounded-[5px] border border-transparent px-1.5 py-0.5 text-xs leading-[1.4] hover:border-primary [&::-webkit-details-marker]:hidden',
          !ai.configured && 'text-muted-foreground',
        )}
        title={disabledReason || 'AI actions'}
      >
        {ai.busy ? '…' : 'AI'}
      </summary>
      <div className="absolute right-0 top-[calc(100%+6px)] z-20 flex min-w-[240px] flex-col gap-1.5 rounded-lg border bg-card p-2.5 shadow-lg">
        {!ai.configured && (
          <p className="m-0 max-w-[260px] text-xs text-muted-foreground">
            AI is not configured for this account. Add an OpenAI key under Account → Connections.
          </p>
        )}
        {ai.configured && (
          <p className="m-0 max-w-[260px] text-xs text-muted-foreground">
            Select text to edit it with AI, or generate a new section. Suggestions are previewed before you apply them.
          </p>
        )}
        {SELECTION_ACTIONS.map((action) => (
          <Button
            key={action}
            variant="outline"
            size="sm"
            className="justify-between text-left"
            disabled={ai.busy || !ai.configured || !ai.hasSelection}
            onClick={() => ai.onAction(action)}
          >
            {AI_ACTION_LABELS[action]}
            {!ai.hasSelection && <span className="ml-2 text-[10px] text-muted-foreground">select text</span>}
          </Button>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="justify-between text-left"
          disabled={ai.busy || !ai.configured}
          onClick={() => ai.onAction('generate_section')}
        >
          {AI_ACTION_LABELS.generate_section}
        </Button>
      </div>
    </details>
  );
}

/**
 * Markdown-style content controls bound to the Tiptap editor instance. Props:
 * `editor` (nullable while the editor initializes) and an optional `ai`
 * descriptor that, when present, adds the AI dropdown.
 */
export function ContentToolbar({ editor, ai, extra }: { editor: Editor | null; ai?: ContentAiToolbar; extra?: ReactNode }) {
  if (!editor)
    return (
      <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
        Loading editor…
      </div>
    );

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
  const sep = <span className="mx-1 h-[18px] w-px bg-border" />;

  // Every block/structural command the old always-visible toolbar exposed. They
  // keep the same active-state predicates and chain commands, just inside the
  // `Format` disclosure, so the persistent bar stays calm without losing a
  // control. Undo/redo and inline marks stay primary because they are the
  // highest-frequency actions while writing.
  const formatItems: FormatItem[] = [
    { title: 'Strikethrough', label: 'Strikethrough', active: editor.isActive('strike'), onClick: run(() => cmd((c) => c.toggleStrike())) },
    { title: 'Heading 1', label: 'Heading 1', active: editor.isActive('heading', { level: 1 }), onClick: run(() => setHeading(1)) },
    { title: 'Heading 2', label: 'Heading 2', active: editor.isActive('heading', { level: 2 }), onClick: run(() => setHeading(2)) },
    { title: 'Heading 3', label: 'Heading 3', active: editor.isActive('heading', { level: 3 }), onClick: run(() => setHeading(3)) },
    { title: 'Heading 4', label: 'Heading 4', active: editor.isActive('heading', { level: 4 }), onClick: run(() => setHeading(4)) },
    { title: 'Bullet list', label: 'Bullet list', active: editor.isActive('bulletList'), onClick: run(() => cmd((c) => c.toggleBulletList())) },
    { title: 'Numbered list', label: 'Numbered list', active: editor.isActive('orderedList'), onClick: run(() => cmd((c) => c.toggleOrderedList())) },
    { title: 'Blockquote', label: 'Blockquote', active: editor.isActive('blockquote'), onClick: run(() => cmd((c) => c.toggleBlockquote())) },
    { title: 'Code block', label: 'Code block', active: editor.isActive('codeBlock'), onClick: run(() => cmd((c) => c.toggleCodeBlock())) },
    { title: 'Link', label: 'Link', active: editor.isActive('link'), onClick: setLink },
    { title: 'Horizontal rule', label: 'Horizontal rule', onClick: run(() => cmd((c) => c.setHorizontalRule())) },
  ];

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 px-2 py-1.5">
      <ToolbarButton title="Bold" label={<strong>B</strong>} active={editor.isActive('bold')} onClick={run(() => cmd((c) => c.toggleBold()))} />
      <ToolbarButton title="Italic" label={<em>I</em>} active={editor.isActive('italic')} onClick={run(() => cmd((c) => c.toggleItalic()))} />
      <FormatMenu items={formatItems} />
      {sep}
      <ToolbarButton title="Undo" label="undo" disabled={!editor.can().undo()} onClick={run(() => cmd((c) => c.undo()))} />
      <ToolbarButton title="Redo" label="redo" disabled={!editor.can().redo()} onClick={run(() => cmd((c) => c.redo()))} />
      {extra}
      {ai && <AiMenu ai={ai} />}
    </div>
  );
}
