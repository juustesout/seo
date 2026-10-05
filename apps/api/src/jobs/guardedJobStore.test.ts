/**
 * Admission-guarded JobStore (P9): the single seam every enqueue path goes
 * through. A database admission denial becomes denial evidence plus a stable
 * structured error; unrelated errors and successful enqueues are untouched.
 */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JobError } from '@seo/contracts';
import { ApiError } from '../apiErrors.js';
import { ResourceAdmissionService } from '../services/resourceAdmission.js';
import { GuardedJobStore } from './guardedJobStore.js';
import type { EnqueueJobInput, JobRecord, JobStore } from './types.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

interface InsertedDenial {
  project_id?: string;
  user_id?: string | null;
  resource?: string;
  code?: string;
  scope?: string;
  job_type?: string | null;
}

function fakeSb(inserted: InsertedDenial[]): SupabaseClient {
  return {
    from(table: string) {
      if (table === 'seo_projects') {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: { account_id: 'acct-1' }, error: null }),
        };
        return builder;
      }
      if (table === 'seo_resource_denials') {
        return {
          insert: async (row: InsertedDenial) => {
            inserted.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
}

function record(): JobRecord {
  return { id: 'job-1' } as unknown as JobRecord;
}

class FakeInnerStore implements JobStore {
  constructor(private readonly behavior: () => Promise<JobRecord>) {}
  enqueue(_input: EnqueueJobInput): Promise<JobRecord> {
    return this.behavior();
  }
  claimNext(): Promise<JobRecord | null> {
    return Promise.resolve(null);
  }
  get(): Promise<JobRecord | null> {
    return Promise.resolve(null);
  }
  list(): Promise<JobRecord[]> {
    return Promise.resolve([]);
  }
  updateProgress(): Promise<void> {
    return Promise.resolve();
  }
  complete(): Promise<void> {
    return Promise.resolve();
  }
  fail(_id: string, _error: JobError): Promise<void> {
    return Promise.resolve();
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
  reschedule(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function guarded(behavior: () => Promise<JobRecord>, inserted: InsertedDenial[] = []): GuardedJobStore {
  return new GuardedJobStore(new FakeInnerStore(behavior), new ResourceAdmissionService(fakeSb(inserted)));
}

const input: EnqueueJobInput = {
  project_id: PROJECT,
  provider: 'content',
  job_type: 'content_write',
  created_by: USER,
};

describe('GuardedJobStore.enqueue', () => {
  it('passes a successful enqueue straight through without recording a denial', async () => {
    const inserted: InsertedDenial[] = [];
    const job = await guarded(async () => record(), inserted).enqueue(input);
    expect(job.id).toBe('job-1');
    expect(inserted).toHaveLength(0);
  });

  it('maps a queue-limit denial to denial evidence plus a structured 429', async () => {
    const inserted: InsertedDenial[] = [];
    const store = guarded(async () => {
      throw { code: 'SE001', message: 'seo_queue_limit', detail: '{"scope":"project"}' };
    }, inserted);
    await expect(store.enqueue(input)).rejects.toMatchObject({
      status: 429,
      code: 'queue_limit',
      details: { resource: 'ai_generation', scope: 'project' },
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      account_id: 'acct-1',
      project_id: PROJECT,
      user_id: USER,
      resource: 'ai_generation',
      code: 'queue_limit',
      job_type: 'content_write',
    });
  });

  it('maps a concurrency denial to the resource_concurrency code', async () => {
    await expect(
      guarded(async () => {
        throw { code: 'SE002', message: 'seo_resource_concurrency' };
      }).enqueue(input),
    ).rejects.toMatchObject({ code: 'resource_concurrency' });
  });

  it('rethrows unrelated errors unchanged and records no denial', async () => {
    const inserted: InsertedDenial[] = [];
    const misc = new ApiError(409, 'conflict', 'A job with the same idempotency key already exists');
    const store = guarded(async () => {
      throw misc;
    }, inserted);
    await expect(store.enqueue(input)).rejects.toBe(misc);
    expect(inserted).toHaveLength(0);
  });

  it('forwards other JobStore operations and the worker wake-up event bus', async () => {
    const events = { on: () => events };
    const inner = new FakeInnerStore(async () => record());
    (inner as unknown as { events: unknown }).events = events;
    const store = new GuardedJobStore(inner, new ResourceAdmissionService(fakeSb([])));
    expect(store.events).toBe(events);
    await expect(store.claimNext()).resolves.toBeNull();
    await expect(store.reschedule('job-1', new Date().toISOString())).resolves.toBe(false);
  });
});
