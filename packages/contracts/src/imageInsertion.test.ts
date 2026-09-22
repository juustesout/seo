/**
 * Context-aware image insertion contract tests (R3.1).
 *
 * The helpers are deterministic and inspectable: a test can assert exactly which
 * search query a transmitted context produces and which existing project asset
 * it selects. The contract only ever selects an existing asset, never invents
 * one, and reports "no candidate" instead of falling back to an arbitrary image.
 */
import { describe, expect, it } from 'vitest';
import {
  IMAGE_INSERTION_MAX_TEXT_CHARS,
  buildImageInsertionQuery,
  imageInsertionAltForIntent,
  isImageInsertionInstruction,
  isValidImageInsertionCandidate,
  isValidImageInsertionContext,
  isValidImageInsertionTarget,
  isValidInsertImageOperation,
  selectImageInsertionCandidate,
  type ImageInsertionContext,
} from './imageInsertion.js';
import type { VisualAssetCandidate } from './visualAssetSelection.js';
import type { CanonicalDocument } from './canonical.js';

const DOC: CanonicalDocument = {
  version: 1,
  meta: { title: 'Solar for every roof' },
  blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Solar panels store energy.' }] }],
};

function context(over: Partial<ImageInsertionContext> = {}): ImageInsertionContext {
  return {
    revision: 'rev1:abcdef0123456789',
    document: DOC,
    target: { kind: 'cursor', position: 3 },
    nearbyText: 'We install solar panels on residential roofs.',
    ...over,
  };
}

const CANDIDATES: VisualAssetCandidate[] = [
  { mediaId: 'm_solar', filename: 'solar-panels.png', alt: 'Solar panels on a roof', mimeType: 'image/png', width: 1600, height: 900 },
  { mediaId: 'm_team', filename: 'team.jpg', alt: 'Our installation team', mimeType: 'image/jpeg', width: 1200, height: 800 },
];

describe('isImageInsertionInstruction', () => {
  it('recognizes Dutch and English insertion requests', () => {
    expect(isImageInsertionInstruction('Zet hier een passende afbeelding.')).toBe(true);
    expect(isImageInsertionInstruction('Add a relevant image here')).toBe(true);
    expect(isImageInsertionInstruction('voeg een foto toe')).toBe(true);
  });

  it('does not treat other image jobs as insertion', () => {
    expect(isImageInsertionInstruction('Beschrijf de afbeelding')).toBe(false);
    expect(isImageInsertionInstruction('Write alt text for the image')).toBe(false);
    expect(isImageInsertionInstruction('Tighten the introduction')).toBe(false);
  });
});

describe('buildImageInsertionQuery', () => {
  it('prefers selected text, then heading, then nearby copy, then title', () => {
    const query = buildImageInsertionQuery({
      selectedText: 'battery storage',
      sectionHeading: 'Energy',
      nearbyText: 'Cells hold charge overnight.',
      documentTitle: 'Solar for every roof',
    });
    expect(query).toBe('battery storage Energy Cells hold charge overnight. Solar for every roof');
  });

  it('drops empty parts and is bounded', () => {
    expect(buildImageInsertionQuery({ nearbyText: '   ' })).toBe('');
    const long = buildImageInsertionQuery({ nearbyText: 'x'.repeat(5000) });
    expect(long.length).toBe(IMAGE_INSERTION_MAX_TEXT_CHARS);
  });
});

describe('target validation', () => {
  it('accepts cursor, text-selection and block targets', () => {
    expect(isValidImageInsertionTarget({ kind: 'cursor', position: 0 })).toBe(true);
    expect(isValidImageInsertionTarget({ kind: 'text-selection', from: 1, to: 4 })).toBe(true);
    expect(isValidImageInsertionTarget({ kind: 'block', path: [0, 1] })).toBe(true);
  });

  it('accepts a section target with bounded paths and heading', () => {
    expect(isValidImageInsertionTarget({ kind: 'section', sectionPath: [0], anchorPath: [0] })).toBe(true);
    expect(isValidImageInsertionTarget({ kind: 'section', sectionPath: [2], anchorPath: [2, 0], heading: 'Solar energy' })).toBe(true);
    expect(isValidImageInsertionTarget({ kind: 'section', sectionPath: [], anchorPath: [0] })).toBe(false);
    expect(isValidImageInsertionTarget({ kind: 'section', sectionPath: [0], anchorPath: [0], heading: 'x'.repeat(301) })).toBe(false);
    expect(isValidImageInsertionTarget({ kind: 'section', sectionPath: [0] })).toBe(false);
  });

  it('accepts a hero target with bounded paths, node type and fixed placement', () => {
    const hero = {
      kind: 'hero',
      heroPath: [0],
      anchorPath: [0],
      nodeType: 'heading',
      placement: 'full_bleed',
      heading: 'Solar for every roof',
      supportingText: 'Clean energy for homes.',
    };
    expect(isValidImageInsertionTarget(hero)).toBe(true);
    expect(isValidImageInsertionTarget({ ...hero, heroPath: [2], anchorPath: [2, 0], nodeType: 'compositionHero' })).toBe(true);
    expect(isValidImageInsertionTarget({ ...hero, placement: 'overlay' })).toBe(false);
    expect(isValidImageInsertionTarget({ ...hero, nodeType: 'x'.repeat(101) })).toBe(false);
    expect(isValidImageInsertionTarget({ ...hero, supportingText: 'x'.repeat(601) })).toBe(false);
    expect(isValidImageInsertionTarget({ kind: 'hero', heroPath: [0], anchorPath: [] })).toBe(false);
  });

  it('rejects malformed, reversed and unbounded targets', () => {
    expect(isValidImageInsertionTarget({ kind: 'cursor', position: -1 })).toBe(false);
    expect(isValidImageInsertionTarget({ kind: 'cursor' })).toBe(false);
    expect(isValidImageInsertionTarget({ kind: 'text-selection', from: 4, to: 1 })).toBe(false);
    expect(isValidImageInsertionTarget({ kind: 'block', path: [] })).toBe(false);
    expect(isValidImageInsertionTarget({ kind: 'block', path: [0], extra: true })).toBe(false);
  });
});

describe('candidate and operation validation', () => {
  it('accepts a media-backed candidate and rejects a missing URL', () => {
    expect(isValidImageInsertionCandidate({ assetId: 'm_solar', url: 'https://x.test/a.png', alt: 'Solar', width: 100, height: 50 })).toBe(true);
    expect(isValidImageInsertionCandidate({ url: '', alt: 'Solar' })).toBe(false);
    expect(isValidImageInsertionCandidate({ assetId: 'm_solar', url: 'https://x.test/a.png', alt: 'x'.repeat(501) })).toBe(false);
  });

  it('accepts a runtime source kind on the candidate and rejects an unknown one (R4.5A)', () => {
    const base = { assetId: 'm_solar', url: 'https://x.test/a.png', alt: 'Solar' };
    expect(isValidImageInsertionCandidate({ ...base, source: 'project_media' })).toBe(true);
    expect(isValidImageInsertionCandidate({ ...base, source: 'unsplash' })).toBe(true);
    expect(isValidImageInsertionCandidate({ ...base, source: 'upload' })).toBe(false);
    expect(isValidImageInsertionCandidate({ ...base, source: 'nope' })).toBe(false);
  });

  it('validates the insert_image operation shape', () => {
    const op = { type: 'insert_image', target: { kind: 'cursor', position: 2 }, image: { assetId: 'm_solar', url: 'https://x.test/a.png', alt: 'Solar' }, rationale: 'Matched metadata on "solar".' };
    expect(isValidInsertImageOperation(op)).toBe(true);
    expect(isValidInsertImageOperation({ ...op, type: 'replace_image' })).toBe(false);
    expect(isValidInsertImageOperation({ ...op, extra: 1 })).toBe(false);
  });

  it('accepts an R4.1 visual intent and keeps R3.1 operations valid', () => {
    const base = { type: 'insert_image', target: { kind: 'cursor', position: 2 }, image: { assetId: 'm_solar', url: 'https://x.test/a.png', alt: 'Solar' } };
    expect(isValidInsertImageOperation(base)).toBe(true);
    expect(isValidInsertImageOperation({ ...base, visual: { role: 'illustration', intent: 'explain' } })).toBe(true);
    expect(isValidInsertImageOperation({ ...base, visual: { role: 'cover', intent: 'explain' } })).toBe(false);
    expect(isValidInsertImageOperation({ ...base, visual: { role: 'inline', intent: 'inspire' } })).toBe(false);
  });

  it('requires a section target and a section role to agree (R4.2)', () => {
    const image = { assetId: 'm_solar', url: 'https://x.test/a.png', alt: 'Solar' };
    const sectionTarget = { kind: 'section', sectionPath: [1], anchorPath: [1], heading: 'Solar energy' };
    const sectionVisual = { role: 'section', intent: 'reinforce', placement: 'contained' };

    expect(isValidInsertImageOperation({ type: 'insert_image', target: sectionTarget, image, visual: sectionVisual })).toBe(true);
    // A section target without a section role is a mismatched operation.
    expect(isValidInsertImageOperation({ type: 'insert_image', target: sectionTarget, image })).toBe(false);
    expect(isValidInsertImageOperation({ type: 'insert_image', target: sectionTarget, image, visual: { role: 'inline', intent: 'reinforce' } })).toBe(false);
    // A section role without a section target is a mismatched operation.
    expect(isValidInsertImageOperation({ type: 'insert_image', target: { kind: 'cursor', position: 2 }, image, visual: sectionVisual })).toBe(false);
  });

  it('rejects a section intent with an unsupported placement (R4.2)', () => {
    const image = { assetId: 'm_solar', url: 'https://x.test/a.png', alt: 'Solar' };
    const sectionTarget = { kind: 'section', sectionPath: [1], anchorPath: [1] };
    expect(
      isValidInsertImageOperation({
        type: 'insert_image',
        target: sectionTarget,
        image,
        visual: { role: 'section', intent: 'reinforce', placement: 'full_bleed' },
      }),
    ).toBe(false);
  });

  it('requires a hero target and a full-bleed hero role to agree (R4.3)', () => {
    const image = { assetId: 'm_solar', url: 'https://x.test/a.png', alt: 'Solar' };
    const heroTarget = { kind: 'hero', heroPath: [0], anchorPath: [0], nodeType: 'heading', placement: 'full_bleed' };
    const heroVisual = { role: 'hero', intent: 'emphasis', placement: 'full_bleed' };

    expect(isValidInsertImageOperation({ type: 'insert_image', target: heroTarget, image, visual: heroVisual })).toBe(true);
    // A hero target without a hero role is a mismatched operation.
    expect(isValidInsertImageOperation({ type: 'insert_image', target: heroTarget, image })).toBe(false);
    expect(
      isValidInsertImageOperation({ type: 'insert_image', target: heroTarget, image, visual: { role: 'inline', intent: 'reinforce' } }),
    ).toBe(false);
    // A hero role without a hero target is a mismatched operation.
    expect(
      isValidInsertImageOperation({ type: 'insert_image', target: { kind: 'cursor', position: 2 }, image, visual: heroVisual }),
    ).toBe(false);
    // A hero intent with any other placement is refused, not downgraded.
    expect(
      isValidInsertImageOperation({
        type: 'insert_image',
        target: heroTarget,
        image,
        visual: { role: 'hero', intent: 'emphasis', placement: 'overlay' },
      }),
    ).toBe(false);
    expect(
      isValidInsertImageOperation({
        type: 'insert_image',
        target: heroTarget,
        image,
        visual: { role: 'hero', intent: 'emphasis' },
      }),
    ).toBe(false);
  });

  it('hosts a background in a section or hero with the full-bleed placement (R4.4)', () => {
    const image = { assetId: 'm_solar', url: 'https://x.test/a.png', alt: '' };
    const sectionTarget = { kind: 'section', sectionPath: [1], anchorPath: [1], heading: 'Solar energy' };
    const heroTarget = { kind: 'hero', heroPath: [0], anchorPath: [0], nodeType: 'heading', placement: 'full_bleed' };
    const backgroundVisual = { role: 'background', intent: 'atmosphere', placement: 'full_bleed' };

    expect(isValidInsertImageOperation({ type: 'insert_image', target: sectionTarget, image, visual: backgroundVisual })).toBe(true);
    expect(isValidInsertImageOperation({ type: 'insert_image', target: heroTarget, image, visual: backgroundVisual })).toBe(true);
    // A background still needs a host region, never a bare caret target.
    expect(
      isValidInsertImageOperation({ type: 'insert_image', target: { kind: 'cursor', position: 2 }, image, visual: backgroundVisual }),
    ).toBe(false);
    // A background is never downgraded to another placement.
    expect(
      isValidInsertImageOperation({
        type: 'insert_image',
        target: sectionTarget,
        image,
        visual: { role: 'background', intent: 'atmosphere', placement: 'overlay' },
      }),
    ).toBe(false);
    // A section/hero target may not carry the plain section/hero role when the
    // request was resolved as a background, and vice versa.
    expect(
      isValidInsertImageOperation({
        type: 'insert_image',
        target: sectionTarget,
        image,
        visual: { role: 'hero', intent: 'emphasis', placement: 'full_bleed' },
      }),
    ).toBe(false);
  });
});

describe('context validation', () => {
  it('accepts a bounded editor context and rejects malformed parts', () => {
    expect(isValidImageInsertionContext(context())).toBe(true);
    expect(isValidImageInsertionContext(context({ revision: '' }))).toBe(false);
    expect(isValidImageInsertionContext({ ...context(), document: { version: 1, blocks: [{ type: '' }] } })).toBe(false);
    expect(isValidImageInsertionContext({ ...context(), nearbyText: 'x'.repeat(601) })).toBe(false);
    expect(isValidImageInsertionContext({ ...context(), target: { kind: 'cursor' } })).toBe(false);
  });

  it('accepts an optional bounded target node type and rejects an unbounded one', () => {
    expect(isValidImageInsertionContext(context({ targetNodeType: 'compositionHero' }))).toBe(true);
    expect(isValidImageInsertionContext({ ...context(), targetNodeType: 'x'.repeat(101) })).toBe(false);
  });

  it('accepts a validated source policy and rejects malformed policy objects (R4.5A)', () => {
    expect(
      isValidImageInsertionContext(
        context({ sourcePolicy: { allowExternalSearch: true, allowGeneration: false, requireGenerationConfirmation: true } }),
      ),
    ).toBe(true);
    // Missing a required field, or carrying an extra key, is not a policy.
    expect(
      isValidImageInsertionContext({ ...context(), sourcePolicy: { allowExternalSearch: true } }),
    ).toBe(false);
    expect(
      isValidImageInsertionContext({
        ...context(),
        sourcePolicy: { allowExternalSearch: true, allowGeneration: false, requireGenerationConfirmation: true, extra: 1 },
      }),
    ).toBe(false);
  });

  it('accepts a section hint alongside the real caret target (R4.2)', () => {
    const withSection = { ...context(), sectionTarget: { kind: 'section', sectionPath: [1], anchorPath: [1], heading: 'Solar energy' } };
    expect(isValidImageInsertionContext(withSection)).toBe(true);
    // The hint must itself be a section target, never some other location kind.
    expect(isValidImageInsertionContext({ ...context(), sectionTarget: { kind: 'cursor', position: 1 } })).toBe(false);
    expect(isValidImageInsertionContext({ ...context(), sectionTarget: { kind: 'section', sectionPath: [] } })).toBe(false);
  });

  it('accepts a hero hint alongside the real caret target (R4.3)', () => {
    const heroTarget = { kind: 'hero', heroPath: [0], anchorPath: [0], nodeType: 'heading', placement: 'full_bleed' };
    expect(isValidImageInsertionContext({ ...context(), heroTarget })).toBe(true);
    // The hint must itself be a hero target, never some other location kind.
    expect(isValidImageInsertionContext({ ...context(), heroTarget: { kind: 'cursor', position: 1 } })).toBe(false);
    expect(isValidImageInsertionContext({ ...context(), heroTarget: { kind: 'section', sectionPath: [0], anchorPath: [0] } })).toBe(false);
  });

  it('accepts a background host hint that reuses a section or hero target (R4.4)', () => {
    const sectionHost = { kind: 'section', sectionPath: [1], anchorPath: [1], heading: 'Solar energy' };
    const heroHost = { kind: 'hero', heroPath: [0], anchorPath: [0], nodeType: 'heading', placement: 'full_bleed' };
    expect(isValidImageInsertionContext({ ...context(), backgroundTarget: sectionHost })).toBe(true);
    expect(isValidImageInsertionContext({ ...context(), backgroundTarget: heroHost })).toBe(true);
    // The hint must itself be a section/hero host, never a caret or block kind.
    expect(isValidImageInsertionContext({ ...context(), backgroundTarget: { kind: 'cursor', position: 1 } })).toBe(false);
    expect(isValidImageInsertionContext({ ...context(), backgroundTarget: { kind: 'block', path: [0] } })).toBe(false);
  });
});

describe('selectImageInsertionCandidate', () => {
  it('selects the best metadata match deterministically', () => {
    const result = selectImageInsertionCandidate(context(), CANDIDATES);
    expect(result?.candidate.mediaId).toBe('m_solar');
    expect(result?.rationale).toContain('solar');
  });

  it('returns null when nothing clears the relevance floor', () => {
    expect(selectImageInsertionCandidate(context({ nearbyText: 'quarterly finance report' }), CANDIDATES)).toBeNull();
  });

  it('never reuses an asset already in the snapshot', () => {
    const doc: CanonicalDocument = {
      version: 1,
      blocks: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Solar panels store energy.' }] },
        { type: 'image', attrs: { mediaId: 'm_solar' } },
      ],
    };
    const result = selectImageInsertionCandidate(
      context({ document: doc, nearbyText: 'We install solar panels and our team on residential roofs.' }),
      CANDIDATES,
    );
    expect(result?.candidate.mediaId).toBe('m_team');
  });

  it('lets a visual intent shape the order of equally relevant assets', () => {
    const portrait = { mediaId: 'm_portrait', filename: 'solar-portrait.png', alt: 'Solar panels on a roof', mimeType: 'image/png', width: 900, height: 1600 };
    const candidates = [CANDIDATES[0]!, portrait];
    const plain = selectImageInsertionCandidate(context(), candidates);
    expect(plain?.candidate.mediaId).toBe('m_portrait');
    const hero = selectImageInsertionCandidate(context(), candidates, {
      visual: { role: 'hero', intent: 'emphasis' },
    });
    expect(hero?.candidate.mediaId).toBe('m_solar');
  });
});

describe('imageInsertionAltForIntent', () => {
  it('drops alt text for decorative roles and preserves it otherwise', () => {
    expect(imageInsertionAltForIntent({ role: 'decorative', intent: 'decoration' }, 'A texture', 'texture.png')).toBe('');
    expect(imageInsertionAltForIntent({ role: 'background', intent: 'atmosphere' }, 'Canal', 'canal.png')).toBe('');
    expect(imageInsertionAltForIntent({ role: 'inline', intent: 'reinforce' }, 'Solar panels')).toBe('Solar panels');
    expect(imageInsertionAltForIntent({ role: 'inline', intent: 'reinforce' }, '', 'solar.png')).toBe('solar.png');
    expect(imageInsertionAltForIntent(undefined, '', 'solar.png')).toBe('solar.png');
  });
});
