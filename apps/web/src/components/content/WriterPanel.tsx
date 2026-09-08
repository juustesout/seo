/**
 * Writer panel for the Content Studio editor (W6).
 *
 * Starts a writer run for the article being edited, shows the AI-generated
 * plan as a PROPOSAL, requires an explicit human decision (Approve & Write /
 * Reject) and - once the approved run has written and deterministically
 * reviewed - shows the review-ready result.
 *
 * Honesty rules honoured here:
 *   - the plan is presented as an AI-generated proposal, never as authority;
 *   - while the approved run is writing the panel says exactly that and keeps
 *     polling the run until a terminal state (review_ready / completed /
 *     rejected / failed) - it never claims a result is ready before the graph
 *     reports it, and polling stops at terminal states;
 *   - the result is previewed only: W6 never saves it to seo_content, never
 *     publishes and never schedules. Applying it to the document stays an
 *     explicit, separate human action that this phase does not implement.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { WriterRunDto, WriterRunStatus } from '@seo/contracts';
import { api } from '../../lib/api';

const TERMINAL: ReadonlySet<WriterRunStatus> = new Set(['review_ready', 'completed', 'rejected', 'failed']);

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
  const [rejectReason, setRejectReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const runRef = useRef<WriterRunDto | null>(null);
  runRef.current = run;

  const refresh = useCallback(async () => {
    const current = runRef.current;
    if (!current) return;
    try {
      const next = await api<WriterRunDto>(runPath(projectId, contentId, current.runId));
      setRun(next);
      if (TERMINAL.has(next.status)) setFatal(null);
    } catch (e) {
      // The run is gone or unreachable (e.g. the API restarted and the
      // in-memory run was lost). Stop polling and surface the reason.
      setFatal(e instanceof Error ? e.message : String(e));
    }
  }, [projectId, contentId]);

  // Poll only while the approved run is writing; stop at terminal states.
  useEffect(() => {
    const current = runRef.current;
    if (!current || current.status !== 'writing' || fatal) return;
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

  const reset = () => {
    setRun(null);
    setError(null);
    setFatal(null);
    setRejectReason('');
  };

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

      {(status === 'completed' || status === 'review_ready') && review && plan && (
        <ReviewResult review={review} planTitle={plan.title} />
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

/** Review-ready result of a completed run: canonical document + deterministic
 *  SEO evaluation. Preview only - never auto-saved or auto-published. */
function ReviewResult({ review, planTitle }: { review: NonNullable<WriterRunDto['review']>; planTitle: string }) {
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
        <span className="muted" style={{ fontSize: 12 }}>
          Deterministic evaluation — {passed} of {review.seo.checks.length} checks passing.
        </span>
      </div>
      <div className="card">
        <div className="article-body" dangerouslySetInnerHTML={{ __html: review.contentHtml }} />
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        To use this draft in the editor you would explicitly apply it as content - W6 does not do that for you.
      </p>
    </div>
  );
}
