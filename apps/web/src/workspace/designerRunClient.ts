/**
 * Shared Designer run client primitives (R5.5.4a).
 *
 * One durable run, one wire shape, one bookmark format, used by both run
 * surfaces (Designer mode and the editor-native Agent). Pure helpers only: no
 * React, no network. The lifecycle hook lives in `useDesignerRunController`.
 */
import { isTerminalAgentRunStatus, type AgentRunStatus } from '@seo/contracts';

export const DESIGNER_RUN_BOOKMARK_PREFIX = 'seo.designer.run';

/** The collection endpoint the route exposes for creating a run. */
export function designerRunsPath(projectId: string): string {
  return `/projects/${projectId}/designer/runs`;
}

/** The single-run read endpoint used for restore and polling. */
export function designerRunPath(projectId: string, runId: string): string {
  return `/projects/${projectId}/designer/runs/${runId}`;
}

/** The project-scoped durable bookmark key for the active run. */
export function designerRunBookmarkKey(projectId: string): string {
  return `${DESIGNER_RUN_BOOKMARK_PREFIX}.${projectId}`;
}

/** A run still has work to do while its status is not terminal. */
export function isActiveAgentRunStatus(status: AgentRunStatus): boolean {
  return !isTerminalAgentRunStatus(status);
}

// The bookmark is a hint, never a source of truth; storage being unavailable
// (private mode, disabled storage) must not break the run lifecycle.
export function readRunBookmark(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeRunBookmark(key: string, runId: string): void {
  try {
    window.localStorage.setItem(key, runId);
  } catch {
    /* ignore: the bookmark is best-effort */
  }
}

export function clearRunBookmark(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore: the bookmark is best-effort */
  }
}
