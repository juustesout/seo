/**
 * content_write executor: the job result must carry the compact Writer summary,
 * and a failed run must hand a failure summary to the worker (on the thrown
 * error's `jobResult`) so the failed job row can explain what it did. The writer
 * engine is mocked here; its own behavior is covered by engine/summary tests.
 */
import { describe, expect, it, vi } from 'vitest';

const { run, parse } = vi.hoisted(() => ({ run: vi.fn(), parse: vi.fn((raw: unknown) => raw) }));
vi.mock('../agents/writer/engine.js', () => ({
  createWriterEngine: () => ({ run }),
  parseWriterInput: (raw: unknown) => parse(raw),
}));

import { getExecutor } from './executors.js';

const SUMMARY = {
  mode: 'quick_draft',
  format: 'short_article',
  pass_count: 4,
  llm_calls: 3,
  duration_ms: 1200,
  by_kind: { context: 1, architecture: 1, section_generation: 2, persist: 1 },
};

function context() {
  return {
    container: {} as never,
    job: {
      id: 'job-1',
      project_id: 'p-1',
      job_type: 'content_write',
      created_by: 'u-1',
      params: { writer_input: { projectId: 'p-1' } },
    } as never,
    writer: {} as never,
    report: vi.fn(),
  };
}

describe('content_write executor', () => {
  it('returns the content id and the compact writer summary', async () => {
    run.mockReset();
    run.mockResolvedValueOnce({
      contentId: 'c-2',
      title: 'New draft',
      slug: 'new-draft',
      format: 'short_article',
      mode: 'quick_draft',
      sectionCount: 3,
      wordCount: 420,
      seoScore: 81,
      summary: SUMMARY,
    });

    const out = await getExecutor('content_write')!(context());

    expect(out).toMatchObject({
      content_id: 'c-2',
      title: 'New draft',
      mode: 'quick_draft',
      section_count: 3,
      word_count: 420,
      seo_score: 81,
      writer_summary: SUMMARY,
    });
  });

  it('carries a failure summary on jobResult when the engine fails', async () => {
    run.mockReset();
    const failure = Object.assign(new Error('provider exploded'), {
      code: 'provider_error',
      status: 502,
      writerSummary: { ...SUMMARY, pass_count: 2, llm_calls: 2, failed_pass: 'section_generation' },
    });
    run.mockRejectedValueOnce(failure);

    let caught: unknown;
    try {
      await getExecutor('content_write')!(context());
    } catch (err) {
      caught = err;
    }

    const jobResult = (caught as { jobResult?: { writer_summary?: { failed_pass?: string } } }).jobResult;
    expect(jobResult?.writer_summary?.failed_pass).toBe('section_generation');
  });

  it('rethrows unchanged when the engine fails before any pass summary exists', async () => {
    run.mockReset();
    const bare = Object.assign(new Error('bad input'), { code: 'bad_request', status: 400 });
    run.mockRejectedValueOnce(bare);

    await expect(getExecutor('content_write')!(context())).rejects.toBe(bare);
  });
});
