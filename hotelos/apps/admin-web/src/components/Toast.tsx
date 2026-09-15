// Toast store + provider (same `useToast()` API as before). The rendering is
// Cocoa 22 (`components/cocoa/CocoaToast`): content bg, radius 12, shadow
// popover, 3 px tone bar, `--cocoa-z-toast`; desktop bottom-right above the
// action bars (`--hotelos-toast-offset`), phone below the toolbar at full
// width. Max 3 visible, 4 s by default, role=status / alert.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CocoaToast, CocoaToastViewport, type CocoaToastVariant } from "./cocoa/CocoaToast";

export type ToastVariant = CocoaToastVariant;

export interface ToastOptions {
  variant?: ToastVariant;
  duration?: number;
}

interface ToastRecord {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastContextValue {
  showToast: (message: string, options?: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const MAX_VISIBLE = 3;
const DEFAULT_DURATION = 4000;

// Internal store, outside React so <ToastHost /> can mount next to the
// provider's children without prop-drilling.
type Listener = (toasts: ToastRecord[]) => void;

const toastStore = (() => {
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
      const record: ToastRecord = { id, message, variant: options?.variant ?? "info", duration: options?.duration ?? DEFAULT_DURATION };
      toasts = [...toasts, record];
      emit();
      return id;
    },
    dismiss(id: number) {
      toasts = toasts.filter((t) => t.id !== id);
      emit();
    }
  };
})();

export function ToastProvider({ children }: { children: ReactNode }) {
  const showToast = useCallback((message: string, options?: ToastOptions) => {
    toastStore.push(message, options);
  }, []);
  const value = useMemo<ToastContextValue>(() => ({ showToast }), [showToast]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

export function ToastHost() {
  const [toasts, setToasts] = useState<ToastRecord[]>(() => toastStore.getToasts());

  useEffect(() => toastStore.subscribe(setToasts), []);

  const handleDismiss = useCallback((id: number | string) => {
    toastStore.dismiss(Number(id));
  }, []);

  // SSR guard: only render on the client where document is available.
  if (typeof document === "undefined") return null;

  const visible = toasts.slice(-MAX_VISIBLE);

  return createPortal(
    <CocoaToastViewport>
      {visible.map((toast) => (
        <CocoaToast key={toast.id} id={toast.id} message={toast.message} variant={toast.variant} duration={toast.duration} onDismiss={handleDismiss} />
      ))}
    </CocoaToastViewport>,
    document.body
  );
}
