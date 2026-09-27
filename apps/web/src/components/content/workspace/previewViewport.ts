/**
 * Preview viewport model (R5.7).
 *
 * Responsive inspection, not device emulation. The canonical renderer owns its
 * responsive behaviour with viewport media queries at 640 / 768 / 1024 px, so a
 * truthful preview must give the rendered document a real viewport whose width
 * sits inside the intended band. These widths are therefore derived from the
 * renderer's own breakpoints rather than invented device sizes:
 *
 * - mobile:  below the first breakpoint (640)
 * - tablet:  between the second and third breakpoint (768-1023)
 * - desktop: at the first large breakpoint (1024+)
 *
 * The set is deliberately small. Adding a mode is a UI-only change; the
 * document and the renderer are never aware of it.
 */
export const PREVIEW_VIEWPORTS = [
  { id: 'desktop', label: 'Desktop', width: 1280 },
  { id: 'tablet', label: 'Tablet', width: 834 },
  { id: 'mobile', label: 'Mobile', width: 390 },
] as const;

export type PreviewViewport = (typeof PREVIEW_VIEWPORTS)[number]['id'];

export const DEFAULT_PREVIEW_VIEWPORT: PreviewViewport = 'desktop';

/** The render viewport width, in CSS pixels, for a preview mode. */
export function previewViewportWidth(id: PreviewViewport): number {
  return (PREVIEW_VIEWPORTS.find((viewport) => viewport.id === id) ?? PREVIEW_VIEWPORTS[0]).width;
}
