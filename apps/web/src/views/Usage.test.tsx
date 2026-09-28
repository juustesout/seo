/**
 * Usage view tests (R5.10.8 web).
 *
 * Covers the four read states (loading, empty, error, populated), the
 * aggregate-only table shape and the project-vs-account endpoint selection. The
 * API module is mocked; the shared `useAsync` hook runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { UsageReportDto } from '@seo/contracts';
import { Usage } from './Usage';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../lib/api', () => ({
  api: (...args: unknown[]) => apiMock.api(...args),
}));

const REPORT: UsageReportDto = {
  scope: { accountId: null, projectId: 'p-1' },
  totals: [
    {
      category: 'ai',
      provider: 'openai',
      operation: 'chat',
      unit: 'input_token',
      quantity: 1500,
      eventCount: 3,
    },
  ],
};

beforeEach(() => {
  apiMock.api.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Usage view', () => {
  it('shows a loading state while the request is in flight', () => {
    apiMock.api.mockReturnValue(new Promise<UsageReportDto>(() => {}));
    render(<Usage projectId="p-1" />);
    expect(screen.getByText('Loading usage…')).toBeTruthy();
  });

  it('renders the aggregate table for the project scope', async () => {
    apiMock.api.mockResolvedValue(REPORT);
    render(<Usage projectId="p-1" />);

    expect(await screen.findByText('openai')).toBeTruthy();
    expect(screen.getByText('ai')).toBeTruthy();
    expect(screen.getByText('chat')).toBeTruthy();
    expect(screen.getByText('input_token')).toBeTruthy();
    expect(screen.getByText('1,500')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(apiMock.api).toHaveBeenCalledWith('/projects/p-1/usage');
  });

  it('renders an honest empty state when nothing is recorded', async () => {
    apiMock.api.mockResolvedValue({ scope: { accountId: null, projectId: 'p-1' }, totals: [] });
    render(<Usage projectId="p-1" />);
    expect(await screen.findByText('No usage recorded yet')).toBeTruthy();
  });

  it('surfaces a read failure instead of a fake empty report', async () => {
    apiMock.api.mockRejectedValue(new Error('usage unavailable'));
    render(<Usage projectId="p-1" />);
    expect(await screen.findByText('usage unavailable')).toBeTruthy();
  });

  it('reads the account scope when no project is given', async () => {
    apiMock.api.mockResolvedValue({ scope: { accountId: 'a-1', projectId: null }, totals: [] });
    render(<Usage />);
    expect(await screen.findByText('No usage recorded yet')).toBeTruthy();
    expect(apiMock.api).toHaveBeenCalledWith('/account/usage');
  });
});
