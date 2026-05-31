import { useState, type CSSProperties } from "react";

export interface CocoaDatePickerProps {
  value: string;
  onChange: (v: string) => void;
  min?: string;
  max?: string;
  size?: "small" | "regular" | "large";
}

const SIZE_METRICS: Record<
  NonNullable<CocoaDatePickerProps["size"]>,
  { height: number; padX: number; fontSize: string; lineHeight: string }
> = {
  small: {
    height: 22,
    padX: 8,
    fontSize: "var(--cocoa-fs-subheadline)",
    lineHeight: "var(--cocoa-lh-subheadline)"
  },
  regular: {
    height: 28,
    padX: 10,
    fontSize: "var(--cocoa-fs-body)",
    lineHeight: "var(--cocoa-lh-body)"
  },
  large: {
    height: 34,
    padX: 12,
    fontSize: "var(--cocoa-fs-title-3)",
    lineHeight: "var(--cocoa-lh-title-3)"
  }
};

export function CocoaDatePicker({
  value,
  onChange,
  min,
  max,
  size = "regular"
}: CocoaDatePickerProps) {
  const [focused, setFocused] = useState(false);
  const metrics = SIZE_METRICS[size];

  const inputStyle: CSSProperties = {
    height: metrics.height,
    padding: `0 ${metrics.padX}px`,
    fontSize: metrics.fontSize,
    lineHeight: metrics.lineHeight,
    fontFamily: "var(--cocoa-font)",
    fontFeatureSettings: '"tnum" 1, "lnum" 1',
    color: "var(--cocoa-label)",
    background: "var(--cocoa-background-control)",
    border: "1px solid var(--cocoa-separator-opaque)",
    borderRadius: "var(--cocoa-radius-sm)",
    outline: "none",
    boxShadow: focused
      ? "0 0 0 3px var(--cocoa-focus-ring)"
      : "var(--cocoa-shadow-control)",
    borderColor: focused
      ? "var(--cocoa-accent)"
      : "var(--cocoa-separator-opaque)",
    transition:
      "border-color var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-fast) var(--cocoa-ease-out)",
    appearance: "none",
    WebkitAppearance: "none",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0
  };

  return (
    <input
      type="date"
      value={value}
      min={min}
      max={max}
      onChange={(event) => onChange(event.currentTarget.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={inputStyle}
    />
  );
}

export default CocoaDatePicker;
