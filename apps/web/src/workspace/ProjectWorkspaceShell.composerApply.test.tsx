/**
 * R5.4.3.2: applying a Composed page to the open workspace document.
 *
 * The composed page is generated in Composer mode (no editor mounted). It can
 * only reach the open document through the shell, which stages it and moves to
 * the editor mode, where the existing external-document replacement runs. These
 * tests exercise that handoff end to end with a real Tiptap editor, and pin the
 * rules: an empty document is replaced in place with no document switch and no
 * `/content` create, a non-empty document is never replaced, and the R5.4.2
 * create-new-draft handoff is untouched.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
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
      // Mirrors the real editor: the lifted session document seeds the live
      // editor, so revision guards compare against the same content.
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

vi.mock('../views/Compose', async () => {
  const { useWorkspaceSessionContext } = await import('./workspaceSession');
  // A fully representable run: one section whose children are text blocks.
  const composed = {
    version: 1,
    blocks: [
      {
        type: 'section',
        children: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Composed heading' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Body copy' }] },
        ],
      },
    ],
  };
  // A partly representable run: the heading maps, the nested CTA does not.
  const mixed = {
    version: 1,
    blocks: [
      {
        type: 'section',
        children: [
          { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Mixed heading' }] },
          { type: 'cta', children: [{ type: 'button', content: [{ type: 'text', text: 'Go' }] }] },
        ],
      },
    ],
  };
  // A run with nothing the operation vocabulary can represent.
  const unsupported = {
    version: 1,
    blocks: [{ type: 'cta', children: [{ type: 'button', content: [{ type: 'text', text: 'Go' }] }] }],
  };
  return {
    Compose: ({
      onOpenEditor,
      onApplyToDocument,
      canApplyToDocument,
      onAppendToDocument,
      canAppendToDocument,
    }: {
      onOpenEditor?: (id: string) => void;
      onApplyToDocument?: (document: unknown) => void;
      canApplyToDocument?: boolean;
      onAppendToDocument?: (document: unknown) => void;
      canAppendToDocument?: boolean;
    }) => {
      const ws = useWorkspaceSessionContext();
      return (
        <div>
          <span data-testid="compose-can-apply">{String(canApplyToDocument)}</span>
          <span data-testid="compose-can-append">{String(canAppendToDocument)}</span>
          <span data-testid="compose-boundary">{ws.session.boundary}</span>
          <span data-testid="compose-lifecycle">{ws.lifecycle.status}</span>
          <span data-testid="compose-lifecycle-error">{ws.lifecycle.error ?? ''}</span>
          <button type="button" data-testid="compose-open" onClick={() => onOpenEditor?.('draft-1')}>
            open
          </button>
          <button type="button" data-testid="compose-apply" onClick={() => onApplyToDocument?.(composed)}>
            apply
          </button>
          <button type="button" data-testid="compose-append" onClick={() => onAppendToDocument?.(composed)}>
            append
          </button>
          <button type="button" data-testid="compose-append-mixed" onClick={() => onAppendToDocument?.(mixed)}>
            append-mixed
          </button>
          <button type="button" data-testid="compose-append-gap" onClick={() => onAppendToDocument?.(unsupported)}>
            append-gap
          </button>
        </div>
      );
    },
  };
});

vi.mock('../lib/api', () => ({ api: apiMock.api }));

vi.mock('../views/Designer', () => ({ Designer: () => <div data-testid="mode-designer" /> }));

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
    if (path === '/projects/p1/content/draft-1') return row('draft-1', EMPTY_JSON);
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
        // Mirrors the canonical route: a mode change drops the deep-linked
        // content id, so remounting the editor does not reopen the document.
        setContentId(null);
      }}
    />
  );
}

function apiMethods(path: string, method: string): number {
  return apiMock.api.mock.calls.filter(([p, init]) => p === path && (init as { method?: string } | undefined)?.method === method)
    .length;
}

describe('Composer output applied to the open document', () => {
  it('replaces an open empty document in place with no switch and no create', async () => {
    render(<Harness initialContentId="doc-empty" />);
    await waitFor(() =>
      expect(screen.getByTestId('mode-editor').getAttribute('data-boundary')).toContain('doc-empty'),
    );

    fireEvent.click(screen.getByTestId('workspace-mode-composer'));
    await screen.findByTestId('compose-apply');
    await waitFor(() => expect(screen.getByTestId('compose-lifecycle').textContent).toBe('ready'));
    await waitFor(() => expect(screen.getByTestId('compose-can-apply').textContent).toBe('true'));
    const boundaryBefore = screen.getByTestId('compose-boundary').textContent;

    fireEvent.click(screen.getByTestId('compose-apply'));

    await screen.findByTestId('mode-editor');
    await waitFor(() => expect(probe.editors.at(-1)?.getText()).toContain('Composed heading'));
    expect(probe.editors.at(-1)?.getText()).toContain('Body copy');

    // No document switch: the boundary is where it was before the apply.
    expect(screen.getByTestId('mode-editor').getAttribute('data-boundary')).toBe(boundaryBefore);
    // No Composer create: the composed document replaces the open one.
    expect(apiMethods('/projects/p1/content', 'POST')).toBe(0);
    // The apply reuses the editor transaction; it starts no save of its own.
    expect(autoMock.saveNow).not.toHaveBeenCalled();
  });

  it('never replaces a non-empty document and reports why', async () => {
    render(<Harness initialContentId="doc-full" />);
    await waitFor(() => expect(screen.getByTestId('mode-editor').getAttribute('data-boundary')).toContain('doc-full'));

    fireEvent.click(screen.getByTestId('workspace-mode-composer'));
    await screen.findByTestId('compose-apply');
    await waitFor(() => expect(screen.getByTestId('compose-lifecycle').textContent).toBe('ready'));
    expect(screen.getByTestId('compose-can-apply').textContent).toBe('false');

    fireEvent.click(screen.getByTestId('compose-apply'));

    await screen.findByText(/only be applied to an empty document/);
    expect(screen.queryByTestId('mode-editor')).toBeNull();
    expect(apiMethods('/projects/p1/content', 'POST')).toBe(0);
  });

  it('keeps the R5.4.2 create-new-draft handoff working alongside apply', async () => {
    render(<Harness initialContentId="doc-empty" />);
    await waitFor(() =>
      expect(screen.getByTestId('mode-editor').getAttribute('data-boundary')).toContain('doc-empty'),
    );

    fireEvent.click(screen.getByTestId('workspace-mode-composer'));
    await screen.findByTestId('compose-open');
    fireEvent.click(screen.getByTestId('compose-open'));

    await screen.findByTestId('mode-editor');
    await waitFor(() => expect(screen.getByTestId('mode-editor').getAttribute('data-boundary')).toContain('draft-1'));
    expect(screen.queryByTestId('compose-open')).toBeNull();
  });

  it('appends the representable parts of a run to the open non-empty document in place', async () => {
    render(<Harness initialContentId="doc-full" />);
    await waitFor(() => expect(screen.getByTestId('mode-editor').getAttribute('data-boundary')).toContain('doc-full'));

    fireEvent.click(screen.getByTestId('workspace-mode-composer'));
    await screen.findByTestId('compose-append');
    await waitFor(() => expect(screen.getByTestId('compose-lifecycle').textContent).toBe('ready'));
    await waitFor(() => expect(screen.getByTestId('compose-can-append').textContent).toBe('true'));
    expect(screen.getByTestId('compose-can-apply').textContent).toBe('false');
    const boundaryBefore = screen.getByTestId('compose-boundary').textContent;

    fireEvent.click(screen.getByTestId('compose-append'));

    await screen.findByTestId('mode-editor');
    await waitFor(() => expect(probe.editors.at(-1)?.getText()).toContain('Composed heading'));
    expect(probe.editors.at(-1)?.getText()).toContain('Body copy');
    // Appended to the open content instead of replacing it.
    expect(probe.editors.at(-1)?.getText()).toContain('Existing content');

    // No document switch: the boundary is where it was before the append.
    expect(screen.getByTestId('mode-editor').getAttribute('data-boundary')).toBe(boundaryBefore);
    // No Composer create: the open document is the only target.
    expect(apiMethods('/projects/p1/content', 'POST')).toBe(0);
    // The append reuses the editor transaction; it starts no save of its own.
    expect(autoMock.saveNow).not.toHaveBeenCalled();
  });

  it('reports the parts it could not add when only some structures are representable', async () => {
    render(<Harness initialContentId="doc-full" />);
    await waitFor(() => expect(screen.getByTestId('mode-editor').getAttribute('data-boundary')).toContain('doc-full'));

    fireEvent.click(screen.getByTestId('workspace-mode-composer'));
    await screen.findByTestId('compose-append-mixed');
    await waitFor(() => expect(screen.getByTestId('compose-lifecycle').textContent).toBe('ready'));

    fireEvent.click(screen.getByTestId('compose-append-mixed'));

    await screen.findByTestId('mode-editor');
    await waitFor(() => expect(probe.editors.at(-1)?.getText()).toContain('Mixed heading'));
    expect(probe.editors.at(-1)?.getText()).toContain('Existing content');
    // The unsupported part is surfaced, never silently dropped.
    await waitFor(() => expect(screen.getByTestId('editor-notice').textContent).toContain('Not added'));
  });

  it('refuses to append and explains when nothing in the run is representable', async () => {
    render(<Harness initialContentId="doc-full" />);
    await waitFor(() => expect(screen.getByTestId('mode-editor').getAttribute('data-boundary')).toContain('doc-full'));

    fireEvent.click(screen.getByTestId('workspace-mode-composer'));
    await screen.findByTestId('compose-append-gap');
    await waitFor(() => expect(screen.getByTestId('compose-lifecycle').textContent).toBe('ready'));

    fireEvent.click(screen.getByTestId('compose-append-gap'));

    await screen.findByText(/could be added to the document/);
    expect(screen.queryByTestId('mode-editor')).toBeNull();
    expect(apiMethods('/projects/p1/content', 'POST')).toBe(0);
  });
});
