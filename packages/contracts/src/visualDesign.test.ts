/**
 * Visual Design domain contract tests (Stage 8E.6, ADR Phase 5.3).
 *
 * The contract is pure: a proposal references existing assets, composition is
 * deterministic and total, and every rejection is a typed, explicit failure.
 * These tests pin those guarantees plus the two properties that keep the domain
 * safe - no bytes/CSS in a proposal, and no silent overwrite of a document.
 */
import { describe, expect, it } from 'vitest';
import {
  VISUAL_DESIGN_MAX_OPERATIONS,
  VISUAL_DESIGN_MAX_UNMATCHED,
  VISUAL_DESIGN_PROPOSAL_KIND,
  VISUAL_DESIGN_PROPOSAL_VERSION,
  VisualDesignError,
  applyVisualDesignProposal,
  isValidVisualAssetRef,
  isValidVisualDesignOperation,
  isValidVisualDesignProposal,
  isValidVisualNoSuitableAsset,
} from './visualDesign.js';
import type { VisualAssetRef, VisualDesignProposal } from './visualDesign.js';
import type { CanonicalDocument } from './canonical.js';
import { stableJsonStringify } from './designer.js';

const IMAGE = 'hero__media';
const HERO = 'hero';
const BODY = 'body';

function baseDocument(): CanonicalDocument {
  return {
    version: 1 as const,
    blocks: [
      {
        id: HERO,
        type: 'hero',
        attrs: { variant: 'default' },
        children: [{ id: IMAGE, type: 'image' }],
      },
      { id: BODY, type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
    ],
  };
}

const ASSET: VisualAssetRef = {
  mediaId: 'm1',
  url: 'https://cdn.example.com/a.png',
  alt: 'A gadget',
  caption: 'The gadget',
  width: 640,
  height: 480,
};

function proposal(operations: VisualDesignProposal['operations'], rationale?: string[]): VisualDesignProposal {
  return {
    kind: VISUAL_DESIGN_PROPOSAL_KIND,
    version: VISUAL_DESIGN_PROPOSAL_VERSION,
    operations,
    ...(rationale ? { rationale } : {}),
  };
}

function expectVisualError(fn: () => unknown): VisualDesignError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(VisualDesignError);
    return err as VisualDesignError;
  }
  throw new Error('Expected a VisualDesignError');
}

describe('isValidVisualDesignOperation', () => {
  it('accepts the two supported operations', () => {
    expect(isValidVisualDesignOperation({ op: 'select_asset', target: IMAGE, mediaId: 'm1' })).toBe(true);
    expect(isValidVisualDesignOperation({ op: 'set_variant', target: HERO, variant: 'centered' })).toBe(true);
  });

  it('rejects unknown operations and a free-form style payload', () => {
    expect(isValidVisualDesignOperation({ op: 'set_background', target: HERO, color: '#fff' })).toBe(false);
    expect(isValidVisualDesignOperation({ op: 'set_css', target: HERO, css: 'color:red' })).toBe(false);
    // No smuggled url / bytes / css on a supported operation.
    expect(isValidVisualDesignOperation({ op: 'select_asset', target: IMAGE, mediaId: 'm1', url: 'x' })).toBe(false);
  });

  it('rejects malformed targets and media ids', () => {
    expect(isValidVisualDesignOperation({ op: 'select_asset', target: 'bad target', mediaId: 'm1' })).toBe(false);
    expect(isValidVisualDesignOperation({ op: 'select_asset', target: IMAGE, mediaId: '' })).toBe(false);
    expect(isValidVisualDesignOperation({ op: 'set_variant', target: HERO, variant: '   ' })).toBe(false);
  });
});

describe('isValidVisualAssetRef', () => {
  it('accepts a bounded, resolved asset', () => {
    expect(isValidVisualAssetRef(ASSET)).toBe(true);
    expect(isValidVisualAssetRef({ mediaId: 'm1', url: 'https://x/y.png' })).toBe(true);
  });

  it('rejects a missing url, bad media id or negative dimensions', () => {
    expect(isValidVisualAssetRef({ mediaId: 'm1' })).toBe(false);
    expect(isValidVisualAssetRef({ mediaId: 'bad id', url: 'https://x' })).toBe(false);
    expect(isValidVisualAssetRef({ mediaId: 'm1', url: 'https://x', width: -1 })).toBe(false);
  });
});

describe('isValidVisualDesignProposal', () => {
  it('accepts a valid proposal with rationale', () => {
    expect(isValidVisualDesignProposal(proposal([{ op: 'select_asset', target: IMAGE, mediaId: 'm1' }], ['use the hero']))).toBe(
      true,
    );
  });

  it('rejects a wrong kind, version, extra key or malformed operation', () => {
    expect(isValidVisualDesignProposal({ ...proposal([]), kind: 'design_package' })).toBe(false);
    expect(isValidVisualDesignProposal({ ...proposal([]), version: 2 })).toBe(false);
    expect(isValidVisualDesignProposal({ ...proposal([]), extra: true })).toBe(false);
    expect(isValidVisualDesignProposal(proposal([{ op: 'nope', target: HERO } as never]))).toBe(false);
    expect(isValidVisualDesignProposal({ kind: VISUAL_DESIGN_PROPOSAL_KIND, version: 1 })).toBe(false);
  });

  it('bounds the operation list', () => {
    const tooMany = Array.from({ length: VISUAL_DESIGN_MAX_OPERATIONS + 1 }, () => ({
      op: 'set_variant' as const,
      target: HERO,
      variant: 'centered',
    }));
    expect(isValidVisualDesignProposal(proposal(tooMany))).toBe(false);
  });

  it('accepts review-only unmatched provenance and rejects malformed entries', () => {
    const withUnmatched = { ...proposal([]), unmatched: [{ targetBlockId: IMAGE, reason: 'below_threshold' }] };
    expect(isValidVisualDesignProposal(withUnmatched)).toBe(true);
    expect(isValidVisualNoSuitableAsset({ targetBlockId: IMAGE, reason: 'no_candidates' })).toBe(true);
    // An unknown reason, an unknown key or a bad target id is never provenance.
    expect(isValidVisualNoSuitableAsset({ targetBlockId: IMAGE, reason: 'guessed' })).toBe(false);
    expect(isValidVisualNoSuitableAsset({ targetBlockId: IMAGE, reason: 'no_candidates', extra: true })).toBe(false);
    expect(isValidVisualNoSuitableAsset({ targetBlockId: 'bad id', reason: 'no_candidates' })).toBe(false);
    expect(isValidVisualDesignProposal({ ...proposal([]), unmatched: [{ targetBlockId: IMAGE, reason: 'guessed' }] })).toBe(
      false,
    );
    const tooMany = Array.from({ length: VISUAL_DESIGN_MAX_UNMATCHED + 1 }, () => ({
      targetBlockId: IMAGE,
      reason: 'no_candidates' as const,
    }));
    expect(isValidVisualDesignProposal({ ...proposal([]), unmatched: tooMany })).toBe(false);
  });
});

describe('applyVisualDesignProposal', () => {
  it('assigns an asset and a variant without mutating the input', () => {
    const document = baseDocument();
    const result = applyVisualDesignProposal(
      document,
      proposal([
        { op: 'select_asset', target: IMAGE, mediaId: 'm1' },
        { op: 'set_variant', target: HERO, variant: 'centered' },
      ]),
      [ASSET],
    );

    const image = result.document.blocks[0]!.children![0]!;
    expect(image.attrs).toMatchObject({
      mediaId: 'm1',
      src: 'https://cdn.example.com/a.png',
      alt: 'A gadget',
      caption: 'The gadget',
      width: 640,
      height: 480,
    });
    expect(result.document.blocks[0]!.attrs?.variant).toBe('centered');
    expect(result.applied).toEqual([`select_asset:${IMAGE}`, `set_variant:${HERO}`]);

    // Pure: the input document is untouched.
    expect(document.blocks[0]!.children![0]!.attrs).toBeUndefined();
    expect(document.blocks[0]!.attrs?.variant).toBe('default');
  });

  it('fails explicitly for an unknown target', () => {
    expect(
      expectVisualError(() =>
        applyVisualDesignProposal(baseDocument(), proposal([{ op: 'set_variant', target: 'missing', variant: 'centered' }])),
      ),
    ).toMatchObject({ code: 'unknown_target' });
  });

  it('fails explicitly for a target that cannot host the operation', () => {
    expect(
      expectVisualError(() =>
        applyVisualDesignProposal(baseDocument(), proposal([{ op: 'select_asset', target: HERO, mediaId: 'm1' }]), [ASSET]),
      ),
    ).toMatchObject({ code: 'unsupported_target' });
    expect(
      expectVisualError(() =>
        applyVisualDesignProposal(baseDocument(), proposal([{ op: 'set_variant', target: BODY, variant: 'default' }])),
      ),
    ).toMatchObject({ code: 'unsupported_target' });
  });

  it('fails explicitly for an unsupported variant', () => {
    expect(
      expectVisualError(() =>
        applyVisualDesignProposal(baseDocument(), proposal([{ op: 'set_variant', target: HERO, variant: 'chartreuse' }])),
      ),
    ).toMatchObject({ code: 'unsupported_variant' });
  });

  it('fails explicitly when the referenced asset is missing', () => {
    expect(
      expectVisualError(() =>
        applyVisualDesignProposal(baseDocument(), proposal([{ op: 'select_asset', target: IMAGE, mediaId: 'ghost' }])),
      ),
    ).toMatchObject({ code: 'unknown_asset' });
  });

  it('refuses a conflicting duplicate operation instead of overwriting', () => {
    expect(
      expectVisualError(() =>
        applyVisualDesignProposal(
          baseDocument(),
          proposal([
            { op: 'set_variant', target: HERO, variant: 'centered' },
            { op: 'set_variant', target: HERO, variant: 'split' },
          ]),
        ),
      ),
    ).toMatchObject({ code: 'duplicate_operation' });
  });

  it('rejects an invalid base document or proposal', () => {
    expect(
      expectVisualError(() => applyVisualDesignProposal({ version: 1, blocks: 'nope' }, proposal([]))),
    ).toMatchObject({ code: 'invalid_document' });
    expect(
      expectVisualError(() => applyVisualDesignProposal(baseDocument(), { kind: 'x' })),
    ).toMatchObject({ code: 'invalid_visual_proposal' });
  });

  it('rejects an invalid resolved asset reference', () => {
    expect(
      expectVisualError(() =>
        applyVisualDesignProposal(
          baseDocument(),
          proposal([{ op: 'select_asset', target: IMAGE, mediaId: 'm1' }]),
          [{ mediaId: 'm1', url: '' }],
        ),
      ),
    ).toMatchObject({ code: 'invalid_visual_proposal' });
  });

  it('ignores unmatched provenance when composing (it is not an instruction)', () => {
    const withUnmatched = {
      ...proposal([{ op: 'select_asset', target: IMAGE, mediaId: 'm1' }]),
      unmatched: [{ targetBlockId: BODY, reason: 'no_candidates' as const }],
    };
    const result = applyVisualDesignProposal(baseDocument(), withUnmatched, [ASSET]);
    expect(result.document.blocks[0]!.children![0]!.attrs?.mediaId).toBe('m1');
    expect(result.applied).toEqual([`select_asset:${IMAGE}`]);
  });
});

describe('stable serialization', () => {
  it('serializes equivalent proposals byte-identically', () => {
    const a = proposal([{ op: 'select_asset', target: IMAGE, mediaId: 'm1' }], ['first', 'second']);
    const b: VisualDesignProposal = {
      version: 1,
      kind: VISUAL_DESIGN_PROPOSAL_KIND,
      rationale: ['first', 'second'],
      operations: [{ mediaId: 'm1', target: IMAGE, op: 'select_asset' }],
    };
    expect(stableJsonStringify(a)).toBe(stableJsonStringify(b));
  });
});
