import type { CSSProperties } from "react";

export type TimelineDragHandleProps = {
  side: "left" | "right";
  ariaLabel?: string;
  onActivate?: () => void;
  style?: CSSProperties;
};

export function TimelineDragHandle(props: TimelineDragHandleProps) {
  const { side, ariaLabel, onActivate, style } = props;
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={ariaLabel ?? (side === "left" ? "Resize start" : "Resize end")}
      onClick={(event) => {
        event.stopPropagation();
        onActivate?.();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          onActivate?.();
        }
      }}
      style={{
        position: "absolute",
        top: 4,
        bottom: 4,
        width: 8,
        cursor: "ew-resize",
        background: "rgba(255,255,255,0.55)",
        borderRadius: 4,
        [side]: 2,
        boxShadow: "inset 0 0 0 1px rgba(15,23,42,0.18)",
        ...style
      }}
    />
  );
}
