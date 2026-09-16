/**
 * Composition writer contract tests (Stage 8B).
 *
 * The AI only ever proposes slot fills; the deterministic transform here turns
 * them into copy inside a copy of the compiled document while proving the
 * structure (ids, types, levels, order, nesting) is untouched. These tests
 * cover the writability rules, the fill shapes, the error vocabulary and the
 * structure-preservation guarantee.
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalDocument } from './canonical.js';
import type { CompositionPlan } from './compositionPlan.js';
import { compileComposition } from './compositionPlan.js';
import { MARKETING_STORYBOARD_PLAN } from './compositionPlanFixtures.js';
import {
  type CompositionSlotFill,
  CompositionFillError,
  applyCompositionSlotFills,
  compositionSlotKindOf,
  compositionStructureSignature,
  isCanonicalStructurePreserved,
  isWritableCompositionSlot,
  validateCompositionSlotFills,
} from './compositionWriter.js';

const compiled = compileComposition(MARKETING_STORYBOARD_PLAN);

function fullFills(): CompositionSlotFill[] {
  return compiled.slots.slots
    .filter(isWritableCompositionSlot)
    .map((ref) =>
      compositionSlotKindOf(ref) === 'items'
        ? { slot: ref.slot, items: [`first ${ref.slot}`, `second ${ref.slot}`] }
        : { slot: ref.slot, text: `copy for ${ref.slot}` },
    );
}

function blockBySlot(document: CanonicalDocument, id: string): CanonicalDocument['blocks'][number] | undefined {
  const walk = (blocks: CanonicalDocument['blocks']): CanonicalDocument['blocks'][number] | undefined => {
    for (const block of blocks) {
      if (block.id === id) return block;
      const found = walk(block.children ?? []);
      if (found) return found;
    }
    return undefined;
  };
  return walk(document.blocks);
}

describe('composition slot writability', () => {
  it('marks text and list slots writable and media/evidence slots not', () => {
    const bySlot = new Map(compiled.slots.slots.map((ref) => [ref.slot, ref]));
    expect(isWritableCompositionSlot(bySlot.get('hero.title')!)).toBe(true);
    expect(compositionSlotKindOf(bySlot.get('hero.title')!)).toBe('text');
    expect(isWritableCompositionSlot(bySlot.get('hero.primaryCta')!)).toBe(true);
    expect(isWritableCompositionSlot(bySlot.get('hero.media')!)).toBe(false);
    expect(isWritableCompositionSlot(bySlot.get('proof.author')!)).toBe(false);
  });

  it('treats a measured value slot as not writable', () => {
    const plan: CompositionPlan = {
      version: 1,
      purpose: 'Show proof',
      format: 'article',
      sections: [{ type: 'stats', requiredContent: [{ slot: 'stats.items', type: 'statItem', role: 'value' }] }],
    };
    const ref = compileComposition(plan).slots.slots[0]!;
    expect(compositionSlotKindOf(ref)).toBeNull();
  });

  it('classifies a list slot as items', () => {
    const plan: CompositionPlan = {
      version: 1,
      purpose: 'Steps',
      format: 'article',
      sections: [{ type: 'section', requiredContent: [{ slot: 'steps.list', type: 'list', role: 'body' }] }],
    };
    const ref = compileComposition(plan).slots.slots[0]!;
    expect(compositionSlotKindOf(ref)).toBe('items');
  });
});

describe('applyCompositionSlotFills', () => {
  it('fills every writable slot with plain inline text', () => {
    const result = applyCompositionSlotFills(compiled, fullFills());
    expect(result.filled).toHaveLength(compiled.slots.slots.length - 2);
    expect(result.unfilled).toEqual([]);
    const title = blockBySlot(result.document, 'hero__title');
    expect(title?.content).toEqual([{ type: 'text', text: 'copy for hero.title' }]);
    const cta = blockBySlot(result.document, 'hero__primaryCta');
    expect(cta?.content).toEqual([{ type: 'text', text: 'copy for hero.primaryCta' }]);
  });

  it('leaves media and attribution slots empty and reports them as unfilled', () => {
    const result = applyCompositionSlotFills(compiled, fullFills());
    const media = blockBySlot(result.document, 'hero__media');
    expect(media?.content).toBeUndefined();
    expect(media?.attrs).toBeUndefined();
    expect(media?.type).toBe('image');
  });

  it('does not mutate the compiled document it was given', () => {
    const before = JSON.stringify(compiled.document);
    applyCompositionSlotFills(compiled, fullFills());
    expect(JSON.stringify(compiled.document)).toBe(before);
  });

  it('preserves structure exactly (ids, types, levels, order, nesting)', () => {
    const result = applyCompositionSlotFills(compiled, fullFills());
    expect(isCanonicalStructurePreserved(compiled.document, result.document)).toBe(true);
    expect(compositionStructureSignature(compiled.document)).toBe(compositionStructureSignature(result.document));
    expect(result.document).not.toEqual(compiled.document);
  });

  it('materializes list slots as listItem children', () => {
    const plan: CompositionPlan = {
      version: 1,
      purpose: 'Steps',
      format: 'article',
      sections: [{ type: 'section', requiredContent: [{ slot: 'steps.list', type: 'list', role: 'body' }] }],
    };
    const listCompiled = compileComposition(plan);
    const result = applyCompositionSlotFills(listCompiled, [{ slot: 'steps.list', items: ['One', 'Two'] }]);
    const list = blockBySlot(result.document, 'steps__list');
    expect(list?.children).toEqual([
      { type: 'listItem', content: [{ type: 'text', text: 'One' }] },
      { type: 'listItem', content: [{ type: 'text', text: 'Two' }] },
    ]);
    expect(isCanonicalStructurePreserved(listCompiled.document, result.document)).toBe(true);
  });

  it('rejects a fill for a non-writable slot', () => {
    expect(() => applyCompositionSlotFills(compiled, [{ slot: 'hero.media', text: 'x' }])).toThrowError(
      CompositionFillError,
    );
  });

  it('rejects an unknown slot', () => {
    expect(() => applyCompositionSlotFills(compiled, [...fullFills(), { slot: 'nope.slot', text: 'x' }])).toThrow(
      /unknown slot/,
    );
  });

  it('rejects duplicate fills', () => {
    const fills = fullFills();
    fills.push({ slot: fills[0]!.slot, text: 'again' });
    expect(() => applyCompositionSlotFills(compiled, fills)).toThrow(/duplicate/);
  });

  it('rejects the wrong shape for a slot kind', () => {
    const fills = fullFills().map((fill) =>
      fill.slot === 'hero.title' ? ({ slot: 'hero.title', items: ['nope'] } as CompositionSlotFill) : fill,
    );
    expect(() => applyCompositionSlotFills(compiled, fills)).toThrow(/text slot/);
  });

  it('rejects a missing fill for a writable slot', () => {
    const fills = fullFills().filter((fill) => fill.slot !== 'problem.body');
    expect(() => applyCompositionSlotFills(compiled, fills)).toThrow(/missing fill/);
  });

  it('rejects oversized text', () => {
    const fills = fullFills().map((fill) =>
      fill.slot === 'problem.body' ? { slot: 'problem.body', text: 'x'.repeat(2001) } : fill,
    );
    expect(() => applyCompositionSlotFills(compiled, fills)).toThrow(/non-empty "text"/);
  });
});

describe('validateCompositionSlotFills', () => {
  it('reports no issues for a complete, well-shaped fill set', () => {
    expect(validateCompositionSlotFills(compiled.slots.slots, fullFills())).toEqual({ ok: true, issues: [] });
  });

  it('lists every problem it can see', () => {
    const result = validateCompositionSlotFills(compiled.slots.slots, [
      { slot: 'hero.media', text: 'x' },
      { slot: 'ghost.slot', text: 'x' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(/not writable/);
    expect(result.issues.join('\n')).toMatch(/unknown slot/);
    expect(result.issues.join('\n')).toMatch(/missing fill/);
  });
});
