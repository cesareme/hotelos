import type { CSSProperties } from "react";
import { CocoaCard } from "../cocoa/CocoaCard";
import { CocoaButton } from "../cocoa/CocoaButton";
import { SparkleIcon } from "../cocoa-icons/NavigationIcons";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type DirectorAiInsightType = "anomaly" | "opportunity" | "risk";
export type DirectorAiInsightSeverity = "low" | "medium" | "high";
export type DirectorAiInsightImpactUnit = "€" | "pp" | "%";
export type DirectorAiInsightImpactMetric = "revpar" | "occupancy" | "revenue";

export interface DirectorAiInsightImpact {
  value: number;
  unit: DirectorAiInsightImpactUnit;
  metric: DirectorAiInsightImpactMetric;
}

export interface DirectorAiInsightRecommendedAction {
  label: string;
  onClick: () => void;
}

export interface DirectorAiInsightCardProps {
  type: DirectorAiInsightType;
  title: string;
  description: string;
  impact?: DirectorAiInsightImpact;
  /** Confidence 0-100. */
  confidence?: number;
  recommendedAction?: DirectorAiInsightRecommendedAction;
  onDismiss?: () => void;
  severity?: DirectorAiInsightSeverity;
  className?: string;
  style?: CSSProperties;
}

/* ------------------------------------------------------------------ */
/*  Tokens & helpers                                                   */
/* ------------------------------------------------------------------ */

const TYPE_LABEL: Record<DirectorAiInsightType, string> = {
  anomaly: "Anomalía",
  opportunity: "Oportunidad",
  risk: "Riesgo"
};

const TYPE_BASE_COLOR: Record<DirectorAiInsightType, string> = {
  anomaly: "var(--cocoa-warning)",
  opportunity: "var(--cocoa-success)",
  risk: "var(--cocoa-danger)"
};

const TYPE_TINT_BG: Record<DirectorAiInsightType, string> = {
  anomaly: "rgba(255, 149, 0, 0.14)",
  opportunity: "rgba(40, 167, 69, 0.14)",
  risk: "rgba(255, 59, 48, 0.14)"
};

const SEVERITY_DOT_COLOR: Record<DirectorAiInsightSeverity, string> = {
  low: "var(--cocoa-secondary-label, #8E8E93)",
  medium: "var(--cocoa-warning)",
  high: "var(--cocoa-danger)"
};

const SEVERITY_LABEL: Record<DirectorAiInsightSeverity, string> = {
  low: "Baja",
  medium: "Media",
  high: "Alta"
};

const METRIC_LABEL: Record<DirectorAiInsightImpactMetric, string> = {
  revpar: "RevPAR",
  occupancy: "ocupación",
  revenue: "revenue"
};

function formatImpactValue(impact: DirectorAiInsightImpact): string {
  const { value, unit } = impact;
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const abs = Math.abs(value);

  if (unit === "€") {
    let formatted: string;
    if (abs >= 1000) {
      const inK = abs / 1000;
      const decimals = inK >= 10 ? 0 : 1;
      formatted = `${inK.toFixed(decimals)}k`;
    } else {
      const decimals = abs < 10 && abs % 1 !== 0 ? 1 : 0;
      formatted = abs.toFixed(decimals);
    }
    return `${sign}€${formatted}`;
  }

  if (unit === "pp") {
    const decimals = abs < 10 && abs % 1 !== 0 ? 1 : 0;
    return `${sign}${abs.toFixed(decimals)}pp`;
  }

  // "%"
  const decimals = abs < 10 && abs % 1 !== 0 ? 1 : 0;
  return `${sign}${abs.toFixed(decimals)}%`;
}

function buildImpactLine(
  impact: DirectorAiInsightImpact | undefined,
  confidence: number | undefined
): string | null {
  const parts: string[] = [];

  if (impact) {
    parts.push(`${formatImpactValue(impact)} ${METRIC_LABEL[impact.metric]}`);
  }

  if (typeof confidence === "number" && Number.isFinite(confidence)) {
    const clamped = Math.max(0, Math.min(100, Math.round(confidence)));
    parts.push(`${clamped}% confianza`);
  }

  if (parts.length === 0) return null;

  return `Impacto: ${parts.join(" · ")}`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function DirectorAiInsightCard({
  type,
  title,
  description,
  impact,
  confidence,
  recommendedAction,
  onDismiss,
  severity,
  className,
  style
}: DirectorAiInsightCardProps) {
  const borderColor = TYPE_BASE_COLOR[type];
  const tintBg = TYPE_TINT_BG[type];
  const typeAccent = TYPE_BASE_COLOR[type];

  const wrapperStyle: CSSProperties = {
    borderLeft: `4px solid ${borderColor}`,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
    fontFamily: "var(--cocoa-font)",
    color: "var(--cocoa-label)",
    animation:
      "director-ai-insight-fade-in var(--cocoa-duration-base, 220ms) var(--cocoa-ease-out, ease-out) both",
    ...style
  };

  const headerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8
  };

  const iconWrapStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    color: typeAccent,
    flexShrink: 0
  };

  const badgeStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    paddingInline: 8,
    paddingBlock: 2,
    borderRadius: "var(--cocoa-radius-sm, 6px)",
    background: tintBg,
    color: typeAccent,
    fontSize: "var(--cocoa-fs-subheadline)",
    fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
    letterSpacing: "var(--cocoa-tracking-tight)",
    lineHeight: 1.2,
    textTransform: "none"
  };

  const severityWrapStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    marginLeft: "auto",
    fontSize: "var(--cocoa-fs-caption)",
    color: "var(--cocoa-secondary-label, #8E8E93)",
    letterSpacing: "var(--cocoa-tracking-tight)"
  };

  const severityDotStyle: CSSProperties | undefined = severity
    ? {
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: SEVERITY_DOT_COLOR[severity],
        display: "inline-block",
        flexShrink: 0
      }
    : undefined;

  const titleStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-title-3)",
    fontWeight: "var(--cocoa-fw-bold)" as unknown as number,
    letterSpacing: "var(--cocoa-tracking-tight)",
    lineHeight: 1.3,
    margin: 0,
    color: "var(--cocoa-label)"
  };

  const descriptionStyle: CSSProperties = {
    marginTop: 6,
    fontSize: "var(--cocoa-fs-body)",
    fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
    lineHeight: 1.45,
    color: "var(--cocoa-label)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word"
  };

  const impactLine = buildImpactLine(impact, confidence);
  const impactRowStyle: CSSProperties = {
    marginTop: 12,
    fontSize: "var(--cocoa-fs-callout)",
    color: "var(--cocoa-secondary-label, #8E8E93)",
    letterSpacing: "var(--cocoa-tracking-tight)",
    lineHeight: 1.4
  };

  const footerStyle: CSSProperties = {
    marginTop: 14,
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap"
  };

  const hasFooter = Boolean(recommendedAction) || Boolean(onDismiss);

  return (
    <CocoaCard
      variant="bordered"
      padding="md"
      className={className}
    >
      <style>{`
        @keyframes director-ai-insight-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div style={wrapperStyle}>
        <div style={headerStyle}>
          <span style={iconWrapStyle} aria-hidden="true">
            <SparkleIcon size={18} color={typeAccent} />
          </span>
          <span style={badgeStyle}>{TYPE_LABEL[type]}</span>
          {severity ? (
            <span
              style={severityWrapStyle}
              aria-label={`Severidad ${SEVERITY_LABEL[severity]}`}
            >
              <span style={severityDotStyle} aria-hidden="true" />
              <span>{SEVERITY_LABEL[severity]}</span>
            </span>
          ) : null}
        </div>

        <h3 style={titleStyle}>{title}</h3>
        <p style={descriptionStyle}>{description}</p>

        {impactLine ? <div style={impactRowStyle}>{impactLine}</div> : null}

        {hasFooter ? (
          <div style={footerStyle}>
            {recommendedAction ? (
              <CocoaButton
                variant="filled"
                tone="accent"
                size="regular"
                onClick={recommendedAction.onClick}
              >
                {recommendedAction.label || "Aplicar"}
              </CocoaButton>
            ) : null}
            {onDismiss ? (
              <CocoaButton
                variant="plain"
                tone="neutral"
                size="regular"
                onClick={onDismiss}
              >
                Descartar
              </CocoaButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </CocoaCard>
  );
}

export default DirectorAiInsightCard;
