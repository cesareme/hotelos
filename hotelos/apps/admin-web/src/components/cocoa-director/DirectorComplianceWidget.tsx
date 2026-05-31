// DirectorComplianceWidget — Director-mode dashboard card showing the
// health of a single compliance authority (VeriFactu, SES.HOSPEDAJES,
// TicketBAI, IGIC, or GDPR).
//
// Layout (CocoaCard padding="sm"):
//   - Header : Authority badge ("VeriFactu" / "SES" / "TBAI" / "IGIC" /
//              "GDPR") + status dot tinted by status (ok/warning/critical).
//   - Body   : Large tabular pending count + small "pendientes" label.
//   - Sub    : Contextual line — preferring errors when present, then
//              the last submission timestamp, then "Sin envios hoy".
//   - Footer : "Ver detalle →" link wired to onDrillDown.
//
// Status colors follow the standard Cocoa status palette:
//   ok       → var(--cocoa-success)
//   warning  → var(--cocoa-warning)
//   critical → var(--cocoa-danger)
//
// The whole card is clickable when onDrillDown is provided.

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";

import { CocoaCard } from "../cocoa/CocoaCard";

export type DirectorComplianceAuthority =
  | "verifactu"
  | "ses"
  | "tbai"
  | "igic"
  | "gdpr";

export type DirectorComplianceStatus = "ok" | "warning" | "critical";

export interface DirectorComplianceWidgetProps {
  authority: DirectorComplianceAuthority;
  pendingCount: number;
  status: DirectorComplianceStatus;
  lastSubmission?: string;
  errorsCount?: number;
  onDrillDown?: () => void;
}

const AUTHORITY_LABEL: Record<DirectorComplianceAuthority, string> = {
  verifactu: "VeriFactu",
  ses: "SES",
  tbai: "TBAI",
  igic: "IGIC",
  gdpr: "GDPR"
};

const STATUS_COLOR: Record<DirectorComplianceStatus, string> = {
  ok: "var(--cocoa-success)",
  warning: "var(--cocoa-warning)",
  critical: "var(--cocoa-danger)"
};

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-2)",
  fontFamily: "var(--cocoa-font)",
  minWidth: 0
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--cocoa-space-2)"
};

const authorityBadgeStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: "var(--cocoa-radius-sm)",
  background: "color-mix(in srgb, var(--cocoa-accent) 10%, transparent)",
  color: "var(--cocoa-accent)",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-wide)",
  textTransform: "uppercase",
  lineHeight: 1.4,
  whiteSpace: "nowrap"
};

function getStatusDotStyle(status: DirectorComplianceStatus): CSSProperties {
  const color = STATUS_COLOR[status];
  return {
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: color,
    boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)`,
    flexShrink: 0
  };
}

const bodyRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--cocoa-space-2)",
  marginTop: "var(--cocoa-space-1)"
};

const countStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-large-title)",
  lineHeight: 1,
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  color: "var(--cocoa-label)",
  fontFamily: "var(--cocoa-font-display)",
  fontFeatureSettings: 'var(--cocoa-font-numeric-tabular)',
  letterSpacing: "var(--cocoa-tracking-tight)"
};

const countLabelStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-subheadline)",
  color: "var(--cocoa-label-secondary)",
  fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
  lineHeight: 1.2
};

function getSubStyle(status: DirectorComplianceStatus, hasErrors: boolean): CSSProperties {
  return {
    fontSize: "var(--cocoa-fs-footnote)",
    lineHeight: 1.3,
    color: hasErrors ? STATUS_COLOR[status] : "var(--cocoa-label-secondary)",
    fontWeight: hasErrors
      ? ("var(--cocoa-fw-medium)" as unknown as number)
      : ("var(--cocoa-fw-regular)" as unknown as number),
    margin: 0
  };
}

const footerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  marginTop: "var(--cocoa-space-1)",
  paddingTop: "var(--cocoa-space-2)",
  borderTop: "1px solid var(--cocoa-separator)"
};

const linkStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: 0,
  border: "none",
  background: "transparent",
  color: "var(--cocoa-accent)",
  fontFamily: "var(--cocoa-font)",
  fontSize: "var(--cocoa-fs-footnote)",
  fontWeight: "var(--cocoa-fw-medium)" as unknown as number,
  cursor: "pointer",
  WebkitAppearance: "none",
  appearance: "none"
};

function formatPending(count: number): string {
  return new Intl.NumberFormat("es-ES").format(count);
}

function buildSubtext(
  errorsCount: number | undefined,
  lastSubmission: string | undefined
): string {
  if (typeof errorsCount === "number" && errorsCount > 0) {
    return errorsCount === 1
      ? "1 error"
      : `${formatPending(errorsCount)} errores`;
  }
  if (lastSubmission && lastSubmission.trim().length > 0) {
    return `Ultimo envio: ${lastSubmission}`;
  }
  return "Sin envios hoy";
}

export function DirectorComplianceWidget({
  authority,
  pendingCount,
  status,
  lastSubmission,
  errorsCount,
  onDrillDown
}: DirectorComplianceWidgetProps) {
  const authorityLabel = AUTHORITY_LABEL[authority];
  const statusDotStyle = getStatusDotStyle(status);
  const hasErrors = typeof errorsCount === "number" && errorsCount > 0;
  const subtext = buildSubtext(errorsCount, lastSubmission);
  const subStyle = getSubStyle(status, hasErrors);

  const handleCardClick = onDrillDown ? () => onDrillDown() : undefined;

  const handleLinkClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onDrillDown?.();
  };

  return (
    <CocoaCard
      variant="bordered"
      padding="sm"
      onClick={handleCardClick}
      className="cocoa-font"
    >
      <div
        style={containerStyle}
        role="group"
        aria-label={`${authorityLabel} compliance, status ${status}, ${pendingCount} pendientes`}
      >
        <div style={headerRowStyle}>
          <span style={authorityBadgeStyle}>{authorityLabel}</span>
          <span
            style={statusDotStyle}
            role="img"
            aria-label={`Status: ${status}`}
          />
        </div>

        <div style={bodyRowStyle}>
          <span style={countStyle}>{formatPending(pendingCount)}</span>
          <span style={countLabelStyle}>pendientes</span>
        </div>

        <p style={subStyle}>{subtext}</p>

        {onDrillDown ? (
          <div style={footerStyle}>
            <button
              type="button"
              style={linkStyle}
              onClick={handleLinkClick}
            >
              Ver detalle <span aria-hidden="true">→</span>
            </button>
          </div>
        ) : null}
      </div>
    </CocoaCard>
  );
}

export default DirectorComplianceWidget;
