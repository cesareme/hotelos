// CocoaSelect — Cocoa-styled native <select> with a custom chevron
// (COCOA-22.md §3.8). Native menu UX (keyboard, type-ahead, AT) with the
// control skin of CocoaInput: control bg, separator border (accent on focus,
// danger on error), radius 8, focus halo, 44 px on a coarse pointer. The
// wrapper fills its row (a form field); `inline` shrinks it to the widest
// option for the pickers of an actions row or a toolbar (fix:L7 qa#6: three
// full-width selects stacked at 1440 in Modelos AEAT).

import { useId, useState, type CSSProperties } from "react";
import { useCoarsePointer, TAP_TARGET_PX } from "../../lib/useCoarsePointer";
import { CONTROL_HEIGHT_BY_SIZE, controlChrome } from "./CocoaInput";

export interface CocoaSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface CocoaSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<CocoaSelectOption>;
  /** Disabled, hidden first option shown while `value` is "" («Selecciona un canal»); a REAL «none» choice («Sin asignar») must be an explicit `{ value: "", label }` option instead. */
  placeholder?: string;
  size?: "small" | "regular" | "large";
  disabled?: boolean;
  error?: boolean;
  required?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
  /** Layout escape hatch for the wrapper (width). */
  style?: CSSProperties;
  /** Shrink to the widest option instead of filling the row (pickers in an actions row or a toolbar). */
  inline?: boolean;
}

// Heights come from CocoaInput's CONTROL_HEIGHT_BY_SIZE (22 / 28 / 34) so a
// select and an input on the same CocoaFormRow align.
const SIZE_METRICS: Record<NonNullable<CocoaSelectProps["size"]>, { fontSize: string; lineHeight: string; padY: number; padL: number; height: number }> = {
  small: { fontSize: "var(--cocoa-fs-subheadline)", lineHeight: "var(--cocoa-lh-subheadline)", padY: 4, padL: 8, height: CONTROL_HEIGHT_BY_SIZE.small },
  regular: { fontSize: "var(--cocoa-fs-body)", lineHeight: "var(--cocoa-lh-body)", padY: 6, padL: 10, height: CONTROL_HEIGHT_BY_SIZE.regular },
  large: { fontSize: "var(--cocoa-fs-title-3)", lineHeight: "var(--cocoa-lh-title-3)", padY: 8, padL: 12, height: CONTROL_HEIGHT_BY_SIZE.large }
};

/** Outer height of a select by size (pure; equals CocoaInput's). */
export function selectControlHeight(size: NonNullable<CocoaSelectProps["size"]>): number {
  return SIZE_METRICS[size].height;
}

export function CocoaSelect({
  value,
  onChange,
  options,
  placeholder,
  size = "regular",
  disabled = false,
  error = false,
  required = false,
  id,
  name,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  className,
  style,
  inline = false
}: CocoaSelectProps) {
  const [focused, setFocused] = useState(false);
  const coarse = useCoarsePointer();
  const generatedId = useId();
  const metrics = SIZE_METRICS[size];
  const chrome = controlChrome({ focused, error });

  const wrapperStyle: CSSProperties = { position: "relative", display: "inline-flex", alignItems: "center", width: inline ? "auto" : "100%", maxWidth: "100%", minWidth: 0, ...style };

  const selectStyle: CSSProperties = {
    width: "100%",
    height: coarse ? TAP_TARGET_PX : metrics.height,
    padding: `${metrics.padY}px 28px ${metrics.padY}px ${metrics.padL}px`,
    fontFamily: "var(--cocoa-font)",
    fontSize: metrics.fontSize,
    lineHeight: metrics.lineHeight,
    color: "var(--cocoa-label)",
    background: "var(--cocoa-background-control)",
    border: `1px solid ${chrome.borderColor}`,
    borderRadius: "var(--cocoa-radius-md)",
    outline: "none",
    appearance: "none",
    WebkitAppearance: "none",
    MozAppearance: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    boxShadow: chrome.boxShadow,
    boxSizing: "border-box",
    transition: "border-color var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-fast) var(--cocoa-ease-out)"
  };

  return (
    <span className={["cocoa-select", className].filter(Boolean).join(" ")} style={wrapperStyle} data-cocoa="select" data-size={size} data-inline={inline ? "true" : undefined}>
      <select
        id={id ?? generatedId}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={required}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid ?? (error || undefined)}
        aria-required={required || undefined}
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
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
      <span style={{ position: "absolute", right: 8, pointerEvents: "none", display: "inline-flex", alignItems: "center", color: "var(--cocoa-label-secondary)" }} aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </span>
  );
}

export default CocoaSelect;
