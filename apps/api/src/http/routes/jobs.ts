/**
 * Jobs API: enqueue + cancel background work. Job rows are durable and the UI
 * reads their status through Supabase (RLS) for live progress.
 *
 * Mounted at /api/projects/:projectId/jobs. Session-authenticated with role
 * gates: viewers list jobs, editors enqueue, admins cancel. Enqueuing is thin -
 * it delegates to the shared job-enqueue gate (../../jobs/enqueue.ts), which
 * validates the job_type, checks the backing provider is honestly
 * configured/connected (never silently queuing a job whose provider is absent)
 * and resolves the project data source. Long provider work never blocks an
 * HTTP handler here.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { enqueueJob } from '../../jobs/enqueue.js';
import { parseId, parseProjectId } from './utils.js';

export const jobsRouter: Router = Router({ mergeParams: true });

jobsRouter.use(requireAuth);

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

    const job = await enqueueJob(container, {
      projectId,
      userId: user!.sub,
      jobType: body.job_type,
      params: body.params,
      dataSourceId: body.data_source_id ?? null,
      runAfter: body.run_after,
      maxRetries: body.max_retries,
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
