// DirectorChannelMixDonut — SVG donut chart for channel revenue mix.
//
// Segments are proportional to revenue. Center shows total revenue with the
// optional label. Legend below lists each channel with its revenue share and
// a colored cost% badge. Hovering a segment highlights it and shows a tooltip
// with detailed metrics (revenue, room nights, cost%).
//
// Wrapped in CocoaCard for consistent Cocoa-styled surfaces.

import {
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent
} from "react";
import { CocoaCard } from "../cocoa/CocoaCard";

export interface DirectorChannel {
  name: string;
  revenue: number;
  roomNights: number;
  costPct: number;
  color?: string;
}

export interface DirectorChannelMixDonutProps {
  channels: DirectorChannel[];
  size?: number;
  centerLabel?: string;
}

interface ChannelSegment {
  channel: DirectorChannel;
  color: string;
  share: number;
  startAngle: number;
  endAngle: number;
  path: string;
}

const DEFAULT_COLORS: Record<string, string> = {
  direct: "var(--cocoa-accent)",
  booking: "#003580",
  expedia: "#fcc04f",
  airbnb: "#FF5A5F",
  gds: "var(--cocoa-label-secondary)",
  wholesale: "var(--cocoa-warning)"
};

const FALLBACK_PALETTE = [
  "var(--cocoa-accent)",
  "#003580",
  "#fcc04f",
  "#FF5A5F",
  "var(--cocoa-label-secondary)",
  "var(--cocoa-warning)",
  "var(--cocoa-success)"
];

function normalizeKey(name: string): string {
  return name.trim().toLowerCase();
}

function resolveColor(channel: DirectorChannel, index: number): string {
  if (channel.color) return channel.color;
  const key = normalizeKey(channel.name);
  if (DEFAULT_COLORS[key]) return DEFAULT_COLORS[key];
  return FALLBACK_PALETTE[index % FALLBACK_PALETTE.length] ?? "var(--cocoa-accent)";
}

function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angle: number
): { x: number; y: number } {
  const rad = (angle - 90) * (Math.PI / 180);
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad)
  };
}

function describeArcPath(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number
): string {
  const safeEnd = endAngle - startAngle >= 360 ? startAngle + 359.999 : endAngle;
  const largeArc = safeEnd - startAngle <= 180 ? 0 : 1;

  const startOuter = polarToCartesian(cx, cy, outerRadius, startAngle);
  const endOuter = polarToCartesian(cx, cy, outerRadius, safeEnd);
  const startInner = polarToCartesian(cx, cy, innerRadius, safeEnd);
  const endInner = polarToCartesian(cx, cy, innerRadius, startAngle);

  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${endOuter.x} ${endOuter.y}`,
    `L ${startInner.x} ${startInner.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${endInner.x} ${endInner.y}`,
    "Z"
  ].join(" ");
}

function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${Math.round(value).toLocaleString()}`;
}

function formatPercent(value: number, fractionDigits = 1): string {
  if (!Number.isFinite(value)) return "0%";
  return `${value.toFixed(fractionDigits)}%`;
}

function costBadgeColor(costPct: number): {
  background: string;
  color: string;
} {
  if (costPct >= 25) {
    return {
      background: "color-mix(in srgb, var(--cocoa-warning) 18%, transparent)",
      color: "var(--cocoa-warning)"
    };
  }
  if (costPct >= 15) {
    return {
      background: "color-mix(in srgb, var(--cocoa-accent) 14%, transparent)",
      color: "var(--cocoa-accent)"
    };
  }
  return {
    background: "color-mix(in srgb, var(--cocoa-success) 16%, transparent)",
    color: "var(--cocoa-success)"
  };
}

export function DirectorChannelMixDonut({
  channels,
  size = 160,
  centerLabel = "Mix de canales"
}: DirectorChannelMixDonutProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const { segments, totalRevenue } = useMemo(() => {
    const total = channels.reduce(
      (sum, channel) => sum + (channel.revenue > 0 ? channel.revenue : 0),
      0
    );

    if (total <= 0) {
      return { segments: [] as ChannelSegment[], totalRevenue: 0 };
    }

    const cx = size / 2;
    const cy = size / 2;
    const outerRadius = size / 2;
    const innerRadius = outerRadius * 0.62;

    let angle = 0;
    const result: ChannelSegment[] = channels.map((channel, index) => {
      const share = channel.revenue > 0 ? channel.revenue / total : 0;
      const sweep = share * 360;
      const startAngle = angle;
      const endAngle = angle + sweep;
      angle = endAngle;
      return {
        channel,
        color: resolveColor(channel, index),
        share,
        startAngle,
        endAngle,
        path: describeArcPath(
          cx,
          cy,
          outerRadius,
          innerRadius,
          startAngle,
          endAngle
        )
      };
    });

    return { segments: result, totalRevenue: total };
  }, [channels, size]);

  const hoveredSegment =
    hoveredIndex !== null ? segments[hoveredIndex] ?? null : null;

  const handleSegmentEnter = (
    index: number,
    event: ReactMouseEvent<SVGPathElement>
  ) => {
    setHoveredIndex(index);
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (bounds) {
      setTooltipPosition({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top
      });
    }
  };

  const handleSegmentMove = (event: ReactMouseEvent<SVGPathElement>) => {
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (bounds) {
      setTooltipPosition({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top
      });
    }
  };

  const handleSegmentLeave = () => {
    setHoveredIndex(null);
    setTooltipPosition(null);
  };

  const containerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    width: "100%"
  };

  const chartWrapperStyle: CSSProperties = {
    position: "relative",
    width: size,
    height: size,
    margin: "0 auto"
  };

  const svgStyle: CSSProperties = {
    display: "block",
    overflow: "visible"
  };

  const centerStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
    textAlign: "center",
    padding: "0 12px"
  };

  const centerValueStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-title-3, 16px)",
    fontWeight: 600,
    color: "var(--cocoa-label)",
    lineHeight: 1.1
  };

  const centerLabelStyle: CSSProperties = {
    marginTop: "4px",
    fontSize: "var(--cocoa-fs-caption-1, 11px)",
    color: "var(--cocoa-label-secondary)",
    letterSpacing: "0.02em"
  };

  const legendStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    width: "100%"
  };

  const legendRowBaseStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 8px",
    borderRadius: "var(--cocoa-radius-md, 6px)",
    transition: "background var(--cocoa-duration-fast, 120ms) ease"
  };

  const legendSwatchStyle = (color: string): CSSProperties => ({
    width: 10,
    height: 10,
    borderRadius: 3,
    background: color,
    flexShrink: 0
  });

  const legendNameStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-body, 13px)",
    color: "var(--cocoa-label)",
    fontWeight: 500,
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  };

  const legendShareStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-subheadline, 12px)",
    color: "var(--cocoa-label-secondary)",
    fontVariantNumeric: "tabular-nums",
    minWidth: 44,
    textAlign: "right"
  };

  const costBadgeBaseStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-caption-1, 11px)",
    fontWeight: 600,
    padding: "2px 6px",
    borderRadius: "var(--cocoa-radius-sm, 4px)",
    fontVariantNumeric: "tabular-nums",
    minWidth: 44,
    textAlign: "center"
  };

  const tooltipStyle: CSSProperties | null =
    hoveredSegment && tooltipPosition
      ? {
          position: "absolute",
          left: Math.min(Math.max(tooltipPosition.x + 12, 0), size),
          top: Math.max(tooltipPosition.y - 12, 0),
          transform: "translate(0, -100%)",
          pointerEvents: "none",
          background: "var(--cocoa-background-content, #ffffff)",
          color: "var(--cocoa-label)",
          border: "1px solid var(--cocoa-separator)",
          borderRadius: "var(--cocoa-radius-md, 6px)",
          boxShadow: "var(--cocoa-shadow-control, 0 4px 12px rgba(0,0,0,0.12))",
          padding: "8px 10px",
          fontSize: "var(--cocoa-fs-subheadline, 12px)",
          whiteSpace: "nowrap",
          zIndex: 4
        }
      : null;

  const tooltipTitleStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontWeight: 600,
    marginBottom: "4px"
  };

  const tooltipRowStyle: CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    gap: "16px",
    color: "var(--cocoa-label-secondary)"
  };

  const tooltipValueStyle: CSSProperties = {
    color: "var(--cocoa-label)",
    fontVariantNumeric: "tabular-nums"
  };

  const emptyState = segments.length === 0 || totalRevenue <= 0;

  return (
    <CocoaCard variant="bordered" padding="lg">
      <div style={containerStyle}>
        <div style={chartWrapperStyle}>
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            role="img"
            aria-label={centerLabel}
            style={svgStyle}
          >
            {emptyState ? (
              <circle
                cx={size / 2}
                cy={size / 2}
                r={size / 2 - 0.5}
                fill="none"
                stroke="var(--cocoa-separator)"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
            ) : (
              segments.map((segment, index) => {
                const isHovered = hoveredIndex === index;
                const isDimmed =
                  hoveredIndex !== null && hoveredIndex !== index;
                const pathStyle: CSSProperties = {
                  cursor: "pointer",
                  transition:
                    "opacity var(--cocoa-duration-fast, 120ms) ease, transform var(--cocoa-duration-fast, 120ms) ease",
                  opacity: isDimmed ? 0.55 : 1,
                  transformOrigin: `${size / 2}px ${size / 2}px`,
                  transform: isHovered ? "scale(1.025)" : "scale(1)"
                };
                return (
                  <path
                    key={`${segment.channel.name}-${index}`}
                    d={segment.path}
                    fill={segment.color}
                    stroke="var(--cocoa-background-content)"
                    strokeWidth={1.5}
                    style={pathStyle}
                    onMouseEnter={(event) => handleSegmentEnter(index, event)}
                    onMouseMove={handleSegmentMove}
                    onMouseLeave={handleSegmentLeave}
                  >
                    <title>{segment.channel.name}</title>
                  </path>
                );
              })
            )}
          </svg>
          <div style={centerStyle}>
            <span style={centerValueStyle}>{formatCurrency(totalRevenue)}</span>
            <span style={centerLabelStyle}>{centerLabel}</span>
          </div>
          {tooltipStyle && hoveredSegment ? (
            <div style={tooltipStyle} role="tooltip">
              <div style={tooltipTitleStyle}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: hoveredSegment.color
                  }}
                />
                {hoveredSegment.channel.name}
              </div>
              <div style={tooltipRowStyle}>
                <span>Revenue</span>
                <span style={tooltipValueStyle}>
                  {formatCurrency(hoveredSegment.channel.revenue)} (
                  {formatPercent(hoveredSegment.share * 100)})
                </span>
              </div>
              <div style={tooltipRowStyle}>
                <span>Room nights</span>
                <span style={tooltipValueStyle}>
                  {hoveredSegment.channel.roomNights.toLocaleString()}
                </span>
              </div>
              <div style={tooltipRowStyle}>
                <span>Cost</span>
                <span style={tooltipValueStyle}>
                  {formatPercent(hoveredSegment.channel.costPct)}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <div style={legendStyle}>
          {segments.map((segment, index) => {
            const isHovered = hoveredIndex === index;
            const badge = costBadgeColor(segment.channel.costPct);
            const rowStyle: CSSProperties = {
              ...legendRowBaseStyle,
              background: isHovered
                ? "var(--cocoa-fill-quaternary, rgba(0,0,0,0.04))"
                : "transparent",
              cursor: "default"
            };
            return (
              <div
                key={`${segment.channel.name}-legend-${index}`}
                style={rowStyle}
                onMouseEnter={() => setHoveredIndex(index)}
                onMouseLeave={() => setHoveredIndex(null)}
              >
                <span style={legendSwatchStyle(segment.color)} />
                <span style={legendNameStyle}>{segment.channel.name}</span>
                <span style={legendShareStyle}>
                  {formatPercent(segment.share * 100)}
                </span>
                <span
                  style={{
                    ...costBadgeBaseStyle,
                    background: badge.background,
                    color: badge.color
                  }}
                  title={`Cost ${formatPercent(segment.channel.costPct)}`}
                >
                  {formatPercent(segment.channel.costPct, 0)}
                </span>
              </div>
            );
          })}
          {segments.length === 0 ? (
            <div
              style={{
                fontSize: "var(--cocoa-fs-subheadline, 12px)",
                color: "var(--cocoa-label-secondary)",
                textAlign: "center",
                padding: "8px 0"
              }}
            >
              Sin datos de canales disponibles.
            </div>
          ) : null}
        </div>
      </div>
    </CocoaCard>
  );
}

export default DirectorChannelMixDonut;
