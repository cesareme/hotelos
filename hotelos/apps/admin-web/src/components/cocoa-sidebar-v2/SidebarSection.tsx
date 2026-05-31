import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";

export interface SidebarSectionProps {
  label: string;
  icon?: ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
  persistKey?: string;
  children?: ReactNode;
}

const STORAGE_PREFIX = "cocoa-sb-";
const COLLAPSE_DURATION_MS = 200;

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  marginBottom: "var(--cocoa-space-2)",
  boxSizing: "border-box"
};

const headerBaseStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--cocoa-space-1)",
  width: "100%",
  padding: "var(--cocoa-space-2) var(--cocoa-space-2) var(--cocoa-space-1)",
  background: "transparent",
  border: "none",
  textAlign: "left",
  font: "inherit",
  fontFamily: "var(--cocoa-font)",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-wide)",
  textTransform: "uppercase",
  color: "var(--cocoa-label-secondary)",
  userSelect: "none",
  boxSizing: "border-box"
};

const headerIconStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 12,
  height: 12,
  flexShrink: 0,
  color: "inherit"
};

const headerLabelStyle: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  margin: 0
};

const bodyOuterStyle: CSSProperties = {
  overflow: "hidden",
  transitionProperty: "max-height",
  transitionDuration: `${COLLAPSE_DURATION_MS}ms`,
  transitionTimingFunction: "var(--cocoa-ease-out)",
  boxSizing: "border-box"
};

const bodyInnerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column"
};

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 10,
        height: 10,
        flexShrink: 0,
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition:
          "transform var(--cocoa-duration-fast) var(--cocoa-ease-out)",
        color: "var(--cocoa-label-secondary)"
      }}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M3.5 2L6.5 5L3.5 8"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function readPersisted(persistKey: string | undefined): boolean | null {
  if (persistKey === undefined || persistKey === "") {
    return null;
  }
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${persistKey}`);
    if (raw === null) {
      return null;
    }
    if (raw === "1" || raw === "true") {
      return true;
    }
    if (raw === "0" || raw === "false") {
      return false;
    }
    return null;
  } catch {
    return null;
  }
}

function writePersisted(persistKey: string | undefined, open: boolean): void {
  if (persistKey === undefined || persistKey === "") {
    return;
  }
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      `${STORAGE_PREFIX}${persistKey}`,
      open ? "1" : "0"
    );
  } catch {
    /* ignore */
  }
}

export function SidebarSection({
  label,
  icon,
  defaultOpen = true,
  collapsible = true,
  persistKey,
  children
}: SidebarSectionProps) {
  const isCollapsible = collapsible !== false;

  const initialOpen = useMemo<boolean>(() => {
    if (!isCollapsible) {
      return true;
    }
    const persisted = readPersisted(persistKey);
    if (persisted !== null) {
      return persisted;
    }
    return defaultOpen !== false;
    // We intentionally only compute initial state once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [open, setOpen] = useState<boolean>(initialOpen);

  // Force open when not collapsible.
  useEffect(() => {
    if (!isCollapsible && !open) {
      setOpen(true);
    }
  }, [isCollapsible, open]);

  // Persist open state changes.
  useEffect(() => {
    if (!isCollapsible) {
      return;
    }
    writePersisted(persistKey, open);
  }, [open, persistKey, isCollapsible]);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [maxHeight, setMaxHeight] = useState<string>(
    initialOpen ? "none" : "0px"
  );
  const firstRenderRef = useRef<boolean>(true);

  // Drive max-height transitions on open/close.
  useEffect(() => {
    const inner = innerRef.current;
    if (inner === null) {
      return;
    }

    // On first render, set to a stable resting value without animating.
    if (firstRenderRef.current) {
      firstRenderRef.current = false;
      setMaxHeight(open ? "none" : "0px");
      return;
    }

    const contentHeight = inner.scrollHeight;

    if (open) {
      // Start from 0 -> contentHeight, then settle to none.
      setMaxHeight(`${contentHeight}px`);
      const settle = window.setTimeout(() => {
        setMaxHeight("none");
      }, COLLAPSE_DURATION_MS);
      return () => {
        window.clearTimeout(settle);
      };
    } else {
      // Going from open -> closed. First set explicit height (if none), then 0.
      // Two-step rAF ensures the browser commits the explicit max-height
      // before transitioning to 0px.
      setMaxHeight(`${contentHeight}px`);
      const raf1 = window.requestAnimationFrame(() => {
        const raf2 = window.requestAnimationFrame(() => {
          setMaxHeight("0px");
        });
        cleanupRaf.current = raf2;
      });
      cleanupRaf.current = raf1;
      return () => {
        if (cleanupRaf.current !== null) {
          window.cancelAnimationFrame(cleanupRaf.current);
          cleanupRaf.current = null;
        }
      };
    }
  }, [open]);

  const cleanupRaf = useRef<number | null>(null);

  const reactId = useId();
  const bodyId = `cocoa-sb-section-${reactId}`;

  const handleToggle = () => {
    if (!isCollapsible) {
      return;
    }
    setOpen((prev) => !prev);
  };

  const bodyStyle: CSSProperties = useMemo(() => {
    return {
      ...bodyOuterStyle,
      maxHeight,
      visibility: open || maxHeight !== "0px" ? "visible" : "hidden"
    };
  }, [maxHeight, open]);

  const headerNode = isCollapsible ? (
    <button
      type="button"
      className="cocoa-focus-ring"
      style={{ ...headerBaseStyle, cursor: "pointer" }}
      onClick={handleToggle}
      aria-expanded={open}
      aria-controls={bodyId}
    >
      <Chevron open={open} />
      {icon !== undefined ? (
        <span style={headerIconStyle} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <h6 style={headerLabelStyle}>{label}</h6>
    </button>
  ) : (
    <div style={headerBaseStyle}>
      {icon !== undefined ? (
        <span style={headerIconStyle} aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <h6 style={headerLabelStyle}>{label}</h6>
    </div>
  );

  return (
    <section style={sectionStyle}>
      {headerNode}
      <div
        ref={bodyRef}
        id={bodyId}
        style={bodyStyle}
        aria-hidden={!open}
      >
        <div ref={innerRef} style={bodyInnerStyle}>
          {children}
        </div>
      </div>
    </section>
  );
}

export default SidebarSection;
