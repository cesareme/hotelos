import type { CSSProperties } from "react";

export type TimelineStatus =
  | "clean"
  | "dirty"
  | "inspected"
  | "out_of_order"
  | "out_of_service"
  | "occupied"
  | "vacant";

const STATUS_COLORS: Record<TimelineStatus, string> = {
  clean: "#0f9f6e",
  dirty: "#b7791f",
  inspected: "#2563eb",
  out_of_order: "#c2413a",
  out_of_service: "#7c3aed",
  occupied: "#1d2a73",
  vacant: "#94a3b8"
};

export type TimelineStatusDotProps = {
  status: TimelineStatus;
  size?: number;
  label?: string;
  style?: CSSProperties;
};

export function TimelineStatusDot(props: TimelineStatusDotProps) {
  const { status, size = 10, label, style } = props;
  const color = STATUS_COLORS[status];
  return (
    <span
      role="img"
      aria-label={label ?? status.replace(/_/g, " ")}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        boxShadow: "0 0 0 2px rgba(255,255,255,0.85)",
        ...style
      }}
    />
  );
}
