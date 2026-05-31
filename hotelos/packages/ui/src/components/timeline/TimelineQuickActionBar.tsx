import type { CSSProperties } from "react";

export type TimelineQuickAction =
  | "move"
  | "extend"
  | "split"
  | "cancel"
  | "block"
  | "release";

export type TimelineQuickActionDescriptor = {
  id: TimelineQuickAction;
  label: string;
  critical?: boolean;
  disabled?: boolean;
};

export const DEFAULT_QUICK_ACTIONS: TimelineQuickActionDescriptor[] = [
  { id: "move", label: "Move", critical: true },
  { id: "extend", label: "Extend", critical: true },
  { id: "split", label: "Split", critical: true },
  { id: "cancel", label: "Cancel", critical: true },
  { id: "block", label: "Block", critical: true },
  { id: "release", label: "Release", critical: true }
];

export type TimelineQuickActionBarProps = {
  actions?: TimelineQuickActionDescriptor[];
  onRequestAction: (action: TimelineQuickAction) => void;
  title?: string;
  selectionSummary?: string;
  style?: CSSProperties;
};

export function TimelineQuickActionBar(props: TimelineQuickActionBarProps) {
  const actions = props.actions ?? DEFAULT_QUICK_ACTIONS;
  return (
    <div
      role="toolbar"
      aria-label="Timeline quick actions"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
        background: "#0b1026",
        color: "#ffffff",
        borderRadius: 14,
        padding: "10px 14px",
        boxShadow: "0 18px 44px rgba(15,23,42,0.18)",
        ...props.style
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", marginRight: 8 }}>
        <small style={{ fontSize: 11, fontWeight: 900, color: "#c7d2fe", textTransform: "uppercase" }}>
          {props.title ?? "Quick actions"}
        </small>
        {props.selectionSummary ? (
          <strong style={{ fontSize: 13, fontWeight: 900 }}>{props.selectionSummary}</strong>
        ) : null}
      </div>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled={action.disabled}
          onClick={() => props.onRequestAction(action.id)}
          aria-label={`${action.label} reservation`}
          style={{
            minHeight: 36,
            padding: "0 14px",
            borderRadius: 999,
            border: `1px solid ${action.critical ? "#c2413a" : "#cdd5e2"}`,
            background: action.critical ? "rgba(194,65,58,0.18)" : "rgba(255,255,255,0.12)",
            color: "#ffffff",
            fontWeight: 900,
            cursor: action.disabled ? "not-allowed" : "pointer",
            opacity: action.disabled ? 0.5 : 1
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
