/**
 * Embedded Agent lifecycle (R2.1).
 *
 * Owns the local submission state machine for the in-editor Agent surface and
 * nothing else: document identity, revision, dirty state and selection come from
 * `useEditorContext`, and the request shape comes from `embeddedAgent.ts`. It
 * submits through the existing durable Designer run endpoint and polls until the
 * run is terminal. It never applies a proposal, never navigates and never writes
 * content.
 *
 * Two safety properties are deliberate. First, submission is blocked while the
 * document is dirty (or not representable / not ready), because the reused
 * endpoint derives its revision from stored content and cannot accept the local
 * canonical snapshot; silently sending a stale document would be dishonest.
 * Second, every request captures the current document identity and an epoch:
 * a response whose epoch no longer matches (the user switched documents, closed
 * the surface or submitted again) is ignored instead of being shown against the
 * wrong document.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { type AgentRun } from '@seo/contracts';
import { api } from '../../../lib/api';
import {
  CLOSED_EMBEDDED_AGENT,
  embeddedAgentOutcomeFromError,
  embeddedAgentOutcomeFromRun,
  embeddedAgentRunPath,
  embeddedAgentSubmission,
  type EmbeddedAgentState,
} from './embeddedAgent';

export const EMBEDDED_AGENT_DEFAULT_POLL_MS = 2000;
export const EMBEDDED_AGENT_MAX_POLLS = 60;

export interface UseEmbeddedAgentOptions {
  projectId: string;
  contentId: string | null;
  revision: string | null;
  dirty: boolean;
  ready: boolean;
  unrepresentable: boolean;
  canEdit: boolean;
  configured: boolean;
  pollMs?: number;
}

export interface EmbeddedAgentController {
  state: EmbeddedAgentState;
  instruction: string;
  setInstruction: (value: string) => void;
  submit: () => void;
  retry: () => void;
  close: () => void;
  canSubmit: boolean;
  /** Why submission is unavailable, in product language; null when it is available. */
  blockedReason: string | null;
}

export function useEmbeddedAgent(options: UseEmbeddedAgentOptions): EmbeddedAgentController {
  const {
    projectId,
    contentId,
    revision,
    dirty,
    ready,
    unrepresentable,
    canEdit,
    configured,
    pollMs = EMBEDDED_AGENT_DEFAULT_POLL_MS,
  } = options;

  const [state, setState] = useState<EmbeddedAgentState>(CLOSED_EMBEDDED_AGENT);
  const [instruction, setInstruction] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);

  const identity = `${projectId}:${contentId ?? 'new'}`;
  const identityRef = useRef(identity);
  const epochRef = useRef(0);
  const submittedRef = useRef('');
  const submittingRef = useRef(false);

  // Reset on a document identity change so a response for the previous document
  // can never be shown against the new one.
  useEffect(() => {
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    epochRef.current += 1;
    submittingRef.current = false;
    submittedRef.current = '';
    setActiveRunId(null);
    setPollAttempt(0);
    setInstruction('');
    setState(CLOSED_EMBEDDED_AGENT);
  }, [identity]);

  // Invalidate every in-flight response on unmount so nothing is applied after
  // the workspace is gone.
  useEffect(
    () => () => {
      epochRef.current += 1;
    },
    [],
  );

  const applyRun = useCallback((run: AgentRun) => {
    const text = submittedRef.current;
    const outcome = embeddedAgentOutcomeFromRun(run);
    if (outcome.kind === 'working') {
      setActiveRunId(run.runId);
      setPollAttempt(0);
      setState({ status: 'working', instruction: text, message: outcome.message });
      return;
    }
    setActiveRunId(null);
    if (outcome.kind === 'completed') {
      setState({ status: 'completed', instruction: text, message: outcome.message });
    } else if (outcome.kind === 'clarification') {
      setState({ status: 'clarification', instruction: text, message: outcome.message });
    } else if (outcome.kind === 'unsupported') {
      setState({ status: 'unsupported', instruction: text, message: outcome.message });
    } else {
      setState({ status: 'error', instruction: text, message: outcome.message, canRetry: outcome.canRetry });
    }
  }, []);

  const blockedReason = (() => {
    if (!projectId) return 'No project context is available.';
    if (!ready) return 'The document is still loading.';
    if (unrepresentable) return 'This document cannot be represented for the Agent yet.';
    if (!configured) return 'The Agent is not configured for this project.';
    if (!canEdit) return 'Editors and above can ask the Agent.';
    if (dirty) return 'Save your changes first so the Agent works from the saved document.';
    return null;
  })();

  const busy = state.status === 'submitting' || state.status === 'working';
  const canSubmit = !blockedReason && instruction.trim().length > 0 && !busy;

  const submit = useCallback(() => {
    if (submittingRef.current) return;
    const submission = embeddedAgentSubmission({ projectId, contentId, revision, instruction });
    if (!submission || !canSubmit) return;
    submittingRef.current = true;
    const text = instruction.trim();
    submittedRef.current = text;
    const epoch = (epochRef.current += 1);
    setActiveRunId(null);
    setPollAttempt(0);
    setState({ status: 'submitting', instruction: text });
    void (async () => {
      try {
        const result = await api<{ run: AgentRun; reused: boolean }>(submission.path, {
          method: 'POST',
          body: submission.body,
        });
        if (epoch !== epochRef.current) return;
        applyRun(result.run);
      } catch (error) {
        if (epoch !== epochRef.current) return;
        const outcome = embeddedAgentOutcomeFromError(error);
        if (outcome.kind === 'unsupported') {
          setState({ status: 'unsupported', instruction: text, message: outcome.message });
        } else if (outcome.kind === 'error') {
          setState({ status: 'error', instruction: text, message: outcome.message, canRetry: outcome.canRetry });
        } else {
          setState({ status: 'completed', instruction: text, message: outcome.message });
        }
      } finally {
        submittingRef.current = false;
      }
    })();
  }, [projectId, contentId, revision, instruction, canSubmit, applyRun]);

  // Poll the active run while it is still working. The epoch captured at schedule
  // time invalidates a slow response after a document switch, close or resubmit.
  useEffect(() => {
    if (state.status !== 'working' || !activeRunId) return;
    const epoch = epochRef.current;
    const runId = activeRunId;
    const attempt = pollAttempt;
    const timer = window.setTimeout(() => {
      if (attempt >= EMBEDDED_AGENT_MAX_POLLS) {
        setActiveRunId(null);
        setState({
          status: 'error',
          instruction: submittedRef.current,
          message: 'The Agent is taking longer than expected. You can keep editing and try again.',
          canRetry: true,
        });
        return;
      }
      void (async () => {
        try {
          const run = await api<AgentRun>(embeddedAgentRunPath(projectId, runId));
          if (epoch !== epochRef.current) return;
          const outcome = embeddedAgentOutcomeFromRun(run);
          if (outcome.kind === 'working') setPollAttempt((value) => value + 1);
          else applyRun(run);
        } catch (error) {
          if (epoch !== epochRef.current) return;
          const outcome = embeddedAgentOutcomeFromError(error);
          if (outcome.kind === 'error' && outcome.canRetry && attempt < EMBEDDED_AGENT_MAX_POLLS) {
            setPollAttempt((value) => value + 1);
            return;
          }
          setActiveRunId(null);
          if (outcome.kind === 'unsupported') {
            setState({ status: 'unsupported', instruction: submittedRef.current, message: outcome.message });
          } else if (outcome.kind === 'error') {
            setState({ status: 'error', instruction: submittedRef.current, message: outcome.message, canRetry: outcome.canRetry });
          } else {
            setState({ status: 'completed', instruction: submittedRef.current, message: outcome.message });
          }
        }
      })();
    }, pollMs);
    return () => window.clearTimeout(timer);
  }, [state.status, activeRunId, pollAttempt, pollMs, projectId, applyRun]);

  const close = useCallback(() => {
    epochRef.current += 1;
    submittingRef.current = false;
    setActiveRunId(null);
    setPollAttempt(0);
    setState(CLOSED_EMBEDDED_AGENT);
  }, []);

  const retry = useCallback(() => {
    submit();
  }, [submit]);

  return { state, instruction, setInstruction, submit, retry, close, canSubmit, blockedReason };
}
