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
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentRun } from '@seo/contracts';
import { tiptapEmptyDoc, type TipDoc } from '@seo/contracts';
import { EditorContextProvider } from '../editor/EditorContext';
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
    fireEvent.change(input, { target: { value: 'Zet hier een passende afbeelding.' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(apiMock.api).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(apiMock.api).toHaveBeenCalledTimes(1));
    expect(apiMock.api).toHaveBeenCalledWith(`/projects/${PROJECT}/designer/runs`, {
      method: 'POST',
      body: { mode: 'intent', instruction: 'Zet hier een passende afbeelding.', content_id: CONTENT },
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
    fireEvent.change(screen.getByTestId('embedded-agent-input'), { target: { value: 'Add an image' } });
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
