/**
 * Opportunity intelligence API (KW5 + KW6). Mounted at
 * /api/projects/:projectId/keyword.
 *
 * GET  /opportunities            - deterministic analysis of the gap snapshot
 *                                  for the exact active competitor set (viewer+).
 * GET  /opportunities/topics     - KW6 topic recommendations: relevance +
 *                                  knowledge readiness over the same set.
 * POST /opportunities/topics/article - turn one recommendation into a draft via
 *                                  the shared Writer Engine (content_write job,
 *                                  editor+).
 * GET  /core-topics              - the project's stored core topics (viewer+).
 * PUT  /core-topics              - replace the core topics in project settings
 *                                  (editor+), no migration and no new table.
 *
 * Every read is a pure projection: it never starts a provider job, never
 * refreshes a snapshot and never persists a derived result. `competitors` is
 * required so a read can never silently describe a different set than the user
 * selected. The route is a thin edge that validates the bounded query, enforces
 * project access and delegates to the services.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  COMPETITOR_RESEARCH_DOMAIN_MAX_CHARS,
  COMPETITOR_RESEARCH_MAX_COMPETITORS,
  CORE_TOPICS_MAX,
  CORE_TOPIC_DESCRIPTION_MAX_CHARS,
  CORE_TOPIC_KEYWORD_MAX_CHARS,
  CORE_TOPIC_KEYWORDS_MAX,
  CORE_TOPIC_NAME_MAX_CHARS,
  OPPORTUNITIES_MAX_LIMIT,
  OPPORTUNITY_INTENTS,
  OPPORTUNITY_REASONS,
  OPPORTUNITY_SORTS,
  OPPORTUNITY_SORT_DIRS,
  TOPIC_ARTICLE_MAX_COMPETITORS,
  TOPIC_ARTICLE_MAX_KEYWORDS,
} from '@seo/contracts';
import { requireAuth } from '../middleware.js';
import { asyncHandler } from '../asyncHandler.js';
import { parseProjectId } from './utils.js';
import { getOpportunities } from '../../services/opportunityService.js';
import {
  buildOpportunityContext,
  getTopicRecommendations,
  readCoreTopics,
  writeCoreTopics,
} from '../../services/opportunityTopicService.js';

export const opportunitiesRouter: Router = Router({ mergeParams: true });

opportunitiesRouter.use(requireAuth);

const querySchema = z.object({
  competitors: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .pipe(
      z
        .array(z.string().max(COMPETITOR_RESEARCH_DOMAIN_MAX_CHARS))
        .min(1)
        .max(COMPETITOR_RESEARCH_MAX_COMPETITORS),
    ),
  domain: z.string().trim().max(COMPETITOR_RESEARCH_DOMAIN_MAX_CHARS).optional(),
  limit: z.coerce.number().int().min(1).max(OPPORTUNITIES_MAX_LIMIT).optional(),
  minVolume: z.coerce.number().nonnegative().optional(),
  maxDifficulty: z.coerce.number().min(0).max(100).optional(),
  intent: z.enum(OPPORTUNITY_INTENTS).optional(),
  sort: z.enum(OPPORTUNITY_SORTS).optional(),
  dir: z.enum(OPPORTUNITY_SORT_DIRS).optional(),
});

/** The topic read shares the competitor-set query, minus the result filters. */
const topicQuerySchema = z.object({
  competitors: querySchema.shape.competitors,
  domain: querySchema.shape.domain,
});

const coreTopicSchema = z.object({
  name: z.string().trim().min(1).max(CORE_TOPIC_NAME_MAX_CHARS),
  description: z.string().trim().max(CORE_TOPIC_DESCRIPTION_MAX_CHARS).default(''),
  keywords: z
    .array(z.string().trim().min(1).max(CORE_TOPIC_KEYWORD_MAX_CHARS))
    .max(CORE_TOPIC_KEYWORDS_MAX)
    .optional(),
});

const coreTopicsSchema = z.object({ topics: z.array(coreTopicSchema).max(CORE_TOPICS_MAX) });

const topicArticleSchema = z.object({
  topic_name: z.string().trim().min(1).max(500),
  topic_description: z.string().trim().max(1000).default(''),
  primary_keyword: z.string().trim().max(200).nullable().optional(),
  keywords: z
    .array(z.object({ keyword: z.string().trim().min(1).max(200), volume: z.number().nullable().optional() }))
    .max(TOPIC_ARTICLE_MAX_KEYWORDS)
    .optional(),
  competitors: z
    .array(z.object({ domain: z.string().trim().min(1).max(253), rank: z.number().int().min(1).nullable().optional() }))
    .max(TOPIC_ARTICLE_MAX_COMPETITORS)
    .optional(),
  opportunity_score: z.number().min(0).max(100).nullable().optional(),
  reasons: z.enum(OPPORTUNITY_REASONS).array().max(OPPORTUNITY_REASONS.length).optional(),
  difficulty: z.number().min(0).max(100).nullable().optional(),
  intent: z.enum(OPPORTUNITY_INTENTS).nullable().optional(),
});

/** Read the deterministic opportunity analysis over the active competitor set. */
opportunitiesRouter.get(
  '/opportunities',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const { competitors, domain, ...query } = querySchema.parse(req.query);
    const result = await getOpportunities(container, projectId, competitors, query, domain);
    res.json({ data: result });
  }),
);

/** Read topic recommendations over the exact same competitor set. */
opportunitiesRouter.get(
  '/opportunities/topics',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    const { competitors, domain } = topicQuerySchema.parse(req.query);
    const result = await getTopicRecommendations(container, projectId, competitors, domain);
    res.json({ data: result });
  }),
);

/** Turn one recommendation into a draft through the shared Writer Engine. */
opportunitiesRouter.post(
  '/opportunities/topics/article',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const body = topicArticleSchema.parse(req.body);
    const relatedKeywords = (body.keywords ?? []).map((row) => ({
      keyword: row.keyword,
      volume: row.volume ?? null,
    }));
    const competitors = (body.competitors ?? []).map((row) => ({
      domain: row.domain,
      rank: row.rank ?? null,
    }));
    const opportunityContext = {
      topic_name: body.topic_name,
      topic_description: body.topic_description,
      primary_keyword: body.primary_keyword,
      keywords: relatedKeywords,
      competitors,
      opportunity_score: body.opportunity_score,
      reasons: body.reasons ?? [],
      difficulty: body.difficulty ?? null,
      intent: body.intent ?? null,
    };
    const opportunityContextText = buildOpportunityContext(opportunityContext);
    const params = {
      topic: body.topic_name,
      target_keyword: body.primary_keyword ?? undefined,
      include_knowledge: true,
      opportunity_context: opportunityContextText,
      writer_input: {
        projectId,
        contentId: null,
        topic: { name: body.topic_name, description: body.topic_description },
        primaryKeyword: body.primary_keyword ?? null,
        relatedKeywords,
        opportunityContext: {
          topic: body.topic_name,
          description: body.topic_description,
          primaryKeyword: body.primary_keyword ?? null,
          keywords: relatedKeywords,
          competitors,
          opportunityScore: body.opportunity_score ?? null,
          reasons: body.reasons ?? [],
          difficulty: body.difficulty ?? null,
          intent: body.intent ?? null,
          knowledgeReadiness: null,
        },
        opportunityContextText,
        format: 'short_article',
        mode: 'quick_draft',
      },
    };
    const job = await container.jobStore.enqueue({
      project_id: projectId,
      provider: 'content',
      job_type: 'content_write',
      params,
      created_by: user!.sub,
    });
    res.status(202).json({ data: { job } });
  }),
);

/** Read the project's stored core topics (empty list when none are set). */
opportunitiesRouter.get(
  '/core-topics',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'viewer');
    res.json({ data: { topics: await readCoreTopics(container, projectId) } });
  }),
);

/** Replace the project's core topics (stored in project settings, no migration). */
opportunitiesRouter.put(
  '/core-topics',
  asyncHandler(async (req, res) => {
    const projectId = parseProjectId(req);
    const { container, user } = req;
    await container.access.requireRole(user!.sub, projectId, 'editor');
    const { topics } = coreTopicsSchema.parse(req.body);
    res.json({ data: { topics: await writeCoreTopics(container, projectId, topics) } });
  }),
);
