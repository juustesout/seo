/**
 * Source Detail "Processing" section (KBUI2).
 *
 * Makes the ingest pipeline legible without inventing progress: a small
 * Queued -> Processing -> Ready stepper derived from the stored lifecycle
 * status, plus an honest one-line message. The API does not expose sub-steps or
 * percentages, so none are shown - a source is only ever "Ready" when the
 * backend says so.
 */
import type { KnowledgeSourceDetailDto, KnowledgeSourceStatus } from '@seo/contracts';
import { SourceSection } from './SourceSection';

type StepState = 'done' | 'active' | 'pending' | 'failed';

const STEPS: Array<{ id: 'queued' | 'processing' | 'ready'; label: string }> = [
  { id: 'queued', label: 'Queued' },
  { id: 'processing', label: 'Processing' },
  { id: 'ready', label: 'Ready' },
];

function stepStates(status: KnowledgeSourceStatus): Record<'queued' | 'processing' | 'ready', StepState> {
  switch (status) {
    case 'ready':
      return { queued: 'done', processing: 'done', ready: 'done' };
    case 'processing':
      return { queued: 'done', processing: 'active', ready: 'pending' };
    case 'queued':
      return { queued: 'active', processing: 'pending', ready: 'pending' };
    case 'failed':
      return { queued: 'done', processing: 'failed', ready: 'pending' };
    default:
      return { queued: 'pending', processing: 'pending', ready: 'pending' };
  }
}

function stateMessage(status: KnowledgeSourceStatus): string {
  switch (status) {
    case 'draft':
      return 'Not queued yet. Start processing when you are ready.';
    case 'queued':
      return 'Queued. Waiting to be processed.';
    case 'processing':
      return 'Processing this source…';
    case 'ready':
      return 'Indexed and ready to be searched.';
    case 'failed':
      return 'Processing stopped with an error. See the details below.';
    case 'deleted':
      return 'Removing this source…';
  }
}

const DOT: Record<StepState, string> = {
  done: 'bg-success',
  active: 'bg-warning',
  failed: 'bg-destructive',
  pending: 'bg-muted-foreground/30',
};

export function SourceLifecycle({ detail }: { detail: KnowledgeSourceDetailDto }) {
  const states = stepStates(detail.status);

  return (
    <SourceSection title="Processing">
      <ol className="m-0 grid list-none gap-1.5 p-0">
        {STEPS.map((step) => {
          const state = states[step.id];
          return (
            <li key={step.id} className="flex items-center gap-2 text-sm">
              <span className={`size-2 rounded-full ${DOT[state]}`} aria-hidden />
              <span className={state === 'pending' ? 'text-muted-foreground' : 'text-foreground'}>{step.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">{stateMessage(detail.status)}</p>
    </SourceSection>
  );
}
