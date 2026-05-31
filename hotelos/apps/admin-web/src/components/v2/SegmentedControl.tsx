import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

export interface SegmentOption {
  value: string;
  label: string;
  icon?: string;
  badge?: number | string;
}

export interface SegmentedControlProps {
  value: string;
  options: SegmentOption[];
  onChange: (value: string) => void;
  size?: "sm" | "md";
  fullWidth?: boolean;
  ariaLabel?: string;
}

const SIZE_PADDING: Record<NonNullable<SegmentedControlProps["size"]>, string> = {
  sm: "4px 10px",
  md: "6px 14px"
};

const SIZE_FS: Record<NonNullable<SegmentedControlProps["size"]>, string> = {
  sm: "var(--fs-xs, 11px)",
  md: "var(--fs-sm, 12px)"
};

interface ThumbPosition {
  left: number;
  width: number;
}

export function SegmentedControl({
  value,
  options,
  onChange,
  size = "md",
  fullWidth = false,
  ariaLabel = "Segmentos"
}: SegmentedControlProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [thumb, setThumb] = useState<ThumbPosition | null>(null);

  const recompute = () => {
    const trackEl = trackRef.current;
    const activeEl = buttonRefs.current[value];
    if (!trackEl || !activeEl) {
      setThumb(null);
      return;
    }
    const trackRect = trackEl.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    setThumb({
      left: activeRect.left - trackRect.left,
      width: activeRect.width
    });
  };

  useLayoutEffect(() => {
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, options.length, size, fullWidth]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !trackRef.current) return;
    const obs = new ResizeObserver(() => recompute());
    obs.observe(trackRef.current);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trackStyle: CSSProperties = {
    position: "relative",
    display: "inline-flex",
    gap: 2,
    padding: 3,
    background: "var(--surface-sunken, #f1efe9)",
    borderRadius: "var(--radius-md, 12px)",
    border: "1px solid var(--line-soft, #f1ede5)",
    width: fullWidth ? "100%" : "auto"
  };

  const thumbStyle: CSSProperties = {
    position: "absolute",
    top: 3,
    bottom: 3,
    left: 0,
    width: thumb?.width ?? 0,
    transform: `translateX(${thumb?.left ?? 0}px)`,
    background: "var(--surface, #ffffff)",
    borderRadius: "calc(var(--radius-md, 12px) - 4px)",
    boxShadow: "var(--shadow-xs, 0 1px 2px rgba(26,26,26,0.04))",
    transition: "transform var(--duration, 180ms) var(--ease), width var(--duration, 180ms) var(--ease)",
    pointerEvents: "none",
    opacity: thumb ? 1 : 0
  };

  return (
    <div
      ref={trackRef}
      role="tablist"
      aria-label={ariaLabel}
      style={trackStyle}
    >
      <div aria-hidden="true" style={thumbStyle} />
      {options.map((opt) => {
        const isActive = opt.value === value;
        const btnStyle: CSSProperties = {
          position: "relative",
          zIndex: 1,
          background: "transparent",
          border: "none",
          padding: SIZE_PADDING[size],
          borderRadius: "calc(var(--radius-md, 12px) - 4px)",
          fontSize: SIZE_FS[size],
          fontWeight: isActive ? 600 : 500,
          color: isActive ? "var(--ink, #1a1a1a)" : "var(--ink-muted, #6a6a6a)",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontFamily: "inherit",
          flex: fullWidth ? 1 : "0 0 auto",
          justifyContent: "center",
          transition: "color var(--duration, 180ms) var(--ease)",
          whiteSpace: "nowrap"
        };
        return (
          <button
            key={opt.value}
            ref={(el) => {
              buttonRefs.current[opt.value] = el;
            }}
            role="tab"
            aria-selected={isActive}
            type="button"
            style={btnStyle}
            onClick={() => onChange(opt.value)}
          >
            {opt.icon ? <span aria-hidden="true">{opt.icon}</span> : null}
            <span>{opt.label}</span>
            {opt.badge !== undefined ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  minWidth: 18,
                  height: 18,
                  padding: "0 6px",
                  fontSize: "var(--fs-xs, 11px)",
                  fontWeight: 600,
                  background: isActive
                    ? "var(--accent-soft, #e6f4ef)"
                    : "var(--neutral-bg, #f0eee8)",
                  color: isActive
                    ? "var(--accent-strong, #086b48)"
                    : "var(--ink-muted, #6a6a6a)",
                  borderRadius: "var(--radius-full, 999px)"
                }}
              >
                {opt.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
