/**
 * Direct composer tests (P8-B). Covers the content link that ties a composer
 * publication to a Content Studio item so the publish is measurable and the
 * content status follows the real remote publish.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Publishing } from './Publishing';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: apiMock };
});

const publisher = {
  publisher: {
    id: 'pb-1',
    name: 'WordPress',
    provider: 'wordpress',
    status: 'connected',
    config: {},
    capabilities: ['publish_article'],
  },
  descriptor: {
    id: 'wordpress',
    name: 'WordPress',
    description: 'Website',
    capabilities: ['publish_article'],
    setup: { category: 'website', auth: 'form' as const },
  },
};

type ApiOpts = { method?: string; body?: Record<string, unknown> };

function respond(path: string, opts: ApiOpts = {}): unknown {
  if (path === '/projects/p1/publishers') return [publisher];
  if (path === '/providers') return { publishers: [] };
  if (path === '/projects/p1/publications?limit=200') return [];
  if (path === '/projects/p1/content?limit=200') {
    return { content: [{ id: 'c1', title: 'Search Console guide', status: 'draft' }], total: 1 };
  }
  if (path === '/projects/p1/jobs?limit=30') return [];
  if (path === '/projects/p1/publications' && opts.method === 'POST') {
    return { publication: { id: 'pub-1' }, job: { id: 'job-1' }, reused: false };
  }
  throw new Error(`unexpected API call ${opts.method ?? 'GET'} ${path}`);
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockImplementation((path: string, opts?: ApiOpts) => Promise.resolve(respond(path, opts)));
});

describe('Direct publication composer', () => {
  it('sends the selected content_id when linking a publication to content', async () => {
    render(<Publishing projectId="p1" />);

    const link = await screen.findByLabelText('Link to content (optional)');
    fireEvent.change(link, { target: { value: 'c1' } });

    const button = screen.getByRole('button', { name: 'Queue publication' });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        '/projects/p1/publications',
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ content_id: 'c1', title: 'Search Console guide' }),
        }),
      ),
    );
  });

  it('submits a standalone publication without a content_id when none is linked', async () => {
    render(<Publishing projectId="p1" />);

    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'A standalone post' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue publication' }));

    await waitFor(() => {
      const post = apiMock.mock.calls.find(
        ([path, opts]) => path === '/projects/p1/publications' && (opts as ApiOpts)?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = (post?.[1] as ApiOpts).body ?? {};
      expect(body.content_id).toBeUndefined();
      expect(body.title).toBe('A standalone post');
    });
  });
});
