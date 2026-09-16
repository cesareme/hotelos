// CocoaStepper — NSStepper-style numeric stepper (COCOA-22.md §3.8): a
// numeric input with stacked +/- buttons sharing the 28 / 22 px control
// shell. Typing commits on blur/Enter, clamped to [min, max]; ArrowUp/Down
// step; focus halo mirrors CocoaInput.
//
// Touch (`pointer: coarse`, qa#6): the shell grows to 44 px like CocoaInput /
// CocoaSelect / CocoaDatePicker (`useCoarsePointer`, mobile.css) and the ±
// pair becomes a row of two 44 × 44 buttons «− +» (UIStepper) to the right of
// the field, so every control measures ≥ 44 × 44 (§5.1 V6; measured before:
// 15 × 14 / 15 × 13 on /recepcion/reservas/nueva at 390). The 1 px border is
// painted by the parts (input, buttons), not by the shell: a border on the
// shell would leave the buttons' own boxes — what a finger and the §5.4
// probe measure — at 42 px inside a 44 px control.

import { useEffect, useId, useRef, useState, type ChangeEvent, type CSSProperties, type KeyboardEvent } from "react";
import { useCoarsePointer, TAP_TARGET_PX } from "../../lib/useCoarsePointer";
import { CONTROL_BORDER_PX, controlChrome } from "./CocoaInput";

export interface CocoaStepperProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  size?: "small" | "regular";
  disabled?: boolean;
  error?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
  style?: CSSProperties;
}

interface SizeMetrics {
  height: number;
  fontSize: string;
  lineHeight: string;
  padY: number;
  padL: number;
  /** Content width of the stacked ± column (borders excluded). */
  buttonsWidth: number;
  chevronSize: number;
  inputMinWidth: number;
}

const SIZE_METRICS: Record<NonNullable<CocoaStepperProps["size"]>, SizeMetrics> = {
  small: { height: 22, fontSize: "var(--cocoa-fs-subheadline)", lineHeight: "var(--cocoa-lh-subheadline)", padY: 4, padL: 8, buttonsWidth: 14, chevronSize: 7, inputMinWidth: 48 },
  regular: { height: 28, fontSize: "var(--cocoa-fs-body)", lineHeight: "var(--cocoa-lh-body)", padY: 6, padL: 10, buttonsWidth: 16, chevronSize: 8, inputMinWidth: 64 }
};

/** Chevron inside a 44 × 44 touch button (the CocoaSelect chevron size). */
const TOUCH_CHEVRON_SIZE = 10;

/** Clamp to [min, max] (pure). */
export function clampStep(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Fine pointer: ± stacked (NSStepper); coarse: side by side «− +» (UIStepper). */
export type CocoaStepperDirection = "column" | "row";

export interface CocoaStepperGeometry {
  direction: CocoaStepperDirection;
  /** Outer height of the control: 22 / 28, 44 on touch (equals CocoaInput / CocoaSelect). */
  height: number;
  /** Outer width of each ± button, borders included: 16 / 18, 44 on touch. */
  buttonWidth: number;
  chevronSize: number;
}

/** Geometry of the control by size and pointer (pure). */
export function stepperGeometry(size: NonNullable<CocoaStepperProps["size"]>, coarse: boolean): CocoaStepperGeometry {
  const metrics = SIZE_METRICS[size];
  if (coarse) return { direction: "row", height: TAP_TARGET_PX, buttonWidth: TAP_TARGET_PX, chevronSize: TOUCH_CHEVRON_SIZE };
  return { direction: "column", height: metrics.height, buttonWidth: metrics.buttonsWidth + 2 * CONTROL_BORDER_PX, chevronSize: metrics.chevronSize };
}

export interface CocoaStepperPartStyles {
  input: CSSProperties;
  increment: CSSProperties;
  decrement: CSSProperties;
}

/**
 * Borders and corner radii of the three parts (pure): the outer edge paints
 * `borderColor` (the control chrome: separator, accent on focus, danger on
 * error), the dividers between parts paint the separator, and only the outer
 * corners are rounded so the assembled control reads as one 8 px shell.
 */
export function stepperPartStyles(direction: CocoaStepperDirection, borderColor: string): CocoaStepperPartStyles {
  const outer = `${CONTROL_BORDER_PX}px solid ${borderColor}`;
  const divider = `${CONTROL_BORDER_PX}px solid var(--cocoa-separator)`;
  const radius = "var(--cocoa-radius-md)";
  const input: CSSProperties = { borderTop: outer, borderBottom: outer, borderLeft: outer, borderRight: "none", borderRadius: `${radius} 0 0 ${radius}` };
  if (direction === "row") {
    return {
      input,
      decrement: { borderTop: outer, borderBottom: outer, borderLeft: divider, borderRight: "none", borderRadius: 0 },
      increment: { borderTop: outer, borderBottom: outer, borderLeft: divider, borderRight: outer, borderRadius: `0 ${radius} ${radius} 0` }
    };
  }
  return {
    input,
    increment: { borderTop: outer, borderBottom: divider, borderLeft: divider, borderRight: outer, borderRadius: `0 ${radius} 0 0` },
    decrement: { borderTop: "none", borderBottom: outer, borderLeft: divider, borderRight: outer, borderRadius: `0 0 ${radius} 0` }
  };
}

function Chevron({ size, up }: { size: number; up: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d={up ? "M2 6.5l3-3 3 3" : "M2 3.5l3 3 3-3"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CocoaStepper({
  value,
  onChange,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  size = "regular",
  disabled = false,
  error = false,
  id,
  name,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  className,
  style
}: CocoaStepperProps) {
  const metrics = SIZE_METRICS[size];
  const coarse = useCoarsePointer();
  const geometry = stepperGeometry(size, coarse);
  const generatedId = useId();
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState<string>(String(value));
  const isEditingRef = useRef(false);
  const chrome = controlChrome({ focused, error });
  const parts = stepperPartStyles(geometry.direction, chrome.borderColor);

  // Keep the text in sync with `value` while the user is not editing (avoids stomping "-" or "1.").
  useEffect(() => {
    if (!isEditingRef.current) setDraft(String(value));
  }, [value]);

  const atMax = value >= max;
  const atMin = value <= min;

  const commit = (next: number) => {
    if (disabled) return;
    const clamped = clampStep(next, min, max);
    if (clamped !== value) onChange(clamped);
    setDraft(String(clamped));
  };

  const handleIncrement = () => {
    if (disabled || atMax) return;
    commit(value + step);
  };

  const handleDecrement = () => {
    if (disabled || atMin) return;
    commit(value - step);
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    isEditingRef.current = true;
    setDraft(event.target.value);
  };

  const commitDraft = () => {
    isEditingRef.current = false;
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) commit(parsed);
    else setDraft(String(value));
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      handleIncrement();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      handleDecrement();
    } else if (event.key === "Enter") {
      event.preventDefault();
      commitDraft();
    }
  };

  const borderTransition = "border-color var(--cocoa-duration-fast) var(--cocoa-ease-out)";

  // The shell only lays out, clips the corners and carries the focus halo; the
  // parts paint the border (see the header comment).
  const wrapperStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "stretch",
    height: geometry.height,
    background: "var(--cocoa-background-control)",
    borderRadius: "var(--cocoa-radius-md)",
    boxShadow: chrome.boxShadow,
    transition: "box-shadow var(--cocoa-duration-fast) var(--cocoa-ease-out)",
    opacity: disabled ? 0.5 : 1,
    overflow: "hidden",
    fontFamily: "var(--cocoa-font)",
    boxSizing: "border-box",
    ...style
  };

  const inputStyle: CSSProperties = {
    flex: 1,
    minWidth: metrics.inputMinWidth,
    height: "100%",
    boxSizing: "border-box",
    padding: `${metrics.padY}px ${metrics.padL}px`,
    fontFamily: "var(--cocoa-font)",
    fontSize: metrics.fontSize,
    lineHeight: metrics.lineHeight,
    fontFeatureSettings: "var(--cocoa-font-numeric-tabular)",
    color: "var(--cocoa-label)",
    background: "transparent",
    ...parts.input,
    outline: "none",
    textAlign: "right",
    appearance: "textfield",
    WebkitAppearance: "none",
    MozAppearance: "textfield",
    transition: borderTransition,
    cursor: disabled ? "not-allowed" : "text"
  };

  const stepperButtonBaseStyle: CSSProperties = {
    // Stacked: each button takes half the shell; row (touch): a fixed 44 × 44 cell stretched to the shell.
    flex: geometry.direction === "column" ? "1 1 0" : "0 0 auto",
    boxSizing: "border-box",
    width: geometry.buttonWidth,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    margin: 0,
    background: "var(--cocoa-background-control)",
    color: "var(--cocoa-label-secondary)",
    cursor: "pointer",
    minHeight: 0,
    lineHeight: 0,
    WebkitAppearance: "none",
    appearance: "none",
    outline: "none",
    transition: `background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), color var(--cocoa-duration-fast) var(--cocoa-ease-out), ${borderTransition}`
  };

  const canIncrement = !disabled && !atMax;
  const canDecrement = !disabled && !atMin;

  const handleButtonHover = (event: React.MouseEvent<HTMLButtonElement>, enter: boolean, canPress: boolean) => {
    if (!canPress) return;
    const target = event.currentTarget;
    target.style.background = enter ? "var(--cocoa-background-content)" : "var(--cocoa-background-control)";
    target.style.color = enter ? "var(--cocoa-label)" : "var(--cocoa-label-secondary)";
  };

  const handleButtonPress = (event: React.MouseEvent<HTMLButtonElement>, pressed: boolean, canPress: boolean) => {
    if (!canPress) return;
    const target = event.currentTarget;
    target.style.background = pressed ? "var(--cocoa-accent)" : "var(--cocoa-background-control)";
    target.style.color = pressed ? "var(--cocoa-accent-contrast)" : "var(--cocoa-label-secondary)";
  };

  const incrementButton = (
    <button
      type="button"
      aria-label="Aumentar"
      onClick={handleIncrement}
      disabled={!canIncrement}
      style={{ ...stepperButtonBaseStyle, ...parts.increment, cursor: canIncrement ? "pointer" : "not-allowed", opacity: canIncrement ? 1 : 0.4 }}
      onMouseEnter={(e) => handleButtonHover(e, true, canIncrement)}
      onMouseLeave={(e) => handleButtonHover(e, false, canIncrement)}
      onMouseDown={(e) => handleButtonPress(e, true, canIncrement)}
      onMouseUp={(e) => handleButtonPress(e, false, canIncrement)}
      tabIndex={-1}
    >
      <Chevron size={geometry.chevronSize} up />
    </button>
  );

  const decrementButton = (
    <button
      type="button"
      aria-label="Reducir"
      onClick={handleDecrement}
      disabled={!canDecrement}
      style={{ ...stepperButtonBaseStyle, ...parts.decrement, cursor: canDecrement ? "pointer" : "not-allowed", opacity: canDecrement ? 1 : 0.4 }}
      onMouseEnter={(e) => handleButtonHover(e, true, canDecrement)}
      onMouseLeave={(e) => handleButtonHover(e, false, canDecrement)}
      onMouseDown={(e) => handleButtonPress(e, true, canDecrement)}
      onMouseUp={(e) => handleButtonPress(e, false, canDecrement)}
      tabIndex={-1}
    >
      <Chevron size={geometry.chevronSize} up={false} />
    </button>
  );

  return (
    <span className={["cocoa-stepper", className].filter(Boolean).join(" ")} style={wrapperStyle} data-cocoa="stepper" data-size={size} data-direction={geometry.direction}>
      <input
        id={id ?? generatedId}
        name={name}
        type="number"
        value={draft}
        onChange={handleInputChange}
        onBlur={() => {
          setFocused(false);
          commitDraft();
        }}
        onFocus={() => setFocused(true)}
        onKeyDown={handleInputKeyDown}
        disabled={disabled}
        min={Number.isFinite(min) ? min : undefined}
        max={Number.isFinite(max) ? max : undefined}
        step={step}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid ?? (error || undefined)}
        style={inputStyle}
        inputMode="decimal"
      />
      <span style={{ display: "inline-flex", flexDirection: geometry.direction, flexShrink: 0 }}>
        {geometry.direction === "row" ? (
          <>
            {decrementButton}
            {incrementButton}
          </>
        ) : (
          <>
            {incrementButton}
            {decrementButton}
          </>
        )}
      </span>
    </span>
  );
}

export default CocoaStepper;
