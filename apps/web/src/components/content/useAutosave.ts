import { useEffect, useRef, useState } from 'react';

export type AutosaveStatus = 'saved' | 'unsaved' | 'saving' | 'failed';

interface UseAutosaveOptions {
  enabled: boolean;
  delayMs?: number;
  /** Serialize the current document+metadata to a canonical string. */
  makeSnapshot: () => string;
  /**
   * A value that changes whenever the workspace changes, used only to schedule
   * the debounce. It is read from a ref, so status transitions never restart the
   * timer (that was the source of the old self-trigger loop).
   */
  snapshotKey: string;
  /** Persist one snapshot (parsed back to an object by the caller). */
  persist: (snapshot: string) => Promise<void>;
}

/**
 * Debounced autosave with a single in-flight request. A newer edit that lands
 * while a save is running is saved again right after it completes, so an older
 * save never overwrites newer edits and requests never overlap. `dirty` is
 * derived from the same baseline as the save decision, so the two can never
 * disagree.
 */
export function useAutosave({ enabled, delayMs = 1600, makeSnapshot, snapshotKey, persist }: UseAutosaveOptions) {
  const [status, setStatus] = useState<AutosaveStatus>('saved');

  const makeRef = useRef(makeSnapshot);
  makeRef.current = makeSnapshot;
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const baselineRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const rerunRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef<Promise<boolean> | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  /**
   * Persist until the workspace stops changing, resolving `true` when it is
   * fully saved and `false` when a persist failed (the workspace stays dirty).
   * A caller that arrives while a save is in flight joins that running chain and
   * marks it for a rerun, so the newest edits are always included before it
   * settles and requests never overlap.
   */
  const runSave = (): Promise<boolean> => {
    if (busyRef.current) {
      rerunRef.current = true;
      return inFlightRef.current ?? Promise.resolve(false);
    }
    const chain = (async () => {
      for (;;) {
        clearTimer();
        const payload = makeRef.current();
        if (baselineRef.current === null || baselineRef.current === payload) {
          setStatus('saved');
          return true;
        }
        busyRef.current = true;
        setStatus('saving');
        try {
          await persistRef.current(payload);
          baselineRef.current = payload;
        } catch {
          busyRef.current = false;
          rerunRef.current = false;
          setStatus('failed');
          return false;
        }
        busyRef.current = false;
        if (!(rerunRef.current || makeRef.current() !== payload)) {
          setStatus('saved');
          return true;
        }
        rerunRef.current = false;
      }
    })();
    inFlightRef.current = chain;
    void chain.finally(() => {
      if (inFlightRef.current === chain) inFlightRef.current = null;
    });
    return chain;
  };

  // Debounce: a workspace change or lifecycle/config change (re)schedules the
  // save. `snapshotKey` is the value form of the snapshot, so status updates
  // (unsaved -> saving -> saved) do not restart the timer. The baseline guard
  // means an untouched, freshly opened document is never persisted.
  useEffect(() => {
    if (!enabled || baselineRef.current === null) {
      clearTimer();
      return;
    }
    if (baselineRef.current === snapshotKey) {
      setStatus((current) => (current === 'saving' ? current : 'saved'));
      return;
    }
    setStatus((current) => (current === 'saving' ? current : 'unsaved'));
    clearTimer();
    timerRef.current = window.setTimeout(() => void runSave(), delayMs);
    return clearTimer;
    // makeSnapshot/persist are deliberately read from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, snapshotKey, delayMs]);

  const setBaseline = (snapshot: string) => {
    baselineRef.current = snapshot;
    if (!busyRef.current) setStatus('saved');
  };

  /** Immediate save, used by explicit Save / Publish actions. */
  const saveNow = () => void runSave();

  /**
   * Await the save barrier: flush pending debounces and queued edits, resolving
   * `true` once the workspace is settled (safe to leave the document) or `false`
   * when a persist failed, in which case the workspace is still dirty.
   */
  const flush = (): Promise<boolean> => {
    clearTimer();
    return runSave();
  };

  // Read through the ref so a stale render can never report the wrong state: the
  // comparison uses the same source `runSave` compares against.
  const dirty = baselineRef.current !== null && baselineRef.current !== makeRef.current();

  return { status, dirty, setBaseline, saveNow, flush };
}
