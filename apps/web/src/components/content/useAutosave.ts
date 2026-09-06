import { useEffect, useRef, useState } from 'react';

export type AutosaveStatus = 'saved' | 'unsaved' | 'saving' | 'failed';

interface UseAutosaveOptions {
  enabled: boolean;
  delayMs?: number;
  /** Serialize the current document+metadata to a canonical string. */
  makeSnapshot: () => string;
  /** Persist one snapshot (parsed back to an object by the caller). */
  persist: (snapshot: string) => Promise<void>;
}

/**
 * Debounced autosave with a single in-flight request. A newer edit that lands
 * while a save is running is saved again right after it completes, so an older
 * save never overwrites newer edits and requests never overlap.
 */
export function useAutosave({ enabled, delayMs = 1600, makeSnapshot, persist }: UseAutosaveOptions) {
  const [status, setStatus] = useState<AutosaveStatus>('saved');

  const makeRef = useRef(makeSnapshot);
  makeRef.current = makeSnapshot;
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const baselineRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const rerunRef = useRef(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const doSave = async () => {
    clearTimer();
    const payload = makeRef.current();
    if (baselineRef.current === payload) {
      setStatus('saved');
      return;
    }
    if (busyRef.current) {
      rerunRef.current = true;
      return;
    }
    busyRef.current = true;
    setStatus('saving');
    try {
      await persistRef.current(payload);
      baselineRef.current = payload;
      busyRef.current = false;
      if (rerunRef.current) {
        rerunRef.current = false;
        void doSave();
      } else {
        setStatus('saved');
      }
    } catch {
      busyRef.current = false;
      rerunRef.current = false;
      setStatus('failed');
    }
  };

  // Debounce: any change schedules a save; leaving the workspace cancels it.
  useEffect(() => {
    if (!enabled) {
      clearTimer();
      return;
    }
    if (baselineRef.current === makeRef.current()) return;
    setStatus((s) => (s === 'saving' ? s : 'unsaved'));
    clearTimer();
    timerRef.current = window.setTimeout(() => void doSave(), delayMs);
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, makeSnapshot, delayMs]);

  // The workspace may set a baseline (freshly loaded row or a brand-new
  // document) so that an untouched editor is never saved.
  const setBaseline = (snapshot: string) => {
    baselineRef.current = snapshot;
    if (!busyRef.current) setStatus('saved');
  };

  /** Immediate save, used by explicit Save / Publish actions. */
  const saveNow = () => void doSave();

  return { status, setBaseline, saveNow };
}
