import type { CSSProperties, ReactNode } from "react";

export interface CocoaStatusBarProps {
  leftSlot?: ReactNode;
  rightSlot?: ReactNode;
  centerSlot?: ReactNode;
}

function DefaultLeftSlot() {
  const wrapperStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6
  };

  const dotStyle: CSSProperties = {
    display: "inline-block",
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "#28c840",
    boxShadow: "0 0 4px rgb(40 200 64 / 0.6)",
    flexShrink: 0
  };

  return (
    <span style={wrapperStyle} aria-label="Estado de conexion">
      <span aria-hidden="true" style={dotStyle} />
      <span>Conectado</span>
    </span>
  );
}

function DefaultRightSlot() {
  return <span>12 reservas hoy &middot; 8 in-house &middot; 3 salidas</span>;
}

export function CocoaStatusBar({
  leftSlot,
  rightSlot,
  centerSlot
}: CocoaStatusBarProps) {
  const containerStyle: CSSProperties = {
    position: "fixed",
    bottom: 0,
    left: 0,
    width: "100%",
    height: 24,
    minHeight: 24,
    zIndex: 100,
    display: "flex",
    alignItems: "center",
    padding: "0 12px",
    background: "var(--cocoa-background-toolbar)",
    backdropFilter: "var(--cocoa-material-toolbar-blur)",
    WebkitBackdropFilter: "var(--cocoa-material-toolbar-blur)",
    borderTop: "1px solid var(--cocoa-separator)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-caption)",
    color: "var(--cocoa-label-secondary)",
    boxSizing: "border-box"
  };

  const leftStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
    justifyContent: "flex-start",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  };

  const centerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
    textAlign: "center",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  };

  const rightStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flex: 1,
    minWidth: 0,
    justifyContent: "flex-end",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap"
  };

  return (
    <div role="status" aria-live="polite" style={containerStyle}>
      <div style={leftStyle}>{leftSlot ?? <DefaultLeftSlot />}</div>
      <div style={centerStyle}>{centerSlot}</div>
      <div style={rightStyle}>{rightSlot ?? <DefaultRightSlot />}</div>
    </div>
  );
}

export default CocoaStatusBar;
