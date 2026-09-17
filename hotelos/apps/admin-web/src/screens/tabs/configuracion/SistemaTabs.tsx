// Sistema — /configuracion/sistema (Tanda 5 · L1a · lot tabs-c).
//
// Item `AuditLogViewer`: base tab «Auditoría» plus Webhooks (WebhooksAdminScreen,
// admin), Aplicaciones (DeveloperAppsScreen, admin), Referencia de API
// (ApiReferenceScreen), Organizaciones (TenantAdminConsoleScreen, admin) and the
// detail sub-URL Organización (/organizaciones/:id → TenantDetailScreen, admin;
// it used to need `#org=`): reachable by URL, painted only on an organization,
// whose id the screen receives as `orgId`; closing it goes back to Organizaciones.
// The DeveloperPortal and ApiUsageLogs placeholders retire into this item.
// Labels, URLs and roles come from nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// L1b registers: screenKey AuditLogViewer · url /configuracion/sistema · tabs
// /configuracion/sistema/webhooks, /aplicaciones, /api, /organizaciones, /organizaciones/:id.

import type { ComponentType } from "react";
import { commitTabNavigation } from "../../../components/cocoa/CocoaRouteTabs";
import { urlForScreen } from "../../../navigation/nav-tree";
import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";
import { useRouteParam } from "../tab-helpers";

type TenantDetailProps = { orgId: string; onClose: () => void };

const BASE_PATH = urlForScreen("AuditLogViewer") ?? "/configuracion/sistema";
const ORGANIZACIONES_PATH = urlForScreen("TenantAdminConsoleScreen") ?? `${BASE_PATH}/organizaciones`;
const ORGANIZACION_PATTERN = urlForScreen("TenantDetailScreen") ?? `${ORGANIZACIONES_PATH}/:id`;

/** Back to the Organizaciones tab inside the container (pushState + `hotelos-tab-changed`; no shell round trip). */
export function closeOrganizacion(): void {
  commitTabNavigation({ basePath: BASE_PATH, from: "organizacion", to: "organizaciones", href: ORGANIZACIONES_PATH });
}

/** Detail sub-URL: the organization id travels in the URL (`:id`) and is re-read on every navigation. */
function OrganizacionParam({ Screen }: { Screen: ComponentType<TenantDetailProps> }) {
  const orgId = useRouteParam(ORGANIZACION_PATTERN, "id");
  if (!orgId) return null;
  return <Screen key={orgId} orgId={orgId} onClose={closeOrganizacion} />;
}

function withOrganizacionParam(Screen: ComponentType<TenantDetailProps>): { default: ComponentType<Record<string, never>> } {
  const Tab = () => <OrganizacionParam Screen={Screen} />;
  Tab.displayName = "TenantDetailScreenTab";
  return { default: Tab };
}

export const loaders: TabLoaders = {
  AuditLogViewer: () => import("../../AuditLogViewer").then((m) => ({ default: m.AuditLogViewer })),
  WebhooksAdmin: () => import("../../developer/WebhooksAdminScreen").then((m) => ({ default: m.WebhooksAdminScreen })),
  DeveloperApps: () => import("../../developer/DeveloperAppsScreen").then((m) => ({ default: m.DeveloperAppsScreen })),
  ApiReferenceScreen: () => import("../../developer/ApiReferenceScreen").then((m) => ({ default: m.ApiReferenceScreen })),
  TenantAdminConsoleScreen: () => import("../../admin/TenantAdminConsoleScreen").then((m) => ({ default: m.TenantAdminConsoleScreen })),
  TenantDetailScreen: () => import("../../admin/TenantDetailScreen").then((m) => withOrganizacionParam(m.TenantDetailScreen))
};

export default function SistemaTabs() {
  return (
    <NavItemTabs
      screenKey="AuditLogViewer"
      loaders={loaders}
      subtitle="Registro de auditoría, webhooks, aplicaciones OAuth, referencia de la API y organizaciones de la plataforma."
    />
  );
}
