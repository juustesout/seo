/**
 * Keyword service (KW1): the Search Console queries the project's linked GSC
 * property is actually seen for.
 *
 * This is a pure read over already-synced rows in `seo_gsc_queries`. It never
 * calls Google and never invents research metrics (volume/difficulty/intent):
 * those belong to the separate tracked-keywords feature (`seo_keywords`). The
 * GSC sync persists one row per (property, date, query) - the current adapter
 * writes country/device/page empty - so a query spans many days and the period
 * has to be rolled up here.
 *
 * CTR and position are recomputed from summed clicks / impressions /
 * (position * impressions); averaging the per-day ctr/position columns would be
 * wrong. Property resolution and every metric read are scoped to the project's
 * own id and its linked property id, so a project can never read another
 * project's queries.
 */
import { z } from 'zod';
import type { KeywordDto, ProjectKeywordsDto } from '@seo/contracts';
import type { ServiceContainer } from '../context.js';
import { ApiError } from '../apiErrors.js';

/** Default window, matching the GSC sync default of 28 days (inclusive). */
const DEFAULT_RANGE_DAYS = 28;
/** Hard ceiling on a single read so a caller cannot scan all history. */
export const MAX_RANGE_DAYS = 366;
/** Default number of returned queries. */
export const DEFAULT_KEYWORD_LIMIT = 100;
/** Hard ceiling on returned queries. */
export const MAX_KEYWORD_LIMIT = 500;
/** Rows fetched per page while scanning; PostgREST caps responses per request. */
const SCAN_PAGE_SIZE = 1000;
/** Refuse to aggregate beyond this many raw rows rather than mislead with a partial sum. */
const MAX_SCAN_ROWS = 200_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC calendar day, e.g. 2026-09-13. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function shiftDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** True for a well-formed, real calendar date (rejects 2026-13-40). */
function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const rangeSchema = z.object({
  startDate: z.string().refine(isRealDate, 'startDate must be an ISO date (YYYY-MM-DD)').optional(),
  endDate: z.string().refine(isRealDate, 'endDate must be an ISO date (YYYY-MM-DD)').optional(),
  limit: z.coerce.number().int().min(1).max(MAX_KEYWORD_LIMIT).default(DEFAULT_KEYWORD_LIMIT),
});

export interface KeywordRange {
  startDate: string;
  endDate: string;
  limit: number;
}

/**
 * Validate query params and fill the deterministic defaults: `endDate` is
 * today (UTC) and `startDate` is the 28 days ending on `endDate` inclusive.
 * The range is bounded in both directions and ordered so a bad range is a 400,
 * never a silent full scan.
 */
export function resolveKeywordRange(raw: unknown): KeywordRange {
  const parsed = rangeSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw ApiError.badRequest('Invalid keyword query parameters', parsed.error.flatten());
  }
  const { limit } = parsed.data;
  const endDate = parsed.data.endDate ?? utcToday();
  const startDate = parsed.data.startDate ?? shiftDays(endDate, -(DEFAULT_RANGE_DAYS - 1));
  if (startDate > endDate) {
    throw ApiError.badRequest('startDate must be on or before endDate');
  }
  const span = Math.round(
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 864e5,
  ) + 1;
  if (span > MAX_RANGE_DAYS) {
    throw ApiError.badRequest(`Date range must be ${MAX_RANGE_DAYS} days or fewer`);
  }
  return { startDate, endDate, limit };
}

function numeric(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

interface QueryRow {
  query: string | null;
  clicks: unknown;
  impressions: unknown;
  position: unknown;
}

/**
 * Roll per-day query rows up to one DTO per query. CTR is clicks/impressions
 * and position is the impression-weighted mean; both are 0 when a query had no
 * impressions. Ordering is impressions desc, clicks desc, then keyword asc so
 * ties are stable and a slice is deterministic.
 */
export function aggregateGscKeywords(rows: QueryRow[]): KeywordDto[] {
  const byQuery = new Map<string, { clicks: number; impressions: number; weighted: number }>();
  for (const row of rows) {
    const keyword = (row.query ?? '').trim();
    if (!keyword) continue;
    const impressions = numeric(row.impressions);
    const acc = byQuery.get(keyword) ?? { clicks: 0, impressions: 0, weighted: 0 };
    acc.clicks += numeric(row.clicks);
    acc.impressions += impressions;
    acc.weighted += numeric(row.position) * impressions;
    byQuery.set(keyword, acc);
  }

  const keywords: KeywordDto[] = [];
  for (const [keyword, acc] of byQuery) {
    keywords.push({
      keyword,
      clicks: acc.clicks,
      impressions: acc.impressions,
      ctr: acc.impressions > 0 ? round(acc.clicks / acc.impressions, 6) : 0,
      position: acc.impressions > 0 ? round(acc.weighted / acc.impressions, 2) : 0,
    });
  }
  keywords.sort(
    (a, b) => b.impressions - a.impressions || b.clicks - a.clicks || a.keyword.localeCompare(b.keyword),
  );
  return keywords;
}

export class KeywordService {
  constructor(private readonly container: ServiceContainer) {}

  /** The primary (else first-linked) GSC property this project uses, if any. */
  private async linkedPropertyId(projectId: string): Promise<string | null> {
    const { data, error } = await this.container.sb
      .from('seo_project_properties')
      .select('property_id')
      .eq('project_id', projectId)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw new ApiError(500, 'storage_error', 'Could not read the linked Search Console property');
    return (data as { property_id?: string } | null)?.property_id ?? null;
  }

  /** Last successful sync time for the project's GSC data source, if any. */
  private async lastSyncedAt(projectId: string): Promise<string | null> {
    const { data, error } = await this.container.sb
      .from('seo_data_sources')
      .select('last_synced_at')
      .eq('project_id', projectId)
      .eq('provider_type', 'gsc')
      .order('last_synced_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return null;
    return (data as { last_synced_at?: string | null } | null)?.last_synced_at ?? null;
  }

  /**
   * Read and aggregate the queries for the project's linked property over the
   * range. Returns an honest empty payload (no propertyId) when the project has
   * not linked a property, so the UI can tell "not connected" apart from
   * "connected but no data yet".
   */
  async listProjectKeywords(projectId: string, range: KeywordRange): Promise<ProjectKeywordsDto> {
    const propertyId = await this.linkedPropertyId(projectId);
    if (!propertyId) return { propertyId: null, lastSyncedAt: null, keywords: [] };

    const rows: QueryRow[] = [];
    for (let offset = 0; ; offset += SCAN_PAGE_SIZE) {
      const { data, error } = await this.container.sb
        .from('seo_gsc_queries')
        .select('query, clicks, impressions, position')
        .eq('project_id', projectId)
        .eq('property_id', propertyId)
        .gte('date', range.startDate)
        .lte('date', range.endDate)
        // A total order over the natural key (date, query) keeps page
        // boundaries stable so no row is dropped or counted twice.
        .order('date', { ascending: true })
        .order('query', { ascending: true })
        .range(offset, offset + SCAN_PAGE_SIZE - 1);
      if (error) throw new ApiError(500, 'storage_error', 'Could not read keyword data');
      const page = (data ?? []) as QueryRow[];
      rows.push(...page);
      if (page.length < SCAN_PAGE_SIZE) break;
      if (rows.length >= MAX_SCAN_ROWS) {
        throw ApiError.badRequest('Too much keyword data for this period; narrow the date range');
      }
    }

    const lastSyncedAt = await this.lastSyncedAt(projectId);
    return {
      propertyId,
      lastSyncedAt,
      keywords: aggregateGscKeywords(rows).slice(0, range.limit),
    };
  }
}
