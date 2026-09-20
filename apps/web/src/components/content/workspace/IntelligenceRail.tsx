/**
 * Segmented document rail: Outline, SEO, Media and Insights in one panel.
 *
 * Replaces the previous stack of five cards in the 250px aside with one
 * segmented surface, so the writing column stays the focus. All underlying
 * panels keep their own props and data sources; this is a layout change, not
 * new data.
 */
import { useState } from 'react';
import type { Editor } from '@tiptap/react';
import type { ContentOutlineItem, SeoResult } from '@seo/contracts';
import { ContentOutline } from '../ContentOutline';
import { SeoPanel } from '../SeoPanel';
import { MediaPanel } from '../MediaPanel';
import { IntelligencePanel } from '../IntelligencePanel';
import { cn } from '@/lib/utils';

export type RailTab = 'outline' | 'seo' | 'media' | 'insights';

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
}

export function IntelligenceRail({ outline, onSelectHeading, seo, media, intelligence }: IntelligenceRailProps) {
  const tabs: Array<{ id: RailTab; label: string }> = [
    { id: 'outline', label: 'Outline' },
    { id: 'seo', label: 'SEO' },
    ...(media ? [{ id: 'media' as const, label: 'Media' }] : []),
    ...(intelligence ? [{ id: 'insights' as const, label: 'Insights' }] : []),
  ];
  const [tab, setTab] = useState<RailTab>('outline');
  const active = tabs.some((t) => t.id === tab) ? tab : 'outline';

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
            onClick={() => setTab(t.id)}
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
          <IntelligencePanel projectId={intelligence.projectId} contentId={intelligence.contentId} />
        )}
      </div>
    </aside>
  );
}
