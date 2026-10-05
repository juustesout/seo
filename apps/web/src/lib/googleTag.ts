/**
 * Public Google tag (gtag.js) loader.
 *
 * The web app is a single-page app with one shared document head
 * (`apps/web/index.html`), so there is no per-page <head> to paste the tag
 * into. Instead the tag is injected once, client-side, and only while a public
 * surface (the signed-out screen or a legal document) is on screen - the
 * authenticated workspace is never tagged. Google's "at most one tag per page"
 * rule is enforced by a module-level guard that also respects an already
 * present tag, so HMR, remounts and multiple callers cannot double-add.
 */
import { useEffect } from 'react';

/** Measurement id baked in when no override is configured. */
const DEFAULT_MEASUREMENT_ID = 'G-X60HNL48JV';

/**
 * The measurement id to use, or null to disable tracking. Set
 * `VITE_GOOGLE_TAG_ID` to override; set it empty (or to `disabled`) to turn the
 * tag off entirely (for example in a local environment).
 */
export function resolvedGoogleTagId(): string | null {
  const raw = import.meta.env.VITE_GOOGLE_TAG_ID as string | undefined;
  if (raw === undefined) return DEFAULT_MEASUREMENT_ID;
  const value = raw.trim();
  return value === '' || value === 'disabled' ? null : value;
}

let loaded = false;

/**
 * Inject the gtag.js snippet exactly once. Returns true when tracking is
 * enabled (the tag is or was added), false when it is disabled.
 */
export function loadGoogleTag(id: string | null = resolvedGoogleTagId()): boolean {
  if (typeof document === 'undefined') return false;
  if (loaded) return true;
  if (!id) return false;
  // Guard the inline `config('…')` interpolation against injection from a
  // malformed environment value; a real measurement id is alphanumeric/dashes.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return false;
  if (document.head.querySelector('script[data-seo-gtag]')) {
    loaded = true;
    return true;
  }
  loaded = true;

  const loader = document.createElement('script');
  loader.async = true;
  loader.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  loader.dataset.seoGtag = 'loader';
  document.head.appendChild(loader);

  const config = document.createElement('script');
  config.dataset.seoGtag = 'config';
  config.text = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${id}');`;
  document.head.appendChild(config);

  return true;
}

/** Injects the tag once while `enabled` (a public surface) is on screen. */
export function useGoogleTag(enabled: boolean): void {
  useEffect(() => {
    if (enabled) loadGoogleTag();
  }, [enabled]);
}
