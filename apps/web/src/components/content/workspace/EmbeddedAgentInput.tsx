/**
 * Embedded Agent instruction input (R2.1).
 *
 * A compact, keyboard-first instruction field inside the editor workspace. It is
 * presentational: all submission state lives in `useEmbeddedAgent`. Enter submits
 * (Shift+Enter inserts a newline), Escape closes, and Send is disabled for a blank
 * instruction or when the surrounding context blocks submission.
 */
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export interface EmbeddedAgentInputProps {
  instruction: string;
  onInstructionChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onSaveNow: () => void;
  canSubmit: boolean;
  busy: boolean;
  dirty: boolean;
  contextHint: string;
  blockedReason: string | null;
}

export function EmbeddedAgentInput({
  instruction,
  onInstructionChange,
  onSubmit,
  onCancel,
  onSaveNow,
  canSubmit,
  busy,
  dirty,
  contextHint,
  blockedReason,
}: EmbeddedAgentInputProps) {
  return (
    <div className="grid gap-2">
      <Textarea
        autoFocus
        rows={2}
        className="min-h-[56px]"
        value={instruction}
        placeholder="Describe what you want to change…"
        aria-label="Agent instruction"
        data-testid="embedded-agent-input"
        disabled={busy}
        onChange={(event) => onInstructionChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (canSubmit) onSubmit();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{contextHint}</span>
        <div className="flex flex-wrap items-center gap-2">
          {dirty && blockedReason && (
            <Button type="button" size="sm" variant="ghost" onClick={onSaveNow}>
              Save now
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onSubmit}
            disabled={!canSubmit}
            data-testid="embedded-agent-send"
          >
            Send
          </Button>
        </div>
      </div>
      {blockedReason && <p className="m-0 text-xs text-muted-foreground">{blockedReason}</p>}
    </div>
  );
}
