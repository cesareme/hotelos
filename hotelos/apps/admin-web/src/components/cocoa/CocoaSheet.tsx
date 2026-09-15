// CocoaSheet — top-anchored modal sheet (COCOA-22.md §3.9): import previews,
// bulk editors and wizards that need width (480 / 640 / 880). Lateral panels
// are CocoaDrawer; confirmations are CocoaDialog.
//
//   Portal · scrim label 45 % (no blur) · translateY(-100 %) → 0 in 400 ms
//   ease-out · content bg · shadow modal · bottom radius 12 · header 16 20
//   (title-2) + «Cerrar» · body 20 scrolls · footer 12 20 · focus trap · Esc
//   and scrim when `dismissible` · body scroll lock · z --cocoa-z-sheet.

import { useId, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CocoaButton } from "./CocoaButton";
import { COCOA_SCRIM, useEscapeKey, useFocusTrap, useMountedTransition, useScrollLock } from "./cocoa-overlay";

export type CocoaSheetSize = "sm" | "md" | "lg";

export interface CocoaSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: CocoaSheetSize;
  footer?: ReactNode;
  /** Esc and the scrim close the sheet (default true). */
  dismissible?: boolean;
  /** Accessible name when there is no title. */
  "aria-label"?: string;
  initialFocus?: () => HTMLElement | null | undefined;
}

export const SHEET_MAX_WIDTH: Record<CocoaSheetSize, number> = { sm: 480, md: 640, lg: 880 };
const EXIT_MS = 400;

export function CocoaSheet({ open, onClose, title, children, size = "md", footer, dismissible = true, "aria-label": ariaLabel, initialFocus }: CocoaSheetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  const { mounted, visible } = useMountedTransition(open, EXIT_MS);

  const onKeyDown = useFocusTrap(containerRef, mounted, initialFocus);
  useEscapeKey(mounted && dismissible, onClose);
  useScrollLock(mounted);

  if (!mounted || typeof document === "undefined") return null;

  const backdropStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: "var(--cocoa-z-sheet)" as CSSProperties["zIndex"],
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    background: COCOA_SCRIM,
    opacity: visible ? 1 : 0,
    transition: "opacity var(--cocoa-duration-slow) var(--cocoa-ease-out)",
    pointerEvents: visible ? "auto" : "none"
  };

  const containerStyle: CSSProperties = {
    position: "relative",
    width: "100%",
    maxWidth: SHEET_MAX_WIDTH[size],
    maxHeight: "calc(100dvh - 24px)",
    display: "flex",
    flexDirection: "column",
    background: "var(--cocoa-background-content)",
    boxShadow: "var(--cocoa-shadow-modal)",
    borderBottomLeftRadius: "var(--cocoa-radius-lg)",
    borderBottomRightRadius: "var(--cocoa-radius-lg)",
    transform: visible ? "translateY(0)" : "translateY(-100%)",
    transition: "transform var(--cocoa-duration-slow) var(--cocoa-ease-out)",
    outline: "none",
    fontFamily: "var(--cocoa-font)",
    color: "var(--cocoa-label)",
    overflow: "hidden",
    paddingTop: "env(safe-area-inset-top)",
    boxSizing: "border-box"
  };

  const node = (
    <div style={backdropStyle} onMouseDown={dismissible ? (event) => (event.target === event.currentTarget ? onClose() : undefined) : undefined} aria-hidden={!visible}>
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? headingId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        className="cocoa-sheet"
        style={containerStyle}
        onKeyDown={onKeyDown}
        data-cocoa="sheet"
        data-size={size}
      >
        {title !== undefined ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--cocoa-space-3)", padding: "var(--cocoa-space-4) 20px", borderBottom: "1px solid var(--cocoa-separator)", flexShrink: 0 }}>
            <h2
              id={headingId}
              style={{
                margin: 0,
                fontSize: "var(--cocoa-fs-title-2)",
                fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
                letterSpacing: "var(--cocoa-tracking-tight)",
                color: "var(--cocoa-label)",
                lineHeight: 1.2,
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap"
              }}
            >
              {title}
            </h2>
            <CocoaButton
              variant="plain"
              tone="neutral"
              size="small"
              aria-label="Cerrar"
              onClick={onClose}
              icon={
                <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
                  <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              }
            />
          </div>
        ) : null}
        <div style={{ padding: 20, overflow: "auto", flex: 1, minHeight: 0, WebkitOverflowScrolling: "touch" }}>{children}</div>
        {footer !== undefined ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: "var(--cocoa-space-2)", padding: "var(--cocoa-space-3) 20px", borderTop: "1px solid var(--cocoa-separator)", flexShrink: 0 }}>{footer}</div>
        ) : null}
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

export default CocoaSheet;
