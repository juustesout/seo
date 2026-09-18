import { Node, mergeAttributes, type NodeViewRenderer } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { CompositionNodeView } from './CompositionNodeView';

export const COMPOSITION_NODE_TYPES = [
  'compositionHero',
  'compositionSection',
  'compositionFeatureGrid',
  'compositionFeatureCard',
  'compositionCta',
  'compositionButton',
] as const;

export type CompositionNodeType = (typeof COMPOSITION_NODE_TYPES)[number];

const FEATURE_CARD_CONTENT =
  '(paragraph | heading | bulletList | orderedList | blockquote | codeBlock | image | horizontalRule)+';

type CompositionNodeOptions = {
  nodeView: boolean;
};

function htmlNodeView(name: string): NodeViewRenderer {
  return () => {
    const dom = document.createElement('section');
    dom.setAttribute('data-composition', name);
    dom.className = `seo-composition seo-${name}`;
    const contentDOM = document.createElement('div');
    contentDOM.className = 'seo-composition__content';
    dom.appendChild(contentDOM);
    return { dom, contentDOM };
  };
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/**
 * Bounded semantic attrs travel through the editor so a Compose -> editor ->
 * save round trip does not lose `variant`/`layout`/`icon`/`href`. They are kept
 * as `data-*` attributes only; layout objects stay JSON-only (never stringified
 * into the DOM).
 */
function compositionAttribute(key: string) {
  const domKey = `data-${kebab(key)}`;
  return {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute(domKey),
    renderHTML: (attributes: Record<string, unknown>) => {
      const value = attributes[key];
      if (value === null || value === undefined || typeof value === 'object') return {};
      return { [domKey]: String(value) };
    },
  };
}

function compositionNode(spec: {
  name: CompositionNodeType;
  group: string;
  content: string;
  attrs?: readonly string[];
}) {
  return Node.create<CompositionNodeOptions>({
    name: spec.name,
    group: spec.group,
    content: spec.content,
    defining: true,
    isolating: false,
    selectable: true,
    draggable: false,
    addOptions() {
      return { nodeView: true };
    },
    addAttributes() {
      return Object.fromEntries((spec.attrs ?? []).map((key) => [key, compositionAttribute(key)]));
    },
    parseHTML() {
      return [{ tag: `section[data-composition="${spec.name}"], a[data-composition="${spec.name}"]` }];
    },
    renderHTML({ HTMLAttributes }) {
      const tag = spec.name === 'compositionButton' ? 'a' : 'section';
      return [
        tag,
        mergeAttributes(HTMLAttributes, {
          'data-composition': spec.name,
          class: `seo-composition seo-${spec.name}`,
        }),
        0,
      ];
    },
    addNodeView() {
      if (!this.options.nodeView) return htmlNodeView(spec.name);
      return ReactNodeViewRenderer(CompositionNodeView);
    },
  });
}

export const CompositionHero = compositionNode({
  name: 'compositionHero',
  group: 'block',
  content: 'block*',
  attrs: ['variant', 'layout'],
});

export const CompositionSection = compositionNode({
  name: 'compositionSection',
  group: 'block',
  content: 'block+',
  attrs: ['variant', 'layout'],
});

export const CompositionFeatureGrid = compositionNode({
  name: 'compositionFeatureGrid',
  group: 'block',
  content: 'compositionFeatureCard+',
  attrs: ['variant', 'layout'],
});

export const CompositionFeatureCard = compositionNode({
  name: 'compositionFeatureCard',
  group: 'compositionCard',
  content: FEATURE_CARD_CONTENT,
  attrs: ['variant', 'layout', 'icon'],
});

export const CompositionCta = compositionNode({
  name: 'compositionCta',
  group: 'block',
  content: 'block*',
  attrs: ['variant', 'layout'],
});

export const CompositionButton = compositionNode({
  name: 'compositionButton',
  group: 'block',
  content: 'inline*',
  attrs: ['variant', 'layout', 'href'],
});
