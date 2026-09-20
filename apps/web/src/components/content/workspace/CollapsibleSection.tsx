import { useState, type ReactNode } from 'react';

/**
 * Collapsible secondary section. Used to demote manager/tooling surfaces
 * (knowledge, writer tools) below the writing surface, closed by default so
 * they never compete with the document.
 */
export function CollapsibleSection({
  title,
  testId,
  defaultOpen = false,
  children,
}: {
  title: string;
  testId?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="rounded-[10px] border bg-card px-3 py-2.5"
      data-testid={testId}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </summary>
      <div className="mt-2.5">{children}</div>
    </details>
  );
}
