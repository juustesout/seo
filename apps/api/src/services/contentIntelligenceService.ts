/**
 * Content intelligence application service (SEO Core).
 *
 * Content Studio Phase G. Builds a read-only, per-content report by
 * aggregating deterministic signals over the rows the platform already stores:
 *   - Search Console page rows (per-page trends + CTR) matched through the
 *     content url/slug against active GSC property hosts;
 *   - Search Console query rows (topically related, property-level) whose
 *     terms are not yet covered by the document;
 *   - DataForSEO keyword rows (volume/difficulty for the exact target) and
 *     tracked-keyword gaps when the integration is connected;
 *   - project knowledge source health (never raw vectors);
 *   - the canonical Phase C on-page evaluation.
 *
 * Nothing here calls a provider, crawls, or writes. An unavailable source is
 * reported as such and never breaks the report. The optional AI pass is an
 * assistant only - it is requested explicitly, labelled as AI, and its output
 * is never conflated with the deterministic signals.
 */

import type { ContentIntelligenceReport } from '@seo/contracts';
import { asTipDoc, contentTextOf, evaluateSeo } from '@seo/contracts';
import {
  aggregateGsc,
  aggregateGscQueries,
  keywordDemandRecommendation,
  knowledgeRecommendations,
  num,
  pageCtrRecommendation,
  pageTrendRecommendation,
  pageUrlCandidates,
  queryOpportunityRecommendations,
  seoRecommendations,
  shortHash,
  siteHostOf,
} from './contentIntelligence.js';
import { ContentService } from './contentService.js';
import { KnowledgeService } from './knowledgeService.js';
import { AIService } from './aiService.js';
import { logger } from '../logger.js';
import type { ServiceContainer } from '../context.js';

type Row = Record<string, unknown>;

const GSC_PAGE_WINDOW_DAYS = 56;
const GSC_QUERY_WINDOW_DAYS = 28;
const SOURCE_LABELS: Record<string, string> = {
  seo: 'On-page SEO',
  gsc: 'Search Console',
  dataforseo: 'DataForSEO',
  knowledge: 'Knowledge base',
};
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export class ContentIntelligenceService {
  private readonly content: ContentService;
  private readonly knowledge: KnowledgeService;

  constructor(private readonly container: ServiceContainer) {
    this.content = new ContentService(container.sb);
    this.knowledge = new KnowledgeService(container);
  }

  async report(
    projectId: string,
    contentId: string,
    opts: { withAi?: boolean } = {},
  ): Promise<ContentIntelligenceReport> {
    const row = await this.content.get(projectId, contentId);
    const targetKeyword = text(row.target_keyword);
    const title = text(row.title) ?? '';
    const docText = contentTextOf(row.content_json);
    const topic = [targetKeyword, title].filter(Boolean).join(' ').trim();
    const published = row.status === 'published';
    const generatedAt = new Date().toISOString();

    // Deterministic Phase C evaluation of the saved document (always works).
    const seoResult = evaluateSeo({
      doc: asTipDoc(row.content_json),
      meta: {
        title,
        targetKeyword,
        metaTitle: text(row.meta_title),
        metaDescription: text(row.meta_description),
      },
    });
    const seoRecs = seoRecommendations(seoResult);

    // Availability probes (server truth, mirrors the dashboard).
    const [accountRow, activeGsc] = await Promise.all([
      this.container.sb.from('seo_projects').select('account_id').eq('id', projectId).maybeSingle<{ account_id: string | null }>(),
      this.container.sb
        .from('seo_data_sources')
        .select('id')
        .eq('project_id', projectId)
        .eq('provider_type', 'gsc')
        .eq('status', 'active')
        .limit(1),
    ]);
    const accountId = (accountRow.data?.account_id as string | null) ?? null;
    const gscConfigured = !activeGsc.error && (activeGsc.data ?? []).length > 0;
    const dfConfigured = await this.dataforseoConnected(projectId, accountId);

    // ------------------------------------------------------------------ GSC
    let gscSources: ContentIntelligenceReport['sources'] = [];
    let gscRecs: ContentIntelligenceReport['recommendations'] = [];
    if (gscConfigured) {
      const gsc = await this.gscSignals(projectId, row, { docText, topic, published });
      gscSources = gsc.sources;
      gscRecs = gsc.recommendations;
    } else {
      gscSources = [
        {
          id: 'gsc',
          label: SOURCE_LABELS.gsc,
          state: 'not_configured',
          note: 'Connect Google Search Console to a property and sync it to power page and query signals.',
        },
      ];
    }

    // ------------------------------------------------------------ DataForSEO
    let dfSources: ContentIntelligenceReport['sources'] = [];
    let dfRecs: ContentIntelligenceReport['recommendations'] = [];
    if (dfConfigured) {
      const df = await this.dataforseoSignals(projectId, row, targetKeyword);
      dfSources = df.sources;
      dfRecs = df.recommendations;
    } else {
      dfSources = [
        {
          id: 'dataforseo',
          label: SOURCE_LABELS.dataforseo,
          state: 'not_configured',
          note: 'Connect DataForSEO to surface keyword volume and difficulty for this target.',
        },
      ];
    }

    // ------------------------------------------------------------- Knowledge
    const knowledgeState = await this.knowledgeSignals(projectId);
    const knowledgeSources = knowledgeState.sources;
    const knowledgeRecs = knowledgeState.recommendations;

    // --------------------------------------------------------------- SEO rec
    const seoSources: ContentIntelligenceReport['sources'] = [
      {
        id: 'seo',
        label: SOURCE_LABELS.seo,
        state: 'configured',
        note: 'Deterministic on-page assessment of the saved document.',
      },
    ];

    // ---------------------------------------------------- Optional AI pass
    let ai: ContentIntelligenceReport['ai'] = { requested: Boolean(opts.withAi), available: false, note: null };
    let aiRecs: ContentIntelligenceReport['recommendations'] = [];
    if (opts.withAi) {
      const pass = await this.aiAssistant(projectId, {
        title,
        targetKeyword,
        topic,
        docText,
        seoScore: seoResult.score,
        deterministic: [...seoRecs, ...gscRecs, ...dfRecs, ...knowledgeRecs],
      });
      ai = pass.state;
      aiRecs = pass.recommendations;
    }

    const recommendations = [...seoRecs, ...gscRecs, ...dfRecs, ...knowledgeRecs, ...aiRecs].sort(
      (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id.localeCompare(b.id),
    );

    return {
      project_id: projectId,
      content_id: contentId,
      generated_at: generatedAt,
      seo_score: seoResult.score,
      sources: [...seoSources, ...gscSources, ...dfSources, ...knowledgeSources],
      recommendations,
      ai,
    };
  }

  // -------------------------------------------------------------------------
  // Availability probes
  // -------------------------------------------------------------------------

  /** DataForSEO may be connected at the project or the account level. */
  private async dataforseoConnected(projectId: string, accountId: string | null): Promise<boolean> {
    const projectLevel = await this.container.sb
      .from('seo_integrations')
      .select('id')
      .eq('project_id', projectId)
      .eq('provider_type', 'dataforseo')
      .eq('status', 'connected')
      .limit(1);
    if (!projectLevel.error && (projectLevel.data ?? []).length > 0) return true;
    if (accountId) {
      const accountLevel = await this.container.sb
        .from('seo_integrations')
        .select('id')
        .eq('account_id', accountId)
        .is('project_id', null)
        .eq('provider_type', 'dataforseo')
        .eq('status', 'connected')
        .limit(1);
      if (!accountLevel.error && (accountLevel.data ?? []).length > 0) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Signal readers (each degrades gracefully and never throws)
  // -------------------------------------------------------------------------

  private async gscSignals(
    projectId: string,
    row: Row,
    ctx: { docText: string; topic: string; published: boolean },
  ): Promise<{ sources: ContentIntelligenceReport['sources']; recommendations: ContentIntelligenceReport['recommendations'] }> {
    const sources: ContentIntelligenceReport['sources'] = [];
    const recommendations: ContentIntelligenceReport['recommendations'] = [];
    const degraded = (note: string): void => {
      sources.push({ id: 'gsc', label: SOURCE_LABELS.gsc, state: 'no_data', note });
    };

    const hosts = await this.container.sb
      .from('seo_gsc_properties')
      .select('site_url')
      .eq('project_id', projectId)
      .eq('is_active', true)
      .limit(50);
    if (hosts.error) {
      degraded('Search Console properties could not be read, so page signals are unavailable right now.');
      return { sources, recommendations };
    }

    const propertyHosts = ((hosts.data ?? []) as Array<{ site_url: string }>)
      .map((p) => siteHostOf(p.site_url))
      .filter((h): h is string => Boolean(h));
    const candidates = pageUrlCandidates({
      url: text(row.url),
      slug: text(row.slug),
      hosts: propertyHosts,
    });

    const sincePages = daysAgo(GSC_PAGE_WINDOW_DAYS);
    const sinceQueries = daysAgo(GSC_QUERY_WINDOW_DAYS);

    // Per-page rows (last 56 days) matched to this content's URL candidates.
    let pageRows: Row[] = [];
    if (candidates.length > 0) {
      const { data, error } = await this.container.sb
        .from('seo_gsc_pages')
        .select('date,url,clicks,impressions,ctr,position')
        .eq('project_id', projectId)
        .gte('date', sincePages)
        .in('url', candidates)
        .limit(2000);
      if (!error) pageRows = (data ?? []) as Row[];
    }

    // Property-level query rows (top 200 by impressions in 28 days) that are
    // relevant to this content's topic. Queries are not page-scoped, so they
    // are only used when we have a topic to match them against.
    let queryRows: Row[] = [];
    if (ctx.topic) {
      const { data, error } = await this.container.sb
        .from('seo_gsc_queries')
        .select('query,clicks,impressions,ctr,position')
        .eq('project_id', projectId)
        .gte('date', sinceQueries)
        .order('impressions', { ascending: false })
        .limit(200);
      if (!error) queryRows = (data ?? []) as Row[];
    }

    const cutoff = sinceQueries;
    const recent = pageRows.filter((r) => String(r.date) >= cutoff);
    const previous = pageRows.filter((r) => String(r.date) < cutoff);
    const recentAgg = aggregateGsc(recent);
    const previousAgg = aggregateGsc(previous);
    const bestRow = pageRows.reduce<Row | null>(
      (best, r) => (best === null || num(r.impressions) > num(best.impressions) ? r : best),
      null,
    );
    const matchedUrl = bestRow ? (String(bestRow.url ?? '') || null) : null;

    if (pageRows.length === 0 && queryRows.length === 0) {
      degraded(
        candidates.length === 0
          ? 'No Search Console data is linked yet - give this article a URL or slug so its page can be matched.'
          : 'No Search Console page or query data was found for this project in the recent window.',
      );
      return { sources, recommendations };
    }

    if (pageRows.length > 0) {
      const trend = pageTrendRecommendation(previousAgg, recentAgg, matchedUrl);
      if (trend) recommendations.push(trend);
      const ctr = pageCtrRecommendation(recentAgg, matchedUrl);
      if (ctr) recommendations.push(ctr);
      if (!matchedUrl) {
        recommendations.push({
          id: 'gsc:page_unmatched',
          type: 'insight',
          priority: 'low',
          source: 'gsc',
          code: 'page_unmatched',
          title: 'GSC page match is a topic match only',
          description: 'No exact Search Console page matched this content, so page-level trends could not be linked.',
          action: { text: 'Publish the article, confirm its URL/slug matches the live path, then re-sync Search Console.' },
          dismissible: true,
        });
      }
    }

    const queryAggs = aggregateGscQueries(queryRows);
    recommendations.push(
      ...queryOpportunityRecommendations(queryAggs, {
        topic: ctx.topic,
        docText: ctx.docText,
        limit: 3,
      }),
    );

    const note =
      pageRows.length === 0
        ? ctx.published
          ? 'No Search Console page matched this published URL yet - verify the URL and sync Search Console.'
          : 'Query signals are topic-based because this content is not published to a matched page yet.'
        : null;
    sources.push({ id: 'gsc', label: SOURCE_LABELS.gsc, state: 'configured', note });
    return { sources, recommendations };
  }

  private async dataforseoSignals(
    projectId: string,
    row: Row,
    targetKeyword: string | null,
  ): Promise<{ sources: ContentIntelligenceReport['sources']; recommendations: ContentIntelligenceReport['recommendations'] }> {
    const recommendations: ContentIntelligenceReport['recommendations'] = [];
    const kw = targetKeyword ?? '';
    if (!kw) {
      return {
        sources: [
          {
            id: 'dataforseo',
            label: SOURCE_LABELS.dataforseo,
            state: 'no_data',
            note: 'Set a target keyword to match it against tracked keyword research.',
          },
        ],
        recommendations,
      };
    }

    const { data, error } = await this.container.sb
      .from('seo_keywords')
      .select('keyword,volume,difficulty,cpc,provider')
      .eq('project_id', projectId)
      .ilike('keyword', kw)
      .limit(5);
    if (error) {
      return {
        sources: [
          { id: 'dataforseo', label: SOURCE_LABELS.dataforseo, state: 'no_data', note: 'Tracked keywords could not be read right now.' },
        ],
        recommendations,
      };
    }
    const kwRows = ((data ?? []) as Row[]).filter((r) => String(r.keyword ?? '').toLowerCase() === kw.toLowerCase());
    const dfRow = kwRows.find((r) => (r.provider === 'dataforseo' || r.provider === undefined) && num(r.volume) > 0) ?? null;

    if (dfRow) {
      const demand = keywordDemandRecommendation(dfRow);
      if (demand) recommendations.push(demand);
      return {
        sources: [
          {
            id: 'dataforseo',
            label: SOURCE_LABELS.dataforseo,
            state: 'configured',
            note: `Keyword demand data for "${kw}" from tracked research.`,
          },
        ],
        recommendations,
      };
    }

    recommendations.push({
      id: `dataforseo:research_gap:${shortHash(kw)}`,
      type: 'insight',
      priority: 'low',
      source: 'dataforseo',
      code: 'research_gap',
      title: `No demand data tracked for "${kw}"`,
      description:
        'This exact keyword is not backed by keyword research yet, so volume and difficulty cannot be reported. Tracking it first keeps the numbers real.',
      action: { text: 'Run DataForSEO keyword research for this target from the Keywords & Rankings view.' },
      dismissible: true,
    });

    const trackedAnywhere = kwRows.length > 0;
    return {
      sources: [
        {
          id: 'dataforseo',
          label: SOURCE_LABELS.dataforseo,
          state: 'no_data',
          note: trackedAnywhere
            ? `"${kw}" is tracked but has no volume data yet.`
            : `"${kw}" is not tracked yet.`,
        },
      ],
      recommendations,
    };
  }

  private async knowledgeSignals(
    projectId: string,
  ): Promise<{ sources: ContentIntelligenceReport['sources']; recommendations: ContentIntelligenceReport['recommendations'] }> {
    const reason = this.knowledge.configuredReason();
    if (reason) {
      return {
        sources: [{ id: 'knowledge', label: SOURCE_LABELS.knowledge, state: 'not_configured', note: reason }],
        recommendations: [],
      };
    }
    const { data, error } = await this.container.sb
      .from('seo_knowledge_sources')
      .select('status')
      .eq('project_id', projectId)
      .limit(500);
    if (error) {
      return {
        sources: [
          { id: 'knowledge', label: SOURCE_LABELS.knowledge, state: 'no_data', note: 'Knowledge sources could not be read right now.' },
        ],
        recommendations: [],
      };
    }
    const statuses = ((data ?? []) as Array<{ status: string }>).map((r) => r.status);
    const counts = {
      total: statuses.length,
      indexed: statuses.filter((s) => s === 'indexed').length,
      error: statuses.filter((s) => s === 'error').length,
      pending: statuses.filter((s) => s === 'pending' || s === 'indexing').length,
    };
    return {
      sources: [
        {
          id: 'knowledge',
          label: SOURCE_LABELS.knowledge,
          state: counts.total > 0 ? 'configured' : 'no_data',
          note: counts.total > 0 ? `${counts.total} source${counts.total === 1 ? '' : 's'} (${counts.indexed} indexed).` : 'No knowledge sources yet.',
        },
      ],
      recommendations: knowledgeRecommendations(counts),
    };
  }

  // -------------------------------------------------------------------------
  // Optional, clearly-labelled AI assistant (never a second scoring engine)
  // -------------------------------------------------------------------------

  private async aiAssistant(
    projectId: string,
    input: {
      title: string;
      targetKeyword: string | null;
      topic: string;
      docText: string;
      seoScore: number;
      deterministic: ContentIntelligenceReport['recommendations'];
    },
  ): Promise<{ state: ContentIntelligenceReport['ai']; recommendations: ContentIntelligenceReport['recommendations'] }> {
    const ai = new AIService(this.container);
    let resolved;
    try {
      resolved = await ai.resolve(projectId);
    } catch (err) {
      logger.warn({ err }, 'intelligence AI resolve failed');
      return {
        state: { requested: true, available: false, note: 'The AI assistant could not be reached. Deterministic signals above remain valid.' },
        recommendations: [],
      };
    }
    if (!resolved.configured || !resolved.provider.isConfigured()) {
      return {
        state: { requested: true, available: false, note: 'Add an AI key to use the optional assistant.' },
        recommendations: [],
      };
    }

    const signalLines = input.deterministic.slice(0, 12).map((r, i) => `${i + 1}. [${r.priority}] ${r.title} (${r.source})`);
    const provider = resolved.provider;
    try {
      const out = await provider.chat({
        json: true,
        temperature: 0.2,
        maxTokens: 1200,
        messages: [
          {
            role: 'system',
            content:
              'You are an SEO editor advising on ONE article. You will receive deterministic signals computed from real stored data. Return JSON exactly shaped as {"opportunities":[{"title":string,"description":string}]} with at most 3 SHORT editorial opportunities. Never invent metrics or external data; only reason about the signals given. Do not restate a signal verbatim.',
          },
          {
            role: 'user',
            content: [
              `Article: ${input.title}`,
              input.targetKeyword ? `Target keyword: ${input.targetKeyword}` : 'Target keyword: not set',
              `Deterministic on-page score: ${input.seoScore}`,
              `Signals:\n${signalLines.join('\n') || '(none)'}`,
              `Article text:\n${input.docText.slice(0, 6000)}`,
            ].join('\n\n'),
          },
        ],
      });
      const parsed = JSON.parse(out.content.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '')) as { opportunities?: unknown };
      const list = Array.isArray(parsed.opportunities)
        ? (parsed.opportunities as Array<Record<string, unknown>>).slice(0, 3)
        : [];
      const recommendations = list
        .map((item, i) => ({
          id: `ai:opportunity:${i + 1}`,
          type: 'insight' as const,
          priority: 'low' as const,
          source: 'ai' as const,
          code: 'ai_opportunity',
          title: String(item.title ?? 'AI suggestion').slice(0, 120),
          description: String(item.description ?? '').slice(0, 500),
          evidence: [{ label: 'Generated', value: 'AI assistant (review before acting)' }],
          action: null,
          dismissible: true,
        }))
        .filter((r) => r.title && r.description);
      return {
        state: {
          requested: true,
          available: true,
          note: recommendations.length > 0 ? `${recommendations.length} AI suggestion${recommendations.length === 1 ? '' : 's'} - generated text, review before acting.` : 'The AI assistant returned no additional opportunities.',
        },
        recommendations,
      };
    } catch (err) {
      logger.warn({ err }, 'intelligence AI pass failed');
      return {
        state: { requested: true, available: true, note: 'The AI assistant pass failed. Deterministic signals above remain valid.' },
        recommendations: [],
      };
    }
  }
}
