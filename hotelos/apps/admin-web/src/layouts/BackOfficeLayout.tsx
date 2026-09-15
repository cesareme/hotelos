import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { SIDEBAR_ELEMENT_ID, Sidebar } from "../navigation/Sidebar";
import { devQueryFrom, findByScreen } from "../navigation/nav-tree";
import { useNavGate } from "../navigation/useEnabledModules";
import { useIsCompactViewport } from "../navigation/viewport";
import { itemUrlForScreen, pathForScreen, urlForScreenWithParams } from "../routes/backoffice.routes";
import { TopBar } from "../components/TopBar";
import { CommandPalette } from "../components/CommandPalette";
import type { SearchHit } from "../services/searchApi";
import { GuideProvider } from "../components/guide/GuideProvider";
import { CocoaToolbar } from "../components/cocoa/CocoaToolbar";
import { useSidebarRecent } from "../hooks/useSidebarRecent";
import { CocoaSplitView } from "../components/cocoa/CocoaSplitView";
import { CocoaToolbarSearchField } from "../components/cocoa-extras/CocoaToolbarSearchField";
import {
  ACTIVE_PROPERTY_INVALID_EVENT,
  OPEN_PROPERTY_SWITCHER_EVENT,
  ensureActiveProperty,
  getActiveProperty,
  loadSwitchableProperties,
  openPropertySwitcher,
  setActiveProperty,
  type ActiveProperty,
  type SwitchableProperty
} from "../services/activeProperty";
import {
  clearSession,
  getUser,
  onAuthChange,
  type AuthUser
} from "../services/auth-storage";
import {
  cycleThemePreference,
  getThemePreference,
  type ThemePreference
} from "../theme";
import { useCocoaNotifications } from "../providers/CocoaGlobalProvider";
import { openHelpCenter } from "../components/guide/guideStore";
import { fetchPropertyReadiness, type PropertyReadiness } from "../services/billingApi";

// Feature flag: keep the legacy chrome reachable in case the migrated shell
// breaks a specific workflow. Flip to false to fall back to TopBar + Sidebar.
const USE_COCOA_LAYOUT = true;

/** Screen the «Nueva reserva» quick action opens (pilots/tanda5-nav-tree.md §11 #5: one click from anywhere). */
export const NEW_RESERVATION_SCREEN = "ReservationCreate";

/** Public login URL the explicit logout lands on (a 401 keeps the deep link; «Cerrar sesión» does not). */
const LOGIN_PATH = pathForScreen("LoginScreen") ?? "/acceso";

// Layout chrome (Tanda 5 · L1c). Inside the split view column the sidebar is
// never off-canvas, whatever the width (styles.css moves `.bo-sidebar` off
// screen under 900px for the drawer); under COMPACT_BREAKPOINT_PX the layout
// renders the Sidebar as a drawer of its own (`.bo-sidebar.open` + `.bo-scrim`)
// instead of the empty drawer of CocoaSplitView.
const LAYOUT_CSS = `
.cocoa-shell .cocoa-sidebar-host { display: flex; min-height: 0; height: 100%; }
.cocoa-shell .cocoa-sidebar-host .bo-sidebar { position: relative; top: auto; left: auto; width: 100%; height: 100%; transform: none; box-shadow: none; z-index: auto; }
.cocoa-shell .cocoa-sidebar-host .bo-sidebar-close { display: none; }
`;

// Map a SearchHit to the Tanda 5 URL of the screen the API points it to
// (`hit.screen`, the same key the `hotelos-nav` below carries): URLs of the
// navigation tree, never the retired /backoffice/* paths; aliases such as
// RoomInventoryManager resolve to their canonical screen. Detail screens
// (`:id` of a reservation/guest, `:propiedad` of a property) are filled with
// the entity id of the hit; a detail screen without its id opens the menu
// item that owns it.
function buildHitPath(hit: SearchHit): string | null {
  const entityId = hit.params?.reservationId ?? hit.params?.guestId ?? hit.params?.propertyId;
  const params: Record<string, string> = entityId ? { id: entityId, propiedad: entityId } : {};
  return urlForScreenWithParams(hit.screen, params) ?? itemUrlForScreen(hit.screen);
}

// --- Cocoa right-slot inline components ------------------------------------

function PropertySwitcher({ compact = false }: { compact?: boolean }) {
  // Mirrors the property dropdown in the legacy TopBar but rendered inside the
  // CocoaToolbar leftSlot. The list comes from the memoized
  // loadSwitchableProperties() (shared with AuthGate and TopBar, one request
  // per session) and we persist via setActiveProperty, which reloads on change.
  // `compact` (phone toolbar): the button shrinks with the row and the name is
  // truncated with an ellipsis instead of overlapping its neighbours.
  const active = getActiveProperty();
  const [open, setOpen] = useState(false);
  const [properties, setProperties] = useState<SwitchableProperty[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadSwitchableProperties()
      .then((list) => {
        if (!cancelled) setProperties(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "No se pudieron cargar las propiedades");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The active-property banner asks us to open so the user can pick another
  // property without hunting for the toolbar control.
  useEffect(() => {
    function onOpenRequest() {
      setOpen(true);
    }
    window.addEventListener(OPEN_PROPERTY_SWITCHER_EVENT, onOpenRequest);
    return () => window.removeEventListener(OPEN_PROPERTY_SWITCHER_EVENT, onOpenRequest);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function choose(property: SwitchableProperty) {
    const next: ActiveProperty = {
      propertyId: property.id,
      organizationId: property.organizationId,
      propertyName: property.name
    };
    setOpen(false);
    setActiveProperty(next);
  }

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", display: "inline-flex", minWidth: 0, flex: compact ? "1 1 auto" : "0 0 auto" }}
      data-tour="property"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Propiedad activa: ${active.propertyName}. Cambiar propiedad`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          minWidth: 0,
          maxWidth: "100%",
          padding: "4px 10px",
          background: "transparent",
          border: "1px solid var(--cocoa-separator)",
          borderRadius: "var(--cocoa-radius-md)",
          color: "var(--cocoa-label)",
          font: "inherit",
          fontSize: "var(--cocoa-fs-body)",
          cursor: "pointer"
        }}
      >
        <span style={{ flex: "1 1 auto", minWidth: 0, maxWidth: compact ? "none" : 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {active.propertyName}
        </span>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="Cambiar propiedad"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            minWidth: 280,
            maxHeight: 360,
            overflowY: "auto",
            background: "var(--cocoa-background-content)",
            border: "1px solid var(--cocoa-separator)",
            borderRadius: "var(--cocoa-radius-md)",
            boxShadow: "var(--cocoa-shadow-modal)",
            padding: 4,
            zIndex: 100
          }}
        >
          {loading ? (
            <div style={{ padding: 8, color: "var(--cocoa-label-secondary)" }}>Cargando…</div>
          ) : null}
          {error ? (
            <div style={{ padding: 8, color: "var(--cocoa-danger, #c0392b)" }}>{error}</div>
          ) : null}
          {!loading && !error && properties.length === 0 ? (
            <div style={{ padding: 8, color: "var(--cocoa-label-secondary)" }}>Sin propiedades</div>
          ) : null}
          {properties.map((property) => {
            const selected = property.id === active.propertyId;
            const location = [property.municipality, property.province].filter(Boolean).join(", ");
            return (
              <button
                key={property.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => choose(property)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  gap: 2,
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 8px",
                  background: selected ? "var(--cocoa-accent)" : "transparent",
                  color: selected ? "var(--cocoa-accent-contrast)" : "inherit",
                  border: "none",
                  borderRadius: "var(--cocoa-radius-sm)",
                  font: "inherit",
                  cursor: "pointer"
                }}
              >
                <span style={{ fontWeight: 600 }}>{property.name}</span>
                <span style={{ fontSize: "var(--cocoa-fs-caption)", opacity: 0.8 }}>
                  {property.organizationName ?? property.organizationId}
                  {location ? ` · ${location}` : ""}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Short label of each theme preference (toolbar toggle and the compact user menu). */
const THEME_SHORT_LABELS: Record<ThemePreference, string> = { light: "Claro", dark: "Oscuro", system: "Auto" };

function ThemeToggle() {
  const [theme, setTheme] = useState<ThemePreference>(() => getThemePreference());

  const themeMeta: Record<ThemePreference, { label: string; icon: ReactElement }> = {
    light: {
      label: "Tema: claro",
      icon: (
        <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden>
          <circle cx="9" cy="9" r="3.4" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.8 3.8l1.4 1.4M12.8 12.8l1.4 1.4M14.2 3.8l-1.4 1.4M5.2 12.8l-1.4 1.4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )
    },
    dark: {
      label: "Tema: oscuro",
      icon: (
        <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden>
          <path d="M14.5 10.6A6 6 0 0 1 7.4 3.5a6 6 0 1 0 7.1 7.1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      )
    },
    system: {
      label: "Tema: sistema",
      icon: (
        <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden>
          <rect x="2.5" y="3.5" width="13" height="8.5" rx="1.3" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6.5 15h5M9 12v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    }
  };

  // The toolbar previously used a 28x28 transparent button which made the
  // toggle effectively invisible — users reported "the dark mode option
  // disappeared". We now ship the same control with a visible border, a
  // larger touch target, and a label so it's discoverable at a glance.
  return (
    <button
      type="button"
      onClick={() => setTheme(cycleThemePreference())}
      aria-label="Cambiar tema (claro/oscuro)"
      title={themeMeta[theme].label}
      data-tour="theme-toggle"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        height: 32,
        padding: "0 10px",
        background: "var(--cocoa-background-control)",
        border: "1px solid var(--cocoa-separator)",
        borderRadius: "var(--cocoa-radius-md)",
        color: "var(--cocoa-label)",
        font: "inherit",
        fontSize: 12,
        fontWeight: 500,
        cursor: "pointer",
        whiteSpace: "nowrap"
      }}
    >
      <span style={{ display: "inline-flex" }}>{themeMeta[theme].icon}</span>
      <span>{THEME_SHORT_LABELS[theme]}</span>
    </button>
  );
}

// --- Setup pending banner ---------------------------------------------------
// Shell banner shown while the active property does not pass its go-live
// readiness checks (GET /backoffice/properties/:id/readiness → status
// "blocked"). Tanda 5: it replaces a localStorage flag nobody wrote, so the
// banner now disappears on its own once the property is ready. It is
// re-checked when the shell changes screen (throttled) and can be dismissed
// for the session per property.
const READINESS_RECHECK_MS = 30_000;
const SETUP_BANNER_DISMISSED_KEY = "anfitorio.setup-banner.dismissed";

function readSetupBannerDismissed(propertyId: string): boolean {
  try {
    return window.sessionStorage.getItem(`${SETUP_BANNER_DISMISSED_KEY}.${propertyId}`) === "1";
  } catch {
    return false;
  }
}

function writeSetupBannerDismissed(propertyId: string): void {
  try {
    window.sessionStorage.setItem(`${SETUP_BANNER_DISMISSED_KEY}.${propertyId}`, "1");
  } catch {
    /* sessionStorage unavailable: the banner just comes back on reload */
  }
}

/** Pure decision used by the banner (and its tests): show only when the API says "blocked". */
export function shouldShowSetupBanner(readiness: PropertyReadiness | null | undefined, dismissed: boolean): boolean {
  if (dismissed || !readiness) return false;
  return readiness.status === "blocked" || (readiness.blockingCount ?? 0) > 0;
}

function SetupPendingBanner(props: { activeScreen: string }) {
  const propertyId = getActiveProperty().propertyId;
  const user = getUser();
  // The readiness route needs `backoffice.access`; a receptionist cannot act
  // on the checklist anyway, so we only ask when the session may open it
  // (sessions without a permission list — demo mode — still try).
  const canCheck = !user?.permissions || user.permissions.includes("backoffice.access");
  const [readiness, setReadiness] = useState<PropertyReadiness | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => readSetupBannerDismissed(propertyId));
  const lastCheckRef = useRef(0);

  useEffect(() => {
    if (!canCheck || !propertyId) return;
    const now = Date.now();
    if (now - lastCheckRef.current < READINESS_RECHECK_MS) return;
    lastCheckRef.current = now;
    let cancelled = false;
    fetchPropertyReadiness(propertyId)
      .then((result) => {
        if (!cancelled) setReadiness(result);
      })
      .catch(() => {
        // No readiness (403, network…) → no banner: never nag about something
        // the user cannot see or fix.
        if (!cancelled) setReadiness(null);
      });
    return () => {
      cancelled = true;
    };
    // Re-check when the shell switches screen (the checklist may have been
    // recalculated) — throttled above.
  }, [canCheck, propertyId, props.activeScreen]);

  if (!shouldShowSetupBanner(readiness, dismissed)) return null;

  const pending = readiness?.blockingCount ?? 0;
  const message =
    pending > 0
      ? `Faltan ${pending} ${pending === 1 ? "comprobación" : "comprobaciones"} para poner la propiedad en marcha.`
      : "La propiedad aún no supera las comprobaciones de puesta en marcha.";

  function openChecklist() {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "GoLiveChecklist" }));
  }

  function dismiss() {
    writeSetupBannerDismissed(propertyId);
    setDismissed(true);
  }

  return (
    <div
      role="region"
      aria-label="Puesta en marcha pendiente"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "8px 16px",
        background: "var(--cocoa-accent-soft, rgba(10, 132, 255, 0.12))",
        borderBottom: "1px solid var(--cocoa-separator)",
        color: "var(--cocoa-label)",
        font: "inherit",
        fontSize: "var(--cocoa-fs-body)"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden>
          <circle cx="9" cy="9" r="7.25" stroke="currentColor" strokeWidth="1.5" />
          <path d="M9 5v4.5l2.5 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{message}</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button
          type="button"
          onClick={openChecklist}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            height: 28,
            padding: "0 12px",
            background: "var(--cocoa-accent)",
            color: "var(--cocoa-accent-contrast)",
            border: "none",
            borderRadius: "var(--cocoa-radius-md)",
            font: "inherit",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            whiteSpace: "nowrap"
          }}
        >
          Ver qué falta
        </button>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Ocultar este aviso durante la sesión"
          style={{
            display: "inline-flex",
            alignItems: "center",
            height: 28,
            padding: "0 10px",
            background: "transparent",
            border: "1px solid var(--cocoa-separator)",
            borderRadius: "var(--cocoa-radius-md)",
            color: "var(--cocoa-label)",
            font: "inherit",
            fontSize: 12,
            cursor: "pointer",
            whiteSpace: "nowrap"
          }}
        >
          Ahora no
        </button>
      </div>
    </div>
  );
}

// --- Active property safety net ----------------------------------------------
// useApiData reports the opaque tenancy 404 ("Propiedad no encontrada.")
// through ACTIVE_PROPERTY_INVALID_EVENT. We re-validate the stored selection
// against the user's real list: if it was repointed we reload (screens read
// the id at module-evaluation time), if the user has no property left we say
// so, and if the API still lists it we surface an actionable notice that opens
// the switcher instead of leaving N cryptic red cards on the screen.
const REVALIDATE_THROTTLE_MS = 30_000;

function ActivePropertyInvalidBanner() {
  const [notice, setNotice] = useState<"unavailable" | "empty" | null>(null);
  const busyRef = useRef(false);
  const lastCheckRef = useRef(0);

  useEffect(() => {
    function onInvalid() {
      const now = Date.now();
      if (busyRef.current || now - lastCheckRef.current < REVALIDATE_THROTTLE_MS) return;
      const user = getUser();
      if (!user) return;
      busyRef.current = true;
      lastCheckRef.current = now;
      ensureActiveProperty(user, { refresh: true })
        .then((result) => {
          if (result.changed) {
            window.location.reload();
            return;
          }
          setNotice(result.empty ? "empty" : "unavailable");
        })
        .catch(() => setNotice("unavailable"))
        .finally(() => {
          busyRef.current = false;
        });
    }
    window.addEventListener(ACTIVE_PROPERTY_INVALID_EVENT, onInvalid);
    return () => window.removeEventListener(ACTIVE_PROPERTY_INVALID_EVENT, onInvalid);
  }, []);

  if (!notice) return null;

  const message =
    notice === "empty"
      ? "Tu usuario ya no tiene propiedades asignadas. Contacta con un administrador."
      : "La propiedad activa no está disponible para tu usuario. Selecciona otra propiedad.";

  const actionButtonStyle = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    height: 28,
    padding: "0 12px",
    border: "none",
    borderRadius: "var(--cocoa-radius-md)",
    font: "inherit",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap"
  } as const;

  return (
    <div
      role="alert"
      aria-label="Propiedad activa no disponible"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "8px 16px",
        background: "var(--cocoa-warning-soft, rgba(255, 159, 10, 0.14))",
        borderBottom: "1px solid var(--cocoa-separator)",
        color: "var(--cocoa-label)",
        font: "inherit",
        fontSize: "var(--cocoa-fs-body)"
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{message}</span>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        {notice === "unavailable" ? (
          <button
            type="button"
            onClick={() => openPropertySwitcher()}
            style={{
              ...actionButtonStyle,
              background: "var(--cocoa-accent)",
              color: "var(--cocoa-accent-contrast)"
            }}
          >
            Cambiar propiedad
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setNotice(null)}
          style={{
            ...actionButtonStyle,
            background: "transparent",
            border: "1px solid var(--cocoa-separator)",
            color: "var(--cocoa-label)"
          }}
        >
          Cerrar
        </button>
      </div>
    </div>
  );
}

// Shared visual contract of the toolbar icon buttons (theme toggle, bell,
// help): same height, border and radius so the right slot reads as one row.
const toolbarIconButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: 32,
  height: 32,
  background: "var(--cocoa-background-control)",
  border: "1px solid var(--cocoa-separator)",
  borderRadius: "var(--cocoa-radius-md)",
  color: "var(--cocoa-label)",
  cursor: "pointer",
  position: "relative"
} as const;

function NotificationsBell() {
  // Tanda 5 (chrome): the bell is wired to the session's notification feed
  // (GET /notifications through CocoaGlobalProvider) and opens the Cocoa
  // notification center; the badge shows the unread count.
  const { unreadCount, openCenter } = useCocoaNotifications();
  const label = unreadCount > 0 ? `Avisos (${unreadCount} sin leer)` : "Avisos";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-tour="notifications"
      onClick={openCenter}
      style={toolbarIconButtonStyle}
    >
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden>
        <path d="M14 11V8a5 5 0 1 0-10 0v3l-1.5 2h13L14 11Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M7 15a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {unreadCount > 0 ? (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: -5,
            right: -5,
            minWidth: 16,
            height: 16,
            padding: "0 4px",
            borderRadius: 8,
            background: "var(--cocoa-danger, #ff3b30)",
            color: "#fff",
            fontSize: 10,
            fontWeight: 700,
            lineHeight: "16px",
            textAlign: "center",
            boxSizing: "border-box"
          }}
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      ) : null}
    </button>
  );
}

function HelpButton() {
  // «?» opens the help center (tours, task guides, persona guides, articles).
  return (
    <button
      type="button"
      aria-label="Centro de ayuda"
      title="Centro de ayuda"
      data-tour="help"
      onClick={() => openHelpCenter()}
      style={toolbarIconButtonStyle}
    >
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden>
        <circle cx="9" cy="9" r="6.75" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7.1 7a1.9 1.9 0 0 1 3.7.6c0 1.3-1.8 1.6-1.8 2.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="9" cy="12.6" r="0.85" fill="currentColor" />
      </svg>
    </button>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Explicit «Cerrar sesión»: the login form must not keep the URL of the last
 * screen (a shared reception PC would show the next user where the previous
 * one was) — a 401 from the API keeps the deep link, this does not. The Cocoa
 * overlays (notification center…) unmount with the session (App.tsx).
 */
export function logoutFromShell(): void {
  if (window.location.pathname !== LOGIN_PATH) window.history.replaceState(null, "", LOGIN_PATH);
  clearSession();
}

const menuItemStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  textAlign: "left",
  padding: "6px 8px",
  background: "transparent",
  border: "none",
  borderRadius: "var(--cocoa-radius-sm)",
  color: "inherit",
  font: "inherit",
  cursor: "pointer"
} as const;

/** `compact`: initials only, and the theme + help entries move into the menu (the phone toolbar has no room for their buttons). */
function UserAvatar({ compact = false }: { compact?: boolean }) {
  const [user, setUser] = useState<AuthUser | null>(() => getUser());
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(() => getThemePreference());
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => onAuthChange(() => setUser(getUser())), []);

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const displayName = user?.fullName ?? "Sesión demo";
  const displayInitials = user ? initials(user.fullName) : "RD";

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      <button
        type="button"
        aria-label="Menú de usuario"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: compact ? 2 : "2px 8px 2px 2px",
          background: "transparent",
          border: "1px solid var(--cocoa-separator)",
          borderRadius: "var(--cocoa-radius-full)",
          color: "var(--cocoa-label)",
          font: "inherit",
          fontSize: "var(--cocoa-fs-body)",
          cursor: "pointer"
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            borderRadius: "50%",
            background: "var(--cocoa-accent)",
            color: "var(--cocoa-accent-contrast)",
            fontSize: 11,
            fontWeight: 600
          }}
        >
          {displayInitials}
        </span>
        {compact ? null : <span style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</span>}
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Menú de usuario"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 220,
            padding: 6,
            background: "var(--cocoa-background-content)",
            border: "1px solid var(--cocoa-separator)",
            borderRadius: "var(--cocoa-radius-md)",
            boxShadow: "var(--cocoa-shadow-modal)",
            zIndex: 100
          }}
        >
          {user ? (
            <div
              style={{
                padding: "6px 8px",
                borderBottom: "1px solid var(--cocoa-separator)",
                marginBottom: 4,
                fontSize: 13
              }}
            >
              <div style={{ fontWeight: 600 }}>{user.fullName}</div>
              {user.email ? <div style={{ opacity: 0.8 }}>{user.email}</div> : null}
            </div>
          ) : null}
          {compact ? (
            <>
              <button
                type="button"
                role="menuitem"
                data-tour="theme-toggle"
                onClick={() => setTheme(cycleThemePreference())}
                style={menuItemStyle}
              >
                Tema: {THEME_SHORT_LABELS[theme]}
                <span style={{ marginLeft: "auto", fontSize: 12, opacity: 0.7 }}>Cambiar</span>
              </button>
              <button
                type="button"
                role="menuitem"
                data-tour="help"
                onClick={() => {
                  setOpen(false);
                  openHelpCenter();
                }}
                style={menuItemStyle}
              >
                Centro de ayuda
              </button>
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              logoutFromShell();
            }}
            style={menuItemStyle}
          >
            Cerrar sesión
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The session may open «Nueva reserva» (roles/module of the tree item, «Ver como…» applied). */
function useCanCreateReservation(): boolean {
  const gate = useNavGate();
  const isVisible = gate.isVisible;
  return useMemo(() => {
    const match = findByScreen(NEW_RESERVATION_SCREEN);
    return match?.kind === "item" && isVisible(match.item);
  }, [isVisible]);
}

/**
 * «+ Nueva reserva» of the toolbar (§11 #5): one click to the reservation
 * form from any screen. Painted only for the roles that can create one.
 */
function NewReservationButton(props: { onOpen: () => void; iconOnly?: boolean }) {
  const label = "Nueva reserva";
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} (Recepción › Nueva reserva)`}
      data-tour="new-reservation"
      onClick={props.onOpen}
      style={{
        ...toolbarIconButtonStyle,
        width: props.iconOnly ? 32 : "auto",
        gap: 6,
        padding: props.iconOnly ? 0 : "0 10px",
        background: "var(--cocoa-accent)",
        border: "1px solid transparent",
        color: "var(--cocoa-accent-contrast)",
        font: "inherit",
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap"
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
        <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      {props.iconOnly ? null : <span>{label}</span>}
    </button>
  );
}

// --- Compact toolbar (under COMPACT_BREAKPOINT_PX) ----------------------------
// One row that never overlaps at 390px: menu button · property (shrinks and
// truncates) · new reservation · search · notifications · user. Theme and
// help live inside the user menu here; the desktop keeps CocoaToolbar.

const compactToolbarStyle = {
  position: "sticky",
  top: 0,
  zIndex: 10,
  height: 48,
  minHeight: 48,
  padding: "0 12px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "var(--cocoa-background-toolbar)",
  backdropFilter: "var(--cocoa-material-toolbar-blur)",
  WebkitBackdropFilter: "var(--cocoa-material-toolbar-blur)",
  borderBottom: "1px solid var(--cocoa-separator)",
  fontFamily: "var(--cocoa-font)",
  boxSizing: "border-box"
} as const;

function CompactToolbar(props: {
  navOpen: boolean;
  onOpenNav: () => void;
  onOpenSearch: () => void;
  canCreateReservation: boolean;
  onCreateReservation: () => void;
}) {
  return (
    <div role="toolbar" aria-label="Barra superior" style={compactToolbarStyle}>
      <button
        type="button"
        aria-label="Abrir el menú"
        aria-expanded={props.navOpen}
        aria-controls={SIDEBAR_ELEMENT_ID}
        onClick={props.onOpenNav}
        style={toolbarIconButtonStyle}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      <PropertySwitcher compact />
      {props.canCreateReservation ? <NewReservationButton onOpen={props.onCreateReservation} iconOnly /> : null}
      <button
        type="button"
        aria-label="Abrir la búsqueda (⌘K)"
        title="Buscar en toda la aplicación (⌘K)"
        data-tour="search"
        onClick={props.onOpenSearch}
        style={toolbarIconButtonStyle}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      <NotificationsBell />
      <UserAvatar compact />
    </div>
  );
}

export function BackOfficeLayout(props: { activeScreen: string; onSelect: (screen: string) => void; children: ReactNode }) {
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [cmdkQuery, setCmdkQuery] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  // Remount key for the toolbar search field: its internal state keeps the
  // handed-over text otherwise (the parent value was already "").
  const [searchFieldKey, setSearchFieldKey] = useState(0);

  // Recents feed the «Recientes» group of ⌘K (hooks/useSidebarRecent).
  const { pushRecent } = useSidebarRecent();
  // Under COMPACT_BREAKPOINT_PX (the width at which CocoaSplitView drops its
  // sidebar column) the layout owns the navigation drawer and the toolbar.
  const compact = useIsCompactViewport();
  const canCreateReservation = useCanCreateReservation();

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const isMeta = event.metaKey || event.ctrlKey;
      if (isMeta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCmdkQuery("");
        setCmdkOpen((open) => !open);
      }
      if (event.key === "Escape") setNavOpen(false);
    }
    function onOpenSearch(event: Event) {
      // Screens may hand over a query: `new CustomEvent("hotelos-open-search", { detail: "García" })`.
      const detail = (event as CustomEvent<string | undefined>).detail;
      setCmdkQuery(typeof detail === "string" ? detail : "");
      setCmdkOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("hotelos-open-search", onOpenSearch);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("hotelos-open-search", onOpenSearch);
    };
  }, []);

  // Lock body scroll while the mobile drawer is open.
  useEffect(() => {
    document.body.style.overflow = navOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [navOpen]);

  function selectAndClose(screen: string) {
    setNavOpen(false);
    props.onSelect(screen);
  }

  function openNewReservation() {
    pushRecent(NEW_RESERVATION_SCREEN);
    selectAndClose(NEW_RESERVATION_SCREEN);
  }

  // The drawer closes when the viewport grows back to the split view.
  useEffect(() => {
    if (!compact) setNavOpen(false);
  }, [compact]);

  // Map an entity hit to a concrete URL + navigation event. Detail screens
  // read their id from the URL, so the path must be in place before React
  // mounts the component — but a screen guard (the rate grid editor with an
  // unsaved draft) may veto the navigation, so the event goes out FIRST as a
  // cancelable `hotelos-nav` and the URL only changes when nobody vetoed it
  // (cierre 2026-09-15). App.tsx applies the switch in a microtask, i.e.
  // after this synchronous pushState, so the mounted screen sees the new URL.
  function selectHit(hit: SearchHit) {
    setNavOpen(false);
    const event = new CustomEvent("hotelos-nav", { detail: hit.screen, cancelable: true });
    window.dispatchEvent(event);
    if (event.defaultPrevented || event.cancelBubble) return;
    const path = buildHitPath(hit);
    if (path && window.location.pathname !== path) {
      window.history.pushState(null, "", path + devQueryFrom(window.location.search));
    }
  }

  // --- Legacy fallback ------------------------------------------------------
  // Kept around so we can flip USE_COCOA_LAYOUT to false if the migrated shell
  // regresses on a flow we missed. The behaviour matches the pre-migration
  // version of this file byte-for-byte.
  if (!USE_COCOA_LAYOUT) {
    return (
      <main className="bo-shell" data-route-base="/backoffice">
        <Sidebar
          activeScreen={props.activeScreen}
          onSelect={selectAndClose}
          open={navOpen}
          onClose={() => setNavOpen(false)}
        />
        <div
          className={`bo-scrim${navOpen ? " open" : ""}`}
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
        <TopBar onOpenCommandPalette={() => openPaletteWith("")} onOpenNav={() => setNavOpen(true)} />
        <ActivePropertyInvalidBanner />
        <SetupPendingBanner activeScreen={props.activeScreen} />
        <section className="bo-workspace">{props.children}</section>
        <CommandPalette
          open={cmdkOpen}
          initialQuery={cmdkQuery}
          onClose={() => setCmdkOpen(false)}
          onSelect={(screen) => selectAndClose(screen)}
          onSelectHit={(hit) => selectHit(hit)}
        />
        <GuideProvider />
      </main>
    );
  }

  // --- Cocoa-migrated shell -------------------------------------------------
  // The toolbar search field is a launcher for ⌘K (Tanda 5: it used to be a
  // dead end). The first character typed — or Enter — opens the CommandPalette
  // with that text, which owns the shared search index + hit routing; the
  // field is cleared so it never holds a stale query.
  function openPaletteWith(query: string) {
    setCmdkQuery(query);
    setCmdkOpen(true);
    setSearchValue("");
    setSearchFieldKey((key) => key + 1);
  }
  function handleSearchChange(next: string) {
    if (next.trim().length > 0) {
      openPaletteWith(next);
      return;
    }
    setSearchValue(next);
  }

  const sidebar = (
    <Sidebar
      activeScreen={props.activeScreen}
      onSelect={(screen) => {
        pushRecent(screen);
        selectAndClose(screen);
      }}
      open={navOpen}
      onClose={() => setNavOpen(false)}
    />
  );

  return (
    <div className="cocoa-shell" data-route-base="/backoffice">
      <style>{LAYOUT_CSS}</style>
      {compact ? (
        <CompactToolbar
          navOpen={navOpen}
          onOpenNav={() => setNavOpen(true)}
          onOpenSearch={() => openPaletteWith("")}
          canCreateReservation={canCreateReservation}
          onCreateReservation={openNewReservation}
        />
      ) : (
      <CocoaToolbar
        showTrafficLights
        title="Anfitorio"
        leftSlot={<PropertySwitcher />}
        rightSlot={
          <>
            {canCreateReservation ? <NewReservationButton onOpen={openNewReservation} /> : null}
            <div
              data-tour="search"
              style={{ display: "inline-flex" }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  openPaletteWith(searchValue);
                }
              }}
            >
              <CocoaToolbarSearchField
                key={searchFieldKey}
                value={searchValue}
                onChange={handleSearchChange}
                placeholder="Buscar reservas, huéspedes…"
                expandOnFocus
              />
            </div>
            <button
              type="button"
              aria-label="Abrir la búsqueda (⌘K)"
              title="Buscar en toda la aplicación (⌘K)"
              onClick={() => openPaletteWith("")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 28,
                height: 28,
                background: "transparent",
                border: "none",
                borderRadius: "var(--cocoa-radius-sm)",
                color: "var(--cocoa-label)",
                cursor: "pointer"
              }}
            >
              <kbd
                style={{
                  font: "inherit",
                  fontSize: 11,
                  padding: "1px 4px",
                  border: "1px solid var(--cocoa-separator)",
                  borderRadius: 4
                }}
              >
                ⌘K
              </kbd>
            </button>
            <ThemeToggle />
            <NotificationsBell />
            <HelpButton />
            <UserAvatar />
          </>
        }
      />
      )}
      <ActivePropertyInvalidBanner />
      <SetupPendingBanner activeScreen={props.activeScreen} />
      {compact ? (
        <>
          {/* Drawer of the layout: `.bo-sidebar` is off-canvas under 900px and
              `.open` slides it in (styles.css); the scrim closes it. */}
          {sidebar}
          <div className={`bo-scrim${navOpen ? " open" : ""}`} onClick={() => setNavOpen(false)} aria-hidden />
        </>
      ) : null}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <CocoaSplitView
          sidebar={compact ? null : <div className="cocoa-sidebar-host">{sidebar}</div>}
          collapsibleSidebar={!compact}
          content={<main className="cocoa-content">{props.children}</main>}
        />
      </div>
      <CommandPalette
        open={cmdkOpen}
        initialQuery={cmdkQuery}
        onClose={() => setCmdkOpen(false)}
        onSelect={(screen) => selectAndClose(screen)}
        onSelectHit={(hit) => selectHit(hit)}
      />
      <GuideProvider />
    </div>
  );
}
