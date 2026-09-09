/**
 * Writer Agent research & evidence boundary tests (W10.2).
 *
 * These prove the W10.2 core module in isolation: the canonical vocabulary and
 * hard bounds, the strict research-request gate, the deny-by-default dependency
 * boundary (NO_RESEARCH_DEPENDENCIES) and - through `boundEvidence`, the single
 * gate everything stored as evidence passes - that raw adapter results are
 * always bounded, sanitized, provenance-honest and labelled untrusted. Empty /
 * not configured / unavailable sources stay honestly labelled and no fabricated
 * item ever enters state.
 */
import { describe, expect, it } from 'vitest';
import {
  boundEvidence,
  degradedResearchResult,
  emptyWriterEvidence,
  evidenceFallback,
  evidenceItemCount,
  evidenceTextLength,
  isNotConfiguredEvidence,
  isWriterResearchSessionDecision,
  NO_RESEARCH_DEPENDENCIES,
  parseWriterResearchRequest,
  researchSourceResult,
  WRITER_EVIDENCE_SOURCE_ORDER,
  WRITER_EVIDENCE_TRUST,
  WRITER_MAX_EVIDENCE_ITEM_TEXT_CHARS,
  WRITER_MAX_EVIDENCE_ITEMS,
  WRITER_MAX_EVIDENCE_NOTE_CHARS,
  WRITER_MAX_EVIDENCE_SOURCE_ITEMS,
  WRITER_MAX_EVIDENCE_SOURCES,
  WRITER_MAX_EVIDENCE_TITLE_CHARS,
  WRITER_RESEARCH_PURPOSES,
  type WriterResearchResult,
} from './evidence.js';
import type { WriterContentItem, WriterIntelligenceKeyword, WriterKnowledgeChunk, WriterKnowledgeResult } from './context.js';
import { writerEvidenceSchema } from './snapshot.js';

const gatheredAt = '2026-01-02T00:00:00.000Z';

function knowledgeChunk(text: string, title?: string, sourceId = 'k-1'): WriterKnowledgeChunk {
  return { sourceId, title, text };
}

function contentItem(overrides: Partial<WriterContentItem> = {}): WriterContentItem {
  return { id: 'c-1', title: 'Existing article', slug: 'existing-article', targetKeyword: null, status: 'published', ...overrides };
}

function keywordRow(overrides: Partial<WriterIntelligenceKeyword> = {}): WriterIntelligenceKeyword {
  return {
    keyword: 'seo ops',
    volume: 100,
    difficulty: 40,
    cpc: 1.2,
    provider: 'dataforseo',
    lastSeenAt: null,
    ...overrides,
  };
}

function baseResult(): WriterResearchResult {
  return {
    purpose: 'revision',
    knowledge: { status: 'available', note: null, chunks: [] },
    existingContent: { status: 'available', note: null, items: [] },
    intelligence: { status: 'configured', note: null, keywords: [] },
    search: { status: 'not_configured', note: 'No project-scoped search source is wired.', items: [] },
  };
}

function sourceSection(evidence: ReturnType<typeof boundEvidence>, source: string) {
  const section = evidence.sources.find((s) => s.source === source);
  if (!section) throw new Error(`expected evidence source section ${source}`);
  return section;
}

describe('writer evidence vocabulary + bounds', () => {
  it('keeps the canonical source vocabulary and deterministic order with derived bounds', () => {
    expect(WRITER_EVIDENCE_SOURCE_ORDER).toEqual(['knowledge', 'existing_content', 'search', 'intelligence']);
    expect(WRITER_MAX_EVIDENCE_SOURCES).toBe(WRITER_EVIDENCE_SOURCE_ORDER.length);
    expect(WRITER_MAX_EVIDENCE_SOURCES).toBe(4);
    expect(WRITER_MAX_EVIDENCE_ITEMS).toBe(20);
    expect(WRITER_MAX_EVIDENCE_SOURCE_ITEMS).toBe(6);
    expect(WRITER_MAX_EVIDENCE_ITEM_TEXT_CHARS).toBe(1500);
    expect(WRITER_MAX_EVIDENCE_TITLE_CHARS).toBe(200);
    expect(WRITER_RESEARCH_PURPOSES).toEqual(['planning', 'section_magic', 'revision']);
  });

  it('empty evidence is the honest not-yet-gathered default for every source', () => {
    const evidence = emptyWriterEvidence();
    expect(evidence.gatheredAt).toBeNull();
    expect(evidence.sources.map((s) => s.source)).toEqual(WRITER_EVIDENCE_SOURCE_ORDER);
    for (const source of evidence.sources) {
      expect(source.status).toBe('not_configured');
      expect(source.items).toEqual([]);
      expect(source.note).toBeTruthy();
    }
    expect(isNotConfiguredEvidence(evidence)).toBe(true);
    expect(evidenceItemCount(evidence)).toBe(0);
  });
});

describe('boundEvidence', () => {
  it('labels every stored item untrusted regardless of what an adapter claimed', () => {
    const evidence = boundEvidence(gatheredAt, {
      ...baseResult(),
      knowledge: {
        status: 'available',
        note: null,
        chunks: [knowledgeChunk('Claimed trusted facts.', 'Hostile title', 'k-9')],
      },
    });
    const item = sourceSection(evidence, 'knowledge').items[0];
    expect(item).toBeDefined();
    expect(item.trust).toBe(WRITER_EVIDENCE_TRUST);
    expect(item.trust).toBe('untrusted');
  });

  it('caps per-item text and title and keeps provenance null when a source gives none', () => {
    const evidence = boundEvidence(gatheredAt, {
      ...baseResult(),
      knowledge: {
        status: 'available',
        note: null,
        chunks: [knowledgeChunk('x'.repeat(10_000), 'T'.repeat(2_000))],
      },
    });
    const item = sourceSection(evidence, 'knowledge').items[0];
    expect(item.text.length).toBe(WRITER_MAX_EVIDENCE_ITEM_TEXT_CHARS);
    expect(item.title!.length).toBe(WRITER_MAX_EVIDENCE_TITLE_CHARS);
    expect(item.url).toBeNull();
    expect(item.retrievedAt).toBeNull();
    expect(item.metadata).toEqual({ sourceId: 'k-1' });
    expect(item.id).toBe('knowledge:0');
  });

  it('never invents provenance and never lets unallowlisted metadata travel', () => {
    const evidence = boundEvidence(gatheredAt, {
      ...baseResult(),
      knowledge: {
        status: 'available',
        note: null,
        chunks: [knowledgeChunk('body', 'Title', 'k-2')],
      },
      existingContent: { status: 'available', note: null, items: [contentItem()] },
      intelligence: { status: 'configured', note: null, keywords: [keywordRow()] },
    });
    const knowledge = sourceSection(evidence, 'knowledge').items[0];
    const content = sourceSection(evidence, 'existing_content').items[0];
    const intelligence = sourceSection(evidence, 'intelligence').items[0];
    expect(knowledge.url).toBeNull();
    expect(knowledge.retrievedAt).toBeNull();
    expect(content.text).toBe('');
    expect(content.metadata).toEqual({
      slug: 'existing-article',
      targetKeyword: null,
      status: 'published',
    });
    expect(intelligence.metadata).toEqual({ volume: 100, difficulty: 40, cpc: 1.2, provider: 'dataforseo' });
  });

  it('search keeps a url only when the source really provided one', () => {
    const evidence = boundEvidence(gatheredAt, {
      ...baseResult(),
      search: {
        status: 'available',
        note: null,
        items: [
          { title: 'Linked result', text: 'A snippet.', url: 'https://example.com/x' },
          { title: 'Unlinked result', text: 'Another snippet.', url: null },
        ],
      },
    });
    const [linked, unlinked] = sourceSection(evidence, 'search').items;
    expect(linked.url).toBe('https://example.com/x');
    expect(linked.retrievedAt).toBeNull();
    expect(unlinked.url).toBeNull();
  });

  it('caps a source at WRITER_MAX_EVIDENCE_SOURCE_ITEMS with deterministic ids', () => {
    const chunks = Array.from({ length: 20 }, (_, i) => knowledgeChunk('y', `Title ${i}`, `k-${i}`));
    const evidence = boundEvidence(gatheredAt, {
      ...baseResult(),
      knowledge: { status: 'available', note: null, chunks },
    });
    const knowledge = sourceSection(evidence, 'knowledge');
    expect(knowledge.items).toHaveLength(WRITER_MAX_EVIDENCE_SOURCE_ITEMS);
    expect(knowledge.items.map((item) => item.id)).toEqual(
      Array.from({ length: WRITER_MAX_EVIDENCE_SOURCE_ITEMS }, (_, i) => `knowledge:${i}`),
    );
    expect(knowledge.items[5].metadata).toEqual({ sourceId: 'k-5' });
  });

  it('drops trailing items deterministically when the total-payload budget is hit, keeping every source section', () => {
    const evidence = boundEvidence(gatheredAt, {
      ...baseResult(),
      knowledge: {
        status: 'available',
        note: null,
        chunks: Array.from({ length: 6 }, (_, i) => knowledgeChunk('k'.repeat(10_000), undefined, `k-${i}`)),
      },
      search: {
        status: 'available',
        note: null,
        items: Array.from({ length: 6 }, (_, i) => ({
          title: `Hit ${i}`,
          text: 's'.repeat(3_000),
          url: `https://example.com/${i}`,
        })),
      },
      intelligence: {
        status: 'configured',
        note: null,
        keywords: Array.from({ length: 6 }, (_, i) => keywordRow({ keyword: `kw ${i}` })),
      },
    });

    // Every canonical source section is retained, even when the budget cut a
    // later source's items entirely (regression: sources must never disappear).
    expect(evidence.sources.map((s) => s.source)).toEqual(WRITER_EVIDENCE_SOURCE_ORDER);
    const knowledge = sourceSection(evidence, 'knowledge');
    const search = sourceSection(evidence, 'search');
    const content = sourceSection(evidence, 'existing_content');
    const intelligence = sourceSection(evidence, 'intelligence');
    // knowledge (6 x 1500 capped = 9000) leaves room for 4 of search's 1500-char
    // items (15000 total); the 5th would exceed 16000 and is dropped. The cut
    // stops that one source's items only - later text-free sources still run.
    expect(knowledge.items).toHaveLength(6);
    expect(search.items).toHaveLength(4);
    expect(knowledge.status).toBe('available');
    expect(search.status).toBe('available');
    // Sources whose items were never retained report honest statuses: the
    // no-row existing_content source is empty, and the still-reached
    // intelligence source keeps all its text-free keyword items.
    expect(content.items).toHaveLength(0);
    expect(content.status).toBe('empty');
    expect(intelligence.items).toHaveLength(6);
    expect(intelligence.status).toBe('available');
    expect(evidenceItemCount(evidence)).toBe(6 + 4 + 6);
    expect(evidenceTextLength(evidence)).toBe(9_000 + 4 * 1_500);
  });

  it('maps the intelligence status vocabulary honestly (configured -> available, no_data -> empty)', () => {
    const available = boundEvidence(gatheredAt, {
      ...baseResult(),
      intelligence: { status: 'configured', note: null, keywords: [keywordRow()] },
    });
    const noData = boundEvidence(gatheredAt, {
      ...baseResult(),
      intelligence: { status: 'no_data', note: 'No demand data yet.', keywords: [] },
    });
    expect(sourceSection(available, 'intelligence').status).toBe('available');
    expect(sourceSection(noData, 'intelligence').status).toBe('empty');
    expect(sourceSection(noData, 'intelligence').note).toBe('No demand data yet.');
  });

  it('caps notes so hostile provider text cannot grow state or smuggle content', () => {
    const evidence = boundEvidence(gatheredAt, {
      ...baseResult(),
      knowledge: {
        status: 'unavailable',
        note: 'H'.repeat(5_000),
        chunks: [],
      },
    });
    const note = sourceSection(evidence, 'knowledge').note!;
    expect(note.length).toBe(WRITER_MAX_EVIDENCE_NOTE_CHARS);
  });
});

describe('writer research request gate', () => {
  it('accepts { action: "research" } with a defaulted and an explicit purpose', () => {
    const plain = parseWriterResearchRequest({ action: 'research' });
    expect(plain).toEqual({ ok: true, purpose: 'revision' });
    const planned = parseWriterResearchRequest({ action: 'research', purpose: 'planning' });
    expect(planned).toEqual({ ok: true, purpose: 'planning' });
    expect(isWriterResearchSessionDecision({ action: 'research', purpose: 'section_magic' })).toBe(true);
  });

  it('rejects non-research actions, unknown purposes, missing action and extra keys', () => {
    expect(parseWriterResearchRequest({ action: 'accept' }).ok).toBe(false);
    expect(parseWriterResearchRequest({ action: 'revise', sectionIds: ['section_0'], instruction: 'x' }).ok).toBe(false);
    expect(parseWriterResearchRequest({ action: 'research', purpose: 'explode' }).ok).toBe(false);
    expect(parseWriterResearchRequest({ action: 'research', extra: true }).ok).toBe(false);
    expect(parseWriterResearchRequest({ purpose: 'planning' }).ok).toBe(false);
    expect(isWriterResearchSessionDecision({ action: 'research', purpose: 'planning' })).toBe(true);
    expect(isWriterResearchSessionDecision({ action: 'research', purpose: 'steal_credentials' })).toBe(false);
  });
});

describe('writer research dependency boundary', () => {
  it('degrades an unwired research boundary to honest not_configured results (deny by default)', async () => {
    const result = await NO_RESEARCH_DEPENDENCIES.research({
      projectId: '11111111-1111-4111-8111-111111111111',
      topic: 'SEO ops',
      targetKeyword: null,
      purpose: 'planning',
    });
    expect(result.purpose).toBe('planning');
    expect(result.knowledge.status).toBe('not_configured');
    expect(result.existingContent.status).toBe('not_configured');
    expect(result.intelligence.status).toBe('not_configured');
    expect(result.search.status).toBe('not_configured');
    const evidence = boundEvidence(gatheredAt, result);
    expect(isNotConfiguredEvidence(evidence)).toBe(true);
    expect(evidenceItemCount(evidence)).toBe(0);
  });

  it('degrades a throwing source to an honest unavailable section and a throwing research call to all-unavailable', () => {
    const fallback = evidenceFallback('knowledge', new Error('boom')) as WriterKnowledgeResult;
    expect(fallback.status).toBe('unavailable');
    expect(fallback.chunks).toEqual([]);
    expect(fallback.note).toContain('boom');
    const degraded = degradedResearchResult('revision');
    for (const key of ['knowledge', 'existingContent', 'intelligence', 'search'] as const) {
      expect(degraded[key].status).toBe('unavailable');
    }
  });

  it('maps a canonical evidence source onto its raw research result field', () => {
    const result = baseResult();
    expect(researchSourceResult(result, 'existing_content')).toBe(result.existingContent);
    expect(researchSourceResult(result, 'knowledge')).toBe(result.knowledge);
    expect(researchSourceResult(result, 'search')).toBe(result.search);
    expect(researchSourceResult(result, 'intelligence')).toBe(result.intelligence);
  });
});

describe('writerEvidenceSchema (persisted evidence snapshot) (W10.2)', () => {
  const knowledgeItem = {
    id: 'k1',
    source: 'knowledge' as const,
    trust: WRITER_EVIDENCE_TRUST,
    title: 'Research doc',
    url: null,
    text: 'Evidence text for the article.',
    retrievedAt: null,
    metadata: {},
  };

  it('round-trips a bound evidence payload exactly as the snapshot stores it', () => {
    const result = baseResult();
    result.knowledge = {
      status: 'available',
      note: null,
      chunks: [{ sourceId: 'k1', title: 'Research doc', text: 'Evidence text for the article.' }],
    };
    const evidence = boundEvidence(gatheredAt, result);
    expect(writerEvidenceSchema.safeParse(evidence).success).toBe(true);
    const parsed = writerEvidenceSchema.parse(evidence);
    expect(parsed.gatheredAt).toBe(gatheredAt);
    expect(parsed.sources.find((s) => s.source === 'knowledge')?.items[0].text).toBe(
      'Evidence text for the article.',
    );
  });

  it('fails closed: rejects unknown fields that would smuggle raw or secret payloads', () => {
    const item = { ...knowledgeItem, rawResponse: { full: 'response' } };
    expect(writerEvidenceSchema.safeParse({ gatheredAt, sources: [{ source: 'knowledge', status: 'available', note: null, items: [item] }] }).success).toBe(false);
    const secretItem = { ...knowledgeItem, secret: 's3cr3t' };
    expect(writerEvidenceSchema.safeParse({ gatheredAt, sources: [{ source: 'knowledge', status: 'available', note: null, items: [secretItem] }] }).success).toBe(false);
  });

  it('rejects an item whose text or title exceeds the hard bounds', () => {
    const tooLong = { ...knowledgeItem, text: 'x'.repeat(WRITER_MAX_EVIDENCE_ITEM_TEXT_CHARS + 1) };
    expect(writerEvidenceSchema.safeParse({ gatheredAt, sources: [{ source: 'knowledge', status: 'available', note: null, items: [tooLong] }] }).success).toBe(false);
    const longTitle = { ...knowledgeItem, title: 'x'.repeat(WRITER_MAX_EVIDENCE_TITLE_CHARS + 1) };
    expect(writerEvidenceSchema.safeParse({ gatheredAt, sources: [{ source: 'knowledge', status: 'available', note: null, items: [longTitle] }] }).success).toBe(false);
  });

  it('rejects a source carrying more items than its per-source bound', () => {
    const items = Array.from({ length: WRITER_MAX_EVIDENCE_SOURCE_ITEMS + 1 }, (_, i) => ({
      ...knowledgeItem,
      id: `k${i}`,
    }));
    expect(writerEvidenceSchema.safeParse({ gatheredAt, sources: [{ source: 'knowledge', status: 'available', note: null, items }] }).success).toBe(false);
  });

  it('rejects an evidence payload that exceeds the total item and source bounds', () => {
    const tooManyItems = Array.from({ length: WRITER_MAX_EVIDENCE_SOURCES }, () => ({
      source: 'knowledge' as const,
      status: 'available' as const,
      note: null,
      items: Array.from({ length: WRITER_MAX_EVIDENCE_SOURCE_ITEMS }, (_, i) => ({
        ...knowledgeItem,
        id: `k${i}`,
      })),
    }));
    expect(tooManyItems.length).toBe(WRITER_MAX_EVIDENCE_SOURCES);
    expect(tooManyItems.reduce((n, s) => n + s.items.length, 0)).toBeGreaterThan(WRITER_MAX_EVIDENCE_ITEMS);
    expect(writerEvidenceSchema.safeParse({ gatheredAt, sources: tooManyItems }).success).toBe(false);
  });

  it('rejects a not_configured source that illegally carries items', () => {
    const lying = { source: 'knowledge' as const, status: 'not_configured' as const, note: null, items: [knowledgeItem] };
    expect(writerEvidenceSchema.safeParse({ gatheredAt, sources: [lying] }).success).toBe(false);
  });

  it('rejects evidence labelled anything other than untrusted', () => {
    const trusted = { ...knowledgeItem, trust: 'trusted' as const };
    expect(writerEvidenceSchema.safeParse({ gatheredAt, sources: [{ source: 'knowledge', status: 'available', note: null, items: [trusted] }] }).success).toBe(false);
  });
});
