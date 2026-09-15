// CocoaStat — secondary figure inside lists, asides and detail headers
// (COCOA-22.md §6 «Cifras»; the small sibling of CocoaKpi).
//
// Label caption uppercase secondary · value tabular (title-2 600, or title-1
// when `size="large"`) · optional `suffix` (decimals / currency symbol) in
// secondary at 0.7 em · optional hint caption. `tone` colours the value with
// the tone INK (the figure is ≤ 22 px, so the AA-safe ink applies).
// Hooks for the css lot: `c22-stat` + data-align/size/tabular/tone, parts
// `c22-stat__label/__value/__decimals/__hint`.

import type { CSSProperties, ReactNode } from "react";
import { toneInk, type CocoaTone } from "./cocoa-tones";

export interface CocoaStatProps {
  label: string;
  value: ReactNode;
  /** Decimals / unit painted smaller in secondary («,50 €»). */
  suffix?: ReactNode;
  tone?: CocoaTone;
  hint?: string;
  align?: "left" | "right";
  size?: "regular" | "large";
  /** Tabular figures (default true; disable for text values). */
  tabular?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function CocoaStat({ label, value, suffix, tone, hint, align = "left", size = "regular", tabular = true, className, style }: CocoaStatProps) {
  const containerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
    alignItems: align === "right" ? "flex-end" : "flex-start",
    textAlign: align,
    fontFamily: "var(--cocoa-font)",
    color: "var(--cocoa-label)",
    ...style
  };

  const labelStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: "var(--cocoa-fw-medium)" as CSSProperties["fontWeight"],
    letterSpacing: "var(--cocoa-tracking-wide)",
    textTransform: "uppercase",
    color: "var(--cocoa-label-secondary)",
    lineHeight: "var(--cocoa-leading-label)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "100%"
  };

  const valueStyle: CSSProperties = {
    fontSize: size === "large" ? "var(--cocoa-fs-title-1)" : "var(--cocoa-fs-title-2)",
    fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
    letterSpacing: "var(--cocoa-tracking-tight)",
    lineHeight: "var(--cocoa-leading-title)",
    color: tone ? toneInk(tone) : "var(--cocoa-label)",
    fontVariantNumeric: tabular ? "tabular-nums lining-nums" : "normal",
    fontFeatureSettings: tabular ? "var(--cocoa-font-numeric-tabular)" : "normal",
    minWidth: 0,
    overflowWrap: "anywhere"
  };

  const suffixStyle: CSSProperties = {
    fontSize: "0.7em",
    fontWeight: "var(--cocoa-fw-medium)" as CSSProperties["fontWeight"],
    color: "var(--cocoa-label-secondary)"
  };

  const hintStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-callout)",
    color: "var(--cocoa-label-secondary)",
    lineHeight: "var(--cocoa-leading-text)"
  };

  return (
    <div
      className={["c22-stat", "cocoa-stat", className].filter(Boolean).join(" ")}
      style={containerStyle}
      data-cocoa="stat"
      data-tone={tone}
      data-align={align}
      data-size={size}
      data-tabular={tabular ? undefined : "false"}
    >
      <span className="c22-stat__label" style={labelStyle}>
        {label}
      </span>
      <span className="c22-stat__value" style={valueStyle}>
        {value}
        {suffix !== undefined && suffix !== null ? (
          <small className="c22-stat__decimals" style={suffixStyle}>
            {suffix}
          </small>
        ) : null}
      </span>
      {hint ? (
        <span className="c22-stat__hint" style={hintStyle}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export default CocoaStat;
