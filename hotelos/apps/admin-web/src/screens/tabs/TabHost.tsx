// Tab host context (Tanda 5 · L1a · lote tabs-a; convention closed in L1c).
//
// A routed tab container (NavItemTabs → CocoaRouteTabs) paints ONE
// CocoaPageHeader for the whole item. THE convention for a hosted screen is
// `useTabHost()`: null when rendered standalone, the host info inside a
// container — the screen then hides its own eyebrow and H1 (no duplicated
// title) and keeps subtitle, inner views and its actions row
// (HOSTED_ACTIONS_ROW / HOSTED_TOOLBAR, or `HostedHead` of tab-helpers.tsx).
// The container passes nothing down: the context is the source of truth, so a
// screen behaves the same whichever container hosts it.
//
// Bridge still in place (L1c): 10 screens branch on an `embedded` prop by hand
// (`{embedded ? null : <h1>…}`) and their loaders wrap them with `embed()` of
// tab-helpers.tsx — SetupCenterScreen, NotificationsScreen, ModuleHealthCenter,
// PropertyAiScreen, AiToolRegistryScreen, AiPipelineStatusScreen,
// AiGovernanceScreen, ApiReferenceScreen, FiscalDashboard and
// SustainabilityDashboard (Modelo303/111/115/180/390Screen left it in lote
// 8-B, Tanda 6). Migrating one = read
// `useTabHost()` instead of the prop, drop the prop, and change its loader to
// `{ default: m.Screen }`. Screens built on `pageHead(embedded)` are already on
// the context (pageHead reads it) and only carry a dead prop.

import { createContext, useContext, type CSSProperties, type ReactNode } from "react";

export type TabHostInfo = {
  /** Item screen key of the tree (`FrontDeskDashboard`). */
  screenKey: string;
  /** Item URL (`/hoy`). */
  basePath: string;
  /** Item label painted by the container header («Mi día»). */
  title: string;
};

const TabHostContext = createContext<TabHostInfo | null>(null);

export function TabHostProvider(props: { value: TabHostInfo; children: ReactNode }) {
  return <TabHostContext.Provider value={props.value}>{props.children}</TabHostContext.Provider>;
}

/** Null when the screen is rendered standalone (legacy route); the host info inside a container. */
export function useTabHost(): TabHostInfo | null {
  return useContext(TabHostContext);
}

/** Right-aligned actions row a hosted screen paints instead of its page header. */
export const HOSTED_ACTIONS_ROW: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "var(--cocoa-space-2)"
};

/** Toolbar (segmented control on the left, actions on the right) for hosted screens with inner views. */
export const HOSTED_TOOLBAR: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--cocoa-space-3)"
};
