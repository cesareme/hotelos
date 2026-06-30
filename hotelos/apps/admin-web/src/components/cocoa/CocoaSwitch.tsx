import { useId, type CSSProperties, type KeyboardEvent } from "react";

export interface CocoaSwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  size?: "small" | "regular";
  label?: string;
  disabled?: boolean;
}

interface Dimensions {
  trackWidth: number;
  trackHeight: number;
  thumbSize: number;
  padding: number;
}

const DIMENSIONS: Record<NonNullable<CocoaSwitchProps["size"]>, Dimensions> = {
  small: {
    trackWidth: 32,
    trackHeight: 20,
    thumbSize: 16,
    padding: 2
  },
  regular: {
    trackWidth: 52,
    trackHeight: 32,
    thumbSize: 28,
    padding: 2
  }
};

/**
 * CocoaSwitch — iOS-toggle style switch following Cocoa design tokens.
 *
 * Track size:
 *   - small:   32 x 20
 *   - regular: 52 x 32
 *
 * Track background:
 *   - on:  var(--cocoa-accent)
 *   - off: var(--cocoa-separator) at 0.5 opacity
 *
 * Thumb: white circle with shadow, translateX transition using
 * var(--cocoa-duration-base) and var(--cocoa-ease-spring).
 */
export function CocoaSwitch({
  checked,
  onChange,
  size = "regular",
  label,
  disabled = false
}: CocoaSwitchProps) {
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
    background: checked
      ? "var(--cocoa-accent)"
      : "color-mix(in srgb, var(--cocoa-separator) 50%, transparent)",
    transition: `background-color var(--cocoa-duration-base) var(--cocoa-ease-out)`,
    opacity: disabled ? 0.5 : 1,
    // audit 2026-06 R2 · #11 a11y: outline:none with no :focus-visible replacement
    // was a WCAG 2.4.7 fail. We consume the shared focus-ring token via the class
    // (cocoa-base.css sets box-shadow on :focus-visible) — no inline override needed.
    WebkitTapHighlightColor: "transparent"
  };

  const thumbTranslate = checked
    ? dims.trackWidth - dims.thumbSize - dims.padding
    : dims.padding;

  const thumbTop = (dims.trackHeight - dims.thumbSize) / 2;

  const thumbStyle: CSSProperties = {
    position: "absolute",
    top: thumbTop,
    left: 0,
    width: dims.thumbSize,
    height: dims.thumbSize,
    borderRadius: "var(--cocoa-radius-full)",
    background: "#FFFFFF",
    boxShadow: "var(--cocoa-shadow-control)",
    transform: `translateX(${thumbTranslate}px)`,
    transition: `transform var(--cocoa-duration-base) var(--cocoa-ease-spring)`,
    pointerEvents: "none"
  };

  const wrapperStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--cocoa-space-2)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-body)",
    lineHeight: "var(--cocoa-lh-body)",
    color: disabled ? "var(--cocoa-label-tertiary)" : "var(--cocoa-label)",
    cursor: disabled ? "not-allowed" : "pointer",
    userSelect: "none"
  };

  const switchButton = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-labelledby={label ? labelId : undefined}
      disabled={disabled}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      className="cocoa-focus-ring cocoa-switch"
      style={trackStyle}
    >
      <span style={thumbStyle} aria-hidden="true" />
    </button>
  );

  if (!label) {
    return switchButton;
  }

  return (
    <label style={wrapperStyle}>
      {switchButton}
      <span id={labelId}>{label}</span>
    </label>
  );
}

export default CocoaSwitch;
