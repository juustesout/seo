/**
 * Content intelligence (Content Studio Phase G).
 *
 * A read-only, per-content report that aggregates deterministic signals from
 * the sources the platform already stores (GSC, DataForSEO keyword data,
 * project knowledge, the Phase C SEO evaluator) into one normalized
 * recommendation list. Every recommendation is source-typed and carries the
 * evidence it was derived from - no invented metrics, no second scoring
 * engine. The report degrades gracefully when an integration is unavailable.
 *
 * This module is shared by the API service and the web editor panel. It holds
 * pure types only (no runtime logic) so both sides compile against the same
 * contract.
 */

export type ContentIntelligenceSourceId = 'seo' | 'gsc' | 'dataforseo' | 'knowledge';

/** Data-driven recommendation sources - 'ai' is the optional assistant. */
export type ContentRecommendationSourceId = ContentIntelligenceSourceId | 'ai';

/** Honest availability of one signal source for this content report. */
export type ContentIntelligenceSourceState = 'configured' | 'no_data' | 'not_configured';

export type ContentRecommendationType = 'issue' | 'opportunity' | 'insight';

export type ContentRecommendationPriority = 'high' | 'medium' | 'low';

/** One piece of evidence a recommendation is derived from (real stored data). */
export interface ContentRecommendationEvidence {
  /** Short label, e.g. "28-day impressions". */
  label: string;
  /** Formatted value, e.g. "1,240". */
  value: string;
  /** Optional URL that points at the underlying record. */
  url?: string | null;
}

/** Optional, non-destructive guidance attached to a recommendation. */
export interface ContentRecommendationAction {
  /** Suggested next step (what to change / where to look). */
  text?: string | null;
}

export interface ContentRecommendation {
  /** Stable identifier, e.g. "gsc:low_ctr_query". */
  id: string;
  /** issue | opportunity | insight - not a score. */
  type: ContentRecommendationType;
  priority: ContentRecommendationPriority;
  /** Which signal produced this recommendation. */
  source: ContentRecommendationSourceId;
  /** Machine-stable code, e.g. "low_ctr_query". */
  code: string;
  title: string;
  description: string;
  /** The stored rows/metrics this recommendation points back to. */
  evidence?: ContentRecommendationEvidence[];
  action?: ContentRecommendationAction | null;
  /** True when the editor may hide this card (client-side only). */
  dismissible: boolean;
}

export interface ContentIntelligenceSource {
  id: ContentIntelligenceSourceId;
  label: string;
  state: ContentIntelligenceSourceState;
  /** Human explanation when not fully usable (never contains secrets). */
  note: string | null;
}

/** Optional, clearly-labelled AI assistant status (never a second score). */
export interface ContentIntelligenceAi {
  /** Whether the caller asked for the optional AI pass. */
  requested: boolean;
  /** Whether a working AI provider resolved for this project. */
  available: boolean;
  /** Failure/absence explanation; null when nothing to say. */
  note: string | null;
}

export interface ContentIntelligenceReport {
  project_id: string;
  content_id: string;
  generated_at: string;
  /** Canonical deterministic Phase C SEO score of the saved document. */
  seo_score: number | null;
  sources: ContentIntelligenceSource[];
  recommendations: ContentRecommendation[];
  ai: ContentIntelligenceAi;
}
