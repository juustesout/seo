/**
 * Shared Writer Engine / Quick Draft tests (W1).
 *
 * The engine is exercised through its dependency seams with fakes, so the tests
 * pin the contract that matters: exactly one plan call and one call per planned
 * section, in plan order; context is gathered project-scoped and bounded with
 * the opportunity briefing carried as labelled untrusted data; the format
 * registry gates the plan before any section is written; a failing or
 * unconfigured AI produces an honest error and NO persisted draft; a success
 * persists through the injected ContentService port as a canonical TipDoc with
 * the deterministic evaluator's score. `parseWriterInput` is the fail-closed
 * boundary for untrusted job params.
 */

import { describe, expect, it } from 'vitest';
import type { ArticlePlan, WriterInput } from '@seo/contracts';
import { ApiError } from '../../apiErrors.js';
import type { ContentInput } from '../../services/contentService.js';
import type {
  DeepWriteDependencies,
  WriterCoherenceInput,
  WriterParagraphInput,
  WriterParagraphRefineInput,
  WriterSectionPlanInput,
} from './deepWrite.js';
import { DEFAULT_WRITER_REVIEW_DEPENDENCIES } from './review.js';
import type { WriterContext, WriterContextDependencies, WriterContextInput } from './context.js';
import type { WriterPlanInput, WriterPlanOutcome, WriterPlannerDependencies } from './planner.js';
import type { WriterSectionDependencies, WriterSectionInput, WriterSectionOutcome } from './sectionWriter.js';
import type { WriterPlan } from './state.js';
import {
  parseWriterInput,
  planToArticlePlan,
  runWriterEngine,
  type WriterEngineDependencies,
  type WriterPersistence,
} from './engine.js';

const PROJECT = 'c00162dd-d23e-4904-85ca-76cccc6d8c90';

function makePlan(sectionCount: number, title = 'Blue widgets explained'): WriterPlan {
  return {
    title,
    metaDescription: 'Everything buyers need to know about blue widgets.',
    introductionPurpose: 'Frame the topic and the primary keyword.',
    sections: Array.from({ length: sectionCount }, (_, index) => ({
      heading: `Section ${index + 1}`,
      keyPoints: [`point ${index + 1}`],
      suggestedKeywords: [`kw${index + 1}`],
    })),
  };
}

function makeInput(overrides: Partial<WriterInput> = {}): WriterInput {
  return {
    projectId: PROJECT,
    contentId: null,
    topic: { name: 'Blue widgets', description: 'Widgets for careful buyers' },
    primaryKeyword: 'blue widgets',
    relatedKeywords: [{ keyword: 'blue widgets', volume: 2400 }],
    opportunityContext: null,
    opportunityContextText: null,
    format: 'short_article',
    mode: 'quick_draft',
    ...overrides,
  };
}

function makePlanner(plan: WriterPlan, failure?: WriterPlanOutcome & { ok: false }) {
  const inputs: WriterPlanInput[] = [];
  const dependencies: WriterPlannerDependencies = {
    async plan(input) {
      inputs.push(input);
      return failure ?? { ok: true, plan };
    },
  };
  return { inputs, dependencies };
}

function makeSectionWriter(failure?: { at: number; outcome: WriterSectionOutcome & { ok: false } }) {
  const calls: WriterSectionInput[] = [];
  const dependencies: WriterSectionDependencies = {
    async writeSection(input) {
      calls.push(input);
      if (failure && failure.at === input.sectionIndex) return failure.outcome;
      return { ok: true, content: `Body for ${input.section.heading}.\n\nSecond paragraph.` };
    },
  };
  return { calls, dependencies };
}

function makeContext() {
  const calls: WriterContextInput[] = [];
  const dependencies: WriterContextDependencies = {
    async getKnowledge(input) {
      calls.push(input);
      return { status: 'available', note: null, chunks: [{ sourceId: 'kb1', title: 'KB', text: 'kb text' }] };
    },
    async getExistingContent() {
      return { status: 'empty', note: null, items: [] };
    },
    async getIntelligence() {
      return { status: 'not_configured', note: 'no dfs', keywords: [] };
    },
  };
  return { calls, dependencies };
}

function makePersistence() {
  const created: Array<{ projectId: string; userId: string | null; input: ContentInput }> = [];
  const updated: Array<{ id: string; input: Partial<ContentInput> }> = [];
  const port: WriterPersistence = {
    async create(projectId, userId, input) {
      created.push({ projectId, userId, input });
      return { id: 'content-1', title: input.title, slug: 'blue-widgets-explained', content_json: input.contentJson };
    },
    async update(_projectId, _userId, id, input) {
      updated.push({ id, input });
      return { id, title: input.title, slug: 'blue-widgets-explained', content_json: input.contentJson };
    },
  };
  return { created, updated, port };
}

function makeDeps(overrides: Partial<WriterEngineDependencies> = {}): WriterEngineDependencies {
  return {
    planner: makePlanner(makePlan(3)).dependencies,
    sectionWriter: makeSectionWriter().dependencies,
    review: DEFAULT_WRITER_REVIEW_DEPENDENCIES,
    context: makeContext().dependencies,
    content: makePersistence().port,
    ...overrides,
  };
}

function makeDeep() {
  let bridges: Array<{ sectionIndex: number; text: string }> = [];
  const sectionPlans: WriterSectionPlanInput[] = [];
  const paragraphs: WriterParagraphInput[] = [];
  const refinements: WriterParagraphRefineInput[] = [];
  const coherence: WriterCoherenceInput[] = [];
  const dependencies: DeepWriteDependencies = {
    sectionPlanner: {
      async planSection(input) {
        sectionPlans.push(input);
        return { ok: true, intents: ['Lead with the answer', 'Add supporting detail'] };
      },
    },
    paragraphWriter: {
      async writeParagraph(input) {
        paragraphs.push(input);
        return { ok: true, content: `${input.section.heading} paragraph ${input.paragraphIndex + 1} body.` };
      },
    },
    paragraphRefiner: {
      async refineParagraph(input) {
        refinements.push(input);
        return { ok: true, content: `Refined: ${input.paragraph}` };
      },
    },
    coherence: {
      async planBridges(input) {
        coherence.push(input);
        return { ok: true, bridges };
      },
    },
  };
  return {
    sectionPlans,
    paragraphs,
    refinements,
    coherence,
    dependencies,
    setBridges: (value: Array<{ sectionIndex: number; text: string }>) => {
      bridges = value;
    },
  };
}

describe('runWriterEngine quick draft', () => {
  it('plans once, writes each section in order and persists a canonical draft', async () => {
    const planner = makePlanner(makePlan(3));
    const sectionWriter = makeSectionWriter();
    const persistence = makePersistence();
    const context = makeContext();
    const stages: string[] = [];

    const result = await runWriterEngine(makeInput(), {
      planner: planner.dependencies,
      sectionWriter: sectionWriter.dependencies,
      review: DEFAULT_WRITER_REVIEW_DEPENDENCIES,
      context: context.dependencies,
      content: persistence.port,
    }, { userId: 'user-1', onStage: (label) => { stages.push(label); } });

    expect(planner.inputs).toHaveLength(1);
    expect(planner.inputs[0]!.formatGuidance).toContain('short article');
    expect(sectionWriter.calls.map((call) => call.sectionIndex)).toEqual([0, 1, 2]);
    expect(sectionWriter.calls[1]!.previousSectionContent).toContain('Section 1');
    expect(persistence.created).toHaveLength(1);
    expect(persistence.created[0]!.userId).toBe('user-1');
    expect(persistence.created[0]!.projectId).toBe(PROJECT);
    const persisted = persistence.created[0]!.input.contentJson as { type: string };
    expect(persisted.type).toBe('doc');
    expect(result.sectionCount).toBe(3);
    expect(result.contentId).toBe('content-1');
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.seoScore).toBeGreaterThanOrEqual(0);
    expect(result.plan.sections).toHaveLength(3);
    expect(result.plan.primaryKeyword).toBe('blue widgets');
    expect(stages).toContain('outline');
    expect(stages).toContain('persist');
  });

  it('gathers project-scoped context and carries the opportunity briefing as untrusted data', async () => {
    const planner = makePlanner(makePlan(3));
    const context = makeContext();

    await runWriterEngine(
      makeInput({
        opportunityContext: {
          topic: 'Blue widgets',
          description: 'Widgets for buyers',
          primaryKeyword: 'blue widgets',
          keywords: [{ keyword: 'blue widgets', volume: 2400 }],
          competitors: [{ domain: 'rival.com', rank: 3 }],
          opportunityScore: 78,
          reasons: ['high_volume', 'low_difficulty'],
          difficulty: 53,
          intent: 'commercial',
          knowledgeReadiness: 'moderate',
        },
      }),
      makeDeps({ planner: planner.dependencies, context: context.dependencies }),
    );

    expect(context.calls[0]).toEqual({ projectId: PROJECT, topic: 'Blue widgets', targetKeyword: 'blue widgets' });
    const chunks = planner.inputs[0]!.context.knowledge.chunks;
    expect(chunks[0]!.sourceId).toBe('opportunity');
    expect(chunks[0]!.trust).toBe('untrusted');
    expect(chunks[0]!.text).toContain('Opportunity score: 78/100');
    expect(chunks[0]!.text).toContain('Keyword difficulty: 53/100');
    expect(chunks[0]!.text).toContain('Search intent: commercial');
    expect(chunks[0]!.text).toContain('Why this opportunity: high volume, low difficulty');
    expect(chunks[1]!.sourceId).toBe('kb1');
  });

  it('fails honestly and writes nothing when AI is not configured', async () => {
    const sectionWriter = makeSectionWriter();
    const persistence = makePersistence();
    const planner = makePlanner(makePlan(3), {
      ok: false,
      code: 'not_configured',
      note: 'Project AI is not configured.',
    });

    await expect(
      runWriterEngine(makeInput(), makeDeps({
        planner: planner.dependencies,
        sectionWriter: sectionWriter.dependencies,
        content: persistence.port,
      })),
    ).rejects.toMatchObject({ code: 'not_configured', status: 503 });

    expect(sectionWriter.calls).toHaveLength(0);
    expect(persistence.created).toHaveLength(0);
  });

  it('fails honestly and writes nothing when a section call errors', async () => {
    const persistence = makePersistence();
    const sectionWriter = makeSectionWriter({
      at: 1,
      outcome: { ok: false, code: 'ai_error', note: 'provider exploded' },
    });

    await expect(
      runWriterEngine(makeInput(), makeDeps({
        sectionWriter: sectionWriter.dependencies,
        content: persistence.port,
      })),
    ).rejects.toMatchObject({ code: 'provider_error', status: 502 });

    expect(sectionWriter.calls).toHaveLength(2);
    expect(persistence.created).toHaveLength(0);
  });

  it('rejects a plan that does not match the format before writing any section', async () => {
    const sectionWriter = makeSectionWriter();
    const persistence = makePersistence();
    const planner = makePlanner(makePlan(2));

    await expect(
      runWriterEngine(makeInput(), makeDeps({
        planner: planner.dependencies,
        sectionWriter: sectionWriter.dependencies,
        content: persistence.port,
      })),
    ).rejects.toMatchObject({ code: 'agent_invalid_output', status: 422 });

    expect(sectionWriter.calls).toHaveLength(0);
    expect(persistence.created).toHaveLength(0);
  });

  it('updates an existing draft instead of creating a second one', async () => {
    const persistence = makePersistence();

    const result = await runWriterEngine(
      makeInput({ contentId: 'existing-content' }),
      makeDeps({ content: persistence.port }),
    );

    expect(persistence.created).toHaveLength(0);
    expect(persistence.updated).toHaveLength(1);
    expect(persistence.updated[0]!.id).toBe('existing-content');
    expect(result.contentId).toBe('existing-content');
  });

  it('records a bounded pass trace on a quick draft run', async () => {
    const result = await runWriterEngine(makeInput(), makeDeps());

    const kinds = result.passes.map((pass) => pass.kind);
    expect(kinds).toContain('context');
    expect(kinds).toContain('architecture');
    expect(kinds).toContain('section_generation');
    expect(kinds).toContain('editorial_validation');
    expect(kinds).toContain('persist');
    expect(result.passes.every((pass) => pass.durationMs >= 0)).toBe(true);
  });

  it('exposes a compact run summary derived from the executed passes', async () => {
    const result = await runWriterEngine(makeInput(), makeDeps());

    expect(result.summary.mode).toBe('quick_draft');
    expect(result.summary.format).toBe('short_article');
    expect(result.summary.pass_count).toBe(result.passes.length);
    // Quick Draft: one architecture call plus one section call per section.
    expect(result.summary.llm_calls).toBe(1 + 3);
    expect(result.summary.by_kind.section_generation).toBe(3);
    expect(result.summary.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.summary.failed_pass).toBeUndefined();
  });

  it('attaches a compact failure summary to the thrown error', async () => {
    const sectionWriter = makeSectionWriter({
      at: 1,
      outcome: { ok: false, code: 'ai_error', note: 'provider exploded' },
    });
    let caught: unknown;
    try {
      await runWriterEngine(makeInput(), makeDeps({ sectionWriter: sectionWriter.dependencies }));
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ code: 'provider_error' });
    const summary = (caught as { writerSummary?: { failed_pass?: string; pass_count: number; llm_calls: number } })
      .writerSummary;
    expect(summary?.failed_pass).toBe('section_generation');
    expect(summary?.pass_count).toBeGreaterThan(0);
    // Architecture, the first section, and the failing second section each made
    // a real call - the failed attempt is still counted.
    expect(summary?.llm_calls).toBe(3);
  });
});

describe('runWriterEngine deep write', () => {
  it('runs hierarchical passes in order and persists one canonical draft', async () => {
    const planner = makePlanner(makePlan(3));
    const persistence = makePersistence();
    const deep = makeDeep();
    const stages: string[] = [];

    const result = await runWriterEngine(
      makeInput({ mode: 'deep_write' }),
      makeDeps({ planner: planner.dependencies, content: persistence.port, deep: deep.dependencies }),
      { userId: 'user-1', onStage: (label) => { stages.push(label); } },
    );

    expect(planner.inputs).toHaveLength(1);
    expect(deep.sectionPlans.map((call) => call.sectionIndex)).toEqual([0, 1, 2]);
    expect(deep.paragraphs).toHaveLength(6);
    expect(deep.paragraphs.map((call) => call.sectionIndex)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(deep.refinements).toHaveLength(3);
    expect(deep.coherence).toHaveLength(1);
    expect(persistence.created).toHaveLength(1);

    const persisted = persistence.created[0]!.input.contentJson as { type: string };
    expect(persisted.type).toBe('doc');
    expect(result.mode).toBe('deep_write');
    expect(result.sectionCount).toBe(3);
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.seoScore).toBeGreaterThanOrEqual(0);

    const kinds = result.passes.map((pass) => pass.kind);
    expect(kinds).toContain('context');
    expect(kinds).toContain('architecture');
    expect(kinds).toContain('section_planning');
    expect(kinds).toContain('section_generation');
    expect(kinds).toContain('paragraph_refinement');
    expect(kinds).toContain('coherence');
    expect(kinds).toContain('editorial_validation');
    expect(kinds).toContain('persist');
    expect(stages).toContain('coherence');
    // Deep Write uses its own bounded call accounting: architecture 1 +
    // section planning 3 + paragraph writing 6 + refinement 3 + coherence 1.
    expect(result.summary.mode).toBe('deep_write');
    expect(result.summary.llm_calls).toBe(14);
    expect(result.summary.failed_pass).toBeUndefined();
  });

  it('carries each pass identity/brief but never the projectId into the pass input', async () => {
    const deep = makeDeep();
    await runWriterEngine(
      makeInput({ mode: 'deep_write' }),
      makeDeps({ deep: deep.dependencies }),
    );

    for (const call of [...deep.sectionPlans, ...deep.paragraphs, ...deep.refinements, ...deep.coherence]) {
      expect(call.projectId).toBe(PROJECT);
      expect(call.articleTitle).toBe('Blue widgets explained');
      expect(call.targetKeyword).toBe('blue widgets');
    }
  });

  it('fails honestly when deep_write is selected but not wired', async () => {
    await expect(
      runWriterEngine(makeInput({ mode: 'deep_write' }), makeDeps({ content: makePersistence().port })),
    ).rejects.toMatchObject({ code: 'internal_error', status: 500 });
  });
});

describe('parseWriterInput', () => {
  it('applies the quick_draft / short_article defaults and bounds the input', () => {
    const parsed = parseWriterInput({
      projectId: PROJECT,
      topic: { name: '  Blue widgets  ', description: '' },
      primaryKeyword: 'blue widgets',
      relatedKeywords: [{ keyword: 'blue widgets', volume: 2400 }],
      opportunityContext: {
        topic: 'Blue widgets',
        description: 'Widgets',
        keywords: [{ keyword: 'blue widgets', volume: 2400 }],
        competitors: [{ domain: 'rival.com', rank: 3 }],
        opportunityScore: 78,
        reasons: ['high_volume'],
        difficulty: 53,
        intent: 'commercial',
      },
    });

    expect(parsed.format).toBe('short_article');
    expect(parsed.mode).toBe('quick_draft');
    expect(parsed.topic.name).toBe('Blue widgets');
    expect(parsed.relatedKeywords).toEqual([{ keyword: 'blue widgets', volume: 2400 }]);
    expect(parsed.opportunityContext?.opportunityScore).toBe(78);
    expect(parsed.opportunityContext?.reasons).toEqual(['high_volume']);
    expect(parsed.opportunityContext?.difficulty).toBe(53);
    expect(parsed.opportunityContext?.intent).toBe('commercial');
  });

  it('fails closed on an unknown format or execution mode', () => {
    expect(() => parseWriterInput({
      projectId: PROJECT,
      topic: { name: 'Blue widgets', description: '' },
      format: 'listicle',
    })).toThrow(ApiError);

    expect(() => parseWriterInput({
      projectId: PROJECT,
      topic: { name: 'Blue widgets', description: '' },
      mode: 'turbo_write',
    })).toThrow(ApiError);
  });

  it('accepts the deep_write execution profile', () => {
    const parsed = parseWriterInput({
      projectId: PROJECT,
      topic: { name: 'Blue widgets', description: '' },
      mode: 'deep_write',
    });
    expect(parsed.mode).toBe('deep_write');
  });

  it('rejects a missing topic name and an unparseable body', () => {
    expect(() => parseWriterInput({ projectId: PROJECT, topic: { description: 'x' } })).toThrow(ApiError);
    expect(() => parseWriterInput(null)).toThrow(ApiError);
  });
});

describe('planToArticlePlan', () => {
  it('projects the internal plan into the bounded contract shape', () => {
    const projected: ArticlePlan = planToArticlePlan(makePlan(3), makeInput());
    expect(projected.title).toBe('Blue widgets explained');
    expect(projected.intent).toBe('Frame the topic and the primary keyword.');
    expect(projected.primaryKeyword).toBe('blue widgets');
    expect(projected.format).toBe('short_article');
    expect(projected.sections[0]).toEqual({ heading: 'Section 1', purpose: 'point 1', keywords: ['kw1'] });
  });
});
