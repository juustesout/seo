/**
 * Durable Designer run client (Stage 8E.6, ADR Phase 5.1).
 *
 * The Designer view never orchestrates anything itself: it submits a natural
 * language intent to the durable run endpoint and then follows the single run
 * the server owns. This hook is the whole lifecycle - submit, restore, poll,
 * stop - so the view stays presentational.
 *
 * The active run reference is bookmarked in `localStorage` under a
 * project-scoped key, mirroring the Writer panel's run bookmark. It is only a
 * hint: every read re-authorizes the run against the URL project on the server,
 * so a foreign or unknown id is reported not found rather than leaked, and a
 * stale id simply falls back to the start form.
 *
 * Race rules (the reason for `epochRef`): restoring, submitting and polling all
 * capture the current epoch and only apply their result while it is unchanged,
 * so a slow response for an older run can never overwrite a newer one, and a
 * reset invalidates every in-flight request. Submission is guarded
 * synchronously by `submittingRef`, so a double click can never enqueue two
 * runs, and polling runs on one interval that stops at a terminal status.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  canonicalEmptyDoc,
  contentRevisionOf,
  type AgentRun,
  type AgentRunStatus,
} from '@seo/contracts';
import { ApiRequestError, api } from '../../lib/api';

/** What the view renders: the two client states plus the four server states. */
export type DesignerRunPhase = 'idle' | 'submitting' | AgentRunStatus;

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

/** Statuses that still have work to do; terminal statuses are not polled. */
const ACTIVE_STATUSES: ReadonlySet<AgentRunStatus> = new Set(['queued', 'running']);

/**
 * Creation proposals are anchored to the empty-document revision: a creation
 * has no stored content to derive a revision from, so the honest baseline is
 * the revision of the document such a creation would start from. Computed from
 * the contract so the value is never an invented literal.
 */
const CREATION_BASE_REVISION = contentRevisionOf(canonicalEmptyDoc());

function storageKey(projectId: string): string {
  return `seo.designer.run.${projectId}`;
}

function runPath(projectId: string, runId: string): string {
  return `/projects/${projectId}/designer/runs/${runId}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useDesignerRun(projectId: string, pollMs = 2000): DesignerRunState {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reused, setReused] = useState(false);
  const [fatal, setFatal] = useState(false);

  const runRef = useRef<AgentRun | null>(null);
  runRef.current = run;
  const epochRef = useRef(0);
  const submittingRef = useRef(false);
  const refreshingRef = useRef(false);

  // Restore the bookmarked run for this project on mount (and whenever the
  // project changes). A run that no longer exists drops its bookmark and falls
  // back to the start form instead of trapping the user on a dead id.
  useEffect(() => {
    let cancelled = false;
    const epoch = (epochRef.current += 1);
    setRun(null);
    setSubmitting(false);
    setError(null);
    setReused(false);
    setFatal(false);
    submittingRef.current = false;

    const stored = window.localStorage.getItem(storageKey(projectId));
    if (!stored) return;

    (async () => {
      try {
        const next = await api<AgentRun>(runPath(projectId, stored));
        if (cancelled || epoch !== epochRef.current) return;
        setRun(next);
      } catch (e) {
        if (cancelled || epoch !== epochRef.current) return;
        if (e instanceof ApiRequestError && e.status === 404) {
          window.localStorage.removeItem(storageKey(projectId));
          setError('This design run is no longer available.');
          setFatal(true);
        } else {
          setError(messageOf(e));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const submit = useCallback(
    async (instruction: string, target?: { contentId?: string }) => {
      const text = instruction.trim();
      if (!text || submittingRef.current) return;
      submittingRef.current = true;
      setSubmitting(true);
      const epoch = (epochRef.current += 1);
      const previous = window.localStorage.getItem(storageKey(projectId));
      setRun(null);
      setError(null);
      setReused(false);
      setFatal(false);
      try {
        const result = await api<{ run: AgentRun; reused: boolean }>(
          `/projects/${projectId}/designer/runs`,
          {
            method: 'POST',
            body: target?.contentId
              ? { mode: 'intent', instruction: text, content_id: target.contentId }
              : { mode: 'intent', instruction: text, base_revision: CREATION_BASE_REVISION },
          },
        );
        if (epoch !== epochRef.current) return;
        window.localStorage.setItem(storageKey(projectId), result.run.runId);
        setReused(result.reused);
        setRun(result.run);
      } catch (e) {
        if (epoch !== epochRef.current) return;
        // Never leave a half-written bookmark behind a failed submission.
        if (previous === null) window.localStorage.removeItem(storageKey(projectId));
        setError(messageOf(e));
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [projectId],
  );

  const refresh = useCallback(async () => {
    const current = runRef.current;
    if (!current || refreshingRef.current) return;
    refreshingRef.current = true;
    const epoch = epochRef.current;
    try {
      const next = await api<AgentRun>(runPath(projectId, current.runId));
      if (epoch !== epochRef.current) return;
      setRun(next);
      setError(null);
    } catch (e) {
      if (epoch !== epochRef.current) return;
      if (e instanceof ApiRequestError && e.status === 404) {
        window.localStorage.removeItem(storageKey(projectId));
        setRun(null);
        setError('This design run is no longer available.');
        setFatal(true);
      } else if (e instanceof ApiRequestError && (e.status === 401 || e.status === 403)) {
        setError(messageOf(e));
        setFatal(true);
      } else {
        // Transient: keep the last known snapshot and retry on the next tick.
        setError(`Connection problem while refreshing the run: ${messageOf(e)} Retrying…`);
      }
    } finally {
      refreshingRef.current = false;
    }
  }, [projectId]);

  const status = run?.status;
  useEffect(() => {
    if (!status || !ACTIVE_STATUSES.has(status) || fatal) return;
    const id = window.setInterval(() => {
      void refresh();
    }, pollMs);
    return () => window.clearInterval(id);
  }, [status, fatal, pollMs, refresh]);

  const reset = useCallback(() => {
    epochRef.current += 1;
    submittingRef.current = false;
    window.localStorage.removeItem(storageKey(projectId));
    setRun(null);
    setSubmitting(false);
    setError(null);
    setReused(false);
    setFatal(false);
  }, [projectId]);

  const phase: DesignerRunPhase = submitting ? 'submitting' : run ? run.status : 'idle';
  return { phase, run, error, reused, submit, reset };
}
