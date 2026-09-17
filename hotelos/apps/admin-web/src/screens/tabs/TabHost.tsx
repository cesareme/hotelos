// Tab host context (Tanda 5 · L1a · lote tabs-a; convention closed in L1c).
//
// A routed tab container (NavItemTabs → CocoaRouteTabs) paints ONE
// CocoaPageHeader for the whole item. THE convention for a hosted screen is
// `useTabHost()`: null when rendered standalone, the host info inside a
// container — the screen then hides its own eyebrow and H1 (no duplicated
// title) and keeps subtitle, inner views and its actions row
// (HOSTED_ACTIONS_ROW / HOSTED_TOOLBAR, or `HostedHead` of components/cocoa,
// which `CocoaPage` paints by itself when hosted).
// The container passes nothing down: the context is the source of truth, so a
// screen behaves the same whichever container hosts it.
//
// Bridge of L1c retired (Cocoa 22 · ola 11): no screen takes an `embedded`
// prop any more and no loader wraps its screen — every container hands the
// screen over as it is (`{ default: m.Screen }`) and the screen reads
// `useTabHost()`, directly or through `CocoaPage`.
//
// Eyebrow qualifier (Tanda 6b · L7, fix qa#12): the container paints the
// category («Finanzas»); a hosted screen that knows more — the sociedad or
// centre of its finance scope, «Finanzas · CELUISMA S.A.» (design §5.3 of
// FINANZAS-ESTRUCTURA-SOCIETARIA.md) — registers its eyebrow through
// `useHostedEyebrow` (CocoaPage and HostedHead do it for their `eyebrow` prop)
// and NavItemTabs paints the qualifier only when it extends its own category
// label (`containerEyebrow`, nav-item-tabs.ts): eyebrow = categoría stays the
// rule of the runbook; the qualifier is its one extension.

import { createContext, useContext, useEffect, type CSSProperties, type ReactNode } from "react";

export type TabHostInfo = {
  /** Item screen key of the tree (`FrontDeskDashboard`). */
  screenKey: string;
  /** Item URL (`/hoy`). */
  basePath: string;
  /** Item label painted by the container header («Mi día»). */
  title: string;
  /**
   * Receives the eyebrow of the hosted screen so the container can qualify its
   * category («Finanzas · CELUISMA S.A.»); null clears it. Absent on a host that
   * keeps the plain category.
   */
  setEyebrow?: (eyebrow: string | null) => void;
};

const TabHostContext = createContext<TabHostInfo | null>(null);

export function TabHostProvider(props: { value: TabHostInfo; children: ReactNode }) {
  return <TabHostContext.Provider value={props.value}>{props.children}</TabHostContext.Provider>;
}

/** Null when the screen is rendered standalone (legacy route); the host info inside a container. */
export function useTabHost(): TabHostInfo | null {
  return useContext(TabHostContext);
}

/**
 * Registers the eyebrow of a hosted screen with its container (no-op standalone
 * or when the host does not take one); cleared on unmount so the next tab of the
 * container starts again from the plain category.
 */
export function useHostedEyebrow(eyebrow: string | undefined): void {
  const setEyebrow = useTabHost()?.setEyebrow;
  useEffect(() => {
    if (!setEyebrow) return undefined;
    setEyebrow(eyebrow ?? null);
    return () => setEyebrow(null);
  }, [setEyebrow, eyebrow]);
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
