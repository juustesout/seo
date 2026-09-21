/**
 * Embedded Agent entry surface tests (R2.1).
 *
 * Drive the entry against the real durable-run wire shapes with the transport
 * module mocked, and assert the R2.1 guarantees: it binds to the editor context
 * with no selector, blocks a dirty document instead of sending stale content,
 * prevents duplicate submits, ignores a response for a document that is no longer
 * open, and never mutates content.
 */
import { useState } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import type { AgentRun, InsertImageOperation } from '@seo/contracts';
import { tiptapEmptyDoc, type TipDoc } from '@seo/contracts';
import { EditorContextProvider } from '../editor/EditorContext';
import { createEditorExtensions } from '../editor/extensions';
import { EmbeddedAgentEntry } from './EmbeddedAgentEntry';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/api')>();
  return { ...actual, api: apiMock.api };
});

import { ApiRequestError } from '../../../lib/api';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const CONTENT = '33333333-3333-4333-8333-333333333333';
const OTHER_CONTENT = '44444444-4444-4444-8444-444444444444';
const RUN_ID = 'ar_22222222-2222-4222-8222-222222222222';

const DOC: TipDoc = tiptapEmptyDoc();

function run(over: Partial<AgentRun> = {}): AgentRun {
  return {
    runId: RUN_ID,
    kind: 'design',
    projectId: PROJECT,
    status: 'queued',
    input: { mode: 'intent', intent: { instruction: 'x', projectId: PROJECT } },
    result: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    ...over,
  };
}

function succeeded(): AgentRun {
  return run({
    status: 'succeeded',
    completedAt: '2026-01-01T00:00:01.000Z',
    result: { version: 1, baseRevision: 'rev1:abc', document: { version: 1, blocks: [] } },
  });
}

function Harness({
  open,
  contentId = CONTENT,
  dirty = false,
  ready = true,
  canEdit = true,
  configured = true,
  onSaveNow = () => {},
  onOpenChange = () => {},
  doc = DOC,
}: {
  open: boolean;
  contentId?: string | null;
  dirty?: boolean;
  ready?: boolean;
  canEdit?: boolean;
  configured?: boolean;
  onSaveNow?: () => void;
  onOpenChange?: (open: boolean) => void;
  doc?: TipDoc;
}) {
  return (
    <EditorContextProvider
      projectId={PROJECT}
      contentId={contentId}
      ready={ready}
      dirty={dirty}
      doc={doc}
      editor={null}
    >
      <EmbeddedAgentEntry
        open={open}
        onOpenChange={onOpenChange}
        canEdit={canEdit}
        configured={configured}
        onSaveNow={onSaveNow}
        pollMs={5}
      />
    </EditorContextProvider>
  );
}

/** Open harness that owns its own open state, for focus/escape interaction tests. */
function OpenHarness() {
  const [open, setOpen] = useState(false);
  return <Harness open={open} onOpenChange={setOpen} />;
}

beforeEach(() => {
  apiMock.api.mockReset();
});

describe('EmbeddedAgentEntry closed state', () => {
  it('shows a compact trigger with no project or document selector', () => {
    render(<Harness open={false} />);
    expect(screen.getByTestId('embedded-agent-open').textContent).toContain('Ask Agent');
    expect(screen.queryByTestId('embedded-agent-input')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText(/select document/i)).toBeNull();
  });
});

describe('EmbeddedAgentEntry input', () => {
  it('focuses the instruction field and disables Send for a blank instruction', () => {
    render(<Harness open />);
    const input = screen.getByTestId('embedded-agent-input') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
    expect(screen.getByText('Working with the current document.')).toBeTruthy();
    expect((screen.getByTestId('embedded-agent-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('submits with Enter but not with Shift+Enter, and calls the existing run endpoint', async () => {
    apiMock.api.mockResolvedValueOnce({ run: succeeded(), reused: false });
    render(<Harness open />);
    const input = screen.getByTestId('embedded-agent-input');
    fireEvent.change(input, { target: { value: 'Maak de intro korter.' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(apiMock.api).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(apiMock.api).toHaveBeenCalledTimes(1));
    expect(apiMock.api).toHaveBeenCalledWith(`/projects/${PROJECT}/designer/runs`, {
      method: 'POST',
      body: { mode: 'intent', instruction: 'Maak de intro korter.', content_id: CONTENT },
    });
  });

  it('prevents duplicate submission while a request is in flight', async () => {
    let resolve!: (value: unknown) => void;
    apiMock.api.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    render(<Harness open />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Do something' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));
    fireEvent.click(screen.getByTestId('embedded-agent-send'));
    expect(apiMock.api).toHaveBeenCalledTimes(1);
    resolve({ run: succeeded(), reused: false });
  });

  it('closes on Escape', async () => {
    const onOpenChange = vi.fn();
    render(<Harness open onOpenChange={onOpenChange} />);
    fireEvent.keyDown(screen.getByTestId('embedded-agent-input'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('EmbeddedAgentEntry submission outcomes', () => {
  it('shows a completed state and never mutates content', async () => {
    apiMock.api.mockResolvedValueOnce({ run: succeeded(), reused: false });
    render(<Harness open />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Tighten the intro' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));
    await waitFor(() => expect(screen.getByTestId('embedded-agent-status').textContent).toContain('unchanged'));
    // Only the run endpoint is touched; no content PATCH/POST/apply is issued.
    for (const call of apiMock.api.mock.calls) {
      expect(String(call[0])).toContain('/designer/runs');
    }
  });

  it('polls a queued run and then reports completion', async () => {
    apiMock.api
      .mockResolvedValueOnce({ run: run({ status: 'queued' }), reused: false })
      .mockResolvedValueOnce(run({ status: 'running' }))
      .mockResolvedValueOnce(succeeded());
    render(<Harness open />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Add a section' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));
    await waitFor(() => expect(apiMock.api.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(apiMock.api.mock.calls.map((call) => call[0])).toContain(`/projects/${PROJECT}/designer/runs/${RUN_ID}`);
    await waitFor(() => expect(screen.getByTestId('embedded-agent-status').textContent).toContain('unchanged'));
  });

  it('reports an unwired capability as unsupported in plain language', async () => {
    apiMock.api.mockResolvedValueOnce({
      run: run({ status: 'failed', error: { code: 'visual_design_unavailable', message: 'Not available yet.' } }),
      reused: false,
    });
    render(<Harness open />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Add a call to action' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));
    await waitFor(() =>
      expect(screen.getByTestId('embedded-agent-status').textContent).toContain("isn't available yet"),
    );
  });

  it('shows a recoverable error with a working retry', async () => {
    apiMock.api
      .mockRejectedValueOnce(new ApiRequestError('validation_error', 'Instruction too short', 400))
      .mockResolvedValueOnce({ run: succeeded(), reused: false });
    render(<Harness open />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Hi' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));
    await waitFor(() =>
      expect(screen.getByTestId('embedded-agent-status').textContent).toContain("couldn't use that instruction"),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(apiMock.api).toHaveBeenCalledTimes(2));
  });
});

describe('EmbeddedAgentEntry context safety', () => {
  it('blocks submission on a dirty document and offers Save now', () => {
    const onSaveNow = vi.fn();
    render(<Harness open dirty onSaveNow={onSaveNow} />);
    expect(screen.getByText(/Save your changes first/)).toBeTruthy();
    expect((screen.getByTestId('embedded-agent-send') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save now' }));
    expect(onSaveNow).toHaveBeenCalledTimes(1);
    expect(apiMock.api).not.toHaveBeenCalled();
  });

  it('does not submit when the document is not ready', () => {
    render(<Harness open ready={false} />);
    expect(screen.getByText('The document is still loading.')).toBeTruthy();
    expect((screen.getByTestId('embedded-agent-send') as HTMLButtonElement).disabled).toBe(true);
  });

  it('ignores a response whose document is no longer open', async () => {
    let resolve!: (value: unknown) => void;
    apiMock.api.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { rerender } = render(<Harness open contentId={CONTENT} />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Change it' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));
    expect(apiMock.api).toHaveBeenCalledTimes(1);

    // The user switches document while the request is still running.
    rerender(<Harness open contentId={OTHER_CONTENT} />);
    resolve({ run: succeeded(), reused: false });

    await waitFor(() => expect(apiMock.api).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('embedded-agent-status')).toBeNull();
  });
});

describe('EmbeddedAgentEntry keyboard opening', () => {
  it('opens and focuses the instruction field from the trigger', () => {
    render(<OpenHarness />);
    fireEvent.click(screen.getByTestId('embedded-agent-open'));
    expect(document.activeElement).toBe(screen.getByTestId('embedded-agent-input'));
  });
});

describe('EmbeddedAgentStatus clarification', () => {
  it('renders a clarification request inline', async () => {
    const { EmbeddedAgentStatus } = await import('./EmbeddedAgentStatus');
    render(
      <EmbeddedAgentStatus
        state={{ status: 'clarification', instruction: 'Make it better', message: 'Which section should change?' }}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByTestId('embedded-agent-status').textContent).toContain('Which section should change?');
  });
});

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length > 0) editors.pop()!.destroy();
});

const IMAGE_DOC: TipDoc = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Solar panels store energy.' }] }],
};

const INSERTION: InsertImageOperation = {
  type: 'insert_image',
  target: { kind: 'cursor', position: 3 },
  image: { assetId: 'm1', url: 'https://cdn.test/solar.png', alt: 'Solar panels' },
};

function imageSucceeded(): AgentRun {
  return run({
    status: 'succeeded',
    completedAt: '2026-01-01T00:00:01.000Z',
    result: { version: 1, baseRevision: 'rev1:abc', document: { version: 1, blocks: [] }, insertion: INSERTION },
  });
}

function makeImageEditor(): Editor {
  const editor = new Editor({ extensions: createEditorExtensions({ nodeViews: false }), content: IMAGE_DOC });
  editors.push(editor);
  return editor;
}

function EditorHarness({ editor, doc = IMAGE_DOC }: { editor: Editor; doc?: TipDoc }) {
  return (
    <EditorContextProvider projectId={PROJECT} contentId={CONTENT} ready dirty={false} doc={doc} editor={editor}>
      <EmbeddedAgentEntry open onOpenChange={() => {}} canEdit configured onSaveNow={() => {}} pollMs={5} />
    </EditorContextProvider>
  );
}

describe('EmbeddedAgentEntry image insertion (R3.1)', () => {
  it('asks where to place the image instead of guessing when there is no target', async () => {
    render(<Harness open />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Zet hier een passende afbeelding.' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));
    await waitFor(() =>
      expect(screen.getByTestId('embedded-agent-status').textContent).toContain('Where should I place the image?'),
    );
    expect(apiMock.api).not.toHaveBeenCalled();
  });

  it('sends the editor context, previews the candidate, and inserts once at the target', async () => {
    const editor = makeImageEditor();
    act(() => {
      editor.commands.setTextSelection(3);
    });
    apiMock.api
      .mockResolvedValueOnce({ run: run({ status: 'queued' }), reused: false })
      .mockResolvedValueOnce(imageSucceeded());

    render(<EditorHarness editor={editor} />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Zet hier een passende afbeelding.' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));

    await waitFor(() => expect(screen.getByTestId('embedded-agent-image-candidate')).toBeTruthy());
    const body = apiMock.api.mock.calls[0]![1]!.body as Record<string, unknown>;
    expect(body.content_id).toBe(CONTENT);
    expect(body.editor_context).toMatchObject({ target: { kind: 'cursor', position: 3 } });

    const insert = screen.getByTestId('embedded-agent-insert');
    fireEvent.click(insert);
    fireEvent.click(insert);
    await waitFor(() => expect(screen.getByTestId('embedded-agent-status').textContent).toContain('Image inserted'));

    const json = JSON.stringify(editor.getJSON());
    expect(json).toContain('"type":"image"');
    expect(json).toContain('m1');
    expect((json.match(/"type":"image"/g) ?? []).length).toBe(1);

    act(() => {
      editor.commands.undo();
    });
    expect(JSON.stringify(editor.getJSON())).not.toContain('"type":"image"');
  });

  it('refuses to insert a candidate once the document revision has moved on', async () => {
    const editor = makeImageEditor();
    act(() => {
      editor.commands.setTextSelection(3);
    });
    apiMock.api
      .mockResolvedValueOnce({ run: run({ status: 'queued' }), reused: false })
      .mockResolvedValueOnce(imageSucceeded());

    const { rerender } = render(<EditorHarness editor={editor} />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Zet hier een passende afbeelding.' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));
    await waitFor(() => expect(screen.getByTestId('embedded-agent-image-candidate')).toBeTruthy());

    // The document revision the request was generated against is no longer current.
    rerender(<EditorHarness editor={editor} doc={tiptapEmptyDoc()} />);
    fireEvent.click(screen.getByTestId('embedded-agent-insert'));

    await waitFor(() => expect(screen.getByTestId('embedded-agent-status').textContent).toContain('document changed'));
    expect(JSON.stringify(editor.getJSON())).not.toContain('"type":"image"');
  });

  it('reports a no-candidate image run without mutating the document', async () => {
    const editor = makeImageEditor();
    act(() => {
      editor.commands.setTextSelection(3);
    });
    apiMock.api.mockResolvedValueOnce({
      run: run({ status: 'failed', error: { code: 'image_insertion_no_candidate', message: 'none', retryable: false } }),
      reused: false,
    });

    render(<EditorHarness editor={editor} />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Zet hier een passende afbeelding.' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));
    await waitFor(() =>
      expect(screen.getByTestId('embedded-agent-status').textContent).toContain("couldn't find a suitable image"),
    );
    expect(screen.queryByTestId('embedded-agent-insert')).toBeNull();
    expect(JSON.stringify(editor.getJSON())).not.toContain('"type":"image"');
  });
});

describe('EmbeddedAgentEntry visual intent (R4.1)', () => {
  it('shows the resolved visual role on the inline candidate', async () => {
    const editor = makeImageEditor();
    act(() => {
      editor.commands.setTextSelection(3);
    });
    apiMock.api
      .mockResolvedValueOnce({ run: run({ status: 'queued' }), reused: false })
      .mockResolvedValueOnce(
        run({
          status: 'succeeded',
          result: {
            version: 1,
            baseRevision: 'rev1:abc',
            document: { version: 1, blocks: [] },
            insertion: { ...INSERTION, visual: { role: 'illustration', intent: 'explain' } },
          },
        }),
      );

    render(<EditorHarness editor={editor} />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Voeg een illustratie toe die dit uitlegt.' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));

    await waitFor(() => expect(screen.getByTestId('embedded-agent-image-role').textContent).toContain('Illustration'));
    expect(screen.getByTestId('embedded-agent-image-candidate').textContent).toContain('explains');
  });

  it('reports a visual role the editor cannot host yet without mutating the document', async () => {
    const editor = makeImageEditor();
    act(() => {
      editor.commands.setTextSelection(3);
    });
    apiMock.api.mockResolvedValueOnce({
      run: run({ status: 'failed', error: { code: 'visual_role_unsupported', message: 'hero unsupported', retryable: false } }),
      reused: false,
    });

    render(<EditorHarness editor={editor} />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Maak de hero sterker.' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));

    await waitFor(() =>
      expect(screen.getByTestId('embedded-agent-status').textContent).toContain("isn't supported here yet"),
    );
    expect(JSON.stringify(editor.getJSON())).not.toContain('"type":"image"');
  });
});
