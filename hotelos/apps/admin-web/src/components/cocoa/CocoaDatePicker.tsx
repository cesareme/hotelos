// CocoaDatePicker — native date input with the CocoaInput skin (COCOA-22.md
// §3.8): control bg, separator border (accent on focus, danger on error),
// radius 8, focus halo, tabular figures, 44 px on a coarse pointer.

import { useId, useState, type CSSProperties } from "react";
import { useCoarsePointer, TAP_TARGET_PX } from "../../lib/useCoarsePointer";
import { controlChrome } from "./CocoaInput";

export interface CocoaDatePickerProps {
  value: string;
  onChange: (v: string) => void;
  min?: string;
  max?: string;
  size?: "small" | "regular" | "large";
  disabled?: boolean;
  error?: boolean;
  required?: boolean;
  /** Date AND time (`datetime-local`; `value`/`min`/`max` as «YYYY-MM-DDTHH:mm»); default a date only. */
  withTime?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
  style?: CSSProperties;
}

const SIZE_METRICS: Record<NonNullable<CocoaDatePickerProps["size"]>, { height: number; padX: number; fontSize: string; lineHeight: string }> = {
  small: { height: 22, padX: 8, fontSize: "var(--cocoa-fs-subheadline)", lineHeight: "var(--cocoa-lh-subheadline)" },
  regular: { height: 28, padX: 10, fontSize: "var(--cocoa-fs-body)", lineHeight: "var(--cocoa-lh-body)" },
  large: { height: 34, padX: 12, fontSize: "var(--cocoa-fs-title-3)", lineHeight: "var(--cocoa-lh-title-3)" }
};

export function CocoaDatePicker({
  value,
  onChange,
  min,
  max,
  size = "regular",
  disabled = false,
  error = false,
  required = false,
  withTime = false,
  id,
  name,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  className,
  style
}: CocoaDatePickerProps) {
  const [focused, setFocused] = useState(false);
  const coarse = useCoarsePointer();
  const generatedId = useId();
  const metrics = SIZE_METRICS[size];
  const chrome = controlChrome({ focused, error });

  const inputStyle: CSSProperties = {
    height: coarse ? TAP_TARGET_PX : metrics.height,
    padding: `0 ${metrics.padX}px`,
    fontSize: metrics.fontSize,
    lineHeight: metrics.lineHeight,
    fontFamily: "var(--cocoa-font)",
    fontFeatureSettings: "var(--cocoa-font-numeric-tabular)",
    color: "var(--cocoa-label)",
    background: "var(--cocoa-background-control)",
    border: `1px solid ${chrome.borderColor}`,
    borderRadius: "var(--cocoa-radius-md)",
    outline: "none",
    boxShadow: chrome.boxShadow,
    transition: "border-color var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-fast) var(--cocoa-ease-out)",
    appearance: "none",
    WebkitAppearance: "none",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "text",
    ...style
  };

  return (
    <input
      type={withTime ? "datetime-local" : "date"}
      id={id ?? generatedId}
      name={name}
      value={value}
      min={min}
      max={max}
      disabled={disabled}
      required={required}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      aria-invalid={ariaInvalid ?? (error || undefined)}
      aria-required={required || undefined}
      className={["cocoa-date-picker", className].filter(Boolean).join(" ")}
      onChange={(event) => onChange(event.currentTarget.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={inputStyle}
      data-cocoa="date-picker"
      data-size={size}
      data-with-time={withTime ? "true" : undefined}
    />
  );
}

export default CocoaDatePicker;
