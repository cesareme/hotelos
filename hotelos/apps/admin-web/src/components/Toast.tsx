// Toast store + provider (same `useToast()` API as before). The rendering is
// Cocoa 22 (`components/cocoa/CocoaToast`): content bg, radius 12, shadow
// popover, 3 px tone bar, `--cocoa-z-toast`; desktop bottom-right above the
// action bars (`--hotelos-toast-offset`), phone below the toolbar at full
// width. Max 3 visible, 4 s by default, role=status / alert.
//
// Tanda UX-1 · U4 (docs/design/UX-RECEPCION-FEEL.md §4 «Toast con acción /
// deshacer», F17, F29): `showToast(message, { action, pauseOnHover,
// announce })` returns the toast `id`; `dismissToast(id)` closes it. A toast
// with an action lasts 8 s by default; `announce` sends the text to the
// shell's single live region (CocoaLiveRegion `announce`) and the item stays
// silent (one announcement, R5). The old calls (`showToast(message)` /
// `{ variant, duration }`) keep compiling and behaving the same.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { announce as announceToShell, hasAnnouncerListeners } from "./cocoa/CocoaLiveRegion";
import { CocoaToast, CocoaToastViewport, type CocoaToastAction, type CocoaToastVariant } from "./cocoa/CocoaToast";
import { UNDO_LABEL, isEditableTarget, isUndoShortcut } from "./cocoa/CocoaUndoBar";

export type ToastVariant = CocoaToastVariant;
export type ToastAction = CocoaToastAction;

export interface ToastOptions {
  variant?: ToastVariant;
  /** Auto-dismiss after ms; ≤ 0 keeps it until dismissed. Default 4000 (8000 with an action). */
  duration?: number;
  /** «Deshacer», «Ver folio»: a plain button reachable with Tab; the toast closes after it runs. */
  action?: ToastAction;
  /** Pause the timer while hovered or focused (default true). */
  pauseOnHover?: boolean;
  /**
   * Announce through the shell live region: a string reads that text, `false`
   * keeps the toast silent. Default (corrector L-04, R5 «una sola live
   * region»): when the shell region is mounted every toast is read ONCE by it
   * and the item itself carries no live role; without shell (auth, guest-web)
   * the item keeps its own role=status / alert.
   */
  announce?: boolean | string;
}

export interface ToastRecord {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
  action?: ToastAction;
  pauseOnHover: boolean;
  announced: boolean;
}

interface ToastContextValue {
  /** Returns the toast id (for `dismissToast`). */
  showToast: (message: string, options?: ToastOptions) => number;
  dismissToast: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export const MAX_VISIBLE = 3;
export const DEFAULT_DURATION = 4000;
/** A toast that offers an action («Deshacer») stays long enough to reach it (P4: 8 s). */
export const ACTION_DURATION = 8000;

/** Duration of a toast (pure): explicit, else 8 s with an action, else 4 s. */
export function toastDuration(options?: Pick<ToastOptions, "duration" | "action">): number {
  if (options?.duration !== undefined) return options.duration;
  return options?.action ? ACTION_DURATION : DEFAULT_DURATION;
}

/** Text the shell live region reads for a toast (pure): `announce` decides; unset → the message when the shell region is mounted. */
export function toastAnnouncement(message: string, options?: Pick<ToastOptions, "announce">, shellMounted = false): string | null {
  const announce = options?.announce;
  if (announce === false) return null;
  if (typeof announce === "string") return announce;
  if (announce === true) return message;
  return shellMounted ? message : null;
}

// Internal store, outside React so <ToastHost /> can mount next to the
// provider's children without prop-drilling.
type Listener = (toasts: ToastRecord[]) => void;

/** Store factory (pure, no DOM): the singleton below and the unit tests share it. */
export function createToastStore(announceText: (text: string, politeness: "polite" | "assertive") => void = announceToShell, shellMounted: () => boolean = hasAnnouncerListeners) {
  let toasts: ToastRecord[] = [];
  let listeners: Listener[] = [];
  let nextId = 1;

  const emit = () => {
    for (const l of listeners) l(toasts);
  };

  return {
    getToasts: () => toasts,
    subscribe(listener: Listener) {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    push(message: string, options?: ToastOptions): number {
      const id = nextId++;
      const variant = options?.variant ?? "info";
      const announcement = toastAnnouncement(message, options, shellMounted());
      const record: ToastRecord = {
        id,
        message,
        variant,
        duration: toastDuration(options),
        action: options?.action,
        pauseOnHover: options?.pauseOnHover ?? true,
        announced: announcement !== null
      };
      toasts = [...toasts, record];
      emit();
      if (announcement !== null) announceText(announcement, variant === "error" ? "assertive" : "polite");
      return id;
    },
    dismiss(id: number) {
      if (!toasts.some((t) => t.id === id)) return;
      toasts = toasts.filter((t) => t.id !== id);
      emit();
    }
  };
}

/** The app's store (exported for runtime probes and tests; screens use `useToast()`). */
export const toastStore = createToastStore();

/** Close a toast by id from anywhere (the hook exposes the same). */
export function dismissToast(id: number): void {
  toastStore.dismiss(id);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const showToast = useCallback((message: string, options?: ToastOptions) => toastStore.push(message, options), []);
  const value = useMemo<ToastContextValue>(() => ({ showToast, dismissToast }), [showToast]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

/** The toast ⌘Z / Ctrl+Z undoes (pure): the LAST visible toast whose action is «Deshacer», or null. */
export function undoableToast(toasts: readonly ToastRecord[]): ToastRecord | null {
  for (let index = toasts.length - 1; index >= 0; index -= 1) {
    const toast = toasts[index];
    if (toast.action && toast.action.label === UNDO_LABEL) return toast;
  }
  return null;
}

export function ToastHost() {
  const [toasts, setToasts] = useState<ToastRecord[]>(() => toastStore.getToasts());

  useEffect(() => toastStore.subscribe(setToasts), []);

  // ⌘Z / Ctrl+Z on the last toast with «Deshacer» (corrector L-11 (a): the
  // shortcut ⌘K announces for the timeline works for every undoable toast).
  // Never inside a text field; the CocoaUndoBar handler checks `defaultPrevented`.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isUndoShortcut(event) || isEditableTarget(event.target)) return;
      const toast = undoableToast(toastStore.getToasts());
      if (!toast?.action) return;
      event.preventDefault();
      void toast.action.onAction();
      toastStore.dismiss(toast.id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleDismiss = useCallback((id: number | string) => {
    toastStore.dismiss(Number(id));
  }, []);

  // SSR guard: only render on the client where document is available.
  if (typeof document === "undefined") return null;

  const visible = toasts.slice(-MAX_VISIBLE);

  return createPortal(
    <CocoaToastViewport>
      {visible.map((toast) => (
        <CocoaToast key={toast.id} id={toast.id} message={toast.message} variant={toast.variant} duration={toast.duration} action={toast.action} pauseOnHover={toast.pauseOnHover} announced={toast.announced} onDismiss={handleDismiss} />
      ))}
    </CocoaToastViewport>,
    document.body
  );
}
