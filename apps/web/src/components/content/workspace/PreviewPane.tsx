/**
 * In-editor preview of the live document.
 *
 * Renders the current Tiptap document through the shared canonical bridge and
 * the `CanonicalRenderer`, so the preview uses the same design tokens as the
 * canvas. When the document cannot be represented canonically the pane says so
 * plainly instead of showing a diverging or stale render - the honesty rule
 * applies to previews too.
 */
import { useMemo } from 'react';
import type { TipDoc } from '@seo/contracts';
import { CanonicalRenderer } from '../../canonicalRenderer/CanonicalRenderer';
import { canonicalFromEditorDocument } from '../editorDraft';

export function PreviewPane({ doc }: { doc: TipDoc }) {
  const result = useMemo(() => {
    try {
      return { document: canonicalFromEditorDocument(doc) } as const;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) } as const;
    }
  }, [doc]);

  if ('error' in result) {
    return (
      <div
        className="rounded-[10px] border border-dashed bg-card p-4 text-sm text-muted-foreground"
        data-testid="preview-fallback"
      >
        <p className="m-0 font-medium text-foreground">Preview is not available for this document yet.</p>
        <p className="mt-1">
          Part of this document cannot be rendered as a canonical page, so no preview is shown rather than a misleading
          one. Your content is safe and still editable.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-[10px] border bg-card p-3" data-testid="preview-pane">
      <CanonicalRenderer document={result.document} />
    </div>
  );
}
