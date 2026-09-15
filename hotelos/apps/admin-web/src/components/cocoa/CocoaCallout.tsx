// CocoaCallout — tinted note / banner of Cocoa 22 (COCOA-22.md §2.1 rule b,
// §3.1 «banners de shell», §3.10 «degradado»): tone wash + tone border,
// radius 8, callout text; `variant="banner"` is the full-width strip under the
// toolbar (no radius, hairline bottom). Tone text goes through the AA-safe
// `*-text` ink. Replaces the `rgba(10,132,255,.12)` shell banners and the
// ad-hoc `.bo-alert`/`.bo-notice` boxes.
//
// A callout is static content: `role="note"` by default (§6 «una live region
// por página» — /hoy/turno mounted five `role="status"` flags). Pass
// `role="status"` / `"alert"` explicitly ONLY for a message that changes
// while the page is open (a save state), or announce through CocoaLiveRegion.
//
// Hooks for the css lot: `c22-callout` + data-tone/variant, parts
// `c22-callout__icon/__body/__title/__actions`.

import type { CSSProperties, ReactNode } from "react";
import { toneBg, toneBorder, toneColor, toneInk, type CocoaTone } from "./cocoa-tones";

export type CocoaCalloutVariant = "inline" | "banner";

export interface CocoaCalloutProps {
  tone?: CocoaTone;
  variant?: CocoaCalloutVariant;
  title?: string;
  icon?: ReactNode;
  /** Buttons at the right (CocoaButton small). */
  actions?: ReactNode;
  children?: ReactNode;
  /** Default `note` (static). `status`/`alert` only for messages that change while mounted. */
  role?: "status" | "alert" | "note";
  id?: string;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
}

/** ARIA role of a callout (pure): `note` unless the caller asks for a live role; the tone never makes it live. */
export function calloutRole(_tone: CocoaTone, role?: CocoaCalloutProps["role"]): "status" | "alert" | "note" {
  return role ?? "note";
}

export function CocoaCallout({ tone = "neutral", variant = "inline", title, icon, actions, children, role, id, className, style }: CocoaCalloutProps) {
  const isBanner = variant === "banner";
  const rootStyle: CSSProperties = {
    display: "flex",
    alignItems: isBanner ? "center" : "flex-start",
    gap: "var(--cocoa-space-2)",
    padding: isBanner ? "var(--cocoa-space-2) var(--cocoa-space-4)" : "var(--cocoa-space-2) var(--cocoa-space-3)",
    border: `1px solid ${toneBorder(tone)}`,
    borderWidth: isBanner ? "0 0 1px" : 1,
    borderRadius: isBanner ? 0 : "var(--cocoa-radius-md)",
    background: toneBg(tone),
    color: "var(--cocoa-label)",
    fontFamily: "var(--cocoa-font)",
    fontSize: isBanner ? "var(--cocoa-fs-body)" : "var(--cocoa-fs-callout)",
    lineHeight: "var(--cocoa-leading-text)",
    minWidth: 0,
    boxSizing: "border-box",
    ...style
  };

  return (
    <div id={id} role={calloutRole(tone, role)} className={["c22-callout", "cocoa-callout", className].filter(Boolean).join(" ")} style={rootStyle} data-cocoa="callout" data-tone={tone} data-variant={variant}>
      {icon ? (
        <span className="c22-callout__icon" aria-hidden="true" style={{ color: toneColor(tone), flexShrink: 0, display: "inline-flex", marginTop: isBanner ? 0 : 1 }}>
          {icon}
        </span>
      ) : null}
      <div className="c22-callout__body" style={{ minWidth: 0, flex: "1 1 auto", display: "flex", flexDirection: "column", gap: 2 }}>
        {title ? (
          <span className="c22-callout__title" style={{ fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"], color: toneInk(tone) }}>
            {title}
          </span>
        ) : null}
        {children}
      </div>
      {actions ? (
        <div className="c22-callout__actions" style={{ display: "inline-flex", gap: "var(--cocoa-space-2)", flexShrink: 0, alignItems: "center" }}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export default CocoaCallout;
