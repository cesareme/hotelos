// Reactive pathname for the tab containers (Tanda 5 · L1a · lote tabs-a).
//
// Same sync rules as CocoaRouteTabs (which keeps its own hook private):
// `popstate` (Back/Forward, openTabPath), `hotelos-tab-changed` (a tab
// switch committed by any strip) and `hotelos-nav` (a shell navigation App.tsx
// decides in a microtask queued before ours, so a microtask here sees the
// final URL). Containers use it to concretize detail sub-URLs (`:id`).

import { useEffect, useState } from "react";
import { TAB_CHANGED_EVENT } from "../../components/cocoa/CocoaRouteTabs";

const SHELL_NAV_EVENT = "hotelos-nav";

export function usePathname(): string {
  const [pathname, setPathname] = useState<string>(() => (typeof window === "undefined" ? "/" : window.location.pathname));
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const sync = () => setPathname(window.location.pathname);
    const afterShellNav = () => queueMicrotask(sync);
    window.addEventListener("popstate", sync);
    window.addEventListener(TAB_CHANGED_EVENT, sync);
    window.addEventListener(SHELL_NAV_EVENT, afterShellNav);
    sync();
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(TAB_CHANGED_EVENT, sync);
      window.removeEventListener(SHELL_NAV_EVENT, afterShellNav);
    };
  }, []);
  return pathname;
}
