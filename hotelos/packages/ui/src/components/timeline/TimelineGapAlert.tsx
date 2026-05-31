import type { CSSProperties } from "react";

export type TimelineGapAlertProps = {
  gapId: string;
  label?: string;
  detail?: string;
  startOffsetDays: number;
  spanDays: number;
  cellWidth?: number;
  top?: number;
  height?: number;
  onClick?: (gapId: string) => void;
  style?: CSSProperties;
};

export function TimelineGapAlert(props: TimelineGapAlertProps) {
  const {
    gapId,
    label = "Short gap",
    detail,
    startOffsetDays,
    spanDays,
    cellWidth = 96,
    top = 6,
    height = 52,
    onClick,
    style
  } = props;
  return (
    <button
      type="button"
      onClick={() => onClick?.(gapId)}
      aria-label={`Optimization opportunity ${label}${detail ? ` · ${detail}` : ""}`}
      style={{
        position: "absolute",
        left: startOffsetDays * cellWidth + 4,
        width: spanDays * cellWidth - 8,
        top,
        height,
        background:
          "repeating-linear-gradient(45deg, rgba(37,99,235,0.18) 0 6px, rgba(37,99,235,0.04) 6px 12px)",
        border: "1px dashed #2563eb",
        color: "#1d2a73",
        borderRadius: 10,
        padding: "6px 10px",
        textAlign: "left",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 2,
        minWidth: 0,
        overflow: "hidden",
        ...style
      }}
    >
      <strong style={{ fontSize: 12, fontWeight: 900, textTransform: "uppercase", letterSpacing: 0 }}>{label}</strong>
      {detail ? <small style={{ fontSize: 11, fontWeight: 700, color: "#1d2a73" }}>{detail}</small> : null}
    </button>
  );
}
