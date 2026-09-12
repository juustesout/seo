/**
 * Knowledge Base workspace navigation (KBUI1).
 *
 * The four sections are distinct mental tasks: Overview answers "what do I
 * have and is it healthy?", Sources manages the library, Search inspects what
 * retrieval actually returns and Discover proposes new URLs for review. The
 * section is URL-driven (the parent routes it), so deep links and back/forward
 * keep working; this component is purely presentational.
 */
import { cn } from '@/lib/utils';

export type KnowledgeSection = 'overview' | 'sources' | 'search' | 'discover';

const ITEMS: Array<{ id: KnowledgeSection; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'sources', label: 'Sources' },
  { id: 'search', label: 'Search' },
  { id: 'discover', label: 'Discover' },
];

export function KnowledgeNavigation({
  section,
  onNavigate,
}: {
  section: KnowledgeSection;
  onNavigate: (section: KnowledgeSection) => void;
}) {
  return (
    <nav aria-label="Knowledge sections" className="flex flex-wrap items-center gap-1">
      {ITEMS.map((item) => {
        const active = item.id === section;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => onNavigate(item.id)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm transition-colors',
              active
                ? 'bg-secondary font-medium text-secondary-foreground'
                : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
