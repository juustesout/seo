/**
 * Composition review dialog (R5.4.5).
 *
 * The user-facing boundary between an immutable `CompositionOperationBatch` and
 * the existing staging/apply pathway. It is deliberately a review, not an editor:
 * the batch shown here is exactly the batch Composer produced, and the only
 * actions are Cancel (leave the document untouched) and Apply (hand the reviewed
 * batch back to the workspace).
 *
 * The composition is rendered with the existing `CanonicalRenderer` - the same
 * renderer the Composer preview and the editor preview use - so there is no
 * second renderer, and the operation summary is derived directly from
 * `batch.operations` (the existing operation vocabulary), never from raw JSON.
 * Unsupported structures are surfaced from `batch.gaps` and are never silently
 * dropped.
 */
import { useMemo } from 'react';
import type { CompositionOperationBatch, CompositionPlanFormat, DocumentOperation } from '@seo/contracts';
import { CanonicalRenderer } from '../components/canonicalRenderer';
import { Button } from '@/components/ui/button';

const FORMAT_LABEL: Record<CompositionPlanFormat, string> = {
  article: 'Article',
  landing_page: 'Landing page',
};

/** One plain-language line in the operation summary. */
export interface CompositionOperationSummaryItem {
  label: string;
  count: number;
}

/**
 * Summarizes a batch's operations in plain language using the actual operation
 * vocabulary. It reads the batch and derives the counts; it stores no second
 * operation representation. Order follows first occurrence in document order.
 */
export function summarizeCompositionOperations(
  operations: DocumentOperation[],
): CompositionOperationSummaryItem[] {
  const counts = new Map<string, number>();
  const bump = (label: string) => counts.set(label, (counts.get(label) ?? 0) + 1);
  for (const operation of operations) {
    if (operation.type === 'insert_section') {
      bump(operation.section.kind === 'hero' ? 'Hero section' : 'Section');
    } else if (operation.type === 'insert_text') {
      bump(operation.block.type === 'heading' ? 'Heading' : 'Paragraph');
    } else {
      bump('Image');
    }
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}

export interface CompositionReviewDialogProps {
  batch: CompositionOperationBatch;
  /** Confirms the reviewed batch; the workspace binds it and runs the apply. */
  onApply: () => void;
  /** Closes the review and leaves the document unchanged. */
  onCancel: () => void;
}

export function CompositionReviewDialog({ batch, onApply, onCancel }: CompositionReviewDialogProps) {
  const summary = useMemo(() => summarizeCompositionOperations(batch.operations), [batch.operations]);
  const formatLabel = batch.plan ? FORMAT_LABEL[batch.plan.format] : null;
  const canApply = batch.operations.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
      role="presentation"
      data-testid="composition-review-backdrop"
    >
      <div
        role="dialog"
        aria-label="Review composition"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border bg-card shadow-xl"
        data-testid="composition-review"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b px-5 py-4">
          <h2 className="text-base font-semibold">Review this composition</h2>
          <p className="mt-1 text-xs text-muted-foreground" data-testid="composition-review-provenance">
            From Composer
            {formatLabel ? ` - ${formatLabel}` : ''}
            {batch.plan?.purpose ? ` - ${batch.plan.purpose}` : ''}
          </p>
        </div>

        <div className="grid gap-4 overflow-y-auto px-5 py-4">
          <section data-testid="composition-review-composition">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Composition</h3>
            <div className="mt-2 overflow-hidden rounded-[10px] border bg-white">
              <CanonicalRenderer document={batch.composition} />
            </div>
          </section>

          <section data-testid="composition-review-operations">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What will be added</h3>
            {summary.length > 0 ? (
              <ul className="m-0 mt-2 list-none divide-y divide-border rounded-md border p-0 text-sm">
                {summary.map((item, index) => (
                  <li
                    key={item.label}
                    className="flex items-center justify-between px-3 py-1.5"
                    data-testid={`composition-review-operation-${index}`}
                  >
                    <span className="text-foreground">{item.label}</span>
                    <span className="text-muted-foreground">{item.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                This composition has no content that the document can currently represent.
              </p>
            )}
          </section>

          {batch.gaps.length > 0 && (
            <section
              className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning"
              data-testid="composition-review-gaps"
            >
              <h3 className="text-xs font-semibold uppercase tracking-wide">Not added</h3>
              <p className="m-0 mt-1">
                Some generated content cannot be represented as document operations yet. It will be left out.
              </p>
              <ul className="m-0 mt-1 list-disc pl-5">
                {batch.gaps.map((gap, index) => (
                  <li key={`${gap.code}-${index}`}>{gap.message}</li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t px-5 py-4">
          <Button type="button" size="sm" variant="outline" data-testid="composition-review-cancel" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" size="sm" data-testid="composition-review-apply" disabled={!canApply} onClick={onApply}>
            Apply to document
          </Button>
        </div>
      </div>
    </div>
  );
}
