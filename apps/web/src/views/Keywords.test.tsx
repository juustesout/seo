/**
 * Keywords view tests (KW1 + KW2 web).
 *
 * Two separated surfaces are covered:
 *   - Research (DataForSEO): idle, viewer gating, submit + running, results,
 *     not-configured and honest failure states.
 *   - My keywords (Search Console): the four honest read states from KW1.
 *
 * The API module is mocked; the shared `useAsync` hook runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CompetitorResearchRunDto, KeywordExpansionRunDto, KeywordResearchRunDto, ProjectKeywordsDto } from '@seo/contracts';
import { Keywords } from './Keywords';

const { apiMock, ApiRequestErrorMock } = vi.hoisted(() => {
  class ApiRequestErrorMock extends Error {
    constructor(
      public code: string,
      message: string,
      public status: number,
    ) {
      super(message);
      this.name = 'ApiRequestError';
    }
  }
  return { apiMock: { api: vi.fn() }, ApiRequestErrorMock };
});
vi.mock('../lib/api', () => ({ api: apiMock.api, ApiRequestError: ApiRequestErrorMock }));

const PROJECT = 'p-1';

const EMPTY_GSC: ProjectKeywordsDto = { propertyId: null, lastSyncedAt: null, keywords: [] };

beforeEach(() => {
  apiMock.api.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Keywords view - GSC read states', () => {
  it('shows a loading state while the request is in flight', () => {
    apiMock.api.mockReturnValue(new Promise<ProjectKeywordsDto>(() => {}));
    render(<Keywords projectId={PROJECT} role="viewer" />);
    expect(screen.getByText('Loading keywords…')).toBeTruthy();
  });

  it('renders the aggregated query table', async () => {
    apiMock.api.mockResolvedValue({
      propertyId: 'prop-1',
      lastSyncedAt: '2026-09-12T08:00:00.000Z',
      keywords: [{ keyword: 'seo tools', clicks: 1200, impressions: 40000, ctr: 0.03, position: 4.25 }],
    } satisfies ProjectKeywordsDto);

    render(<Keywords projectId={PROJECT} role="viewer" />);

    expect(await screen.findByText('seo tools')).toBeTruthy();
    expect(screen.getByText('1,200')).toBeTruthy();
    expect(screen.getByText('40,000')).toBeTruthy();
    expect(screen.getByText('3.00%')).toBeTruthy();
    expect(screen.getByText('4.3')).toBeTruthy();
    expect(apiMock.api).toHaveBeenCalledWith(`/projects/${PROJECT}/gsc/keywords`);
  });

  it('prompts to connect Search Console when no property is linked', async () => {
    apiMock.api.mockResolvedValue(EMPTY_GSC);
    render(<Keywords projectId={PROJECT} role="viewer" />);
    expect(await screen.findByText('Google Search Console is not connected to this project.')).toBeTruthy();
  });

  it('prompts to run a sync when a property is linked but has no data', async () => {
    apiMock.api.mockResolvedValue({ propertyId: 'prop-1', lastSyncedAt: null, keywords: [] } satisfies ProjectKeywordsDto);
    render(<Keywords projectId={PROJECT} role="viewer" />);
    expect(
      await screen.findByText('No keyword data is available yet. Run a Google Search Console sync first.'),
    ).toBeTruthy();
  });

  it('shows a generic message on failure without leaking the raw error', async () => {
    apiMock.api.mockRejectedValue(new Error('boom: raw database secret'));
    render(<Keywords projectId={PROJECT} role="viewer" />);
    expect(await screen.findByText('Could not load keyword data. Please try again.')).toBeTruthy();
    expect(screen.queryByText(/raw database secret/)).toBeNull();
  });
});

describe('Keywords view - Research (KW2)', () => {
  function mockResearch(handlers: {
    gsc?: ProjectKeywordsDto;
    post?: () => Promise<unknown>;
    get?: () => Promise<KeywordResearchRunDto>;
  }) {
    apiMock.api.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path.endsWith('/gsc/keywords')) return handlers.gsc ?? EMPTY_GSC;
      if (path.endsWith('/keyword/research') && opts?.method === 'POST') {
        return handlers.post ? handlers.post() : Promise.reject(new Error('no post handler'));
      }
      if (path.includes('/keyword/research/')) {
        if (!handlers.get) throw new Error('no get handler');
        return handlers.get();
      }
      throw new Error(`unexpected ${path}`);
    });
  }

  const STARTED = { jobId: 'run-1', status: 'queued' as const, seed: 'seo tools' };

  function run(overrides: Partial<KeywordResearchRunDto> = {}): KeywordResearchRunDto {
    return {
      jobId: 'run-1',
      seed: 'seo tools',
      status: 'completed',
      results: 0,
      keywords: [],
      error: null,
      createdAt: '2026-09-13T10:00:00.000Z',
      completedAt: '2026-09-13T10:00:10.000Z',
      ...overrides,
    };
  }

  it('shows the idle prompt and does not start anything', async () => {
    mockResearch({});
    render(<Keywords projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Research' }));
    expect(await screen.findByText('Enter a keyword to research.')).toBeTruthy();
  });

  it('blocks viewers from starting research', async () => {
    mockResearch({});
    render(<Keywords projectId={PROJECT} role="viewer" />);
    fireEvent.click(screen.getByRole('button', { name: 'Research' }));
    expect(await screen.findByText('Only editors and above can start keyword research.')).toBeTruthy();
    expect((screen.getByLabelText('Seed keyword') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Start research' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('validates an empty seed before calling the API', async () => {
    mockResearch({});
    render(<Keywords projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Research' }));
    fireEvent.change(screen.getByLabelText('Seed keyword'), { target: { value: '   ' } });
    const button = screen.getByRole('button', { name: 'Start research' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('submits a trimmed seed, then shows the running state', async () => {
    let posted: Record<string, unknown> | null = null;
    apiMock.api.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      if (path.endsWith('/gsc/keywords')) return EMPTY_GSC;
      if (path.endsWith('/keyword/research') && opts?.method === 'POST') {
        posted = opts.body as Record<string, unknown>;
        return STARTED;
      }
      if (path.includes('/keyword/research/')) return run({ status: 'running', completedAt: null });
      throw new Error(`unexpected ${path}`);
    });

    render(<Keywords projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Research' }));
    fireEvent.change(screen.getByLabelText('Seed keyword'), { target: { value: '  seo tools  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start research' }));

    expect(await screen.findByText('Researching keywords…')).toBeTruthy();
    expect(posted).toEqual({ seed: 'seo tools' });
  });

  it('renders the run results once completed', async () => {
    mockResearch({
      post: async () => STARTED,
      get: async () =>
        run({
          results: 2,
          keywords: [
            { keyword: 'seo software', searchVolume: 1200, difficulty: 40, cpc: 2.5 },
            { keyword: 'seo tools', searchVolume: null, difficulty: null, cpc: null },
          ],
        }),
    });

    render(<Keywords projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Research' }));
    fireEvent.change(screen.getByLabelText('Seed keyword'), { target: { value: 'seo tools' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start research' }));

    expect(await screen.findByText('seo software')).toBeTruthy();
    expect(await screen.findByText('1,200')).toBeTruthy();
    expect(screen.getByText('$2.50')).toBeTruthy();
    expect(screen.getByText(/2 results/)).toBeTruthy();
  });

  it('maps a not-configured server error to an honest message', async () => {
    mockResearch({
      post: async () => {
        throw new ApiRequestErrorMock('not_configured', 'No dataforseo provider is registered', 503);
      },
    });

    render(<Keywords projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Research' }));
    fireEvent.change(screen.getByLabelText('Seed keyword'), { target: { value: 'seo tools' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start research' }));

    expect(await screen.findByText('Keyword research is not configured.')).toBeTruthy();
  });

  it('shows an honest failure without leaking provider internals', async () => {
    mockResearch({
      post: async () => STARTED,
      get: async () => run({ status: 'failed', completedAt: '2026-09-13T10:00:10.000Z', error: 'Keyword research failed. Please try again.' }),
    });

    render(<Keywords projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Research' }));
    fireEvent.change(screen.getByLabelText('Seed keyword'), { target: { value: 'seo tools' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start research' }));

    expect(await screen.findByText('Keyword research failed. Please try again.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/api\.dataforseo\.com/)).toBeNull());
  });
});

describe('Keywords view - Competitors (KW3)', () => {
  const DISCOVER_JOB = 'disc-1';
  const GAP_JOB = 'gap-1';

  function discoveryRun(overrides: Partial<CompetitorResearchRunDto> = {}): CompetitorResearchRunDto {
    return {
      jobId: DISCOVER_JOB,
      mode: 'discover',
      status: 'completed',
      domain: 'example.com',
      candidates: [],
      selectedCompetitors: [],
      gaps: [],
      count: 0,
      error: null,
      createdAt: '2026-09-13T10:00:00.000Z',
      completedAt: '2026-09-13T10:00:10.000Z',
      ...overrides,
    };
  }

  function gapRun(overrides: Partial<CompetitorResearchRunDto> = {}): CompetitorResearchRunDto {
    return {
      jobId: GAP_JOB,
      mode: 'gap',
      status: 'completed',
      domain: 'example.com',
      candidates: [],
      selectedCompetitors: ['rival.com'],
      gaps: [],
      count: 0,
      error: null,
      createdAt: '2026-09-13T10:00:00.000Z',
      completedAt: '2026-09-13T10:00:10.000Z',
      ...overrides,
    };
  }

  function renderCompetitors(role = 'editor') {
    render(<Keywords projectId={PROJECT} role={role} />);
    fireEvent.click(screen.getByRole('button', { name: 'Competitors' }));
  }

  it('blocks viewers from running competitor research', async () => {
    apiMock.api.mockResolvedValue(EMPTY_GSC);
    renderCompetitors('viewer');
    expect(await screen.findByText('Only editors and above can run competitor research.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Find competitors' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('discovers candidates, then shows the selected gap keywords', async () => {
    apiMock.api.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      if (path.endsWith('/gsc/keywords')) return EMPTY_GSC;
      if (path.endsWith('/keyword/competitors') && opts?.method === 'POST') {
        return { jobId: DISCOVER_JOB, status: 'queued', mode: 'discover', domain: 'example.com' };
      }
      if (path.endsWith('/keyword/competitor-gap') && opts?.method === 'POST') {
        return { jobId: GAP_JOB, status: 'queued', mode: 'gap', domain: 'example.com', competitors: ['rival.com'] };
      }
      if (path.includes(`/keyword/competitors/${DISCOVER_JOB}`)) {
        return discoveryRun({
          candidates: [
            { domain: 'rival.com', sharedKeywords: 1842, keywordsCount: 5200, avgPosition: 12.4, etv: 900 },
          ],
          count: 1,
        });
      }
      if (path.includes(`/keyword/competitors/${GAP_JOB}`)) {
        return gapRun({
          gaps: [
            { keyword: 'blue widgets', searchVolume: 2400, difficulty: 42, cpc: 1.2, competitorDomain: 'rival.com', position: 4 },
          ],
          count: 1,
        });
      }
      throw new Error(`unexpected ${path}`);
    });

    renderCompetitors();
    fireEvent.click(screen.getByRole('button', { name: 'Find competitors' }));

    expect(await screen.findByText('rival.com')).toBeTruthy();
    expect(screen.getByText('1,842')).toBeTruthy();
    expect(screen.getByText(/Your domain:/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Select rival.com'));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze keyword gaps' }));

    expect(await screen.findByText('blue widgets')).toBeTruthy();
    expect(screen.getByText('2,400')).toBeTruthy();
  });

  it('shows the honest server message when the project has no domain', async () => {
    apiMock.api.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path.endsWith('/gsc/keywords')) return EMPTY_GSC;
      if (path.endsWith('/keyword/competitors') && opts?.method === 'POST') {
        throw new ApiRequestErrorMock('bad_request', 'Add a domain to this project before finding competitors', 400);
      }
      throw new Error(`unexpected ${path}`);
    });

    renderCompetitors();
    fireEvent.click(screen.getByRole('button', { name: 'Find competitors' }));

    expect(
      await screen.findByText('Add a domain to this project before finding competitors'),
    ).toBeTruthy();
  });

  it('maps a not-configured server error to an honest message', async () => {
    apiMock.api.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path.endsWith('/gsc/keywords')) return EMPTY_GSC;
      if (path.endsWith('/keyword/competitors') && opts?.method === 'POST') {
        throw new ApiRequestErrorMock('not_configured', 'No dataforseo provider is registered', 503);
      }
      throw new Error(`unexpected ${path}`);
    });

    renderCompetitors();
    fireEvent.click(screen.getByRole('button', { name: 'Find competitors' }));

    expect(await screen.findByText('Competitor research is not configured.')).toBeTruthy();
  });
});

describe('Keywords view - Expand (KW4)', () => {
  const JOB = 'exp-1';

  function expansionRun(overrides: Partial<KeywordExpansionRunDto> = {}): KeywordExpansionRunDto {
    return {
      jobId: JOB,
      status: 'completed',
      seeds: ['seo tools'],
      methods: ['suggestions'],
      methodStatus: { suggestions: { status: 'success', count: 1 } },
      candidates: [
        {
          keyword: 'seo software',
          searchVolume: 1200,
          difficulty: 40,
          cpc: 2.5,
          competition: 'HIGH',
          intent: 'commercial',
          methods: ['suggestions'],
          seeds: ['seo tools'],
        },
      ],
      count: 1,
      error: null,
      createdAt: '2026-09-13T10:00:00.000Z',
      completedAt: '2026-09-13T10:00:10.000Z',
      ...overrides,
    };
  }

  function renderExpand(role = 'editor') {
    render(<Keywords projectId={PROJECT} role={role} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
  }

  it('blocks viewers from running keyword expansion', async () => {
    apiMock.api.mockResolvedValue(EMPTY_GSC);
    renderExpand('viewer');
    expect(await screen.findByText('Only editors and above can run keyword expansion.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start expansion' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('runs an expansion, shows partial method status, and saves a selected keyword', async () => {
    let savedBody: Record<string, unknown> | null = null;
    apiMock.api.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      if (path.endsWith('/gsc/keywords')) return EMPTY_GSC;
      if (path.endsWith('/keyword/expansion') && opts?.method === 'POST') {
        return { jobId: JOB, status: 'queued', seeds: ['seo tools'], methods: ['suggestions', 'related'] };
      }
      if (path.endsWith(`/keyword/expansion/${JOB}/save`) && opts?.method === 'POST') {
        savedBody = opts.body as Record<string, unknown>;
        return { saved: 1, skipped: 0 };
      }
      if (path.includes(`/keyword/expansion/${JOB}`)) {
        return expansionRun({
          methods: ['suggestions', 'related'],
          methodStatus: { suggestions: { status: 'success', count: 1 }, related: { status: 'failed', count: 0 } },
        });
      }
      throw new Error(`unexpected ${path}`);
    });

    renderExpand();
    fireEvent.change(screen.getByLabelText('Seed keywords'), { target: { value: 'seo tools' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start expansion' }));

    expect(await screen.findByText('seo software')).toBeTruthy();
    expect(screen.getByText('Related: failed')).toBeTruthy();
    expect(screen.getByText('1,200')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Select seo software'));
    fireEvent.click(screen.getByRole('button', { name: 'Save selected' }));

    await waitFor(() => expect(savedBody).toEqual({ keywords: ['seo software'] }));
    expect(await screen.findByText(/Saved 1 keyword/)).toBeTruthy();
  });

  it('maps a not-configured server error to an honest message', async () => {
    apiMock.api.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path.endsWith('/gsc/keywords')) return EMPTY_GSC;
      if (path.endsWith('/keyword/expansion') && opts?.method === 'POST') {
        throw new ApiRequestErrorMock('not_configured', 'No dataforseo provider is registered', 503);
      }
      throw new Error(`unexpected ${path}`);
    });

    renderExpand();
    fireEvent.change(screen.getByLabelText('Seed keywords'), { target: { value: 'seo tools' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start expansion' }));

    expect(await screen.findByText('Keyword expansion is not configured.')).toBeTruthy();
  });
});
