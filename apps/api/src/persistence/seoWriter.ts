/**
 * SEO data writer - the ONLY place that persists normalized provider output
 * into Supabase (besides user-content CRUD which the web client performs under
 * RLS). Handles upsert semantics that respect historical data (e.g. rankings
 * for a given date are never overwritten once written).
 *
 * Why a single writer: every executor (gsc_sync, serp_retrieval, rank_sync,
 * audit, ...) funnels through here, so idempotency rules, onConflict keys and
 * "what counts as the natural key" live in one place. Executors therefore
 * produce typed payloads and never hand-craft inserts, and a new data source
 * cannot accidentally invent a conflicting storage convention.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkedUpsert } from '../supabase.js';
import { logger } from '../logger.js';
import { ApiError } from '../apiErrors.js';
import type { AuditFinding, CompetitorKeywordGap, IsoDate, IsoDateTime, KeywordResearchResult, SerpItem, SourceSnapshotType } from '@seo/contracts';
import type { GscDailyRow, GscPageRowInput, GscQueryRowInput } from '../providers/gsc/gscDataSource.js';
import { scopeKeyOf } from '../services/sourceScope.js';

/** One gsc_sync job's full output: daily rollup + dimensioned query/page rows. */
export interface GscSyncPayload {
  propertyId: string;
  daily: GscDailyRow[];
  queries: GscQueryRowInput[];
  pages: GscPageRowInput[];
}

/** Minimal structural row shapes the writer accepts for normalized pages. */
export interface PageInput {
  url: string;
  source: string;
  provider: string;
  is_homepage?: boolean;
}

/**
 * One ranking observation for a (source, keyword, url, date). Rows are
 * append-only; `date` is the observation date the report described, not the
 * write time, so re-syncing an old window must not touch newer data.
 */
export interface RankingInput {
  keyword_id?: string | null;
  keyword: string;
  page_id?: string | null;
  url: string;
  domain?: string | null;
  position?: number | null;
  engine?: string;
  country?: string | null;
  device?: string | null;
  source: string;
  date: IsoDate;
  is_estimate?: boolean;
  meta?: Record<string, unknown>;
}

/**
 * One SERP fetch, persisted as one row per ranked result (see persistSerpSnapshots).
 * results are the ordered organic/paid items the fetch captured.
 */
export interface SerpSnapshotInput {
  keyword_id?: string | null;
  keyword: string;
  engine?: string;
  country?: string | null;
  locale?: string | null;
  device?: string | null;
  url?: string | null;
  fetched_at: IsoDateTime;
  results: SerpItem[];
}

/**
 * One explicitly saved KW4 expansion candidate, ready to upsert. `meta`
 * carries the run-derived provenance (run id, methods, seeds, related depth)
 * computed server-side; it is never accepted from the client.
 */
export interface ExpansionKeywordInput {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competition: string | null;
  intent: string | null;
  meta: Record<string, unknown>;
}

/**
 * One reusable source snapshot ready to upsert (KW4.5). `scope` is the
 * canonical provider-affecting identity; the writer derives `scope_key` from it
 * so a caller can never store a row whose key does not match its scope.
 */
export interface SourceSnapshotInput {
  type: SourceSnapshotType;
  provider: string;
  scope: Record<string, unknown>;
  data: Record<string, unknown>;
  schemaVersion?: number;
  sourceJobId?: string | null;
}

/** One deduplicated seo_keywords row derived from competitor gap evidence. */
export interface DedupedGapKeyword {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competitorDomains: string[];
}

/** Coerce a value to a finite number or null (never a fabricated zero). */
function finiteOrNull(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Highest finite value of two, or null when neither is a finite number. */
function bestMetric(a: number | null, b: number | null): number | null {
  const values = [a, b].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return values.length > 0 ? Math.max(...values) : null;
}

/**
 * Collapse competitor gap rows onto the `seo_keywords` persistence key
 * (project, provider, source, keyword), which does not include the competitor.
 * Without this, two competitors ranking for the same keyword would put two rows
 * with the same conflict key in one upsert and Postgres would reject the whole
 * batch - after the paid provider call. Metrics keep the highest finite value
 * (they are keyword-level and identical across competitors) and every
 * contributing competitor stays in `competitorDomains` as provenance. The full
 * per-competitor evidence lives in the source snapshot, never here.
 */
export function dedupeGapKeywords(gaps: CompetitorKeywordGap[]): DedupedGapKeyword[] {
  const byKeyword = new Map<string, DedupedGapKeyword>();
  for (const gap of gaps) {
    if (!gap.keyword) continue;
    const domain = gap.competitor_domain;
    const existing = byKeyword.get(gap.keyword);
    if (!existing) {
      byKeyword.set(gap.keyword, {
        keyword: gap.keyword,
        volume: finiteOrNull(gap.search_volume),
        difficulty: finiteOrNull(gap.difficulty),
        cpc: finiteOrNull(gap.cpc),
        competitorDomains: domain ? [domain] : [],
      });
      continue;
    }
    existing.volume = bestMetric(existing.volume, finiteOrNull(gap.search_volume));
    existing.difficulty = bestMetric(existing.difficulty, finiteOrNull(gap.difficulty));
    existing.cpc = bestMetric(existing.cpc, finiteOrNull(gap.cpc));
    if (domain && !existing.competitorDomains.includes(domain)) existing.competitorDomains.push(domain);
  }
  return [...byKeyword.values()]
    .map((row) => ({ ...row, competitorDomains: [...row.competitorDomains].sort() }))
    .sort((a, b) => (a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0));
}

/**
 * The single persistence gateway for normalized provider SEO data. Takes the
 * Supabase service-role client; RLS remains the boundary and every write is
 * project-scoped by the caller-supplied projectId.
 */
export class SeoWriter {
  constructor(private readonly sb: SupabaseClient) {}

  // -- GSC ------------------------------------------------------------------

  /**
   * Persist one GSC sync in three upserts. Daily rollups key on
   * (property_id, date); query/page tables add their dimension columns to the
   * key. All use onConflict upsert (overwrite on re-sync), which is correct
   * for GSC because Google returns the *authoritative* number for a date -
   * unlike rankings, GSC metrics are mutable and a re-sync should update them.
   */
  async persistGsc(projectId: string, payload: GscSyncPayload) {
    const { propertyId, daily, queries, pages } = payload;
    const gscProperty = { property_id: propertyId };

    if (daily.length > 0) {
      await chunkedUpsert(
        this.sb,
        'seo_gsc_performance',
        daily.map((d) => ({ ...gscProperty, project_id: projectId, date: d.date, clicks: d.clicks, impressions: d.impressions, ctr: d.ctr, position: d.position })),
        { onConflict: 'property_id,date' },
      );
    }
    if (queries.length > 0) {
      await chunkedUpsert(
        this.sb,
        'seo_gsc_queries',
        queries.map((q) => ({
          ...gscProperty,
          project_id: projectId,
          date: q.date,
          query: q.keyword,
          country: '',
          device: '',
          page: '',
          clicks: q.clicks,
          impressions: q.impressions,
          ctr: q.ctr,
          position: q.position,
        })),
        { onConflict: 'property_id,date,query,country,device,page' },
      );
    }
    if (pages.length > 0) {
      await chunkedUpsert(
        this.sb,
        'seo_gsc_pages',
        pages.map((p) => ({
          ...gscProperty,
          project_id: projectId,
          date: p.date,
          url: p.page,
          country: '',
          device: '',
          clicks: p.clicks,
          impressions: p.impressions,
          ctr: p.ctr,
          position: p.position,
        })),
        { onConflict: 'property_id,date,url,country,device' },
      );
    }
    logger.info({ projectId, propertyId, daily: daily.length, queries: queries.length, pages: pages.length }, 'gsc data persisted');
  }

  /**
   * Upsert GSC-seen keywords into the keyword registry. Duplicates within one
   * sync are deduped first; the natural key (project, provider, source,
   * keyword) makes repeated syncs additive, and the latest position is kept in
   * meta so the keyword table shows a "last known position" without a join.
   */
  async ingestGscKeywords(projectId: string, queries: GscQueryRowInput[]) {
    const seen = new Set<string>();
    const now = new Date().toISOString();
    const rows = [];
    for (const q of queries) {
      if (seen.has(q.keyword)) continue;
      seen.add(q.keyword);
      rows.push({
        project_id: projectId,
        keyword: q.keyword,
        source: 'gsc',
        provider: 'gsc',
        meta: { last_position: q.position },
        last_seen_at: now,
      });
    }
    if (rows.length === 0) return;
    await chunkedUpsert(this.sb, 'seo_keywords', rows, {
      onConflict: 'project_id,provider,source,keyword',
      ignoreDuplicates: true,
    });
  }

  // -- Pages / keywords / rankings / serp / audits ----------------------------

  /**
   * Upsert crawled/discovered pages. ignoreDuplicates keeps the first-seen
   * row (a page's provider/source should not flip each crawl); last_seen_at is
   * refreshed so the pages list reflects current crawl coverage.
   */
  async persistPages(projectId: string, pages: PageInput[]) {
    const now = new Date().toISOString();
    await chunkedUpsert(
      this.sb,
      'seo_pages',
      pages.map((p) => ({
        project_id: projectId,
        url: p.url,
        source: p.source,
        provider: p.provider,
        is_homepage: p.is_homepage ?? false,
        last_seen_at: now,
      })),
      { onConflict: 'project_id,url', ignoreDuplicates: true },
    );
  }

  /**
   * Persist keyword-research results. These rows overwrite on re-research
   * (same natural key): unlike rankings, keyword metrics are a fresh snapshot,
   * and keeping stale volume/difficulty around would mislead the keyword table.
   */
  async persistKeywordResearch(projectId: string, results: KeywordResearchResult[]) {
    const now = new Date().toISOString();
    const rows = results.map((r) => ({
      project_id: projectId,
      keyword: r.keyword,
      volume: r.search_volume,
      difficulty: r.difficulty,
      cpc: r.cpc,
      competition: r.competition,
      source: 'dataforseo',
      provider: 'dataforseo',
      intent: r.keyword_intents?.join(',') ?? null,
      meta: { monthly_searches: r.monthly_searches ?? [], intents: r.keyword_intents ?? [] },
      last_seen_at: now,
    }));
    await chunkedUpsert(this.sb, 'seo_keywords', rows, {
      onConflict: 'project_id,provider,source,keyword',
    });
  }

  /**
   * Enrich the shared keyword store with keywords discovered through a
   * competitor gap (KW3). These rows are written under their own `source`
   * ('competitor_gap') so they never overwrite research-owned rows for the same
   * keyword; `meta` carries provenance (which competitor, which gap type). The
   * run's authoritative, per-competitor mapping still lives on the job result -
   * this is enrichment, not the source of truth.
   */
  async persistCompetitorGapKeywords(projectId: string, gaps: CompetitorKeywordGap[]) {
    if (gaps.length === 0) return;
    const now = new Date().toISOString();
    const rows = dedupeGapKeywords(gaps).map((g) => ({
      project_id: projectId,
      keyword: g.keyword,
      volume: g.volume,
      difficulty: g.difficulty,
      cpc: g.cpc,
      competition: null,
      source: 'competitor_gap',
      provider: 'dataforseo',
      intent: null,
      meta: {
        discovered_via: 'competitor_gap',
        gap_type: 'competitor_only',
        competitor_domains: g.competitorDomains,
        competitor_count: g.competitorDomains.length,
      },
      last_seen_at: now,
    }));
    await chunkedUpsert(this.sb, 'seo_keywords', rows, {
      onConflict: 'project_id,provider,source,keyword',
    });
  }

  /**
   * Persist an explicitly saved KW4 expansion selection into the shared
   * keyword store under `source = 'keyword_expansion'`. The service has
   * already verified every row against the run snapshot and derived its
   * provenance, so the writer only maps columns and upserts on the natural key
   * (re-saving the same selection updates metrics rather than duplicating).
   */
  async persistExpansionKeywords(projectId: string, rows: ExpansionKeywordInput[]) {
    if (rows.length === 0) return;
    const now = new Date().toISOString();
    await chunkedUpsert(
      this.sb,
      'seo_keywords',
      rows.map((r) => ({
        project_id: projectId,
        keyword: r.keyword,
        volume: r.volume,
        difficulty: r.difficulty,
        cpc: r.cpc,
        competition: r.competition,
        source: 'keyword_expansion',
        provider: 'dataforseo',
        intent: r.intent,
        meta: r.meta,
        last_seen_at: now,
      })),
      { onConflict: 'project_id,provider,source,keyword' },
    );
  }

  /**
   * Upsert the current best-known snapshot for one canonical scope (KW4.5).
   * A refresh overwrites in place on (project_id, type, scope_key); this table
   * is deliberately not a history. `fetched_at` is set to now because the
   * caller only persists after a provider call actually returned.
   */
  async persistSourceSnapshot(projectId: string, input: SourceSnapshotInput) {
    const { error } = await this.sb.from('seo_source_snapshots').upsert(
      {
        project_id: projectId,
        type: input.type,
        provider: input.provider,
        scope: input.scope,
        scope_key: scopeKeyOf(input.scope),
        data: input.data,
        schema_version: input.schemaVersion ?? 1,
        fetched_at: new Date().toISOString(),
        source_job_id: input.sourceJobId ?? null,
      },
      { onConflict: 'project_id,type,scope_key' },
    );
    if (error) {
      logger.error({ error, type: input.type }, 'source snapshot upsert failed');
      throw new ApiError(500, 'storage_error', 'Failed to store the source snapshot', error.message);
    }
  }

  /**
   * Rankings are append-only time-series: once a (source, keyword, url,
   * date) row exists it is never overwritten (historical integrity).
   */
  async persistRankings(projectId: string, rankings: RankingInput[]) {
    await chunkedUpsert(
      this.sb,
      'seo_rankings',
      rankings.map((r) => ({
        project_id: projectId,
        keyword_id: r.keyword_id,
        keyword: r.keyword,
        page_id: r.page_id,
        url: r.url,
        domain: r.domain,
        position: r.position,
        engine: r.engine,
        country: r.country,
        device: r.device,
        source: r.source,
        date: r.date,
        is_estimate: r.is_estimate ?? false,
        meta: r.meta ?? {},
      })),
      { onConflict: 'project_id,source,keyword,url,engine,country,device,date', ignoreDuplicates: true },
    );
  }

  /**
   * Persist SERP snapshots as one seo_serp_results row per ranked item (a
   * snapshot = keyword x ranked URLs at fetched_at). Each item records its
   * own url/domain/position/kind so the table doubles as a historical SERP
   * record that can be diffed against the latest fetch per keyword.
   */
  async persistSerpSnapshots(projectId: string, snapshots: SerpSnapshotInput[]) {
    for (const s of snapshots) {
      await chunkedUpsert(
        this.sb,
        'seo_serp_results',
        s.results.map((item) => ({
          project_id: projectId,
          keyword_id: s.keyword_id,
          keyword: s.keyword,
          engine: s.engine,
          country: s.country,
          locale: s.locale,
          device: s.device,
          url: item.url,
          domain: item.domain,
          position: item.position,
          title: item.title,
          description: item.description,
          kind: item.kind,
          is_paid: item.is_paid,
          fetched_at: s.fetched_at,
        })),
      );
    }
  }

  /**
   * Append audit findings produced by crawl/audit jobs. Findings carry their
   * own natural keys from the provider; a fresh audit run is expected to
   * replace findings for the URLs it re-crawled.
   */
  async persistAuditFindings(projectId: string, findings: AuditFinding[]) {
    await chunkedUpsert(this.sb, 'seo_audits', findings.map((f) => ({ ...f, project_id: projectId })));
  }

  // -- Sync bookkeeping -------------------------------------------------------

  /** Mark a data source successfully synced (drives the "last synced" UI state). */
  async markDataSourceSynced(projectId: string, dataSourceId: string, at = new Date().toISOString()) {
    await this.sb
      .from('seo_data_sources')
      .update({ last_synced_at: at, status: 'active' })
      .eq('project_id', projectId)
      .eq('id', dataSourceId);
  }

  /** Flag a data source as failed so the UI shows the error instead of stale silence. */
  async markDataSourceError(projectId: string, dataSourceId: string, message: string) {
    await this.sb
      .from('seo_data_sources')
      .update({ status: 'error' })
      .eq('project_id', projectId)
      .eq('id', dataSourceId);
    logger.warn({ projectId, dataSourceId }, `data source sync error: ${message}`);
  }
}
