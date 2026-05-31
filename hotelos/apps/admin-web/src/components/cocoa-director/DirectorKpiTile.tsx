// DirectorKpiTile — Cocoa-style KPI tile for the Director dashboard.
//
// Compact metric tile that surfaces a single KPI with optional delta vs a
// reference period and an optional sparkline. Designed to live inside the
// Director Overview grid alongside other tiles.
//
// Layout (vertical):
//   - Top row: icon (optional) + label (tiny, secondary)
//   - Middle:  value (HUGE, tabular-nums, semibold) + optional unit (small)
//   - Bottom:  delta arrow + delta value + deltaLabel (e.g. "vs ayer", "vs LY")
//   - Bottom-right: 60x20 mini sparkline (color follows status)
//
// Colors:
//   - delta > 0 with polarity 'positive-good'  → var(--cocoa-success)
//   - delta < 0 with polarity 'positive-good'  → var(--cocoa-danger)
//   - delta > 0 with polarity 'negative-good'  → var(--cocoa-danger)
//   - delta < 0 with polarity 'negative-good'  → var(--cocoa-success)
//   - polarity 'neutral'                       → var(--cocoa-label-secondary)
//
// Status border-left (3px):
//   - 'ok'        → var(--cocoa-success)
//   - 'warning'   → var(--cocoa-warning)
//   - 'critical'  → var(--cocoa-danger)
//
// A11y:
//   - Minimum touch target 44px (enforced via minHeight).
//   - When `onClick` is provided, the tile renders as a button-role container
//     with keyboard support (Enter / Space).

import {
  useCallback,
  useMemo,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";

import { CocoaCard } from "../cocoa/CocoaCard";

export type DirectorKpiDeltaUnit = "%" | "pp" | "€" | "pts";
export type DirectorKpiPolarity =
  | "positive-good"
  | "negative-good"
  | "neutral";
export type DirectorKpiStatus = "ok" | "warning" | "critical";
export type DirectorKpiSize = "compact" | "regular";

export interface DirectorKpiTileProps {
  label: string;
  value: string | number;
  unit?: string;
  deltaLabel?: string;
  delta?: number;
  deltaUnit?: DirectorKpiDeltaUnit;
  deltaPolarity?: DirectorKpiPolarity;
  sparkline?: number[];
  icon?: ReactNode;
  status?: DirectorKpiStatus;
  size?: DirectorKpiSize;
  onClick?: () => void;
}

const STATUS_COLOR: Record<DirectorKpiStatus, string> = {
  ok: "var(--cocoa-success)",
  warning: "var(--cocoa-warning)",
  critical: "var(--cocoa-danger)"
};

function getDeltaColor(
  delta: number | undefined,
  polarity: DirectorKpiPolarity
): string {
  if (delta === undefined || delta === 0 || polarity === "neutral") {
    return "var(--cocoa-label-secondary)";
  }
  const isPositive = delta > 0;
  if (polarity === "positive-good") {
    return isPositive ? "var(--cocoa-success)" : "var(--cocoa-danger)";
  }
  // negative-good
  return isPositive ? "var(--cocoa-danger)" : "var(--cocoa-success)";
}

function formatDelta(delta: number): string {
  const abs = Math.abs(delta);
  // Preserve sensible precision: integers stay whole, otherwise 1 decimal.
  if (Number.isInteger(abs)) return abs.toString();
  return abs.toFixed(1);
}

interface SparklineProps {
  values: number[];
  color: string;
  width?: number;
  height?: number;
}

function Sparkline({
  values,
  color,
  width = 60,
  height = 20
}: SparklineProps) {
  const path = useMemo(() => {
    if (values.length === 0) return "";
    if (values.length === 1) {
      const y = height / 2;
      return `M 0 ${y} L ${width} ${y}`;
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const stepX = width / (values.length - 1);
    const pad = 1;
    const innerH = height - pad * 2;
    return values
      .map((value, index) => {
        const x = index * stepX;
        const normalized = (value - min) / range;
        const y = pad + (1 - normalized) * innerH;
        return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(" ");
  }, [values, width, height]);

  if (values.length === 0) return null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DirectorKpiTile({
  label,
  value,
  unit,
  deltaLabel,
  delta,
  deltaUnit,
  deltaPolarity = "positive-good",
  sparkline,
  icon,
  status,
  size = "regular",
  onClick
}: DirectorKpiTileProps) {
  const isInteractive = typeof onClick === "function";

  const valueFontSize = size === "compact" ? 24 : 32;
  const deltaColor = getDeltaColor(delta, deltaPolarity);
  const statusColor = status ? STATUS_COLOR[status] : undefined;
  const sparklineColor = statusColor ?? "var(--cocoa-label-tertiary)";

  const containerStyle = useMemo<CSSProperties>(
    () => ({
      display: "flex",
      flexDirection: "column",
      gap: 8,
      minHeight: 44,
      fontFamily: "var(--cocoa-font)",
      color: "var(--cocoa-label)",
      borderLeft: statusColor ? `3px solid ${statusColor}` : undefined,
      // Compensate visual offset when border-left is drawn so content stays aligned.
      paddingLeft: statusColor ? 9 : undefined
    }),
    [statusColor]
  );

  const topRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    color: "var(--cocoa-label-secondary)"
  };

  const iconStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 14,
    height: 14,
    flexShrink: 0
  };

  const labelStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    letterSpacing: "var(--cocoa-tracking-wide)",
    textTransform: "uppercase",
    color: "var(--cocoa-label-secondary)",
    lineHeight: 1,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis"
  };

  const middleRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "baseline",
    gap: 4
  };

  const valueStyle: CSSProperties = {
    fontSize: valueFontSize,
    fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
    letterSpacing: "var(--cocoa-tracking-tight)",
    color: "var(--cocoa-label)",
    lineHeight: 1.05,
    fontVariantNumeric: "tabular-nums",
    fontFeatureSettings: '"tnum"'
  };

  const unitStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-callout)",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    color: "var(--cocoa-label-secondary)",
    fontVariantNumeric: "tabular-nums",
    fontFeatureSettings: '"tnum"'
  };

  const bottomRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginTop: "auto"
  };

  const deltaStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: "var(--cocoa-fs-footnote)",
    fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
    color: deltaColor,
    fontVariantNumeric: "tabular-nums",
    fontFeatureSettings: '"tnum"',
    lineHeight: 1.2,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  };

  const deltaLabelStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-footnote)",
    fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
    color: "var(--cocoa-label-secondary)",
    fontVariantNumeric: "tabular-nums",
    fontFeatureSettings: '"tnum"'
  };

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!isInteractive) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onClick?.();
      }
    },
    [isInteractive, onClick]
  );

  const hasDelta = typeof delta === "number";
  const hasBottomRow =
    hasDelta || Boolean(deltaLabel) || (sparkline && sparkline.length > 0);
  const deltaArrow = hasDelta
    ? delta === 0
      ? "•"
      : delta > 0
      ? "▲"
      : "▼"
    : null;

  const ariaLabel = useMemo(() => {
    const parts: string[] = [label, String(value)];
    if (unit) parts.push(unit);
    if (hasDelta && delta !== undefined) {
      const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
      parts.push(
        `${sign}${formatDelta(delta)}${deltaUnit ?? ""}${
          deltaLabel ? ` ${deltaLabel}` : ""
        }`
      );
    } else if (deltaLabel) {
      parts.push(deltaLabel);
    }
    return parts.join(", ");
  }, [label, value, unit, hasDelta, delta, deltaUnit, deltaLabel]);

  return (
    <CocoaCard
      variant="plain"
      padding="sm"
      onClick={onClick}
      className={isInteractive ? "cocoa-focus-ring" : undefined}
    >
      <div
        style={containerStyle}
        role={isInteractive ? "button" : "group"}
        tabIndex={isInteractive ? 0 : undefined}
        onKeyDown={isInteractive ? handleKeyDown : undefined}
        aria-label={isInteractive ? ariaLabel : undefined}
      >
        <div style={topRowStyle}>
          {icon ? (
            <span style={iconStyle} aria-hidden="true">
              {icon}
            </span>
          ) : null}
          <span style={labelStyle}>{label}</span>
        </div>

        <div style={middleRowStyle}>
          <span style={valueStyle}>{value}</span>
          {unit ? <span style={unitStyle}>{unit}</span> : null}
        </div>

        {hasBottomRow ? (
          <div style={bottomRowStyle}>
            <span style={deltaStyle}>
              {hasDelta && deltaArrow ? (
                <span aria-hidden="true">{deltaArrow}</span>
              ) : null}
              {hasDelta && delta !== undefined ? (
                <span>
                  {formatDelta(delta)}
                  {deltaUnit ?? ""}
                </span>
              ) : null}
              {deltaLabel ? (
                <span style={deltaLabelStyle}>{deltaLabel}</span>
              ) : null}
            </span>
            {sparkline && sparkline.length > 0 ? (
              <Sparkline values={sparkline} color={sparklineColor} />
            ) : null}
          </div>
        ) : null}
      </div>
    </CocoaCard>
  );
}

export default DirectorKpiTile;
