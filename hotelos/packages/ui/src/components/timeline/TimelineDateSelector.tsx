import type { CSSProperties } from "react";

export type TimelineGranularity = "day" | "week" | "month";

export type TimelineDateSelectorProps = {
  rangeLabel: string;
  granularity: TimelineGranularity;
  onGranularityChange?: (granularity: TimelineGranularity) => void;
  onPrev?: () => void;
  onNext?: () => void;
  onToday?: () => void;
  onPickRange?: () => void;
  style?: CSSProperties;
};

const GRANULARITIES: TimelineGranularity[] = ["day", "week", "month"];

export function TimelineDateSelector(props: TimelineDateSelectorProps) {
  const { rangeLabel, granularity, onGranularityChange, onPrev, onNext, onToday, onPickRange, style } = props;
  return (
    <div
      role="toolbar"
      aria-label="Timeline date selector"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
        background: "#ffffff",
        border: "1px solid #d9e0ea",
        borderRadius: 14,
        padding: "10px 12px",
        boxShadow: "0 6px 18px rgba(15,23,42,0.04)",
        ...style
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          onClick={onPrev}
          aria-label="Previous range"
          style={navButtonStyle}
        >
          {"<"}
        </button>
        <button type="button" onClick={onToday} style={pillButtonStyle}>
          Today
        </button>
        <button
          type="button"
          onClick={onNext}
          aria-label="Next range"
          style={navButtonStyle}
        >
          {">"}
        </button>
      </div>
      <button type="button" onClick={onPickRange} style={rangeButtonStyle} aria-label="Pick date range">
        {rangeLabel}
      </button>
      <div role="radiogroup" aria-label="Granularity" style={{ display: "flex", gap: 4 }}>
        {GRANULARITIES.map((g) => {
          const active = g === granularity;
          return (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onGranularityChange?.(g)}
              style={{
                ...pillButtonStyle,
                background: active ? "#1d2a73" : "#ffffff",
                color: active ? "#ffffff" : "#1d2a73",
                borderColor: active ? "#1d2a73" : "#cdd5e2"
              }}
            >
              {g[0].toUpperCase() + g.slice(1)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const navButtonStyle: CSSProperties = {
  minWidth: 36,
  minHeight: 36,
  borderRadius: 10,
  border: "1px solid #cdd5e2",
  background: "#ffffff",
  color: "#1d2a73",
  fontWeight: 900,
  cursor: "pointer"
};

const pillButtonStyle: CSSProperties = {
  minHeight: 36,
  borderRadius: 999,
  border: "1px solid #cdd5e2",
  background: "#ffffff",
  color: "#1d2a73",
  padding: "0 14px",
  fontWeight: 900,
  cursor: "pointer"
};

const rangeButtonStyle: CSSProperties = {
  ...pillButtonStyle,
  background: "#eef2f7",
  color: "#0b1026"
};
