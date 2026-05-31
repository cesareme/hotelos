// CocoaSplitView — three-column macOS-style layout.
//
// Columns: sidebar | content | inspector(optional).
// Implemented with CSS Grid using a dynamic grid-template-columns string so
// drag handles can mutate the sidebar / inspector widths live.
//
// The middle (content) column owns its own vertical scroll and applies the
// shared --cocoa-space-4 padding token. The sidebar column expects a
// CocoaSidebar (which handles its own sticky/flex internals).
//
// Inspector enters with a translateX slide (-> 0) when it mounts, and
// reverses on unmount via a brief mounted-but-hidden phase.
//
// Resize handles sit between columns 1-2 and 2-3 (only the latter when the
// inspector is present). Drag math is window-relative: we capture the
// pointer, then on every move we compute the new width as (clientX - left)
// for the sidebar or (right - clientX) for the inspector, clamped between
// reasonable min/max bounds so the layout never collapses.
//
// Responsive: below 900px the sidebar collapses out of the grid and becomes
// a drawer (off-canvas, slides in from the left), opened via a hamburger
// button rendered in the top-left. The inspector is also hidden at that
// width to keep the content column readable; callers can re-layout further
// up the tree if they need a different mobile story.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";

export interface CocoaSplitViewProps {
  sidebar: ReactNode;
  content: ReactNode;
  inspector?: ReactNode;
  sidebarWidth?: number;
  inspectorWidth?: number;
  collapsibleSidebar?: boolean;
}

const DEFAULT_SIDEBAR_WIDTH = 240;
const DEFAULT_INSPECTOR_WIDTH = 320;

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 420;
const MIN_INSPECTOR_WIDTH = 240;
const MAX_INSPECTOR_WIDTH = 520;

const MOBILE_BREAKPOINT_PX = 900;

const RESIZE_HANDLE_WIDTH = 6;

type DragMode = "sidebar" | "inspector";

interface DragState {
  mode: DragMode;
  pointerId: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function useIsMobile(): boolean {
  // Track viewport width so we can swap the split layout for the drawer-
  // based mobile layout. SSR guard: if `window` is undefined we assume
  // desktop, which matches the default layout the server would render.
  const getInitial = useCallback((): boolean => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < MOBILE_BREAKPOINT_PX;
  }, []);

  const [isMobile, setIsMobile] = useState<boolean>(getInitial);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handler = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT_PX);
    };
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("resize", handler);
    };
  }, []);

  return isMobile;
}

export function CocoaSplitView({
  sidebar,
  content,
  inspector,
  sidebarWidth: sidebarWidthProp = DEFAULT_SIDEBAR_WIDTH,
  inspectorWidth: inspectorWidthProp = DEFAULT_INSPECTOR_WIDTH,
  collapsibleSidebar = true
}: CocoaSplitViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);

  const [sidebarWidth, setSidebarWidth] = useState<number>(sidebarWidthProp);
  const [inspectorWidth, setInspectorWidth] = useState<number>(
    inspectorWidthProp
  );

  // Inspector slide-in: track mount/visibility separately so the exit
  // animation can play to completion before unmount.
  const [isInspectorMounted, setIsInspectorMounted] = useState<boolean>(
    inspector !== undefined
  );
  const [isInspectorVisible, setIsInspectorVisible] = useState<boolean>(false);

  // Mobile drawer state. Only meaningful when isMobile is true.
  const isMobile = useIsMobile();
  const [isDrawerOpen, setIsDrawerOpen] = useState<boolean>(false);

  // Sync width props -> state when the caller updates them.
  useEffect(() => {
    setSidebarWidth(clamp(sidebarWidthProp, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH));
  }, [sidebarWidthProp]);

  useEffect(() => {
    setInspectorWidth(
      clamp(inspectorWidthProp, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH)
    );
  }, [inspectorWidthProp]);

  // Inspector mount + slide-in/out lifecycle.
  useEffect(() => {
    if (inspector !== undefined) {
      setIsInspectorMounted(true);
      // Defer visibility flip a frame so the off-screen transform paints
      // first; otherwise the inspector pops in without animation.
      const raf = window.requestAnimationFrame(() => {
        setIsInspectorVisible(true);
      });
      return () => window.cancelAnimationFrame(raf);
    }

    setIsInspectorVisible(false);
    if (!isInspectorMounted) return undefined;
    const timeout = window.setTimeout(() => {
      setIsInspectorMounted(false);
    }, 320);
    return () => window.clearTimeout(timeout);
  }, [inspector, isInspectorMounted]);

  // Close the drawer automatically when we cross back into desktop.
  useEffect(() => {
    if (!isMobile && isDrawerOpen) {
      setIsDrawerOpen(false);
    }
  }, [isMobile, isDrawerOpen]);

  // --- Resize handle drag logic ---------------------------------------------

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const state = dragStateRef.current;
    if (state === null) return;
    if (event.pointerId !== state.pointerId) return;
    const container = containerRef.current;
    if (container === null) return;

    const rect = container.getBoundingClientRect();

    if (state.mode === "sidebar") {
      const next = clamp(
        event.clientX - rect.left,
        MIN_SIDEBAR_WIDTH,
        MAX_SIDEBAR_WIDTH
      );
      setSidebarWidth(next);
      return;
    }

    // Inspector: width is measured from the right edge of the container.
    const next = clamp(
      rect.right - event.clientX,
      MIN_INSPECTOR_WIDTH,
      MAX_INSPECTOR_WIDTH
    );
    setInspectorWidth(next);
  }, []);

  const handlePointerUp = useCallback(
    (event: PointerEvent) => {
      const state = dragStateRef.current;
      if (state === null) return;
      if (event.pointerId !== state.pointerId) return;
      dragStateRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    },
    [handlePointerMove]
  );

  const startDrag = useCallback(
    (mode: DragMode, event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragStateRef.current = { mode, pointerId: event.pointerId };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [handlePointerMove, handlePointerUp]
  );

  // Ensure listeners get cleaned up if the component unmounts mid-drag.
  useEffect(() => {
    return () => {
      if (dragStateRef.current !== null) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      }
    };
  }, [handlePointerMove, handlePointerUp]);

  // --- Styles ---------------------------------------------------------------

  const showInspectorColumn = isInspectorMounted && !isMobile;
  const showSidebarColumn = !isMobile;

  const gridTemplateColumns = useMemo<string>(() => {
    if (!showSidebarColumn) {
      // Single column on mobile; sidebar lives in a drawer instead.
      return "1fr";
    }
    if (showInspectorColumn) {
      return `${sidebarWidth}px 1fr ${inspectorWidth}px`;
    }
    return `${sidebarWidth}px 1fr`;
  }, [
    showSidebarColumn,
    showInspectorColumn,
    sidebarWidth,
    inspectorWidth
  ]);

  const containerStyle: CSSProperties = {
    position: "relative",
    display: "grid",
    gridTemplateColumns,
    width: "100%",
    height: "100%",
    minHeight: 0,
    background: "var(--cocoa-background-window)",
    fontFamily: "var(--cocoa-font)",
    color: "var(--cocoa-label)"
  };

  const sidebarColumnStyle: CSSProperties = {
    position: "relative",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    borderRight: "1px solid var(--cocoa-separator)"
  };

  const contentColumnStyle: CSSProperties = {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
    padding: "var(--cocoa-space-4)"
  };

  const inspectorColumnStyle: CSSProperties = {
    position: "relative",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    borderLeft: "1px solid var(--cocoa-separator)",
    transform: isInspectorVisible ? "translateX(0)" : "translateX(100%)",
    transition:
      "transform var(--cocoa-duration-base) var(--cocoa-ease-out)",
    willChange: "transform"
  };

  const sidebarResizeHandleStyle: CSSProperties = {
    position: "absolute",
    top: 0,
    bottom: 0,
    // Sit straddling the column boundary so the hit target is generous but
    // the visible cursor change feels precise.
    right: -RESIZE_HANDLE_WIDTH / 2,
    width: RESIZE_HANDLE_WIDTH,
    cursor: "col-resize",
    zIndex: 2,
    touchAction: "none"
  };

  const inspectorResizeHandleStyle: CSSProperties = {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -RESIZE_HANDLE_WIDTH / 2,
    width: RESIZE_HANDLE_WIDTH,
    cursor: "col-resize",
    zIndex: 2,
    touchAction: "none"
  };

  // Mobile-only chrome: hamburger toggle + off-canvas drawer + backdrop.
  const hamburgerStyle: CSSProperties = {
    position: "absolute",
    top: 12,
    left: 12,
    zIndex: 5,
    width: 32,
    height: 32,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--cocoa-background-content)",
    border: "1px solid var(--cocoa-separator)",
    borderRadius: "var(--cocoa-radius-md)",
    color: "var(--cocoa-label)",
    cursor: "pointer",
    padding: 0,
    boxShadow: "var(--cocoa-shadow-control)"
  };

  const drawerBackdropStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0, 0, 0, 0.32)",
    backdropFilter: "blur(6px)",
    WebkitBackdropFilter: "blur(6px)",
    opacity: isDrawerOpen ? 1 : 0,
    pointerEvents: isDrawerOpen ? "auto" : "none",
    transition: "opacity var(--cocoa-duration-base) var(--cocoa-ease-out)",
    zIndex: 999
  };

  const drawerStyle: CSSProperties = {
    position: "fixed",
    top: 0,
    bottom: 0,
    left: 0,
    width: clamp(sidebarWidth, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
    maxWidth: "85vw",
    background: "var(--cocoa-background-content)",
    borderRight: "1px solid var(--cocoa-separator)",
    boxShadow: "var(--cocoa-shadow-modal)",
    transform: isDrawerOpen ? "translateX(0)" : "translateX(-100%)",
    transition:
      "transform var(--cocoa-duration-base) var(--cocoa-ease-out)",
    zIndex: 1000,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column"
  };

  const showHamburger = isMobile && collapsibleSidebar;

  const closeDrawer = useCallback(() => {
    setIsDrawerOpen(false);
  }, []);

  // Close drawer on Escape for keyboard parity with the sheet/popover.
  useEffect(() => {
    if (!isDrawerOpen) return undefined;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDrawer();
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
    };
  }, [isDrawerOpen, closeDrawer]);

  return (
    <div ref={containerRef} style={containerStyle}>
      {showHamburger ? (
        <button
          type="button"
          aria-label="Open navigation"
          aria-expanded={isDrawerOpen}
          onClick={() => setIsDrawerOpen(true)}
          style={hamburgerStyle}
          className="cocoa-focus-ring"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M2 4h12M2 8h12M2 12h12"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : null}

      {showSidebarColumn ? (
        <div style={sidebarColumnStyle}>
          {sidebar}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={(event) => startDrag("sidebar", event)}
            style={sidebarResizeHandleStyle}
          />
        </div>
      ) : null}

      <div style={contentColumnStyle}>{content}</div>

      {showInspectorColumn ? (
        <div style={inspectorColumnStyle}>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize inspector"
            onPointerDown={(event) => startDrag("inspector", event)}
            style={inspectorResizeHandleStyle}
          />
          {inspector}
        </div>
      ) : null}

      {isMobile ? (
        <>
          <div
            style={drawerBackdropStyle}
            onClick={closeDrawer}
            aria-hidden={!isDrawerOpen}
          />
          <aside
            style={drawerStyle}
            aria-hidden={!isDrawerOpen}
            aria-label="Navigation"
          >
            {sidebar}
          </aside>
        </>
      ) : null}
    </div>
  );
}

export default CocoaSplitView;
