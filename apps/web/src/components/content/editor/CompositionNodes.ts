import { Node, mergeAttributes, type NodeViewRenderer } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { CompositionNodeView } from './CompositionNodeView';

export const COMPOSITION_NODE_TYPES = [
  'compositionHero',
  'compositionSection',
  'compositionFeatureGrid',
  'compositionFeatureCard',
  'compositionCta',
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

function compositionNode(spec: {
  name: CompositionNodeType;
  group: string;
  content: string;
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
    parseHTML() {
      return [{ tag: `section[data-composition="${spec.name}"]` }];
    },
    renderHTML({ HTMLAttributes }) {
      return [
        'section',
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
});

export const CompositionSection = compositionNode({
  name: 'compositionSection',
  group: 'block',
  content: 'block+',
});

export const CompositionFeatureGrid = compositionNode({
  name: 'compositionFeatureGrid',
  group: 'block',
  content: 'compositionFeatureCard+',
});

export const CompositionFeatureCard = compositionNode({
  name: 'compositionFeatureCard',
  group: 'compositionCard',
  content: FEATURE_CARD_CONTENT,
});

export const CompositionCta = compositionNode({
  name: 'compositionCta',
  group: 'block',
  content: 'block*',
});
