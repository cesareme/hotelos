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
//   - «Ver como…» (§8): only the platform administrator, in memory (no
//     localStorage), simulates the menu filter of a role — never permissions;
//     the token lives in navigation/view-as.ts and `useNavGate` applies it, so
//     ⌘K, the containers and the guide share the simulation (L1c);
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

import { useEffect, useMemo, useState } from "react";
import { ACTIONS, UI_STATES } from "../content/actions";
import { useDevMode } from "./dev-mode";
import { isGroupOpen, readGroupToggles, toggleGroup, togglesOnArrival, writeGroupToggles, type GroupToggles } from "./nav-preferences";
import { activeMenuItemFor, countMenu, enableModuleTarget, landingFor, menuCategories, menuItemMatches, type MenuCategory } from "./nav-tree";
import { ROLE_TOKEN_LABELS, ROLE_TOKEN_PRIORITY, type RoleToken } from "./role-tokens";
import { useNavGate } from "./useEnabledModules";
import { setViewAs } from "./view-as";
import { useIsMobileViewport } from "./viewport";

export type SidebarProps = {
  activeScreen: string;
  onSelect: (screen: string) => void;
  open?: boolean;
  onClose?: () => void;
};

// ----------------------------------------------------------------- helpers

/** Tokens offered by «Ver como…»: every hotel role, broadest first (never admin or público). */
export const VIEW_AS_TOKENS: readonly RoleToken[] = ROLE_TOKEN_PRIORITY.filter((token) => token !== "admin" && token !== "publico");

/** DOM id of the <aside>: `aria-controls` of the drawer button of the layout. */
export const SIDEBAR_ELEMENT_ID = "bo-sidebar";

// Cocoa 22 skin of the sidebar (COCOA-22.md §2 tokens, §3.1 shell): every
// colour, radius, shadow and type size below is a --cocoa-* token and the
// rules are UNLAYERED, so they win over the legacy `.bo-sidebar` skin of
// styles.css (@layer cocoa-legacy) without touching that sheet. Only the
// look lives here: positioning (drawer under 900 px), the class names and the
// menu logic are unchanged. Focus: one 3 px Esmeralda ring everywhere.
const SIDEBAR_CSS = `
.bo-sidebar { background: var(--cocoa-background-sidebar); border-right: 1px solid var(--cocoa-separator); color: var(--cocoa-label); font-family: var(--cocoa-font); padding: var(--cocoa-space-5) var(--cocoa-space-3); scrollbar-color: var(--cocoa-separator) transparent; }
.bo-sidebar::-webkit-scrollbar-thumb { background: var(--cocoa-separator); border-radius: var(--cocoa-radius-full); }
.bo-sidebar .bo-brand { gap: var(--cocoa-space-3); margin-bottom: var(--cocoa-space-5); padding: 0 var(--cocoa-space-3); }
.bo-sidebar .bo-brand span { width: 36px; height: 36px; border-radius: var(--cocoa-radius-md); background: var(--cocoa-accent); color: var(--cocoa-accent-contrast); font-weight: var(--cocoa-fw-bold); font-size: var(--cocoa-fs-title-2); box-shadow: var(--cocoa-shadow-control); }
.bo-sidebar .bo-brand strong { font-size: var(--cocoa-fs-title-3); font-weight: var(--cocoa-fw-bold); color: var(--cocoa-label); letter-spacing: var(--cocoa-tracking-tight); }
.bo-sidebar .bo-brand small { font-size: var(--cocoa-fs-subheadline); font-weight: var(--cocoa-fw-medium); color: var(--cocoa-label-secondary); }
.bo-sidebar .bo-brand-home { display: flex; width: 100%; text-align: left; background: transparent; border: none; padding: 0; color: inherit; font: inherit; cursor: pointer; border-radius: var(--cocoa-radius-md); }
.bo-sidebar .bo-sidebar-search { gap: var(--cocoa-space-2); padding: 6px 10px; border-radius: var(--cocoa-radius-md); background: var(--cocoa-background-control); border: 1px solid var(--cocoa-separator); margin-bottom: var(--cocoa-space-4); transition: border-color var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-fast) var(--cocoa-ease-out); }
.bo-sidebar .bo-sidebar-search:focus-within { border-color: var(--cocoa-accent); box-shadow: 0 0 0 3px var(--cocoa-focus-ring); }
.bo-sidebar .bo-sidebar-search input { font-size: var(--cocoa-fs-body); color: var(--cocoa-label); font-family: var(--cocoa-font); }
.bo-sidebar .bo-sidebar-search input::placeholder { color: var(--cocoa-label-secondary); }
.bo-sidebar .bo-role-switcher label { font-size: var(--cocoa-fs-caption); font-weight: var(--cocoa-fw-semibold); letter-spacing: var(--cocoa-tracking-wide); color: var(--cocoa-label-secondary); }
.bo-sidebar .bo-role-select-wrap select { min-height: 32px; border-radius: var(--cocoa-radius-md); border: 1px solid var(--cocoa-accent-border); background: var(--cocoa-accent-bg); color: var(--cocoa-label); font-family: var(--cocoa-font); font-size: var(--cocoa-fs-body); font-weight: var(--cocoa-fw-semibold); }
.bo-sidebar .bo-role-select-wrap select:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--cocoa-focus-ring); }
.bo-sidebar .bo-role-select-wrap svg { color: var(--cocoa-tone-accent-text); }
.bo-sidebar .bo-nav-group-head { padding: var(--cocoa-space-2) var(--cocoa-space-3); border-radius: var(--cocoa-radius-md); color: var(--cocoa-label-secondary); font-family: var(--cocoa-font); font-size: var(--cocoa-fs-subheadline); font-weight: var(--cocoa-fw-bold); letter-spacing: 0.06em; transition: background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), color var(--cocoa-duration-fast) var(--cocoa-ease-out); }
.bo-sidebar .bo-nav-group-head:hover { background: var(--cocoa-fill-tertiary); color: var(--cocoa-label); }
.bo-sidebar .bo-nav-group-badge { font-size: var(--cocoa-fs-caption); font-weight: var(--cocoa-fw-semibold); color: var(--cocoa-tone-accent-text); background: var(--cocoa-accent-bg); border-radius: var(--cocoa-radius-sm); letter-spacing: var(--cocoa-tracking-wide); }
.bo-sidebar .bo-nav-chevron { color: var(--cocoa-label-tertiary); font-size: var(--cocoa-fs-caption); }
.bo-sidebar .bo-nav-count { font-size: var(--cocoa-fs-caption); font-weight: var(--cocoa-fw-semibold); color: var(--cocoa-label-secondary); background: var(--cocoa-background-control); border: 1px solid var(--cocoa-separator); border-radius: var(--cocoa-radius-full); font-variant-numeric: tabular-nums; }
.bo-sidebar .bo-nav-section.nested { border-left-color: var(--cocoa-separator); }
.bo-sidebar .bo-nav-item { color: var(--cocoa-label); padding: 9px var(--cocoa-space-3); min-height: 38px; border-radius: var(--cocoa-radius-md); font-family: var(--cocoa-font); font-size: var(--cocoa-fs-body); font-weight: var(--cocoa-fw-medium); transition: background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), color var(--cocoa-duration-fast) var(--cocoa-ease-out); }
.bo-sidebar .bo-nav-item:hover { background: var(--cocoa-fill-tertiary); color: var(--cocoa-label); }
.bo-sidebar .bo-nav-item.active { background: var(--cocoa-accent-bg); color: var(--cocoa-tone-accent-text); font-weight: var(--cocoa-fw-semibold); }
.bo-sidebar .bo-nav-item.active::before { background: var(--cocoa-accent); border-radius: var(--cocoa-radius-full); }
.bo-sidebar .bo-nav-item.locked { opacity: 0.6; cursor: default; justify-content: space-between; gap: var(--cocoa-space-2); }
.bo-sidebar .bo-nav-item.locked:hover { background: transparent; color: var(--cocoa-label); }
.bo-sidebar .bo-nav-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bo-sidebar .bo-nav-unlock { flex: none; font: inherit; font-size: var(--cocoa-fs-subheadline); font-weight: var(--cocoa-fw-semibold); padding: 2px 8px; border-radius: var(--cocoa-radius-full); border: 1px solid var(--cocoa-separator); background: var(--cocoa-background-control); color: var(--cocoa-tone-accent-text); cursor: pointer; }
.bo-sidebar .bo-nav-unlock:hover { background: var(--cocoa-accent-bg); }
.bo-sidebar .bo-nav-notice { margin: 0 4px var(--cocoa-space-3); padding: 10px 12px; border-radius: var(--cocoa-radius-md); background: var(--cocoa-fill-quaternary); color: var(--cocoa-label-secondary); font-size: var(--cocoa-fs-callout); line-height: 1.4; }
.bo-sidebar .bo-nav-notice strong { display: block; color: var(--cocoa-label); margin-bottom: 2px; }
.bo-sidebar .bo-nav-notice button { margin-top: 6px; font: inherit; font-size: var(--cocoa-fs-callout); font-weight: var(--cocoa-fw-semibold); background: transparent; border: none; color: var(--cocoa-tone-accent-text); cursor: pointer; padding: 0; border-radius: var(--cocoa-radius-sm); }
.bo-sidebar .bo-nav-skeleton { display: flex; flex-direction: column; gap: 10px; padding: 4px 12px; }
.bo-sidebar .bo-nav-skeleton .bo-skeleton { height: 14px; border-radius: var(--cocoa-radius-md); }
.bo-sidebar .bo-nav-viewas-badge { display: inline-flex; align-items: center; gap: 6px; margin: 0 4px var(--cocoa-space-3); padding: 4px 8px; border-radius: var(--cocoa-radius-full); background: var(--cocoa-accent-bg); color: var(--cocoa-tone-accent-text); font-size: var(--cocoa-fs-subheadline); font-weight: var(--cocoa-fw-semibold); }
.bo-sidebar .bo-nav-viewas-badge button { font: inherit; font-size: var(--cocoa-fs-subheadline); background: transparent; border: none; color: inherit; cursor: pointer; text-decoration: underline; padding: 0; border-radius: var(--cocoa-radius-sm); }
.bo-sidebar .bo-nav-counts { margin: var(--cocoa-space-3) var(--cocoa-space-3) 0; font-size: var(--cocoa-fs-subheadline); color: var(--cocoa-label-secondary); font-variant-numeric: tabular-nums; }
.bo-sidebar .bo-sidebar-close { border-radius: var(--cocoa-radius-md); border: 1px solid var(--cocoa-separator); background: var(--cocoa-background-control); color: var(--cocoa-label); }
.bo-sidebar .bo-brand-home:focus-visible, .bo-sidebar .bo-nav-group-head:focus-visible, .bo-sidebar .bo-nav-item:focus-visible, .bo-sidebar .bo-nav-unlock:focus-visible, .bo-sidebar .bo-nav-notice button:focus-visible, .bo-sidebar .bo-nav-viewas-badge button:focus-visible, .bo-sidebar .bo-sidebar-close:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--cocoa-focus-ring); }
`;

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
    <aside id={SIDEBAR_ELEMENT_ID} className={`bo-sidebar${props.open ? " open" : ""}`} aria-label="Navegación del Back Office" data-tour="sidebar" aria-busy={gate.loading}>
      <style>{SIDEBAR_CSS}</style>
      <button type="button" className="bo-sidebar-close" aria-label="Cerrar el menú" onClick={() => props.onClose?.()}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      <button type="button" className="bo-brand-home" onClick={goHome} title="Ir a mi página de inicio" aria-label="Ir a mi página de inicio">
        <div className="bo-brand">
          <span>A</span>
          <div>
            <strong>Anfitorio</strong>
            <small>Back Office</small>
          </div>
        </div>
      </button>

      {gate.isPlatformAdmin ? (
        <div className="bo-role-switcher">
          <label htmlFor="bo-view-as">Ver como…</label>
          <div className="bo-role-select-wrap">
            <select
              id="bo-view-as"
              value={gate.viewAs ?? ""}
              onChange={(event) => setViewAs(event.target.value as RoleToken | "")}
              aria-label="Ver el menú como otro rol (solo cambia el menú, no los permisos)"
            >
              <option value="">Mi menú (administrador)</option>
              {VIEW_AS_TOKENS.map((token) => (
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
        <div className="bo-nav-viewas-badge" role="status">
          Viendo como {ROLE_TOKEN_LABELS[gate.viewAs]}
          <button type="button" onClick={() => setViewAs("")}>
            Salir
          </button>
        </div>
      ) : null}

      <div className="bo-sidebar-search">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar en el menú"
          aria-label="Buscar en la navegación"
        />
      </div>

      {gate.loading ? (
        <div className="bo-nav-skeleton" role="status" aria-label={UI_STATES.loading.title}>
          {Array.from({ length: 9 }, (_, index) => (
            <span key={index} className={`bo-skeleton bo-skeleton-text${index % 3 === 0 ? " short" : index % 3 === 1 ? " medium" : ""}`} />
          ))}
        </div>
      ) : null}

      {!gate.loading && noRole ? (
        <div className="bo-nav-notice" role="status">
          <strong>{UI_STATES.noRole.title}</strong>
          {UI_STATES.noRole.message}
        </div>
      ) : null}

      {!gate.loading && gate.error ? (
        <div className="bo-nav-notice" role="alert">
          <strong>{UI_STATES.error.title}</strong>
          No se han podido leer los módulos activos: las entradas que dependen de un módulo no se muestran.
          <button type="button" onClick={gate.refresh}>
            {ACTIONS.retry}
          </button>
        </div>
      ) : null}

      {!gate.loading && q && shown.length === 0 ? (
        <div className="bo-nav-notice" role="status">
          <strong>{UI_STATES.noResults.title}</strong>
          Ninguna entrada del menú coincide con «{q}».
        </div>
      ) : null}

      {!gate.loading
        ? shown.map(({ category, items }) => {
            const open = isOpen(category);
            return (
              <section key={category.key} className={`bo-nav-group${open ? " open" : ""}`} data-nav-category={category.key}>
                <button type="button" className="bo-nav-group-head" onClick={() => toggle(category)} aria-expanded={open}>
                  <span className="bo-nav-group-title">{category.label}</span>
                  {category.devOnly ? <span className="bo-nav-group-badge">dev</span> : null}
                  <span className="bo-nav-count" aria-label={`${items.length} entradas`}>
                    {items.length}
                  </span>
                  <span className="bo-nav-chevron" aria-hidden>
                    {open ? "▾" : "▸"}
                  </span>
                </button>
                {open ? (
                  <div className="bo-nav-group-body">
                    <div className="bo-nav-section">
                      {items.map((item) => {
                        const isActive = active?.screenKey === item.screenKey && active?.categoryKey === category.key;
                        if (item.visibility === "locked") {
                          return (
                            <div
                              key={item.screenKey}
                              className="bo-nav-item locked"
                              data-nav-item={item.screenKey}
                              data-nav-url={item.url}
                              data-nav-locked={item.lockedBy.join(",")}
                              title={`${UI_STATES.moduleDisabled.title}: ${UI_STATES.moduleDisabled.message}`}
                            >
                              <span className="bo-nav-item-label">{item.label}</span>
                              <button
                                type="button"
                                className="bo-nav-unlock"
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
                            className={`bo-nav-item${isActive ? " active" : ""}`}
                            data-nav-item={item.screenKey}
                            data-nav-url={item.url}
                            aria-current={isActive ? "page" : undefined}
                            onClick={() => select(item.screenKey)}
                          >
                            <span className="bo-nav-item-label">{item.label}</span>
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
        <p className="bo-nav-counts" data-nav-counts={`${counts.categories}/${counts.items}/${counts.locked}`}>
          {counts.categories} {counts.categories === 1 ? "categoría" : "categorías"} · {counts.items} {counts.items === 1 ? "entrada" : "entradas"}
          {counts.locked > 0 ? ` · ${counts.locked} por activar` : ""}
        </p>
      ) : null}
    </aside>
  );
}
