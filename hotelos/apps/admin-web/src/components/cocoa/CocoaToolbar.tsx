import type { CSSProperties, ReactNode } from "react";

export interface CocoaToolbarProps {
  title?: string;
  subtitle?: string;
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
  showTrafficLights?: boolean;
}

const TRAFFIC_LIGHT_COLORS = ["#ff5f57", "#febc2e", "#28c840"] as const;

function TrafficLights() {
  return (
    <div
      aria-hidden="true"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexShrink: 0
      }}
    >
      {TRAFFIC_LIGHT_COLORS.map((color) => (
        <span
          key={color}
          style={{
            display: "inline-block",
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: color
          }}
        />
      ))}
    </div>
  );
}

export function CocoaToolbar({
  title,
  subtitle,
  leftSlot,
  rightSlot,
  showTrafficLights = false
}: CocoaToolbarProps) {
  const containerStyle: CSSProperties = {
    position: "sticky",
    top: 0,
    zIndex: 10,
    height: 48,
    minHeight: 48,
    padding: "0 16px",
    display: "flex",
    alignItems: "center",
    background: "var(--cocoa-background-toolbar)",
    backdropFilter: "var(--cocoa-material-toolbar-blur)",
    WebkitBackdropFilter: "var(--cocoa-material-toolbar-blur)",
    borderBottom: "1px solid var(--cocoa-separator)",
    fontFamily: "var(--cocoa-font)",
    boxSizing: "border-box"
  };

  const leftStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flex: 1,
    minWidth: 0,
    justifyContent: "flex-start"
  };

  const centerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    minWidth: 0,
    textAlign: "center"
  };

  const rightStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
    justifyContent: "flex-end"
  };

  const titleStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-headline)",
    fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
    color: "var(--cocoa-label)",
    letterSpacing: "var(--cocoa-tracking-tight)",
    lineHeight: 1.2,
    margin: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "100%"
  };

  const subtitleStyle: CSSProperties = {
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: "var(--cocoa-fw-regular)" as unknown as number,
    color: "var(--cocoa-label-secondary)",
    lineHeight: 1.2,
    margin: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: "100%"
  };

  return (
    <div role="toolbar" style={containerStyle}>
      <div style={leftStyle}>
        {showTrafficLights ? <TrafficLights /> : null}
        {leftSlot}
      </div>
      <div style={centerStyle}>
        {title ? <span style={titleStyle}>{title}</span> : null}
        {subtitle ? <span style={subtitleStyle}>{subtitle}</span> : null}
      </div>
      <div style={rightStyle}>{rightSlot}</div>
    </div>
  );
}

export default CocoaToolbar;
