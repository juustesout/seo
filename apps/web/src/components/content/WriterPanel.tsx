/**
 * Writer panel for the Content Studio editor (W6, durable runs W7, revision
 * loop W8, Section Magic W10.1, research context W10.2).
 *
 * Starts a writer run for the article being edited, shows the AI-generated
 * plan as a PROPOSAL, requires an explicit human decision (Approve & Write /
 * Reject) and - once the approved run has written and deterministically
 * reviewed - rests on the W8 review session (`review_ready`) where the run is
 * previewed as a review-ready draft and the human can request a controlled
 * revision of specific sections or a W10.1 Section Magic transformation.
 *
 * Honesty rules honoured here:
 *   - the plan is presented as an AI-generated proposal, never as authority;
 *   - while the approved run is progressing (writing / revising / reviewing)
 *     the panel says exactly that and keeps polling the run until a resting
 *     state (awaiting_approval / review_ready / completed / rejected / failed)
 *     - it never claims a result is ready before the graph reports it, and
 *     polling stops at resting states;
 *   - `review_ready` is a resting hub, NOT terminal: at `review_ready` the
 *     human chooses what happens next (a controlled revise of the selected
 *     sections, or a Section Magic transformation of them). `completed` is
 *     terminal but only ever reached through the writer accept flow, which
 *     this surface does not expose;
 *   - Section Magic (W10.1) is always user-triggered and section-scoped: the
 *     human selects the sections and the action, the AI only ever transforms
 *     exactly those sections, and a magic round is reported as a proposal in
 *     progress (`revising` with the action surfaced from the run) - it is never
 *     auto-accepted or auto-published;
 *   - the result is previewed only: the writer flow never saves it to
 *     seo_content, never publishes and never schedules. Applying it to the
 *     document stays an explicit, separate human action that is not
 *     implemented here.
 *   - W7 durability: a run survives API restarts and browser refreshes. The
 *     panel keeps a per-content bookmark of the current run and reloads that
 *     exact run on mount - it never silently starts a new run, and a run that
 *     no longer exists simply falls back to the fresh start form.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  WriterAgentAction,
  WriterAgentDto,
  WriterAgentGoal,
  WriterEvidenceDto,
  WriterEvidenceSource,
  WriterEvidenceStatus,
  WriterIntelligenceDto,
  WriterIntelligenceSource,
  WriterRunDto,
  WriterRunStatus,
  WriterMagicAction,
  WriterMagicTone,
} from '@seo/contracts';
import { ApiRequestError, api } from '../../lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** Canonical Section Magic actions surfaced in the picker, mirroring the API
 *  vocabulary. change_tone requires a tone; custom requires an instruction;
 *  the rest take an optional instruction. */
const MAGIC_ACTIONS: Array<{ value: WriterMagicAction; label: string }> = [
  { value: 'improve', label: 'Improve' },
  { value: 'expand', label: 'Expand' },
  { value: 'shorten', label: 'Shorten' },
  { value: 'clarify', label: 'Clarify' },
  { value: 'change_tone', label: 'Change tone' },
  { value: 'add_examples', label: 'Add examples' },
  { value: 'improve_seo', label: 'Improve SEO' },
  { value: 'custom', label: 'Custom' },
];

const MAGIC_TONES: Array<{ value: WriterMagicTone; label: string }> = [
  { value: 'professional', label: 'Professional' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'authoritative', label: 'Authoritative' },
  { value: 'conversational', label: 'Conversational' },
  { value: 'formal', label: 'Formal' },
  { value: 'persuasive', label: 'Persuasive' },
  { value: 'practical', label: 'Practical' },
  { value: 'casual', label: 'Casual' },
];

/** Canonical W10.3 intelligence purposes, mirroring the API vocabulary. */
const INTELLIGENCE_PURPOSES: Array<{ value: string; label: string }> = [
  { value: 'deep_research', label: 'Deep research' },
  { value: 'planning', label: 'Planning' },
  { value: 'section_magic', label: 'Section magic' },
  { value: 'revision', label: 'Revision' },
];

function magicActionLabel(value: WriterMagicAction): string {
  return MAGIC_ACTIONS.find((a) => a.value === value)?.label ?? value;
}

/** Canonical W10.4 bounded agent goals, mirroring the API vocabulary. The goal
 *  only biases which allowlisted actions the coordinator prefers. */
const AGENT_GOALS: Array<{ value: WriterAgentGoal; label: string }> = [
  { value: 'improve_evidence', label: 'Improve evidence coverage' },
  { value: 'improve_seo', label: 'Improve SEO quality' },
  { value: 'improve_clarity', label: 'Improve clarity' },
  { value: 'deep_research', label: 'Deep research' },
  { value: 'section_improvement', label: 'Improve selected sections' },
];

/** Human labels for the fixed W10.4 agent action allowlist. */
const AGENT_ACTION_LABELS: Record<WriterAgentAction, string> = {
  research: 'Research',
  intelligence: 'Intelligence',
  magic: 'Section Magic',
  revision: 'Revision',
  review: 'Review',
  finish: 'Finish',
};

function agentGoalLabel(value: WriterAgentGoal): string {
  return AGENT_GOALS.find((g) => g.value === value)?.label ?? value;
}

/** Resting statuses the panel shows without polling. review_ready is NOT in
 *  this set: it is the W8 review-session hub (a human decision is required),
 *  and completed/rejected/failed are terminal. */
const TERMINAL: ReadonlySet<WriterRunStatus> = new Set(['completed', 'rejected', 'failed']);

/** In-progress statuses that keep the panel polling for a resting state. */
const PROGRESS: ReadonlySet<WriterRunStatus> = new Set(['writing', 'revising', 'reviewing']);

const SELECT_CLASS =
  'h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50';

const CHECKBOX_CLASS = 'size-4 accent-primary';

type PillVariant = 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline';

/** Map the panel's honest status vocabulary (ok/err/busy/neutral) to a Badge
 *  variant. Anything unrecognized stays neutral so a status the UI has never
 *  classified is never painted as success. */
function pillVariant(cls: string): PillVariant {
  switch (cls) {
    case 'ok':
      return 'success';
    case 'err':
      return 'destructive';
    case 'busy':
      return 'warning';
    default:
      return 'outline';
  }
}

/**
 * Local bookmark of the run belonging to this project+content, so a browser
 * refresh reloads the SAME run instead of silently starting a new one. It is
 * only a hint: the API re-authorizes the run against project/content on every
 * read, and a stale/unknown id simply falls back to the start form.
 */
function storageKey(projectId: string, contentId: string): string {
  return `seo.writer.run.${projectId}.${contentId}`;
}

function runPath(projectId: string, contentId: string, runId: string): string {
  return `/projects/${projectId}/content/${contentId}/writer/${runId}`;
}

function statusClass(status: WriterRunStatus): string {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'failed':
    case 'rejected':
      return 'err';
    case 'writing':
    case 'revising':
    case 'reviewing':
    case 'awaiting_approval':
    case 'starting':
    case 'gathering_context':
    case 'planning':
      return 'busy';
    default:
      return '';
  }
}

/** Stable plan-order sort of selected section ids (mirrors the API). */
function sortedSectionIds(sectionIds: string[]): string[] {
  return [...sectionIds].sort((a, b) => {
    const ai = Number(/^section_(\d+)$/.exec(a)?.[1]);
    const bi = Number(/^section_(\d+)$/.exec(b)?.[1]);
    return ai - bi;
  });
}

/** Root card that frames every writer surface, matching the AI-panel accent. */
function WriterShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-testid="writer-panel"
      className="my-3 flex flex-col rounded-[10px] border border-l-[3px] border-l-primary bg-card p-3.5 text-card-foreground"
    >
      {children}
    </div>
  );
}

/** Inset notice used for the honest error / success / neutral banners. */
function Banner({
  tone = 'info',
  className,
  children,
}: {
  tone?: 'info' | 'error' | 'success';
  className?: string;
  children: React.ReactNode;
}) {
  const tones = {
    info: 'border-l-warning text-muted-foreground',
    error: 'border-l-destructive text-destructive',
    success: 'border-l-success text-foreground',
  } as const;
  return (
    <div className={cn('rounded-md border border-l-[3px] bg-card px-3.5 py-2.5', tones[tone], className)}>
      {children}
    </div>
  );
}

/** Shared proposal header: a badge, an honest description and an optional
 *  action pinned to the end of the row. */
function ProposalHead({
  label,
  description,
  action,
}: {
  label: string;
  description: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="warning">{label}</Badge>
      <span className="text-xs text-muted-foreground">{description}</span>
      {action ? <span className="ml-auto">{action}</span> : null}
    </div>
  );
}

interface WriterPanelProps {
  projectId: string;
  contentId: string;
  /** Content title, used as the run's topic when no instruction is given. */
  defaultTopic: string;
  /** Content target keyword, passed to the writer when present. */
  defaultKeyword?: string;
  /** Poll cadence while an approved run is writing (tests override this). */
  pollMs?: number;
}

export function WriterPanel({ projectId, contentId, defaultTopic, defaultKeyword, pollMs = 1200 }: WriterPanelProps) {
  const [instruction, setInstruction] = useState('');
  const [run, setRun] = useState<WriterRunDto | null>(null);
  const [startBusy, setStartBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [rejectReason, setRejectReason] = useState('');
  const [reviseSections, setReviseSections] = useState<string[]>([]);
  const [reviseInstruction, setReviseInstruction] = useState('');
  const [magicAction, setMagicAction] = useState<WriterMagicAction>('improve');
  const [magicTone, setMagicTone] = useState<WriterMagicTone>('professional');
  const [magicInstruction, setMagicInstruction] = useState('');
  const [researchBusy, setResearchBusy] = useState(false);
  const [intelligenceBusy, setIntelligenceBusy] = useState(false);
  const [intelligencePurpose, setIntelligencePurpose] = useState('deep_research');
  const [intelligenceFocus, setIntelligenceFocus] = useState('');
  const [intelligenceSections, setIntelligenceSections] = useState<string[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentGoal, setAgentGoal] = useState<WriterAgentGoal>('improve_clarity');
  const [agentInstruction, setAgentInstruction] = useState('');
  const [agentSections, setAgentSections] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const runRef = useRef<WriterRunDto | null>(null);
  runRef.current = run;

  // W7: after a refresh the panel remounts with no run in memory. If this
  // project/content has a known run, reload that exact run (the API resumes an
  // interrupted `writing` run as a side effect of the read) instead of letting
  // the user believe the old run vanished and starting a duplicate. A run that
  // no longer exists (404) falls back to the fresh start form.
  useEffect(() => {
    let cancelled = false;
    const stored = window.localStorage.getItem(storageKey(projectId, contentId));
    if (!stored) {
      setRestoring(false);
      return;
    }
    (async () => {
      try {
        const next = await api<WriterRunDto>(runPath(projectId, contentId, stored));
        if (!cancelled) setRun(next);
      } catch (e) {
        if (!cancelled && e instanceof ApiRequestError && e.status === 404) {
          window.localStorage.removeItem(storageKey(projectId, contentId));
        } else if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, contentId]);

  const refresh = useCallback(async () => {
    const current = runRef.current;
    if (!current) return;
    try {
      const next = await api<WriterRunDto>(runPath(projectId, contentId, current.runId));
      setRun(next);
      if (TERMINAL.has(next.status)) setFatal(null);
    } catch (e) {
      // The run is no longer readable (should be rare now that runs are
      // durable). Stop polling and surface the reason; the user can reset.
      setFatal(e instanceof Error ? e.message : String(e));
    }
  }, [projectId, contentId]);

  // Poll only while the run is progressing (writing after approve; revising /
  // reviewing after a revise resume) OR a bounded W10.4 agent loop is running
  // on top of the resting review_ready state; stop at true resting/terminal
  // states.
  useEffect(() => {
    const current = runRef.current;
    const agentRunning = current?.agent?.status === 'running';
    if (!current || (!PROGRESS.has(current.status) && !agentRunning) || fatal) return;
    const id = window.setInterval(() => {
      void refresh();
    }, pollMs);
    return () => window.clearInterval(id);
  }, [run, fatal, pollMs, refresh]);

  const start = async () => {
    setStartBusy(true);
    setError(null);
    setFatal(null);
    setRejectReason('');
    try {
      const created = await api<WriterRunDto>(`/projects/${projectId}/content/${contentId}/writer`, {
        method: 'POST',
        body: { instruction: instruction.trim() || undefined },
      });
      setRun(created);
      window.localStorage.setItem(storageKey(projectId, contentId), created.runId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStartBusy(false);
    }
  };

  const decide = async (decision: 'approve' | 'reject') => {
    const current = runRef.current;
    if (!current || actionBusy) return;
    setActionBusy(true);
    setError(null);
    setFatal(null);
    try {
      const next = await api<WriterRunDto>(`${runPath(projectId, contentId, current.runId)}/approval`, {
        method: 'POST',
        body: decision === 'approve' ? { decision: 'approve' } : { decision: 'reject', reason: rejectReason.trim() || undefined },
      });
      setRun(next);
      if (decision === 'reject') setRejectReason('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  };

  const toggleReviseSection = (sectionId: string) => {
    setReviseSections((prev) =>
      prev.includes(sectionId) ? prev.filter((id) => id !== sectionId) : [...prev, sectionId],
    );
  };

  const reviseSelected = async () => {
    const current = runRef.current;
    if (!current || actionBusy) return;
    const trimmed = reviseInstruction.trim();
    if (reviseSections.length === 0 || !trimmed) return;
    setActionBusy(true);
    setError(null);
    setFatal(null);
    try {
      const sectionIds = sortedSectionIds(reviseSections);
      const next = await api<WriterRunDto>(`${runPath(projectId, contentId, current.runId)}/revise`, {
        method: 'POST',
        body: { action: 'revise', sectionIds, instruction: trimmed },
      });
      setRun(next);
      setReviseSections([]);
      setReviseInstruction('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  };

  /** W10.1 Section Magic: posts the human-selected sections + action (with the
   *  optional bounded instruction, or a tone for change_tone) to the magic
   *  endpoint. The AI transforms exactly those sections; the run goes `revising`
   *  and this panel polls to the next review_ready proposal - nothing is
   *  accepted or published automatically. */
  const applyMagic = async () => {
    const current = runRef.current;
    if (!current || actionBusy) return;
    const sectionIds = sortedSectionIds(reviseSections);
    if (sectionIds.length === 0) return;
    const body: Record<string, unknown> = { action: magicAction, sectionIds };
    if (magicAction === 'change_tone') {
      body.tone = magicTone;
    } else {
      const trimmed = magicInstruction.trim();
      if (magicAction === 'custom' && !trimmed) return;
      if (trimmed) body.instruction = trimmed;
    }
    setActionBusy(true);
    setError(null);
    setFatal(null);
    try {
      const next = await api<WriterRunDto>(`${runPath(projectId, contentId, current.runId)}/magic`, {
        method: 'POST',
        body,
      });
      setRun(next);
      setReviseSections([]);
      setMagicInstruction('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActionBusy(false);
    }
  };

  /** W10.2 research gather: posts to the research endpoint so the writer
   *  collects bounded, project-scoped evidence for this draft. It is an honest,
   *  synchronous gather - the response carries the resting review_ready DTO with
   *  `evidence` filled in. Research never changes the article, never applies the
   *  evidence and never leaves review_ready. */
  const gatherResearch = async () => {
    const current = runRef.current;
    if (!current || actionBusy || researchBusy) return;
    setResearchBusy(true);
    setError(null);
    setFatal(null);
    try {
      const next = await api<WriterRunDto>(`${runPath(projectId, contentId, current.runId)}/research`, {
        method: 'POST',
        body: {},
      });
      setRun(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResearchBusy(false);
    }
  };

  /** W10.3 intelligence gather: posts to the intelligence endpoint so the
   *  writer combines this project's existing sources into bounded, untrusted
   *  findings for this draft. It is an honest, synchronous gather - the response
   *  carries the resting review_ready DTO with `intelligence` filled in. It
   *  never changes the article, never applies a finding and never leaves
   *  review_ready; it does nothing automatically. */
  const gatherIntelligence = async () => {
    const current = runRef.current;
    if (!current || actionBusy || intelligenceBusy) return;
    setIntelligenceBusy(true);
    setError(null);
    setFatal(null);
    try {
      const focus = intelligenceFocus.trim();
      const next = await api<WriterRunDto>(`${runPath(projectId, contentId, current.runId)}/intelligence`, {
        method: 'POST',
        body: {
          purpose: intelligencePurpose,
          ...(focus ? { focus } : {}),
          ...(intelligenceSections.length > 0 ? { sections: intelligenceSections } : {}),
        },
      });
      setRun(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIntelligenceBusy(false);
    }
  };

  const toggleIntelligenceSection = (sectionId: string) => {
    setIntelligenceSections((prev) =>
      prev.includes(sectionId) ? prev.filter((s) => s !== sectionId) : [...prev, sectionId],
    );
  };

  /** W10.4 bounded agent: posts the human-chosen goal (with the optional,
   *  bounded, untrusted instruction and optional section focus) to the agent
   *  endpoint. The coordinator only ever chooses from its fixed allowlist,
   *  stays within hard step/action budgets and never applies or publishes the
   *  article. The run stays review_ready while `agent.status` is `running`; the
   *  panel polls until the agent reaches a terminal status. */
  const startAgent = async () => {
    const current = runRef.current;
    if (!current || actionBusy || agentBusy) return;
    setAgentBusy(true);
    setError(null);
    setFatal(null);
    try {
      const instruction = agentInstruction.trim();
      const next = await api<WriterRunDto>(`${runPath(projectId, contentId, current.runId)}/agent`, {
        method: 'POST',
        body: {
          goal: agentGoal,
          ...(instruction ? { instruction } : {}),
          ...(agentSections.length > 0 ? { sections: sortedSectionIds(agentSections) } : {}),
        },
      });
      setRun(next);
      setAgentInstruction('');
      setAgentSections([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAgentBusy(false);
    }
  };

  const toggleAgentSection = (sectionId: string) => {
    setAgentSections((prev) =>
      prev.includes(sectionId) ? prev.filter((s) => s !== sectionId) : [...prev, sectionId],
    );
  };

  const reset = () => {
    setRun(null);
    setError(null);
    setFatal(null);
    setRejectReason('');
    setReviseSections([]);
    setReviseInstruction('');
    setMagicInstruction('');
    setIntelligenceFocus('');
    setIntelligenceSections([]);
    setAgentInstruction('');
    setAgentSections([]);
    window.localStorage.removeItem(storageKey(projectId, contentId));
  };

  if (!run && restoring) {
    return (
      <WriterShell>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong>Writer</strong>
          <span className="text-xs text-muted-foreground">Restoring the writer run for this article…</span>
        </div>
      </WriterShell>
    );
  }

  if (!run) {
    return (
      <WriterShell>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong>Writer</strong>
          <span className="text-xs text-muted-foreground">
            Drafts an article from this project's context, then waits for your approval.
          </span>
        </div>
        <p className="mb-4 mt-2 text-[13px] text-muted-foreground">
          Leave the instruction empty to use this article's title as the topic. The result is a review-ready draft for
          this document - it is never saved or published automatically.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            className="min-w-[320px] flex-1"
            type="text"
            placeholder={`Instruction (optional) — e.g. write about ${defaultTopic || 'this topic'}`}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            disabled={startBusy}
          />
          <Button disabled={startBusy} onClick={() => void start()}>
            {startBusy ? 'Planning…' : 'Start writer run'}
          </Button>
        </div>
        {error && <Banner tone="error" className="mt-2">{error}</Banner>}
      </WriterShell>
    );
  }

  const { status, plan, review, note, evidence, intelligence, agent } = run;
  const agentRunning = agent?.status === 'running';
  const agentBusyState = actionBusy || researchBusy || agentRunning;

  return (
    <WriterShell>
      <div className="flex flex-wrap items-center gap-2">
        <strong>Writer</strong>
        <Badge variant={pillVariant(statusClass(status))}>{status}</Badge>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{run.runId}</span>
      </div>

      {error && <Banner tone="error" className="mt-2">{error}</Banner>}
      {fatal && (
        <Banner tone="error" className="mt-2">
          {fatal}
          <Button variant="outline" size="sm" className="ml-2.5" onClick={reset}>
            Start a new run
          </Button>
        </Banner>
      )}

      {status === 'awaiting_approval' && plan && (
        <PlanReview plan={plan} rejectReason={rejectReason} onReasonChange={setRejectReason} busy={actionBusy} onApprove={() => void decide('approve')} onReject={() => void decide('reject')} />
      )}

      {status === 'writing' && (
        <p className="mt-2 text-sm text-muted-foreground">
          Writer is writing… the approved sections are being written and reviewed. This article is not saved until you
          decide what to do with the result.
        </p>
      )}

      {status === 'revising' && (
        <p className="mt-2 text-sm text-muted-foreground">
          {run.magicAction
            ? `Writer is applying ${magicActionLabel(run.magicAction)} to the selected section(s)… the result will be a fresh review-ready proposal and is never accepted or published automatically.`
            : 'Writer is revising the selected sections… this article is not saved until you decide what to do with the result.'}
        </p>
      )}

      {status === 'reviewing' && (
        <p className="mt-2 text-sm text-muted-foreground">
          Writer is re-reviewing the revised draft…
        </p>
      )}

      {status === 'review_ready' && review && plan && (
        <>
          <ReviewResult review={review} planTitle={plan.title} revisionCount={run.revisionCount} />
          <ResearchControls evidence={evidence} busy={actionBusy || researchBusy || agentRunning} onGather={() => void gatherResearch()} />
          <IntelligenceControls
            intelligence={intelligence}
            sections={plan.sections}
            purpose={intelligencePurpose}
            focus={intelligenceFocus}
            selected={intelligenceSections}
            busy={actionBusy || intelligenceBusy || agentRunning}
            onPurposeChange={setIntelligencePurpose}
            onFocusChange={setIntelligenceFocus}
            onToggleSection={toggleIntelligenceSection}
            onGather={() => void gatherIntelligence()}
          />
          <ReviewSessionControls
            sections={plan.sections}
            selected={reviseSections}
            instruction={reviseInstruction}
            busy={agentBusyState}
            onToggle={toggleReviseSection}
            onInstructionChange={setReviseInstruction}
            onRevise={() => void reviseSelected()}
          />
          <MagicControls
            sections={plan.sections}
            selected={reviseSections}
            action={magicAction}
            tone={magicTone}
            instruction={magicInstruction}
            busy={agentBusyState}
            hasResearch={Boolean(evidence && evidence.sources.some((s) => s.items.length > 0))}
            onActionChange={setMagicAction}
            onToneChange={setMagicTone}
            onInstructionChange={setMagicInstruction}
            onApply={() => void applyMagic()}
          />
          <AgentControls
            agent={agent}
            sections={plan.sections}
            goal={agentGoal}
            instruction={agentInstruction}
            selected={agentSections}
            busy={agentBusy || actionBusy || researchBusy || agentRunning}
            onGoalChange={setAgentGoal}
            onInstructionChange={setAgentInstruction}
            onToggleSection={toggleAgentSection}
            onStart={() => void startAgent()}
          />
        </>
      )}

      {status === 'completed' && review && plan && (
        <ReviewResult review={review} planTitle={plan.title} revisionCount={run.revisionCount} />
      )}

      {status === 'rejected' && (
        <Banner className="mt-2">
          The proposed plan was rejected{note ? ` — ${note}` : ''}. Nothing was written.
          <Button variant="outline" size="sm" className="ml-2.5" onClick={reset}>
            Start a new run
          </Button>
        </Banner>
      )}

      {status === 'failed' && (
        <Banner tone="error" className="mt-2">
          {note ?? 'The writer run failed.'}
          <Button variant="outline" size="sm" className="ml-2.5" onClick={reset}>
            Start a new run
          </Button>
        </Banner>
      )}
    </WriterShell>
  );
}

/** Plan review with the two explicit human actions. There is no implicit
 *  approval and nothing auto-submits. */
function PlanReview({
  plan,
  rejectReason,
  onReasonChange,
  busy,
  onApprove,
  onReject,
}: {
  plan: NonNullable<WriterRunDto['plan']>;
  rejectReason: string;
  onReasonChange: (reason: string) => void;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="mt-2.5">
      <ProposalHead
        label="AI-generated proposal"
        description="Review the proposed outline below - the article is only written after you approve it."
      />
      <h2 className="mb-1 mt-2.5 text-[15px] font-semibold">{plan.title}</h2>
      {plan.metaDescription && <p className="mb-4 text-[13px] text-muted-foreground">{plan.metaDescription}</p>}
      {plan.sections.map((s, i) => (
        <div key={i} className="mt-2 border-t pt-2">
          <h3 className="mb-1 text-sm font-semibold">
            {i + 1}. {s.heading}
          </h3>
          {s.keyPoints.length > 0 && (
            <ul className="my-1 list-disc pl-5 text-[13px] text-muted-foreground">
              {s.keyPoints.map((k, j) => (
                <li key={j}>{k}</li>
              ))}
            </ul>
          )}
          {s.suggestedKeywords.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Suggested keywords: {s.suggestedKeywords.join(', ')}
            </p>
          )}
        </div>
      ))}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={onApprove}>
          Approve &amp; Write
        </Button>
        <Button variant="outline" className="text-destructive" disabled={busy} onClick={onReject}>
          Reject
        </Button>
        <Input
          className="min-w-[240px] flex-1"
          type="text"
          placeholder="Optional reason for rejection…"
          value={rejectReason}
          onChange={(e) => onReasonChange(e.target.value)}
          disabled={busy}
        />
      </div>
      {busy && <p className="mt-2 text-sm text-muted-foreground">Submitting your decision…</p>}
    </div>
  );
}

/** Review-ready result of a run: canonical document + deterministic SEO
 *  evaluation. Preview only - never auto-saved or auto-published. */
function ReviewResult({
  review,
  planTitle,
  revisionCount,
}: {
  review: NonNullable<WriterRunDto['review']>;
  planTitle: string;
  revisionCount?: number;
}) {
  const passed = review.seo.checks.filter((c) => c.status === 'pass').length;
  return (
    <div className="mt-2.5">
      <Banner tone="success">
        The writer produced a review-ready draft. It is previewed below and was NOT saved to this document or published
        anywhere.
      </Banner>
      <div className="my-2.5 flex flex-wrap items-center gap-3">
        <h2 className="m-0 text-[15px] font-semibold">{planTitle}</h2>
        <Badge variant="success">SEO {Math.round(review.seo.score)}/100</Badge>
        {typeof revisionCount === 'number' && revisionCount > 0 && (
          <Badge variant="outline">Revision {revisionCount}</Badge>
        )}
        <span className="text-xs text-muted-foreground">
          Deterministic evaluation — {passed} of {review.seo.checks.length} checks passing.
        </span>
      </div>
      <div className="rounded-lg border bg-card p-4">
        <div className="article-body" dangerouslySetInnerHTML={{ __html: review.contentHtml }} />
      </div>
      <p className="text-xs text-muted-foreground">
        To use this draft in the editor you would explicitly apply it as content - this panel does not do that for you.
      </p>
    </div>
  );
}

/** W10.2 Research context block. Explicit, honest: shows which research
 *  evidence the human gathered for this draft as untrusted reference material
 *  ("research context"), never as verified facts, and never auto-applies it.
 *  Empty / not configured / unavailable sources are reported exactly as they
 *  are - nothing is fabricated. */
function ResearchControls({
  evidence,
  busy,
  onGather,
}: {
  evidence: WriterRunDto['evidence'];
  busy: boolean;
  onGather: () => void;
}) {
  const itemCount = evidence ? evidence.sources.reduce((sum, s) => sum + s.items.length, 0) : 0;
  return (
    <div className="mt-3.5 flex flex-col">
      <ProposalHead
        label="Research context"
        description="Reference material gathered from this project for the draft - it is not verified facts, it is never applied automatically, and it is offered to later revisions only as untrusted context."
      />
      {busy && <p className="mt-2 text-sm text-muted-foreground">Gathering evidence…</p>}
      {!busy && !evidence && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="m-0 flex-1 text-sm text-muted-foreground">
            No research context has been gathered for this draft yet.
          </p>
          <Button variant="outline" onClick={onGather} disabled={busy}>
            Gather evidence
          </Button>
        </div>
      )}
      {!busy && evidence && (
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-2.5">
            <Badge variant="success">
              {itemCount} item{itemCount === 1 ? '' : 's'}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Gathered {evidence.gatheredAt ? new Date(evidence.gatheredAt).toLocaleString() : ''}
            </span>
            <Button variant="outline" size="sm" onClick={onGather} disabled={busy}>
              Gather again
            </Button>
          </div>
          {evidence.sources.map((source) => (
            <ResearchSourceSection key={source.source} source={source.source} status={source.status} note={source.note} items={source.items} />
          ))}
        </div>
      )}
    </div>
  );
}

function ResearchSourceSection({
  source,
  status,
  note,
  items,
}: {
  source: WriterEvidenceSource;
  status: WriterEvidenceStatus;
  note: string | null;
  items: WriterEvidenceDto['sources'][number]['items'];
}) {
  const label: Record<WriterEvidenceSource, string> = {
    knowledge: 'Knowledge',
    existing_content: 'Existing content',
    search: 'Search',
    intelligence: 'Intelligence',
  };
  return (
    <div className="mt-2 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-[13px]">{label[source]}</strong>
        <Badge variant={pillVariant(statusClassFromEvidence(status))}>{status}</Badge>
      </div>
      {note && (
        <p className="my-0.5 text-xs text-muted-foreground">
          {note}
        </p>
      )}
      {items.length === 0 && status !== 'available' && (
        <p className="my-1 text-xs text-muted-foreground">
          No items gathered from this source.
        </p>
      )}
      {items.map((item) => (
        <div key={item.id} className="my-1.5">
          <div className="flex flex-wrap items-baseline gap-1.5">
            {item.title ? <strong className="text-[13px]">{item.title}</strong> : null}
            {item.url ? (
              <a className="text-xs text-muted-foreground" href={item.url} target="_blank" rel="noreferrer">
                source
              </a>
            ) : null}
            {item.source === 'intelligence' && item.metadata ? (
              <span className="font-mono text-xs text-muted-foreground">
                {typeof item.metadata.volume === 'number' ? `vol ${item.metadata.volume}` : ''}
                {typeof item.metadata.difficulty === 'number' ? ` diff ${item.metadata.difficulty}` : ''}
                {typeof item.metadata.cpc === 'number' ? ` cpc ${item.metadata.cpc}` : ''}
              </span>
            ) : null}
          </div>
          {item.text ? <p className="my-0.5 text-[13px] text-muted-foreground">{item.text}</p> : null}
          {!item.text && item.source !== 'intelligence' && (
            <p className="my-0.5 text-xs text-muted-foreground">
              Untrusted reference item — see its source above.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function statusClassFromEvidence(status: WriterEvidenceStatus): string {
  switch (status) {
    case 'available':
      return 'ok';
    case 'unavailable':
      return 'err';
    case 'empty':
    case 'not_configured':
      return '';
    default:
      return '';
  }
}

/** W10.3 combined-intelligence block. Explicit, honest and inert: it combines
 *  this project's existing sources into untrusted reference findings, reports
 *  every source status exactly (available / empty / not configured /
 *  unavailable - nothing fabricated) and never auto-applies a finding or
 *  changes the workflow. A later revision/magic may use it only as explicit
 *  untrusted context. */
function IntelligenceControls({
  intelligence,
  sections,
  purpose,
  focus,
  selected,
  busy,
  onPurposeChange,
  onFocusChange,
  onToggleSection,
  onGather,
}: {
  intelligence: WriterIntelligenceDto | null;
  sections: Array<{ heading: string }>;
  purpose: string;
  focus: string;
  selected: string[];
  busy: boolean;
  onPurposeChange: (value: string) => void;
  onFocusChange: (value: string) => void;
  onToggleSection: (sectionId: string) => void;
  onGather: () => void;
}) {
  const findingCount = intelligence ? intelligence.findings.length : 0;
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3.5 flex flex-col">
      <ProposalHead
        label="Intelligence"
        description="Combined signals from this project's own sources. They are not verified facts, they are never applied automatically, and later revisions may use them only as untrusted reference material."
        action={
          <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide intelligence' : intelligence ? `Intelligence (${findingCount})` : 'Deep research'}
          </Button>
        }
      />

      {open && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              className={SELECT_CLASS}
              value={purpose}
              onChange={(e) => onPurposeChange(e.target.value)}
              disabled={busy}
              aria-label="Intelligence purpose"
            >
              {INTELLIGENCE_PURPOSES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <Input
              className="min-w-[200px] flex-1"
              type="text"
              value={focus}
              placeholder="Focus (optional)"
              onChange={(e) => onFocusChange(e.target.value)}
              disabled={busy}
            />
            <Button variant="outline" onClick={onGather} disabled={busy}>
              {busy ? 'Gathering intelligence…' : intelligence ? 'Gather again' : 'Gather intelligence'}
            </Button>
          </div>

          {sections.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Focus sections (optional):
              </span>
              {sections.map((section, index) => {
                const sectionId = `section_${index}`;
                const active = selected.includes(sectionId);
                return (
                  <label key={sectionId} className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className={CHECKBOX_CLASS}
                      checked={active}
                      disabled={busy}
                      onChange={() => onToggleSection(sectionId)}
                    />
                    {section.heading}
                  </label>
                );
              })}
            </div>
          )}

          {busy && (
            <p className="mt-2 text-sm text-muted-foreground">
              Gathering intelligence…
            </p>
          )}

          {!busy && !intelligence && (
            <p className="mt-2 text-sm text-muted-foreground">
              No combined intelligence has been gathered for this draft yet.
            </p>
          )}

          {!busy && intelligence && (
            <div className="mt-2">
              <div className="flex flex-wrap items-center gap-2.5">
                <Badge
                  variant={pillVariant(
                    statusClassFromEvidence(
                      intelligence.status === 'available' || intelligence.status === 'partial' ? 'available' : intelligence.status === 'unavailable' ? 'unavailable' : 'empty',
                    ),
                  )}
                >
                  {intelligence.status}
                </Badge>
                <Badge variant="success">
                  {findingCount} finding{findingCount === 1 ? '' : 's'}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  Gathered {intelligence.gatheredAt ? new Date(intelligence.gatheredAt).toLocaleString() : ''}
                </span>
              </div>
              {intelligence.note && (
                <p className="text-xs text-muted-foreground">
                  {intelligence.note}
                </p>
              )}
              {intelligence.sources.map((source) => (
                <IntelligenceSourceSection key={source.source} source={source.source} status={source.status} note={source.note} findingCount={source.findingCount} />
              ))}
              {intelligence.findings.map((finding) => (
                <div key={finding.id} className="mt-2 border-t pt-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{finding.type}</Badge>
                    <span className="text-xs text-muted-foreground">
                      untrusted reference
                    </span>
                  </div>
                  <p className="my-1 text-[13px] text-muted-foreground">
                    {finding.summary}
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function IntelligenceSourceSection({
  source,
  status,
  note,
  findingCount,
}: {
  source: WriterIntelligenceSource;
  status: WriterIntelligenceDto['sources'][number]['status'];
  note: string | null;
  findingCount: number;
}) {
  const label: Record<WriterIntelligenceSource, string> = {
    knowledge: 'Knowledge',
    existing_content: 'Existing content',
    dataforseo: 'Keyword demand',
    gsc: 'Search Console',
    content_intelligence: 'Content intelligence',
  };
  return (
    <div className="mt-2 border-t pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-[13px]">{label[source]}</strong>
        <Badge variant={pillVariant(statusClassFromEvidence(status))}>{status}</Badge>
        <span className="text-xs text-muted-foreground">
          {findingCount} finding{findingCount === 1 ? '' : 's'}
        </span>
      </div>
      {note && (
        <p className="my-0.5 text-xs text-muted-foreground">
          {note}
        </p>
      )}
      {findingCount === 0 && status !== 'available' && (
        <p className="my-1 text-xs text-muted-foreground">
          No findings gathered from this source.
        </p>
      )}
    </div>
  );
}

/** W10.4 Advanced Agent controls. The human picks a bounded goal (optional
 *  untrusted instruction and section focus) and starts one bounded coordination
 *  run. The coordinator only ever chooses from its fixed action allowlist, stays
 *  within the hard step/action budgets and never applies or publishes. While it
 *  runs the panel reports step progress and polls; a `limit_reached`/`failed`
 *  terminal state is shown honestly and nothing restarts automatically. */
function AgentControls({
  agent,
  sections,
  goal,
  instruction,
  selected,
  busy,
  onGoalChange,
  onInstructionChange,
  onToggleSection,
  onStart,
}: {
  agent: WriterAgentDto | null;
  sections: Array<{ heading: string }>;
  goal: WriterAgentGoal;
  instruction: string;
  selected: string[];
  busy: boolean;
  onGoalChange: (value: WriterAgentGoal) => void;
  onInstructionChange: (value: string) => void;
  onToggleSection: (sectionId: string) => void;
  onStart: () => void;
}) {
  const [open, setOpen] = useState(false);
  const running = agent?.status === 'running';
  const statusLabel = agent ? agent.status : 'idle';
  const statusPill =
    agent?.status === 'completed' || agent?.status === 'limit_reached'
      ? 'ok'
      : agent?.status === 'failed'
        ? 'error'
        : running
          ? 'busy'
          : '';
  return (
    <div className="mt-3.5 flex flex-col">
      <ProposalHead
        label="Advanced Agent"
        description="A bounded coordinator that only chooses from a fixed allowlist (research, intelligence, Section Magic, revision, review, finish). It never adds tools, never bypasses the step/action limits and never applies or publishes the article."
        action={
          <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide agent' : agent ? `Agent (${statusLabel})` : 'Start agent'}
          </Button>
        }
      />

      {open && (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              className={SELECT_CLASS}
              value={goal}
              onChange={(e) => onGoalChange(e.target.value as WriterAgentGoal)}
              disabled={busy}
              aria-label="Agent goal"
            >
              {AGENT_GOALS.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
            <Input
              className="min-w-[220px] flex-1"
              type="text"
              value={instruction}
              placeholder="Instruction (optional)"
              onChange={(e) => onInstructionChange(e.target.value)}
              disabled={busy}
              maxLength={500}
            />
            <Button variant="outline" onClick={onStart} disabled={busy || running}>
              {running ? 'Agent working…' : agent ? 'Run agent again' : 'Start agent'}
            </Button>
          </div>

          {sections.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Focus sections (optional):
              </span>
              {sections.map((section, index) => {
                const sectionId = `section_${index}`;
                const active = selected.includes(sectionId);
                return (
                  <label key={sectionId} className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className={CHECKBOX_CLASS}
                      checked={active}
                      disabled={busy}
                      onChange={() => onToggleSection(sectionId)}
                    />
                    {section.heading}
                  </label>
                );
              })}
            </div>
          )}

          {running && (
            <p className="mt-2 text-sm text-muted-foreground">
              The agent is choosing bounded actions… it stops on its own within the step and action limits.
            </p>
          )}

          {!agent && (
            <p className="mt-2 text-sm text-muted-foreground">
              No advanced agent run has been started for this draft yet. Starting one runs only allowlisted actions on
              this run; nothing is ever applied or published automatically.
            </p>
          )}

          {agent && (
            <div className="mt-2">
              <div className="flex flex-wrap items-center gap-2.5">
                <Badge variant={pillVariant(statusPill)}>{statusLabel}</Badge>
                <Badge variant="outline">{agentGoalLabel(agent.goal)}</Badge>
                <span className="text-xs text-muted-foreground">
                  step {agent.stepCount}/{agent.maxSteps}
                </span>
                {agent.startedAt && (
                  <span className="text-xs text-muted-foreground">
                    Started {new Date(agent.startedAt).toLocaleString()}
                  </span>
                )}
                {agent.finishedAt && (
                  <span className="text-xs text-muted-foreground">
                    Finished {new Date(agent.finishedAt).toLocaleString()}
                  </span>
                )}
              </div>
              {agent.note && (
                <p className="text-xs text-muted-foreground">
                  {agent.note}
                </p>
              )}
              {agent.steps.length > 0 && (
                <div className="mt-1.5">
                  {agent.steps.map((step) => (
                    <div key={step.index} className="mt-1.5 border-t pt-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{AGENT_ACTION_LABELS[step.action]}</Badge>
                        <Badge
                          variant={step.status === 'failed' ? 'destructive' : step.status === 'completed' ? 'success' : 'warning'}
                        >
                          {step.status}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          Step {step.index + 1}
                        </span>
                      </div>
                      {step.summary && (
                        <p className="my-1 text-[13px] text-muted-foreground">
                          {step.summary}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** W8 review-session controls: the human picks exactly the approved sections to
 *  rewrite and gives one instruction. No section is ever revised implicitly. */
function ReviewSessionControls({
  sections,
  selected,
  instruction,
  busy,
  onToggle,
  onInstructionChange,
  onRevise,
}: {
  sections: NonNullable<WriterRunDto['plan']>['sections'];
  selected: string[];
  instruction: string;
  busy: boolean;
  onToggle: (sectionId: string) => void;
  onInstructionChange: (value: string) => void;
  onRevise: () => void;
}) {
  const canRevise = selected.length > 0 && instruction.trim().length > 0 && !busy;
  return (
    <div className="mt-3.5 flex flex-col">
      <ProposalHead
        label="Review session"
        description="Not happy yet? Select exactly the sections to rewrite and tell the writer what to change. The approved outline stays fixed and untouched sections are kept as they are."
      />
      <div className="mt-2">
        {sections.map((s, i) => {
          const sectionId = s.sectionId ?? `section_${i}`;
          const checked = selected.includes(sectionId);
          return (
            <label key={sectionId} className="my-1 flex flex-wrap items-center gap-2">
              <input
                type="checkbox"
                className={CHECKBOX_CLASS}
                checked={checked}
                disabled={busy}
                onChange={() => onToggle(sectionId)}
              />
              <span className="font-mono text-xs text-muted-foreground">
                {i + 1}.
              </span>
              <span>{s.heading}</span>
            </label>
          );
        })}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Input
          className="min-w-[320px] flex-1"
          type="text"
          placeholder="What should change? (e.g. make the intro sharper, add concrete examples)"
          value={instruction}
          onChange={(e) => onInstructionChange(e.target.value)}
          disabled={busy}
        />
        <Button disabled={!canRevise} onClick={onRevise}>
          Revise selected sections
        </Button>
      </div>
      {busy && <p className="mt-2 text-sm text-muted-foreground">Requesting the revision…</p>}
    </div>
  );
}

/** W10.1 Section Magic controls: the human picks the sections (shared with the
 *  revision flow above) AND the action - the AI never decides what to transform
 *  or why. change_tone requires a tone (no free-text instruction); custom
 *  requires an instruction; the rest take an optional bounded instruction.
 *  Applying only ever posts the transformation; the run must rest on
 *  review_ready again and the human decides what happens to the result. */
function MagicControls({
  sections,
  selected,
  action,
  tone,
  instruction,
  busy,
  hasResearch = false,
  onActionChange,
  onToneChange,
  onInstructionChange,
  onApply,
}: {
  sections: NonNullable<WriterRunDto['plan']>['sections'];
  selected: string[];
  action: WriterMagicAction;
  tone: WriterMagicTone;
  instruction: string;
  busy: boolean;
  /** True when gathered research context exists and will be offered to the
   *  writer as untrusted reference material for the transformed sections. */
  hasResearch?: boolean;
  onActionChange: (action: WriterMagicAction) => void;
  onToneChange: (tone: WriterMagicTone) => void;
  onInstructionChange: (value: string) => void;
  onApply: () => void;
}) {
  const usesTone = action === 'change_tone';
  const needsInstruction = action === 'custom';
  const canApply =
    !busy &&
    selected.length > 0 &&
    (usesTone || (needsInstruction ? instruction.trim().length > 0 : true));
  const selectedHeadings = sections
    .filter((s, i) => selected.includes(s.sectionId ?? `section_${i}`))
    .map((s) => s.heading);
  return (
    <div className="mt-2.5 flex flex-col">
      <ProposalHead
        label="Section Magic"
        description="Want to improve a section without writing a full revision? Select sections above (shared with the revision flow), pick an action here, and the writer transforms exactly those sections into a fresh review-ready proposal. Nothing is accepted or published automatically."
      />
      <p className="mb-1 mt-2 text-[13px] text-muted-foreground">
        {selected.length === 0
          ? 'No sections selected yet.'
          : `Will transform: ${selectedHeadings.join('; ')}`}
      </p>
      {hasResearch && (
        <p className="my-1 text-xs text-muted-foreground">
          Gathered research context will be offered to the writer as untrusted reference material for these sections —
          it is never applied verbatim.
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground">
          Action
        </label>
        <select
          className={SELECT_CLASS}
          value={action}
          disabled={busy}
          onChange={(e) => onActionChange(e.target.value as WriterMagicAction)}
        >
          {MAGIC_ACTIONS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        {usesTone ? (
          <>
            <label className="text-xs text-muted-foreground">
              Tone
            </label>
            <select
              className={SELECT_CLASS}
              value={tone}
              disabled={busy}
              onChange={(e) => onToneChange(e.target.value as WriterMagicTone)}
            >
              {MAGIC_TONES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </>
        ) : (
          <Input
            className="min-w-[220px] flex-1"
            type="text"
            placeholder={needsInstruction ? 'Describe the change (required for custom)' : 'Optional instruction…'}
            value={instruction}
            onChange={(e) => onInstructionChange(e.target.value)}
            disabled={busy}
          />
        )}
        <Button disabled={!canApply} onClick={onApply}>
          Apply magic to selected sections
        </Button>
      </div>
      {busy && <p className="mt-2 text-sm text-muted-foreground">Requesting the transformation…</p>}
    </div>
  );
}
