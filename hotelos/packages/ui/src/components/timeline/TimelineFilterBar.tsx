import type { CSSProperties } from "react";

export type TimelineFilterOption = {
  id: string;
  label: string;
  count?: number;
};

export type TimelineFilterGroup = {
  id: string;
  label: string;
  options: TimelineFilterOption[];
  selectedIds: string[];
};

export type TimelineFilterBarProps = {
  groups: TimelineFilterGroup[];
  onToggle?: (groupId: string, optionId: string) => void;
  onClear?: () => void;
  style?: CSSProperties;
};

export function TimelineFilterBar(props: TimelineFilterBarProps) {
  const { groups, onToggle, onClear, style } = props;
  return (
    <div
      role="toolbar"
      aria-label="Timeline filters"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-start",
        gap: 14,
        background: "#ffffff",
        border: "1px solid #d9e0ea",
        borderRadius: 14,
        padding: "10px 12px",
        boxShadow: "0 6px 18px rgba(15,23,42,0.04)",
        ...style
      }}
    >
      {groups.map((group) => (
        <div key={group.id} style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <small style={{ fontSize: 11, fontWeight: 900, textTransform: "uppercase", color: "#667085" }}>
            {group.label}
          </small>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {group.options.map((option) => {
              const active = group.selectedIds.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onToggle?.(group.id, option.id)}
                  style={{
                    minHeight: 30,
                    borderRadius: 999,
                    border: `1px solid ${active ? "#1d2a73" : "#cdd5e2"}`,
                    background: active ? "#1d2a73" : "#f8fafc",
                    color: active ? "#ffffff" : "#1d2a73",
                    padding: "4px 10px",
                    fontWeight: 900,
                    cursor: "pointer",
                    fontSize: 12
                  }}
                >
                  {option.label}
                  {typeof option.count === "number" ? ` · ${option.count}` : ""}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {onClear ? (
        <button
          type="button"
          onClick={onClear}
          style={{
            marginLeft: "auto",
            alignSelf: "center",
            background: "transparent",
            border: 0,
            color: "#c2413a",
            fontWeight: 900,
            cursor: "pointer"
          }}
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
