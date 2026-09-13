/**
 * Shared job-enqueue gate. The generic /jobs route and feature routes (e.g.
 * keyword research) both go through this one path, so provider registration,
 * connection gating and data-source resolution never drift between entry
 * points. Enqueuing is thin: it validates the job_type against the platform's
 * known vocabulary, checks the backing provider is honestly configured and
 * connected (never silently queuing a job whose provider is absent), resolves
 * the project data source and delegates row creation to the job store. Long
 * provider work never happens here.
 */

import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import type { JobRecord } from './types.js';

/** Maps every platform job_type to its owning provider (drives gating + data source resolution). */
export const JOB_PROVIDER: Record<string, string> = {
  gsc_sync: 'gsc',
  dataforseo_rank_sync: 'dataforseo',
  dataforseo_keyword_research: 'dataforseo',
  serp_retrieval: 'dataforseo',
  competitor_research: 'dataforseo',
  website_crawl: 'crawler',
  website_audit: 'crawler',
  knowledge_index: 'qdrant',
  knowledge_reindex: 'qdrant',
  knowledge_delete: 'qdrant',
  knowledge_discovery: 'qdrant',
};

export const KNOWN_JOB_TYPES = Object.keys(JOB_PROVIDER);

/** The most recently created data source of a provider for this project, if any. */
export async function resolveDataSource(container: ServiceContainer, projectId: string, provider: string) {
  const { data } = await container.sb
    .from('seo_data_sources')
    .select('*')
    .eq('project_id', projectId)
    .eq('provider_type', provider)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? (data as Record<string, unknown>) : null;
}

/**
 * The connected GSC integration behind a project's linked property. Since
 * Stage 4 the Google connection lives at the account level (integration has
 * project_id NULL) and the project's property references it; legacy rows
 * reference a project-scoped integration. Returns null when unresolved.
 */
async function resolveGscIntegrationForProject(container: ServiceContainer, projectId: string): Promise<string | null> {
  const { data: link } = await container.sb
    .from('seo_project_properties')
    .select('property_id')
    .eq('project_id', projectId)
    .order('is_primary', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!link) return null;
  const { data: property } = await container.sb
    .from('seo_gsc_properties')
    .select('integration_id')
    .eq('id', (link as Record<string, unknown>).property_id as string)
    .maybeSingle();
  const integrationId = (property as Record<string, unknown> | null)?.integration_id as string | null;
  if (!integrationId) return null;
  const { data: integration } = await container.sb
    .from('seo_integrations')
    .select('id, project_id, account_id')
    .eq('id', integrationId)
    .eq('status', 'connected')
    .maybeSingle();
  if (!integration) return null;
  const { data: project } = await container.sb.from('seo_projects').select('account_id').eq('id', projectId).maybeSingle();
  const accountId = (project as Record<string, unknown> | null)?.account_id as string | null;
  const row = integration as Record<string, unknown>;
  const ownedByProject = (row.project_id as string | null) === projectId;
  const ownedByProjectAccount = (row.project_id as string | null) === null && (row.account_id as string | null) === accountId;
  return ownedByProject || ownedByProjectAccount ? integrationId : null;
}

/**
 * Verify a provider has a connected integration before a job is enqueued, and
 * return its id. GSC goes through the account/property link (resolveGsc...);
 * every other provider needs a connected project-scoped integration row.
 * Enqueuing without this check would produce jobs that fail at run time
 * instead of telling the user what to connect.
 */
export async function assertConnectedIntegration(container: ServiceContainer, projectId: string, provider: string) {
  if (provider === 'gsc') {
    const linked = await resolveGscIntegrationForProject(container, projectId);
    if (linked) return linked;
  }
  const { data } = await container.sb
    .from('seo_integrations')
    .select('id')
    .eq('project_id', projectId)
    .eq('provider_type', provider)
    .eq('status', 'connected')
    .maybeSingle();
  if (!data) {
    throw ApiError.badRequest(`No connected ${provider} integration for this project`);
  }
  return data.id as string;
}

export interface EnqueueJobOptions {
  projectId: string;
  userId: string;
  jobType: string;
  params?: Record<string, unknown>;
  dataSourceId?: string | null;
  runAfter?: string;
  maxRetries?: number;
}

/** Validate, gate and enqueue one job through the single shared path. */
export async function enqueueJob(container: ServiceContainer, opts: EnqueueJobOptions): Promise<JobRecord> {
  const { projectId, userId, jobType } = opts;
  if (!KNOWN_JOB_TYPES.includes(jobType)) {
    throw ApiError.badRequest(`Unknown job_type '${jobType}'. Known: ${KNOWN_JOB_TYPES.join(', ')}`);
  }
  const provider = JOB_PROVIDER[jobType]!;

  // crawler job types exist in the platform vocabulary but no crawler provider
  // is registered yet -> honest "not configured", never silent fake.
  if (provider === 'crawler' || (provider !== 'qdrant' && !container.registry.getDataSource(provider))) {
    throw ApiError.notConfigured(`No ${provider} provider is registered on this server yet`);
  }
  if (provider === 'qdrant' && !container.registry.getKnowledge('qdrant')) {
    throw ApiError.notConfigured('The qdrant knowledge provider is not registered on this server yet');
  }

  // Knowledge indexing is server-configured (env), not a user-connected
  // integration; everything else requires a connected integration.
  let integrationId: string | null = null;
  if (provider !== 'qdrant') {
    integrationId = await assertConnectedIntegration(container, projectId, provider);
  }

  let dataSourceId: string | null = opts.dataSourceId ?? null;
  if (!dataSourceId && provider !== 'qdrant') {
    const ds = await resolveDataSource(container, projectId, provider);
    dataSourceId = ds ? (ds.id as string) : null;
  }
  if (!dataSourceId && provider !== 'qdrant') {
    throw ApiError.badRequest(`Attach a ${provider} data source to this project before syncing`);
  }

  return container.jobStore.enqueue({
    project_id: projectId,
    provider,
    job_type: jobType,
    params: opts.params ?? {},
    integration_id: integrationId,
    data_source_id: dataSourceId,
    created_by: userId,
    run_after: opts.runAfter,
    max_retries: opts.maxRetries,
  });
}
