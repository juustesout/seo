/**
 * R5.6.3: the Intelligence Rail is the on-demand contextual surface of the
 * editor. These tests pin the behaviour the task depends on: the four areas
 * stay reachable, Outline follows the current document, the SEO surface is the
 * deterministic evaluation for the open document, Insights follow the document
 * identity with no stale context, and rail state is document-scoped.
 */
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { evaluateSeo, tiptapEmptyDoc, type ContentOutlineItem } from '@seo/contracts';
import { IntelligenceRail, type IntelligenceRailProps } from './IntelligenceRail';
import { WorkspaceStateProvider } from './workspaceState';
import { RichTextEditor } from '../RichTextEditor';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../../../lib/api', () => ({ api: apiMock.api, apiRaw: vi.fn() }));

function report(contentId: string) {
  return {
    project_id: 'p1',
    content_id: contentId,
    generated_at: '2026-01-01T00:00:00.000Z',
    seo_score: 50,
    sources: [{ id: 'seo', label: 'On-page SEO', state: 'configured', note: null }],
    recommendations: [
      {
        id: `${contentId}-rec`,
        type: 'issue',
        priority: 'high',
        source: 'seo',
        code: 'sample',
        title: `${contentId} only`,
        description: 'A stored signal for this document.',
        dismissible: true,
      },
    ],
    ai: { requested: false, available: false, note: null },
  };
}

beforeEach(() => {
  apiMock.api.mockReset();
  apiMock.api.mockImplementation(async (path: string) => {
    const match = /\/content\/([^/]+)\/intelligence/.exec(path);
    if (match) return report(match[1]!);
    if (path.includes('/media')) return { media: [], note: null };
    return {};
  });
});

const SEO = evaluateSeo({
  doc: tiptapEmptyDoc(),
  meta: { title: 'A title', targetKeyword: 'content engine', metaTitle: 'Meta title', metaDescription: 'Meta description' },
});

function Harness({
  documentKey = 'c1#0',
  contentId = 'c1',
  outline = [
    { level: 1, text: 'Intro' },
    { level: 2, text: 'Details' },
  ] as ContentOutlineItem[],
  onSelectHeading = () => {},
  withMedia = false,
}: {
  documentKey?: string;
  contentId?: string;
  outline?: ContentOutlineItem[];
  onSelectHeading?: (index: number) => void;
  withMedia?: boolean;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const rail: IntelligenceRailProps = {
    outline,
    onSelectHeading,
    seo: {
      result: SEO,
      targetKeyword: 'content engine',
      metaTitle: 'Meta title',
      metaDescription: 'Meta description',
      onKeywordChange: () => {},
      onMetaTitleChange: () => {},
      onMetaDescriptionChange: () => {},
    },
    media: withMedia && editor ? { projectId: 'p1', editor, canEdit: true, canDelete: false } : undefined,
    intelligence: { projectId: 'p1', contentId },
  };
  return (
    <WorkspaceStateProvider documentKey={documentKey}>
      <IntelligenceRail {...rail} />
      {withMedia && <RichTextEditor initialDoc={tiptapEmptyDoc()} onEditor={setEditor} />}
    </WorkspaceStateProvider>
  );
}

describe('IntelligenceRail contextual behavior', () => {
  it('keeps Outline, SEO, Media and Insights reachable', async () => {
    render(<Harness withMedia />);
    await screen.findByRole('tab', { name: 'Media' });
    expect(screen.getByRole('tab', { name: 'Outline' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'SEO' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Insights' })).toBeTruthy();
  });

  it('navigates from Outline using the listed heading index', () => {
    const onSelectHeading = vi.fn();
    render(<Harness onSelectHeading={onSelectHeading} />);
    expect(screen.getByRole('button', { name: 'Intro' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(onSelectHeading).toHaveBeenCalledWith(1);
  });

  it('shows the SEO assessment for the current document', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('tab', { name: 'SEO' }));
    expect(screen.getByText('Deterministic on-page assessment')).toBeTruthy();
    expect(screen.getByText(String(SEO.score))).toBeTruthy();
  });

  it('follows the document identity in Insights without showing stale context', async () => {
    const { rerender } = render(<Harness contentId="c1" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Insights' }));
    expect(await screen.findByText('c1 only')).toBeTruthy();

    rerender(<Harness contentId="c2" />);
    expect(await screen.findByText('c2 only')).toBeTruthy();
    expect(screen.queryByText('c1 only')).toBeNull();
  });

  it('keeps the active tab document-scoped so a switch resets it', () => {
    const { rerender } = render(<Harness documentKey="c1#0" />);
    fireEvent.click(screen.getByRole('tab', { name: 'SEO' }));
    expect(screen.getByText('Deterministic on-page assessment')).toBeTruthy();

    rerender(<Harness documentKey="c2#0" />);
    // The rail falls back to Outline for the new document; no prior context.
    expect(screen.queryByText('Deterministic on-page assessment')).toBeNull();
    expect(screen.getByRole('button', { name: 'Intro' })).toBeTruthy();
  });

  it('exposes the project media library on the Media tab', async () => {
    render(<Harness withMedia />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Media' }));
    await waitFor(() => expect(screen.getByText('Media library')).toBeTruthy());
  });
});
