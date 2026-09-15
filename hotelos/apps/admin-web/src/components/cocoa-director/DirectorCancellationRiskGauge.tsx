// DirectorCancellationRiskGauge — semi-circular risk gauge for cancellations.
//
// Renders a CocoaCard with a half-doughnut SVG gauge whose color and needle
// follow the score (0-100). Color thresholds:
//   - 0-30%  → success (verde)
//   - 30-60% → warning (ambar)
//   - 60-100% → danger (rojo)
//
// Below the gauge: the score label, the "Riesgo cancelacion" caption, the
// number of reservations at risk, and an optional "Revisar" call to action.
//
// Cocoa 22 (ola 2): the geometry (track, progress arc, needle, 220×130 box)
// comes from `cocoa/cocoa-chart-math` — the same helpers `CocoaChart.Gauge`
// uses — so the two render identical shapes; the tone comes from
// `thresholdTone` + `toneColor`. Screens should use `CocoaChart.Gauge`
// directly; this component stays for the legacy callers until wave 11.

import { useMemo, type CSSProperties } from "react";

import { CocoaCard } from "../cocoa/CocoaCard";
import { CocoaButton } from "../cocoa/CocoaButton";
import { gaugeToneLabel } from "../cocoa/CocoaChart";
import { GAUGE, gaugeGeometry, thresholdTone } from "../cocoa/cocoa-chart-math";
import { toneColor } from "../cocoa/cocoa-tones";
import { number, plural } from "../../lib/format";

export interface DirectorCancellationRiskGaugeProps {
  score: number;
  reservationsAtRisk: number;
  onReview?: () => void;
}

// Cancellation risk thresholds (0–30 low · 30–60 moderate · 60–100 high).
const RISK_THRESHOLDS: [number, number] = [30, 60];

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--cocoa-space-3)",
  fontFamily: "var(--cocoa-font)",
  color: "var(--cocoa-label)"
};

const gaugeWrapStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  maxWidth: GAUGE.width,
  display: "flex",
  justifyContent: "center"
};

const centerLabelWrapStyle: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 6,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  pointerEvents: "none"
};

const scoreTextStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-title-1)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1,
  color: "var(--cocoa-label)",
  fontVariantNumeric: "tabular-nums"
};

const subLabelStyle: CSSProperties = {
  marginTop: "var(--cocoa-space-1)",
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)",
  textAlign: "center"
};

const footerStyle: CSSProperties = {
  width: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--cocoa-space-2)"
};

const countStyle: CSSProperties = {
  margin: 0,
  fontSize: "var(--cocoa-fs-subheadline)",
  color: "var(--cocoa-label-secondary)",
  textAlign: "center"
};

export function DirectorCancellationRiskGauge({ score, reservationsAtRisk, onReview }: DirectorCancellationRiskGaugeProps) {
  const clampedScore = Math.max(0, Math.min(100, score));
  const tone = thresholdTone(clampedScore, RISK_THRESHOLDS, false);
  const color = toneColor(tone);
  const toneLabel = gaugeToneLabel(tone);
  const geometry = useMemo(() => gaugeGeometry(clampedScore, 0, 100), [clampedScore]);
  const scoreText = `${number(Math.round(clampedScore))} %`;

  return (
    <CocoaCard padding="md">
      <div style={containerStyle}>
        <div style={gaugeWrapStyle}>
          <svg
            viewBox={`0 0 ${GAUGE.width} ${GAUGE.height}`}
            width="100%"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={`Riesgo de cancelación ${scoreText} (${toneLabel})`}
            style={{ display: "block", aspectRatio: `${GAUGE.width} / ${GAUGE.height}` }}
          >
            <path d={geometry.trackPath} fill="none" stroke="var(--cocoa-chart-track)" strokeWidth={GAUGE.stroke} strokeLinecap="round" />
            <path d={geometry.progressPath} fill="none" stroke={color} strokeWidth={GAUGE.stroke} strokeLinecap="round" />
            <path d={geometry.needlePath} fill={color} />
            <circle cx={GAUGE.cx} cy={GAUGE.cy} r={6} fill={color} />
            <circle cx={GAUGE.cx} cy={GAUGE.cy} r={3} fill="var(--cocoa-background-content)" />
          </svg>
          <div style={centerLabelWrapStyle}>
            <span style={scoreTextStyle}>{scoreText}</span>
            <span style={subLabelStyle}>Riesgo de cancelación</span>
          </div>
        </div>

        <div style={footerStyle}>
          <p style={countStyle}>{plural(reservationsAtRisk, "reserva en riesgo", "reservas en riesgo")}</p>
          {onReview ? (
            <CocoaButton variant="tinted" size="small" onClick={onReview}>
              Revisar →
            </CocoaButton>
          ) : null}
        </div>
      </div>
    </CocoaCard>
  );
}

export default DirectorCancellationRiskGauge;
