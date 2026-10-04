/**
 * Content performance service (P7 measurement loop).
 *
 * Answers the one question the platform could not answer before: after we
 * published this content, what did Google actually do with it? It joins the
 * three persisted facts the platform owns - the live URL captured by the
 * publisher (seo_publications.target_url), Search Console page performance
 * (seo_gsc_pages) and stored GA4 page traffic (seo_page_traffic) - into one
 * project-scoped, read-only report.
 *
 * It is deliberately not automated SEO: nothing here changes content. Every row
 * is labelled honestly (`measured` vs `no_traffic`), a provider that is not
 * configured is reported as a note, and no metric is fabricated - a page with
 * no matched row shows "no data", never a zero that looks like evidence.
 *
 * Matching is host-agnostic and path-based: both GSC page rows (absolute URLs)
 * and GA4 rows (paths) are reduced to a normalized path and compared with the
 * candidate paths derived from a content item's published URL, url and slug.
 * That reuses the same path vocabulary the intelligence service already uses
 * (contentPathKeys) so the two features can never disagree about what "the
 * same page" means.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ContentPerformanceItem,
  ContentPerformanceReportDto,
  ContentPerformanceSearch,
  ContentPerformanceSyncDto,
  ContentPerformanceTraffic,
  PerformancePeriodDays,
} from '@seo/contracts';
import type { ServiceContainer } from '../context.js';
import { ApiError } from '../apiErrors.js';
import { contentPathKeys } from './contentIntelligence.js';
import { GoogleAnalyticsService } from './googleAnalyticsService.js';
import { enqueueGscSyncIfIdle, GSC_SYNC_JOB_TYPE } from './gscSyncService.js';
import { enqueueAnalyticsSyncIfIdle, ANALYTICS_SYNC_JOB_TYPE } from './analyticsSyncService.js';

type Row = Record<string, unknown>;

export const PERFORMANCE_PERIODS: PerformancePeriodDays[] = [7, 28, 90];
export const DEFAULT_PERFORMANCE_PERIOD: PerformancePeriodDays = 28;

/** Upper bound on content items a single report aggregates. */
const MAX_CONTENT_ITEMS = 500;
/** Upper bound on provider rows read for the join. */
const MAX_METRIC_ROWS = 20000;

/** Parse a requested period into the supported set, defaulting to 28 days. */
export function resolvePerformancePeriodDays(raw: unknown): PerformancePeriodDays {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return (PERFORMANCE_PERIODS as number[]).includes(n) ? (n as PerformancePeriodDays) : DEFAULT_PERFORMANCE_PERIOD;
}

/** UTC YYYY-MM-DD for `date` shifted by `days`. */
function shiftDate(date: Date, days: number): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalize a URL or path to a comparison key: lowercased, no scheme/host, no
 * query/fragment, no trailing slash, always leading slash. Returns null for an
 * empty/unparsable value so it never matches everything.
 */
export function normalizePathKey(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  let path = s;
  if (/^https?:\/\//i.test(s)) {
    try {
      path = new URL(s).pathname;
    } catch {
      return null;
    }
  }
  const stripped = path.split('#')[0]?.split('?')[0]?.replace(/\/+$/, '') ?? '';
  if (!stripped) return '/';
  return (stripped.startsWith('/') ? stripped : `/${stripped}`).toLowerCase();
}

/** The candidate comparison keys for one content item. */
function matchKeys(item: { publication_url: string | null; url: string | null; slug: string | null }): string[] {
  const keys = new Set<string>();
  for (const raw of [item.publication_url, item.url]) {
    const k = normalizePathKey(raw);
    if (k) keys.add(k);
  }
  const candidates = contentPathKeys({ url: item.publication_url ?? item.url, slug: item.slug });
  for (const c of candidates) {
    const k = normalizePathKey(c);
    if (k) keys.add(k);
  }
  return [...keys];
}

interface SearchAgg extends ContentPerformanceSearch {
  positionWeight: number;
}
type TrafficAgg = ContentPerformanceTraffic;

/** The latest publication (by published_at) per content item. */
interface LatestPublication {
  url: string;
  publishedAt: string;
}

/** Whether a project links any GSC property (drives the search source flag). */
async function projectHasGscProperty(sb: SupabaseClient, projectId: string): Promise<boolean> {
  const { data, error } = await sb
    .from('seo_project_properties')
    .select('property_id')
    .eq('project_id', projectId)
    .limit(1);
  if (error) return false;
  return (data ?? []).length > 0;
}

export class ContentPerformanceService {
  constructor(
    private readonly container: ServiceContainer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get sb(): SupabaseClient {
    return this.container.sb;
  }

  /**
   * The durable measurement report. Reads only persisted rows (no live Google
   * call): the sync endpoint is what refreshes the underlying GSC/GA4 data.
   */
  async report(projectId: string, days: PerformancePeriodDays): Promise<ContentPerformanceReportDto> {
    const endDate = shiftDate(this.now(), 0);
    const startDate = shiftDate(this.now(), -(days - 1));
    const notes: string[] = [];

    const latestPublications = await this.latestPublications(projectId);
    const content = await this.contentItems(projectId, [...latestPublications.keys()]);
    const gscLinked = await projectHasGscProperty(this.sb, projectId);
    const ga4Property = await new GoogleAnalyticsService(this.container).currentProperty(projectId);

    if (!gscLinked) notes.push('Connect Search Console to see search performance for published content.');
    if (!ga4Property) notes.push('Bind a Google Analytics property to see page traffic for published content.');

    const gscByPath = gscLinked ? await this.gscByPath(projectId, startDate, endDate) : { map: new Map<string, SearchAgg>(), lastSynced: null as string | null };
    const trafficByPath = ga4Property
      ? await this.trafficByPath(projectId, startDate, endDate)
      : { map: new Map<string, TrafficAgg>(), lastSynced: null as string | null };

    const items: ContentPerformanceItem[] = [];
    for (const c of content) {
      const publication = latestPublications.get(c.id) ?? null;
      const keys = matchKeys({ publication_url: publication?.url ?? null, url: c.url, slug: c.slug });
      let matchedPath: string | null = null;
      let search: SearchAgg | null = null;
      let traffic: TrafficAgg | null = null;
      for (const key of keys) {
        const s = gscByPath.map.get(key);
        const t = trafficByPath.map.get(key);
        if (s || t) {
          matchedPath = key;
          search = s ?? null;
          traffic = t ?? null;
          break;
        }
      }
      const finalSearch: ContentPerformanceSearch | null = search
        ? {
            clicks: search.clicks,
            impressions: search.impressions,
            ctr: search.impressions > 0 ? search.clicks / search.impressions : 0,
            position: search.impressions > 0 ? search.positionWeight / search.impressions : null,
          }
        : null;
      items.push({
        content_id: c.id,
        title: c.title,
        content_status: c.status,
        target_keyword: c.target_keyword,
        publication_url: publication?.url ?? null,
        published_at: publication?.publishedAt ?? c.published_at,
        days_live: this.daysLive(publication?.publishedAt ?? c.published_at, endDate),
        matched_path: matchedPath,
        search: finalSearch,
        traffic: traffic ? { views: traffic.views, active_users: traffic.active_users, sessions: traffic.sessions } : null,
        state: finalSearch || traffic ? 'measured' : 'no_traffic',
      });
    }

    items.sort((a, b) => {
      const aMeasured = a.state === 'measured' ? 0 : 1;
      const bMeasured = b.state === 'measured' ? 0 : 1;
      if (aMeasured !== bMeasured) return aMeasured - bMeasured;
      const aClicks = a.search?.clicks ?? -1;
      const bClicks = b.search?.clicks ?? -1;
      if (aClicks !== bClicks) return bClicks - aClicks;
      return (b.published_at ?? '').localeCompare(a.published_at ?? '');
    });

    const totalsSearch = sumSearch(items);
    const totalsTraffic = sumTraffic(items);

    return {
      project_id: projectId,
      period: { days, start_date: startDate, end_date: endDate },
      sources: { gsc: gscLinked, ga4: Boolean(ga4Property) },
      rows: items,
      totals: { search: totalsSearch, traffic: totalsTraffic },
      last_synced_at: latestOf(gscByPath.lastSynced, trafficByPath.lastSynced),
      notes,
    };
  }

  /** Whole days from a publication date to the report end, or null when unpublished. */
  private daysLive(publishedAt: string | null, endDate: string): number | null {
    if (!publishedAt) return null;
    const start = Date.parse(publishedAt);
    if (!Number.isFinite(start)) return null;
    const end = Date.parse(`${endDate}T23:59:59Z`);
    return Math.max(0, Math.floor((end - start) / 864e5));
  }

  /**
   * The latest successful publication per content id. The publisher writes
   * target_url only after the remote confirms an id, so a row here is a URL the
   * content really lives at. Delete/update attempts are ignored; only the
   * currently successful publish/update is the live URL.
   */
  private async latestPublications(projectId: string): Promise<Map<string, LatestPublication>> {
    const { data, error } = await this.sb
      .from('seo_publications')
      .select('content_id, target_url, published_at, created_at')
      .eq('project_id', projectId)
      .not('content_id', 'is', null)
      .not('target_url', 'is', null)
      .in('status', ['published', 'updated'])
      .order('published_at', { ascending: false })
      .limit(MAX_CONTENT_ITEMS * 4);
    if (error) throw new ApiError(500, 'storage_error', 'Could not read publications');
    const out = new Map<string, LatestPublication>();
    for (const r of (data ?? []) as Row[]) {
      const contentId = text(r.content_id);
      const url = text(r.target_url);
      if (!contentId || !url) continue;
      const publishedAt = text(r.published_at) ?? text(r.created_at);
      const existing = out.get(contentId);
      if (!existing || (publishedAt && publishedAt > existing.publishedAt)) {
        out.set(contentId, { url, publishedAt: publishedAt ?? '' });
      }
    }
    return out;
  }

  /**
   * The content items to report on: anything published (whether or not the
   * publisher was used) plus anything with a successful publication. Draft
   * content with no publication is out of scope - the loop measures publishing.
   */
  private async contentItems(projectId: string, publishedContentIds: string[]): Promise<Array<{
    id: string;
    title: string;
    url: string | null;
    slug: string | null;
    status: string;
    target_keyword: string | null;
    published_at: string | null;
  }>> {
    const columns = 'id, title, url, slug, status, target_keyword, published_at';
    const byId = new Map<string, Row>();
    const { data: published, error: pubErr } = await this.sb
      .from('seo_content')
      .select(columns)
      .eq('project_id', projectId)
      .eq('status', 'published')
      .limit(MAX_CONTENT_ITEMS);
    if (pubErr) throw new ApiError(500, 'storage_error', 'Could not read published content');
    for (const r of (published ?? []) as Row[]) byId.set(String(r.id), r);
    if (publishedContentIds.length > 0) {
      const { data: linked, error: linkErr } = await this.sb
        .from('seo_content')
        .select(columns)
        .eq('project_id', projectId)
        .in('id', publishedContentIds.slice(0, MAX_CONTENT_ITEMS));
      if (linkErr) throw new ApiError(500, 'storage_error', 'Could not read published content');
      for (const r of (linked ?? []) as Row[]) byId.set(String(r.id), r);
    }
    return [...byId.values()].map((r) => ({
      id: String(r.id),
      title: String(r.title ?? 'Untitled'),
      url: text(r.url),
      slug: text(r.slug),
      status: String(r.status ?? 'draft'),
      target_keyword: text(r.target_keyword),
      published_at: text(r.published_at),
    }));
  }

  /** Search Console page rows for the period, aggregated by normalized path. */
  private async gscByPath(projectId: string, startDate: string, endDate: string): Promise<{ map: Map<string, SearchAgg>; lastSynced: string | null }> {
    const { data, error } = await this.sb
      .from('seo_gsc_pages')
      .select('url, clicks, impressions, position')
      .eq('project_id', projectId)
      .gte('date', startDate)
      .lte('date', endDate)
      .limit(MAX_METRIC_ROWS);
    if (error) return { map: new Map(), lastSynced: null };
    const map = new Map<string, SearchAgg>();
    for (const r of (data ?? []) as Row[]) {
      const key = normalizePathKey(text(r.url));
      if (!key) continue;
      const agg = map.get(key) ?? { clicks: 0, impressions: 0, ctr: 0, position: null, positionWeight: 0 };
      const impressions = num(r.impressions);
      agg.clicks += num(r.clicks);
      agg.impressions += impressions;
      agg.positionWeight += num(r.position) * impressions;
      map.set(key, agg);
    }
    return { map, lastSynced: null };
  }

  /** Stored GA4 page traffic for the period, aggregated by normalized path. */
  private async trafficByPath(projectId: string, startDate: string, endDate: string): Promise<{ map: Map<string, TrafficAgg>; lastSynced: string | null }> {
    const { data, error } = await this.sb
      .from('seo_page_traffic')
      .select('path, views, active_users, sessions, fetched_at')
      .eq('project_id', projectId)
      .gte('date', startDate)
      .lte('date', endDate)
      .limit(MAX_METRIC_ROWS);
    if (error) return { map: new Map(), lastSynced: null };
    const map = new Map<string, TrafficAgg>();
    let lastSynced: string | null = null;
    for (const r of (data ?? []) as Row[]) {
      const key = normalizePathKey(text(r.path));
      const fetchedAt = text(r.fetched_at);
      if (fetchedAt && (!lastSynced || fetchedAt > lastSynced)) lastSynced = fetchedAt;
      if (!key) continue;
      const agg = map.get(key) ?? { views: 0, active_users: 0, sessions: 0 };
      agg.views += num(r.views);
      agg.active_users += num(r.active_users);
      agg.sessions += num(r.sessions);
      map.set(key, agg);
    }
    return { map, lastSynced };
  }
}

function sumSearch(items: ContentPerformanceItem[]): ContentPerformanceSearch | null {
  let any = false;
  let clicks = 0;
  let impressions = 0;
  let positionWeight = 0;
  for (const item of items) {
    if (!item.search) continue;
    any = true;
    clicks += item.search.clicks;
    impressions += item.search.impressions;
    if (item.search.position !== null) positionWeight += item.search.position * item.search.impressions;
  }
  if (!any) return null;
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? positionWeight / impressions : null,
  };
}

function sumTraffic(items: ContentPerformanceItem[]): ContentPerformanceTraffic | null {
  let any = false;
  let views = 0;
  let activeUsers = 0;
  let sessions = 0;
  for (const item of items) {
    if (!item.traffic) continue;
    any = true;
    views += item.traffic.views;
    activeUsers += item.traffic.active_users;
    sessions += item.traffic.sessions;
  }
  return any ? { views, active_users: activeUsers, sessions } : null;
}

function latestOf(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Refresh the measurement data: enqueue a GSC and/or GA4 sync when the provider
 * is actually configured, and report what was skipped and why. A provider that
 * is not connected is a skip, never a fabricated job.
 */
export async function syncContentPerformance(
  container: ServiceContainer,
  args: { projectId: string; userId: string; days: number },
): Promise<ContentPerformanceSyncDto> {
  const jobs: ContentPerformanceSyncDto['jobs'] = [];
  const skipped: ContentPerformanceSyncDto['skipped'] = [];
  let reused = false;

  const gscLinked = await projectHasGscProperty(container.sb, args.projectId);
  if (gscLinked) {
    try {
      const r = await enqueueGscSyncIfIdle(container, { projectId: args.projectId, userId: args.userId, params: { days: args.days } });
      jobs.push({ job_type: GSC_SYNC_JOB_TYPE, job_id: r.job.id });
      reused = reused || r.reused;
    } catch {
      skipped.push({ provider: 'gsc', reason: 'Search Console could not be synced' });
    }
  } else {
    skipped.push({ provider: 'gsc', reason: 'Search Console is not connected' });
  }

  const property = await new GoogleAnalyticsService(container).currentProperty(args.projectId);
  if (property) {
    try {
      const r = await enqueueAnalyticsSyncIfIdle(container, { projectId: args.projectId, userId: args.userId, params: { days: args.days } });
      jobs.push({ job_type: ANALYTICS_SYNC_JOB_TYPE, job_id: r.job.id });
      reused = reused || r.reused;
    } catch {
      skipped.push({ provider: 'ga4', reason: 'Google Analytics could not be synced' });
    }
  } else {
    skipped.push({ provider: 'ga4', reason: 'No Google Analytics property is bound to this project' });
  }

  return { jobs, reused, skipped };
}
