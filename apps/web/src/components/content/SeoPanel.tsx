import type { SeoCategory, SeoCheck, SeoResult } from '@seo/contracts';
import { seoScoreLabel } from '@seo/contracts';

const CATEGORIES: SeoCategory[] = ['Metadata', 'Keyword', 'Content', 'Structure', 'Readability'];

const STATUS_ICON: Record<SeoCheck['status'], string> = {
  pass: '✓',
  warn: '!',
  fail: '✕',
  not_applicable: '·',
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
  return (
    <div className={`chk chk-${status}`}>
      <span className="chk-ic">{STATUS_ICON[status]}</span>
      <div className="chk-body">
        <div className="chk-top">
          <span className="chk-label">{check.label}</span>
          <span className="chk-pts">{status === 'not_applicable' ? '—' : `${check.points}/${check.maxPoints}`}</span>
        </div>
        <div className="chk-detail" title={check.suggestion}>
          {check.detail}
        </div>
      </div>
    </div>
  );
}

/** Live deterministic SEO panel for the Content Studio workspace. */
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
    <div className="seo-panel">
      <div className="seo-head">
        <h3>SEO</h3>
        <span className="muted seo-note">Deterministic on-page assessment</span>
      </div>

      <div className="seo-hero">
        <div className="seo-score">
          <span className="seo-num">{result.score}</span>
          <span className="seo-total">/ 100</span>
        </div>
        <div className={`seo-verdict seo-verdict-${verdictClass(result.score)}`}>{seoScoreLabel(result.score)}</div>
      </div>

      <div className="seo-meta">
        <label className="fld">
          Target keyword
          <input
            type="text"
            value={targetKeyword}
            disabled={!editable}
            placeholder="e.g. content engine"
            onChange={(e) => onKeywordChange?.(e.target.value)}
          />
        </label>
        <label className="fld">
          Meta title
          <input
            type="text"
            value={metaTitle}
            disabled={!editable}
            placeholder="A click-worthy title for search results"
            onChange={(e) => onMetaTitleChange?.(e.target.value)}
          />
        </label>
        <label className="fld">
          Meta description
          <textarea
            rows={2}
            value={metaDescription}
            disabled={!editable}
            placeholder="One or two sentences summarising the page"
            onChange={(e) => onMetaDescriptionChange?.(e.target.value)}
          />
        </label>
      </div>

      <div className="seo-checks">
        {CATEGORIES.map((category) => {
          const checks = result.checks.filter((c) => c.category === category);
          if (checks.length === 0) return null;
          return (
            <div className="seo-group" key={category}>
              <h4>{category}</h4>
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
  if (score >= 90) return 'great';
  if (score >= 80) return 'good';
  if (score >= 60) return 'mid';
  return 'low';
}
