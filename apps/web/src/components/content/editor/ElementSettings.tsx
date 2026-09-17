import { renderElementSettings } from './settingsRegistry';
import type { EditorSelection } from './types';

export function ElementSettings({ selection }: { selection: EditorSelection }) {
  if (!selection) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="element-settings">
        Select an element on the canvas to edit its settings.
      </p>
    );
  }

  return (
    <div className="grid gap-2" data-testid="element-settings">
      {renderElementSettings(selection)}
    </div>
  );
}
