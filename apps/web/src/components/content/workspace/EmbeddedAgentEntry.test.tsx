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
import type { AgentRun, DocumentOperationBatch, InsertImageOperation } from '@seo/contracts';
import { contentRevisionOf, tiptapEmptyDoc, type TipDoc } from '@seo/contracts';
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

const SECTION_DOC: TipDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Solar energy' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Solar panels store energy.' }] },
  ],
};

const SECTION_INSERTION: InsertImageOperation = {
  type: 'insert_image',
  target: { kind: 'section', sectionPath: [0], anchorPath: [0], heading: 'Solar energy' },
  image: { assetId: 'm1', url: 'https://cdn.test/solar.png', alt: 'Solar panels' },
  visual: { role: 'section', intent: 'reinforce', placement: 'contained' },
};

const HERO_INSERTION: InsertImageOperation = {
  type: 'insert_image',
  target: { kind: 'hero', heroPath: [0], anchorPath: [0], nodeType: 'heading', placement: 'full_bleed' },
  image: { assetId: 'm1', url: 'https://cdn.test/solar.png', alt: 'Solar panels' },
  visual: { role: 'hero', intent: 'emphasis', placement: 'full_bleed' },
};

const BACKGROUND_INSERTION: InsertImageOperation = {
  type: 'insert_image',
  target: { kind: 'section', sectionPath: [0], anchorPath: [0], heading: 'Solar energy' },
  image: { assetId: 'm1', url: 'https://cdn.test/solar.png', alt: '' },
  visual: { role: 'background', intent: 'atmosphere', placement: 'full_bleed' },
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
    expect(body.editor_context).toMatchObject({
      target: { kind: 'cursor', position: 3 },
      // R4.5A/R4.5B: an explicit image request opts into local-first external
      // search and offers generation, which still needs an explicit confirm.
      sourcePolicy: { allowExternalSearch: true, allowGeneration: true, requireGenerationConfirmation: true },
    });
    expect((body.editor_context as Record<string, unknown>).generationConfirmed).toBeUndefined();

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

  it('shows the external source when a candidate came from stock search (R4.5A)', async () => {
    const editor = makeImageEditor();
    act(() => {
      editor.commands.setTextSelection(3);
    });
    const unsplashInsertion: InsertImageOperation = {
      ...INSERTION,
      image: {
        ...INSERTION.image,
        source: 'unsplash',
        credit: 'Photo by Ada on Unsplash',
        sourceUrl: 'https://unsplash.com/photos/x',
      },
    };
    apiMock.api.mockResolvedValueOnce({ run: run({ status: 'queued' }), reused: false }).mockResolvedValueOnce(
      run({
        status: 'succeeded',
        completedAt: '2026-01-01T00:00:01.000Z',
        result: { version: 1, baseRevision: 'rev1:abc', document: { version: 1, blocks: [] }, insertion: unsplashInsertion },
      }),
    );

    render(<EditorHarness editor={editor} />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Zet hier een passende afbeelding.' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));

    await waitFor(() => expect(screen.getByTestId('embedded-agent-image-candidate')).toBeTruthy());
    expect(screen.getByTestId('embedded-agent-image-source').textContent).toContain('Unsplash');
    expect(screen.getByTestId('embedded-agent-image-source').textContent).toContain('Photo by Ada');
  });

  it('refuses to insert a candidate once the document revision has moved on', async () => {
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

    // The document revision the request was generated against is no longer current.
    act(() => {
      editor.commands.insertContent({ type: 'paragraph', content: [{ type: 'text', text: 'Edited after the request.' }] });
    });
    fireEvent.click(screen.getByTestId('embedded-agent-insert'));

    await waitFor(() => expect(screen.getByTestId('embedded-agent-status').textContent).toContain('document changed'));
    expect(JSON.stringify(editor.getJSON())).not.toContain('"type":"image"');
  });

  it('reveals the inserted image after a successful insertion', async () => {
    const editor = makeImageEditor();
    act(() => {
      editor.commands.setTextSelection(3);
    });
    const onRevealInsertion = vi.fn();
    apiMock.api
      .mockResolvedValueOnce({ run: run({ status: 'queued' }), reused: false })
      .mockResolvedValueOnce(imageSucceeded());

    render(
      <EditorContextProvider projectId={PROJECT} contentId={CONTENT} ready dirty={false} doc={IMAGE_DOC} editor={editor}>
        <EmbeddedAgentEntry
          open
          onOpenChange={() => {}}
          canEdit
          configured
          onSaveNow={() => {}}
          pollMs={5}
          onRevealInsertion={onRevealInsertion}
        />
      </EditorContextProvider>,
    );
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Zet hier een passende afbeelding.' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));

    await waitFor(() => expect(screen.getByTestId('embedded-agent-image-candidate')).toBeTruthy());
    fireEvent.click(screen.getByTestId('embedded-agent-insert'));
    await waitFor(() => expect(onRevealInsertion).toHaveBeenCalledTimes(1));
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

describe('EmbeddedAgentEntry confirmed generation (R4.5B)', () => {
  function generationRequired(): AgentRun {
    return run({
      status: 'succeeded',
      completedAt: '2026-01-01T00:00:01.000Z',
      result: {
        version: 1,
        baseRevision: 'rev1:abc',
        document: { version: 1, blocks: [] },
        acquisition: { kind: 'generation_required', provider: 'openai', model: 'dall-e-3' },
      },
    });
  }

  function generatedSucceeded(): AgentRun {
    const insertion: InsertImageOperation = {
      ...INSERTION,
      image: { assetId: 'm-gen', url: 'https://cdn.test/generated.png', alt: 'Generated image', source: 'openai_generated' },
    };
    return run({
      status: 'succeeded',
      completedAt: '2026-01-01T00:00:01.000Z',
      result: { version: 1, baseRevision: 'rev1:abc', document: { version: 1, blocks: [] }, insertion },
    });
  }

  it('offers AI generation and only runs it on the explicit confirmed rerun', async () => {
    const editor = makeImageEditor();
    act(() => {
      editor.commands.setTextSelection(3);
    });
    apiMock.api
      .mockResolvedValueOnce({ run: generationRequired(), reused: false })
      .mockResolvedValueOnce({ run: generatedSucceeded(), reused: false });

    render(<EditorHarness editor={editor} />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Zet hier een passende afbeelding.' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));

    await waitFor(() => expect(screen.getByTestId('embedded-agent-generation')).toBeTruthy());
    expect(screen.queryByTestId('embedded-agent-insert')).toBeNull();
    expect(screen.getByTestId('embedded-agent-generation-provider').textContent).toContain('OpenAI');
    const firstBody = apiMock.api.mock.calls[0]![1]!.body as Record<string, unknown>;
    expect((firstBody.editor_context as Record<string, unknown>).generationConfirmed).toBeUndefined();

    fireEvent.click(screen.getByTestId('embedded-agent-generate'));
    await waitFor(() => expect(screen.getByTestId('embedded-agent-image-candidate')).toBeTruthy());

    expect(apiMock.api).toHaveBeenCalledTimes(2);
    const secondBody = apiMock.api.mock.calls[1]![1]!.body as Record<string, unknown>;
    expect(secondBody.instruction).toBe('Zet hier een passende afbeelding.');
    expect(secondBody.editor_context).toMatchObject({
      generationConfirmed: true,
      sourcePolicy: { allowExternalSearch: true, allowGeneration: true, requireGenerationConfirmation: true },
    });
    expect(screen.getByTestId('embedded-agent-image-source').textContent).toContain('AI-generated');
    // Still no document change until the user inserts the candidate.
    expect(JSON.stringify(editor.getJSON())).not.toContain('"type":"image"');
  });

  it('ignores a second Generate click while the confirmed run is in flight', async () => {
    const editor = makeImageEditor();
    act(() => {
      editor.commands.setTextSelection(3);
    });
    apiMock.api.mockResolvedValueOnce({ run: generationRequired(), reused: false }).mockReturnValueOnce(
      new Promise(() => undefined),
    );

    render(<EditorHarness editor={editor} />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Zet hier een passende afbeelding.' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));
    await waitFor(() => expect(screen.getByTestId('embedded-agent-generate')).toBeTruthy());

    const generate = screen.getByTestId('embedded-agent-generate');
    fireEvent.click(generate);
    fireEvent.click(generate);
    await waitFor(() => expect(apiMock.api).toHaveBeenCalledTimes(2));
    // Only the first offer + the single confirmed run were sent.
    expect(apiMock.api).toHaveBeenCalledTimes(2);
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
      run: run({ status: 'failed', error: { code: 'visual_role_unsupported', message: 'logo unsupported', retryable: false } }),
      reused: false,
    });

    render(<EditorHarness editor={editor} />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Maak het logo sterker.' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));

    await waitFor(() =>
      expect(screen.getByTestId('embedded-agent-status').textContent).toContain("isn't supported here yet"),
    );
    expect(JSON.stringify(editor.getJSON())).not.toContain('"type":"image"');
  });
});

describe('EmbeddedAgentEntry section visuals (R4.2)', () => {
  it('sends the section hint, previews the candidate, and inserts after the heading', async () => {
    const editor = new Editor({ extensions: createEditorExtensions({ nodeViews: false }), content: SECTION_DOC });
    editors.push(editor);
    act(() => {
      editor.commands.setTextSelection(20);
    });
    apiMock.api
      .mockResolvedValueOnce({ run: run({ status: 'queued' }), reused: false })
      .mockResolvedValueOnce(
        run({
          status: 'succeeded',
          result: { version: 1, baseRevision: 'rev1:abc', document: { version: 1, blocks: [] }, insertion: SECTION_INSERTION },
        }),
      );

    render(<EditorHarness editor={editor} doc={SECTION_DOC} />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), {
      target: { value: 'Geef deze sectie een passende afbeelding.' },
    });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));

    await waitFor(() => expect(screen.getByTestId('embedded-agent-image-role').textContent).toContain('Section image'));
    const body = apiMock.api.mock.calls[0]![1]!.body as Record<string, unknown>;
    expect(body.editor_context).toMatchObject({
      target: { kind: 'cursor' },
      sectionTarget: { kind: 'section', sectionPath: [0], anchorPath: [0], heading: 'Solar energy' },
    });

    fireEvent.click(screen.getByTestId('embedded-agent-insert'));
    await waitFor(() => expect(screen.getByTestId('embedded-agent-status').textContent).toContain('Image inserted'));

    const content = editor.getJSON().content ?? [];
    expect(content[0]!.type).toBe('heading');
    expect(content[1]!.type).toBe('image');
  });

  it('asks the user to anchor the request when the section cannot be found', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Just prose.' }] }] },
    });
    editors.push(editor);
    act(() => {
      editor.commands.setTextSelection(3);
    });
    apiMock.api.mockResolvedValueOnce({
      run: run({ status: 'failed', error: { code: 'section_target_unresolved', message: 'no heading', retryable: false } }),
      reused: false,
    });

    render(
      <EditorHarness
        editor={editor}
        doc={{ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Just prose.' }] }] }}
      />,
    );
    fireEvent.change(screen.getByTestId('embedded-agent-input'), {
      target: { value: 'Geef deze sectie een passende afbeelding.' },
    });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));

    await waitFor(() =>
      expect(screen.getByTestId('embedded-agent-status').textContent).toContain('Put the cursor under a section heading'),
    );
    expect(JSON.stringify(editor.getJSON())).not.toContain('"type":"image"');
  });
});

describe('EmbeddedAgentEntry hero visuals (R4.3)', () => {
  it('sends the hero hint, previews the candidate, and inserts in the hero', async () => {
    const editor = new Editor({ extensions: createEditorExtensions({ nodeViews: false }), content: SECTION_DOC });
    editors.push(editor);
    act(() => {
      editor.commands.setTextSelection(20);
    });
    apiMock.api
      .mockResolvedValueOnce({ run: run({ status: 'queued' }), reused: false })
      .mockResolvedValueOnce(
        run({
          status: 'succeeded',
          result: { version: 1, baseRevision: 'rev1:abc', document: { version: 1, blocks: [] }, insertion: HERO_INSERTION },
        }),
      );

    render(<EditorHarness editor={editor} doc={SECTION_DOC} />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Maak de hero-afbeelding sterker.' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));

    await waitFor(() => expect(screen.getByTestId('embedded-agent-image-role').textContent).toContain('Hero visual'));
    const body = apiMock.api.mock.calls[0]![1]!.body as Record<string, unknown>;
    expect(body.editor_context).toMatchObject({
      target: { kind: 'cursor' },
      heroTarget: { kind: 'hero', heroPath: [0], anchorPath: [0], placement: 'full_bleed' },
    });

    fireEvent.click(screen.getByTestId('embedded-agent-insert'));
    await waitFor(() => expect(screen.getByTestId('embedded-agent-status').textContent).toContain('Image inserted'));

    const content = editor.getJSON().content ?? [];
    expect(content[0]!.type).toBe('heading');
    expect(content[1]!.type).toBe('image');
  });

  it('asks the user to anchor the request when the hero cannot be found', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Just prose.' }] }] },
    });
    editors.push(editor);
    act(() => {
      editor.commands.setTextSelection(3);
    });
    apiMock.api.mockResolvedValueOnce({
      run: run({ status: 'failed', error: { code: 'hero_target_unresolved', message: 'no hero', retryable: false } }),
      reused: false,
    });

    render(
      <EditorHarness
        editor={editor}
        doc={{ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Just prose.' }] }] }}
      />,
    );
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Maak de hero-afbeelding sterker.' } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));

    await waitFor(() =>
      expect(screen.getByTestId('embedded-agent-status').textContent).toContain("couldn't find a hero area"),
    );
    expect(JSON.stringify(editor.getJSON())).not.toContain('"type":"image"');
  });
});

describe('EmbeddedAgentEntry background visuals (R4.4)', () => {
  it('sends the host hint, previews the candidate, and inserts the background after the heading', async () => {
    const editor = new Editor({ extensions: createEditorExtensions({ nodeViews: false }), content: SECTION_DOC });
    editors.push(editor);
    act(() => {
      editor.commands.setTextSelection(20);
    });
    apiMock.api
      .mockResolvedValueOnce({ run: run({ status: 'queued' }), reused: false })
      .mockResolvedValueOnce(
        run({
          status: 'succeeded',
          result: { version: 1, baseRevision: 'rev1:abc', document: { version: 1, blocks: [] }, insertion: BACKGROUND_INSERTION },
        }),
      );

    render(<EditorHarness editor={editor} doc={SECTION_DOC} />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), {
      target: { value: 'Geef deze sectie een rustige achtergrond.' },
    });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));

    await waitFor(() => expect(screen.getByTestId('embedded-agent-image-role').textContent).toContain('Background visual'));
    const body = apiMock.api.mock.calls[0]![1]!.body as Record<string, unknown>;
    expect(body.editor_context).toMatchObject({
      target: { kind: 'cursor' },
      sectionTarget: { kind: 'section', sectionPath: [0], anchorPath: [0], heading: 'Solar energy' },
    });

    fireEvent.click(screen.getByTestId('embedded-agent-insert'));
    await waitFor(() => expect(screen.getByTestId('embedded-agent-status').textContent).toContain('Image inserted'));

    const content = editor.getJSON().content ?? [];
    expect(content[0]!.type).toBe('heading');
    expect(content[1]!.type).toBe('image');
  });

  it('asks the user to anchor the request when no host region can be found', async () => {
    const editor = new Editor({
      extensions: createEditorExtensions({ nodeViews: false }),
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Just prose.' }] }] },
    });
    editors.push(editor);
    act(() => {
      editor.commands.setTextSelection(3);
    });
    apiMock.api.mockResolvedValueOnce({
      run: run({ status: 'failed', error: { code: 'background_target_unresolved', message: 'no region', retryable: false } }),
      reused: false,
    });

    render(
      <EditorHarness
        editor={editor}
        doc={{ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Just prose.' }] }] }}
      />,
    );
    fireEvent.change(screen.getByTestId('embedded-agent-input'), {
      target: { value: 'Gebruik een rustige achtergrond.' },
    });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));

    await waitFor(() =>
      expect(screen.getByTestId('embedded-agent-status').textContent).toContain('section or hero for the background'),
    );
    expect(JSON.stringify(editor.getJSON())).not.toContain('"type":"image"');
  });
});

describe('EmbeddedAgentEntry document operations (Part B)', () => {
  const OPERATION_INSTRUCTION = 'Please add a hero section with a title "Halleluja" and background image of Amsterdam';

  function operationBatch(): DocumentOperationBatch {
    return {
      version: 1,
      baseRevision: contentRevisionOf(IMAGE_DOC),
      operations: [
        { type: 'insert_section', ref: 'section-1', section: { kind: 'hero' }, position: { mode: 'document_start' } },
        {
          type: 'insert_text',
          target: { mode: 'ref', ref: 'section-1' },
          block: { type: 'heading', level: 1, text: 'Halleluja' },
        },
        {
          type: 'insert_image',
          target: { mode: 'ref', ref: 'section-1' },
          image: { assetId: 'm1', url: 'https://cdn.test/amsterdam.png', alt: 'Amsterdam' },
        },
      ],
    };
  }

  function operationsSucceeded(): AgentRun {
    return run({
      status: 'succeeded',
      completedAt: '2026-01-01T00:00:01.000Z',
      result: {
        version: 1,
        baseRevision: contentRevisionOf(IMAGE_DOC),
        document: { version: 1, blocks: [] },
        operations: operationBatch(),
      },
    });
  }

  it('applies a hero, title and image batch as one undoable editor edit', async () => {
    const editor = makeImageEditor();
    apiMock.api
      .mockResolvedValueOnce({ run: run({ status: 'queued' }), reused: false })
      .mockResolvedValueOnce(operationsSucceeded());

    render(<EditorHarness editor={editor} />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: OPERATION_INSTRUCTION } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));

    const body = apiMock.api.mock.calls[0]![1]!.body as Record<string, unknown>;
    expect(body.instruction).toBe(OPERATION_INSTRUCTION);
    expect(body.editor_context).toBeDefined();

    await waitFor(() => expect(screen.getByTestId('embedded-agent-operations')).toBeTruthy());
    expect(screen.getByTestId('embedded-agent-operations').textContent).toContain('Halleluja');
    expect(JSON.stringify(editor.getJSON())).not.toContain('"type":"image"');

    const apply = screen.getByTestId('embedded-agent-apply');
    fireEvent.click(apply);
    fireEvent.click(apply);
    await waitFor(() => expect(screen.getByTestId('embedded-agent-status').textContent).toContain('Added to the document'));

    const json = JSON.stringify(editor.getJSON());
    expect(json).toContain('Halleluja');
    expect(json).toContain('"type":"image"');
    expect((json.match(/"type":"image"/g) ?? []).length).toBe(1);

    act(() => {
      editor.commands.undo();
    });
    expect(JSON.stringify(editor.getJSON())).not.toContain('"type":"image"');
  });

  it('refuses to apply a batch once the document revision has moved on', async () => {
    const editor = makeImageEditor();
    apiMock.api
      .mockResolvedValueOnce({ run: run({ status: 'queued' }), reused: false })
      .mockResolvedValueOnce(operationsSucceeded());

    render(<EditorHarness editor={editor} />);
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: OPERATION_INSTRUCTION } });
    fireEvent.click(screen.getByTestId('embedded-agent-send'));
    await waitFor(() => expect(screen.getByTestId('embedded-agent-operations')).toBeTruthy());

    act(() => {
      editor.commands.insertContent({ type: 'paragraph', content: [{ type: 'text', text: 'Edited after the request.' }] });
    });
    fireEvent.click(screen.getByTestId('embedded-agent-apply'));

    await waitFor(() => expect(screen.getByTestId('embedded-agent-status').textContent).toContain('document changed'));
    expect(JSON.stringify(editor.getJSON())).not.toContain('"type":"image"');
  });
});
