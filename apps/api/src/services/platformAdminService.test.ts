/**
 * Platform admin read service tests (P3).
 *
 * The service maps service-role RPCs into DTOs and, critically, must not let a
 * database authorization refusal or a storage fault look like success or like
 * the wrong kind of failure: SQLSTATE 42501 becomes 403 (authorization), any
 * other RPC error becomes 500 storage_error, and a healthy response is mapped
 * field-for-field (snake_case -> DTO, event_count -> eventCount).
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccountEntitlementDto } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import { SupabasePlatformAdminService } from './platformAdminService.js';
import type { EntitlementService } from './entitlementService.js';

const EMPTY_ENTITLEMENT: AccountEntitlementDto = {
  plan: {
    key: 'base',
    name: 'Base',
    displayName: 'Free',
    description: null,
    isDefault: true,
    isPublic: true,
    sortOrder: 0,
    pricing: { currency: null, monthlyPrice: 0, yearlyPrice: 0, priceStatus: 'final', priceLabel: 'Free' },
    billingIntervals: ['monthly', 'yearly'],
  },
  features: [],
  allowances: [],
  period: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
};

function serviceWith(
  rpc: ReturnType<typeof vi.fn>,
  entitlement: AccountEntitlementDto = EMPTY_ENTITLEMENT,
  calls?: string[],
) {
  const entitlements = {
    accountEntitlement: async (actor: string, accountId: string) => {
      calls?.push(`entitlement:${actor}:${accountId}`);
      return entitlement;
    },
  } as unknown as EntitlementService;
  return new SupabasePlatformAdminService({ rpc } as unknown as SupabaseClient, entitlements);
}

describe('SupabasePlatformAdminService', () => {
  it('maps a database authorization refusal (42501) to 403', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'not allowed' } });
    const svc = serviceWith(rpc);
    await expect(svc.listUsers('u-1')).rejects.toMatchObject({ status: 403 });
  });

  it('maps any other RPC error to a 500 storage error, never forbidden', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '57014', message: 'timeout' } });
    const svc = serviceWith(rpc);
    const err = await svc.overview('u-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).code).toBe('storage_error');
  });

  it('maps the overview row and recent jobs into the DTO', async () => {
    const rpc = vi.fn(async (fn: string) => {
      if (fn === 'seo_platform_admin_overview') {
        return {
          data: {
            users: '4',
            accounts: 3,
            projects: 2,
            jobs: 9,
            active_jobs: 1,
            failed_jobs: 2,
            usage_events_this_period: 12,
            usage_period_start: '2026-09-01T00:00:00Z',
          },
          error: null,
        };
      }
      return {
        data: [
          {
            job_id: 'j-1',
            project_id: 'p-1',
            project_name: 'Site',
            provider: 'dataforseo',
            job_type: 'sync',
            status: 'failed',
            queued_at: '2026-09-02T00:00:00Z',
            started_at: null,
            completed_at: null,
            message: 'boom',
            params: { secret: 'must-not-leak' },
          },
        ],
        error: null,
      };
    });
    const svc = serviceWith(rpc);
    const out = await svc.overview('u-1');
    expect(out).toMatchObject({ users: 4, accounts: 3, projects: 2, jobs: 9, usage_events_this_period: 12 });
    expect(out.recent_jobs).toHaveLength(1);
    expect(out.recent_jobs[0]).toMatchObject({ job_id: 'j-1', status: 'failed', message: 'boom' });
    expect(JSON.stringify(out.recent_jobs[0])).not.toContain('must-not-leak');
  });

  it('maps usage rows and echoes the requested scope', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ category: 'ai', provider: 'openai', operation: 'chat', unit: 'input_token', quantity: '15', event_count: '2' }],
      error: null,
    });
    const svc = serviceWith(rpc);
    const out = await svc.usage('u-1', { accountId: 'acc-1', category: 'ai' });
    expect(out).toEqual({
      scope: { accountId: 'acc-1', projectId: null },
      totals: [{ category: 'ai', provider: 'openai', operation: 'chat', unit: 'input_token', quantity: 15, eventCount: 2 }],
    });
  });

  it('re-verifies the platform admin then returns the effective entitlement policy', async () => {
    const calls: string[] = [];
    const rpc = vi.fn(async (fn: string) => {
      calls.push(fn);
      return { data: null, error: null };
    });
    const svc = serviceWith(rpc, EMPTY_ENTITLEMENT, calls);
    const out = await svc.accountEntitlement('admin-1', 'acc-1');
    expect(out).toEqual(EMPTY_ENTITLEMENT);
    expect(calls).toEqual(['seo_assert_platform_admin', 'entitlement:admin-1:acc-1']);
  });

  it('refuses to read an entitlement policy when the actor is not a platform admin', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'not allowed' } });
    const svc = serviceWith(rpc);
    await expect(svc.accountEntitlement('u-1', 'acc-1')).rejects.toMatchObject({ status: 403 });
  });
});
