/**
 * SEO Core data API (reads over the normalized store + feature presence).
 * Everything here reads provider-normalized rows; nothing talks to providers.
 * Jobs/dashboard/features drive the UI from real state, never fabricated.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { parseProjectId } from './utils.js';

export const seoRouter: Router = Router({ mergeParams: true });

seoRouter.use(requireAuth);

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 864e5);
  return d.toISOString().slice(0, 10);
}

/** Sum a numeric column over a filtered set. */
async function sumColumn(container: ReturnType<typeof import('../../context.js').getContainer>, table: string, column: string, projectId: string, since: string) {
  const { data, error } = await container.sb
    .from(table)
    .select(`${column}, date`)
    .eq('project_id', projectId)
    .gte('date', since);
  if (error) throw ApiError.badRequest(`Could not read ${table}`);
  const rows = (data as unknown as Array<Record<string, unknown>>) ?? [];
  let total = 0;
  for (const r of rows) total += Number(r[column] ?? 0);
  return { total, days: new Set(rows.map((r) => r.date as string)).size };
}

async function countTable(container: ReturnType<typeof import('../../context.js').getContainer>, table: string, projectId: string, since?: string) {
  let q = container.sb.from(table).select('id', { count: 'exact', head: true }).eq('project_id', projectId);
  if (since) q = q.gte('date', since);
  const { count } = await q;
  return count ?? 0;
}

/** Feature presence computed from provider + connection state (server truth). */
seoRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');

    const [integrations, dataSources] = await Promise.all([
      container.sb.from('seo_integrations').select('provider_type, status, name, last_sync_at').eq('project_id', projectId),
      container.sb.from('seo_data_sources').select('provider_type, kind, name, status, external_id, external_url, last_synced_at').eq('project_id', projectId),
    ]);

    const s7 = daysAgo(7);
    const s28 = daysAgo(28);
    const [perf7, perf28, keywordCount, pageCount, rankCount] = await Promise.all([
      sumColumn(container, 'seo_gsc_performance', 'clicks', projectId, s7),
      sumColumn(container, 'seo_gsc_performance', 'clicks', projectId, s28),
      countTable(container, 'seo_keywords', projectId),
      countTable(container, 'seo_pages', projectId),
      container.sb
        .from('seo_rankings')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .gte('date', s28),
    ]);

    const impressions28 = await sumColumn(container, 'seo_gsc_performance', 'impressions', projectId, s28);
    const { data: queries } = await container.sb
      .from('seo_gsc_queries')
      .select('query, clicks, impressions, ctr, position, date')
      .eq('project_id', projectId)
      .gte('date', s28)
      .order('clicks', { ascending: false })
      .limit(8);

    const lastSync =
      (dataSources.data ?? []).reduce<string | null>((acc, ds) => {
        const t = (ds as Record<string, unknown>).last_synced_at as string | null;
        if (t && (!acc || t > acc)) return t;
        return acc;
      }, null) ?? null;

    const activeGsc = (dataSources.data ?? []).some((d) => (d as Record<string, unknown>).provider_type === 'gsc' && (d as Record<string, unknown>).status === 'active');
    const connectedDf = (integrations.data ?? []).some((i) => (i as Record<string, unknown>).provider_type === 'dataforseo' && (i as Record<string, unknown>).status === 'connected');
    const qdrantAvailable = container.registry.listKnowledge().length > 0;
    const publisherAvailable = container.registry.listPublishers().length > 0;

    const topQueries = (queries as unknown as Array<Record<string, unknown>> | null) ?? [];

    res.json({
      data: {
        project_id: projectId,
        performance: { last_7d: perf7.total, last_28d: perf28.total, impressions_28d: impressions28.total, days: perf28.days },
        counts: { keywords: keywordCount, pages: pageCount, ranking_rows_28d: rankCount.count ?? 0 },
        top_queries: topQueries.slice(0, 5).map((q) => ({
          query: q.query,
          clicks: q.clicks,
          impressions: q.impressions,
          position: Math.round(Number(q.position) * 100) / 100,
        })),
        sources: { integrations: integrations.data ?? [], data_sources: dataSources.data ?? [], last_sync_at: lastSync },
        features: {
          search_console_data: activeGsc,
          serp_tracking: connectedDf,
          keyword_research: connectedDf,
          knowledge_base: qdrantAvailable,
          publishing: publisherAvailable,
          site_audit: false, // no crawler provider registered -> honest off state
        },
      },
    });
  }),
);

/** Daily performance series (from seo_gsc_performance rollups). */
seoRouter.get(
  '/performance',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const days = z.coerce.number().int().min(1).max(370).default(28).parse(req.query.days);
    const { data } = await container.sb
      .from('seo_gsc_performance')
      .select('date, clicks, impressions, ctr, position')
      .eq('project_id', projectId)
      .gte('date', daysAgo(days))
      .order('date', { ascending: true });
    const byDay = new Map<string, { clicks: number; impressions: number; ctr: number; position: number }>();
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = row.date as string;
      const cur = byDay.get(key) ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
      cur.clicks += Number(row.clicks ?? 0);
      cur.impressions += Number(row.impressions ?? 0);
      cur.ctr += Number(row.ctr ?? 0);
      cur.position += Number(row.position ?? 0);
      byDay.set(key, cur);
    }
    const series = [...byDay.entries()].map(([date, v]) => ({
      date,
      clicks: v.clicks,
      impressions: v.impressions,
      ctr: byDay.size ? Number((v.ctr / byDay.size).toFixed(6)) : 0,
      avg_position: byDay.size ? Number((v.position / byDay.size).toFixed(2)) : 0,
    }));
    res.json({ data: { series, days } });
  }),
);

/** Tracked keywords list. */
seoRouter.get(
  '/keywords',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0), source: z.string().optional() }).parse(req.query);
    let q = container.sb.from('seo_keywords').select('keyword, intent, volume, difficulty, cpc, source, provider, last_seen_at').eq('project_id', projectId);
    if (parsed.source) q = q.eq('source', parsed.source);
    const { data, error } = await q.order('last_seen_at', { ascending: false }).range(parsed.offset, parsed.offset + parsed.limit - 1);
    if (error) throw ApiError.badRequest('Could not read keywords');
    const { count } = await container.sb.from('seo_keywords').select('id', { count: 'exact', head: true }).eq('project_id', projectId);
    res.json({ data: { keywords: data ?? [], total: count ?? 0 } });
  }),
);

/** Tracked/last-seen pages list. */
seoRouter.get(
  '/pages',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const { data, error } = await container.sb
      .from('seo_pages')
      .select('url, title, status_code, word_count, is_indexable, last_seen_at, provider')
      .eq('project_id', projectId)
      .order('last_seen_at', { ascending: false })
      .range(parsed.offset, parsed.offset + parsed.limit - 1);
    if (error) throw ApiError.badRequest('Could not read pages');
    res.json({ data: { pages: data ?? [] } });
  }),
);

/** Latest ranking snapshot per tracked keyword. */
seoRouter.get(
  '/rankings',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const { data: latestRow } = await container.sb.from('seo_rankings').select('date').eq('project_id', projectId).order('date', { ascending: false }).limit(1).maybeSingle();
    if (!latestRow) {
      res.json({ data: { date: null, rankings: [] } });
      return;
    }
    const { data } = await container.sb
      .from('seo_rankings')
      .select('keyword, url, position, engine, date, source')
      .eq('project_id', projectId)
      .eq('date', (latestRow as Record<string, unknown>).date as string)
      .order('position', { ascending: true })
      .limit(100);
    res.json({ data: { date: (latestRow as Record<string, unknown>).date, rankings: data ?? [] } });
  }),
);

/** Latest site audit findings (populated by crawl/audit jobs). */
seoRouter.get(
  '/audits',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const { data, error } = await container.sb
      .from('seo_audits')
      .select('severity, finding_key, title, detail, recommendation, url, audited_at')
      .eq('project_id', projectId)
      .order('audited_at', { ascending: false })
      .limit(parsed.limit);
    if (error) throw ApiError.badRequest('Could not read audit findings');
    res.json({ data: { findings: data ?? [] } });
  }),
);
