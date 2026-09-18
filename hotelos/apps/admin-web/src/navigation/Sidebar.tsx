// Back Office sidebar (Tanda 5 · L1b · lote sidebar).
//
// The menu is DATA, not code: the nine domain categories, their items, tabs,
// roles and module gates come from nav-tree.generated.json (built from
// pilots/tanda5-nav-tree.csv) through `menuCategories` of ./nav-tree.ts. This
// file only renders: nothing is typed twice, no persona views, no placeholder
// flags, no module spreads, no route→screen map.
//
//   - role tokens: template keys of the ACTIVE property from GET /users/me
//     (+ `admin` for the platform administrator), see ./useEnabledModules.ts;
//   - enabled modules: session cache over GET /backoffice/properties/:id/modules;
//     while either is unknown the aside paints a skeleton (never a half menu);
//   - «Activar módulo» (§6.3): an entry hidden only by its module is dimmed for
//     users with `modules.enable` and opens Módulos e integraciones with the
//     code preselected (`ModuleManager#modulo=<code>`);
//   - «Ver como…» (§8; Tanda 8a design §5.3 «por ámbito»): whoever manages
//     users in the active scope (`gate.canViewAs`: the platform administrator,
//     or `users.assign` / `roles.manage` in the property) simulates, in memory
//     (no localStorage), the menu filter of a role of rank ≤ their own
//     (`viewAsTokensFor`) — never permissions; the token lives in
//     navigation/view-as.ts and `useNavGate` applies it, so ⌘K, the
//     containers, the guide and the router gate of App.tsx share the
//     simulation (L1c / L4);
//   - «Desarrollo» (§4.3): only with dev mode (`?dev=1` for the tab or
//     localStorage anfitorio.dev=1, navigation/dev-mode.ts, reactive) AND the
//     admin token;
//   - landing (§3): the brand block goes to `landingFor(tokens)` — the mobile
//     tab for pisos/mantenimiento under MOBILE_BREAKPOINT_PX (viewport.ts);
//   - groups (L1c): every category starts expanded so the frequent tasks of
//     §11 stay at ≤ 2 clicks; a collapse is remembered per browser
//     (navigation/nav-preferences.ts) and the group of the active screen
//     reopens when the user navigates into it.
//
// Navigation still goes through `onSelect(screenKey)` (App.tsx → hotelos-nav)
// so the screen guards keep vetoing; the URL of each entry is exposed as
// `data-nav-url` and `landingFor().url` for the router (L1b · router-app).
// Chrome hooks preserved: `data-tour="sidebar"` on the <aside>; `id`
// SIDEBAR_ELEMENT_ID is the `aria-controls` target of the drawer button.
// Skin and geometry (Cocoa 22 · ola 11, R11): every `c22-*` class below is
// painted by styles/cocoa-22-shell.css — no inline style element is injected here.

import { useEffect, useMemo, useState } from "react";
import { CocoaSkeleton } from "../components/cocoa/CocoaState";
import { ACTIONS, UI_STATES } from "../content/actions";
import { useDevMode } from "./dev-mode";
import { isGroupOpen, readGroupToggles, toggleGroup, togglesOnArrival, writeGroupToggles, type GroupToggles } from "./nav-preferences";
import { activeMenuItemFor, countMenu, enableModuleTarget, landingFor, menuCategories, menuItemMatches, type MenuCategory } from "./nav-tree";
import { ROLE_TOKEN_LABELS, ROLE_TOKEN_PRIORITY, type RoleToken } from "./role-tokens";
import { TEMPLATE_RANKS, useNavGate } from "./useEnabledModules";
import { setViewAs, viewAsTokensFor } from "./view-as";
import { useIsMobileViewport } from "./viewport";
import { BRAND } from "../config/brand";

export type SidebarProps = {
  activeScreen: string;
  onSelect: (screen: string) => void;
  open?: boolean;
  onClose?: () => void;
};

// ----------------------------------------------------------------- helpers

/** Every token «Ver como…» may offer (the platform administrator gets them all): hotel roles, broadest first (never admin or público). */
export const VIEW_AS_TOKENS: readonly RoleToken[] = ROLE_TOKEN_PRIORITY.filter((token) => token !== "admin" && token !== "publico");

/** DOM id of the <aside>: `aria-controls` of the drawer button of the layout. */
export const SIDEBAR_ELEMENT_ID = "c22-sidebar";

// ----------------------------------------------------------------- component

export function Sidebar(props: SidebarProps) {
  const gate = useNavGate();
  const mobile = useIsMobileViewport();
  const devMode = useDevMode();
  const [query, setQuery] = useState("");
  // Explicit toggles of the user (persisted per browser); everything else is open.
  const [toggled, setToggled] = useState<GroupToggles>(() => readGroupToggles());

  // «Ver como…» is applied by the gate (in memory, view-as.ts): `gate.tokens`
  // already holds the simulated token and «Activar módulo» is off meanwhile.
  const simulating = gate.viewAs !== null;
  const tokens = gate.tokens;
  // Tokens this user may simulate: rank ≤ their own (design §5.3); every hotel token for the platform administrator.
  const viewAsOptions = useMemo(
    () => viewAsTokensFor({ canViewAs: gate.canViewAs, isPlatformAdmin: gate.isPlatformAdmin, maxViewAsRank: gate.maxViewAsRank }, TEMPLATE_RANKS),
    [gate.canViewAs, gate.isPlatformAdmin, gate.maxViewAsRank]
  );

  const categories = useMemo<MenuCategory[]>(
    () => menuCategories(tokens, gate.modules, { canEnableModules: gate.canEnableModules, devMode }),
    [tokens, gate.modules, gate.canEnableModules, devMode]
  );
  const active = useMemo(() => activeMenuItemFor(props.activeScreen), [props.activeScreen]);
  const counts = useMemo(() => countMenu(categories), [categories]);

  // Arriving at a screen opens its group even if the user had collapsed it
  // (only on arrival: a collapse of the active group afterwards is respected).
  const activeCategoryKey = active?.categoryKey ?? null;
  useEffect(() => {
    setToggled((prev) => togglesOnArrival(prev, activeCategoryKey));
  }, [activeCategoryKey]);
  useEffect(() => {
    writeGroupToggles(toggled);
  }, [toggled]);

  const q = query.trim();
  const shown = useMemo(
    () =>
      categories
        .map((category) => ({ category, items: category.items.filter((item) => menuItemMatches(item, q)) }))
        .filter((entry) => entry.items.length > 0),
    [categories, q]
  );

  function isOpen(category: MenuCategory): boolean {
    return isGroupOpen({ key: category.key, toggled, searching: q.length > 0 });
  }

  function toggle(category: MenuCategory) {
    setToggled(toggleGroup(toggled, category.key, isOpen(category)));
  }

  function select(screen: string) {
    props.onSelect(screen);
    props.onClose?.();
  }

  function goHome() {
    select(landingFor(tokens, { mobile, templateKey: gate.templateKey }).screenKey);
  }

  const noRole = gate.known && !gate.loading && tokens.length === 0;

  return (
    <aside id={SIDEBAR_ELEMENT_ID} className={`c22-sidebar${props.open ? " open" : ""}`} aria-label="Navegación del Back Office" data-tour="sidebar" aria-busy={gate.loading}>
      <button type="button" className="c22-sidebar-close" aria-label="Cerrar el menú" onClick={() => props.onClose?.()}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      <button type="button" className="c22-brand-home" onClick={goHome} title="Ir a mi página de inicio" aria-label="Ir a mi página de inicio">
        <div className="c22-brand">
          <span aria-hidden="true">
            <svg viewBox="0 0 512 512" width="22" height="22" focusable="false">
              <path d="M394 262 V212 A104 104 0 0 0 290 108 H222 A104 104 0 0 0 118 212 V318 A104 104 0 0 0 222 422 H290 A104 104 0 0 0 366 389" fill="none" stroke="currentColor" strokeWidth="54" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M118 262 H394" fill="none" stroke="currentColor" strokeWidth="54" strokeLinecap="round" />
            </svg>
          </span>
          <div>
            <strong>{BRAND.name}</strong>
            <small>Back Office</small>
          </div>
        </div>
      </button>

      {gate.canViewAs && viewAsOptions.length > 0 ? (
        <div className="c22-role-switcher">
          <label htmlFor="c22-view-as">Ver como…</label>
          <div className="c22-role-select-wrap">
            <select
              id="c22-view-as"
              value={gate.viewAs ?? ""}
              onChange={(event) => setViewAs(event.target.value as RoleToken | "")}
              aria-label="Ver el menú como otro rol (solo cambia el menú, no los permisos)"
            >
              <option value="">{gate.isPlatformAdmin ? "Mi menú (administrador)" : "Mi menú"}</option>
              {viewAsOptions.map((token) => (
                <option key={token} value={token}>
                  {ROLE_TOKEN_LABELS[token]}
                </option>
              ))}
            </select>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>
      ) : null}
      {simulating && gate.viewAs ? (
        <div className="c22-nav-viewas-badge" role="status">
          Viendo como {ROLE_TOKEN_LABELS[gate.viewAs]} · solo menú
          <button type="button" onClick={() => setViewAs("")}>
            Salir
          </button>
        </div>
      ) : null}

      <div className="c22-sidebar-search">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar en el menú"
          aria-label="Buscar en la navegación"
        />
      </div>

      {gate.loading ? (
        <div className="c22-nav-skeleton" role="status" aria-label={UI_STATES.loading.title}>
          <CocoaSkeleton variant="text" lines={9} height={14} />
        </div>
      ) : null}

      {!gate.loading && noRole ? (
        <div className="c22-nav-notice" role="status">
          <strong>{UI_STATES.noRole.title}</strong>
          {UI_STATES.noRole.message}
        </div>
      ) : null}

      {!gate.loading && gate.error ? (
        <div className="c22-nav-notice" role="alert">
          <strong>{UI_STATES.error.title}</strong>
          No se han podido leer los módulos activos: las entradas que dependen de un módulo no se muestran.
          <button type="button" onClick={gate.refresh}>
            {ACTIONS.retry}
          </button>
        </div>
      ) : null}

      {!gate.loading && q && shown.length === 0 ? (
        <div className="c22-nav-notice" role="status">
          <strong>{UI_STATES.noResults.title}</strong>
          Ninguna entrada del menú coincide con «{q}».
        </div>
      ) : null}

      {!gate.loading
        ? shown.map(({ category, items }) => {
            const open = isOpen(category);
            return (
              <section key={category.key} className={`c22-nav-group${open ? " open" : ""}`} data-nav-category={category.key}>
                <button type="button" className="c22-nav-group-head" onClick={() => toggle(category)} aria-expanded={open}>
                  <span className="c22-nav-group-title">{category.label}</span>
                  {category.devOnly ? <span className="c22-nav-group-badge">dev</span> : null}
                  <span className="c22-nav-count" aria-label={`${items.length} entradas`}>
                    {items.length}
                  </span>
                  <span className="c22-nav-chevron" aria-hidden>
                    {open ? "▾" : "▸"}
                  </span>
                </button>
                {open ? (
                  <div className="c22-nav-group-body">
                    <div className="c22-nav-section">
                      {items.map((item) => {
                        const isActive = active?.screenKey === item.screenKey && active?.categoryKey === category.key;
                        if (item.visibility === "locked") {
                          return (
                            <div
                              key={item.screenKey}
                              className="c22-nav-item locked"
                              data-nav-item={item.screenKey}
                              data-nav-url={item.url}
                              data-nav-locked={item.lockedBy.join(",")}
                              title={`${UI_STATES.moduleDisabled.title}: ${UI_STATES.moduleDisabled.message}`}
                            >
                              <span className="c22-nav-item-label">{item.label}</span>
                              <button
                                type="button"
                                className="c22-nav-unlock"
                                onClick={() => select(enableModuleTarget(item))}
                                aria-label={`${ACTIONS.enableModule} para ${item.label}`}
                              >
                                {ACTIONS.enableModule}
                              </button>
                            </div>
                          );
                        }
                        return (
                          <button
                            key={item.screenKey}
                            type="button"
                            className={`c22-nav-item${isActive ? " active" : ""}`}
                            data-nav-item={item.screenKey}
                            data-nav-url={item.url}
                            aria-current={isActive ? "page" : undefined}
                            onClick={() => select(item.screenKey)}
                          >
                            <span className="c22-nav-item-label">{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </section>
            );
          })
        : null}

      {!gate.loading && !q && counts.items > 0 ? (
        <p className="c22-nav-counts" data-nav-counts={`${counts.categories}/${counts.items}/${counts.locked}`}>
          {counts.categories} {counts.categories === 1 ? "categoría" : "categorías"} · {counts.items} {counts.items === 1 ? "entrada" : "entradas"}
          {counts.locked > 0 ? ` · ${counts.locked} por activar` : ""}
        </p>
      ) : null}
    </aside>
  );
}
