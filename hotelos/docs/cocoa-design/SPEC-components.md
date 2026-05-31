# HotelOS Component Map: Cocoa → Web

Mapping every relevant Cocoa control to its HotelOS web equivalent. Each component declares dimensions, states, and a runnable CSS recipe. Tokens (`--accent`, `--bg-control`, `--label-primary`, etc.) come from `03-color-system.md`. Typography from `04-typography.md` (SF Pro Text / SF Pro Display, fallback `-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif`).

Global rules:
- All controls use `font-family: var(--font-sf-text)`.
- Focus ring: `box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent)`.
- Transitions: `transition: background 120ms ease, box-shadow 160ms ease, transform 80ms ease`.
- Disabled: `opacity: 0.4; pointer-events: none`.

---

## 1. CocoaButton — `NSButton` (push)

**Variants**: `filled-accent`, `filled-neutral`, `bordered`, `borderless-link`, `destructive`, `icon-only`.

**Heights**: small 22px / regular 28px / large 32px.
**Radius**: 6px (small), 8px (regular/large).
**Padding**: 0 10px (small), 0 14px (regular), 0 18px (large).
**Type**: SF Pro Text, semibold, 12px/13px/14px per size.

**States**: default · hover (+4% brightness) · active (−6% brightness, scale 0.98) · disabled (opacity 0.4) · focused (accent ring).

```css
.cocoa-btn {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 14px;
  border-radius: 8px; border: 0;
  font: 600 13px/1 var(--font-sf-text);
  color: var(--label-on-accent);
  background: var(--accent);
  box-shadow: 0 1px 0 rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.18);
  transition: background 120ms ease, box-shadow 160ms ease, transform 80ms ease;
}
.cocoa-btn:hover    { background: color-mix(in srgb, var(--accent) 92%, white); }
.cocoa-btn:active   { transform: scale(0.98); background: color-mix(in srgb, var(--accent) 92%, black); }
.cocoa-btn:focus-visible { outline: 0; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent); }

.cocoa-btn--neutral { background: var(--bg-control); color: var(--label-primary); box-shadow: inset 0 0 0 0.5px var(--separator); }
.cocoa-btn--bordered { background: transparent; color: var(--label-primary); box-shadow: inset 0 0 0 1px var(--separator); }
.cocoa-btn--link { background: transparent; color: var(--accent); padding: 0; height: auto; box-shadow: none; }
.cocoa-btn--destructive { background: var(--system-red); }
.cocoa-btn--sm { height: 22px; padding: 0 10px; border-radius: 6px; font-size: 12px; }
.cocoa-btn--lg { height: 32px; padding: 0 18px; font-size: 14px; }
```

---

## 2. CocoaSelect — `NSPopUpButton`

Menu-only (fixed list). Caret chevron on right. Bordered style by default.

**Height**: 28px (regular). **Radius**: 8px. **Padding**: 0 28px 0 12px (right padding reserves space for caret).
**Chevron**: SF Symbol `chevron.up.chevron.down`, 10px, label-secondary, right inset 10px.

```css
.cocoa-select {
  position: relative;
  display: inline-flex; align-items: center;
  height: 28px; padding: 0 28px 0 12px;
  border-radius: 8px;
  background: var(--bg-control);
  box-shadow: inset 0 0 0 0.5px var(--separator), 0 1px 0 rgba(0,0,0,0.04);
  font: 500 13px/1 var(--font-sf-text);
  color: var(--label-primary);
  appearance: none;
}
.cocoa-select::after {
  content: ""; position: absolute; right: 10px; top: 50%;
  width: 10px; height: 10px; transform: translateY(-50%);
  background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><path d='M2 4l3-3 3 3M2 6l3 3 3-3' stroke='%238E8E93' stroke-width='1.2' fill='none' stroke-linecap='round'/></svg>") center/contain no-repeat;
}
.cocoa-select:hover  { background: color-mix(in srgb, var(--bg-control) 90%, var(--label-primary)); }
.cocoa-select:focus-visible { outline: 0; box-shadow: inset 0 0 0 0.5px var(--separator), 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent); }
```

When the list allows typing → use `CocoaCombobox` (same shell + visible caret + dropdown listbox).

---

## 3. CocoaInput — `NSTextField`

**Height**: 28px. **Radius**: 6px. **Padding**: 0 10px.
**Border**: 0.5px `--separator`. **Focus**: accent ring 3px + border becomes `--accent`.
**Placeholder**: `--label-tertiary`.

```css
.cocoa-input {
  height: 28px; padding: 0 10px;
  border-radius: 6px;
  background: var(--bg-input);
  box-shadow: inset 0 0 0 0.5px var(--separator), inset 0 1px 1px rgba(0,0,0,0.03);
  font: 400 13px/1 var(--font-sf-text);
  color: var(--label-primary);
  border: 0;
}
.cocoa-input::placeholder { color: var(--label-tertiary); }
.cocoa-input:hover  { box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--separator) 60%, var(--label-secondary)); }
.cocoa-input:focus  { outline: 0;
  box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent);
}
.cocoa-input[aria-invalid="true"] {
  box-shadow: inset 0 0 0 1px var(--system-red), 0 0 0 3px color-mix(in srgb, var(--system-red) 25%, transparent);
}
```

Multi-line variant `CocoaTextArea`: same skin, `min-height: 80px`, `padding: 8px 10px`, `resize: vertical`.

---

## 4. CocoaSearchInput — `NSSearchField`

**Height**: 26px. **Radius**: 13px (rounded full). **Padding**: 0 28px 0 28px.
**Leading icon**: SF Symbol `magnifyingglass`, 12px, `--label-secondary`, inset 9px.
**Trailing clear**: SF Symbol `xmark.circle.fill`, 14px, appears only when value present.

```css
.cocoa-search {
  position: relative;
  display: inline-flex; align-items: center;
  height: 26px;
  background: var(--bg-search);
  border-radius: 13px;
  box-shadow: inset 0 0 0 0.5px var(--separator);
}
.cocoa-search > .icon-magnifier {
  position: absolute; left: 9px; width: 12px; height: 12px;
  color: var(--label-secondary);
}
.cocoa-search > input {
  flex: 1; height: 100%; padding: 0 28px;
  background: transparent; border: 0;
  font: 400 13px/1 var(--font-sf-text);
  color: var(--label-primary);
}
.cocoa-search > input::placeholder { color: var(--label-tertiary); }
.cocoa-search:focus-within {
  box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent);
}
.cocoa-search > .clear-btn {
  position: absolute; right: 8px;
  width: 14px; height: 14px; padding: 0; border: 0;
  background: transparent; color: var(--label-tertiary);
  cursor: pointer;
}
.cocoa-search[data-empty="true"] > .clear-btn { display: none; }
```

---

## 5. CocoaSegmentedControl — `NSSegmentedControl`

Style: **separated** (modern toolbar look). Active segment has inset white shadow over `--bg-control-elevated`.

**Height**: 28px. **Radius**: 8px outer, 6px inner. **Item padding**: 0 12px.
**Animation**: 200ms ease slide of the active background pill via `transform` on a positioned `::after`.

```css
.cocoa-seg {
  display: inline-flex; align-items: stretch;
  height: 28px; padding: 2px;
  background: var(--bg-control);
  border-radius: 8px;
  box-shadow: inset 0 0 0 0.5px var(--separator);
}
.cocoa-seg__item {
  flex: 1; display: inline-flex; align-items: center; justify-content: center;
  padding: 0 12px;
  border: 0; background: transparent;
  font: 500 12px/1 var(--font-sf-text);
  color: var(--label-secondary);
  border-radius: 6px;
  transition: color 120ms ease;
  cursor: pointer;
}
.cocoa-seg__item:hover { color: var(--label-primary); }
.cocoa-seg__item[aria-selected="true"] {
  color: var(--label-primary);
  background: var(--bg-control-elevated);
  box-shadow: 0 1px 2px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.5);
}
.cocoa-seg__item:focus-visible { outline: 0; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent); }
```

For a 3-pane HotelOS view switcher (List / Grid / Map) this is the canonical control.

---

## 6. CocoaStepper — `NSStepper`

Paired with `CocoaInput` numeric. Two stacked arrow buttons (▲ ▼) on the right, 13px wide each, 11px tall, total 22px. Auto-repeat on press-hold (200ms initial, 80ms steady).

**Container**: input + stepper share a single 28px-tall shell with rounded right side flush.

```css
.cocoa-stepper {
  display: inline-flex; align-items: stretch;
  height: 28px;
  border-radius: 6px;
  background: var(--bg-input);
  box-shadow: inset 0 0 0 0.5px var(--separator);
}
.cocoa-stepper > input {
  flex: 1; width: 64px; padding: 0 8px;
  background: transparent; border: 0;
  font: 400 13px/1 var(--font-sf-text);
  color: var(--label-primary);
  text-align: right;
}
.cocoa-stepper__btns {
  display: inline-flex; flex-direction: column;
  width: 14px; border-left: 0.5px solid var(--separator);
}
.cocoa-stepper__btns > button {
  flex: 1; padding: 0; border: 0;
  background: var(--bg-control);
  color: var(--label-secondary);
  cursor: pointer; font-size: 8px;
}
.cocoa-stepper__btns > button:first-child { border-radius: 0 6px 0 0; border-bottom: 0.5px solid var(--separator); }
.cocoa-stepper__btns > button:last-child  { border-radius: 0 0 6px 0; }
.cocoa-stepper__btns > button:hover { background: var(--bg-control-hover); color: var(--label-primary); }
.cocoa-stepper__btns > button:active { background: var(--accent); color: var(--label-on-accent); }
```

---

## 7. CocoaDatePicker — `NSDatePicker`

Two surfaces:
1. **Textual+stepper trigger** (inline in forms): looks like `CocoaInput` + stepper; format `MMM d, yyyy`.
2. **Inline calendar popover** on click: 240×260px, accent-tinted today, accent-filled selected day.

**Grid**: 7×6 day grid, 32×32px cells, 4px gap. Month header 40px tall with chevrons.

```css
.cocoa-datepicker__popover {
  width: 240px; padding: 12px;
  background: var(--bg-popover);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.18), 0 0 0 0.5px var(--separator);
  backdrop-filter: blur(20px) saturate(180%);
}
.cocoa-datepicker__header {
  display: flex; align-items: center; justify-content: space-between;
  height: 32px; margin-bottom: 8px;
  font: 600 13px/1 var(--font-sf-text); color: var(--label-primary);
}
.cocoa-datepicker__grid {
  display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px;
}
.cocoa-datepicker__day {
  display: inline-flex; align-items: center; justify-content: center;
  height: 28px; border-radius: 6px; border: 0;
  background: transparent; color: var(--label-primary);
  font: 400 12px/1 var(--font-sf-text); cursor: pointer;
}
.cocoa-datepicker__day:hover { background: var(--bg-control-hover); }
.cocoa-datepicker__day[data-today="true"] { color: var(--accent); font-weight: 600; }
.cocoa-datepicker__day[aria-selected="true"] { background: var(--accent); color: var(--label-on-accent); }
.cocoa-datepicker__day[data-other-month="true"] { color: var(--label-tertiary); }
```

For HotelOS range selection (check-in / check-out) two anchors share one popover; range cells use `background: color-mix(in srgb, var(--accent) 18%, transparent)`.

---

## 8. CocoaSlider — `NSSlider`

Linear horizontal. Track 4px tall, knob 17px circle, white with subtle shadow. Filled portion uses `--accent`.

```css
.cocoa-slider {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 17px;
  background: transparent;
}
.cocoa-slider::-webkit-slider-runnable-track {
  height: 4px; border-radius: 2px;
  background: linear-gradient(to right,
    var(--accent) var(--fill, 50%),
    var(--bg-control) var(--fill, 50%));
}
.cocoa-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 17px; height: 17px;
  margin-top: -6.5px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.18), 0 0 0 0.5px rgba(0,0,0,0.06);
  cursor: grab;
}
.cocoa-slider::-webkit-slider-thumb:active { cursor: grabbing; box-shadow: 0 2px 6px rgba(0,0,0,0.22); }
.cocoa-slider:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 1px 3px rgba(0,0,0,0.18), 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent);
}
```

Update `--fill` via JS on input. Vertical variant rotates 270deg in a fixed container.

---

## 9. CocoaSwitch — `NSSwitch`

iOS-style pill toggle. 38×22px. Knob 18px circle. On → `--accent`; off → `--bg-control`.

**Rule**: use for a heavy section toggle (enable feature). For a list of binary options use `CocoaCheckbox` (14×14px square).

```css
.cocoa-switch {
  position: relative; display: inline-block;
  width: 38px; height: 22px;
}
.cocoa-switch > input { position: absolute; opacity: 0; inset: 0; margin: 0; }
.cocoa-switch__track {
  position: absolute; inset: 0;
  background: var(--bg-control);
  border-radius: 11px;
  box-shadow: inset 0 0 0 0.5px var(--separator);
  transition: background 180ms ease;
}
.cocoa-switch__knob {
  position: absolute; top: 2px; left: 2px;
  width: 18px; height: 18px; border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0,0,0,0.18), 0 0 0 0.5px rgba(0,0,0,0.04);
  transition: transform 180ms ease;
}
.cocoa-switch > input:checked ~ .cocoa-switch__track { background: var(--accent); }
.cocoa-switch > input:checked ~ .cocoa-switch__knob  { transform: translateX(16px); }
.cocoa-switch > input:focus-visible ~ .cocoa-switch__track {
  box-shadow: inset 0 0 0 0.5px var(--separator), 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent);
}

.cocoa-checkbox {
  width: 14px; height: 14px; border-radius: 3px;
  background: var(--bg-control);
  box-shadow: inset 0 0 0 0.5px var(--separator);
  display: inline-flex; align-items: center; justify-content: center;
}
.cocoa-checkbox[aria-checked="true"] { background: var(--accent); box-shadow: none; }
.cocoa-checkbox[aria-checked="true"]::after {
  content: ""; width: 8px; height: 6px;
  border-left: 1.5px solid #fff; border-bottom: 1.5px solid #fff;
  transform: rotate(-45deg) translate(1px, -1px);
}
```

---

## 10. CocoaWindow — `NSWindow` chrome

Decorative traffic lights top-left (red #FF5F57, yellow #FEBC2E, green #28C840), 12px circles, 8px gap, 12px inset. Title bar 38px with material toolbar. Resize handle bottom-right (decorative when non-resizable).

```css
.cocoa-window {
  border-radius: 10px; overflow: hidden;
  background: var(--bg-window);
  box-shadow: 0 16px 48px rgba(0,0,0,0.22), 0 0 0 0.5px rgba(0,0,0,0.08);
}
.cocoa-window__titlebar {
  position: relative; height: 38px;
  display: flex; align-items: center; justify-content: center;
  background: var(--material-toolbar);
  backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 0.5px solid var(--separator);
  font: 600 13px/1 var(--font-sf-text); color: var(--label-primary);
}
.cocoa-window__lights { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); display: inline-flex; gap: 8px; }
.cocoa-window__light { width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 0 0 0.5px rgba(0,0,0,0.12); }
.cocoa-window__light--close   { background: #FF5F57; }
.cocoa-window__light--min     { background: #FEBC2E; }
.cocoa-window__light--zoom    { background: #28C840; }
.cocoa-window:not(:focus-within) .cocoa-window__light { background: #C8C8C8; }
```

When the window loses focus, lights desaturate to grey (matches Cocoa behavior).

---

## 11. CocoaTable — `NSTableView`

Header row 28px tall with sort indicators (chevron up/down). Rows 32px. Zebra: even rows transparent, odd rows `color-mix(in srgb, var(--label-primary) 3%, transparent)`. Selected row uses `--bg-selected-content`. Hover uses `color-mix(in srgb, var(--label-primary) 6%, transparent)`.

```css
.cocoa-table { width: 100%; border-collapse: separate; border-spacing: 0; font: 400 13px/1 var(--font-sf-text); }
.cocoa-table thead th {
  position: sticky; top: 0;
  height: 28px; padding: 0 12px; text-align: left;
  background: var(--material-toolbar);
  backdrop-filter: blur(20px);
  border-bottom: 0.5px solid var(--separator);
  font-weight: 600; color: var(--label-secondary); font-size: 11px;
  text-transform: none;
}
.cocoa-table thead th[aria-sort]::after {
  content: ""; display: inline-block; margin-left: 6px;
  width: 8px; height: 8px;
  background: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'><path d='M1 5l3-3 3 3' stroke='%238E8E93' stroke-width='1.2' fill='none'/></svg>") center/contain no-repeat;
}
.cocoa-table thead th[aria-sort="descending"]::after { transform: rotate(180deg); }
.cocoa-table tbody tr { height: 32px; }
.cocoa-table tbody tr:nth-child(even) { background: color-mix(in srgb, var(--label-primary) 3%, transparent); }
.cocoa-table tbody tr:hover { background: color-mix(in srgb, var(--label-primary) 6%, transparent); }
.cocoa-table tbody tr[aria-selected="true"] {
  background: var(--bg-selected-content);
  color: var(--label-on-selected);
}
.cocoa-table tbody td { padding: 0 12px; border-bottom: 0.5px solid var(--separator); }
```

---

## 12. CocoaSplitView — `NSSplitView`

Three columns: Sidebar | Content | Inspector. Sidebar 220px (collapsible to 0), Inspector 320px (collapsible). Vertical divider 0.5px `--separator` with 6px-wide invisible drag hit area.

```css
.cocoa-split { display: grid; grid-template-columns: var(--sidebar-w, 220px) 1fr var(--inspector-w, 320px); height: 100%; }
.cocoa-split__pane { position: relative; overflow: auto; }
.cocoa-split__pane--sidebar { background: var(--material-sidebar); backdrop-filter: blur(40px) saturate(180%); }
.cocoa-split__pane--inspector { background: var(--material-sidebar); backdrop-filter: blur(40px) saturate(180%); border-left: 0.5px solid var(--separator); }
.cocoa-split__divider {
  position: absolute; top: 0; right: -3px; width: 6px; height: 100%;
  cursor: col-resize; z-index: 2;
}
.cocoa-split__divider::after { content: ""; position: absolute; left: 3px; top: 0; width: 0.5px; height: 100%; background: var(--separator); }
.cocoa-split[data-sidebar-collapsed="true"] { grid-template-columns: 0 1fr var(--inspector-w, 320px); }
.cocoa-split[data-inspector-collapsed="true"] { grid-template-columns: var(--sidebar-w, 220px) 1fr 0; }
```

Resize via pointer events; persist widths in `localStorage` so layout survives reload.

---

## 13. CocoaToolbar — `NSToolbar`

Lives inside `CocoaWindow__titlebar` (unified style) or below it. Material `toolbar` with vibrancy. Items have icon (16px SF Symbol) + optional label (11px caption). Primary action floats to the right edge (e.g. "New Booking" filled-accent button).

```css
.cocoa-toolbar {
  display: flex; align-items: center; gap: 4px;
  height: 38px; padding: 0 8px;
  background: var(--material-toolbar);
  backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 0.5px solid var(--separator);
}
.cocoa-toolbar__item {
  display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
  min-width: 44px; height: 30px; padding: 0 8px;
  border: 0; background: transparent;
  border-radius: 6px;
  color: var(--label-primary); cursor: pointer;
}
.cocoa-toolbar__item:hover { background: color-mix(in srgb, var(--label-primary) 8%, transparent); }
.cocoa-toolbar__item:active { background: color-mix(in srgb, var(--label-primary) 12%, transparent); }
.cocoa-toolbar__icon { width: 16px; height: 16px; }
.cocoa-toolbar__label { font: 500 10px/1 var(--font-sf-text); color: var(--label-secondary); margin-top: 2px; }
.cocoa-toolbar__spacer { flex: 1; }
.cocoa-toolbar__primary { margin-left: auto; }
```

Compact mode (`data-style="unifiedCompact"`) drops the label and tightens height to 30px.

---

## 14. CocoaPopover — `NSPopover`

Anchored bubble with directional arrow. Material popover (vibrancy + 0.5px hairline border). Max width 320px.

```css
.cocoa-popover {
  position: absolute; max-width: 320px; padding: 10px 12px;
  background: var(--bg-popover);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.22), 0 0 0 0.5px var(--separator);
  backdrop-filter: blur(20px) saturate(180%);
  font: 400 13px/1.4 var(--font-sf-text);
  color: var(--label-primary);
}
.cocoa-popover__arrow {
  position: absolute; width: 12px; height: 12px;
  background: inherit;
  transform: rotate(45deg);
  box-shadow: -0.5px -0.5px 0 var(--separator);
}
.cocoa-popover[data-placement="bottom"] .cocoa-popover__arrow { top: -6px; left: calc(var(--arrow-x, 50%) - 6px); }
.cocoa-popover[data-placement="top"]    .cocoa-popover__arrow { bottom: -6px; left: calc(var(--arrow-x, 50%) - 6px); transform: rotate(225deg); }
.cocoa-popover[data-placement="right"]  .cocoa-popover__arrow { left: -6px; top: calc(var(--arrow-y, 50%) - 6px); transform: rotate(-45deg); }
.cocoa-popover[data-placement="left"]   .cocoa-popover__arrow { right: -6px; top: calc(var(--arrow-y, 50%) - 6px); transform: rotate(135deg); }
```

Open animation: 160ms scale 0.96 → 1 + opacity 0 → 1. Close mirrors. Dismiss on outside click + `Escape`.

---

## 15. CocoaSheet — `NSSheet`

Modal that drops from the top of the parent `CocoaWindow`. Width matches the window minus 96px insets, or `min(560px, window − 96px)`. Backdrop dims at 20%.

```css
.cocoa-sheet-host { position: relative; }
.cocoa-sheet-backdrop {
  position: absolute; inset: 0;
  background: rgba(0,0,0,0.2);
  opacity: 0; transition: opacity 200ms ease;
  z-index: 10;
}
.cocoa-sheet-host[data-open="true"] .cocoa-sheet-backdrop { opacity: 1; }
.cocoa-sheet {
  position: absolute; top: 38px; left: 50%;
  width: min(560px, calc(100% - 96px));
  transform: translate(-50%, -100%);
  background: var(--bg-window);
  border-radius: 0 0 10px 10px;
  box-shadow: 0 16px 32px rgba(0,0,0,0.25);
  padding: 20px;
  transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
  z-index: 11;
}
.cocoa-sheet-host[data-open="true"] .cocoa-sheet { transform: translate(-50%, 0); }
.cocoa-sheet__footer {
  display: flex; justify-content: flex-end; gap: 10px;
  margin-top: 20px; padding-top: 16px;
  border-top: 0.5px solid var(--separator);
}
```

Footer convention: Cancel on the left of the right-aligned cluster, primary action rightmost (HIG ordering).

---

## Token cross-reference

| Token | Light | Dark | Source |
|---|---|---|---|
| `--accent` | system blue / hotel brand | same | `03-color-system.md` |
| `--bg-window` | #ECECEC | #1E1E1E | window background |
| `--bg-control` | rgba(0,0,0,0.05) | rgba(255,255,255,0.08) | control surface |
| `--bg-control-elevated` | #FFFFFF | #3A3A3C | active segment |
| `--bg-input` | #FFFFFF | #1C1C1E | text field |
| `--bg-search` | rgba(0,0,0,0.06) | rgba(255,255,255,0.1) | search field |
| `--bg-popover` | rgba(255,255,255,0.72) | rgba(40,40,42,0.72) | vibrancy popover |
| `--bg-selected-content` | system accent | system accent | selected row |
| `--separator` | rgba(0,0,0,0.12) | rgba(255,255,255,0.14) | 0.5px hairlines |
| `--label-primary` | #000 | #FFF | titles |
| `--label-secondary` | rgba(0,0,0,0.55) | rgba(255,255,255,0.6) | sub-labels |
| `--label-tertiary` | rgba(0,0,0,0.35) | rgba(255,255,255,0.4) | placeholders |
| `--label-on-accent` | #FFF | #FFF | text on accent fill |
| `--material-toolbar` | see `05-materials-blur.md` | — | titlebar/toolbar |
| `--material-sidebar` | see `05-materials-blur.md` | — | sidebar/inspector |

---

## Implementation order (suggested)

1. Tokens + reset + `cocoa-window` + `cocoa-toolbar` (the shell).
2. `cocoa-btn` + `cocoa-input` + `cocoa-select` (the form basics — unblocks every screen).
3. `cocoa-search` + `cocoa-segmented` + `cocoa-switch` + `cocoa-checkbox` (toolbar + inline controls).
4. `cocoa-table` + `cocoa-split` (the reservation grid + dashboard layout).
5. `cocoa-popover` + `cocoa-sheet` + `cocoa-datepicker` (modal flows: edit booking, pick stay range).
6. `cocoa-slider` + `cocoa-stepper` (numeric inputs — rate, occupancy, pax count).

Every component must pass the 11-point Mac-nativeness checklist from `01-visual-fundamentals.md` before merging.
