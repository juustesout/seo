/**
 * Resource admission service (P9): classification, denial recognition, stable
 * error mapping and best-effort denial evidence.
 */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from '../apiErrors.js';
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

function fakeSb(opts: { accountId?: string | null; insertError?: unknown; inserted?: InsertedRow[] } = {}): SupabaseClient {
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
