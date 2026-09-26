/**
 * R5.5.2: applying a reviewed Designer proposal to the open workspace document.
 *
 * The Designer runs in an isolated mode with no editor mounted, so a proposal
 * can only reach the open document through the shell: it stages the proposal and
 * moves to the editor mode, where the existing document-operation / image
 * insertion pipeline applies it. These tests exercise that handoff end to end
 * with a real Tiptap editor and pin the shell guards: a representable proposal
 * is applied in place with no `/content` create and no document switch, while an
 * unsupported, foreign-document or stale proposal only reports why and never
 * touches the document.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import type { CanonicalDocument, DesignerProposal } from '@seo/contracts';
import { ProjectWorkspaceShell } from './ProjectWorkspaceShell';
import type { WorkspaceMode } from './WorkspaceModeSwitcher';

const probe = vi.hoisted(() => ({ editors: [] as Editor[] }));
const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
const autoMock = vi.hoisted(() => ({
  setBaseline: vi.fn(),
  saveNow: vi.fn(),
  flush: vi.fn(async () => true),
}));

vi.mock('../components/content/useAutosave', () => ({
  useAutosave: () => ({
    status: 'saved',
    dirty: false,
    setBaseline: autoMock.setBaseline,
    saveNow: autoMock.saveNow,
    flush: autoMock.flush,
  }),
}));

vi.mock('../views/EditorView', async () => {
  const React = await import('react');
  const { Editor } = await import('@tiptap/core');
  const { createEditorExtensions } = await import('../components/content/editor/extensions');
  const { tiptapEmptyDoc } = await import('@seo/contracts');
  const { useWorkspaceSessionContext } = await import('./workspaceSession');
  return {
    EditorView: ({
      onEditor,
      open,
      initialContentId,
    }: {
      onEditor: (editor: Editor) => void;
      open: (id: string) => void;
      initialContentId?: string | null;
    }) => {
      const ws = useWorkspaceSessionContext();
      const editorRef = React.useRef<Editor | null>(null);
      React.useEffect(() => {
        if (initialContentId) open(initialContentId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      React.useEffect(() => {
        const editor = new Editor({ extensions: createEditorExtensions({ nodeViews: false }), content: tiptapEmptyDoc() });
        editorRef.current = editor;
        probe.editors.push(editor);
        onEditor(editor);
        return () => editor.destroy();
      }, [onEditor]);
      React.useEffect(() => {
        const editor = editorRef.current;
        if (editor && !editor.isDestroyed) editor.commands.setContent(ws.doc, false);
      }, [ws.doc]);
      return (
        <div data-testid="mode-editor" data-boundary={ws.session.boundary}>
          <span data-testid="editor-notice">{ws.notice ?? ''}</span>
        </div>
      );
    },
  };
});

vi.mock('../views/Designer', async () => {
  const { DESIGNER_PROPOSAL_VERSION, DOCUMENT_OPERATIONS_VERSION, contentRevisionOf } = await import(
    '@seo/contracts'
  );
  const { useWorkspaceSessionContext } = await import('./workspaceSession');

  const BASE_DOCUMENT: CanonicalDocument = {
    version: 1,
    blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Designer base' }] }],
  };

  return {
    Designer: ({
      onApplyProposal,
      onReviewOpenChange,
    }: {
      onApplyProposal?: (proposal: DesignerProposal, targetDocumentId: string) => void;
      onReviewOpenChange?: (open: boolean) => void;
    }) => {
      const ws = useWorkspaceSessionContext();
      const revision = contentRevisionOf(ws.doc);
      const representable: DesignerProposal = {
        version: DESIGNER_PROPOSAL_VERSION,
        baseRevision: revision,
        document: BASE_DOCUMENT,
        operations: {
          version: DOCUMENT_OPERATIONS_VERSION,
          baseRevision: revision,
          operations: [
            {
              type: 'insert_section',
              ref: 'section-1',
              section: { kind: 'section' },
              position: { mode: 'document_end' },
            },
            {
              type: 'insert_text',
              target: { mode: 'ref', ref: 'section-1' },
              block: { type: 'heading', level: 1, text: 'Designer heading' },
            },
            {
              type: 'insert_text',
              target: { mode: 'ref', ref: 'section-1' },
              block: { type: 'paragraph', text: 'Designer body' },
            },
          ],
        },
      };
      const unsupported: DesignerProposal = {
        version: DESIGNER_PROPOSAL_VERSION,
        baseRevision: revision,
        document: BASE_DOCUMENT,
      };
      const stale: DesignerProposal = { ...representable, baseRevision: 'rev1:0000000000000000' };
      const targetId = ws.session.identity.documentId ?? '';

      return (
        <div>
          <span data-testid="designer-lifecycle">{ws.lifecycle.status}</span>
          <span data-testid="designer-document">{ws.session.identity.documentId ?? ''}</span>
          <button
            type="button"
            data-testid="designer-apply"
            onClick={() => onApplyProposal?.(representable, targetId)}
          >
            apply
          </button>
          <button
            type="button"
            data-testid="designer-apply-unsupported"
            onClick={() => onApplyProposal?.(unsupported, targetId)}
          >
            apply-unsupported
          </button>
          <button
            type="button"
            data-testid="designer-apply-foreign"
            onClick={() => onApplyProposal?.(representable, 'other-doc')}
          >
            apply-foreign
          </button>
          <button type="button" data-testid="designer-apply-stale" onClick={() => onApplyProposal?.(stale, targetId)}>
            apply-stale
          </button>
          <button type="button" data-testid="designer-review-open" onClick={() => onReviewOpenChange?.(true)}>
            open-review
          </button>
          <button type="button" data-testid="designer-review-close" onClick={() => onReviewOpenChange?.(false)}>
            close-review
          </button>
        </div>
      );
    },
  };
});

vi.mock('../lib/api', () => ({ api: apiMock.api }));

function row(id: string, contentJson: unknown) {
  return {
    id,
    title: 'Doc',
    slug: 'doc',
    status: 'draft',
    content_json: contentJson,
    content_html: null,
    outline: null,
    target_keyword: null,
    meta_title: null,
    meta_description: null,
    url: null,
    excerpt: null,
    seo_score: null,
    updated_at: null,
    published_at: null,
  };
}

const EMPTY_JSON = { type: 'doc', content: [{ type: 'paragraph' }] };
const FULL_JSON = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Existing content' }] }],
};

beforeEach(() => {
  probe.editors.length = 0;
  autoMock.saveNow.mockClear();
  autoMock.flush.mockClear();
  apiMock.api.mockReset();
  apiMock.api.mockImplementation(async (path: string) => {
    if (path.includes('/content?')) return { content: [], total: 0 };
    if (path === '/projects/p1/content/doc-empty') return row('doc-empty', EMPTY_JSON);
    if (path === '/projects/p1/content/doc-full') return row('doc-full', FULL_JSON);
    if (path === '/projects/p1/ai') return { configured: false };
    return {};
  });
});

afterEach(() => {
  probe.editors.length = 0;
});

function Harness({ initialContentId = null }: { initialContentId?: string | null }) {
  const [mode, setMode] = useState<WorkspaceMode>('editor');
  const [contentId, setContentId] = useState<string | null>(initialContentId);
  return (
    <ProjectWorkspaceShell
      projectId="p1"
      role="owner"
      mode={mode}
      initialContentId={contentId}
      onModeChange={(next) => {
        setMode(next);
        setContentId(null);
      }}
    />
  );
}

function apiMethods(path: string, method: string): number {
  return apiMock.api.mock.calls.filter(([p, init]) => p === path && (init as { method?: string } | undefined)?.method === method)
    .length;
}

async function openDesignerWithFullDocument(): Promise<string> {
  render(<Harness initialContentId="doc-full" />);
  await waitFor(() => expect(screen.getByTestId('mode-editor').getAttribute('data-boundary')).toContain('doc-full'));
  const boundary = screen.getByTestId('mode-editor').getAttribute('data-boundary') ?? '';
  fireEvent.click(screen.getByTestId('workspace-mode-designer'));
  await screen.findByTestId('designer-apply');
  await waitFor(() => expect(screen.getByTestId('designer-lifecycle').textContent).toBe('ready'));
  return boundary;
}

describe('Designer proposal applied to the open document', () => {
  it('applies a representable proposal through the editor with no switch and no create', async () => {
    const boundaryBefore = await openDesignerWithFullDocument();

    fireEvent.click(screen.getByTestId('designer-apply'));

    await screen.findByTestId('mode-editor');
    await waitFor(() => expect(probe.editors.at(-1)?.getText()).toContain('Designer heading'));
    expect(probe.editors.at(-1)?.getText()).toContain('Designer body');
    expect(probe.editors.at(-1)?.getText()).toContain('Existing content');

    // No document switch: the boundary is where it was before the apply.
    expect(screen.getByTestId('mode-editor').getAttribute('data-boundary')).toBe(boundaryBefore);
    // The apply reuses the editor transaction; it starts no save of its own and
    // never creates a content record for the proposal.
    expect(autoMock.saveNow).not.toHaveBeenCalled();
    expect(apiMethods('/projects/p1/content', 'POST')).toBe(0);
  });

  it('refuses a proposal that carries no representable mutation', async () => {
    await openDesignerWithFullDocument();

    fireEvent.click(screen.getByTestId('designer-apply-unsupported'));

    await screen.findByText(/whole-document result/);
    expect(screen.queryByTestId('mode-editor')).toBeNull();
    expect(screen.getByTestId('designer-apply')).toBeTruthy();
    expect(apiMethods('/projects/p1/content', 'POST')).toBe(0);
  });

  it('refuses a proposal generated for a different document', async () => {
    await openDesignerWithFullDocument();

    fireEvent.click(screen.getByTestId('designer-apply-foreign'));

    await screen.findByText(/generated for a different document/);
    expect(screen.queryByTestId('mode-editor')).toBeNull();
    expect(apiMethods('/projects/p1/content', 'POST')).toBe(0);
  });

  it('refuses a proposal whose base revision is stale', async () => {
    await openDesignerWithFullDocument();

    fireEvent.click(screen.getByTestId('designer-apply-stale'));

    await screen.findByText(/changed before this proposal could be applied/);
    expect(screen.queryByTestId('mode-editor')).toBeNull();
    expect(apiMethods('/projects/p1/content', 'POST')).toBe(0);
  });

  it('holds navigation while a Designer review is open and allows it after close', async () => {
    await openDesignerWithFullDocument();

    fireEvent.click(screen.getByTestId('designer-review-open'));
    fireEvent.click(screen.getByTestId('workspace-mode-editor'));

    // Still in Designer, with the reason surfaced rather than silently dropped.
    expect(screen.getByTestId('designer-apply')).toBeTruthy();
    expect(screen.queryByTestId('mode-editor')).toBeNull();
    await screen.findByText(/Finish or cancel the Designer review before leaving Designer/);

    fireEvent.click(screen.getByTestId('designer-review-close'));
    fireEvent.click(screen.getByTestId('workspace-mode-editor'));
    await screen.findByTestId('mode-editor');
  });
});
