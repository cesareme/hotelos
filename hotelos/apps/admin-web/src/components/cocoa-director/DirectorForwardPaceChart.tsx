// Director Forward Pace Chart — multi-line pickup chart (OTB vs Forecast vs
// Last Year) for the commercial director's view. Base of `CocoaChart.Line`
// (COCOA-22.md §3.12); the geometry helpers now come from
// `cocoa/cocoa-chart-math` so both render the same shapes.
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
//
// Wrapped in CocoaCard padding="md" to align with the rest of the Cocoa UI.

import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { CocoaCard } from "../cocoa/CocoaCard";
import { CocoaEmptyState } from "../cocoa-empty-state/CocoaEmptyState";
import { EmptyStateBox } from "../cocoa-illustrations";
import { buildPathD, formatChartValue, formatYTick, niceCeil, pickXStep } from "../cocoa/cocoa-chart-math";
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

// ---------------------------------------------------------------------------
// SVG layout constants: inner padding of the plot area.
// ---------------------------------------------------------------------------

const CHART_PADDING = {
  top: 16,
  right: 16,
  bottom: 32,
  left: 44
} as const;

/** Canon viewBox width (used until the container is measured). */
export const VIEWBOX_WIDTH = 640;
/** Narrowest viewBox: below this the axis labels would collide. */
export const MIN_VIEWBOX_WIDTH = 240;
const Y_TICKS = 4;

/** ViewBox width for a measured container width (pure): canon 640 until measured, never below 240. */
export function paceViewBoxWidth(measured: number | null): number {
  return measured === null ? VIEWBOX_WIDTH : Math.max(MIN_VIEWBOX_WIDTH, Math.round(measured));
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
  zIndex: 2
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

export function DirectorForwardPaceChart({
  data,
  days = 30,
  valueLabel = "Ocupación %",
  height = 200,
  title
}: DirectorForwardPaceChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const measured = useElementWidth(wrapperRef);
  const viewBoxWidth = paceViewBoxWidth(measured);

  // First `days` points.
  const slice = useMemo(() => data.slice(0, Math.max(0, days)), [data, days]);

  // Scales and coordinates. Memoised so hover does not recompute them.
  const geometry = useMemo(() => {
    if (slice.length === 0) return null;

    const innerWidth = viewBoxWidth - CHART_PADDING.left - CHART_PADDING.right;
    const innerHeight = height - CHART_PADDING.top - CHART_PADDING.bottom;

    // Y range from the maximum of the three series. Minimum 0.
    let rawMax = 0;
    for (const p of slice) {
      if (p.otb > rawMax) rawMax = p.otb;
      if (p.forecast > rawMax) rawMax = p.forecast;
      if (p.lastYear > rawMax) rawMax = p.lastYear;
    }
    const yMax = niceCeil(rawMax || 1);

    // A single point sits at the horizontal centre.
    const xOf = (i: number) => {
      if (slice.length === 1) {
        return CHART_PADDING.left + innerWidth / 2;
      }
      return CHART_PADDING.left + (innerWidth * i) / (slice.length - 1);
    };
    const yOf = (v: number) => CHART_PADDING.top + innerHeight * (1 - v / yMax);

    const otbPoints = slice.map((p, i) => ({ x: xOf(i), y: yOf(p.otb) }));
    const forecastPoints = slice.map((p, i) => ({ x: xOf(i), y: yOf(p.forecast) }));
    const lastYearPoints = slice.map((p, i) => ({ x: xOf(i), y: yOf(p.lastYear) }));

    // X ticks.
    const xStep = pickXStep(slice.length);
    const xTicks: Array<{ i: number; x: number; label: string }> = [];
    for (let i = 0; i < slice.length; i += xStep) {
      xTicks.push({ i, x: xOf(i), label: formatDayMonth(slice[i].date) });
    }
    // Always show the last tick even when it does not fall on the step.
    if (xTicks.length > 0 && xTicks[xTicks.length - 1].i !== slice.length - 1) {
      const lastIdx = slice.length - 1;
      xTicks.push({ i: lastIdx, x: xOf(lastIdx), label: formatDayMonth(slice[lastIdx].date) });
    }

    // Y ticks (Y_TICKS + 1 values including 0 and yMax).
    const yTicks: Array<{ value: number; y: number }> = [];
    for (let i = 0; i <= Y_TICKS; i += 1) {
      const value = (yMax * i) / Y_TICKS;
      yTicks.push({ value, y: yOf(value) });
    }

    return {
      innerWidth,
      innerHeight,
      yMax,
      xOf,
      yOf,
      otbPoints,
      forecastPoints,
      lastYearPoints,
      xTicks,
      yTicks
    };
  }, [slice, height, viewBoxWidth]);

  // Empty state, wrapped in the same CocoaCard padding="md" as the chart.
  if (slice.length === 0 || !geometry) {
    return (
      <CocoaCard variant="bordered" padding="md">
        <CocoaEmptyState
          illustration={<EmptyStateBox tone="accent" size={160} />}
          title="Sin datos de pickup todavía"
        />
      </CocoaCard>
    );
  }

  const { innerWidth, yMax, otbPoints, forecastPoints, lastYearPoints, xTicks, yTicks } = geometry;

  // Maps a pointer event on the SVG to the nearest index: the pointer position
  // relative to the bounding rect is projected into viewBox space (the SVG
  // keeps the viewBox aspect ratio, so the mapping is linear).
  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const relativeX = ((event.clientX - rect.left) / rect.width) * viewBoxWidth;

    if (slice.length === 1) {
      setHoverIndex(0);
      return;
    }
    const ratio = (relativeX - CHART_PADDING.left) / (innerWidth === 0 ? 1 : innerWidth);
    const idx = Math.round(ratio * (slice.length - 1));
    const clamped = Math.max(0, Math.min(slice.length - 1, idx));
    setHoverIndex(clamped);
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
                <line
                  x1={CHART_PADDING.left}
                  x2={viewBoxWidth - CHART_PADDING.right}
                  y1={tick.y}
                  y2={tick.y}
                  stroke="var(--cocoa-separator)"
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={CHART_PADDING.left - 8}
                  y={tick.y}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize={10}
                  fill="var(--cocoa-label-tertiary)"
                  fontFamily="var(--cocoa-font)"
                >
                  {formatYTick(tick.value, yMax)}
                </text>
              </g>
            ))}
          </g>

          {/* X axis labels */}
          <g>
            {xTicks.map((tick) => (
              <text
                key={`x-${tick.i}`}
                x={tick.x}
                y={height - CHART_PADDING.bottom + 16}
                textAnchor="middle"
                fontSize={10}
                fill="var(--cocoa-label-tertiary)"
                fontFamily="var(--cocoa-font)"
              >
                {tick.label}
              </text>
            ))}
          </g>

          {/* Y axis label (valueLabel) */}
          <text
            x={CHART_PADDING.left - 36}
            y={CHART_PADDING.top - 4}
            textAnchor="start"
            fontSize={10}
            fill="var(--cocoa-label-tertiary)"
            fontFamily="var(--cocoa-font)"
          >
            {valueLabel}
          </text>

          {/* Last Year (grey, 1 px, solid) */}
          <path
            d={buildPathD(lastYearPoints)}
            fill="none"
            stroke="var(--cocoa-label-tertiary)"
            strokeWidth={1}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* Forecast (warning, dashed, 2 px) */}
          <path
            d={buildPathD(forecastPoints)}
            fill="none"
            stroke="var(--cocoa-warning)"
            strokeWidth={2}
            strokeDasharray="6 4"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* OTB (accent, solid, 2 px) */}
          <path
            d={buildPathD(otbPoints)}
            fill="none"
            stroke="var(--cocoa-accent)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* Hover: vertical guide + points */}
          {hoverIndex !== null ? (
            <g pointerEvents="none">
              <line
                x1={hoverX}
                x2={hoverX}
                y1={CHART_PADDING.top}
                y2={height - CHART_PADDING.bottom}
                stroke="var(--cocoa-label-tertiary)"
                strokeWidth={1}
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={otbPoints[hoverIndex].x}
                cy={otbPoints[hoverIndex].y}
                r={3.5}
                fill="var(--cocoa-accent)"
                stroke="var(--cocoa-background-content)"
                strokeWidth={1.5}
              />
              <circle
                cx={forecastPoints[hoverIndex].x}
                cy={forecastPoints[hoverIndex].y}
                r={3.5}
                fill="var(--cocoa-warning)"
                stroke="var(--cocoa-background-content)"
                strokeWidth={1.5}
              />
              <circle
                cx={lastYearPoints[hoverIndex].x}
                cy={lastYearPoints[hoverIndex].y}
                r={3}
                fill="var(--cocoa-label-tertiary)"
                stroke="var(--cocoa-background-content)"
                strokeWidth={1.5}
              />
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
  const color =
    tone === "accent"
      ? "var(--cocoa-accent)"
      : tone === "warning"
        ? "var(--cocoa-warning)"
        : "var(--cocoa-label-tertiary)";
  return (
    <span style={legendItemStyle}>
      <svg width={20} height={8} viewBox="0 0 20 8" aria-hidden="true" style={{ display: "block" }}>
        <line
          x1={0}
          x2={20}
          y1={4}
          y2={4}
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={dashed ? "5 3" : undefined}
        />
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
