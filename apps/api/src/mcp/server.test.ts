import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTools, registerTools } from '../mcp/server.js';
import type { MpcDeps } from '../mcp/server.js';
import { ScheduleService } from '../services/scheduleService.js';
import { PublicationService } from '../services/publicationService.js';
import { ApiError } from '../apiErrors.js';

const readOnlyDeps = { canRead: false, canWrite: false } as unknown as MpcDeps;
const readWriteDeps = { canRead: true, canWrite: true } as unknown as MpcDeps;

// Realistic UUID-shaped ids so edge validation in handlers is exercised.
const CID = '11111111-1111-4111-8111-111111111111';
const PID = '22222222-2222-4222-8222-222222222222';
const SCHED = '33333333-3333-4333-8333-333333333333';
const PUB = '44444444-4444-4444-8444-444444444444';
const ANY_UUID = '00000000-0000-4000-8000-000000000000';

const byName = (name: string) => buildTools().find((t) => t.name === name)!;

function deps(overrides: Partial<MpcDeps> = {}): MpcDeps {
  return {
    sb: {} as never,
    jobStore: {} as never,
    projectId: 'p1',
    userId: 'u1',
    canRead: true,
    canWrite: true,
    ...overrides,
  } as MpcDeps;
}

const viewer = (): MpcDeps => deps({ canWrite: false });
const editor = (): MpcDeps => deps();

async function expectsDenied(p: Promise<unknown>): Promise<void> {
  try {
    await p;
    throw new Error('expected ApiError to be thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  }
}

async function expectsCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
    throw new Error(`expected ApiError with code '${code}'`);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mcp tool registry', () => {
  it('exposes the full tool set with scopes and versioned schemas', () => {
    const tools = buildTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'content_analyze',
        'content_generate',
        'content_get',
        'content_list',
        'content_resolve_images',
        'content_update',
        'jobs_list',
        'publication_get',
        'publication_list',
        'schedule_cancel',
        'schedule_create',
        'schedule_list',
        'schedule_reschedule',
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.description).toContain('schema v1');
      expect(tool.inputSchema).toBeTruthy();
    }
    expect(tools.filter((t) => t.readOnly)).toHaveLength(7);
    expect(tools.filter((t) => !t.readOnly)).toHaveLength(6);
  });

  it('registers only tools the bound key scopes allow (no useless write tools for a reader)', () => {
    const registered: string[] = [];
    const fake = { registerTool: (...args: unknown[]) => void registered.push(String(args[0])) };
    registerTools(fake as never, viewer());
    expect(registered).toContain('schedule_list');
    expect(registered).toContain('publication_list');
    expect(registered).toContain('content_get');
    expect(registered).not.toContain('schedule_create');
    expect(registered).not.toContain('schedule_reschedule');
    expect(registered).not.toContain('schedule_cancel');
    expect(registered).not.toContain('content_update');
  });
});

describe('mcp authorization (scope mirrors project role)', () => {
  it('denies read tools when the bound key has no read scope', async () => {
    await expectsDenied(byName('content_list').handler(readOnlyDeps, {}));
    await expectsDenied(byName('content_get').handler(readOnlyDeps, { id: '00000000-0000-4000-8000-000000000000' }));
    await expectsDenied(byName('content_analyze').handler(readOnlyDeps, { id: '00000000-0000-4000-8000-000000000000' }));
    await expectsDenied(byName('jobs_list').handler(readOnlyDeps, {}));
    await expectsDenied(byName('schedule_list').handler(readOnlyDeps, { project_id: 'p1' }));
    await expectsDenied(byName('publication_list').handler(readOnlyDeps, { project_id: 'p1' }));
    await expectsDenied(byName('publication_get').handler(readOnlyDeps, { project_id: 'p1', publication_id: ANY_UUID }));
  });

  it('denies write tools when the bound key has no write scope (viewer)', async () => {
    const noWrite = deps({ canWrite: false });
    await expectsDenied(byName('content_generate').handler(noWrite, {}));
    await expectsDenied(byName('content_resolve_images').handler(noWrite, { id: '00000000-0000-4000-8000-000000000000' }));
    await expectsDenied(byName('content_update').handler(noWrite, { id: '00000000-0000-4000-8000-000000000000', meta_title: 'x' }));
    await expectsDenied(
      byName('schedule_create').handler(noWrite, { project_id: 'p1', content_id: CID, publisher_id: PID, scheduled_at: '2026-09-10T09:00:00+02:00' }),
    );
    await expectsDenied(byName('schedule_reschedule').handler(noWrite, { project_id: 'p1', schedule_id: SCHED, scheduled_at: '2026-09-10T09:00:00+02:00' }));
    await expectsDenied(byName('schedule_cancel').handler(noWrite, { project_id: 'p1', schedule_id: SCHED }));
  });

  it('viewer can list schedules and publications (read scope only)', async () => {
    const v = viewer();
    const sampleSchedule = { id: 's1', content_title: 'Demo', status: 'scheduled' };
    const samplePub = { id: 'pub1', content_title: 'Demo', status: 'published' };
    vi.spyOn(ScheduleService.prototype, 'list').mockResolvedValue([sampleSchedule as never]);
    vi.spyOn(PublicationService.prototype, 'list').mockResolvedValue([samplePub as never]);

    const schedules = await byName('schedule_list').handler(v, { project_id: 'p1' });
    const pubs = await byName('publication_list').handler(v, { project_id: 'p1' });

    expect(schedules.data).toEqual([sampleSchedule]);
    expect(pubs.data).toEqual([samplePub]);
  });

  it('rejects a project_id that does not match the bound key (cross-project access)', async () => {
    const scheduleList = vi.spyOn(ScheduleService.prototype, 'list');
    const pubList = vi.spyOn(PublicationService.prototype, 'list');
    const create = vi.spyOn(ScheduleService.prototype, 'create');
    const get = vi.spyOn(PublicationService.prototype, 'get');

    const d = deps();
    await expectsDenied(byName('schedule_list').handler(d, { project_id: 'p-other' }));
    await expectsDenied(byName('publication_list').handler(d, { project_id: 'p-other' }));
    await expectsDenied(
      byName('schedule_create').handler(d, { project_id: 'p-other', content_id: CID, publisher_id: PID, scheduled_at: '2026-09-10T09:00:00+02:00' }),
    );
    await expectsDenied(
      byName('publication_get').handler(d, { project_id: 'p-other', publication_id: '00000000-0000-4000-8000-000000000000' }),
    );
    expect(scheduleList).not.toHaveBeenCalled();
    expect(pubList).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('mcp scheduling tools delegate to ScheduleService', () => {
  it('schedule_list forwards status/from/to filters to the service', async () => {
    const spy = vi.spyOn(ScheduleService.prototype, 'list').mockResolvedValue([]);
    const d = editor();

    const out = await byName('schedule_list').handler(d, {
      project_id: 'p1',
      status: 'published',
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00+02:00',
      limit: 5,
    });

    expect(out.data).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('p1', {
      status: 'published',
      from: '2026-09-01T00:00:00Z',
      to: '2026-10-01T00:00:00+02:00',
      limit: 5,
    });
  });

  it('rejects ambiguous or offset-less from/to times for schedule_list', async () => {
    const spy = vi.spyOn(ScheduleService.prototype, 'list').mockResolvedValue([]);
    const d = editor();
    await expectsCode(byName('schedule_list').handler(d, { project_id: 'p1', from: '2026-09-10 09:00' }), 'invalid_datetime');
    await expectsCode(byName('schedule_list').handler(d, { project_id: 'p1', to: '2026-09-10T09:00:00' }), 'invalid_datetime');
    expect(spy).not.toHaveBeenCalled();
  });

  it('schedule_create calls ScheduleService.create with the bound project and actor', async () => {
    const spy = vi
      .spyOn(ScheduleService.prototype, 'create')
      .mockResolvedValue({ id: 's-new', content_title: 'Demo', status: 'scheduled' } as never);
    const d = editor();

    const out = await byName('schedule_create').handler(d, {
      project_id: 'p1',
      content_id: CID,
      publisher_id: PID,
      scheduled_at: '2026-09-10T09:00:00+02:00',
    });

    expect(out.data).toMatchObject({ id: 's-new' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('p1', 'u1', {
      content_id: CID,
      publisher_id: PID,
      scheduled_at: '2026-09-10T09:00:00+02:00',
      publish_kind: 'article',
    });
  });

  it('schedule_create rejects ambiguous/offset-less times before touching the service', async () => {
    const spy = vi.spyOn(ScheduleService.prototype, 'create').mockResolvedValue({} as never);
    const d = editor();
    await expectsCode(
      byName('schedule_create').handler(d, { project_id: 'p1', content_id: CID, publisher_id: PID, scheduled_at: '2026-09-10 09:00' }),
      'invalid_datetime',
    );
    await expectsCode(
      byName('schedule_create').handler(d, { project_id: 'p1', content_id: CID, publisher_id: PID, scheduled_at: '2026-09-10T09:00:00' }),
      'invalid_datetime',
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('schedule_create rejects missing required ids safely', async () => {
    const spy = vi.spyOn(ScheduleService.prototype, 'create').mockResolvedValue({} as never);
    const d = editor();
    await expectsCode(
      byName('schedule_create').handler(d, { project_id: 'p1', publisher_id: PID, scheduled_at: '2026-09-10T09:00:00+02:00' }),
      'invalid_input',
    );
    await expectsCode(
      byName('schedule_create').handler(d, { project_id: 'p1', content_id: CID, scheduled_at: '2026-09-10T09:00:00+02:00' }),
      'invalid_input',
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('schedule_create refuses to run without a user identity on the key', async () => {
    vi.spyOn(ScheduleService.prototype, 'create').mockResolvedValue({} as never);
    const d = deps({ userId: null });
    await expectsDenied(
      byName('schedule_create').handler(d, { project_id: 'p1', content_id: CID, publisher_id: PID, scheduled_at: '2026-09-10T09:00:00+02:00' }),
    );
  });

  it('schedule_reschedule calls the existing service (moves the same job)', async () => {
    const spy = vi.spyOn(ScheduleService.prototype, 'reschedule').mockResolvedValue({ id: 's1', status: 'scheduled' } as never);
    const d = editor();

    const out = await byName('schedule_reschedule').handler(d, {
      project_id: 'p1',
      schedule_id: SCHED,
      scheduled_at: '2026-10-01T10:00:00+02:00',
    });

    expect(out.data).toMatchObject({ id: 's1' });
    expect(spy).toHaveBeenCalledWith('p1', SCHED, '2026-10-01T10:00:00+02:00');
  });

  it('schedule_cancel calls the existing service (preserves history, idempotent)', async () => {
    const spy = vi.spyOn(ScheduleService.prototype, 'cancel').mockResolvedValue({ id: 's1', status: 'cancelled' } as never);
    const d = editor();

    const out = await byName('schedule_cancel').handler(d, { project_id: 'p1', schedule_id: SCHED });

    expect(out.data).toMatchObject({ id: 's1', status: 'cancelled' });
    expect(spy).toHaveBeenCalledWith('p1', SCHED);
  });

  it('surfaces service domain errors as their existing codes', async () => {
    vi.spyOn(ScheduleService.prototype, 'reschedule').mockRejectedValue(
      new ApiError(409, 'schedule_not_editable', 'A schedule in status \'publishing\' cannot be rescheduled'),
    );
    await expectsCode(
      byName('schedule_reschedule').handler(editor(), { project_id: 'p1', schedule_id: SCHED, scheduled_at: '2026-10-01T10:00:00+02:00' }),
      'schedule_not_editable',
    );
  });
});

describe('mcp publication tools reuse PublicationService', () => {
  it('publication_list forwards filters and returns the safe list DTO', async () => {
    const spy = vi.spyOn(PublicationService.prototype, 'list').mockResolvedValue([]);
    const d = editor();

    const out = await byName('publication_list').handler(d, {
      project_id: 'p1',
      content_id: CID,
      publisher_id: PID,
      schedule_id: SCHED,
      status: 'failed',
      limit: 10,
      offset: 20,
    });

    expect(out.data).toEqual([]);
    expect(spy).toHaveBeenCalledWith('p1', {
      content_id: CID,
      publisher_id: PID,
      schedule_id: SCHED,
      status: 'failed',
      limit: 10,
      offset: 20,
    });
  });

  it('publication_get is project scoped via the bound key', async () => {
    const spy = vi.spyOn(PublicationService.prototype, 'get').mockResolvedValue({ id: 'pub1', content_title: 'Demo' } as never);
    const d = editor();

    const out = await byName('publication_get').handler(d, { project_id: 'p1', publication_id: PUB });
    expect(out.data).toMatchObject({ id: 'pub1' });
    expect(spy).toHaveBeenCalledWith('p1', PUB);
  });

  it('never injects article bodies or credentials into tool output', async () => {
    const safeRow = {
      id: 'pub1',
      project_id: 'p1',
      content_id: CID,
      content_title: 'Demo',
      publisher_id: PID,
      publisher_name: 'WordPress live',
      schedule_id: null,
      status: 'published',
      remote_id: 'wp-42',
      target_url: 'https://example.com/p/42',
      scheduled_for: null,
      published_at: '2026-09-01T09:00:00.000Z',
      error: null,
      created_at: '2026-09-01T08:00:00.000Z',
      updated_at: '2026-09-01T09:00:00.000Z',
    };
    vi.spyOn(PublicationService.prototype, 'list').mockResolvedValue([safeRow as never]);
    const d = viewer();

    const out = await byName('publication_list').handler(d, { project_id: 'p1' });

    const payload = JSON.stringify(out.data);
    expect(payload).not.toContain('<p>');
    expect(payload).not.toContain('credentials');
    expect(payload).not.toContain('config');
    expect(payload).not.toContain('token');
    expect(payload).toContain('target_url');
  });

  it('rejects malformed missing ids before hitting the service', async () => {
    const spy = vi.spyOn(PublicationService.prototype, 'get').mockResolvedValue({} as never);
    await expectsCode(
      byName('publication_get').handler(editor(), { project_id: 'p1' }),
      'invalid_input',
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
