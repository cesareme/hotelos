// CocoaStepper — NSStepper-style numeric stepper.
//
// Composite control: a numeric input (Cocoa-styled) on the left, with two
// vertically stacked +/- buttons on the right that share the same 28px /
// 22px shell. Click on the top button increments by `step` (capped at
// `max`), click on the bottom button decrements (capped at `min`).
//
// Typing in the input commits the parsed numeric value on blur/Enter,
// clamped to [min, max]. Keyboard ArrowUp/ArrowDown also step the value.
//
// Focus ring mirrors CocoaSelect (3px halo using --cocoa-focus-ring) so
// the stepper aligns visually with sibling form controls.

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent
} from "react";

export interface CocoaStepperProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  size?: "small" | "regular";
  disabled?: boolean;
}

interface SizeMetrics {
  height: number;
  fontSize: string;
  lineHeight: string;
  padY: number;
  padL: number;
  buttonsWidth: number;
  chevronSize: number;
  inputMinWidth: number;
}

const SIZE_METRICS: Record<
  NonNullable<CocoaStepperProps["size"]>,
  SizeMetrics
> = {
  small: {
    height: 22,
    fontSize: "var(--cocoa-fs-subheadline)",
    lineHeight: "var(--cocoa-lh-subheadline)",
    padY: 4,
    padL: 8,
    buttonsWidth: 14,
    chevronSize: 7,
    inputMinWidth: 48
  },
  regular: {
    height: 28,
    fontSize: "var(--cocoa-fs-body)",
    lineHeight: "var(--cocoa-lh-body)",
    padY: 6,
    padL: 10,
    buttonsWidth: 16,
    chevronSize: 8,
    inputMinWidth: 64
  }
};

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function ChevronUp({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 6.5l3-3 3 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronDown({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 3.5l3 3 3-3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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
  disabled = false
}: CocoaStepperProps) {
  const metrics = SIZE_METRICS[size];
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState<string>(String(value));
  const isEditingRef = useRef(false);

  // Keep the input text in sync with `value` while the user isn't actively
  // editing it. This avoids stomping over a partially-typed value (e.g.
  // "-" or "1.") during typing.
  useEffect(() => {
    if (!isEditingRef.current) {
      setDraft(String(value));
    }
  }, [value]);

  const atMax = value >= max;
  const atMin = value <= min;

  const commit = (next: number) => {
    if (disabled) return;
    const clamped = clamp(next, min, max);
    if (clamped !== value) {
      onChange(clamped);
    }
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
    if (Number.isFinite(parsed)) {
      commit(parsed);
    } else {
      // Revert to the last good value.
      setDraft(String(value));
    }
  };

  const handleInputBlur = () => {
    setFocused(false);
    commitDraft();
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

  const wrapperStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "stretch",
    height: metrics.height,
    background: "var(--cocoa-background-control)",
    border: "1px solid var(--cocoa-separator)",
    borderRadius: "var(--cocoa-radius-md)",
    boxShadow: focused ? "0 0 0 3px var(--cocoa-focus-ring)" : "none",
    transition:
      "border-color var(--cocoa-duration-fast) var(--cocoa-ease-out), box-shadow var(--cocoa-duration-fast) var(--cocoa-ease-out)",
    opacity: disabled ? 0.5 : 1,
    overflow: "hidden",
    fontFamily: "var(--cocoa-font)"
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
    color: "var(--cocoa-label)",
    background: "transparent",
    border: "none",
    outline: "none",
    textAlign: "right",
    appearance: "textfield",
    WebkitAppearance: "none",
    MozAppearance: "textfield",
    cursor: disabled ? "not-allowed" : "text"
  };

  const buttonsWrapperStyle: CSSProperties = {
    display: "inline-flex",
    flexDirection: "column",
    width: metrics.buttonsWidth,
    flexShrink: 0,
    borderLeft: "1px solid var(--cocoa-separator)"
  };

  const stepperButtonBaseStyle: CSSProperties = {
    flex: 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    margin: 0,
    border: "none",
    background: "var(--cocoa-background-control)",
    color: "var(--cocoa-label-secondary)",
    cursor: "pointer",
    minHeight: 0,
    lineHeight: 0,
    WebkitAppearance: "none",
    appearance: "none",
    outline: "none",
    transition:
      "background-color var(--cocoa-duration-fast) var(--cocoa-ease-out), color var(--cocoa-duration-fast) var(--cocoa-ease-out)"
  };

  const incrementStyle: CSSProperties = {
    ...stepperButtonBaseStyle,
    borderBottom: "1px solid var(--cocoa-separator)",
    cursor: disabled || atMax ? "not-allowed" : "pointer",
    opacity: disabled || atMax ? 0.4 : 1
  };

  const decrementStyle: CSSProperties = {
    ...stepperButtonBaseStyle,
    cursor: disabled || atMin ? "not-allowed" : "pointer",
    opacity: disabled || atMin ? 0.4 : 1
  };

  const handleButtonHover = (
    event: React.MouseEvent<HTMLButtonElement>,
    enter: boolean,
    canPress: boolean
  ) => {
    if (!canPress) return;
    const target = event.currentTarget;
    if (enter) {
      target.style.background = "var(--cocoa-background-content, var(--cocoa-background-control))";
      target.style.color = "var(--cocoa-label)";
    } else {
      target.style.background = "var(--cocoa-background-control)";
      target.style.color = "var(--cocoa-label-secondary)";
    }
  };

  const handleButtonPress = (
    event: React.MouseEvent<HTMLButtonElement>,
    pressed: boolean,
    canPress: boolean
  ) => {
    if (!canPress) return;
    const target = event.currentTarget;
    if (pressed) {
      target.style.background = "var(--cocoa-accent)";
      target.style.color = "var(--cocoa-accent-contrast)";
    } else {
      target.style.background = "var(--cocoa-background-control)";
      target.style.color = "var(--cocoa-label-secondary)";
    }
  };

  const canIncrement = !disabled && !atMax;
  const canDecrement = !disabled && !atMin;

  return (
    <span style={wrapperStyle}>
      <input
        type="number"
        value={draft}
        onChange={handleInputChange}
        onBlur={handleInputBlur}
        onFocus={() => setFocused(true)}
        onKeyDown={handleInputKeyDown}
        disabled={disabled}
        min={Number.isFinite(min) ? min : undefined}
        max={Number.isFinite(max) ? max : undefined}
        step={step}
        style={inputStyle}
        inputMode="decimal"
      />
      <span style={buttonsWrapperStyle}>
        <button
          type="button"
          aria-label="Increment"
          onClick={handleIncrement}
          disabled={!canIncrement}
          style={incrementStyle}
          onMouseEnter={(e) => handleButtonHover(e, true, canIncrement)}
          onMouseLeave={(e) => handleButtonHover(e, false, canIncrement)}
          onMouseDown={(e) => handleButtonPress(e, true, canIncrement)}
          onMouseUp={(e) => handleButtonPress(e, false, canIncrement)}
          tabIndex={-1}
        >
          <ChevronUp size={metrics.chevronSize} />
        </button>
        <button
          type="button"
          aria-label="Decrement"
          onClick={handleDecrement}
          disabled={!canDecrement}
          style={decrementStyle}
          onMouseEnter={(e) => handleButtonHover(e, true, canDecrement)}
          onMouseLeave={(e) => handleButtonHover(e, false, canDecrement)}
          onMouseDown={(e) => handleButtonPress(e, true, canDecrement)}
          onMouseUp={(e) => handleButtonPress(e, false, canDecrement)}
          tabIndex={-1}
        >
          <ChevronDown size={metrics.chevronSize} />
        </button>
      </span>
    </span>
  );
}

export default CocoaStepper;
