// CocoaInput — text field of Cocoa 22 (COCOA-22.md §3.8; replaces raw
// <input>/<textarea>, `.fp-field`, `FormField`, `FormTextarea`).
//
//   control bg · border separator (accent on focus, danger on error) · radius 8
//   focus halo 3 px --cocoa-focus-ring (danger 45 % on error) · sizes small /
//   regular / large = 22 / 28 / 34 px (`CONTROL_HEIGHT_BY_SIZE`, the SAME
//   heights as CocoaSelect and CocoaDatePicker so a form row aligns; §3.8
//   control 28) · optional left icon and right slot · 16 px on a coarse
//   pointer (mobile.css, avoids the iOS zoom) · `multiline` renders a
//   <textarea> with the same skin (vertical resize, `rows`).
//
// Placeholder colour (`.cocoa-input input::placeholder` → label-tertiary) is a
// global rule of the css lot, not an inline <style> per instance.

import { useId, useState, type CSSProperties, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

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
  readOnly?: boolean;
  error?: boolean;
  inputMode?: "none" | "text" | "tel" | "url" | "email" | "numeric" | "decimal" | "search";
  required?: boolean;
  /** Render a <textarea> (vertical resize). */
  multiline?: boolean;
  rows?: number;
  /** Native <datalist> suggestions (single-line only): offered while typing, free text stays allowed (a category field with the usual values). */
  suggestions?: readonly string[];
  name?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  maxLength?: number;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  pattern?: string;
  onBlur?: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onFocus?: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  /** Accessible name when there is no visible <label>. */
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  /** Explicit id so an external <label htmlFor> can point at the input; defaults to a generated one. */
  id?: string;
  className?: string;
  /** Layout escape hatch for the wrapper (width). */
  style?: CSSProperties;
};

/** Outer height of every text-like control by size (§3.8): shared with CocoaSelect / CocoaDatePicker. */
export const CONTROL_HEIGHT_BY_SIZE: Record<CocoaInputSize, number> = { small: 22, regular: 28, large: 34 };

/** Border of every control (1 px each side). */
export const CONTROL_BORDER_PX = 1;

type SizeMetrics = {
  padX: number;
  fontSize: string;
  lineHeight: string;
  /** Numeric mirror of `lineHeight` (cocoa-tokens.css `--cocoa-lh-*`) used to derive the vertical padding. */
  lineHeightPx: number;
  iconPad: number;
  rightPad: number;
  iconBox: number;
  slotBox: number;
};

const SIZE_METRICS: Record<CocoaInputSize, SizeMetrics> = {
  small: { padX: 10, fontSize: "var(--cocoa-fs-subheadline)", lineHeight: "var(--cocoa-lh-subheadline)", lineHeightPx: 14, iconPad: 26, rightPad: 26, iconBox: 26, slotBox: 26 },
  regular: { padX: 12, fontSize: "var(--cocoa-fs-body)", lineHeight: "var(--cocoa-lh-body)", lineHeightPx: 16, iconPad: 30, rightPad: 30, iconBox: 30, slotBox: 30 },
  large: { padX: 14, fontSize: "var(--cocoa-fs-title-3)", lineHeight: "var(--cocoa-lh-title-3)", lineHeightPx: 20, iconPad: 34, rightPad: 34, iconBox: 34, slotBox: 34 }
};

/** Vertical padding that makes the control exactly `CONTROL_HEIGHT_BY_SIZE[size]` tall (pure): (height − 2 × border − line-height) / 2. */
export function inputPaddingY(size: CocoaInputSize): number {
  return (CONTROL_HEIGHT_BY_SIZE[size] - 2 * CONTROL_BORDER_PX - SIZE_METRICS[size].lineHeightPx) / 2;
}

/** Border and halo of a control by state (pure; shared with select/date picker). */
export function controlChrome(input: { focused: boolean; error: boolean }): { borderColor: string; boxShadow: string } {
  const borderColor = input.error ? "var(--cocoa-danger)" : input.focused ? "var(--cocoa-accent)" : "var(--cocoa-separator)";
  const boxShadow = input.focused
    ? input.error
      ? "0 0 0 3px color-mix(in srgb, var(--cocoa-danger) 45%, transparent)"
      : "0 0 0 3px var(--cocoa-focus-ring)"
    : "none";
  return { borderColor, boxShadow };
}

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
    readOnly = false,
    error = false,
    inputMode,
    required = false,
    multiline = false,
    rows = 3,
    suggestions,
    name,
    autoComplete,
    autoFocus,
    maxLength,
    min,
    max,
    step,
    pattern,
    onBlur,
    onFocus,
    onKeyDown,
    "aria-label": ariaLabel,
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": ariaInvalid,
    id,
    className,
    style
  } = props;

  const [focused, setFocused] = useState(false);
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listId = !multiline && suggestions && suggestions.length > 0 ? `${inputId}-list` : undefined;
  const metrics = SIZE_METRICS[size];
  // Single-line controls are exactly 22 / 28 / 34 px; a textarea keeps 8 px of air.
  const padY = multiline ? "var(--cocoa-space-2)" : inputPaddingY(size);
  const chrome = controlChrome({ focused, error });

  const wrapperStyle: CSSProperties = {
    position: "relative",
    display: "inline-flex",
    width: "100%",
    alignItems: "stretch",
    minWidth: 0,
    ...style
  };

  const controlStyle: CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    margin: 0,
    appearance: "none",
    WebkitAppearance: "none",
    background: "var(--cocoa-background-control)",
    color: "var(--cocoa-label)",
    border: `${CONTROL_BORDER_PX}px solid ${chrome.borderColor}`,
    borderRadius: "var(--cocoa-radius-md)",
    paddingTop: padY,
    paddingBottom: padY,
    paddingLeft: icon ? metrics.iconPad : metrics.padX,
    paddingRight: rightSlot ? metrics.rightPad : metrics.padX,
    fontFamily: "var(--cocoa-font)",
    fontSize: metrics.fontSize,
    lineHeight: metrics.lineHeight,
    fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
    letterSpacing: "var(--cocoa-tracking-normal)",
    outline: 0,
    boxShadow: chrome.boxShadow,
    transition: "border-color var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-fast) var(--cocoa-ease-out)",
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "text",
    resize: multiline ? "vertical" : undefined,
    minHeight: multiline ? undefined : undefined
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
    pointerEvents: "none"
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
    color: "var(--cocoa-label-secondary)"
  };

  const shared = {
    id: inputId,
    value,
    placeholder,
    disabled,
    readOnly,
    required,
    name,
    autoComplete,
    autoFocus,
    maxLength,
    "aria-invalid": ariaInvalid ?? (error || undefined),
    "aria-required": required || undefined,
    "aria-label": ariaLabel,
    "aria-describedby": ariaDescribedBy,
    style: controlStyle,
    onFocus: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFocused(true);
      onFocus?.(event);
    },
    onBlur: (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFocused(false);
      onBlur?.(event);
    },
    onKeyDown
  };

  return (
    <span className={["cocoa-input", className].filter(Boolean).join(" ")} data-size={size} data-cocoa="input" data-multiline={multiline ? "true" : undefined} style={wrapperStyle}>
      {icon ? (
        <span aria-hidden="true" style={iconStyle}>
          {icon}
        </span>
      ) : null}
      {multiline ? (
        <textarea {...shared} rows={rows} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...shared} type={type} inputMode={inputMode} min={min} max={max} step={step} pattern={pattern} list={listId} onChange={(e) => onChange(e.target.value)} />
      )}
      {listId ? (
        <datalist id={listId}>
          {suggestions!.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      ) : null}
      {rightSlot ? <span style={slotStyle}>{rightSlot}</span> : null}
    </span>
  );
}

export default CocoaInput;
