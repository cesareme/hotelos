// DirectorSegmentBars — horizontal segment bars for hotel mix breakdown.
//
// Visualizes hotel segments (Corporate, Leisure, Group, Wholesale, OTA) as
// horizontal bars. Each row shows: segment name + ADR (left), Δ vs LY arrow
// (right), and a sub-label with Mix %. Bar width is proportional to mixPct
// on a fixed 0-100% scale.
//
// Tokens-only: no hex/px literals; relies on Cocoa CSS variables.

import type { CSSProperties } from "react";
import { CocoaCard } from "../cocoa/CocoaCard";

export interface DirectorSegmentBarsSegment {
  name: string;
  adr: number;
  mixPct: number;
  deltaVsLY: number;
}

export interface DirectorSegmentBarsProps {
  segments: Array<DirectorSegmentBarsSegment>;
  maxBars?: number;
  valueLabel?: string;
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmtEur(value: number): string {
  if (!Number.isFinite(value)) return "€0.00";
  // Use tabular numerals via CSS; format value with two decimals and EUR sign.
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function fmtDelta(value: number): string {
  if (!Number.isFinite(value)) return "€0.00";
  const abs = Math.abs(value);
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  const formatted = new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(abs);
  return `${sign}${formatted}`;
}

function fmtMix(value: number): string {
  const v = Number.isFinite(value) ? value : 0;
  const clamped = Math.max(0, Math.min(100, v));
  // Show whole percent — keeps the sub label compact.
  return `Mix ${Math.round(clamped)}%`;
}

function clampMixPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function deltaColor(value: number): string {
  if (!Number.isFinite(value) || value === 0) {
    return "var(--cocoa-label-secondary)";
  }
  return value > 0 ? "var(--cocoa-success)" : "var(--cocoa-danger)";
}

function deltaArrow(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "→";
  return value > 0 ? "▲" : "▼";
}

// ---------------------------------------------------------------------------
// Styles (token-based)
// ---------------------------------------------------------------------------

const wrapperStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-3)",
  fontFamily: "var(--cocoa-font)",
  color: "var(--cocoa-label)"
};

const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: "var(--cocoa-space-2)"
};

const headerTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-headline)",
  fontWeight: 600,
  color: "var(--cocoa-label)"
};

const headerSubStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)",
  textTransform: "uppercase",
  letterSpacing: "0.04em"
};

const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-3)"
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-1)"
};

const rowHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: "var(--cocoa-space-2)"
};

const leftLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--cocoa-space-2)",
  minWidth: 0,
  flex: "1 1 auto"
};

const segmentNameStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-body)",
  fontWeight: 600,
  color: "var(--cocoa-label)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap"
};

const adrStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-callout)",
  color: "var(--cocoa-label-secondary)",
  fontVariantNumeric: "tabular-nums"
};

const deltaStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-callout)",
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  flex: "0 0 auto",
  whiteSpace: "nowrap"
};

const barTrackStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: 6,
  background: "var(--cocoa-label-quaternary)",
  borderRadius: "var(--cocoa-radius-full)",
  overflow: "hidden"
};

const subStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)",
  fontVariantNumeric: "tabular-nums"
};

const emptyStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-callout)",
  color: "var(--cocoa-label-secondary)",
  textAlign: "center",
  padding: "var(--cocoa-space-4) 0"
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DirectorSegmentBars({
  segments,
  maxBars,
  valueLabel = "ADR / Mix"
}: DirectorSegmentBarsProps) {
  const limit =
    typeof maxBars === "number" && maxBars > 0
      ? Math.floor(maxBars)
      : segments.length;
  const visible = segments.slice(0, limit);

  return (
    <CocoaCard variant="bordered" padding="md">
      <div style={wrapperStyle}>
        <div style={headerStyle}>
          <h3 style={headerTitleStyle}>Segments</h3>
          <span style={headerSubStyle}>{valueLabel}</span>
        </div>

        {visible.length === 0 ? (
          <div style={emptyStyle}>No segment data available.</div>
        ) : (
          <div style={listStyle} role="list" aria-label="Hotel segments mix">
            {visible.map((segment, index) => {
              const mix = clampMixPct(segment.mixPct);
              const dColor = deltaColor(segment.deltaVsLY);
              const arrow = deltaArrow(segment.deltaVsLY);
              const barFillStyle: CSSProperties = {
                position: "absolute",
                inset: 0,
                width: `${mix}%`,
                background: "var(--cocoa-accent)",
                borderRadius: "var(--cocoa-radius-full)"
              };
              const deltaRowStyle: CSSProperties = {
                ...deltaStyle,
                color: dColor
              };
              const key = `${segment.name}-${index}`;
              return (
                <div key={key} role="listitem" style={rowStyle}>
                  <div style={rowHeaderStyle}>
                    <div style={leftLabelStyle}>
                      <span style={segmentNameStyle}>{segment.name}</span>
                      <span style={adrStyle}>{fmtEur(segment.adr)}</span>
                    </div>
                    <span
                      style={deltaRowStyle}
                      aria-label={`Delta versus last year ${fmtDelta(
                        segment.deltaVsLY
                      )}`}
                    >
                      {`Δ ${arrow} ${fmtDelta(segment.deltaVsLY)}`}
                    </span>
                  </div>
                  <div
                    style={barTrackStyle}
                    role="progressbar"
                    aria-valuenow={Math.round(mix)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${segment.name} mix`}
                  >
                    <div style={barFillStyle} />
                  </div>
                  <span style={subStyle}>{fmtMix(segment.mixPct)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </CocoaCard>
  );
}

export default DirectorSegmentBars;
