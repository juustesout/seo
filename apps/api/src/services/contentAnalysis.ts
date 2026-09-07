/**
 * Content analysis report (SEO Core).
 *
 * Phase C: this module no longer scores content itself. Scoring lives in the
 * shared, deterministic {@link @seo/contracts!evaluateSeo} evaluator. This
 * module only shapes a {@link SeoResult} into the report structure the
 * analysis endpoints, REST v1, MCP and the content_analyze job already return,
 * so existing consumers keep working against one scoring model.
 *
 * The report is read-only and deterministic: it reshapes whatever the
 * evaluator computed and never re-scores or consults AI. summary.media is the
 * evaluator's count of media-library-backed images; mediaPlaceholders stays 0
 * by design, because placeholder media is a content-agent write-time concept
 * that the deterministic evaluator does not model.
 */

import type { SeoCheck, SeoResult } from '@seo/contracts';

/** One normalized, human-readable problem for the report. severity is derived
 *  from the check status (fail -> error, warn -> warning); the message is the
 *  evaluator's detail text. */
export interface AnalysisIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

/** Deterministic structural counts of the audited document. */
export interface AnalysisSummary {
  words: number;
  headings: number;
  paragraphs: number;
  links: number;
  media: number;
  mediaPlaceholders: number;
  longParagraphs: number;
}

export interface ContentAnalysisReport {
  score: number;
  issues: AnalysisIssue[];
  recommendations: string[];
  summary: AnalysisSummary;
  /** Per-check breakdown produced by the shared deterministic evaluator. */
  checks: SeoCheck[];
  generated_at: string;
}

/** Shape a deterministic SEO evaluation into the legacy report format. */
export function buildContentAnalysisReport(result: SeoResult, generatedAt = new Date().toISOString()): ContentAnalysisReport {
  const issues: AnalysisIssue[] = result.checks
    .filter((c) => c.status === 'fail' || c.status === 'warn')
    .map((c) => ({
      code: c.code,
      severity: c.status === 'fail' ? 'error' : 'warning',
      message: c.detail,
    }));

  const recommendations: string[] = [];
  for (const c of result.checks) {
    if (c.status === 'fail' && c.suggestion && recommendations.length < 6) recommendations.push(c.suggestion);
  }
  for (const c of result.checks) {
    if (c.status === 'warn' && c.suggestion && recommendations.length < 6) recommendations.push(c.suggestion);
  }

  return {
    score: result.score,
    issues,
    recommendations,
    summary: {
      words: result.stats.words,
      headings: result.stats.headings,
      paragraphs: result.stats.paragraphs,
      links: result.stats.links,
      media: result.stats.images,
      mediaPlaceholders: 0,
      longParagraphs: result.stats.longParagraphs,
    },
    checks: result.checks,
    generated_at: generatedAt,
  };
}
