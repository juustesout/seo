/**
 * The single durable Designer run controller (R5.5.4a, ADR Decision 4).
 *
 * Both run surfaces - the Designer mode and the editor-native Agent - drive the
 * same durable endpoint. This hook owns the server lifecycle they share:
 * restore from a bookmark, submit, one epoch guard, one poll loop that stops at
 * a terminal status, bookmark read/write/clear, and not-found/auth stop rules.
 *
 * It deliberately does not own presentation: outcome copy, dirty/ready gating,
 * proposal classification/application and per-surface UI state stay with the
 * adapters. Callbacks (`onRun`/`onError`/`onGone`/`onExhausted`/`onReset`) are
 * the seams where each surface applies its own policy.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentRun, AgentRunStatus } from '@seo/contracts';
import { ApiRequestError, api } from '../lib/api';
import {
  clearRunBookmark,
  designerRunPath,
  designerRunsPath,
  isActiveAgentRunStatus,
  readRunBookmark,
  writeRunBookmark,
} from './designerRunClient';

/** What the view renders: the two client states plus the four server states. */
export type DesignerRunPhase = 'idle' | 'submitting' | AgentRunStatus;

export type RunSource = 'restore' | 'submit' | 'poll';

export interface RunMeta {
  source: RunSource;
  reused: boolean;
}

/** A poll/restore error tells the controller whether to keep polling. */
export type RunErrorDirective = 'retry' | 'stop' | void;

export interface UseDesignerRunControllerOptions {
  projectId: string;
  pollMs?: number;
  /** Durable bookmark key; null disables bookmarking/restoring for the surface. */
  bookmarkKey?: string | null;
  /** Poll-attempt budget before `onExhausted`; null means unbounded. */
  maxPolls?: number | null;
  /** Change-detection key; a change invalidates in-flight work and resets. */
  identity?: string;
  onRun?: (run: AgentRun, meta: RunMeta) => void;
  onError?: (error: unknown, meta: RunMeta & { fatal: boolean }) => RunErrorDirective;
  onGone?: (error: unknown) => void;
  onExhausted?: () => void;
  onReset?: () => void;
}

export interface DesignerRunController {
  run: AgentRun | null;
  phase: DesignerRunPhase;
  submitting: boolean;
  reused: boolean;
  activeRunId: string | null;
  submit: (body: Record<string, unknown>) => Promise<void>;
  reset: () => void;
}

export function useDesignerRunController(
  options: UseDesignerRunControllerOptions,
): DesignerRunController {
  const {
    projectId,
    pollMs = 2000,
    bookmarkKey = null,
    maxPolls = null,
    identity = projectId,
    onRun,
    onError,
    onGone,
    onExhausted,
    onReset,
  } = options;

  const [run, setRun] = useState<AgentRun | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reused, setReused] = useState(false);
  const [stopped, setStopped] = useState(false);

  const runRef = useRef<AgentRun | null>(null);
  runRef.current = run;
  const epochRef = useRef(0);
  const submittingRef = useRef(false);
  const refreshingRef = useRef(false);
  const stoppedRef = useRef(false);
  const attemptRef = useRef(0);

  // Keep the latest callbacks without making the lifecycle effects depend on
  // their identity (adapters pass inline closures).
  const cb = useRef({ onRun, onError, onGone, onExhausted, onReset });
  cb.current = { onRun, onError, onGone, onExhausted, onReset };

  const applyRun = useCallback((next: AgentRun, meta: RunMeta) => {
    setRun(next);
    cb.current.onRun?.(next, meta);
  }, []);

  const halt = useCallback(() => {
    stoppedRef.current = true;
    setStopped(true);
  }, []);

  // Restore a bookmarked run on mount / identity change, or merely reset when the
  // surface has no bookmark. A stale id drops its bookmark and falls back instead
  // of trapping the user on a dead run.
  useEffect(() => {
    let cancelled = false;
    const epoch = (epochRef.current += 1);
    submittingRef.current = false;
    refreshingRef.current = false;
    stoppedRef.current = false;
    attemptRef.current = 0;
    setRun(null);
    setSubmitting(false);
    setReused(false);
    setStopped(false);
    cb.current.onReset?.();

    if (!bookmarkKey) return;
    const stored = readRunBookmark(bookmarkKey);
    if (!stored) return;

    (async () => {
      try {
        const next = await api<AgentRun>(designerRunPath(projectId, stored));
        if (cancelled || epoch !== epochRef.current) return;
        applyRun(next, { source: 'restore', reused: false });
      } catch (e) {
        if (cancelled || epoch !== epochRef.current) return;
        if (e instanceof ApiRequestError && e.status === 404) {
          clearRunBookmark(bookmarkKey);
          halt();
          cb.current.onGone?.(e);
          return;
        }
        const directive = cb.current.onError?.(e, { source: 'restore', reused: false, fatal: false });
        if (directive === 'stop') halt();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [identity, bookmarkKey, projectId, applyRun, halt]);

  // Invalidate every in-flight response on unmount.
  useEffect(
    () => () => {
      epochRef.current += 1;
    },
    [],
  );

  const submit = useCallback(
    async (body: Record<string, unknown>) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setSubmitting(true);
      const epoch = (epochRef.current += 1);
      stoppedRef.current = false;
      attemptRef.current = 0;
      setRun(null);
      setReused(false);
      setStopped(false);
      try {
        const result = await api<{ run: AgentRun; reused: boolean }>(designerRunsPath(projectId), {
          method: 'POST',
          body,
        });
        if (epoch !== epochRef.current) return;
        if (bookmarkKey) writeRunBookmark(bookmarkKey, result.run.runId);
        setReused(result.reused);
        applyRun(result.run, { source: 'submit', reused: result.reused });
      } catch (e) {
        if (epoch !== epochRef.current) return;
        const directive = cb.current.onError?.(e, { source: 'submit', reused: false, fatal: false });
        if (directive === 'stop') halt();
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
      }
    },
    [projectId, bookmarkKey, applyRun, halt],
  );

  const refresh = useCallback(async () => {
    const current = runRef.current;
    if (!current || refreshingRef.current || stoppedRef.current) return;
    refreshingRef.current = true;
    const epoch = epochRef.current;
    try {
      const next = await api<AgentRun>(designerRunPath(projectId, current.runId));
      if (epoch !== epochRef.current) return;
      attemptRef.current += 1;
      applyRun(next, { source: 'poll', reused: false });
      if (maxPolls !== null && attemptRef.current >= maxPolls && isActiveAgentRunStatus(next.status)) {
        halt();
        cb.current.onExhausted?.();
      }
    } catch (e) {
      if (epoch !== epochRef.current) return;
      if (e instanceof ApiRequestError && e.status === 404) {
        if (bookmarkKey) clearRunBookmark(bookmarkKey);
        setRun(null);
        halt();
        cb.current.onGone?.(e);
        return;
      }
      const fatal = e instanceof ApiRequestError && (e.status === 401 || e.status === 403);
      const directive = cb.current.onError?.(e, { source: 'poll', reused: false, fatal });
      if (fatal || directive === 'stop') halt();
    } finally {
      refreshingRef.current = false;
    }
  }, [projectId, bookmarkKey, maxPolls, applyRun, halt]);

  const status = run?.status;
  useEffect(() => {
    if (!status || !isActiveAgentRunStatus(status) || stopped) return;
    const id = window.setInterval(() => {
      void refresh();
    }, pollMs);
    return () => window.clearInterval(id);
  }, [status, stopped, pollMs, refresh]);

  const reset = useCallback(() => {
    epochRef.current += 1;
    submittingRef.current = false;
    refreshingRef.current = false;
    stoppedRef.current = false;
    attemptRef.current = 0;
    if (bookmarkKey) clearRunBookmark(bookmarkKey);
    setRun(null);
    setSubmitting(false);
    setReused(false);
    setStopped(false);
  }, [bookmarkKey]);

  const phase: DesignerRunPhase = submitting ? 'submitting' : run ? run.status : 'idle';
  const activeRunId = run && isActiveAgentRunStatus(run.status) && !stopped ? run.runId : null;

  return { run, phase, submitting, reused, activeRunId, submit, reset };
}
