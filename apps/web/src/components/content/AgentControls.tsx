/**
 * Agent Controls: a thin control surface over the shared Writer Engine on the
 * open article. It starts a normal `content_write` job and tracks that exact
 * job (by id, or by the `source_content_id` it was started for) - never a
 * result guessed from timestamps or belonging to another article.
 *
 * It always creates a NEW draft: the endpoint enforces `contentId: null`, so the
 * article being edited is never overwritten. The legacy Writer panel/toggle is
 * deliberately separate and untouched.
 */
import { useState } from 'react';
import {
  WRITER_EXECUTION_PROFILE_IDS,
  WRITER_FORMAT_IDS,
  type WriterExecutionProfileId,
  type WriterFormatId,
  type WriterRunSummary,
} from '@seo/contracts';
import { api } from '../../lib/api';
import { useJobs, StatusPill } from '../../lib/ui';
import { Button } from '@/components/ui/button';

interface AgentControlsJob {
  id: string;
  job_type: string;
  status: string;
  progress: number | null;
  message: string | null;
  error: { message?: string } | null;
  created_at: string | null;
  params: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
}

const MODE_LABEL: Record<WriterExecutionProfileId, string> = {
  quick_draft: 'Quick Draft',
  deep_write: 'Deep Write',
};

const FORMAT_LABEL: Record<WriterFormatId, string> = {
  short_article: 'Short article',
  explainer: 'Explainer',
};

const KIND_LABEL: Record<string, string> = {
  context: 'context',
  architecture: 'architecture',
  section_planning: 'section planning',
  section_generation: 'section writing',
  paragraph_refinement: 'refinement',
  coherence: 'coherence',
  editorial_validation: 'review',
  persist: 'persist',
};

function humanizeKind(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/_/g, ' ');
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function asMode(value: unknown): WriterExecutionProfileId | null {
  return typeof value === 'string' && (WRITER_EXECUTION_PROFILE_IDS as readonly string[]).includes(value)
    ? (value as WriterExecutionProfileId)
    : null;
}

function asSummary(value: unknown): WriterRunSummary | null {
  if (!value || typeof value !== 'object') return null;
  const summary = value as WriterRunSummary;
  return typeof summary.pass_count === 'number' ? summary : null;
}

export function AgentControls({
  projectId,
  contentId,
  canEdit,
  aiConfigured,
  onOpenDraft,
}: {
  projectId: string;
  contentId: string;
  canEdit: boolean;
  aiConfigured: boolean;
  onOpenDraft?: (contentId: string) => void;
}) {
  const [mode, setMode] = useState<WriterExecutionProfileId>('quick_draft');
  const [format, setFormat] = useState<WriterFormatId>('short_article');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [trackedJobId, setTrackedJobId] = useState<string | null>(null);

  const { jobs, reload } = useJobs(projectId, canEdit);

  // Associate strictly by explicit job identity: the run we started, else the
  // most recent run that recorded this article as its source.
  const agentJobs = (jobs as AgentControlsJob[]).filter(
    (job) => job.job_type === 'content_write' && job.params?.source_content_id === contentId,
  );
  const job = agentJobs.find((candidate) => candidate.id === trackedJobId) ?? agentJobs[0] ?? null;

  const running = job?.status === 'queued' || job?.status === 'running';
  const runMode = asMode((job?.params?.writer_input as Record<string, unknown> | undefined)?.mode);
  const summary = job?.status === 'completed' ? asSummary(job.result?.writer_summary) : null;
  const failedSummary = job?.status === 'failed' ? asSummary(job.result?.writer_summary) : null;
  const generatedId = typeof job?.result?.content_id === 'string' ? (job.result.content_id as string) : null;

  const start = async () => {
    if (!canEdit || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const data = await api<{ job: AgentControlsJob }>(`/projects/${projectId}/content/${contentId}/draft`, {
        method: 'POST',
        body: { mode, format },
      });
      setTrackedJobId(data.job?.id ?? null);
      reload();
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border bg-card p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agent Controls</h3>
        <span className="text-[11px] text-muted-foreground">Writer Engine</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Mode</span>
          <select
            aria-label="Writer mode"
            className="h-8 rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={mode}
            disabled={!canEdit || starting || running}
            onChange={(e) => setMode(e.target.value as WriterExecutionProfileId)}
          >
            {WRITER_EXECUTION_PROFILE_IDS.map((id) => (
              <option key={id} value={id}>
                {MODE_LABEL[id]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>Format</span>
          <select
            aria-label="Writer format"
            className="h-8 rounded-md border border-input bg-background px-2 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            value={format}
            disabled={!canEdit || starting || running}
            onChange={(e) => setFormat(e.target.value as WriterFormatId)}
          >
            {WRITER_FORMAT_IDS.map((id) => (
              <option key={id} value={id}>
                {FORMAT_LABEL[id]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <Button disabled={!canEdit || !aiConfigured || starting || running} onClick={() => void start()}>
        {starting ? 'Starting…' : 'Generate draft'}
      </Button>
      <p className="m-0 text-[11.5px] leading-snug text-muted-foreground">
        Creates a new draft. Your current article is not overwritten.
      </p>

      {!aiConfigured && (
        <p className="m-0 rounded-md border border-dashed border-destructive/40 px-2 py-1.5 text-[11.5px] text-destructive">
          Project AI is not configured. Add a key before generating drafts.
        </p>
      )}

      {startError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {startError}
        </div>
      )}

      {running && (
        <div className="rounded-md border bg-muted/40 px-2.5 py-2 text-xs">
          <div className="flex items-center gap-1.5">
            <StatusPill status={job?.status} />
            <span className="text-muted-foreground">{MODE_LABEL[runMode ?? mode]}</span>
            <span className="ml-auto tabular-nums text-muted-foreground">
              {job?.progress != null ? `${job.progress}%` : ''}
            </span>
          </div>
          <p className="m-0 mt-1 text-muted-foreground">{job?.message || 'Writing…'}</p>
        </div>
      )}

      {job?.status === 'completed' && (
        <div className="rounded-md border bg-muted/40 px-2.5 py-2 text-xs">
          <div className="flex items-center gap-1.5">
            <StatusPill status="completed" />
            <span className="font-semibold">
              {MODE_LABEL[(summary?.mode ?? runMode) ?? mode]} · {FORMAT_LABEL[summary?.format ?? format]}
            </span>
          </div>
          <dl className="mt-1.5 grid grid-cols-3 gap-x-2 gap-y-1">
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Passes</dt>
              <dd className="m-0 tabular-nums">{summary?.pass_count ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">LLM calls</dt>
              <dd className="m-0 tabular-nums">{summary?.llm_calls ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Duration</dt>
              <dd className="m-0 tabular-nums">{summary ? formatDuration(summary.duration_ms) : '—'}</dd>
            </div>
          </dl>
          {summary && Object.keys(summary.by_kind).length > 0 && (
            <p className="m-0 mt-1.5 text-[11px] leading-snug text-muted-foreground">
              {Object.entries(summary.by_kind)
                .map(([kind, count]) => `${humanizeKind(kind)} ${count}`)
                .join(' · ')}
            </p>
          )}
          {generatedId && (
            <div className="mt-1.5 flex items-center gap-2">
              <span className="min-w-0 truncate text-muted-foreground">
                {typeof job.result?.title === 'string' ? (job.result.title as string) : 'New draft'}
              </span>
              {onOpenDraft && (
                <Button variant="outline" size="sm" className="ml-auto" onClick={() => onOpenDraft(generatedId)}>
                  Open draft
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {job?.status === 'failed' && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
          <p className="m-0">{job.error?.message || 'The writer run failed.'}</p>
          {failedSummary?.failed_pass && (
            <p className="m-0 mt-1 text-[11px]">
              Failed at: {humanizeKind(failedSummary.failed_pass)} (after {failedSummary.pass_count} pass
              {failedSummary.pass_count === 1 ? '' : 'es'})
            </p>
          )}
          {canEdit && (
            <Button variant="outline" size="sm" className="mt-1.5" disabled={starting} onClick={() => void start()}>
              Retry
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
