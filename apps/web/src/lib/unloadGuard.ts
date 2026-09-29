import { useEffect } from 'react';

/**
 * Native unsaved-changes exit guard (R5.11.1).
 *
 * Reload, tab close and crash are the one navigation the app cannot intercept:
 * by the time the page is torn down the canonical autosave can no longer
 * complete. The browser's own `beforeunload` prompt is the honest guard, so it is
 * installed only while the workspace is `dirty` and removed as soon as the
 * document is saved (or no document is open), which also stops a clean exit from
 * warning.
 *
 * This is deliberately not a second save mechanism. It never persists anything
 * and never claims the document was saved; it only asks the browser to confirm
 * leaving. There is intentionally no `pagehide`/`sendBeacon` flush: the canonical
 * persist is an authenticated JSON `fetch`, which the browser does not guarantee
 * to complete during teardown, so a fire-and-forget call there would give false
 * confidence - and a beacon body/headers cannot express that request faithfully.
 *
 * Browser limitations (documented, not worked around): modern browsers ignore a
 * custom message and show their own generic copy, and a prompt is only shown
 * once the page has had a user interaction.
 */
export function useUnloadGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): string => {
      // Custom text is ignored by modern browsers; `preventDefault` plus a
      // `returnValue` assignment is what marks the event as "unsaved".
      event.preventDefault();
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}
