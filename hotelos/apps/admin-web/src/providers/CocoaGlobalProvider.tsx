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
//   useCocoaNotifications()  -> { items, unreadCount, push, markAllRead, markRead, refresh, openCenter }
//                               (items = GET /notifications of the session user + local pushes)
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
// <html> (data-theme, data-reduced-motion, data-high-contrast) through the
// same pure helpers CocoaPreferencesSheet uses (components/cocoa-global/
// cocoa-preferences.ts), so the active window matches the user's stored prefs
// even before they open the sheet for the first time. Cocoa 22: the accent is
// no longer a preference — the legacy `accentColor` of the API is ignored and
// the inline `--cocoa-accent` older bundles wrote on <html> is removed.

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
import {
  DEFAULT_COCOA_PREFERENCES,
  applyPreferencesToRoot,
  clearLegacyAccentOverride,
  documentRoot,
  normalizePreferences,
  sanitizePreferencePatch,
  type CocoaPreferences,
  type CocoaThemePreference,
} from "../components/cocoa-global/cocoa-preferences";
import { apiRequest } from "../services/api-client";
import { getToken, onAuthChange } from "../services/auth-storage";
import { listNotifications, markNotificationRead, type NotificationRecord } from "../services/notificationsApi";
import { navigateTo } from "../lib/navigate";
import { openHelpCenter } from "../components/guide/guideStore";
import { BRAND } from "../config/brand";

// ---------------------------------------------------------------------------
// Preference shape — shared with CocoaPreferencesSheet through
// cocoa-preferences.ts so consumers can read & update from anywhere without
// importing the sheet itself. No `accentColor` (Cocoa 22).
// ---------------------------------------------------------------------------
export type { CocoaPreferences, CocoaThemePreference };

const DEFAULT_PREFERENCES: CocoaPreferences = { ...DEFAULT_COCOA_PREFERENCES };

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
  unreadCount: number;
  /** Loading/error line of the server feed (null when idle). */
  status: string | null;
  push: (n: CocoaNotificationInput) => void;
  markAllRead: () => void;
  markRead: (id: string) => void;
  /** Re-fetch GET /notifications (the bell calls it when the center opens). */
  refresh: () => void;
  openCenter: () => void;
}

/** Event any screen can dispatch to open the notification center (toolbar bell, ⌘K). */
export const OPEN_NOTIFICATIONS_EVENT = "hotelos-open-notifications";

// Server notification types → Cocoa severities.
const NOTIFICATION_TYPE_MAP: Record<string, CocoaNotification["type"]> = {
  compliance: "warning",
  maintenance: "warning",
  guest_message: "info",
  payment: "success",
  system: "info",
};

function fromServerRecord(record: NotificationRecord): CocoaNotification {
  return {
    id: record.id,
    title: record.title,
    message: record.body,
    type: NOTIFICATION_TYPE_MAP[record.type] ?? "info",
    timestamp: record.createdAt,
    read: record.status === "read",
  };
}

// Poll cadence of the server feed while a session exists and the tab is visible.
const NOTIFICATIONS_POLL_MS = 60_000;

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
// Document-level application — the pure helpers of cocoa-preferences.ts
// (shared with CocoaPreferencesSheet) so both call sites converge on the same
// data-* attributes; every apply also clears the legacy inline accent.
// ---------------------------------------------------------------------------
function applyAllPreferences(prefs: CocoaPreferences): void {
  const root = documentRoot();
  if (root) applyPreferencesToRoot(root, prefs);
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
// CustomEvent through the typed `navigateTo` helper (lib/navigate.ts) — the
// same channel App.tsx already listens on for routing — so the provider only
// depends on the ScreenKey type, never on the screen graph itself.
// Entries for Preferences / Help / About open the corresponding overlay
// directly via the bound handler injected at render time.
// ---------------------------------------------------------------------------
interface DefaultCommandBindings {
  openPreferences: () => void;
  openShortcuts: () => void;
  openAbout: () => void;
}

function buildDefaultCommands(bindings: DefaultCommandBindings): CocoaCommandPaletteItem[] {
  return [
    { id: "nav.today", label: "Mi día", category: "Navegación", onSelect: () => navigateTo("FrontDeskDashboard") },
    { id: "nav.reservations", label: "Reservas", category: "Navegación", onSelect: () => navigateTo("ReservationWorkspace") },
    { id: "nav.reservation-create", label: "Nueva reserva", category: "Navegación", onSelect: () => navigateTo("ReservationCreate") },
    { id: "nav.reservation-import", label: "Importar reservas", category: "Navegación", onSelect: () => navigateTo("ReservationImportScreen") },
    { id: "nav.sage200-import", label: "Importar desde Sage 200", category: "Navegación", onSelect: () => navigateTo("Sage200ImportScreen") },
    { id: "nav.guests", label: "Huéspedes", category: "Navegación", onSelect: () => navigateTo("GuestsList") },
    { id: "nav.groups", label: "Grupos y eventos", category: "Navegación", onSelect: () => navigateTo("GroupsEventsDashboard") },
    { id: "nav.rates", label: "Planes de tarifas", category: "Navegación", onSelect: () => navigateTo("RatePlans") },
    { id: "nav.compliance", label: "Bandeja de cumplimiento", category: "Navegación", onSelect: () => navigateTo("ComplianceInbox") },
    { id: "nav.setup", label: "Puesta en marcha", category: "Navegación", onSelect: () => navigateTo("SetupCenterScreen") },
    { id: "global.help", label: "Centro de ayuda", category: "Sistema", onSelect: () => openHelpCenter() },
    { id: "global.shortcuts", label: "Atajos de teclado", category: "Sistema", shortcut: "⌘/", onSelect: bindings.openShortcuts },
    { id: "global.preferences", label: "Preferencias", category: "Sistema", shortcut: "⌘,", onSelect: bindings.openPreferences },
    { id: "global.about", label: `Acerca de ${BRAND.name}`, category: "Sistema", onSelect: bindings.openAbout },
  ];
}

// ---------------------------------------------------------------------------
// Provider implementation.
// ---------------------------------------------------------------------------
export interface CocoaGlobalProviderProps {
  children: ReactNode;
  /**
   * Bind ⌘K / Ctrl+K to the Cocoa command palette (default true). The
   * back-office shell has its own CommandPalette (screens + live search
   * hits) on the same shortcut: with both bound, ⌘K opened TWO stacked
   * palettes and Enter picked the first item of this one («Reservaciones»).
   * App.tsx passes false so only the shell's palette answers the shortcut;
   * this palette stays reachable through `useCocoaCommandPalette().open()`.
   */
  commandPaletteHotkey?: boolean;
}

export function CocoaGlobalProvider({ children, commandPaletteHotkey = true }: CocoaGlobalProviderProps) {
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
  // ordering even before its own bucket sort runs. Two sources: local pushes
  // (`push`, kept in memory) and the session user's server feed
  // (GET /notifications, ids tracked in `serverIdsRef` so read marks are
  // POSTed back). The feed is fetched once a session exists and polled while
  // the tab is visible.
  const [notifications, setNotifications] = useState<CocoaNotification[]>([]);
  const [notificationsStatus, setNotificationsStatus] = useState<string | null>(null);
  const notificationIdCounterRef = useRef<number>(0);
  const serverIdsRef = useRef<Set<string>>(new Set());
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
  const refreshNotifications = useCallback(() => {
    if (!getToken()) return;
    setNotificationsStatus("Cargando…");
    listNotifications()
      .then((records) => {
        const serverItems = records.map(fromServerRecord);
        serverIdsRef.current = new Set(serverItems.map((item) => item.id));
        setNotifications((prev) => {
          const local = prev.filter((item) => !serverIdsRef.current.has(item.id) && !records.some((record) => record.id === item.id));
          return [...serverItems, ...local];
        });
        setNotificationsStatus(null);
      })
      .catch((error: unknown) => {
        setNotificationsStatus(error instanceof Error ? `No se pudieron cargar los avisos: ${error.message}` : "No se pudieron cargar los avisos.");
      });
  }, []);
  const markNotificationReadLocal = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id && !n.read ? { ...n, read: true } : n)));
    if (serverIdsRef.current.has(id)) {
      // Best effort: the local flip already happened; a failed POST only
      // means the mark comes back unread on the next refresh.
      markNotificationRead(id).catch(() => undefined);
    }
  }, []);
  const markAllNotificationsRead = useCallback(() => {
    setNotifications((prev) => {
      for (const n of prev) {
        if (!n.read && serverIdsRef.current.has(n.id)) markNotificationRead(n.id).catch(() => undefined);
      }
      return prev.map((n) => (n.read ? n : { ...n, read: true }));
    });
  }, []);
  const unreadCount = useMemo(() => notifications.reduce((total, n) => (n.read ? total : total + 1), 0), [notifications]);

  // Server feed lifecycle: fetch when a session appears (login, tab focus,
  // other tab), poll while the document is visible, reset on logout.
  useEffect(() => {
    let timer: number | null = null;
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      if (!getToken()) {
        serverIdsRef.current = new Set();
        setNotifications((prev) => prev.filter((n) => !serverIdsRef.current.has(n.id)));
        return;
      }
      refreshNotifications();
      timer = window.setInterval(() => {
        if (document.visibilityState === "visible") refreshNotifications();
      }, NOTIFICATIONS_POLL_MS);
    };
    start();
    const offAuth = onAuthChange(start);
    return () => {
      stop();
      offAuth();
    };
  }, [refreshNotifications]);

  // Preferences store — applies any change to <html> immediately and rolls
  // back on failure, mirroring the CocoaPreferencesSheet semantics so both
  // entry points share the same UX guarantees.
  const [preferences, setPreferences] = useState<CocoaPreferences>(DEFAULT_PREFERENCES);
  const updatePreferences = useCallback(
    async (partial: Partial<CocoaPreferences>): Promise<void> => {
      // Only the known keys with valid values reach the state and the wire
      // (a stale caller passing `accentColor` changes nothing).
      const patch = sanitizePreferencePatch(partial);
      if (Object.keys(patch).length === 0) return;
      let previous: CocoaPreferences = DEFAULT_PREFERENCES;
      setPreferences((prev) => {
        previous = prev;
        const next: CocoaPreferences = { ...prev, ...patch };
        applyAllPreferences(next);
        return next;
      });
      try {
        await apiRequest<Partial<CocoaPreferences>>("/users/me/preferences", {
          method: "PATCH",
          body: patch,
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
  // to the default tokens. The migration (drop of the inline accent) runs at
  // mount regardless of the request outcome.
  useEffect(() => {
    const root = documentRoot();
    if (root) clearLegacyAccentOverride(root);
    const controller = new AbortController();
    let cancelled = false;
    apiRequest<unknown>("/users/me/preferences", {
      method: "GET",
      signal: controller.signal,
    })
      .then((data) => {
        if (cancelled) return;
        // `accentColor` (still returned by the API) is dropped here.
        const merged = normalizePreferences(data, DEFAULT_PREFERENCES);
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
  const openNotifications = useCallback(() => {
    refreshNotifications();
    setNotificationsOpen(true);
  }, [refreshNotifications]);
  const closeNotifications = useCallback(() => setNotificationsOpen(false), []);

  useEffect(() => {
    window.addEventListener(OPEN_NOTIFICATIONS_EVENT, openNotifications);
    return () => window.removeEventListener(OPEN_NOTIFICATIONS_EVENT, openNotifications);
  }, [openNotifications]);
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
          // Without the hotkey the event is left untouched for the shell's
          // own ⌘K listener (BackOfficeLayout), which also prevents default.
          if (!commandPaletteHotkey) return;
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
  }, [openPalette, openShortcuts, openPreferences, commandPaletteHotkey]);

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
      unreadCount,
      status: notificationsStatus,
      push: pushNotification,
      markAllRead: markAllNotificationsRead,
      markRead: markNotificationReadLocal,
      refresh: refreshNotifications,
      openCenter: openNotifications,
    }),
    [notifications, unreadCount, notificationsStatus, pushNotification, markAllNotificationsRead, markNotificationReadLocal, refreshNotifications, openNotifications],
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
                onMarkAsRead={markNotificationReadLocal}
                status={notificationsStatus}
              />
              <CocoaKeyboardShortcutsHelp
                open={shortcutsOpen}
                onClose={closeShortcuts}
                onRequestOpen={openShortcuts}
              />
              <CocoaAboutDialog open={aboutOpen} onClose={closeAbout} onOpenHelp={openHelpCenter} onOpenShortcuts={openShortcuts} />
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
