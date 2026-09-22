/**
 * Document Operation Batch v1 tests (Slice 1).
 *
 * The batch is a pure, structural transformation: it creates containers and
 * targets the newly created structure, refuses forward references and
 * unresolvable paths, and never returns a partial document. These tests pin the
 * contract, the executor's atomicity and the editor-representability guarantee.
 */
import { describe, expect, it } from 'vitest';
import { canonicalDocumentToEditorDocument } from './editorHandoff.js';
import { isValidCanonicalDoc, type CanonicalBlock, type CanonicalDocument } from './canonical.js';
import { isValidDocStructure } from './contentDoc.js';
import {
  DOCUMENT_OPERATION_MAX_OPS,
  DocumentOperationError,
  applyDocumentOperations,
  isValidDocumentOperationBatch,
  type DocumentOperationBatch,
  type InsertImageDocumentOperation,
  type InsertSectionOperation,
  type InsertTextOperation,
} from './documentOperations.js';

const BASE: CanonicalDocument = {
  version: 1,
  blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'Intro paragraph.' }] }],
};

const IMAGE = { assetId: 'm1', url: 'https://cdn.test/amsterdam.png', alt: 'Amsterdam canal' };

function heroSection(ref = 'hero-1', over: Partial<InsertSectionOperation['section']> = {}): InsertSectionOperation {
  return { type: 'insert_section', ref, section: { kind: 'hero', ...over }, position: { mode: 'document_end' } };
}

function headingInto(ref: string, text = 'Halleluja', at?: 'start' | 'end'): InsertTextOperation {
  return { type: 'insert_text', target: { mode: 'ref', ref, ...(at ? { at } : {}) }, block: { type: 'heading', level: 1, text } };
}

function imageInto(ref: string, over: Partial<InsertImageDocumentOperation> = {}): InsertImageDocumentOperation {
  return { type: 'insert_image', target: { mode: 'ref', ref }, image: IMAGE, ...over };
}

function batch(operations: DocumentOperationBatch['operations'], baseRevision = 'rev1:abc'): DocumentOperationBatch {
  return { version: 1, baseRevision, operations };
}

function codeOf(fn: () => unknown): { code?: string; index?: number } {
  try {
    fn();
    return {};
  } catch (error) {
    if (error instanceof DocumentOperationError) return { code: error.code, index: error.index };
    throw error;
  }
}

describe('isValidDocumentOperationBatch', () => {
  it('accepts a well-formed hero + heading + image batch', () => {
    expect(isValidDocumentOperationBatch(batch([heroSection(), headingInto('hero-1'), imageInto('hero-1')]))).toBe(true);
  });

  it('rejects an empty or oversized operation list', () => {
    expect(isValidDocumentOperationBatch(batch([]))).toBe(false);
    const tooMany = Array.from({ length: DOCUMENT_OPERATION_MAX_OPS + 1 }, (_, index) => heroSection(`hero-${index}`));
    expect(isValidDocumentOperationBatch(batch(tooMany))).toBe(false);
  });

  it('rejects an unknown version, extra keys and a blank revision', () => {
    expect(isValidDocumentOperationBatch({ ...batch([heroSection()]), version: 2 })).toBe(false);
    expect(isValidDocumentOperationBatch({ ...batch([heroSection()]), extra: true })).toBe(false);
    expect(isValidDocumentOperationBatch(batch([heroSection()], '   '))).toBe(false);
  });

  it('rejects a forward reference, a duplicate ref and an unknown kind/variant', () => {
    // The text op targets a ref created later in the batch.
    expect(isValidDocumentOperationBatch(batch([headingInto('hero-1'), heroSection('hero-1')]))).toBe(false);
    expect(isValidDocumentOperationBatch(batch([heroSection('hero-1'), heroSection('hero-1')]))).toBe(false);
    expect(
      isValidDocumentOperationBatch(
        batch([{ type: 'insert_section', ref: 'h', section: { kind: 'callout' } as unknown as InsertSectionOperation['section'], position: { mode: 'document_end' } }]),
      ),
    ).toBe(false);
    expect(isValidDocumentOperationBatch(batch([heroSection('h', { variant: 'not-a-variant' })]))).toBe(false);
  });

  it('rejects an image without a library assetId and a malformed heading block', () => {
    expect(
      isValidDocumentOperationBatch(
        batch([
          heroSection(),
          { type: 'insert_image', target: { mode: 'ref', ref: 'hero-1' }, image: { url: 'https://cdn.test/x.png', alt: '' } },
        ]),
      ),
    ).toBe(false);
    expect(
      isValidDocumentOperationBatch(
        batch([
          heroSection(),
          {
            type: 'insert_text',
            target: { mode: 'ref', ref: 'hero-1' },
            block: { type: 'heading', level: 9, text: 'Nope' } as unknown as InsertTextOperation['block'],
          },
        ]),
      ),
    ).toBe(false);
    expect(
      isValidDocumentOperationBatch(
        batch([
          heroSection(),
          { type: 'insert_text', target: { mode: 'ref', ref: 'hero-1' }, block: { type: 'paragraph', text: '  ' } },
        ]),
      ),
    ).toBe(false);
  });
});

describe('applyDocumentOperations', () => {
  it('creates a hero, a heading and an image, and never mutates the base', () => {
    const snapshot = JSON.parse(JSON.stringify(BASE));
    const result = applyDocumentOperations(
      BASE,
      batch([heroSection(), headingInto('hero-1'), imageInto('hero-1')]),
    );

    expect(BASE).toEqual(snapshot);
    expect(isValidCanonicalDoc(result)).toBe(true);
    const hero = result.blocks[result.blocks.length - 1]!;
    expect(hero.type).toBe('hero');
    expect(hero.children?.map((child: CanonicalBlock) => child.type)).toEqual(['heading', 'image']);
    expect(hero.children?.[0]?.content?.[0]).toEqual({ type: 'text', text: 'Halleluja' });
    expect(hero.children?.[1]?.attrs).toMatchObject({ mediaId: 'm1', src: IMAGE.url, alt: IMAGE.alt });
  });

  it('erases operation-local refs and synthesizes no persistent ids', () => {
    const result = applyDocumentOperations(BASE, batch([heroSection('sec-hero-1'), headingInto('sec-hero-1')]));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sec-hero-1');
    for (const block of result.blocks) expect(block.id).toBeUndefined();
    expect(result.blocks[result.blocks.length - 1]!.children?.[0]?.id).toBeUndefined();
  });

  it('produces a document the editor bridge can represent without dropping structure', () => {
    const result = applyDocumentOperations(BASE, batch([heroSection(), headingInto('hero-1', 'Titel', 'start'), imageInto('hero-1')]));
    const editorDocument = canonicalDocumentToEditorDocument(result);
    expect(isValidDocStructure(editorDocument)).toBe(true);
    const serialized = JSON.stringify(editorDocument);
    expect(serialized).toContain('compositionHero');
    expect(serialized).toContain('m1');
    expect(serialized).not.toContain('[unsupported:');
  });

  it('inserts into a ref at start or end deterministically', () => {
    const result = applyDocumentOperations(
      BASE,
      batch([heroSection(), headingInto('hero-1', 'Eerste', 'start'), imageInto('hero-1'), { type: 'insert_text', target: { mode: 'ref', ref: 'hero-1', at: 'start' }, block: { type: 'paragraph', text: 'Boven' } }]),
    );
    const hero = result.blocks[result.blocks.length - 1]!;
    expect(hero.children?.map((child: CanonicalBlock) => child.type)).toEqual(['paragraph', 'heading', 'image']);
  });

  it('places a section at document_start / after_block and inserts after a block path', () => {
    const started = applyDocumentOperations(
      BASE,
      batch([{ type: 'insert_section', ref: 's1', section: { kind: 'section' }, position: { mode: 'document_start' } }, headingInto('s1')]),
    );
    expect(started.blocks[0]!.type).toBe('section');

    const after = applyDocumentOperations(
      BASE,
      batch([
        { type: 'insert_section', ref: 's1', section: { kind: 'section' }, position: { mode: 'after_block', path: [0] } },
        headingInto('s1'),
      ]),
    );
    expect(after.blocks.map((block: CanonicalBlock) => block.type)).toEqual(['paragraph', 'section']);

    const sibling = applyDocumentOperations(
      BASE,
      batch([
        heroSection('hero-1', undefined),
        { type: 'insert_text', target: { mode: 'block', path: [0] }, block: { type: 'paragraph', text: 'Na de intro.' } },
        headingInto('hero-1'),
      ]),
    );
    expect(sibling.blocks[1]).toMatchObject({ type: 'paragraph', content: [{ type: 'text', text: 'Na de intro.' }] });
  });

  it('throws with the failing operation index on an unresolved path', () => {
    const result = codeOf(() =>
      applyDocumentOperations(
        BASE,
        batch([
          { type: 'insert_text', target: { mode: 'block', path: [9] }, block: { type: 'paragraph', text: 'Nope.' } },
        ]),
      ),
    );
    expect(result).toEqual({ code: 'unresolved_path', index: 0 });
  });

  it('refuses a container left with no content instead of dropping it', () => {
    const result = codeOf(() => applyDocumentOperations(BASE, batch([heroSection()])));
    expect(result).toEqual({ code: 'result_incomplete', index: 0 });
  });

  it('is atomic: a later failing operation leaves the base untouched and throws', () => {
    const snapshot = JSON.parse(JSON.stringify(BASE));
    const result = codeOf(() =>
      applyDocumentOperations(
        BASE,
        batch([
          heroSection('hero-1'),
          headingInto('hero-1'),
          { type: 'insert_text', target: { mode: 'block', path: [42] }, block: { type: 'paragraph', text: 'Nope.' } },
        ]),
      ),
    );
    expect(result).toEqual({ code: 'unresolved_path', index: 2 });
    expect(BASE).toEqual(snapshot);
  });

  it('throws invalid_batch instead of executing an unvalidated batch', () => {
    expect(codeOf(() => applyDocumentOperations(BASE, batch([])))).toEqual({ code: 'invalid_batch' });
  });
});
