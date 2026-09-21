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
