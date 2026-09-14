/**
 * Opportunity intelligence service (KW5 v1).
 *
 * Reads the project's current-best-known competitor-gap snapshot, consolidates
 * spelling variants into one row per concept, scores each row with the pure
 * `opportunityScoring` module and returns an explainable, bounded projection.
 *
 * It never calls a provider, never mutates the snapshot and never persists a
 * derived result: the whole pipeline is `read -> analyze -> project`. Source
 * intelligence stays the single source of truth.
 */

import {
  OPPORTUNITIES_DEFAULT_LIMIT,
  OPPORTUNITIES_MAX_LIMIT,
  type CompetitorGapDto,
  type KeywordOpportunityDto,
  type OpportunitiesDto,
  type OpportunityCompetitorDto,
  type OpportunityQuery,
  type OpportunitySort,
  type OpportunitySortDir,
} from '@seo/contracts';
import type { ServiceContainer } from '../context.js';
import { canonicalKeywordKey, chooseCanonicalLabel, classifyIntent, type KeywordVariantCount } from './keywordCanonical.js';
import { scoreOpportunity } from './opportunityScoring.js';
import { computeSnapshotFreshness, projectGapRows, readLatestSourceSnapshot } from './sourceSnapshotService.js';

/** A mutable accumulation bucket for one canonical keyword. */
interface KeywordGroup {
  variants: Map<string, number>;
  volumes: number[];
  difficulties: number[];
  cpcs: number[];
  /** domain -> best (lowest) observed rank, null when every rank was missing. */
  competitors: Map<string, number | null>;
}

/** Highest finite value in the list, or null when it holds none. */
function maxOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.max(...values);
}

/**
 * Consolidate bounded gap rows into one opportunity per canonical keyword.
 * Variants are merged deterministically; metrics take the highest reported
 * value (a conservative read of the spelling variants) and competitor ranks
 * keep each domain's best rank. Output order is not significant - the caller
 * applies the query sort.
 */
export function buildOpportunities(gaps: CompetitorGapDto[]): KeywordOpportunityDto[] {
  const groups = new Map<string, KeywordGroup>();

  for (const gap of gaps) {
    const keyword = typeof gap.keyword === 'string' ? gap.keyword.trim() : '';
    if (!keyword) continue;
    const key = canonicalKeywordKey(keyword);
    if (!key) continue;

    let group = groups.get(key);
    if (!group) {
      group = { variants: new Map(), volumes: [], difficulties: [], cpcs: [], competitors: new Map() };
      groups.set(key, group);
    }

    group.variants.set(keyword, (group.variants.get(keyword) ?? 0) + 1);
    if (typeof gap.searchVolume === 'number' && Number.isFinite(gap.searchVolume)) group.volumes.push(gap.searchVolume);
    if (typeof gap.difficulty === 'number' && Number.isFinite(gap.difficulty)) group.difficulties.push(gap.difficulty);
    if (typeof gap.cpc === 'number' && Number.isFinite(gap.cpc)) group.cpcs.push(gap.cpc);

    const domain = typeof gap.competitorDomain === 'string' ? gap.competitorDomain.trim() : '';
    if (domain) {
      const rank = typeof gap.position === 'number' && Number.isFinite(gap.position) ? gap.position : null;
      const existing = group.competitors.get(domain);
      if (existing === undefined) {
        group.competitors.set(domain, rank);
      } else if (rank != null && (existing == null || rank < existing)) {
        group.competitors.set(domain, rank);
      }
    }
  }

  const out: KeywordOpportunityDto[] = [];
  for (const group of groups.values()) {
    const variantCounts: KeywordVariantCount[] = [...group.variants.entries()].map(([value, count]) => ({ value, count }));
    const keyword = chooseCanonicalLabel(variantCounts);

    const competitors: OpportunityCompetitorDto[] = [...group.competitors.entries()]
      .map(([domain, rank]) => ({ domain, rank }))
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));

    const bestRank = competitors.reduce<number | null>(
      (min, c) => (c.rank != null && (min == null || c.rank < min) ? c.rank : min),
      null,
    );
    const searchVolume = maxOrNull(group.volumes);
    const difficulty = maxOrNull(group.difficulties);
    const cpc = maxOrNull(group.cpcs);

    const { score, reasons } = scoreOpportunity({
      searchVolume,
      difficulty,
      cpc,
      competitorCount: competitors.length,
      bestRank,
    });

    out.push({
      keyword,
      variants: variantCounts.map((v) => v.value).sort(),
      searchVolume,
      difficulty,
      cpc,
      competition: null,
      intent: classifyIntent(keyword),
      competitors,
      competitorCount: competitors.length,
      score,
      reasons,
    });
  }
  return out;
}

/** Default direction per sort field when the caller does not specify one. */
const DEFAULT_DIR: Record<OpportunitySort, OpportunitySortDir> = {
  score: 'desc',
  volume: 'desc',
  difficulty: 'asc',
  keyword: 'asc',
};

/** Resolve the effective sort direction for a query. */
function resolveDir(sort: OpportunitySort, dir?: OpportunitySortDir): OpportunitySortDir {
  return dir ?? DEFAULT_DIR[sort];
}

/**
 * Compare two opportunities for a sort field. Nulls always sort last so a
 * missing metric never masquerades as the smallest value, in either direction.
 */
function compareForSort(a: KeywordOpportunityDto, b: KeywordOpportunityDto, sort: OpportunitySort, dir: OpportunitySortDir): number {
  const sign = dir === 'asc' ? 1 : -1;
  if (sort === 'keyword') return sign * (a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0);
  const va = sort === 'score' ? a.score : sort === 'volume' ? a.searchVolume : a.difficulty;
  const vb = sort === 'score' ? b.score : sort === 'volume' ? b.searchVolume : b.difficulty;
  if (va == null && vb == null) return 0;
  if (va == null) return 1;
  if (vb == null) return -1;
  if (va === vb) return 0;
  return sign * (va < vb ? -1 : 1);
}

/** Apply result-view filters, ordering and the bounded limit to built rows. */
function applyQuery(
  rows: KeywordOpportunityDto[],
  query: OpportunityQuery,
): { rows: KeywordOpportunityDto[]; total: number } {
  let filtered = rows;
  if (query.minVolume != null) {
    filtered = filtered.filter((row) => row.searchVolume != null && row.searchVolume >= query.minVolume!);
  }
  if (query.maxDifficulty != null) {
    filtered = filtered.filter((row) => row.difficulty != null && row.difficulty <= query.maxDifficulty!);
  }
  if (query.intent != null) {
    filtered = filtered.filter((row) => row.intent === query.intent);
  }

  const sort: OpportunitySort = query.sort ?? 'score';
  const dir = resolveDir(sort, query.dir);
  const ordered = [...filtered].sort((a, b) => compareForSort(a, b, sort, dir) || (a.keyword < b.keyword ? -1 : 1));

  const requested = query.limit ?? OPPORTUNITIES_DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, requested), OPPORTUNITIES_MAX_LIMIT);
  return { rows: ordered.slice(0, limit), total: filtered.length };
}

/**
 * Read the current gap snapshot, analyze it and return the bounded projection.
 * When no gap snapshot exists the result carries a null snapshot and no rows,
 * so the UI can prompt the user to run a competitor gap analysis first without
 * this call ever spending provider credits.
 */
export async function getOpportunities(
  container: ServiceContainer,
  projectId: string,
  query: OpportunityQuery,
): Promise<OpportunitiesDto> {
  const record = await readLatestSourceSnapshot(container, projectId, 'competitor_gap');
  if (!record) return { snapshot: null, opportunities: [], total: 0, count: 0 };

  const opportunities = buildOpportunities(projectGapRows(record.data.gaps));
  const { rows, total } = applyQuery(opportunities, query);

  return {
    snapshot: {
      id: record.id,
      fetchedAt: record.fetchedAt,
      sourceJobId: record.sourceJobId,
      freshness: computeSnapshotFreshness('competitor_gap', record.fetchedAt),
    },
    opportunities: rows,
    total,
    count: rows.length,
  };
}
