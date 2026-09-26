/**
 * R5.4.2: the Composer handoff guard.
 *
 * `ComposerMode` supplies `beginHandoff` to `Compose`. It captures the shared
 * document boundary when the handoff task starts through the existing
 * `useOperationBoundary`, and treats an unmounted Composer as invalid, so a late
 * creation result cannot switch the workspace to an obsolete draft. `Compose` is
 * stubbed here so the guard itself is isolated from the (already covered)
 * Composer surface.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { WorkspaceSessionValue } from './workspaceSession';
import { WorkspaceSessionProvider } from './workspaceSession';
import { ComposerMode } from './ComposerMode';

const probe = vi.hoisted(() => ({
  beginHandoff: null as null | (() => { isStale: () => boolean }),
  onOpenEditor: null as null | ((contentId: string) => void),
}));

vi.mock('../views/Compose', () => ({
  Compose: (props: { beginHandoff: () => { isStale: () => boolean }; onOpenEditor: (id: string) => void }) => {
    probe.beginHandoff = props.beginHandoff;
    probe.onOpenEditor = props.onOpenEditor;
    return <div data-testid="compose-stub" />;
  },
}));

function sessionStub(overrides: { documentId?: string | null; err?: string | null } = {}): WorkspaceSessionValue {
  const { documentId = 'doc-9', err = null } = overrides;
  const id = documentId ?? 'closed';
  return {
    projectId: 'canon-1',
    role: 'editor',
    err,
    session: { identity: { documentId, creating: false }, boundary: `${id}#0`, hasDocument: documentId !== null },
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

describe('ComposerMode handoff guard', () => {
  it('treats a capture from a superseded document boundary as stale', () => {
    const { rerender, onOpenEditor } = renderComposer(sessionStub({ documentId: 'doc-9' }));
    const guard = probe.beginHandoff!();
    expect(guard.isStale()).toBe(false);

    rerender(
      <WorkspaceSessionProvider value={sessionStub({ documentId: 'doc-10' })}>
        <ComposerMode onOpenEditor={onOpenEditor} />
      </WorkspaceSessionProvider>,
    );
    expect(guard.isStale()).toBe(true);
  });

  it('treats a capture from an unmounted Composer as stale', () => {
    const { unmount } = renderComposer(sessionStub({ documentId: 'doc-9' }));
    const guard = probe.beginHandoff!();
    expect(guard.isStale()).toBe(false);

    unmount();
    expect(guard.isStale()).toBe(true);
  });

  it('forwards the handoff through the supplied callback while current', () => {
    const { onOpenEditor } = renderComposer(sessionStub({ documentId: 'doc-9' }));
    expect(probe.beginHandoff!().isStale()).toBe(false);
    probe.onOpenEditor!('draft-1');
    expect(onOpenEditor).toHaveBeenCalledWith('draft-1');
  });

  it('surfaces the workspace error (e.g. a blocked save barrier)', () => {
    const { getByText } = renderComposer(sessionStub({ err: 'Could not switch documents.' }));
    expect(getByText('Could not switch documents.')).toBeTruthy();
  });
});
