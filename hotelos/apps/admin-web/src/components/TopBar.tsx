import { useEffect, useRef, useState, type ReactElement } from "react";
import { apiRequest } from "../services/api-client";
import {
  getActiveProperty,
  setActiveProperty,
  type ActiveProperty
} from "../services/activeProperty";
import { clearSession, getUser, onAuthChange, type AuthUser } from "../services/auth-storage";
import { cycleThemePreference, getThemePreference, type ThemePreference } from "../theme";
import { Spinner } from "./States";
import { openHelpCenter } from "./guide/guideStore";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

type TopBarProps = {
  onOpenCommandPalette: () => void;
  onOpenNav?: () => void;
};

type SwitchableProperty = {
  id: string;
  name: string;
  organizationId: string;
  organizationName?: string;
  municipality?: string | null;
  province?: string | null;
  status?: string | null;
};

export function TopBar(props: TopBarProps) {
  const active = getActiveProperty();
  const [open, setOpen] = useState(false);
  const [properties, setProperties] = useState<SwitchableProperty[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePreference>(() => getThemePreference());
  const [user, setUser] = useState<AuthUser | null>(() => getUser());
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => onAuthChange(() => setUser(getUser())), []);

  useEffect(() => {
    if (!userMenuOpen) return;
    function onClick(event: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) setUserMenuOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setUserMenuOpen(false);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [userMenuOpen]);

  function handleLogout() {
    setUserMenuOpen(false);
    clearSession();
  }

  const displayName = user?.fullName ?? "Sesión demo";
  const displayInitials = user ? initials(user.fullName) : "RD";

  const themeMeta: Record<ThemePreference, { label: string; icon: ReactElement }> = {
    light: {
      label: "Tema: claro",
      icon: (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
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
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
          <path
            d="M14.5 10.6A6 6 0 0 1 7.4 3.5a6 6 0 1 0 7.1 7.1Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      )
    },
    system: {
      label: "Tema: sistema",
      icon: (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
          <rect x="2.5" y="3.5" width="13" height="8.5" rx="1.3" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6.5 15h5M9 12v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    }
  };

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
    setActiveProperty(next); // persists + reloads if changed
  }

  return (
    <header className="bo-topbar">
      <button
        type="button"
        className="bo-nav-toggle"
        aria-label="Abrir/cerrar menú"
        onClick={() => props.onOpenNav?.()}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
          <path d="M2.5 5h13M2.5 9h13M2.5 13h13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      <div className="bo-property-switcher" ref={wrapRef} data-tour="property">
        <button
          type="button"
          className="bo-topbar-property"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="bo-topbar-property-name">{active.propertyName}</span>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {open ? (
          <div className="bo-property-menu" role="listbox" aria-label="Cambiar propiedad">
            <div className="bo-property-menu-head">Propiedades</div>
            {loading ? (
              <div className="bo-property-menu-empty" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Spinner size="sm" /> Cargando…
              </div>
            ) : null}
            {error ? <div className="bo-property-menu-empty bo-property-menu-error">{error}</div> : null}
            {!loading && !error && properties.length === 0 ? (
              <div className="bo-property-menu-empty">Sin propiedades</div>
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
                  className={`bo-property-option${selected ? " is-active" : ""}`}
                  onClick={() => choose(property)}
                >
                  <span className="bo-property-option-main">
                    <span className="bo-property-option-name">{property.name}</span>
                    <span className="bo-property-option-meta">
                      {property.organizationName ?? property.organizationId}
                      {location ? ` · ${location}` : ""}
                    </span>
                  </span>
                  {selected ? (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                      <path d="M2.5 7.5L5.5 10.5L11.5 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <button type="button" className="bo-topbar-search" onClick={props.onOpenCommandPalette} data-tour="search" aria-label="Buscar">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
          <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10 10L13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span>Search reservations, guests, settings...</span>
        <kbd className="bo-topbar-search-kbd">⌘K</kbd>
      </button>

      <div className="bo-topbar-actions">
        <button
          type="button"
          className="bo-icon-button"
          data-tour="help"
          aria-label="Ayuda y guía de recepción"
          title="Ayuda y guía"
          onClick={() => openHelpCenter()}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
            <circle cx="9" cy="9" r="6.75" stroke="currentColor" strokeWidth="1.5" />
            <path d="M7.1 7a1.9 1.9 0 0 1 3.7.6c0 1.3-1.8 1.6-1.8 2.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="9" cy="12.6" r="0.85" fill="currentColor" />
          </svg>
        </button>
        <button
          type="button"
          className="bo-theme-toggle"
          aria-label="Cambiar tema (claro/oscuro)"
          title={themeMeta[theme].label}
          onClick={() => setTheme(cycleThemePreference())}
        >
          {themeMeta[theme].icon}
        </button>
        <button type="button" className="bo-icon-button has-badge" data-tour="notifications" aria-label="Notificaciones">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
            <path d="M14 11V8a5 5 0 1 0-10 0v3l-1.5 2h13L14 11Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M7 15a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <div ref={userMenuRef} style={{ position: "relative" }}>
          <button
            type="button"
            className="bo-user-chip"
            aria-label="Menú de usuario"
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
            onClick={() => setUserMenuOpen((value) => !value)}
          >
            <span className="bo-user-chip-avatar">{displayInitials}</span>
            <span className="bo-user-chip-name">{displayName}</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {userMenuOpen ? (
            <div
              role="menu"
              aria-label="Menú de usuario"
              style={{
                position: "absolute",
                top: "calc(100% + var(--space-2))",
                right: 0,
                minWidth: 220,
                padding: "var(--space-2)",
                background: "var(--surface-1)",
                border: "1px solid var(--line, rgba(0,0,0,0.08))",
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-lg)",
                zIndex: 60
              }}
            >
              {user ? (
                <div
                  style={{
                    padding: "var(--space-2) var(--space-3)",
                    color: "var(--ink-soft)",
                    fontSize: 13,
                    borderBottom: "1px solid var(--line, rgba(0,0,0,0.06))",
                    marginBottom: "var(--space-2)"
                  }}
                >
                  <div style={{ color: "var(--ink)", fontWeight: 600 }}>{user.fullName}</div>
                  {user.email ? <div style={{ marginTop: 2 }}>{user.email}</div> : null}
                </div>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="bo-button-link"
                style={{ width: "100%", justifyContent: "flex-start" }}
                onClick={handleLogout}
              >
                Cerrar sesión
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
