/**
 * Knowledge Base view (project nav "Knowledge").
 *
 * Thin composition wrapper: the Knowledge Base is a workspace with four
 * URL-driven sections (Overview, Sources, Search, Discover) and the shell that
 * owns them lives in `components/knowledge/workspace/KnowledgeWorkspace`. The
 * active section and any query filters come from the URL (parsed by App), so
 * deep links and back/forward keep working and every KB1-KB9 capability stays
 * reachable behind the project nav entry.
 */
import { KnowledgeWorkspace } from '../components/knowledge/workspace/KnowledgeWorkspace';
import type { KnowledgeSection } from '../components/knowledge/workspace/KnowledgeNavigation';

const SECTIONS: KnowledgeSection[] = ['overview', 'sources', 'search', 'discover'];

/** Unknown or absent sub-segments fall back to the Overview landing page. */
function toSection(sub: string | null): KnowledgeSection {
  return SECTIONS.includes(sub as KnowledgeSection) ? (sub as KnowledgeSection) : 'overview';
}

export function Knowledge({
  projectId,
  role = 'viewer',
  section = null,
  search = '',
  onNavigate,
}: {
  projectId: string;
  role?: string;
  section?: string | null;
  search?: string;
  onNavigate: (section: KnowledgeSection, params?: Record<string, string | null>) => void;
}) {
  return (
    <KnowledgeWorkspace
      projectId={projectId}
      role={role}
      section={toSection(section)}
      search={search}
      onNavigate={onNavigate}
    />
  );
}
