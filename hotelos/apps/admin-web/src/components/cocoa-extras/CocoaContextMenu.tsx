// CocoaContextMenu — right-click context menu wrapper with Cocoa visuals.
//
// Wraps an arbitrary subtree and intercepts onContextMenu (right-click) to
// pop up a vertical list of menu items positioned at the cursor. Items can be
// regular actions, separators, or destructive actions, and may include an
// icon on the left and a keyboard shortcut hint on the right (rendered in a
// monospaced font, AppKit-style).
//
// Closes on: click outside, Escape key, or clicking any item. Disabled items
// are dimmed and ignore clicks. Destructive items are tinted with the danger
// color and switch their hover background to a danger tint.
//
// The menu itself is rendered in a fixed-position layer so it escapes any
// parent overflow:hidden / transform contexts, and it gets clamped to the
// viewport edges so a click near the bottom-right corner still produces a
// fully-visible menu.
//
// Visuals (background, shadow, blur, radius) all come from
// styles/cocoa-tokens.css so it stays consistent with CocoaPopover and the
// rest of the design system.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

export interface CocoaContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  destructive?: boolean;
  separator?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

export interface CocoaContextMenuProps {
  items: Array<CocoaContextMenuItem>;
  children: ReactNode;
}

interface MenuPosition {
  top: number;
  left: number;
}

// Padding between the cursor and the viewport edge when we have to clamp the
// menu so it stays fully visible.
const VIEWPORT_PADDING = 8;

export function CocoaContextMenu({ items, children }: CocoaContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Where the user right-clicked, in viewport coords. We use this as the
  // initial position, then clamp to viewport after measuring the menu.
  const [requestedPosition, setRequestedPosition] =
    useState<MenuPosition | null>(null);
  // Final clamped position after measurement — what we actually render.
  const [position, setPosition] = useState<MenuPosition | null>(null);

  const isOpen = requestedPosition !== null;

  const close = useCallback(() => {
    setRequestedPosition(null);
    setPosition(null);
  }, []);

  // Capture right-click on the wrapped subtree and open the menu at the
  // cursor. preventDefault suppresses the browser's native context menu.
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      setRequestedPosition({ top: event.clientY, left: event.clientX });
      // Reset measured position so the menu briefly hides until we re-measure.
      setPosition(null);
    },
    [],
  );

  // After the menu is rendered we can measure it and clamp the position to
  // the viewport. useLayoutEffect avoids a paint flash at the unclamped spot.
  useLayoutEffect(() => {
    if (requestedPosition === null) return;
    const menuEl = menuRef.current;
    if (menuEl === null) return;
    const menuRect = menuEl.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = requestedPosition.left;
    let top = requestedPosition.top;

    if (left + menuRect.width > viewportWidth - VIEWPORT_PADDING) {
      left = Math.max(VIEWPORT_PADDING, viewportWidth - menuRect.width - VIEWPORT_PADDING);
    }
    if (top + menuRect.height > viewportHeight - VIEWPORT_PADDING) {
      top = Math.max(VIEWPORT_PADDING, viewportHeight - menuRect.height - VIEWPORT_PADDING);
    }

    setPosition({ top, left });
  }, [requestedPosition]);

  // Close on outside mousedown — matches Cocoa popover behavior and feels
  // snappier than waiting for the click event.
  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current !== null && menuRef.current.contains(target)) {
        return;
      }
      close();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [isOpen, close]);

  // Close on Escape.
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
    };
  }, [isOpen, close]);

  // Close on scroll / resize so a stale menu doesn't float around after the
  // page layout shifts under it.
  useEffect(() => {
    if (!isOpen) return;
    const handler = () => close();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [isOpen, close]);

  const handleItemClick = (item: CocoaContextMenuItem) => {
    if (item.disabled === true) return;
    if (item.separator === true) return;
    if (item.onClick !== undefined) {
      item.onClick();
    }
    close();
  };

  const menuStyle: CSSProperties = {
    position: "fixed",
    top: position?.top ?? requestedPosition?.top ?? 0,
    left: position?.left ?? requestedPosition?.left ?? 0,
    // Hide for the measurement frame to avoid a flash at the unclamped spot.
    visibility: position === null ? "hidden" : "visible",
    background: "var(--cocoa-background-content)",
    boxShadow: "var(--cocoa-shadow-popover)",
    borderRadius: "var(--cocoa-radius-md)",
    backdropFilter: "var(--cocoa-material-popover-blur)",
    WebkitBackdropFilter: "var(--cocoa-material-popover-blur)",
    minWidth: 200,
    padding: "var(--cocoa-space-1) 0",
    display: "flex",
    flexDirection: "column",
    transformOrigin: "top left",
    animation:
      "cocoa-context-menu-in var(--cocoa-duration-fast) var(--cocoa-ease-out)",
    zIndex: 1000,
    fontFamily: "var(--cocoa-font-family)",
    fontSize: "var(--cocoa-fs-body)",
    lineHeight: "var(--cocoa-lh-body)",
    color: "var(--cocoa-label)",
    userSelect: "none",
  };

  return (
    <>
      {/* Keyframes injected inline so we don't need an extra CSS file. The
          fade+scale is subtle (fast duration) — context menus should feel
          immediate. */}
      <style>{`
        @keyframes cocoa-context-menu-in {
          from { opacity: 0; transform: scale(0.96); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <div
        onContextMenu={handleContextMenu}
        style={{ display: "contents" }}
      >
        {children}
      </div>
      {isOpen && (
        <div
          ref={menuRef}
          role="menu"
          aria-orientation="vertical"
          style={menuStyle}
        >
          {items.map((item) => {
            if (item.separator === true) {
              return (
                <div
                  key={item.id}
                  role="separator"
                  style={{
                    height: 1,
                    background: "var(--cocoa-separator)",
                    margin: "var(--cocoa-space-1) 0",
                  }}
                />
              );
            }
            return (
              <MenuItemRow
                key={item.id}
                item={item}
                onClick={() => handleItemClick(item)}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

interface MenuItemRowProps {
  item: CocoaContextMenuItem;
  onClick: () => void;
}

function MenuItemRow({ item, onClick }: MenuItemRowProps) {
  const [hovered, setHovered] = useState(false);

  const isDisabled = item.disabled === true;
  const isDestructive = item.destructive === true;

  // Color logic: destructive items always use the danger color; disabled
  // items dim to the secondary label color regardless of destructive state.
  const textColor = isDisabled
    ? "var(--cocoa-label-tertiary)"
    : isDestructive
      ? "var(--cocoa-danger)"
      : "var(--cocoa-label)";

  // Hover background. We pick a very subtle accent / danger tint so the menu
  // feels Cocoa-native rather than web-flashy.
  const hoverBackground =
    hovered && !isDisabled
      ? isDestructive
        ? "rgb(255 59 48 / 0.10)"
        : "rgb(0 100 225 / 0.10)"
      : "transparent";

  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--cocoa-space-2)",
    padding: "4px var(--cocoa-space-3)",
    margin: "0 var(--cocoa-space-1)",
    borderRadius: "var(--cocoa-radius-sm, 4px)",
    cursor: isDisabled ? "default" : "pointer",
    color: textColor,
    background: hoverBackground,
    transition: "background var(--cocoa-duration-fast) var(--cocoa-ease-out)",
    opacity: isDisabled ? 0.6 : 1,
  };

  return (
    <div
      role="menuitem"
      aria-disabled={isDisabled}
      tabIndex={-1}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      style={rowStyle}
    >
      {item.icon !== undefined && (
        <span
          aria-hidden="true"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 16,
            height: 16,
            flexShrink: 0,
          }}
        >
          {item.icon}
        </span>
      )}
      <span style={{ flex: 1, whiteSpace: "nowrap" }}>{item.label}</span>
      {item.shortcut !== undefined && (
        <span
          style={{
            fontFamily: "var(--cocoa-font-mono)",
            fontSize: "var(--cocoa-fs-footnote)",
            color: isDisabled
              ? "var(--cocoa-label-tertiary)"
              : "var(--cocoa-label-secondary)",
            marginLeft: "var(--cocoa-space-3)",
            whiteSpace: "nowrap",
          }}
        >
          {item.shortcut}
        </span>
      )}
    </div>
  );
}

export default CocoaContextMenu;
