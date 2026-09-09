/**
 * Writer panel for the Content Studio editor (W6, durable runs W7, revision
 * loop W8).
 *
 * Starts a writer run for the article being edited, shows the AI-generated
 * plan as a PROPOSAL, requires an explicit human decision (Approve & Write /
 * Reject) and - once the approved run has written and deterministically
 * reviewed - rests on the W8 review session (`review_ready`) where the run is
 * previewed as a review-ready draft and the human can request a controlled
 * revision of specific sections.
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
 *     sections). `completed` is terminal but only ever reached through the
 *     writer accept flow, which this W8 surface does not expose;
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
import type { WriterRunDto, WriterRunStatus } from '@seo/contracts';
import { ApiRequestError, api } from '../../lib/api';

/** Resting statuses the panel shows without polling. review_ready is NOT in
 *  this set: it is the W8 review-session hub (a human decision is required),
 *  and completed/rejected/failed are terminal. */
const TERMINAL: ReadonlySet<WriterRunStatus> = new Set(['completed', 'rejected', 'failed']);

/** In-progress statuses that keep the panel polling for a resting state. */
const PROGRESS: ReadonlySet<WriterRunStatus> = new Set(['writing', 'revising', 'reviewing']);

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
  // reviewing after a revise resume); stop at resting/terminal states.
  useEffect(() => {
    const current = runRef.current;
    if (!current || !PROGRESS.has(current.status) || fatal) return;
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
      const sectionIds = [...reviseSections].sort((a, b) => {
        const ai = Number(/^section_(\d+)$/.exec(a)?.[1]);
        const bi = Number(/^section_(\d+)$/.exec(b)?.[1]);
        return ai - bi;
      });
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

  const reset = () => {
    setRun(null);
    setError(null);
    setFatal(null);
    setRejectReason('');
    setReviseSections([]);
    setReviseInstruction('');
    window.localStorage.removeItem(storageKey(projectId, contentId));
  };

  if (!run && restoring) {
    return (
      <div className="writer-panel">
        <div className="ai-panel-head">
          <strong>Writer</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            Restoring the writer run for this article…
          </span>
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="writer-panel">
        <div className="ai-panel-head">
          <strong>Writer</strong>
          <span className="muted" style={{ fontSize: 12 }}>
            Drafts an article from this project's context, then waits for your approval.
          </span>
        </div>
        <p className="sub">
          Leave the instruction empty to use this article's title as the topic. The result is a review-ready draft for
          this document - it is never saved or published automatically.
        </p>
        <div className="row" style={{ marginTop: 8 }}>
          <input
            type="text"
            placeholder={`Instruction (optional) — e.g. write about ${defaultTopic || 'this topic'}`}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            style={{ minWidth: 420 }}
            disabled={startBusy}
          />
          <button className="btn primary" disabled={startBusy} onClick={() => void start()}>
            {startBusy ? 'Planning…' : 'Start writer run'}
          </button>
        </div>
        {error && <div className="banner error" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    );
  }

  const { status, plan, review, note } = run;

  return (
    <div className="writer-panel">
      <div className="ai-panel-head">
        <strong>Writer</strong>
        <span className={`pill ${statusClass(status)}`}>{status}</span>
        <span className="muted mono" style={{ fontSize: 12 }}>
          {run.runId}
        </span>
      </div>

      {error && <div className="banner error" style={{ marginTop: 8 }}>{error}</div>}
      {fatal && (
        <div className="banner error" style={{ marginTop: 8 }}>
          {fatal}
          <button className="btn sm" style={{ marginLeft: 10 }} onClick={reset}>
            Start a new run
          </button>
        </div>
      )}

      {status === 'awaiting_approval' && plan && (
        <PlanReview plan={plan} rejectReason={rejectReason} onReasonChange={setRejectReason} busy={actionBusy} onApprove={() => void decide('approve')} onReject={() => void decide('reject')} />
      )}

      {status === 'writing' && (
        <p className="muted" style={{ marginTop: 8 }}>
          Writer is writing… the approved sections are being written and reviewed. This article is not saved until you
          decide what to do with the result.
        </p>
      )}

      {status === 'revising' && (
        <p className="muted" style={{ marginTop: 8 }}>
          Writer is revising the selected sections… this article is not saved until you decide what to do with the
          result.
        </p>
      )}

      {status === 'reviewing' && (
        <p className="muted" style={{ marginTop: 8 }}>
          Writer is re-reviewing the revised draft…
        </p>
      )}

      {status === 'review_ready' && review && plan && (
        <>
          <ReviewResult review={review} planTitle={plan.title} revisionCount={run.revisionCount} />
          <ReviewSessionControls
            sections={plan.sections}
            selected={reviseSections}
            instruction={reviseInstruction}
            busy={actionBusy}
            onToggle={toggleReviseSection}
            onInstructionChange={setReviseInstruction}
            onRevise={() => void reviseSelected()}
          />
        </>
      )}

      {status === 'completed' && review && plan && (
        <ReviewResult review={review} planTitle={plan.title} revisionCount={run.revisionCount} />
      )}

      {status === 'rejected' && (
        <div className="banner" style={{ marginTop: 8 }}>
          The proposed plan was rejected{note ? ` — ${note}` : ''}. Nothing was written.
          <button className="btn sm" style={{ marginLeft: 10 }} onClick={reset}>
            Start a new run
          </button>
        </div>
      )}

      {status === 'failed' && (
        <div className="banner error" style={{ marginTop: 8 }}>
          {note ?? 'The writer run failed.'}
          <button className="btn sm" style={{ marginLeft: 10 }} onClick={reset}>
            Start a new run
          </button>
        </div>
      )}
    </div>
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
    <div style={{ marginTop: 10 }}>
      <div className="writer-proposal">
        <span className="pill busy">AI-generated proposal</span>
        <span className="muted" style={{ fontSize: 12 }}>
          Review the proposed outline below - the article is only written after you approve it.
        </span>
      </div>
      <h2 style={{ margin: '10px 0 4px' }}>{plan.title}</h2>
      {plan.metaDescription && <p className="sub">{plan.metaDescription}</p>}
      {plan.sections.map((s, i) => (
        <div key={i} className="writer-section">
          <h3>{i + 1}. {s.heading}</h3>
          {s.keyPoints.length > 0 && (
            <ul className="sub">
              {s.keyPoints.map((k, j) => (
                <li key={j}>{k}</li>
              ))}
            </ul>
          )}
          {s.suggestedKeywords.length > 0 && (
            <p className="muted" style={{ fontSize: 12 }}>
              Suggested keywords: {s.suggestedKeywords.join(', ')}
            </p>
          )}
        </div>
      ))}
      <div className="row" style={{ marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy} onClick={onApprove}>
          Approve &amp; Write
        </button>
        <button className="btn danger" disabled={busy} onClick={onReject}>
          Reject
        </button>
        <input
          type="text"
          placeholder="Optional reason for rejection…"
          value={rejectReason}
          onChange={(e) => onReasonChange(e.target.value)}
          disabled={busy}
          style={{ minWidth: 280 }}
        />
      </div>
      {busy && <p className="muted" style={{ marginTop: 8 }}>Submitting your decision…</p>}
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
    <div style={{ marginTop: 10 }}>
      <div className="banner ok">
        The writer produced a review-ready draft. It is previewed below and was NOT saved to this document or published
        anywhere.
      </div>
      <div className="row" style={{ alignItems: 'center', gap: 12, margin: '10px 0' }}>
        <h2 style={{ margin: 0 }}>{planTitle}</h2>
        <span className="pill ok">SEO {Math.round(review.seo.score)}/100</span>
        {typeof revisionCount === 'number' && revisionCount > 0 && (
          <span className="pill">Revision {revisionCount}</span>
        )}
        <span className="muted" style={{ fontSize: 12 }}>
          Deterministic evaluation — {passed} of {review.seo.checks.length} checks passing.
        </span>
      </div>
      <div className="card">
        <div className="article-body" dangerouslySetInnerHTML={{ __html: review.contentHtml }} />
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        To use this draft in the editor you would explicitly apply it as content - this panel does not do that for you.
      </p>
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
    <div className="writer-revision" style={{ marginTop: 14 }}>
      <div className="writer-proposal">
        <span className="pill busy">Review session</span>
        <span className="muted" style={{ fontSize: 12 }}>
          Not happy yet? Select exactly the sections to rewrite and tell the writer what to change. The approved outline
          stays fixed and untouched sections are kept as they are.
        </span>
      </div>
      <div style={{ marginTop: 8 }}>
        {sections.map((s, i) => {
          const sectionId = s.sectionId ?? `section_${i}`;
          const checked = selected.includes(sectionId);
          return (
            <label key={sectionId} className="row" style={{ alignItems: 'center', gap: 8, margin: '4px 0' }}>
              <input
                type="checkbox"
                checked={checked}
                disabled={busy}
                onChange={() => onToggle(sectionId)}
              />
              <span className="muted mono" style={{ fontSize: 12 }}>
                {i + 1}.
              </span>
              <span>{s.heading}</span>
            </label>
          );
        })}
      </div>
      <div className="row" style={{ marginTop: 10, alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <input
          type="text"
          placeholder="What should change? (e.g. make the intro sharper, add concrete examples)"
          value={instruction}
          onChange={(e) => onInstructionChange(e.target.value)}
          disabled={busy}
          style={{ minWidth: 380, flex: 1 }}
        />
        <button className="btn primary" disabled={!canRevise} onClick={onRevise}>
          Revise selected sections
        </button>
      </div>
      {busy && <p className="muted" style={{ marginTop: 8 }}>Requesting the revision…</p>}
    </div>
  );
}
