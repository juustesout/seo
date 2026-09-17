import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react';
import { cn } from '@/lib/utils';
import { getEditorElement } from './elementRegistry';

export function CompositionNodeView({ node, editor, getPos, selected }: ReactNodeViewProps) {
  const type = node.type.name;
  const label = getEditorElement(type)?.label ?? type;

  const selectSelf = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    const pos = getPos();
    if (typeof pos !== 'number' || !editor || editor.isDestroyed) return;
    editor.chain().focus().setNodeSelection(pos).run();
  };

  return (
    <NodeViewWrapper
      as="section"
      data-composition={type}
      data-selected={selected ? 'true' : 'false'}
      data-testid={`composition-${type}`}
      className={cn('seo-composition', `seo-${type}`, selected && 'seo-composition-selected')}
    >
      <div className="seo-composition__chrome" contentEditable={false} onMouseDown={selectSelf}>
        <span>{label}</span>
        {selected && <span className="seo-composition__mark">selected</span>}
      </div>
      <NodeViewContent className="seo-composition__content" />
    </NodeViewWrapper>
  );
}
