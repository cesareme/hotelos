import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

export type ToastVariant = "success" | "error" | "info";

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

// Internal store. Living outside React so <ToastHost /> can be mounted at the
// same level as <ToastProvider> children without prop-drilling.
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
      const record: ToastRecord = {
        id,
        message,
        variant: options?.variant ?? "info",
        duration: options?.duration ?? DEFAULT_DURATION
      };
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
  if (!ctx) {
    throw new Error("useToast must be used within <ToastProvider>");
  }
  return ctx;
}

const variantBorder: Record<ToastVariant, string> = {
  success: "var(--ok, var(--ok-ink, #0a6b46))",
  error: "var(--danger, var(--danger-ink, #8d1b1b))",
  info: "var(--info, var(--info-ink, #1a3d8a))"
};

interface ToastItemProps {
  toast: ToastRecord;
  onDismiss: (id: number) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (toast.duration <= 0) return;
    timerRef.current = setTimeout(() => onDismiss(toast.id), toast.duration);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.duration, toast.id, onDismiss]);

  const style: React.CSSProperties = {
    background: "var(--surface-1, var(--surface, #ffffff))",
    color: "var(--ink, #1a1a1a)",
    borderLeft: `4px solid ${variantBorder[toast.variant]}`,
    padding: "var(--space-3, 12px) var(--space-4, 16px)",
    borderRadius: "var(--radius-md, 12px)",
    boxShadow: "var(--shadow-lg, 0 4px 14px rgba(26,26,26,0.08), 0 24px 60px rgba(26,26,26,0.10))",
    minWidth: 260,
    maxWidth: 380,
    cursor: "pointer",
    fontSize: "var(--fs-sm, 13px)",
    lineHeight: "var(--lh-snug, 1.35)",
    animation: "guide-rise 180ms cubic-bezier(0.32, 0.72, 0.36, 1)",
    pointerEvents: "auto"
  };

  // a11y: error toasts use role="alert" + aria-live="assertive" so screen
  // readers interrupt the user; success/info use polite. Keyboard handlers
  // allow dismissing via Enter/Space when the toast receives focus.
  const isError = toast.variant === "error";
  return (
    <div
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-label={`Notificación: ${toast.message}. Pulsa Enter para descartar.`}
      tabIndex={0}
      style={style}
      onClick={() => onDismiss(toast.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "Escape") {
          e.preventDefault();
          onDismiss(toast.id);
        }
      }}
    >
      {toast.message}
    </div>
  );
}

export function ToastHost() {
  const [toasts, setToasts] = useState<ToastRecord[]>(() => toastStore.getToasts());

  useEffect(() => toastStore.subscribe(setToasts), []);

  const handleDismiss = useCallback((id: number) => {
    toastStore.dismiss(id);
  }, []);

  // SSR guard: only render on the client where document is available.
  if (typeof document === "undefined") return null;

  const visible = toasts.slice(-MAX_VISIBLE);

  const containerStyle: React.CSSProperties = {
    position: "fixed",
    right: "var(--space-6, 24px)",
    bottom: "var(--space-6, 24px)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2, 8px)",
    zIndex: 1000,
    pointerEvents: "none"
  };

  const node = (
    <div style={containerStyle} aria-label="Notificaciones">
      {visible.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={handleDismiss} />
      ))}
    </div>
  );

  return createPortal(node, document.body);
}
