/**
 * The three workspace modes (R5.3). The buttons are three ways of working on the
 * same page, not three applications: switching a mode never reloads or replaces
 * the shared document session owned by `ProjectWorkspaceShell`.
 */
import { useRef } from 'react';
import { Bot, PenSquare, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

export type WorkspaceMode = 'editor' | 'composer' | 'designer';

interface ModeDescriptor {
  id: WorkspaceMode;
  label: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const WORKSPACE_MODES: ModeDescriptor[] = [
  { id: 'composer', label: 'Composer', hint: 'Create page structure and sections', icon: Sparkles },
  { id: 'designer', label: 'Designer', hint: 'Propose and review design changes', icon: Bot },
  { id: 'editor', label: 'Editor', hint: 'Edit the document content', icon: PenSquare },
];

/** Map an arbitrary route segment to a supported mode, defaulting to editor. */
export function normalizeWorkspaceMode(value: string | null | undefined): WorkspaceMode {
  return value === 'composer' || value === 'designer' ? value : 'editor';
}

/**
 * Three prominent mode buttons with active styling and roving keyboard focus.
 * Arrow keys move and activate; Enter/Space activate the focused button, so the
 * switcher is usable without a pointer.
 */
export function WorkspaceModeSwitcher({
  mode,
  onChange,
}: {
  mode: WorkspaceMode;
  onChange?: (mode: WorkspaceMode) => void;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (delta: number) => {
    const index = WORKSPACE_MODES.findIndex((m) => m.id === mode);
    const nextIndex = (index + delta + WORKSPACE_MODES.length) % WORKSPACE_MODES.length;
    const next = WORKSPACE_MODES[nextIndex];
    if (!next) return;
    onChange?.(next.id);
    buttons.current[nextIndex]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Workspace mode"
      data-testid="workspace-mode-switcher"
      className="inline-flex flex-wrap items-center gap-1 rounded-[10px] border bg-card p-1"
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {WORKSPACE_MODES.map((m, index) => {
        const Icon = m.icon;
        const active = mode === m.id;
        return (
          <button
            key={m.id}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            aria-pressed={active}
            tabIndex={active ? 0 : -1}
            title={m.hint}
            data-testid={`workspace-mode-${m.id}`}
            onClick={() => onChange?.(m.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <Icon className="size-4" />
            <span>{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}
