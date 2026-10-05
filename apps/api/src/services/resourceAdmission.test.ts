/**
 * Resource admission service (P9): classification, denial recognition, stable
 * error mapping and best-effort denial evidence.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from '../apiErrors.js';
import type { EntitlementAdmissionRequest } from './entitlementService.js';
import { ResourceAdmissionService, resourceForJobType } from './resourceAdmission.js';

interface InsertedRow {
  account_id?: string | null;
  project_id?: string;
  user_id?: string | null;
  resource?: string;
  code?: string;
  scope?: string;
  job_type?: string | null;
}

function fakeSb(
  opts: {
    accountId?: string | null;
    insertError?: unknown;
    inserted?: InsertedRow[];
    rpc?: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  } = {},
): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'seo_projects') {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: { account_id: opts.accountId ?? null }, error: null }),
        };
        return builder;
      }
      if (table === 'seo_resource_denials') {
        return {
          insert: async (row: InsertedRow) => {
            opts.inserted?.push(row);
            return { error: opts.insertError ?? null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: (fn: string, args: Record<string, unknown>) =>
      opts.rpc ? opts.rpc(fn, args) : Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

describe('resourceForJobType', () => {
  it('maps known job types onto the closed resource vocabulary', () => {
    expect(resourceForJobType('content_write')).toBe('ai_generation');
    expect(resourceForJobType('content_images')).toBe('ai_image');
    expect(resourceForJobType('gsc_sync')).toBe('google_search_console');
    expect(resourceForJobType('publish')).toBe('publishing');
    expect(resourceForJobType('dataforseo_keyword_research')).toBe('dataforseo_keywords');
  });

  it('falls back to background_job for unknown types so nothing is silently exempt', () => {
    expect(resourceForJobType('a_job_type_from_the_future')).toBe('background_job');
  });
});

describe('ResourceAdmissionService.admissionErrorFrom', () => {
  const admission = new ResourceAdmissionService(fakeSb());

  it('recognises the SE001 queue-limit SQLSTATE and parses scope from detail', () => {
    const failure = admission.admissionErrorFrom({
      code: 'SE001',
      message: 'seo_queue_limit',
      detail: JSON.stringify({ scope: 'account', resource: 'background_job' }),
    });
    expect(failure).toEqual({ code: 'queue_limit', scope: 'account' });
  });

  it('recognises concurrency and rate SQLSTATEs', () => {
    expect(admission.admissionErrorFrom({ code: 'SE002' })?.code).toBe('resource_concurrency');
    expect(admission.admissionErrorFrom({ code: 'SE003' })?.code).toBe('resource_limit');
  });

  it('falls back to the raised message when the SQLSTATE is not surfaced (PostgREST)', () => {
    const failure = admission.admissionErrorFrom(new Error('seo_resource_rate'));
    expect(failure).toEqual({ code: 'resource_limit', scope: 'project' });
  });

  it('parses scope from PostgREST details objects', () => {
    const failure = admission.admissionErrorFrom({ message: 'seo_queue_limit', details: { scope: 'account' } });
    expect(failure?.scope).toBe('account');
  });

  it('returns null for unrelated errors so callers rethrow them unchanged', () => {
    expect(admission.admissionErrorFrom(new Error('boom'))).toBeNull();
    expect(admission.admissionErrorFrom({ code: '23505' })).toBeNull();
  });
});

describe('ResourceAdmissionService.toApiError', () => {
  const admission = new ResourceAdmissionService(fakeSb());

  it('produces a 429 with the stable code and secret-free details', () => {
    const error = admission.toApiError({ code: 'queue_limit', scope: 'project' }, 'content_write');
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(429);
    expect(error.code).toBe('queue_limit');
    expect(error.details).toEqual({ resource: 'ai_generation', scope: 'project' });
    expect(error.message).toContain('queued');
  });
});

describe('ResourceAdmissionService.recordDenial', () => {
  it('resolves the account from the project and writes secret-free evidence', async () => {
    const inserted: InsertedRow[] = [];
    const admission = new ResourceAdmissionService(fakeSb({ accountId: 'acct-1', inserted }));
    await admission.recordDenial({
      projectId: 'proj-1',
      userId: 'user-1',
      resource: 'ai_generation',
      code: 'queue_limit',
      scope: 'project',
      jobType: 'content_write',
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      account_id: 'acct-1',
      project_id: 'proj-1',
      user_id: 'user-1',
      resource: 'ai_generation',
      code: 'queue_limit',
      scope: 'project',
      job_type: 'content_write',
    });
  });

  it('never throws when the evidence insert fails', async () => {
    const admission = new ResourceAdmissionService(fakeSb({ insertError: { message: 'down' } }));
    await expect(
      admission.recordDenial({
        projectId: 'proj-1',
        userId: null,
        resource: 'background_job',
        code: 'resource_limit',
        scope: 'account',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('ResourceAdmissionService sync admission', () => {
  it('passes the resource, amount and ttl to seo_admit_resource and returns the id', async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const admission = new ResourceAdmissionService(
      fakeSb({
        rpc: async (fn, args) => {
          calls.push({ fn, args });
          return { data: 'res-1', error: null };
        },
      }),
    );
    const id = await admission.admit({
      projectId: 'proj-1',
      userId: 'user-1',
      resource: 'ai_generation',
      amount: 2,
      ttlSeconds: 120,
    });
    expect(id).toBe('res-1');
    expect(calls[0]?.fn).toBe('seo_admit_resource');
    expect(calls[0]?.args).toEqual({
      p_project_id: 'proj-1',
      p_resource: 'ai_generation',
      p_amount: 2,
      p_ttl_seconds: 120,
    });
  });

  it('maps a denial onto a structured 429 and records evidence before throwing', async () => {
    const inserted: InsertedRow[] = [];
    const admission = new ResourceAdmissionService(
      fakeSb({
        accountId: 'acct-1',
        inserted,
        rpc: async () => ({
          data: null,
          error: { code: 'SE002', message: 'seo_resource_concurrency', detail: JSON.stringify({ scope: 'project' }) },
        }),
      }),
    );
    await expect(
      admission.admit({ projectId: 'proj-1', userId: 'user-1', resource: 'ai_image' }),
    ).rejects.toMatchObject({ status: 429, code: 'resource_concurrency' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ resource: 'ai_image', code: 'resource_concurrency', scope: 'project' });
  });

  it('treats an unrecognised database error as an internal error, not a denial', async () => {
    const admission = new ResourceAdmissionService(
      fakeSb({ rpc: async () => ({ data: null, error: { code: '42P01', message: 'relation missing' } }) }),
    );
    await expect(
      admission.admit({ projectId: 'proj-1', userId: null, resource: 'ai_generation' }),
    ).rejects.toMatchObject({ status: 500, code: 'resource_admission_failed' });
  });

  it('releases the reservation whether the wrapped operation succeeds or fails', async () => {
    const released: Array<Record<string, unknown>> = [];
    const admission = new ResourceAdmissionService(
      fakeSb({
        rpc: async (fn, args) => {
          if (fn === 'seo_release_resource') released.push(args);
          return fn === 'seo_admit_resource' ? { data: 'res-1', error: null } : { data: null, error: null };
        },
      }),
    );
    await expect(
      admission.withAdmission({ projectId: 'proj-1', userId: null, resource: 'ai_generation' }, async () => 'ok'),
    ).resolves.toBe('ok');
    await expect(
      admission.withAdmission({ projectId: 'proj-1', userId: null, resource: 'ai_generation' }, async () => {
        throw new Error('provider boom');
      }),
    ).rejects.toThrow('provider boom');
    expect(released).toEqual([{ p_reservation_id: 'res-1' }, { p_reservation_id: 'res-1' }]);
  });

  it('never throws from release when the release RPC fails', async () => {
    const admission = new ResourceAdmissionService(
      fakeSb({ rpc: async () => ({ data: null, error: { message: 'down' } }) }),
    );
    await expect(admission.release('res-1')).resolves.toBeUndefined();
    await expect(admission.release(null)).resolves.toBeUndefined();
  });
});

describe('ResourceAdmissionService P13 entitlement seam', () => {
  /** A structural double of the entitlement admitter (no cast needed). */
  function fakeEntitlements(
    overrides: {
      admit?: (request: EntitlementAdmissionRequest) => Promise<string | null>;
      release?: (reservationId: string | null | undefined) => Promise<void>;
    } = {},
  ) {
    return {
      admit: vi.fn(overrides.admit ?? (async () => 'ent-1' as string | null)),
      release: vi.fn(overrides.release ?? (async () => {})),
    };
  }

  function admittingSb() {
    return fakeSb({
      rpc: async (fn) => (fn === 'seo_admit_resource' ? { data: 'res-1', error: null } : { data: null, error: null }),
    });
  }

  it('admits the mapped entitlement resource after the technical reservation and releases both', async () => {
    const entitlements = fakeEntitlements();
    const admission = new ResourceAdmissionService(admittingSb(), entitlements);
    await expect(
      admission.withAdmission({ projectId: 'proj-1', userId: 'user-1', resource: 'ai_generation' }, async () => 'ok'),
    ).resolves.toBe('ok');
    expect(entitlements.admit).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'proj-1', userId: 'user-1', resource: 'ai_generation' }),
    );
    expect(entitlements.release).toHaveBeenCalledWith('ent-1');
  });

  it('does not consult entitlement for a resource with no product mapping', async () => {
    const entitlements = fakeEntitlements();
    const admission = new ResourceAdmissionService(admittingSb(), entitlements);
    await admission.withAdmission({ projectId: 'proj-1', userId: null, resource: 'publishing' }, async () => 'ok');
    expect(entitlements.admit).not.toHaveBeenCalled();
  });

  it('releases the technical reservation when the entitlement admission denies', async () => {
    const released: Array<Record<string, unknown>> = [];
    const entitlements = fakeEntitlements({
      admit: async () => {
        throw new ApiError(403, 'entitlement_limit', 'xai');
      },
    });
    const admission = new ResourceAdmissionService(
      fakeSb({
        rpc: async (fn, args) => {
          if (fn === 'seo_release_resource') released.push(args);
          return fn === 'seo_admit_resource' ? { data: 'res-1', error: null } : { data: null, error: null };
        },
      }),
      entitlements,
    );
    await expect(
      admission.withAdmission({ projectId: 'proj-1', userId: null, resource: 'ai_generation' }, async () => 'never'),
    ).rejects.toMatchObject({ status: 403, code: 'entitlement_limit' });
    expect(released).toEqual([{ p_reservation_id: 'res-1' }]);
  });
});
