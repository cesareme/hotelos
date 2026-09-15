// useRateGridDraft — React binding of the draft store: reducer + undo/redo +
// localStorage autosave per (property, user) + restore banner.
//
// The reducer itself is pure (draft-store.ts). This hook:
//   · keeps the store in `useReducer`;
//   · autosaves the present draft (debounced 400 ms) under
//     `draftStorageKey(propertyId, userId)` and clears the key when empty;
//   · on mount / property change, looks for a saved draft and exposes it as
//     `restorable` ({ count, savedAt }) so the status bar can offer
//     "Tienes N cambios sin publicar de ayer · Restaurar / Descartar".
// localStorage access is wrapped in try/catch (private mode, quota, etc.):
// autosave degrades to "no persistence", never to a crash.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  canRedo,
  canUndo,
  deserializeDraft,
  draftChangeCount,
  draftIsEmpty,
  draftReducer,
  draftStorageKey,
  emptyDraft,
  initialDraftStore,
  serializeDraft,
  type DraftAction,
  type DraftStoreState
} from "./draft-store";
import type { DraftState } from "./types";

const AUTOSAVE_DEBOUNCE_MS = 400;

export interface UseRateGridDraftOptions {
  propertyId: string;
  userId: string;
  /** Disable persistence (e.g. read-only users). */
  persist?: boolean;
}

export interface UseRateGridDraftResult {
  store: DraftStoreState;
  draft: DraftState;
  dispatch: (action: DraftAction) => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  canUndo: boolean;
  canRedo: boolean;
  changeCount: number;
  restorable: { count: number; savedAt: string; draft: DraftState } | null;
  restore: () => void;
  discardRestorable: () => void;
  lastSavedAt: string | null;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Storage unavailable (private mode, disabled): behave as if nothing was saved.
    return null;
  }
}

function writeStorage(key: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    // Quota / disabled storage: autosave silently degrades; the in-memory draft is intact.
    return false;
  }
}

export function useRateGridDraft(options: UseRateGridDraftOptions): UseRateGridDraftResult {
  const { propertyId, userId, persist = true } = options;
  const storageKey = useMemo(() => draftStorageKey(propertyId, userId), [propertyId, userId]);
  const [store, dispatch] = useReducer(draftReducer, undefined, () => initialDraftStore(emptyDraft()));
  const [restorable, setRestorable] = useState<UseRateGridDraftResult["restorable"]>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const skipNextSave = useRef(false);

  // Look for a saved draft when the (property, user) pair changes.
  useEffect(() => {
    if (!persist || typeof window === "undefined") return;
    const saved = deserializeDraft(readStorage(storageKey), propertyId, userId);
    if (saved && !draftIsEmpty(saved.draft)) {
      setRestorable({ count: draftChangeCount(saved.draft), savedAt: saved.savedAt, draft: saved.draft });
    } else {
      setRestorable(null);
    }
    skipNextSave.current = true;
    dispatch({ type: "restore", draft: emptyDraft() });
  }, [storageKey, propertyId, userId, persist]);

  // Debounced autosave of the present draft.
  useEffect(() => {
    if (!persist || typeof window === "undefined") return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (draftIsEmpty(store.present)) {
        writeStorage(storageKey, null);
        return;
      }
      const now = new Date().toISOString();
      if (writeStorage(storageKey, serializeDraft(store.present, propertyId, userId, now))) setLastSavedAt(now);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [store.present, storageKey, propertyId, userId, persist]);

  const restore = useCallback(() => {
    if (!restorable) return;
    dispatch({ type: "restore", draft: restorable.draft });
    setRestorable(null);
  }, [restorable]);

  const discardRestorable = useCallback(() => {
    setRestorable(null);
    writeStorage(storageKey, null);
  }, [storageKey]);

  return {
    store,
    draft: store.present,
    dispatch,
    undo: useCallback(() => dispatch({ type: "undo" }), []),
    redo: useCallback(() => dispatch({ type: "redo" }), []),
    clear: useCallback(() => dispatch({ type: "clear" }), []),
    canUndo: canUndo(store),
    canRedo: canRedo(store),
    changeCount: draftChangeCount(store.present),
    restorable,
    restore,
    discardRestorable,
    lastSavedAt
  };
}

export default useRateGridDraft;
