/**
 * Knowledge Base workspace (KBUI1) - the shell that ties the four sections
 * together.
 *
 * It owns the shared read models the sections need (server capability status
 * and the optional collections list), renders the URL-driven navigation and
 * switches between Overview, Sources, Search and Discover. Each section keeps
 * its own feature ownership; the shell only composes them so existing KB1-KB9
 * behaviour stays reachable and no API logic is duplicated.
 */
import type { KnowledgeCollectionsResponse } from '@seo/contracts';
import { api } from '../../../lib/api';
import { useAsync } from '../../../lib/ui';
import { PageHeader } from '@/components/ui/page-header';
import { KnowledgeNavigation, type KnowledgeSection } from './KnowledgeNavigation';
import { KnowledgeOverview } from '../overview/KnowledgeOverview';
import { SourcesPage } from '../sources/SourcesPage';
import { KnowledgeSearchExplorer } from '../KnowledgeSearchExplorer';
import { KnowledgeDiscoveryPanel } from '../KnowledgeDiscovery';

interface KnowledgeStatus {
  project_id: string;
  provider: { id: string; name: string; description: string } | null;
  configured: boolean;
  note: string;
}

/** Editor-or-higher roles can manage sources; viewers get read-only surfaces. */
const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export function KnowledgeWorkspace({
  projectId,
  role = 'viewer',
  section,
  search,
  onNavigate,
}: {
  projectId: string;
  role?: string;
  section: KnowledgeSection;
  search: string;
  onNavigate: (section: KnowledgeSection, params?: Record<string, string | null>) => void;
}) {
  const canEdit = (ROLE_RANK[role] ?? 0) >= 1;
  const status = useAsync<KnowledgeStatus>(() => api(`/projects/${projectId}/knowledge/status`), [projectId]);
  const collectionsQuery = useAsync<KnowledgeCollectionsResponse>(
    () => api(`/projects/${projectId}/knowledge/collections?limit=100`),
    [projectId],
  );
  const collections = collectionsQuery.data?.items ?? [];
  const configured = status.data?.configured ?? false;

  const params = new URLSearchParams(search);
  const initialStatus = params.get('status') ?? '';
  const initialFreshness = params.get('freshness') ?? '';
  const initialCollectionId = params.get('collection') ?? '';
  const initialUncategorized = params.get('uncategorized') === 'true';
  const initialSourceId = params.get('source');

  return (
    <div className="grid gap-4">
      <PageHeader
        title="Knowledge Base"
        description="Manage your project's documents, websites and reference material, inspect what retrieval returns and discover new pages to review."
      />

      <KnowledgeNavigation section={section} onNavigate={(next) => onNavigate(next)} />

      {section === 'overview' && (
        <KnowledgeOverview projectId={projectId} canEdit={canEdit} collections={collections} onNavigate={onNavigate} />
      )}

      {section === 'sources' && (
        <SourcesPage
          projectId={projectId}
          canEdit={canEdit}
          configured={configured}
          collections={collections}
          onCollectionsChanged={() => collectionsQuery.reload()}
          initialStatus={initialStatus}
          initialFreshness={initialFreshness}
          initialCollectionId={initialCollectionId}
          initialUncategorized={initialUncategorized}
          initialSourceId={initialSourceId}
          onDiscover={() => onNavigate('discover')}
          onQueryChange={(p) =>
            onNavigate('sources', {
              status: p.status,
              freshness: p.freshness,
              collection: p.collection,
              uncategorized: p.uncategorized,
              source: p.source,
            })
          }
        />
      )}

      {section === 'search' && (
        <KnowledgeSearchExplorer projectId={projectId} configured={configured} canEdit={canEdit} />
      )}

      {section === 'discover' && (
        <KnowledgeDiscoveryPanel projectId={projectId} collections={collections} canEdit={canEdit} />
      )}
    </div>
  );
}
