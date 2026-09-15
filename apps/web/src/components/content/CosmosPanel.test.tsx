/**
 * CosmosPanel behaviour tests: it renders the grouped Cosmos fields from the
 * API, disables editing for non-editors, and saves the whole config back
 * through the project-scoped endpoint. The transport module is mocked; no live
 * calls are made.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CosmosPanel } from './CosmosPanel';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../../lib/api', () => ({ api: apiMock.api }));

const PROJECT = 'p-1';

beforeEach(() => {
  apiMock.api.mockReset();
});

describe('CosmosPanel', () => {
  it('renders the stored Cosmos config, then saves edits via PUT', async () => {
    apiMock.api.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
      if (init?.method === 'PUT') return init.body;
      return { identity: { name: 'Acme' }, voice: { tone: 'Direct' } };
    });

    render(<CosmosPanel projectId={PROJECT} canEdit />);

    const name = await screen.findByDisplayValue('Acme');
    expect(screen.getByDisplayValue('Direct')).toBeTruthy();

    fireEvent.change(name, { target: { value: 'Acme Analytics' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Cosmos' }));

    await vi.waitFor(() =>
      expect(apiMock.api).toHaveBeenCalledWith(
        `/projects/${PROJECT}/cosmos`,
        expect.objectContaining({
          method: 'PUT',
          body: expect.objectContaining({ identity: expect.objectContaining({ name: 'Acme Analytics' }) }),
        }),
      ),
    );
    expect(await screen.findByText('Cosmos saved.')).toBeTruthy();
  });

  it('renders every Cosmos section', async () => {
    apiMock.api.mockResolvedValue({});
    render(<CosmosPanel projectId={PROJECT} canEdit />);
    for (const title of ['Identity', 'Voice', 'Editorial', 'SEO', 'Knowledge']) {
      expect(await screen.findByText(title)).toBeTruthy();
    }
  });

  it('disables the fields and hides Save for a non-editor', async () => {
    apiMock.api.mockResolvedValue({ identity: { name: 'Acme' } });
    render(<CosmosPanel projectId={PROJECT} canEdit={false} />);
    const name = (await screen.findByDisplayValue('Acme')) as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save Cosmos' })).toBeNull();
  });

  it('surfaces a load error instead of failing silently', async () => {
    apiMock.api.mockRejectedValue(new Error('Could not read the project settings'));
    render(<CosmosPanel projectId={PROJECT} canEdit />);
    expect(await screen.findByText('Could not read the project settings')).toBeTruthy();
  });
});
