/**
 * Test doubles for the synchronous resource-admission seam (P11).
 *
 * These build a *real* `ResourceAdmissionService` over a minimal fake
 * Supabase client, so service tests exercise the production admit/release
 * code path instead of stubbing the service out. Use `admittingResourceAdmission`
 * for tests that must get past admission, and `denyingResourceAdmission` for
 * tests that assert how a service surfaces a resource denial.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ResourceErrorCode, ResourceScope } from '@seo/contracts';
import { ResourceAdmissionService } from '../services/resourceAdmission.js';

function fakeSb(rpc: (fn: string) => Promise<{ data: unknown; error: unknown }>): SupabaseClient {
  return {
    rpc: (fn: string) => rpc(fn),
    from: () => {
      throw new Error('resource-admission test double only supports rpc()');
    },
  } as unknown as SupabaseClient;
}

/** Admission that always succeeds, returning a stable reservation id. */
export function admittingResourceAdmission(): ResourceAdmissionService {
  return new ResourceAdmissionService(
    fakeSb(async (fn) =>
      fn === 'seo_admit_resource' ? { data: 'test-reservation', error: null } : { data: null, error: null },
    ),
  );
}

/** Admission that always denies with the given code/scope. */
export function denyingResourceAdmission(
  code: ResourceErrorCode = 'resource_limit',
  scope: ResourceScope = 'project',
): ResourceAdmissionService {
  const sqlstate = code === 'queue_limit' ? 'SE001' : code === 'resource_concurrency' ? 'SE002' : 'SE003';
  const message = code === 'queue_limit' ? 'seo_queue_limit' : code === 'resource_concurrency' ? 'seo_resource_concurrency' : 'seo_resource_rate';
  return new ResourceAdmissionService(
    fakeSb(async () => ({
      data: null,
      error: { code: sqlstate, message, detail: JSON.stringify({ scope }) },
    })),
  );
}
