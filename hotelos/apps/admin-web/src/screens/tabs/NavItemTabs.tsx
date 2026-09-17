// Generic routed tab container for ONE item of the tree (Tanda 5 · L1a · lote tabs-a).
//
// Renders, in this order: one CocoaPageHeader (eyebrow = category — extended
// with the qualifier a hosted screen registers through useHostedEyebrow when
// it starts with that category, «Finanzas · CELUISMA S.A.», see
// containerEyebrow —, title = item label, optional subtitle/actions), the
// module-list error when the gate
// could not read it, and CocoaRouteTabs with the tabs built from the JSON item
// (`buildItemTabs`), the role/module gate (`useNavGate`) and the landing per
// role (`landingKeysFor` → landingTabFor of nav-tree.ts). Screens hosted here
// read `useTabHost()` to drop their own page header. A strip with a single
// painted tab (Huéspedes on the list, Compras with the module off) is hidden
// with CSS: one tab is not a choice.
//
// When NO tab passes the gate the container says why (qa#12): «Módulo no
// activado» with «Activar módulo» (same target as the Sidebar, §6.3) when the
// item is for this profile but its module is off, an honest «no hemos podido
// comprobar los módulos» when the list is not readable, and «Sin acceso» only
// when the role gate is the cause — never the generic text of CocoaRouteTabs.

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaRouteTabs, CocoaTabSkeleton, type CocoaRouteTab } from "../../components/cocoa/CocoaRouteTabs";
import { CocoaState } from "../../components/cocoa/CocoaState";
import { ACTIONS, errorStateFor } from "../../content/actions";
import { navigateTo } from "../../lib/navigate";
import { useNavGate } from "../../navigation/useEnabledModules";
// Kept apart from the line above: tests/sidebar-nav-contract asserts the gate import literally (L1c).
import { forbiddenModuleLists } from "../../navigation/useEnabledModules";
import { getActivePropertyId } from "../../services/activeProperty";
import { enableModuleHash } from "../operations/module-gate";
import { TabHostProvider } from "./TabHost";
import { buildItemTabs, containerEyebrow, emptyTabsCopy, emptyTabsReason, itemForScreen, landingKeysFor, unlockingModulesFor, type TabLoaders } from "./nav-item-tabs";
import { usePathname } from "./usePathname";

export type NavItemTabsProps = {
  /** Item screen key of the tree (`FrontDeskDashboard`). */
  screenKey: string;
  /** Lazy loader per screen key (base and tabs); define at module scope. */
  loaders: TabLoaders;
  /** Roles of the base tab when narrower than the item roles. */
  baseRoles?: readonly string[];
  subtitle?: string;
  actions?: ReactNode;
  /** Drops tabs the container does not want in a given URL (e.g. Cronología of a guest being created). */
  tabFilter?: (tab: CocoaRouteTab, params: { pathname: string }) => boolean;
};

const STRIP_CSS = `.anf-nav-tabs [role="tablist"]:has(> [role="tab"]:only-child) { display: none; }`;

const stackStyle = { display: "flex", flexDirection: "column", gap: "var(--cocoa-space-5)", minWidth: 0 } as const;

export function NavItemTabs(props: NavItemTabsProps) {
  const { screenKey, loaders, baseRoles, subtitle, actions, tabFilter } = props;
  const { category, item } = useMemo(() => itemForScreen(screenKey), [screenKey]);
  // Same property the gate reads, so the remembered 403 of GET /modules is looked up for it (as useScreenModuleGate does).
  const propertyId = getActivePropertyId();
  const gate = useNavGate(propertyId);
  const pathname = usePathname();

  const tabs = useMemo(() => {
    const built = buildItemTabs(item, loaders, { pathname, baseRoles });
    return tabFilter ? built.filter((tab) => tabFilter(tab, { pathname })) : built;
  }, [item, loaders, pathname, baseRoles, tabFilter]);

  const landing = useMemo(
    () => landingKeysFor(item, tabs, gate.tokens, gate.modules, { templateKey: gate.templateKey }),
    [item, tabs, gate.tokens, gate.modules, gate.templateKey]
  );

  const isVisible = useCallback((tab: CocoaRouteTab) => gate.isVisible(tab), [gate]);
  // Eyebrow qualifier of the hosted screen («Finanzas · CELUISMA S.A.», design §5.3), registered through
  // the host context (useHostedEyebrow) and painted only when it extends this category (fix:L7 qa#12).
  const [screenEyebrow, setScreenEyebrow] = useState<string | null>(null);
  const hostInfo = useMemo(() => ({ screenKey, basePath: item.url, title: item.label, setEyebrow: setScreenEyebrow }), [screenKey, item.url, item.label]);
  const eyebrow = containerEyebrow(category.label, item.label, screenEyebrow);
  const modulesError = gate.error ? errorStateFor("los módulos activos de la propiedad") : null;

  // Empty container (qa#12): why no tab is visible, and the copy for it. A
  // module list that failed to load is already explained by `modulesError`
  // with its «Reintentar», so the unknown-modules state is not repeated below it.
  const listUnavailable = gate.error !== null || forbiddenModuleLists.has(propertyId);
  const emptyReason = gate.loading ? null : emptyTabsReason(tabs, gate.tokens, gate.modules, { listUnavailable });
  const emptyCopy = emptyReason && !(emptyReason === "modules_unknown" && modulesError) ? emptyTabsCopy(emptyReason, { canEnable: gate.canEnableModules }) : null;
  const unlockCodes = useMemo(() => unlockingModulesFor(tabs, gate.tokens), [tabs, gate.tokens]);
  // «Activar módulo»: Módulos e integraciones with the first missing module preselected (§6.3, Sidebar's target).
  const enableModule = useCallback(() => navigateTo("ModuleManager", enableModuleHash(unlockCodes)), [unlockCodes]);

  return (
    <TabHostProvider value={hostInfo}>
      <div className="anf-nav-tabs" style={stackStyle} data-nav-item={screenKey} data-nav-empty={emptyReason ?? undefined}>
        <style>{STRIP_CSS}</style>
        <CocoaPageHeader eyebrow={eyebrow} title={item.label} subtitle={subtitle} actions={actions} />
        {modulesError ? (
          <CocoaState kind="error" title={modulesError.title} message={modulesError.message} primaryAction={{ label: modulesError.cta ?? ACTIONS.retry, onClick: gate.refresh }} inline />
        ) : null}
        {gate.loading ? (
          <CocoaTabSkeleton />
        ) : emptyCopy ? (
          <CocoaState
            kind="empty"
            title={emptyCopy.title}
            message={emptyCopy.message}
            primaryAction={emptyCopy.cta ? { label: emptyCopy.cta, onClick: enableModule } : undefined}
          />
        ) : emptyReason ? null : (
          <CocoaRouteTabs
            basePath={item.url}
            tabs={tabs}
            defaultTab={landing.defaultTab}
            mobileDefaultTab={landing.mobileDefaultTab}
            isVisible={isVisible}
            ariaLabel={`Secciones de ${item.label}`}
          />
        )}
      </div>
    </TabHostProvider>
  );
}

export default NavItemTabs;
