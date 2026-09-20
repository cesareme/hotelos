// DirectorPickupBar — 7-day net pickup bars (legacy of `CocoaChart.Bars`).
//
// Cocoa 22 (ola 2): the bar tone and height come from `cocoa/cocoa-chart-math`
// (`barTone`, `barHeight`) — the same helpers `CocoaChart.Bars` uses — and the
// labels go through `lib/format` (es-ES sign and decimal comma). Screens
// should use `CocoaChart.Bars`; this component stays for legacy callers
// until wave 11.

import { useMemo, useState, type CSSProperties } from "react";
import { CocoaCard } from "../cocoa/CocoaCard";
import { barHeight, barTone } from "../cocoa/cocoa-chart-math";
import { toneColor } from "../cocoa/cocoa-tones";
import { number, percent } from "../../lib/format";

export interface DirectorPickupBarDatum {
  day: string;
  net: number;
  pctVsLY?: number;
}

export interface DirectorPickupBarProps {
  data: Array<DirectorPickupBarDatum>;
  height?: number;
  valueLabel?: string;
}

const DEFAULT_HEIGHT = 120;

// Reserved space inside the chart for the top value label and the axis label
// at the bottom. The remaining vertical space is used for the bar itself.
const TOP_LABEL_OFFSET = 16;
const AXIS_LABEL_OFFSET = 16;
const BAR_GAP = 8;
const BAR_CORNER_RADIUS = 3;

/** Bar colour by the sign of the delta vs LY (success / danger); unknown or zero → tertiary label. */
function pickColor(pctVsLY: number | undefined): string {
  if (typeof pctVsLY !== "number" || Number.isNaN(pctVsLY)) return "var(--cocoa-label-tertiary)";
  const tone = barTone(pctVsLY, "positive-good");
  return tone === "neutral" ? "var(--cocoa-label-tertiary)" : toneColor(tone);
}

function formatNet(value: number): string {
  return number(value, { signDisplay: "exceptZero", maximumFractionDigits: 0 });
}

function formatPct(pct: number): string {
  return percent(pct, { signDisplay: "exceptZero", minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function DirectorPickupBar({ data, height = DEFAULT_HEIGHT, valueLabel }: DirectorPickupBarProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const chartHeight = Math.max(height, 60);
  const plotHeight = Math.max(chartHeight - TOP_LABEL_OFFSET - AXIS_LABEL_OFFSET, 1);

  const maxAbs = useMemo(() => {
    if (data.length === 0) return 1;
    const max = Math.max(...data.map((d) => Math.abs(d.net)));
    return max > 0 ? max : 1;
  }, [data]);

  if (data.length === 0) {
    return (
      <CocoaCard variant="bordered" padding="md">
        <div
          style={{
            height: chartHeight,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--cocoa-label-secondary)",
            fontFamily: "var(--cocoa-font)",
            fontSize: "var(--cocoa-fs-footnote)"
          }}
        >
          Sin datos
        </div>
      </CocoaCard>
    );
  }

  const containerStyle: CSSProperties = {
    position: "relative",
    width: "100%",
    height: chartHeight,
    display: "flex",
    alignItems: "stretch",
    gap: BAR_GAP,
    fontFamily: "var(--cocoa-font)"
  };

  return (
    <CocoaCard variant="bordered" padding="md">
      {valueLabel ? (
        <div
          style={{
            fontFamily: "var(--cocoa-font)",
            fontSize: "var(--cocoa-fs-footnote)",
            lineHeight: "var(--cocoa-lh-footnote)",
            color: "var(--cocoa-label-secondary)",
            marginBottom: "var(--cocoa-space-2)",
            fontWeight: "var(--cocoa-fw-medium)" as CSSProperties["fontWeight"]
          }}
        >
          {valueLabel}
        </div>
      ) : null}
      <div style={containerStyle} role="group" aria-label="Pickup neto últimos 7 días">
        {data.map((d, index) => {
          const color = pickColor(d.pctVsLY);
          const h = barHeight(d.net, maxAbs, plotHeight);
          const isHovered = hoveredIndex === index;

          const tooltipParts: string[] = [`Pickup neto: ${formatNet(d.net)}`];
          if (typeof d.pctVsLY === "number" && !Number.isNaN(d.pctVsLY)) {
            tooltipParts.push(`frente al año anterior: ${formatPct(d.pctVsLY)}`);
          } else {
            tooltipParts.push("frente al año anterior: —");
          }
          const tooltipText = tooltipParts.join(" · ");

          return (
            <div
              key={`${d.day}-${index}`}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "flex-end",
                minWidth: 0,
                position: "relative",
                cursor: "default"
              }}
              onMouseEnter={() => setHoveredIndex(index)}
              onMouseLeave={() => setHoveredIndex(null)}
              onFocus={() => setHoveredIndex(index)}
              onBlur={() => setHoveredIndex(null)}
              tabIndex={0}
              role="img"
              aria-label={`${d.day}: ${tooltipText}`}
            >
              <div
                style={{
                  fontSize: "var(--cocoa-fs-caption)",
                  lineHeight: `${TOP_LABEL_OFFSET}px`,
                  height: TOP_LABEL_OFFSET,
                  color: "var(--cocoa-label)",
                  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
                  fontVariantNumeric: "tabular-nums",
                  textAlign: "center"
                }}
              >
                {formatNet(d.net)}
              </div>
              <div
                style={{
                  height: plotHeight,
                  width: "100%",
                  display: "flex",
                  alignItems: "flex-end",
                  justifyContent: "center"
                }}
              >
                <div
                  style={{
                    width: "100%",
                    maxWidth: 28,
                    height: h,
                    background: color,
                    borderRadius: BAR_CORNER_RADIUS,
                    opacity: isHovered ? 0.85 : 1,
                    transition: "opacity var(--cocoa-duration-fast) var(--cocoa-ease-out)"
                  }}
                />
              </div>
              <div
                style={{
                  fontSize: "var(--cocoa-fs-caption)",
                  lineHeight: `${AXIS_LABEL_OFFSET}px`,
                  height: AXIS_LABEL_OFFSET,
                  color: "var(--cocoa-label-secondary)",
                  textAlign: "center"
                }}
              >
                {d.day}
              </div>
              {isHovered ? (
                <div
                  role="tooltip"
                  style={{
                    position: "absolute",
                    bottom: `calc(100% - ${TOP_LABEL_OFFSET}px + 4px)`,
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
                  {tooltipText}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </CocoaCard>
  );
}

export default DirectorPickupBar;
