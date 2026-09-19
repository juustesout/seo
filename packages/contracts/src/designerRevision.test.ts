import { describe, expect, it } from 'vitest';
import type { CanonicalDocument } from './canonical.js';
import { compositionStructureSignature } from './compositionWriter.js';
import {
  DESIGNER_REVISION_ITEM_MAX_CHARS,
  DESIGNER_REVISION_TEXT_MAX_CHARS,
  DesignerRevisionError,
  applyDesignerRevision,
  isValidDesignerRevisionRef,
  isValidDesignerRevisionTarget,
  resolveDesignerRevisionTargets,
  validateDesignerRevisionFills,
} from './designerRevision.js';

const documentWithIds: CanonicalDocument = {
  version: 1,
  blocks: [
    {
      id: 'hero',
      type: 'hero',
      children: [
        { id: 'hero__title', type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Old title' }] },
        { id: 'hero__intro', type: 'paragraph', content: [{ type: 'text', text: 'Old intro' }] },
      ],
    },
    {
      id: 'section1',
      type: 'section',
      children: [
        { id: 's1__heading', type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Features' }] },
        {
          id: 's1__list',
          type: 'list',
          attrs: { ordered: false },
          children: [
            { type: 'listItem', content: [{ type: 'text', text: 'One' }] },
            { type: 'listItem', content: [{ type: 'text', text: 'Two' }] },
          ],
        },
      ],
    },
  ],
};

const documentWithoutIds: CanonicalDocument = {
  version: 1,
  blocks: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Intro' }] },
  ],
};

describe('isValidDesignerRevisionTarget', () => {
  it('accepts document-wide scopes without a ref', () => {
    expect(isValidDesignerRevisionTarget({ kind: 'document' })).toBe(true);
    expect(isValidDesignerRevisionTarget({ kind: 'introduction' })).toBe(true);
  });

  it('accepts section and block scope with a ref', () => {
    expect(isValidDesignerRevisionTarget({ kind: 'section', ref: 'section1' })).toBe(true);
    expect(isValidDesignerRevisionTarget({ kind: 'block', ref: '#0.1' })).toBe(true);
  });

  it('rejects a ref on a document-wide scope and a missing ref on section/block', () => {
    expect(isValidDesignerRevisionTarget({ kind: 'document', ref: 'hero' })).toBe(false);
    expect(isValidDesignerRevisionTarget({ kind: 'section' })).toBe(false);
    expect(isValidDesignerRevisionTarget({ kind: 'block', ref: '' })).toBe(false);
  });

  it('rejects an unknown scope, extra keys and malformed refs', () => {
    expect(isValidDesignerRevisionTarget({ kind: 'page' })).toBe(false);
    expect(isValidDesignerRevisionTarget({ kind: 'block', ref: 'hero', extra: true })).toBe(false);
    expect(isValidDesignerRevisionTarget({ kind: 'block', ref: 'has space' })).toBe(false);
    expect(isValidDesignerRevisionTarget({ kind: 'block', ref: 'a/b' })).toBe(false);
  });

  it('validates reference tokens', () => {
    expect(isValidDesignerRevisionRef('hero__title')).toBe(true);
    expect(isValidDesignerRevisionRef('#0.1.2')).toBe(true);
    expect(isValidDesignerRevisionRef('#')).toBe(false);
    expect(isValidDesignerRevisionRef('.1')).toBe(false);
  });
});

describe('resolveDesignerRevisionTargets', () => {
  it('covers every writable block for document scope, in document order', () => {
    const refs = resolveDesignerRevisionTargets(documentWithIds, { kind: 'document' });
    expect(refs.map((ref) => ref.ref)).toEqual(['hero__title', 'hero__intro', 's1__heading', 's1__list']);
    expect(refs.map((ref) => ref.type)).toEqual(['heading', 'paragraph', 'heading', 'list']);
    expect(refs[0]).toMatchObject({ text: 'Old title' });
    expect(refs[3]).toMatchObject({ items: ['One', 'Two'] });
  });

  it('covers the leading subtree for introduction scope', () => {
    const refs = resolveDesignerRevisionTargets(documentWithIds, { kind: 'introduction' });
    expect(refs.map((ref) => ref.ref)).toEqual(['hero__title', 'hero__intro']);
  });

  it('covers a named section subtree', () => {
    const refs = resolveDesignerRevisionTargets(documentWithIds, { kind: 'section', ref: 'section1' });
    expect(refs.map((ref) => ref.ref)).toEqual(['s1__heading', 's1__list']);
  });

  it('covers exactly one writable block for block scope', () => {
    const refs = resolveDesignerRevisionTargets(documentWithIds, { kind: 'block', ref: 'hero__intro' });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ ref: 'hero__intro', type: 'paragraph', path: [0, 1] });
  });

  it('falls back to positional refs when blocks have no ids', () => {
    const refs = resolveDesignerRevisionTargets(documentWithoutIds, { kind: 'document' });
    expect(refs.map((ref) => ref.ref)).toEqual(['#0', '#1']);
    expect(resolveDesignerRevisionTargets(documentWithoutIds, { kind: 'block', ref: '#1' })[0]).toMatchObject({
      type: 'paragraph',
      path: [1],
    });
  });

  it('throws unknown_target for an unknown ref and invalid_target for a non-writable ref', () => {
    expect(() => resolveDesignerRevisionTargets(documentWithIds, { kind: 'section', ref: 'nope' })).toThrow(
      DesignerRevisionError,
    );
    expect(() => resolveDesignerRevisionTargets(documentWithIds, { kind: 'block', ref: 'hero' })).toThrow(
      DesignerRevisionError,
    );
  });

  it('throws invalid_target for a malformed target', () => {
    expect(() => resolveDesignerRevisionTargets(documentWithIds, { kind: 'block' })).toThrow(DesignerRevisionError);
  });
});

describe('validateDesignerRevisionFills', () => {
  it('collects actionable issues instead of throwing', () => {
    const targets = resolveDesignerRevisionTargets(documentWithIds, { kind: 'document' });
    expect(validateDesignerRevisionFills(targets, [{ ref: 'hero__intro', text: 'ok' }]).ok).toBe(true);
    const result = validateDesignerRevisionFills(targets, [
      { ref: 'unknown', text: 'x' },
      { ref: 's1__list', text: 'wrong shape' },
      { ref: 'hero__intro' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.includes('unknown target reference "unknown"'))).toBe(true);
    expect(result.issues.some((issue) => issue.includes('"s1__list" is a list'))).toBe(true);
    expect(result.issues.some((issue) => issue.includes('"hero__intro" needs a non-empty'))).toBe(true);
  });
});

describe('applyDesignerRevision', () => {
  it('rewrites text and list items without touching the source document', () => {
    const targets = resolveDesignerRevisionTargets(documentWithIds, { kind: 'document' });
    const result = applyDesignerRevision(documentWithIds, targets, [
      { ref: 'hero__title', text: 'New title' },
      { ref: 's1__list', items: ['Alpha', 'Beta', 'Gamma'] },
    ]);
    expect(result.revised).toEqual(['hero__title', 's1__list']);
    const hero = result.document.blocks[0]!.children![0]!;
    expect(hero.content).toEqual([{ type: 'text', text: 'New title' }]);
    const list = result.document.blocks[1]!.children![1]!;
    expect(list.children?.map((item) => item.content?.[0])).toEqual([
      { type: 'text', text: 'Alpha' },
      { type: 'text', text: 'Beta' },
      { type: 'text', text: 'Gamma' },
    ]);
    expect(documentWithIds.blocks[0]!.children![0]!.content).toEqual([{ type: 'text', text: 'Old title' }]);
  });

  it('allows a partial revision: untouched targets keep their copy', () => {
    const targets = resolveDesignerRevisionTargets(documentWithIds, { kind: 'document' });
    const result = applyDesignerRevision(documentWithIds, targets, [{ ref: 'hero__intro', text: 'Rewritten' }]);
    expect(result.revised).toEqual(['hero__intro']);
    expect(documentWithIds.blocks[1]!.children![0]!.content).toEqual([{ type: 'text', text: 'Features' }]);
  });

  it('rejects a fill for a ref that was not resolved', () => {
    const targets = resolveDesignerRevisionTargets(documentWithIds, { kind: 'block', ref: 'hero__intro' });
    expect(() => applyDesignerRevision(documentWithIds, targets, [{ ref: 'hero__title', text: 'x' }])).toThrow(
      DesignerRevisionError,
    );
  });

  it('rejects duplicate fills and wrong value shapes', () => {
    const targets = resolveDesignerRevisionTargets(documentWithIds, { kind: 'document' });
    expect(() =>
      applyDesignerRevision(documentWithIds, targets, [
        { ref: 'hero__intro', text: 'a' },
        { ref: 'hero__intro', text: 'b' },
      ]),
    ).toThrow(DesignerRevisionError);
    expect(() => applyDesignerRevision(documentWithIds, targets, [{ ref: 's1__list', text: 'not a list' }])).toThrow(
      DesignerRevisionError,
    );
    expect(() => applyDesignerRevision(documentWithIds, targets, [{ ref: 'hero__intro', items: ['x'] }])).toThrow(
      DesignerRevisionError,
    );
  });

  it('rejects empty, over-long and malformed fill values', () => {
    const targets = resolveDesignerRevisionTargets(documentWithIds, { kind: 'document' });
    expect(() => applyDesignerRevision(documentWithIds, targets, [{ ref: 'hero__intro', text: '   ' }])).toThrow(
      DesignerRevisionError,
    );
    expect(() =>
      applyDesignerRevision(documentWithIds, targets, [
        { ref: 'hero__intro', text: 'x'.repeat(DESIGNER_REVISION_TEXT_MAX_CHARS + 1) },
      ]),
    ).toThrow(DesignerRevisionError);
    expect(() =>
      applyDesignerRevision(documentWithIds, targets, [
        { ref: 's1__list', items: ['x'.repeat(DESIGNER_REVISION_ITEM_MAX_CHARS + 1)] },
      ]),
    ).toThrow(DesignerRevisionError);
    expect(() => applyDesignerRevision(documentWithIds, targets, [{ text: 'no ref' } as never])).toThrow(
      DesignerRevisionError,
    );
  });

  it('preserves the exact structure and untouched copy across multiple edits', () => {
    const targets = resolveDesignerRevisionTargets(documentWithIds, { kind: 'document' });
    const before = compositionStructureSignature(documentWithIds);
    const result = applyDesignerRevision(documentWithIds, targets, [
      { ref: 'hero__title', text: 'New title' },
      { ref: 'hero__intro', text: 'New intro' },
      { ref: 's1__heading', text: 'New heading' },
      { ref: 's1__list', items: ['Only'] },
    ]);

    expect(compositionStructureSignature(result.document)).toBe(before);
    expect(result.document.blocks.map((block) => block.id)).toEqual(['hero', 'section1']);
    expect(result.document.blocks[0]!.children!.map((child) => child.id)).toEqual(['hero__title', 'hero__intro']);
    expect(result.document.blocks[1]!.children!.map((child) => child.id)).toEqual(['s1__heading', 's1__list']);
    expect(result.revised).toEqual(['hero__title', 'hero__intro', 's1__heading', 's1__list']);
    expect(compositionStructureSignature(documentWithIds)).toBe(before);
  });

  it('never exposes or fills a non-writable block', () => {
    const targets = resolveDesignerRevisionTargets(documentWithIds, { kind: 'document' });
    expect(targets.some((ref) => ref.ref === 'hero' || ref.ref === 'section1')).toBe(false);
    expect(() => applyDesignerRevision(documentWithIds, targets, [{ ref: 'hero', text: 'rewritten' }])).toThrow(
      DesignerRevisionError,
    );
  });

  it('rejects targets resolved against a different document instead of editing by position', () => {
    const foreignTargets = resolveDesignerRevisionTargets(documentWithoutIds, { kind: 'document' });
    try {
      applyDesignerRevision(documentWithIds, foreignTargets, [{ ref: '#0', text: 'wrong document' }]);
      throw new Error('Expected applyDesignerRevision to reject foreign targets');
    } catch (err) {
      expect(err).toBeInstanceOf(DesignerRevisionError);
      expect((err as DesignerRevisionError).code).toBe('unknown_target');
    }
  });
});
