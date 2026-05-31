import type { CSSProperties, ReactNode } from "react";

export type TimelineGridProps = {
  children: ReactNode;
  style?: CSSProperties;
};

export function TimelineGrid(props: TimelineGridProps) {
  return (
    <div
      role="grid"
      aria-label="Timeline grid"
      style={{
        border: "1px solid #d9e0ea",
        borderRadius: 18,
        overflow: "auto",
        background: "#ffffff",
        boxShadow: "0 18px 44px rgba(15, 23, 42, 0.06)",
        maxHeight: 640,
        ...props.style
      }}
    >
      {props.children}
    </div>
  );
}
