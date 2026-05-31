// CocoaKeyboardShortcutsHelp — DEV GLOBAL · W6
//
// Modal sheet (centered, 640px wide, max-height 80vh, scrollable) that fetches
// the keyboard shortcut catalog from `GET /developer/keyboard-shortcuts` and
// renders each category as a collapsible `CocoaFormFieldset`. Inside each
// fieldset, shortcuts are listed in a two-column layout: keys (left, monospace
// small bold) and action (right, label). A search input at the top filters
// shortcuts by keyword in either the keys or action. Footer shows "Cierra con
// Esc" plus version info. A global keydown listener for Cmd+/ (or Ctrl+/) is
// registered to trigger `open` via the optional `onRequestOpen` callback.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import { createPortal } from "react-dom";
import { apiRequest } from "../../services/api-client";
import { CocoaFormFieldset } from "../cocoa-extras/CocoaFormFieldset";
import { CocoaSearchInput } from "../cocoa/CocoaSearchInput";

export interface CocoaKeyboardShortcutsHelpProps {
  open: boolean;
  onClose: () => void;
  /**
   * Optional callback fired when the global Cmd+/ (or Ctrl+/) shortcut is
   * pressed. Typically used by the parent to toggle `open` to true. If
   * omitted, the global listener still runs but no-ops (useful when the
   * parent prefers to manage the shortcut itself).
   */
  onRequestOpen?: () => void;
  /**
   * Optional version string shown in the footer. Defaults to the admin-web
   * package version baked at build-time when available.
   */
  version?: string;
}

export interface CocoaKeyboardShortcut {
  keys: string;
  action: string;
}

export interface CocoaKeyboardShortcutCategory {
  category: string;
  shortcuts: CocoaKeyboardShortcut[];
}

interface KeyboardShortcutsResponse {
  categories: CocoaKeyboardShortcutCategory[];
}

const SHEET_MAX_WIDTH = 640;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  );
  return nodes.filter((node) => {
    if (node.hasAttribute("disabled")) return false;
    if (node.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return true;
  });
}

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0, 0, 0, 0.32)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  padding: "var(--cocoa-space-4)",
  boxSizing: "border-box"
};

const containerStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  maxWidth: SHEET_MAX_WIDTH,
  maxHeight: "80vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--cocoa-background-content)",
  boxShadow: "var(--cocoa-shadow-modal)",
  borderRadius: "var(--cocoa-radius-xl)",
  outline: "none",
  fontFamily: "var(--cocoa-font)",
  color: "var(--cocoa-label)",
  overflow: "hidden"
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "16px 20px",
  borderBottom: "1px solid var(--cocoa-separator)",
  flexShrink: 0
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-title-3)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  color: "var(--cocoa-label)",
  lineHeight: 1.2,
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};

const closeButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: "var(--cocoa-radius-md)",
  background: "transparent",
  border: "1px solid transparent",
  color: "var(--cocoa-label-secondary)",
  cursor: "pointer",
  flexShrink: 0,
  padding: 0
};

const searchWrapperStyle: CSSProperties = {
  padding: "12px 20px",
  borderBottom: "1px solid var(--cocoa-separator)",
  flexShrink: 0,
  background: "var(--cocoa-background-content)"
};

const bodyStyle: CSSProperties = {
  padding: "16px 20px",
  overflow: "auto",
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-3)"
};

const shortcutRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)",
  alignItems: "center",
  gap: "var(--cocoa-space-3)",
  padding: "6px 0",
  borderBottom: "1px solid var(--cocoa-separator)"
};

const shortcutRowLastStyle: CSSProperties = {
  ...shortcutRowStyle,
  borderBottom: "none"
};

const keysStyle: CSSProperties = {
  fontFamily: "var(--cocoa-font-mono)",
  fontSize: "var(--cocoa-fs-footnote)",
  fontWeight: "var(--cocoa-fw-bold)" as unknown as number,
  color: "var(--cocoa-label)",
  letterSpacing: "var(--cocoa-tracking-normal)",
  margin: 0,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis"
};

const actionStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-label-secondary)",
  margin: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};

const footerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "12px 20px",
  borderTop: "1px solid var(--cocoa-separator)",
  flexShrink: 0,
  fontSize: "var(--cocoa-fs-footnote)",
  color: "var(--cocoa-label-secondary)"
};

const footerHintStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6
};

const footerKbdStyle: CSSProperties = {
  fontFamily: "var(--cocoa-font-mono)",
  fontWeight: "var(--cocoa-fw-bold)" as unknown as number,
  padding: "1px 6px",
  borderRadius: "var(--cocoa-radius-sm)",
  background: "var(--cocoa-background-control)",
  border: "1px solid var(--cocoa-separator)",
  color: "var(--cocoa-label)",
  fontSize: "var(--cocoa-fs-caption)"
};

const versionStyle: CSSProperties = {
  fontFamily: "var(--cocoa-font-mono)",
  fontSize: "var(--cocoa-fs-caption)",
  letterSpacing: "var(--cocoa-tracking-normal)",
  color: "var(--cocoa-label-secondary)"
};

const statusMessageStyle: CSSProperties = {
  padding: "var(--cocoa-space-4)",
  textAlign: "center",
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-label-secondary)"
};

const errorMessageStyle: CSSProperties = {
  ...statusMessageStyle,
  color: "var(--cocoa-label)"
};

const DEFAULT_VERSION =
  (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? "0.1.0";

export function CocoaKeyboardShortcutsHelp({
  open,
  onClose,
  onRequestOpen,
  version
}: CocoaKeyboardShortcutsHelpProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [categories, setCategories] = useState<
    CocoaKeyboardShortcutCategory[] | null
  >(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<string>("");

  // Global Cmd+/ (or Ctrl+/) listener — fires onRequestOpen so the parent can
  // toggle `open` to true. Runs even when the sheet is currently closed.
  useEffect(() => {
    function handleGlobalKey(event: globalThis.KeyboardEvent) {
      const isToggle =
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key === "/";
      if (!isToggle) return;
      event.preventDefault();
      if (onRequestOpen) {
        onRequestOpen();
      }
    }
    window.addEventListener("keydown", handleGlobalKey);
    return () => window.removeEventListener("keydown", handleGlobalKey);
  }, [onRequestOpen]);

  // Reset query each time the sheet opens.
  useEffect(() => {
    if (open) {
      setQuery("");
    }
  }, [open]);

  // Fetch the catalog on first open and cache it across subsequent opens.
  useEffect(() => {
    if (!open) return undefined;
    if (categories !== null) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    apiRequest<KeyboardShortcutsResponse>("/developer/keyboard-shortcuts", {
      signal: controller.signal
    })
      .then((res) => {
        setCategories(res.categories ?? []);
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name === "AbortError") return;
        setError(
          err instanceof Error
            ? err.message
            : "No se pudo cargar el catálogo de atajos."
        );
      })
      .finally(() => {
        setLoading(false);
      });
    return () => controller.abort();
  }, [open, categories]);

  // Focus management: trap focus inside the sheet while open and restore on close.
  useEffect(() => {
    if (!open) return undefined;
    previouslyFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? null;

    const root = containerRef.current;
    if (root) {
      const focusables = getFocusableElements(root);
      const first = focusables[0] ?? root;
      window.requestAnimationFrame(() => {
        first.focus({ preventScroll: true });
      });
    }

    return () => {
      const previous = previouslyFocusedRef.current;
      if (previous && typeof previous.focus === "function") {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open]);

  // Close on Esc + body scroll lock while open.
  useEffect(() => {
    if (!open) return undefined;

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  const handleBackdropClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const handleContainerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Tab") return;
      const root = containerRef.current;
      if (!root) return;

      const focusables = getFocusableElements(root);
      if (focusables.length === 0) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || !root.contains(active)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    },
    []
  );

  const filteredCategories = useMemo<CocoaKeyboardShortcutCategory[]>(() => {
    if (categories === null) return [];
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories
      .map((cat) => ({
        category: cat.category,
        shortcuts: cat.shortcuts.filter(
          (s) =>
            s.action.toLowerCase().includes(q) ||
            s.keys.toLowerCase().includes(q)
        )
      }))
      .filter((cat) => cat.shortcuts.length > 0);
  }, [categories, query]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  const resolvedVersion = version ?? DEFAULT_VERSION;

  const node = (
    <div
      style={backdropStyle}
      onMouseDown={handleBackdropClick}
      aria-hidden={false}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cocoa-kbd-help-title"
        tabIndex={-1}
        style={containerStyle}
        onKeyDown={handleContainerKeyDown}
      >
        <div style={headerStyle}>
          <h2 id="cocoa-kbd-help-title" style={titleStyle}>
            Atajos de teclado
          </h2>
          <button
            type="button"
            aria-label="Cerrar"
            onClick={onClose}
            className="cocoa-focus-ring"
            style={closeButtonStyle}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              aria-hidden="true"
              focusable="false"
            >
              <path
                d="M1 1L13 13M13 1L1 13"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div style={searchWrapperStyle}>
          <CocoaSearchInput
            value={query}
            onChange={setQuery}
            placeholder="Buscar por tecla o acción…"
            autoFocus
          />
        </div>

        <div style={bodyStyle}>
          {loading && categories === null ? (
            <div role="status" aria-live="polite" style={statusMessageStyle}>
              Cargando atajos…
            </div>
          ) : null}
          {error ? (
            <div role="alert" style={errorMessageStyle}>
              {error}
            </div>
          ) : null}
          {!loading && !error && filteredCategories.length === 0 ? (
            <div style={statusMessageStyle}>
              {query.trim()
                ? `Sin resultados para "${query}".`
                : "No hay atajos disponibles."}
            </div>
          ) : null}
          {filteredCategories.map((cat) => (
            <CocoaFormFieldset
              key={cat.category}
              title={cat.category}
              collapsible
              defaultOpen
            >
              <div
                role="list"
                aria-label={`Atajos de ${cat.category}`}
                style={{ display: "flex", flexDirection: "column" }}
              >
                {cat.shortcuts.map((s, idx) => {
                  const isLast = idx === cat.shortcuts.length - 1;
                  return (
                    <div
                      key={`${cat.category}-${s.keys}-${s.action}`}
                      role="listitem"
                      style={isLast ? shortcutRowLastStyle : shortcutRowStyle}
                    >
                      <kbd style={keysStyle}>{s.keys}</kbd>
                      <span style={actionStyle}>{s.action}</span>
                    </div>
                  );
                })}
              </div>
            </CocoaFormFieldset>
          ))}
        </div>

        <div style={footerStyle}>
          <span style={footerHintStyle}>
            Cierra con <kbd style={footerKbdStyle}>Esc</kbd>
          </span>
          <span style={versionStyle}>v{resolvedVersion}</span>
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

export default CocoaKeyboardShortcutsHelp;
