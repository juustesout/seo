/**
 * Knowledge discovery panel (KB9).
 *
 * Verifies the human-in-the-loop discovery flow: a bounded seed request, a
 * polled proposal that is never auto-selected, a disabled ineligible candidate
 * with a machine reason, an honest apply result and a human (never raw code)
 * failure message. All transport goes through the mocked `api` wrapper.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type {
  KnowledgeDiscoveryApplyResultDto,
  KnowledgeDiscoverySessionDetailDto,
} from '@seo/contracts';
import { KnowledgeDiscoveryPanel } from './KnowledgeDiscovery';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../../lib/api', () => ({ api: apiMock.api }));

const PROJECT = 'p-1';
const SESSION = 'd-1';

function session(overrides: Partial<KnowledgeDiscoverySessionDetailDto> = {}): KnowledgeDiscoverySessionDetailDto {
  return {
    id: SESSION,
    projectId: PROJECT,
    seedUrl: 'https://example.com/',
    normalizedSeedUrl: 'https://example.com/',
    collectionId: null,
    status: 'ready',
    scope: 'same_host',
    maxUrls: 25,
    maxDepth: 1,
    candidateCount: 2,
    eligibleCount: 1,
    alreadyExistingCount: 1,
    errorCode: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    candidates: [
      {
        url: 'https://example.com/a',
        normalizedUrl: 'https://example.com/a',
        title: 'Alpha',
        depth: 1,
        discoveredFrom: 'https://example.com/',
        eligible: true,
        reason: null,
        alreadyExists: false,
        existingSourceId: null,
      },
      {
        url: 'https://example.com/dup',
        normalizedUrl: 'https://example.com/dup',
        title: null,
        depth: 1,
        discoveredFrom: 'https://example.com/',
        eligible: false,
        reason: 'duplicate',
        alreadyExists: true,
        existingSourceId: 's-1',
      },
    ],
    ...overrides,
  };
}

const applyResult: KnowledgeDiscoveryApplyResultDto = {
  created: 1,
  alreadyExists: 0,
  queued: 1,
  rejected: 0,
  items: [
    {
      url: 'https://example.com/a',
      normalizedUrl: 'https://example.com/a',
      outcome: 'created',
      sourceId: 's-2',
      reason: null,
    },
  ],
};

/** POST /discovery -> queued, GET /discovery/:id -> ready, POST apply -> result. */
function mockFlow(get: () => KnowledgeDiscoverySessionDetailDto) {
  apiMock.api.mockImplementation(async (path: string, init?: { method?: string }) => {
    const p = String(path);
    if (p.endsWith('/knowledge/discovery') && init?.method === 'POST') {
      return { session: session({ status: 'queued', candidates: [] }), job: { id: 'job-1' } };
    }
    if (p.endsWith('/apply')) return applyResult;
    if (p.includes('/knowledge/discovery/')) return get();
    throw new Error(`unexpected ${p}`);
  });
}

function openAndStart() {
  fireEvent.click(screen.getByRole('button', { name: 'Discover from website' }));
  fireEvent.change(screen.getByLabelText('Seed URL'), { target: { value: 'https://example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discover links' }));
}

beforeEach(() => {
  apiMock.api.mockReset();
});

describe('KnowledgeDiscoveryPanel', () => {
  it('sends a bounded seed request and shows the polled proposal without auto-selecting', async () => {
    mockFlow(() => session());
    render(<KnowledgeDiscoveryPanel projectId={PROJECT} canEdit />);

    openAndStart();

    expect(await screen.findByText('Alpha')).toBeTruthy();
    const addButton = screen.getByRole('button', { name: 'Add selected to Knowledge Base' }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    expect(screen.getByText('0 selected')).toBeTruthy();

    const call = apiMock.api.mock.calls.find((c) => String(c[0]).endsWith('/knowledge/discovery'));
    expect((call![1] as { body: unknown }).body).toEqual({
      seedUrl: 'https://example.com',
      collectionId: null,
      maxUrls: 25,
      maxDepth: 1,
      scope: 'same_host',
    });
  });

  it('disables an ineligible candidate and explains why', async () => {
    mockFlow(() => session());
    render(<KnowledgeDiscoveryPanel projectId={PROJECT} canEdit />);
    openAndStart();

    await screen.findByText('Alpha');
    const duplicate = screen.getByLabelText('Select https://example.com/dup') as HTMLInputElement;
    expect(duplicate.disabled).toBe(true);
    expect(screen.getByText('Already in the Knowledge Base')).toBeTruthy();
  });

  it('applies only the human selection and reports honest counts', async () => {
    mockFlow(() => session());
    render(<KnowledgeDiscoveryPanel projectId={PROJECT} canEdit />);
    openAndStart();

    fireEvent.click(await screen.findByLabelText('Select Alpha'));
    expect(screen.getByText('1 selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add selected to Knowledge Base' }));

    await waitFor(() => {
      const call = apiMock.api.mock.calls.find((c) => String(c[0]).endsWith('/apply'));
      expect(call).toBeTruthy();
      expect((call![1] as { body: unknown }).body).toEqual({ urls: ['https://example.com/a'] });
    });
    expect(await screen.findByText(/1 added, 0 already existed, 0 rejected/)).toBeTruthy();
  });

  it('selects every eligible candidate on demand', async () => {
    mockFlow(() => session());
    render(<KnowledgeDiscoveryPanel projectId={PROJECT} canEdit />);
    openAndStart();

    await screen.findByText('Alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Select eligible' }));
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('shows a human failure message, never the raw stored code', async () => {
    mockFlow(() => session({ status: 'failed', candidates: [], errorCode: 'knowledge_fetch_provider_error' }));
    render(<KnowledgeDiscoveryPanel projectId={PROJECT} canEdit />);
    openAndStart();

    expect(await screen.findByText('Discovery failed')).toBeTruthy();
    expect(screen.queryByText('knowledge_fetch_provider_error')).toBeNull();
  });

  it('renders no discovery entry for a viewer', () => {
    render(<KnowledgeDiscoveryPanel projectId={PROJECT} canEdit={false} />);
    expect(screen.queryByRole('button', { name: 'Discover from website' })).toBeNull();
  });
});
