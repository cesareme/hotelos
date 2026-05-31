// Director Forward Pace Chart — gráfico multi-línea de pickup (OTB vs Forecast
// vs Last Year) para la vista del Director Comercial.
//
// Implementación SVG inline (sin dependencias externas). Tres series:
//   - OTB:       línea sólida, color accent (--cocoa-accent), 2px.
//   - Forecast:  línea dashed, color warning (--cocoa-warning), 2px.
//   - Last Year: línea sólida, color terciario, 1px.
//
// Comportamiento:
//   - Eje X con fechas formateadas DD-MM, omitidas cada N para evitar overlap.
//   - Eje Y con valor (ocupación % o rooms). Etiqueta configurable.
//   - Hover: vertical guide line + tooltip card con fecha y valores.
//   - Legend arriba derecha; título opcional arriba izquierda.
//   - Empty state cuando `data` está vacío: ilustración + mensaje.
//
// Wrap en CocoaCard padding="md" para alinear con el resto de la UI Cocoa.

import { useMemo, useState, type CSSProperties, type PointerEvent } from "react";
import { CocoaCard } from "../cocoa/CocoaCard";
import { CocoaEmptyState } from "../cocoa-empty-state/CocoaEmptyState";
import { EmptyStateBox } from "../cocoa-illustrations";

export interface DirectorForwardPacePoint {
  /** Fecha en formato ISO (YYYY-MM-DD) o cualquier formato parseable por Date. */
  date: string;
  /** Pickup confirmado (On The Books). */
  otb: number;
  /** Pronóstico para esa fecha. */
  forecast: number;
  /** Valor del mismo día el año anterior. */
  lastYear: number;
}

export interface DirectorForwardPaceChartProps {
  data: Array<DirectorForwardPacePoint>;
  /** Cantidad máxima de días a mostrar (slice desde el inicio). Default 30. */
  days?: number;
  /** Etiqueta del eje Y (ej: "Ocupación %", "Rooms"). */
  valueLabel?: string;
  /** Alto del área del gráfico (no del card completo). Default 200. */
  height?: number;
  /** Título opcional mostrado arriba a la izquierda. */
  title?: string;
}

// ---------------------------------------------------------------------------
// Constantes de layout SVG. Padding interno del área de plotting.
// ---------------------------------------------------------------------------

const CHART_PADDING = {
  top: 16,
  right: 16,
  bottom: 32,
  left: 44
} as const;

const VIEWBOX_WIDTH = 640;
const Y_TICKS = 4;

// ---------------------------------------------------------------------------
// Estilos del wrapper interno (título + legend + svg). El padding del card
// proviene de CocoaCard padding="md".
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
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
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
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
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

/** Formatea una fecha ISO a "DD-MM". Devuelve la cadena original si es inválida. */
function formatDayMonth(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const dd = String(parsed.getUTCDate()).padStart(2, "0");
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}`;
}

/** Calcula el "step" de ticks del eje X para que no haya más de ~8 etiquetas. */
function pickXStep(count: number): number {
  if (count <= 8) return 1;
  return Math.ceil(count / 8);
}

/** Redondea hacia arriba al múltiplo más cercano "agradable" para el eje Y. */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const norm = value / base;
  let nice: number;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

/** Construye un atributo "d" de path SVG a partir de puntos (x, y). */
function buildPathD(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Componente principal.
// ---------------------------------------------------------------------------

export function DirectorForwardPaceChart({
  data,
  days = 30,
  valueLabel = "Ocupación %",
  height = 200,
  title
}: DirectorForwardPaceChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Slice de los primeros `days` puntos.
  const slice = useMemo(() => data.slice(0, Math.max(0, days)), [data, days]);

  // Cálculo de escalas y coordenadas. Memoizado por estabilidad en hover.
  const geometry = useMemo(() => {
    if (slice.length === 0) return null;

    const innerWidth = VIEWBOX_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
    const innerHeight = height - CHART_PADDING.top - CHART_PADDING.bottom;

    // Rango del eje Y a partir del máximo entre las tres series. Mínimo 0.
    let rawMax = 0;
    for (const p of slice) {
      if (p.otb > rawMax) rawMax = p.otb;
      if (p.forecast > rawMax) rawMax = p.forecast;
      if (p.lastYear > rawMax) rawMax = p.lastYear;
    }
    const yMax = niceCeil(rawMax || 1);

    // Si hay un solo punto, lo posicionamos en el centro horizontal.
    const xOf = (i: number) => {
      if (slice.length === 1) {
        return CHART_PADDING.left + innerWidth / 2;
      }
      return (
        CHART_PADDING.left + (innerWidth * i) / (slice.length - 1)
      );
    };
    const yOf = (v: number) =>
      CHART_PADDING.top + innerHeight * (1 - v / yMax);

    const otbPoints = slice.map((p, i) => ({ x: xOf(i), y: yOf(p.otb) }));
    const forecastPoints = slice.map((p, i) => ({
      x: xOf(i),
      y: yOf(p.forecast)
    }));
    const lastYearPoints = slice.map((p, i) => ({
      x: xOf(i),
      y: yOf(p.lastYear)
    }));

    // Ticks del eje X.
    const xStep = pickXStep(slice.length);
    const xTicks: Array<{ i: number; x: number; label: string }> = [];
    for (let i = 0; i < slice.length; i += xStep) {
      xTicks.push({ i, x: xOf(i), label: formatDayMonth(slice[i].date) });
    }
    // Garantizamos que el último tick aparezca aunque no caiga en el step.
    if (
      xTicks.length > 0 &&
      xTicks[xTicks.length - 1].i !== slice.length - 1
    ) {
      const lastIdx = slice.length - 1;
      xTicks.push({
        i: lastIdx,
        x: xOf(lastIdx),
        label: formatDayMonth(slice[lastIdx].date)
      });
    }

    // Ticks del eje Y (Y_TICKS + 1 valores incluyendo 0 y yMax).
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
  }, [slice, height]);

  // Empty state. Lo envolvemos en CocoaCard padding="md" igual que el chart.
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

  const {
    innerWidth,
    yMax,
    otbPoints,
    forecastPoints,
    lastYearPoints,
    xTicks,
    yTicks
  } = geometry;

  // Convierte un evento de puntero del SVG en el índice más cercano. Como el
  // SVG usa preserveAspectRatio por defecto y un viewBox, mapeamos la posición
  // del puntero relativa al bounding rect al espacio del viewBox.
  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const relativeX = ((event.clientX - rect.left) / rect.width) * VIEWBOX_WIDTH;

    if (slice.length === 1) {
      setHoverIndex(0);
      return;
    }
    const ratio =
      (relativeX - CHART_PADDING.left) /
      (innerWidth === 0 ? 1 : innerWidth);
    const idx = Math.round(ratio * (slice.length - 1));
    const clamped = Math.max(0, Math.min(slice.length - 1, idx));
    setHoverIndex(clamped);
  }

  function handlePointerLeave() {
    setHoverIndex(null);
  }

  const hoverPoint = hoverIndex !== null ? slice[hoverIndex] : null;
  const hoverX = hoverIndex !== null ? otbPoints[hoverIndex].x : 0;

  // Posición del tooltip (HTML overlay). Lo alineamos respecto al área del SVG
  // usando porcentajes del viewBox, igual que para `relativeX`.
  const tooltipLeftPct = (hoverX / VIEWBOX_WIDTH) * 100;
  // Si el hover cae en la mitad derecha del chart, ancla el tooltip a la
  // derecha del punto para evitar que se corte.
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

      <div style={chartWrapperStyle}>
        <svg
          role="img"
          aria-label={
            title ? `${title} — ${valueLabel}` : `Pace chart — ${valueLabel}`
          }
          viewBox={`0 0 ${VIEWBOX_WIDTH} ${height}`}
          preserveAspectRatio="none"
          style={{ ...svgStyle, height }}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
        >
          {/* Grid horizontal + ticks Y */}
          <g>
            {yTicks.map((tick) => (
              <g key={`y-${tick.value}`}>
                <line
                  x1={CHART_PADDING.left}
                  x2={VIEWBOX_WIDTH - CHART_PADDING.right}
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

          {/* Etiquetas eje X */}
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

          {/* Etiqueta del eje Y (valueLabel) */}
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

          {/* Línea Last Year (gris, 1px, sólida) */}
          <path
            d={buildPathD(lastYearPoints)}
            fill="none"
            stroke="var(--cocoa-label-tertiary)"
            strokeWidth={1}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* Línea Forecast (warning, dashed, 2px) */}
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

          {/* Línea OTB (accent, sólida, 2px) */}
          <path
            d={buildPathD(otbPoints)}
            fill="none"
            stroke="var(--cocoa-accent)"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* Hover: guía vertical + puntos */}
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
              right: tooltipAlignRight
                ? `calc(${100 - tooltipLeftPct}% + 12px)`
                : undefined,
              top: 8
            }}
          >
            <div style={tooltipDateStyle}>
              {formatTooltipDate(hoverPoint.date)}
            </div>
            <div style={tooltipRowStyle}>
              <Dot color="var(--cocoa-accent)" />
              <span>OTB:&nbsp;</span>
              <strong style={{ color: "var(--cocoa-label)" }}>
                {formatValue(hoverPoint.otb)}
              </strong>
            </div>
            <div style={tooltipRowStyle}>
              <Dot color="var(--cocoa-warning)" dashed />
              <span>Forecast:&nbsp;</span>
              <strong style={{ color: "var(--cocoa-label)" }}>
                {formatValue(hoverPoint.forecast)}
              </strong>
            </div>
            <div style={tooltipRowStyle}>
              <Dot color="var(--cocoa-label-tertiary)" />
              <span>Año anterior:&nbsp;</span>
              <strong style={{ color: "var(--cocoa-label)" }}>
                {formatValue(hoverPoint.lastYear)}
              </strong>
            </div>
          </div>
        ) : null}
      </div>
    </CocoaCard>
  );
}

// ---------------------------------------------------------------------------
// Subcomponentes presentacionales.
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
      <svg
        width={20}
        height={8}
        viewBox="0 0 20 8"
        aria-hidden="true"
        style={{ display: "block" }}
      >
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
        borderRadius: dashed ? 0 : "50%",
        background: dashed ? "transparent" : color,
        border: dashed ? `2px dashed ${color}` : undefined,
        flexShrink: 0
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Formateadores auxiliares.
// ---------------------------------------------------------------------------

function formatYTick(value: number, max: number): string {
  // Si el rango es chico (<=10) mostramos decimales; si no, redondeamos.
  if (max <= 10) return value.toFixed(1).replace(/\.0$/, "");
  return Math.round(value).toString();
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return "—";
  if (Math.abs(value) >= 100) return Math.round(value).toString();
  if (Math.abs(value) >= 10) return value.toFixed(1).replace(/\.0$/, "");
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function formatTooltipDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const dd = String(parsed.getUTCDate()).padStart(2, "0");
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = parsed.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

export default DirectorForwardPaceChart;
