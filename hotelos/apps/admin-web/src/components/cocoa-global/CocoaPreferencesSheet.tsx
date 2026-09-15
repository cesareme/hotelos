// CocoaPreferencesSheet — NSPreferencesPanel-style modal sheet.
//
// Mimics the macOS System Preferences / Settings window: a fixed-size modal
// panel (720 x 540) centered on the viewport with a horizontal tab bar at
// the top. Each tab has an icon above a label, in the classic NSToolbar
// "icon + label" arrangement. Switching tabs swaps the body panel below.
//
// Only the Appearance tab is wired to the preferences API. The remaining
// tabs are placeholders with a «Próximamente» message.
//
// API contract:
//   GET    /users/me/preferences   ->  { themePreference, reducedMotion,
//                                        highContrast } (+ a legacy
//                                        `accentColor` that is ignored)
//   PATCH  /users/me/preferences   <-  partial of the same shape
//
// Real-time application: when the user changes any visual preference, the
// component immediately applies it to <html> (data-theme and the a11y
// data-* attributes) through the pure helpers of ./cocoa-preferences.ts —
// shared with CocoaGlobalProvider — so the whole window updates without a
// reload. Cocoa 22: there is no accent preference; the single accent is
// Esmeralda (`--cocoa-accent` in styles/cocoa-tokens.css).

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import CocoaSwitch from "../cocoa/CocoaSwitch";
import { apiRequest } from "../../services/api-client";
import {
  DEFAULT_COCOA_PREFERENCES,
  applyPreferencesToRoot,
  documentRoot,
  normalizePreferences,
  sanitizePreferencePatch,
  type CocoaPreferences,
  type CocoaThemePreference,
} from "./cocoa-preferences";

export interface CocoaPreferencesSheetProps {
  open: boolean;
  onClose: () => void;
}

type ThemePreference = CocoaThemePreference;
type UserPreferences = CocoaPreferences;

type TabId =
  | "general"
  | "appearance"
  | "notifications"
  | "privacy"
  | "advanced";

interface TabDescriptor {
  id: TabId;
  label: string;
  icon: ReactNode;
}

const PANEL_WIDTH = 720;
const PANEL_HEIGHT = 540;
const TAB_BAR_HEIGHT = 96;

const DEFAULT_PREFERENCES: UserPreferences = { ...DEFAULT_COCOA_PREFERENCES };

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
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  return nodes.filter((node) => {
    if (node.hasAttribute("disabled")) return false;
    if (node.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return true;
  });
}

// Tab bar icons — simple line-art SVGs in the Cocoa icon style. Each icon
// fills its host span with currentColor so the active state can recolor it.

function GeneralIcon(): ReactNode {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" />
    </svg>
  );
}

function AppearanceIcon(): ReactNode {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3a9 9 0 1 0 0 18 3 3 0 0 0 0-6h-1a2 2 0 0 1 0-4h2a4 4 0 0 0 4-4 4 4 0 0 0-5-4Z" />
      <circle cx="7.5" cy="10.5" r="1" fill="currentColor" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" />
      <circle cx="16.5" cy="10.5" r="1" fill="currentColor" />
    </svg>
  );
}

function NotificationsIcon(): ReactNode {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 8a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
      <path d="M10.5 20a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}

function PrivacyIcon(): ReactNode {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3Z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function AdvancedIcon(): ReactNode {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h14M18 18h2" />
      <circle cx="16" cy="6" r="2" fill="currentColor" />
      <circle cx="8" cy="12" r="2" fill="currentColor" />
      <circle cx="16" cy="18" r="2" fill="currentColor" />
    </svg>
  );
}

const TABS: TabDescriptor[] = [
  { id: "general", label: "General", icon: <GeneralIcon /> },
  { id: "appearance", label: "Apariencia", icon: <AppearanceIcon /> },
  { id: "notifications", label: "Notificaciones", icon: <NotificationsIcon /> },
  { id: "privacy", label: "Privacidad", icon: <PrivacyIcon /> },
  { id: "advanced", label: "Avanzado", icon: <AdvancedIcon /> },
];

// Apply visual preferences to the document root so the rest of the app
// picks them up via the data-* attributes (shared helpers; every apply also
// removes the legacy inline accent of older bundles).
function applyPreferences(prefs: UserPreferences): void {
  const root = documentRoot();
  if (root) applyPreferencesToRoot(root, prefs);
}

export function CocoaPreferencesSheet({
  open,
  onClose,
}: CocoaPreferencesSheetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [isMounted, setIsMounted] = useState<boolean>(open);
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<TabId>("appearance");
  const [preferences, setPreferences] = useState<UserPreferences>(
    DEFAULT_PREFERENCES,
  );
  const [loading, setLoading] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Mount + transition lifecycle: render after open=true and animate in
  // on the next frame; unmount after the exit transition has played.
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

  // Focus management: trap focus inside while open, restore on close.
  useEffect(() => {
    if (!isMounted) return undefined;
    previouslyFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? null;

    const root = containerRef.current;
    if (root) {
      const focusables = getFocusableElements(root);
      const first = focusables[0] ?? root;
      window.requestAnimationFrame(() => {
        first.focus({ preventScroll: true });
      });
    }

    return () => {
      const previous = previouslyFocusedRef.current;
      if (previous && typeof previous.focus === "function") {
        previous.focus({ preventScroll: true });
      }
    };
  }, [isMounted]);

  // Esc to close + body scroll lock while open.
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

  // Initial fetch of preferences whenever the sheet opens. We refetch on
  // every open so the displayed values stay in sync with server-side
  // changes made elsewhere (e.g. another device).
  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    apiRequest<unknown>("/users/me/preferences", {
      method: "GET",
      signal: controller.signal,
    })
      .then((data) => {
        if (cancelled) return;
        // The legacy `accentColor` of the payload is dropped here.
        const merged = normalizePreferences(data, DEFAULT_PREFERENCES);
        setPreferences(merged);
        // Apply on initial load so the displayed values match the active
        // window state — e.g. if the user reloads with stored prefs.
        applyPreferences(merged);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setLoadError(
          error instanceof Error ? error.message : "No se pudieron cargar las preferencias.",
        );
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open]);

  // Optimistic patch helper: applies the change to the UI immediately,
  // sends a PATCH, and rolls back on failure. Real-time visual updates
  // also fire here so the document picks up the new theme/accent/a11y
  // settings without waiting for the server round trip.
  const patchPreferences = useCallback(
    (rawPatch: Partial<UserPreferences>) => {
      const patch = sanitizePreferencePatch(rawPatch);
      if (Object.keys(patch).length === 0) return;
      setPreferences((prev) => {
        const next: UserPreferences = { ...prev, ...patch };
        applyPreferences(next);
        // Fire-and-forget PATCH with optimistic rollback.
        apiRequest<Partial<UserPreferences>>("/users/me/preferences", {
          method: "PATCH",
          body: patch,
        }).catch(() => {
          // On failure restore the previous values both in state and in
          // the document so the UI doesn't drift from the server.
          setPreferences(prev);
          applyPreferences(prev);
        });
        return next;
      });
    },
    [],
  );

  const handleBackdropClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    },
    [onClose],
  );

  // Tab key cycles within the sheet; arrow keys navigate the tab bar when
  // focus is on one of the tab buttons.
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
    [],
  );

  const handleTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const nextIndex = (index + direction + TABS.length) % TABS.length;
      setActiveTab(TABS[nextIndex].id);
    },
    [],
  );

  const backdropStyle = useMemo<CSSProperties>(
    () => ({
      position: "fixed",
      inset: 0,
      zIndex: "var(--cocoa-z-sheet)" as CSSProperties["zIndex"],
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "var(--cocoa-scrim)",
      backdropFilter: "var(--cocoa-scrim-blur)",
      WebkitBackdropFilter: "var(--cocoa-scrim-blur)",
      opacity: isVisible ? 1 : 0,
      transition:
        "opacity var(--cocoa-duration-slow) var(--cocoa-ease-out)",
      pointerEvents: isVisible ? "auto" : "none",
    }),
    [isVisible],
  );

  const containerStyle = useMemo<CSSProperties>(
    () => ({
      position: "relative",
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      maxWidth: "calc(100vw - 32px)",
      maxHeight: "calc(100vh - 32px)",
      display: "flex",
      flexDirection: "column",
      background: "var(--cocoa-background-content)",
      boxShadow: "var(--cocoa-shadow-modal)",
      borderRadius: "var(--cocoa-radius-lg)",
      transform: isVisible ? "scale(1)" : "scale(0.96)",
      opacity: isVisible ? 1 : 0,
      transition:
        "transform var(--cocoa-duration-slow) var(--cocoa-ease-out), opacity var(--cocoa-duration-slow) var(--cocoa-ease-out)",
      outline: "none",
      fontFamily: "var(--cocoa-font)",
      color: "var(--cocoa-label)",
      overflow: "hidden",
    }),
    [isVisible],
  );

  const tabBarStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      alignItems: "stretch",
      justifyContent: "center",
      gap: 4,
      height: TAB_BAR_HEIGHT,
      padding: "12px 16px",
      background:
        "color-mix(in srgb, var(--cocoa-background-window) 80%, transparent)",
      borderBottom: "1px solid var(--cocoa-separator)",
      flexShrink: 0,
    }),
    [],
  );

  const bodyStyle = useMemo<CSSProperties>(
    () => ({
      flex: 1,
      minHeight: 0,
      overflow: "auto",
      padding: "24px 32px",
    }),
    [],
  );

  const closeButtonStyle = useMemo<CSSProperties>(
    () => ({
      position: "absolute",
      top: 12,
      left: 12,
      width: 14,
      height: 14,
      borderRadius: "var(--cocoa-radius-full)",
      background: "var(--cocoa-danger)",
      border: "1px solid color-mix(in srgb, var(--cocoa-danger) 70%, var(--cocoa-label))",
      cursor: "pointer",
      padding: 0,
      WebkitTapHighlightColor: "transparent",
      zIndex: 1,
    }),
    [],
  );

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
        aria-label="Preferencias"
        tabIndex={-1}
        style={containerStyle}
        onKeyDown={handleContainerKeyDown}
      >
        <button
          type="button"
          aria-label="Cerrar preferencias"
          className="cocoa-focus-ring"
          onClick={onClose}
          style={closeButtonStyle}
        />
        <div role="tablist" aria-label="Secciones de preferencias" style={tabBarStyle}>
          {TABS.map((tab, index) => (
            <TabButton
              key={tab.id}
              tab={tab}
              active={activeTab === tab.id}
              onSelect={() => setActiveTab(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            />
          ))}
        </div>
        <div style={bodyStyle}>
          {activeTab === "appearance" ? (
            <AppearancePanel
              preferences={preferences}
              loading={loading}
              loadError={loadError}
              onPatch={patchPreferences}
            />
          ) : (
            <PlaceholderPanel tab={activeTab} />
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

interface TabButtonProps {
  tab: TabDescriptor;
  active: boolean;
  onSelect: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

function TabButton({ tab, active, onSelect, onKeyDown }: TabButtonProps) {
  const style: CSSProperties = {
    display: "inline-flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    width: 84,
    padding: "8px 6px",
    border: "1px solid transparent",
    borderRadius: "var(--cocoa-radius-md)",
    background: active ? "var(--cocoa-background-control)" : "transparent",
    color: active ? "var(--cocoa-accent)" : "var(--cocoa-label-secondary)",
    cursor: active ? "default" : "pointer",
    fontFamily: "inherit",
    fontSize: "var(--cocoa-fs-caption-1)",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    letterSpacing: "var(--cocoa-tracking-tight)",
    transition:
      "background var(--cocoa-duration-fast) var(--cocoa-ease-out), color var(--cocoa-duration-fast) var(--cocoa-ease-out)",
  };

  const iconWrap: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
  };

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className="cocoa-focus-ring"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      style={style}
    >
      <span style={iconWrap} aria-hidden="true">
        {tab.icon}
      </span>
      <span>{tab.label}</span>
    </button>
  );
}

interface AppearancePanelProps {
  preferences: UserPreferences;
  loading: boolean;
  loadError: string | null;
  onPatch: (patch: Partial<UserPreferences>) => void;
}

function AppearancePanel({
  preferences,
  loading,
  loadError,
  onPatch,
}: AppearancePanelProps) {
  const sectionStyle: CSSProperties = {
    marginBottom: 28,
  };

  const sectionTitleStyle: CSSProperties = {
    margin: "0 0 12px 0",
    fontSize: "var(--cocoa-fs-headline)",
    fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
    letterSpacing: "var(--cocoa-tracking-tight)",
    color: "var(--cocoa-label)",
    lineHeight: 1.2,
  };

  const radioGroupStyle: CSSProperties = {
    display: "flex",
    gap: 12,
  };

  const switchRowStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  };

  const errorStyle: CSSProperties = {
    margin: "0 0 16px 0",
    padding: "8px 12px",
    borderRadius: "var(--cocoa-radius-md)",
    background: "var(--cocoa-danger-bg)",
    border: "1px solid var(--cocoa-danger-border)",
    color: "var(--cocoa-danger-ink)",
    fontSize: "var(--cocoa-fs-subheadline)",
  };

  if (loading) {
    return (
      <div
        role="status"
        aria-busy="true"
        style={{
          padding: 24,
          color: "var(--cocoa-label-secondary)",
          fontSize: "var(--cocoa-fs-body)",
        }}
      >
        Cargando preferencias…
      </div>
    );
  }

  return (
    <div>
      {loadError ? <div style={errorStyle}>{loadError}</div> : null}

      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>Tema</h3>
        <div
          role="radiogroup"
          aria-label="Tema"
          style={radioGroupStyle}
        >
          <ThemeRadioOption
            value="light"
            label="Claro"
            current={preferences.themePreference}
            onSelect={(value) => onPatch({ themePreference: value })}
          />
          <ThemeRadioOption
            value="dark"
            label="Oscuro"
            current={preferences.themePreference}
            onSelect={(value) => onPatch({ themePreference: value })}
          />
          <ThemeRadioOption
            value="auto"
            label="Automático"
            current={preferences.themePreference}
            onSelect={(value) => onPatch({ themePreference: value })}
          />
        </div>
      </section>

      <section style={{ ...sectionStyle, marginBottom: 0 }}>
        <h3 style={sectionTitleStyle}>Accesibilidad</h3>
        <div style={switchRowStyle}>
          <CocoaSwitch
            checked={preferences.reducedMotion}
            onChange={(value) => onPatch({ reducedMotion: value })}
            label="Reducir movimiento"
          />
          <CocoaSwitch
            checked={preferences.highContrast}
            onChange={(value) => onPatch({ highContrast: value })}
            label="Alto contraste"
          />
        </div>
      </section>
    </div>
  );
}

interface ThemeRadioOptionProps {
  value: ThemePreference;
  label: string;
  current: ThemePreference;
  onSelect: (value: ThemePreference) => void;
}

function ThemeRadioOption({
  value,
  label,
  current,
  onSelect,
}: ThemeRadioOptionProps) {
  const selected = current === value;

  const wrapperStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    border: selected
      ? "1px solid var(--cocoa-accent)"
      : "1px solid var(--cocoa-separator)",
    background: selected
      ? "color-mix(in srgb, var(--cocoa-accent) 10%, transparent)"
      : "var(--cocoa-background-control)",
    borderRadius: "var(--cocoa-radius-md)",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: "var(--cocoa-fs-body)",
    color: "var(--cocoa-label)",
    transition:
      "background var(--cocoa-duration-fast) var(--cocoa-ease-out), border-color var(--cocoa-duration-fast) var(--cocoa-ease-out)",
  };

  const dotStyle: CSSProperties = {
    width: 14,
    height: 14,
    borderRadius: "50%",
    border: selected
      ? "4px solid var(--cocoa-accent)"
      : "1px solid var(--cocoa-separator)",
    background: selected ? "var(--cocoa-background-content)" : "transparent",
    boxSizing: "border-box",
    flexShrink: 0,
  };

  return (
    <label style={wrapperStyle}>
      <input
        type="radio"
        name="cocoa-theme-preference"
        value={value}
        checked={selected}
        onChange={() => onSelect(value)}
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0,0,0,0)",
          border: 0,
        }}
      />
      <span aria-hidden="true" style={dotStyle} />
      <span>{label}</span>
    </label>
  );
}

interface PlaceholderPanelProps {
  tab: TabId;
}

function PlaceholderPanel({ tab }: PlaceholderPanelProps) {
  const TITLES: Record<TabId, string> = {
    general: "General",
    appearance: "Apariencia",
    notifications: "Notificaciones",
    privacy: "Privacidad",
    advanced: "Avanzado",
  };

  const wrapperStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    gap: 8,
    color: "var(--cocoa-label-secondary)",
    textAlign: "center",
  };

  const titleStyle: CSSProperties = {
    margin: 0,
    fontSize: "var(--cocoa-fs-title-3)",
    fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
    color: "var(--cocoa-label)",
  };

  const bodyTextStyle: CSSProperties = {
    margin: 0,
    fontSize: "var(--cocoa-fs-body)",
    color: "var(--cocoa-label-secondary)",
  };

  return (
    <div style={wrapperStyle}>
      <h3 style={titleStyle}>{TITLES[tab]}</h3>
      <p style={bodyTextStyle}>Próximamente</p>
    </div>
  );
}

export default CocoaPreferencesSheet;
