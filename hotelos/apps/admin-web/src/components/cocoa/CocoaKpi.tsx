// CocoaKpi + CocoaKpiStrip + CocoaDelta — the KPI tile of the canon
// (COCOA-22.md §3.6), its auto-fit strip (§3.4) and the delta chip
// («▲ 100 % vs LY», §6 «Cifras»). The former director KPI tile alias was retired in ola 11.
//
//   ┌─ 3 px tone bar (padding-left 9) ───────────────┐  radius 12 · shadow card · padding 12 · gap 8 · min-height 44
//   │ OCUPACIÓN            caption 500 uppercase +0.012em secondary
//   │ 1,7 %                32 px 600 −0.011em lh 1.05 tabular   (unit callout 500 secondary)
//   │ ▲ 100 % vs LY  ~~~~  footnote 500 tabular · polarity colour · sparkline 60×20
//   └────────────────────────────────────────────────┘
//
// Polarity: positive-good (▲ success / ▼ danger), negative-good (inverted),
// neutral (secondary, «•»). The delta TEXT (11 px) uses the AA-safe tone ink
// (`toneInk`, §2.1 rule c: hue ≤ 13 px fails AA in light — success 3.13:1,
// danger 3.55:1); the hue is kept for the arrow glyph (a graphic, 3:1) and
// the sparkline. `caption` is a footnote line under the figure («4 facturas»)
// for context that is not a unit (the aria-label reads it after the value).
// Status paints the bar and the sparkline (ok →
// success, warning, critical → danger); without status there is no bar and the
// sparkline is tertiary. `tone` forces the colour of the figure (≥ 24 px, so
// the tone hue is allowed). `degraded` paints «—» with the DEGRADED_HINT
// tooltip and hides delta and sparkline (§3.10, never a fake green 0).
//
// Cocoa 22 normalises the surface to radius 12 + --cocoa-shadow-card (the
// canon painted `plain` rectangles without radius, §3.5 finding). Hooks for
// the css lot: root `c22-kpi` + data-status/size/tone/degraded, parts
// `c22-kpi__head/__icon/__label/__value-row/__value/__unit/__caption/__foot/__spark`,
// delta `c22-delta[data-sentiment]`.

import { useMemo, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { number as formatNumber } from "../../lib/format";
import { DEGRADED_HINT } from "../cocoa-extras/DegradedValue";
import { CocoaSparkline } from "./CocoaChart";
import { toneColor, toneInk, type CocoaSentiment, type CocoaTone } from "./cocoa-tones";

/** Unit of the delta chip: the four usual ones keep autocomplete; any other short unit («hab», «noches») is accepted (`(string & {})`). */
export type CocoaKpiDeltaUnit = "%" | "pp" | "€" | "pts" | (string & {});
export type CocoaKpiPolarity = "positive-good" | "negative-good" | "neutral";
export type CocoaKpiStatus = "ok" | "warning" | "critical";
export type CocoaKpiSize = "regular" | "compact";

export interface CocoaKpiProps {
  label: string;
  value: string | number;
  unit?: string;
  /** Secondary line under the figure («272,00 €», «4 facturas»): context of the value, not its unit (Tanda 6). */
  caption?: string;
  delta?: number;
  deltaUnit?: CocoaKpiDeltaUnit;
  /** «vs LY», «vs ayer». */
  deltaLabel?: string;
  polarity?: CocoaKpiPolarity;
  sparkline?: readonly number[];
  status?: CocoaKpiStatus;
  /** Forces the colour of the figure (the status bar keeps its own tone). */
  tone?: CocoaTone;
  size?: CocoaKpiSize;
  icon?: ReactNode;
  onClick?: () => void;
  /** The counter's query failed: paint «—» with the hint instead of a fake value. */
  degraded?: boolean;
  id?: string;
  className?: string;
  /** Layout escape hatch only. */
  style?: CSSProperties;
}

export interface CocoaKpiStripProps {
  /** Minimum tile width in px for the auto-fit grid. Default 180 (canon); ops mini-cards use 200. */
  min?: number;
  stagger?: boolean;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  "aria-label"?: string;
}

export interface CocoaDeltaProps {
  delta?: number;
  unit?: string;
  /** «vs LY». */
  label?: string;
  polarity?: CocoaKpiPolarity;
  className?: string;
  style?: CSSProperties;
}

const STATUS_TONE: Record<CocoaKpiStatus, CocoaTone> = { ok: "success", warning: "warning", critical: "danger" };

/** Tone of a delta by polarity (pure): success / danger / neutral. */
export function deltaTone(delta: number | undefined, polarity: CocoaKpiPolarity = "positive-good"): "success" | "danger" | "neutral" {
  if (delta === undefined || !Number.isFinite(delta) || delta === 0 || polarity === "neutral") return "neutral";
  const good = polarity === "positive-good" ? delta > 0 : delta < 0;
  return good ? "success" : "danger";
}

/** Sentiment of a delta (pure; the css lot's `data-sentiment`). */
export function deltaSentiment(delta: number | undefined, polarity: CocoaKpiPolarity = "positive-good"): CocoaSentiment {
  const tone = deltaTone(delta, polarity);
  if (tone === "success") return "good";
  if (tone === "danger") return "bad";
  return "neutral";
}

/** «▲» / «▼» / «•» (pure). */
export function deltaArrow(delta: number): string {
  if (delta > 0) return "▲";
  if (delta < 0) return "▼";
  return "•";
}

/** Absolute delta with sensible precision: integers whole, otherwise one decimal (es-ES via lib/format). */
export function formatDelta(delta: number): string {
  const abs = Math.abs(delta);
  return Number.isInteger(abs) ? formatNumber(abs, { maximumFractionDigits: 0 }) : formatNumber(abs, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** Colours of a delta chip (pure): AA ink for the 11 px text, the tone hue only for the arrow glyph. */
export function deltaColors(tone: "success" | "danger" | "neutral"): { text: string; arrow: string } {
  if (tone === "neutral") return { text: "var(--cocoa-label-secondary)", arrow: "var(--cocoa-label-secondary)" };
  return { text: toneInk(tone), arrow: toneColor(tone) };
}

/** Accessible name «etiqueta, valor unidad, +delta unidad vs LY» (pure). */
export function kpiAriaLabel(input: {
  label: string;
  value: string | number;
  unit?: string;
  caption?: string;
  delta?: number;
  deltaUnit?: string;
  deltaLabel?: string;
  degraded?: boolean;
}): string {
  const parts: string[] = [input.label];
  if (input.degraded) {
    parts.push("no disponible");
    return parts.join(", ");
  }
  parts.push(input.unit ? `${input.value} ${input.unit}` : String(input.value));
  if (input.caption) parts.push(input.caption);
  if (typeof input.delta === "number" && Number.isFinite(input.delta)) {
    const sign = input.delta > 0 ? "+" : input.delta < 0 ? "−" : "";
    parts.push(`${sign}${formatDelta(input.delta)}${input.deltaUnit ? ` ${input.deltaUnit}` : ""}${input.deltaLabel ? ` ${input.deltaLabel}` : ""}`);
  } else if (input.deltaLabel) {
    parts.push(input.deltaLabel);
  }
  return parts.join(", ");
}

/** Delta chip: «▲ 100 % vs LY» in the polarity colour; decorative (the KPI's aria-label carries the value). */
export function CocoaDelta({ delta, unit, label, polarity = "positive-good", className, style }: CocoaDeltaProps) {
  const hasDelta = typeof delta === "number" && Number.isFinite(delta);
  if (!hasDelta && !label) return null;
  const sentiment = deltaSentiment(delta, polarity);
  const tone = deltaTone(delta, polarity);
  const colors = deltaColors(tone);
  return (
    <span
      className={["c22-delta", className].filter(Boolean).join(" ")}
      aria-hidden="true"
      data-cocoa="delta"
      data-sentiment={sentiment}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--cocoa-space-1)",
        fontSize: "var(--cocoa-fs-footnote)",
        fontWeight: "var(--cocoa-fw-medium)" as CSSProperties["fontWeight"],
        color: colors.text,
        fontVariantNumeric: "tabular-nums",
        fontFeatureSettings: "var(--cocoa-font-numeric-tabular)",
        lineHeight: 1.2,
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        ...style
      }}
    >
      {hasDelta && typeof delta === "number" ? (
        <>
          <span className="c22-delta__arrow" style={{ color: colors.arrow }}>
            {deltaArrow(delta)}
          </span>
          <span>
            {formatDelta(delta)}
            {unit ? ` ${unit}` : ""}
          </span>
        </>
      ) : null}
      {label ? (
        <span className="c22-delta__label" style={{ color: "var(--cocoa-label-secondary)", fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"] }}>
          {label}
        </span>
      ) : null}
    </span>
  );
}

export function CocoaKpi({
  label,
  value,
  unit,
  caption,
  delta,
  deltaUnit,
  deltaLabel,
  polarity = "positive-good",
  sparkline,
  status,
  tone,
  size = "regular",
  icon,
  onClick,
  degraded = false,
  id,
  className,
  style
}: CocoaKpiProps) {
  const isInteractive = typeof onClick === "function";
  const statusTone = status ? STATUS_TONE[status] : undefined;
  const statusColor = statusTone ? toneColor(statusTone) : undefined;
  const hasDelta = !degraded && typeof delta === "number" && Number.isFinite(delta);
  const hasSparkline = !degraded && Array.isArray(sparkline) && sparkline.length > 0;
  const hasBottomRow = hasDelta || (!degraded && Boolean(deltaLabel)) || hasSparkline;

  const ariaLabel = useMemo(
    () => kpiAriaLabel({ label, value, unit, caption, delta, deltaUnit, deltaLabel, degraded }),
    [label, value, unit, caption, delta, deltaUnit, deltaLabel, degraded]
  );

  const rootStyle: CSSProperties = {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-2)",
    boxSizing: "border-box",
    minWidth: 0,
    minHeight: 44,
    height: "100%",
    padding: "var(--cocoa-space-3)",
    paddingLeft: statusColor ? "calc(var(--cocoa-space-3) - 3px)" : undefined,
    borderLeft: statusColor ? `3px solid ${statusColor}` : undefined,
    background: "var(--cocoa-background-content)",
    borderRadius: "var(--cocoa-radius-lg)",
    boxShadow: "var(--cocoa-shadow-card)",
    color: "var(--cocoa-label)",
    fontFamily: "var(--cocoa-font)",
    textAlign: "left",
    cursor: isInteractive ? "pointer" : undefined,
    ...style
  };

  const labelStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: "var(--cocoa-fw-medium)" as CSSProperties["fontWeight"],
    letterSpacing: "var(--cocoa-tracking-wide)",
    textTransform: "uppercase",
    color: "var(--cocoa-label-secondary)",
    lineHeight: 1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0
  };

  const valueStyle: CSSProperties = {
    fontSize: size === "compact" ? "var(--cocoa-fs-kpi-compact)" : "var(--cocoa-fs-kpi)",
    fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
    letterSpacing: "var(--cocoa-tracking-tight)",
    color: degraded ? "var(--cocoa-label-tertiary)" : tone ? toneColor(tone) : "var(--cocoa-label)",
    lineHeight: "var(--cocoa-leading-kpi)",
    fontVariantNumeric: "tabular-nums",
    fontFeatureSettings: "var(--cocoa-font-numeric-tabular)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0,
    cursor: degraded ? "help" : undefined,
    transition: "color var(--cocoa-duration-base) var(--cocoa-ease-out)"
  };

  const unitStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-callout)",
    fontWeight: "var(--cocoa-fw-medium)" as CSSProperties["fontWeight"],
    color: "var(--cocoa-label-secondary)",
    fontVariantNumeric: "tabular-nums"
  };

  const captionStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-footnote)",
    color: "var(--cocoa-label-secondary)",
    fontVariantNumeric: "tabular-nums",
    lineHeight: 1.2,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    minWidth: 0
  };

  const onKeyDown = isInteractive
    ? (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick?.();
        }
      }
    : undefined;

  return (
    <div
      id={id}
      className={["c22-kpi", "cocoa-kpi", isInteractive ? "cocoa-focus-ring" : null, className].filter(Boolean).join(" ")}
      style={rootStyle}
      role={isInteractive ? "button" : "group"}
      tabIndex={isInteractive ? 0 : undefined}
      aria-label={ariaLabel}
      onClick={isInteractive ? () => onClick?.() : undefined}
      onKeyDown={onKeyDown}
      data-cocoa="kpi"
      data-status={status}
      data-size={size}
      data-tone={tone}
      data-degraded={degraded ? "true" : undefined}
      data-variant="elevated"
    >
      <div className="c22-kpi__head" style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--cocoa-label-secondary)", minWidth: 0 }}>
        {icon ? (
          <span className="c22-kpi__icon" aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, flexShrink: 0 }}>
            {icon}
          </span>
        ) : null}
        <span className="c22-kpi__label" style={labelStyle}>
          {label}
        </span>
      </div>

      <div className="c22-kpi__value-row" style={{ display: "flex", alignItems: "baseline", gap: "var(--cocoa-space-1)", minWidth: 0 }}>
        {degraded ? (
          <span className="c22-kpi__value" style={valueStyle} title={DEGRADED_HINT} aria-hidden="true">
            —
          </span>
        ) : (
          <>
            <span className="c22-kpi__value" style={valueStyle}>
              {value}
            </span>
            {unit ? (
              <span className="c22-kpi__unit" style={unitStyle}>
                {unit}
              </span>
            ) : null}
          </>
        )}
      </div>

      {caption && !degraded ? (
        <span className="c22-kpi__caption" style={captionStyle} title={caption}>
          {caption}
        </span>
      ) : null}

      {hasBottomRow ? (
        <div className="c22-kpi__foot" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--cocoa-space-2)", marginTop: "auto", minWidth: 0 }}>
          <CocoaDelta delta={hasDelta ? delta : undefined} unit={deltaUnit} label={deltaLabel} polarity={polarity} />
          {hasSparkline ? <CocoaSparkline values={sparkline!} tone={statusTone} className="c22-kpi__spark" /> : null}
        </div>
      ) : degraded ? (
        <span className="c22-kpi__foot" style={{ fontSize: "var(--cocoa-fs-footnote)", color: "var(--cocoa-label-tertiary)", marginTop: "auto" }} title={DEGRADED_HINT} aria-hidden="true">
          No disponible
        </span>
      ) : null}
    </div>
  );
}

/** `data-min` values the stylesheet resolves by itself; other minimums travel as an inline variable. */
export const KPI_STRIP_CSS_MINS: readonly number[] = [180, 200, 240];

export function CocoaKpiStrip({ min = 180, stagger = false, children, className, style, "aria-label": ariaLabel }: CocoaKpiStripProps) {
  const custom = !KPI_STRIP_CSS_MINS.includes(min);
  const stripStyle: CSSProperties = {
    minWidth: 0,
    ...(custom ? { ["--c22-kpi-min" as string]: `${min}px` } : {}),
    ...style
  };
  return (
    <div
      className={["c22-kpi-strip", "cocoa-kpi-strip", stagger ? "cocoa-stagger" : null, className].filter(Boolean).join(" ")}
      style={stripStyle}
      role={ariaLabel ? "group" : undefined}
      aria-label={ariaLabel}
      data-cocoa="kpi-strip"
      data-min={min === 180 ? undefined : String(min)}
    >
      {children}
    </div>
  );
}

export default CocoaKpi;
