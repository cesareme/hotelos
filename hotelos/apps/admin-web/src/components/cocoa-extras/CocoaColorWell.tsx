// CocoaColorWell — NSColorWell-style color picker following Cocoa visuals.
//
// Renders a square or circular "well" filled with the currently selected
// color, surrounded by a subtle border and a control-style shadow. Clicking
// the well opens a CocoaPopover with a grid of preset color swatches and a
// native `<input type="color">` at the bottom for full picker access.
//
// The component is fully controlled: it takes a `value` (CSS color string,
// typically hex) and emits `onChange(color)` whenever the user picks a new
// one. No internal selection state — the caller owns it.
//
// Sizes mirror NSColorWell standard control sizes:
//   - small:   16px well
//   - regular: 24px well (default)
//   - large:   32px well
//
// Shape is a rounded square (per macOS color well convention) — the corner
// radius scales with size. A checkered backdrop shows through if the color
// is fully transparent, mirroring NSColorWell's "no color" state.
//
// Default preset palette matches Apple's standard color set used across
// iWork / Notes / Reminders accent pickers.

import { useRef, useState, type CSSProperties } from "react";
import CocoaPopover from "../cocoa/CocoaPopover";

export interface CocoaColorWellProps {
  value: string;
  onChange: (color: string) => void;
  size?: "small" | "regular" | "large";
  presets?: string[];
}

interface Dimensions {
  well: number;
  radius: number;
  swatch: number;
  swatchRadius: number;
}

const DIMENSIONS: Record<NonNullable<CocoaColorWellProps["size"]>, Dimensions> =
  {
    small: { well: 16, radius: 4, swatch: 20, swatchRadius: 4 },
    regular: { well: 24, radius: 5, swatch: 24, swatchRadius: 5 },
    large: { well: 32, radius: 6, swatch: 28, swatchRadius: 6 },
  };

const DEFAULT_PRESETS: string[] = [
  "#007aff",
  "#34c759",
  "#ff9500",
  "#ff3b30",
  "#5856d6",
  "#af52de",
  "#ff2d55",
  "#a2845e",
  "#8e8e93",
  "#000000",
  "#ffffff",
];

// Normalize for comparison — hex values may differ by case.
function sameColor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function CocoaColorWell({
  value,
  onChange,
  size = "regular",
  presets = DEFAULT_PRESETS,
}: CocoaColorWellProps) {
  const dims = DIMENSIONS[size];
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  const handleToggle = () => {
    setOpen((prev) => !prev);
  };

  const handlePresetClick = (color: string) => {
    onChange(color);
    setOpen(false);
  };

  const handleNativeChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ): void => {
    onChange(event.target.value);
  };

  const wellStyle: CSSProperties = {
    width: dims.well,
    height: dims.well,
    borderRadius: dims.radius,
    background: value,
    border: "1px solid var(--cocoa-separator)",
    boxShadow: "var(--cocoa-shadow-control)",
    padding: 0,
    cursor: "pointer",
    display: "inline-block",
    verticalAlign: "middle",
    outline: "none",
    WebkitTapHighlightColor: "transparent",
  };

  const gridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: `repeat(6, ${dims.swatch}px)`,
    gap: "var(--cocoa-space-2)",
    marginBottom: "var(--cocoa-space-3)",
  };

  const dividerStyle: CSSProperties = {
    height: 1,
    background: "var(--cocoa-separator)",
    margin: "0 0 var(--cocoa-space-3) 0",
    border: "none",
  };

  const nativeRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--cocoa-space-2)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-body)",
    lineHeight: "var(--cocoa-lh-body)",
    color: "var(--cocoa-label)",
  };

  const nativeInputStyle: CSSProperties = {
    appearance: "none",
    WebkitAppearance: "none",
    width: 32,
    height: 24,
    padding: 0,
    border: "1px solid var(--cocoa-separator)",
    borderRadius: "var(--cocoa-radius-sm)",
    background: "transparent",
    cursor: "pointer",
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Select color"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={handleToggle}
        style={wellStyle}
      />
      <CocoaPopover
        open={open}
        anchorEl={buttonRef.current}
        placement="bottom"
        onClose={() => setOpen(false)}
      >
        <div style={gridStyle} role="listbox" aria-label="Preset colors">
          {presets.map((color) => {
            const selected = sameColor(color, value);
            const swatchStyle: CSSProperties = {
              width: dims.swatch,
              height: dims.swatch,
              borderRadius: dims.swatchRadius,
              background: color,
              border: selected
                ? "2px solid var(--cocoa-accent)"
                : "1px solid var(--cocoa-separator)",
              boxShadow: "var(--cocoa-shadow-control)",
              padding: 0,
              cursor: "pointer",
              outline: "none",
              WebkitTapHighlightColor: "transparent",
            };
            return (
              <button
                key={color}
                type="button"
                role="option"
                aria-selected={selected}
                aria-label={color}
                title={color}
                onClick={() => handlePresetClick(color)}
                style={swatchStyle}
              />
            );
          })}
        </div>
        <hr style={dividerStyle} />
        <label style={nativeRowStyle}>
          <span>Custom</span>
          <input
            type="color"
            value={value}
            onChange={handleNativeChange}
            style={nativeInputStyle}
            aria-label="Custom color"
          />
        </label>
      </CocoaPopover>
    </>
  );
}

export default CocoaColorWell;
