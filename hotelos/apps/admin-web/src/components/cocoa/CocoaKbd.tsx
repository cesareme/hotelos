// CocoaKbd — keyboard hint («⌘K», «Esc») of Cocoa 22 (COCOA-22.md §3.1,
// §5.2 «? = atajos»): control bg, hairline, radius 4, caption 600 secondary.
// Decorative by default (the button/aria-label carries the meaning).
//
// Hooks for the css lot: `c22-kbd` (`data-cocoa="kbd"`).

import type { CSSProperties, ReactNode } from "react";

export interface CocoaKbdProps {
  children: ReactNode;
  /** Announce the key to AT (default: hidden, decorative). */
  announce?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function CocoaKbd({ children, announce = false, className, style }: CocoaKbdProps) {
  return (
    <kbd
      className={["c22-kbd", "cocoa-kbd", className].filter(Boolean).join(" ")}
      aria-hidden={announce ? undefined : true}
      data-cocoa="kbd"
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 5px",
        borderRadius: "var(--cocoa-radius-sm)",
        border: "1px solid var(--cocoa-separator)",
        background: "var(--cocoa-background-control)",
        color: "var(--cocoa-label-secondary)",
        fontFamily: "var(--cocoa-font)",
        fontSize: "var(--cocoa-fs-caption)",
        fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
        lineHeight: 1.4,
        letterSpacing: "var(--cocoa-tracking-wide)",
        ...style
      }}
    >
      {children}
    </kbd>
  );
}

export default CocoaKbd;
