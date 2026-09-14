/**
 * Source snapshot service (KW4.5 foundation).
 *
 * Reads and projects the reusable, project-scoped provider intelligence stored
 * in `seo_source_snapshots`. The canonical scope + its hash live in
 * `sourceScope.ts`; this module adds the database read, the bounded row
 * projection and the derived freshness state (never stored).
 *
 * Freshness mirrors the KB7 knowledge model: `fetched_at` is the stored fact and
 * `fresh`/`due`/`stale`/`unknown` is computed on every read, so an expired
 * snapshot stays available and is never deleted by the passing of time.
 */

import {
  COMPETITOR_RESEARCH_MAX_CANDIDATES,
  COMPETITOR_RESEARCH_RUN_MAX_GAPS,
  SOURCE_SNAPSHOT_FRESH_MS,
  SOURCE_SNAPSHOT_STALE_FACTOR,
  type CompetitorCandidateDto,
  type CompetitorGapDto,
  type SourceSnapshotDto,
  type SourceSnapshotFreshnessDto,
  type SourceSnapshotFreshnessState,
  type SourceSnapshotType,
} from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import { scopeKeyOf } from './sourceScope.js';

/** The stored snapshot row, projected to the fields the API needs. */
export interface SourceSnapshotRecord {
  id: string;
  type: SourceSnapshotType;
  provider: string;
  scope: Record<string, unknown>;
  data: Record<string, unknown>;
  fetchedAt: string;
  sourceJobId: string | null;
}

/** Coerce a value to a finite number or null (never a fabricated zero). */
function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Project bounded candidate rows out of a stored payload (never fabricate). */
export function projectCandidateRows(raw: unknown): CompetitorCandidateDto[] {
  if (!Array.isArray(raw)) return [];
  const out: CompetitorCandidateDto[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.domain !== 'string' || !row.domain) continue;
    out.push({
      domain: row.domain,
      sharedKeywords: nullableNumber(row.sharedKeywords),
      keywordsCount: nullableNumber(row.keywordsCount),
      avgPosition: nullableNumber(row.avgPosition),
      etv: nullableNumber(row.etv),
    });
    if (out.length >= COMPETITOR_RESEARCH_MAX_CANDIDATES) break;
  }
  return out;
}

/** Project bounded gap rows out of a stored payload (never fabricate). */
export function projectGapRows(raw: unknown): CompetitorGapDto[] {
  if (!Array.isArray(raw)) return [];
  const out: CompetitorGapDto[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.keyword !== 'string' || !row.keyword) continue;
    if (typeof row.competitorDomain !== 'string' || !row.competitorDomain) continue;
    out.push({
      keyword: row.keyword,
      searchVolume: nullableNumber(row.searchVolume),
      difficulty: nullableNumber(row.difficulty),
      cpc: nullableNumber(row.cpc),
      competitorDomain: row.competitorDomain,
      position: nullableNumber(row.position),
    });
    if (out.length >= COMPETITOR_RESEARCH_RUN_MAX_GAPS) break;
  }
  return out;
}

/**
 * Derive the freshness state from the stored `fetched_at` and the type's
 * window. `fresh` before one window, `due` up to STALE_FACTOR windows, `stale`
 * after. An unparseable/missing time is `unknown` - never guessed.
 */
export function computeSnapshotFreshness(
  type: SourceSnapshotType,
  fetchedAt: string | null,
  now: Date = new Date(),
): SourceSnapshotFreshnessDto {
  if (!fetchedAt) return { state: 'unknown', fetched_at: null, age_ms: null };
  const at = Date.parse(fetchedAt);
  if (!Number.isFinite(at)) return { state: 'unknown', fetched_at: null, age_ms: null };
  const age = Math.max(0, now.getTime() - at);
  const freshMs = SOURCE_SNAPSHOT_FRESH_MS[type];
  const state: SourceSnapshotFreshnessState =
    age < freshMs ? 'fresh' : age >= freshMs * SOURCE_SNAPSHOT_STALE_FACTOR ? 'stale' : 'due';
  return { state, fetched_at: fetchedAt, age_ms: age };
}

/** Map a raw `seo_source_snapshots` row to the service record. */
function mapSnapshotRow(row: Record<string, unknown>, type: SourceSnapshotType): SourceSnapshotRecord {
  return {
    id: String(row.id),
    type,
    provider: typeof row.provider === 'string' ? row.provider : '',
    scope: (row.scope as Record<string, unknown> | null) ?? {},
    data: (row.data as Record<string, unknown> | null) ?? {},
    fetchedAt: String(row.fetched_at),
    sourceJobId: row.source_job_id == null ? null : String(row.source_job_id),
  };
}

const SNAPSHOT_COLUMNS = 'id, type, provider, scope, data, fetched_at, source_job_id';

/** Read the current snapshot for a canonical scope, or null when none exists. */
export async function readSourceSnapshot(
  container: ServiceContainer,
  projectId: string,
  type: SourceSnapshotType,
  scope: Record<string, unknown>,
): Promise<SourceSnapshotRecord | null> {
  const { data, error } = await container.sb
    .from('seo_source_snapshots')
    .select(SNAPSHOT_COLUMNS)
    .eq('project_id', projectId)
    .eq('type', type)
    .eq('scope_key', scopeKeyOf(scope))
    .maybeSingle();
  if (error) throw new ApiError(500, 'storage_error', 'Could not read the source snapshot');
  if (!data) return null;
  return mapSnapshotRow(data as Record<string, unknown>, type);
}

/**
 * Project a stored record into the API DTO, deriving freshness on read.
 */
export async function readLatestSourceSnapshot(
  container: ServiceContainer,
  projectId: string,
  type: SourceSnapshotType,
): Promise<SourceSnapshotRecord | null> {
  const { data, error } = await container.sb
    .from('seo_source_snapshots')
    .select(SNAPSHOT_COLUMNS)
    .eq('project_id', projectId)
    .eq('type', type)
    .order('fetched_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new ApiError(500, 'storage_error', 'Could not read the source snapshot');
  if (!data) return null;
  return mapSnapshotRow(data as Record<string, unknown>, type);
}

/** Project a stored record into the API DTO, deriving freshness on read. */
export function toSourceSnapshotDto(record: SourceSnapshotRecord, now: Date = new Date()): SourceSnapshotDto {
  const candidates = record.type === 'competitor_discovery' ? projectCandidateRows(record.data.competitors) : [];
  const gaps = record.type === 'competitor_gap' ? projectGapRows(record.data.gaps) : [];
  const storedTotal = nullableNumber(record.data.total);
  const count = storedTotal != null ? storedTotal : candidates.length + gaps.length;
  return {
    id: record.id,
    type: record.type,
    scope: record.scope,
    candidates,
    gaps,
    count,
    fetchedAt: record.fetchedAt,
    sourceJobId: record.sourceJobId,
    freshness: computeSnapshotFreshness(record.type, record.fetchedAt, now),
  };
}
