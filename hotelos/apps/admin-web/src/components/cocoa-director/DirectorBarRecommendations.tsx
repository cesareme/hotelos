import type { CSSProperties } from "react";
import { CocoaCard } from "../cocoa/CocoaCard";
import { CocoaButton } from "../cocoa/CocoaButton";
import { SparkleIcon } from "../cocoa-icons/NavigationIcons";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface DirectorBarRecommendation {
  /** ISO date string (e.g. "2026-06-15"). */
  date: string;
  /** Current BAR price in EUR. */
  currentBar: number;
  /** AI-suggested BAR price in EUR. */
  suggestedBar: number;
  /** Estimated revenue lift in EUR. */
  estimatedRevenueLift: number;
  /** Confidence percentage (0-100). */
  confidence: number;
}

export interface DirectorBarRecommendationsProps {
  recommendations: Array<DirectorBarRecommendation>;
  onApply?: (date: string) => void;
  onViewAll?: () => void;
  className?: string;
  style?: CSSProperties;
}

/* ------------------------------------------------------------------ */
/*  Tokens & helpers                                                   */
/* ------------------------------------------------------------------ */

const MAX_VISIBLE_RECOMMENDATIONS = 3;

const MONTH_ABBR_ES = [
  "Ene",
  "Feb",
  "Mar",
  "Abr",
  "May",
  "Jun",
  "Jul",
  "Ago",
  "Sep",
  "Oct",
  "Nov",
  "Dic"
];

function formatDateDDMMM(dateString: string): string {
  // Accept ISO dates like "2026-06-15" or anything Date can parse.
  // Use a UTC-safe parse for the common YYYY-MM-DD shape to avoid TZ shifts.
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateString);
  let day: number;
  let monthIdx: number;
  if (isoMatch) {
    day = Number(isoMatch[3]);
    monthIdx = Number(isoMatch[2]) - 1;
  } else {
    const parsed = new Date(dateString);
    if (Number.isNaN(parsed.getTime())) {
      return dateString;
    }
    day = parsed.getDate();
    monthIdx = parsed.getMonth();
  }
  const month = MONTH_ABBR_ES[monthIdx] ?? "";
  const dayStr = day.toString().padStart(2, "0");
  return `${dayStr} ${month}`;
}

function formatEur(value: number): string {
  const abs = Math.abs(value);
  let formatted: string;
  if (abs >= 1000) {
    const inK = abs / 1000;
    const decimals = inK >= 10 ? 0 : 1;
    formatted = `${inK.toFixed(decimals)}k`;
  } else {
    const decimals = abs < 10 && abs % 1 !== 0 ? 1 : 0;
    formatted = abs.toFixed(decimals);
  }
  return `€${formatted}`;
}

function formatLift(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatEur(value)}`;
}

function confidenceColor(confidence: number): string {
  const clamped = Math.max(0, Math.min(100, confidence));
  if (clamped >= 75) return "var(--cocoa-success)";
  if (clamped >= 50) return "var(--cocoa-warning)";
  return "var(--cocoa-danger)";
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function DirectorBarRecommendations({
  recommendations,
  onApply,
  onViewAll,
  className,
  style
}: DirectorBarRecommendationsProps) {
  const visible = recommendations.slice(0, MAX_VISIBLE_RECOMMENDATIONS);
  const isEmpty = visible.length === 0;

  const wrapperStyle: CSSProperties = {
    fontFamily: "var(--cocoa-font)",
    color: "var(--cocoa-label)",
    ...style
  };

  const headerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 12
  };

  const iconWrapStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 20,
    height: 20,
    color: "var(--cocoa-accent)",
    flexShrink: 0
  };

  const titleStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-title-3)",
    fontWeight: "var(--cocoa-fw-bold)" as unknown as number,
    letterSpacing: "var(--cocoa-tracking-tight)",
    lineHeight: 1.3,
    margin: 0,
    color: "var(--cocoa-label)"
  };

  const emptyStyle: CSSProperties = {
    paddingBlock: 16,
    textAlign: "center",
    color: "var(--cocoa-secondary-label, #8E8E93)",
    fontSize: "var(--cocoa-fs-callout)",
    letterSpacing: "var(--cocoa-tracking-tight)"
  };

  const listStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 8
  };

  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    paddingBlock: 8,
    borderBottom: "1px solid var(--cocoa-separator)"
  };

  const lastRowStyle: CSSProperties = {
    ...rowStyle,
    borderBottom: "none"
  };

  const dateStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-body)",
    fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
    color: "var(--cocoa-label)",
    flexShrink: 0,
    minWidth: 56
  };

  const pricesStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: "var(--cocoa-fs-body)",
    color: "var(--cocoa-label)",
    fontVariantNumeric: "tabular-nums",
    flexShrink: 0
  };

  const currentPriceStyle: CSSProperties = {
    color: "var(--cocoa-secondary-label, #8E8E93)",
    fontWeight: "var(--cocoa-fw-regular)" as unknown as number
  };

  const arrowStyle: CSSProperties = {
    color: "var(--cocoa-secondary-label, #8E8E93)",
    fontSize: "var(--cocoa-fs-callout)"
  };

  const suggestedPriceStyle: CSSProperties = {
    color: "var(--cocoa-label)",
    fontWeight: "var(--cocoa-fw-semibold)" as unknown as number
  };

  const liftStyle: CSSProperties = {
    marginLeft: "auto",
    fontSize: "var(--cocoa-fs-callout)",
    fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
    color: "var(--cocoa-success)",
    fontVariantNumeric: "tabular-nums",
    flexShrink: 0
  };

  const confidenceWrapStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    flexShrink: 0
  };

  const footerStyle: CSSProperties = {
    marginTop: 12,
    display: "flex",
    justifyContent: "flex-end"
  };

  return (
    <CocoaCard variant="bordered" padding="md" className={className}>
      <div style={wrapperStyle}>
        <div style={headerStyle}>
          <span style={iconWrapStyle} aria-hidden="true">
            <SparkleIcon size={18} color="var(--cocoa-accent)" />
          </span>
          <h3 style={titleStyle}>BAR Recommendations IA</h3>
        </div>

        {isEmpty ? (
          <div style={emptyStyle}>Sin recomendaciones nuevas</div>
        ) : (
          <>
            <div style={listStyle} role="list">
              {visible.map((rec, index) => {
                const isLast = index === visible.length - 1;
                const confidence = Math.max(
                  0,
                  Math.min(100, Math.round(rec.confidence))
                );
                const dotStyle: CSSProperties = {
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: confidenceColor(rec.confidence),
                  display: "inline-block",
                  flexShrink: 0
                };
                const dateLabel = formatDateDDMMM(rec.date);

                return (
                  <div
                    key={`${rec.date}-${index}`}
                    style={isLast ? lastRowStyle : rowStyle}
                    role="listitem"
                    aria-label={`Recomendación BAR ${dateLabel}: ${formatEur(rec.currentBar)} a ${formatEur(rec.suggestedBar)}, lift ${formatLift(rec.estimatedRevenueLift)}, confianza ${confidence}%`}
                  >
                    <span style={dateStyle}>{dateLabel}</span>
                    <span style={pricesStyle}>
                      <span style={currentPriceStyle}>
                        {formatEur(rec.currentBar)}
                      </span>
                      <span style={arrowStyle} aria-hidden="true">
                        →
                      </span>
                      <span style={suggestedPriceStyle}>
                        {formatEur(rec.suggestedBar)}
                      </span>
                    </span>
                    <span style={liftStyle}>
                      {formatLift(rec.estimatedRevenueLift)}
                    </span>
                    <span
                      style={confidenceWrapStyle}
                      aria-label={`Confianza ${confidence}%`}
                      title={`Confianza ${confidence}%`}
                    >
                      <span style={dotStyle} aria-hidden="true" />
                    </span>
                    {onApply ? (
                      <CocoaButton
                        variant="filled"
                        tone="accent"
                        size="small"
                        onClick={() => onApply(rec.date)}
                      >
                        Aplicar
                      </CocoaButton>
                    ) : null}
                  </div>
                );
              })}
            </div>

            <div style={footerStyle}>
              <CocoaButton
                variant="plain"
                tone="accent"
                size="small"
                onClick={onViewAll}
              >
                Ver todas →
              </CocoaButton>
            </div>
          </>
        )}
      </div>
    </CocoaCard>
  );
}

export default DirectorBarRecommendations;
