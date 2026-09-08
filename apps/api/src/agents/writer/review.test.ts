/**
 * Writer Agent W5 tests: deterministic review and canonical content assembly.
 *
 * The W5 phase turns a fully written run into ONE canonical Content Studio
 * document (approved title as H1, approved sections strictly in plan order,
 * written bodies split into clean paragraphs), renders content_html through
 * the existing canonical renderer and scores it with the existing Phase C SEO
 * evaluator - no AI call, no invented score, no persistence. These tests pin
 * the assembly invariants (plan order is authoritative, writtenSections order
 * is never trusted, missing/extra/duplicate/invalid sections fail honestly),
 * the deterministic delegation to the existing evaluator/renderer and the
 * graph-level no-side-effect completion (no ContentService, no job, no
 * publication, no AI provider anywhere in the phase).
 */

import { describe, expect, it } from 'vitest';
import { evaluateSeo, renderDocHtml, type SeoResult, type TipDoc } from '@seo/contracts';
import {
  DEFAULT_WRITER_REVIEW_DEPENDENCIES,
  assembleReviewDocument,
  contentParagraphs,
  reviewWriterContent,
  type WriterReviewDependencies,
} from './review.js';
import {
  createWriterRunRegistry,
  resumeWriterRun,
  runWriterOnce,
  writerSectionIdFor,
  type WriterPlan,
  type WriterRunRequest,
  type WriterSectionDependencies,
  type WriterSectionInput,
} from './index.js';

const projectId = 'c00162dd-d23e-4904-85ca-76cccc6d8c90';

function plan(overrides: Partial<WriterPlan> = {}): WriterPlan {
  return {
    title: 'Running SEO content ops on LangGraph',
    metaDescription: 'How to orchestrate SEO content operations with LangGraph.',
    introductionPurpose: 'Frame why teams automate content operations.',
    sections: [
      { heading: 'Why LangGraph fits content ops', keyPoints: ['durable orchestration'], suggestedKeywords: [] },
      { heading: 'A minimal pipeline', keyPoints: ['one graph per run'], suggestedKeywords: [] },
      { heading: 'Operating cadence', keyPoints: ['steady beats bursts'], suggestedKeywords: [] },
    ],
    ...overrides,
  };
}

function written(plan: WriterPlan, contents: Record<number, string>): { sectionId: string; content: string }[] {
  return Object.entries(contents).map(([index, content]) => ({
    sectionId: writerSectionIdFor(Number(index)),
    content,
  }));
}

const cannedSeo: SeoResult = {
  score: 42,
  keyword: 'seo ops',
  checks: [
    {
      code: 'has_content',
      category: 'Content',
      label: 'Content',
      status: 'pass',
      points: 4,
      maxPoints: 4,
      detail: 'test',
    },
  ],
  stats: {
    words: 10,
    headings: 2,
    h1: 1,
    h2: 1,
    paragraphs: 1,
    links: 0,
    longParagraphs: 0,
    images: 0,
    imagesMissingAlt: 0,
  },
};

function recordingDeps(overrides: Partial<WriterReviewDependencies> = {}): {
  deps: WriterReviewDependencies;
  evaluateInputs: unknown[];
  renderInputs: unknown[];
} {
  const evaluateInputs: unknown[] = [];
  const renderInputs: unknown[] = [];
  return {
    evaluateInputs,
    renderInputs,
    deps: {
      evaluate: (input) => {
        evaluateInputs.push(input);
        return overrides.evaluate ? (overrides.evaluate(input) as SeoResult) : cannedSeo;
      },
      renderHtml: (doc) => {
        renderInputs.push(doc);
        if (overrides.renderHtml) return overrides.renderHtml(doc);
        return '<article>canonical html</article>';
      },
    },
  };
}

function okSectionWriter(): WriterSectionDependencies {
  return {
    async writeSection(input: WriterSectionInput) {
      return { ok: true, content: `Body for ${input.section.heading}.` };
    },
  };
}

describe('contentParagraphs', () => {
  it('splits a body on blank lines, collapses stray whitespace and drops empties', () => {
    expect(contentParagraphs('Lead line.\n\nSecond  para   with   spaces.\n\n\nTrailing.')).toEqual([
      'Lead line.',
      'Second para with spaces.',
      'Trailing.',
    ]);
    expect(contentParagraphs('Single paragraph, single line breaks\nkept joined.')).toEqual([
      'Single paragraph, single line breaks kept joined.',
    ]);
    expect(contentParagraphs('   \n\n  ')).toEqual([]);
  });
});

describe('assembleReviewDocument', () => {
  it('builds one canonical doc: approved title as H1 then plan sections in order', () => {
    const p = plan();
    const sections = written(p, {
      1: 'Pipeline body.\n\nSecond pipeline paragraph.',
      0: 'Why body.',
      2: 'Cadence body.',
    });

    const assembled = assembleReviewDocument(p, sections);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;

    const { doc } = assembled;
    expect(doc.type).toBe('doc');
    const headingTexts = (doc.content ?? [])
      .filter((n) => n.type === 'heading')
      .map((n) => (n.content?.[0] as { text?: string } | undefined)?.text);
    expect(headingTexts).toEqual([
      p.title,
      p.sections[0].heading,
      p.sections[1].heading,
      p.sections[2].heading,
    ]);
    const levels = (doc.content ?? [])
      .filter((n) => n.type === 'heading')
      .map((n) => (n.attrs as { level?: number }).level);
    expect(levels).toEqual([1, 2, 2, 2]);
    const paragraphTexts = (doc.content ?? [])
      .filter((n) => n.type === 'paragraph')
      .map((n) => (n.content?.[0] as { text?: string } | undefined)?.text);
    expect(paragraphTexts).toEqual(['Why body.', 'Pipeline body.', 'Second pipeline paragraph.', 'Cadence body.']);
    expect(docHeadingsVia(doc).map((h) => h.text)).toEqual([
      p.title,
      p.sections[0].heading,
      p.sections[1].heading,
      p.sections[2].heading,
    ]);
  });

  it('order invariant: writtenSections order is never trusted', () => {
    const p = plan();
    const sections = written(p, { 2: 'C.', 0: 'A.', 1: 'B.' });
    const assembled = assembleReviewDocument(p, sections);
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    const texts = (assembled.doc.content ?? [])
      .filter((n) => n.type === 'paragraph')
      .map((n) => (n.content?.[0] as { text?: string } | undefined)?.text);
    expect(texts).toEqual(['A.', 'B.', 'C.']);
  });

  it('fails honestly when a planned section was never written', () => {
    const p = plan();
    const outcome = assembleReviewDocument(p, written(p, { 0: 'A.', 1: 'B.' }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('missing_section');
    expect(outcome.note).toContain('section_2');
  });

  it('fails honestly on an unknown extra section', () => {
    const p = plan();
    const sections = [...written(p, { 0: 'A.', 1: 'B.', 2: 'C.' }), { sectionId: 'section_9', content: 'Rogue.' }];
    const outcome = assembleReviewDocument(p, sections);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('extra_section');
  });

  it('fails honestly on a duplicate section', () => {
    const p = plan();
    const sections = [...written(p, { 0: 'A.', 1: 'B.', 2: 'C.' }), { sectionId: writerSectionIdFor(1), content: 'Again.' }];
    const outcome = assembleReviewDocument(p, sections);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('extra_section');
    expect(outcome.note).toContain('more than once');
  });

  it('fails honestly on invalid section content', () => {
    const p = plan();
    const outcome = assembleReviewDocument(p, written(p, { 0: 'A.', 1: '', 2: 'C.' }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('invalid_content');
  });
});

function docHeadingsVia(doc: TipDoc): { level: number; text: string }[] {
  return (doc.content ?? [])
    .filter((n) => n.type === 'heading')
    .map((n) => ({
      level: (n.attrs as { level?: number }).level ?? 0,
      text: (n.content?.[0] as { text?: string } | undefined)?.text ?? '',
    }));
}

describe('reviewWriterContent', () => {
  it('delegates to the injected evaluator and renderer and returns the canonical artifact', () => {
    const p = plan();
    const { deps, evaluateInputs, renderInputs } = recordingDeps();
    const outcome = reviewWriterContent(deps, {
      plan: p,
      writtenSections: written(p, { 0: 'A.', 1: 'B.', 2: 'C.' }),
      targetKeyword: 'seo ops',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(renderInputs).toHaveLength(1);
    expect(evaluateInputs).toHaveLength(1);
    expect(outcome.review.contentJson.type).toBe('doc');
    expect(outcome.review.contentHtml).toBe('<article>canonical html</article>');
    expect(outcome.review.seo).toEqual(cannedSeo);
    expect(evaluateInputs[0]).toMatchObject({
      meta: { title: p.title, targetKeyword: 'seo ops', metaTitle: null, metaDescription: p.metaDescription },
    });
  });

  it('uses the real canonical pipeline deterministically (no AI, no invented score)', () => {
    const p = plan();
    const outcome = reviewWriterContent(DEFAULT_WRITER_REVIEW_DEPENDENCIES, {
      plan: p,
      writtenSections: written(p, { 0: 'A body about orchestration with enough words.', 1: 'B.', 2: 'C.' }),
      targetKeyword: 'content ops',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const expected = evaluateSeo({
      doc: outcome.review.contentJson,
      meta: { title: p.title, targetKeyword: 'content ops', metaTitle: null, metaDescription: p.metaDescription },
    });
    expect(outcome.review.seo).toEqual(expected);
    expect(outcome.review.seo.score).toBeTypeOf('number');
    expect(outcome.review.seo.checks.length).toBeGreaterThan(0);
    expect(renderDocHtml(outcome.review.contentJson)).toBe(outcome.review.contentHtml);
  });

  it('propagates the assembled failure codes honestly', () => {
    const p = plan();
    const missing = reviewWriterContent(DEFAULT_WRITER_REVIEW_DEPENDENCIES, {
      plan: p,
      writtenSections: written(p, { 0: 'A.', 1: 'B.' }),
      targetKeyword: null,
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe('missing_section');

    const extra = reviewWriterContent(DEFAULT_WRITER_REVIEW_DEPENDENCIES, {
      plan: p,
      writtenSections: [...written(p, { 0: 'A.', 1: 'B.', 2: 'C.' }), { sectionId: 'section_5', content: 'X.' }],
      targetKeyword: null,
    });
    expect(extra.ok).toBe(false);
    if (extra.ok) return;
    expect(extra.code).toBe('extra_section');
  });

  it('degrades to render_failed when the renderer throws', () => {
    const p = plan();
    const { deps } = recordingDeps({ renderHtml: () => { throw new Error('render boom'); } });
    const outcome = reviewWriterContent(deps, {
      plan: p,
      writtenSections: written(p, { 0: 'A.', 1: 'B.', 2: 'C.' }),
      targetKeyword: null,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('render_failed');
  });

  it('degrades to evaluate_failed when the evaluator throws', () => {
    const p = plan();
    const { deps } = recordingDeps({ evaluate: () => { throw new Error('eval boom'); } });
    const outcome = reviewWriterContent(deps, {
      plan: p,
      writtenSections: written(p, { 0: 'A.', 1: 'B.', 2: 'C.' }),
      targetKeyword: null,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('evaluate_failed');
  });
});

describe('W5 graph completion', () => {
  it('completes a fully written run through the injected deterministic review', async () => {
    const registry = createWriterRunRegistry();
    const { deps, evaluateInputs } = recordingDeps();
    const p = plan();
    const run = await runWriterOnce(
      startRequest(),
      { planner: { plan: async () => ({ ok: true as const, plan: p }) }, sectionWriter: okSectionWriter(), review: deps },
      registry,
    );
    expect(run.status).toBe('awaiting_approval');

    const resumed = await resumeWriterRun({ runId: run.runId, decision: { decision: 'approve' } }, registry);

    expect(resumed.status).toBe('completed');
    expect(resumed.reviewStatus).toBe('completed');
    expect(resumed.reviewNote).toBeNull();
    expect(resumed.review?.seo).toEqual(cannedSeo);
    expect(resumed.review?.contentJson.type).toBe('doc');
    expect(evaluateInputs).toHaveLength(1);
  });

  it('completes with the real deterministic score when no review allowlist is injected', async () => {
    const registry = createWriterRunRegistry();
    const p = plan();
    const run = await runWriterOnce(
      startRequest(),
      { planner: { plan: async () => ({ ok: true as const, plan: p }) }, sectionWriter: okSectionWriter() },
      registry,
    );
    const resumed = await resumeWriterRun({ runId: run.runId, decision: { decision: 'approve' } }, registry);

    expect(resumed.status).toBe('completed');
    expect(resumed.reviewStatus).toBe('completed');
    expect(resumed.review).not.toBeNull();
    const expected = evaluateSeo({
      doc: resumed.review!.contentJson,
      meta: { title: p.title, targetKeyword: null, metaTitle: null, metaDescription: p.metaDescription },
    });
    expect(resumed.review!.seo).toEqual(expected);
    expect(resumed.review!.contentHtml).toContain('<h1>');
  });

  it('never calls ContentService, jobs or the publisher: only the injected allowlists run', async () => {
    // The run has no database, job, scheduler or publication dependency anywhere:
    // it completes purely from the context/planner/section-writer/review
    // allowlists. If any hidden side effect existed, it would have to be wired
    // and would fail here.
    const registry = createWriterRunRegistry();
    const p = plan();
    const run = await runWriterOnce(
      startRequest(),
      {
        planner: { plan: async () => ({ ok: true as const, plan: p }) },
        sectionWriter: okSectionWriter(),
        review: DEFAULT_WRITER_REVIEW_DEPENDENCIES,
      },
      registry,
    );
    const resumed = await resumeWriterRun({ runId: run.runId, decision: { decision: 'approve' } }, registry);
    expect(resumed.status).toBe('completed');
    expect(resumed.reviewStatus).toBe('completed');
    expect(resumed.plan).toEqual(p);
  });
});

function startRequest(): WriterRunRequest {
  return { projectId, requestId: 'req-review', topic: 'SEO content ops with LangGraph' };
}
