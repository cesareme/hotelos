import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { CocoaSearchInput } from "../cocoa/CocoaSearchInput";

// Signature Mac command palette (Raycast/Alfred). Centered modal, search +
// keyboard-driven list. Items are provided by the caller — this component is a
// dumb shell that filters by substring on label + category and dispatches
// `onSelect` for the active row.
export interface CocoaCommandPaletteItem {
  id: string;
  label: string;
  category?: string;
  icon?: ReactNode;
  shortcut?: string;
  onSelect: () => void;
}

export interface CocoaCommandPaletteProps {
  open: boolean;
  onClose: () => void;
  items: CocoaCommandPaletteItem[];
}

// Approximate row height for virtualization slicing. Items render at 32–36px
// depending on font; we use a fixed 36 so scrollTop math stays simple.
const ROW_HEIGHT = 36;
// Number of off-screen rows to render above and below the viewport so quick
// arrow navigation doesn't show empty space before paint.
const OVERSCAN = 6;
// Cap the list viewport so the palette doesn't grow taller than the modal box.
const LIST_MAX_HEIGHT = 360;

const overlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  // 25% from the top of the viewport per the Mac signature look.
  paddingTop: "25vh",
  background: "rgba(0, 0, 0, 0.32)",
  zIndex: 1000
};

const panelBaseStyle: CSSProperties = {
  width: "100%",
  maxWidth: 640,
  margin: "0 16px",
  background: "var(--cocoa-background-content)",
  WebkitBackdropFilter: "blur(20px)",
  backdropFilter: "blur(20px)",
  borderRadius: "var(--cocoa-radius-xl)",
  boxShadow: "var(--cocoa-shadow-modal)",
  border: "1px solid var(--cocoa-separator)",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  transitionProperty: "transform, opacity",
  transitionTimingFunction: "ease-out",
  transitionDuration: "var(--cocoa-duration-base)"
};

const headerStyle: CSSProperties = {
  padding: 12,
  borderBottom: "1px solid var(--cocoa-separator)"
};

const listViewportStyle: CSSProperties = {
  maxHeight: LIST_MAX_HEIGHT,
  overflowY: "auto",
  position: "relative"
};

const itemRowBase: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 12px",
  height: ROW_HEIGHT,
  boxSizing: "border-box",
  cursor: "pointer",
  color: "inherit",
  userSelect: "none"
};

const iconCellStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 18,
  height: 18,
  flexShrink: 0,
  opacity: 0.85
};

const labelStyle: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis"
};

const categoryStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--cocoa-label-tertiary)",
  flexShrink: 0
};

const shortcutStyle: CSSProperties = {
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  fontSize: 11,
  color: "var(--cocoa-label-tertiary)",
  flexShrink: 0,
  letterSpacing: 0.5
};

const emptyStyle: CSSProperties = {
  padding: 24,
  textAlign: "center",
  color: "var(--cocoa-label-tertiary)",
  fontSize: 13
};

function normalize(s: string): string {
  return s.toLowerCase();
}

export function CocoaCommandPalette({
  open,
  onClose,
  items
}: CocoaCommandPaletteProps) {
  const [query, setQuery] = useState<string>("");
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const [scrollTop, setScrollTop] = useState<number>(0);
  const [mounted, setMounted] = useState<boolean>(open);
  const [visible, setVisible] = useState<boolean>(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Reset query and selection each time the palette opens. We delay teardown
  // until the exit animation finishes so the scale+fade is observable.
  useEffect(() => {
    if (open) {
      setMounted(true);
      setQuery("");
      setActiveIdx(0);
      setScrollTop(0);
      const raf = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = window.setTimeout(() => setMounted(false), 200);
    return () => window.clearTimeout(t);
  }, [open]);

  const filtered = useMemo(() => {
    const q = normalize(query.trim());
    if (!q) return items;
    return items.filter((it) => {
      if (normalize(it.label).includes(q)) return true;
      if (it.category && normalize(it.category).includes(q)) return true;
      return false;
    });
  }, [items, query]);

  // Reset active index when the filter window shrinks past the cursor.
  useEffect(() => {
    setActiveIdx((idx) => {
      if (filtered.length === 0) return 0;
      if (idx >= filtered.length) return filtered.length - 1;
      return idx;
    });
  }, [filtered.length]);

  // Keep the active row visible inside the scroll viewport when arrow keys
  // move the cursor outside the rendered window.
  useEffect(() => {
    if (!listRef.current) return;
    const top = activeIdx * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    const viewport = listRef.current;
    if (top < viewport.scrollTop) {
      viewport.scrollTop = top;
    } else if (bottom > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = bottom - viewport.clientHeight;
    }
  }, [activeIdx]);

  const commit = useCallback(
    (item: CocoaCommandPaletteItem) => {
      item.onSelect();
      onClose();
    },
    [onClose]
  );

  // Keyboard navigation only when the palette is mounted+open. We attach to
  // window so the input retains focus while we still steer arrows ourselves.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((idx) => Math.min(idx + 1, Math.max(filtered.length - 1, 0)));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((idx) => Math.max(idx - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        const item = filtered[activeIdx];
        if (item) {
          e.preventDefault();
          commit(item);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, activeIdx, commit, onClose]);

  // Compute virtualization window: render only the rows visible (plus overscan)
  // inside the scroll viewport. Cheap for thousands of items.
  const totalHeight = filtered.length * ROW_HEIGHT;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(LIST_MAX_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
  const endIdx = Math.min(filtered.length, startIdx + visibleCount);
  const offsetY = startIdx * ROW_HEIGHT;

  if (!mounted) return null;

  const panelStyle: CSSProperties = {
    ...panelBaseStyle,
    opacity: visible ? 1 : 0,
    transform: visible ? "scale(1)" : "scale(0.95)"
  };

  return createPortal(
    <div
      style={overlayStyle}
      onClick={onClose}
      role="presentation"
    >
      <div
        style={panelStyle}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Paleta de comandos"
      >
        <div style={headerStyle}>
          <CocoaSearchInput
            value={query}
            onChange={setQuery}
            placeholder="Buscar acciones, pantallas..."
            autoFocus
          />
        </div>
        <div
          ref={listRef}
          style={listViewportStyle}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
          role="listbox"
          aria-label="Resultados"
        >
          {filtered.length === 0 ? (
            <div style={emptyStyle}>Sin resultados</div>
          ) : (
            <div style={{ height: totalHeight, position: "relative" }}>
              <div
                style={{
                  position: "absolute",
                  top: offsetY,
                  left: 0,
                  right: 0
                }}
              >
                {filtered.slice(startIdx, endIdx).map((item, i) => {
                  const idx = startIdx + i;
                  const active = idx === activeIdx;
                  const rowStyle: CSSProperties = {
                    ...itemRowBase,
                    background: active ? "var(--cocoa-accent)" : "transparent",
                    color: active ? "#FFFFFF" : "inherit"
                  };
                  const subStyle: CSSProperties = active
                    ? { ...categoryStyle, color: "rgba(255,255,255,0.85)" }
                    : categoryStyle;
                  const kbdStyle: CSSProperties = active
                    ? { ...shortcutStyle, color: "rgba(255,255,255,0.85)" }
                    : shortcutStyle;
                  return (
                    <div
                      key={item.id}
                      role="option"
                      aria-selected={active}
                      style={rowStyle}
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => commit(item)}
                    >
                      {item.icon ? (
                        <span style={iconCellStyle} aria-hidden="true">
                          {item.icon}
                        </span>
                      ) : (
                        <span style={iconCellStyle} aria-hidden="true" />
                      )}
                      <span style={labelStyle}>{item.label}</span>
                      {item.category ? (
                        <span style={subStyle}>{item.category}</span>
                      ) : null}
                      {item.shortcut ? (
                        <span style={kbdStyle}>{item.shortcut}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

// Global Cmd+K / Ctrl+K listener. Mount once near the app root and pass an
// open setter; the hook prevents the browser's default Meta+K behavior so the
// palette wins regardless of focus.
export function useCocoaCommandPaletteHotkey(onOpen: () => void): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isK = e.key === "k" || e.key === "K";
      if (!isK) return;
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        onOpen();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onOpen]);
}

export default CocoaCommandPalette;
