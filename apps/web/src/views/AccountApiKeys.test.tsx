/**
 * Account API keys view tests (P8-G). The key point: revocation is destructive
 * and must be confirmed before the endpoint is called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountApiKeys } from './AccountApiKeys';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: apiMock };
});

const key = {
  id: 'k1',
  name: 'Agent key',
  key_prefix: 'seo_live_ab',
  scopes: ['read'],
  created_at: '2026-01-01T00:00:00Z',
  last_used_at: null,
  revoked_at: null,
};

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation((path: string) => {
    if (path === '/account/api-keys') return Promise.resolve({ keys: [key], note: '' });
    if (path === '/account/api-keys/k1/revoke') return Promise.resolve({});
    throw new Error(`unexpected API call ${path}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AccountApiKeys', () => {
  it('confirms before revoking a key', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AccountApiKeys />);

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(apiMock).not.toHaveBeenCalledWith('/account/api-keys/k1/revoke', expect.anything());

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/account/api-keys/k1/revoke', { method: 'POST', body: {} }),
    );
    await screen.findByText('API key "Agent key" revoked.');
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(3));
  });
});
