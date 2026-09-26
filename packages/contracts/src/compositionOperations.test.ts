/**
 * R5.4.4: Composer operation-batch tests.
 *
 * The batch is the Composer-level handoff: a generated composition plus the
 * existing append operations and explicit gaps, with stable metadata. These
 * tests pin that it wraps (never re-implements) `mapCompositionToAppendOperations`,
 * that unsupported structures stay explicit, and that building a batch is inert.
 */
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_DOCUMENT_VERSION,
  type CanonicalBlock,
  type CanonicalDocument,
} from './canonical.js';
import { mapCompositionToAppendOperations } from './compositionAppend.js';
import {
  COMPOSITION_OPERATION_BATCH_VERSION,
  composeOperationBatch,
} from './compositionOperations.js';
import { COMPOSITION_PLAN_VERSION, type CompositionPlan } from './compositionPlan.js';

function heading(text: string, level: 1 | 2 | 3 = 2): CanonicalBlock {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

function paragraph(text: string): CanonicalBlock {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function section(type: 'hero' | 'section', children: CanonicalBlock[], variant?: string): CanonicalBlock {
  return { type, ...(variant ? { attrs: { variant } } : {}), children };
}

function doc(...blocks: CanonicalBlock[]): CanonicalDocument {
  return { version: CANONICAL_DOCUMENT_VERSION, blocks };
}

const PLAN: CompositionPlan = {
  version: COMPOSITION_PLAN_VERSION,
  purpose: 'A landing page for an SEO tool',
  format: 'landing_page',
  sections: [{ type: 'hero' }],
};

describe('composeOperationBatch', () => {
  it('produces a versioned batch with the composition, plan and mapped operations', () => {
    const composition = doc(section('hero', [heading('Hero title', 1), paragraph('Hero body')], 'centered'));

    const batch = composeOperationBatch(composition, PLAN);

    expect(batch.version).toBe(COMPOSITION_OPERATION_BATCH_VERSION);
    expect(batch.composition).toBe(composition);
    expect(batch.plan).toBe(PLAN);
    expect(batch.gaps).toEqual([]);
    expect(batch.operations.map((operation) => operation.type)).toEqual([
      'insert_section',
      'insert_text',
      'insert_text',
    ]);
    expect(batch.operations[0]).toMatchObject({
      type: 'insert_section',
      ref: 'section-1',
      section: { kind: 'hero', variant: 'centered' },
      position: { mode: 'document_end' },
    });
  });

  it('omits the plan when the caller does not have one', () => {
    const batch = composeOperationBatch(doc(section('section', [paragraph('Body')])));

    expect('plan' in batch).toBe(false);
  });

  it('reuses the existing mapper without changing its semantics', () => {
    const composition = doc(
      section('hero', [heading('Top', 1), { type: 'image' }]),
      { type: 'featureGrid', children: [{ type: 'featureCard' }] } as CanonicalBlock,
    );

    const expected = mapCompositionToAppendOperations(composition);
    const batch = composeOperationBatch(composition);

    expect(batch.operations).toEqual(expected.operations);
    expect(batch.gaps).toEqual(expected.gaps);
  });

  it('keeps unsupported composition elements explicit as gaps', () => {
    const composition = doc(
      section('section', [heading('Features'), { type: 'cta', children: [heading('Act')] } as CanonicalBlock]),
      { type: 'stats' } as CanonicalBlock,
    );

    const batch = composeOperationBatch(composition);

    expect(batch.operations.map((operation) => operation.type)).toEqual(['insert_section', 'insert_text']);
    expect(batch.gaps.map((gap) => gap.code)).toEqual(['unsupported_block', 'unsupported_block']);
    expect(batch.gaps.map((gap) => gap.path)).toEqual([
      [0, 1],
      [1],
    ]);
  });

  it('is inert: building a batch neither mutates its inputs nor applies anything', () => {
    const composition = doc(section('hero', [heading('Title', 1), paragraph('Body')]));
    const compositionSnapshot = JSON.stringify(composition);
    const planSnapshot = JSON.stringify(PLAN);

    composeOperationBatch(composition, PLAN);

    expect(JSON.stringify(composition)).toBe(compositionSnapshot);
    expect(JSON.stringify(PLAN)).toBe(planSnapshot);
    // The batch emits document_end sections; it never edits the composition it read.
    expect(composition.blocks).toHaveLength(1);
  });

  it('returns an empty, versioned batch for a composition with nothing representable', () => {
    const batch = composeOperationBatch(doc({ type: 'cta', children: [heading('Act')] } as CanonicalBlock));

    expect(batch.version).toBe(COMPOSITION_OPERATION_BATCH_VERSION);
    expect(batch.operations).toEqual([]);
    expect(batch.gaps).toHaveLength(1);
  });
});
