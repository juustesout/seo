/**
 * Job executors - the operations the worker performs. Each maps one job_type
 * to an idempotent-ish, progress-reporting routine. Executors orchestrate
 * providers (through the registry) and persist via SeoWriter; they never call
 * external APIs directly.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { SeoWriter } from '../persistence/seoWriter.js';
import { buildProviderContext } from '../context.js';
import type { JobRecord } from './types.js';
import { ApiError } from '../apiErrors.js';
import { logger } from '../logger.js';
import type { KnowledgeDocumentInput, ProviderContext } from '@seo/contracts';
import { GscDataSource } from '../providers/gsc/gscDataSource.js';
import { DataForSeoDataSource } from '../providers/dataforseo/dataSource.js';
import { urlBelongsToDomain } from '../providers/dataforseo/normalize.js';
import { delay } from '../util.js';
import type { ServiceContainer } from '../context.js';
import { ContentService } from '../services/contentService.js';
import { ContentAgentService } from '../services/contentAgentService.js';
import type { ContentBlock } from '@seo/contracts';

export interface JobExecContext {
  container: ServiceContainer;
  job: JobRecord;
  writer: SeoWriter;
  report(progress: number, message?: string): Promise<void>;
}

export type JobExecutor = (ctx: JobExecContext) => Promise<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

async function dataSourceRow(sb: SupabaseClient, projectId: string, dataSourceId?: string | null) {
  if (!dataSourceId) throw new ApiError(400, 'bad_request', 'Job requires a data_source_id');
  const { data } = await sb.from('seo_data_sources').select('*').eq('project_id', projectId).eq('id', dataSourceId).maybeSingle();
  if (!data) throw new ApiError(404, 'not_found', 'Data source not found for this project');
  return data as Record<string, unknown>;
}

async function integrationRow(sb: SupabaseClient, projectId: string, integrationId?: string | null) {
  if (!integrationId) throw new ApiError(400, 'bad_request', 'Job requires an integration');
  const { data } = await sb.from('seo_integrations').select('*').eq('project_id', projectId).eq('id', integrationId).maybeSingle();
  if (!data) throw new ApiError(404, 'not_found', 'Integration not found for this project');
  return data as Record<string, unknown>;
}

async function gscPropertyForDataSource(sb: SupabaseClient, projectId: string, dataSourceId?: string | null) {
  if (!dataSourceId) return null;
  const { data } = await sb
    .from('seo_gsc_properties')
    .select('*')
    .eq('project_id', projectId)
    .eq('data_source_id', dataSourceId)
    .maybeSingle();
  return data ? (data as Record<string, unknown>) : null;
}

async function trackedKeywords(sb: SupabaseClient, projectId: string, limit = 60): Promise<string[]> {
  const { data } = await sb
    .from('seo_keywords')
    .select('keyword')
    .eq('project_id', projectId)
    .neq('provider', 'gsc')
    .order('last_seen_at', { ascending: false })
    .limit(limit);
  const kw = (data ?? []).map((r) => r.keyword as string).filter(Boolean);
  if (kw.length > 0) return kw;
  // fallback: top GSC queries in the last month (used to bootstrap tracking)
  const { data: q } = await sb
    .from('seo_gsc_queries')
    .select('query, clicks')
    .eq('project_id', projectId)
    .gte('date', new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10))
    .order('clicks', { ascending: false })
    .limit(400);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of q ?? []) {
    const query = row.query as string;
    if (seen.has(query) || out.length >= limit) continue;
    seen.add(query);
    out.push(query);
  }
  return out;
}

async function targetDomain(sb: SupabaseClient, container: ServiceContainer, projectId: string, preferred?: string | null) {
  if (preferred) return preferred.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const { data } = await sb
    .from('seo_domains')
    .select('domain')
    .eq('project_id', projectId)
    .order('is_primary', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.domain as string | undefined) ?? null;
}

function noopCredentialReader(): ProviderContext['credentials'] {
  return {
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
  };
}

// ---------------------------------------------------------------------------
// GSC sync
// ---------------------------------------------------------------------------

const gscSync: JobExecutor = async ({ container, job, writer, report }) => {
  const ds = await dataSourceRow(container.sb, job.project_id, job.data_source_id);
  const property = await gscPropertyForDataSource(container.sb, job.project_id, job.data_source_id);
  const siteUrl = ((ds.config as Record<string, unknown>)?.siteUrl as string | undefined) ?? (property?.site_url as string | undefined);
  if (!siteUrl) throw new ApiError(400, 'bad_request', 'GSC data source has no property attached');

  const endDate = (job.params.endDate as string) ?? new Date().toISOString().slice(0, 10);
  const days = Number(job.params.days ?? job.params.rangeDays ?? 28);
  const start = new Date(`${endDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - Math.max(0, days - 1));
  const startDate = (job.params.startDate as string) ?? start.toISOString().slice(0, 10);
  const range = { startDate, endDate };

  const adapter = container.registry.getDataSource('gsc');
  if (!adapter) throw new ApiError(503, 'not_configured', 'GSC provider is not registered');
  const gsc = adapter as GscDataSource;
  const ctx = buildProviderContext(container, {
    projectId: job.project_id,
    userId: job.created_by,
    owner: { integrationId: String(ds.integration_id), providerType: 'gsc' },
    config: { siteUrl },
  });

  await report(5, `Fetching daily totals ${startDate}..${endDate}`);
  const daily = await gsc.fetchDaily(ctx, range);
  await report(20, 'Fetching query performance');
  const queryRows = await gsc.fetchDimension(ctx, range, ['date', 'query']);
  await report(45, 'Fetching page performance');
  const pageRows = await gsc.fetchDimension(ctx, range, ['date', 'page']);
  await report(65, 'Persisting Search Console data');

  const propertyId = (property?.id as string | undefined) ?? (job.params.property_id as string | undefined);
  if (!propertyId) {
    // property row should exist; create a reference if it does not yet
    throw new ApiError(400, 'bad_request', 'GSC property record is missing for this data source');
  }
  await writer.persistGsc(job.project_id, { propertyId, daily, queries: queryRows as never[], pages: pageRows as never[] });
  await writer.ingestGscKeywords(job.project_id, queryRows as never[]);
  await writer.persistPages(
    job.project_id,
    [...new Set((pageRows as Array<{ page: string }>).map((p) => p.page))].map((url) => ({
      id: url,
      project_id: job.project_id,
      url,
      is_homepage: false,
      source: 'gsc',
      provider: 'gsc',
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })),
  );
  await writer.markDataSourceSynced(job.project_id, String(ds.id));
  await report(100, `Synced ${daily.length} days, ${queryRows.length} query rows, ${pageRows.length} page rows`);
  return {
    days: daily.length,
    queryRows: queryRows.length,
    pageRows: pageRows.length,
    range: { startDate, endDate },
  };
};

// ---------------------------------------------------------------------------
// DataForSEO
// ---------------------------------------------------------------------------

const dataForSeoRankSync: JobExecutor = async ({ container, job, writer, report }) => {
  const ds = await dataSourceRow(container.sb, job.project_id, job.data_source_id);
  const adapter = container.registry.getDataSource('dataforseo');
  if (!adapter) throw new ApiError(503, 'not_configured', 'DataForSEO provider is not registered');
  const dfseo = adapter as DataForSeoDataSource;

  const domain = await targetDomain(container.sb, container, job.project_id, (job.params.domain as string) ?? null);
  const keywords = (job.params.keywords as string[] | undefined)?.slice(0, 100) ?? (await trackedKeywords(container.sb, job.project_id, 100));
  if (keywords.length === 0) return { message: 'No tracked keywords to rank-sync', found: 0 };

  const ctx = buildProviderContext(container, {
    projectId: job.project_id,
    userId: job.created_by,
    owner: { integrationId: String(ds.integration_id), providerType: 'dataforseo' },
    config: { ...(ds.config as Record<string, unknown>) },
  });

  await report(10, `Running SERP tracking for ${keywords.length} keywords`);
  const outcomes = await dfseo.fetchTaskSerp(ctx, keywords, {
    onProgress: (done, total) => void report(10 + Math.round((done / total) * 60), `SERP tasks ${done}/${total}`),
  });

  const date = new Date().toISOString().slice(0, 10);
  const today = new Date().toISOString();
  const rows = [];
  let found = 0;
  let notFound = 0;
  for (const outcome of outcomes) {
    const own = outcome.items.find((item) => urlBelongsToDomain(item.url, domain));
    if (own) {
      found += 1;
      rows.push({
        id: `${date}:${outcome.keyword}`,
        project_id: job.project_id,
        keyword: outcome.keyword,
        url: own.url,
        domain,
        position: own.position,
        engine: 'google',
        country: null,
        device: null,
        source: 'dataforseo',
        date,
        is_estimate: false,
        meta: {},
        created_at: today,
        updated_at: today,
      });
    } else {
      notFound += 1;
    }
  }
  await report(90, `Persisting ${rows.length} ranking rows`);
  await writer.persistRankings(job.project_id, rows as never[]);
  await writer.markDataSourceSynced(job.project_id, String(ds.id));
  await report(100, `Rank sync complete`);
  return { keywords: keywords.length, outcomes: outcomes.length, found, notFound, domain };
};

const serpRetrieval: JobExecutor = async ({ container, job, writer, report }) => {
  const ds = await dataSourceRow(container.sb, job.project_id, job.data_source_id);
  const adapter = container.registry.getDataSource('dataforseo');
  if (!adapter) throw new ApiError(503, 'not_configured', 'DataForSEO provider is not registered');
  const dfseo = adapter as DataForSeoDataSource;
  const keywords = (job.params.keywords as string[] | undefined)?.slice(0, 50) ?? (await trackedKeywords(container.sb, job.project_id, 50));
  if (keywords.length === 0) return { message: 'No keywords to retrieve SERPs for' };

  const ctx = buildProviderContext(container, {
    projectId: job.project_id,
    userId: job.created_by,
    owner: { integrationId: String(ds.integration_id), providerType: 'dataforseo' },
    config: { ...(ds.config as Record<string, unknown>) },
  });
  await report(10, `Retrieving live SERPs for ${keywords.length} keywords`);
  const outcomes = await dfseo.fetchLiveSerp(ctx, keywords, { depth: 20 });
  await report(70, 'Storing SERP results');
  await writer.persistSerpSnapshots(
    job.project_id,
    outcomes.map((o) => ({
      id: `${o.keyword}-${o.fetchedAt}`,
      project_id: job.project_id,
      keyword: o.keyword,
      engine: 'google',
      country: null,
      locale: null,
      device: null,
      url: null,
      fetched_at: o.fetchedAt,
      results: o.items,
    })),
  );
  await report(100, `Stored ${outcomes.length} SERP snapshots`);
  return { snapshots: outcomes.length };
};

const dataForSeoKeywordResearch: JobExecutor = async ({ container, job, writer, report }) => {
  const ds = await dataSourceRow(container.sb, job.project_id, job.data_source_id);
  const adapter = container.registry.getDataSource('dataforseo');
  if (!adapter) throw new ApiError(503, 'not_configured', 'DataForSEO provider is not registered');
  const dfseo = adapter as DataForSeoDataSource;
  const seeds = (job.params.seeds as string[] | undefined) ?? (job.params.keywords as string[] | undefined) ?? [];
  if (seeds.length === 0) throw new ApiError(400, 'bad_request', 'keyword_research requires seeds');

  const ctx = buildProviderContext(container, {
    projectId: job.project_id,
    userId: job.created_by,
    owner: { integrationId: String(ds.integration_id), providerType: 'dataforseo' },
    config: { ...(ds.config as Record<string, unknown>) },
  });
  await report(10, `Researching keywords from ${seeds.length} seed(s)`);
  const results = await dfseo.researchKeywords(ctx, seeds);
  await report(70, `Persisting ${results.length} suggested keywords`);
  await writer.persistKeywordResearch(job.project_id, results);
  await report(100, 'Keyword research complete');
  return { seeds: seeds.length, results: results.length };
};

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

async function collectKnowledgeDocuments(sb: SupabaseClient, projectId: string): Promise<KnowledgeDocumentInput[]> {
  const docs: KnowledgeDocumentInput[] = [];
  const now = new Date().toISOString();

  const { data: pages } = await sb
    .from('seo_pages')
    .select('url, title, description')
    .eq('project_id', projectId)
    .limit(800);
  for (const p of pages ?? []) {
    const title = (p.title as string | null) ?? '';
    const desc = (p.description as string | null) ?? '';
    const url = p.url as string;
    docs.push({
      externalId: `page:${url}`,
      kind: 'page',
      title: title || url,
      text: `Page: ${title}\nURL: ${url}\n${desc ? `Description: ${desc}` : ''}`,
      url,
      meta: { source: 'crawl', updated_at: now },
    });
  }

  const { data: content } = await sb
    .from('seo_content')
    .select('id, title, body, excerpt, url, content_html')
    .eq('project_id', projectId)
    .limit(500);
  for (const c of content ?? []) {
    const body = ((c.body as string | null) ?? (c.content_html as string | null)) ?? '';
    docs.push({
      externalId: `content:${c.id as string}`,
      kind: 'content',
      title: (c.title as string) ?? '',
      text: `${(c.title as string) ?? ''}\n\n${body.slice(0, 12000)}`,
      url: (c.url as string | null) ?? undefined,
      meta: { source: 'content' },
    });
  }

  const { data: keywords } = await sb.from('seo_keywords').select('keyword, meta, difficulty, volume').eq('project_id', projectId).limit(2000);
  for (const k of keywords ?? []) {
    const keyword = k.keyword as string;
    const meta = (k.meta as Record<string, unknown>) ?? {};
    const difficulty = k.difficulty as number | null;
    const volume = k.volume as number | null;
    const intents = (meta.intents as string[] | undefined) ?? [];
    docs.push({
      externalId: `keyword:${keyword}`,
      kind: 'keyword',
      title: keyword,
      text: `Keyword: ${keyword}\nDifficulty: ${difficulty ?? 'n/a'}\nVolume: ${volume ?? 'n/a'}\nIntents: ${intents.join(', ') || 'n/a'}`,
      meta: { source: 'keyword_research', difficulty, volume },
    });
  }

  const { data: audits } = await sb
    .from('seo_audits')
    .select('id, title, detail, recommendation, severity, url')
    .eq('project_id', projectId)
    .order('audited_at', { ascending: false })
    .limit(800);
  for (const a of audits ?? []) {
    docs.push({
      externalId: `audit:${a.id as string}`,
      kind: 'audit',
      title: (a.title as string) ?? 'Audit finding',
      text: `${(a.title as string) ?? ''}\n${(a.detail as string | null) ?? ''}\nRecommendation: ${(a.recommendation as string | null) ?? ''}`,
      url: (a.url as string | null) ?? undefined,
      meta: { source: 'audit', severity: a.severity },
    });
  }

  return docs;
}

const knowledgeIndex: JobExecutor = async ({ container, job, report }) => {
  const provider = container.registry.getKnowledge('qdrant');
  if (!provider) throw new ApiError(503, 'not_configured', 'Knowledge provider (qdrant) is not registered');
  const ctx: ProviderContext = {
    projectId: job.project_id,
    userId: job.created_by,
    config: {},
    credentials: noopCredentialReader(),
    logger: logger.child({ projectId: job.project_id, provider: 'qdrant' }) as unknown as ProviderContext['logger'],
  };
  const docs = await collectKnowledgeDocuments(container.sb, job.project_id);
  if (docs.length === 0) return { message: 'Nothing to index yet - add pages, content or keywords first', documents: 0 };
  await provider.ensureProject(ctx);
  await report(20, `Indexing ${docs.length} documents`);
  const { indexed } = await provider.index(ctx, docs);
  await report(100, `Indexed ${indexed} chunks`);
  return { documents: docs.length, chunks: indexed };
};

const knowledgeReindex: JobExecutor = async ({ container, job, report }) => {
  const provider = container.registry.getKnowledge('qdrant');
  if (!provider) throw new ApiError(503, 'not_configured', 'Knowledge provider (qdrant) is not registered');
  const ctx: ProviderContext = {
    projectId: job.project_id,
    userId: job.created_by,
    config: {},
    credentials: noopCredentialReader(),
    logger: logger.child({ projectId: job.project_id, provider: 'qdrant' }) as unknown as ProviderContext['logger'],
  };
  const docs = await collectKnowledgeDocuments(container.sb, job.project_id);
  await provider.ensureProject(ctx);
  await report(20, `Reindexing project knowledge (${docs.length} documents)`);
  await provider.reindex(ctx, docs);
  await report(100, 'Reindex complete');
  return { documents: docs.length };
};

const knowledgeDelete: JobExecutor = async ({ container, job }) => {
  const provider = container.registry.getKnowledge('qdrant');
  if (!provider) throw new ApiError(503, 'not_configured', 'Knowledge provider (qdrant) is not registered');
  const ctx: ProviderContext = {
    projectId: job.project_id,
    userId: job.created_by,
    config: {},
    credentials: noopCredentialReader(),
    logger: logger.child({ projectId: job.project_id, provider: 'qdrant' }) as unknown as ProviderContext['logger'],
  };
  await provider.deleteProject(ctx);
  return { message: 'Project knowledge base cleared' };
};

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

const publish: JobExecutor = async ({ container, job, report }) => {
  const publicationId = job.params.publication_id as string | undefined;
  if (!publicationId) throw new ApiError(400, 'bad_request', 'publish job requires a publication_id');
  const { data: publication } = await container.sb
    .from('seo_publications')
    .select('*')
    .eq('project_id', job.project_id)
    .eq('id', publicationId)
    .maybeSingle();
  if (!publication) throw new ApiError(404, 'not_found', 'Publication not found');
  const pub = publication as Record<string, unknown>;
  const { data: publisher } = await container.sb
    .from('seo_publishers')
    .select('*')
    .eq('project_id', job.project_id)
    .eq('id', pub.publisher_id as string)
    .maybeSingle();
  if (!publisher) throw new ApiError(404, 'not_found', 'Publisher not found');

  const adapter = container.registry.getPublisher(publisher.provider as string);
  if (!adapter) throw new ApiError(503, 'not_configured', `Publisher ${publisher.provider} is not registered`);
  const ctx = buildProviderContext(container, {
    projectId: job.project_id,
    userId: job.created_by,
    owner: { publisherId: String(publisher.id), providerType: String(publisher.provider) },
    config: (publisher.config as Record<string, unknown>) ?? {},
  });

  const operation = job.job_type; // publish | publish_update | publish_delete
  await report(20, `Publishing to ${publisher.name}`);

  if (operation === 'publish_delete') {
    const remoteId = pub.remote_id as string | null;
    if (!remoteId) throw new ApiError(400, 'bad_request', 'Nothing to delete: publication has no remote id');
    await adapter.delete(ctx, remoteId);
    await container.sb.from('seo_publications').update({ status: 'deleted', published_at: null }).eq('id', publicationId);
    await report(100, 'Publication deleted remotely');
    return { remoteId, deleted: true };
  }

  const title = pub.title as string;
  const content = (pub.content as string) ?? '';
  const slug = (pub.slug as string | undefined) ?? undefined;
  const remoteStatus = job.params.remote_status === 'draft' ? 'draft' : 'publish';

  if (operation === 'publish_update') {
    const remoteId = pub.remote_id as string | null;
    if (!remoteId) throw new ApiError(400, 'bad_request', 'Cannot update a publication without a remote id');
    await report(40, 'Updating remote post');
    const result = await adapter.update(ctx, remoteId, { title, content, excerpt: (pub.excerpt as string) ?? undefined, status: remoteStatus });
    await container.sb
      .from('seo_publications')
      .update({ status: 'updated', target_url: result.url, remote_id: result.remoteId, published_at: new Date().toISOString(), error: null })
      .eq('id', publicationId);
    await report(100, 'Publication updated');
    return { remoteId: result.remoteId, url: result.url };
  }

  await report(40, 'Creating remote post');
  const result = await adapter.publish(ctx, { title, content, excerpt: (pub.excerpt as string) ?? undefined, slug, status: remoteStatus });
  await container.sb
    .from('seo_publications')
    .update({ status: 'published', target_url: result.url, remote_id: result.remoteId, published_at: new Date().toISOString(), error: null })
    .eq('id', publicationId);
  await report(100, 'Publication published');
  return { remoteId: result.remoteId, url: result.url };
};

// ---------------------------------------------------------------------------
// Content agent
// ---------------------------------------------------------------------------

async function contentGenerate(ctx: JobExecContext): Promise<Record<string, unknown>> {
  const { container, job } = ctx;
  const input = (job.params ?? {}) as Record<string, unknown>;
  const topic = typeof input.topic === 'string' ? input.topic.trim() : '';
  if (!topic) throw new ApiError(400, 'bad_request', 'content_generate requires a topic');

  const agent = new ContentAgentService(container);
  const stage = (label: string, progress: number) => ctx.report(progress, label);
  const result = await agent.generate(job.project_id, String(job.created_by ?? 'system'), {
    topic,
    targetKeyword: typeof input.target_keyword === 'string' ? input.target_keyword : null,
    language: typeof input.language === 'string' ? input.language : undefined,
    audience: typeof input.audience === 'string' ? input.audience : null,
    tone: typeof input.tone === 'string' ? input.tone : null,
    contentLength: input.content_length === 'short' || input.content_length === 'long' ? input.content_length : 'medium',
    includeKnowledge: input.include_knowledge !== false,
    imageHint: typeof input.image_hint === 'string' ? input.image_hint : null,
    imageCount: typeof input.image_count === 'number' ? input.image_count : undefined,
  }, stage);

  await ctx.report(100, `Content draft "${result.title}" created`);
  return result;
}

async function contentImages(ctx: JobExecContext): Promise<Record<string, unknown>> {
  const { container, job } = ctx;
  const params = (job.params ?? {}) as Record<string, unknown>;
  const contentId = typeof params.content_id === 'string' ? params.content_id : '';
  if (!contentId) throw new ApiError(400, 'bad_request', 'content_images requires a content_id');
  const providerId = typeof params.image_provider === 'string' ? params.image_provider : 'unsplash';
  const cap = typeof params.limit === 'number' ? Math.max(1, Math.min(Math.floor(params.limit), 6)) : 4;

  const service = new ContentService(container.sb);
  const row = await service.get(job.project_id, contentId);
  const blocks = (row.content_json ?? []) as ContentBlock[];
  type MediaBlock = Extract<ContentBlock, { type: 'media' }>;
  const isImagePlaceholder = (b: ContentBlock): b is MediaBlock =>
    b.type === 'media' && b.attrs.kind === 'placeholder' && !b.attrs.src;
  const placeholders: Array<{ block: MediaBlock; index: number }> = [];
  blocks.forEach((b, index) => {
    if (isImagePlaceholder(b)) placeholders.push({ block: b, index });
  });
  if (placeholders.length === 0) {
    await ctx.report(100, 'No media placeholders in this content draft');
    return { resolved: 0, skipped: 0 };
  }

  const media = container.registry.getMedia(providerId);
  if (!media) throw new ApiError(400, 'bad_request', `No media provider "${providerId}" is registered`);
  if (!media.isConfigured()) {
    throw ApiError.notConfigured(`Media provider "${providerId}" is not configured on this server`);
  }

  let resolved = 0;
  for (const target of placeholders) {
    if (resolved >= cap) break;
    const title = typeof row.title === 'string' ? row.title : '';
    const alt = String(target.block.attrs.alt || title || 'illustration').slice(0, 500);
    let src: string | null = null;
    if (media.capabilities.includes('search') && media.search) {
      const hits = await media.search({ query: alt, limit: 1, orientation: 'landscape' });
      src = hits[0]?.url ?? null;
    }
    if (!src && media.capabilities.includes('generate') && media.generate) {
      const gen = await media.generate({
        prompt: `High-quality editorial image for an article section: ${alt}`,
        size: '1792x1024',
      });
      src = gen.url;
    }
    if (!src) continue;
    const updated = {
      ...target.block,
      attrs: {
        ...target.block.attrs,
        kind: 'image' as const,
        src,
        provider: providerId,
      },
    } as unknown as ContentBlock;
    blocks[target.index] = updated;
    resolved += 1;
    await ctx.report(Math.round((resolved / placeholders.length) * 90), `Resolved ${resolved} image(s)`);
  }

  const skipped = placeholders.length - resolved;
  if (resolved > 0) {
    await service.update(job.project_id, String(job.created_by ?? 'system'), contentId, { contentJson: blocks });
  }
  await ctx.report(100, `Resolved ${resolved} image(s), ${skipped} left as placeholders`);
  return { resolved, skipped, provider: providerId };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const EXECUTORS: Record<string, JobExecutor> = {
  gsc_sync: gscSync,
  dataforseo_rank_sync: dataForSeoRankSync,
  dataforseo_keyword_research: dataForSeoKeywordResearch,
  serp_retrieval: serpRetrieval,
  knowledge_index: knowledgeIndex,
  knowledge_reindex: knowledgeReindex,
  knowledge_delete: knowledgeDelete,
  content_generate: contentGenerate,
  content_images: contentImages,
  publish,
  publish_update: publish,
  publish_delete: publish,
};

export function getExecutor(jobType: string): JobExecutor | undefined {
  return EXECUTORS[jobType];
}

export async function isJobExpired(job: JobRecord, maxRuntimeMs: number): Promise<boolean> {
  if (!job.started_at) return false;
  return Date.now() - new Date(job.started_at).getTime() > maxRuntimeMs;
}

// small guard: ensure an unexpected rejection never crashes the worker silently
export function safeDelay(ms: number): Promise<void> {
  return delay(ms);
}
