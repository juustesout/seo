/**
 * In-editor preview of the live document (R5.7).
 *
 * Preview is a rendering/inspection surface, never a second editor: it renders
 * the current document revision through the shared canonical bridge and the
 * `CanonicalRenderer`, so it uses the same design tokens as the canvas and
 * carries no document state of its own. The editor remains the only source of
 * document mutations.
 *
 * The canonical renderer owns its responsive behaviour with viewport media
 * queries, so the document is rendered into an isolated `srcdoc` iframe whose
 * viewport is the selected width. That is the only way to inspect tablet/mobile
 * layout truthfully without duplicating the renderer's breakpoint rules or
 * changing the shared renderer used elsewhere. The iframe is sandboxed, so
 * preview styling cannot corrupt the workspace and workspace styling cannot
 * leak into the rendered page. When the document cannot be represented
 * canonically the pane says so plainly instead of showing a diverging render.
 */
import { useMemo } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Monitor, Smartphone, Tablet } from 'lucide-react';
import type { TipDoc } from '@seo/contracts';
import { Button } from '@/components/ui/button';
import { CanonicalRenderer } from '../../canonicalRenderer/CanonicalRenderer';
import canonicalRendererCss from '../../canonicalRenderer/canonicalRenderer.css?inline';
import { canonicalFromEditorDocument } from '../editorDraft';
import { useDesignSystem } from '../../../lib/designSystem';
import {
  DEFAULT_PREVIEW_VIEWPORT,
  PREVIEW_VIEWPORTS,
  previewViewportWidth,
  type PreviewViewport,
} from './previewViewport';

const VIEWPORT_ICONS = { desktop: Monitor, tablet: Tablet, mobile: Smartphone } as const;

/**
 * A complete, self-contained document for the isolated frame. Only the
 * canonical renderer's own stylesheet is injected; the design tokens travel
 * inline on `.cosmos-doc` inside the serialized markup, so the frame needs no
 * application CSS and cannot inherit any.
 */
function frameDocument(markup: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<style>${canonicalRendererCss}</style>`,
    '<style>html,body{margin:0;padding:0}body{background:#fff}</style>',
    `</head><body>${markup}</body></html>`,
  ].join('');
}

export interface PreviewPaneProps {
  doc: TipDoc;
  /** Workspace-owned viewport inspection mode (document-scoped, shell-owned). */
  viewport?: PreviewViewport;
  /** Reports a viewport change to the workspace; omitted for a static preview. */
  onViewportChange?: (viewport: PreviewViewport) => void;
}

export function PreviewPane({ doc, viewport = DEFAULT_PREVIEW_VIEWPORT, onViewportChange }: PreviewPaneProps) {
  const designSystem = useDesignSystem();
  const result = useMemo(() => {
    try {
      return { document: canonicalFromEditorDocument(doc) } as const;
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) } as const;
    }
  }, [doc]);

  const frame = useMemo(() => {
    if ('error' in result) return null;
    return frameDocument(
      renderToStaticMarkup(<CanonicalRenderer document={result.document} designSystem={designSystem} />),
    );
  }, [result, designSystem]);

  if (frame === null) {
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

  const width = previewViewportWidth(viewport);

  return (
    <div className="grid gap-2" data-testid="preview-pane" data-viewport={viewport}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          Preview of the current document. The viewport only changes how it is inspected.
        </span>
        {onViewportChange && (
          <div role="group" aria-label="Preview viewport" className="flex flex-wrap items-center gap-1">
            {PREVIEW_VIEWPORTS.map((option) => {
              const Icon = VIEWPORT_ICONS[option.id];
              const active = option.id === viewport;
              return (
                <Button
                  key={option.id}
                  type="button"
                  size="sm"
                  variant={active ? 'secondary' : 'outline'}
                  aria-pressed={active}
                  aria-label={option.label}
                  title={`${option.label} (${option.width}px)`}
                  onClick={() => onViewportChange(option.id)}
                >
                  <Icon aria-hidden="true" />
                  {option.label}
                </Button>
              );
            })}
          </div>
        )}
      </div>
      <div className="overflow-x-auto rounded-[10px] border bg-card p-3">
        <iframe
          title="Document preview"
          data-testid="preview-frame"
          data-viewport={viewport}
          data-width={width}
          sandbox=""
          srcDoc={frame}
          className="mx-auto block rounded bg-white"
          style={{ width, height: 640, border: 0 }}
        />
      </div>
    </div>
  );
}
