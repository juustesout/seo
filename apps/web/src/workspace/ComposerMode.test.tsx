/**
 * R5.4.1: `ComposerMode` is the architectural boundary between the shared
 * workspace session and the existing Composer surface.
 *
 * These tests pin the integration contract: project identity comes from the
 * shared session (not from props/Composer-local state), the boundary renders the
 * existing Composer surface and no editor infrastructure, and a change to the
 * canonical active document does not reset or re-key the composition workflow
 * (Composer owns no document identity).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  MARKETING_STORYBOARD_PLAN,
  applyCompositionSlotFills,
  compileComposition,
  compositionSlotKindOf,
  isWritableCompositionSlot,
  type CanonicalDocument,
  type CompositionOperationBatch,
} from '@seo/contracts';
import type { WorkspaceSessionValue } from './workspaceSession';
import { WorkspaceSessionProvider } from './workspaceSession';
import { ComposerMode } from './ComposerMode';

const apiMock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: apiMock.api };
});

function sessionStub(overrides: { projectId?: string; role?: string; documentId?: string | null } = {}): WorkspaceSessionValue {
  const { projectId = 'canon-1', role = 'editor', documentId = 'doc-9' } = overrides;
  return {
    projectId,
    role,
    session: { identity: { documentId, creating: false }, boundary: `${documentId}#0`, hasDocument: documentId !== null },
  } as unknown as WorkspaceSessionValue;
}

function renderComposer(session: WorkspaceSessionValue, onOpenEditor = vi.fn()) {
  const view = render(
    <WorkspaceSessionProvider value={session}>
      <ComposerMode onOpenEditor={onOpenEditor} />
    </WorkspaceSessionProvider>,
  );
  return { ...view, onOpenEditor };
}

describe('ComposerMode', () => {
  it('renders the existing Composer surface and mounts no editor infrastructure', () => {
    apiMock.api.mockReset();
    const { container } = renderComposer(sessionStub());
    expect(screen.getByRole('heading', { name: 'Compose' })).toBeTruthy();
    expect(screen.getByLabelText('What do you want to create?')).toBeTruthy();
    expect(container.querySelector('.ProseMirror')).toBeNull();
    expect(screen.queryByTestId('editor-workspace')).toBeNull();
    expect(screen.queryByTestId('embedded-agent-open')).toBeNull();
  });

  it('consumes the canonical project identity from the shared session', async () => {
    apiMock.api.mockReset();
    apiMock.api.mockReturnValue(new Promise(() => {}));
    renderComposer(sessionStub({ projectId: 'canon-42', role: 'editor' }));

    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    await waitFor(() =>
      expect(apiMock.api).toHaveBeenCalledWith(
        '/projects/canon-42/composition/plan',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('does not reset the composition workflow when the shared document changes', async () => {
    apiMock.api.mockReset();
    apiMock.api.mockReturnValue(new Promise(() => {}));
    const { rerender } = renderComposer(sessionStub({ documentId: 'doc-9' }));

    const box = screen.getByLabelText('What do you want to create?') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'A pricing page' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    expect(screen.getByRole('button', { name: 'Planning…' })).toBeTruthy();

    rerender(
      <WorkspaceSessionProvider value={sessionStub({ documentId: 'doc-10' })}>
        <ComposerMode onOpenEditor={vi.fn()} />
      </WorkspaceSessionProvider>,
    );

    // Composer-owned workflow state survives a canonical document change, and
    // nothing fetches the newly active document through the Composer.
    expect((screen.getByLabelText('What do you want to create?') as HTMLTextAreaElement).value).toBe('A pricing page');
    expect(screen.getByRole('button', { name: 'Planning…' })).toBeTruthy();
    expect(apiMock.api).not.toHaveBeenCalledWith(expect.stringContaining('doc-10'));
  });

  it('forwards the reviewed batch to the shell only after the user applies it', async () => {
    apiMock.api.mockReset();
    const compiled = compileComposition(MARKETING_STORYBOARD_PLAN);
    const fills = compiled.slots.slots.filter(isWritableCompositionSlot).map((ref) =>
      compositionSlotKindOf(ref) === 'items'
        ? { slot: ref.slot, items: [`item ${ref.slot}`] }
        : { slot: ref.slot, text: `copy for ${ref.slot}` },
    );
    const document: CanonicalDocument = applyCompositionSlotFills(compiled, fills).document;
    apiMock.api.mockImplementation((path: string) =>
      path.endsWith('/plan')
        ? Promise.resolve(MARKETING_STORYBOARD_PLAN)
        : Promise.resolve({ compositionPlan: MARKETING_STORYBOARD_PLAN, canonicalDocument: document }),
    );
    const onAppendToDocument = vi.fn();
    render(
      <WorkspaceSessionProvider value={sessionStub()}>
        <ComposerMode
          onOpenEditor={vi.fn()}
          onAppendToDocument={onAppendToDocument}
          canAppendToDocument
        />
      </WorkspaceSessionProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Generate composition' }));
    await screen.findByText('copy for hero.title');

    fireEvent.click(screen.getByTestId('compose-append-current'));
    expect(screen.getByTestId('composition-review')).toBeTruthy();
    expect(onAppendToDocument).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('composition-review-apply'));
    expect(onAppendToDocument).toHaveBeenCalledTimes(1);
    expect(onAppendToDocument.mock.calls[0]?.[0]).toMatchObject({ composition: document });
    expect(onAppendToDocument.mock.calls[0]?.[0] as CompositionOperationBatch).not.toHaveProperty('baseRevision');
  });
});
