/**
 * R5.4.3.4: Composer -> append-operation mapping tests.
 *
 * The mapping is pure and deterministic: it turns the representable parts of a
 * composed CanonicalDocument into the existing operation vocabulary (appended at
 * `document_end`) and reports everything it cannot represent as an explicit gap.
 * These tests pin the supported subset, the gap reporting and the guarantee that
 * the input is never mutated.
 */
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_DOCUMENT_VERSION,
  type CanonicalBlock,
  type CanonicalDocument,
} from './canonical.js';
import {
  DOCUMENT_OPERATION_MAX_OPS,
  applyDocumentOperations,
  isValidDocumentOperationBatch,
  type DocumentOperationBatch,
} from './documentOperations.js';
import { mapCompositionToAppendOperations } from './compositionAppend.js';

function doc(...blocks: CanonicalBlock[]): CanonicalDocument {
  return { version: CANONICAL_DOCUMENT_VERSION, blocks };
}

function heading(text: string, level: 1 | 2 | 3 = 2): CanonicalBlock {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

function paragraph(text: string): CanonicalBlock {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function section(type: 'hero' | 'section', children: CanonicalBlock[], variant?: string): CanonicalBlock {
  return { type, ...(variant ? { attrs: { variant } } : {}), children };
}

describe('mapCompositionToAppendOperations', () => {
  it('maps a hero with a heading and a paragraph', () => {
    const result = mapCompositionToAppendOperations(doc(section('hero', [heading('Hero title', 1), paragraph('Hero body')], 'centered')));

    expect(result.gaps).toEqual([]);
    expect(result.operations).toEqual([
      {
        type: 'insert_section',
        ref: 'section-1',
        section: { kind: 'hero', variant: 'centered' },
        position: { mode: 'document_end' },
      },
      { type: 'insert_text', target: { mode: 'ref', ref: 'section-1' }, block: { type: 'heading', level: 1, text: 'Hero title' } },
      { type: 'insert_text', target: { mode: 'ref', ref: 'section-1' }, block: { type: 'paragraph', text: 'Hero body' } },
    ]);
  });

  it('maps a normal section with a heading and a paragraph', () => {
    const result = mapCompositionToAppendOperations(doc(section('section', [heading('Problem'), paragraph('Why it matters')])));

    expect(result.gaps).toEqual([]);
    expect(result.operations).toEqual([
      { type: 'insert_section', ref: 'section-1', section: { kind: 'section' }, position: { mode: 'document_end' } },
      { type: 'insert_text', target: { mode: 'ref', ref: 'section-1' }, block: { type: 'heading', level: 2, text: 'Problem' } },
      { type: 'insert_text', target: { mode: 'ref', ref: 'section-1' }, block: { type: 'paragraph', text: 'Why it matters' } },
    ]);
  });

  it('maps multiple representable sections in document order with fresh refs', () => {
    const result = mapCompositionToAppendOperations(
      doc(section('hero', [heading('Top', 1)]), section('section', [paragraph('One')]), section('section', [paragraph('Two')])),
    );

    expect(result.gaps).toEqual([]);
    expect(result.operations.map((operation) => operation.type)).toEqual([
      'insert_section',
      'insert_text',
      'insert_section',
      'insert_text',
      'insert_section',
      'insert_text',
    ]);
    const refs = result.operations.filter((operation) => operation.type === 'insert_section').map((operation) => operation.ref);
    expect(refs).toEqual(['section-1', 'section-2', 'section-3']);
    for (const operation of result.operations) {
      if (operation.type === 'insert_section') expect(operation.position).toEqual({ mode: 'document_end' });
    }
  });

  it('maps an image child that has a real assetId', () => {
    const image: CanonicalBlock = {
      type: 'image',
      attrs: { mediaId: 'media-1', src: 'https://cdn.test/a.png', alt: 'A canal', caption: 'Amsterdam', width: 800 },
    };
    const result = mapCompositionToAppendOperations(doc(section('section', [heading('Gallery'), image])));

    expect(result.gaps).toEqual([]);
    expect(result.operations.at(-1)).toEqual({
      type: 'insert_image',
      target: { mode: 'ref', ref: 'section-1' },
      image: { assetId: 'media-1', url: 'https://cdn.test/a.png', alt: 'A canal', caption: 'Amsterdam', width: 800 },
    });
  });

  it('reports an image without an assetId as a gap and keeps the rest', () => {
    const result = mapCompositionToAppendOperations(doc(section('hero', [heading('Title', 1), { type: 'image' }])));

    expect(result.operations.map((operation) => operation.type)).toEqual(['insert_section', 'insert_text']);
    expect(result.gaps).toEqual([
      { path: [0, 1], type: 'image', code: 'image_without_asset', message: 'Image has no assetId and was not added' },
    ]);
  });

  it.each([
    ['featureGrid', { type: 'featureGrid', children: [{ type: 'featureCard' }] } as CanonicalBlock],
    ['cta', { type: 'cta', children: [heading('Act now')] } as CanonicalBlock],
    ['list', { type: 'list', attrs: { ordered: false }, content: [{ type: 'text', text: 'item' }] } as CanonicalBlock],
    ['stats', { type: 'stats' } as CanonicalBlock],
    ['button', { type: 'button', attrs: { variant: 'primary' } } as CanonicalBlock],
  ])('reports a top-level %s as an unsupported gap', (_name, block) => {
    const result = mapCompositionToAppendOperations(doc(block));

    expect(result.operations).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ path: [0], type: block.type, code: 'unsupported_block' });
  });

  it('reports unsupported children while still appending the supported ones', () => {
    const result = mapCompositionToAppendOperations(
      doc(section('section', [heading('Features'), { type: 'featureGrid', children: [{ type: 'featureCard' }] }, paragraph('Body')])),
    );

    expect(result.operations.map((operation) => operation.type)).toEqual([
      'insert_section',
      'insert_text',
      'insert_text',
    ]);
    expect(result.gaps).toEqual([
      { path: [0, 1], type: 'featureGrid', code: 'unsupported_block', message: 'Feature grid could not be added' },
    ]);
  });

  it('reports a container with no supported content and emits no empty section', () => {
    const result = mapCompositionToAppendOperations(doc(section('section', [{ type: 'cta', children: [heading('Act')] }])));

    expect(result.operations).toEqual([]);
    expect(result.gaps).toEqual([
      { path: [0], type: 'section', code: 'empty_container', message: 'Section had no supported content and was not added' },
    ]);
  });

  it('reports empty or over-long text as unsupported content but keeps the mapped section', () => {
    const result = mapCompositionToAppendOperations(
      doc(section('section', [paragraph(''), paragraph('Body'), heading('x'.repeat(501), 2)])),
    );

    expect(result.operations.map((operation) => operation.type)).toEqual(['insert_section', 'insert_text']);
    expect(result.gaps.map((gap) => gap.code)).toEqual(['unsupported_content', 'unsupported_content']);
    expect(result.gaps.map((gap) => gap.path)).toEqual([
      [0, 0],
      [0, 2],
    ]);
  });

  it('returns no operations and no gaps for an empty document', () => {
    expect(mapCompositionToAppendOperations(doc())).toEqual({ operations: [], gaps: [] });
  });

  it('never mutates its input', () => {
    const composed = doc(section('hero', [heading('Title', 1), { type: 'image' }]), { type: 'featureGrid' });
    const snapshot = JSON.stringify(composed);

    mapCompositionToAppendOperations(composed);

    expect(JSON.stringify(composed)).toBe(snapshot);
  });

  it('caps output at the operation limit and reports the overflow as a gap', () => {
    const many = Array.from({ length: DOCUMENT_OPERATION_MAX_OPS }, () => section('section', [paragraph('Body')]));
    const result = mapCompositionToAppendOperations(doc(...many));

    expect(result.operations.length).toBeLessThanOrEqual(DOCUMENT_OPERATION_MAX_OPS);
    expect(result.operations.length % 2).toBe(0);
    expect(result.gaps.every((gap) => gap.code === 'operation_limit')).toBe(true);
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  it('produces batches that the existing executor accepts', () => {
    const base = doc(paragraph('Existing document.'));
    const result = mapCompositionToAppendOperations(
      doc(section('hero', [heading('Top', 1), paragraph('Intro')]), section('section', [paragraph('Body')])),
    );
    const batch: DocumentOperationBatch = { version: 1, baseRevision: 'rev1:abc', operations: result.operations };

    expect(isValidDocumentOperationBatch(batch)).toBe(true);
    const next = applyDocumentOperations(base, batch);
    expect(next.blocks.map((block) => block.type)).toEqual(['paragraph', 'hero', 'section']);
    expect(next.blocks[1]?.children?.map((child) => child.type)).toEqual(['heading', 'paragraph']);
  });
});
