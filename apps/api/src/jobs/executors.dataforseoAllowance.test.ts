/**
 * DataForSEO operator-funded allowance enforcement (P14).
 *
 * The worker path is the single place DataForSEO provider calls happen, so every
 * entry point (UI, API v1, MCP, scheduled jobs) funnels through these executors.
 * These tests pin that each logical operation is admitted against the
 * `dataforseo_research` product allowance *before* the provider is touched, that
 * the reservation amount is the billable provider-request count (never the raw
 * keyword/task sub-units), and that a denial stops the provider call.
 */
import { describe, expect, it, vi } from 'vitest';
import { DATAFORSEO_CRED_KEYS } from '../providers/dataforseo/dataSource.js';
import { getExecutor } from './executors.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';

interface Admission {
  projectId: string;
  userId: string | null;
  resource: string;
  fundingSource?: string | null;
  amount?: number;
}

function buildContainer(args: {
  adapter: { researchKeywords: ReturnType<typeof vi.fn> };
  env?: Record<string, string>;
  stored?: Record<string, string>;
  admissions: Admission[];
  deny?: boolean;
}) {
  return {
    sb: {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: 'ds-1', integration_id: 'int-1', config: {} },
                error: null,
              }),
            }),
          }),
        }),
      }),
    },
    registry: { getDataSource: () => args.adapter },
    config: { env: args.env ?? {} },
    credentials: {
      reader: () => ({ get: async (key: string) => args.stored?.[key] ?? null }),
    },
    entitlements: {
      withAdmission: async <T>(request: Admission, fn: () => Promise<T>) => {
        args.admissions.push(request);
        if (args.deny) throw new Error('seo_entitlement_limit');
        return fn();
      },
    },
  } as never;
}

describe('dataforseo executor product allowance (P14)', () => {
  it('admits an operator-funded research call and holds one provider request', async () => {
    const researchKeywords = vi.fn(async () => [
      {
        keyword: 'seo',
        location_code: 2840,
        language_code: 'en',
        search_volume: 100,
        cpc: 1,
        competition: 'LOW',
        difficulty: 10,
        serp: [],
        keyword_intents: [],
      },
    ]);
    const admissions: Admission[] = [];
    const container = buildContainer({
      adapter: { researchKeywords },
      env: { DATAFORSEO_BASE64: 'server-token' },
      admissions,
    });
    const executor = getExecutor('dataforseo_keyword_research')!;

    await executor({
      container,
      job: { project_id: PROJECT, data_source_id: 'ds-1', created_by: 'u1', params: { seeds: ['seo'] } } as never,
      writer: { persistKeywordResearch: vi.fn() } as never,
      report: vi.fn(),
    });

    expect(admissions).toEqual([
      { projectId: PROJECT, userId: 'u1', resource: 'dataforseo_research', fundingSource: 'operator_funded', amount: 1 },
    ]);
    expect(researchKeywords).toHaveBeenCalledTimes(1);
  });

  it('attributes a stored-credential (BYOK) call without consuming the operator allowance', async () => {
    const researchKeywords = vi.fn(async () => []);
    const admissions: Admission[] = [];
    const container = buildContainer({
      adapter: { researchKeywords },
      stored: { [DATAFORSEO_CRED_KEYS.base64]: 'user-token' },
      admissions,
    });
    const executor = getExecutor('dataforseo_keyword_research')!;

    await executor({
      container,
      job: { project_id: PROJECT, data_source_id: 'ds-1', created_by: 'u1', params: { seeds: ['seo'] } } as never,
      writer: { persistKeywordResearch: vi.fn() } as never,
      report: vi.fn(),
    });

    expect(admissions[0]?.fundingSource).toBe('byok');
    expect(researchKeywords).toHaveBeenCalledTimes(1);
  });

  it('denies before the provider call when the allowance is exhausted', async () => {
    const researchKeywords = vi.fn(async () => []);
    const admissions: Admission[] = [];
    const container = buildContainer({
      adapter: { researchKeywords },
      env: { DATAFORSEO_BASE64: 'server-token' },
      admissions,
      deny: true,
    });
    const executor = getExecutor('dataforseo_keyword_research')!;

    await expect(
      executor({
        container,
        job: { project_id: PROJECT, data_source_id: 'ds-1', created_by: 'u1', params: { seeds: ['seo'] } } as never,
        writer: { persistKeywordResearch: vi.fn() } as never,
        report: vi.fn(),
      }),
    ).rejects.toThrow('seo_entitlement_limit');

    expect(admissions).toHaveLength(1);
    expect(researchKeywords).not.toHaveBeenCalled();
  });

  it('holds one provider request per competitor for a gap run', async () => {
    const findCompetitorKeywordGaps = vi.fn(async () => []);
    const admissions: Admission[] = [];
    const container = buildContainer({
      adapter: { researchKeywords: vi.fn() } as never,
      env: { DATAFORSEO_BASE64: 'server-token' },
      admissions,
    });
    (container as unknown as { registry: { getDataSource: () => unknown } }).registry.getDataSource = () => ({
      findCompetitorKeywordGaps,
    });
    const executor = getExecutor('competitor_research')!;

    await executor({
      container,
      job: {
        project_id: PROJECT,
        data_source_id: 'ds-1',
        created_by: 'u1',
        params: { mode: 'gap', domain: 'example.com', competitors: ['a.com', 'b.com', 'c.com'] },
      } as never,
      writer: { persistCompetitorGapKeywords: vi.fn(), persistSourceSnapshot: vi.fn() } as never,
      report: vi.fn(),
    });

    expect(admissions).toEqual([
      {
        projectId: PROJECT,
        userId: 'u1',
        resource: 'dataforseo_research',
        fundingSource: 'operator_funded',
        amount: 3,
      },
    ]);
    expect(findCompetitorKeywordGaps).toHaveBeenCalledTimes(1);
  });
});
