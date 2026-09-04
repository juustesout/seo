/**
 * DataForSEO response normalization: raw wrapper output -> normalized SEO
 * models. All parsing/nesting quirks live here, not in executors or the UI.
 */

import type { KeywordResearchResult, SerpItem } from '@seo/contracts';
import type { KeywordSuggestion, SerpItemRaw, SerpTask, SerpTaskResult } from './dataForSeoClient.js';
import { asNumber } from '../../util.js';

const PAID_TYPES = new Set(['paid', 'ad', 'ads']);

export function normalizeSerpItems(items: SerpItemRaw[] | undefined): SerpItem[] {
  if (!items) return [];
  const out: SerpItem[] = [];
  for (const raw of items) {
    const type = raw.type ?? 'organic';
    const isPaid = PAID_TYPES.has(type);
    if (type !== 'organic' && !isPaid) continue; // skip featured/structured features
    const url = raw.url;
    if (!url) continue;
    const position = asNumber(raw.rank_absolute) ?? asNumber(raw.rank_group);
    if (position === null) continue;
    out.push({
      position,
      url,
      domain: typeof raw.domain === 'string' ? raw.domain : hostOf(url),
      title: typeof raw.title === 'string' ? raw.title : null,
      description: typeof raw.description === 'string' ? raw.description : null,
      kind: type,
      is_paid: isPaid,
    });
  }
  out.sort((a, b) => a.position - b.position);
  return out;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function keywordOfTask(task: SerpTask): string {
  return task.result?.[0]?.keyword ?? task.keyword ?? '';
}

export function resultOfTask(task: SerpTask): SerpTaskResult | undefined {
  return task.result?.[0];
}

export function normalizeSerpResult(result: SerpTaskResult | undefined): {
  keyword: string;
  engine: string;
  items: SerpItem[];
  checkUrl?: string;
} {
  const keyword = result?.keyword ?? '';
  const items = normalizeSerpItems(result?.items);
  const engine = typeof result?.se_domain === 'string' ? result.se_domain.replace('google.', 'google') : 'google';
  return { keyword, engine, items, checkUrl: result?.check_url };
}

export function normalizeSuggestion(item: KeywordSuggestion): KeywordResearchResult | null {
  const kd = item.keyword_data;
  const info = kd?.keyword_info ?? item.keyword_info;
  const props = kd?.keyword_properties ?? item.keyword_properties;
  const intent = kd?.keyword_properties?.search_intent ?? item.search_intent_info?.main_intent ?? null;
  const keyword = kd?.keyword ?? item.keyword;
  if (!keyword) return null;
  const competitionNum = asNumber(info?.competition);
  const monthly = (info?.monthly_searches ?? [])
    .map((m) => ({
      year: m.year,
      month: m.month,
      volume: asNumber(m.search_volume) ?? 0,
    }))
    .filter((m) => m.volume > 0);
  return {
    keyword,
    location_code: null,
    language_code: null,
    search_volume: asNumber(info?.search_volume),
    cpc: asNumber(info?.cpc),
    competition: competitionLabel(competitionNum),
    difficulty: asNumber(props?.keyword_difficulty),
    serp: [],
    keyword_intents: intent ? [intent] : null,
    monthly_searches: monthly,
  };
}

function competitionLabel(value: number | null): string | null {
  if (value === null) return null;
  if (value <= 0.33) return 'LOW';
  if (value <= 0.66) return 'MEDIUM';
  return 'HIGH';
}

/** True when a URL's hostname belongs to the target domain (or its subdomains). */
export function urlBelongsToDomain(url: string | null | undefined, domain: string | null | undefined): boolean {
  if (!url || !domain) return false;
  const host = hostOf(url) ?? '';
  const normalized = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase();
  return host === normalized || host.endsWith(`.${normalized}`);
}

export function difficultyLevel(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'N/A';
  if (value <= 14) return 'Very easy';
  if (value <= 29) return 'Easy';
  if (value <= 49) return 'Possible';
  if (value <= 69) return 'Difficult';
  return 'Hard';
}
