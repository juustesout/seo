import type { ReactNode } from 'react';
import type { EditorSettingsDefinition, EditorSettingsProps } from './types';
import { getEditorElement } from './elementRegistry';

function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="grid gap-1.5">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

const SETTINGS: Record<string, EditorSettingsDefinition['render']> = {
  paragraph: () => <Placeholder title="Text" body="Paragraph copy is edited on the canvas." />,
  heading: () => <Placeholder title="Heading" body="Heading level and copy are edited on the canvas." />,
  image: () => <Placeholder title="Image" body="Media is chosen from the project library." />,
  compositionHero: () => <Placeholder title="Hero" body="Hero content is edited on the canvas." />,
  compositionSection: () => <Placeholder title="Section" body="Section content is edited on the canvas." />,
  compositionFeatureGrid: () => <Placeholder title="Feature Grid" body="Feature cards are nested inside this grid." />,
  compositionFeatureCard: () => <Placeholder title="Feature Card" body="Card copy is edited on the canvas." />,
  compositionCta: () => <Placeholder title="CTA" body="Call-to-action copy is edited on the canvas." />,
};

export function getElementSettingsRenderer(type: string): EditorSettingsDefinition['render'] | undefined {
  return SETTINGS[type];
}

export function renderElementSettings(selection: EditorSettingsProps['selection']): ReactNode {
  const render = SETTINGS[selection.type];
  if (render) return render({ selection });
  const known = getEditorElement(selection.type);
  if (known) return <Placeholder title={known.label} body="No settings available for this element." />;
  return <p className="text-sm text-muted-foreground">No settings available for this element.</p>;
}
