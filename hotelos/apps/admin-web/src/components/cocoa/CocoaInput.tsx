// CocoaInput — Cocoa Edition text field.
//
// macOS HIG inspired single-line input. Theme-aware via --cocoa-* tokens
// (light/dark) and supports optional left icon + right slot (e.g. clear button).
//
// Usage:
//   <CocoaInput value={q} onChange={setQ} placeholder="Search…" icon={<SearchIcon />} />
//   <CocoaInput value={v} onChange={setV} size="large" error={!!err} required />

import { useId, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

export type CocoaInputSize = "small" | "regular" | "large";

export type CocoaInputProps = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  size?: CocoaInputSize;
  icon?: ReactNode;
  rightSlot?: ReactNode;
  disabled?: boolean;
  error?: boolean;
  inputMode?:
    | "none"
    | "text"
    | "tel"
    | "url"
    | "email"
    | "numeric"
    | "decimal"
    | "search";
  required?: boolean;
};

type SizeMetrics = {
  padY: number;
  padX: number;
  fontSize: string;
  lineHeight: string;
  iconPad: number; // extra left padding when icon present
  rightPad: number; // extra right padding when rightSlot present
  iconBox: number; // icon container width
  slotBox: number; // right slot container width
};

const SIZE_METRICS: Record<CocoaInputSize, SizeMetrics> = {
  small: {
    padY: 6,
    padX: 10,
    fontSize: "var(--cocoa-fs-callout)",
    lineHeight: "var(--cocoa-lh-callout)",
    iconPad: 26,
    rightPad: 26,
    iconBox: 26,
    slotBox: 26,
  },
  regular: {
    padY: 8,
    padX: 12,
    fontSize: "var(--cocoa-fs-body)",
    lineHeight: "var(--cocoa-lh-body)",
    iconPad: 30,
    rightPad: 30,
    iconBox: 30,
    slotBox: 30,
  },
  large: {
    padY: 10,
    padX: 14,
    fontSize: "var(--cocoa-fs-title-3)",
    lineHeight: "var(--cocoa-lh-title-3)",
    iconPad: 34,
    rightPad: 34,
    iconBox: 34,
    slotBox: 34,
  },
};

export function CocoaInput(props: CocoaInputProps) {
  const {
    value,
    onChange,
    placeholder,
    type = "text",
    size = "regular",
    icon,
    rightSlot,
    disabled = false,
    error = false,
    inputMode,
    required = false,
  } = props;

  const [focused, setFocused] = useState(false);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const metrics = SIZE_METRICS[size];

  // Borders + focus ring tokens
  const borderColor = error
    ? "var(--cocoa-danger)"
    : focused
      ? "var(--cocoa-accent)"
      : "var(--cocoa-separator)";

  // Focus ring — consume the shared tokens (audit 2026-06 · #4), never literals.
  // Danger variant derives from --cocoa-danger so it themes with the palette.
  const focusRing = focused
    ? error
      ? "0 0 0 3px color-mix(in srgb, var(--cocoa-danger) 45%, transparent)"
      : "0 0 0 3px var(--cocoa-focus-ring)"
    : "none";

  const wrapperStyle: CSSProperties = {
    position: "relative",
    display: "inline-flex",
    width: "100%",
    alignItems: "stretch",
  };

  const inputStyle: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    margin: 0,
    appearance: "none",
    WebkitAppearance: "none",
    background: "var(--cocoa-background-control)",
    color: "var(--cocoa-label)",
    border: `1px solid ${borderColor}`,
    borderRadius: "var(--cocoa-radius-md)",
    paddingTop: metrics.padY,
    paddingBottom: metrics.padY,
    paddingLeft: icon ? metrics.iconPad : metrics.padX,
    paddingRight: rightSlot ? metrics.rightPad : metrics.padX,
    fontFamily: "var(--cocoa-font)",
    fontSize: metrics.fontSize,
    lineHeight: metrics.lineHeight,
    fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
    letterSpacing: "var(--cocoa-tracking-normal)",
    outline: 0,
    boxShadow: focusRing,
    transition:
      "border-color var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-fast) var(--cocoa-ease-out)",
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "text",
  };

  const iconStyle: CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: metrics.iconBox,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--cocoa-label-secondary)",
    pointerEvents: "none",
  };

  const slotStyle: CSSProperties = {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: metrics.slotBox,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--cocoa-label-secondary)",
  };

  return (
    <span className="cocoa-input" data-size={size} style={wrapperStyle}>
      {icon ? (
        <span aria-hidden="true" style={iconStyle}>
          {icon}
        </span>
      ) : null}
      <input
        id={inputId}
        ref={inputRef}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        inputMode={inputMode}
        aria-invalid={error || undefined}
        aria-required={required || undefined}
        style={inputStyle}
      />
      {rightSlot ? <span style={slotStyle}>{rightSlot}</span> : null}
      <style>{`
        .cocoa-input input::placeholder {
          color: var(--cocoa-label-tertiary);
          opacity: 1;
        }
        .cocoa-input input::-webkit-input-placeholder {
          color: var(--cocoa-label-tertiary);
          opacity: 1;
        }
      `}</style>
    </span>
  );
}

export default CocoaInput;
