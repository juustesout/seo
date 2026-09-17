/**
 * Compose (Stage 8A + 8B + 8D): an isolated surface for the full composition chain.
 *
 *   brief -> POST /composition/plan    -> CompositionPlan            (Composer)
 *         -> POST /composition/compose -> filled CanonicalDocument   (Writer)
 *         -> CanonicalRenderer                                      (Preview)
 *         -> POST /content (Open in Editor) -> Content Studio        (Editor)
 *
 * The two server phases are two explicit requests so "Planning..." and
 * "Writing..." are real, not decorative, and a failure is attributed to the
 * phase that failed. The second request carries back the validated plan, so the
 * writer never re-plans and the Structure tab shows exactly the skeleton the
 * copy was written into. It reuses the existing planner/compose endpoints and
 * the existing renderer; generation itself is preview-only. Only "Open in
 * Editor" creates a persistent Content Studio draft from the current
 * CanonicalDocument (no second AI call, no new persistence layer).
 */
import { useState } from 'react';
import {
  COMPOSITION_PLAN_FORMAT_IDS,
  type CanonicalDocument,
  type CompositionPlan,
  type CompositionPlanFormat,
  type CompositionPlanNode,
} from '@seo/contracts';
import { ApiRequestError, api } from '../lib/api';
import { CanonicalRenderer } from '../components/canonicalRenderer';
import { editorDraftFromCanonical } from '../components/content/editorDraft';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/** Editable default so the surface is useful on first load. */
const DEFAULT_BRIEF =
  'Create a landing page for an SEO tool that helps businesses find keyword opportunities, analyze competitors and create better content.';

/** UI labels for the bounded plan formats; ids always come from the contract. */
const FORMAT_LABEL: Record<CompositionPlanFormat, string> = {
  article: 'Article',
  landing_page: 'Landing page',
};

const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

type OutputTab = 'preview' | 'structure';
type Phase = 'idle' | 'planning' | 'writing' | 'done';
type PhaseName = 'planning' | 'writing';

interface ComposeResponse {
  compositionPlan: CompositionPlan;
  canonicalDocument: CanonicalDocument;
}

interface CreatedContentRow {
  id: string;
}

interface ComposeError {
  message: string;
  code: string | null;
  phase: PhaseName;
}

function toError(e: unknown, phase: PhaseName): ComposeError {
  return {
    message: e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : String(e),
    code: e instanceof ApiRequestError ? e.code : null,
    phase,
  };
}

export function Compose({
  projectId,
  role = 'viewer',
  onOpenEditor,
}: {
  projectId: string;
  role?: string;
  onOpenEditor?: (contentId: string) => void;
}) {
  const canEdit = (ROLE_RANK[role] ?? 0) >= 1;
  const [brief, setBrief] = useState(DEFAULT_BRIEF);
  const [format, setFormat] = useState<CompositionPlanFormat>('landing_page');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<ComposeError | null>(null);
  const [plan, setPlan] = useState<CompositionPlan | null>(null);
  const [document, setDocument] = useState<CanonicalDocument | null>(null);
  const [tab, setTab] = useState<OutputTab>('preview');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const busy = phase === 'planning' || phase === 'writing';
  const buttonLabel = phase === 'planning' ? 'Planning…' : phase === 'writing' ? 'Writing…' : 'Generate composition';

  const generate = async () => {
    if (!canEdit || busy) return;
    setError(null);
    setCreateError(null);
    setPlan(null);
    setDocument(null);
    setTab('preview');

    setPhase('planning');
    let nextPlan: CompositionPlan;
    try {
      nextPlan = await api<CompositionPlan>(`/projects/${projectId}/composition/plan`, {
        method: 'POST',
        body: { brief: brief.trim(), format },
      });
    } catch (e) {
      setPhase('idle');
      setError(toError(e, 'planning'));
      return;
    }
    setPlan(nextPlan);

    setPhase('writing');
    try {
      const result = await api<ComposeResponse>(`/projects/${projectId}/composition/compose`, {
        method: 'POST',
        body: { brief: brief.trim(), format, plan: nextPlan },
      });
      setPlan(result.compositionPlan);
      setDocument(result.canonicalDocument);
      setPhase('done');
      setTab('preview');
    } catch (e) {
      setPhase('idle');
      setError(toError(e, 'writing'));
    }
  };

  // Persist the current run as a Content Studio draft and open the editor. The
  // document already exists in memory, so this is a single create call: no AI,
  // no re-planning. Guarded against double submits while the create is in
  // flight; the preview stays on screen if it fails.
  const openInEditor = async () => {
    if (!document || !canEdit || creating || !onOpenEditor) return;
    setCreating(true);
    setCreateError(null);
    try {
      const draft = editorDraftFromCanonical(document, brief.trim());
      const row = await api<CreatedContentRow>(`/projects/${projectId}/content`, {
        method: 'POST',
        body: { title: draft.title, status: 'draft', content_json: draft.doc },
      });
      onOpenEditor(row.id);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Compose"
        description="Turn a brief into a composition plan, let the writer fill its slots and preview the compiled page. Uses the project's configured AI; nothing is saved."
      />

      <section className="rounded-[10px] border bg-card p-4">
        <label className="text-sm font-medium" htmlFor="compose-brief">
          What do you want to create?
        </label>
        <Textarea
          id="compose-brief"
          className="mt-2"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="Create a landing page for my SEO tool"
          disabled={busy}
        />

        <fieldset className="mt-4">
          <legend className="text-sm font-medium">Format</legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {COMPOSITION_PLAN_FORMAT_IDS.map((id) => (
              <label key={id} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="compose-format"
                  value={id}
                  checked={format === id}
                  disabled={busy}
                  onChange={() => setFormat(id)}
                />
                {FORMAT_LABEL[id]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-4 flex items-center gap-3">
          <Button type="button" onClick={() => void generate()} disabled={!canEdit || busy || brief.trim().length < 3}>
            {buttonLabel}
          </Button>
          {busy && <span className="text-sm text-muted-foreground">Working through composer and writer…</span>}
        </div>

        {!canEdit && (
          <p className="mt-3 text-xs text-muted-foreground">Editors and above can generate a composition.</p>
        )}

        {error && (
          <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <p className="m-0 font-medium">{error.phase === 'planning' ? 'Planning failed' : 'Writing failed'}</p>
            <p className="m-0">{error.message}</p>
            {error.code && <p className="m-0 mt-1 text-xs opacity-80">Error code: {error.code}</p>}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="inline-flex w-fit rounded-md border p-0.5" role="group" aria-label="Composition output view">
          {(['preview', 'structure'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={tab === value}
              disabled={!plan}
              onClick={() => setTab(value)}
              className={cn(
                'rounded px-3 py-1 text-sm capitalize',
                tab === value ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground',
                !plan && 'opacity-50',
              )}
            >
              {value}
            </button>
          ))}
        </div>

        {!plan && !busy && !document && (
          <div className="rounded-[10px] border border-dashed p-10 text-center text-sm text-muted-foreground">
            Your composition preview will appear here.
          </div>
        )}

        {plan && tab === 'preview' && !document && (
          <div className="rounded-[10px] border border-dashed p-10 text-center text-sm text-muted-foreground">
            {phase === 'writing' ? 'Writing copy into the planned slots…' : 'Copy has not been written yet.'}
          </div>
        )}

        {document && tab === 'preview' && (
          <div className="overflow-hidden rounded-[10px] border bg-white">
            <CanonicalRenderer document={document} />
          </div>
        )}

        {document && tab === 'preview' && canEdit && onOpenEditor && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={() => void openInEditor()} disabled={creating}>
              {creating ? 'Opening…' : 'Open in Editor'}
            </Button>
            <span className="text-xs text-muted-foreground">
              Creates a draft in Content Studio from this run. Generating stays preview-only until you do this.
            </span>
          </div>
        )}

        {createError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            Could not open in editor: {createError}
          </div>
        )}

        {plan && tab === 'structure' && <StructurePanel plan={plan} />}

        {plan && (
          <div className="grid gap-2">
            <DebugPanel title="Composition Plan" value={plan} />
            {document && <DebugPanel title="Canonical Document" value={document} />}
          </div>
        )}
      </section>
    </div>
  );
}

/** Semantic view of the plan: section containers and their required slots. */
function StructurePanel({ plan }: { plan: CompositionPlan }) {
  return (
    <div className="rounded-[10px] border bg-card p-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-sm font-semibold text-foreground">{plan.format}</span>
        <span className="text-xs text-muted-foreground">{plan.purpose}</span>
      </div>
      <ul className="m-0 list-none p-0 font-mono text-sm">
        {plan.sections.map((section, index) => (
          <PlanNode key={index} node={section} />
        ))}
      </ul>
    </div>
  );
}

function planNodeHeading(node: CompositionPlanNode): string {
  const parts: string[] = [node.type];
  if (node.variant) parts.push(`(${node.variant})`);
  if (node.purpose) parts.push(`- ${node.purpose}`);
  return parts.join(' ');
}

function PlanNode({ node }: { node: CompositionPlanNode }) {
  const requirements = node.requiredContent ?? [];
  const children = node.children ?? [];
  return (
    <li className="pl-3">
      <span className="text-foreground">{planNodeHeading(node)}</span>
      {requirements.length + children.length > 0 && (
        <ul className="m-0 list-none border-l border-border/60 p-0 pl-4">
          {requirements.map((requirement, index) => (
            <li key={`slot-${index}`} className="pl-3">
              <code className="text-foreground">{requirement.slot}</code>{' '}
              <span className="text-muted-foreground">
                ({requirement.type}
                {requirement.level ? ` h${requirement.level}` : ''}
                {requirement.role ? `, ${requirement.role}` : ''})
              </span>
            </li>
          ))}
          {children.map((child, index) => (
            <PlanNode key={`child-${index}`} node={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Raw JSON, collapsed by default: debugging, not primary content. */
function DebugPanel({ title, value }: { title: string; value: unknown }) {
  return (
    <details className="rounded-[10px] border bg-card px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">{title}</summary>
      <pre className="mt-2 max-h-96 overflow-auto rounded bg-muted/40 p-3 text-xs leading-relaxed">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
