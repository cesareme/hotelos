import type { CSSProperties } from "react";

export type TimelineOverbookingAlertProps = {
  count: number;
  channel?: string;
  detail?: string;
  onClick?: () => void;
  style?: CSSProperties;
};

export function TimelineOverbookingAlert(props: TimelineOverbookingAlertProps) {
  const { count, channel, detail, onClick, style } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Overbooking alert: ${count} reservations exceed inventory`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        background: "#c2413a",
        color: "#ffffff",
        border: "1px solid #7f1d1d",
        borderRadius: 999,
        padding: "6px 12px",
        cursor: onClick ? "pointer" : "default",
        boxShadow: "0 6px 14px rgba(194,65,58,0.32)",
        fontWeight: 900,
        ...style
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: "rgba(255,255,255,0.18)",
          fontSize: 12,
          fontWeight: 900
        }}
      >
        {count}
      </span>
      <span style={{ fontSize: 12, letterSpacing: 0 }}>
        Overbooking{channel ? ` · ${channel}` : ""}
        {detail ? ` · ${detail}` : ""}
      </span>
    </button>
  );
}
