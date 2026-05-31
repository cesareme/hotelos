// CocoaBreadcrumb — macOS-style breadcrumb path bar.
//
// Renders a horizontal row of breadcrumb items separated by a tertiary
// separator (default ›). Each item is rendered as an inline button when
// it has an `onClick` handler, or as a plain span otherwise. The last
// item is rendered in bold and is never interactive even if an onClick
// is provided.
//
// Visuals:
// - Row uses horizontal gap of 6px between item/separator slots.
// - Items use var(--cocoa-label-secondary) by default and shift to
//   var(--cocoa-accent) on hover for interactive items.
// - The last item uses var(--cocoa-label) with semibold weight.
// - Separators are tertiary-tinted via var(--cocoa-label-tertiary).
//
// Responsive collapse:
// - When the available row width is narrower than the intrinsic content,
//   the middle items collapse into a single "…" dropdown button that
//   opens a popover menu with the collapsed items. The first and last
//   items are always visible.
// - The collapse threshold is recalculated via a ResizeObserver on the
//   container element.
//
// A11y:
// - <nav aria-label="Breadcrumb"> wraps an ordered list <ol>.
// - aria-current="page" is applied to the last item.
// - The collapse trigger uses aria-expanded and a labeled aria-haspopup.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";

export interface CocoaBreadcrumbItem {
  label: string;
  onClick?: () => void;
  icon?: ReactNode;
}

export interface CocoaBreadcrumbProps {
  items: CocoaBreadcrumbItem[];
  separator?: ReactNode;
}

interface CollapsedLayout {
  leading: CocoaBreadcrumbItem[];
  middle: CocoaBreadcrumbItem[];
  trailing: CocoaBreadcrumbItem[];
}

function buildLayout(
  items: CocoaBreadcrumbItem[],
  isCollapsed: boolean
): CollapsedLayout {
  if (!isCollapsed || items.length <= 3) {
    return {
      leading: items.slice(0, Math.max(0, items.length - 1)),
      middle: [],
      trailing: items.length > 0 ? [items[items.length - 1]] : []
    };
  }

  const last = items[items.length - 1];
  const first = items[0];
  const middle = items.slice(1, items.length - 1);

  return {
    leading: [first],
    middle,
    trailing: [last]
  };
}

interface BreadcrumbItemProps {
  item: CocoaBreadcrumbItem;
  isLast: boolean;
}

function BreadcrumbItem({ item, isLast }: BreadcrumbItemProps) {
  const [isHover, setIsHover] = useState<boolean>(false);
  const interactive = !isLast && typeof item.onClick === "function";

  const style = useMemo<CSSProperties>(() => {
    const base: CSSProperties = {
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      padding: "2px 4px",
      margin: 0,
      border: "none",
      background: "transparent",
      borderRadius: "var(--cocoa-radius-sm, 4px)",
      fontFamily: "var(--cocoa-font)",
      fontSize: "var(--cocoa-fs-body)",
      letterSpacing: "var(--cocoa-tracking-tight)",
      lineHeight: 1.2,
      whiteSpace: "nowrap",
      cursor: interactive ? "pointer" : "default",
      userSelect: "none",
      WebkitAppearance: "none",
      appearance: "none",
      transition:
        "color var(--cocoa-duration-fast) var(--cocoa-ease-out), background-color var(--cocoa-duration-fast) var(--cocoa-ease-out)"
    };

    if (isLast) {
      base.color = "var(--cocoa-label)";
      base.fontWeight = "var(--cocoa-fw-semibold)" as unknown as number;
    } else {
      base.color = interactive && isHover
        ? "var(--cocoa-accent)"
        : "var(--cocoa-label-secondary)";
      base.fontWeight = "var(--cocoa-fw-regular)" as unknown as number;
    }

    return base;
  }, [isLast, interactive, isHover]);

  const handleMouseEnter = useCallback(() => {
    if (interactive) setIsHover(true);
  }, [interactive]);

  const handleMouseLeave = useCallback(() => {
    if (interactive) setIsHover(false);
  }, [interactive]);

  const content = (
    <>
      {item.icon ? (
        <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0 }}>
          {item.icon}
        </span>
      ) : null}
      <span>{item.label}</span>
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        className="cocoa-focus-ring"
        style={style}
        onClick={item.onClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        aria-current={isLast ? "page" : undefined}
      >
        {content}
      </button>
    );
  }

  return (
    <span style={style} aria-current={isLast ? "page" : undefined}>
      {content}
    </span>
  );
}

interface CollapsedMenuButtonProps {
  items: CocoaBreadcrumbItem[];
}

function CollapsedMenuButton({ items }: CollapsedMenuButtonProps) {
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [isHover, setIsHover] = useState<boolean>(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handlePointerDown = (event: globalThis.MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      close();
    };

    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
        triggerRef.current?.focus({ preventScroll: true });
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [isOpen, close]);

  const triggerStyle = useMemo<CSSProperties>(
    () => ({
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: 22,
      height: 20,
      padding: "0 6px",
      border: "none",
      background: isHover
        ? "var(--cocoa-background-control-hover, rgba(0, 0, 0, 0.06))"
        : "transparent",
      borderRadius: "var(--cocoa-radius-sm, 4px)",
      fontFamily: "var(--cocoa-font)",
      fontSize: "var(--cocoa-fs-body)",
      fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
      color: "var(--cocoa-label-secondary)",
      cursor: "pointer",
      userSelect: "none",
      WebkitAppearance: "none",
      appearance: "none",
      lineHeight: 1,
      transition:
        "background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), color var(--cocoa-duration-fast) var(--cocoa-ease-out)"
    }),
    [isHover]
  );

  const menuStyle = useMemo<CSSProperties>(
    () => ({
      position: "absolute",
      top: "calc(100% + 4px)",
      left: 0,
      minWidth: 160,
      padding: 4,
      background: "var(--cocoa-background-content)",
      border: "1px solid var(--cocoa-separator)",
      borderRadius: "var(--cocoa-radius-md)",
      boxShadow: "var(--cocoa-shadow-popover, 0 8px 24px rgba(0, 0, 0, 0.18))",
      zIndex: 1000,
      display: "flex",
      flexDirection: "column",
      gap: 1,
      fontFamily: "var(--cocoa-font)"
    }),
    []
  );

  const handleSelect = useCallback(
    (item: CocoaBreadcrumbItem) => {
      close();
      if (item.onClick) item.onClick();
    },
    [close]
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
        event.preventDefault();
        setIsOpen(true);
      }
    },
    []
  );

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={triggerRef}
        type="button"
        className="cocoa-focus-ring"
        style={triggerStyle}
        onClick={() => setIsOpen((prev) => !prev)}
        onMouseEnter={() => setIsHover(true)}
        onMouseLeave={() => setIsHover(false)}
        onKeyDown={handleKeyDown}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={menuId}
        aria-label="Show collapsed breadcrumb items"
      >
        …
      </button>
      {isOpen ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          style={menuStyle}
        >
          {items.map((item, index) => (
            <CollapsedMenuItem
              key={`${item.label}-${index}`}
              item={item}
              onSelect={handleSelect}
            />
          ))}
        </div>
      ) : null}
    </span>
  );
}

interface CollapsedMenuItemProps {
  item: CocoaBreadcrumbItem;
  onSelect: (item: CocoaBreadcrumbItem) => void;
}

function CollapsedMenuItem({ item, onSelect }: CollapsedMenuItemProps) {
  const [isHover, setIsHover] = useState<boolean>(false);
  const interactive = typeof item.onClick === "function";

  const style = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "6px 10px",
      border: "none",
      background: isHover
        ? "var(--cocoa-accent)"
        : "transparent",
      color: isHover
        ? "var(--cocoa-accent-contrast)"
        : "var(--cocoa-label)",
      borderRadius: "var(--cocoa-radius-sm, 4px)",
      fontFamily: "var(--cocoa-font)",
      fontSize: "var(--cocoa-fs-body)",
      fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
      letterSpacing: "var(--cocoa-tracking-tight)",
      lineHeight: 1.2,
      textAlign: "left",
      cursor: interactive ? "pointer" : "default",
      userSelect: "none",
      WebkitAppearance: "none",
      appearance: "none",
      whiteSpace: "nowrap",
      width: "100%"
    }),
    [isHover, interactive]
  );

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      onSelect(item);
    },
    [item, onSelect]
  );

  return (
    <button
      type="button"
      role="menuitem"
      style={style}
      onClick={handleClick}
      onMouseEnter={() => setIsHover(true)}
      onMouseLeave={() => setIsHover(false)}
      disabled={!interactive}
    >
      {item.icon ? (
        <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0 }}>
          {item.icon}
        </span>
      ) : null}
      <span>{item.label}</span>
    </button>
  );
}

interface SeparatorSlotProps {
  separator: ReactNode;
}

function SeparatorSlot({ separator }: SeparatorSlotProps) {
  const style = useMemo<CSSProperties>(
    () => ({
      display: "inline-flex",
      alignItems: "center",
      color: "var(--cocoa-label-tertiary)",
      fontFamily: "var(--cocoa-font)",
      fontSize: "var(--cocoa-fs-body)",
      lineHeight: 1.2,
      userSelect: "none",
      flexShrink: 0
    }),
    []
  );

  return (
    <span style={style} aria-hidden="true">
      {separator}
    </span>
  );
}

export function CocoaBreadcrumb({
  items,
  separator = "›"
}: CocoaBreadcrumbProps) {
  const containerRef = useRef<HTMLOListElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [isCollapsed, setIsCollapsed] = useState<boolean>(false);

  // Measure full vs available width and toggle collapsed state.
  const evaluateCollapse = useCallback(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;
    if (items.length <= 3) {
      setIsCollapsed(false);
      return;
    }
    const containerWidth = container.clientWidth;
    const fullWidth = measure.scrollWidth;
    setIsCollapsed(fullWidth > containerWidth);
  }, [items.length]);

  useLayoutEffect(() => {
    evaluateCollapse();
  }, [evaluateCollapse, items]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    if (typeof ResizeObserver === "undefined") return undefined;

    const observer = new ResizeObserver(() => {
      evaluateCollapse();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [evaluateCollapse]);

  const layout = useMemo(
    () => buildLayout(items, isCollapsed),
    [items, isCollapsed]
  );

  const navStyle = useMemo<CSSProperties>(
    () => ({
      display: "block",
      fontFamily: "var(--cocoa-font)",
      color: "var(--cocoa-label)",
      minWidth: 0,
      width: "100%"
    }),
    []
  );

  const listStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "nowrap",
      gap: 6,
      listStyle: "none",
      margin: 0,
      padding: 0,
      minWidth: 0,
      overflow: "hidden"
    }),
    []
  );

  const measureStyle = useMemo<CSSProperties>(
    () => ({
      position: "absolute",
      visibility: "hidden",
      pointerEvents: "none",
      left: -99999,
      top: 0,
      display: "flex",
      alignItems: "center",
      gap: 6,
      whiteSpace: "nowrap"
    }),
    []
  );

  const renderItemSlot = (
    item: CocoaBreadcrumbItem,
    isLast: boolean,
    key: string
  ) => (
    <li key={key} style={{ display: "inline-flex", alignItems: "center", minWidth: 0 }}>
      <BreadcrumbItem item={item} isLast={isLast} />
    </li>
  );

  const renderSeparator = (key: string) => (
    <li
      key={key}
      style={{ display: "inline-flex", alignItems: "center" }}
      aria-hidden="true"
    >
      <SeparatorSlot separator={separator} />
    </li>
  );

  // Build visible row.
  const visibleNodes: ReactNode[] = [];
  if (isCollapsed && layout.middle.length > 0) {
    layout.leading.forEach((item, index) => {
      visibleNodes.push(renderItemSlot(item, false, `lead-${index}`));
      visibleNodes.push(renderSeparator(`lead-sep-${index}`));
    });
    visibleNodes.push(
      <li
        key="collapsed"
        style={{ display: "inline-flex", alignItems: "center" }}
      >
        <CollapsedMenuButton items={layout.middle} />
      </li>
    );
    visibleNodes.push(renderSeparator("collapsed-sep"));
    layout.trailing.forEach((item, index) => {
      const isLast = index === layout.trailing.length - 1;
      visibleNodes.push(renderItemSlot(item, isLast, `trail-${index}`));
      if (!isLast) {
        visibleNodes.push(renderSeparator(`trail-sep-${index}`));
      }
    });
  } else {
    const total = items.length;
    items.forEach((item, index) => {
      const isLast = index === total - 1;
      visibleNodes.push(renderItemSlot(item, isLast, `item-${index}`));
      if (!isLast) {
        visibleNodes.push(renderSeparator(`sep-${index}`));
      }
    });
  }

  return (
    <nav aria-label="Breadcrumb" style={navStyle}>
      <ol ref={containerRef} style={listStyle}>
        {visibleNodes}
      </ol>
      {/* Hidden measurement node mirrors the full uncollapsed row. */}
      <div ref={measureRef} aria-hidden="true" style={measureStyle}>
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <span
              key={`measure-${index}`}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <BreadcrumbItem item={item} isLast={isLast} />
              {!isLast ? <SeparatorSlot separator={separator} /> : null}
            </span>
          );
        })}
      </div>
    </nav>
  );
}

export default CocoaBreadcrumb;
