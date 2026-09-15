/**
 * Selection-scoped AI bubble menu for the Content Studio editor.
 *
 * Rendered by RichTextEditor next to EditorContent. Every action goes through
 * one shared handler (`onAction`) that calls the project's structured AI edit
 * endpoint - the menu itself holds no document state and never edits the
 * document. `Ask AI` collects a short instruction and uses the same path.
 */
import { BubbleMenu, type Editor } from '@tiptap/react';
import type { ContentAiEditOperation } from '@seo/contracts';
import { Button } from '@/components/ui/button';

const ACTIONS: Array<{ operation: ContentAiEditOperation; label: string }> = [
  { operation: 'rewrite', label: 'Rewrite' },
  { operation: 'improve', label: 'Improve' },
  { operation: 'shorten', label: 'Shorten' },
  { operation: 'expand', label: 'Expand' },
];

export interface EditorAiActions {
  configured: boolean;
  busy: boolean;
  onAction: (operation: ContentAiEditOperation, instruction?: string) => void;
}

export function EditorAiBubbleMenu({ editor, actions }: { editor: Editor | null; actions: EditorAiActions }) {
  if (!editor) return null;

  const disabled = actions.busy || !actions.configured;
  const title = actions.configured
    ? actions.busy
      ? 'AI is working…'
      : undefined
    : 'AI is not configured — add an OpenAI key under Account → Integrations.';

  const ask = () => {
    const instruction = window.prompt('What should the AI do with the selection?', 'Make this sound less corporate.');
    if (instruction === null) return;
    const trimmed = instruction.trim();
    if (!trimmed) return;
    actions.onAction('ask', trimmed);
  };

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ state }) => !state.selection.empty}
      tippyOptions={{ duration: 120, maxWidth: 520 }}
    >
      <div className="flex flex-wrap items-center gap-1 rounded-lg border bg-card p-1 shadow-lg">
        {ACTIONS.map((action) => (
          <Button
            key={action.operation}
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={disabled}
            title={title}
            onClick={() => actions.onAction(action.operation)}
          >
            {action.label}
          </Button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={disabled}
          title={title}
          onClick={ask}
        >
          Ask AI
        </Button>
        {actions.busy && <span className="px-1.5 text-[11px] text-muted-foreground">…</span>}
      </div>
    </BubbleMenu>
  );
}
