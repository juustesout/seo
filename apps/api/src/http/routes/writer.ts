/**
 * Writer API (project-scoped, W6): start and supervise a writer run for one
 * content item of the Content Studio.
 *
 * Thin routes: every handler authorizes first (authenticated user -> project
 * membership role -> content exists in this project via ContentService.get),
 * then delegates to the WriterRunService (SEO Core), which maps the resting
 * writer state onto a safe WriterRunDto. No handler ever trusts a request id:
 * the runId is bound to the exact projectId+contentId in the URL, so a valid
 * runId from another project/content can never be addressed here (404).
 *
 * Mounted at /api/projects/:projectId/content/:contentId/writer.
 *
 * Endpoints:
 *   POST /              start a run (editor+)     -> WriterRunDto (awaiting_approval)
 *   GET  /:runId        safe run snapshot (viewer+) -> WriterRunDto
 *   POST /:runId/approval  approve/reject (editor+) -> WriterRunDto (writing | rejected)
 *
 * Error semantics reuse the W3 writer boundary: malformed runId -> 400, an
 * invalid approval decision -> 400 invalid_approval_decision, unknown or
 * mismatched run -> 404 writer_run_not_found, run not awaiting approval ->
 * 409 writer_run_not_awaiting_approval.
 *
 * W6 boundaries: starting/approving never writes seo_content, never publishes
 * and never schedules - a completed run only exposes its review-ready
 * artifact. Responses carry no prompts, no checkpoint data and no credentials.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ApiError } from '../../apiErrors.js';
import { asyncHandler } from '../asyncHandler.js';
import { requireAuth } from '../middleware.js';
import { parseId, parseProjectId } from './utils.js';
import { ContentService } from '../../services/contentService.js';
import { WriterRunService } from '../../services/writerRunService.js';
import {
  isWriterRunId,
  parseWriterApprovalDecision,
  type WriterRunId,
} from '../../agents/writer/index.js';

export const writerRouter: Router = Router({ mergeParams: true });

writerRouter.use(requireAuth);

const startSchema = z
  .object({
    instruction: z.string().trim().min(1).max(500).optional(),
  })
  .passthrough();

/** Strict W3 approval vocabulary is validated through the shared gate. */
function parseRunId(raw: string | undefined): WriterRunId {
  if (!raw || !isWriterRunId(raw)) {
    throw ApiError.badRequest('runId must be a writer run id (wr_<uuid>)', { runId: raw });
  }
  return raw;
}

/** Start a writer run for one content item (editor+). The optional
 *  `instruction` becomes the run's topic; without one the content title is
 *  used. Returns the resting DTO: awaiting_approval with the proposed plan
 *  when planning succeeded, failed with an honest note otherwise. */
writerRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = startSchema.parse(req.body);

    const content = await new ContentService(container.sb).get(projectId, parseId(req, 'contentId'));
    const instruction = body.instruction ?? null;
    const contentTitle = typeof content.title === 'string' ? content.title.trim() : '';
    const topic = instruction ?? contentTitle;
    if (!topic) {
      throw ApiError.badRequest('Provide an instruction or give this content a title first.');
    }
    const targetKeyword =
      typeof content.target_keyword === 'string' && content.target_keyword.trim()
        ? content.target_keyword.trim()
        : null;

    const svc = new WriterRunService(container, { actor: { userId: user!.sub } });
    const run = await svc.start(projectId, parseId(req, 'contentId'), { topic, targetKeyword });
    res.status(201).json({ data: run });
  }),
);

/** Safe run snapshot for the UI (viewer+ read access). Only identity, plan,
 *  note and - after a completed W5 review - the canonical artifact; never
 *  prompts, checkpoint state or credentials. */
writerRouter.get(
  '/:runId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const contentId = parseId(req, 'contentId');
    await new ContentService(container.sb).get(projectId, contentId);
    const runId = parseRunId(req.params.runId);
    const svc = new WriterRunService(container);
    res.json({ data: await svc.getRun(runId, projectId, contentId) });
  }),
);

/** Explicit human approval or rejection of a proposed plan (editor+). The
 *  exact W3 approval vocabulary is enforced here; an approve starts the W4+W5
 *  phase in-process and returns the run as `writing` (poll GET /:runId until a
 *  terminal status), a reject resumes synchronously to `rejected`. */
writerRouter.post(
  '/:runId/approval',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const contentId = parseId(req, 'contentId');
    await new ContentService(container.sb).get(projectId, contentId);
    const runId = parseRunId(req.params.runId);

    const parsed = parseWriterApprovalDecision(req.body);
    if (!parsed.ok) {
      throw new ApiError(400, 'invalid_approval_decision', parsed.note, { runId });
    }

    const svc = new WriterRunService(container);
    const run = await svc.decide(runId, parsed.decision, projectId, contentId);
    res.json({ data: run });
  }),
);
