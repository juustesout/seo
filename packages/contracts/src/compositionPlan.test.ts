import { describe, expect, it } from 'vitest';
import {
  CANONICAL_COMPOSITION_BLOCK_TYPES,
  CANONICAL_COMPOSITION_LEAF_BLOCK_TYPES,
  canonicalBlockTypeOf,
  isValidCanonicalDoc,
  type CanonicalBlock,
} from './canonical.js';
import {
  COMPOSITION_CONTAINER_TYPES,
  COMPOSITION_CONTENT_TYPES,
  COMPOSITION_LEAF_TYPES,
  COMPOSITION_MAX_DEPTH,
  COMPOSITION_MAX_FEATURE_CARDS,
  COMPOSITION_MAX_SECTIONS,
  COMPOSITION_MAX_STAT_ITEMS,
  COMPOSITION_PLAN_VERSION,
  COMPOSITION_SLOT_MAX_CHARS,
  CompositionPlanError,
  compileComposition,
  compileCompositionPlan,
  compositionSlotId,
  findCompiledSlotBlock,
  isValidCompositionPlan,
  isValidCompositionSlot,
  type CompositionPlan,
  type CompositionPlanNode,
} from './compositionPlan.js';
import { MARKETING_STORYBOARD_PLAN } from './compositionPlanFixtures.js';

function plan(sections: unknown[]): CompositionPlan {
  return {
    version: COMPOSITION_PLAN_VERSION,
    purpose: 'Test plan',
    format: 'landing_page',
    sections: sections as CompositionPlanNode[],
  };
}

function ok(value: unknown): boolean {
  return isValidCompositionPlan(value);
}

function minimalNode(type: string): CompositionPlanNode {
  if (type === 'featureGrid') return { type: 'featureGrid' as CompositionPlanNode['type'], children: [{ type: 'featureCard' }] };
  if (type === 'stats') {
    return { type: 'stats' as CompositionPlanNode['type'], requiredContent: [{ slot: 'stat.sample', type: 'statItem' }] };
  }
  return { type: type as CompositionPlanNode['type'] };
}

describe('composition plan vocabulary', () => {
  it('reuses the canonical vocabulary instead of a second taxonomy', () => {
    expect(COMPOSITION_CONTAINER_TYPES).toEqual(CANONICAL_COMPOSITION_BLOCK_TYPES);
    expect(COMPOSITION_LEAF_TYPES).toEqual(CANONICAL_COMPOSITION_LEAF_BLOCK_TYPES);
    for (const type of [...CANONICAL_COMPOSITION_BLOCK_TYPES, ...CANONICAL_COMPOSITION_LEAF_BLOCK_TYPES]) {
      expect(canonicalBlockTypeOf(type)).toBe(true);
    }
    expect(COMPOSITION_CONTENT_TYPES).toEqual(['heading', 'paragraph', 'list', 'image', 'quote', 'code']);
  });

  it('accepts the representative marketing storyboard', () => {
    expect(ok(MARKETING_STORYBOARD_PLAN)).toBe(true);
  });
});

describe('semantic slots', () => {
  it('accepts well-formed, scoped slot keys', () => {
    expect(ok(plan([{ type: 'hero', requiredContent: [{ slot: 'hero.title', type: 'heading', level: 1 }] }]))).toBe(true);
    expect(
      ok(
        plan([
          {
            type: 'featureGrid',
            children: [
              { type: 'featureCard', requiredContent: [{ slot: 'feature.card.1.title', type: 'heading', level: 3 }] },
              { type: 'featureCard', requiredContent: [{ slot: 'feature.card.2.title', type: 'heading', level: 3 }] },
            ],
          },
        ]),
      ),
    ).toBe(true);
    expect(isValidCompositionSlot('conversion.primaryCta')).toBe(true);
    expect(isValidCompositionSlot('a')).toBe(true);
  });

  it('rejects malformed slot keys', () => {
    const invalid = [
      '',
      'Hero.title',
      'hero title',
      'hero..title',
      'hero.',
      '.title',
      'hero/title',
      'hero-title',
      'hero_title',
      '1hero',
      'hero.title.',
      'hero.1 title',
      'a'.repeat(COMPOSITION_SLOT_MAX_CHARS + 1),
      'héró.title',
      'style:color',
    ];
    for (const slot of invalid) {
      expect(isValidCompositionSlot(slot)).toBe(false);
      expect(ok(plan([{ type: 'section', requiredContent: [{ slot, type: 'paragraph' }] }]))).toBe(false);
    }
  });

  it('rejects requirements without a slot and duplicate slots', () => {
    expect(ok(plan([{ type: 'section', requiredContent: [{ type: 'paragraph' }] }]))).toBe(false);
    expect(
      ok(
        plan([
          {
            type: 'hero',
            requiredContent: [
              { slot: 'hero.title', type: 'heading', level: 1 },
              { slot: 'hero.title', type: 'paragraph' },
            ],
          },
        ]),
      ),
    ).toBe(false);
    // Duplicates are rejected plan-wide, even across different sections.
    expect(
      ok(
        plan([
          { type: 'section', requiredContent: [{ slot: 'shared.body', type: 'paragraph' }] },
          { type: 'cta', requiredContent: [{ slot: 'shared.body', type: 'paragraph' }] },
        ]),
      ),
    ).toBe(false);
  });

  it('derives an injective canonical id from a slot', () => {
    expect(compositionSlotId('hero.title')).toBe('hero__title');
    expect(compositionSlotId('feature.card.1.title')).toBe('feature__card__1__title');
    expect(compositionSlotId('title')).toBe('title');
  });

  it('is deterministic and emitted in document order', () => {
    const a = compileComposition(MARKETING_STORYBOARD_PLAN);
    const b = compileComposition(MARKETING_STORYBOARD_PLAN);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.slots.slots.map((entry) => entry.slot)).toEqual([
      'hero.title',
      'hero.intro',
      'hero.media',
      'hero.primaryCta',
      'problem.title',
      'problem.body',
      'feature.card.1.title',
      'feature.card.1.body',
      'feature.card.2.title',
      'feature.card.2.body',
      'feature.card.3.title',
      'feature.card.3.body',
      'proof.quote',
      'proof.author',
      'conversion.title',
      'conversion.body',
      'conversion.primaryCta',
      'footer.body',
      'footer.secondaryCta',
    ]);
  });

  it('keeps slot identity out of the canonical document model', () => {
    const compiled = compileComposition(MARKETING_STORYBOARD_PLAN);
    expect(JSON.stringify(compiled.document)).not.toContain('"slot"');
    expect(compiled.document.blocks[0]).not.toHaveProperty('slot');
  });

  it('resolves a slot to its compiled canonical block without DOM selectors', () => {
    const compiled = compileComposition(MARKETING_STORYBOARD_PLAN);
    const cta = findCompiledSlotBlock(compiled, 'hero.primaryCta');
    expect(cta).toEqual({ id: 'hero__primaryCta', type: 'button', attrs: { variant: 'primary' } });
    expect(findCompiledSlotBlock(compiled, 'proof.quote')?.type).toBe('quote');
    expect(findCompiledSlotBlock(compiled, 'feature.card.2.body')?.id).toBe('feature__card__2__body');
    expect(findCompiledSlotBlock(compiled, 'does.not.exist')).toBeUndefined();
  });

  it('records the index path to every compiled slot', () => {
    const compiled = compileComposition(MARKETING_STORYBOARD_PLAN);
    const bySlot = new Map(compiled.slots.slots.map((entry) => [entry.slot, entry]));
    expect(bySlot.get('hero.title')?.path).toEqual([0, 0]);
    expect(bySlot.get('hero.primaryCta')?.path).toEqual([0, 3]);
    expect(bySlot.get('feature.card.2.body')?.path).toEqual([2, 1, 1]);
    for (const entry of compiled.slots.slots) {
      const block = findCompiledSlotBlock(compiled, entry.slot);
      expect(block?.id).toBe(entry.id);
      expect(block?.type).toBe(entry.type);
    }
  });

  it('does not mutate the plan while producing the slot map', () => {
    const before = structuredClone(MARKETING_STORYBOARD_PLAN);
    compileComposition(MARKETING_STORYBOARD_PLAN);
    expect(MARKETING_STORYBOARD_PLAN).toEqual(before);
  });
});

describe('deterministic compiler', () => {
  it('is a pure function of the plan', () => {
    const a = compileCompositionPlan(MARKETING_STORYBOARD_PLAN);
    const b = compileCompositionPlan(MARKETING_STORYBOARD_PLAN);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not mutate the plan it compiles or validates', () => {
    const before = structuredClone(MARKETING_STORYBOARD_PLAN);
    isValidCompositionPlan(MARKETING_STORYBOARD_PLAN);
    compileCompositionPlan(MARKETING_STORYBOARD_PLAN);
    expect(MARKETING_STORYBOARD_PLAN).toEqual(before);
  });

  it('produces a document the canonical validator accepts', () => {
    expect(isValidCanonicalDoc(compileCompositionPlan(MARKETING_STORYBOARD_PLAN))).toBe(true);
  });

  it('compiles the storyboard into the expected top-level sections', () => {
    const blocks = compileCompositionPlan(MARKETING_STORYBOARD_PLAN).blocks;
    expect(blocks.map((block) => block.type)).toEqual([
      'hero',
      'section',
      'featureGrid',
      'testimonial',
      'cta',
      'footer',
    ]);
  });

  it('compiles every supported container type into a known canonical block', () => {
    for (const type of COMPOSITION_CONTAINER_TYPES) {
      const document = compileCompositionPlan(plan([minimalNode(type)]));
      expect(document.blocks[0]?.type).toBe(type);
      expect(canonicalBlockTypeOf(type)).toBe(true);
      expect(isValidCanonicalDoc(document)).toBe(true);
    }
  });

  it('compiles every requirement type into a known canonical block', () => {
    for (const type of [...COMPOSITION_CONTENT_TYPES, ...COMPOSITION_LEAF_TYPES]) {
      const requirement = type === 'heading' ? { slot: 'sample.slot', type, level: 2 } : { slot: 'sample.slot', type };
      const document = compileCompositionPlan(plan([{ type: 'section', requiredContent: [requirement] }]));
      const child = document.blocks[0]?.children?.[0];
      expect(child?.type).toBe(type);
      expect(isValidCanonicalDoc(document)).toBe(true);
    }
  });
});

describe('structure preservation', () => {
  it('preserves variant and normalized layout intent', () => {
    const blocks = compileCompositionPlan(MARKETING_STORYBOARD_PLAN).blocks;
    const hero = blocks[0]!;
    expect(hero.attrs?.variant).toBe('split');
    const layout = hero.attrs?.layout as Record<string, unknown>;
    expect(layout).toEqual({ direction: 'row', width: 'wide' });
    expect(Object.keys(layout)).toEqual(['direction', 'width']);
    expect((blocks[2]!.attrs?.layout as Record<string, unknown>)).toEqual({ columns: 3 });
  });

  it('orders required content before nested sections deterministically', () => {
    const document = compileCompositionPlan(
      plan([
        {
          type: 'hero',
          requiredContent: [{ slot: 'hero.title', type: 'heading', level: 1 }],
          children: [{ type: 'section', requiredContent: [{ slot: 'problem.body', type: 'paragraph' }] }],
        },
      ]),
    );
    const children = document.blocks[0]!.children!;
    expect(children.map((child) => child.type)).toEqual(['heading', 'section']);
  });

  it('compiles nested sections recursively', () => {
    const document = compileCompositionPlan(
      plan([
        {
          type: 'hero',
          children: [
            {
              type: 'section',
              children: [
                {
                  type: 'mediaText',
                  requiredContent: [
                    { slot: 'media.image', type: 'image' },
                    { slot: 'media.body', type: 'paragraph' },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    );
    const mediaText = document.blocks[0]!.children![0]!.children![0]!;
    expect(mediaText.type).toBe('mediaText');
    expect(mediaText.children?.map((child) => child.type)).toEqual(['image', 'paragraph']);
  });

  it('compiles a feature grid of bounded cards', () => {
    const document = compileCompositionPlan(
      plan([
        {
          type: 'featureGrid',
          layout: { columns: 3 },
          children: [
            {
              type: 'featureCard',
              requiredContent: [
                { slot: 'feature.card.1.title', type: 'heading', level: 3 },
                { slot: 'feature.card.1.body', type: 'paragraph' },
              ],
            },
            { type: 'featureCard' },
          ],
        },
      ]),
    );
    const grid = document.blocks[0]!;
    expect(grid.children?.map((child) => child.type)).toEqual(['featureCard', 'featureCard']);
    expect(grid.children?.[0]?.children?.map((child) => child.type)).toEqual(['heading', 'paragraph']);
  });

  it('compiles stats into bounded stat item placeholders', () => {
    const document = compileCompositionPlan(
      plan([
        {
          type: 'stats',
          requiredContent: [
            { slot: 'stats.one', type: 'statItem' },
            { slot: 'stats.two', type: 'statItem' },
          ],
        },
      ]),
    );
    expect(document.blocks[0]!.children?.map((child) => child.type)).toEqual(['statItem', 'statItem']);
  });

  it('keeps planner-only metadata out of the document', () => {
    const document = compileCompositionPlan(MARKETING_STORYBOARD_PLAN);
    const json = JSON.stringify(document);
    expect(json).not.toContain('purpose');
    expect(json).not.toContain('"role"');
    expect(json).not.toContain('"slot"');
    expect(json).not.toContain('introduction');
  });
});

describe('content placeholders', () => {
  it('never invents copy, media, links, icons or values', () => {
    const document = compileCompositionPlan(MARKETING_STORYBOARD_PLAN);
    const json = JSON.stringify(document);
    expect(json).not.toContain('"text"');
    expect(json).not.toContain('"src"');
    expect(json).not.toContain('"href"');
    expect(json).not.toContain('"icon"');
    expect(json).not.toContain('"value"');
    expect(json).not.toContain('"content"');
  });

  it('emits empty semantic placeholder blocks', () => {
    const document = compileCompositionPlan(
      plan([
        {
          type: 'section',
          requiredContent: [
            { slot: 'a', type: 'heading', level: 1 },
            { slot: 'b', type: 'paragraph' },
            { slot: 'c', type: 'list' },
            { slot: 'd', type: 'image' },
            { slot: 'e', type: 'button' },
            { slot: 'f', type: 'badge' },
            { slot: 'g', type: 'statItem' },
          ],
        },
      ]),
    );
    const children: CanonicalBlock[] = document.blocks[0]!.children!;
    const [heading, paragraph, list, image, button, badge, statItem] = children;
    expect(heading).toEqual({ id: 'a', type: 'heading', attrs: { level: 1 } });
    expect(paragraph).toEqual({ id: 'b', type: 'paragraph' });
    expect(list).toEqual({ id: 'c', type: 'list', attrs: { ordered: false }, children: [] });
    expect(image).toEqual({ id: 'd', type: 'image' });
    expect(button).toEqual({ id: 'e', type: 'button' });
    expect(badge).toEqual({ id: 'f', type: 'badge' });
    expect(statItem).toEqual({ id: 'g', type: 'statItem' });
  });

  it('keeps leaf variant intent without inventing a label', () => {
    const document = compileCompositionPlan(
      plan([
        {
          type: 'cta',
          requiredContent: [{ slot: 'cta.button', type: 'button', variant: 'primary', role: 'primaryCta' }],
        },
      ]),
    );
    expect(document.blocks[0]!.children![0]).toEqual({
      id: 'cta__button',
      type: 'button',
      attrs: { variant: 'primary' },
    });
  });
});

describe('structural rejection', () => {
  it('rejects malformed feature grids', () => {
    expect(ok(plan([{ type: 'featureGrid' }]))).toBe(false);
    expect(ok(plan([{ type: 'featureGrid', children: [] }]))).toBe(false);
    expect(ok(plan([{ type: 'featureGrid', children: [{ type: 'section' }] }]))).toBe(false);
    expect(
      ok(
        plan([
          {
            type: 'featureGrid',
            children: Array.from({ length: COMPOSITION_MAX_FEATURE_CARDS + 1 }, () => ({ type: 'featureCard' })),
          },
        ]),
      ),
    ).toBe(false);
  });

  it('rejects cards that nest further composition', () => {
    expect(ok(plan([{ type: 'featureCard', children: [{ type: 'section' }] }]))).toBe(false);
  });

  it('rejects malformed stats blocks', () => {
    expect(ok(plan([{ type: 'stats' }]))).toBe(false);
    expect(ok(plan([{ type: 'stats', requiredContent: [{ slot: 's.label', type: 'paragraph' }] }]))).toBe(false);
    expect(ok(plan([{ type: 'stats', children: [{ type: 'statItem' }] }]))).toBe(false);
    expect(
      ok(
        plan([
          {
            type: 'stats',
            requiredContent: Array.from({ length: COMPOSITION_MAX_STAT_ITEMS + 1 }, (_, index) => ({
              slot: `stat.${index}`,
              type: 'statItem',
            })),
          },
        ]),
      ),
    ).toBe(false);
  });

  it('rejects unsupported vocabulary and values', () => {
    expect(ok(plan([{ type: 'pricing' }]))).toBe(false);
    expect(ok(plan([{ type: 'hero', variant: 'warning' }]))).toBe(false);
    expect(ok(plan([{ type: 'hero', layout: { align: 'middle' } }]))).toBe(false);
    expect(ok(plan([{ type: 'hero', layout: { columns: 99 } }]))).toBe(false);
    expect(ok(plan([{ type: 'hero', layout: { gridTemplateColumns: '1fr 1fr' } }]))).toBe(false);
    expect(ok(plan([{ type: 'hero', purpose: 'marketing' }]))).toBe(false);
    expect(ok(plan([{ type: 'section', requiredContent: [{ slot: 'x.slot', type: 'iframe' }] }]))).toBe(false);
    expect(
      ok(plan([{ type: 'section', requiredContent: [{ slot: 'x.slot', type: 'heading', level: 7 }] }])),
    ).toBe(false);
    expect(ok(plan([{ type: 'section', requiredContent: [{ slot: 'x.slot', type: 'paragraph', level: 2 }] }]))).toBe(false);
    expect(
      ok(plan([{ type: 'section', requiredContent: [{ slot: 'x.slot', type: 'paragraph', variant: 'primary' }] }])),
    ).toBe(false);
    expect(ok(plan([{ type: 'section', requiredContent: [{ slot: 'x.slot', type: 'paragraph', role: 'nope' }] }]))).toBe(false);
  });

  it('rejects unknown keys at every level', () => {
    expect(ok({ ...plan([{ type: 'section' }]), extra: true })).toBe(false);
    expect(ok(plan([{ type: 'section', style: 'color:red' }]))).toBe(false);
    expect(
      ok(plan([{ type: 'section', requiredContent: [{ slot: 'x.slot', type: 'paragraph', style: 'color:red' }] }])),
    ).toBe(false);
  });

  it('rejects malformed plan envelopes', () => {
    expect(ok(null)).toBe(false);
    expect(ok({ ...plan([{ type: 'section' }]), version: 2 })).toBe(false);
    expect(ok({ ...plan([{ type: 'section' }]), format: 'email' })).toBe(false);
    expect(ok({ ...plan([{ type: 'section' }]), purpose: '   ' })).toBe(false);
    expect(ok({ ...plan([{ type: 'section' }]), sections: [] })).toBe(false);
    expect(ok(plan(Array.from({ length: COMPOSITION_MAX_SECTIONS + 1 }, () => ({ type: 'section' }))))).toBe(false);
    expect(ok(plan(Array.from({ length: COMPOSITION_MAX_SECTIONS }, () => ({ type: 'section' }))))).toBe(true);
  });

  it('bounds nesting depth', () => {
    const withinBound = nestSections(COMPOSITION_MAX_DEPTH);
    const tooDeep = nestSections(COMPOSITION_MAX_DEPTH + 2);
    expect(ok(plan([withinBound]))).toBe(true);
    expect(ok(plan([tooDeep]))).toBe(false);
  });
});

function nestSections(depth: number): CompositionPlanNode {
  let node: CompositionPlanNode = { type: 'section' };
  for (let i = 0; i < depth; i += 1) {
    node = { type: 'section', children: [node] };
  }
  return node;
}

describe('compile failure', () => {
  it('throws a typed error on an invalid plan', () => {
    expect(() => compileCompositionPlan(plan([{ type: 'pricing' }]))).toThrow(CompositionPlanError);
    try {
      compileCompositionPlan(plan([{ type: 'pricing' }]));
      expect.unreachable('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CompositionPlanError);
      expect((error as CompositionPlanError).code).toBe('invalid_composition_plan');
    }
  });
});
