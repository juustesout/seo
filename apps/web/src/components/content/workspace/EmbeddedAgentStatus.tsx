/**
 * Embedded Agent status surface (R2.1).
 *
 * Renders the product-language state of one Agent interaction. It is deliberately
 * small: a progress line, a plain result line, or a recoverable error with an
 * optional retry. It never shows run ids, statuses, revisions or raw payloads,
 * and it never claims the document changed (R2.1 applies nothing).
 */
import { Button } from '@/components/ui/button';
import type { EmbeddedAgentState } from './embeddedAgent';

export interface EmbeddedAgentStatusProps {
  state: EmbeddedAgentState;
  onRetry: () => void;
}

export function EmbeddedAgentStatus({ state, onRetry }: EmbeddedAgentStatusProps) {
  if (state.status === 'closed' || state.status === 'idle') return null;

  if (state.status === 'submitting') {
    return (
      <p role="status" aria-live="polite" data-testid="embedded-agent-status" className="m-0 text-xs text-muted-foreground">
        Submitting your request…
      </p>
    );
  }

  if (state.status === 'working') {
    return (
      <p role="status" aria-live="polite" data-testid="embedded-agent-status" className="m-0 text-xs text-muted-foreground">
        {state.message}
      </p>
    );
  }

  if (state.status === 'completed') {
    return (
      <p
        role="status"
        aria-live="polite"
        data-testid="embedded-agent-status"
        className="m-0 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-xs text-success"
      >
        {state.message}
      </p>
    );
  }

  if (state.status === 'clarification') {
    return (
      <p
        role="status"
        aria-live="polite"
        data-testid="embedded-agent-status"
        className="m-0 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-foreground"
      >
        {state.message}
      </p>
    );
  }

  if (state.status === 'unsupported') {
    return (
      <p
        role="status"
        aria-live="polite"
        data-testid="embedded-agent-status"
        className="m-0 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      >
        {state.message}
      </p>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="embedded-agent-status"
      className="grid gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
    >
      <p className="m-0">{state.message}</p>
      {state.canRetry && (
        <div>
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
