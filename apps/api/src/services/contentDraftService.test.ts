/**
 * Agent Controls service: it must build a valid WriterInput from the source
 * article (title -> topic, target_keyword -> primaryKeyword), always request a
 * NEW draft (contentId: null), reuse opportunity context already captured on a
 * prior content_write job, and never write to the source article.
 */
import { describe, expect, it } from 'vitest';
import type { ServiceContainer } from '../context.js';
import type { EnqueueJobInput, JobRecord } from '../jobs/types.js';
import { startContentDraft } from './contentDraftService.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const CONTENT = '22222222-2222-4222-8222-222222222222';

type Row = Record<string, unknown>;

const ARTICLE: Row = {
  id: CONTENT,
  project_id: PROJECT,
  title: 'Blue widgets',
  excerpt: 'Widgets for careful buyers',
  target_keyword: 'blue widgets',
  language: 'en',
};

function fakeSb(rows: Row[]) {
  const writes: string[] = [];
  function builder() {
    const filters: Array<(row: Row) => boolean> = [];
    const b = {
      select: () => b,
      eq: (col: string, val: unknown) => {
        filters.push((row) => row[col] === val);
        return b;
      },
      maybeSingle: async () => ({ data: rows.filter((row) => filters.every((f) => f(row)))[0] ?? null, error: null }),
      insert: () => {
        writes.push('insert');
        return b;
      },
      update: () => {
        writes.push('update');
        return b;
      },
    };
    return b;
  }
  return { from: () => builder(), writes };
}

function fakeStore(jobs: JobRecord[] = []) {
  const enqueued: EnqueueJobInput[] = [];
  return {
    enqueued,
    list: async () => jobs,
    enqueue: async (input: EnqueueJobInput) => {
      enqueued.push(input);
      return { id: 'job-new', status: 'queued', ...input } as JobRecord;
    },
  };
}

function container(sb: ReturnType<typeof fakeSb>, store: ReturnType<typeof fakeStore>): ServiceContainer {
  return { sb, jobStore: store } as unknown as ServiceContainer;
}

function sourceJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-source',
    project_id: PROJECT,
    integration_id: null,
    data_source_id: null,
    provider: 'content',
    job_type: 'content_write',
    status: 'completed',
    params: {
      writer_input: {
        opportunityContext: {
          topic: 'Blue widgets',
          description: 'Widgets for buyers',
          primaryKeyword: 'blue widgets',
          keywords: [{ keyword: 'blue widgets', volume: 2400 }],
          competitors: [{ domain: 'rival.com', rank: 3 }],
          opportunityScore: 78,
          reasons: ['high_volume'],
          difficulty: 53,
          intent: 'commercial',
          knowledgeReadiness: 'moderate',
        },
        opportunityContextText: 'Topic: Blue widgets\nOpportunity score: 78/100',
        relatedKeywords: [{ keyword: 'blue widgets', volume: 2400 }],
      },
    },
    progress: 100,
    message: null,
    result: { content_id: CONTENT },
    error: null,
    queued_at: '2026-01-01T00:00:00.000Z',
    started_at: null,
    completed_at: null,
    run_after: '2026-01-01T00:00:00.000Z',
    retry_count: 0,
    max_retries: 3,
    created_by: 'u-1',
    ...overrides,
  };
}

describe('startContentDraft', () => {
  it('builds a new-draft WriterInput from the source article and never writes it', async () => {
    const sb = fakeSb([ARTICLE]);
    const store = fakeStore();

    const result = await startContentDraft(container(sb, store), {
      projectId: PROJECT,
      contentId: CONTENT,
      userId: 'u-1',
    });

    expect(result.reused).toBe(false);
    expect(store.enqueued).toHaveLength(1);
    const input = store.enqueued[0]!;
    expect(input.job_type).toBe('content_write');
    expect(input.provider).toBe('content');
    expect(input.params?.source_content_id).toBe(CONTENT);
    const writerInput = input.params?.writer_input as Record<string, unknown>;
    expect(writerInput.contentId).toBe(null);
    expect(writerInput.mode).toBe('quick_draft');
    expect(writerInput.format).toBe('short_article');
    expect(writerInput.topic).toEqual({ name: 'Blue widgets', description: 'Widgets for careful buyers' });
    expect(writerInput.primaryKeyword).toBe('blue widgets');
    expect(writerInput.language).toBe('en');
    expect(sb.writes).toEqual([]);
  });

  it('honours explicit mode and format', async () => {
    const sb = fakeSb([ARTICLE]);
    const store = fakeStore();

    await startContentDraft(container(sb, store), {
      projectId: PROJECT,
      contentId: CONTENT,
      userId: 'u-1',
      mode: 'deep_write',
      format: 'explainer',
    });

    const writerInput = store.enqueued[0]!.params?.writer_input as Record<string, unknown>;
    expect(writerInput.mode).toBe('deep_write');
    expect(writerInput.format).toBe('explainer');
  });

  it('reuses opportunity context already captured on a prior content_write job', async () => {
    const sb = fakeSb([ARTICLE]);
    const store = fakeStore([sourceJob()]);

    await startContentDraft(container(sb, store), { projectId: PROJECT, contentId: CONTENT, userId: 'u-1' });

    const writerInput = store.enqueued[0]!.params?.writer_input as Record<string, unknown>;
    const context = writerInput.opportunityContext as Record<string, unknown>;
    expect(context.opportunityScore).toBe(78);
    expect(context.difficulty).toBe(53);
    expect(context.intent).toBe('commercial');
    expect(writerInput.opportunityContextText).toBe('Topic: Blue widgets\nOpportunity score: 78/100');
    expect(writerInput.relatedKeywords).toEqual([{ keyword: 'blue widgets', volume: 2400 }]);
  });

  it('ignores job data that never produced this article', async () => {
    const sb = fakeSb([ARTICLE]);
    const store = fakeStore([sourceJob({ result: { content_id: 'some-other-article' } })]);

    await startContentDraft(container(sb, store), { projectId: PROJECT, contentId: CONTENT, userId: 'u-1' });

    const writerInput = store.enqueued[0]!.params?.writer_input as Record<string, unknown>;
    expect(writerInput.opportunityContext).toBe(null);
  });

  it('derives a fresh idempotency key from the predecessor run', async () => {
    const sb = fakeSb([ARTICLE]);
    const store = fakeStore([
      sourceJob({ id: 'job-prev', params: { source_content_id: CONTENT }, result: null }),
    ]);

    await startContentDraft(container(sb, store), { projectId: PROJECT, contentId: CONTENT, userId: 'u-1' });

    expect(store.enqueued[0]!.idempotency_key).toBe(`content_draft:${PROJECT}:${CONTENT}:job-prev`);
  });
});
