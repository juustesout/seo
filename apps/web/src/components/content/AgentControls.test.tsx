/**
 * Agent Controls UI: starts a normal `content_write` job, tracks it by explicit
 * identity, and shows a compact run summary. The panel must never issue a write
 * against the source article - every run creates a new draft.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentControls } from './AgentControls';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../../lib/api', () => ({
  api: apiMock.api,
  ApiRequestError: class ApiRequestError extends Error {},
}));

const PROJECT = 'p-1';
const CONTENT = 'c-1';

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    job_type: 'content_write',
    status: 'queued',
    progress: null,
    message: null,
    error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    params: { source_content_id: CONTENT, writer_input: { mode: 'quick_draft', format: 'short_article' } },
    result: null,
    ...overrides,
  };
}

function wire(opts: { jobs?: unknown[]; draft?: unknown } = {}) {
  apiMock.api.mockImplementation(async (path: string, options: { method?: string; body?: unknown } = {}) => {
    if (String(path).includes('/jobs')) return opts.jobs ?? [];
    if (String(path).endsWith('/draft') && options.method === 'POST') return opts.draft ?? { job: job() };
    throw new Error(`unexpected api call ${path}`);
  });
}

function renderControls(props: Partial<Parameters<typeof AgentControls>[0]> = {}) {
  return render(
    <AgentControls projectId={PROJECT} contentId={CONTENT} canEdit aiConfigured {...props} />,
  );
}

beforeEach(() => {
  apiMock.api.mockReset();
});

describe('AgentControls', () => {
  it('renders the mode/format controls and the new-draft note', async () => {
    wire();
    renderControls();
    expect(screen.getByText('Agent Controls')).toBeTruthy();
    expect(screen.getByLabelText('Writer mode')).toBeTruthy();
    expect(screen.getByLabelText('Writer format')).toBeTruthy();
    expect(screen.getByText('Creates a new draft. Your current article is not overwritten.')).toBeTruthy();
  });

  it('starts a content_write job for the selected mode and format', async () => {
    wire();
    renderControls();
    fireEvent.change(screen.getByLabelText('Writer mode'), { target: { value: 'deep_write' } });
    fireEvent.change(screen.getByLabelText('Writer format'), { target: { value: 'explainer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate draft' }));

    await waitFor(() =>
      expect(apiMock.api).toHaveBeenCalledWith(`/projects/${PROJECT}/content/${CONTENT}/draft`, {
        method: 'POST',
        body: { mode: 'deep_write', format: 'explainer' },
      }),
    );
  });

  it('shows the running job status and progress', async () => {
    wire({
      jobs: [
        job({
          status: 'running',
          progress: 40,
          message: 'writing section 2 of 3',
          params: { source_content_id: CONTENT, writer_input: { mode: 'deep_write', format: 'short_article' } },
        }),
      ],
    });
    renderControls();
    expect(await screen.findByText('writing section 2 of 3')).toBeTruthy();
    const progress = screen.getByText('40%');
    expect(progress.parentElement?.textContent).toContain('Deep Write');
    expect(progress.parentElement?.textContent).toContain('running');
  });

  it('renders a compact summary and opens the generated draft', async () => {
    wire({
      jobs: [
        job({
          status: 'completed',
          result: {
            content_id: 'c-2',
            title: 'A brand new draft',
            writer_summary: {
              mode: 'quick_draft',
              format: 'short_article',
              pass_count: 6,
              llm_calls: 4,
              duration_ms: 1500,
              by_kind: { architecture: 1, section_generation: 3, context: 1, persist: 1 },
            },
          },
        }),
      ],
    });
    const onOpenDraft = vi.fn();
    renderControls({ onOpenDraft });

    expect(await screen.findByText('Passes')).toBeTruthy();
    expect(screen.getByText('Passes').parentElement?.querySelector('dd')?.textContent).toBe('6');
    expect(screen.getByText('LLM calls').parentElement?.querySelector('dd')?.textContent).toBe('4');
    expect(screen.getByText('Duration').parentElement?.querySelector('dd')?.textContent).toBe('1.5 s');
    expect(
      screen.getByText('architecture 1 · section writing 3 · context 1 · persist 1'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Open draft' }));
    expect(onOpenDraft).toHaveBeenCalledWith('c-2');
  });

  it('surfaces a failure with the failed pass and a retry action', async () => {
    wire({
      jobs: [
        job({
          status: 'failed',
          error: { message: 'provider exploded' },
          result: {
            writer_summary: {
              mode: 'deep_write',
              format: 'short_article',
              pass_count: 2,
              llm_calls: 2,
              duration_ms: 10,
              by_kind: { architecture: 1, section_generation: 1 },
              failed_pass: 'section_generation',
            },
          },
        }),
      ],
    });
    renderControls();
    expect(await screen.findByText('provider exploded')).toBeTruthy();
    expect(screen.getByText(/Failed at: section writing/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('never writes to the source article', async () => {
    wire();
    renderControls();
    fireEvent.click(screen.getByRole('button', { name: 'Generate draft' }));
    await waitFor(() => expect(apiMock.api).toHaveBeenCalled());

    const sourceWrites = apiMock.api.mock.calls.filter(([path, options]) => {
      const method = (options as { method?: string } | undefined)?.method;
      return (
        (method === 'PATCH' || method === 'PUT' || method === 'DELETE') &&
        String(path).includes(`/content/${CONTENT}`)
      );
    });
    expect(sourceWrites).toHaveLength(0);
  });

  it('disables generation when the user cannot edit', () => {
    wire();
    renderControls({ canEdit: false });
    expect(screen.getByRole('button', { name: 'Generate draft' })).toHaveProperty('disabled', true);
  });

  it('disables generation and explains when project AI is not configured', () => {
    wire();
    renderControls({ aiConfigured: false });
    expect(screen.getByRole('button', { name: 'Generate draft' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Project AI is not configured. Add a key before generating drafts.')).toBeTruthy();
  });

  it('ignores content_write jobs that belong to another article', async () => {
    wire({
      jobs: [
        job({ id: 'other', params: { source_content_id: 'some-other-article' }, status: 'running' }),
      ],
    });
    renderControls();
    await waitFor(() => expect(apiMock.api).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Generate draft' })).toHaveProperty('disabled', false);
    expect(screen.queryByText('40%')).toBeNull();
  });
});
