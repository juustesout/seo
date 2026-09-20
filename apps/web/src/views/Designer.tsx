/**
 * Designer (Stage 8E.6, ADR Phase 5.1).
 *
 * The first Designer surface: a brief is submitted as a durable agent run and
 * the view follows that one run to a terminal state. It is deliberately narrow.
 * It does not plan, execute, apply or persist anything in the browser - those
 * are the DesignerService and the worker. The result it shows is a
 * `DesignerProposal`, which is explicitly a proposal: the copy here is never
 * written to Content Studio and nothing is published.
 *
 * Persistence of the active run lives in `useDesignerRun` (a project-scoped
 * bookmark, restored and resumed on mount) so a refresh or navigation cannot
 * silently start a duplicate run or lose a pending one.
 */
import { useState } from 'react';
import type { DesignerProposal } from '@seo/contracts';
import { CanonicalRenderer } from '../components/canonicalRenderer';
import { useDesignerRun, type DesignerRunPhase } from '../components/designer/useDesignerRun';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';

/** Minimum rank that may start a run; matches the API's editor+ requirement. */
const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

const PHASE_LABEL: Record<DesignerRunPhase, string> = {
  idle: 'Idle',
  submitting: 'Submitting',
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
};

function phaseVariant(phase: DesignerRunPhase): 'success' | 'warning' | 'destructive' | 'outline' {
  if (phase === 'succeeded') return 'success';
  if (phase === 'failed') return 'destructive';
  if (phase === 'submitting' || phase === 'queued' || phase === 'running') return 'warning';
  return 'outline';
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
  const [instruction, setInstruction] = useState('');

  const busy = phase === 'submitting' || phase === 'queued' || phase === 'running';
  const canSubmit = canEdit && !busy && instruction.trim().length >= 3;

  const startOver = () => {
    reset();
    setInstruction('');
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Designer"
        description="Describe what you want created. The Designer plans and runs the work in the background; the result is a reviewable proposal and is never saved or published automatically."
      />

      <section className="rounded-[10px] border bg-card p-4">
        <label className="text-sm font-medium" htmlFor="designer-instruction">
          What should the Designer create?
        </label>
        <Textarea
          id="designer-instruction"
          className="mt-2"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Create a landing page for an SEO tool that helps businesses find keyword opportunities."
          disabled={busy}
        />
        <div className="mt-4 flex items-center gap-3">
          <Button type="button" onClick={() => void submit(instruction)} disabled={!canSubmit}>
            {phase === 'submitting' ? 'Submitting…' : 'Start design run'}
          </Button>
          {busy && <span className="text-sm text-muted-foreground">Tracking the run in the background…</span>}
        </div>
        {!canEdit && (
          <p className="mt-3 text-xs text-muted-foreground">Editors and above can start a design run.</p>
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

        {phase === 'succeeded' && run?.result && <ProposalResult proposal={run.result} />}

        {(phase === 'succeeded' || phase === 'failed') && (
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
 * Renders a succeeded run's proposal with the existing canonical renderer. The
 * banner and the explicit absence of any apply action are the point: the
 * document is a candidate, not the stored article.
 */
function ProposalResult({ proposal }: { proposal: DesignerProposal }) {
  const review = proposal.review;
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
        This is a proposal. It has not been applied, saved, or published.
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>
          Based on revision <code className="font-mono">{proposal.baseRevision}</code>
        </span>
        {review && (
          <span>
            {review.ok ? 'Review passed' : 'Review found issues'}
            {typeof review.score === 'number' ? ` · SEO score ${review.score}` : ''}
          </span>
        )}
      </div>

      {review && (review.errors.length > 0 || review.warnings.length > 0) && (
        <div className="rounded-[10px] border bg-card p-3 text-sm">
          {review.errors.map((issue, index) => (
            <p key={`error-${index}`} className="m-0 text-destructive">
              {issue.code}: {issue.message}
            </p>
          ))}
          {review.warnings.map((issue, index) => (
            <p key={`warning-${index}`} className="m-0 text-muted-foreground">
              {issue.code}: {issue.message}
            </p>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-[10px] border bg-white">
        <CanonicalRenderer document={proposal.document} />
      </div>
    </div>
  );
}
