// CocoaWhatsNewDialog — Release notes modal for HotelOS.
//
// A 720x560 modal that surfaces the contents of a product release to users.
// It is meant to be shown on the first session after a new version ships, and
// can be reopened from the help menu.
//
// Layout, top-to-bottom:
//   - Header: large version label (e.g. "v3.4") with the release date as a
//     secondary subtitle to its right.
//   - Tabs: a CocoaSegmentedControl with one entry per item `type`
//     ('feature', 'improvement', 'fix'). The tabs filter the list below. A
//     'Todo' (All) tab is included as a sensible default. Tabs whose count
//     is zero are hidden so the control never grows beyond the relevant
//     options.
//   - List: a scrollable column of items. Each item shows a small colored
//     badge with the localized type label, the item title in semibold, and
//     a description paragraph. An optional image is rendered on the right
//     side of the row when provided.
//   - Footer: a flat 'No mostrar de nuevo' checkbox on the left and a
//     filled accent 'Genial' button on the right that calls `onClose`.
//
// Visuals: blurred backdrop with fade, dialog container with
// var(--cocoa-radius-lg), var(--cocoa-shadow-modal), and a spring scale/
// translate entry powered by var(--cocoa-ease-spring). All colors resolve
// through cocoa-tokens so light/dark themes pick up automatically.
//
// A11y:
// - role="dialog" + aria-modal="true"
// - aria-labelledby on the version header
// - ESC closes the modal (calls onClose)
// - Focus moves to the primary action ('Genial') on open and is restored to
//   the previously focused element on close; focus is trapped within the
//   dialog while open.
// - The tab strip uses role="tablist" via CocoaSegmentedControl.
// - The dismiss checkbox emits its current value back to the caller via
//   `onDontShowAgainChange` so the host can persist the preference.
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
import { CocoaSegmentedControl } from "../cocoa/CocoaSegmentedControl";

export type CocoaWhatsNewItemType = "feature" | "improvement" | "fix";

export interface CocoaWhatsNewItem {
  type: CocoaWhatsNewItemType;
  title: string;
  description: string;
  image?: string;
}

export interface CocoaWhatsNewDialogProps {
  open: boolean;
  onClose: () => void;
  version: string;
  releaseDate: string;
  items: CocoaWhatsNewItem[];
  dontShowAgain?: boolean;
  onDontShowAgainChange?: (value: boolean) => void;
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

type TabValue = "all" | CocoaWhatsNewItemType;

interface TabDefinition {
  value: TabValue;
  label: string;
}

const TABS_ORDER: TabDefinition[] = [
  { value: "all", label: "Todo" },
  { value: "feature", label: "Nuevo" },
  { value: "improvement", label: "Mejoras" },
  { value: "fix", label: "Correcciones" }
];

interface BadgeTheme {
  label: string;
  color: string;
  background: string;
  border: string;
}

const BADGE_THEMES: Record<CocoaWhatsNewItemType, BadgeTheme> = {
  feature: {
    label: "Nuevo",
    color: "var(--cocoa-accent)",
    background: "color-mix(in srgb, var(--cocoa-accent) 14%, transparent)",
    border: "color-mix(in srgb, var(--cocoa-accent) 32%, transparent)"
  },
  improvement: {
    label: "Mejora",
    color: "var(--cocoa-success)",
    background: "color-mix(in srgb, var(--cocoa-success) 14%, transparent)",
    border: "color-mix(in srgb, var(--cocoa-success) 32%, transparent)"
  },
  fix: {
    label: "Corrección",
    color: "var(--cocoa-warning)",
    background: "color-mix(in srgb, var(--cocoa-warning) 14%, transparent)",
    border: "color-mix(in srgb, var(--cocoa-warning) 32%, transparent)"
  }
};

export function CocoaWhatsNewDialog({
  open,
  onClose,
  version,
  releaseDate,
  items,
  dontShowAgain,
  onDontShowAgainChange
}: CocoaWhatsNewDialogProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [isMounted, setIsMounted] = useState<boolean>(open);
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<TabValue>("all");
  const [internalDontShow, setInternalDontShow] = useState<boolean>(
    dontShowAgain ?? false
  );
  const titleId = useId();
  const subtitleId = useId();
  const checkboxId = useId();

  const isDontShowControlled = typeof dontShowAgain === "boolean";
  const dontShowValue = isDontShowControlled
    ? Boolean(dontShowAgain)
    : internalDontShow;

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

  // Reset the active tab whenever the modal is reopened so it always starts
  // on 'Todo'.
  useEffect(() => {
    if (open) {
      setActiveTab("all");
    }
  }, [open]);

  // Focus management — move focus to the primary action on open,
  // restore on close.
  useEffect(() => {
    if (!isMounted) return undefined;
    previouslyFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? null;

    const root = containerRef.current;
    const raf = window.requestAnimationFrame(() => {
      if (primaryActionRef.current) {
        primaryActionRef.current.focus({ preventScroll: true });
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

  const handleDismiss = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleDontShowChange = useCallback(
    (event: ReactMouseEvent<HTMLInputElement> | React.ChangeEvent<HTMLInputElement>) => {
      const target = event.target as HTMLInputElement;
      const next = target.checked;
      if (!isDontShowControlled) {
        setInternalDontShow(next);
      }
      onDontShowAgainChange?.(next);
    },
    [isDontShowControlled, onDontShowAgainChange]
  );

  // Filter items per tab + compute counts per type so we can hide empty tabs.
  const countsByType = useMemo(() => {
    const map: Record<CocoaWhatsNewItemType, number> = {
      feature: 0,
      improvement: 0,
      fix: 0
    };
    for (const item of items) {
      map[item.type] += 1;
    }
    return map;
  }, [items]);

  const tabOptions = useMemo(() => {
    return TABS_ORDER.filter((tab) => {
      if (tab.value === "all") return items.length > 0;
      return countsByType[tab.value] > 0;
    }).map((tab) => ({ value: tab.value, label: tab.label }));
  }, [countsByType, items.length]);

  const effectiveTab: TabValue = useMemo(() => {
    if (tabOptions.some((tab) => tab.value === activeTab)) return activeTab;
    return tabOptions[0]?.value ?? "all";
  }, [activeTab, tabOptions]);

  const filteredItems = useMemo(() => {
    if (effectiveTab === "all") return items;
    return items.filter((item) => item.type === effectiveTab);
  }, [effectiveTab, items]);

  const handleTabChange = useCallback((value: string) => {
    setActiveTab(value as TabValue);
  }, []);

  const backdropStyle = useMemo<CSSProperties>(
    () => ({
      position: "fixed",
      inset: 0,
      zIndex: 1100,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 16,
      background: "rgba(0, 0, 0, 0.32)",
      backdropFilter: "blur(8px) saturate(180%)",
      WebkitBackdropFilter: "blur(8px) saturate(180%)",
      opacity: isVisible ? 1 : 0,
      transition: "opacity var(--cocoa-duration-base) var(--cocoa-ease-out)",
      pointerEvents: isVisible ? "auto" : "none"
    }),
    [isVisible]
  );

  const containerStyle = useMemo<CSSProperties>(
    () => ({
      position: "relative",
      width: 720,
      height: 560,
      maxWidth: "100%",
      maxHeight: "100%",
      display: "flex",
      flexDirection: "column",
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
      color: "var(--cocoa-label)",
      boxSizing: "border-box",
      overflow: "hidden"
    }),
    [isVisible]
  );

  const headerStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: 16,
      padding: "24px 28px 16px",
      borderBottom: "1px solid var(--cocoa-separator)",
      flexShrink: 0
    }),
    []
  );

  const versionStyle = useMemo<CSSProperties>(
    () => ({
      margin: 0,
      fontSize: "var(--cocoa-fs-title-1)",
      lineHeight: "var(--cocoa-lh-title-1)",
      fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
      letterSpacing: "var(--cocoa-tracking-tight)",
      color: "var(--cocoa-label)"
    }),
    []
  );

  const releaseDateStyle = useMemo<CSSProperties>(
    () => ({
      margin: 0,
      fontSize: "var(--cocoa-fs-subheadline)",
      fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
      color: "var(--cocoa-label-secondary)"
    }),
    []
  );

  const tabsBarStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      justifyContent: "flex-start",
      padding: "12px 28px 8px",
      flexShrink: 0
    }),
    []
  );

  const listScrollStyle = useMemo<CSSProperties>(
    () => ({
      flex: 1,
      overflowY: "auto",
      padding: "8px 28px 16px",
      display: "flex",
      flexDirection: "column",
      gap: 12
    }),
    []
  );

  const emptyStateStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flex: 1,
      color: "var(--cocoa-label-secondary)",
      fontSize: "var(--cocoa-fs-body)"
    }),
    []
  );

  const itemRowStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      alignItems: "flex-start",
      gap: 16,
      padding: 16,
      background: "var(--cocoa-background-control)",
      border: "1px solid var(--cocoa-separator)",
      borderRadius: "var(--cocoa-radius-md)",
      boxShadow: "var(--cocoa-shadow-control)",
      boxSizing: "border-box"
    }),
    []
  );

  const itemTextColumnStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      flexDirection: "column",
      gap: 6,
      flex: 1,
      minWidth: 0
    }),
    []
  );

  const itemTitleRowStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      alignItems: "center",
      gap: 10,
      flexWrap: "wrap"
    }),
    []
  );

  const itemTitleStyle = useMemo<CSSProperties>(
    () => ({
      margin: 0,
      fontSize: "var(--cocoa-fs-headline)",
      lineHeight: "var(--cocoa-lh-headline)",
      fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
      color: "var(--cocoa-label)"
    }),
    []
  );

  const itemDescriptionStyle = useMemo<CSSProperties>(
    () => ({
      margin: 0,
      fontSize: "var(--cocoa-fs-body)",
      lineHeight: 1.4,
      color: "var(--cocoa-label-secondary)"
    }),
    []
  );

  const itemImageStyle = useMemo<CSSProperties>(
    () => ({
      width: 96,
      height: 72,
      flexShrink: 0,
      objectFit: "cover",
      borderRadius: "var(--cocoa-radius-sm)",
      border: "1px solid var(--cocoa-separator)"
    }),
    []
  );

  const footerStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 16,
      padding: "16px 28px 20px",
      borderTop: "1px solid var(--cocoa-separator)",
      flexShrink: 0
    }),
    []
  );

  const dontShowLabelStyle = useMemo<CSSProperties>(
    () => ({
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      fontSize: "var(--cocoa-fs-footnote)",
      color: "var(--cocoa-label-secondary)",
      cursor: "pointer",
      userSelect: "none"
    }),
    []
  );

  const dontShowCheckboxStyle = useMemo<CSSProperties>(
    () => ({
      margin: 0,
      width: 14,
      height: 14,
      accentColor: "var(--cocoa-accent)",
      cursor: "pointer"
    }),
    []
  );

  function renderBadge(type: CocoaWhatsNewItemType) {
    const theme = BADGE_THEMES[type];
    const style: CSSProperties = {
      display: "inline-flex",
      alignItems: "center",
      padding: "2px 8px",
      borderRadius: 999,
      fontSize: "var(--cocoa-fs-caption-1)",
      lineHeight: 1.2,
      fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
      color: theme.color,
      background: theme.background,
      border: `1px solid ${theme.border}`,
      whiteSpace: "nowrap"
    };
    return (
      <span style={style} aria-label={theme.label}>
        {theme.label}
      </span>
    );
  }

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
        aria-describedby={subtitleId}
        tabIndex={-1}
        style={containerStyle}
        onKeyDown={handleContainerKeyDown}
      >
        <header style={headerStyle}>
          <h1 id={titleId} style={versionStyle}>
            {version}
          </h1>
          <p id={subtitleId} style={releaseDateStyle}>
            {releaseDate}
          </p>
        </header>

        {tabOptions.length > 1 ? (
          <div style={tabsBarStyle}>
            <CocoaSegmentedControl
              size="small"
              value={effectiveTab}
              onChange={handleTabChange}
              options={tabOptions}
              aria-label="Filtrar novedades por tipo"
            />
          </div>
        ) : (
          <div style={{ height: 8, flexShrink: 0 }} aria-hidden="true" />
        )}

        {filteredItems.length === 0 ? (
          <div style={emptyStateStyle}>No hay novedades para mostrar.</div>
        ) : (
          <ul
            style={listScrollStyle}
            aria-label="Lista de novedades"
          >
            {filteredItems.map((item, index) => (
              <li
                key={`${item.type}-${index}-${item.title}`}
                style={itemRowStyle}
              >
                <div style={itemTextColumnStyle}>
                  <div style={itemTitleRowStyle}>
                    {renderBadge(item.type)}
                    <h2 style={itemTitleStyle}>{item.title}</h2>
                  </div>
                  <p style={itemDescriptionStyle}>{item.description}</p>
                </div>
                {item.image ? (
                  <img
                    src={item.image}
                    alt=""
                    style={itemImageStyle}
                    loading="lazy"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <footer style={footerStyle}>
          <label htmlFor={checkboxId} style={dontShowLabelStyle}>
            <input
              id={checkboxId}
              type="checkbox"
              checked={dontShowValue}
              onChange={handleDontShowChange}
              style={dontShowCheckboxStyle}
            />
            No mostrar de nuevo
          </label>

          <CocoaButton
            variant="filled"
            tone="accent"
            size="large"
            onClick={handleDismiss}
            aria-label="Cerrar novedades"
          >
            <span
              ref={(el) => {
                const btn = el?.closest("button") as HTMLButtonElement | null;
                primaryActionRef.current = btn;
              }}
            >
              Genial
            </span>
          </CocoaButton>
        </footer>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

export default CocoaWhatsNewDialog;
