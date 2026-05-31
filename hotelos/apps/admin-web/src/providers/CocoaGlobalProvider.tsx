// CocoaGlobalProvider — central orchestrator for all "global" Cocoa overlays.
//
// Mounts the four singleton surfaces (command palette, preferences sheet,
// notification center, keyboard shortcuts help, about dialog) exactly once at
// the top of the React tree and exposes a stable, hook-based API so any screen
// can open them, push notifications, register commands, or hook keyboard
// shortcuts without prop-drilling.
//
// API surface (all hooks throw outside the provider):
//   useCocoaCommandPalette() -> { open, register(item) => unregister }
//   useCocoaNotifications()  -> { items, push, markAllRead, openCenter }
//   useCocoaPreferences()    -> { prefs, update(partial) => Promise, openSheet }
//   useCocoaShortcuts()      -> { openHelp, register(combo, handler) => off }
//   useCocoaAbout()          -> { open }
//
// Global key listeners:
//   Cmd/Ctrl+K  -> open command palette
//   Cmd/Ctrl+/  -> open keyboard shortcuts help
//   Cmd/Ctrl+,  -> open preferences sheet
//
// On mount the provider GETs /users/me/preferences and applies the response to
// <html> via data-theme + the same CSS custom properties used by
// CocoaPreferencesSheet, so the active window matches the user's stored prefs
// even before they open the sheet for the first time.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  CocoaAboutDialog,
  CocoaCommandPalette,
  CocoaKeyboardShortcutsHelp,
  CocoaNotificationCenter,
  CocoaPreferencesSheet,
  type CocoaCommandPaletteItem,
  type CocoaNotification,
} from "../components/cocoa-global";
import { apiRequest } from "../services/api-client";

// ---------------------------------------------------------------------------
// Preference shape — mirrors the CocoaPreferencesSheet contract so consumers
// can read & update from anywhere without importing the sheet itself.
// ---------------------------------------------------------------------------
export type CocoaThemePreference = "light" | "dark" | "auto";

export interface CocoaPreferences {
  themePreference: CocoaThemePreference;
  accentColor: string;
  reducedMotion: boolean;
  highContrast: boolean;
}

const DEFAULT_PREFERENCES: CocoaPreferences = {
  themePreference: "auto",
  accentColor: "#007aff",
  reducedMotion: false,
  highContrast: false,
};

// ---------------------------------------------------------------------------
// Notification input type — slimmer than CocoaNotification so callers don't
// have to mint an id or timestamp themselves. We fill those in inside push().
// ---------------------------------------------------------------------------
export type CocoaNotificationInput = Omit<CocoaNotification, "id" | "timestamp"> & {
  id?: string;
  timestamp?: string;
};

// ---------------------------------------------------------------------------
// Context shapes — one context per concern keeps re-renders narrow: pushing a
// notification doesn't re-render screens that only listen for the command
// palette open() handle, and vice versa.
// ---------------------------------------------------------------------------
interface CommandPaletteContextValue {
  open: () => void;
  register: (item: CocoaCommandPaletteItem) => () => void;
}

interface NotificationsContextValue {
  items: CocoaNotification[];
  push: (n: CocoaNotificationInput) => void;
  markAllRead: () => void;
  openCenter: () => void;
}

interface PreferencesContextValue {
  prefs: CocoaPreferences;
  update: (partial: Partial<CocoaPreferences>) => Promise<void>;
  openSheet: () => void;
}

interface ShortcutsContextValue {
  openHelp: () => void;
  register: (combo: string, handler: (event: KeyboardEvent) => void) => () => void;
}

interface AboutContextValue {
  open: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);
const NotificationsContext = createContext<NotificationsContextValue | null>(null);
const PreferencesContext = createContext<PreferencesContextValue | null>(null);
const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);
const AboutContext = createContext<AboutContextValue | null>(null);

// ---------------------------------------------------------------------------
// Document-level helpers — duplicated (intentionally) from
// CocoaPreferencesSheet so the provider can apply prefs at mount without
// depending on the sheet being rendered. Both call sites converge on the same
// CSS custom properties and data-* attributes, so the effect is identical.
// ---------------------------------------------------------------------------
function applyThemePreference(value: CocoaThemePreference): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", value);
}

function applyAccentColor(color: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("--cocoa-accent", color);
}

function applyReducedMotion(enabled: boolean): void {
  if (typeof document === "undefined") return;
  if (enabled) {
    document.documentElement.setAttribute("data-reduced-motion", "true");
  } else {
    document.documentElement.removeAttribute("data-reduced-motion");
  }
}

function applyHighContrast(enabled: boolean): void {
  if (typeof document === "undefined") return;
  if (enabled) {
    document.documentElement.setAttribute("data-high-contrast", "true");
  } else {
    document.documentElement.removeAttribute("data-high-contrast");
  }
}

function applyAllPreferences(prefs: CocoaPreferences): void {
  applyThemePreference(prefs.themePreference);
  applyAccentColor(prefs.accentColor);
  applyReducedMotion(prefs.reducedMotion);
  applyHighContrast(prefs.highContrast);
}

// ---------------------------------------------------------------------------
// Shortcut combo parser. Accepts strings like "Cmd+K", "Ctrl+Shift+P", "?".
// "Cmd" or "Meta" both map to event.metaKey; "Mod" matches metaKey OR ctrlKey
// so callers can write platform-agnostic combos.
// ---------------------------------------------------------------------------
interface ParsedCombo {
  key: string;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  mod: boolean; // platform-agnostic Cmd/Ctrl
}

function parseCombo(combo: string): ParsedCombo {
  const parts = combo
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  let meta = false;
  let ctrl = false;
  let shift = false;
  let alt = false;
  let mod = false;
  let key = "";
  for (const raw of parts) {
    const token = raw.toLowerCase();
    if (token === "cmd" || token === "meta" || token === "command") meta = true;
    else if (token === "ctrl" || token === "control") ctrl = true;
    else if (token === "shift") shift = true;
    else if (token === "alt" || token === "option" || token === "opt") alt = true;
    else if (token === "mod") mod = true;
    else key = token;
  }
  return { key, meta, ctrl, shift, alt, mod };
}

function eventMatchesCombo(event: KeyboardEvent, combo: ParsedCombo): boolean {
  const eventKey = event.key.toLowerCase();
  if (combo.key && eventKey !== combo.key) return false;
  if (combo.mod) {
    if (!(event.metaKey || event.ctrlKey)) return false;
  } else {
    if (combo.meta !== event.metaKey) return false;
    if (combo.ctrl !== event.ctrlKey) return false;
  }
  if (combo.shift !== event.shiftKey) return false;
  if (combo.alt !== event.altKey) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Default command palette items. Each entry dispatches a `hotelos-nav`
// CustomEvent — the same channel App.tsx already listens on for routing — so
// the provider doesn't need to know the screen graph or import App.tsx.
// Entries for Preferences / Help / About open the corresponding overlay
// directly via the bound handler injected at render time.
// ---------------------------------------------------------------------------
function navigateTo(screen: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>("hotelos-nav", { detail: screen }));
}

interface DefaultCommandBindings {
  openPreferences: () => void;
  openShortcuts: () => void;
  openAbout: () => void;
}

function buildDefaultCommands(bindings: DefaultCommandBindings): CocoaCommandPaletteItem[] {
  return [
    {
      id: "nav.reservations",
      label: "Reservaciones",
      category: "Navegacion",
      onSelect: () => navigateTo("ReservationWorkspaceScreen"),
    },
    {
      id: "nav.frontdesk",
      label: "Front desk",
      category: "Navegacion",
      onSelect: () => navigateTo("FrontDeskDashboard"),
    },
    {
      id: "nav.groups",
      label: "Grupos",
      category: "Navegacion",
      onSelect: () => navigateTo("GroupsCalendarScreen"),
    },
    {
      id: "nav.allotments",
      label: "Allotments",
      category: "Navegacion",
      onSelect: () => navigateTo("AllotmentsScreen"),
    },
    {
      id: "nav.rates",
      label: "Tarifas",
      category: "Navegacion",
      onSelect: () => navigateTo("RatePlansScreen"),
    },
    {
      id: "nav.compliance",
      label: "Compliance",
      category: "Navegacion",
      onSelect: () => navigateTo("ComplianceCenterScreen"),
    },
    {
      id: "nav.setup",
      label: "Setup",
      category: "Navegacion",
      onSelect: () => navigateTo("SetupCenterScreen"),
    },
    {
      id: "global.preferences",
      label: "Preferences",
      category: "Sistema",
      shortcut: "⌘,",
      onSelect: bindings.openPreferences,
    },
    {
      id: "global.shortcuts",
      label: "Help shortcuts",
      category: "Sistema",
      shortcut: "⌘/",
      onSelect: bindings.openShortcuts,
    },
    {
      id: "global.about",
      label: "About",
      category: "Sistema",
      onSelect: bindings.openAbout,
    },
  ];
}

// ---------------------------------------------------------------------------
// Provider implementation.
// ---------------------------------------------------------------------------
export interface CocoaGlobalProviderProps {
  children: ReactNode;
}

export function CocoaGlobalProvider({ children }: CocoaGlobalProviderProps) {
  // Overlay open/close state — each overlay is independent so opening one
  // doesn't dismiss another (e.g. About opened from the palette while the
  // palette is closing).
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  const [preferencesOpen, setPreferencesOpen] = useState<boolean>(false);
  const [notificationsOpen, setNotificationsOpen] = useState<boolean>(false);
  const [shortcutsOpen, setShortcutsOpen] = useState<boolean>(false);
  const [aboutOpen, setAboutOpen] = useState<boolean>(false);

  // Command palette registry — externally registered items are appended to the
  // built-in defaults at render time. We key by id so the same id replaces
  // rather than duplicates, which lets screens re-register on remount.
  const [extraCommands, setExtraCommands] = useState<CocoaCommandPaletteItem[]>([]);
  const registerCommand = useCallback(
    (item: CocoaCommandPaletteItem): (() => void) => {
      setExtraCommands((prev) => {
        const filtered = prev.filter((existing) => existing.id !== item.id);
        return [...filtered, item];
      });
      return () => {
        setExtraCommands((prev) => prev.filter((existing) => existing.id !== item.id));
      };
    },
    [],
  );

  // Notification store — newest first so the center renders chronological
  // ordering even before its own bucket sort runs.
  const [notifications, setNotifications] = useState<CocoaNotification[]>([]);
  const notificationIdCounterRef = useRef<number>(0);
  const pushNotification = useCallback((input: CocoaNotificationInput) => {
    setNotifications((prev) => {
      notificationIdCounterRef.current += 1;
      const id = input.id ?? `notif-${Date.now()}-${notificationIdCounterRef.current}`;
      const timestamp = input.timestamp ?? new Date().toISOString();
      const record: CocoaNotification = {
        id,
        title: input.title,
        message: input.message,
        type: input.type,
        timestamp,
        read: input.read ?? false,
        actions: input.actions,
      };
      // Deduplicate by id so callers can safely re-push with the same id to
      // update an existing notification without producing a phantom copy.
      const filtered = prev.filter((existing) => existing.id !== id);
      return [record, ...filtered];
    });
  }, []);
  const markAllNotificationsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => (n.read ? n : { ...n, read: true })));
  }, []);

  // Preferences store — applies any change to <html> immediately and rolls
  // back on failure, mirroring the CocoaPreferencesSheet semantics so both
  // entry points share the same UX guarantees.
  const [preferences, setPreferences] = useState<CocoaPreferences>(DEFAULT_PREFERENCES);
  const updatePreferences = useCallback(
    async (partial: Partial<CocoaPreferences>): Promise<void> => {
      let previous: CocoaPreferences = DEFAULT_PREFERENCES;
      setPreferences((prev) => {
        previous = prev;
        const next: CocoaPreferences = { ...prev, ...partial };
        applyAllPreferences(next);
        return next;
      });
      try {
        await apiRequest<Partial<CocoaPreferences>>("/users/me/preferences", {
          method: "PATCH",
          body: partial,
        });
      } catch (error) {
        // Roll back local state + applied document attributes so the UI stays
        // truthful when the server rejects the change.
        setPreferences(previous);
        applyAllPreferences(previous);
        throw error;
      }
    },
    [],
  );

  // Initial preference load — fetch once at mount and apply to <html>. Errors
  // are swallowed so a failing endpoint doesn't block the app from rendering;
  // the user can still open the sheet and retry, and the document falls back
  // to the default tokens.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    apiRequest<Partial<CocoaPreferences>>("/users/me/preferences", {
      method: "GET",
      signal: controller.signal,
    })
      .then((data) => {
        if (cancelled) return;
        const merged: CocoaPreferences = {
          themePreference: data.themePreference ?? DEFAULT_PREFERENCES.themePreference,
          accentColor: data.accentColor ?? DEFAULT_PREFERENCES.accentColor,
          reducedMotion: data.reducedMotion ?? DEFAULT_PREFERENCES.reducedMotion,
          highContrast: data.highContrast ?? DEFAULT_PREFERENCES.highContrast,
        };
        setPreferences(merged);
        applyAllPreferences(merged);
      })
      .catch(() => {
        // Intentionally silent — keep defaults so the app still renders.
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  // External shortcut registry — combos are matched against keydown events
  // in document-capture order. We use a ref so handlers fire without
  // triggering re-renders when the set of registrations changes.
  const shortcutRegistryRef = useRef<
    Array<{ combo: ParsedCombo; handler: (event: KeyboardEvent) => void }>
  >([]);
  const registerShortcut = useCallback(
    (combo: string, handler: (event: KeyboardEvent) => void): (() => void) => {
      const parsed = parseCombo(combo);
      const entry = { combo: parsed, handler };
      shortcutRegistryRef.current.push(entry);
      return () => {
        shortcutRegistryRef.current = shortcutRegistryRef.current.filter(
          (existing) => existing !== entry,
        );
      };
    },
    [],
  );

  // Open helpers — split out so we can pass them to the default command items
  // before the context values themselves exist (avoids a forward-ref cycle).
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openPreferences = useCallback(() => setPreferencesOpen(true), []);
  const closePreferences = useCallback(() => setPreferencesOpen(false), []);
  const openNotifications = useCallback(() => setNotificationsOpen(true), []);
  const closeNotifications = useCallback(() => setNotificationsOpen(false), []);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), []);
  const openAbout = useCallback(() => setAboutOpen(true), []);
  const closeAbout = useCallback(() => setAboutOpen(false), []);

  // Global keydown listener: built-in shortcuts run first, then we walk the
  // external registry. The built-ins call preventDefault so the browser
  // doesn't open its own Cmd+K / Cmd+, dialogs.
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "k") {
          event.preventDefault();
          openPalette();
          return;
        }
        if (key === "/") {
          event.preventDefault();
          openShortcuts();
          return;
        }
        if (key === ",") {
          event.preventDefault();
          openPreferences();
          return;
        }
      }
      // External shortcuts — run handlers in registration order. Iterating a
      // copy guards against handlers that unregister themselves mid-loop.
      const snapshot = shortcutRegistryRef.current.slice();
      for (const entry of snapshot) {
        if (eventMatchesCombo(event, entry.combo)) {
          entry.handler(event);
        }
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [openPalette, openShortcuts, openPreferences]);

  // Merge default + externally-registered commands for the palette. Defaults
  // come first so the navigation entries always appear at the top of the
  // unfiltered list, matching the spec.
  const paletteItems = useMemo<CocoaCommandPaletteItem[]>(() => {
    const defaults = buildDefaultCommands({
      openPreferences,
      openShortcuts,
      openAbout,
    });
    return [...defaults, ...extraCommands];
  }, [extraCommands, openPreferences, openShortcuts, openAbout]);

  // Context values — memoized so consumers that read a single context don't
  // re-render when an unrelated piece of state changes.
  const commandPaletteValue = useMemo<CommandPaletteContextValue>(
    () => ({ open: openPalette, register: registerCommand }),
    [openPalette, registerCommand],
  );
  const notificationsValue = useMemo<NotificationsContextValue>(
    () => ({
      items: notifications,
      push: pushNotification,
      markAllRead: markAllNotificationsRead,
      openCenter: openNotifications,
    }),
    [notifications, pushNotification, markAllNotificationsRead, openNotifications],
  );
  const preferencesValue = useMemo<PreferencesContextValue>(
    () => ({
      prefs: preferences,
      update: updatePreferences,
      openSheet: openPreferences,
    }),
    [preferences, updatePreferences, openPreferences],
  );
  const shortcutsValue = useMemo<ShortcutsContextValue>(
    () => ({ openHelp: openShortcuts, register: registerShortcut }),
    [openShortcuts, registerShortcut],
  );
  const aboutValue = useMemo<AboutContextValue>(
    () => ({ open: openAbout }),
    [openAbout],
  );

  return (
    <CommandPaletteContext.Provider value={commandPaletteValue}>
      <NotificationsContext.Provider value={notificationsValue}>
        <PreferencesContext.Provider value={preferencesValue}>
          <ShortcutsContext.Provider value={shortcutsValue}>
            <AboutContext.Provider value={aboutValue}>
              {children}
              <CocoaCommandPalette
                open={paletteOpen}
                onClose={closePalette}
                items={paletteItems}
              />
              <CocoaPreferencesSheet
                open={preferencesOpen}
                onClose={closePreferences}
              />
              <CocoaNotificationCenter
                open={notificationsOpen}
                onClose={closeNotifications}
                notifications={notifications}
                onMarkAllAsRead={markAllNotificationsRead}
              />
              <CocoaKeyboardShortcutsHelp
                open={shortcutsOpen}
                onClose={closeShortcuts}
                onRequestOpen={openShortcuts}
              />
              <CocoaAboutDialog open={aboutOpen} onClose={closeAbout} />
            </AboutContext.Provider>
          </ShortcutsContext.Provider>
        </PreferencesContext.Provider>
      </NotificationsContext.Provider>
    </CommandPaletteContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks — one per surface so consumers depend only on what they use. Each
// hook throws when called outside the provider, matching the convention used
// by ToastProvider/useToast elsewhere in the app.
// ---------------------------------------------------------------------------
export function useCocoaCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) {
    throw new Error("useCocoaCommandPalette must be used within <CocoaGlobalProvider>");
  }
  return ctx;
}

export function useCocoaNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) {
    throw new Error("useCocoaNotifications must be used within <CocoaGlobalProvider>");
  }
  return ctx;
}

export function useCocoaPreferences(): PreferencesContextValue {
  const ctx = useContext(PreferencesContext);
  if (!ctx) {
    throw new Error("useCocoaPreferences must be used within <CocoaGlobalProvider>");
  }
  return ctx;
}

export function useCocoaShortcuts(): ShortcutsContextValue {
  const ctx = useContext(ShortcutsContext);
  if (!ctx) {
    throw new Error("useCocoaShortcuts must be used within <CocoaGlobalProvider>");
  }
  return ctx;
}

export function useCocoaAbout(): AboutContextValue {
  const ctx = useContext(AboutContext);
  if (!ctx) {
    throw new Error("useCocoaAbout must be used within <CocoaGlobalProvider>");
  }
  return ctx;
}

export default CocoaGlobalProvider;
