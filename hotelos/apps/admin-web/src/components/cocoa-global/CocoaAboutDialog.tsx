// CocoaAboutDialog — NSApplicationAboutWindow-style modal for ehotelOS.
//
// Renders a small, centered modal (width 380px) that surfaces brand,
// version, edition, and quick legal links. Layout, top-to-bottom:
//   - Large app icon (64x64 rounded square with accent → success gradient)
//   - 'ehotelOS' large-title heading
//   - 'Gestión hotelera con IA' italic subtitle
//   - 'Versión <app version>' caption
//   - one-line description
//   - Inline links row: Help center · Keyboard shortcuts · Privacy · Terms
//   - copyright footnote
//   - Filled CocoaButton 'OK' aligned at the bottom
//
// Visuals: blurred backdrop with fade, dialog container with
// var(--cocoa-radius-lg), var(--cocoa-shadow-modal), and a spring scale/
// translate entry powered by var(--cocoa-ease-spring). All colors resolve
// through cocoa-tokens so light/dark themes pick up automatically.
//
// A11y:
// - role="dialog" + aria-modal="true"
// - aria-labelledby on the title
// - ESC closes the dialog
// - Focus moves to the OK button on open and is restored to the previously
//   focused element on close; focus is trapped within the dialog while open.
//
// Portal-mounted on document.body so it escapes any stacking context.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from "react";
import { createPortal } from "react-dom";

import { CocoaButton } from "../cocoa/CocoaButton";
import { DEFAULT_VERSION } from "./CocoaKeyboardShortcutsHelp";
import { BRAND } from "../../config/brand";

export interface CocoaAboutDialogProps {
  open: boolean;
  onClose: () => void;
  /** Opens the help center («?»); the link is hidden when omitted. */
  onOpenHelp?: () => void;
  /** Opens the keyboard shortcuts sheet; the link is hidden when omitted. */
  onOpenShortcuts?: () => void;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable='true']",
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

interface AboutLink {
  label: string;
  onClick: () => void;
}

// Version shown in the dialog: the same constant the shortcuts sheet reads
// (build-time VITE_APP_VERSION, else the package default).
const APP_VERSION = DEFAULT_VERSION;

export function CocoaAboutDialog({ open, onClose, onOpenHelp, onOpenShortcuts }: CocoaAboutDialogProps) {
  // Only real actions are listed: the previous «Privacy» / «Terms» anchors
  // pointed nowhere (Tanda 5 · chrome).
  const links: AboutLink[] = [];
  if (onOpenHelp) links.push({ label: "Centro de ayuda", onClick: () => { onClose(); onOpenHelp(); } });
  if (onOpenShortcuts) links.push({ label: "Atajos de teclado", onClick: () => { onClose(); onOpenShortcuts(); } });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const okButtonRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [isMounted, setIsMounted] = useState<boolean>(open);
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const titleId = useId();

  // Manage mount/unmount with motion enter/exit.
  useEffect(() => {
    if (open) {
      setIsMounted(true);
      const raf = window.requestAnimationFrame(() => {
        setIsVisible(true);
      });
      return () => window.cancelAnimationFrame(raf);
    }

    setIsVisible(false);
    if (!isMounted) return undefined;
    const timeout = window.setTimeout(() => {
      setIsMounted(false);
    }, 400);
    return () => window.clearTimeout(timeout);
  }, [open, isMounted]);

  // Focus management — move focus to OK on open, restore on close.
  useEffect(() => {
    if (!isMounted) return undefined;
    previouslyFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? null;

    const root = containerRef.current;
    const raf = window.requestAnimationFrame(() => {
      if (okButtonRef.current) {
        okButtonRef.current.focus({ preventScroll: true });
        return;
      }
      const focusables = getFocusableElements(root);
      const first = focusables[0] ?? root;
      first?.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(raf);
      const previous = previouslyFocusedRef.current;
      if (previous && typeof previous.focus === "function") {
        previous.focus({ preventScroll: true });
      }
    };
  }, [isMounted]);

  // Esc + body scroll lock.
  useEffect(() => {
    if (!isMounted) return undefined;

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
  }, [isMounted, onClose]);

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

  const backdropStyle = useMemo<CSSProperties>(
    () => ({
      position: "fixed",
      inset: 0,
      zIndex: "var(--cocoa-z-modal)" as CSSProperties["zIndex"],
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
      background: "var(--cocoa-scrim)",
      backdropFilter: "var(--cocoa-scrim-blur)",
      WebkitBackdropFilter: "var(--cocoa-scrim-blur)",
      opacity: isVisible ? 1 : 0,
      transition: "opacity var(--cocoa-duration-base) var(--cocoa-ease-out)",
      pointerEvents: isVisible ? "auto" : "none"
    }),
    [isVisible]
  );

  const containerStyle = useMemo<CSSProperties>(
    () => ({
      position: "relative",
      width: 380,
      maxWidth: "100%",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 10,
      padding: "28px 28px 20px",
      background: "var(--cocoa-background-content)",
      borderRadius: "var(--cocoa-radius-lg)",
      boxShadow: "var(--cocoa-shadow-modal)",
      transform: isVisible
        ? "scale(1) translateY(0)"
        : "scale(0.94) translateY(-8px)",
      opacity: isVisible ? 1 : 0,
      transition:
        "transform var(--cocoa-duration-slow) var(--cocoa-ease-spring), opacity var(--cocoa-duration-base) var(--cocoa-ease-out)",
      outline: "none",
      fontFamily: "var(--cocoa-font)",
      color: "var(--cocoa-label)"
    }),
    [isVisible]
  );

  const appIconStyle = useMemo<CSSProperties>(
    () => ({
      width: 64,
      height: 64,
      borderRadius: "var(--cocoa-radius-xl)",
      // Flat Esmeralda: no gradient, no second hue (COCOA-22.md §6).
      background: "var(--cocoa-accent)",
      boxShadow: "var(--cocoa-shadow-card)",
      marginBottom: 6,
      flexShrink: 0
    }),
    []
  );

  const titleStyle = useMemo<CSSProperties>(
    () => ({
      margin: 0,
      fontSize: "var(--cocoa-fs-large-title)",
      lineHeight: "var(--cocoa-lh-large-title)",
      fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
      letterSpacing: "var(--cocoa-tracking-tight)",
      color: "var(--cocoa-label)",
      textAlign: "center"
    }),
    []
  );

  const subtitleStyle = useMemo<CSSProperties>(
    () => ({
      margin: 0,
      fontSize: "var(--cocoa-fs-body)",
      fontStyle: "italic",
      fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
      color: "var(--cocoa-label-secondary)",
      textAlign: "center"
    }),
    []
  );

  const captionStyle = useMemo<CSSProperties>(
    () => ({
      margin: 0,
      fontSize: "var(--cocoa-fs-caption)",
      fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
      color: "var(--cocoa-label-tertiary)",
      letterSpacing: "var(--cocoa-tracking-wide)",
      textAlign: "center"
    }),
    []
  );

  const descriptionStyle = useMemo<CSSProperties>(
    () => ({
      margin: "8px 0 4px",
      fontSize: "var(--cocoa-fs-body)",
      fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
      color: "var(--cocoa-label-secondary)",
      lineHeight: 1.45,
      textAlign: "center"
    }),
    []
  );

  const linksRowStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "center",
      gap: "4px 8px",
      marginTop: 4
    }),
    []
  );

  const linkStyle = useMemo<CSSProperties>(
    () => ({
      fontSize: "var(--cocoa-fs-footnote)",
      color: "var(--cocoa-accent)",
      textDecoration: "none",
      cursor: "pointer"
    }),
    []
  );

  const linkSeparatorStyle = useMemo<CSSProperties>(
    () => ({
      fontSize: "var(--cocoa-fs-footnote)",
      color: "var(--cocoa-label-tertiary)",
      userSelect: "none"
    }),
    []
  );

  const footnoteStyle = useMemo<CSSProperties>(
    () => ({
      margin: "10px 0 0",
      fontSize: "var(--cocoa-fs-footnote)",
      color: "var(--cocoa-label-tertiary)",
      textAlign: "center"
    }),
    []
  );

  const actionsRowStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      justifyContent: "center",
      width: "100%",
      marginTop: 14
    }),
    []
  );

  if (!isMounted) return null;
  if (typeof document === "undefined") return null;

  const node = (
    <div
      style={backdropStyle}
      onMouseDown={handleBackdropClick}
      aria-hidden={!isVisible}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={containerStyle}
        onKeyDown={handleContainerKeyDown}
      >
        <div style={appIconStyle} aria-hidden="true" />

        <h1 id={titleId} style={titleStyle}>
          {BRAND.name}
        </h1>

        <p style={subtitleStyle}>Gestión hotelera con IA</p>

        <p style={captionStyle}>Versión {APP_VERSION}</p>

        <p style={descriptionStyle}>Recepción, operaciones, revenue, finanzas y cumplimiento español en una sola aplicación.</p>

        <div style={linksRowStyle}>
          {links.map((link, index) => (
            <span
              key={link.label}
              style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
            >
              <button
                type="button"
                style={{ ...linkStyle, background: "transparent", border: "none", padding: 0, font: "inherit", cursor: "pointer" }}
                onClick={link.onClick}
                onMouseEnter={(event) => {
                  event.currentTarget.style.textDecoration = "underline";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.textDecoration = "none";
                }}
              >
                {link.label}
              </button>
              {index < links.length - 1 ? (
                <span style={linkSeparatorStyle} aria-hidden="true">
                  &middot;
                </span>
              ) : null}
            </span>
          ))}
        </div>

        <p style={footnoteStyle}>© 2026 {BRAND.name}. Todos los derechos reservados.</p>

        <div style={actionsRowStyle}>
          <CocoaButton
            variant="filled"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <span
              ref={(el) => {
                // Reach into the underlying button element for focus management.
                const btn = el?.closest("button") as HTMLButtonElement | null;
                okButtonRef.current = btn;
              }}
            >
              Aceptar
            </span>
          </CocoaButton>
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

export default CocoaAboutDialog;