// Generic routed tab container for ONE item of the tree (Tanda 5 · L1a · lote tabs-a).
//
// Renders, in this order: one CocoaPageHeader (eyebrow = category, title =
// item label, optional subtitle/actions), the module-list error when the gate
// could not read it, and CocoaRouteTabs with the tabs built from the JSON item
// (`buildItemTabs`), the role/module gate (`useNavGate`) and the landing per
// role (`landingKeysFor` → landingTabFor of nav-tree.ts). Screens hosted here
// read `useTabHost()` to drop their own page header. A strip with a single
// painted tab (Huéspedes on the list, Compras with the module off) is hidden
// with CSS: one tab is not a choice.

import { useCallback, useMemo, type ReactNode } from "react";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaRouteTabs, CocoaTabSkeleton, type CocoaRouteTab } from "../../components/cocoa/CocoaRouteTabs";
import { ErrorState } from "../../components/States";
import { errorStateFor } from "../../content/actions";
import { useNavGate } from "../../navigation/useEnabledModules";
import { TabHostProvider } from "./TabHost";
import { buildItemTabs, itemForScreen, landingKeysFor, type TabLoaders } from "./nav-item-tabs";
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
  const gate = useNavGate();
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
  const hostInfo = useMemo(() => ({ screenKey, basePath: item.url, title: item.label }), [screenKey, item.url, item.label]);
  const modulesError = gate.error ? errorStateFor("los módulos activos de la propiedad") : null;

  return (
    <TabHostProvider value={hostInfo}>
      <div className="anf-nav-tabs" style={stackStyle} data-nav-item={screenKey}>
        <style>{STRIP_CSS}</style>
        <CocoaPageHeader eyebrow={category.label} title={item.label} subtitle={subtitle} actions={actions} />
        {modulesError ? (
          <ErrorState title={modulesError.title} message={modulesError.message} onRetry={gate.refresh} retryLabel={modulesError.cta} />
        ) : null}
        {gate.loading ? (
          <CocoaTabSkeleton />
        ) : (
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
