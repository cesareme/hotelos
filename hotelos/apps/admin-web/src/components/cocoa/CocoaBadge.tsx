// CocoaBadge — status chip of Cocoa 22 (COCOA-22.md §3.11; replaces
// `.bo-status/.bo-chip/.bo-pill`, `.cm-pill`, `v2/StatusBadge` and the local
// `badgeStyle` of the director dashboard).
//
//   - `outline` (canon): transparent · 1 px border in the tone hue · text in
//     the tone INK (AA at 10 px in light; the hue itself is only 2–3.5:1).
//   - `tinted`: tone wash + tone border + tone ink (degraded banner, callouts).
//   - `dot`: no box; a 6 px dot in the tone hue (painted by the stylesheet's
//     `.c22-badge[data-variant="dot"]::before`) + label text (status pills).
//   - caption 600 uppercase +0.012 em · padding 2 8 · radius 4 · line-height 1.4.
//
// Hooks for the css lot: root `c22-badge` + data-tone/variant/size/uppercase,
// parts `c22-badge__icon/__text`.

import type { CSSProperties, ReactNode } from "react";
import { toneBg, toneBorder, toneColor, toneInk, type CocoaTone } from "./cocoa-tones";

export type CocoaBadgeVariant = "outline" | "tinted" | "dot";
export type CocoaBadgeSize = "small" | "regular";

export interface CocoaBadgeProps {
  tone?: CocoaTone;
  variant?: CocoaBadgeVariant;
  size?: CocoaBadgeSize;
  /** Default: true for outline/tinted, false for dot. */
  uppercase?: boolean;
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
  role?: string;
  "aria-label"?: string;
}

export interface BadgeTokens {
  color: string;
  background: string;
  border: string;
  /** Colour of the leading dot (`dot` variant only). */
  dot?: string;
}

/** Token set for a tone/variant pair (pure, unit-tested). */
export function badgeTokens(tone: CocoaTone, variant: CocoaBadgeVariant): BadgeTokens {
  switch (variant) {
    case "tinted":
      return { color: toneInk(tone), background: toneBg(tone), border: toneBorder(tone) };
    case "dot":
      return { color: "var(--cocoa-label)", background: "transparent", border: "transparent", dot: toneColor(tone) };
    case "outline":
    default:
      return { color: toneInk(tone), background: "transparent", border: toneColor(tone) };
  }
}

const PADDING_BY_SIZE: Record<CocoaBadgeSize, string> = {
  small: "0 6px",
  regular: "2px var(--cocoa-space-2)"
};

export function CocoaBadge({
  tone = "neutral",
  variant = "outline",
  size = "regular",
  uppercase,
  icon,
  children,
  title,
  className,
  style,
  role,
  "aria-label": ariaLabel
}: CocoaBadgeProps) {
  const tokens = badgeTokens(tone, variant);
  const isUpper = uppercase ?? variant !== "dot";

  const badgeStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--cocoa-space-1)",
    padding: variant === "dot" ? "0 0 0 var(--cocoa-space-1)" : PADDING_BY_SIZE[size],
    fontFamily: "var(--cocoa-font)",
    fontSize: isUpper ? "var(--cocoa-fs-caption)" : "var(--cocoa-fs-footnote)",
    fontWeight: (isUpper ? "var(--cocoa-fw-semibold)" : "var(--cocoa-fw-medium)") as CSSProperties["fontWeight"],
    letterSpacing: isUpper ? "var(--cocoa-tracking-wide)" : "var(--cocoa-tracking-normal)",
    textTransform: isUpper ? "uppercase" : "none",
    lineHeight: size === "small" ? 1.5 : 1.4,
    color: tokens.color,
    background: tokens.background,
    border: `1px solid ${tokens.border}`,
    borderRadius: "var(--cocoa-radius-sm)",
    whiteSpace: "nowrap",
    verticalAlign: "middle",
    maxWidth: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    ...style
  };

  return (
    <span
      className={["c22-badge", "cocoa-badge", className].filter(Boolean).join(" ")}
      style={badgeStyle}
      title={title}
      role={role}
      aria-label={ariaLabel}
      data-cocoa="badge"
      data-tone={tone}
      data-variant={variant}
      data-size={size}
      data-uppercase={isUpper ? undefined : "false"}
    >
      {icon ? (
        <span className="c22-badge__icon" aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 10, height: 10, flexShrink: 0 }}>
          {icon}
        </span>
      ) : null}
      <span className="c22-badge__text" style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
        {children}
      </span>
    </span>
  );
}

export default CocoaBadge;
