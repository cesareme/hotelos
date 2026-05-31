import type { CSSProperties } from "react";

export type TimelineHeaderDay = {
  key: string;
  label: string;
  sublabel?: string;
  isToday?: boolean;
  isWeekend?: boolean;
};

export type TimelineHeaderProps = {
  leadingLabel?: string;
  days: TimelineHeaderDay[];
  cellWidth?: number;
  style?: CSSProperties;
};

export function TimelineHeader(props: TimelineHeaderProps) {
  const { days, leadingLabel = "Resource", cellWidth = 96, style } = props;
  return (
    <div
      role="row"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 2,
        display: "grid",
        gridTemplateColumns: `220px repeat(${days.length}, ${cellWidth}px)`,
        background: "#0b1026",
        color: "#ffffff",
        borderBottom: "1px solid #1d2a73",
        ...style
      }}
    >
      <div
        role="columnheader"
        style={{
          padding: "10px 12px",
          fontWeight: 900,
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: 0,
          borderRight: "1px solid #1d2a73",
          background: "#0b1026"
        }}
      >
        {leadingLabel}
      </div>
      {days.map((day) => (
        <div
          role="columnheader"
          key={day.key}
          style={{
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 2,
            borderRight: "1px solid #1d2a73",
            background: day.isToday ? "#2563eb" : day.isWeekend ? "#131b3c" : "#0b1026",
            color: "#ffffff"
          }}
        >
          <strong style={{ fontSize: 13, fontWeight: 900 }}>{day.label}</strong>
          {day.sublabel ? <small style={{ fontSize: 11, color: "#c7d2fe" }}>{day.sublabel}</small> : null}
        </div>
      ))}
    </div>
  );
}
