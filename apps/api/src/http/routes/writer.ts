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
 *   POST /:runId/revise    revise sections (editor+) -> WriterRunDto (revising)
 *   POST /:runId/magic     Section Magic transform (editor+) -> WriterRunDto (revising)
 *   POST /:runId/research  gather research evidence (editor+) -> WriterRunDto (review_ready)
 *   POST /:runId/intelligence  gather combined intelligence (editor+) -> WriterRunDto (review_ready)
 *
 * Error semantics reuse the W3 writer boundary: malformed runId -> 400, an
 * invalid approval decision -> 400 invalid_approval_decision, an invalid
 * review-session revision -> 400 invalid_review_session_decision, an invalid
 * Section Magic request -> 400 invalid_magic_request, unknown or mismatched run
 * -> 404 writer_run_not_found, run not awaiting approval -> 409
 * writer_run_not_awaiting_approval, run not resting on review_ready (for
 * revise/magic) -> 409 writer_run_not_review_ready.
 *
 * W6/W8/W10.1 boundaries: starting/approving/revising/magic never writes
 * seo_content, never publishes and never schedules - a review_ready run only
 * exposes its review-ready artifact, and this surface exposes no accept/
 * completed path (that stays graph/contract-level until a later milestone).
 * Section Magic only ever transforms the explicitly selected sections of a
 * review_ready run through the W8 revision round and never accepts or publishes
 * on its own. Responses carry no prompts, no checkpoint data and no
 * credentials.
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
  parseWriterSessionDecision,
  parseWriterMagicRequest,
  parseWriterIntelligenceRequest,
  parseWriterAgentRequest,
  type WriterRunId,
} from '../../agents/writer/index.js';

export const writerRouter: Router = Router({ mergeParams: true });

writerRouter.use(requireAuth);

const startSchema = z
  .object({
    instruction: z.string().trim().min(1).max(500).optional(),
  })
  .passthrough();

/** Bounded W10.2 research purposes accepted by the research endpoint. */
const researchPurposeSchema = z.enum(['planning', 'section_magic', 'revision']).optional();

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
 *  resting status), a reject resumes synchronously to `rejected`. */
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

/** Explicit revision of one or more sections of a review_ready run (editor+).
 *  The exact W8 review-session revise vocabulary is enforced here (sectionIds
 *  must address existing approved-plan sections, instruction bounded, no extra
 *  fields); accepting a run is not part of this W8 surface. A valid revise
 *  commits the run to `revising` first and resumes the revision round in the
 *  background - poll GET /:runId until it rests on review_ready again. */
writerRouter.post(
  '/:runId/revise',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const contentId = parseId(req, 'contentId');
    await new ContentService(container.sb).get(projectId, contentId);
    const runId = parseRunId(req.params.runId);

    const parsed = parseWriterSessionDecision({ action: 'revise', ...(req.body as Record<string, unknown>) });
    if (!parsed.ok || parsed.decision.action !== 'revise') {
      throw new ApiError(
        400,
        'invalid_review_session_decision',
        parsed.ok
          ? 'This endpoint only accepts revisions; accepting a run is not available.'
          : parsed.note,
        { runId },
      );
    }

    const svc = new WriterRunService(container);
    const run = await svc.revise(runId, parsed.decision, projectId, contentId);
    res.json({ data: run });
  }),
);

/** Explicit Section Magic transformation of one or more sections of a
 *  review_ready run (editor+). The exact W10.1 magic vocabulary is enforced
 *  here: sectionIds must address existing approved-plan sections (re-validated
 *  against the run's plan), the action is one of the canonical bounded magic
 *  actions, the instruction is optional and bounded, and change_tone/custom
 *  obey their per-action field rules. A valid magic request commits the run to
 *  `revising` first and resumes the W8 revision round in the background - poll
 *  GET /:runId until it rests on review_ready again. Magic never accepts or
 *  publishes a run and never transforms sections the user did not select. */
writerRouter.post(
  '/:runId/magic',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const contentId = parseId(req, 'contentId');
    await new ContentService(container.sb).get(projectId, contentId);
    const runId = parseRunId(req.params.runId);

    const parsed = parseWriterMagicRequest(req.body);
    if (!parsed.ok) {
      throw new ApiError(400, 'invalid_magic_request', parsed.note, { runId });
    }

    const svc = new WriterRunService(container);
    const run = await svc.magic(runId, req.body, projectId, contentId);
    res.json({ data: run });
  }),
);

/** Explicit research-evidence gather for a review_ready run (editor+, W10.2).
 *  Research is a read-only, synchronous operation: the run rests on
 *  review_ready the whole time and the response is the resting DTO carrying the
 *  fresh `evidence` (honest per-source status - never fabricated, never
 *  auto-applied, never written to the article). The optional body purpose is
 *  bounded to the canonical vocabulary. Wrong-state / unknown runs fail closed
 *  exactly like revise/magic. */
writerRouter.post(
  '/:runId/research',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const contentId = parseId(req, 'contentId');
    await new ContentService(container.sb).get(projectId, contentId);
    const runId = parseRunId(req.params.runId);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const purpose = researchPurposeSchema.safeParse(body.purpose);
    if (!purpose.success) {
      throw new ApiError(
        400,
        'invalid_research_request',
        'Research purpose, when provided, must be one of: planning, section_magic, revision.',
        { runId },
      );
    }

    const svc = new WriterRunService(container);
    const run = await svc.research(runId, purpose.data ?? 'revision', projectId, contentId);
    res.json({ data: run });
  }),
);

/** Explicit combined-intelligence gather for a review_ready run (editor+,
 *  W10.3). Intelligence is a read-only, synchronous operation that combines the
 *  project's existing sources into bounded, untrusted findings: the run rests on
 *  review_ready the whole time and the response is the resting DTO carrying the
 *  fresh `intelligence` (honest per-source status - never fabricated, never
 *  auto-applied, never written to the article). The strict body is
 *  `{ purpose, focus?, sections? }` with sections re-validated against the
 *  approved plan; unknown workflow-control fields are rejected. Wrong-state /
 *  unknown runs fail closed exactly like revise/magic/research. */
writerRouter.post(
  '/:runId/intelligence',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const contentId = parseId(req, 'contentId');
    await new ContentService(container.sb).get(projectId, contentId);
    const runId = parseRunId(req.params.runId);

    const parsed = parseWriterIntelligenceRequest(req.body);
    if (!parsed.ok) {
      throw new ApiError(400, 'invalid_intelligence_request', parsed.note, { runId });
    }

    const svc = new WriterRunService(container);
    const run = await svc.intelligence(runId, parsed.request, projectId, contentId);
    res.json({ data: run });
  }),
);

/** Start one bounded advanced-agent coordination run on a review_ready run
 *  (editor+, W10.4). The strict body is `{ goal, max_steps?, instruction?,
 *  sections? }` with max_steps server-bounded and sections re-validated against
 *  the approved plan. The coordinator only ever chooses from the fixed action
 *  allowlist and executes through existing safe boundaries; it can never apply
 *  or publish. The response is the resting DTO with `agent.status` set to
 *  `running` (poll GET /:runId until the agent reaches a terminal status).
 *  Unknown workflow-control fields, invalid goals/steps and wrong-state / busy /
 *  unknown runs fail closed. */
writerRouter.post(
  '/:runId/agent',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const contentId = parseId(req, 'contentId');
    await new ContentService(container.sb).get(projectId, contentId);
    const runId = parseRunId(req.params.runId);

    const parsed = parseWriterAgentRequest(req.body);
    if (!parsed.ok) {
      throw new ApiError(400, 'invalid_agent_request', parsed.note, { runId });
    }

    const svc = new WriterRunService(container);
    const run = await svc.agent(runId, parsed.request, projectId, contentId);
    res.json({ data: run });
  }),
);
