/**
 * R5.4.5: the composition review dialog.
 *
 * The review is a boundary, not an editor: it shows the immutable batch Composer
 * produced (composition, a plain-language operation summary, and any gaps) and
 * offers exactly two outcomes. These tests pin those contracts: the composition
 * is rendered with the existing renderer, the summary is derived from the batch's
 * operations, gaps are surfaced only when present, and Apply/Cancel report back
 * without the dialog mutating anything itself.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  COMPOSITION_OPERATION_BATCH_VERSION,
  MARKETING_STORYBOARD_PLAN,
  applyCompositionSlotFills,
  compileComposition,
  compositionSlotKindOf,
  isWritableCompositionSlot,
  type CanonicalDocument,
  type CompositionGap,
  type CompositionOperationBatch,
  type DocumentOperation,
} from '@seo/contracts';
import { CompositionReviewDialog, summarizeCompositionOperations } from './CompositionReviewDialog';

function filledDocument(): CanonicalDocument {
  const compiled = compileComposition(MARKETING_STORYBOARD_PLAN);
  const fills = compiled.slots.slots.filter(isWritableCompositionSlot).map((ref) =>
    compositionSlotKindOf(ref) === 'items'
      ? { slot: ref.slot, items: [`item ${ref.slot}`] }
      : { slot: ref.slot, text: `copy for ${ref.slot}` },
  );
  return applyCompositionSlotFills(compiled, fills).document;
}

const OPERATIONS: DocumentOperation[] = [
  { type: 'insert_section', ref: 'hero', section: { kind: 'hero' }, position: { mode: 'document_end' } },
  { type: 'insert_section', ref: 's1', section: { kind: 'section' }, position: { mode: 'document_end' } },
  { type: 'insert_text', target: { mode: 'ref', ref: 'hero' }, block: { type: 'heading', level: 1, text: 'Title' } },
  { type: 'insert_text', target: { mode: 'ref', ref: 'hero' }, block: { type: 'paragraph', text: 'Body' } },
  { type: 'insert_text', target: { mode: 'ref', ref: 'hero' }, block: { type: 'paragraph', text: 'More' } },
  {
    type: 'insert_image',
    target: { mode: 'ref', ref: 's1' },
    image: { assetId: 'asset-1', url: 'https://cdn.example/image.png', alt: 'A diagram' },
  },
];

function batch(overrides: Partial<CompositionOperationBatch> = {}): CompositionOperationBatch {
  return {
    version: COMPOSITION_OPERATION_BATCH_VERSION,
    composition: filledDocument(),
    plan: MARKETING_STORYBOARD_PLAN,
    operations: OPERATIONS,
    gaps: [],
    ...overrides,
  };
}

describe('summarizeCompositionOperations', () => {
  it('counts the batch operations in plain language in document order', () => {
    expect(summarizeCompositionOperations(OPERATIONS)).toEqual([
      { label: 'Hero section', count: 1 },
      { label: 'Section', count: 1 },
      { label: 'Heading', count: 1 },
      { label: 'Paragraph', count: 2 },
      { label: 'Image', count: 1 },
    ]);
  });

  it('returns an empty summary for an empty batch', () => {
    expect(summarizeCompositionOperations([])).toEqual([]);
  });
});

describe('CompositionReviewDialog', () => {
  it('renders the composition with the existing renderer and a provenance line', () => {
    const { container } = render(
      <CompositionReviewDialog batch={batch()} onApply={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(screen.getByRole('dialog', { name: 'Review composition' })).toBeTruthy();
    expect(container.querySelector('[data-cosmos-document]')).not.toBeNull();
    expect(screen.getByTestId('composition-review-provenance').textContent).toContain('Landing page');
  });

  it('derives the operation summary from the batch operations', () => {
    render(<CompositionReviewDialog batch={batch()} onApply={vi.fn()} onCancel={vi.fn()} />);

    const summary = screen.getByTestId('composition-review-operations');
    expect(summary.textContent).toContain('Hero section');
    expect(summary.textContent).toContain('Paragraph');
    expect(summary.textContent).toContain('Image');
  });

  it('hides the gap section when the batch has no gaps', () => {
    render(<CompositionReviewDialog batch={batch({ gaps: [] })} onApply={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByTestId('composition-review-gaps')).toBeNull();
  });

  it('surfaces unsupported structures as gaps', () => {
    const gaps: CompositionGap[] = [
      { path: [2], type: 'footer', code: 'unsupported_content', message: 'A footer cannot be added yet.' },
    ];
    render(<CompositionReviewDialog batch={batch({ gaps })} onApply={vi.fn()} onCancel={vi.fn()} />);

    const section = screen.getByTestId('composition-review-gaps');
    expect(section.textContent).toContain('A footer cannot be added yet.');
  });

  it('reports Apply and Cancel without mutating anything itself', () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(<CompositionReviewDialog batch={batch()} onApply={onApply} onCancel={onCancel} />);

    fireEvent.click(screen.getByTestId('composition-review-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('composition-review-apply'));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('disables Apply when there is nothing to add', () => {
    render(<CompositionReviewDialog batch={batch({ operations: [] })} onApply={vi.fn()} onCancel={vi.fn()} />);

    expect((screen.getByTestId('composition-review-apply') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('composition-review-operations').textContent).toContain(
      'no content that the document can currently represent',
    );
  });
});
