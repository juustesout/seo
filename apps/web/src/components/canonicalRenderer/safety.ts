/**
 * Narrow URL safety for rendered documents.
 *
 * Canonical values are validated structurally, but URLs still come from
 * external systems. These helpers only allow schemes that cannot execute
 * script, so the renderer never becomes an HTML/script execution surface.
 */

const SAFE_HREF_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** Allow http(s)/mailto/tel and relative URLs; reject javascript:, data:, ... */
export function safeHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const href = value.trim();
  if (href.length === 0) return undefined;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(href);
  if (!scheme) return href;
  return SAFE_HREF_SCHEMES.has(`${scheme[1]!.toLowerCase()}:`) ? href : undefined;
}

/** Allow relative and http(s)/inline-image sources; reject everything else. */
export function safeImageSrc(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const src = value.trim();
  if (src.length === 0) return undefined;
  if (src.startsWith('/')) return src;
  if (/^https?:\/\//i.test(src)) return src;
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(src)) return src;
  return undefined;
}
