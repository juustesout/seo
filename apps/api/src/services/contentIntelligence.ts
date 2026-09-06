/**
 * Content intelligence signal helpers (SEO Core).
 *
 * Deterministic, dependency-free computations over the rows the platform
 * already stores (GSC pages/queries, DataForSEO keyword rows, knowledge
 * source rows, Phase C SEO checks). Everything here is pure - no network, no
 * provider calls - so it can be unit tested and reused by the intelligence
 * service, REST/MCP and the worker identically.
 */

import type { ContentRecommendation, SeoResult } from '@seo/contracts';

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

export function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function fmtInt(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}

export function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

export function fmtPosition(v: number | null): string {
  if (v === null) return '—';
  return v.toFixed(1);
}

export function shortHash(input: string): string {
  let h = 0;
  for (const ch of input) {
    h = (h * 31 + ch.charCodeAt(0)) | 0;
  }
  return (h >>> 0).toString(36).padStart(4, '0').slice(0, 4);
}

// ---------------------------------------------------------------------------
// URL matching between content rows and stored GSC pages
// ---------------------------------------------------------------------------

/** Host of a GSC property row: handles both url-prefix and sc-domain forms. */
export function siteHostOf(siteUrl: string): string | null {
  const s = siteUrl.trim();
  if (!s) return null;
  if (s.startsWith('sc-domain:')) {
    const host = s.slice('sc-domain:'.length).trim().toLowerCase();
    return host.replace(/^\.+/, '') || null;
  }
  try {
    const host = new URL(s).hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

/** Normalized content path candidates derived from url + slug. */
export function contentPathKeys(input: { url?: string | null; slug?: string | null }): string[] {
  const out: string[] = [];
  const add = (p: string | null): void => {
    if (p && !out.includes(p)) out.push(p);
  };
  if (input.url) {
    const s = input.url.trim();
    if (/^https?:\/\//i.test(s)) {
      try {
        add(new URL(s).pathname.replace(/\/+$/, '') || '/');
      } catch {
        /* ignore unparsable url */
      }
    } else if (s.startsWith('/')) {
      add(s.replace(/\/+$/, '') || '/');
    }
  }
  if (input.slug) {
    const sl = input.slug.trim().replace(/^\/+|\/+$/g, '');
    if (sl) add(`/${sl}`);
  }
  return out;
}

/**
 * Concrete page URL strings we probe seo_gsc_pages with. GSC stores full
 * absolute page URLs, so candidates are built from the content path(s) under
 * every active property host plus the raw content url when it is absolute.
 */
export function pageUrlCandidates(input: {
  url?: string | null;
  slug?: string | null;
  hosts?: Array<string | null | undefined>;
}): string[] {
  const paths = contentPathKeys(input);
  const hosts = [...new Set((input.hosts ?? []).map((h) => h?.trim().toLowerCase()).filter((h): h is string => Boolean(h)))];
  const out: string[] = [];
  const add = (u: string): void => {
    const normalized = u.toLowerCase();
    if (normalized && !out.includes(normalized)) out.push(normalized);
  };

  if (input.url && /^https?:\/\//i.test(input.url.trim())) {
    const base = input.url.trim().split('#')[0].split('?')[0];
    add(base);
    add(base.replace(/\/+$/, ''));
    add(`${base.replace(/\/+$/, '')}/`);
  }
  for (const host of hosts) {
    for (const path of paths) {
      for (const proto of ['https', 'http']) {
        add(`${proto}://${host}${path}`);
        add(`${proto}://${host}${path}/`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Query relevance + coverage (deterministic, term-based)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  `a an the and or but for nor so yet with without of in on at to from by over under up down is are was were be been being
   am do does did have has had having can could should would will shall may might must not no yes if then than else when while
   what which who whom whose this that these those it its there here their they we you your our us them him her his he she as
   into onto upon about again further once only such also just more most other some any both each few own same very too off
   how why where because until during before after above below between out against`
    .split(/\s+/)
    .filter(Boolean),
);

/** Meaningful lowercase words of a phrase (stopwords and tiny tokens removed). */
export function significantTokens(phrase: string): string[] {
  return (phrase ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

export function hasAnyToken(query: string, topicTokens: string[]): boolean {
  const qTokens = significantTokens(query);
  let shared = 0;
  const seen = new Set<string>();
  for (const t of qTokens) {
    if (!seen.has(t) && topicTokens.includes(t)) {
      seen.add(t);
      shared += 1;
    }
  }
  return shared >= 2;
}

export function queryCoversTopic(query: string, topic: string): boolean {
  const q = query.trim().toLowerCase();
  const t = topic.trim().toLowerCase();
  if (!q || !t) return false;
  return q.includes(t) || t.includes(q);
}

/** Significant query terms that do not appear anywhere in the document text. */
export function missingTerms(query: string, docText: string): string[] {
  const haystack = (docText ?? '').toLowerCase();
  return significantTokens(query).filter((t) => !haystack.includes(t));
}

export function relatedQuery(query: string, topic: string, topicTokens: string[]): boolean {
  if (!topic.trim()) return false;
  if (queryCoversTopic(query, topic)) return true;
  return hasAnyToken(query, topicTokens);
}

// ---------------------------------------------------------------------------
// Aggregators over stored GSC rows
// ---------------------------------------------------------------------------

export interface GscAgg {
  clicks: number;
  impressions: number;
  ctr: number;
  /** Impression-weighted average position (null when no impressions). */
  position: number | null;
}

export function aggregateGsc(rows: Array<Record<string, unknown>>): GscAgg {
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  let posSum = 0;
  let posCount = 0;
  for (const row of rows) {
    const c = num(row.clicks);
    const im = num(row.impressions);
    const p = num(row.position);
    clicks += c;
    impressions += im;
    weighted += p * im;
    if (p > 0) {
      posSum += p;
      posCount += 1;
    }
  }
  const position =
    impressions > 0 ? weighted / impressions : posCount > 0 ? posSum / posCount : null;
  return { clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position };
}

export interface GscQueryAgg {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

/** Aggregate daily query rows (multiple dates/properties) into per-query totals. */
export function aggregateGscQueries(rows: Array<Record<string, unknown>>): GscQueryAgg[] {
  const byQuery = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const q = String(row.query ?? '').trim();
    if (!q) continue;
    const list = byQuery.get(q);
    if (list) list.push(row);
    else byQuery.set(q, [row]);
  }
  const out: GscQueryAgg[] = [];
  for (const [query, list] of byQuery) {
    const agg = aggregateGsc(list);
    out.push({ query, ...agg });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recommendation builders (deterministic; every claim has stored evidence)
// ---------------------------------------------------------------------------

/** Map the canonical Phase C checks onto normalized, evidence-free issues. */
export function seoRecommendations(result: SeoResult): ContentRecommendation[] {
  const out: ContentRecommendation[] = [];
  for (const check of result.checks) {
    if (check.status !== 'fail' && check.status !== 'warn') continue;
    const fail = check.status === 'fail';
    out.push({
      id: `seo:${check.code}`,
      type: 'issue',
      priority: fail ? 'high' : 'medium',
      source: 'seo',
      code: check.code,
      title: check.label,
      description: check.detail,
      evidence: [{ label: 'Category', value: check.category }],
      action: check.suggestion ? { text: check.suggestion } : null,
      dismissible: false,
    });
  }
  return out;
}

/** Impression-weighted visibility decline between two 28-day windows. */
export function pageTrendRecommendation(
  prev: GscAgg,
  recent: GscAgg,
  evidenceUrl?: string | null,
): ContentRecommendation | null {
  if (prev.impressions < 20 || recent.impressions < 20) return null;
  const ratio = recent.impressions / prev.impressions;
  if (ratio >= 1 - 0.2) return null;
  const drop = 1 - ratio;
  const evidence: ContentRecommendation['evidence'] = [
    { label: 'Impressions (previous 28d)', value: fmtInt(prev.impressions) },
    { label: 'Impressions (last 28d)', value: fmtInt(recent.impressions) },
    { label: 'Clicks (last 28d)', value: fmtInt(recent.clicks) },
  ];
  if (evidenceUrl) evidence.push({ label: 'Page', value: evidenceUrl, url: evidenceUrl });
  return {
    id: 'gsc:page_visibility_decline',
    type: 'issue',
    priority: 'high',
    source: 'gsc',
    code: 'page_visibility_decline',
    title: 'This page is losing visibility',
    description: `Search Console shows impressions fell ${fmtPct(drop)} over the last 28 days compared with the previous 28 days.`,
    evidence,
    action: { text: 'Review what changed (title, content refresh, seasonality, competitor SERP shifts) and consider refreshing the article.' },
    dismissible: true,
  };
}

/** Low click-through while ranking in the near-top positions. */
export function pageCtrRecommendation(recent: GscAgg, evidenceUrl?: string | null): ContentRecommendation | null {
  if (recent.impressions < 200) return null;
  if (recent.position === null || recent.position < 4 || recent.position > 20) return null;
  if (recent.ctr >= 0.02) return null;
  const evidence: ContentRecommendation['evidence'] = [
    { label: 'Impressions (28d)', value: fmtInt(recent.impressions) },
    { label: 'Average position', value: fmtPosition(recent.position) },
    { label: 'CTR', value: fmtPct(recent.ctr) },
    { label: 'Clicks (28d)', value: fmtInt(recent.clicks) },
  ];
  if (evidenceUrl) evidence.push({ label: 'Page', value: evidenceUrl, url: evidenceUrl });
  return {
    id: 'gsc:page_low_ctr',
    type: 'opportunity',
    priority: 'medium',
    source: 'gsc',
    code: 'page_low_ctr',
    title: 'The page ranks but earns few clicks',
    description: `This page averages position ${fmtPosition(recent.position)} with a ${fmtPct(recent.ctr)} click-through rate over the last 28 days.`,
    evidence,
    action: { text: 'Improve the search-result appeal: rewrite the title tag and meta description around the target keyword and an obvious benefit.' },
    dismissible: true,
  };
}

const QUERY_IMPRESSION_MIN = 100;
const QUERY_POSITION_MIN = 4;
const QUERY_POSITION_MAX = 20;
const QUERY_CTR_MAX = 0.02;

export interface QueryOpportunityOpts {
  topic: string;
  docText: string;
  limit?: number;
}

/** Queries with real impressions that stall below position 4-20 territory and
 *  whose terms are not yet covered by this document. Topical by design - the
 *  queries are property-level rows, so wording never claims a per-page rank. */
export function queryOpportunityRecommendations(
  aggs: GscQueryAgg[],
  opts: QueryOpportunityOpts,
): ContentRecommendation[] {
  const topicTokens = significantTokens(opts.topic);
  const docText = opts.docText ?? '';
  const limit = opts.limit ?? 3;
  const ranked = [...aggs]
    .filter((a) => a.impressions >= QUERY_IMPRESSION_MIN)
    .filter((a) => a.position !== null && a.position >= QUERY_POSITION_MIN && a.position <= QUERY_POSITION_MAX)
    .filter((a) => a.ctr < QUERY_CTR_MAX)
    .sort((a, b) => b.impressions - a.impressions);

  const out: ContentRecommendation[] = [];
  for (const agg of ranked) {
    if (!relatedQuery(agg.query, opts.topic, topicTokens)) continue;
    const missing = missingTerms(agg.query, docText);
    if (missing.length === 0) continue;
    out.push({
      id: `gsc:low_ctr_query:${shortHash(agg.query)}`,
      type: 'opportunity',
      priority: 'medium',
      source: 'gsc',
      code: 'low_ctr_query',
      title: `Add coverage for "${agg.query}"`,
      description: `A related query on your Search Console property has ${fmtInt(agg.impressions)} impressions in 28 days at position ${fmtPosition(agg.position)} but almost no clicks - and terms like "${missing.slice(0, 3).join('", "')}" are not in this document yet.`,
      evidence: [
        { label: 'Query', value: agg.query },
        { label: 'Impressions (28d)', value: fmtInt(agg.impressions) },
        { label: 'Average position', value: fmtPosition(agg.position) },
        { label: 'Clicks (28d)', value: fmtInt(agg.clicks) },
      ],
      action: { text: 'Add a section that answers this query explicitly, then mention the exact phrases so the page can rank for them.' },
      dismissible: true,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export interface KeywordRowLike {
  keyword?: unknown;
  volume?: unknown;
  difficulty?: unknown;
  cpc?: unknown;
  source?: unknown;
  provider?: unknown;
}

/** Demand signal for an exact-match keyword row that carries DataForSEO metrics. */
export function keywordDemandRecommendation(row: KeywordRowLike): ContentRecommendation | null {
  const keyword = String(row.keyword ?? '').trim();
  const volume = num(row.volume);
  if (!keyword || volume <= 0) return null;
  const difficulty = row.difficulty === null || row.difficulty === undefined ? null : num(row.difficulty);
  const cpc = row.cpc === null || row.cpc === undefined ? null : num(row.cpc);
  const evidence: ContentRecommendation['evidence'] = [
    { label: 'Volume / month', value: fmtInt(volume) },
    { label: 'Keyword difficulty', value: difficulty === null ? '—' : String(Math.round(difficulty)) },
  ];
  if (cpc !== null) evidence.push({ label: 'CPC', value: `$${cpc.toFixed(2)}` });
  const easy = difficulty !== null && difficulty < 45;
  return {
    id: `dataforseo:keyword_demand:${shortHash(keyword)}`,
    type: 'opportunity',
    priority: easy ? 'high' : 'medium',
    source: 'dataforseo',
    code: 'keyword_demand',
    title: `Search demand for "${keyword}"`,
    description:
      difficulty === null
        ? `Keyword research records an estimated ${fmtInt(volume)} searches a month for this exact keyword.`
        : `Keyword research records an estimated ${fmtInt(volume)} searches a month at difficulty ${Math.round(difficulty)} for this exact keyword.`,
    evidence,
    action: { text: `Make sure the article targets "${keyword}" explicitly in the copy, an H2 and the title tag.` },
    dismissible: true,
  };
}

/** Knowledge source health (project-scoped rows only - never raw vectors). */
export function knowledgeRecommendations(counts: {
  total: number;
  indexed: number;
  error: number;
  pending: number;
}): ContentRecommendation[] {
  const out: ContentRecommendation[] = [];
  if (counts.total === 0) {
    out.push({
      id: 'knowledge:no_sources',
      type: 'insight',
      priority: 'low',
      source: 'knowledge',
      code: 'no_sources',
      title: 'No knowledge sources yet',
      description: 'The project has no knowledge sources. Grounding content in your own material gives the AI assistant reference context that is traceable back to you.',
      action: { text: 'Add a note, reference or URL from the Knowledge Base view.' },
      dismissible: true,
    });
    return out;
  }
  if (counts.error > 0) {
    out.push({
      id: 'knowledge:source_errors',
      type: 'issue',
      priority: 'high',
      source: 'knowledge',
      code: 'source_errors',
      title: 'Some knowledge sources failed to index',
      description: `${counts.error} of ${counts.total} knowledge source${counts.total === 1 ? '' : 's'} errored during indexing and are not searchable.`,
      evidence: [
        { label: 'Indexed', value: fmtInt(counts.indexed) },
        { label: 'Errors', value: fmtInt(counts.error) },
        { label: 'Pending', value: fmtInt(counts.pending) },
      ],
      action: { text: 'Review and retry the failed sources from the Knowledge Base view.' },
      dismissible: true,
    });
  }
  return out;
}
