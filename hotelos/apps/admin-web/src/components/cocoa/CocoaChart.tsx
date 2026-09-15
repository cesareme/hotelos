// CocoaChart — the own SVG charts of Cocoa 22 (COCOA-22.md §3.12), extracted
// from the director dashboard (`cocoa-director/*`, which keeps rendering its
// own copies until wave 2 swaps them for these).
//
//   Sparkline  60×20, 1.5 px, tone or tertiary (KPI tiles)
//   Bars       div bars radius 2, tone by polarity/sign, HUD tooltip (pickup)
//   Line       multi-series, padding 16/16/32/44, 4 Y ticks, hover guide +
//              tooltip card, legend swatches 20×8 (pace)
//   Gauge      220×130 semicircle, stroke 16, needle + hub, tone by threshold
//   Donut      accent + greys, stroke 1.5 between slices, centre title-2
//   Progress   6 px track, tone fill, role=progressbar
//
// Rules: only `var(--cocoa-*)` inside the SVG (inherits the theme), no
// libraries, every number through lib/format (es-ES: «12,5 %», never
// «12.5 %»), `role="img"` + `aria-label` (or aria-hidden when decorative),
// text never deformed: the line chart measures its container and sizes its
// viewBox to it (`preserveAspectRatio="xMidYMid meet"` + `aspect-ratio`),
// instead of the canon's `none` that stretched glyphs on phones.
//
// Hooks for the css lot: root `c22-chart[data-kind]`, parts `c22-chart__grid/
// __axis/__series[data-tone,data-dashed,data-width]/__guide/__legend/
// __legend-item/__swatch/__tooltip`, `c22-bars/__col/__bar/__label`,
// `c22-gauge__track/__arc`, `c22-donut__slice[data-index]`, `c22-progress/
// __fill/__label`. Every tone is also a `data-tone` so the stylesheet's
// tone resolution and the inline `var(--cocoa-tone-*)` always agree.

import { useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { percent as formatPercent } from "../../lib/format";
import { toneColor, toneInk, type CocoaTone } from "./cocoa-tones";
import { useElementWidth } from "./cocoa-viewport";
import {
  GAUGE,
  LINE_DEFAULT_WIDTH,
  LINE_PADDING,
  barHeight,
  barTone,
  buildPathD,
  clampPercent,
  donutSegments,
  formatChartValue,
  formatYTick,
  gaugeGeometry,
  lineGeometry,
  sparklinePath,
  thresholdTone,
  type ChartPolarity
} from "./cocoa-chart-math";

export type CocoaSeriesTone = CocoaTone | "tertiary";

/** Canon series order when no tone is given: accent → warning → tertiary → info → success → neutral. */
export const SERIES_TONE_ORDER: readonly CocoaSeriesTone[] = ["accent", "warning", "tertiary", "info", "success", "neutral"];

/** Tone name of a series (pure): explicit tone, else by index in the canon order. */
export function seriesToneName(tone: CocoaSeriesTone | undefined, index: number): CocoaSeriesTone {
  return tone ?? SERIES_TONE_ORDER[index % SERIES_TONE_ORDER.length];
}

/** Stroke of a series (pure): the tone hue, `label-tertiary` for `tertiary`. */
export function seriesStroke(tone: CocoaSeriesTone | undefined, index: number): string {
  const name = seriesToneName(tone, index);
  if (name === "tertiary") return "var(--cocoa-chart-reference)";
  return toneColor(name);
}

/** Canon donut palette: accent, then the label greys (85 / 62 / 26 %), then the quaternary fill. */
export const DONUT_PALETTE: readonly string[] = [
  "var(--cocoa-chart-primary)",
  "var(--cocoa-chart-series-2)",
  "var(--cocoa-chart-series-3)",
  "var(--cocoa-chart-series-4)",
  "var(--cocoa-fill-quaternary)"
];

/** Fill of a donut slice (pure): explicit tone, else the palette by index. */
export function donutSliceColor(tone: CocoaTone | undefined, index: number): string {
  if (tone) return toneColor(tone);
  return DONUT_PALETTE[index % DONUT_PALETTE.length];
}

const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0
};

const axisText: CSSProperties = { fontSize: "var(--cocoa-chart-axis-size)", fontFamily: "var(--cocoa-font)", fill: "var(--cocoa-chart-axis)" };

// ----------------------------------------------------------------- Sparkline

export interface CocoaSparklineProps {
  values: readonly number[];
  tone?: CocoaTone;
  width?: number;
  height?: number;
  /** When given the sparkline is announced; otherwise it is decorative. */
  "aria-label"?: string;
  className?: string;
}

export function CocoaSparkline({ values, tone, width = 60, height = 20, "aria-label": ariaLabel, className }: CocoaSparklineProps) {
  const d = useMemo(() => sparklinePath(values, width, height), [values, width, height]);
  if (values.length === 0) return null;
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={ariaLabel ? "img" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      className={className}
      style={{ display: "block", flexShrink: 0 }}
      data-cocoa="chart-sparkline"
      data-tone={tone}
    >
      <path d={d} fill="none" stroke={tone ? toneColor(tone) : "var(--cocoa-chart-reference)"} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ----------------------------------------------------------------- Bars

export interface CocoaBarsDatum {
  label: string;
  value: number;
  tone?: CocoaTone;
  /** Extra text for the tooltip («vs LY: +3,1 %»). */
  hint?: string;
}

export interface CocoaBarsProps {
  data: readonly CocoaBarsDatum[];
  /** Total height in px (min 60). Default 120. */
  height?: number;
  valueFormat?: (value: number) => string;
  polarity?: ChartPolarity;
  "aria-label"?: string;
}

const BARS_TOP = 16;
const BARS_AXIS = 16;

function formatSigned(value: number): string {
  return `${value > 0 ? "+" : ""}${value}`;
}

export function CocoaBars({ data, height = 120, valueFormat = formatSigned, polarity = "positive-good", "aria-label": ariaLabel }: CocoaBarsProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const chartHeight = Math.max(height, 60);
  const plotHeight = Math.max(chartHeight - BARS_TOP - BARS_AXIS, 1);
  const maxAbs = useMemo(() => Math.max(1, ...data.map((d) => Math.abs(d.value))), [data]);

  if (data.length === 0) {
    return (
      <div style={{ height: chartHeight, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-footnote)" }} role="status">
        Sin datos
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="c22-chart c22-bars"
      data-cocoa="chart"
      data-kind="bars"
      style={{ position: "relative", width: "100%", height: chartHeight, display: "flex", alignItems: "stretch", gap: "var(--cocoa-space-2)", fontFamily: "var(--cocoa-font)", ["--c22-bars-height" as string]: `${chartHeight}px` }}
    >
      {data.map((d, index) => {
        const tone = d.tone ?? barTone(d.value, polarity);
        const color = tone === "neutral" ? "var(--cocoa-chart-reference)" : toneColor(tone);
        const h = barHeight(d.value, maxAbs, plotHeight);
        const isHovered = hovered === index;
        const tooltip = [`${valueFormat(d.value)}`, d.hint].filter(Boolean).join(" · ");
        return (
          <div
            key={`${d.label}-${index}`}
            className="c22-bars__col cocoa-focus-ring"
            style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", minWidth: 0, position: "relative", height: "100%" }}
            onMouseEnter={() => setHovered(index)}
            onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(index)}
            onBlur={() => setHovered(null)}
            tabIndex={0}
            role="img"
            aria-label={`${d.label}: ${tooltip}`}
          >
            <div style={{ fontSize: "var(--cocoa-fs-caption)", lineHeight: `${BARS_TOP}px`, height: BARS_TOP, color: "var(--cocoa-label)", fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"], fontVariantNumeric: "tabular-nums", textAlign: "center" }}>
              {valueFormat(d.value)}
            </div>
            <div style={{ height: plotHeight, width: "100%", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
              <div className="c22-bars__bar" data-tone={tone} style={{ width: "100%", maxWidth: 28, minWidth: 4, height: h, background: color, borderRadius: 2, opacity: isHovered ? 0.85 : 1, transition: "opacity var(--cocoa-duration-fast) var(--cocoa-ease-out)" }} />
            </div>
            <div className="c22-bars__label" style={{ fontSize: "var(--cocoa-fs-caption)", lineHeight: `${BARS_AXIS}px`, height: BARS_AXIS, color: "var(--cocoa-label-secondary)", textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>
              {d.label}
            </div>
            {isHovered ? (
              <div
                role="tooltip"
                className="c22-chart__tooltip c22-chart__tooltip-hud"
                style={{
                  position: "absolute",
                  bottom: `calc(100% - ${BARS_TOP}px + 4px)`,
                  left: "50%",
                  transform: "translateX(-50%)",
                  background: "var(--cocoa-material-hud-bg)",
                  color: "var(--cocoa-material-hud-color)",
                  padding: "6px 8px",
                  borderRadius: "var(--cocoa-radius-sm)",
                  fontSize: "var(--cocoa-fs-caption)",
                  lineHeight: "var(--cocoa-lh-caption)",
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                  boxShadow: "var(--cocoa-shadow-popover)",
                  pointerEvents: "none",
                  zIndex: "var(--cocoa-z-tooltip)" as CSSProperties["zIndex"]
                }}
              >
                {tooltip}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------- Line

export interface CocoaLinePoint {
  /** X label (already formatted: «05-10»). */
  x: string;
  y: number;
}

export interface CocoaLineSeries {
  id: string;
  label: string;
  points: readonly CocoaLinePoint[];
  tone?: CocoaSeriesTone;
  dashed?: boolean;
  width?: 1 | 2;
}

export interface CocoaLineProps {
  series: readonly CocoaLineSeries[];
  /** Plot height in px. Default 200. */
  height?: number;
  yLabel?: string;
  ticks?: number;
  tooltip?: boolean;
  legend?: boolean;
  valueFormat?: (value: number) => string;
  /** Title of the tooltip for a point (default: its `x` label). */
  tooltipTitle?: (x: string) => string;
  "aria-label"?: string;
}

export const MIN_LINE_WIDTH = 240;

/** ViewBox width of a line chart (pure): the measured container, never below 240; the canon 640 until measured. */
export function lineViewBoxWidth(measured: number | null): number {
  return measured === null ? LINE_DEFAULT_WIDTH : Math.max(MIN_LINE_WIDTH, Math.round(measured));
}

export function CocoaLine({
  series,
  height = 200,
  yLabel,
  ticks = 4,
  tooltip = true,
  legend = true,
  valueFormat = formatChartValue,
  tooltipTitle,
  "aria-label": ariaLabel
}: CocoaLineProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const measured = useElementWidth(wrapperRef);
  const width = lineViewBoxWidth(measured);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const geometry = useMemo(() => lineGeometry(series, width, height, ticks), [series, width, height, ticks]);

  if (!geometry) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-footnote)" }} role="status">
        Sin datos
      </div>
    );
  }

  const longest = series.reduce((best, s) => (s.points.length > best.points.length ? s : best), series[0]);

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!tooltip) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const viewBoxX = ((event.clientX - rect.left) / rect.width) * width;
    setHoverIndex(geometry.indexAt(viewBoxX));
  };

  const hoverX = hoverIndex !== null ? geometry.xOf(hoverIndex) : 0;
  const hoverPct = (hoverX / width) * 100;
  const alignRight = hoverPct > 65;
  const hoverLabel = hoverIndex !== null ? longest.points[hoverIndex]?.x ?? "" : "";

  return (
    <div className="c22-chart" data-cocoa="chart" data-kind="line" style={{ position: "relative", width: "100%", fontFamily: "var(--cocoa-font)" }}>
      {legend ? (
        <div className="c22-chart__legend" aria-hidden="true" style={{ display: "flex", alignItems: "center", gap: "var(--cocoa-space-3)", flexWrap: "wrap", marginTop: 0, marginBottom: "var(--cocoa-space-3)", justifyContent: "flex-end" }}>
          {series.map((s, index) => (
            <span key={s.id} className="c22-chart__legend-item" style={{ display: "inline-flex", alignItems: "center", gap: "var(--cocoa-space-1)", fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>
              <svg className="c22-chart__swatch" width={20} height={8} viewBox="0 0 20 8" aria-hidden="true" style={{ display: "block" }}>
                <line x1={0} x2={20} y1={4} y2={4} stroke={seriesStroke(s.tone, index)} strokeWidth={2} strokeLinecap="round" strokeDasharray={s.dashed ? "5 3" : undefined} />
              </svg>
              {s.label}
            </span>
          ))}
        </div>
      ) : null}
      <div ref={wrapperRef} style={{ position: "relative", width: "100%" }}>
        <svg
          role="img"
          aria-label={ariaLabel ?? series.map((s) => s.label).join(" · ")}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          className="c22-chart__svg"
          style={{ display: "block", width: "100%", height: "auto", aspectRatio: `${width} / ${height}`, overflow: "visible", cursor: tooltip ? "crosshair" : "default" }}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIndex(null)}
        >
          <g>
            {geometry.yTicks.map((tick) => (
              <g key={`y-${tick.value}`}>
                <line className="c22-chart__grid" x1={LINE_PADDING.left} x2={width - LINE_PADDING.right} y1={tick.y} y2={tick.y} stroke="var(--cocoa-chart-grid)" strokeWidth={1} shapeRendering="crispEdges" />
                <text className="c22-chart__axis" x={LINE_PADDING.left - 8} y={tick.y} textAnchor="end" dominantBaseline="central" style={axisText}>
                  {formatYTick(tick.value, geometry.yMax)}
                </text>
              </g>
            ))}
          </g>
          <g>
            {geometry.xTicks.map((tick) => (
              <text key={`x-${tick.i}`} className="c22-chart__axis" x={tick.x} y={height - LINE_PADDING.bottom + 16} textAnchor="middle" style={axisText}>
                {tick.label}
              </text>
            ))}
          </g>
          {yLabel ? (
            <text className="c22-chart__axis" x={LINE_PADDING.left - 36} y={LINE_PADDING.top - 4} textAnchor="start" style={axisText}>
              {yLabel}
            </text>
          ) : null}
          {series.map((s, index) => {
            const toneName = seriesToneName(s.tone, index);
            const strokeWidth = s.width ?? (toneName === "tertiary" ? 1 : 2);
            return (
              <path
                key={s.id}
                className="c22-chart__series"
                data-tone={toneName}
                data-dashed={s.dashed ? "true" : undefined}
                data-width={strokeWidth}
                d={buildPathD(geometry.series[index])}
                fill="none"
                stroke={seriesStroke(s.tone, index)}
                strokeWidth={strokeWidth}
                strokeDasharray={s.dashed ? "6 4" : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          {hoverIndex !== null ? (
            <g pointerEvents="none">
              <line className="c22-chart__guide" x1={hoverX} x2={hoverX} y1={LINE_PADDING.top} y2={height - LINE_PADDING.bottom} stroke="var(--cocoa-chart-reference)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
              {series.map((s, index) => {
                const point = geometry.series[index][hoverIndex];
                if (!point) return null;
                return <circle key={s.id} cx={point.x} cy={point.y} r={3.5} fill={seriesStroke(s.tone, index)} stroke="var(--cocoa-background-content)" strokeWidth={1.5} />;
              })}
            </g>
          ) : null}
        </svg>
        {tooltip && hoverIndex !== null ? (
          <div
            className="c22-chart__tooltip"
            style={{
              position: "absolute",
              top: 8,
              left: alignRight ? undefined : `calc(${hoverPct}% + 12px)`,
              right: alignRight ? `calc(${100 - hoverPct}% + 12px)` : undefined,
              pointerEvents: "none",
              background: "var(--cocoa-background-content)",
              border: "1px solid var(--cocoa-separator)",
              borderRadius: "var(--cocoa-radius-md)",
              boxShadow: "var(--cocoa-shadow-control)",
              padding: "var(--cocoa-space-2) var(--cocoa-space-3)",
              fontSize: "var(--cocoa-fs-caption)",
              color: "var(--cocoa-label)",
              whiteSpace: "nowrap",
              fontFeatureSettings: "var(--cocoa-font-numeric-tabular)",
              zIndex: "var(--cocoa-z-tooltip)" as CSSProperties["zIndex"]
            }}
          >
            <div style={{ fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"], marginBottom: "var(--cocoa-space-1)" }}>
              {tooltipTitle ? tooltipTitle(hoverLabel) : hoverLabel}
            </div>
            {series.map((s, index) => {
              const point = s.points[hoverIndex];
              return (
                <div key={s.id} style={{ display: "flex", alignItems: "center", gap: "var(--cocoa-space-2)", color: "var(--cocoa-label-secondary)" }}>
                  <span
                    aria-hidden="true"
                    style={{
                      display: "inline-block",
                      width: 8,
                      height: 8,
                      borderRadius: s.dashed ? 0 : "var(--cocoa-radius-full)",
                      background: s.dashed ? "transparent" : seriesStroke(s.tone, index),
                      border: s.dashed ? `2px dashed ${seriesStroke(s.tone, index)}` : undefined,
                      flexShrink: 0
                    }}
                  />
                  <span>{s.label}:&nbsp;</span>
                  <strong style={{ color: "var(--cocoa-label)" }}>{point ? valueFormat(point.y) : "—"}</strong>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      {longest.points.length > 12 ? (
        <table style={srOnly}>
          <caption>{ariaLabel ?? "Serie"}</caption>
          <thead>
            <tr>
              <th scope="col">Fecha</th>
              {series.map((s) => (
                <th key={s.id} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {longest.points.map((p, i) => (
              <tr key={`${p.x}-${i}`}>
                <th scope="row">{p.x}</th>
                {series.map((s) => (
                  <td key={s.id}>{s.points[i] ? valueFormat(s.points[i].y) : "—"}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------- Gauge

export interface CocoaGaugeProps {
  value: number;
  min?: number;
  max?: number;
  /** `[warnAt, dangerAt]`; below the first success, below the second warning, else danger. */
  thresholds?: [number, number];
  /** Higher is better (flips the threshold tones). */
  invert?: boolean;
  /** Text under the figure («Riesgo cancelación»). */
  label?: string;
  /** Text under the label («12 reservas en riesgo»). */
  caption?: string;
  format?: (value: number) => string;
  "aria-label"?: string;
}

/** Spanish qualifier of a gauge tone (pure). */
export function gaugeToneLabel(tone: "success" | "warning" | "danger"): string {
  return tone === "success" ? "bajo" : tone === "warning" ? "moderado" : "alto";
}

export function CocoaGauge({ value, min = 0, max = 100, thresholds = [30, 60], invert = false, label, caption, format, "aria-label": ariaLabel }: CocoaGaugeProps) {
  const clamped = Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
  const tone = thresholdTone(clamped, thresholds, invert);
  const color = toneColor(tone);
  const geometry = useMemo(() => gaugeGeometry(clamped, min, max), [clamped, min, max]);
  const text = format ? format(clamped) : formatPercent(clamped, { maximumFractionDigits: 0 });

  return (
    <div className="c22-chart" data-cocoa="chart" data-kind="gauge" data-tone={tone} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--cocoa-space-2)", fontFamily: "var(--cocoa-font)", width: "100%" }}>
      <div style={{ position: "relative", width: "100%", maxWidth: GAUGE.width, display: "flex", justifyContent: "center" }}>
        <svg viewBox={`0 0 ${GAUGE.width} ${GAUGE.height}`} width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label={ariaLabel ?? `${label ?? "Indicador"} ${text} (${gaugeToneLabel(tone)})`} style={{ display: "block", aspectRatio: `${GAUGE.width} / ${GAUGE.height}` }}>
          <path className="c22-gauge__track" d={geometry.trackPath} fill="none" stroke="var(--cocoa-chart-track)" strokeWidth={GAUGE.stroke} strokeLinecap="round" />
          <path className="c22-gauge__arc" data-tone={tone} d={geometry.progressPath} fill="none" stroke={color} strokeWidth={GAUGE.stroke} strokeLinecap="round" />
          <path d={geometry.needlePath} fill={color} />
          <circle cx={GAUGE.cx} cy={GAUGE.cy} r={6} fill={color} />
          <circle cx={GAUGE.cx} cy={GAUGE.cy} r={3} fill="var(--cocoa-background-content)" />
        </svg>
        <div aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, bottom: 6, display: "flex", flexDirection: "column", alignItems: "center", pointerEvents: "none" }}>
          <span style={{ fontSize: "var(--cocoa-fs-title-1)", fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"], letterSpacing: "var(--cocoa-tracking-tight)", lineHeight: 1, color: "var(--cocoa-label)", fontVariantNumeric: "tabular-nums" }}>
            {text}
          </span>
          {label ? <span style={{ marginTop: "var(--cocoa-space-1)", fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)", textAlign: "center" }}>{label}</span> : null}
        </div>
      </div>
      {caption ? <p style={{ margin: 0, fontSize: "var(--cocoa-fs-subheadline)", color: "var(--cocoa-label-secondary)", textAlign: "center" }}>{caption}</p> : null}
    </div>
  );
}

// ----------------------------------------------------------------- Donut

export interface CocoaDonutSlice {
  label: string;
  value: number;
  tone?: CocoaTone;
}

export interface CocoaDonutProps {
  slices: readonly CocoaDonutSlice[];
  centerLabel?: string;
  centerValue?: string;
  /** Diameter in px. Default 160. */
  size?: number;
  legend?: boolean;
  valueFormat?: (value: number) => string;
  "aria-label"?: string;
}

/** Share of a donut slice as es-ES percent with at most one decimal (pure): 0.125 → «12,5 %», 0.5 → «50 %». */
export function donutShareLabel(share: number): string {
  return formatPercent(share, { ratio: true, maximumFractionDigits: 1 });
}

export function CocoaDonut({ slices, centerLabel, centerValue, size = 160, legend = true, valueFormat, "aria-label": ariaLabel }: CocoaDonutProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const { segments, total } = useMemo(() => donutSegments(slices, size), [slices, size]);
  const empty = segments.length === 0 || total <= 0;
  const percent = (share: number) => donutShareLabel(share);

  return (
    <div className="c22-chart" data-cocoa="chart" data-kind="donut" style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-4)", width: "100%", fontFamily: "var(--cocoa-font)" }}>
      <div style={{ position: "relative", width: size, height: size, maxWidth: "100%", margin: "0 auto" }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={ariaLabel ?? centerLabel ?? "Distribución"} style={{ display: "block", overflow: "visible", maxWidth: "100%" }}>
          {empty ? (
            <circle cx={size / 2} cy={size / 2} r={size / 2 - 0.5} fill="none" stroke="var(--cocoa-separator)" strokeWidth={1} strokeDasharray="4 4" />
          ) : (
            segments.map((segment, index) =>
              segment.share > 0 ? (
                <path
                  key={`${segment.slice.label}-${index}`}
                  className="c22-donut__slice"
                  data-index={segment.slice.tone ? undefined : index % DONUT_PALETTE.length}
                  data-tone={segment.slice.tone}
                  d={segment.path}
                  fill={donutSliceColor(segment.slice.tone, index)}
                  stroke="var(--cocoa-background-content)"
                  strokeWidth={1.5}
                  style={{ opacity: hovered !== null && hovered !== index ? 0.55 : 1, transition: "opacity var(--cocoa-duration-fast) var(--cocoa-ease-out)" }}
                  onMouseEnter={() => setHovered(index)}
                  onMouseLeave={() => setHovered(null)}
                >
                  <title>{`${segment.slice.label}: ${percent(segment.share)}`}</title>
                </path>
              ) : null
            )
          )}
        </svg>
        <div aria-hidden="true" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none", textAlign: "center", padding: "0 var(--cocoa-space-3)" }}>
          {centerValue ? (
            <span style={{ fontSize: "var(--cocoa-fs-title-2)", fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"], color: "var(--cocoa-label)", lineHeight: 1.1, fontVariantNumeric: "tabular-nums" }}>
              {centerValue}
            </span>
          ) : null}
          {centerLabel ? <span style={{ marginTop: 4, fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)", letterSpacing: "var(--cocoa-tracking-wide)" }}>{centerLabel}</span> : null}
        </div>
      </div>
      {legend ? (
        <ul className="c22-chart__legend" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "var(--cocoa-space-2)", marginTop: 0 }}>
          {segments.map((segment, index) => (
            <li
              key={`${segment.slice.label}-legend-${index}`}
              className="c22-chart__legend-item"
              style={{ display: "flex", alignItems: "center", gap: "var(--cocoa-space-2)", fontSize: "var(--cocoa-fs-body)", color: "var(--cocoa-label)", whiteSpace: "normal" }}
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(null)}
            >
              <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: donutSliceColor(segment.slice.tone, index), flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{segment.slice.label}</span>
              <span style={{ color: "var(--cocoa-label-secondary)", fontVariantNumeric: "tabular-nums", fontSize: "var(--cocoa-fs-subheadline)" }}>
                {valueFormat ? valueFormat(segment.slice.value) : percent(segment.share)}
              </span>
            </li>
          ))}
          {empty ? <li style={{ fontSize: "var(--cocoa-fs-subheadline)", color: "var(--cocoa-label-secondary)", textAlign: "center" }}>Sin datos.</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------- Progress

export interface CocoaProgressProps {
  /** 0–100. */
  value: number;
  tone?: CocoaTone;
  label?: string;
  /** Show «NN %» at the right of the label. Default true. */
  showValue?: boolean;
  "aria-label"?: string;
}

export function CocoaProgress({ value, tone = "accent", label, showValue = true, "aria-label": ariaLabel }: CocoaProgressProps) {
  const pct = clampPercent(value);
  const text = formatPercent(pct, { maximumFractionDigits: 0 });
  return (
    <div className="c22-chart" data-cocoa="chart" data-kind="progress" style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-1)", width: "100%", fontFamily: "var(--cocoa-font)" }}>
      {label || showValue ? (
        <div className="c22-progress__label" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "var(--cocoa-space-2)", fontSize: "var(--cocoa-fs-caption)", marginBottom: 0 }}>
          <span style={{ color: "var(--cocoa-label-secondary)", fontWeight: "var(--cocoa-fw-medium)" as CSSProperties["fontWeight"], textTransform: "uppercase", letterSpacing: "var(--cocoa-tracking-wide)" }}>{label}</span>
          {showValue ? <span style={{ color: toneInk(tone), fontVariantNumeric: "tabular-nums", fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"] }}>{text}</span> : null}
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-label={ariaLabel ?? label}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="c22-progress"
        data-cocoa="progress"
        data-tone={tone}
        style={{ display: "block", height: 6, width: "100%", background: "var(--cocoa-chart-track)", borderRadius: "var(--cocoa-radius-full)", overflow: "hidden" }}
      >
        <div className="c22-progress__fill" style={{ display: "block", height: "100%", width: `${pct}%`, background: toneColor(tone), borderRadius: "var(--cocoa-radius-full)", transition: "width var(--cocoa-duration-base) var(--cocoa-ease-out)" }} />
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- namespace

/** `CocoaChart.Line` etc. — one import for screens (COCOA-22.md §8). */
export const CocoaChart = {
  Sparkline: CocoaSparkline,
  Bars: CocoaBars,
  Line: CocoaLine,
  Gauge: CocoaGauge,
  Donut: CocoaDonut,
  Progress: CocoaProgress
} as const;

export type CocoaChartNamespace = typeof CocoaChart;
export type { ReactNode as CocoaChartNode };

export default CocoaChart;
