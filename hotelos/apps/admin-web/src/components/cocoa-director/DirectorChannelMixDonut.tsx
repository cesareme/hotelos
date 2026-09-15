// DirectorChannelMixDonut — SVG donut chart for channel revenue mix.
//
// Segments are proportional to revenue. Center shows total revenue with the
// optional label. Legend below lists each channel with its revenue share and
// a colored cost% badge. Hovering a segment highlights it and shows a tooltip
// with detailed metrics (revenue, room nights, cost%).
//
// Cocoa 22 (ola 2): the ring geometry comes from `cocoa/cocoa-chart-math`
// (`donutSegments`, inner radius 62 %) — the same helper `CocoaChart.Donut`
// uses — the slice colours from the canon `DONUT_PALETTE` (no OTA brand
// hexes: one accent, then the label greys) and every figure from
// `lib/format`. Screens should use `CocoaChart.Donut`; this component stays
// for legacy callers until wave 11.

import { useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { CocoaCard } from "../cocoa/CocoaCard";
import { DONUT_PALETTE, donutShareLabel } from "../cocoa/CocoaChart";
import { donutSegments, type DonutSegment } from "../cocoa/cocoa-chart-math";
import { toneBg, toneInk } from "../cocoa/cocoa-tones";
import { money, number, percent } from "../../lib/format";

export interface DirectorChannel {
  name: string;
  revenue: number;
  roomNights: number;
  costPct: number;
  /** Explicit colour token for the slice (`var(--cocoa-*)`); defaults to the canon palette by index. */
  color?: string;
}

export interface DirectorChannelMixDonutProps {
  channels: DirectorChannel[];
  size?: number;
  centerLabel?: string;
}

type ChannelSlice = { value: number; channel: DirectorChannel; color: string };

function resolveColor(channel: DirectorChannel, index: number): string {
  if (channel.color) return channel.color;
  return DONUT_PALETTE[index % DONUT_PALETTE.length] ?? DONUT_PALETTE[0];
}

function formatCurrency(value: number): string {
  return money(value, { compact: true });
}

function formatCostPct(value: number, fractionDigits = 1): string {
  return percent(value, { maximumFractionDigits: fractionDigits });
}

/** Cost badge tone: ≥ 25 % warning · ≥ 15 % accent · below success (AA ink over the tone wash). */
function costBadgeColor(costPct: number): { background: string; color: string } {
  if (costPct >= 25) return { background: toneBg("warning"), color: toneInk("warning") };
  if (costPct >= 15) return { background: toneBg("accent"), color: toneInk("accent") };
  return { background: toneBg("success"), color: toneInk("success") };
}

export function DirectorChannelMixDonut({ channels, size = 160, centerLabel = "Mix de canales" }: DirectorChannelMixDonutProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ x: number; y: number } | null>(null);

  const { segments, totalRevenue } = useMemo(() => {
    const slices: ChannelSlice[] = channels.map((channel, index) => ({ value: channel.revenue, channel, color: resolveColor(channel, index) }));
    const { segments: computed, total } = donutSegments(slices, size);
    return { segments: computed as DonutSegment<ChannelSlice>[], totalRevenue: total };
  }, [channels, size]);

  const hoveredSegment = hoveredIndex !== null ? segments[hoveredIndex] ?? null : null;

  const handleSegmentEnter = (index: number, event: ReactMouseEvent<SVGPathElement>) => {
    setHoveredIndex(index);
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (bounds) {
      setTooltipPosition({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    }
  };

  const handleSegmentMove = (event: ReactMouseEvent<SVGPathElement>) => {
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (bounds) {
      setTooltipPosition({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    }
  };

  const handleSegmentLeave = () => {
    setHoveredIndex(null);
    setTooltipPosition(null);
  };

  const containerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-4)",
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
    padding: "0 var(--cocoa-space-3)"
  };

  const centerValueStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-title-3)",
    fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
    color: "var(--cocoa-label)",
    lineHeight: 1.1,
    fontVariantNumeric: "tabular-nums"
  };

  const centerLabelStyle: CSSProperties = {
    marginTop: "var(--cocoa-space-1)",
    fontSize: "var(--cocoa-fs-caption-1)",
    color: "var(--cocoa-label-secondary)",
    letterSpacing: "var(--cocoa-tracking-wide)"
  };

  const legendStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-2)",
    width: "100%"
  };

  const legendRowBaseStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--cocoa-space-2)",
    padding: "6px var(--cocoa-space-2)",
    borderRadius: "var(--cocoa-radius-md)",
    transition: "background var(--cocoa-duration-fast) var(--cocoa-ease-out)"
  };

  const legendSwatchStyle = (color: string): CSSProperties => ({
    width: 10,
    height: 10,
    borderRadius: 3,
    background: color,
    flexShrink: 0
  });

  const legendNameStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-body)",
    color: "var(--cocoa-label)",
    fontWeight: "var(--cocoa-fw-medium)" as CSSProperties["fontWeight"],
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  };

  const legendShareStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-subheadline)",
    color: "var(--cocoa-label-secondary)",
    fontVariantNumeric: "tabular-nums",
    minWidth: 44,
    textAlign: "right"
  };

  const costBadgeBaseStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-caption-1)",
    fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
    padding: "2px 6px",
    borderRadius: "var(--cocoa-radius-sm)",
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
          background: "var(--cocoa-background-content)",
          color: "var(--cocoa-label)",
          border: "1px solid var(--cocoa-separator)",
          borderRadius: "var(--cocoa-radius-md)",
          boxShadow: "var(--cocoa-shadow-popover)",
          padding: "var(--cocoa-space-2) 10px",
          fontSize: "var(--cocoa-fs-subheadline)",
          whiteSpace: "nowrap",
          zIndex: "var(--cocoa-z-tooltip)" as CSSProperties["zIndex"]
        }
      : null;

  const tooltipTitleStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
    marginBottom: "var(--cocoa-space-1)"
  };

  const tooltipRowStyle: CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    gap: "var(--cocoa-space-4)",
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
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={centerLabel} style={svgStyle}>
            {emptyState ? (
              <circle cx={size / 2} cy={size / 2} r={size / 2 - 0.5} fill="none" stroke="var(--cocoa-separator)" strokeWidth={1} strokeDasharray="4 4" />
            ) : (
              segments.map((segment, index) => {
                if (!segment.path) return null;
                const isHovered = hoveredIndex === index;
                const isDimmed = hoveredIndex !== null && hoveredIndex !== index;
                const pathStyle: CSSProperties = {
                  cursor: "pointer",
                  transition: "opacity var(--cocoa-duration-fast) var(--cocoa-ease-out), transform var(--cocoa-duration-fast) var(--cocoa-ease-out)",
                  opacity: isDimmed ? 0.55 : 1,
                  transformOrigin: `${size / 2}px ${size / 2}px`,
                  transform: isHovered ? "scale(1.025)" : "scale(1)"
                };
                return (
                  <path
                    key={`${segment.slice.channel.name}-${index}`}
                    d={segment.path}
                    fill={segment.slice.color}
                    stroke="var(--cocoa-background-content)"
                    strokeWidth={1.5}
                    style={pathStyle}
                    onMouseEnter={(event) => handleSegmentEnter(index, event)}
                    onMouseMove={handleSegmentMove}
                    onMouseLeave={handleSegmentLeave}
                  >
                    <title>{segment.slice.channel.name}</title>
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
                <span style={{ width: 8, height: 8, borderRadius: 2, background: hoveredSegment.slice.color }} />
                {hoveredSegment.slice.channel.name}
              </div>
              <div style={tooltipRowStyle}>
                <span>Ingresos</span>
                <span style={tooltipValueStyle}>
                  {formatCurrency(hoveredSegment.slice.channel.revenue)} ({donutShareLabel(hoveredSegment.share)})
                </span>
              </div>
              <div style={tooltipRowStyle}>
                <span>Noches</span>
                <span style={tooltipValueStyle}>{number(hoveredSegment.slice.channel.roomNights)}</span>
              </div>
              <div style={tooltipRowStyle}>
                <span>Coste</span>
                <span style={tooltipValueStyle}>{formatCostPct(hoveredSegment.slice.channel.costPct)}</span>
              </div>
            </div>
          ) : null}
        </div>

        <div style={legendStyle}>
          {segments.map((segment, index) => {
            const isHovered = hoveredIndex === index;
            const badge = costBadgeColor(segment.slice.channel.costPct);
            const rowStyle: CSSProperties = {
              ...legendRowBaseStyle,
              background: isHovered ? "var(--cocoa-fill-quaternary)" : "transparent",
              cursor: "default"
            };
            return (
              <div key={`${segment.slice.channel.name}-legend-${index}`} style={rowStyle} onMouseEnter={() => setHoveredIndex(index)} onMouseLeave={() => setHoveredIndex(null)}>
                <span style={legendSwatchStyle(segment.slice.color)} />
                <span style={legendNameStyle}>{segment.slice.channel.name}</span>
                <span style={legendShareStyle}>{donutShareLabel(segment.share)}</span>
                <span style={{ ...costBadgeBaseStyle, background: badge.background, color: badge.color }} title={`Coste ${formatCostPct(segment.slice.channel.costPct)}`}>
                  {formatCostPct(segment.slice.channel.costPct, 0)}
                </span>
              </div>
            );
          })}
          {segments.length === 0 ? (
            <div
              style={{
                fontSize: "var(--cocoa-fs-subheadline)",
                color: "var(--cocoa-label-secondary)",
                textAlign: "center",
                padding: "var(--cocoa-space-2) 0"
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
