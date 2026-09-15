// CocoaSwitch — iOS-style toggle (COCOA-22.md §3.8): tracks 52×32 / 32×20,
// accent when on, translucent separator when off; thumb slides with the
// spring easing (the only spring in the kit); focus ring via
// `.cocoa-focus-ring`; ±12 px tap area on touch (`.cocoa-switch::before` in
// mobile.css). The thumb colour reads `--cocoa-switch-thumb` (css lot: white
// in light, light grey in dark) and falls back to the content background.

import { useId, type CSSProperties, type KeyboardEvent } from "react";

export interface CocoaSwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  size?: "small" | "regular";
  label?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  className?: string;
  style?: CSSProperties;
}

interface Dimensions {
  trackWidth: number;
  trackHeight: number;
  thumbSize: number;
  padding: number;
}

const DIMENSIONS: Record<NonNullable<CocoaSwitchProps["size"]>, Dimensions> = {
  small: { trackWidth: 32, trackHeight: 20, thumbSize: 16, padding: 2 },
  regular: { trackWidth: 52, trackHeight: 32, thumbSize: 28, padding: 2 }
};

/** Thumb translation for a state (pure). */
export function switchThumbOffset(checked: boolean, dims: Dimensions): number {
  return checked ? dims.trackWidth - dims.thumbSize - dims.padding : dims.padding;
}

export function CocoaSwitch({ checked, onChange, size = "regular", label, disabled = false, id, name, "aria-label": ariaLabel, "aria-describedby": ariaDescribedBy, className, style }: CocoaSwitchProps) {
  const reactId = useId();
  const labelId = `cocoa-switch-label-${reactId}`;
  const dims = DIMENSIONS[size];

  const handleToggle = () => {
    if (disabled) return;
    onChange(!checked);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      onChange(!checked);
    }
  };

  const trackStyle: CSSProperties = {
    position: "relative",
    display: "inline-block",
    flexShrink: 0,
    width: dims.trackWidth,
    height: dims.trackHeight,
    borderRadius: "var(--cocoa-radius-full)",
    border: "none",
    padding: 0,
    cursor: disabled ? "not-allowed" : "pointer",
    background: checked ? "var(--cocoa-accent)" : "color-mix(in srgb, var(--cocoa-separator) 50%, transparent)",
    transition: "background-color var(--cocoa-duration-base) var(--cocoa-ease-out)",
    opacity: disabled ? 0.5 : 1,
    WebkitTapHighlightColor: "transparent",
    ...style
  };

  const thumbStyle: CSSProperties = {
    position: "absolute",
    top: (dims.trackHeight - dims.thumbSize) / 2,
    left: 0,
    width: dims.thumbSize,
    height: dims.thumbSize,
    borderRadius: "var(--cocoa-radius-full)",
    background: "var(--cocoa-switch-thumb, var(--cocoa-background-content))",
    boxShadow: "0 0 0 0.5px var(--cocoa-separator-opaque), var(--cocoa-shadow-control)",
    transform: `translateX(${switchThumbOffset(checked, dims)}px)`,
    transition: "transform var(--cocoa-duration-base) var(--cocoa-ease-spring)",
    pointerEvents: "none"
  };

  const switchButton = (
    <button
      type="button"
      id={id}
      name={name}
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-labelledby={label ? labelId : undefined}
      aria-label={label ? undefined : ariaLabel}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      className={["cocoa-focus-ring", "cocoa-switch", className].filter(Boolean).join(" ")}
      style={trackStyle}
      data-cocoa="switch"
      data-size={size}
    >
      <span style={thumbStyle} aria-hidden="true" />
    </button>
  );

  if (!label) return switchButton;

  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--cocoa-space-2)",
        fontFamily: "var(--cocoa-font)",
        fontSize: "var(--cocoa-fs-body)",
        lineHeight: "var(--cocoa-lh-body)",
        color: disabled ? "var(--cocoa-label-secondary)" : "var(--cocoa-label)",
        cursor: disabled ? "not-allowed" : "pointer",
        userSelect: "none"
      }}
    >
      {switchButton}
      <span id={labelId}>{label}</span>
    </label>
  );
}

export default CocoaSwitch;
