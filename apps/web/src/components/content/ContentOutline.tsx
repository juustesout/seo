import type { ContentOutlineItem } from '@seo/contracts';
import { Empty } from '../../lib/ui';

interface ContentOutlineProps {
  items: ContentOutlineItem[];
  onSelect: (index: number) => void;
}

/**
 * Live document outline: the headings of the current Tiptap document in order,
 * derived on the fly (there is no separate outline state). Props: `items` from
 * the parent's `docHeadings(doc)` memo, `onSelect(index)` scrolls the editor to
 * that heading via the RichTextEditor handle. Purely presentational - it reads
 * structured content and never edits it.
 */
export function ContentOutline({ items, onSelect }: ContentOutlineProps) {
  if (items.length === 0) {
    return (
      <div className="outline">
        <h3>Outline</h3>
        <Empty>No headings yet — the outline is built from your headings as you type.</Empty>
      </div>
    );
  }
  return (
    <div className="outline">
      <h3>Outline</h3>
      <div className="outline-items">
        {items.map((item, i) => (
          <button
            type="button"
            key={`${item.level}-${i}`}
            className="outline-item"
            style={{ paddingLeft: 6 + (Math.min(item.level, 6) - 1) * 14 }}
            onClick={() => onSelect(i)}
            title={`Jump to "${item.text}"`}
          >
            <span className={`h-dot h${item.level}`} />
            <span>{item.text || 'Untitled heading'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
