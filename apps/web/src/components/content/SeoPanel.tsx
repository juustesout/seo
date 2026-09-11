/**
 * On-page SEO panel for the Content Studio.
 *
 * The score/checks are deterministic client-side evaluations shared with the
 * server (evaluateSeo in @seo/contracts), not an invented or vendor metric.
 * When `editable` the panel is bound to the workspace's target keyword and
 * meta fields so the score updates live as you type; read-only variants (viewer
 * screen) just render the stored row's assessment.
 */
import type { SeoCategory, SeoCheck, SeoResult } from '@seo/contracts';
import { seoScoreLabel } from '@seo/contracts';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const CATEGORIES: SeoCategory[] = ['Metadata', 'Keyword', 'Content', 'Structure', 'Readability'];

const STATUS_ICON: Record<SeoCheck['status'], string> = {
  pass: '✓',
  warn: '!',
  fail: '✕',
  not_applicable: '·',
};

const ICON_COLOR: Record<SeoCheck['status'], string> = {
  pass: 'text-success',
  warn: 'text-warning',
  fail: 'text-destructive',
  not_applicable: 'text-muted-foreground',
};

interface SeoPanelProps {
  result: SeoResult;
  editable?: boolean;
  targetKeyword: string;
  metaTitle: string;
  metaDescription: string;
  onKeywordChange?: (value: string) => void;
  onMetaTitleChange?: (value: string) => void;
  onMetaDescriptionChange?: (value: string) => void;
}

function CheckRow({ check }: { check: SeoCheck }) {
  const status = check.status;
  const dim = status === 'not_applicable';
  return (
    <div className="flex items-start gap-2 rounded-md px-1 py-1.5">
      <span className={cn('w-4 shrink-0 text-center text-[13px] leading-6 font-bold', ICON_COLOR[status])}>
        {STATUS_ICON[status]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex justify-between gap-2">
          <span className={cn('text-[12.5px] font-medium', dim && 'text-muted-foreground')}>{check.label}</span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {status === 'not_applicable' ? '—' : `${check.points}/${check.maxPoints}`}
          </span>
        </div>
        <div className={cn('mt-px text-[11.5px] leading-snug text-muted-foreground', dim && 'text-muted-foreground')} title={check.suggestion}>
          {check.detail}
        </div>
      </div>
    </div>
  );
}

/**
 * Live deterministic SEO panel for the Content Studio workspace. Props: the
 * evaluated `result`, an `editable` flag (viewers get a locked form), the
 * current keyword/meta values, and optional change handlers that feed the
 * parent workspace state.
 */
export function SeoPanel({
  result,
  editable = false,
  targetKeyword,
  metaTitle,
  metaDescription,
  onKeywordChange,
  onMetaTitleChange,
  onMetaDescriptionChange,
}: SeoPanelProps) {
  return (
    <div className="rounded-[10px] border bg-card p-3.5">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">SEO</h3>
        <span className="text-[11px] text-muted-foreground">Deterministic on-page assessment</span>
      </div>

      <div className="mb-2.5 flex items-baseline gap-2.5">
        <div className="tabular-nums">
          <span className="text-[34px] font-extrabold leading-none">{result.score}</span>
          <span className="text-[13px] text-muted-foreground"> / 100</span>
        </div>
        <div className={cn('text-[13px] font-semibold', verdictClass(result.score))}>{seoScoreLabel(result.score)}</div>
      </div>

      <div className="mb-1.5 grid gap-2 border-t pt-1">
        <label className="grid gap-1 text-xs font-medium">
          Target keyword
          <Input
            type="text"
            className="h-8 text-xs"
            value={targetKeyword}
            disabled={!editable}
            placeholder="e.g. content engine"
            onChange={(e) => onKeywordChange?.(e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs font-medium">
          Meta title
          <Input
            type="text"
            className="h-8 text-xs"
            value={metaTitle}
            disabled={!editable}
            placeholder="A click-worthy title for search results"
            onChange={(e) => onMetaTitleChange?.(e.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs font-medium">
          Meta description
          <Textarea
            rows={2}
            className="min-h-[44px] text-xs"
            value={metaDescription}
            disabled={!editable}
            placeholder="One or two sentences summarising the page"
            onChange={(e) => onMetaDescriptionChange?.(e.target.value)}
          />
        </label>
      </div>

      <div>
        {CATEGORIES.map((category) => {
          const checks = result.checks.filter((c) => c.category === category);
          if (checks.length === 0) return null;
          return (
            <div className="mt-2" key={category}>
              <h4 className="mb-1 mt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {category}
              </h4>
              {checks.map((check) => (
                <CheckRow key={check.code} check={check} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function verdictClass(score: number): string {
  if (score >= 80) return 'text-success';
  if (score >= 60) return 'text-warning';
  return 'text-destructive';
}
