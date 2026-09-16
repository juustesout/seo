/**
 * Compose (Stage 8A): an isolated surface for the Composition Planner.
 *
 * One vertical slice, no new layers:
 *
 *   brief -> POST /composition/plan -> CompositionPlan
 *         -> compileCompositionPlan() -> CanonicalDocument
 *         -> CanonicalRenderer -> preview
 *
 * It reuses the existing planner API, the existing deterministic compiler and
 * the existing renderer, so the whole chain can be seen end to end on one
 * screen. The planner produces structure only (no copy), so the preview shows
 * empty placeholder blocks; the Structure tab plus the debug panels exist to
 * tell Composer/compiler/renderer/design problems apart. Nothing is persisted.
 */
import { useMemo, useState } from 'react';
import {
  COMPOSITION_PLAN_FORMAT_IDS,
  compileCompositionPlan,
  type CanonicalDocument,
  type CompositionPlan,
  type CompositionPlanFormat,
  type CompositionPlanNode,
} from '@seo/contracts';
import { ApiRequestError, api } from '../lib/api';
import { CanonicalRenderer } from '../components/canonicalRenderer';
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

interface ComposeError {
  message: string;
  code: string | null;
}

export function Compose({ projectId, role = 'viewer' }: { projectId: string; role?: string }) {
  const canEdit = (ROLE_RANK[role] ?? 0) >= 1;
  const [brief, setBrief] = useState(DEFAULT_BRIEF);
  const [format, setFormat] = useState<CompositionPlanFormat>('landing_page');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ComposeError | null>(null);
  const [plan, setPlan] = useState<CompositionPlan | null>(null);
  const [tab, setTab] = useState<OutputTab>('preview');

  // Compilation is pure and local (the contract ships the compiler), so the
  // browser renders exactly the document the server-side flow would produce.
  const compiled = useMemo(() => {
    if (!plan) return null;
    try {
      return { document: compileCompositionPlan(plan), error: null as string | null };
    } catch (e) {
      return {
        document: null as CanonicalDocument | null,
        error: e instanceof Error ? e.message : 'The composition could not be compiled.',
      };
    }
  }, [plan]);

  const generate = async () => {
    if (!canEdit || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api<CompositionPlan>(`/projects/${projectId}/composition/plan`, {
        method: 'POST',
        body: { brief: brief.trim(), format },
      });
      setPlan(result);
      setTab('preview');
    } catch (e) {
      setError(
        e instanceof ApiRequestError
          ? { message: e.message, code: e.code }
          : { message: e instanceof Error ? e.message : String(e), code: null },
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Compose"
        description="Turn a brief into a composition plan and preview the compiled page. Uses the project's configured AI; nothing is saved."
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
          disabled={loading}
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
                  disabled={loading}
                  onChange={() => setFormat(id)}
                />
                {FORMAT_LABEL[id]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-4">
          <Button type="button" onClick={() => void generate()} disabled={!canEdit || loading || brief.trim().length < 3}>
            {loading ? 'Generating composition…' : 'Generate composition'}
          </Button>
        </div>

        {!canEdit && (
          <p className="mt-3 text-xs text-muted-foreground">Editors and above can generate a composition.</p>
        )}

        {error && (
          <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
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

        {!plan && !loading && (
          <div className="rounded-[10px] border border-dashed p-10 text-center text-sm text-muted-foreground">
            Your composition preview will appear here.
          </div>
        )}

        {plan && compiled?.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            The plan could not be compiled: {compiled.error}
          </div>
        )}

        {plan && compiled?.document && tab === 'preview' && (
          <div className="overflow-hidden rounded-[10px] border bg-white">
            <CanonicalRenderer document={compiled.document} />
          </div>
        )}

        {plan && tab === 'structure' && <StructurePanel plan={plan} />}

        {plan && (
          <div className="grid gap-2">
            <DebugPanel title="Composition Plan" value={plan} />
            {compiled?.document && <DebugPanel title="Canonical Document" value={compiled.document} />}
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
