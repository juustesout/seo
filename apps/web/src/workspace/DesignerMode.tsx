/**
 * Designer mode boundary (R5.5.1).
 *
 * The shell dispatches exactly one active mode; this is the designer branch and
 * the architectural seam between the shared workspace/session and the existing
 * Designer surface. Mirroring `ComposerMode`, it owns no document identity,
 * loader, save state or lifecycle of its own:
 *
 * - project identity and role come from the shared `WorkspaceSessionValue`
 *   (`useWorkspaceSessionContext`), not from a Designer-local variable;
 * - the canonical active document identity stays in the shared session
 *   (`useDocumentSession`); the Designer edits the one open document instead of
 *   selecting its own from a separate `/content` list;
 * - the live canonical document/revision handed to the Designer are derived
 *   from the live workspace document (`canonicalFromEditorDocument(ws.doc)` and
 *   `documentRevisionOf(ws.doc)`), the same source the Editor and Composer use,
 *   so there is exactly one authoritative current document.
 *
 * It mounts no editor infrastructure (no Tiptap, `EditorContextProvider`,
 * `EditorSelectionProvider`, editor keymap or editor AI state), so the R5.3.3
 * isolation guarantee is preserved. The Designer run endpoint and its existing
 * server-side apply are unchanged in R5.5.1; routing the proposal through the
 * shared mutation pipeline is R5.5.2.
 */
import { useMemo } from 'react';
import { canonicalFromEditorDocument } from '../components/content/editorDraft';
import { documentRevisionOf } from '../components/content/documentRevision';
import { Designer } from '../views/Designer';
import { useWorkspaceSessionContext } from './workspaceSession';

export interface DesignerModeProps {
  /** Poll interval override for tests; the Designer run client defaults to 2s. */
  pollMs?: number;
}

export function DesignerMode({ pollMs }: DesignerModeProps) {
  const { projectId, role, doc, title, session, lifecycle } = useWorkspaceSessionContext();

  // The live document in canonical form, or null when the editor document is a
  // legacy shape the canonical model cannot represent. This is the same live
  // buffer the Editor renders, not a second read of stored content.
  const currentDocument = useMemo(() => {
    try {
      return canonicalFromEditorDocument(doc);
    } catch {
      return null;
    }
  }, [doc]);

  return (
    <Designer
      projectId={projectId}
      role={role}
      pollMs={pollMs}
      documentId={session.identity.documentId}
      documentTitle={title}
      documentRevision={documentRevisionOf(doc)}
      documentStatus={lifecycle.status}
      currentDocument={currentDocument}
    />
  );
}
