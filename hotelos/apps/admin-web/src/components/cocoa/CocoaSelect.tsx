// CocoaSelect — Cocoa-styled native <select> with custom chevron.
//
// Wraps a native <select> so users get the platform's native menu UX
// (keyboard nav, type-ahead, accessibility) but with macOS Cocoa visuals
// matching the rest of the design system. Uses CSS custom properties from
// styles/cocoa-tokens.css so it stays consistent in light/dark mode.
//
// Focus ring intentionally mirrors CocoaInput (3px halo using
// --cocoa-focus-ring) so form rows align visually when mixing inputs and
// selects.

import { useState, type CSSProperties } from "react";
import { useCoarsePointer, TAP_TARGET_PX } from "../../lib/useCoarsePointer";

export interface CocoaSelectOption {
  value: string;
  label: string;
}

export interface CocoaSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<CocoaSelectOption>;
  placeholder?: string;
  size?: "small" | "regular" | "large";
  disabled?: boolean;
}

// Per-size metrics tuned to match CocoaInput proportions.
const SIZE_METRICS: Record<
  NonNullable<CocoaSelectProps["size"]>,
  { fontSize: string; lineHeight: string; padY: number; padL: number; height: number }
> = {
  small: {
    fontSize: "var(--cocoa-fs-subheadline)",
    lineHeight: "var(--cocoa-lh-subheadline)",
    padY: 4,
    padL: 8,
    height: 22,
  },
  regular: {
    fontSize: "var(--cocoa-fs-body)",
    lineHeight: "var(--cocoa-lh-body)",
    padY: 6,
    padL: 10,
    height: 28,
  },
  large: {
    fontSize: "var(--cocoa-fs-title-3)",
    lineHeight: "var(--cocoa-lh-title-3)",
    padY: 8,
    padL: 12,
    height: 34,
  },
};

export function CocoaSelect({
  value,
  onChange,
  options,
  placeholder,
  size = "regular",
  disabled = false,
}: CocoaSelectProps) {
  const [focused, setFocused] = useState(false);
  const coarse = useCoarsePointer();
  const metrics = SIZE_METRICS[size];

  const wrapperStyle: CSSProperties = {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    width: "100%",
  };

  const selectStyle: CSSProperties = {
    width: "100%",
    // Touch: a real 44px control (desktop keeps the dense 22–34px height).
    height: coarse ? TAP_TARGET_PX : metrics.height,
    padding: `${metrics.padY}px 28px ${metrics.padY}px ${metrics.padL}px`,
    fontFamily: "var(--cocoa-font)",
    fontSize: metrics.fontSize,
    lineHeight: metrics.lineHeight,
    color: "var(--cocoa-label)",
    background: "var(--cocoa-background-control)",
    border: "1px solid var(--cocoa-separator)",
    borderRadius: "var(--cocoa-radius-md)",
    outline: "none",
    appearance: "none",
    WebkitAppearance: "none",
    MozAppearance: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    boxShadow: focused ? "0 0 0 3px var(--cocoa-focus-ring)" : "none",
    transition:
      "border-color var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-fast) var(--cocoa-ease-out)",
  };

  const chevronStyle: CSSProperties = {
    position: "absolute",
    right: 8,
    pointerEvents: "none",
    display: "inline-flex",
    alignItems: "center",
    color: "var(--cocoa-label-secondary)",
  };

  return (
    <span style={wrapperStyle}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={selectStyle}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        {placeholder !== undefined ? (
          <option value="" disabled hidden>
            {placeholder}
          </option>
        ) : null}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <span style={chevronStyle} aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path
            d="M2 4l3 3 3-3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </span>
  );
}

export default CocoaSelect;
