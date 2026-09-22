/**
 * Embedded Agent status surface (R2.1, extended R3.1).
 *
 * Renders the product-language state of one Agent interaction. It is deliberately
 * small: a progress line, a plain result line, or a recoverable error with an
 * optional retry. It never shows run ids, statuses, revisions or raw payloads.
 * R3.1 adds the inline image candidate: a compact preview with an explicit
 * "Insert image" confirmation, never an automatic document change.
 */
import { Button } from '@/components/ui/button';
import { visualIntentLabel, visualRoleLabel, type EmbeddedAgentState } from './embeddedAgent';

export interface EmbeddedAgentStatusProps {
  state: EmbeddedAgentState;
  onRetry: () => void;
  /** Confirms the current image candidate; required to render the candidate actions. */
  onInsert?: () => void;
  /** Dismisses the current result without changing the document. */
  onCancel?: () => void;
}

export function EmbeddedAgentStatus({ state, onRetry, onInsert, onCancel }: EmbeddedAgentStatusProps) {
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

  if (state.status === 'insertion') {
    const { image, visual } = state.operation;
    const roleLabel = visualRoleLabel(visual?.role);
    const intentLabel = visualIntentLabel(visual?.intent);
    const decorative = visual?.accessibilityRequired === false;
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="embedded-agent-image-candidate"
        className="grid gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs"
      >
        <p className="m-0 font-medium text-foreground" data-testid="embedded-agent-image-role">
          {roleLabel ?? 'Suggested image'}
        </p>
        {roleLabel && intentLabel && <p className="m-0 text-muted-foreground">This visual {intentLabel}.</p>}
        <img
          src={image.url}
          alt={image.alt}
          data-testid="embedded-agent-image-preview"
          className="max-h-40 w-full rounded object-cover"
        />
        <p className="m-0 text-muted-foreground">
          {decorative ? 'Decorative - no alt text needed.' : `Alt text: ${image.alt || 'none'}`}
        </p>
        {image.source === 'unsplash' && (
          <p className="m-0 text-muted-foreground" data-testid="embedded-agent-image-source">
            Stock photo from Unsplash{image.credit ? ` - ${image.credit}` : ''}
          </p>
        )}
        {image.sourceUrl && (
          <p className="m-0 text-muted-foreground">
            Source:{' '}
            <a href={image.sourceUrl} target="_blank" rel="noreferrer noopener" className="underline">
              {image.sourceUrl}
            </a>
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={onInsert}
            disabled={!onInsert}
            data-testid="embedded-agent-insert"
          >
            Insert image
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  if (state.status === 'applied') {
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

  if (state.status === 'empty') {
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
