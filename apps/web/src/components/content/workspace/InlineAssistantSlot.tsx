/**
 * Reserved place for in-editor AI assistance.
 *
 * Deliberately not an agent in R1: it establishes one fixed place that later
 * phases (R2) mount the embedded Designer into, and it groups inline AI status
 * and errors so they are no longer scattered across separate banners. It is
 * focusable and reachable with Ctrl/Cmd+K.
 */
import type { ReactNode } from 'react';

export function InlineAssistantSlot({
  configured,
  busy,
  children,
}: {
  configured: boolean;
  busy: boolean;
  children?: ReactNode;
}) {
  const status = !configured
    ? 'Not configured for this project.'
    : busy
      ? 'Working…'
      : 'Select text for inline actions, or press Ctrl/⌘+K.';

  return (
    <div
      id="inline-assistant"
      tabIndex={-1}
      data-testid="inline-assistant"
      className="mt-3 grid gap-2 rounded-[10px] border border-dashed bg-muted/30 px-3 py-2 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-semibold uppercase tracking-wide text-foreground">AI</span>
        <span>{status}</span>
      </div>
      {children}
    </div>
  );
}
