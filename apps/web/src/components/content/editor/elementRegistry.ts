import type { EditorElementDefinition } from './types';

export const EDITOR_ELEMENT_CATEGORIES = ['Content', 'Media', 'Composition'] as const;

export type EditorElementCategory = (typeof EDITOR_ELEMENT_CATEGORIES)[number];

/**
 * Catalog of insertable/selectable editor elements. New composition types
 * (Section, FeatureGrid, FeatureCard, Proof, Footer, ...) are added here;
 * the browser renders from this list instead of per-type UI branches.
 */
export const EDITOR_ELEMENTS: readonly EditorElementDefinition[] = [
  { type: 'paragraph', label: 'Text', category: 'Content' },
  { type: 'heading', label: 'Heading', category: 'Content' },
  { type: 'image', label: 'Image', category: 'Media' },
  { type: 'compositionHero', label: 'Hero', category: 'Composition' },
  { type: 'compositionCta', label: 'CTA', category: 'Composition' },
];

const BY_TYPE = new Map(EDITOR_ELEMENTS.map((el) => [el.type, el]));

/** Canonical / shorthand names that resolve to a registered editor type. */
const TYPE_ALIASES: Record<string, string> = {
  text: 'paragraph',
  hero: 'compositionHero',
  cta: 'compositionCta',
};

export function resolveElementType(type: string): string {
  return TYPE_ALIASES[type] ?? type;
}

export function getEditorElement(type: string): EditorElementDefinition | undefined {
  return BY_TYPE.get(resolveElementType(type));
}

export function groupEditorElements(
  elements: readonly EditorElementDefinition[] = EDITOR_ELEMENTS,
): Array<{ category: string; elements: EditorElementDefinition[] }> {
  const grouped = new Map<string, EditorElementDefinition[]>();
  for (const el of elements) {
    const list = grouped.get(el.category);
    if (list) list.push(el);
    else grouped.set(el.category, [el]);
  }
  return Array.from(grouped.entries()).map(([category, groupedElements]) => ({
    category,
    elements: groupedElements,
  }));
}
