/**
 * Entitlement service (P13): the product-policy admission and read model.
 *
 * Uses a small chainable Supabase double because the service reads several
 * policy tables and one ledger aggregate. The behaviour under test is the
 * decision logic: when no plan applies, when BYOK is exempt, when a finite
 * allowance is enforced, denial mapping, and the resolved read model.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EntitlementAdmissionRequest, FundingResolver } from './entitlementService.js';
import { EntitlementService, entitlementResourceFor, isEntitlementDenial } from './entitlementService.js';

const ACC = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const PLAN = '44444444-4444-4444-8444-444444444444';

type QueryKind = 'maybeSingle' | 'list' | 'order';
type Handler = (kind: QueryKind, filters: Record<string, unknown>) => { data: unknown; error: unknown };

function query(handler: Handler) {
  const filters: Record<string, unknown> = {};
  const builder = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      filters[col] = val;
      return builder;
    },
    is: (col: string, val: unknown) => {
      filters[col] = val;
      return builder;
    },
    gt: (col: string, val: unknown) => {
      filters[col] = val;
      return builder;
    },
    order: () => Promise.resolve(handler('order', filters)),
    maybeSingle: () => Promise.resolve(handler('maybeSingle', filters)),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(handler('list', filters)).then(resolve, reject),
  };
  return builder;
}

function makeSb(
  tables: Record<string, Handler>,
  rpcImpl?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
): SupabaseClient {
  return {
    from: (table: string) => {
      const handler = tables[table];
      if (!handler) throw new Error(`unexpected table ${table}`);
      return query(handler);
    },
    rpc: rpcImpl ?? (async () => ({ data: null, error: null })),
  } as unknown as SupabaseClient;
}

const activePlanHandler: Handler = () => ({
  data: { seo_plans: { id: PLAN, key: 'base', name: 'Base', is_default: true, status: 'active' } },
  error: null,
});

const accountHandler: Handler = () => ({ data: { account_id: ACC }, error: null });

function policy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resource: 'x_link_post',
    unit: 'link_posts',
    period: 'month',
    scope: 'account',
    operator_funded: true,
    byok_exempt: false,
    status: 'active',
    allowance: 5,
    ...overrides,
  };
}

function service(
  tables: Record<string, Handler>,
  funding?: FundingResolver,
  rpcImpl?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
) {
  return new EntitlementService(makeSb(tables, rpcImpl), funding);
}

const request: EntitlementAdmissionRequest = {
  projectId: PROJECT,
  userId: USER,
  resource: 'x_link_post',
  fundingSource: 'operator_funded',
};

describe('entitlementResourceFor', () => {
  it('maps technical resources to their product resource', () => {
    expect(entitlementResourceFor('ai_generation')).toBe('ai_generation');
    expect(entitlementResourceFor('ai_image')).toBe('ai_image');
    expect(entitlementResourceFor('dataforseo_serp')).toBe('dataforseo_research');
    expect(entitlementResourceFor('dataforseo_keywords')).toBe('dataforseo_research');
    expect(entitlementResourceFor('media')).toBe('media');
  });

  it('returns null for resources with no product allowance', () => {
    expect(entitlementResourceFor('publishing')).toBeNull();
    expect(entitlementResourceFor('background_job')).toBeNull();
    expect(entitlementResourceFor('google_search_console')).toBeNull();
  });
});

describe('isEntitlementDenial', () => {
  it('recognises the SE004 SQLSTATE or the raised message', () => {
    expect(isEntitlementDenial({ code: 'SE004' })).toBe(true);
    expect(isEntitlementDenial(new Error('seo_entitlement_limit'))).toBe(true);
    expect(isEntitlementDenial({ code: '42P01', message: 'missing' })).toBe(false);
  });
});

describe('EntitlementService.admit', () => {
  it('does not enforce when the project has no account', async () => {
    const rpc = vi.fn(async () => ({ data: 'x', error: null }));
    const svc = service({ seo_projects: () => ({ data: null, error: null }) }, undefined, rpc);
    await expect(svc.admit(request)).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not enforce when the plan defines no active finite policy', async () => {
    for (const row of [null, policy({ status: 'disabled' }), policy({ operator_funded: false }), policy({ allowance: null })]) {
      const rpc = vi.fn(async () => ({ data: 'x', error: null }));
      const svc = service(
        {
          seo_projects: accountHandler,
          seo_account_entitlements: activePlanHandler,
          seo_resource_policies: () => ({ data: row, error: null }),
        },
        undefined,
        rpc,
      );
      await expect(svc.admit(request)).resolves.toBeNull();
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it('exempts BYOK usage on a byok-exempt resource', async () => {
    const rpc = vi.fn(async () => ({ data: 'x', error: null }));
    const svc = service(
      {
        seo_projects: accountHandler,
        seo_account_entitlements: activePlanHandler,
        seo_resource_policies: () => ({ data: policy({ byok_exempt: true, allowance: 3 }), error: null }),
      },
      undefined,
      rpc,
    );
    await expect(svc.admit({ ...request, fundingSource: 'byok' })).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('does not consume an operator allowance for unattributable funding', async () => {
    const rpc = vi.fn(async () => ({ data: 'x', error: null }));
    const svc = service(
      {
        seo_projects: accountHandler,
        seo_account_entitlements: activePlanHandler,
        seo_resource_policies: () => ({ data: policy(), error: null }),
      },
      undefined,
      rpc,
    );
    await expect(svc.admit({ ...request, fundingSource: null })).resolves.toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reserves a finite allowance through the atomic database function', async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const svc = service(
      {
        seo_projects: accountHandler,
        seo_account_entitlements: activePlanHandler,
        seo_resource_policies: () => ({ data: policy(), error: null }),
      },
      undefined,
      async (fn, args) => {
        calls.push({ fn, args });
        return { data: 'resv-1', error: null };
      },
    );
    await expect(svc.admit(request)).resolves.toBe('resv-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.fn).toBe('seo_admit_entitlement');
    expect(calls[0]?.args).toMatchObject({
      p_account_id: ACC,
      p_project_id: PROJECT,
      p_resource: 'x_link_post',
      p_category: 'publishing',
      p_units: ['publish_attempt'],
      p_x_link_only: true,
      p_amount: 1,
      p_allowance: 5,
    });
  });

  it('resolves funding itself when the caller omits it', async () => {
    const resolveFunding = vi.fn(async () => 'operator_funded' as const);
    const rpc = vi.fn(async () => ({ data: 'resv-1', error: null }));
    const svc = service(
      {
        seo_projects: accountHandler,
        seo_account_entitlements: activePlanHandler,
        seo_resource_policies: () => ({ data: policy(), error: null }),
      },
      resolveFunding,
      rpc,
    );
    await expect(svc.admit({ projectId: PROJECT, userId: USER, resource: 'x_link_post' })).resolves.toBe('resv-1');
    expect(resolveFunding).toHaveBeenCalledWith(PROJECT, 'x_link_post');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('maps a database denial onto a persistent 403 entitlement_limit', async () => {
    const svc = service(
      {
        seo_projects: accountHandler,
        seo_account_entitlements: activePlanHandler,
        seo_resource_policies: () => ({ data: policy({ allowance: 0 }), error: null }),
      },
      undefined,
      async () => ({ data: null, error: { code: 'SE004', message: 'seo_entitlement_limit' } }),
    );
    await expect(svc.admit(request)).rejects.toMatchObject({
      status: 403,
      code: 'entitlement_limit',
      details: { resource: 'x_link_post', scope: 'account' },
    });
  });

  it('treats an unrelated database error as internal, not a denial', async () => {
    const svc = service(
      {
        seo_projects: accountHandler,
        seo_account_entitlements: activePlanHandler,
        seo_resource_policies: () => ({ data: policy(), error: null }),
      },
      undefined,
      async () => ({ data: null, error: { code: '42P01', message: 'relation missing' } }),
    );
    await expect(svc.admit(request)).rejects.toMatchObject({ status: 500, code: 'entitlement_admission_failed' });
  });
});

describe('EntitlementService.accountEntitlement', () => {
  it('resolves plan, features and allowances with held reservations counted', async () => {
    const svc = service(
      {
        seo_account_entitlements: activePlanHandler,
        seo_plan_features: (kind) =>
          kind === 'list'
            ? { data: [{ feature: 'api_access', enabled: true }], error: null }
            : { data: null, error: null },
        seo_resource_policies: (kind) =>
          kind === 'order'
            ? { data: [policy({ resource: 'media', unit: 'assets', allowance: 10 })], error: null }
            : { data: null, error: null },
        seo_entitlement_reservations: (kind) =>
          kind === 'list' ? { data: [{ resource: 'media', amount: 2 }], error: null } : { data: [], error: null },
      },
      undefined,
      async (fn) => (fn === 'seo_entitlement_consumed' ? { data: 3, error: null } : { data: null, error: null }),
    );

    const model = await svc.accountEntitlement(USER, ACC);
    expect(model.plan).toEqual({ key: 'base', name: 'Base', isDefault: true });
    expect(model.features.find((f) => f.feature === 'api_access')?.enabled).toBe(true);
    expect(model.features.find((f) => f.feature === 'mcp_access')?.enabled).toBe(false);
    expect(model.allowances).toHaveLength(1);
    expect(model.allowances[0]).toMatchObject({
      resource: 'media',
      allowance: 10,
      consumed: 5,
      remaining: 5,
      byokExempt: false,
    });
    expect(model.period.start < model.period.end).toBe(true);
  });
});
