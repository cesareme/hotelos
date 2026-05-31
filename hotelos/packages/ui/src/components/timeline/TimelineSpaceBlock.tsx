import type { CSSProperties } from "react";

export type SpaceBlockKind = "parking" | "meeting_room" | "spa" | "restaurant" | "coworking" | "event_space";

const KIND_TONES: Record<SpaceBlockKind, { bg: string; border: string; ink: string }> = {
  parking: { bg: "#0b1026", border: "#0b1026", ink: "#ffffff" },
  meeting_room: { bg: "#2563eb", border: "#1e3a8a", ink: "#ffffff" },
  spa: { bg: "#a78bfa", border: "#6d28d9", ink: "#ffffff" },
  restaurant: { bg: "#f97316", border: "#9a3412", ink: "#ffffff" },
  coworking: { bg: "#14b8a6", border: "#115e59", ink: "#ffffff" },
  event_space: { bg: "#ec4899", border: "#9d174d", ink: "#ffffff" }
};

export type TimelineSpaceBlockProps = {
  bookingId: string;
  title: string;
  detail?: string;
  kind: SpaceBlockKind;
  startOffsetDays: number;
  spanDays: number;
  cellWidth?: number;
  top?: number;
  height?: number;
  onClick?: (bookingId: string) => void;
  style?: CSSProperties;
};

export function TimelineSpaceBlock(props: TimelineSpaceBlockProps) {
  const { bookingId, title, detail, kind, startOffsetDays, spanDays, cellWidth = 96, top = 6, height = 52, onClick, style } = props;
  const tone = KIND_TONES[kind];
  return (
    <button
      type="button"
      onClick={() => onClick?.(bookingId)}
      aria-label={`${kind.replace(/_/g, " ")} booking ${title}`}
      style={{
        position: "absolute",
        left: startOffsetDays * cellWidth + 4,
        width: spanDays * cellWidth - 8,
        top,
        height,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        color: tone.ink,
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
        boxShadow: "0 6px 14px rgba(15,23,42,0.18)",
        ...style
      }}
    >
      <strong style={{ fontSize: 13, fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {title}
      </strong>
      {detail ? (
        <small style={{ fontSize: 11, fontWeight: 800, opacity: 0.9, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {detail}
        </small>
      ) : null}
    </button>
  );
}
