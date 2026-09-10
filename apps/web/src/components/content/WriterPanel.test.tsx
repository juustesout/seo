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
import type {
  WriterEvidenceDto,
  WriterIntelligenceDto,
  WriterRunDto,
  WriterRunPlanDto,
  WriterRunReviewDto,
  WriterMagicAction,
} from '@seo/contracts';
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
      sectionId: 'section_0',
      heading: 'What on-page SEO controls',
      keyPoints: ['The page itself: copy, structure, metadata.'],
      suggestedKeywords: ['on page seo'],
    },
    {
      sectionId: 'section_1',
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
    revisionCount: 0,
    lastRevisionAt: null,
    magicAction: null,
    evidence: null,
    intelligence: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

interface FakeApi {
  current: () => WriterRunDto;
  setCurrent: (next: WriterRunDto) => void;
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
    if (method === 'POST' && path.endsWith('/revise')) {
      current = run({ status: 'revising' });
      return current;
    }
    if (method === 'POST' && path.endsWith('/magic')) {
      const body = opts.body as { action?: WriterMagicAction } | undefined;
      current = run({ status: 'revising', magicAction: body?.action ?? 'improve' });
      return current;
    }
    const next = onGet ? onGet() : undefined;
    if (next) current = next;
    return current;
  });
  return {
    current: () => current,
    setCurrent: (next: WriterRunDto) => {
      current = next;
    },
    calls,
  };
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

  it('approves, reports writing honestly and rests on the review-ready review session', async () => {
    fakeApi(run({ status: 'starting', plan: null }), () => run({ status: 'review_ready', review: REVIEW }));
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" pollMs={5} />);
    await startRun();

    fireEvent.click(screen.getByRole('button', { name: /approve.*write/i }));

    // Approve returned "writing": the panel says so and polls to the resting
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

    // `review_ready` is the W8 resting hub, not a terminal: the human decides
    // next through the review-session controls. The proposal/approve actions
    // are gone; the revise affordance is present.
    expect(screen.getByText('review_ready')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve.*write/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^reject/i })).toBeNull();
    expect(screen.getByText(/review session/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /revise selected sections/i })).toBeTruthy();
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
    // reports the resting review-ready result.
    let reads = 0;
    const fake = fakeApi(
      run({ status: 'writing' }),
      () =>
        (reads += 1) > 1 ? run({ status: 'review_ready', review: REVIEW }) : run({ status: 'writing' }),
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

describe('WriterPanel - W8 review session', () => {
  beforeEach(() => {
    window.localStorage.clear();
    apiMock.api.mockReset();
  });

  it('revises only the selected sections: posts the exact ids and polls to a fresh review-ready draft', { timeout: 15000 }, async () => {
    window.localStorage.setItem(BOOKMARK_KEY, 'run-1');
    const revisedHtml =
      '<h2>On-Page SEO Fundamentals</h2><p>This is the revised review-ready body.</p>';
    const revisedReview: WriterRunReviewDto = { ...REVIEW, contentHtml: revisedHtml };
    let reviseClicked = false;
    const fake = fakeApi(run({ status: 'review_ready', review: REVIEW }), () =>
      reviseClicked ? run({ status: 'review_ready', review: revisedReview, revisionCount: 1 }) : undefined,
    );
    // Keep a handle on the raw mock so the revise branch can set the flag.
    const original = apiMock.api.getMockImplementation();
    apiMock.api.mockImplementation(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      if ((opts.method ?? 'GET') === 'POST' && path.endsWith('/revise')) reviseClicked = true;
      return original!(path, opts);
    });
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" pollMs={5} />);

    // Restored review_ready run: only the review-session controls are shown.
    await screen.findByText(/review-ready draft/i);
    expect(screen.getByText('review_ready')).toBeTruthy();

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]!);

    fireEvent.change(screen.getByPlaceholderText(/what should change/i), {
      target: { value: 'Make the intro sharper' },
    });
    fireEvent.click(screen.getByRole('button', { name: /revise selected sections/i }));

    // Revise returned "revising": the panel reports it honestly and polls.
    const revising = await screen.findByText(/revising the selected sections/i);
    expect(revising).toBeTruthy();

    const fresh = await screen.findByText(/This is the revised review-ready body/i, {}, { timeout: 2000 });
    expect(fresh).toBeTruthy();
    expect(screen.getByText(/revision 1/i)).toBeTruthy();

    // The exact stable section id was sent; the panel never fabricated a body.
    const reviseCall = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/revise'));
    expect(reviseCall).toBeTruthy();
    expect(reviseCall!.body).toEqual({
      action: 'revise',
      sectionIds: ['section_0'],
      instruction: 'Make the intro sharper',
    });
  });
});

describe('WriterPanel - W10.1 Section Magic', () => {
  beforeEach(() => {
    window.localStorage.clear();
    apiMock.api.mockReset();
  });

  it('applies a magic action to the selected sections only: posts the exact ids + action and reports honest progress', async () => {
    window.localStorage.setItem(BOOKMARK_KEY, 'run-1');
    const expandedHtml =
      '<h2>On-Page SEO Fundamentals</h2><p>This is the expanded review-ready body.</p>';
    const expandedReview: WriterRunReviewDto = { ...REVIEW, contentHtml: expandedHtml };
    let magicApplied = false;
    const fake = fakeApi(run({ status: 'review_ready', review: REVIEW }), () =>
      magicApplied ? run({ status: 'review_ready', review: expandedReview, revisionCount: 1 }) : undefined,
    );
    const original = apiMock.api.getMockImplementation();
    apiMock.api.mockImplementation(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      if ((opts.method ?? 'GET') === 'POST' && path.endsWith('/magic')) magicApplied = true;
      return original!(path, opts);
    });
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" pollMs={5} />);

    await screen.findByText(/review-ready draft/i);
    // Section selection is shared with the revision flow above.
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(2);
    fireEvent.click(checkboxes[0]!);
    expect(screen.getByText(/Will transform:/i)).toBeTruthy();

    // Pick an action and an optional instruction (default action is improve).
    const actionSelect = screen.getAllByRole('combobox')[0]!;
    fireEvent.change(actionSelect, { target: { value: 'expand' } });
    fireEvent.change(screen.getByPlaceholderText(/Optional instruction/i), {
      target: { value: 'Add concrete details' },
    });
    fireEvent.click(screen.getByRole('button', { name: /apply magic to selected sections/i }));

    // The run reported `revising` with the action surfaced; the panel says so
    // honestly and polls to the fresh review-ready proposal.
    const applying = await screen.findByText(/applying Expand/i);
    expect(applying).toBeTruthy();

    const fresh = await screen.findByText(/This is the expanded review-ready body/i, {}, { timeout: 2000 });
    expect(fresh).toBeTruthy();
    expect(screen.getByText(/revision 1/i)).toBeTruthy();

    const magicCall = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/magic'));
    expect(magicCall).toBeTruthy();
    expect(magicCall!.body).toEqual({
      action: 'expand',
      sectionIds: ['section_0'],
      instruction: 'Add concrete details',
    });
    // Nothing was auto-accepted: the run rests on review_ready as a proposal.
    expect(screen.queryByText(/completed/i)).toBeNull();
    expect(screen.getByText(/NOT saved to this document/i)).toBeTruthy();
  });

  it('sends a tone (and never an instruction) for the change_tone action', async () => {
    window.localStorage.setItem(BOOKMARK_KEY, 'run-1');
    let applied = false;
    const fake = fakeApi(run({ status: 'review_ready', review: REVIEW }), () =>
      applied ? run({ status: 'review_ready', review: REVIEW, revisionCount: 1 }) : undefined,
    );
    const original = apiMock.api.getMockImplementation();
    apiMock.api.mockImplementation(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      if ((opts.method ?? 'GET') === 'POST' && path.endsWith('/magic')) applied = true;
      return original!(path, opts);
    });
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" pollMs={5} />);

    await screen.findByText(/review-ready draft/i);
    fireEvent.click(screen.getAllByRole('checkbox')[1]!);

    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'change_tone' } });
    // change_tone hides the free-text instruction and shows a bounded tone picker.
    expect(screen.queryByPlaceholderText(/Optional instruction/i)).toBeNull();
    const toneSelect = screen.getAllByRole('combobox')[1]!;
    fireEvent.change(toneSelect, { target: { value: 'casual' } });
    fireEvent.click(screen.getByRole('button', { name: /apply magic to selected sections/i }));

    await screen.findByText(/applying Change tone/i);

    const magicCall = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/magic'));
    expect(magicCall!.body).toEqual({
      action: 'change_tone',
      sectionIds: ['section_1'],
      tone: 'casual',
    });
  });

  it('requires an instruction for the custom action before it can be applied', async () => {
    window.localStorage.setItem(BOOKMARK_KEY, 'run-1');
    fakeApi(run({ status: 'review_ready', review: REVIEW }));
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" />);

    await screen.findByText(/review-ready draft/i);
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'custom' } });

    const apply = screen.getByRole('button', { name: /apply magic to selected sections/i }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/required for custom/i), {
      target: { value: 'Tighten the argument' },
    });
    expect((screen.getByRole('button', { name: /apply magic to selected sections/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('WriterPanel - W10.2 research & evidence', () => {
  beforeEach(() => {
    window.localStorage.clear();
    apiMock.api.mockReset();
  });

  const EVIDENCE: WriterEvidenceDto = {
    gatheredAt: '2026-01-02T00:00:00.000Z',
    sources: [
      {
        source: 'knowledge',
        status: 'available',
        note: null,
        items: [
          {
            id: 'knowledge:0',
            source: 'knowledge',
            title: 'On-page factors overview',
            text: 'Authority and content relevance drive rankings.',
            url: null,
            retrievedAt: '2026-01-02T00:00:00.000Z',
            trust: 'untrusted',
          },
        ],
      },
      {
        source: 'search',
        status: 'not_configured',
        note: 'No project-scoped search source is configured.',
        items: [],
      },
      { source: 'existing_content', status: 'empty', note: null, items: [] },
      {
        source: 'intelligence',
        status: 'unavailable',
        note: 'DataForSEO signals are not configured for this project.',
        items: [],
      },
    ],
  };

  it('gathers evidence only on the explicit human click and shows it as untrusted research context', async () => {
    window.localStorage.setItem(BOOKMARK_KEY, 'run-1');
    const base = run({ status: 'review_ready', review: REVIEW });
    const fake = fakeApi(base);
    const original = apiMock.api.getMockImplementation();
    apiMock.api.mockImplementation(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      if ((opts.method ?? 'GET') === 'POST' && path.endsWith('/research')) {
        fake.setCurrent(run({ status: 'review_ready', review: REVIEW, evidence: EVIDENCE }));
      }
      return original!(path, opts);
    });
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" pollMs={5} />);

    await screen.findByText(/review-ready draft/i);

    // Before gathering there is no evidence and no magic research note.
    expect(screen.getByRole('button', { name: /gather evidence/i })).toBeTruthy();
    expect(screen.queryByText(/1 item/i)).toBeNull();
    expect(screen.queryByText(/untrusted reference material for these sections/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /gather evidence/i }));

    // The synchronous gather returns the resting review_ready DTO with evidence.
    const item = await screen.findByText(/Authority and content relevance drive rankings/i, {}, { timeout: 2000 });
    expect(item).toBeTruthy();
    expect(screen.getByText('Research context')).toBeTruthy();
    expect(screen.getByText(/1 item/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /gather again/i })).toBeTruthy();
    // Honest per-source statuses surface exactly as reported.
    expect(screen.getByText(/not_configured/i)).toBeTruthy();
    expect(screen.getByText(/unavailable/i)).toBeTruthy();
    expect(screen.getByText(/No project-scoped search source is configured/i)).toBeTruthy();

    // The evidence is offered to a later magic round as untrusted reference
    // material only - never auto-applied, never accepted.
    expect(screen.getByText(/will be offered to the writer as untrusted reference material/i)).toBeTruthy();
    expect(screen.getByText(/NOT saved to this document/i)).toBeTruthy();
    expect(screen.getByText('review_ready')).toBeTruthy();

    const researchCall = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/research'));
    expect(researchCall).toBeTruthy();
    expect(researchCall!.body).toEqual({});
  });

  it('reports a gathered-but-empty research result honestly (no fabricated fallback)', async () => {
    window.localStorage.setItem(BOOKMARK_KEY, 'run-1');
    const EMPTY: WriterEvidenceDto = {
      gatheredAt: '2026-01-02T00:00:00.000Z',
      sources: [
        { source: 'knowledge', status: 'empty', note: null, items: [] },
        { source: 'search', status: 'not_configured', note: null, items: [] },
        { source: 'existing_content', status: 'empty', note: null, items: [] },
        { source: 'intelligence', status: 'unavailable', note: null, items: [] },
      ],
    };
    const base = run({ status: 'review_ready', review: REVIEW });
    const fake = fakeApi(base);
    const original = apiMock.api.getMockImplementation();
    apiMock.api.mockImplementation(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      if ((opts.method ?? 'GET') === 'POST' && path.endsWith('/research')) {
        fake.setCurrent(run({ status: 'review_ready', review: REVIEW, evidence: EMPTY }));
      }
      return original!(path, opts);
    });
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" pollMs={5} />);

    await screen.findByText(/review-ready draft/i);
    fireEvent.click(screen.getByRole('button', { name: /gather evidence/i }));

    await screen.findByText(/0 items/i, {}, { timeout: 2000 });
    expect(screen.getAllByText(/No items gathered from this source/i)).toHaveLength(4);
    // With no usable items the magic note stays off: nothing to offer.
    expect(screen.queryByText(/will be offered to the writer as untrusted reference material/i)).toBeNull();
  });
});

describe('WriterPanel - W10.3 combined intelligence', () => {
  beforeEach(() => {
    window.localStorage.clear();
    apiMock.api.mockReset();
  });

  const INTELLIGENCE: WriterIntelligenceDto = {
    gatheredAt: '2026-01-03T00:00:00.000Z',
    status: 'partial',
    findings: [
      { id: 'keyword:0', type: 'keyword', summary: 'langgraph volume:1200', evidenceIds: ['langgraph'], trust: 'untrusted' },
    ],
    sources: [
      { source: 'knowledge', status: 'available', note: null, findingCount: 1 },
      { source: 'existing_content', status: 'empty', note: null, findingCount: 0 },
      { source: 'dataforseo', status: 'not_configured', note: null, findingCount: 0 },
      { source: 'gsc', status: 'unavailable', note: null, findingCount: 0 },
      { source: 'content_intelligence', status: 'not_configured', note: null, findingCount: 0 },
    ],
    note: 'Intelligence gathered from some sources; other sources were empty or unavailable.',
  };

  it('gathers intelligence only on the explicit human click and shows findings as untrusted reference material', async () => {
    window.localStorage.setItem(BOOKMARK_KEY, 'run-1');
    const base = run({ status: 'review_ready', review: REVIEW });
    const fake = fakeApi(base);
    const original = apiMock.api.getMockImplementation();
    apiMock.api.mockImplementation(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      if ((opts.method ?? 'GET') === 'POST' && path.endsWith('/intelligence')) {
        fake.setCurrent(run({ status: 'review_ready', review: REVIEW, intelligence: INTELLIGENCE }));
      }
      return original!(path, opts);
    });
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" pollMs={5} />);

    await screen.findByText(/review-ready draft/i);

    // The intelligence controls are inert until the human opens them.
    fireEvent.click(screen.getByRole('button', { name: /deep research/i }));
    expect(screen.getByRole('button', { name: /gather intelligence/i })).toBeTruthy();
    expect(screen.queryByText(/1 finding/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /gather intelligence/i }));

    const summary = await screen.findByText(/langgraph volume:1200/i, {}, { timeout: 2000 });
    expect(summary).toBeTruthy();
    expect(screen.getByText('Intelligence')).toBeTruthy();
    expect(screen.getAllByText(/1 finding/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/untrusted reference/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/partial/)).toBeTruthy();
    expect(screen.getAllByText(/not_configured/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/unavailable/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /gather again/i })).toBeTruthy();
    // The draft is still only previewed: gathering intelligence never saves it.
    expect(screen.getByText(/NOT saved to this document/i)).toBeTruthy();

    const call = fake.calls.find((c) => c.method === 'POST' && c.path.endsWith('/intelligence'));
    expect(call).toBeTruthy();
    expect(call!.body).toEqual({ purpose: 'deep_research' });
  });

  it('reports a gathered-but-empty intelligence result honestly (no fabricated fallback)', async () => {
    window.localStorage.setItem(BOOKMARK_KEY, 'run-1');
    const EMPTY: WriterIntelligenceDto = {
      gatheredAt: '2026-01-03T00:00:00.000Z',
      status: 'not_configured',
      findings: [],
      sources: [
        { source: 'knowledge', status: 'not_configured', note: null, findingCount: 0 },
        { source: 'existing_content', status: 'not_configured', note: null, findingCount: 0 },
        { source: 'dataforseo', status: 'not_configured', note: null, findingCount: 0 },
        { source: 'gsc', status: 'not_configured', note: null, findingCount: 0 },
        { source: 'content_intelligence', status: 'not_configured', note: null, findingCount: 0 },
      ],
      note: 'No intelligence sources are configured for this project yet.',
    };
    const base = run({ status: 'review_ready', review: REVIEW });
    const fake = fakeApi(base);
    const original = apiMock.api.getMockImplementation();
    apiMock.api.mockImplementation(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      if ((opts.method ?? 'GET') === 'POST' && path.endsWith('/intelligence')) {
        fake.setCurrent(run({ status: 'review_ready', review: REVIEW, intelligence: EMPTY }));
      }
      return original!(path, opts);
    });
    render(<WriterPanel projectId={PROJECT} contentId={CONTENT} defaultTopic="On-Page SEO" pollMs={5} />);

    await screen.findByText(/review-ready draft/i);
    fireEvent.click(screen.getByRole('button', { name: /deep research/i }));
    fireEvent.click(screen.getByRole('button', { name: /gather intelligence/i }));

    await screen.findAllByText(/0 findings/i, {}, { timeout: 2000 });
    expect(screen.getAllByText(/No findings gathered from this source/i)).toHaveLength(5);
    expect(screen.getByText(/No intelligence sources are configured for this project yet/i)).toBeTruthy();
  });
});
