import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { EDITOR_ELEMENTS, groupEditorElements } from './elementRegistry';
import type { EditorElementDefinition } from './types';

export function ElementBrowser({
  elements = EDITOR_ELEMENTS,
  selectedType,
  onSelect,
}: {
  elements?: readonly EditorElementDefinition[];
  selectedType?: string | null;
  onSelect: (element: EditorElementDefinition) => void;
}) {
  const groups = groupEditorElements(elements);
  return (
    <div className="grid gap-4" data-testid="element-browser">
      {groups.map((group) => (
        <section key={group.category} className="grid gap-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.category}</h3>
          <div className="grid gap-1">
            {group.elements.map((element) => (
              <Button
                key={element.type}
                type="button"
                variant="ghost"
                size="sm"
                className={cn('justify-start', selectedType === element.type && 'bg-accent text-accent-foreground')}
                aria-pressed={selectedType === element.type}
                onClick={() => onSelect(element)}
              >
                {element.icon}
                {element.label}
              </Button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
