import type { CSSProperties, ReactNode } from "react";
import { CocoaButton } from "../cocoa/CocoaButton";

export interface CocoaQuickAction {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  onClick: () => void;
}

export interface CocoaQuickActionsBarProps {
  actions: CocoaQuickAction[];
}

const barStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 1,
  display: "flex",
  alignItems: "center",
  gap: 4,
  height: 36,
  minHeight: 36,
  padding: "0 12px",
  background: "var(--cocoa-background-toolbar)",
  borderBottom: "1px solid var(--cocoa-separator)",
  backdropFilter: "var(--cocoa-material-toolbar-blur)",
  WebkitBackdropFilter: "var(--cocoa-material-toolbar-blur)",
  boxSizing: "border-box",
  overflowX: "auto"
};

const shortcutStyle: CSSProperties = {
  marginLeft: 6,
  opacity: 0.55,
  fontSize: "var(--cocoa-fs-caption-1)",
  letterSpacing: "var(--cocoa-tracking-tight)"
};

export function CocoaQuickActionsBar({ actions }: CocoaQuickActionsBarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Quick actions"
      style={barStyle}
    >
      {actions.map((action) => (
        <CocoaButton
          key={action.id}
          variant="plain"
          size="small"
          tone="neutral"
          icon={action.icon}
          onClick={action.onClick}
          aria-label={action.label}
        >
          <span style={{ display: "inline-flex", alignItems: "center" }}>
            {action.label}
            {action.shortcut ? (
              <span style={shortcutStyle}>{action.shortcut}</span>
            ) : null}
          </span>
        </CocoaButton>
      ))}
    </div>
  );
}

export default CocoaQuickActionsBar;
