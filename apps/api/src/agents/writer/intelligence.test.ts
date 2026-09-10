/**
 * Writer Agent combined-intelligence boundary tests (W10.3).
 *
 * These prove the W10.3 core module in isolation: the canonical source /
 * finding-type / status vocabulary and hard bounds, the strict request and
 * session gates, the deny-by-default dependency boundary
 * (NO_INTELLIGENCE_DEPENDENCIES) and - through `boundIntelligence`, the single
 * gate everything stored as intelligence passes - that raw adapter readings are
 * always bounded, deduplicated, provenance-honest and labelled untrusted, with
 * empty / not configured / unavailable sources staying honestly labelled and no
 * fabricated finding ever entering state.
 */
import { describe, expect, it } from 'vitest';
import {
  boundIntelligence,
  degradedIntelligenceReading,
  emptyWriterIntelligence,
  intelligenceFindingCount,
  isNotConfiguredIntelligence,
  isWriterIntelligenceSessionDecision,
  NO_INTELLIGENCE_DEPENDENCIES,
  parseWriterIntelligenceRequest,
  WRITER_INTELLIGENCE_FINDING_TYPES,
  WRITER_INTELLIGENCE_PURPOSES,
  WRITER_INTELLIGENCE_SOURCE_ORDER,
  WRITER_INTELLIGENCE_SOURCES,
  WRITER_INTELLIGENCE_STATUSES,
  WRITER_INTELLIGENCE_TRUST,
  WRITER_MAX_INTELLIGENCE_EVIDENCE_IDS,
  WRITER_MAX_INTELLIGENCE_FINDINGS,
  WRITER_MAX_INTELLIGENCE_SOURCE_FINDINGS,
  WRITER_MAX_INTELLIGENCE_SOURCES,
  WRITER_MAX_INTELLIGENCE_SUMMARY_CHARS,
  type WriterIntelligenceReading,
  type WriterIntelligenceRawFinding,
  type WriterIntelligenceSourceReading,
} from './intelligence.js';
import { writerIntelligenceSchema } from './snapshot.js';

const gatheredAt = '2026-01-02T00:00:00.000Z';

function finding(overrides: Partial<WriterIntelligenceRawFinding> = {}): WriterIntelligenceRawFinding {
  return { type: 'keyword', summary: 'a signal', evidenceIds: [], ...overrides };
}

function section(overrides: Partial<WriterIntelligenceSourceReading> = {}): WriterIntelligenceSourceReading {
  return { status: 'empty', note: null, findings: [], ...overrides };
}

function reading(overrides: Partial<WriterIntelligenceReading> = {}): WriterIntelligenceReading {
  return {
    knowledge: section(),
    existingContent: section(),
    dataforseo: section(),
    gsc: section(),
    contentIntelligence: section(),
    ...overrides,
  };
}

function sourceSection(intelligence: ReturnType<typeof boundIntelligence>, source: string) {
  const found = intelligence.sources.find((s) => s.source === source);
  if (!found) throw new Error(`expected intelligence source section ${source}`);
  return found;
}

describe('writer intelligence vocabulary + bounds (W10.3)', () => {
  it('keeps the canonical source / finding-type / status vocabulary and derived bounds', () => {
    expect(WRITER_INTELLIGENCE_SOURCES).toEqual([
      'knowledge',
      'existing_content',
      'dataforseo',
      'gsc',
      'content_intelligence',
    ]);
    expect(WRITER_INTELLIGENCE_SOURCE_ORDER).toEqual([...WRITER_INTELLIGENCE_SOURCES]);
    expect(WRITER_MAX_INTELLIGENCE_SOURCES).toBe(5);
    expect(WRITER_INTELLIGENCE_FINDING_TYPES).toEqual(['keyword', 'opportunity', 'overlap', 'knowledge', 'content']);
    expect(WRITER_INTELLIGENCE_STATUSES).toEqual(['available', 'partial', 'empty', 'not_configured', 'unavailable']);
    expect(WRITER_INTELLIGENCE_PURPOSES).toEqual(['deep_research', 'planning', 'section_magic', 'revision']);
    expect(WRITER_MAX_INTELLIGENCE_SOURCE_FINDINGS).toBe(8);
    expect(WRITER_MAX_INTELLIGENCE_FINDINGS).toBe(20);
    expect(WRITER_MAX_INTELLIGENCE_EVIDENCE_IDS).toBe(6);
    expect(WRITER_MAX_INTELLIGENCE_SUMMARY_CHARS).toBe(500);
  });

  it('empty intelligence is the honest not-yet-gathered default for every source', () => {
    const intelligence = emptyWriterIntelligence();
    expect(intelligence.gatheredAt).toBeNull();
    expect(intelligence.status).toBe('not_configured');
    expect(intelligence.sources.map((s) => s.source)).toEqual(WRITER_INTELLIGENCE_SOURCE_ORDER);
    for (const source of intelligence.sources) {
      expect(source.status).toBe('not_configured');
      expect(source.findingCount).toBe(0);
    }
    expect(isNotConfiguredIntelligence(intelligence)).toBe(true);
    expect(intelligenceFindingCount(intelligence)).toBe(0);
  });
});

describe('boundIntelligence', () => {
  it('labels every stored finding untrusted regardless of what an adapter claimed', () => {
    const intelligence = boundIntelligence(
      gatheredAt,
      reading({
        knowledge: section({
          status: 'available',
          findings: [finding({ type: 'knowledge', summary: 'Trust me.', evidenceIds: ['k1'] })],
        }),
      }),
    );
    const stored = sourceSection(intelligence, 'knowledge');
    expect(stored.findingCount).toBe(1);
    const item = intelligence.findings[0];
    expect(item.trust).toBe(WRITER_INTELLIGENCE_TRUST);
    expect(item.trust).toBe('untrusted');
  });

  it('caps a source at the per-source finding bound with deterministic ids', () => {
    const many = Array.from({ length: 12 }, (_, i) => finding({ summary: `signal ${i}` }));
    const intelligence = boundIntelligence(
      gatheredAt,
      reading({ knowledge: section({ status: 'available', findings: many }) }),
    );
    expect(intelligence.findings).toHaveLength(WRITER_MAX_INTELLIGENCE_SOURCE_FINDINGS);
    expect(intelligence.findings.map((f) => f.id)).toEqual(
      Array.from({ length: 8 }, (_, i) => `knowledge:${i}`),
    );
  });

  it('hard-bounds the total finding count across all sources', () => {
    const eight = (prefix: string) =>
      Array.from({ length: 8 }, (_, i) => finding({ summary: `${prefix} ${i}` }));
    const intelligence = boundIntelligence(
      gatheredAt,
      reading({
        knowledge: section({ status: 'available', findings: eight('k') }),
        existingContent: section({ status: 'available', findings: eight('c') }),
        dataforseo: section({ status: 'available', findings: eight('d') }),
        gsc: section({ status: 'available', findings: eight('g') }),
        contentIntelligence: section({ status: 'available', findings: eight('i') }),
      }),
    );
    expect(intelligence.findings).toHaveLength(WRITER_MAX_INTELLIGENCE_FINDINGS);
    expect(sourceSection(intelligence, 'knowledge').findingCount).toBe(8);
    expect(sourceSection(intelligence, 'existing_content').findingCount).toBe(8);
    expect(sourceSection(intelligence, 'dataforseo').findingCount).toBe(4);
    expect(sourceSection(intelligence, 'gsc').findingCount).toBe(0);
    expect(sourceSection(intelligence, 'gsc').status).toBe('empty');
  });

  it('deduplicates summaries deterministically in canonical source order', () => {
    const intelligence = boundIntelligence(
      gatheredAt,
      reading({
        knowledge: section({ status: 'available', findings: [finding({ type: 'knowledge', summary: '  Same   SIGNAL ' })] }),
        dataforseo: section({ status: 'available', findings: [finding({ type: 'keyword', summary: 'same signal' })] }),
      }),
    );
    expect(intelligence.findings).toHaveLength(1);
    expect(intelligence.findings[0].id).toBe('knowledge:0');
    expect(sourceSection(intelligence, 'dataforseo').findingCount).toBe(0);
  });

  it('rewrites an available source whose findings were all dropped to honestly empty', () => {
    const intelligence = boundIntelligence(
      gatheredAt,
      reading({ knowledge: section({ status: 'available', findings: [finding({ summary: '   ' })] }) }),
    );
    const stored = sourceSection(intelligence, 'knowledge');
    expect(stored.status).toBe('empty');
    expect(stored.findingCount).toBe(0);
  });

  it('caps summary length and evidence references so hostile text cannot grow state', () => {
    const longSummary = 'x'.repeat(WRITER_MAX_INTELLIGENCE_SUMMARY_CHARS + 200);
    const ids = Array.from({ length: 20 }, (_, i) => `ref-${i}`);
    const intelligence = boundIntelligence(
      gatheredAt,
      reading({ gsc: section({ status: 'available', findings: [finding({ summary: longSummary, evidenceIds: ids })] }) }),
    );
    const item = intelligence.findings[0];
    expect(item.summary).toHaveLength(WRITER_MAX_INTELLIGENCE_SUMMARY_CHARS);
    expect(item.evidenceIds).toHaveLength(WRITER_MAX_INTELLIGENCE_EVIDENCE_IDS);
  });

  it('computes the honest overall status from the source sections', () => {
    const onlyFindings = reading({
      knowledge: section({ status: 'available', findings: [finding({ summary: 'fact' })] }),
    });
    expect(boundIntelligence(gatheredAt, onlyFindings).status).toBe('available');

    const degraded = reading({
      knowledge: section({ status: 'available', findings: [finding({ summary: 'fact' })] }),
      gsc: section({ status: 'not_configured', note: 'not wired' }),
    });
    expect(boundIntelligence(gatheredAt, degraded).status).toBe('partial');

    expect(boundIntelligence(gatheredAt, reading()).status).toBe('empty');

    const allNotConfigured = reading({
      knowledge: section({ status: 'not_configured' }),
      existingContent: section({ status: 'not_configured' }),
      dataforseo: section({ status: 'not_configured' }),
      gsc: section({ status: 'not_configured' }),
      contentIntelligence: section({ status: 'not_configured' }),
    });
    expect(boundIntelligence(gatheredAt, allNotConfigured).status).toBe('not_configured');

    const allUnavailable = reading({
      knowledge: section({ status: 'unavailable' }),
      existingContent: section({ status: 'unavailable' }),
      dataforseo: section({ status: 'unavailable' }),
      gsc: section({ status: 'unavailable' }),
      contentIntelligence: section({ status: 'unavailable' }),
    });
    expect(boundIntelligence(gatheredAt, allUnavailable).status).toBe('unavailable');
  });
});

describe('writer intelligence request gate (W10.3)', () => {
  it('accepts { purpose, focus?, sections? } using the bounded vocabulary', () => {
    expect(parseWriterIntelligenceRequest({ purpose: 'deep_research' })).toEqual({
      ok: true,
      request: { purpose: 'deep_research', focus: null, sections: [] },
    });
    expect(
      parseWriterIntelligenceRequest({ purpose: 'revision', focus: 'gap', sections: ['section_0', 'section_1'] }),
    ).toEqual({
      ok: true,
      request: { purpose: 'revision', focus: 'gap', sections: ['section_0', 'section_1'] },
    });
  });

  it('rejects unknown purposes, extra keys, malformed sections and duplicate sections', () => {
    expect(parseWriterIntelligenceRequest({ purpose: 'browse_the_web' }).ok).toBe(false);
    expect(parseWriterIntelligenceRequest({ purpose: 'revision', publish: true }).ok).toBe(false);
    expect(parseWriterIntelligenceRequest({ purpose: 'revision', sections: ['nope'] }).ok).toBe(false);
    expect(parseWriterIntelligenceRequest({ purpose: 'revision', sections: ['section_0', 'section_0'] })).toEqual({
      ok: false,
      note: 'Intelligence sections must not contain duplicates.',
    });
    expect(parseWriterIntelligenceRequest({}).ok).toBe(false);
  });

  it('accepts only the exact intelligence session resume shape', () => {
    expect(isWriterIntelligenceSessionDecision({ action: 'intelligence', purpose: 'planning' })).toBe(true);
    expect(isWriterIntelligenceSessionDecision({ action: 'intelligence', purpose: 'planning', sections: ['section_0'] })).toBe(true);
    expect(isWriterIntelligenceSessionDecision({ action: 'research', purpose: 'planning' })).toBe(false);
    expect(isWriterIntelligenceSessionDecision({ action: 'intelligence' })).toBe(false);
    expect(isWriterIntelligenceSessionDecision({ action: 'intelligence', purpose: 'planning', approve: true })).toBe(false);
  });
});

describe('writer intelligence dependency boundary (W10.3)', () => {
  it('degrades an unwired intelligence boundary to honest not_configured readings (deny by default)', async () => {
    const result = await NO_INTELLIGENCE_DEPENDENCIES.gather({
      projectId: 'p',
      contentId: 'c',
      topic: 't',
      targetKeyword: null,
      purpose: 'revision',
      focus: null,
      sections: [],
    });
    for (const source of Object.values(result)) {
      expect(source.status).toBe('not_configured');
      expect(source.findings).toEqual([]);
    }
    expect(Object.keys(result)).toEqual(['knowledge', 'existingContent', 'dataforseo', 'gsc', 'contentIntelligence']);
  });

  it('degrades a whole thrown gather to honest unavailable readings', () => {
    const result = degradedIntelligenceReading();
    for (const source of Object.values(result)) {
      expect(source.status).toBe('unavailable');
      expect(source.findings).toEqual([]);
    }
  });
});

describe('writerIntelligenceSchema (persisted intelligence snapshot) (W10.3)', () => {
  function stored() {
    return boundIntelligence(
      gatheredAt,
      reading({
        knowledge: section({
          status: 'available',
          findings: [finding({ type: 'knowledge', summary: 'Knowledge fact', evidenceIds: ['k1'] })],
        }),
        gsc: section({ status: 'not_configured', note: 'not wired' }),
      }),
    );
  }

  it('round-trips a bound intelligence payload exactly as the snapshot stores it', () => {
    const parsed = writerIntelligenceSchema.safeParse(stored());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.findings).toHaveLength(1);
    expect(parsed.data.findings[0].trust).toBe('untrusted');
  });

  it('fails closed: rejects unknown fields that would smuggle raw or secret payloads', () => {
    const value = { ...stored(), rawProviderResponse: { apiKey: 'leak' } };
    expect(writerIntelligenceSchema.safeParse(value).success).toBe(false);
    const itemWithExtra = stored();
    (itemWithExtra.findings[0] as unknown as Record<string, unknown>).raw = 'secret';
    expect(writerIntelligenceSchema.safeParse(itemWithExtra).success).toBe(false);
  });

  it('rejects a payload whose declared source finding counts do not match the findings array', () => {
    const value = stored();
    value.sources[0] = { ...value.sources[0], findingCount: value.findings.length + 1 };
    expect(writerIntelligenceSchema.safeParse(value).success).toBe(false);
  });

  it('rejects a not_configured source that illegally carries findings', () => {
    const value = stored();
    const gsc = value.sources.find((s) => s.source === 'gsc')!;
    gsc.findingCount = 1;
    expect(writerIntelligenceSchema.safeParse(value).success).toBe(false);
  });

  it('rejects findings labelled anything other than untrusted and oversize arrays', () => {
    const value = stored();
    (value.findings[0] as unknown as Record<string, unknown>).trust = 'trusted';
    expect(writerIntelligenceSchema.safeParse(value).success).toBe(false);

    const overflow = { ...stored(), findings: Array.from({ length: 21 }, (_, i) => value.findings[0]) };
    expect(writerIntelligenceSchema.safeParse(overflow).success).toBe(false);
  });
});
