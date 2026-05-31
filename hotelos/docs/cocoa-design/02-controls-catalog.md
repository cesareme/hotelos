# 02 · NSControls Catalog (Cocoa → Web)

Reference catalog of AppKit controls with appearance, dimensions, states, usage, and CSS approximations.

---

## 1. NSButton

### Variants (bezel styles)
- **Push / Rounded** (`.rounded`): default filled button, rounded corners, accent-tinted when default. Used everywhere in sheets/alerts/preferences.
- **Bordered (Big Sur+)**: gray fill, subtle border, no accent. The non-default sibling of push.
- **Borderless / Plain**: text-only, no background, used inline.
- **Textured Rounded**: minimal toolbar variant, icon-only with hover background.
- **Inline** (`.inline`): pill badge for counters in source lists.
- **Recessed** (`.recessed`): toggle-style for scope bars.
- **Help Button** (`.helpButton`): fixed-size circular `?` (≈22×22pt).
- **Disclosure Triangle** (`.disclosure`): 13×13pt rotating chevron for outlines.

Deprecated for modern apps: bevel, round, textured square ([mackuba.eu](https://mackuba.eu/2014/10/06/a-guide-to-nsbutton-styles/)).

### Dimensions (heights in points)
- **Regular**: 21–22pt (most common)
- **Small**: 17–19pt
- **Mini**: 14–15pt
- **Large** (Big Sur+): 28–32pt, for onboarding/CTAs ([Apple Forum](https://developer.apple.com/forums/thread/739201))

### States
- Default: fill = accent color (push), text white
- Hover: subtle brightness lift (toolbar buttons gain bg)
- Pressed: darken ~10%, slight inset
- Disabled: 40% opacity, no interaction
- Focus ring: 3pt outer glow, system accent at 50% alpha

### When to use
- **Push**: primary destructive/confirmation actions.
- **Bordered**: secondary actions next to push.
- **Borderless**: inline links, table-cell actions.
- **Recessed/Inline**: filtering, badges.

### CSS approximation
```css
.btn-push {
  height: 22px; padding: 0 14px;
  border-radius: 5px; border: 0;
  background: var(--accent, #007AFF); color: white;
  font: 13px/1 -apple-system, "SF Pro Text";
  box-shadow: 0 1px 0 rgba(0,0,0,.04);
}
.btn-push:hover  { filter: brightness(1.05); }
.btn-push:active { filter: brightness(.92); }
.btn-push:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 50%, transparent); outline-offset: 1px; }
.btn-push:disabled { opacity: .4; pointer-events: none; }
```

---

## 2. NSPopUpButton vs NSComboBox

### Appearance
- **NSPopUpButton**: closed dropdown with double-chevron (⌃⌄) on the right, accent-tinted edge. Pure menu.
- **NSComboBox**: text field with single down-chevron — you can **type** OR pick.

### Dimensions
Both follow control-size system: **22pt** regular / 19pt small / 15pt mini ([Apple HIG legacy](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGControls/XHIGControls.html)).

### States
Same as NSButton plus an **open** state (menu floats below with shadow + vibrancy). NSComboBox shows a blinking caret when focused.

### When to use
- **NSPopUpButton**: closed list of options, no custom values (country selector, status).
- **NSComboBox**: suggested values + free entry (recent searches, font sizes) ([Apple docs](https://developer.apple.com/documentation/appkit/nscombobox)).

### CSS approximation
```css
.popup {
  appearance: none;
  height: 22px; padding: 0 24px 0 8px;
  border-radius: 5px; border: 1px solid rgba(0,0,0,.15);
  background: #fff url("data:image/svg+xml,...chevrons...") no-repeat right 6px center / 10px;
}
.combo { /* same, but it's an <input> with a <datalist> */ }
```

---

## 3. NSTextField / NSSearchField

### Variants
- **NSTextField (bezeled)**: white fill, 1pt gray border, sharp corners (radius ≈ 3pt).
- **NSTextField (rounded)**: pill ends, used for inline forms.
- **NSSearchField**: rounded rectangle, magnifying glass leading, clear-button trailing.

### Dimensions
- Height: **21–22pt** regular / 19pt small / 15pt mini.
- Search field corner radius: **5pt** continuous; icon **12×12** at 80% opacity ([Full Stack Stanley](https://www.fullstackstanley.com/articles/replicating-the-macos-search-textfield-in-swiftui/)).

### States
- Default: white bg, gray 1pt border
- Focus: 3pt accent glow ring (`accent @ 70%`), border thickens
- Disabled: gray text, no caret
- Placeholder: secondaryLabelColor (≈ 60% gray)

### When to use
- **Bezeled**: forms.
- **Rounded**: inline filters, toolbar.
- **Search field**: when there's a magnifying glass + clear-on-type behavior.

### CSS approximation
```css
.field {
  height: 22px; padding: 0 8px;
  border: 1px solid rgba(0,0,0,.15);
  border-radius: 5px; background: #fff;
  font: 13px/1 -apple-system;
}
.field:focus { outline: 3px solid color-mix(in srgb, var(--accent) 70%, transparent); border-color: var(--accent); }
.search-field { padding-left: 24px;
  background: #fff url('magnifier.svg') no-repeat 6px center / 12px; border-radius: 5px; }
```

---

## 4. NSSegmentedControl

### Variants ([Apple docs](https://developer.apple.com/documentation/appkit/nssegmentedcontrol/style))
- **Rounded** (`.rounded`): default, contiguous segments, divider lines.
- **Separated** (`.separated`): each segment is a standalone capsule with gaps — modern toolbar look.
- **Capsule** (`.capsule`): rounded pill.
- **SmallSquare** (`.smallSquare`): below table views.
- **Textured Rounded / Square**: legacy.

### Dimensions
Same control-size scale: 22 / 19 / 15pt. Segment min-width ≈ 24pt.

### States
- Default: light fill, dark text
- Selected: accent-tinted background, white text
- Hover: subtle 5% darken
- Disabled: 40% opacity
- Focus: ring around whole control

### When to use
- **Rounded**: 2–5 mutually exclusive views (Files / Mail / Calendar tabs).
- **Separated**: toolbars where each action is independent (multi-select).
- **SmallSquare**: gradient-style add/remove below lists.

### CSS approximation
```css
.seg { display: inline-flex; height: 22px; border-radius: 5px;
       background: rgba(0,0,0,.06); padding: 2px; gap: 2px; }
.seg button { flex: 1; min-width: 24px; padding: 0 10px; border: 0;
              border-radius: 4px; background: transparent; font: 13px/1 -apple-system; }
.seg button[aria-selected="true"] { background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
```

---

## 5. NSStepper

### Appearance
Vertically stacked up/down arrows, 13pt wide × 22pt tall. Almost always paired with NSTextField to form a number input ([Apple docs](https://developer.apple.com/documentation/appkit/nsstepper)).

### States
Pressed half lights up; auto-repeat after ~400ms hold; disabled = 40% opacity.

### When to use
Bounded integer/float input (quantity, opacity %). Avoid for unbounded values — use plain text field.

### CSS approximation
```css
.stepper { display: inline-flex; flex-direction: column; width: 13px; height: 22px; }
.stepper button { flex: 1; border: 1px solid rgba(0,0,0,.15); background: #fafafa; }
.stepper button:first-child { border-radius: 3px 3px 0 0; }
.stepper button:last-child  { border-radius: 0 0 3px 3px; border-top: 0; }
```

---

## 6. NSDatePicker

### Variants ([Apple docs](https://developer.apple.com/documentation/appkit/nsdatepicker/style))
- **Textual** (`.textField`): compact stepper-driven `MM/DD/YYYY` — pairs with stepper.
- **Textual+Stepper** (`.textFieldAndStepper`): same with up/down arrows.
- **Graphical** (`.clockAndCalendar`): full calendar grid + analog clock face. ~140×148pt.

### When to use
- **Textual**: forms with limited space, single-date.
- **Graphical**: when users browse months, pick ranges, or expect calendar.

### CSS approximation
Textual = `<input type="date">` styled like NSTextField. Graphical = library (FullCalendar) or build with CSS grid for the month and an SVG clock.

---

## 7. NSSlider

### Variants ([Apple docs](https://developer.apple.com/documentation/appkit/nsslider))
- **Linear horizontal**: thin 4pt track, 17pt circular knob with shadow.
- **Linear vertical**: same rotated.
- **Linear with tick marks**: tick lines above/below.
- **Circular** (`NSCircularSlider`): 19×19pt dial, indicator dot rotates.

### States
- Default: light track, accent fill from min to knob position
- Pressed: knob enlarges slightly, drops shadow
- Disabled: full track grayed, no fill
- Focus: accent glow around knob

### When to use
- **Linear**: continuous ranges (volume, opacity).
- **Circular**: angular values (rotation, hue).
- Add tick marks when values snap to discrete steps.

### CSS approximation
```css
input[type="range"].slider {
  -webkit-appearance: none; height: 17px; background: transparent;
}
.slider::-webkit-slider-runnable-track { height: 4px; border-radius: 2px;
  background: linear-gradient(to right, var(--accent) var(--pct, 50%), rgba(0,0,0,.1) 0); }
.slider::-webkit-slider-thumb { -webkit-appearance: none; width: 17px; height: 17px;
  border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); margin-top: -6px; }
```

---

## 8. NSSwitch vs Checkbox (NSButton .switch)

### Appearance
- **NSSwitch** (Catalina+, iOS-style): pill 32×16pt (small) / 38×22pt (default). Track + sliding knob.
- **Checkbox**: 14×14pt square with checkmark glyph ✓ when on. Always paired with a trailing label.

### States
- Switch off: gray track, knob left
- Switch on: accent-tinted track, knob right
- Mixed (checkbox only): dash glyph `−`
- Disabled: 40% opacity
- Focus: accent ring on knob (switch) or whole square (checkbox)

### When to use ([HIG guidance](https://developer.apple.com/documentation/appkit/nsswitch))
- **NSSwitch**: heavy toggles for whole sections (Wi-Fi on/off, iCloud sync). Apply immediately.
- **Checkbox**: list of binary options ("Remember me", "Send analytics"), modal forms where state applies on Save. Cheaper visually, denser in lists.

### CSS approximation
```css
/* Switch */
.switch { position: relative; width: 38px; height: 22px; border-radius: 11px;
          background: rgba(0,0,0,.15); transition: background .15s; }
.switch[aria-checked="true"] { background: var(--accent); }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px;
                 width: 18px; height: 18px; border-radius: 50%; background: #fff;
                 box-shadow: 0 1px 2px rgba(0,0,0,.2); transition: left .15s; }
.switch[aria-checked="true"]::after { left: 18px; }

/* Checkbox */
.check { width: 14px; height: 14px; border-radius: 3px;
         border: 1px solid rgba(0,0,0,.25); background: #fff; }
.check[aria-checked="true"] { background: var(--accent); border-color: var(--accent);
         background-image: url('checkmark.svg'); background-size: 10px; background-repeat: no-repeat; background-position: center; }
```

---

## Universal notes

- **Control sizes** scale fonts: 13pt (regular), 11pt (small), 9pt (mini).
- **Focus rings**: always `accent @ ~50–70% alpha`, 3pt wide, 1pt outset.
- **Disabled**: uniformly `opacity: 0.4` + `pointer-events: none`.
- **Accent color**: respect user choice (`AppleHighlightColor`); web equivalent is `accent-color` CSS property.

## Sources
- [A guide to NSButton styles – mackuba.eu](https://mackuba.eu/2014/10/06/a-guide-to-nsbutton-styles/)
- [Apple Developer: NSButton.BezelStyle](https://developer.apple.com/documentation/appkit/nsbutton/bezelstyle)
- [Apple Developer: NSPopUpButton](https://developer.apple.com/documentation/appkit/nspopupbutton)
- [Apple Developer: NSComboBox](https://developer.apple.com/documentation/appkit/nscombobox)
- [Apple Developer: NSSearchField](https://developer.apple.com/documentation/appkit/nssearchfield)
- [Apple Developer: NSSegmentedControl.Style](https://developer.apple.com/documentation/appkit/nssegmentedcontrol/style)
- [Apple Developer: NSStepper](https://developer.apple.com/documentation/appkit/nsstepper)
- [Apple Developer: NSDatePicker.Style](https://developer.apple.com/documentation/appkit/nsdatepicker/style)
- [Apple Developer: NSSlider](https://developer.apple.com/documentation/appkit/nsslider)
- [Apple Developer: NSSwitch](https://developer.apple.com/documentation/appkit/nsswitch)
- [Full Stack Stanley: Replicating macOS Search TextField](https://www.fullstackstanley.com/articles/replicating-the-macos-search-textfield-in-swiftui/)
- [Apple HIG legacy: control dimensions](https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGControls/XHIGControls.html)
- [Apple Developer Forum: HIG button sizes](https://developer.apple.com/forums/thread/739201)
