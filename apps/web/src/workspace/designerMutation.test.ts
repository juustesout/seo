/**
 * R5.5.2: the Designer proposal -> mutation adapter.
 *
 * The adapter is the only place that decides whether a proposal is representable
 * through the existing workspace mutation vocabulary. These tests pin the
 * classification order and the explicit unsupported forms, so the pipeline can
 * never silently fall back to a whole-document replacement.
 */
import { describe, expect, it } from 'vitest';
import {
  DESIGNER_PROPOSAL_VERSION,
  DOCUMENT_OPERATIONS_VERSION,
  type DesignerProposal,
  type DocumentOperation,
  type InsertImageOperation,
} from '@seo/contracts';
import {
  DESIGNER_MUTATION_UNSUPPORTED_COPY,
  isDesignerMutationRepresentable,
  planDesignerMutation,
} from './designerMutation';

const BASE_REVISION = 'rev1:abc';
const DOCUMENT = { version: 1 as const, blocks: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Body' }] }] };

const OPERATIONS: DocumentOperation[] = [
  { type: 'insert_section', ref: 's1', section: { kind: 'section' }, position: { mode: 'document_end' } },
  { type: 'insert_text', target: { mode: 'ref', ref: 's1' }, block: { type: 'paragraph', text: 'Copy' } },
];

const INSERTION: InsertImageOperation = {
  type: 'insert_image',
  target: { kind: 'cursor', position: 1 },
  image: { assetId: 'm_1', url: 'https://cdn.test/x.png', alt: 'X' },
};

function base(over: Partial<DesignerProposal>): DesignerProposal {
  return { version: DESIGNER_PROPOSAL_VERSION, baseRevision: BASE_REVISION, document: DOCUMENT, ...over };
}

describe('planDesignerMutation', () => {
  it('reuses an existing operation batch verbatim', () => {
    const batch = { version: DOCUMENT_OPERATIONS_VERSION, baseRevision: BASE_REVISION, operations: OPERATIONS };
    const plan = planDesignerMutation(base({ operations: batch }));
    expect(plan).toEqual({ kind: 'operations', batch });
  });

  it('reuses an existing insertion verbatim', () => {
    const plan = planDesignerMutation(base({ insertion: INSERTION }));
    expect(plan).toEqual({ kind: 'insertion', operation: INSERTION });
  });

  it('prefers operations over an insertion when both are somehow present', () => {
    const batch = { version: DOCUMENT_OPERATIONS_VERSION, baseRevision: BASE_REVISION, operations: OPERATIONS };
    const plan = planDesignerMutation(base({ operations: batch, insertion: INSERTION }));
    expect(plan.kind).toBe('operations');
  });

  it('reports a generation request as unsupported until it is confirmed', () => {
    const plan = planDesignerMutation(
      base({ acquisition: { kind: 'generation_required', provider: 'openai', model: 'gpt-image-1' } }),
    );
    expect(plan).toEqual({
      kind: 'unsupported',
      code: 'generation_required',
      reason: DESIGNER_MUTATION_UNSUPPORTED_COPY.generation_required,
    });
  });

  it('reports a canonical-document-only proposal as unsupported, never a replacement', () => {
    const plan = planDesignerMutation(base({}));
    expect(plan).toEqual({
      kind: 'unsupported',
      code: 'canonical_document_only',
      reason: DESIGNER_MUTATION_UNSUPPORTED_COPY.canonical_document_only,
    });
  });
});

describe('isDesignerMutationRepresentable', () => {
  it('accepts operation and insertion plans', () => {
    const batch = { version: DOCUMENT_OPERATIONS_VERSION, baseRevision: BASE_REVISION, operations: OPERATIONS };
    expect(isDesignerMutationRepresentable(planDesignerMutation(base({ operations: batch })))).toBe(true);
    expect(isDesignerMutationRepresentable(planDesignerMutation(base({ insertion: INSERTION })))).toBe(true);
  });

  it('rejects unsupported plans', () => {
    expect(isDesignerMutationRepresentable(planDesignerMutation(base({})))).toBe(false);
  });
});
