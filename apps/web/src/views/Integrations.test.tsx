/**
 * Project Integrations view tests (P8-G). Deleting an integration removes its
 * stored credentials and project binding, so it must be confirmed first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Integrations } from './Integrations';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: apiMock };
});

const row = {
  integration: { id: 'i1', provider_type: 'dataforseo', status: 'connected', config: {} },
  descriptor: { id: 'dataforseo', name: 'DataForSEO', description: 'SERP data', capabilities: [], kind: 'data_source' },
};

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation((path: string, opts?: { method?: string }) => {
    if (path === '/providers') return Promise.resolve({ dataSources: [], knowledge: [], publishers: [] });
    if (path === '/projects/p1/integrations') return Promise.resolve([row]);
    if (path === '/projects/p1/integrations/i1' && opts?.method === 'DELETE') return Promise.resolve({});
    throw new Error(`unexpected API call ${opts?.method ?? 'GET'} ${path}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Integrations', () => {
  it('confirms before deleting an integration', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<Integrations projectId="p1" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(apiMock).not.toHaveBeenCalledWith('/projects/p1/integrations/i1', expect.anything());

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/projects/p1/integrations/i1', { method: 'DELETE' }),
    );
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(4));
  });
});
