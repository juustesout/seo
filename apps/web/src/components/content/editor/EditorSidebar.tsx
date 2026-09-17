import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ElementBrowser } from './ElementBrowser';
import { ElementSettings } from './ElementSettings';
import { getEditorElement } from './elementRegistry';
import type { EditorElementDefinition, EditorSelection, SidebarMode } from './types';

export function EditorSidebar({
  mode,
  onModeChange,
  selectedElement,
  onSelectElement,
  insertHint,
}: {
  mode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
  selectedElement: EditorSelection;
  onSelectElement: (element: EditorElementDefinition) => void;
  insertHint?: string | null;
}) {
  return (
    <aside
      className="flex min-h-[460px] w-full flex-col border-r bg-card lg:w-[32%] lg:min-w-[240px] lg:max-w-[360px]"
      data-testid="editor-sidebar"
    >
      <div className="flex gap-1 border-b p-2">
        <Button
          type="button"
          size="sm"
          variant={mode === 'elements' ? 'secondary' : 'ghost'}
          className={cn('flex-1', mode === 'elements' && 'font-semibold')}
          aria-pressed={mode === 'elements'}
          onClick={() => onModeChange('elements')}
        >
          Elements
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === 'settings' ? 'secondary' : 'ghost'}
          className={cn('flex-1', mode === 'settings' && 'font-semibold')}
          aria-pressed={mode === 'settings'}
          onClick={() => onModeChange('settings')}
        >
          Settings
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {mode === 'elements' ? (
          <>
            <ElementBrowser
              selectedType={selectedElement?.type ?? null}
              onSelect={(element) => onSelectElement(element)}
            />
            {selectedElement && (
              <p className="mt-3 text-xs text-muted-foreground">
                Selected: {getEditorElement(selectedElement.type)?.label ?? selectedElement.type}
              </p>
            )}
            {insertHint && (
              <p className="mt-3 text-xs text-destructive" data-testid="insert-hint">
                {insertHint}
              </p>
            )}
          </>
        ) : (
          <div className="grid gap-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-fit justify-start px-0 text-muted-foreground"
              data-testid="back-to-elements"
              onClick={() => onModeChange('elements')}
            >
              {'\u2190'} Elements
            </Button>
            <ElementSettings selection={selectedElement} />
          </div>
        )}
      </div>
    </aside>
  );
}
