import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { cn } from '@/lib/utils';
import { getEditorElement } from './elementRegistry';
import { compositionBlockClassNames } from './compositionPresentation';

/**
 * Composition NodeView.
 *
 * The editable content element carries the CanonicalRenderer's own
 * `.cosmos-*` classes, so a Hero/Section/FeatureGrid/FeatureCard/CTA/Button
 * renders as the same surface the published document uses. The FeatureCard is
 * the one container that also owns an optional icon, so its card classes sit on
 * the wrapper to keep the icon and the editable body as siblings.
 *
 * Editor chrome (type label, selected marker) is an absolutely positioned
 * overlay and selection is drawn with an outline only, so entering or leaving
 * selection never changes the composition's layout.
 */
export function CompositionNodeView({ node, editor, getPos, selected }: ReactNodeViewProps) {
  const type = node.type.name;
  const label = getEditorElement(type)?.label ?? type;
  const canonicalClasses = compositionBlockClassNames(type, node.attrs as Record<string, unknown>);
  const isCard = type === 'compositionFeatureCard';
  const icon = isCard && typeof node.attrs.icon === 'string' && node.attrs.icon.length > 0 ? node.attrs.icon : null;

  const selectSelf = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    const pos = getPos();
    if (typeof pos !== 'number' || !editor || editor.isDestroyed) return;
    editor.chain().focus().setNodeSelection(pos).run();
  };

  return (
    <NodeViewWrapper
      data-composition={type}
      data-selected={selected ? 'true' : 'false'}
      data-testid={`composition-${type}`}
      className={cn('seo-composition', isCard && canonicalClasses, selected && 'seo-composition-selected')}
    >
      <div className="seo-composition__chrome" contentEditable={false} onMouseDown={selectSelf}>
        <span>{label}</span>
        {selected && <span className="seo-composition__mark">selected</span>}
      </div>
      {icon ? (
        <span
          className="cosmos-feature-card__icon"
          data-cosmos-icon={icon}
          aria-hidden="true"
          contentEditable={false}
        />
      ) : null}
      <NodeViewContent className={cn('seo-composition__content', !isCard && canonicalClasses)} />
    </NodeViewWrapper>
  );
}
