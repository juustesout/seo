/**
 * Compose surface tests (Stage 8A).
 *
 * The Compose view is a thin slice over the existing Composition Planner API,
 * the existing deterministic compiler and the existing CanonicalRenderer. The
 * transport module is mocked; the plan under test is the shared storyboard
 * fixture, so the compile + render assertions run the real contracts/renderer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MARKETING_STORYBOARD_PLAN } from '@seo/contracts';
import { Compose } from './Compose';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: apiMock.api };
});

const PROJECT = 'p-1';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  apiMock.api.mockReset();
});

describe('Compose', () => {
  it('renders the form, format choices and empty state', () => {
    render(<Compose projectId={PROJECT} role="editor" />);
    expect(screen.getByLabelText('What do you want to create?')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Article' })).toBeTruthy();
    expect((screen.getByRole('radio', { name: 'Landing page' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Generate composition' })).toBeTruthy();
    expect(screen.getByText('Your composition preview will appear here.')).toBeTruthy();
  });

  it('lets the user edit the brief', () => {
    render(<Compose projectId={PROJECT} role="editor" />);
    const box = screen.getByLabelText('What do you want to create?') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'A pricing page' } });
    expect(box.value).toBe('A pricing page');
  });

  it('posts the brief and format to the existing composition endpoint', async () => {
    apiMock.api.mockResolvedValue(MARKETING_STORYBOARD_PLAN);
    render(<Compose projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    await waitFor(() =>
      expect(apiMock.api).toHaveBeenCalledWith(
        `/projects/${PROJECT}/composition/plan`,
        expect.objectContaining({
          method: 'POST',
          body: expect.objectContaining({ format: 'landing_page', brief: expect.stringContaining('Create a landing page') }),
        }),
      ),
    );
  });

  it('disables the button and shows progress while generating', () => {
    const pending = deferred<unknown>();
    apiMock.api.mockReturnValue(pending.promise);
    render(<Compose projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    expect((screen.getByRole('button', { name: 'Generating composition…' }) as HTMLButtonElement).disabled).toBe(true);
    pending.resolve(MARKETING_STORYBOARD_PLAN);
  });

  it('shows the returned CompositionPlan under Structure', async () => {
    apiMock.api.mockResolvedValue(MARKETING_STORYBOARD_PLAN);
    render(<Compose projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    fireEvent.click(await screen.findByRole('button', { name: 'structure' }));
    expect(screen.getByText('hero.title')).toBeTruthy();
    expect(screen.getByText('feature.card.1.title')).toBeTruthy();
    expect(screen.getByText('landing_page')).toBeTruthy();
  });

  it('compiles the plan and renders it with the existing CanonicalRenderer', async () => {
    apiMock.api.mockResolvedValue(MARKETING_STORYBOARD_PLAN);
    const { container } = render(<Compose projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    await waitFor(() => expect(container.querySelector('[data-cosmos-document]')).not.toBeNull());
    expect(container.querySelector('.cosmos-hero--split')).not.toBeNull();
    expect(container.querySelectorAll('.cosmos-featureGrid .cosmos-featureCard')).toHaveLength(3);
    expect(container.querySelector('footer.cosmos-footer')).not.toBeNull();
  });

  it('toggles between preview and structure', async () => {
    apiMock.api.mockResolvedValue(MARKETING_STORYBOARD_PLAN);
    const { container } = render(<Compose projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    await waitFor(() => expect(container.querySelector('[data-cosmos-document]')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'structure' }));
    expect(container.querySelector('[data-cosmos-document]')).toBeNull();
    expect(screen.getByText('hero.title')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'preview' }));
    expect(container.querySelector('[data-cosmos-document]')).not.toBeNull();
  });

  it('exposes the raw plan and compiled document in debug panels', async () => {
    apiMock.api.mockResolvedValue(MARKETING_STORYBOARD_PLAN);
    const { container } = render(<Compose projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    expect(await screen.findByText('Composition Plan')).toBeTruthy();
    expect(screen.getByText('Canonical Document')).toBeTruthy();
    expect(container.textContent).toContain('"version": 1');
    expect(container.textContent).toContain('"blocks"');
  });

  it('surfaces an API error and keeps the empty state', async () => {
    apiMock.api.mockRejectedValue(new Error('Project AI is not configured.'));
    render(<Compose projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    expect(await screen.findByText('Project AI is not configured.')).toBeTruthy();
    expect(screen.getByText('Your composition preview will appear here.')).toBeTruthy();
  });

  it('disables generation for a non-editor', () => {
    render(<Compose projectId={PROJECT} role="viewer" />);
    expect((screen.getByRole('button', { name: 'Generate composition' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Editors and above can generate a composition.')).toBeTruthy();
  });

  it('does not crash when the returned plan cannot be compiled', async () => {
    apiMock.api.mockResolvedValue({ version: 1, purpose: 'x', format: 'landing_page', sections: [] });
    render(<Compose projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    expect(await screen.findByText(/could not be compiled/)).toBeTruthy();
  });
});
