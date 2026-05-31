import type { CSSProperties } from "react";
import { TimelineDragHandle } from "./TimelineDragHandle.js";

export type ReservationBlockStatus =
  | "confirmed"
  | "checked_in"
  | "checked_out"
  | "cancelled"
  | "tentative"
  | "no_show";

export type ReservationBlockKind =
  | "reservation"
  | "group_block"
  | "out_of_order"
  | "out_of_service"
  | "house_use"
  | "day_use"
  | "maintenance_block"
  | "event"
  | "parking_booking"
  | "meeting_room_booking";

const STATUS_TONES: Record<ReservationBlockStatus, { bg: string; border: string; ink: string }> = {
  confirmed: { bg: "#1d2a73", border: "#0b1026", ink: "#ffffff" },
  checked_in: { bg: "#0f9f6e", border: "#0a7e57", ink: "#ffffff" },
  checked_out: { bg: "#94a3b8", border: "#64748b", ink: "#0b1026" },
  cancelled: { bg: "#fde2e2", border: "#c2413a", ink: "#7f1d1d" },
  tentative: { bg: "#fff7e6", border: "#b7791f", ink: "#7a4b08" },
  no_show: { bg: "#1f2937", border: "#0b1026", ink: "#ffffff" }
};

const KIND_TONES: Partial<Record<ReservationBlockKind, { bg: string; border: string; ink: string }>> = {
  group_block: { bg: "#7c3aed", border: "#5b21b6", ink: "#ffffff" },
  out_of_order: { bg: "#c2413a", border: "#7f1d1d", ink: "#ffffff" },
  out_of_service: { bg: "#fde2e2", border: "#c2413a", ink: "#7f1d1d" },
  house_use: { bg: "#0ea5e9", border: "#0369a1", ink: "#ffffff" },
  day_use: { bg: "#facc15", border: "#a16207", ink: "#1f2937" },
  maintenance_block: { bg: "#475569", border: "#0b1026", ink: "#ffffff" },
  event: { bg: "#ec4899", border: "#9d174d", ink: "#ffffff" },
  parking_booking: { bg: "#0b1026", border: "#0b1026", ink: "#ffffff" },
  meeting_room_booking: { bg: "#2563eb", border: "#1e3a8a", ink: "#ffffff" }
};

export type TimelineReservationBlockProps = {
  reservationId: string;
  guestName: string;
  status: ReservationBlockStatus;
  kind?: ReservationBlockKind;
  balance?: string;
  journeyState?: string;
  color?: string;
  startOffsetDays: number;
  spanDays: number;
  cellWidth?: number;
  top?: number;
  height?: number;
  onClick?: (reservationId: string) => void;
  onResizeStart?: (reservationId: string) => void;
  onResizeEnd?: (reservationId: string) => void;
  style?: CSSProperties;
};

export function TimelineReservationBlock(props: TimelineReservationBlockProps) {
  const {
    reservationId,
    guestName,
    status,
    kind = "reservation",
    balance,
    journeyState,
    color,
    startOffsetDays,
    spanDays,
    cellWidth = 96,
    top = 6,
    height = 52,
    onClick,
    onResizeStart,
    onResizeEnd,
    style
  } = props;

  const tone = KIND_TONES[kind] ?? STATUS_TONES[status];
  const bg = color ?? tone.bg;

  return (
    <button
      type="button"
      onClick={() => onClick?.(reservationId)}
      aria-label={`Reservation ${reservationId} for ${guestName}, status ${status}`}
      style={{
        position: "absolute",
        left: startOffsetDays * cellWidth + 4,
        width: spanDays * cellWidth - 8,
        top,
        height,
        background: bg,
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
        {guestName}
      </strong>
      <small style={{ fontSize: 11, fontWeight: 800, opacity: 0.9, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {status.replace(/_/g, " ")}
        {journeyState ? ` · ${journeyState}` : ""}
        {balance ? ` · ${balance}` : ""}
      </small>
      <TimelineDragHandle side="left" onActivate={() => onResizeStart?.(reservationId)} />
      <TimelineDragHandle side="right" onActivate={() => onResizeEnd?.(reservationId)} />
    </button>
  );
}
