import { type ReactNode, type CSSProperties } from "react";

export type StatTileColor = "default" | "ok" | "warn" | "danger";
export type StatTileSize = "sm" | "md" | "lg";

export interface StatTileDelta {
  value: number;
  direction: "up" | "down" | "flat";
}

export interface StatTileProps {
  label: string;
  value: string | number;
  delta?: StatTileDelta;
  sparkline?: number[];
  color?: StatTileColor;
  size?: StatTileSize;
  icon?: ReactNode;
  helper?: string;
  onClick?: () => void;
  loading?: boolean;
}

const VALUE_FONT_SIZE: Record<StatTileSize, string> = {
  sm: "var(--fs-xl, 20px)",
  md: "var(--fs-2xl, 24px)",
  lg: "var(--fs-display, 44px)"
};

const TILE_PADDING: Record<StatTileSize, string> = {
  sm: "var(--space-3, 12px)",
  md: "var(--space-4, 16px)",
  lg: "var(--space-5, 20px)"
};

const COLOR_FG: Record<StatTileColor, string> = {
  default: "var(--ink, #1a1a1a)",
  ok: "var(--ok-ink, #0a6b46)",
  warn: "var(--warn-ink, #8a4a09)",
  danger: "var(--danger-ink, #8d1b1b)"
};

const DELTA_ARROW: Record<StatTileDelta["direction"], string> = {
  up: "▲",
  down: "▼",
  flat: "→"
};

function deltaColor(direction: StatTileDelta["direction"]): string {
  if (direction === "up") return "var(--ok-ink, #0a6b46)";
  if (direction === "down") return "var(--danger-ink, #8d1b1b)";
  return "var(--ink-muted, #6a6a6a)";
}

interface SparklineProps {
  data: number[];
  color: string;
}

function Sparkline({ data, color }: SparklineProps) {
  if (data.length === 0) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;

  return (
    <div
      aria-hidden="true"
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 2,
        height: 24,
        marginTop: "var(--space-2, 8px)"
      }}
    >
      {data.map((point, idx) => {
        const pct = ((point - min) / range) * 100;
        const height = Math.max(8, pct);
        return (
          <div
            key={idx}
            style={{
              flex: 1,
              minWidth: 3,
              height: `${height}%`,
              background: color,
              borderRadius: "var(--radius-xs, 6px)",
              opacity: 0.55 + (idx / data.length) * 0.45
            }}
          />
        );
      })}
    </div>
  );
}

export function StatTile({
  label,
  value,
  delta,
  sparkline,
  color = "default",
  size = "md",
  icon,
  helper,
  onClick,
  loading = false
}: StatTileProps) {
  const isInteractive = typeof onClick === "function";
  const fg = COLOR_FG[color];

  const containerStyle: CSSProperties = {
    background: "var(--surface-1, var(--surface, #ffffff))",
    border: "1px solid var(--line, #e8e5dd)",
    borderRadius: "var(--radius-lg, 16px)",
    padding: TILE_PADDING[size],
    boxShadow: "var(--shadow-sm, 0 1px 3px rgba(26,26,26,0.05))",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2, 8px)",
    cursor: isInteractive ? "pointer" : "default",
    transition: "transform var(--duration, 180ms) var(--ease), box-shadow var(--duration, 180ms) var(--ease)",
    minWidth: 0
  };

  const labelStyle: CSSProperties = {
    fontSize: "var(--fs-xs, 11px)",
    color: "var(--ink-muted, #6a6a6a)",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2, 8px)"
  };

  const valueStyle: CSSProperties = {
    fontSize: VALUE_FONT_SIZE[size],
    fontWeight: 600,
    color: fg,
    lineHeight: "var(--lh-tight, 1.15)",
    fontVariantNumeric: "tabular-nums"
  };

  const deltaStyle: CSSProperties | undefined = delta
    ? {
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: "var(--fs-sm, 12px)",
        color: deltaColor(delta.direction),
        fontWeight: 500
      }
    : undefined;

  const containerProps = isInteractive
    ? {
        role: "button" as const,
        tabIndex: 0,
        onClick,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick?.();
          }
        }
      }
    : {};

  if (loading) {
    return (
      <div style={containerStyle} aria-busy="true">
        <div style={labelStyle}>{label}</div>
        <div
          style={{
            height: 28,
            width: "60%",
            background: "var(--surface-sunken, #f1efe9)",
            borderRadius: "var(--radius-sm, 8px)"
          }}
        />
      </div>
    );
  }

  return (
    <article style={containerStyle} {...containerProps}>
      <div style={labelStyle}>
        {icon ? <span aria-hidden="true">{icon}</span> : null}
        <span>{label}</span>
      </div>
      <div style={valueStyle}>{value}</div>
      {delta ? (
        <div style={deltaStyle}>
          <span aria-hidden="true">{DELTA_ARROW[delta.direction]}</span>
          <span>{Math.abs(delta.value)}%</span>
        </div>
      ) : null}
      {sparkline && sparkline.length > 0 ? (
        <Sparkline data={sparkline} color={fg} />
      ) : null}
      {helper ? (
        <div
          style={{
            fontSize: "var(--fs-xs, 11px)",
            color: "var(--ink-muted, #6a6a6a)"
          }}
        >
          {helper}
        </div>
      ) : null}
    </article>
  );
}

export default StatTile;
