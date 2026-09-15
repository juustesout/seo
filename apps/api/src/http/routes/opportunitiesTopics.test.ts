/**
 * Topic route tests (KW6 HTTP boundary).
 *
 * Mounts the real opportunitiesRouter over a fake container so the wire
 * contract is tested end-to-end: viewer reads, editor-only core-topic writes,
 * article hand-off into the shared writer engine job, project isolation
 * and bounded/validated query. The read must never start a provider job, and no
 * DataForSEO registry is present, so any accidental provider call would throw.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { ApiError, errorHandler } from '../../apiErrors.js';
import { competitorGapScope, scopeKeyOf } from '../../services/sourceScope.js';
import { opportunitiesRouter } from './opportunities.js';

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const PROJECT = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT = '99999999-9999-4999-8999-999999999999';

const TOKEN_TO_USER: Record<string, { sub: string } | undefined> = {
  'viewer-token': { sub: 'viewer-user' },
  'editor-token': { sub: 'editor-user' },
};
const ROLE_BY_USER: Record<string, string | undefined> = { 'viewer-user': 'viewer', 'editor-user': 'editor' };
const ROLE_ORDER: Record<string, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

let tables: Tables = {};
let enqueued: Array<Record<string, unknown>> = [];

function fakeSb() {
  function builderFor(table: string) {
    const rows = tables[table] ?? [];
    const filters: Array<(r: Row) => boolean> = [];
    let pending: Row | null = null;
    const builder = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        if (pending) {
          for (const r of rows) if (filters.every((f) => f(r))) Object.assign(r, pending);
          pending = null;
        }
        return builder;
      },
      update: (patch: Row) => {
        pending = patch;
        return builder;
      },
      maybeSingle: async () => ({ data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }),
    };
    return builder;
  }
  return { from: (table: string) => builderFor(table) };
}

function snapshotRow(projectId: string, competitors: string[] = ['rival.com']) {
  const scope = competitorGapScope({ domain: 'example.com', competitors });
  return {
    id: 'snap-1',
    project_id: projectId,
    type: 'competitor_gap',
    provider: 'dataforseo',
    scope,
    scope_key: scopeKeyOf(scope),
    data: {
      gaps: [{ keyword: 'blue widgets', searchVolume: 2400, difficulty: 53, cpc: 3.2, competitorDomain: 'rival.com', position: 3 }],
      total: 1,
    },
    fetched_at: new Date().toISOString(),
    source_job_id: null,
  };
}

function settingsRow(projectId: string, coreTopics: unknown[]): Row {
  return { id: projectId, settings: { coreTopics } };
}

let server: Server;
let base = '';

async function request(path: string, opts: { token?: string; method?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return {
    status: res.status,
    json: (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string } },
  };
}

beforeEach(() => {
  enqueued = [];
  tables = {
    seo_source_snapshots: [snapshotRow(PROJECT)],
    seo_projects: [settingsRow(PROJECT, [{ name: 'blue widgets', description: 'widgets for buyers' }])],
  };
});

describe('opportunity topic routes', () => {
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      (req as unknown as { container: unknown }).container = {
        access: {
          requireRole: async (userId: string, _projectId: string, minRole: string) => {
            const role = ROLE_BY_USER[userId];
            if (!role) throw ApiError.forbidden('You do not have access to this project');
            if ((ROLE_ORDER[role] ?? -1) < ROLE_ORDER[minRole]) {
              throw ApiError.forbidden(`This action requires the ${minRole} role`);
            }
          },
        },
        sb: fakeSb(),
        config: { env: {} },
        registry: { getKnowledge: () => null },
        jobStore: {
          enqueue: async (input: Record<string, unknown>) => {
            enqueued.push(input);
            return { id: 'job-1', status: 'queued', ...input };
          },
        },
      };
      (req as unknown as { user?: { sub: string } }).user = TOKEN_TO_USER[token];
      next();
    });
    app.use(`/api/projects/:projectId/keyword`, opportunitiesRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${PROJECT}/keyword`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  const set = 'competitors=rival.com&domain=example.com';

  it('rejects an anonymous topic read', async () => {
    const res = await request(`/opportunities/topics?${set}`);
    expect(res.status).toBe(401);
  });

  it('requires a competitor set', async () => {
    const res = await request('/opportunities/topics', { token: 'viewer-token' });
    expect(res.status).toBe(400);
  });

  it('lets a viewer read bounded topic recommendations without starting any job', async () => {
    const res = await request(`/opportunities/topics?${set}`, { token: 'viewer-token' });
    expect(res.status).toBe(200);
    const data = res.json.data as {
      recommendations: Array<{ topic: { name: string }; relevance: { state: string } }>;
      topicsConfigured: boolean;
      consideredCount: number;
    };
    expect(data.topicsConfigured).toBe(true);
    expect(data.consideredCount).toBe(1);
    expect(data.recommendations[0]!.topic.name).toBe('blue widgets');
    expect(data.recommendations[0]!.relevance.state).toBe('strong');
    expect(enqueued).toHaveLength(0);
  });

  it('does not return another project snapshot for the same set', async () => {
    tables.seo_source_snapshots = [snapshotRow(OTHER_PROJECT)];
    const res = await request(`/opportunities/topics?${set}`, { token: 'viewer-token' });
    expect(res.status).toBe(200);
    expect((res.json.data as { snapshot: unknown }).snapshot).toBeNull();
  });

  it('exposes an honest empty state when no core topics exist', async () => {
    tables.seo_projects = [settingsRow(PROJECT, [])];
    const res = await request(`/opportunities/topics?${set}`, { token: 'viewer-token' });
    expect(res.status).toBe(200);
    expect((res.json.data as { recommendations: unknown[] }).recommendations).toEqual([]);
    expect((res.json.data as { topicsConfigured: boolean }).topicsConfigured).toBe(false);
  });

  it('reads the stored core topics', async () => {
    const res = await request('/core-topics', { token: 'viewer-token' });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ topics: [{ name: 'blue widgets', description: 'widgets for buyers' }] });
  });

  it('blocks a viewer from writing core topics', async () => {
    const res = await request('/core-topics', {
      token: 'viewer-token',
      method: 'PUT',
      body: { topics: [{ name: 'x', description: '' }] },
    });
    expect(res.status).toBe(403);
  });

  it('lets an editor replace core topics, preserving other settings', async () => {
    (tables.seo_projects[0]!.settings as Row).ai = { provider: 'x' };
    const res = await request('/core-topics', {
      token: 'editor-token',
      method: 'PUT',
      body: { topics: [{ name: '  New topic ', description: 'desc' }] },
    });
    expect(res.status).toBe(200);
    expect(res.json.data).toEqual({ topics: [{ name: 'New topic', description: 'desc' }] });
    const stored = tables.seo_projects[0]!.settings as Row;
    expect(stored.ai).toEqual({ provider: 'x' });
    expect(stored.coreTopics).toEqual([{ name: 'New topic', description: 'desc' }]);
  });

  it('blocks a viewer from creating a draft', async () => {
    const res = await request('/opportunities/topics/article', {
      token: 'viewer-token',
      method: 'POST',
      body: { topic_name: 'blue widgets', topic_description: '' },
    });
    expect(res.status).toBe(403);
    expect(enqueued).toHaveLength(0);
  });

  it('enqueues the shared writer engine job with structured opportunity context', async () => {
    const res = await request('/opportunities/topics/article', {
      token: 'editor-token',
      method: 'POST',
      body: {
        topic_name: 'blue widgets',
        topic_description: 'widgets for buyers',
        primary_keyword: 'blue widgets',
        keywords: [{ keyword: 'blue widgets', volume: 2400 }],
        competitors: [{ domain: 'rival.com', rank: 3 }],
        opportunity_score: 78,
        reasons: ['high_volume', 'low_difficulty'],
        difficulty: 53,
        intent: 'commercial',
      },
    });
    expect(res.status).toBe(202);
    expect(enqueued).toHaveLength(1);
    const job = enqueued[0]!;
    expect(job.provider).toBe('content');
    expect(job.job_type).toBe('content_write');
    expect(job.project_id).toBe(PROJECT);
    expect(job.created_by).toBe('editor-user');
    const params = job.params as Record<string, unknown>;
    expect(params.topic).toBe('blue widgets');
    expect(params.target_keyword).toBe('blue widgets');
    expect(params.include_knowledge).toBe(true);
    const context = params.opportunity_context as string;
    expect(context).toContain('Topic: blue widgets');
    expect(context).toContain('Competitor evidence: rival.com #3');
    expect(context).toContain('Opportunity score: 78/100');
    expect(context).toContain('Keyword difficulty: 53/100');
    expect(context).toContain('Search intent: commercial');
    expect(context).toContain('Why this opportunity: high volume, low difficulty');
    const writerInput = params.writer_input as Record<string, unknown>;
    expect(writerInput.projectId).toBe(PROJECT);
    expect(writerInput.format).toBe('short_article');
    expect(writerInput.mode).toBe('quick_draft');
    expect(writerInput.primaryKeyword).toBe('blue widgets');
    expect(writerInput.opportunityContextText).toBe(context);
    const opportunity = writerInput.opportunityContext as Record<string, unknown>;
    expect(opportunity.topic).toBe('blue widgets');
    expect(opportunity.opportunityScore).toBe(78);
    expect(opportunity.reasons).toEqual(['high_volume', 'low_difficulty']);
    expect(opportunity.difficulty).toBe(53);
    expect(opportunity.intent).toBe('commercial');
    expect((opportunity.competitors as unknown[])[0]).toEqual({ domain: 'rival.com', rank: 3 });
  });

  it('rejects an unknown opportunity reason tag at the edge', async () => {
    const res = await request('/opportunities/topics/article', {
      token: 'editor-token',
      method: 'POST',
      body: {
        topic_name: 'blue widgets',
        reasons: ['definitely_not_a_reason'],
      },
    });
    expect(res.status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  it('rejects an invalid article body at the edge', async () => {
    const res = await request('/opportunities/topics/article', {
      token: 'editor-token',
      method: 'POST',
      body: { topic_description: 'missing name' },
    });
    expect(res.status).toBe(400);
    expect(enqueued).toHaveLength(0);
  });

  it('rejects an over-cap competitor set at the edge', async () => {
    const res = await request('/opportunities/topics?competitors=a.com,b.com,c.com,d.com', { token: 'viewer-token' });
    expect(res.status).toBe(400);
  });
});
