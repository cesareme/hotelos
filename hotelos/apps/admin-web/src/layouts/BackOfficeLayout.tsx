import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  Sidebar,
  backOfficeNavigationGroups,
  type BackOfficeNavItem
} from "../navigation/Sidebar";
import { TopBar } from "../components/TopBar";
import { CommandPalette } from "../components/CommandPalette";
import type { SearchHit } from "../services/searchApi";
import { GuideProvider } from "../components/guide/GuideProvider";
import { CocoaToolbar } from "../components/cocoa/CocoaToolbar";
import {
  CocoaSidebarV2,
  SIDEBAR_V2_CONFIG,
  type SidebarGroup as SidebarV2Group,
  type SidebarItem as SidebarV2Item
} from "../components/cocoa-sidebar-v2";
import { useSidebarFavorites } from "../hooks/useSidebarFavorites";
import { useSidebarRecent } from "../hooks/useSidebarRecent";
import { useSidebarRoleFilter } from "../hooks/useSidebarRoleFilter";
import { CocoaSplitView } from "../components/cocoa/CocoaSplitView";
import { CocoaToolbarSearchField } from "../components/cocoa-extras/CocoaToolbarSearchField";
import { apiRequest } from "../services/api-client";
import {
  getActiveProperty,
  setActiveProperty,
  type ActiveProperty
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

// Feature flag: keep the legacy chrome reachable in case the migrated shell
// breaks a specific workflow. Flip to false to fall back to TopBar + Sidebar.
const USE_COCOA_LAYOUT = true;

// Feature flag for the v2 sidebar rail (collapsible groups, favorites,
// recents, role gating). Defaults to false because the v2 config still has
// less surface area than the legacy `backOfficeNavigationGroups` (e.g. it is
// missing PersonaLandingScreen and some niche entries). When this is `false`
// the shell renders the v1 `CocoaSidebar` driven by the legacy nav groups so
// users keep full access to every screen while the v2 catalogue catches up.
const USE_SIDEBAR_V2 = false;

// Map a SearchHit to a concrete URL path for detail screens. The handler is
// loose by design — most workspaces just need the entity id appended.
function buildHitPath(hit: SearchHit): string | null {
  switch (hit.kind) {
    case "reservation":
      return hit.params?.reservationId ? `/backoffice/reservations/${hit.params.reservationId}` : "/backoffice/reservations";
    case "guest":
      return hit.params?.guestId ? `/backoffice/guests/${hit.params.guestId}` : "/backoffice/guests";
    case "room":
      return "/backoffice/configuration/rooms";
    case "folio":
      return "/backoffice/finance/folio-routing";
    case "invoice":
      return "/backoffice/billing/invoices";
    case "property":
      return "/backoffice/portfolio";
    case "rate_plan":
      return "/backoffice/revenue/recommendations";
    default:
      return null;
  }
}

// --- Cocoa right-slot inline components ------------------------------------

type SwitchableProperty = {
  id: string;
  name: string;
  organizationId: string;
  organizationName?: string;
  municipality?: string | null;
  province?: string | null;
  status?: string | null;
};

function PropertySwitcher() {
  // Mirrors the property dropdown in the legacy TopBar but rendered inside the
  // CocoaToolbar leftSlot. We talk to /properties directly (same as TopBar) and
  // persist via setActiveProperty, which already triggers a reload on change.
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
    apiRequest<SwitchableProperty[]>("/properties")
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
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
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
        <span style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
      <span>{theme === "light" ? "Claro" : theme === "dark" ? "Oscuro" : "Auto"}</span>
    </button>
  );
}

// --- Resume Onboarding banner ----------------------------------------------
// Persistent shell banner that nudges users back into the setup flow when
// onboarding hasn't been marked complete yet. The signal lives in
// localStorage under the `onboarding-complete` key and is set to "true" once
// the wizard / Setup Center declares the property ready to go live. The banner
// hides itself the moment that flag flips so we don't overload the shell with
// noise once the property is fully configured.
const ONBOARDING_COMPLETE_KEY = "onboarding-complete";

function readOnboardingComplete(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true";
  } catch {
    // localStorage may throw in private mode / restricted contexts; default to
    // "complete" so we never block the shell with a banner the user can't act
    // on (they can't persist the dismissal anyway).
    return true;
  }
}

function ResumeOnboardingBanner() {
  const [complete, setComplete] = useState<boolean>(() => readOnboardingComplete());

  useEffect(() => {
    // Re-evaluate when other tabs/windows or other parts of the app flip the
    // flag (e.g. once the Setup Center marks all required steps green).
    function onStorage(event: StorageEvent) {
      if (event.key === ONBOARDING_COMPLETE_KEY) {
        setComplete(readOnboardingComplete());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  if (complete) return null;

  function resume() {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "SetupCenterScreen" }));
  }

  return (
    <div
      role="region"
      aria-label="Onboarding pendiente"
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
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          Tu configuración inicial aún no está completa.
        </span>
      </div>
      <button
        type="button"
        onClick={resume}
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
        Continuar configuración
      </button>
    </div>
  );
}

function NotificationsBell() {
  // Matched to the ThemeToggle visual contract so the right-slot row looks
  // intentional rather than a stray icon. Same height + border + radius.
  return (
    <button
      type="button"
      aria-label="Notificaciones"
      title="Notificaciones"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        background: "var(--cocoa-background-control)",
        border: "1px solid var(--cocoa-separator)",
        borderRadius: "var(--cocoa-radius-md)",
        color: "var(--cocoa-label)",
        cursor: "pointer"
      }}
    >
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none" aria-hidden>
        <path d="M14 11V8a5 5 0 1 0-10 0v3l-1.5 2h13L14 11Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M7 15a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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

function UserAvatar() {
  const [user, setUser] = useState<AuthUser | null>(() => getUser());
  const [open, setOpen] = useState(false);
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
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
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
          padding: "2px 8px 2px 2px",
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
        <span style={{ maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName}</span>
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
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              clearSession();
            }}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "6px 8px",
              background: "transparent",
              border: "none",
              borderRadius: "var(--cocoa-radius-sm)",
              color: "inherit",
              font: "inherit",
              cursor: "pointer"
            }}
          >
            Cerrar sesión
          </button>
        </div>
      ) : null}
    </div>
  );
}

// Build SidebarV2 groups by feeding the v2 renderer with the full legacy
// `backOfficeNavigationGroups` catalogue. The v2 config alone is missing many
// screens (AI Operations, Channel Manager, CRM, F&B Inventory, etc.) which
// would leave the sidebar incomplete. By rebuilding from the legacy tree we
// keep the v2 Cocoa look while restoring the entire surface area users expect.
function buildLegacySidebarV2Groups(): SidebarV2Group[] {
  return backOfficeNavigationGroups
    .map((group): SidebarV2Group => {
      const items: SidebarV2Item[] = [];
      const pushItem = (item: BackOfficeNavItem) => {
        if (item.placeholder) return;
        items.push({
          id: item.screen,
          label: item.label,
          screen: item.screen
        });
      };
      if (group.items) {
        for (const item of group.items) pushItem(item);
      }
      if (group.subgroups) {
        for (const sg of group.subgroups) {
          for (const item of sg.items) pushItem(item);
        }
      }
      // Cast the loose string id to the curated `SidebarGroupId` union; the
      // v2 renderer only uses this as a stable key, it does not switch on it.
      return {
        id: group.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") as SidebarV2Group["id"],
        label: group.title,
        items
      };
    })
    .filter((g) => g.items.length > 0);
}

const LEGACY_V2_GROUPS: SidebarV2Group[] = buildLegacySidebarV2Groups();

// Build a flat lookup from every screen id (across BOTH v2 config and legacy
// groups) to the corresponding `SidebarItem` shape. We need this because the
// favorites/recent hooks persist *screen ids only* (strings), but the sidebar
// renders them as full items (label + shortcut + icon). The map is computed
// once at module load; reads are O(1).
const SIDEBAR_V2_ITEM_BY_SCREEN: Record<string, SidebarV2Item> = (() => {
  const map: Record<string, SidebarV2Item> = {};
  for (const group of SIDEBAR_V2_CONFIG) {
    for (const item of group.items) {
      map[item.screen] = item;
    }
  }
  for (const group of LEGACY_V2_GROUPS) {
    for (const item of group.items) {
      if (!map[item.screen]) map[item.screen] = item;
    }
  }
  return map;
})();

function hydrateScreens(screenIds: string[]): SidebarV2Item[] {
  const items: SidebarV2Item[] = [];
  for (const screen of screenIds) {
    const match = SIDEBAR_V2_ITEM_BY_SCREEN[screen];
    if (match !== undefined) items.push(match);
  }
  return items;
}

export function BackOfficeLayout(props: { activeScreen: string; onSelect: (screen: string) => void; children: ReactNode }) {
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");

  // Sidebar v2 state: persistent favorites + recents and a role-filtered view
  // of the config. The role is derived from the cached auth user; when no
  // session exists (e.g. demo mode) we leave it undefined and the role gate
  // falls back to "show everything that has no `rolesAllowed`".
  const currentUser = getUser();
  const currentUserRole =
    (currentUser as (AuthUser & { role?: string }) | null)?.role ?? undefined;
  const { favorites, toggleFavorite } = useSidebarFavorites();
  const { recent, pushRecent } = useSidebarRecent();
  // Source of truth for the sidebar groups: when `USE_SIDEBAR_V2` is true we
  // drive the rail from the curated v2 catalogue; otherwise we fall back to
  // the full legacy tree converted to v2 item shapes so users keep access to
  // every screen (AI Operations, Channel Manager, CRM, F&B Inventory, etc.)
  // that the v2 config hasn't catalogued yet.
  const sourceGroups = USE_SIDEBAR_V2 ? SIDEBAR_V2_CONFIG : LEGACY_V2_GROUPS;
  const filteredGroups = useSidebarRoleFilter(sourceGroups, currentUserRole);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const isMeta = event.metaKey || event.ctrlKey;
      if (isMeta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCmdkOpen((open) => !open);
      }
      if (event.key === "Escape") setNavOpen(false);
    }
    function onOpenSearch() {
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

  // Map an entity hit to a concrete URL + navigation event. Detail screens
  // read their id from the URL, so we push the path first then dispatch the
  // nav event so React re-mounts the right component.
  function selectHit(hit: SearchHit) {
    setNavOpen(false);
    const path = buildHitPath(hit);
    if (path && window.location.pathname !== path) {
      window.history.pushState(null, "", path);
    }
    // Nav event drives SCREEN_COMPONENTS swap in App.tsx (no full reload).
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: hit.screen }));
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
        <TopBar onOpenCommandPalette={() => setCmdkOpen(true)} onOpenNav={() => setNavOpen(true)} />
        <ResumeOnboardingBanner />
        <section className="bo-workspace">{props.children}</section>
        <CommandPalette
          open={cmdkOpen}
          onClose={() => setCmdkOpen(false)}
          onSelect={(screen) => selectAndClose(screen)}
          onSelectHit={(hit) => selectHit(hit)}
        />
        <GuideProvider />
      </main>
    );
  }

  // --- Cocoa-migrated shell -------------------------------------------------
  // Hydrate the persisted screen ids into full sidebar items so the v2 rail
  // can render labels + shortcuts for favorites/recents. Items whose screen
  // no longer exists in the config are silently dropped (e.g. after a config
  // rename).
  const favoriteItems = hydrateScreens(favorites);
  const recentItems = hydrateScreens(recent);

  // The Cocoa search field is local-state only; pressing Enter or ⌘K still
  // routes through the existing CommandPalette so callers don't lose the
  // shared search index + hit routing.
  function handleSearchChange(next: string) {
    setSearchValue(next);
  }

  // Sidebar v2 navigation: route the click *and* record the screen in the
  // recents stack so the pinned section reflects the actual usage pattern.
  function handleSidebarNavigate(screen: string) {
    pushRecent(screen);
    selectAndClose(screen);
  }

  return (
    <div className="cocoa-shell" data-route-base="/backoffice">
      <CocoaToolbar
        showTrafficLights
        title="Anfitorio"
        leftSlot={<PropertySwitcher />}
        rightSlot={
          <>
            <CocoaToolbarSearchField
              value={searchValue}
              onChange={handleSearchChange}
              placeholder="Buscar…"
              expandOnFocus
            />
            <button
              type="button"
              aria-label="Abrir paleta de comandos"
              title="Abrir paleta de comandos (⌘K)"
              onClick={() => setCmdkOpen(true)}
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
            <UserAvatar />
          </>
        }
      />
      <ResumeOnboardingBanner />
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <CocoaSplitView
          sidebar={
            <Sidebar
              activeScreen={props.activeScreen}
              onSelect={(screen) => {
                pushRecent(screen);
                selectAndClose(screen);
              }}
              open={navOpen}
              onClose={() => setNavOpen(false)}
            />
          }
          content={<main className="cocoa-content">{props.children}</main>}
        />
      </div>
      <CommandPalette
        open={cmdkOpen}
        onClose={() => setCmdkOpen(false)}
        onSelect={(screen) => selectAndClose(screen)}
        onSelectHit={(hit) => selectHit(hit)}
      />
      <GuideProvider />
    </div>
  );
}
