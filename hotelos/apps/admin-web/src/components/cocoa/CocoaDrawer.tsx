// CocoaDrawer — side panel of Cocoa 22 (COCOA-22.md §3.9; replaces the legacy
// fixed side panel (retired in ola 11), the `*Drawer.tsx` built on
// `position:fixed` and CocoaSheet used as a lateral panel; CocoaSheet stays for
// import/preview sheets).
//
//   side="right" (default) / "left": 360 · 480 · 640 px, translateX 400 ms ease-out
//   side="bottom" and every side on a phone (< 600): full width, max 90 dvh,
//   36×4 handle, safe-area padding, translateY
//   Portal · scrim `--cocoa-scrim` · shadow modal · radius 12 on the inner
//   edge · header title-2 600 + caption subtitle + «Cerrar» · body scrolls ·
//   footer separated · focus trap · Esc + scrim click when `dismissible`
//   (default) · body scroll lock · z --cocoa-z-sheet · aria-labelledby.
//
// Hooks for the css lot: scrim `c22-scrim[data-open]`, panel `c22-drawer`
// + data-side/size/open (the stylesheet gates `visibility` on `data-open`,
// so it is always emitted), parts `c22-drawer__handle/__head/__heading/
// __title/__subtitle/__body/__foot`.

import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CocoaButton } from "./CocoaButton";
import { COCOA_SCRIM, useEscapeKey, useFocusTrap, useMountedTransition, useScrollLock } from "./cocoa-overlay";
import { useIsNarrow } from "./cocoa-viewport";

export type CocoaDrawerSide = "right" | "bottom" | "left";
export type CocoaDrawerSize = "sm" | "md" | "lg";

export interface CocoaDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  side?: CocoaDrawerSide;
  size?: CocoaDrawerSize;
  footer?: ReactNode;
  /** Esc and the scrim close the drawer (default true; false for mandatory flows). */
  dismissible?: boolean;
  /** Element to focus on open (default: first focusable, then the panel). */
  initialFocus?: () => HTMLElement | null | undefined;
  /** When it changes while the drawer is open, `initialFocus` is evaluated again (a form that arrives after a fetch: pass the loaded state). */
  focusKey?: string | number | boolean;
  children: ReactNode;
  className?: string;
  /** Layout escape hatch for the panel. */
  style?: CSSProperties;
}

export const DRAWER_WIDTH: Record<CocoaDrawerSize, number> = { sm: 360, md: 480, lg: 640 };
const EXIT_MS = 400;

export interface DrawerGeometry {
  side: CocoaDrawerSide;
  width: string;
  maxHeight: string;
  hiddenTransform: string;
  radius: CSSProperties;
  anchor: CSSProperties;
}

/** Effective side and box of the panel (pure): phones always get a bottom sheet. */
export function drawerGeometry(input: { side: CocoaDrawerSide; size: CocoaDrawerSize; isNarrow: boolean }): DrawerGeometry {
  const side: CocoaDrawerSide = input.isNarrow ? "bottom" : input.side;
  const px = DRAWER_WIDTH[input.size];
  if (side === "bottom") {
    return {
      side,
      width: "100%",
      maxHeight: "90dvh",
      hiddenTransform: "translateY(100%)",
      radius: { borderTopLeftRadius: "var(--cocoa-radius-lg)", borderTopRightRadius: "var(--cocoa-radius-lg)" },
      anchor: { left: 0, right: 0, bottom: 0, top: "auto" }
    };
  }
  if (side === "left") {
    return {
      side,
      width: `min(${px}px, 100vw)`,
      maxHeight: "100dvh",
      hiddenTransform: "translateX(-100%)",
      radius: { borderTopRightRadius: "var(--cocoa-radius-lg)", borderBottomRightRadius: "var(--cocoa-radius-lg)" },
      anchor: { top: 0, bottom: 0, left: 0, right: "auto" }
    };
  }
  return {
    side,
    width: `min(${px}px, 100vw)`,
    maxHeight: "100dvh",
    hiddenTransform: "translateX(100%)",
    radius: { borderTopLeftRadius: "var(--cocoa-radius-lg)", borderBottomLeftRadius: "var(--cocoa-radius-lg)" },
    anchor: { top: 0, bottom: 0, right: 0, left: "auto" }
  };
}

export function CocoaDrawer({ open, onClose, title, subtitle, side = "right", size = "md", footer, dismissible = true, initialFocus, focusKey, children, className, style }: CocoaDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();
  const subtitleId = useId();
  const isNarrow = useIsNarrow();
  const { mounted, visible } = useMountedTransition(open, EXIT_MS);
  const geometry = drawerGeometry({ side, size, isNarrow });

  const onKeyDown = useFocusTrap(panelRef, mounted, initialFocus);
  useEscapeKey(mounted && dismissible, onClose);
  useScrollLock(mounted);

  // The trap reads `initialFocus` once on open; content that arrives later (a
  // loaded form) asks again through `focusKey`. `initialFocus` is read when the
  // key changes, on purpose (not a dependency).
  useEffect(() => {
    if (!mounted || focusKey === undefined) return undefined;
    const raf = window.requestAnimationFrame(() => initialFocus?.()?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(raf);
  }, [focusKey, mounted]);

  if (!mounted || typeof document === "undefined") return null;

  const scrimStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: "var(--cocoa-z-sheet)" as CSSProperties["zIndex"],
    background: COCOA_SCRIM,
    opacity: visible ? 1 : 0,
    transition: "opacity var(--cocoa-duration-slow) var(--cocoa-ease-out)",
    pointerEvents: visible ? "auto" : "none"
  };

  const panelStyle: CSSProperties = {
    position: "fixed",
    ...geometry.anchor,
    zIndex: "var(--cocoa-z-sheet)" as CSSProperties["zIndex"],
    width: geometry.width,
    maxHeight: geometry.maxHeight,
    display: "flex",
    flexDirection: "column",
    background: "var(--cocoa-background-content)",
    color: "var(--cocoa-label)",
    boxShadow: "var(--cocoa-shadow-modal)",
    ...geometry.radius,
    transform: visible ? "translate(0, 0)" : geometry.hiddenTransform,
    transition: "transform var(--cocoa-duration-slow) var(--cocoa-ease-out)",
    outline: "none",
    fontFamily: "var(--cocoa-font)",
    overflow: "hidden",
    boxSizing: "border-box",
    paddingTop: geometry.side === "bottom" ? 0 : "env(safe-area-inset-top)",
    ...style
  };

  const node = (
    <div
      className="c22-scrim"
      style={scrimStyle}
      onMouseDown={dismissible ? (event) => (event.target === event.currentTarget ? onClose() : undefined) : undefined}
      aria-hidden={!visible}
      data-cocoa="scrim"
      data-open={visible ? "true" : "false"}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        className={["c22-drawer", "cocoa-drawer", className].filter(Boolean).join(" ")}
        style={panelStyle}
        onKeyDown={onKeyDown}
        data-cocoa="drawer"
        data-side={geometry.side}
        data-size={size}
        data-open={visible ? "true" : "false"}
      >
        {geometry.side === "bottom" ? (
          <div aria-hidden="true" style={{ display: "flex", justifyContent: "center", paddingTop: "var(--cocoa-space-2)", flexShrink: 0 }}>
            <span className="c22-drawer__handle" style={{ width: 36, height: 4, borderRadius: "var(--cocoa-radius-full)", background: "var(--cocoa-separator-opaque)", margin: 0 }} />
          </div>
        ) : null}
        <header className="c22-drawer__head" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--cocoa-space-3)", padding: "var(--cocoa-space-4) var(--cocoa-space-5)", borderBottom: "1px solid var(--cocoa-separator)", flexShrink: 0 }}>
          <div className="c22-drawer__heading" style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 auto" }}>
            <h2 id={headingId} className="c22-drawer__title" style={{ margin: 0, fontSize: "var(--cocoa-fs-title-2)", fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"], letterSpacing: "var(--cocoa-tracking-tight)", lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {title}
            </h2>
            {subtitle ? (
              <p id={subtitleId} className="c22-drawer__subtitle" style={{ margin: 0, fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)", lineHeight: 1.35 }}>
                {subtitle}
              </p>
            ) : null}
          </div>
          <CocoaButton variant="plain" tone="neutral" size="small" aria-label="Cerrar" onClick={onClose} icon={<CloseGlyph />} />
        </header>
        <div className="c22-drawer__body" style={{ padding: "var(--cocoa-space-5)", overflow: "auto", flex: "1 1 auto", minHeight: 0, WebkitOverflowScrolling: "touch", paddingBottom: footer ? "var(--cocoa-space-5)" : "calc(var(--cocoa-space-5) + env(safe-area-inset-bottom))" }}>
          {children}
        </div>
        {footer ? (
          <footer className="c22-drawer__foot" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: "var(--cocoa-space-2)", padding: "var(--cocoa-space-3) var(--cocoa-space-5)", paddingBottom: "calc(var(--cocoa-space-3) + env(safe-area-inset-bottom))", borderTop: "1px solid var(--cocoa-separator)", flexShrink: 0 }}>
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

function CloseGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export default CocoaDrawer;
