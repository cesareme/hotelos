import { useEffect, useState, type CSSProperties } from "react";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { EmptyStateError } from "../../components/cocoa-illustrations";

export interface CocoaServerErrorScreenProps {
  error?: Error;
  onRetry?: () => void;
}

const AUTO_RETRY_MS = 5000;

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  paddingInline: "clamp(16px, 4vw, 32px)",
  paddingBlock: "clamp(24px, 5vw, 48px)",
  boxSizing: "border-box",
  fontFamily: "var(--cocoa-font)",
  background: "var(--cocoa-background)"
};

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  width: "100%",
  maxWidth: 480,
  gap: "var(--cocoa-space-4)"
};

const illustrationWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 240,
  height: 180,
  maxWidth: "100%",
  flexShrink: 0
};

const textBlockStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--cocoa-space-2)",
  width: "100%"
};

const titleStyle: CSSProperties = {
  color: "var(--cocoa-label)",
  fontSize: "var(--cocoa-fs-title-1)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1.2,
  margin: 0
};

const descriptionStyle: CSSProperties = {
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-subheadline)",
  fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1.4,
  margin: 0
};

const actionsRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--cocoa-space-2)",
  marginTop: "var(--cocoa-space-2)"
};

const footerLinkStyle: CSSProperties = {
  color: "var(--cocoa-label-tertiary)",
  fontSize: "var(--cocoa-fs-caption)",
  letterSpacing: "var(--cocoa-tracking-tight)",
  lineHeight: 1.4,
  margin: 0,
  textDecoration: "underline",
  cursor: "pointer",
  background: "none",
  border: "none",
  padding: 0,
  fontFamily: "inherit"
};

const detailsStyle: CSSProperties = {
  width: "100%",
  marginTop: "var(--cocoa-space-2)",
  textAlign: "left",
  color: "var(--cocoa-label-tertiary)",
  fontSize: "var(--cocoa-fs-caption)"
};

const summaryStyle: CSSProperties = {
  cursor: "pointer",
  color: "var(--cocoa-label-tertiary)",
  fontSize: "var(--cocoa-fs-caption)",
  letterSpacing: "var(--cocoa-tracking-tight)",
  userSelect: "none",
  outline: "none"
};

const preStyle: CSSProperties = {
  marginTop: "var(--cocoa-space-2)",
  padding: "var(--cocoa-space-2)",
  background: "var(--cocoa-background-control)",
  border: "1px solid var(--cocoa-separator)",
  borderRadius: "var(--cocoa-radius-sm)",
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-caption)",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 240,
  overflow: "auto"
};

function reload(): void {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

export function CocoaServerErrorScreen({
  error,
  onRetry
}: CocoaServerErrorScreenProps) {
  const [supportHover, setSupportHover] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      reload();
    }, AUTO_RETRY_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  const handleRetry = () => {
    if (onRetry) {
      onRetry();
      return;
    }
    reload();
  };

  const technicalMessage = error
    ? `${error.name ?? "Error"}: ${error.message ?? ""}${
        error.stack ? `\n\n${error.stack}` : ""
      }`
    : null;

  return (
    <div style={pageStyle} role="alert" aria-live="assertive">
      <div style={containerStyle}>
        <div aria-hidden="true" style={illustrationWrapStyle}>
          <EmptyStateError size={240} tone="warning" />
        </div>

        <div style={textBlockStyle}>
          <h1 style={titleStyle}>Error del servidor</h1>
          <p style={descriptionStyle}>
            Algo fallo al procesar la peticion. Reintentamos automaticamente en
            5 segundos.
          </p>
        </div>

        <div style={actionsRowStyle}>
          <CocoaButton
            variant="filled"
            tone="accent"
            onClick={handleRetry}
          >
            Reintentar ahora
          </CocoaButton>
        </div>

        <button
          type="button"
          style={{
            ...footerLinkStyle,
            color: supportHover
              ? "var(--cocoa-label-secondary)"
              : "var(--cocoa-label-tertiary)"
          }}
          onMouseEnter={() => setSupportHover(true)}
          onMouseLeave={() => setSupportHover(false)}
          onClick={() => {
            if (typeof window !== "undefined") {
              window.location.href = "mailto:soporte@hotelos.app";
            }
          }}
        >
          Si el problema persiste, contacta soporte tecnico
        </button>

        {technicalMessage ? (
          <details style={detailsStyle}>
            <summary style={summaryStyle}>Detalles tecnicos</summary>
            <pre style={preStyle}>{technicalMessage}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

export default CocoaServerErrorScreen;
