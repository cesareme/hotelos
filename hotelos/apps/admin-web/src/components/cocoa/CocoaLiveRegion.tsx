// CocoaLiveRegion — the single live region of a page (COCOA-22.md §5.2, §6
// «Live regions»): «Guardado», «Datos a 08:12», «3 indicadores no
// disponibles» are announced once through this visually hidden node instead
// of sprinkling `aria-live` on every chip. Polite by default; `assertive`
// interrupts (errors). The same message twice is re-announced only when
// `key` changes (pass a counter or a timestamp).

import { useEffect, useState, type ReactNode } from "react";

export interface CocoaLiveRegionProps {
  message: ReactNode;
  politeness?: "polite" | "assertive";
  /** Change it to re-announce an identical message. */
  announceKey?: string | number;
  id?: string;
}

export function CocoaLiveRegion({ message, politeness = "polite", announceKey, id }: CocoaLiveRegionProps) {
  // Clear, then set on the next frame so AT sees a change even for repeats.
  const [current, setCurrent] = useState<ReactNode>(message);
  useEffect(() => {
    setCurrent(null);
    const raf = typeof window !== "undefined" ? window.requestAnimationFrame(() => setCurrent(message)) : null;
    return () => {
      if (raf !== null) window.cancelAnimationFrame(raf);
    };
  }, [message, announceKey]);

  return (
    <div id={id} className="c22-live-region cocoa-sr-only" role={politeness === "assertive" ? "alert" : "status"} aria-live={politeness} aria-atomic="true" data-cocoa="live-region">
      {current}
    </div>
  );
}

export default CocoaLiveRegion;
