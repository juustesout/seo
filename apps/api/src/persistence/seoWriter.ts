/**
 * SEO data writer - the ONLY place that persists normalized provider output
 * into Supabase (besides user-content CRUD which the web client performs under
 * RLS). Handles upsert semantics that respect historical data (e.g. rankings
 * for a given date are never overwritten once written).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkedUpsert } from '../supabase.js';
import { logger } from '../logger.js';
import type { AuditFinding, IsoDate, IsoDateTime, KeywordResearchResult, SerpItem } from '@seo/contracts';
import type { GscDailyRow, GscPageRowInput, GscQueryRowInput } from '../providers/gsc/gscDataSource.js';

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

export class SeoWriter {
  constructor(private readonly sb: SupabaseClient) {}

  // -- GSC ------------------------------------------------------------------

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

  async persistAuditFindings(projectId: string, findings: AuditFinding[]) {
    await chunkedUpsert(this.sb, 'seo_audits', findings.map((f) => ({ ...f, project_id: projectId })));
  }

  // -- Sync bookkeeping -------------------------------------------------------

  async markDataSourceSynced(projectId: string, dataSourceId: string, at = new Date().toISOString()) {
    await this.sb
      .from('seo_data_sources')
      .update({ last_synced_at: at, status: 'active' })
      .eq('project_id', projectId)
      .eq('id', dataSourceId);
  }

  async markDataSourceError(projectId: string, dataSourceId: string, message: string) {
    await this.sb
      .from('seo_data_sources')
      .update({ status: 'error' })
      .eq('project_id', projectId)
      .eq('id', dataSourceId);
    logger.warn({ projectId, dataSourceId }, `data source sync error: ${message}`);
  }
}
