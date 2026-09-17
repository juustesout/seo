import { Node, mergeAttributes } from '@tiptap/core';

function compositionBlock(name: string) {
  return Node.create({
    name,
    group: 'block',
    content: 'block*',
    defining: true,
    isolating: false,
    parseHTML() {
      return [{ tag: `section[data-composition="${name}"]` }];
    },
    renderHTML({ HTMLAttributes }) {
      return [
        'section',
        mergeAttributes(HTMLAttributes, {
          'data-composition': name,
          class: `seo-composition seo-${name}`,
        }),
        0,
      ];
    },
  });
}

export const CompositionHero = compositionBlock('compositionHero');
export const CompositionCta = compositionBlock('compositionCta');

export const COMPOSITION_NODE_TYPES = ['compositionHero', 'compositionCta'] as const;
