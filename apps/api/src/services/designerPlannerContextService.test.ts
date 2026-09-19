/**
 * Designer planner context service tests (Stage 8E.6, Phase 3.2).
 *
 * The loader is the only place the planner reads project state. These tests
 * prove it reads through ContentService/Cosmos, bounds the context and never
 * reaches for raw provider or content internals.
 */
import { describe, expect, it, vi } from 'vitest';
import type { DesignerIntent } from '@seo/contracts';
import type { ServiceContainer } from '../context.js';
import {
  PLANNER_CONTEXT_COSMOS_MAX_CHARS,
} from '../agents/designer/plannerContext.js';
import { DesignerPlannerContextService } from './designerPlannerContextService.js';

const mock = vi.hoisted(() => ({
  cosmosText: 'brand context',
  contentJson: null as unknown,
  getCalls: 0,
}));

vi.mock('./cosmosService.js', () => ({
  getCosmosContext: async () => ({ text: mock.cosmosText, hasContent: true, useProjectKnowledge: false }),
}));

vi.mock('./contentService.js', () => ({
  ContentService: class {
    async get() {
      mock.getCalls += 1;
      return {
        id: 'c1',
        title: 'Stored title',
        target_keyword: 'seo',
        language: 'en',
        content_json: mock.contentJson,
      };
    }
  },
}));

const TIP_DOC = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, id: 'b0', content: [{ type: 'text', text: 'Why analytics' }] },
    { type: 'paragraph', id: 'b1', content: [{ type: 'text', text: 'Old intro copy here' }] },
  ],
};

const CONTENT_ID = '33333333-3333-4333-8333-333333333333';

function intent(overrides: Partial<DesignerIntent> = {}): DesignerIntent {
  return { projectId: 'p1', instruction: 'Improve the intro', ...overrides } as DesignerIntent;
}

const service = new DesignerPlannerContextService({} as ServiceContainer);

describe('DesignerPlannerContextService', () => {
  it('loads bounded Cosmos context and no document when the intent has no contentId', async () => {
    mock.cosmosText = 'a'.repeat(PLANNER_CONTEXT_COSMOS_MAX_CHARS + 500);
    const context = await service.load(intent());
    expect(context.cosmosText).toHaveLength(PLANNER_CONTEXT_COSMOS_MAX_CHARS);
    expect(context.document).toBeUndefined();
    expect(mock.getCalls).toBe(0);
  });

  it('summarizes the target document into revision, headings and writable blocks', async () => {
    mock.cosmosText = 'brand context';
    mock.contentJson = TIP_DOC;
    const context = await service.load(intent({ contentId: CONTENT_ID }));
    expect(context.document?.contentId).toBe(CONTENT_ID);
    expect(context.document?.title).toBe('Stored title');
    expect(context.document?.targetKeyword).toBe('seo');
    expect(context.document?.revision).toMatch(/^rev1:/);
    expect(context.document?.wordCount).toBeGreaterThan(0);
    expect(context.document?.headings).toContainEqual({ level: 2, text: 'Why analytics' });
    const refs = context.document?.blocks.map((b) => b.ref) ?? [];
    expect(refs).toContain('b0');
    expect(refs).toContain('b1');
  });

  it('truncates an over-long block text through the shared bounds', async () => {
    mock.contentJson = {
      type: 'doc',
      content: [{ type: 'paragraph', id: 'b0', content: [{ type: 'text', text: 'x'.repeat(2000) }] }],
    };
    const context = await service.load(intent({ contentId: CONTENT_ID }));
    expect(context.document?.blocks[0]?.text.length).toBeLessThanOrEqual(400);
  });
});
