/**
 * KB7 knowledge refresh executor registration.
 *
 * The executor must be a thin delegation to the SAME KnowledgeService pipeline
 * as ingest so hashing, the unchanged short-circuit and bounded backoff live in
 * exactly one place. This guards the job_type -> service wiring.
 */

import { describe, expect, it, vi } from 'vitest';
import { getExecutor } from './executors.js';
import { KnowledgeService } from '../services/knowledgeService.js';

const PROJECT = '00000000-0000-0000-0000-0000000000bb';
const SOURCE = '00000000-0000-0000-0000-0000000000aa';

describe('knowledge_source_refresh executor (KB7)', () => {
  it('is registered and delegates to KnowledgeService.refreshSource', async () => {
    const spy = vi.spyOn(KnowledgeService.prototype, 'refreshSource').mockResolvedValue({ refreshed: true } as never);
    const executor = getExecutor('knowledge_source_refresh');
    expect(executor).toBeTypeOf('function');

    const report = vi.fn(async () => undefined);
    await executor!({
      container: {} as never,
      job: { project_id: PROJECT, params: { source_id: SOURCE } } as never,
      writer: {} as never,
      report,
    });

    expect(spy).toHaveBeenCalledWith(PROJECT, SOURCE, report);
    spy.mockRestore();
  });

  it('rejects a job without a source_id before touching the service', async () => {
    const spy = vi.spyOn(KnowledgeService.prototype, 'refreshSource');
    const executor = getExecutor('knowledge_source_refresh')!;

    await expect(
      executor({ container: {} as never, job: { project_id: PROJECT, params: {} } as never, writer: {} as never, report: vi.fn() }),
    ).rejects.toMatchObject({ status: 400 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('knowledge_discovery executor (KB9)', () => {
  it('is registered and delegates to KnowledgeService.runDiscovery', async () => {
    const spy = vi
      .spyOn(KnowledgeService.prototype, 'runDiscovery')
      .mockResolvedValue({ status: 'ready', candidates: [] } as never);
    const executor = getExecutor('knowledge_discovery');
    expect(executor).toBeTypeOf('function');

    const report = vi.fn(async () => undefined);
    await executor!({
      container: {} as never,
      job: { project_id: PROJECT, params: { session_id: SOURCE } } as never,
      writer: {} as never,
      report,
    });

    expect(spy).toHaveBeenCalledWith(PROJECT, SOURCE, report);
    spy.mockRestore();
  });

  it('rejects a job without a session_id before touching the service', async () => {
    const spy = vi.spyOn(KnowledgeService.prototype, 'runDiscovery');
    const executor = getExecutor('knowledge_discovery')!;

    await expect(
      executor({ container: {} as never, job: { project_id: PROJECT, params: {} } as never, writer: {} as never, report: vi.fn() }),
    ).rejects.toMatchObject({ status: 400 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
