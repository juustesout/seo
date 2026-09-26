/**
 * Designer run adapter (R5.5.4a).
 *
 * The Designer mode's view of the shared run controller. It keeps only
 * Designer-specific policy: the intent body (creation vs existing-content
 * edit), the project-scoped bookmark, and the transport copy the view renders.
 * The lifecycle itself is owned by `useDesignerRunController`.
 *
 * The active run reference is bookmarked in `localStorage` under a
 * project-scoped key, mirroring the Writer panel's run bookmark. It is only a
 * hint: every read re-authorizes the run against the URL project on the server,
 * so a foreign or unknown id is reported not found rather than leaked, and a
 * stale id simply falls back to the start form.
 */
import { useState } from 'react';
import { canonicalEmptyDoc, contentRevisionOf, type AgentRun } from '@seo/contracts';
import { ApiRequestError } from '../../lib/api';
import { designerRunBookmarkKey } from '../../workspace/designerRunClient';
import { useDesignerRunController, type DesignerRunPhase } from '../../workspace/useDesignerRunController';

export type { DesignerRunPhase };

export interface DesignerRunState {
  phase: DesignerRunPhase;
  run: AgentRun | null;
  /** Submit or refresh failure text; never the run's own structured error. */
  error: string | null;
  /** True when the server collapsed this submission onto an existing run. */
  reused: boolean;
  /**
   * Submit one intent. Without a target this is a creation intent anchored to
   * the empty-document revision; with a `contentId` it is an edit intent where
   * the server derives the base revision from the stored document (the contract
   * forbids sending both, so the revision check is never bypassed).
   */
  submit: (instruction: string, target?: { contentId?: string }) => Promise<void>;
  reset: () => void;
}

/**
 * Creation proposals are anchored to the empty-document revision: a creation
 * has no stored content to derive a revision from, so the honest baseline is
 * the revision of the document such a creation would start from. Computed from
 * the contract so the value is never an invented literal.
 */
export const CREATION_BASE_REVISION = contentRevisionOf(canonicalEmptyDoc());

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useDesignerRun(projectId: string, pollMs = 2000): DesignerRunState {
  const [error, setError] = useState<string | null>(null);

  const controller = useDesignerRunController({
    projectId,
    pollMs,
    bookmarkKey: designerRunBookmarkKey(projectId),
    onReset: () => setError(null),
    onRun: () => setError(null),
    onGone: () => setError('This design run is no longer available.'),
    onError: (e, meta) => {
      if (meta.source === 'poll') {
        if (e instanceof ApiRequestError && (e.status === 401 || e.status === 403)) {
          setError(messageOf(e));
          return 'stop';
        }
        setError(`Connection problem while refreshing the run: ${messageOf(e)} Retrying…`);
        return 'retry';
      }
      setError(messageOf(e));
      return 'stop';
    },
  });

  const submit = (instruction: string, target?: { contentId?: string }) => {
    setError(null);
    return controller.submit(
      target?.contentId
        ? { mode: 'intent', instruction: instruction.trim(), content_id: target.contentId }
        : { mode: 'intent', instruction: instruction.trim(), base_revision: CREATION_BASE_REVISION },
    );
  };

  return {
    phase: controller.phase,
    run: controller.run,
    error,
    reused: controller.reused,
    submit,
    reset: controller.reset,
  };
}
