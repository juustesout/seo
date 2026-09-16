/**
 * Compose surface tests (Stage 8A + 8B).
 *
 * The Compose view runs the two real server phases (plan, then compose) and
 * renders whatever the server returns with the existing CanonicalRenderer. The
 * transport is mocked with per-path responses; the plan and the filled document
 * come from the real contracts (compile + apply) so render/preview assertions
 * exercise the actual pipeline.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  MARKETING_STORYBOARD_PLAN,
  applyCompositionSlotFills,
  compileComposition,
  compositionSlotKindOf,
  isWritableCompositionSlot,
  type CanonicalDocument,
} from '@seo/contracts';
import { Compose } from './Compose';

const { apiMock } = vi.hoisted(() => ({ apiMock: { api: vi.fn() } }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: apiMock.api };
});

// Real ApiRequestError so the view's error branch is exercised.
import { ApiRequestError } from '../lib/api';

const PROJECT = 'p-1';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

function filledDocument(): CanonicalDocument {
  const compiled = compileComposition(MARKETING_STORYBOARD_PLAN);
  const fills = compiled.slots.slots.filter(isWritableCompositionSlot).map((ref) =>
    compositionSlotKindOf(ref) === 'items'
      ? { slot: ref.slot, items: [`item ${ref.slot}`] }
      : { slot: ref.slot, text: `copy for ${ref.slot}` },
  );
  return applyCompositionSlotFills(compiled, fills).document;
}

function mockComposeFlow(): {
  plan: ReturnType<typeof deferred<unknown>>;
  compose: ReturnType<typeof deferred<unknown>>;
} {
  const plan = deferred<unknown>();
  const compose = deferred<unknown>();
  apiMock.api.mockImplementation((path: string) => (path.endsWith('/plan') ? plan.promise : compose.promise));
  return { plan, compose };
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

  it('plans first and then composes with the returned plan', async () => {
    const { plan, compose } = mockComposeFlow();
    plan.resolve(MARKETING_STORYBOARD_PLAN);
    compose.resolve({ compositionPlan: MARKETING_STORYBOARD_PLAN, canonicalDocument: filledDocument() });
    render(<Compose projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    await waitFor(() => expect(apiMock.api).toHaveBeenCalledTimes(2));

    expect(apiMock.api).toHaveBeenNthCalledWith(
      1,
      `/projects/${PROJECT}/composition/plan`,
      expect.objectContaining({ method: 'POST', body: expect.objectContaining({ format: 'landing_page' }) }),
    );
    expect(apiMock.api).toHaveBeenNthCalledWith(
      2,
      `/projects/${PROJECT}/composition/compose`,
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({ plan: MARKETING_STORYBOARD_PLAN }),
      }),
    );
  });

  it('shows a real planning phase, then a real writing phase', async () => {
    const { plan, compose } = mockComposeFlow();
    render(<Compose projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    expect((screen.getByRole('button', { name: 'Planning…' }) as HTMLButtonElement).disabled).toBe(true);

    plan.resolve(MARKETING_STORYBOARD_PLAN);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Writing…' })).toBeTruthy());
    expect(screen.getByText('Writing copy into the planned slots…')).toBeTruthy();

    compose.resolve({ compositionPlan: MARKETING_STORYBOARD_PLAN, canonicalDocument: filledDocument() });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate composition' })).toBeTruthy());
  });

  it('renders the Writer copy with the existing CanonicalRenderer', async () => {
    const { plan, compose } = mockComposeFlow();
    plan.resolve(MARKETING_STORYBOARD_PLAN);
    compose.resolve({ compositionPlan: MARKETING_STORYBOARD_PLAN, canonicalDocument: filledDocument() });
    const { container } = render(<Compose projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));

    expect(await screen.findByText('copy for hero.title')).toBeTruthy();
    expect(screen.getByText('copy for hero.primaryCta')).toBeTruthy();
    await waitFor(() => expect(container.querySelector('[data-cosmos-document]')).not.toBeNull());
    expect(container.querySelector('.cosmos-hero--split')).not.toBeNull();
  });

  it('keeps the original Composer structure available after writing', async () => {
    const { plan, compose } = mockComposeFlow();
    plan.resolve(MARKETING_STORYBOARD_PLAN);
    compose.resolve({ compositionPlan: MARKETING_STORYBOARD_PLAN, canonicalDocument: filledDocument() });
    render(<Compose projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    await screen.findByText('copy for hero.title');

    fireEvent.click(screen.getByRole('button', { name: 'structure' }));
    expect(screen.getByText('hero.title')).toBeTruthy();
    expect(screen.getByText('feature.card.1.title')).toBeTruthy();
    expect(screen.getByText('landing_page')).toBeTruthy();
  });

  it('attributes a failure to the planning phase', async () => {
    const { plan } = mockComposeFlow();
    plan.reject(new ApiRequestError('not_configured', 'Project AI is not configured.', 503));
    render(<Compose projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    expect(await screen.findByText('Planning failed')).toBeTruthy();
    expect(screen.getByText('Project AI is not configured.')).toBeTruthy();
    expect(screen.getByText('Your composition preview will appear here.')).toBeTruthy();
  });

  it('attributes a failure to the writing phase and keeps the structure', async () => {
    const { plan, compose } = mockComposeFlow();
    plan.resolve(MARKETING_STORYBOARD_PLAN);
    compose.reject(new ApiRequestError('invalid_output', 'The AI writer returned invalid copy.', 422));
    render(<Compose projectId={PROJECT} role="editor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    expect(await screen.findByText('Writing failed')).toBeTruthy();
    expect(screen.getByText('The AI writer returned invalid copy.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'structure' }));
    expect(screen.getByText('hero.title')).toBeTruthy();
  });

  it('disables generation for a non-editor', () => {
    render(<Compose projectId={PROJECT} role="viewer" />);
    expect((screen.getByRole('button', { name: 'Generate composition' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Editors and above can generate a composition.')).toBeTruthy();
  });
});
