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
import {
  type AgentRun,
  type ImageInsertionContext,
  type InsertImageOperation,
} from '@seo/contracts';
import { api } from '../../../lib/api';
import {
  CLOSED_EMBEDDED_AGENT,
  EMBEDDED_AGENT_IMAGE_SOURCE_POLICY,
  IMAGE_INSERTION_CLARIFICATION_MESSAGE,
  embeddedAgentOutcomeFromError,
  embeddedAgentOutcomeFromRun,
  embeddedAgentRunPath,
  embeddedAgentSubmission,
  embeddedAgentWantsImageContext,
  type EmbeddedAgentState,
} from './embeddedAgent';
import type { ImageInsertionApplyResult } from '../editor/imageInsertion';

export const EMBEDDED_AGENT_DEFAULT_POLL_MS = 2000;
export const EMBEDDED_AGENT_MAX_POLLS = 60;
const UNAVAILABLE_INSERT_MESSAGE = "This action isn't available yet.";

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
  /** Builds the bounded image-insertion context from the live editor (R3.1). */
  buildImageInsertionContext?: () => ImageInsertionContext | null;
  /** Applies a returned insert_image operation through the editor (R3.1). */
  applyImageInsertion?: (operation: InsertImageOperation, expectedRevision: string) => ImageInsertionApplyResult;
  /** Called after an insertion is applied so the host can reveal the result. */
  onInserted?: () => void;
}

export interface EmbeddedAgentController {
  state: EmbeddedAgentState;
  instruction: string;
  setInstruction: (value: string) => void;
  submit: () => void;
  retry: () => void;
  /** Confirms and applies the current image-insertion candidate. */
  insert: () => void;
  /** R4.5B: confirms and runs the offered AI image generation. */
  generate: () => void;
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
    buildImageInsertionContext,
    applyImageInsertion,
    onInserted,
  } = options;

  const [state, setState] = useState<EmbeddedAgentState>(CLOSED_EMBEDDED_AGENT);
  const [instruction, setInstruction] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);

  const identity = `${projectId}:${contentId ?? 'new'}`;
  const identityRef = useRef(identity);
  const epochRef = useRef(0);
  const submittedRef = useRef('');
  const submittedContextRef = useRef<ImageInsertionContext | null>(null);
  const submittingRef = useRef(false);
  const applyingRef = useRef(false);

  // Reset on a document identity change so a response for the previous document
  // can never be shown against the new one.
  useEffect(() => {
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    epochRef.current += 1;
    submittingRef.current = false;
    applyingRef.current = false;
    submittedRef.current = '';
    submittedContextRef.current = null;
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
    } else if (outcome.kind === 'insertion') {
      setState({ status: 'insertion', instruction: text, message: outcome.message, operation: outcome.operation });
    } else if (outcome.kind === 'generation_required') {
      setState({
        status: 'generation',
        instruction: text,
        message: outcome.message,
        provider: outcome.provider,
        model: outcome.model,
      });
    } else if (outcome.kind === 'empty') {
      setState({ status: 'empty', instruction: text, message: outcome.message });
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

  /**
   * Starts one durable Designer run for `text`. `generationConfirmed` marks the
   * R4.5B follow-up: the image context then carries `generationConfirmed: true`
   * so the backend may actually generate. It is the single submission path for
   * both the first request and the confirmed generation.
   */
  const runInstruction = useCallback(
    (rawText: string, generationConfirmed: boolean) => {
      if (submittingRef.current) return;
      const text = rawText.trim();
      if (!text) return;
      const wantsImage = generationConfirmed || embeddedAgentWantsImageContext(text);
      let imageContext: ImageInsertionContext | null = null;
      if (wantsImage) {
        imageContext = contentId ? buildImageInsertionContext?.() ?? null : null;
        if (imageContext) {
          imageContext = generationConfirmed
            ? { ...imageContext, sourcePolicy: EMBEDDED_AGENT_IMAGE_SOURCE_POLICY, generationConfirmed: true }
            : { ...imageContext, sourcePolicy: EMBEDDED_AGENT_IMAGE_SOURCE_POLICY };
        }
        if (!imageContext) {
          // No reliable insertion point (or the document is not persisted yet).
          // Ask instead of inserting at an arbitrary position.
          epochRef.current += 1;
          applyingRef.current = false;
          submittedRef.current = text;
          submittedContextRef.current = null;
          setActiveRunId(null);
          setPollAttempt(0);
          setState({
            status: 'clarification',
            instruction: text,
            message: contentId
              ? IMAGE_INSERTION_CLARIFICATION_MESSAGE
              : 'Save this draft first so I can place an image in it.',
          });
          return;
        }
      }
      const submission = embeddedAgentSubmission({ projectId, contentId, revision, instruction: text, imageContext });
      if (!submission) return;
      submittingRef.current = true;
      applyingRef.current = false;
      submittedRef.current = text;
      submittedContextRef.current = imageContext;
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
          } else if (outcome.kind === 'empty') {
            setState({ status: 'empty', instruction: text, message: outcome.message });
          } else if (outcome.kind === 'clarification') {
            setState({ status: 'clarification', instruction: text, message: outcome.message });
          } else if (outcome.kind === 'generation_required') {
            setState({
              status: 'generation',
              instruction: text,
              message: outcome.message,
              provider: outcome.provider,
              model: outcome.model,
            });
          } else if (outcome.kind === 'insertion') {
            setState({ status: 'insertion', instruction: text, message: outcome.message, operation: outcome.operation });
          } else if (outcome.kind === 'error') {
            setState({ status: 'error', instruction: text, message: outcome.message, canRetry: outcome.canRetry });
          } else {
            setState({ status: 'completed', instruction: text, message: outcome.message });
          }
        } finally {
          submittingRef.current = false;
        }
      })();
    },
    [projectId, contentId, revision, applyRun, buildImageInsertionContext],
  );

  const submit = useCallback(() => {
    if (!canSubmit) return;
    runInstruction(instruction.trim(), false);
  }, [canSubmit, instruction, runInstruction]);

  /**
   * R4.5B: the explicit confirmation action for an offered AI generation. It
   * re-runs the same instruction with generation enabled and confirmed, so the
   * backend may actually generate. Guarded so a second click cannot start a
   * parallel generation, and blocked (with an honest reason) if the document
   * changed since the offer.
   */
  const generate = useCallback(() => {
    if (state.status !== 'generation') return;
    if (blockedReason) {
      setState({ status: 'error', instruction: state.instruction, message: blockedReason, canRetry: false });
      return;
    }
    runInstruction(state.instruction, true);
  }, [state, blockedReason, runInstruction]);

  const insert = useCallback(() => {
    if (state.status !== 'insertion' || applyingRef.current) return;
    applyingRef.current = true;
    const text = state.instruction;
    const expectedRevision = submittedContextRef.current?.revision ?? '';
    const result = applyImageInsertion?.(state.operation, expectedRevision);
    if (!result) {
      setState({ status: 'error', instruction: text, message: UNAVAILABLE_INSERT_MESSAGE, canRetry: false });
      return;
    }
    if (result.ok) {
      setState({ status: 'applied', instruction: text, message: 'Image inserted. Undo removes it.' });
      onInserted?.();
      return;
    }
    applyingRef.current = false;
    setState({
      status: 'error',
      instruction: text,
      message:
        result.reason === 'stale-revision'
          ? 'The document changed while I was finding the image. Please run the request again.'
          : "I couldn't place the image there. Put the cursor where you want it and try again.",
      canRetry: false,
    });
  }, [state, applyImageInsertion, onInserted]);

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
          } else if (outcome.kind === 'empty') {
            setState({ status: 'empty', instruction: submittedRef.current, message: outcome.message });
          } else if (outcome.kind === 'clarification') {
            setState({ status: 'clarification', instruction: submittedRef.current, message: outcome.message });
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
    applyingRef.current = false;
    submittedContextRef.current = null;
    setActiveRunId(null);
    setPollAttempt(0);
    setState(CLOSED_EMBEDDED_AGENT);
  }, []);

  const retry = useCallback(() => {
    submit();
  }, [submit]);

  return { state, instruction, setInstruction, submit, retry, insert, generate, close, canSubmit, blockedReason };
}
