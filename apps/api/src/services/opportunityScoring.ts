/**
 * Opportunity scoring (KW5 v1).
 *
 * One pure, deterministic function turns the facts of a consolidated keyword
 * into a 0-100 score plus the reason tags that explain it. The score is a
 * weighted sum of four bounded signals, never a black box:
 *
 *   volume      - logarithmic (keyword volumes have huge outliers)
 *   difficulty  - lower is better; missing -> neutral, never a fake zero
 *   cpc         - a small commercial signal, deliberately lightly weighted
 *   competitors - validated demand, capped so it cannot dominate
 *
 * Missing metrics are neutral (or zero for the cpc bonus) and never raised to
 * a reason. The same input always yields exactly the same score and reasons.
 */

import type { OpportunityReason } from '@seo/contracts';

export interface OpportunityScoreInput {
  searchVolume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competitorCount: number;
  /** Best (lowest) competitor rank, or null when no rank was reported. */
  bestRank: number | null;
}

export interface OpportunityScoreResult {
  /** Integer 0-100. */
  score: number;
  reasons: OpportunityReason[];
}

const VOLUME_WEIGHT = 0.4;
const DIFFICULTY_WEIGHT = 0.3;
const COMMERCIAL_WEIGHT = 0.15;
const COMPETITOR_WEIGHT = 0.15;

/** Neutral component value for a missing metric (neither reward nor punish). */
const NEUTRAL = 0.5;

/** Volume at/above which the logarithmic volume component saturates. */
const VOLUME_CEILING = 100_000;

/** Monthly CPC (USD) at/above which the commercial component saturates. */
const CPC_CEILING = 10;

/** Unique competitors at/above which the validation component saturates. */
const COMPETITOR_CAP = 3;

/** A volume component at/above this earns the `high_volume` reason. */
const HIGH_VOLUME_AT = 0.6;

/** Difficulty at/below this earns the `low_difficulty` reason. */
const LOW_DIFFICULTY_AT = 40;

/** CPC (USD) at/above this earns the `commercial_value` reason. */
const COMMERCIAL_AT = 1;

/** A competitor rank at/below this earns the `top_competitor_rank` reason. */
const TOP_RANK_AT = 3;

/** Clamp a number to the 0..1 range. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Logarithmically normalize a positive value against a ceiling into 0..1. */
function logScore(value: number, ceiling: number): number {
  if (!(value > 0)) return 0;
  return clamp01(Math.log10(value + 1) / Math.log10(ceiling + 1));
}

/** Compute the explainable score and reasons for one consolidated keyword. */
export function scoreOpportunity(input: OpportunityScoreInput): OpportunityScoreResult {
  const volumeScore = input.searchVolume == null ? NEUTRAL : logScore(input.searchVolume, VOLUME_CEILING);
  const difficultyScore = input.difficulty == null ? NEUTRAL : clamp01(1 - input.difficulty / 100);
  const commercialScore = input.cpc == null ? 0 : logScore(input.cpc, CPC_CEILING);
  const competitors = Number.isFinite(input.competitorCount) ? Math.max(0, input.competitorCount) : 0;
  const competitorScore = clamp01(Math.min(competitors, COMPETITOR_CAP) / COMPETITOR_CAP);

  const weighted =
    volumeScore * VOLUME_WEIGHT +
    difficultyScore * DIFFICULTY_WEIGHT +
    commercialScore * COMMERCIAL_WEIGHT +
    competitorScore * COMPETITOR_WEIGHT;
  const score = Math.round(clamp01(weighted) * 100);

  const reasons: OpportunityReason[] = [];
  if (input.searchVolume != null && volumeScore >= HIGH_VOLUME_AT) reasons.push('high_volume');
  if (input.difficulty != null && input.difficulty <= LOW_DIFFICULTY_AT) reasons.push('low_difficulty');
  if (input.cpc != null && input.cpc >= COMMERCIAL_AT) reasons.push('commercial_value');
  if (competitors >= 2) reasons.push('multiple_competitors_rank');
  if (input.bestRank != null && input.bestRank <= TOP_RANK_AT) reasons.push('top_competitor_rank');

  return { score, reasons };
}
