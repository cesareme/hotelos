import type { CSSProperties, ReactNode } from "react";
import { CocoaButton } from "../cocoa/CocoaButton";

export interface CocoaEmptyStateAction {
  label: string;
  onClick: () => void;
}

export interface CocoaEmptyStateProps {
  illustration?: ReactNode;
  title: string;
  description?: string;
  primaryAction?: CocoaEmptyStateAction;
  secondaryAction?: CocoaEmptyStateAction;
  className?: string;
  style?: CSSProperties;
}

const containerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  textAlign: "center",
  width: "100%",
  minHeight: 320,
  paddingInline: "clamp(16px, 4vw, 32px)",
  paddingBlock: "clamp(24px, 5vw, 40px)",
  boxSizing: "border-box",
  fontFamily: "var(--cocoa-font)"
};

const illustrationStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 200,
  height: 150,
  maxWidth: "100%",
  flexShrink: 0,
  marginBottom: "var(--cocoa-space-4)",
  color: "var(--cocoa-label-tertiary)"
};

const textBlockStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--cocoa-space-2)",
  maxWidth: 480
};

const titleStyle: CSSProperties = {
  color: "var(--cocoa-label)",
  fontSize: "var(--cocoa-fs-title-2)",
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
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--cocoa-space-2)",
  marginTop: "var(--cocoa-space-4)"
};

export function CocoaEmptyState({
  illustration,
  title,
  description,
  primaryAction,
  secondaryAction,
  className,
  style
}: CocoaEmptyStateProps) {
  const mergedContainerStyle: CSSProperties = style
    ? { ...containerStyle, ...style }
    : containerStyle;

  const hasActions = Boolean(primaryAction || secondaryAction);

  return (
    <div className={className} style={mergedContainerStyle} role="status">
      {illustration ? (
        <div aria-hidden="true" style={illustrationStyle}>
          {illustration}
        </div>
      ) : null}
      <div style={textBlockStyle}>
        <h2 style={titleStyle}>{title}</h2>
        {description ? <p style={descriptionStyle}>{description}</p> : null}
      </div>
      {hasActions ? (
        <div style={actionsRowStyle}>
          {primaryAction ? (
            <CocoaButton
              variant="filled"
              tone="accent"
              onClick={primaryAction.onClick}
            >
              {primaryAction.label}
            </CocoaButton>
          ) : null}
          {secondaryAction ? (
            <CocoaButton
              variant="bordered"
              tone="neutral"
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </CocoaButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default CocoaEmptyState;
