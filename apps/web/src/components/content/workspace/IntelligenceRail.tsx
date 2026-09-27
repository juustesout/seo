/**
 * Segmented document rail: Outline, SEO, Media and Insights in one panel.
 *
 * Replaces the previous stack of five cards in the 250px aside with one
 * segmented surface, so the writing column stays the focus. All underlying
 * panels keep their own props and data sources; this is a layout change, not
 * new data.
 *
 * Since R5.8 the areas are derived from the workspace context rather than the
 * props alone: Media can mutate the document, so it is only offered on the
 * editable canvas surface (never in preview). The active tab remains UI state
 * (`useDocumentScopedState`); a context default is used until the user chooses
 * one, and an unavailable tab falls back to that default.
 */
import type { Editor } from '@tiptap/react';
import type { ContentOutlineItem, SeoResult } from '@seo/contracts';
import { ContentOutline } from '../ContentOutline';
import { SeoPanel } from '../SeoPanel';
import { MediaPanel } from '../MediaPanel';
import { IntelligencePanel } from '../IntelligencePanel';
import { useDocumentScopedState } from './workspaceState';
import {
  DEFAULT_WORKSPACE_CONTEXT,
  defaultRailTabForContext,
  railTabsForContext,
  type ContextRailTab,
  type WorkspaceContext,
} from './workspaceContext';
import { cn } from '@/lib/utils';

export type RailTab = ContextRailTab;

export interface IntelligenceRailProps {
  outline: ContentOutlineItem[];
  onSelectHeading: (index: number) => void;
  seo: {
    result: SeoResult;
    targetKeyword: string;
    metaTitle: string;
    metaDescription: string;
    onKeywordChange: (value: string) => void;
    onMetaTitleChange: (value: string) => void;
    onMetaDescriptionChange: (value: string) => void;
  };
  media?: { projectId: string; editor: Editor; canEdit: boolean; canDelete: boolean };
  intelligence?: { projectId: string; contentId: string };
  /** Derived workspace context: which surface and which selection is active. */
  context?: WorkspaceContext;
}

export function IntelligenceRail({
  outline,
  onSelectHeading,
  seo,
  media,
  intelligence,
  context = DEFAULT_WORKSPACE_CONTEXT,
}: IntelligenceRailProps) {
  const available = railTabsForContext(context, {
    media: Boolean(media),
    insights: Boolean(intelligence),
  });
  const tabs: Array<{ id: RailTab; label: string }> = [
    { id: 'outline', label: 'Outline' },
    { id: 'seo', label: 'SEO' },
    ...(available.includes('media') ? [{ id: 'media' as const, label: 'Media' }] : []),
    ...(available.includes('insights') ? [{ id: 'insights' as const, label: 'Insights' }] : []),
  ];
  const [userTab, setUserTab] = useDocumentScopedState<RailTab | null>(null);
  // The user's explicit choice wins while it is still available; otherwise the
  // rail falls back to the context default (Outline, or Media for an image).
  const active = userTab && available.includes(userTab) ? userTab : defaultRailTabForContext(context, available);

  return (
    <aside className="flex min-w-0 flex-col gap-3" data-testid="intelligence-rail">
      <div role="tablist" aria-label="Document tools" className="flex gap-1 rounded-[10px] border bg-card p-1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            data-testid={`intelligence-tab-${t.id}`}
            className={cn(
              'flex-1 rounded-md px-2 py-1 text-xs font-medium',
              active === t.id ? 'bg-secondary font-semibold' : 'text-muted-foreground hover:bg-accent',
            )}
            onClick={() => setUserTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-w-0">
        {active === 'outline' && <ContentOutline items={outline} onSelect={onSelectHeading} />}
        {active === 'seo' && (
          <SeoPanel
            result={seo.result}
            editable
            targetKeyword={seo.targetKeyword}
            metaTitle={seo.metaTitle}
            metaDescription={seo.metaDescription}
            onKeywordChange={seo.onKeywordChange}
            onMetaTitleChange={seo.onMetaTitleChange}
            onMetaDescriptionChange={seo.onMetaDescriptionChange}
          />
        )}
        {active === 'media' && media && (
          <MediaPanel projectId={media.projectId} editor={media.editor} canEdit={media.canEdit} canDelete={media.canDelete} />
        )}
        {active === 'insights' && intelligence && (
          // Keyed by document identity so a document switch remounts the panel:
          // its fetch, AI toggle and dismissed-recommendation state all reset,
          // so a previous document's context can never stay visible.
          <IntelligencePanel
            key={`${intelligence.projectId}:${intelligence.contentId}`}
            projectId={intelligence.projectId}
            contentId={intelligence.contentId}
          />
        )}
      </div>
    </aside>
  );
}
