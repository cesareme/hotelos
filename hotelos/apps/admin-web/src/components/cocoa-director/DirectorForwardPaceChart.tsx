// Director Forward Pace Chart — multi-line pickup chart (OTB vs Forecast vs
// Last Year) for the commercial director's view. Base of `CocoaChart.Line`
// (COCOA-22.md §3.12).
//
// Cocoa 22 (ola 2): the whole geometry (scales, ticks, hover index, viewBox
// width) now comes from `cocoa/cocoa-chart-math` (`lineGeometry`,
// `LINE_PADDING`) and `cocoa/CocoaChart` (`lineViewBoxWidth`), the same
// helpers `CocoaChart.Line` uses, so both render the same shapes. Screens
// should use `CocoaChart.Line`; this component stays for legacy callers and
// its exported sizing helpers until wave 11.
//
// Inline SVG (no external dependencies). Three series:
//   - OTB:       solid line, accent (--cocoa-accent), 2 px.
//   - Forecast:  dashed line, warning (--cocoa-warning), 2 px.
//   - Last Year: solid line, tertiary, 1 px.
//
// Behaviour:
//   - X axis with DD-MM dates, thinned to ≤ ~8 labels.
//   - Y axis with the value (occupancy % or rooms); configurable label.
//   - Hover: vertical guide + tooltip card with the date and the values.
//   - Legend top-right; optional title top-left.
//   - Empty state when `data` is empty: illustration + message.
//
// Sizing (Cocoa 22 fix, measured 276×200 stretched at 390 px with the old
// `preserveAspectRatio="none"`): the chart measures its container and uses
// that width as the viewBox width (min 240; the canon 640 until measured),
// with `preserveAspectRatio="xMidYMid meet"` and an explicit `aspect-ratio`
// equal to the viewBox — so the glyphs are never deformed and the plot keeps
// its `height` at every width.

import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { CocoaCard } from "../cocoa/CocoaCard";
import { CocoaState } from "../cocoa/CocoaState";
import { MIN_LINE_WIDTH, lineViewBoxWidth } from "../cocoa/CocoaChart";
import { LINE_DEFAULT_WIDTH, LINE_PADDING, buildPathD, formatChartValue, formatYTick, lineGeometry } from "../cocoa/cocoa-chart-math";
import { useElementWidth } from "../cocoa/cocoa-viewport";

export interface DirectorForwardPacePoint {
  /** ISO date (YYYY-MM-DD) or any Date-parseable string. */
  date: string;
  /** Confirmed pickup (On The Books). */
  otb: number;
  /** Forecast for that date. */
  forecast: number;
  /** Same day, previous year. */
  lastYear: number;
}

export interface DirectorForwardPaceChartProps {
  data: Array<DirectorForwardPacePoint>;
  /** Maximum number of days to show (slice from the start). Default 30. */
  days?: number;
  /** Y axis label (e.g. "Ocupación %", "Rooms"). */
  valueLabel?: string;
  /** Height of the plot area (not of the whole card). Default 200. */
  height?: number;
  /** Optional title, top-left. */
  title?: string;
}

/** Canon viewBox width (used until the container is measured) — `LINE_DEFAULT_WIDTH` of cocoa-chart-math. */
export const VIEWBOX_WIDTH = LINE_DEFAULT_WIDTH;
/** Narrowest viewBox: below this the axis labels would collide — `MIN_LINE_WIDTH` of CocoaChart. */
export const MIN_VIEWBOX_WIDTH = MIN_LINE_WIDTH;
const Y_TICKS = 4;

/** ViewBox width for a measured container width (pure): canon 640 until measured, never below 240. Alias of `lineViewBoxWidth`. */
export function paceViewBoxWidth(measured: number | null): number {
  return lineViewBoxWidth(measured);
}

// ---------------------------------------------------------------------------
// Inner wrapper styles (title + legend + svg). The card padding comes from
// CocoaCard padding="md".
// ---------------------------------------------------------------------------

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--cocoa-space-3)",
  marginBottom: "var(--cocoa-space-3)",
  flexWrap: "wrap",
  fontFamily: "var(--cocoa-font)"
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-title-3)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label)",
  letterSpacing: "var(--cocoa-tracking-tight)"
};

const legendRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--cocoa-space-3)",
  flexWrap: "wrap",
  marginLeft: "auto"
};

const legendItemStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--cocoa-space-1)",
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)",
  fontFeatureSettings: "var(--cocoa-font-numeric-tabular)"
};

const chartWrapperStyle: CSSProperties = {
  position: "relative",
  width: "100%"
};

const svgStyle: CSSProperties = {
  display: "block",
  width: "100%",
  height: "auto",
  overflow: "visible",
  cursor: "crosshair"
};

const tooltipStyle: CSSProperties = {
  position: "absolute",
  pointerEvents: "none",
  background: "var(--cocoa-background-content)",
  border: "1px solid var(--cocoa-separator)",
  borderRadius: "var(--cocoa-radius-md)",
  boxShadow: "var(--cocoa-shadow-control)",
  padding: "var(--cocoa-space-2) var(--cocoa-space-3)",
  fontFamily: "var(--cocoa-font)",
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label)",
  whiteSpace: "nowrap",
  fontFeatureSettings: "var(--cocoa-font-numeric-tabular)",
  zIndex: "var(--cocoa-z-tooltip)" as CSSProperties["zIndex"]
};

const tooltipDateStyle: CSSProperties = {
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  marginBottom: "var(--cocoa-space-1)",
  color: "var(--cocoa-label)"
};

const tooltipRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--cocoa-space-2)",
  color: "var(--cocoa-label-secondary)"
};

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Formats an ISO date as "DD-MM"; returns the input when it is not a date. */
function formatDayMonth(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const dd = String(parsed.getUTCDate()).padStart(2, "0");
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}`;
}

// ---------------------------------------------------------------------------
// Main component.
// ---------------------------------------------------------------------------

export function DirectorForwardPaceChart({ data, days = 30, valueLabel = "Ocupación %", height = 200, title }: DirectorForwardPaceChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const measured = useElementWidth(wrapperRef);
  const viewBoxWidth = paceViewBoxWidth(measured);

  // First `days` points.
  const slice = useMemo(() => data.slice(0, Math.max(0, days)), [data, days]);

  // Scales and coordinates from cocoa-chart-math. Memoised so hover does not recompute them.
  const geometry = useMemo(() => {
    if (slice.length === 0) return null;
    const labels = slice.map((p) => formatDayMonth(p.date));
    return lineGeometry(
      [
        { id: "otb", points: slice.map((p, i) => ({ x: labels[i], y: p.otb })) },
        { id: "forecast", points: slice.map((p, i) => ({ x: labels[i], y: p.forecast })) },
        { id: "last-year", points: slice.map((p, i) => ({ x: labels[i], y: p.lastYear })) }
      ],
      viewBoxWidth,
      height,
      Y_TICKS
    );
  }, [slice, height, viewBoxWidth]);

  // Empty state, wrapped in the same CocoaCard padding="md" as the chart.
  if (slice.length === 0 || !geometry) {
    return (
      <CocoaCard variant="bordered" padding="md">
        <CocoaState kind="empty" illustration="box" title="Sin datos de pickup todavía" />
      </CocoaCard>
    );
  }

  const { yMax, xTicks, yTicks, indexAt } = geometry;
  const [otbPoints, forecastPoints, lastYearPoints] = geometry.series;

  // Maps a pointer event on the SVG to the nearest index: the pointer position
  // relative to the bounding rect is projected into viewBox space (the SVG
  // keeps the viewBox aspect ratio, so the mapping is linear).
  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const relativeX = ((event.clientX - rect.left) / rect.width) * viewBoxWidth;
    setHoverIndex(indexAt(relativeX));
  }

  function handlePointerLeave() {
    setHoverIndex(null);
  }

  const hoverPoint = hoverIndex !== null ? slice[hoverIndex] : null;
  const hoverX = hoverIndex !== null ? otbPoints[hoverIndex].x : 0;

  // Tooltip position (HTML overlay), as a percentage of the viewBox width —
  // the same mapping as `relativeX`.
  const tooltipLeftPct = (hoverX / viewBoxWidth) * 100;
  // Past the right third, anchor the tooltip to the right of the point so it is not cut.
  const tooltipAlignRight = tooltipLeftPct > 65;

  return (
    <CocoaCard variant="bordered" padding="md">
      <div style={headerRowStyle}>
        {title ? <h3 style={titleStyle}>{title}</h3> : <span />}
        <div style={legendRowStyle} aria-hidden="true">
          <LegendSwatch tone="accent" label="OTB" />
          <LegendSwatch tone="warning" label="Forecast" dashed />
          <LegendSwatch tone="muted" label="Año anterior" />
        </div>
      </div>

      <div ref={wrapperRef} style={chartWrapperStyle}>
        <svg
          role="img"
          aria-label={title ? `${title} — ${valueLabel}` : `Pace chart — ${valueLabel}`}
          viewBox={`0 0 ${viewBoxWidth} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ ...svgStyle, aspectRatio: `${viewBoxWidth} / ${height}` }}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
        >
          {/* Horizontal grid + Y ticks */}
          <g>
            {yTicks.map((tick) => (
              <g key={`y-${tick.value}`}>
                <line x1={LINE_PADDING.left} x2={viewBoxWidth - LINE_PADDING.right} y1={tick.y} y2={tick.y} stroke="var(--cocoa-separator)" strokeWidth={1} shapeRendering="crispEdges" />
                <text x={LINE_PADDING.left - 8} y={tick.y} textAnchor="end" dominantBaseline="central" fontSize={10} fill="var(--cocoa-label-tertiary)" fontFamily="var(--cocoa-font)">
                  {formatYTick(tick.value, yMax)}
                </text>
              </g>
            ))}
          </g>

          {/* X axis labels */}
          <g>
            {xTicks.map((tick) => (
              <text key={`x-${tick.i}`} x={tick.x} y={height - LINE_PADDING.bottom + 16} textAnchor="middle" fontSize={10} fill="var(--cocoa-label-tertiary)" fontFamily="var(--cocoa-font)">
                {tick.label}
              </text>
            ))}
          </g>

          {/* Y axis label (valueLabel) */}
          <text x={LINE_PADDING.left - 36} y={LINE_PADDING.top - 4} textAnchor="start" fontSize={10} fill="var(--cocoa-label-tertiary)" fontFamily="var(--cocoa-font)">
            {valueLabel}
          </text>

          {/* Last Year (grey, 1 px, solid) */}
          <path d={buildPathD(lastYearPoints)} fill="none" stroke="var(--cocoa-label-tertiary)" strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />

          {/* Forecast (warning, dashed, 2 px) */}
          <path d={buildPathD(forecastPoints)} fill="none" stroke="var(--cocoa-warning)" strokeWidth={2} strokeDasharray="6 4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />

          {/* OTB (accent, solid, 2 px) */}
          <path d={buildPathD(otbPoints)} fill="none" stroke="var(--cocoa-accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />

          {/* Hover: vertical guide + points */}
          {hoverIndex !== null ? (
            <g pointerEvents="none">
              <line x1={hoverX} x2={hoverX} y1={LINE_PADDING.top} y2={height - LINE_PADDING.bottom} stroke="var(--cocoa-label-tertiary)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
              <circle cx={otbPoints[hoverIndex].x} cy={otbPoints[hoverIndex].y} r={3.5} fill="var(--cocoa-accent)" stroke="var(--cocoa-background-content)" strokeWidth={1.5} />
              <circle cx={forecastPoints[hoverIndex].x} cy={forecastPoints[hoverIndex].y} r={3.5} fill="var(--cocoa-warning)" stroke="var(--cocoa-background-content)" strokeWidth={1.5} />
              <circle cx={lastYearPoints[hoverIndex].x} cy={lastYearPoints[hoverIndex].y} r={3} fill="var(--cocoa-label-tertiary)" stroke="var(--cocoa-background-content)" strokeWidth={1.5} />
            </g>
          ) : null}
        </svg>

        {/* Tooltip overlay (HTML) */}
        {hoverPoint ? (
          <div
            style={{
              ...tooltipStyle,
              left: tooltipAlignRight ? undefined : `calc(${tooltipLeftPct}% + 12px)`,
              right: tooltipAlignRight ? `calc(${100 - tooltipLeftPct}% + 12px)` : undefined,
              top: 8
            }}
          >
            <div style={tooltipDateStyle}>{formatTooltipDate(hoverPoint.date)}</div>
            <div style={tooltipRowStyle}>
              <Dot color="var(--cocoa-accent)" />
              <span>OTB:&nbsp;</span>
              <strong style={{ color: "var(--cocoa-label)" }}>{formatChartValue(hoverPoint.otb)}</strong>
            </div>
            <div style={tooltipRowStyle}>
              <Dot color="var(--cocoa-warning)" dashed />
              <span>Forecast:&nbsp;</span>
              <strong style={{ color: "var(--cocoa-label)" }}>{formatChartValue(hoverPoint.forecast)}</strong>
            </div>
            <div style={tooltipRowStyle}>
              <Dot color="var(--cocoa-label-tertiary)" />
              <span>Año anterior:&nbsp;</span>
              <strong style={{ color: "var(--cocoa-label)" }}>{formatChartValue(hoverPoint.lastYear)}</strong>
            </div>
          </div>
        ) : null}
      </div>
    </CocoaCard>
  );
}

// ---------------------------------------------------------------------------
// Presentational subcomponents.
// ---------------------------------------------------------------------------

interface LegendSwatchProps {
  tone: "accent" | "warning" | "muted";
  label: string;
  dashed?: boolean;
}

function LegendSwatch({ tone, label, dashed = false }: LegendSwatchProps) {
  const color = tone === "accent" ? "var(--cocoa-accent)" : tone === "warning" ? "var(--cocoa-warning)" : "var(--cocoa-label-tertiary)";
  return (
    <span style={legendItemStyle}>
      <svg width={20} height={8} viewBox="0 0 20 8" aria-hidden="true" style={{ display: "block" }}>
        <line x1={0} x2={20} y1={4} y2={4} stroke={color} strokeWidth={2} strokeLinecap="round" strokeDasharray={dashed ? "5 3" : undefined} />
      </svg>
      {label}
    </span>
  );
}

interface DotProps {
  color: string;
  dashed?: boolean;
}

function Dot({ color, dashed = false }: DotProps) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: dashed ? 0 : "var(--cocoa-radius-full)",
        background: dashed ? "transparent" : color,
        border: dashed ? `2px dashed ${color}` : undefined,
        flexShrink: 0
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Formatters.
// ---------------------------------------------------------------------------

function formatTooltipDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const dd = String(parsed.getUTCDate()).padStart(2, "0");
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = parsed.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

export default DirectorForwardPaceChart;
