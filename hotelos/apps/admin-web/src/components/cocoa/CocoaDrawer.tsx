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
//   (default) · body scroll lock · z --cocoa-z-sheet · aria-labelledby ·
//   `submitOnEnter` (UX-1 · U5, F6; opt-in, default false — UX1-REV-05): Enter in a one-line field
//   of the body clicks the footer's primary action — the single `filled`,
//   non-destructive, enabled CocoaButton (`drawerPrimaryButton`) — never in a
//   <textarea>, never inside a <form> (the form owns Enter; U6 wraps the quick
//   drawers in one) and never when the footer has no such button.
//
// Hooks for the css lot: scrim `c22-scrim[data-open]`, panel `c22-drawer`
// + data-side/size/open (the stylesheet gates `visibility` on `data-open`,
// so it is always emitted), parts `c22-drawer__handle/__head/__heading/
// __title/__subtitle/__body/__foot`.

import { useCallback, useEffect, useId, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CocoaButton } from "./CocoaButton";
import { shouldSubmitOnEnter } from "./CocoaDialog";
import { CocoaState, SKELETON_DELAY_MS, fadeInClass, useFadeInAfterLoading, useSkeletonDelay } from "./CocoaState";
import { COCOA_SCRIM, focusWhenFocusable, getFocusableElements, initialFocusTarget, useEscapeKey, useFocusTrap, useMountedTransition, useScrollLock } from "./cocoa-overlay";
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
  /** The body is loading (a fetch after open): after `skeletonDelayMs` the body paints `skeleton` (default CocoaState loading) instead of `children`, then fades the content in. */
  loading?: boolean;
  /** Mirror skeleton of the drawer body (composed with CocoaSkeleton). */
  skeleton?: ReactNode;
  /** Delay before the skeleton paints (ms): 300 by default (NN/g), 0 = at once. */
  skeletonDelayMs?: number;
  children: ReactNode;
  className?: string;
  /** Layout escape hatch for the panel. */
  style?: CSSProperties;
  /** Enter in a one-line field clicks the footer's primary action (opt-in, default false; see `drawerPrimaryButton`). */
  submitOnEnter?: boolean;
}

type ButtonLike = { disabled?: boolean; getAttribute: (name: string) => string | null; click?: () => void };
type FooterLike = { querySelectorAll: (selector: string) => ArrayLike<ButtonLike> } | null | undefined;

/** The footer's primary action (pure): its ONLY `filled` non-destructive CocoaButton, enabled and not busy; null otherwise (two filled buttons = ambiguous = no Enter). */
export function drawerPrimaryButton<Button extends ButtonLike>(footer: { querySelectorAll: (selector: string) => ArrayLike<Button> } | null | undefined): Button | null {
  if (!footer) return null;
  const filled = Array.from(footer.querySelectorAll('[data-cocoa="button"][data-variant="filled"]')).filter((button) => button.getAttribute("data-tone") !== "destructive");
  if (filled.length !== 1) return null;
  const button = filled[0];
  if (button.disabled || button.getAttribute("aria-disabled") === "true" || button.getAttribute("aria-busy") === "true") return null;
  return button;
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

export function CocoaDrawer({ open, onClose, title, subtitle, side = "right", size = "md", footer, dismissible = true, initialFocus, focusKey, loading = false, skeleton, skeletonDelayMs = SKELETON_DELAY_MS, children, className, style, submitOnEnter = false }: CocoaDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLElement | null>(null);
  const headingId = useId();
  const subtitleId = useId();
  const isNarrow = useIsNarrow();
  const { mounted, visible } = useMountedTransition(open, EXIT_MS);
  const geometry = drawerGeometry({ side, size, isNarrow });

  const onKeyDown = useFocusTrap(panelRef, mounted, initialFocus);
  // Enter in a one-line field of the body = the footer's primary action (F6).
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const submits = shouldSubmitOnEnter(
        { key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, isComposing: event.nativeEvent.isComposing, target: event.target },
        { enabled: submitOnEnter && !loading, tone: "primary", busy: false, confirmDisabled: false, hasInitialFocus: true }
      );
      if (submits) {
        const primary = drawerPrimaryButton(footerRef.current) as HTMLButtonElement | null;
        if (primary) {
          event.preventDefault();
          primary.click();
          return;
        }
      }
      onKeyDown(event);
    },
    [submitOnEnter, loading, onKeyDown]
  );
  useEscapeKey(mounted && dismissible, onClose);
  useScrollLock(mounted);

  // Skeleton with delay + fade-in of the body (U4, §4 «Esqueleto con retardo»).
  const showSkeleton = useSkeletonDelay(loading, skeletonDelayMs);
  const fade = useFadeInAfterLoading(loading);

  // The trap reads `initialFocus` once on open; content that arrives later (a
  // loaded form, a CTA that turns enabled) asks again through `focusKey`.
  // `initialFocus` is read when the key changes, on purpose (not a dependency).
  // A disabled preferred target falls back to the first focusable (never the
  // trigger row behind the scrim, L-01); a focus the operator already moved
  // inside the panel is left alone.
  useEffect(() => {
    if (!mounted || focusKey === undefined) return undefined;
    const panel = panelRef.current;
    // The operator is already in a field of the panel (typing an amount, picking a method): a later key change
    // (the CTA turning enabled) must not yank the focus; a button the trap auto-focused as a fallback may be left.
    const editingInside = () => {
      const current = document.activeElement as HTMLElement | null;
      return Boolean(panel && current && panel.contains(current) && /^(INPUT|SELECT|TEXTAREA)$/.test(current.tagName));
    };
    // Retries frame by frame while the panel is still `visibility: hidden` (focus() is a no-op there).
    return focusWhenFocusable(panel, () => initialFocusTarget(initialFocus?.(), getFocusableElements(panel), panel), { stop: editingInside });
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
        onKeyDown={handleKeyDown}
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
        <div
          className={["c22-drawer__body", fadeInClass(fade)].filter(Boolean).join(" ")}
          style={{ padding: "var(--cocoa-space-5)", overflow: "auto", flex: "1 1 auto", minHeight: 0, WebkitOverflowScrolling: "touch", paddingBottom: footer ? "var(--cocoa-space-5)" : "calc(var(--cocoa-space-5) + env(safe-area-inset-bottom))" }}
          aria-busy={loading || undefined}
          data-skeleton={loading ? (showSkeleton ? "visible" : "pending") : undefined}
        >
          {loading ? (showSkeleton ? (skeleton ?? <CocoaState kind="loading" />) : null) : children}
        </div>
        {footer ? (
          <footer ref={footerRef} className="c22-drawer__foot" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap", gap: "var(--cocoa-space-2)", padding: "var(--cocoa-space-3) var(--cocoa-space-5)", paddingBottom: "calc(var(--cocoa-space-3) + env(safe-area-inset-bottom))", borderTop: "1px solid var(--cocoa-separator)", flexShrink: 0 }}>
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
