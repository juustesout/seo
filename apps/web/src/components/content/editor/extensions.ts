import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
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
    }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      defaultProtocol: 'https',
      HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
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
