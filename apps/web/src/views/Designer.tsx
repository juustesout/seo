/**
 * Designer (Stage 8E.6, ADR Phase 5.1 + 5.2).
 *
 * Two flows share one view. Creation mode (5.1) submits an intent anchored to
 * the empty-document revision and shows the result as a proposal that is never
 * applied. Edit mode (5.2) targets one existing document: the intent is
 * submitted against that document's server-derived revision, the returned
 * proposal is reviewed side by side with the current saved document, and the
 * user may explicitly apply it or reject it.
 *
 * Nothing here orchestrates or persists a design itself. Submission and the
 * apply both go through existing API capabilities: the durable run endpoint and
 * `POST /content/:contentId/designer/apply`, which re-checks the revision
 * before saving and refuses a stale proposal. Reject is local by design and
 * never touches saved content.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  asTipDoc,
  contentRevisionOf,
  type DesignerProposal,
  type DesignerReview,
  type VisualDesignProposal,
} from '@seo/contracts';
import { CanonicalRenderer } from '../components/canonicalRenderer';
import { canonicalFromEditorDocument } from '../components/content/editorDraft';
import { useDesignerRun, type DesignerRunPhase } from '../components/designer/useDesignerRun';
import { ApiRequestError, api } from '../lib/api';
import { useAsync } from '../lib/ui';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

/** Minimum rank that may start/apply a run; matches the API's editor+ rules. */
const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

const PHASE_LABEL: Record<DesignerRunPhase, string> = {
  idle: 'Idle',
  submitting: 'Submitting',
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
};

type DesignerMode = 'create' | 'edit';
type ApplyState = 'idle' | 'applying' | 'applied' | 'conflict' | 'rejected';

/** The list row is deliberately light (`LIST_COLUMNS` has no document body). */
interface ContentListRow {
  id: string;
  title: string;
  status: string;
  updated_at: string | null;
}

interface ContentDetailRow extends ContentListRow {
  content_json: unknown;
}

function phaseVariant(phase: DesignerRunPhase): 'success' | 'warning' | 'destructive' | 'outline' {
  if (phase === 'succeeded') return 'success';
  if (phase === 'failed') return 'destructive';
  if (phase === 'submitting' || phase === 'queued' || phase === 'running') return 'warning';
  return 'outline';
}

/**
 * Canonical view of a stored editor document. Conversion can legitimately fail
 * for a legacy row the canonical model cannot represent; that is not fatal here
 * (revision math and apply still work), so it degrades to no preview.
 */
function storedCanonical(row: ContentDetailRow | null) {
  if (!row) return null;
  try {
    return canonicalFromEditorDocument(asTipDoc(row.content_json));
  } catch {
    return null;
  }
}

export function Designer({
  projectId,
  role = 'viewer',
  pollMs,
}: {
  projectId: string;
  role?: string;
  pollMs?: number;
}) {
  const canEdit = (ROLE_RANK[role] ?? 0) >= 1;
  const { phase, run, error, reused, submit, reset } = useDesignerRun(projectId, pollMs);

  const [mode, setMode] = useState<DesignerMode>('create');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [applyState, setApplyState] = useState<ApplyState>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);
  const applyingRef = useRef(false);

  // The active run owns its document: a run started against content is reviewed
  // against that same content, independent of whatever the form selector shows.
  const runContentId =
    run?.input.mode === 'intent' ? run.input.intent.contentId ?? null : null;
  const activeDocId = runContentId ?? selectedId;

  const list = useAsync<{ content: ContentListRow[]; total: number }>(
    () =>
      mode === 'edit'
        ? api(`/projects/${projectId}/content?limit=300`)
        : Promise.resolve({ content: [], total: 0 }),
    [projectId, mode],
  );
  const detail = useAsync<ContentDetailRow | null>(
    () => (activeDocId ? api(`/projects/${projectId}/content/${activeDocId}`) : Promise.resolve(null)),
    [projectId, activeDocId, detailRefresh],
  );
  // Guard against a slower previous selection landing after a newer one.
  const selectedDoc = detail.data && detail.data.id === activeDocId ? detail.data : null;

  const busy = phase === 'submitting' || phase === 'queued' || phase === 'running';
  const proposal = run?.result ?? null;
  const currentRevision = useMemo(
    () => (selectedDoc ? contentRevisionOf(selectedDoc.content_json) : null),
    [selectedDoc],
  );
  const revisionMatches =
    currentRevision !== null && proposal !== null && proposal.baseRevision === currentRevision;

  // A restored run may carry a document id; surface it in the form so the same
  // selection is obvious after a refresh, without stealing a user's later pick.
  useEffect(() => {
    if (!runContentId) return;
    setMode('edit');
    setSelectedId((prev) => prev ?? runContentId);
  }, [runContentId]);

  // A new run or a different reviewed document resets any apply decision.
  useEffect(() => {
    setApplyState('idle');
    setApplyError(null);
  }, [run?.runId, activeDocId]);

  const canSubmit =
    canEdit &&
    !busy &&
    instruction.trim().length >= 3 &&
    (mode === 'create' || (selectedId !== null && selectedDoc !== null));

  const startRun = () => {
    if (!canSubmit) return;
    void submit(instruction, mode === 'edit' && selectedId ? { contentId: selectedId } : undefined);
  };

  const selectDocument = (id: string) => {
    if (busy) return;
    reset();
    setSelectedId(id || null);
  };

  const changeMode = (next: DesignerMode) => {
    if (busy || mode === next) return;
    setMode(next);
  };

  const apply = async () => {
    if (!canEdit || !proposal || !activeDocId || applyingRef.current) return;
    if (!revisionMatches) {
      setApplyState('conflict');
      return;
    }
    applyingRef.current = true;
    setApplyState('applying');
    setApplyError(null);
    try {
      await api(`/projects/${projectId}/content/${activeDocId}/designer/apply`, {
        method: 'POST',
        body: { proposal },
      });
      setApplyState('applied');
      // The saved document now holds the proposal; re-read it so the current
      // preview and revision reflect what was actually written.
      setDetailRefresh((x) => x + 1);
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'stale_proposal') {
        setApplyState('conflict');
        setApplyError(e.message);
      } else {
        setApplyState('idle');
        setApplyError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      applyingRef.current = false;
    }
  };

  const reject = () => {
    if (!proposal || applyState === 'applied') return;
    if (!window.confirm('Reject this proposal without applying it? The saved document will not change.')) return;
    setApplyState('rejected');
  };

  const startOver = () => {
    if (runContentId) {
      setSelectedId(runContentId);
      setMode('edit');
    }
    reset();
    setInstruction('');
    setApplyState('idle');
    setApplyError(null);
  };

  const showEditReview = phase === 'succeeded' && runContentId !== null && proposal !== null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Designer"
        description="Create a new document or change an existing one. The Designer runs in the background and returns a reviewable proposal; edit proposals are only written when you explicitly apply them."
      />

      <section className="rounded-[10px] border bg-card p-4">
        <fieldset disabled={busy}>
          <legend className="text-sm font-medium">Mode</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {(['create', 'edit'] as const).map((value) => (
              <Button
                key={value}
                type="button"
                variant={mode === value ? 'default' : 'outline'}
                size="sm"
                aria-pressed={mode === value}
                onClick={() => changeMode(value)}
              >
                {value === 'create' ? 'Create new' : 'Edit existing'}
              </Button>
            ))}
          </div>
        </fieldset>

        {mode === 'edit' && (
          <div className="mt-4 grid gap-2">
            <label className="text-sm font-medium" htmlFor="designer-document">
              Select document
            </label>
            <select
              id="designer-document"
              className="h-9 max-w-md rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
              value={selectedId ?? ''}
              disabled={busy}
              onChange={(e) => selectDocument(e.target.value)}
            >
              <option value="">Select a document…</option>
              {(list.data?.content ?? []).map((row) => (
                <option key={row.id} value={row.id}>
                  {row.title} ({row.status})
                </option>
              ))}
            </select>
            {list.loading && <span className="text-xs text-muted-foreground">Loading documents…</span>}
            {list.error && (
              <span className="text-xs text-destructive">Could not load documents: {list.error}</span>
            )}

            {selectedId && !selectedDoc && detail.loading && (
              <span className="text-xs text-muted-foreground">Loading the selected document…</span>
            )}
            {selectedDoc && (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                <p className="m-0 font-medium">{selectedDoc.title}</p>
                <p className="m-0 text-xs text-muted-foreground">
                  Current revision: <code className="font-mono">{currentRevision}</code>
                </p>
              </div>
            )}
            {detail.error && selectedId && !busy && (
              <span className="text-xs text-destructive">Could not load the document: {detail.error}</span>
            )}
          </div>
        )}

        <label className="mt-4 block text-sm font-medium" htmlFor="designer-instruction">
          {mode === 'edit' ? 'How should the Designer change this document?' : 'What should the Designer create?'}
        </label>
        <Textarea
          id="designer-instruction"
          className="mt-2"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={
            mode === 'edit'
              ? 'Rewrite the introduction and tighten the headings.'
              : 'Create a landing page for an SEO tool that helps businesses find keyword opportunities.'
          }
          disabled={busy}
        />
        <div className="mt-4 flex items-center gap-3">
          <Button type="button" onClick={startRun} disabled={!canSubmit}>
            {phase === 'submitting' ? 'Submitting…' : 'Start design run'}
          </Button>
          {busy && <span className="text-sm text-muted-foreground">Tracking the run in the background…</span>}
        </div>
        {!canEdit && (
          <p className="mt-3 text-xs text-muted-foreground">Editors and above can start a design run.</p>
        )}
        {mode === 'edit' && canEdit && !busy && !selectedId && (
          <p className="mt-3 text-xs text-muted-foreground">Select a document before starting an edit run.</p>
        )}
        {error && !run && (
          <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-label="Designer run">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={phaseVariant(phase)}>{PHASE_LABEL[phase]}</Badge>
          {run && <span className="font-mono text-xs text-muted-foreground">{run.runId}</span>}
        </div>

        {reused && (
          <p className="m-0 text-xs text-muted-foreground">
            An identical request was already submitted, so this is tracking that existing run.
          </p>
        )}

        {phase === 'idle' && !run && !error && (
          <div className="rounded-[10px] border border-dashed p-10 text-center text-sm text-muted-foreground">
            Describe what you want and start a run. Its proposal will appear here.
          </div>
        )}

        {phase === 'submitting' && (
          <div className="rounded-[10px] border border-dashed p-10 text-center text-sm text-muted-foreground">
            Submitting your brief…
          </div>
        )}

        {phase === 'queued' && (
          <div className="rounded-[10px] border border-dashed p-10 text-center text-sm text-muted-foreground">
            Queued. A worker will pick this run up shortly.
          </div>
        )}

        {phase === 'running' && (
          <div className="rounded-[10px] border border-dashed p-10 text-center text-sm text-muted-foreground">
            Running. The Designer is planning and executing this brief.
          </div>
        )}

        {error && run && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {phase === 'failed' && run?.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <p className="m-0 font-medium">The design run failed.</p>
            <p className="m-0">{run.error.message}</p>
            <p className="m-0 mt-1 text-xs opacity-80">
              Error code: {run.error.code}
              {run.error.retryable ? ' (retryable)' : ''}
            </p>
          </div>
        )}

        {showEditReview && (
          <EditReview
            proposal={proposal}
            document={selectedDoc}
            documentError={detail.error}
            documentLoading={detail.loading}
            currentRevision={currentRevision}
            revisionMatches={revisionMatches}
            canEdit={canEdit}
            applyState={applyState}
            applyError={applyError}
            onApply={() => void apply()}
            onReject={reject}
            onStartOver={startOver}
          />
        )}

        {phase === 'succeeded' && !showEditReview && proposal && <ProposalResult proposal={proposal} />}

        {(phase === 'succeeded' || phase === 'failed') && !showEditReview && (
          <div>
            <Button type="button" variant="outline" onClick={startOver}>
              Start a new run
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Edit-mode review. It makes the three states explicit - the saved document, the
 * generated proposal, and whether the proposal was applied - and it is the only
 * place a proposal can be written to content, through the existing apply route.
 */
function EditReview({
  proposal,
  document,
  documentError,
  documentLoading,
  currentRevision,
  revisionMatches,
  canEdit,
  applyState,
  applyError,
  onApply,
  onReject,
  onStartOver,
}: {
  proposal: DesignerProposal;
  document: ContentDetailRow | null;
  documentError: string | null;
  documentLoading: boolean;
  currentRevision: string | null;
  revisionMatches: boolean;
  canEdit: boolean;
  applyState: ApplyState;
  applyError: string | null;
  onApply: () => void;
  onReject: () => void;
  onStartOver: () => void;
}) {
  const currentCanonical = useMemo(() => storedCanonical(document), [document]);
  const terminal = applyState === 'applied' || applyState === 'rejected';

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-[10px] border bg-card p-3 text-sm">
        <p className="m-0 font-medium">
          {document ? document.title : documentLoading ? 'Loading document…' : 'Source document'}
        </p>
        <p className="m-0 text-xs text-muted-foreground">
          Source revision: <code className="font-mono">{proposal.baseRevision}</code>
          {currentRevision && (
            <>
              {' · '}Current revision: <code className="font-mono">{currentRevision}</code>
            </>
          )}
        </p>
      </div>

      {documentError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Could not read the source document: {documentError}
        </div>
      )}

      {document && !revisionMatches && applyState !== 'applied' && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
          The saved document changed after this proposal was generated. Start a new run to propose against the current
          revision.
        </div>
      )}

      {applyState === 'applied' && (
        <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
          Proposal applied to the saved document.
        </div>
      )}
      {applyState === 'rejected' && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          Proposal rejected. The saved document was not changed.
        </div>
      )}
      {applyState === 'conflict' && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <p className="m-0 font-medium">This proposal is stale and was not applied.</p>
          {applyError && <p className="m-0">{applyError}</p>}
        </div>
      )}
      {applyError && applyState === 'idle' && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {applyError}
        </div>
      )}

      {proposal.review && <ReviewSummary review={proposal.review} />}
      {proposal.visual && <VisualProvenance visual={proposal.visual} />}

      {documentLoading && !document && (
        <div className="rounded-[10px] border border-dashed p-10 text-center text-sm text-muted-foreground">
          Loading the current saved document…
        </div>
      )}

      <div className="grid gap-3">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Proposed document</p>
          <div className="overflow-hidden rounded-[10px] border bg-white">
            <CanonicalRenderer document={proposal.document} />
          </div>
        </div>

        {currentCanonical && (
          <details className="rounded-[10px] border bg-card px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Current saved document
            </summary>
            <div className="mt-2 overflow-hidden rounded border bg-white">
              <CanonicalRenderer document={currentCanonical} />
            </div>
          </details>
        )}
      </div>

      {!terminal && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={onApply} disabled={!canEdit || applyState === 'applying' || !revisionMatches}>
            {applyState === 'applying' ? 'Applying…' : 'Apply to document'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onReject}
            disabled={applyState === 'applying'}
          >
            Reject
          </Button>
          {!canEdit && <span className="text-xs text-muted-foreground">Editors and above can apply.</span>}
        </div>
      )}

      {terminal && (
        <div>
          <Button type="button" variant="outline" onClick={onStartOver}>
            Start a new run
          </Button>
        </div>
      )}
    </div>
  );
}

/** Deterministic review summary; the full visual diff is intentionally absent. */
function ReviewSummary({ review }: { review: DesignerReview }) {
  return (
    <div className="rounded-[10px] border bg-card p-3 text-sm">
      <p className="m-0 text-xs text-muted-foreground">
        {review.ok ? 'Review passed' : 'Review found issues'}
        {typeof review.score === 'number' ? ` · SEO score ${review.score}` : ''}
      </p>
      {review.errors.map((issue, index) => (
        <p key={`error-${index}`} className="m-0 mt-1 text-destructive">
          {issue.code}: {issue.message}
        </p>
      ))}
      {review.warnings.map((issue, index) => (
        <p key={`warning-${index}`} className="m-0 mt-1 text-muted-foreground">
          {issue.code}: {issue.message}
        </p>
      ))}
    </div>
  );
}

/**
 * Visual-domain provenance. The Visual domain explains which existing project
 * asset it chose for which image block (and which targets it could not fill).
 * These are read-only explanations, never executable instructions: the proposed
 * document above remains the single source of truth and apply depends only on it.
 */
function VisualProvenance({ visual }: { visual: VisualDesignProposal }) {
  const unmatched = visual.unmatched ?? [];
  if (visual.operations.length === 0 && unmatched.length === 0) return null;

  return (
    <div className="rounded-[10px] border bg-card p-3 text-sm">
      <p className="m-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">Visual selections</p>
      <p className="m-0 mt-1 text-xs text-muted-foreground">
        Chosen by the Visual domain from existing project assets. Explanation only; not applied on its own.
      </p>
      <ul className="m-0 mt-2 list-disc pl-5">
        {visual.operations.map((op, index) => {
          const reason = visual.rationale?.[index];
          return (
            <li key={`operation-${index}`}>
              {op.op === 'select_asset' ? (
                <>
                  <span className="font-mono text-xs">{op.target}</span> &rarr; asset{' '}
                  <span className="font-mono text-xs">{op.mediaId}</span>
                </>
              ) : (
                <>
                  <span className="font-mono text-xs">{op.target}</span> &rarr; variant{' '}
                  <span className="font-mono text-xs">{op.variant}</span>
                </>
              )}
              {reason ? `: ${reason}` : ''}
            </li>
          );
        })}
        {unmatched.map((entry, index) => (
          <li key={`unmatched-${index}`} className="text-muted-foreground">
            No asset for <span className="font-mono text-xs">{entry.targetBlockId}</span> ({entry.reason})
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Creation-mode proposal. It has no document to apply to (the apply route
 * requires an existing content record), so it stays explicitly proposal-only.
 */
function ProposalResult({ proposal }: { proposal: DesignerProposal }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
        This is a proposal. It has not been applied, saved, or published.
      </div>

      <div className="text-xs text-muted-foreground">
        Based on revision <code className="font-mono">{proposal.baseRevision}</code>
      </div>

      {proposal.review && <ReviewSummary review={proposal.review} />}
      {proposal.visual && <VisualProvenance visual={proposal.visual} />}

      <div className="overflow-hidden rounded-[10px] border bg-white">
        <CanonicalRenderer document={proposal.document} />
      </div>
    </div>
  );
}
