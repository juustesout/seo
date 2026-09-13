/**
 * Keywords view tests (KW1 web).
 *
 * The page is a thin read: it must render the four honest states from the API
 * payload - loading, no property linked, linked but no data yet, and data - and
 * never leak a raw error message. The API module is mocked; the shared
 * `useAsync` hook runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ProjectKeywordsDto } from '@seo/contracts';
import { Keywords } from './Keywords';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../lib/api', () => ({ api: apiMock.api }));

const PROJECT = 'p-1';

beforeEach(() => {
  apiMock.api.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Keywords view', () => {
  it('shows a loading state while the request is in flight', () => {
    apiMock.api.mockReturnValue(new Promise<ProjectKeywordsDto>(() => {}));
    render(<Keywords projectId={PROJECT} />);
    expect(screen.getByText('Loading keywords…')).toBeTruthy();
  });

  it('renders the aggregated query table', async () => {
    apiMock.api.mockResolvedValue({
      propertyId: 'prop-1',
      lastSyncedAt: '2026-09-12T08:00:00.000Z',
      keywords: [{ keyword: 'seo tools', clicks: 1200, impressions: 40000, ctr: 0.03, position: 4.25 }],
    } satisfies ProjectKeywordsDto);

    render(<Keywords projectId={PROJECT} />);

    expect(await screen.findByText('seo tools')).toBeTruthy();
    expect(screen.getByText('1,200')).toBeTruthy();
    expect(screen.getByText('40,000')).toBeTruthy();
    expect(screen.getByText('3.00%')).toBeTruthy();
    expect(screen.getByText('4.3')).toBeTruthy();
    expect(apiMock.api).toHaveBeenCalledWith(`/projects/${PROJECT}/gsc/keywords`);
  });

  it('prompts to connect Search Console when no property is linked', async () => {
    apiMock.api.mockResolvedValue({ propertyId: null, lastSyncedAt: null, keywords: [] } satisfies ProjectKeywordsDto);
    render(<Keywords projectId={PROJECT} />);
    expect(await screen.findByText('Google Search Console is not connected to this project.')).toBeTruthy();
  });

  it('prompts to run a sync when a property is linked but has no data', async () => {
    apiMock.api.mockResolvedValue({ propertyId: 'prop-1', lastSyncedAt: null, keywords: [] } satisfies ProjectKeywordsDto);
    render(<Keywords projectId={PROJECT} />);
    expect(
      await screen.findByText('No keyword data is available yet. Run a Google Search Console sync first.'),
    ).toBeTruthy();
  });

  it('shows a generic message on failure without leaking the raw error', async () => {
    apiMock.api.mockRejectedValue(new Error('boom: raw database secret'));
    render(<Keywords projectId={PROJECT} />);
    expect(await screen.findByText('Could not load keyword data. Please try again.')).toBeTruthy();
    expect(screen.queryByText(/raw database secret/)).toBeNull();
  });
});
