import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { ImageBlock } from '../ImageBlock';
import { CompositionCta, CompositionHero } from './CompositionNodes';

export function createEditorExtensions() {
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
    CompositionHero,
    CompositionCta,
  ];
}
