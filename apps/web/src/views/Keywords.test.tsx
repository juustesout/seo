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
import type {
  CompetitorResearchRunDto,
  KeywordExpansionRunDto,
  KeywordResearchRunDto,
  OpportunitiesDto,
  ProjectKeywordsDto,
  SourceSnapshotDto,
  TopicRecommendationDto,
  TopicRecommendationsDto,
} from '@seo/contracts';
import { Keywords } from './Keywords';

const { apiMock, ApiRequestErrorMock, jobsState } = vi.hoisted(() => {
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
  return { apiMock: { api: vi.fn() }, ApiRequestErrorMock, jobsState: { payload: [] as unknown[] } };
});
vi.mock('../lib/api', () => ({
  api: (path: string, ...rest: unknown[]) =>
    String(path).includes('/jobs') ? Promise.resolve(jobsState.payload) : (apiMock.api as (...a: unknown[]) => unknown)(path, ...rest),
  ApiRequestError: ApiRequestErrorMock,
}));

const PROJECT = 'p-1';

const EMPTY_GSC: ProjectKeywordsDto = { propertyId: null, lastSyncedAt: null, keywords: [] };

beforeEach(() => {
  apiMock.api.mockReset();
  jobsState.payload = [];
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
    apiMock.api.mockImplementation(async (path: string) => {
      if (path.endsWith('/gsc/keywords')) return EMPTY_GSC;
      if (path.endsWith('/keyword/competitors/snapshot')) return null;
      throw new Error(`unexpected ${path}`);
    });
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

  it('collapses the candidate list to the active set and re-opens it on demand', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      if (path.endsWith('/gsc/keywords')) return EMPTY_GSC;
      if (path.endsWith('/keyword/competitors/snapshot')) {
        return {
          id: 'dsnap-1',
          type: 'competitor_discovery',
          scope: { domain: 'example.com' },
          candidates: [
            { domain: 'rival.com', sharedKeywords: 1842, keywordsCount: 5200, avgPosition: 12.4, etv: 900 },
          ],
          gaps: [],
          count: 1,
          fetchedAt: '2026-09-13T00:00:00.000Z',
          sourceJobId: 'job-1',
          freshness: { state: 'fresh', fetched_at: '2026-09-13T00:00:00.000Z', age_ms: 3_600_000 },
        };
      }
      throw new Error(`unexpected ${path}`);
    });

    renderCompetitors();
    fireEvent.click(await screen.findByLabelText('Select rival.com'));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(await screen.findByText('Analyzing:')).toBeTruthy();
    expect(screen.queryByLabelText('Select rival.com')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Change competitors' }));
    expect(await screen.findByLabelText('Select rival.com')).toBeTruthy();
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

describe('Keywords view - Opportunities (KW5/KW5.1)', () => {
  function opportunities(overrides: Partial<OpportunitiesDto> = {}): OpportunitiesDto {
    return {
      snapshot: {
        id: 'snap-1',
        fetchedAt: '2026-09-13T00:00:00.000Z',
        sourceJobId: 'job-1',
        freshness: { state: 'fresh', fetched_at: '2026-09-13T00:00:00.000Z', age_ms: 3_600_000 },
        domain: 'example.com',
        competitors: ['rival.com'],
      },
      opportunities: [
        {
          keyword: 'seo tools',
          variants: ['seo tools', 'seo-tools'],
          searchVolume: 1200,
          difficulty: 30,
          cpc: 2.5,
          competition: 'HIGH',
          intent: 'commercial',
          competitors: [
            { domain: 'rival.com', rank: 2 },
            { domain: 'other.com', rank: null },
          ],
          competitorCount: 2,
          score: 78,
          reasons: ['high_volume', 'low_difficulty'],
        },
      ],
      total: 1,
      count: 1,
      ...overrides,
    };
  }

  function discoverySnapshot(): SourceSnapshotDto {
    return {
      id: 'dsnap-1',
      type: 'competitor_discovery',
      scope: { domain: 'example.com' },
      candidates: [
        { domain: 'rival.com', sharedKeywords: 1842, keywordsCount: 5200, avgPosition: 12.4, etv: 900 },
        { domain: 'other.com', sharedKeywords: 1200, keywordsCount: 4200, avgPosition: 15.1, etv: 700 },
      ],
      gaps: [],
      count: 2,
      fetchedAt: '2026-09-13T00:00:00.000Z',
      sourceJobId: 'job-1',
      freshness: { state: 'fresh', fetched_at: '2026-09-13T00:00:00.000Z', age_ms: 3_600_000 },
    };
  }

  function mockApi(opps: (path: string) => unknown) {
    apiMock.api.mockImplementation(async (path: string) => {
      if (path.endsWith('/gsc/keywords')) return EMPTY_GSC;
      if (path.endsWith('/keyword/competitors/snapshot')) return discoverySnapshot();
      if (path.includes('/keyword/opportunities')) return opps(path);
      throw new Error(`unexpected ${path}`);
    });
  }

  async function selectCompetitors(domains: string[], role = 'viewer') {
    render(<Keywords projectId={PROJECT} role={role} />);
    fireEvent.click(screen.getByRole('button', { name: 'Competitors' }));
    for (const d of domains) {
      fireEvent.click(await screen.findByLabelText(`Select ${d}`));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Opportunities' }));
  }

  it('prompts to select competitors before reading any snapshot', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      if (path.endsWith('/gsc/keywords')) return EMPTY_GSC;
      if (path.includes('/keyword/opportunities')) return { snapshot: null, opportunities: [], total: 0, count: 0 };
      throw new Error(`unexpected ${path}`);
    });

    render(<Keywords projectId={PROJECT} role="viewer" />);
    fireEvent.click(screen.getByRole('button', { name: 'Opportunities' }));

    expect(await screen.findByText(/Select competitors to see their opportunities/)).toBeTruthy();
    expect(apiMock.api).not.toHaveBeenCalledWith(expect.stringContaining('/keyword/opportunities'));
  });

  it('reads the exact active set and prompts to run a gap analysis when it has no snapshot', async () => {
    mockApi(() => ({ snapshot: null, opportunities: [], total: 0, count: 0 }));

    await selectCompetitors(['rival.com']);

    expect(await screen.findByText(/No competitor gap data available yet for this competitor set/)).toBeTruthy();
    expect(apiMock.api).toHaveBeenCalledWith(
      expect.stringContaining(`/projects/${PROJECT}/keyword/opportunities?competitors=rival.com`),
    );
    expect(apiMock.api).toHaveBeenCalledWith(expect.stringContaining('sort=score&dir=desc'));
  });

  it('renders consolidated opportunities with metrics and explainable reasons', async () => {
    mockApi(() => opportunities());

    await selectCompetitors(['rival.com']);

    expect(await screen.findByText('seo tools')).toBeTruthy();
    expect(screen.getByText('1,200')).toBeTruthy();
    expect(screen.getByText('$2.50')).toBeTruthy();
    expect(screen.getByText('78')).toBeTruthy();
    expect(screen.getByText('High volume · Low difficulty')).toBeTruthy();
    expect(screen.getByText(/Showing 1 of 1 opportunities/)).toBeTruthy();
  });

  it('passes result filters through the request and renders an empty result', async () => {
    mockApi((path) =>
      path.includes('minVolume=500') ? { snapshot: opportunities().snapshot, opportunities: [], total: 3, count: 0 } : opportunities(),
    );

    await selectCompetitors(['rival.com']);
    await screen.findByText('seo tools');

    fireEvent.change(screen.getByLabelText('Minimum volume'), { target: { value: '500' } });

    await waitFor(() => expect(apiMock.api).toHaveBeenCalledWith(expect.stringContaining('minVolume=500')));
    expect(await screen.findByText('No opportunities match these filters.')).toBeTruthy();
  });

  it('reveals the long list in bounded steps', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      keyword: `kw-${i}`,
      variants: [`kw-${i}`],
      searchVolume: 100 + i,
      difficulty: 20,
      cpc: 1,
      competition: 'HIGH',
      intent: null,
      competitors: [{ domain: 'rival.com', rank: 3 }],
      competitorCount: 1,
      score: 100 - i,
      reasons: ['high_volume' as const],
    }));
    mockApi(() => ({ snapshot: opportunities().snapshot, opportunities: rows, total: 40, count: 40 }));

    await selectCompetitors(['rival.com']);

    expect(await screen.findByText('kw-0')).toBeTruthy();
    expect(screen.getByText('kw-24')).toBeTruthy();
    expect(screen.queryByText('kw-25')).toBeNull();
    expect(screen.getByText(/Showing 25 of 40 opportunities/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('kw-25')).toBeTruthy();
    expect(screen.getByText(/Showing 40 of 40 opportunities/)).toBeTruthy();
  });

  it('flags a stale snapshot and shows a generic error without leaking internals', async () => {
    mockApi(() =>
      opportunities({
        snapshot: {
          id: 'snap-1',
          fetchedAt: '2026-08-01T00:00:00.000Z',
          sourceJobId: null,
          freshness: { state: 'stale', fetched_at: '2026-08-01T00:00:00.000Z', age_ms: 86_400_000 * 45 },
          domain: 'example.com',
          competitors: ['rival.com'],
        },
      }),
    );

    await selectCompetitors(['rival.com']);
    expect(await screen.findByText(/may be outdated/)).toBeTruthy();
  });

  it('shows a generic load error without leaking the raw message', async () => {
    mockApi(() => {
      throw new Error('boom: raw database secret');
    });

    await selectCompetitors(['rival.com']);

    expect(await screen.findByText('Could not load opportunities. Please try again.')).toBeTruthy();
    expect(screen.queryByText(/raw database secret/)).toBeNull();
  });

  it('links the empty state to the Competitors tab', async () => {
    mockApi(() => ({ snapshot: null, opportunities: [], total: 0, count: 0 }));

    await selectCompetitors(['rival.com']);
    fireEvent.click(await screen.findByRole('button', { name: 'Go to Competitors' }));

    expect(await screen.findByRole('button', { name: 'Find competitors' })).toBeTruthy();
  });
});

describe('Keywords view - Compare (KW5.1)', () => {
  function compareData(): OpportunitiesDto {
    return {
      snapshot: {
        id: 'snap-1',
        fetchedAt: '2026-09-13T00:00:00.000Z',
        sourceJobId: 'job-1',
        freshness: { state: 'fresh', fetched_at: '2026-09-13T00:00:00.000Z', age_ms: 3_600_000 },
        domain: 'example.com',
        competitors: ['other.com', 'rival.com'],
      },
      opportunities: [
        {
          keyword: 'seo tools',
          variants: ['seo tools'],
          searchVolume: 1200,
          difficulty: 30,
          cpc: 2.5,
          competition: 'HIGH',
          intent: 'commercial',
          competitors: [
            { domain: 'rival.com', rank: 2 },
            { domain: 'other.com', rank: null },
          ],
          competitorCount: 2,
          score: 78,
          reasons: ['high_volume'],
        },
      ],
      total: 1,
      count: 1,
    };
  }

  function discoverySnapshot(): SourceSnapshotDto {
    return {
      id: 'dsnap-1',
      type: 'competitor_discovery',
      scope: { domain: 'example.com' },
      candidates: [
        { domain: 'rival.com', sharedKeywords: 1842, keywordsCount: 5200, avgPosition: 12.4, etv: 900 },
        { domain: 'other.com', sharedKeywords: 1200, keywordsCount: 4200, avgPosition: 15.1, etv: 700 },
      ],
      gaps: [],
      count: 2,
      fetchedAt: '2026-09-13T00:00:00.000Z',
      sourceJobId: 'job-1',
      freshness: { state: 'fresh', fetched_at: '2026-09-13T00:00:00.000Z', age_ms: 3_600_000 },
    };
  }

  async function selectAndCompare() {
    apiMock.api.mockImplementation(async (path: string) => {
      if (path.endsWith('/gsc/keywords')) return EMPTY_GSC;
      if (path.endsWith('/keyword/competitors/snapshot')) return discoverySnapshot();
      if (path.includes('/keyword/opportunities')) return compareData();
      throw new Error(`unexpected ${path}`);
    });
    render(<Keywords projectId={PROJECT} role="viewer" />);
    fireEvent.click(screen.getByRole('button', { name: 'Competitors' }));
    fireEvent.click(await screen.findByLabelText('Select rival.com'));
    fireEvent.click(screen.getByLabelText('Select other.com'));
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
  }

  it('asks for a selection before comparing', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      if (path.endsWith('/gsc/keywords')) return EMPTY_GSC;
      if (path.endsWith('/keyword/competitors/snapshot')) return null;
      throw new Error(`unexpected ${path}`);
    });
    render(<Keywords projectId={PROJECT} role="viewer" />);
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(await screen.findByText(/Select competitors to compare/)).toBeTruthy();
  });

  it('renders a per-competitor rank matrix and uses a dash for missing evidence', async () => {
    await selectAndCompare();

    expect(await screen.findByText('seo tools')).toBeTruthy();
    expect(screen.getAllByText('rival.com').length).toBeGreaterThan(0);
    expect(screen.getAllByText('other.com').length).toBeGreaterThan(0);
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
    expect(apiMock.api).toHaveBeenCalledWith(expect.stringContaining('competitors=rival.com%2Cother.com'));
  });
});

describe('Keywords view - Topics (KW6)', () => {
  function discoverySnapshot(): SourceSnapshotDto {
    return {
      id: 'dsnap-1',
      type: 'competitor_discovery',
      scope: { domain: 'example.com' },
      candidates: [{ domain: 'rival.com', sharedKeywords: 1842, keywordsCount: 5200, avgPosition: 12.4, etv: 900 }],
      gaps: [],
      count: 1,
      fetchedAt: '2026-09-13T00:00:00.000Z',
      sourceJobId: 'job-1',
      freshness: { state: 'fresh', fetched_at: '2026-09-13T00:00:00.000Z', age_ms: 3_600_000 },
    };
  }

  function recommendation(overrides: Partial<TopicRecommendationDto> = {}): TopicRecommendationDto {
    return {
      topic: { name: 'blue widgets', description: 'widgets for buyers' },
      relevance: { state: 'strong', score: 0.82 },
      knowledge: { state: 'strong', sources: 3, topScore: 0.9 },
      keywords: [{ keyword: 'blue widgets', volume: 2400, opportunityScore: 78, competitors: [{ domain: 'rival.com', rank: 3 }] }],
      candidateCount: 1,
      totalVolume: 2400,
      bestOpportunityScore: 78,
      competitorEvidence: [{ domain: 'rival.com', rank: 3 }],
      recommendation: 'create_article',
      actionAvailable: true,
      why: '1 matching gap keyword with about 2400 monthly searches combined. Topic relevance is strong.',
      ...overrides,
    };
  }

  function topicsData(overrides: Partial<TopicRecommendationsDto> = {}): TopicRecommendationsDto {
    return {
      snapshot: {
        id: 'snap-1',
        fetchedAt: '2026-09-13T00:00:00.000Z',
        sourceJobId: 'job-1',
        freshness: { state: 'fresh', fetched_at: '2026-09-13T00:00:00.000Z', age_ms: 3_600_000 },
        domain: 'example.com',
        competitors: ['rival.com'],
      },
      recommendations: [recommendation()],
      consideredCount: 1,
      candidateCount: 1,
      knowledgeConfigured: true,
      topicsConfigured: true,
      ...overrides,
    };
  }

  function mockApi(handlers: {
    topics?: () => unknown;
    article?: (opts?: { method?: string; body?: unknown }) => unknown;
    coreTopics?: unknown;
  }) {
    apiMock.api.mockImplementation(async (path: string, opts?: { method?: string; body?: unknown }) => {
      if (path.endsWith('/gsc/keywords')) return EMPTY_GSC;
      if (path.endsWith('/keyword/competitors/snapshot')) return discoverySnapshot();
      if (path.includes('/opportunities/topics/article') && opts?.method === 'POST') {
        return handlers.article ? handlers.article(opts) : { job: { id: 'job-1' } };
      }
      if (path.includes('/opportunities/topics')) return handlers.topics ? handlers.topics() : topicsData();
      if (path.endsWith('/keyword/core-topics')) return handlers.coreTopics ?? { topics: [] };
      throw new Error(`unexpected ${path}`);
    });
  }

  async function selectCompetitors(role = 'viewer') {
    render(<Keywords projectId={PROJECT} role={role} />);
    fireEvent.click(screen.getByRole('button', { name: 'Competitors' }));
    fireEvent.click(await screen.findByLabelText('Select rival.com'));
    fireEvent.click(screen.getByRole('button', { name: 'Topics' }));
  }

  it('prompts to select competitors before reading any snapshot', async () => {
    apiMock.api.mockImplementation(async (path: string) => {
      if (path.endsWith('/gsc/keywords')) return EMPTY_GSC;
      throw new Error(`unexpected ${path}`);
    });

    render(<Keywords projectId={PROJECT} role="viewer" />);
    fireEvent.click(screen.getByRole('button', { name: 'Topics' }));

    expect(await screen.findByText(/Select competitors to see topic recommendations/)).toBeTruthy();
    expect(apiMock.api).not.toHaveBeenCalledWith(expect.stringContaining('/opportunities/topics'));
  });

  it('renders a topic card with relevance and knowledge states, never a percentage', async () => {
    mockApi({});

    await selectCompetitors();

    expect(await screen.findByText('blue widgets')).toBeTruthy();
    expect(screen.getByText('Strong match')).toBeTruthy();
    expect(screen.getByText('Knowledge: Strong')).toBeTruthy();
    expect(screen.getByText('rival.com #3')).toBeTruthy();
    expect(screen.queryByText(/82%/)).toBeNull();
    expect(apiMock.api).toHaveBeenCalledWith(expect.stringContaining('competitors=rival.com'));
  });

  it('creates a draft through the existing content path when an editor asks', async () => {
    let posted: Record<string, unknown> | null = null;
    mockApi({
      article: (opts) => {
        posted = opts?.body as Record<string, unknown>;
        return { job: { id: 'job-1' } };
      },
    });

    await selectCompetitors('editor');
    fireEvent.click(await screen.findByRole('button', { name: 'Create article' }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toMatchObject({
      topic_name: 'blue widgets',
      primary_keyword: 'blue widgets',
      opportunity_score: 78,
    });
    expect(await screen.findByText(/Draft generation started for "blue widgets"/)).toBeTruthy();
  });

  it('blocks a viewer from creating a draft', async () => {
    mockApi({});

    await selectCompetitors('viewer');

    const button = (await screen.findByRole('button', { name: 'Create article' })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText('Editors and above can create drafts.')).toBeTruthy();
  });

  it('shows only an advisory note for a research recommendation', async () => {
    mockApi({
      topics: () =>
        topicsData({
          recommendations: [
            recommendation({
              knowledge: { state: 'weak', sources: 1 },
              recommendation: 'research',
              actionAvailable: false,
            }),
          ],
        }),
    });

    await selectCompetitors('editor');

    expect(await screen.findByRole('button', { name: 'Research recommended' })).toBeTruthy();
    expect(screen.getByText(/no research run is started from here yet/)).toBeTruthy();
  });

  it('points at core topics when the project has none configured', async () => {
    mockApi({ topics: () => topicsData({ topicsConfigured: false, recommendations: [], snapshot: null }) });

    await selectCompetitors('editor');

    expect(await screen.findByText(/No core topics are configured for this project yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add core topics' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add topic' }));
    expect(await screen.findByLabelText('Topic 1 name')).toBeTruthy();
  });

  it('shows a generic load error without leaking internals', async () => {
    mockApi({
      topics: () => {
        throw new Error('boom: raw database secret');
      },
    });

    await selectCompetitors();

    expect(await screen.findByText('Could not load topic recommendations. Please try again.')).toBeTruthy();
    expect(screen.queryByText(/raw database secret/)).toBeNull();
  });
});

describe('Keywords view - GSC sync', () => {
  const LINKED_EMPTY: ProjectKeywordsDto = { propertyId: 'prop-1', lastSyncedAt: null, keywords: [] };

  it('offers an editor a sync CTA when a property is linked but has no data', async () => {
    apiMock.api.mockResolvedValue(LINKED_EMPTY);
    render(<Keywords projectId={PROJECT} role="editor" />);
    expect(await screen.findByRole('button', { name: 'Sync Google Search Console' })).toBeTruthy();
  });

  it('does not offer a viewer the sync CTA', async () => {
    apiMock.api.mockResolvedValue(LINKED_EMPTY);
    render(<Keywords projectId={PROJECT} role="viewer" />);
    await screen.findByText('No keyword data is available yet. Run a Google Search Console sync first.');
    expect(screen.queryByRole('button', { name: 'Sync Google Search Console' })).toBeNull();
  });

  it('starts a sync through the explicit endpoint when the CTA is clicked', async () => {
    apiMock.api.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path.endsWith('/gsc/sync') && opts?.method === 'POST') return { job: { id: 'job-1' }, reused: false };
      return LINKED_EMPTY;
    });
    render(<Keywords projectId={PROJECT} role="editor" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sync Google Search Console' }));
    await waitFor(() =>
      expect(apiMock.api).toHaveBeenCalledWith(`/projects/${PROJECT}/gsc/sync`, { method: 'POST' }),
    );
  });

  it('shows the real job progress and message while a sync is running', async () => {
    apiMock.api.mockResolvedValue(LINKED_EMPTY);
    jobsState.payload = [
      { id: 'job-1', job_type: 'gsc_sync', status: 'running', progress: 45, message: 'Fetching page performance' },
    ];
    render(<Keywords projectId={PROJECT} role="editor" />);
    expect(await screen.findByText('Fetching page performance')).toBeTruthy();
    expect(screen.getByText('45%')).toBeTruthy();
    expect(screen.queryByText('No keyword data is available yet. Run a Google Search Console sync first.')).toBeNull();
  });

  it('surfaces a concise failure and keeps the sync action available', async () => {
    apiMock.api.mockResolvedValue(LINKED_EMPTY);
    jobsState.payload = [
      { id: 'job-1', job_type: 'gsc_sync', status: 'failed', progress: 20, error: { message: 'quota exceeded' } },
    ];
    render(<Keywords projectId={PROJECT} role="editor" />);
    expect(await screen.findByText('quota exceeded')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sync Google Search Console' })).toBeTruthy();
  });

  it('offers an editor a "Sync again" action when data is already present', async () => {
    apiMock.api.mockResolvedValue({
      propertyId: 'prop-1',
      lastSyncedAt: '2026-09-12T08:00:00.000Z',
      keywords: [{ keyword: 'seo tools', clicks: 1, impressions: 10, ctr: 0.1, position: 2 }],
    } satisfies ProjectKeywordsDto);
    render(<Keywords projectId={PROJECT} role="editor" />);
    expect(await screen.findByRole('button', { name: 'Sync again' })).toBeTruthy();
  });

  it('does not offer a viewer a "Sync again" action', async () => {
    apiMock.api.mockResolvedValue({
      propertyId: 'prop-1',
      lastSyncedAt: '2026-09-12T08:00:00.000Z',
      keywords: [{ keyword: 'seo tools', clicks: 1, impressions: 10, ctr: 0.1, position: 2 }],
    } satisfies ProjectKeywordsDto);
    render(<Keywords projectId={PROJECT} role="viewer" />);
    await screen.findByText('seo tools');
    expect(screen.queryByRole('button', { name: 'Sync again' })).toBeNull();
  });

  it('refreshes the keyword read once a running sync finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let keywordCalls = 0;
      apiMock.api.mockImplementation(async (path: string) => {
        if (String(path).endsWith('/gsc/keywords')) keywordCalls += 1;
        return LINKED_EMPTY;
      });
      jobsState.payload = [
        { id: 'job-1', job_type: 'gsc_sync', status: 'running', progress: 65, message: 'Persisting Search Console data' },
      ];
      render(<Keywords projectId={PROJECT} role="editor" />);
      await screen.findByText('Persisting Search Console data');

      const before = keywordCalls;
      jobsState.payload = [{ id: 'job-1', job_type: 'gsc_sync', status: 'completed', progress: 100, message: null }];
      await vi.advanceTimersByTimeAsync(4100);

      await waitFor(() => expect(keywordCalls).toBeGreaterThan(before));
    } finally {
      vi.useRealTimers();
    }
  });
});

