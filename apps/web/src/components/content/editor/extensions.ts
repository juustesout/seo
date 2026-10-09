import StarterKit from '@tiptap/starter-kit';
import { ImageBlock } from '../ImageBlock';
import {
  CompositionButton,
  CompositionCta,
  CompositionFeatureCard,
  CompositionFeatureGrid,
  CompositionHero,
  CompositionSection,
} from './CompositionNodes';

export function createEditorExtensions(options: { nodeViews?: boolean } = {}) {
  const nodeView = options.nodeViews !== false;
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      },
      trailingNode: false,
    }),
    ImageBlock,
    CompositionHero.configure({ nodeView }),
    CompositionSection.configure({ nodeView }),
    CompositionFeatureGrid.configure({ nodeView }),
    CompositionFeatureCard.configure({ nodeView }),
    CompositionCta.configure({ nodeView }),
    CompositionButton.configure({ nodeView }),
  ];
}
