// Cocoa 22 · pure SVG geometry for CocoaChart (COCOA-22.md §3.12).
//
// Extracted verbatim from the canon (`cocoa-director/DirectorKpiTile`,
// `DirectorForwardPaceChart`, `DirectorCancellationRiskGauge`,
// `DirectorChannelMixDonut`, `DirectorPickupBar`) so CocoaChart renders the
// same shapes: sparkline 60×20 padding 1 · line chart padding 16/16/32/44 with
// 4 Y ticks and "nice" ceilings · gauge 220×130, r 90, stroke 16, needle +
// hub · donut with inner radius 62 %. No React, no DOM: unit-tested. Labels go
// through lib/format (es-ES decimal comma).

import { number as formatNumber } from "../../lib/format";

export interface XY {
  x: number;
  y: number;
}

/** Path `d` of a sparkline: values fitted to `width×height` with `pad`. */
export function sparklinePath(values: readonly number[], width = 60, height = 20, pad = 1): string {
  if (values.length === 0) return "";
  if (values.length === 1) {
    const y = height / 2;
    return `M 0 ${y} L ${width} ${y}`;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = width / (values.length - 1);
  const innerH = height - pad * 2;
  return values
    .map((value, index) => {
      const x = index * stepX;
      const normalized = (value - min) / range;
      const y = pad + (1 - normalized) * innerH;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

/** Rounds up to the nearest 1 / 2 / 5 × 10ⁿ ("nice" axis ceiling). */
export function niceCeil(value: number): number {
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

/** Tick step so an X axis shows at most ~8 labels. */
export function pickXStep(count: number): number {
  if (count <= 8) return 1;
  return Math.ceil(count / 8);
}

/** Polyline `d` from points. */
export function buildPathD(points: readonly XY[]): string {
  if (points.length === 0) return "";
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
}

/** Y-axis tick label (es-ES via lib/format): one decimal when the range is small (≤ 10), integers otherwise. */
export function formatYTick(value: number, max: number): string {
  if (max <= 10) return formatNumber(value, { maximumFractionDigits: 1 });
  return formatNumber(value, { maximumFractionDigits: 0 });
}

/** Compact value for tooltips (es-ES via lib/format): 0 decimals ≥ 100, 1 decimal ≥ 10, 2 below; «—» for NaN. */
export function formatChartValue(value: number): string {
  if (Number.isNaN(value)) return "—";
  if (Math.abs(value) >= 100) return formatNumber(value, { maximumFractionDigits: 0 });
  if (Math.abs(value) >= 10) return formatNumber(value, { maximumFractionDigits: 1 });
  return formatNumber(value, { maximumFractionDigits: 2 });
}

// ----------------------------------------------------------------- line chart

export const LINE_PADDING = { top: 16, right: 16, bottom: 32, left: 44 } as const;
export const LINE_DEFAULT_WIDTH = 640;

export interface LineSeriesInput {
  id: string;
  points: ReadonlyArray<{ x: string; y: number }>;
}

export interface LineGeometry {
  innerWidth: number;
  innerHeight: number;
  yMax: number;
  /** Points per series (same order as the input). */
  series: XY[][];
  xTicks: Array<{ i: number; x: number; label: string }>;
  yTicks: Array<{ value: number; y: number }>;
  xOf: (index: number) => number;
  /** Index of the point nearest to a viewBox X (hover). */
  indexAt: (viewBoxX: number) => number;
}

/**
 * Scales every series to a `width×height` viewBox. The X axis takes the
 * labels of the longest series; shorter series are drawn on their first N
 * positions. `yMax` is the nice ceiling of the largest value (min 0).
 */
export function lineGeometry(
  input: readonly LineSeriesInput[],
  width: number = LINE_DEFAULT_WIDTH,
  height = 200,
  ticks = 4
): LineGeometry | null {
  const count = Math.max(0, ...input.map((s) => s.points.length));
  if (count === 0) return null;
  const innerWidth = width - LINE_PADDING.left - LINE_PADDING.right;
  const innerHeight = height - LINE_PADDING.top - LINE_PADDING.bottom;
  let rawMax = 0;
  for (const s of input) for (const p of s.points) if (p.y > rawMax) rawMax = p.y;
  const yMax = niceCeil(rawMax || 1);
  const xOf = (i: number) => (count === 1 ? LINE_PADDING.left + innerWidth / 2 : LINE_PADDING.left + (innerWidth * i) / (count - 1));
  const yOf = (v: number) => LINE_PADDING.top + innerHeight * (1 - v / yMax);
  const series = input.map((s) => s.points.map((p, i) => ({ x: xOf(i), y: yOf(p.y) })));
  const longest = input.reduce((best, s) => (s.points.length > best.points.length ? s : best), input[0]);
  const step = pickXStep(count);
  const xTicks: LineGeometry["xTicks"] = [];
  for (let i = 0; i < count; i += step) xTicks.push({ i, x: xOf(i), label: longest.points[i]?.x ?? "" });
  if (xTicks.length > 0 && xTicks[xTicks.length - 1].i !== count - 1) {
    xTicks.push({ i: count - 1, x: xOf(count - 1), label: longest.points[count - 1]?.x ?? "" });
  }
  const yTicks: LineGeometry["yTicks"] = [];
  for (let i = 0; i <= ticks; i += 1) {
    const value = (yMax * i) / ticks;
    yTicks.push({ value, y: yOf(value) });
  }
  const indexAt = (viewBoxX: number) => {
    if (count === 1) return 0;
    const ratio = (viewBoxX - LINE_PADDING.left) / (innerWidth === 0 ? 1 : innerWidth);
    const idx = Math.round(ratio * (count - 1));
    return Math.max(0, Math.min(count - 1, idx));
  };
  return { innerWidth, innerHeight, yMax, series, xTicks, yTicks, xOf, indexAt };
}

// ----------------------------------------------------------------- gauge

export const GAUGE = { width: 220, height: 130, cx: 110, cy: 110, radius: 90, stroke: 16 } as const;

/** Angle in degrees on a semicircle: left (180°) = min, right (0°) = max. */
export function gaugeAngle(value: number, min = 0, max = 100): number {
  const span = max - min || 1;
  const ratio = Math.max(0, Math.min(1, (value - min) / span));
  return 180 - ratio * 180;
}

/** Gauge polar → cartesian (Y grows downwards, angle counter-clockwise from +X), rounded to 3 decimals so paths are stable. */
export function gaugePoint(radius: number, angleDeg: number, cx: number = GAUGE.cx, cy: number = GAUGE.cy): XY {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: round3(cx + radius * Math.cos(rad)), y: round3(cy - radius * Math.sin(rad)) };
}

/** Rounds to 3 decimals and drops the negative zero (pure). */
export function round3(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export interface GaugeGeometry {
  angle: number;
  trackPath: string;
  progressPath: string;
  needlePath: string;
}

/** Track, progress arc and needle for a value in `[min, max]`. */
export function gaugeGeometry(value: number, min = 0, max = 100): GaugeGeometry {
  const start = gaugePoint(GAUGE.radius, 180);
  const end = gaugePoint(GAUGE.radius, 0);
  const trackPath = `M ${start.x} ${start.y} A ${GAUGE.radius} ${GAUGE.radius} 0 0 1 ${end.x} ${end.y}`;
  const angle = gaugeAngle(value, min, max);
  const progressEnd = gaugePoint(GAUGE.radius, angle);
  const largeArc = 180 - angle > 180 ? 1 : 0;
  const progressPath = `M ${start.x} ${start.y} A ${GAUGE.radius} ${GAUGE.radius} 0 ${largeArc} 1 ${progressEnd.x} ${progressEnd.y}`;
  const tip = gaugePoint(GAUGE.radius - 6, angle);
  const baseLeft = gaugePoint(8, angle + 90);
  const baseRight = gaugePoint(8, angle - 90);
  const needlePath = `M ${tip.x} ${tip.y} L ${baseLeft.x} ${baseLeft.y} L ${baseRight.x} ${baseRight.y} Z`;
  return { angle, trackPath, progressPath, needlePath };
}

/**
 * Tone by thresholds `[warnAt, dangerAt]`: below the first → success, below
 * the second → warning, else danger. `invert` flips it (higher is better).
 */
export function thresholdTone(
  value: number,
  thresholds: readonly [number, number] = [30, 60],
  invert = false
): "success" | "warning" | "danger" {
  const [warnAt, dangerAt] = thresholds;
  if (!invert) {
    if (value < warnAt) return "success";
    if (value < dangerAt) return "warning";
    return "danger";
  }
  if (value >= dangerAt) return "success";
  if (value >= warnAt) return "warning";
  return "danger";
}

// ----------------------------------------------------------------- donut

/** Donut polar → cartesian (0° at 12 o'clock, clockwise). */
export function donutPoint(cx: number, cy: number, radius: number, angle: number): XY {
  const rad = (angle - 90) * (Math.PI / 180);
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

/** Ring segment path between two angles (degrees, clockwise from 12 o'clock). */
export function describeArcPath(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number
): string {
  const safeEnd = endAngle - startAngle >= 360 ? startAngle + 359.999 : endAngle;
  const largeArc = safeEnd - startAngle <= 180 ? 0 : 1;
  const startOuter = donutPoint(cx, cy, outerRadius, startAngle);
  const endOuter = donutPoint(cx, cy, outerRadius, safeEnd);
  const startInner = donutPoint(cx, cy, innerRadius, safeEnd);
  const endInner = donutPoint(cx, cy, innerRadius, startAngle);
  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${endOuter.x} ${endOuter.y}`,
    `L ${startInner.x} ${startInner.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${endInner.x} ${endInner.y}`,
    "Z"
  ].join(" ");
}

export interface DonutSegment<T> {
  slice: T;
  share: number;
  startAngle: number;
  endAngle: number;
  path: string;
}

/** Segments of a donut of `size` px (inner radius 62 %); zero/negative values get an empty slice. */
export function donutSegments<T extends { value: number }>(slices: readonly T[], size = 160): { segments: DonutSegment<T>[]; total: number } {
  const total = slices.reduce((sum, s) => sum + (s.value > 0 ? s.value : 0), 0);
  if (total <= 0) return { segments: [], total: 0 };
  const cx = size / 2;
  const cy = size / 2;
  const outer = size / 2;
  const inner = outer * 0.62;
  let angle = 0;
  const segments = slices.map((slice) => {
    const share = slice.value > 0 ? slice.value / total : 0;
    const startAngle = angle;
    const endAngle = angle + share * 360;
    angle = endAngle;
    return { slice, share, startAngle, endAngle, path: share > 0 ? describeArcPath(cx, cy, outer, inner, startAngle, endAngle) : "" };
  });
  return { segments, total };
}

// ----------------------------------------------------------------- bars

export type ChartPolarity = "positive-good" | "negative-good";

/** Tone of a bar by sign and polarity; zero/NaN → neutral. */
export function barTone(value: number, polarity: ChartPolarity = "positive-good"): "success" | "danger" | "neutral" {
  if (!Number.isFinite(value) || value === 0) return "neutral";
  const good = polarity === "positive-good" ? value > 0 : value < 0;
  return good ? "success" : "danger";
}

/** Bar height in px for a value inside a plot of `plotHeight` (min 2 px). */
export function barHeight(value: number, maxAbs: number, plotHeight: number, minPx = 2): number {
  const safeMax = maxAbs > 0 ? maxAbs : 1;
  return Math.max(plotHeight * (Math.abs(value) / safeMax), minPx);
}

/** Clamp to [0, 100] for progress bars; NaN → 0. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}
