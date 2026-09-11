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
      <div className="rounded-[10px] border bg-card p-3">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outline</h3>
        <Empty>No headings yet — the outline is built from your headings as you type.</Empty>
      </div>
    );
  }
  return (
    <div className="rounded-[10px] border bg-card p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outline</h3>
      <div className="flex max-h-[60vh] flex-col gap-px overflow-y-auto">
        {items.map((item, i) => (
          <button
            type="button"
            key={`${item.level}-${i}`}
            className="flex items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-accent"
            style={{ paddingLeft: 6 + (Math.min(item.level, 6) - 1) * 14 }}
            onClick={() => onSelect(i)}
            title={`Jump to "${item.text}"`}
          >
            <span
              className={[
                'shrink-0 self-center rounded-[2px]',
                item.level <= 1 ? 'size-2.5 bg-primary' : item.level === 2 ? 'size-[7px] bg-primary' : 'size-[7px] bg-muted-foreground',
              ].join(' ')}
            />
            <span className="truncate">{item.text || 'Untitled heading'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
