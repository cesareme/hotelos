// CocoaHelpButton — contextual screen guidance trigger.
//
// Renders a small circular "?" button anchored to the bottom-right corner of
// the viewport. Activating it opens a right-side Sheet (420px wide, full
// height) that exposes the contextual help for the current screen, organized
// into five tabs: Qué es, Cómo usarla, Trucos, Atajos and Relacionadas. The
// footer carries a link to the central help center scoped to the screen via
// the `screenId` query parameter so deep-linking from the docs back into the
// app stays consistent.
//
// The component is intentionally self-contained and uses inline styles aligned
// with the Cocoa design tokens (`--cocoa-*` CSS variables) so it can be
// dropped into any screen without extra wiring. Tabs whose content is empty
// or unprovided are hidden so each screen only surfaces what it actually
// documents.
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";

export interface CocoaHelpRelatedScreen {
  /** Stable identifier of the related screen (used for the help-center deep link). */
  screenId: string;
  /** Human-readable label shown in the list. */
  label: string;
  /** Optional in-app route. When omitted, the entry is rendered as static text. */
  href?: string;
  /** Optional short description shown under the label. */
  description?: string;
}

export interface CocoaHelpContent {
  /** Plain-language explanation of what the screen is for. */
  whatIsThis: ReactNode;
  /** Ordered, step-by-step instructions for the most common workflow. */
  howToUse: ReactNode[];
  /** Optional tips & tricks the user might miss otherwise. */
  tips?: ReactNode[];
  /** Optional list of keyboard shortcuts specific to the screen. */
  shortcuts?: Array<{ keys: string; action: string }>;
  /** Optional list of related screens the user may want to jump to. */
  relatedScreens?: CocoaHelpRelatedScreen[];
}

export interface CocoaHelpButtonProps {
  /** Stable identifier of the current screen. Used for the help-center link. */
  screenId: string;
  /** Display name of the current screen. Shown in the sheet header. */
  screenLabel: string;
  /** Contextual content rendered inside the sheet. */
  helpContent: CocoaHelpContent;
  /**
   * Optional override for the help center base URL. Defaults to the standard
   * `/ayuda` entry point used across the admin app.
   */
  helpCenterBaseUrl?: string;
  /**
   * Optional className applied to the floating trigger button. Useful for
   * tests and for screens that need to nudge the button off-axis to avoid
   * collisions with other floating elements.
   */
  className?: string;
  /**
   * Optional style overrides for the floating trigger button. Mostly used to
   * tweak `bottom`/`right` offsets per screen.
   */
  buttonStyle?: CSSProperties;
}

type HelpTabId =
  | "what-is-this"
  | "how-to-use"
  | "tips"
  | "shortcuts"
  | "related";

interface HelpTabDefinition {
  id: HelpTabId;
  label: string;
  isAvailable: boolean;
}

const SHEET_WIDTH = 420;
const DEFAULT_HELP_CENTER_BASE_URL = "/ayuda";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
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

function buildHelpCenterUrl(baseUrl: string, screenId: string): string {
  // Append the screenId as a query parameter so the help center can scroll to
  // (or filter by) the article that matches the current screen. We avoid the
  // URL constructor here because `baseUrl` may be relative (e.g. "/ayuda").
  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}screen=${encodeURIComponent(screenId)}`;
}

const triggerBaseStyle: CSSProperties = {
  position: "fixed",
  bottom: 24,
  right: 24,
  zIndex: 900,
  width: 40,
  height: 40,
  borderRadius: "50%",
  background: "var(--cocoa-background-content)",
  border: "1px solid var(--cocoa-separator)",
  color: "var(--cocoa-accent)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  fontFamily: "var(--cocoa-font)",
  fontSize: "var(--cocoa-fs-title-3)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  lineHeight: 1,
  boxShadow: "var(--cocoa-shadow-floating)",
  transition:
    "transform var(--cocoa-duration-fast) var(--cocoa-ease-out), background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), color var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-fast) var(--cocoa-ease-out)"
};

const backdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  display: "flex",
  justifyContent: "flex-end",
  background: "rgba(0, 0, 0, 0.32)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)"
};

const sheetBaseStyle: CSSProperties = {
  position: "relative",
  width: SHEET_WIDTH,
  maxWidth: "94vw",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  background: "var(--cocoa-background-content)",
  boxShadow: "var(--cocoa-shadow-modal)",
  borderTopLeftRadius: "var(--cocoa-radius-xl)",
  borderBottomLeftRadius: "var(--cocoa-radius-xl)",
  outline: "none",
  fontFamily: "var(--cocoa-font)",
  color: "var(--cocoa-label)",
  overflow: "hidden"
};

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 12,
  padding: "16px 20px 12px",
  borderBottom: "1px solid var(--cocoa-separator)",
  flexShrink: 0
};

const eyebrowStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-normal)",
  textTransform: "uppercase",
  color: "var(--cocoa-label-secondary)"
};

const titleStyle: CSSProperties = {
  margin: "4px 0 0",
  fontSize: "var(--cocoa-fs-title-3)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  color: "var(--cocoa-label)",
  lineHeight: 1.25,
  overflow: "hidden",
  textOverflow: "ellipsis"
};

const closeButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: "var(--cocoa-radius-md)",
  background: "transparent",
  border: "1px solid transparent",
  color: "var(--cocoa-label-secondary)",
  cursor: "pointer",
  flexShrink: 0,
  padding: 0,
  transition:
    "background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), color var(--cocoa-duration-fast) var(--cocoa-ease-out)"
};

const tabsStyle: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: 0,
  padding: "8px 12px 0",
  borderBottom: "1px solid var(--cocoa-separator)",
  background: "var(--cocoa-background-content)",
  overflowX: "auto",
  flexShrink: 0
};

const bodyStyle: CSSProperties = {
  padding: "16px 20px 20px",
  overflow: "auto",
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  gap: 12
};

const sectionHeadingStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-subheadline)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  color: "var(--cocoa-label)",
  letterSpacing: "var(--cocoa-tracking-tight)"
};

const paragraphStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-body)",
  lineHeight: 1.5,
  color: "var(--cocoa-label)"
};

const orderedListStyle: CSSProperties = {
  margin: 0,
  paddingLeft: 22,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-label)",
  lineHeight: 1.5
};

const unorderedListStyle: CSSProperties = {
  margin: 0,
  paddingLeft: 22,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-label)",
  lineHeight: 1.5
};

const shortcutsListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 0,
  margin: 0,
  padding: 0,
  listStyle: "none"
};

const shortcutRowStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, auto) minmax(0, 1fr)",
  alignItems: "center",
  gap: 12,
  padding: "8px 0",
  borderBottom: "1px solid var(--cocoa-separator)"
};

const shortcutRowLastStyle: CSSProperties = {
  ...shortcutRowStyle,
  borderBottom: "none"
};

const shortcutKeysStyle: CSSProperties = {
  fontFamily: "var(--cocoa-font-mono)",
  fontSize: "var(--cocoa-fs-footnote)",
  fontWeight: "var(--cocoa-fw-bold)" as unknown as number,
  color: "var(--cocoa-label)",
  padding: "2px 8px",
  borderRadius: "var(--cocoa-radius-sm)",
  background: "var(--cocoa-background-control)",
  border: "1px solid var(--cocoa-separator)",
  whiteSpace: "nowrap"
};

const shortcutActionStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-label-secondary)",
  lineHeight: 1.4
};

const relatedListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: 4
};

const relatedItemStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "10px 12px",
  borderRadius: "var(--cocoa-radius-md)",
  border: "1px solid var(--cocoa-separator)",
  background: "var(--cocoa-background-content)",
  color: "var(--cocoa-label)",
  textDecoration: "none",
  cursor: "pointer",
  transition:
    "background-color var(--cocoa-duration-fast) var(--cocoa-ease-out)"
};

const relatedItemStaticStyle: CSSProperties = {
  ...relatedItemStyle,
  cursor: "default"
};

const relatedLabelStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-body)",
  fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
  color: "var(--cocoa-label)"
};

const relatedDescriptionStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-footnote)",
  color: "var(--cocoa-label-secondary)",
  lineHeight: 1.4
};

const emptyStateStyle: CSSProperties = {
  padding: "12px 0",
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-label-secondary)"
};

const footerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "12px 20px",
  borderTop: "1px solid var(--cocoa-separator)",
  flexShrink: 0,
  fontSize: "var(--cocoa-fs-footnote)",
  color: "var(--cocoa-label-secondary)",
  background: "var(--cocoa-background-content)"
};

const footerLinkStyle: CSSProperties = {
  color: "var(--cocoa-accent)",
  textDecoration: "none",
  fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
  display: "inline-flex",
  alignItems: "center",
  gap: 6
};

const TAB_BUTTON_PADDING = "8px 10px";

function getTabButtonStyle(isActive: boolean): CSSProperties {
  return {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: TAB_BUTTON_PADDING,
    border: "none",
    background: "transparent",
    color: isActive
      ? "var(--cocoa-label)"
      : "var(--cocoa-label-secondary)",
    fontFamily: "inherit",
    fontSize: "var(--cocoa-fs-subheadline)",
    fontWeight: isActive
      ? ("var(--cocoa-fw-semibold)" as unknown as number)
      : ("var(--cocoa-fw-medium)" as unknown as number),
    letterSpacing: "var(--cocoa-tracking-tight)",
    lineHeight: 1,
    whiteSpace: "nowrap",
    cursor: isActive ? "default" : "pointer",
    borderBottom: isActive
      ? "2px solid var(--cocoa-accent)"
      : "2px solid transparent",
    marginBottom: -1,
    transition:
      "color var(--cocoa-duration-fast) var(--cocoa-ease-out), border-color var(--cocoa-duration-fast) var(--cocoa-ease-out)"
  };
}

export function CocoaHelpButton({
  screenId,
  screenLabel,
  helpContent,
  helpCenterBaseUrl = DEFAULT_HELP_CENTER_BASE_URL,
  className,
  buttonStyle
}: CocoaHelpButtonProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState<boolean>(false);
  const titleId = useId();
  const tabsLabelId = useId();
  const panelId = useId();

  const tabs = useMemo<HelpTabDefinition[]>(() => {
    const hasTips = (helpContent.tips ?? []).length > 0;
    const hasShortcuts = (helpContent.shortcuts ?? []).length > 0;
    const hasRelated = (helpContent.relatedScreens ?? []).length > 0;
    return [
      { id: "what-is-this", label: "Qué es", isAvailable: true },
      {
        id: "how-to-use",
        label: "Cómo usarla",
        isAvailable: helpContent.howToUse.length > 0
      },
      { id: "tips", label: "Trucos", isAvailable: hasTips },
      { id: "shortcuts", label: "Atajos", isAvailable: hasShortcuts },
      { id: "related", label: "Relacionadas", isAvailable: hasRelated }
    ];
  }, [
    helpContent.howToUse,
    helpContent.tips,
    helpContent.shortcuts,
    helpContent.relatedScreens
  ]);

  const availableTabs = useMemo(
    () => tabs.filter((tab) => tab.isAvailable),
    [tabs]
  );

  const [activeTab, setActiveTab] = useState<HelpTabId>(
    availableTabs[0]?.id ?? "what-is-this"
  );

  // Whenever the sheet opens, default back to the first tab so each visit
  // starts at the contextual "what is this" view.
  useEffect(() => {
    if (!open) return;
    const fallback = availableTabs[0]?.id ?? "what-is-this";
    setActiveTab(fallback);
  }, [open, availableTabs]);

  // Focus management: trap focus inside the sheet while open, restore the
  // trigger when it closes.
  useEffect(() => {
    if (!open) return undefined;
    previouslyFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? triggerRef.current;

    const root = containerRef.current;
    if (root) {
      const focusables = getFocusableElements(root);
      const first = focusables[0] ?? root;
      const raf = window.requestAnimationFrame(() => {
        first.focus({ preventScroll: true });
      });
      return () => {
        window.cancelAnimationFrame(raf);
        const previous = previouslyFocusedRef.current ?? triggerRef.current;
        if (previous && typeof previous.focus === "function") {
          previous.focus({ preventScroll: true });
        }
      };
    }

    return () => {
      const previous = previouslyFocusedRef.current ?? triggerRef.current;
      if (previous && typeof previous.focus === "function") {
        previous.focus({ preventScroll: true });
      }
    };
  }, [open]);

  // Close on Escape and lock body scroll while the sheet is visible.
  useEffect(() => {
    if (!open) return undefined;

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const handleBackdropClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        setOpen(false);
      }
    },
    []
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

  const handleTabsKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (availableTabs.length === 0) return;
      const currentIndex = availableTabs.findIndex(
        (tab) => tab.id === activeTab
      );
      if (currentIndex < 0) return;

      if (event.key === "ArrowRight") {
        event.preventDefault();
        const next = availableTabs[(currentIndex + 1) % availableTabs.length];
        setActiveTab(next.id);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        const next =
          availableTabs[
            (currentIndex - 1 + availableTabs.length) % availableTabs.length
          ];
        setActiveTab(next.id);
      } else if (event.key === "Home") {
        event.preventDefault();
        setActiveTab(availableTabs[0].id);
      } else if (event.key === "End") {
        event.preventDefault();
        setActiveTab(availableTabs[availableTabs.length - 1].id);
      }
    },
    [activeTab, availableTabs]
  );

  const handleTriggerHover = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.transform = "scale(1.05)";
    event.currentTarget.style.color = "var(--cocoa-accent-hover)";
  };

  const handleTriggerLeave = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.transform = "";
    event.currentTarget.style.color = "var(--cocoa-accent)";
  };

  const handleCloseHover = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.background = "var(--cocoa-background-control)";
    event.currentTarget.style.color = "var(--cocoa-label)";
  };

  const handleCloseLeave = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.currentTarget.style.background = "transparent";
    event.currentTarget.style.color = "var(--cocoa-label-secondary)";
  };

  const handleRelatedHover = (event: ReactMouseEvent<HTMLElement>) => {
    event.currentTarget.style.background =
      "var(--cocoa-background-control)";
  };

  const handleRelatedLeave = (event: ReactMouseEvent<HTMLElement>) => {
    event.currentTarget.style.background = "var(--cocoa-background-content)";
  };

  const triggerStyle = useMemo<CSSProperties>(() => {
    if (!buttonStyle) return triggerBaseStyle;
    return { ...triggerBaseStyle, ...buttonStyle };
  }, [buttonStyle]);

  const helpCenterUrl = useMemo(
    () => buildHelpCenterUrl(helpCenterBaseUrl, screenId),
    [helpCenterBaseUrl, screenId]
  );

  const renderTabContent = (): ReactNode => {
    switch (activeTab) {
      case "what-is-this":
        return (
          <section aria-labelledby={`${panelId}-what-is-this`}>
            <h3 id={`${panelId}-what-is-this`} style={sectionHeadingStyle}>
              ¿Qué es esta pantalla?
            </h3>
            <div style={{ height: 8 }} />
            {typeof helpContent.whatIsThis === "string" ? (
              <p style={paragraphStyle}>{helpContent.whatIsThis}</p>
            ) : (
              helpContent.whatIsThis
            )}
          </section>
        );
      case "how-to-use":
        return (
          <section aria-labelledby={`${panelId}-how-to-use`}>
            <h3 id={`${panelId}-how-to-use`} style={sectionHeadingStyle}>
              Cómo usarla
            </h3>
            <div style={{ height: 8 }} />
            {helpContent.howToUse.length === 0 ? (
              <p style={emptyStateStyle}>
                Aún no hay instrucciones documentadas para esta pantalla.
              </p>
            ) : (
              <ol style={orderedListStyle}>
                {helpContent.howToUse.map((step, idx) => (
                  <li key={`how-${idx}`}>{step}</li>
                ))}
              </ol>
            )}
          </section>
        );
      case "tips": {
        const tips = helpContent.tips ?? [];
        return (
          <section aria-labelledby={`${panelId}-tips`}>
            <h3 id={`${panelId}-tips`} style={sectionHeadingStyle}>
              Trucos
            </h3>
            <div style={{ height: 8 }} />
            {tips.length === 0 ? (
              <p style={emptyStateStyle}>Sin trucos por ahora.</p>
            ) : (
              <ul style={unorderedListStyle}>
                {tips.map((tip, idx) => (
                  <li key={`tip-${idx}`}>{tip}</li>
                ))}
              </ul>
            )}
          </section>
        );
      }
      case "shortcuts": {
        const shortcuts = helpContent.shortcuts ?? [];
        return (
          <section aria-labelledby={`${panelId}-shortcuts`}>
            <h3 id={`${panelId}-shortcuts`} style={sectionHeadingStyle}>
              Atajos
            </h3>
            <div style={{ height: 8 }} />
            {shortcuts.length === 0 ? (
              <p style={emptyStateStyle}>
                Esta pantalla no expone atajos propios.
              </p>
            ) : (
              <ul style={shortcutsListStyle}>
                {shortcuts.map((shortcut, idx) => {
                  const isLast = idx === shortcuts.length - 1;
                  return (
                    <li
                      key={`shortcut-${shortcut.keys}-${idx}`}
                      style={isLast ? shortcutRowLastStyle : shortcutRowStyle}
                    >
                      <kbd style={shortcutKeysStyle}>{shortcut.keys}</kbd>
                      <span style={shortcutActionStyle}>
                        {shortcut.action}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      }
      case "related": {
        const related = helpContent.relatedScreens ?? [];
        return (
          <section aria-labelledby={`${panelId}-related`}>
            <h3 id={`${panelId}-related`} style={sectionHeadingStyle}>
              Pantallas relacionadas
            </h3>
            <div style={{ height: 8 }} />
            {related.length === 0 ? (
              <p style={emptyStateStyle}>Sin pantallas relacionadas.</p>
            ) : (
              <ul style={relatedListStyle}>
                {related.map((item) => {
                  const content = (
                    <>
                      <span style={relatedLabelStyle}>{item.label}</span>
                      {item.description ? (
                        <span style={relatedDescriptionStyle}>
                          {item.description}
                        </span>
                      ) : null}
                    </>
                  );
                  if (item.href) {
                    return (
                      <li key={`related-${item.screenId}`}>
                        <a
                          href={item.href}
                          style={relatedItemStyle}
                          className="cocoa-focus-ring"
                          onMouseEnter={handleRelatedHover}
                          onMouseLeave={handleRelatedLeave}
                        >
                          {content}
                        </a>
                      </li>
                    );
                  }
                  return (
                    <li
                      key={`related-${item.screenId}`}
                      style={relatedItemStaticStyle}
                    >
                      {content}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      }
      default:
        return null;
    }
  };

  const triggerClassName = ["cocoa-focus-ring", className]
    .filter(Boolean)
    .join(" ");

  const sheetNode =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            style={backdropStyle}
            onMouseDown={handleBackdropClick}
            aria-hidden={false}
          >
            <aside
              ref={containerRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              tabIndex={-1}
              style={sheetBaseStyle}
              onKeyDown={handleContainerKeyDown}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div style={headerStyle}>
                <div style={{ minWidth: 0 }}>
                  <p style={eyebrowStyle}>Ayuda contextual</p>
                  <h2 id={titleId} style={titleStyle}>
                    {screenLabel}
                  </h2>
                </div>
                <button
                  type="button"
                  aria-label="Cerrar ayuda"
                  onClick={() => setOpen(false)}
                  onMouseEnter={handleCloseHover}
                  onMouseLeave={handleCloseLeave}
                  className="cocoa-focus-ring"
                  style={closeButtonStyle}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path
                      d="M1 1L13 13M13 1L1 13"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>

              <div
                role="tablist"
                aria-labelledby={tabsLabelId}
                style={tabsStyle}
                onKeyDown={handleTabsKeyDown}
              >
                <span id={tabsLabelId} style={{ display: "none" }}>
                  Secciones de la ayuda
                </span>
                {availableTabs.map((tab) => {
                  const isActive = tab.id === activeTab;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      aria-controls={`${panelId}-${tab.id}`}
                      id={`${panelId}-tab-${tab.id}`}
                      tabIndex={isActive ? 0 : -1}
                      className="cocoa-focus-ring"
                      style={getTabButtonStyle(isActive)}
                      onClick={() => setActiveTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>

              <div
                role="tabpanel"
                id={`${panelId}-${activeTab}`}
                aria-labelledby={`${panelId}-tab-${activeTab}`}
                style={bodyStyle}
              >
                {renderTabContent()}
              </div>

              <div style={footerStyle}>
                <span>¿Necesitas más? Visita el centro de ayuda.</span>
                <a
                  href={helpCenterUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={footerLinkStyle}
                  className="cocoa-focus-ring"
                >
                  Centro de ayuda
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path
                      d="M3 1H9V7M9 1L1 9"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      fill="none"
                    />
                  </svg>
                </a>
              </div>
            </aside>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Ayuda sobre ${screenLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={triggerClassName}
        style={triggerStyle}
        onClick={() => setOpen((prev) => !prev)}
        onMouseEnter={handleTriggerHover}
        onMouseLeave={handleTriggerLeave}
        data-screen-id={screenId}
      >
        <span aria-hidden="true">?</span>
      </button>
      {sheetNode}
    </>
  );
}

export default CocoaHelpButton;
