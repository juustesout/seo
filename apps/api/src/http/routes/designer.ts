/**
 * Designer API (Stage 8E.6, Phase 2/3.3/Phase 4.1), project-scoped.
 *
 * Four thin, project-authorized endpoints around the DesignerService:
 *   - POST /api/projects/:projectId/designer/execute
 *       run an already-validated `DesignerPlan` and return a reviewable
 *       `DesignerProposal` (never persists; editor+).
 *   - POST /api/projects/:projectId/designer/intent
 *       turn a natural-language intent into a proposal through the LLM planner
 *       (never persists; editor+). Creation (client `base_revision`) and edit
 *       (`content_id`, revision derived server-side) are both supported.
 *   - POST /api/projects/:projectId/designer/runs
 *       durably accept a plan or intent as an `seo_agent_runs` row and enqueue
 *       its `agent_design` job (202; never executes synchronously; editor+).
 *   - GET  /api/projects/:projectId/designer/runs/:runId
 *       read the safe lifecycle snapshot of one durable run (viewer+); the run
 *       is bound to the URL project, so a foreign run id is never addressable.
 *   - POST /api/projects/:projectId/content/:contentId/designer/apply
 *       apply an explicitly approved proposal through the existing
 *       ContentService save path (editor+). A proposal generated against an
 *       older revision is rejected with `stale_proposal` (409) and no mutation.
 *
 * The Designer never writes seo_content on execute/intent/run submission and
 * never publishes.
 *
 * Mounted at:
 *   /api/projects/:projectId/designer
 *   /api/projects/:projectId/content/:contentId/designer
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  AGENT_RUN_IDEMPOTENCY_KEY_MAX_CHARS,
  DESIGNER_BASE_REVISION_MAX_CHARS,
  DESIGNER_INTENT_INSTRUCTION_MAX_CHARS,
  isValidDesignBrief,
  isValidDesignerPlan,
  isValidDesignerProposal,
  isAgentRunId,
  isValidImageInsertionContext,
} from '@seo/contracts';
import type { DesignerIntent, DesignerPlan, ImageInsertionContext } from '@seo/contracts';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { ApiError } from '../../apiErrors.js';
import { parseId, parseProjectId } from './utils.js';
import { ContentService } from '../../services/contentService.js';
import { AgentRunService, type AgentRunSubmission } from '../../services/agentRunService.js';
import { DesignerService } from '../../services/designerService.js';

export const designerRouter: Router = Router({ mergeParams: true });
export const contentDesignerRouter: Router = Router({ mergeParams: true });

designerRouter.use(requireAuth);
contentDesignerRouter.use(requireAuth);

const briefSchema = z.unknown().refine((value) => value === undefined || isValidDesignBrief(value), {
  message: 'Invalid design brief',
});

const executeSchema = z
  .object({
    plan: z.unknown().refine(isValidDesignerPlan, { message: 'Invalid designer plan' }),
    brief: briefSchema.optional(),
    content_id: z.string().uuid().optional(),
    base_revision: z.string().min(1).max(DESIGNER_BASE_REVISION_MAX_CHARS).optional(),
  })
  .strict();

const applySchema = z
  .object({
    proposal: z.unknown().refine(isValidDesignerProposal, { message: 'Invalid designer proposal' }),
  })
  .strict();

/**
 * Natural-language intent. `context` is deliberately not accepted here: the
 * contract leaves `selection` unbounded/opaque and the planner prompt ignores
 * it, so exposing it would only add transport and payload risk. The durable
 * `/runs` intent path instead takes the bounded, validated `editor_context`
 * (R3.1) when the caller is the Editor. `base_revision` is accepted only
 * without `content_id` (the server derives it from stored content), mirroring
 * the service's honest revision semantics.
 */
const intentSchema = z
  .object({
    instruction: z.string().trim().min(1).max(DESIGNER_INTENT_INSTRUCTION_MAX_CHARS),
    content_id: z.string().uuid().optional(),
    base_revision: z.string().min(1).max(DESIGNER_BASE_REVISION_MAX_CHARS).optional(),
    brief: briefSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.content_id !== undefined && value.base_revision !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'base_revision must not be provided with content_id; the revision is derived from stored content.',
        path: ['base_revision'],
      });
    }
    if (value.content_id === undefined && value.base_revision === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide content_id (existing-content edit) or base_revision (creation).',
        path: ['base_revision'],
      });
    }
  });

/**
 * Durable run submission (Phase 4.1, extended R3.1). `plan` mode accepts a
 * validated plan; `intent` mode accepts natural language. `_id` is always
 * resolved server-side and `base_revision` may not accompany `content_id`,
 * mirroring the intent route's honest revision semantics. `editor_context` is
 * the R3.1 editor-native seam: a validated `ImageInsertionContext` (canonical
 * snapshot + revision + insertion target) that lets the run resolve a
 * context-aware image insertion. It is bounded by its own contract validator and
 * requires `content_id` so the server can re-derive and check the revision.
 */
const runSchema = z
  .object({
    mode: z.enum(['plan', 'intent']),
    plan: z.unknown().optional(),
    instruction: z.string().trim().min(1).max(DESIGNER_INTENT_INSTRUCTION_MAX_CHARS).optional(),
    content_id: z.string().uuid().optional(),
    base_revision: z.string().min(1).max(DESIGNER_BASE_REVISION_MAX_CHARS).optional(),
    editor_context: z.unknown().optional(),
    brief: briefSchema.optional(),
    idempotency_key: z.string().trim().min(1).max(AGENT_RUN_IDEMPOTENCY_KEY_MAX_CHARS).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === 'plan') {
      if (value.plan === undefined || !isValidDesignerPlan(value.plan)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A valid plan is required.', path: ['plan'] });
      }
      if (value.instruction !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'instruction is only valid for intent mode.',
          path: ['instruction'],
        });
      }
    } else {
      if (value.instruction === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'instruction is required for intent mode.',
          path: ['instruction'],
        });
      }
      if (value.plan !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'plan is only valid for plan mode.',
          path: ['plan'],
        });
      }
    }
    if (value.editor_context !== undefined) {
      if (!isValidImageInsertionContext(value.editor_context)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid editor context.', path: ['editor_context'] });
      } else if (value.mode !== 'intent') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'editor_context is only valid for intent mode.',
          path: ['editor_context'],
        });
      } else if (value.content_id === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'editor_context requires content_id; the revision is derived from stored content.',
          path: ['content_id'],
        });
      }
    }
    if (value.content_id !== undefined && value.base_revision !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'base_revision must not be provided with content_id; the revision is derived from stored content.',
        path: ['base_revision'],
      });
    }
    if (value.content_id === undefined && value.base_revision === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide content_id (existing-content edit) or base_revision (creation).',
        path: ['base_revision'],
      });
    }
  });

/** Run a Designer plan into a proposal (editor+). Never persists. */
designerRouter.post(
  '/execute',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = executeSchema.parse(req.body ?? {});
    const proposal = await new DesignerService(container).execute(projectId, {
      plan: body.plan,
      brief: body.brief,
      contentId: body.content_id,
      baseRevision: body.base_revision,
    });
    res.json({ data: { proposal } });
  }),
);

/**
 * Natural-language Designer intent (editor+). This is the public language entry
 * point: it always uses the LLM planner (the deterministic planner would reject
 * free-form instructions) and returns a proposal only - it never applies,
 * publishes or persists.
 *
 * Creation and edit are both supported: with `content_id` the proposal anchors
 * to the stored content's revision (preflighted, project-scoped, so foreign or
 * unknown content 404s before any model call); without `content_id` the client
 * supplies `base_revision` and the resulting creation proposal is carried into
 * the normal content-creation workflow. `DesignerService.apply` requires an
 * existing content record and is intentionally not used for creation proposals.
 */
designerRouter.post(
  '/intent',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = intentSchema.parse(req.body ?? {});

    if (body.content_id !== undefined) {
      await new ContentService(container.sb).get(projectId, body.content_id);
    }

    const intent: DesignerIntent = {
      instruction: body.instruction,
      projectId,
      ...(body.content_id !== undefined ? { contentId: body.content_id } : {}),
      ...(body.brief !== undefined ? { brief: body.brief } : {}),
    };

    const service = new DesignerService(container, { llmPlanner: true });
    const proposal = await service.executeIntent(projectId, intent, {
      ...(body.base_revision !== undefined ? { baseRevision: body.base_revision } : {}),
    });
    res.json({ data: { proposal } });
  }),
);

/**
 * Durably accept a Designer run (editor+). Persists an `seo_agent_runs` row and
 * enqueues its `agent_design` job, returning the stable run identity and its
 * initial status (202). It never runs the Designer or blocks on provider work;
 * execution and the status API are Phase 4 Part 2. An optional
 * `idempotency_key` collapses re-submissions onto the existing run.
 */
designerRouter.post(
  '/runs',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = runSchema.parse(req.body ?? {});

    if (body.content_id !== undefined) {
      await new ContentService(container.sb).get(projectId, body.content_id);
    }

    const common = {
      ...(body.content_id !== undefined ? { contentId: body.content_id } : {}),
      ...(body.base_revision !== undefined ? { baseRevision: body.base_revision } : {}),
      ...(body.brief !== undefined ? { brief: body.brief } : {}),
      ...(body.idempotency_key !== undefined ? { idempotencyKey: body.idempotency_key } : {}),
    };
    const submission: AgentRunSubmission =
      body.mode === 'plan'
        ? { mode: 'plan', plan: body.plan as DesignerPlan, ...common }
        : {
            mode: 'intent',
            instruction: body.instruction!,
            ...common,
            ...(body.editor_context !== undefined
              ? { editorContext: body.editor_context as ImageInsertionContext }
              : {}),
          };

    const result = await new AgentRunService(container).submitDesignRun(projectId, user!.sub, submission);
    res.status(202).json({ data: { run: result.run, reused: result.reused } });
  }),
);

/**
 * Read one durable Designer run (viewer+). Read-only and project-scoped: the
 * runId is bound to the URL project, so a valid run id from another project is
 * reported as not found (never a cross-project leak). The response is the safe
 * lifecycle snapshot - identity, status, bounded input, persisted result or
 * availability, and the structured error on failure.
 */
designerRouter.get(
  '/runs/:runId',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const runId = req.params.runId;
    if (!isAgentRunId(runId)) {
      throw ApiError.badRequest('runId must be an agent run id (ar_<uuid>)', { runId });
    }
    const run = await new AgentRunService(container).getRun(projectId, runId);
    if (!run) throw new ApiError(404, 'agent_run_not_found', 'Agent run not found', { runId });
    res.json({ data: run });
  }),
);

/** Apply an approved proposal to one content item (editor+). */
contentDesignerRouter.post(
  '/apply',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const contentId = parseId(req, 'contentId');
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = applySchema.parse(req.body ?? {});
    const row = await new DesignerService(container).apply(projectId, contentId, body.proposal, user!.sub);
    res.json({ data: row });
  }),
);
