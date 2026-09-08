/**
 * WriterPanel behaviour tests (W6 + durable runs W7).
 *
 * These drive the panel through the real API contract shape (start -> proposal
 * -> explicit approve/reject -> writing -> review-ready) with the transport
 * module mocked, and assert the honesty rules: the plan is surfaced as a
 * proposal, nothing auto-approves, nothing auto-saves, rejection stops the run
 * and polling ends at a terminal state. W7 additionally asserts refresh
 * recovery: the panel reloads the bookmarked run for the content instead of
 * silently starting a new one, and a run that no longer exists falls back to
 * the fresh start form.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { asTipDoc, evaluateSeo, tiptapEmptyDoc } from '@seo/contracts';
import type { WriterRunDto, WriterRunPlanDto, WriterRunReviewDto } from '@seo/contracts';
import { WriterPanel } from './WriterPanel';

const { apiMock, ApiRequestError } = vi.hoisted(() => {
  class ApiRequestError extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number,
    ) {
      super(message);
      this.name = 'ApiRequestError';
    }
  }
  return { apiMock: { api: vi.fn() }, ApiRequestError };
});
vi.mock('../../lib/api', () => ({ api: apiMock.api, ApiRequestError }));

const PROJECT = 'p-1';
const CONTENT = 'c-1';
const BOOKMARK_KEY = `seo.writer.run.${PROJECT}.${CONTENT}`;

const PLAN: WriterRunPlanDto = {
  title: 'On-Page SEO Fundamentals',
  metaDescription: 'A grounded guide to ranking signals you control.',
  introductionPurpose: 'Frame what on-page SEO controls and what it does not.',
  sections: [
    {
      heading: 'What on-page SEO controls',
      keyPoints: ['The page itself: copy, structure, metadata.'],
      suggestedKeywords: ['on page seo'],
    },
    {
      heading: 'Ranking factors beyond the page',
      keyPoints: ['Authority and links are not on-page.'],
      suggestedKeywords: [],
    },
  ],
};

const reviewDoc = asTipDoc({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'On-Page SEO Fundamentals' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'This is the review-ready body.' }] },
  ],
});

const REVIEW: WriterRunReviewDto = {
  contentJson: reviewDoc,
  contentHtml: '<h2>On-Page SEO Fundamentals</h2><p>This is the review-ready body.</p>',
  seo: evaluateSeo({
    doc: reviewDoc,
    meta: {
      title: 'On-Page SEO Fundamentals',
      targetKeyword: 'on page seo',
      metaTitle: 'On-Page SEO Fundamentals',
      metaDescription: 'A grounded guide to ranking signals you control.',
    },
  }),
};

function run(over: Partial<WriterRunDto>): WriterRunDto {
  return {
    runId: 'run-1',
    projectId: PROJECT,
    contentId: CONTENT,
    status: 'awaiting_approval',
    plan: PLAN,
    note: null,
    review: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

interface FakeApi {
  current: () => WriterRunDto;
  calls: Array<{ path: string; method?: string; body?: unknown }>;
}

/** Wire the mocked api to a stateful fake driven per test. */
function fakeApi(initial: WriterRunDto, onGet?: () => WriterRunDto | undefined): FakeApi {
  let current = initial;
  const calls: FakeApi['calls'] = [];
  apiMock.api.mockReset();
  apiMock.api.mockImplementation(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    if (method === 'POST' && path.endsWith('/writer')) {
      current = run({ status: 'awaiting_approval' });
      return current;
    }
    if (method === 'POST' && path.endsWith('/approval')) {
      const body = opts.body as { decision: 'approve' | 'reject'; reason?: string } | undefined;
      current =
        body?.decision === 'approve'
          ? run({ status: 'writing' })
          : run({ status: 'rejected', note: body?.reason ?? 'rejected without a reason' });
      return current;
    }
    const next = onGet ? onGet() : undefined;
    if (next) current = next;
    return current;
  });
  return { current: () => current, calls };
}

async function startRun() {
  fireEvent.click(screen.getByRole('button', { name: /start writer run/i }));
  await screen.findByText(PLAN.title);
  expect(screen.getByText(/AI-generated proposal/i)).toBeTruthy();
}

describe('WriterPanel', () => {
  beforeEach(() => {
    window.localStorage.clear();
    apiMock.api.mockReset();
  });

  it('starts with no run and posts the instruction on Start', async () => {
    const fake = fakeApi(run({ status: 'starting', plan: null }));
    render(
      <WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" defaultKeyword="on page seo" />,
    );

    expect(screen.getByRole('button', { name: /start writer run/i })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/instruction \(optional\)/i), {
      target: { value: '  Keep it concise  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start writer run/i }));
    await screen.findByText(/AI-generated proposal/i);

    const startCall = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/writer'));
    expect(startCall).toBeTruthy();
    expect((startCall!.body as { instruction?: string }).instruction).toBe('Keep it concise');
  });

  it('omits the instruction when left empty (content title becomes the topic)', async () => {
    const fake = fakeApi(run({ status: 'starting', plan: null }));
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" />);

    fireEvent.click(screen.getByRole('button', { name: /start writer run/i }));
    await screen.findByText(/AI-generated proposal/i);

    const startCall = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/writer'));
    expect((startCall!.body as { instruction?: string }).instruction).toBeUndefined();
  });

  it('shows the plan as a proposal and only writes after an explicit approve', async () => {
    fakeApi(run({ status: 'starting', plan: null }));
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" />);
    await startRun();

    // The plan is visible but nothing has been approved or written yet.
    expect(screen.getByText(/What on-page SEO controls/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /approve.*write/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^reject/i })).toBeTruthy();
    expect(screen.queryByText(/review-ready/i)).toBeNull();
  });

  it('approves, reports writing honestly and ends at the review-ready result', async () => {
    fakeApi(run({ status: 'starting', plan: null }), () => run({ status: 'completed', review: REVIEW }));
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" pollMs={5} />);
    await startRun();

    fireEvent.click(screen.getByRole('button', { name: /approve.*write/i }));

    // Approve returned "writing": the panel says so and polls to the terminal
    // state instead of claiming a result that does not exist yet.
    const writing = await screen.findByText(/writer is writing/i);
    expect(writing).toBeTruthy();
    expect(screen.queryByText(/review-ready/i)).toBeNull();

    const reviewReady = await screen.findByText(/review-ready draft/i, {}, { timeout: 2000 });
    expect(reviewReady).toBeTruthy();
    // Preview of the canonical result, explicitly not saved.
    expect(screen.getByText(/This is the review-ready body/i)).toBeTruthy();
    expect(screen.getByText(/NOT saved to this document/i)).toBeTruthy();
    expect(screen.getByText(new RegExp(`SEO ${Math.round(REVIEW.seo.score)}/100`))).toBeTruthy();

    // Terminal: the proposal actions and the run's own start/approve affordances are gone.
    expect(screen.queryByRole('button', { name: /approve.*write/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^reject/i })).toBeNull();
    expect(screen.getByText('completed')).toBeTruthy();
  });

  it('rejects with a reason and offers a fresh run without writing anything', async () => {
    fakeApi(run({ status: 'starting', plan: null }));
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" />);
    await startRun();

    fireEvent.change(screen.getByPlaceholderText(/optional reason for rejection/i), {
      target: { value: 'Too shallow' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^reject/i }));

    const banner = await screen.findByText(/Too shallow/i);
    expect(banner).toBeTruthy();
    expect(screen.getByText(/Nothing was written/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /start a new run/i })).toBeTruthy();
    expect(screen.queryByText(/review-ready/i)).toBeNull();
  });

  it('surfaces honest start failures instead of inventing a run', async () => {
    apiMock.api.mockReset();
    apiMock.api.mockRejectedValue(new Error('Writer is not configured for this project'));
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" />);

    fireEvent.click(screen.getByRole('button', { name: /start writer run/i }));
    const err = await screen.findByText(/Writer is not configured for this project/i);
    expect(err).toBeTruthy();
    expect(screen.queryByText(/AI-generated proposal/i)).toBeNull();
  });

  it('keeps the proposal within the panel (no whole-view takeover)', async () => {
    fakeApi(run({ status: 'starting', plan: null }));
    const { container } = render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" />);
    await startRun();

    const panel = container.querySelector('.writer-panel');
    expect(panel).toBeTruthy();
    const scope = within(panel as HTMLElement);
    expect(scope.queryByText(PLAN.title)).toBeTruthy();
    expect(scope.queryByText(/suggested keywords/i)).toBeTruthy();
  });
});

describe('WriterPanel - W7 refresh recovery', () => {
  beforeEach(() => {
    window.localStorage.clear();
    apiMock.api.mockReset();
  });

  it('reloads the bookmarked run after a refresh instead of starting a new one', async () => {
    window.localStorage.setItem(BOOKMARK_KEY, 'run-1');
    const fake = fakeApi(run({ status: 'awaiting_approval' }));
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" />);

    await screen.findByText(/run-1/i);
    expect(screen.getByText(/AI-generated proposal/i)).toBeTruthy();

    const methods = fake.calls.map((c) => c.method ?? 'GET');
    expect(methods.filter((m) => m === 'POST')).toEqual([]);
    const get = fake.calls.find((c) => (c.method ?? 'GET') === 'GET' && c.path.endsWith('/writer/run-1'));
    expect(get).toBeTruthy();
    // A proposal reloaded from storage is still not approved or written.
    expect(screen.getByRole('button', { name: /approve.*write/i })).toBeTruthy();
  });

  it('resumes polling on a reloaded writing run and never starts a duplicate', async () => {
    window.localStorage.setItem(BOOKMARK_KEY, 'run-1');
    // First read reloads the interrupted `writing` run; the following poll read
    // reports the terminal review-ready result.
    let reads = 0;
    const fake = fakeApi(
      run({ status: 'writing' }),
      () =>
        (reads += 1) > 1 ? run({ status: 'completed', review: REVIEW }) : run({ status: 'writing' }),
    );
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" pollMs={5} />);

    const writing = await screen.findByText(/writer is writing/i);
    expect(writing).toBeTruthy();

    const reviewReady = await screen.findByText(/review-ready draft/i, {}, { timeout: 2000 });
    expect(reviewReady).toBeTruthy();

    expect(fake.calls.every((c) => (c.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('starts a run persist its bookmark for a later refresh', async () => {
    fakeApi(run({ status: 'starting', plan: null }));
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" />);

    fireEvent.click(screen.getByRole('button', { name: /start writer run/i }));
    await screen.findByText(/AI-generated proposal/i);
    expect(window.localStorage.getItem(BOOKMARK_KEY)).toBe('run-1');
  });

  it('forgets a run whose bookmark no longer exists (404) and shows the fresh form', async () => {
    window.localStorage.setItem(BOOKMARK_KEY, 'stale-run');
    apiMock.api.mockReset();
    apiMock.api.mockRejectedValue(
      new ApiRequestError('writer_run_not_found', 'No writer run exists for this project/content.', 404),
    );
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" />);

    await screen.findByRole('button', { name: /start writer run/i });
    expect(window.localStorage.getItem(BOOKMARK_KEY)).toBeNull();
    expect(screen.queryByText(/run-1/i)).toBeNull();
  });

  it('clears the bookmark when the user opts to start over', async () => {
    window.localStorage.setItem(BOOKMARK_KEY, 'run-1');
    fakeApi(run({ status: 'rejected', note: 'Not the direction.' }));
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" />);

    await screen.findByText(/not the direction/i);
    fireEvent.click(screen.getByRole('button', { name: /start a new run/i }));
    expect(window.localStorage.getItem(BOOKMARK_KEY)).toBeNull();
    expect(screen.getByRole('button', { name: /start writer run/i })).toBeTruthy();
  });
});
