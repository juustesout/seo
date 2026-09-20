/**
 * Visual asset selection tests (Stage 8E.6, ADR Phase 5.3.1).
 *
 * The intelligence layer is pure and deterministic: it ranks only metadata that
 * actually exists (filename/alt/caption/mime/dimensions), never invents an
 * asset, never reuses one asset twice, and reports a no-suitable-asset result
 * instead of guessing. These tests pin those guarantees plus the adapter into
 * the existing Visual Design proposal contract.
 */
import { describe, expect, it } from 'vitest';
import {
  VISUAL_ASSET_DEFAULT_MIN_SCORE,
  VISUAL_ASSET_MAX_CANDIDATES,
  VISUAL_ASSET_MIME_TYPES,
  VISUAL_ASSET_ROLES,
  collectVisualTargets,
  isSelectableVisualMimeType,
  isValidVisualAssetCandidate,
  isValidVisualAssetSelection,
  isValidVisualAssetSelectionRequest,
  selectVisualAssets,
  visualDesignProposalFromSelections,
} from './visualAssetSelection.js';
import type { VisualAssetCandidate } from './visualAssetSelection.js';
import type { VisualAssetRef } from './visualDesign.js';
import {
  VISUAL_DESIGN_PROPOSAL_KIND,
  VISUAL_DESIGN_PROPOSAL_VERSION,
  VisualDesignError,
  applyVisualDesignProposal,
  isValidVisualDesignProposal,
} from './visualDesign.js';

const HERO_IMAGE = 'hero__media';
const FEAT_IMAGE = 'feat__media';

function document() {
  return {
    version: 1 as const,
    meta: { title: 'Power your property' },
    blocks: [
      {
        id: 'hero',
        type: 'hero',
        children: [
          { id: 'hero__title', type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Affordable solar energy' }] },
          { id: HERO_IMAGE, type: 'image' },
        ],
      },
      {
        id: 'features',
        type: 'section',
        children: [
          { id: 'feat__title', type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Battery storage' }] },
          { id: FEAT_IMAGE, type: 'image' },
        ],
      },
    ],
  };
}

const SOLAR: VisualAssetCandidate = {
  mediaId: 'm_solar',
  filename: 'solar-panels.png',
  alt: 'Solar panels on a roof',
  caption: 'Clean energy',
  mimeType: 'image/png',
  width: 1600,
  height: 900,
  usageCount: 0,
};

const BATTERY: VisualAssetCandidate = {
  mediaId: 'm_battery',
  filename: 'home-battery.jpg',
  alt: 'Home battery storage unit',
  caption: '',
  mimeType: 'image/jpeg',
  width: 1200,
  height: 800,
  usageCount: 0,
};

function expectVisualError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(VisualDesignError);
    expect((err as VisualDesignError).code).toBe(code);
    return;
  }
  throw new Error('Expected a VisualDesignError');
}

/** Media infrastructure resolves candidate metadata into composition asset refs. */
function toAssetRef(candidate: VisualAssetCandidate): VisualAssetRef {
  return {
    mediaId: candidate.mediaId,
    url: `https://cdn.example.com/${candidate.mediaId}.png`,
    ...(candidate.alt !== undefined ? { alt: candidate.alt } : {}),
    ...(candidate.caption !== undefined ? { caption: candidate.caption } : {}),
    ...(candidate.width !== undefined ? { width: candidate.width } : {}),
    ...(candidate.height !== undefined ? { height: candidate.height } : {}),
  };
}

describe('validators', () => {
  it('accepts a well-formed candidate and rejects stray keys or bad fields', () => {
    expect(isValidVisualAssetCandidate(SOLAR)).toBe(true);
    expect(isValidVisualAssetCandidate({ mediaId: 'm1', filename: 'a.png' })).toBe(true);
    expect(isValidVisualAssetCandidate({ mediaId: 'm1', filename: 'a.png', bytes: 'x' })).toBe(false);
    expect(isValidVisualAssetCandidate({ mediaId: '', filename: 'a.png' })).toBe(false);
    expect(isValidVisualAssetCandidate({ mediaId: 'm1', filename: '' })).toBe(false);
    expect(isValidVisualAssetCandidate({ mediaId: 'm1', filename: 'a.png', width: 0 })).toBe(false);
    expect(isValidVisualAssetCandidate({ mediaId: 'm1', filename: 'a.png', mimeType: 'image/svg+xml' })).toBe(false);
  });

  it('only accepts the stored image MIME types', () => {
    for (const mime of VISUAL_ASSET_MIME_TYPES) expect(isSelectableVisualMimeType(mime)).toBe(true);
    expect(isSelectableVisualMimeType(undefined)).toBe(true);
    expect(isSelectableVisualMimeType('image/svg+xml')).toBe(false);
    expect(isSelectableVisualMimeType('application/pdf')).toBe(false);
  });

  it('validates selections and requests', () => {
    const selection = { assetId: 'm1', targetBlockId: HERO_IMAGE, role: 'image', score: 3, rationale: 'match' };
    expect(isValidVisualAssetSelection(selection)).toBe(true);
    expect(isValidVisualAssetSelection({ ...selection, score: -1 })).toBe(false);
    expect(isValidVisualAssetSelection({ ...selection, role: 'background' })).toBe(false);
    expect(isValidVisualAssetSelection({ ...selection, extra: true })).toBe(false);
    expect(VISUAL_ASSET_ROLES).toEqual(['image']);

    expect(isValidVisualAssetSelectionRequest({})).toBe(true);
    expect(isValidVisualAssetSelectionRequest({ targets: [HERO_IMAGE], minScore: 2 })).toBe(true);
    expect(isValidVisualAssetSelectionRequest({ targets: [] })).toBe(false);
    expect(isValidVisualAssetSelectionRequest({ targets: ['bad id'] })).toBe(false);
    expect(isValidVisualAssetSelectionRequest({ minScore: -1 })).toBe(false);
    expect(isValidVisualAssetSelectionRequest({ nope: true })).toBe(false);
  });
});

describe('collectVisualTargets', () => {
  it('collects image blocks in document order with section context', () => {
    const { targets, skipped } = collectVisualTargets(document());
    expect(targets.map((t) => t.blockId)).toEqual([HERO_IMAGE, FEAT_IMAGE]);
    expect(targets.every((t) => t.role === 'image')).toBe(true);
    expect(targets[0]!.context).toContain('Affordable solar energy');
    expect(targets[1]!.context).toContain('Battery storage');
    expect(skipped).toEqual([]);
  });

  it('reports unknown and unsupported requested targets instead of ignoring them', () => {
    const { targets, skipped } = collectVisualTargets(document(), ['hero__title', 'ghost', HERO_IMAGE]);
    expect(targets.map((t) => t.blockId)).toEqual([HERO_IMAGE]);
    expect(skipped).toEqual([
      { targetBlockId: 'hero__title', reason: 'unsupported_target' },
      { targetBlockId: 'ghost', reason: 'unknown_target' },
    ]);
  });

  it('rejects an invalid document', () => {
    expectVisualError(() => collectVisualTargets({ version: 1, blocks: 'nope' }), 'invalid_document');
  });
});

describe('selectVisualAssets', () => {
  it('selects the asset whose metadata matches each section', () => {
    const result = selectVisualAssets(document(), [SOLAR, BATTERY]);
    expect(result.selections.map((s) => [s.targetBlockId, s.assetId])).toEqual([
      [HERO_IMAGE, 'm_solar'],
      [FEAT_IMAGE, 'm_battery'],
    ]);
    expect(result.unmatched).toEqual([]);
    expect(result.selections[0]!.score).toBeGreaterThanOrEqual(VISUAL_ASSET_DEFAULT_MIN_SCORE);
    expect(result.selections[0]!.rationale.length).toBeGreaterThan(0);
  });

  it('is deterministic regardless of candidate input order', () => {
    const a = selectVisualAssets(document(), [SOLAR, BATTERY]);
    const b = selectVisualAssets(document(), [BATTERY, SOLAR]);
    expect(b).toEqual(a);
  });

  it('returns an explicit unmatched result (never a guess) when nothing matches', () => {
    const unrelated: VisualAssetCandidate = { mediaId: 'm_cat', filename: 'cat.png', alt: 'A cat', mimeType: 'image/png' };
    const result = selectVisualAssets(document(), [unrelated]);
    expect(result.selections).toEqual([]);
    expect(result.unmatched.map((u) => u.reason)).toEqual(['below_threshold', 'below_threshold']);
  });

  it('reports no_candidates when the project library is empty', () => {
    const result = selectVisualAssets(document(), []);
    expect(result.selections).toEqual([]);
    expect(result.unmatched.every((u) => u.reason === 'no_candidates')).toBe(true);
  });

  it('never selects an asset that is not an existing candidate', () => {
    const result = selectVisualAssets(document(), [SOLAR]);
    expect(result.selections.every((s) => s.assetId === 'm_solar')).toBe(true);
    expect(result.selections.every((s) => s.assetId !== 'm_battery')).toBe(true);
  });

  it('does not reuse one asset across two targets (conflict avoidance)', () => {
    const result = selectVisualAssets(document(), [SOLAR]);
    expect(result.selections.map((s) => s.targetBlockId)).toEqual([HERO_IMAGE]);
    expect(result.unmatched).toEqual([{ targetBlockId: FEAT_IMAGE, reason: 'all_conflicting' }]);
  });

  it('rejects an unsupported asset type and only ranks selectable candidates', () => {
    const svg: VisualAssetCandidate = { mediaId: 'm_svg', filename: 'solar.svg', alt: 'Solar', mimeType: 'image/svg+xml' };
    const result = selectVisualAssets(document(), [svg, SOLAR]);
    expect(result.selections[0]!.assetId).toBe('m_solar');
  });

  it('honours an explicit target list and an explicit threshold', () => {
    const result = selectVisualAssets(document(), [SOLAR, BATTERY], { targets: [FEAT_IMAGE] });
    expect(result.selections.map((s) => [s.targetBlockId, s.assetId])).toEqual([[FEAT_IMAGE, 'm_battery']]);

    const strict = selectVisualAssets(document(), [SOLAR, BATTERY], { minScore: 100 });
    expect(strict.selections).toEqual([]);
    expect(strict.unmatched.every((u) => u.reason === 'below_threshold')).toBe(true);
  });

  it('reports unmatched for an explicit target that cannot be satisfied', () => {
    const result = selectVisualAssets(document(), [SOLAR], { targets: [FEAT_IMAGE] });
    expect(result.selections).toEqual([]);
    expect(result.unmatched).toEqual([{ targetBlockId: FEAT_IMAGE, reason: 'below_threshold' }]);
  });

  it('treats an already-assigned asset as available to its own block only', () => {
    const doc = document();
    (doc.blocks[0]!.children![1] as { attrs?: Record<string, unknown> }).attrs = { mediaId: 'm_solar' };
    const result = selectVisualAssets(doc, [SOLAR, BATTERY]);
    expect(result.selections.map((s) => [s.targetBlockId, s.assetId])).toEqual([
      [HERO_IMAGE, 'm_solar'],
      [FEAT_IMAGE, 'm_battery'],
    ]);
  });

  it('bounds the candidate set', () => {
    const many: VisualAssetCandidate[] = Array.from({ length: VISUAL_ASSET_MAX_CANDIDATES + 25 }, (_, i) => ({
      mediaId: `m_${i}`,
      filename: `solar-${i}.png`,
      alt: 'Solar panels',
      mimeType: 'image/png',
    }));
    const result = selectVisualAssets(document(), many);
    expect(result.selections.length).toBeGreaterThanOrEqual(1);
    expect(result.selections.length).toBeLessThanOrEqual(2);
    expect(new Set(result.selections.map((s) => s.assetId)).size).toBe(result.selections.length);
  });

  it('rejects an invalid selection request', () => {
    expectVisualError(
      () => selectVisualAssets(document(), [SOLAR], { targets: ['bad id'] }),
      'invalid_visual_proposal',
    );
  });
});

describe('visualDesignProposalFromSelections', () => {
  const solarSelection = {
    assetId: 'm_solar',
    targetBlockId: HERO_IMAGE,
    role: 'image' as const,
    score: 5,
    rationale: 'Matched metadata on "solar".',
  };
  const batterySelection = {
    assetId: 'm_battery',
    targetBlockId: FEAT_IMAGE,
    role: 'image' as const,
    score: 6,
    rationale: 'Matched metadata on "battery".',
  };

  it('produces a validated proposal that the existing composition accepts', () => {
    const proposal = visualDesignProposalFromSelections([solarSelection, batterySelection]);
    expect(proposal.kind).toBe(VISUAL_DESIGN_PROPOSAL_KIND);
    expect(proposal.version).toBe(VISUAL_DESIGN_PROPOSAL_VERSION);
    expect(proposal.operations).toEqual([
      { op: 'select_asset', target: HERO_IMAGE, mediaId: 'm_solar' },
      { op: 'select_asset', target: FEAT_IMAGE, mediaId: 'm_battery' },
    ]);
    expect(proposal.rationale).toHaveLength(2);

    const composed = applyVisualDesignProposal(document(), proposal, [toAssetRef(SOLAR), toAssetRef(BATTERY)]);
    expect(composed.applied).toEqual([`select_asset:${HERO_IMAGE}`, `select_asset:${FEAT_IMAGE}`]);
    expect(composed.document.blocks[0]!.children![1]!.attrs?.mediaId).toBe('m_solar');
  });

  it('attaches review-only unmatched provenance and rejects a malformed entry', () => {
    const unmatched = [{ targetBlockId: FEAT_IMAGE, reason: 'below_threshold' as const }];
    const proposal = visualDesignProposalFromSelections([solarSelection], undefined, unmatched);
    expect(proposal.unmatched).toEqual(unmatched);
    expect(isValidVisualDesignProposal(proposal)).toBe(true);
    // Unmatched entries are provenance, not a mutation payload: an unknown
    // reason is rejected rather than carried onto the proposal.
    expectVisualError(
      () =>
        visualDesignProposalFromSelections([solarSelection], undefined, [
          { targetBlockId: FEAT_IMAGE, reason: 'guessed' as never },
        ]),
      'invalid_visual_proposal',
    );
  });

  it('refuses a duplicate target or a duplicated asset instead of overwriting', () => {
    expectVisualError(
      () =>
        visualDesignProposalFromSelections([
          solarSelection,
          { ...batterySelection, targetBlockId: HERO_IMAGE },
        ]),
      'duplicate_operation',
    );
    expectVisualError(
      () =>
        visualDesignProposalFromSelections([
          solarSelection,
          { ...batterySelection, assetId: 'm_solar' },
        ]),
      'duplicate_operation',
    );
  });

  it('rejects an invalid selection', () => {
    expectVisualError(
      () => visualDesignProposalFromSelections([{ ...solarSelection, score: -1 }]),
      'invalid_visual_proposal',
    );
  });

  it('produces an empty proposal for an empty selection list', () => {
    const proposal = visualDesignProposalFromSelections([]);
    expect(proposal.operations).toEqual([]);
    expect(proposal.rationale).toBeUndefined();
  });
});
