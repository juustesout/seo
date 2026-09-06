/** Jobs API: enqueue + cancel background work. Job rows are durable and the UI reads their status through Supabase (RLS) for live progress. */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { parseId, parseProjectId } from './utils.js';

export const jobsRouter: Router = Router({ mergeParams: true });

jobsRouter.use(requireAuth);

const JOB_PROVIDER: Record<string, string> = {
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
};

const KNOWN_JOB_TYPES = Object.keys(JOB_PROVIDER);

async function resolveDataSource(container: ReturnType<typeof import('../../context.js').getContainer>, projectId: string, provider: string) {
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
 * Resolve the connected GSC integration behind a project's linked property.
 * Since Stage 4 the Google connection lives at the account level (integration
 * has project_id NULL) and the project's property references it; legacy rows
 * reference a project-scoped integration. Returns null when unresolved.
 */
async function resolveGscIntegrationForProject(
  container: ReturnType<typeof import('../../context.js').getContainer>,
  projectId: string,
): Promise<string | null> {
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

async function assertConnectedIntegration(
  container: ReturnType<typeof import('../../context.js').getContainer>,
  projectId: string,
  provider: string,
) {
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

/** Enqueue a background job. The job row is inserted server-side only. */
jobsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');

    const body = z
      .object({
        job_type: z.string().min(1),
        params: z.record(z.string(), z.unknown()).default({}),
        data_source_id: z.string().uuid().optional().nullable(),
        run_after: z.string().optional(),
        max_retries: z.number().int().min(0).max(10).optional(),
      })
      .parse(req.body);

    if (!KNOWN_JOB_TYPES.includes(body.job_type)) {
      throw ApiError.badRequest(`Unknown job_type '${body.job_type}'. Known: ${KNOWN_JOB_TYPES.join(', ')}`);
    }
    const provider = JOB_PROVIDER[body.job_type]!;

    // crawler job types exist in the platform vocabulary but no crawler
    // provider is registered yet -> honest "not configured", never silent fake.
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

    let dataSourceId: string | null = body.data_source_id ?? null;
    if (!dataSourceId && provider !== 'qdrant') {
      const ds = await resolveDataSource(container, projectId, provider);
      dataSourceId = ds ? (ds.id as string) : null;
    }
    if (!dataSourceId && provider !== 'qdrant') {
      throw ApiError.badRequest(`Attach a ${provider} data source to this project before syncing`);
    }

    const job = await container.jobStore.enqueue({
      project_id: projectId,
      provider,
      job_type: body.job_type,
      params: body.params,
      integration_id: integrationId,
      data_source_id: dataSourceId,
      created_by: user!.sub,
      run_after: body.run_after,
      max_retries: body.max_retries,
    });
    res.status(202).json({ data: { job } });
  }),
);

/** Recent jobs for a project (UI polls for progress). */
jobsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const jobs = await container.jobStore.list(projectId, parsed.limit);
    res.json({ data: jobs });
  }),
);

/** Cancel a queued/running job (admin/owner only). */
jobsRouter.post(
  '/:jobId/cancel',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const jobId = parseId(req, 'jobId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'admin');
    const { data } = await container.sb.from('seo_sync_jobs').select('status').eq('id', jobId).eq('project_id', projectId).maybeSingle();
    if (!data) throw ApiError.notFound('Job not found');
    if (data.status === 'running') {
      // worker will observe cancellation via its own checks on long polls
    }
    await container.jobStore.cancel(jobId);
    res.json({ data: { ok: true } });
  }),
);
