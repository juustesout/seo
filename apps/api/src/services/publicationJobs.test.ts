/**
 * Logical publication identity + idempotent publish-job enqueue (R5.11.2 H3).
 *
 * The durable job queue's unique idempotency_key is the persistent boundary that
 * makes duplicate submissions, concurrent requests and a double click resolve to
 * one logical publish operation, while a later deliberate operation still gets a
 * fresh attempt.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../apiErrors.js';
import type { ServiceContainer } from '../context.js';
import type { EnqueueJobInput, JobRecord } from '../jobs/types.js';
import {
  actionPublishIdentity,
  directPublishIdentity,
  enqueuePublicationJob,
  publicationJobsByIdentity,
  publishJobIdempotencyKey,
  publishJobType,
  reusablePublicationJob,
} from './publicationJobs.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const PUBLICATION = '22222222-2222-4222-8222-222222222222';
const PUBLISHER = '33333333-3333-4333-8333-333333333333';

interface JobRow extends Record<string, unknown> {
  id: string;
  status: string;
  idempotency_key: string | null;
}

/** Unique-key-enforcing job store whose rows are visible to the sb reader. */
class FakeJobStore {
  records: JobRow[];
  private seq = 0;
  constructor(records: JobRow[]) {
    this.records = records;
  }
  async enqueue(input: EnqueueJobInput): Promise<JobRecord> {
    const key = input.idempotency_key ?? null;
    if (key && this.records.some((r) => r.idempotency_key === key)) {
      throw ApiError.conflict('A job with the same idempotency key already exists');
    }
    const row: JobRow = {
      id: `job-${++this.seq}`,
      project_id: input.project_id,
      provider: input.provider,
      job_type: input.job_type,
      status: 'queued',
      params: input.params ?? {},
      queued_at: new Date().toISOString(),
      run_after: new Date().toISOString(),
      retry_count: 0,
      max_retries: 3,
      idempotency_key: key,
    };
    this.records.push(row);
    return row as unknown as JobRecord;
  }
}

/** Read-only sb fake: only the seo_sync_jobs LIKE-prefix query is exercised. */
function fakeSb(records: JobRow[]) {
  return {
    from(table: string) {
      let prefix: string | null = null;
      let projectId: string | null = null;
      const b = {
        select: () => b,
        eq: (col: string, val: unknown) => {
          if (col === 'project_id') projectId = String(val);
          return b;
        },
        like: (_col: string, pattern: string) => {
          prefix = pattern.endsWith('%') ? pattern.slice(0, -1) : pattern;
          return b;
        },
        order: () => b,
        then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
          const rows =
            table === 'seo_sync_jobs'
              ? records.filter(
                  (r) =>
                    (projectId === null || r.project_id === projectId) &&
                    (prefix === null || String(r.idempotency_key ?? '').startsWith(prefix)),
                )
              : [];
          return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
        },
      };
      return b as unknown as { from: never };
    },
  };
}

function container(records: JobRow[]): ServiceContainer {
  return {
    sb: fakeSb(records),
    jobStore: new FakeJobStore(records),
  } as unknown as ServiceContainer;
}

function jobRows(): JobRow[] {
  return [];
}

function intent(overrides: Partial<Parameters<typeof directPublishIdentity>[0]> = {}) {
  return {
    projectId: PROJECT,
    publisherId: PUBLISHER,
    publishKind: 'article',
    remoteStatus: 'publish',
    title: 'Hello world',
    content: '<p>Body</p>',
    ...overrides,
  };
}

describe('publish job identity', () => {
  it('maps lifecycle actions onto the existing executor job vocabulary', () => {
    expect(publishJobType('publish')).toBe('publish');
    expect(publishJobType('update')).toBe('publish_update');
    expect(publishJobType('delete')).toBe('publish_delete');
  });

  it('derives a stable direct identity that changes with the payload', () => {
    const a = directPublishIdentity(intent());
    const b = directPublishIdentity(intent());
    const changed = directPublishIdentity(intent({ content: '<p>Other</p>' }));
    expect(a).toBe(b);
    expect(changed).not.toBe(a);
  });

  it('keys a lifecycle action on the publication row', () => {
    expect(actionPublishIdentity(PUBLICATION, 'publish')).toContain(PUBLICATION);
    expect(actionPublishIdentity(PUBLICATION, 'update')).not.toBe(actionPublishIdentity(PUBLICATION, 'publish'));
  });

  it('suffixes the identity with the attempt generation', () => {
    expect(publishJobIdempotencyKey('publish:action:update:x', 0)).toBe('publish:action:update:x:0');
    expect(publishJobIdempotencyKey('publish:action:update:x', 3)).toBe('publish:action:update:x:3');
  });
});

describe('enqueuePublicationJob', () => {
  const identity = actionPublishIdentity(PUBLICATION, 'publish');
  const base = { projectId: PROJECT, userId: 'user-1', identity, provider: 'wordpress', jobType: 'publish' as const, params: { publication_id: PUBLICATION } };

  it('enqueues the first attempt with a deterministic key', async () => {
    const records = jobRows();
    const c = container(records);
    const { job, reused } = await enqueuePublicationJob(c, base);
    expect(reused).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].idempotency_key).toBe(`${identity}:0`);
    expect(job.id).toBe('job-1');
  });

  it('reuses an in-flight job for a repeat submission instead of starting a second op', async () => {
    const records = jobRows();
    const c = container(records);
    const first = await enqueuePublicationJob(c, base);
    const second = await enqueuePublicationJob(c, base);
    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(records).toHaveLength(1);
  });

  it('starts a new generation once the previous attempt is terminal', async () => {
    const records = jobRows();
    const c = container(records);
    await enqueuePublicationJob(c, base);
    records[0].status = 'failed';
    const retry = await enqueuePublicationJob(c, base);
    expect(retry.reused).toBe(false);
    expect(records).toHaveLength(2);
    expect(records[1].idempotency_key).toBe(`${identity}:1`);
  });

  it('resolves a concurrent duplicate that raced past the reuse check onto the winner', async () => {
    const records = jobRows();
    const c = container(records);
    // The winner is already durable (as if inserted by a peer request) but the
    // pre-check is simulated as having seen nothing, so enqueue hits the unique
    // key and must recover by reusing the winner rather than failing.
    records.push({
      id: 'winner',
      project_id: PROJECT,
      provider: 'wordpress',
      job_type: 'publish',
      status: 'running',
      params: { publication_id: PUBLICATION },
      queued_at: new Date().toISOString(),
      run_after: new Date().toISOString(),
      idempotency_key: `${identity}:0`,
    } as unknown as JobRow);
    // Force the race: hide the winner from the pre-check, then surface it.
    let hidden = true;
    (c as { sb: unknown }).sb = {
      from() {
        const b = {
          select: () => b,
          eq: () => b,
          like: () => b,
          order: () => b,
          then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
            const rows = hidden ? [] : records;
            hidden = false;
            return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
          },
        };
        return b;
      },
    };
    const result = await enqueuePublicationJob(c, base);
    expect(result.reused).toBe(true);
    expect(result.job.id).toBe('winner');
    expect(records.filter((r) => r.status === 'queued')).toHaveLength(0);
  });
});

describe('publicationJobsByIdentity + reusablePublicationJob', () => {
  it('returns only jobs for the requested identity, newest first', async () => {
    const records: JobRow[] = [
      { id: 'a', project_id: PROJECT, status: 'completed', idempotency_key: 'publish:action:publish:x:0' },
      { id: 'b', project_id: PROJECT, status: 'queued', idempotency_key: 'publish:action:publish:x:1' },
      { id: 'c', project_id: PROJECT, status: 'queued', idempotency_key: 'publish:action:publish:y:0' },
    ];
    const c = container(records);
    const rows = await publicationJobsByIdentity(c, PROJECT, 'publish:action:publish:x');
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b']);
    const reusable = await reusablePublicationJob(c, PROJECT, 'publish:action:publish:x');
    expect(reusable?.id).toBe('b');
    expect(await reusablePublicationJob(c, PROJECT, 'publish:action:publish:z')).toBeNull();
  });
});
