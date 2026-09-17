import type { ReactNode } from 'react';
import type { EditorSettingsDefinition, EditorSettingsProps, EditorSelection } from './types';
import { getEditorElement, resolveElementType } from './elementRegistry';

function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid gap-1.5">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

function CompositionSettings({ selection }: EditorSettingsProps) {
  const known = getEditorElement(selection.type);
  const title = known?.label ?? selection.type;
  const path = selection.path ?? [];
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">Type: {title}</p>
        {path.length > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="element-settings-path">
            Path: {path.join('.')}
          </p>
        )}
      </div>
      <div className="grid gap-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Settings</p>
        <p className="text-xs text-muted-foreground">No editable settings yet</p>
      </div>
    </div>
  );
}

const SETTINGS: Record<string, EditorSettingsDefinition['render']> = {
  paragraph: () => <Placeholder title="Text" body="Paragraph copy is edited on the canvas." />,
  heading: () => <Placeholder title="Heading" body="Heading level and copy are edited on the canvas." />,
  image: () => <Placeholder title="Image" body="Media is chosen from the project library." />,
  compositionHero: (props) => <CompositionSettings {...props} />,
  compositionSection: (props) => <CompositionSettings {...props} />,
  compositionFeatureGrid: (props) => <CompositionSettings {...props} />,
  compositionFeatureCard: (props) => <CompositionSettings {...props} />,
  compositionCta: (props) => <CompositionSettings {...props} />,
};

export function getElementSettingsRenderer(type: string): EditorSettingsDefinition['render'] | undefined {
  return SETTINGS[resolveElementType(type)];
}

export function renderElementSettings(selection: Exclude<EditorSelection, null>): ReactNode {
  const render = getElementSettingsRenderer(selection.type);
  if (render) return render({ selection: { ...selection, type: resolveElementType(selection.type) } });
  const known = getEditorElement(selection.type);
  if (known) return <Placeholder title={known.label} body="No settings available for this element." />;
  return <p className="text-sm text-muted-foreground">No settings available for this element.</p>;
}
