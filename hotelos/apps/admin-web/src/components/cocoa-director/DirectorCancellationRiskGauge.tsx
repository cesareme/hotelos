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

import { useMemo, type CSSProperties } from "react";

import { CocoaCard } from "../cocoa/CocoaCard";
import { CocoaButton } from "../cocoa/CocoaButton";

export interface DirectorCancellationRiskGaugeProps {
  score: number;
  reservationsAtRisk: number;
  onReview?: () => void;
}

type RiskTone = "success" | "warning" | "error";

function getTone(score: number): RiskTone {
  if (score < 30) return "success";
  if (score < 60) return "warning";
  return "error";
}

const TONE_COLOR: Record<RiskTone, string> = {
  success: "var(--cocoa-success)",
  warning: "var(--cocoa-warning)",
  error: "var(--cocoa-danger)"
};

const TONE_LABEL: Record<RiskTone, string> = {
  success: "Bajo",
  warning: "Moderado",
  error: "Alto"
};

// Gauge geometry. The viewBox is twice the size of the radius so the gauge
// fits cleanly inside it with stroke caps.
const VIEW_W = 220;
const VIEW_H = 130;
const CX = VIEW_W / 2;
const CY = 110;
const RADIUS = 90;
const STROKE_WIDTH = 16;

// Convert a 0..100 score into an angle in degrees within a semicircle whose
// left side (180 degrees) maps to 0 and right side (0 degrees) maps to 100.
function scoreToAngle(score: number): number {
  const clamped = Math.max(0, Math.min(100, score));
  return 180 - (clamped / 100) * 180;
}

function polarToCartesian(
  cx: number,
  cy: number,
  radius: number,
  angleDeg: number
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy - radius * Math.sin(rad)
  };
}

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
  maxWidth: VIEW_W,
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
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1,
  color: "var(--cocoa-label)"
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

export function DirectorCancellationRiskGauge({
  score,
  reservationsAtRisk,
  onReview
}: DirectorCancellationRiskGaugeProps) {
  const clampedScore = Math.max(0, Math.min(100, score));
  const tone = useMemo(() => getTone(clampedScore), [clampedScore]);
  const color = TONE_COLOR[tone];
  const toneLabel = TONE_LABEL[tone];

  // Build the background (track) and foreground (progress) arcs.
  const startPoint = polarToCartesian(CX, CY, RADIUS, 180);
  const endPoint = polarToCartesian(CX, CY, RADIUS, 0);
  const trackPath = `M ${startPoint.x} ${startPoint.y} A ${RADIUS} ${RADIUS} 0 0 1 ${endPoint.x} ${endPoint.y}`;

  const progressAngle = scoreToAngle(clampedScore);
  const progressEnd = polarToCartesian(CX, CY, RADIUS, progressAngle);
  const largeArcFlag = 180 - progressAngle > 180 ? 1 : 0;
  const progressPath = `M ${startPoint.x} ${startPoint.y} A ${RADIUS} ${RADIUS} 0 ${largeArcFlag} 1 ${progressEnd.x} ${progressEnd.y}`;

  // Needle geometry — a triangular pointer rotated to the score angle.
  const needleLength = RADIUS - 6;
  const needleTip = polarToCartesian(CX, CY, needleLength, progressAngle);
  const needleBaseLeft = polarToCartesian(
    CX,
    CY,
    8,
    progressAngle + 90
  );
  const needleBaseRight = polarToCartesian(
    CX,
    CY,
    8,
    progressAngle - 90
  );
  const needlePath = `M ${needleTip.x} ${needleTip.y} L ${needleBaseLeft.x} ${needleBaseLeft.y} L ${needleBaseRight.x} ${needleBaseRight.y} Z`;

  const reviewLabel = reservationsAtRisk === 1
    ? "1 reserva en riesgo"
    : `${reservationsAtRisk} reservas en riesgo`;

  return (
    <CocoaCard padding="md">
      <div style={containerStyle}>
        <div style={gaugeWrapStyle}>
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            width="100%"
            role="img"
            aria-label={`Riesgo de cancelacion ${Math.round(clampedScore)}% (${toneLabel})`}
          >
            <path
              d={trackPath}
              fill="none"
              stroke="var(--cocoa-separator)"
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="round"
            />
            <path
              d={progressPath}
              fill="none"
              stroke={color}
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="round"
            />
            <path d={needlePath} fill={color} />
            <circle cx={CX} cy={CY} r={6} fill={color} />
            <circle
              cx={CX}
              cy={CY}
              r={3}
              fill="var(--cocoa-background-content)"
            />
          </svg>
          <div style={centerLabelWrapStyle}>
            <span style={scoreTextStyle}>{Math.round(clampedScore)}%</span>
            <span style={subLabelStyle}>Riesgo cancelacion</span>
          </div>
        </div>

        <div style={footerStyle}>
          <p style={countStyle}>{reviewLabel}</p>
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
