/**
 * Designer (Stage 8E.6, ADR Phase 5.1 + 5.2; workspace binding R5.5.1; mutation
 * handoff R5.5.2).
 *
 * Two flows share one view. Creation mode (5.1) submits an intent anchored to
 * the empty-document revision and shows the result as a proposal that is never
 * applied. Edit mode (5.2) targets the one document the workspace has open: the
 * intent is submitted against that document's server-derived revision, the
 * returned proposal is reviewed against the live document, and the user may
 * explicitly apply it or reject it.
 *
 * R5.5.1: this view no longer owns a document selector, a `/content` list read
 * or a document detail read. Document identity, title, the live canonical
 * document and its revision arrive from the shared workspace session through
 * `DesignerMode`; the view owns only Designer-specific form/run/apply state.
 *
 * R5.5.2: apply no longer calls the legacy whole-document
 * `POST /content/:contentId/designer/apply`. A proposal is classified by
 * `planDesignerMutation`; a proposal carrying document operations or an image
 * insertion is handed to `onApplyProposal` (the shell stages it and the editor
 * applies it through the existing mutation pipeline), while a canonical-document
 * -only or generation-required proposal is surfaced as unsupported and stays
 * proposal-only. The view never mutates the document itself.
 */
import { useEffect, useRef, useState } from 'react';
import {
  type CanonicalDocument,
  type DesignerProposal,
  type DesignerReview,
  type VisualDesignProposal,
} from '@seo/contracts';
import type { DocumentLifecycleStatus } from '../components/content/session';
import { CanonicalRenderer } from '../components/canonicalRenderer';
import { useDesignerRun, type DesignerRunPhase } from '../components/designer/useDesignerRun';
import {
  isDesignerMutationRepresentable,
  planDesignerMutation,
  type DesignerMutationPlan,
} from '../workspace/designerMutation';
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

type DesignerFlow = 'create' | 'edit';
type ApplyState = 'idle' | 'staging' | 'conflict' | 'rejected';

function phaseVariant(phase: DesignerRunPhase): 'success' | 'warning' | 'destructive' | 'outline' {
  if (phase === 'succeeded') return 'success';
  if (phase === 'failed') return 'destructive';
  if (phase === 'submitting' || phase === 'queued' || phase === 'running') return 'warning';
  return 'outline';
}

export interface DesignerProps {
  projectId: string;
  role?: string;
  pollMs?: number;
  /**
   * The shared workspace document id, or null when none is open. Edit runs are
   * bound to this document; the Designer keeps no identity of its own.
   */
  documentId?: string | null;
  /** The shared workspace document title (display only). */
  documentTitle?: string | null;
  /** The live canonical revision of the shared workspace document. */
  documentRevision?: string | null;
  /** The live lifecycle of the shared workspace document. */
  documentStatus?: DocumentLifecycleStatus;
  /** The live canonical document, or null when it is not representable. */
  currentDocument?: CanonicalDocument | null;
  /**
   * Hands a representable proposal to the workspace for application through the
   * shared mutation pipeline (R5.5.2). Supplied by `DesignerMode`/the shell; the
   * Designer never mutates the document and never calls the legacy apply route.
   * When absent, applying is unavailable and the proposal stays proposal-only.
   */
  onApplyProposal?: (proposal: DesignerProposal, targetDocumentId: string) => void;
}

export function Designer({
  projectId,
  role = 'viewer',
  pollMs,
  documentId = null,
  documentTitle = null,
  documentRevision = null,
  documentStatus = 'idle',
  currentDocument = null,
  onApplyProposal,
}: DesignerProps) {
  const canEdit = (ROLE_RANK[role] ?? 0) >= 1;
  const { phase, run, error, reused, submit, reset } = useDesignerRun(projectId, pollMs);

  const [mode, setMode] = useState<DesignerFlow>('create');
  const [instruction, setInstruction] = useState('');
  const [applyState, setApplyState] = useState<ApplyState>('idle');
  const applyingRef = useRef(false);

  const busy = phase === 'submitting' || phase === 'queued' || phase === 'running';
  const proposal = run?.result ?? null;
  // An edit run carries the target document id; a creation run has none.
  const runContentId =
    run?.input.mode === 'intent' ? run.input.intent.contentId ?? null : null;

  // An edit proposal is reviewable here only while the document it was generated
  // for is still the open document. A proposal for another document (the user
  // switched while it ran) is shown as proposal-only rather than silently
  // compared against the wrong live document.
  const targetsOpenDocument = runContentId !== null && runContentId === documentId;
  const revisionMatches =
    targetsOpenDocument &&
    documentRevision !== null &&
    proposal !== null &&
    proposal.baseRevision === documentRevision;

  // How the proposal can reach the shared mutation pipeline, or why it cannot.
  // A canonical-document-only or generation-required proposal stays proposal-only.
  const mutationPlan: DesignerMutationPlan | null = proposal ? planDesignerMutation(proposal) : null;
  const representable = mutationPlan !== null && isDesignerMutationRepresentable(mutationPlan);
  const unsupportedReason = mutationPlan?.kind === 'unsupported' ? mutationPlan.reason : null;
  // Applying is a handoff to the shell, so it also needs the callback, a matching
  // open document and a still-current revision.
  const canApplyNow =
    canEdit && representable && Boolean(onApplyProposal) && targetsOpenDocument && revisionMatches;

  // A restored run that targets the open document surfaces in edit mode so the
  // form context matches the review, without stealing a user's later choice.
  useEffect(() => {
    if (runContentId && runContentId === documentId) setMode('edit');
  }, [runContentId, documentId]);

  // A new run or a different open document resets any apply decision.
  useEffect(() => {
    setApplyState('idle');
  }, [run?.runId, documentId]);

  const editTargetReady = documentId !== null && documentStatus === 'ready';
  const canSubmit =
    canEdit &&
    !busy &&
    instruction.trim().length >= 3 &&
    (mode === 'create' || editTargetReady);

  const startRun = () => {
    if (!canSubmit) return;
    void submit(instruction, mode === 'edit' && documentId ? { contentId: documentId } : undefined);
  };

  const changeMode = (next: DesignerFlow) => {
    if (busy || mode === next) return;
    setMode(next);
  };

  /**
   * Hands the proposal to the shell, which stages it and switches to the editor
   * mode where the shared mutation pipeline applies it. The Designer performs no
   * write; a refusal by the shell is shown by `DesignerMode`.
   */
  const apply = () => {
    if (applyingRef.current) return;
    if (!canApplyNow || !proposal || !runContentId || !onApplyProposal) {
      if (proposal && (!targetsOpenDocument || !revisionMatches)) setApplyState('conflict');
      return;
    }
    applyingRef.current = true;
    setApplyState('staging');
    onApplyProposal(proposal, runContentId);
  };

  const reject = () => {
    if (!proposal || applyState === 'rejected' || applyState === 'staging') return;
    if (!window.confirm('Reject this proposal without applying it? The saved document will not change.')) return;
    setApplyState('rejected');
  };

  const startOver = () => {
    reset();
    setInstruction('');
    setApplyState('idle');
  };

  const showEditReview = phase === 'succeeded' && targetsOpenDocument && proposal !== null;
  const showForeignProposal =
    phase === 'succeeded' && runContentId !== null && !targetsOpenDocument && proposal !== null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Designer"
        description="Create a new document or change the one you have open. The Designer runs in the background and returns a reviewable proposal; edit proposals are only written when you explicitly apply them."
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
                {value === 'create' ? 'Create new' : 'Edit open document'}
              </Button>
            ))}
          </div>
        </fieldset>

        {mode === 'edit' && (
          <div className="mt-4 grid gap-2">
            <span className="text-sm font-medium">Target document</span>
            {documentStatus === 'loading' && (
              <span className="text-xs text-muted-foreground">Loading the open document…</span>
            )}
            {documentStatus === 'error' && (
              <span className="text-xs text-destructive">Could not load the open document.</span>
            )}
            {documentStatus === 'ready' && documentId && (
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
                <p className="m-0 font-medium">{documentTitle || 'Untitled document'}</p>
                <p className="m-0 text-xs text-muted-foreground">
                  Current revision: <code className="font-mono">{documentRevision ?? 'unavailable'}</code>
                </p>
              </div>
            )}
            {(documentStatus === 'idle' || (documentStatus === 'ready' && !documentId)) && (
              <p className="m-0 text-xs text-muted-foreground">
                {documentStatus === 'ready'
                  ? 'This document has not been saved yet. Save it before starting an edit run.'
                  : 'No document is open. Open one in the Editor, then return to the Designer.'}
              </p>
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
        {mode === 'edit' && canEdit && !busy && !editTargetReady && (
          <p className="mt-3 text-xs text-muted-foreground">Open a document in the Editor before starting an edit run.</p>
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
            documentTitle={documentTitle}
            currentCanonical={currentDocument}
            currentRevision={documentRevision}
            revisionMatches={revisionMatches}
            canEdit={canEdit}
            representable={representable}
            unsupportedReason={unsupportedReason}
            canApply={canApplyNow}
            applyState={applyState}
            onApply={apply}
            onReject={reject}
            onStartOver={startOver}
          />
        )}

        {showForeignProposal && (
          <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
            This proposal was generated for a different document than the one currently open. Open that document to
            review and apply it.
          </div>
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
 * Edit-mode review. It makes the states explicit - the open document, the
 * generated proposal, whether the proposal can reach the shared mutation
 * pipeline, and whether it was rejected - and it never writes the document
 * itself. A representable proposal is handed to the shell (R5.5.2); the document
 * and revision shown are the live workspace ones, never a second read.
 */
function EditReview({
  proposal,
  documentTitle,
  currentCanonical,
  currentRevision,
  revisionMatches,
  canEdit,
  representable,
  unsupportedReason,
  canApply,
  applyState,
  onApply,
  onReject,
  onStartOver,
}: {
  proposal: DesignerProposal;
  documentTitle: string | null;
  currentCanonical: CanonicalDocument | null;
  currentRevision: string | null;
  revisionMatches: boolean;
  canEdit: boolean;
  representable: boolean;
  unsupportedReason: string | null;
  canApply: boolean;
  applyState: ApplyState;
  onApply: () => void;
  onReject: () => void;
  onStartOver: () => void;
}) {
  const terminal = applyState === 'rejected';
  const handedOff = applyState === 'staging';

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-[10px] border bg-card p-3 text-sm">
        <p className="m-0 font-medium">{documentTitle || 'Open document'}</p>
        <p className="m-0 text-xs text-muted-foreground">
          Source revision: <code className="font-mono">{proposal.baseRevision}</code>
          {currentRevision && (
            <>
              {' · '}Current revision: <code className="font-mono">{currentRevision}</code>
            </>
          )}
        </p>
      </div>

      {currentCanonical && !revisionMatches && !handedOff && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
          The open document no longer matches the revision this proposal was generated from. Start a new run to propose
          against the current revision.
        </div>
      )}

      {!representable && unsupportedReason && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
          <p className="m-0 font-medium">This proposal cannot be applied from here.</p>
          <p className="m-0 mt-1">{unsupportedReason}</p>
        </div>
      )}

      {handedOff && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          Apply requested. The workspace is applying it through the editor.
        </div>
      )}
      {applyState === 'rejected' && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          Proposal rejected. The saved document was not changed.
        </div>
      )}
      {applyState === 'conflict' && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          This proposal is stale and was not applied.
        </div>
      )}

      {proposal.review && <ReviewSummary review={proposal.review} />}
      {proposal.visual && <VisualProvenance visual={proposal.visual} />}

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
              Current document
            </summary>
            <div className="mt-2 overflow-hidden rounded border bg-white">
              <CanonicalRenderer document={currentCanonical} />
            </div>
          </details>
        )}
      </div>

      {!terminal && (
        <div className="flex flex-wrap items-center gap-3">
          {representable && (
            <Button type="button" onClick={onApply} disabled={!canApply || handedOff}>
              {handedOff ? 'Applying…' : 'Apply to document'}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onReject} disabled={handedOff}>
            Reject
          </Button>
          {!canEdit && <span className="text-xs text-muted-foreground">Editors and above can apply.</span>}
          {canEdit && representable && !canApply && !handedOff && (
            <span className="text-xs text-muted-foreground">
              Apply needs the open document at the revision this proposal was generated from.
            </span>
          )}
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
