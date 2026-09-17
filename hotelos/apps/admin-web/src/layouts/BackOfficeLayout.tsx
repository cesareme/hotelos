import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { SIDEBAR_ELEMENT_ID, Sidebar } from "../navigation/Sidebar";
import { devQueryFrom, findByScreen } from "../navigation/nav-tree";
import { useNavGate } from "../navigation/useEnabledModules";
import { useIsCompactViewport } from "../navigation/viewport";
import { itemUrlForScreen, pathForScreen, urlForScreenWithParams } from "../routes/backoffice.routes";
import { CommandPalette } from "../components/CommandPalette";
import type { SearchHit } from "../services/searchApi";
import { GuideProvider } from "../components/guide/GuideProvider";
import { CocoaToolbar } from "../components/cocoa/CocoaToolbar";
import { CocoaButton, type CocoaButtonProps } from "../components/cocoa/CocoaButton";
import { TAP_TARGET_PX, useCoarsePointer } from "../lib/useCoarsePointer";
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
import { PROPERTY_KIND_LABELS, type StructuredPropertyRow } from "../services/financeScope";

/** Screen the «Nueva reserva» quick action opens (pilots/tanda5-nav-tree.md §11 #5: one click from anywhere). */
export const NEW_RESERVATION_SCREEN = "ReservationCreate";

/** Public login URL the explicit logout lands on (a 401 keeps the deep link; «Cerrar sesión» does not). */
const LOGIN_PATH = pathForScreen("LoginScreen") ?? "/acceso";

// Layout chrome (Tanda 5 · L1c · Cocoa 22 ola 11, R11): the sidebar geometry
// lives in styles/cocoa-22-shell.css — inside the split view column
// (`.cocoa-sidebar-host`) it is never off-canvas, whatever the width; under
// COMPACT_BREAKPOINT_PX the layout renders the Sidebar as a drawer of its own
// (`.c22-sidebar.open` + `.c22-scrim`, z-index / scrim / shadow / width
// tokens) instead of the empty drawer of CocoaSplitView. The property
// switcher truncates its name inside CocoaButton's child span and the raw
// menu / listbox rows get their hover wash from that same sheet.

// --- Toolbar chrome tokens -----------------------------------------------------

/** Width of the square toolbar controls on a mouse (spec §3.1); 44 × 44 on a coarse pointer. */
const TOOLBAR_ICON_PX = 32;

/** 12 px 500 text of the toolbar buttons (measured on the canon: theme toggle, «Nueva reserva»). */
const toolbarTextButtonStyle: CSSProperties = { fontSize: "var(--cocoa-fs-callout)", paddingInline: 10 };

type ToolbarIconButtonProps = Omit<CocoaButtonProps, "variant" | "tone" | "size" | "aria-label"> & { "aria-label": string };

/**
 * Square toolbar control (menu, search, bell, help): a bordered neutral
 * CocoaButton without horizontal padding whose width follows the pointer —
 * 32 px on a mouse, the 44 px tap target on touch (measured before: 32 × 44,
 * the width failed the target). `aria-label` is mandatory: icon only.
 */
function ToolbarIconButton({ style, ...rest }: ToolbarIconButtonProps) {
  const coarse = useCoarsePointer();
  return (
    <CocoaButton
      variant="bordered"
      tone="neutral"
      size="large"
      {...rest}
      style={{ paddingInline: 0, minWidth: coarse ? TAP_TARGET_PX : TOOLBAR_ICON_PX, ...style }}
    />
  );
}

// Floating menus of the toolbar (property list, user menu): the popover
// surface of the spec — content bg, hairline, radius 8, popover shadow,
// dropdown layer. `left`/`right`/`minWidth` are set per menu.
const dropdownSurfaceStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  padding: 4,
  background: "var(--cocoa-background-content)",
  border: "1px solid var(--cocoa-separator)",
  borderRadius: "var(--cocoa-radius-md)",
  boxShadow: "var(--cocoa-shadow-popover)",
  fontFamily: "var(--cocoa-font)",
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-label)",
  zIndex: "var(--cocoa-z-dropdown)" as CSSProperties["zIndex"]
};

// Rows of those menus stay raw <button>s (role="menuitem" / "option" and
// aria-selected are not props of CocoaButton yet); they share the focus ring
// class and the hover wash of styles/cocoa-22-shell.css (`.cocoa-menu-item`).
const menuItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  minHeight: 32,
  textAlign: "left",
  padding: "6px 8px",
  background: "transparent",
  border: "none",
  borderRadius: "var(--cocoa-radius-sm)",
  color: "var(--cocoa-label)",
  font: "inherit",
  cursor: "pointer"
};

// Shell banners under the toolbar (setup pending, invalid property): tinted
// wash of their tone (§3.1), hairline below, body text, actions in a row.
const shellBannerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--cocoa-space-3)",
  padding: "var(--cocoa-space-2) var(--cocoa-space-4)",
  borderBottom: "1px solid var(--cocoa-separator)",
  color: "var(--cocoa-label)",
  fontFamily: "var(--cocoa-font)",
  fontSize: "var(--cocoa-fs-body)"
};

const kbdStyle: CSSProperties = {
  font: "inherit",
  fontSize: "var(--cocoa-fs-subheadline)",
  padding: "1px 4px",
  border: "1px solid var(--cocoa-separator)",
  borderRadius: "var(--cocoa-radius-sm)"
};

// Unread count pinned to the bell's corner (it lives in the aria-hidden icon
// slot of CocoaButton; the count travels in the button's accessible name).
const unreadBadgeStyle: CSSProperties = {
  position: "absolute",
  top: -5,
  right: -5,
  minWidth: 16,
  height: 16,
  padding: "0 4px",
  borderRadius: "var(--cocoa-radius-full)",
  background: "var(--cocoa-danger)",
  color: "var(--cocoa-accent-contrast)",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: 700,
  lineHeight: "16px",
  textAlign: "center",
  boxSizing: "border-box",
  fontVariantNumeric: "tabular-nums"
};

const avatarInitialsStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  borderRadius: "var(--cocoa-radius-full)",
  background: "var(--cocoa-accent)",
  color: "var(--cocoa-accent-contrast)",
  fontSize: "var(--cocoa-fs-subheadline)",
  fontWeight: 600,
  flexShrink: 0
};

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
  // Property dropdown rendered inside the CocoaToolbar leftSlot. The list
  // comes from the memoized loadSwitchableProperties() (shared with AuthGate,
  // one request per session) and we persist via setActiveProperty, which
  // reloads on change.
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

  // Tanda 6b · L7 (design §5.3): the rows carry `kind`, `code` and `legalEntityName`
  // (additive columns of GET /users/me/properties): the list is grouped by sociedad
  // and, inside it, «Hoteles» first and «Centros no alojativos» (oficina central,
  // otros) after. A single group with hotels only paints no headings.
  const groups = groupSwitchableProperties(properties as StructuredPropertyRow[]);
  const showHeadings = groups.length > 1 || groups.some((group) => group.nonOperational.length > 0);

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", display: "inline-flex", minWidth: 0, flex: compact ? "1 1 auto" : "0 0 auto" }}
      data-tour="property"
    >
      <CocoaButton
        variant="bordered"
        tone="neutral"
        size="large"
        className="cocoa-toolbar-property"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Propiedad activa: ${active.propertyName}. Cambiar propiedad`}
        icon={
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        }
        iconPosition="right"
        style={{ minWidth: 0, maxWidth: "100%", paddingInline: 10, fontSize: "var(--cocoa-fs-body)" }}
      >
        <span style={{ display: "block", minWidth: 0, maxWidth: compact ? "none" : 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {active.propertyName}
        </span>
      </CocoaButton>
      {open ? (
        <div role="listbox" aria-label="Cambiar propiedad" style={{ ...dropdownSurfaceStyle, left: 0, minWidth: 280, maxHeight: 360, overflowY: "auto" }}>
          {loading ? (
            <div role="status" style={{ padding: 8, color: "var(--cocoa-label-secondary)" }}>Cargando…</div>
          ) : null}
          {error ? (
            <div role="alert" style={{ padding: 8, color: "var(--cocoa-danger-ink)" }}>{error}</div>
          ) : null}
          {!loading && !error && properties.length === 0 ? (
            <div style={{ padding: 8, color: "var(--cocoa-label-secondary)" }}>Sin propiedades</div>
          ) : null}
          {groups.map((group) => (
            <div key={group.key} role="presentation">
              {showHeadings ? (
                <div role="presentation" style={switcherGroupHeadingStyle}>
                  {group.label}
                </div>
              ) : null}
              {(
                [
                  { heading: "Hoteles", rows: group.hotels },
                  { heading: "Centros no alojativos", rows: group.nonOperational }
                ] as const
              ).map((section) =>
                section.rows.length === 0 ? null : (
                  <div key={section.heading} role="presentation">
                    {showHeadings && group.nonOperational.length > 0 ? (
                      <div role="presentation" style={switcherSectionHeadingStyle}>
                        {section.heading}
                      </div>
                    ) : null}
                    {section.rows.map((property) => {
                      const selected = property.id === active.propertyId;
                      const location = [property.municipality, property.province].filter(Boolean).join(", ");
                      const kind = property.kind ?? "hotel";
                      return (
                        <button
                          key={property.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className="cocoa-menu-item cocoa-focus-ring"
                          onClick={() => choose(property)}
                          style={{
                            ...menuItemStyle,
                            flexDirection: "column",
                            alignItems: "flex-start",
                            gap: 2,
                            background: selected ? "var(--cocoa-accent-bg)" : "transparent",
                            color: selected ? "var(--cocoa-tone-accent-text)" : "var(--cocoa-label)"
                          }}
                        >
                          <span style={{ fontWeight: 600 }}>
                            {property.name}
                            {property.code ? ` (${property.code})` : ""}
                          </span>
                          <span style={{ fontSize: "var(--cocoa-fs-caption)", color: selected ? "inherit" : "var(--cocoa-label-secondary)" }}>
                            {kind !== "hotel" ? `${PROPERTY_KIND_LABELS[kind]} · ` : ""}
                            {property.legalEntityName ?? property.organizationName ?? property.organizationId}
                            {location ? ` · ${location}` : ""}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Group headings of the switcher (sociedad · «Hoteles» / «Centros no alojativos»): caption secondary, uppercase.
const switcherGroupHeadingStyle: CSSProperties = {
  padding: "6px 8px 2px",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: 600,
  letterSpacing: "var(--cocoa-tracking-wide)",
  textTransform: "uppercase",
  color: "var(--cocoa-label-secondary)"
};
const switcherSectionHeadingStyle: CSSProperties = { padding: "4px 8px 2px", fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-tertiary)" };

export type SwitcherGroup = { key: string; label: string; hotels: StructuredPropertyRow[]; nonOperational: StructuredPropertyRow[] };

/**
 * Pure: switcher rows grouped by sociedad (razón social; the organization name for
 * rows without one) with the hotels first and the non-operational centres
 * (oficina central, otros) after. Order of the groups = order of first appearance.
 */
export function groupSwitchableProperties(rows: readonly StructuredPropertyRow[]): SwitcherGroup[] {
  const groups = new Map<string, SwitcherGroup>();
  for (const row of rows) {
    const key = row.legalEntityId ?? row.organizationId;
    const label = row.legalEntityName ?? row.organizationName ?? row.organizationId;
    let group = groups.get(key);
    if (!group) {
      group = { key, label, hotels: [], nonOperational: [] };
      groups.set(key, group);
    }
    if ((row.kind ?? "hotel") === "hotel") group.hotels.push(row);
    else group.nonOperational.push(row);
  }
  return [...groups.values()];
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
  // disappeared". The control keeps a visible border, the 32 px row height
  // and a label so it's discoverable at a glance (bordered neutral, like the
  // rest of the toolbar row). The wrapper carries the guide hook.
  return (
    <span data-tour="theme-toggle" style={{ display: "inline-flex", flexShrink: 0 }}>
      <CocoaButton
        variant="bordered"
        tone="neutral"
        size="large"
        icon={themeMeta[theme].icon}
        onClick={() => setTheme(cycleThemePreference())}
        aria-label="Cambiar tema (claro/oscuro)"
        title={themeMeta[theme].label}
        style={toolbarTextButtonStyle}
      >
        {THEME_SHORT_LABELS[theme]}
      </CocoaButton>
    </span>
  );
}

// --- Office centre banner (Tanda 6b · L7) --------------------------------------
// Shown while the active centre is the oficina central (or another non-hotel
// centre, design §5.2 R6): no rooms, no reception, no night audit — Finanzas y
// Cumplimiento are the screens that work there. Reads the same memoized list as
// the switcher (`kind` is an additive column of GET /users/me/properties).

/** Pure decision used by the banner (and its tests): the active row exists and is not a hotel. */
export function isNonOperationalCentre(rows: readonly StructuredPropertyRow[], propertyId: string): StructuredPropertyRow | null {
  const row = rows.find((candidate) => candidate.id === propertyId);
  return row && row.kind && row.kind !== "hotel" ? row : null;
}

function OfficeCentreBanner(props: { onOpenFinance: () => void }) {
  const active = getActiveProperty();
  const [row, setRow] = useState<StructuredPropertyRow | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadSwitchableProperties()
      .then((list) => {
        if (!cancelled) setRow(isNonOperationalCentre(list as StructuredPropertyRow[], active.propertyId));
      })
      .catch(() => {
        // No list (network, 403): no banner — never nag about something we cannot verify.
        if (!cancelled) setRow(null);
      });
    return () => {
      cancelled = true;
    };
  }, [active.propertyId]);
  if (!row) return null;
  const kind = row.kind ?? "other";
  return (
    <div role="region" aria-label="Centro no alojativo activo" style={{ ...shellBannerStyle, background: "var(--cocoa-accent-bg)" }}>
      <span style={{ minWidth: 0 }}>
        Estás en <strong>{row.name}</strong>
        {row.code ? ` (${row.code})` : ""}, un centro de tipo {PROPERTY_KIND_LABELS[kind].toLowerCase()} de {row.legalEntityName ?? row.organizationName ?? "la sociedad"}: sin habitaciones, recepción ni cierre del día. Aquí trabajan Finanzas y Cumplimiento.
      </span>
      <div style={{ display: "flex", gap: "var(--cocoa-space-2)", flexShrink: 0 }}>
        <CocoaButton variant="filled" tone="accent" onClick={props.onOpenFinance}>
          Abrir Finanzas
        </CocoaButton>
        <CocoaButton variant="bordered" tone="neutral" onClick={() => openPropertySwitcher()}>
          Cambiar de centro
        </CocoaButton>
      </div>
    </div>
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
    <div role="region" aria-label="Puesta en marcha pendiente" style={{ ...shellBannerStyle, background: "var(--cocoa-accent-bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--cocoa-space-2)", minWidth: 0 }}>
        <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden style={{ flexShrink: 0, color: "var(--cocoa-tone-accent-text)" }}>
          <circle cx="9" cy="9" r="7.25" stroke="currentColor" strokeWidth="1.5" />
          <path d="M9 5v4.5l2.5 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{message}</span>
      </div>
      <div style={{ display: "flex", gap: "var(--cocoa-space-2)", flexShrink: 0 }}>
        <CocoaButton variant="filled" tone="accent" onClick={openChecklist}>
          Ver qué falta
        </CocoaButton>
        <CocoaButton variant="bordered" tone="neutral" onClick={dismiss} aria-label="Ocultar este aviso durante la sesión">
          Ahora no
        </CocoaButton>
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

  return (
    <div role="alert" aria-label="Propiedad activa no disponible" style={{ ...shellBannerStyle, background: "var(--cocoa-warning-bg)" }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{message}</span>
      <div style={{ display: "flex", gap: "var(--cocoa-space-2)", flexShrink: 0 }}>
        {notice === "unavailable" ? (
          <CocoaButton variant="filled" tone="accent" onClick={() => openPropertySwitcher()}>
            Cambiar propiedad
          </CocoaButton>
        ) : null}
        <CocoaButton variant="bordered" tone="neutral" onClick={() => setNotice(null)}>
          Cerrar
        </CocoaButton>
      </div>
    </div>
  );
}

function NotificationsBell() {
  // Tanda 5 (chrome): the bell is wired to the session's notification feed
  // (GET /notifications through CocoaGlobalProvider) and opens the Cocoa
  // notification center; the badge shows the unread count (also in the name).
  const { unreadCount, openCenter } = useCocoaNotifications();
  const label = unreadCount > 0 ? `Avisos (${unreadCount} sin leer)` : "Avisos";
  return (
    <span data-tour="notifications" style={{ display: "inline-flex", flexShrink: 0 }}>
      <ToolbarIconButton
        aria-label={label}
        title={label}
        onClick={openCenter}
        icon={
          <>
            <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden>
              <path d="M14 11V8a5 5 0 1 0-10 0v3l-1.5 2h13L14 11Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M7 15a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            {unreadCount > 0 ? <span style={unreadBadgeStyle}>{unreadCount > 99 ? "99+" : unreadCount}</span> : null}
          </>
        }
      />
    </span>
  );
}

function HelpButton() {
  // «?» opens the help center (tours, task guides, persona guides, articles).
  return (
    <span data-tour="help" style={{ display: "inline-flex", flexShrink: 0 }}>
      <ToolbarIconButton
        aria-label="Centro de ayuda"
        title="Centro de ayuda"
        onClick={() => openHelpCenter()}
        icon={
          <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden>
            <circle cx="9" cy="9" r="6.75" stroke="currentColor" strokeWidth="1.5" />
            <path d="M7.1 7a1.9 1.9 0 0 1 3.7.6c0 1.3-1.8 1.6-1.8 2.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="9" cy="12.6" r="0.85" fill="currentColor" />
          </svg>
        }
      />
    </span>
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
      <CocoaButton
        variant="bordered"
        tone="neutral"
        size="large"
        aria-label="Menú de usuario"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{ borderRadius: "var(--cocoa-radius-full)", paddingInline: 3, paddingRight: compact ? 3 : 10, fontSize: "var(--cocoa-fs-body)" }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden style={avatarInitialsStyle}>
            {displayInitials}
          </span>
          {compact ? null : <span style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</span>}
        </span>
      </CocoaButton>
      {open ? (
        <div role="menu" aria-label="Menú de usuario" style={{ ...dropdownSurfaceStyle, right: 0, minWidth: 220, padding: 6 }}>
          {user ? (
            <div
              style={{
                padding: "6px 8px",
                borderBottom: "1px solid var(--cocoa-separator)",
                marginBottom: 4
              }}
            >
              <div style={{ fontWeight: 600 }}>{user.fullName}</div>
              {user.email ? <div style={{ color: "var(--cocoa-label-secondary)" }}>{user.email}</div> : null}
            </div>
          ) : null}
          {compact ? (
            <>
              <button
                type="button"
                role="menuitem"
                data-tour="theme-toggle"
                className="cocoa-menu-item cocoa-focus-ring"
                onClick={() => setTheme(cycleThemePreference())}
                style={menuItemStyle}
              >
                Tema: {THEME_SHORT_LABELS[theme]}
                <span style={{ marginLeft: "auto", fontSize: "var(--cocoa-fs-callout)", color: "var(--cocoa-label-secondary)" }}>Cambiar</span>
              </button>
              <button
                type="button"
                role="menuitem"
                data-tour="help"
                className="cocoa-menu-item cocoa-focus-ring"
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
            className="cocoa-menu-item cocoa-focus-ring"
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
  const coarse = useCoarsePointer();
  return (
    <span data-tour="new-reservation" style={{ display: "inline-flex", flexShrink: 0 }}>
      <CocoaButton
        variant="filled"
        tone="accent"
        size="large"
        aria-label={label}
        title={`${label} (Recepción › Nueva reserva)`}
        onClick={props.onOpen}
        icon={
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        }
        style={props.iconOnly ? { paddingInline: 0, minWidth: coarse ? TAP_TARGET_PX : TOOLBAR_ICON_PX } : { ...toolbarTextButtonStyle, fontWeight: 600 }}
      >
        {props.iconOnly ? null : label}
      </CocoaButton>
    </span>
  );
}

// --- Compact toolbar (under COMPACT_BREAKPOINT_PX) ----------------------------
// One row that never overlaps at 390px: menu button · property (shrinks and
// truncates) · new reservation · search · notifications · user. Theme and
// help live inside the user menu here; the desktop keeps CocoaToolbar.

// Same material, height, hairline and layer as CocoaToolbar (window variant);
// content-box so the safe-area top padding does not eat the 48 px row.
const compactToolbarStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: "var(--cocoa-z-toolbar)" as CSSProperties["zIndex"],
  height: "var(--cocoa-toolbar-height)",
  minHeight: "var(--cocoa-toolbar-height)",
  padding: "0 12px",
  paddingTop: "env(safe-area-inset-top)",
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "var(--cocoa-background-toolbar)",
  backdropFilter: "var(--cocoa-material-toolbar-blur)",
  WebkitBackdropFilter: "var(--cocoa-material-toolbar-blur)",
  borderBottom: "1px solid var(--cocoa-separator)",
  fontFamily: "var(--cocoa-font)",
  boxSizing: "content-box"
};

function CompactToolbar(props: {
  navOpen: boolean;
  onOpenNav: () => void;
  onOpenSearch: () => void;
  canCreateReservation: boolean;
  onCreateReservation: () => void;
}) {
  return (
    <div role="toolbar" aria-label="Barra superior" className="cocoa-toolbar" data-cocoa="toolbar" data-variant="window" style={compactToolbarStyle}>
      <ToolbarIconButton
        aria-label="Abrir el menú"
        aria-expanded={props.navOpen}
        aria-controls={SIDEBAR_ELEMENT_ID}
        onClick={props.onOpenNav}
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        }
      />
      <PropertySwitcher compact />
      {props.canCreateReservation ? <NewReservationButton onOpen={props.onCreateReservation} iconOnly /> : null}
      <span data-tour="search" style={{ display: "inline-flex", flexShrink: 0 }}>
        <ToolbarIconButton
          aria-label="Abrir la búsqueda (⌘K)"
          title="Buscar en toda la aplicación (⌘K)"
          onClick={props.onOpenSearch}
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          }
        />
      </span>
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
        title="ehotelOS"
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
            <CocoaButton
              variant="plain"
              tone="neutral"
              size="large"
              aria-label="Abrir la búsqueda (⌘K)"
              title="Buscar en toda la aplicación (⌘K)"
              onClick={() => openPaletteWith("")}
              style={{ paddingInline: 4 }}
            >
              <kbd style={kbdStyle}>⌘K</kbd>
            </CocoaButton>
            <ThemeToggle />
            <NotificationsBell />
            <HelpButton />
            <UserAvatar />
          </>
        }
      />
      )}
      <ActivePropertyInvalidBanner />
      <OfficeCentreBanner onOpenFinance={() => selectAndClose("FinancePositionDashboard")} />
      <SetupPendingBanner activeScreen={props.activeScreen} />
      {compact ? (
        <>
          {/* Drawer of the layout: `.c22-sidebar` is off-canvas under 900px and
              `.open` slides it in (styles/cocoa-22-shell.css); the scrim closes it. */}
          {sidebar}
          <div className={`c22-scrim${navOpen ? " open" : ""}`} onClick={() => setNavOpen(false)} aria-hidden />
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
