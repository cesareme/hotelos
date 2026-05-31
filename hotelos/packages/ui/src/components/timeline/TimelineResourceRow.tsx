import type { CSSProperties, ReactNode } from "react";
import { TimelineStatusDot, type TimelineStatus } from "./TimelineStatusDot.js";

export type TimelineResource = {
  id: string;
  name: string;
  resourceType: string;
  status: TimelineStatus;
  capacity?: string;
  subLabel?: string;
};

export type TimelineResourceRowProps = {
  resource: TimelineResource;
  days: number;
  cellWidth?: number;
  height?: number;
  onSelect?: (resourceId: string) => void;
  children?: ReactNode;
  style?: CSSProperties;
};

export function TimelineResourceRow(props: TimelineResourceRowProps) {
  const { resource, days, cellWidth = 96, height = 64, onSelect, children, style } = props;
  return (
    <div
      role="row"
      style={{
        display: "grid",
        gridTemplateColumns: `220px repeat(${days}, ${cellWidth}px)`,
        borderBottom: "1px solid #e9edf3",
        minHeight: height,
        background: "#ffffff",
        ...style
      }}
    >
      <button
        type="button"
        onClick={() => onSelect?.(resource.id)}
        aria-label={`Open ${resource.name} details`}
        style={{
          all: "unset",
          cursor: onSelect ? "pointer" : "default",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "8px 12px",
          gap: 4,
          borderRight: "1px solid #e9edf3",
          background: "#f6f4ef",
          minWidth: 0
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <TimelineStatusDot status={resource.status} />
          <strong style={{ fontSize: 14, fontWeight: 900, color: "#111827" }}>{resource.name}</strong>
        </span>
        <small style={{ fontSize: 11, fontWeight: 800, color: "#667085", textTransform: "uppercase" }}>
          {resource.resourceType}
          {resource.capacity ? ` · ${resource.capacity}` : ""}
        </small>
        {resource.subLabel ? <small style={{ fontSize: 11, color: "#667085" }}>{resource.subLabel}</small> : null}
      </button>
      <div
        style={{
          gridColumn: `2 / span ${days}`,
          position: "relative",
          background:
            "repeating-linear-gradient(90deg, rgba(15,23,42,0.04) 0 1px, transparent 1px " + cellWidth + "px)"
        }}
      >
        {children}
      </div>
    </div>
  );
}
