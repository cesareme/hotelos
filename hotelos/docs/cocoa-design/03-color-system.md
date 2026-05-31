# macOS Color System — Semantic, Accent & Web Adaptation

Source-of-truth reference for adapting the native macOS color system (AppKit / NSColor) to a web stack via CSS custom properties. Values reflect macOS Sonoma 14.4 / Sequoia 15 catalog colors.

---

## 1. Philosophy: Semantic Over Literal

Apple's guidance: **never hardcode hex values for UI chrome**. Use NSColor *semantic* tokens (e.g. `labelColor`) — they adapt automatically to:

- Light / Dark appearance
- Vibrant / non-vibrant backgrounds (sidebars, popovers)
- Increased Contrast accessibility setting
- Color Filters / accent overrides

Hardcoding literal RGB defeats every one of those behaviors. The web port should mirror this with CSS variables driven by `prefers-color-scheme`, `prefers-contrast`, and an accent-color token.

---

## 2. Label Colors (Text Hierarchy)

The `*LabelColor` family is the primary tool for **text on standard backgrounds**. They are expressed as black/white with descending alpha — meaning they auto-blend over any underlying material.

| Token | Light (RGBA) | Dark (RGBA) | Use |
|---|---|---|---|
| `labelColor` | `0,0,0,0.85` | `255,255,255,0.85` | Primary body text, titles |
| `secondaryLabelColor` | `0,0,0,0.50` | `255,255,255,0.55` | Subtitles, captions |
| `tertiaryLabelColor` | `0,0,0,0.26` | `255,255,255,0.25` | Disabled text, placeholders |
| `quaternaryLabelColor` | `0,0,0,0.10` | `255,255,255,0.10` | Watermarks, faintest hints |
| `textColor` | `#000000` | `#FFFFFF` | Solid text in fields |
| `placeholderTextColor` | `0,0,0,0.25` | `255,255,255,0.25` | NSTextField placeholder |
| `linkColor` | `#0068DA` | `#419CFF` | Hyperlinks |

---

## 3. Backgrounds & Fills

| Token | Light (hex) | Dark (hex) | Use |
|---|---|---|---|
| `windowBackgroundColor` | `#ECECEC` | `#323232` | Default window chrome |
| `controlBackgroundColor` | `#FFFFFF` | `#1E1E1E` | Scroll views, list backdrops |
| `textBackgroundColor` | `#FFFFFF` | `#1E1E1E` | NSTextField / editable areas |
| `underPageBackgroundColor` | `#969696` | `#282828` | Behind paged docs |
| `gridColor` | `#E6E6E6` | `#1A1A1A` | NSTableView grid lines |
| `controlColor` | `#FFFFFF` | `255,255,255,0.25` | Default control fill |

---

## 4. Separators

| Token | Light (RGBA) | Dark (RGBA) |
|---|---|---|
| `separatorColor` | `0,0,0,0.10` | `255,255,255,0.10` |

Always 1px / hairline. On Retina, use `0.5px` or `border-width: thin`.

---

## 5. Selection Colors

| Token | Light (hex) | Dark (hex) | Use |
|---|---|---|---|
| `selectedContentBackgroundColor` | `#0064E1` | `#0059D1` | Selected row in list/table (key window) |
| `unemphasizedSelectedContentBackgroundColor` | `#DCDCDC` | `#464646` | Selected row when window not key |
| `selectedTextBackgroundColor` | `#B3D7FF` | `#3F638B` | Text selection highlight |
| `keyboardFocusIndicatorColor` | `0,103,244,0.5` | `26,169,255,0.5` | Focus ring (3px outer glow) |
| `findHighlightColor` | `#FFFF00` | `#FFFF00` | Find-bar matches |

Note: `selectedContentBackgroundColor` follows the **system accent**. When user picks Graphite, it becomes `#7F7F7F`.

---

## 6. Accent Color System (Sequoia / Sonoma)

Set in **System Settings → Appearance → Accent color**. Eight presets + Multicolor (per-app default, usually Blue) + custom picker.

| Accent | Light (hex) | Dark (hex) |
|---|---|---|
| Blue (default) | `#007AFF` | `#0A84FF` |
| Purple | `#A550A7` | `#BF5AF2` |
| Pink | `#F74F9E` | `#FF6FB3` |
| Red | `#FF3B30` | `#FF453A` |
| Orange | `#F7821B` | `#FF9F0A` |
| Yellow | `#FFC600` | `#FFD60A` |
| Green | `#62BA46` | `#32D74B` |
| Graphite | `#8C8C8C` | `#8E8E93` |
| Multicolor | follows app default (usually Blue) | — |

Programmatically the current choice surfaces as **`controlAccentColor`**. Apple's guidance: use `controlAccentColor` for any custom control mimicking a system bezel/button so it tracks the user preference. *Do not* hardcode `#007AFF`.

Bonus: `selectedMenuItemColor` and `keyboardFocusIndicatorColor` both derive from the accent.

---

## 7. System Colors (Tint Palette)

These are absolute brand tints (used for status badges, icons, NOT chrome). They have tiny light/dark variants.

| Token | Light | Dark |
|---|---|---|
| `systemRedColor` | `#FF3B30` | `#FF453A` |
| `systemOrangeColor` | `#FF9500` | `#FF9F0A` |
| `systemYellowColor` | `#FFCC00` | `#FFD60A` |
| `systemGreenColor` | `#28CD41` | `#32D74B` |
| `systemMintColor` | `#00C7BE` | `#63E6E2` |
| `systemTealColor` | `#59ADC4` | `#6AC4DC` |
| `systemCyanColor` | `#55BEF0` | `#5AC8F5` |
| `systemBlueColor` | `#007AFF` | `#0A84FF` |
| `systemIndigoColor` | `#5856D6` | `#5E5CE6` |
| `systemPurpleColor` | `#AF52DE` | `#BF5AF2` |
| `systemPinkColor` | `#FF2D55` | `#FF375F` |
| `systemBrownColor` | `#A2845E` | `#AC8E68` |
| `systemGrayColor` | `#8E8E93` | `#98989D` |

---

## 8. Web Adaptation — CSS Custom Properties

Mirror the semantic structure. Drive light/dark via `prefers-color-scheme`, accent via a single token so user-themeable later.

```css
:root {
  /* Accent — overridable per user */
  --system-accent:            #007AFF;
  --system-accent-selected:   #0064E1;

  /* Labels (alpha over background) */
  --system-label:             rgba(0,0,0,0.85);
  --system-label-secondary:   rgba(0,0,0,0.50);
  --system-label-tertiary:    rgba(0,0,0,0.26);
  --system-label-quaternary:  rgba(0,0,0,0.10);

  /* Backgrounds */
  --system-window-bg:         #ECECEC;
  --system-control-bg:        #FFFFFF;
  --system-text-bg:           #FFFFFF;
  --system-grid:              #E6E6E6;

  /* Separators */
  --system-separator:         rgba(0,0,0,0.10);

  /* Selection */
  --system-selection-bg:      var(--system-accent-selected);
  --system-selection-text-bg: #B3D7FF;
  --system-focus-ring:        rgba(0,103,244,0.5);

  /* Link */
  --system-link:              #0068DA;
}

@media (prefers-color-scheme: dark) {
  :root {
    --system-accent:            #0A84FF;
    --system-accent-selected:   #0059D1;
    --system-label:             rgba(255,255,255,0.85);
    --system-label-secondary:   rgba(255,255,255,0.55);
    --system-label-tertiary:    rgba(255,255,255,0.25);
    --system-label-quaternary:  rgba(255,255,255,0.10);
    --system-window-bg:         #323232;
    --system-control-bg:        #1E1E1E;
    --system-text-bg:           #1E1E1E;
    --system-grid:              #1A1A1A;
    --system-separator:         rgba(255,255,255,0.10);
    --system-selection-text-bg: #3F638B;
    --system-focus-ring:        rgba(26,169,255,0.5);
    --system-link:              #419CFF;
  }
}

@media (prefers-contrast: more) {
  :root {
    --system-label:            rgba(0,0,0,1);
    --system-separator:        rgba(0,0,0,0.30);
  }
}
```

### Usage
```css
.list-row             { background: var(--system-control-bg); color: var(--system-label); }
.list-row[aria-selected="true"] { background: var(--system-selection-bg); color: #fff; }
.list-row + .list-row { border-top: 1px solid var(--system-separator); }
.button-primary       { background: var(--system-accent); color: #fff; }
button:focus-visible  { outline: 3px solid var(--system-focus-ring); outline-offset: 1px; }
```

### Accent-aware native handoff
Modern browsers honor CSS `accent-color`. Wire it to your token so checkboxes/radios/range pick up the user's choice:
```css
:root { accent-color: var(--system-accent); }
```

For Electron / WKWebView shells, query `NSColor.controlAccentColor` on launch and inject as `--system-accent` so the web layer tracks System Settings live.

---

## Sources

- Apple Developer — [`NSColor`](https://developer.apple.com/documentation/appkit/nscolor)
- Apple Developer — [`labelColor`](https://developer.apple.com/documentation/appkit/nscolor/1534657-labelcolor) / [`secondaryLabelColor`](https://developer.apple.com/documentation/appkit/nscolor/1533254-secondarylabelcolor)
- Apple Developer — [`controlAccentColor`](https://developer.apple.com/documentation/AppKit/NSColor/controlAccentColor) / [`separatorColor`](https://developer.apple.com/documentation/AppKit/NSColor/separatorColor) / [`windowBackgroundColor`](https://developer.apple.com/documentation/appkit/nscolor/1528630-windowbackgroundcolor)
- Apple HIG — [Color (macOS)](https://developer.apple.com/design/human-interface-guidelines/color)
- Catalog dump (Sonoma 14.4) — [martinhoeller gist](https://gist.github.com/martinhoeller/38509f37d42814526a9aecbb24928f46)
- Semantic reference — [iccir gist](https://gist.github.com/iccir/b2601d4c9b1ae3a31651b3a25124f9e8)
- System color extractor — [andrejilderda gist](https://gist.github.com/andrejilderda/8677c565cddc969e6aae7df48622d47c)
- AbilityNet — [Change accent color in macOS 15 Sequoia](https://mcmw.abilitynet.org.uk/how-to-change-the-system-accent-colour-in-macos-15-sequoia)
- AllThings.how — [System font & accent colors macOS 15](https://allthings.how/change-the-system-font-and-accent-colors-in-macos-15/)
- WWDC 2018 — [Introducing Dark Mode](https://nonstrict.eu/wwdcindex/wwdc2018/210/)
- mackuba.eu — [Dark Side of the Mac: Updating Your App](https://mackuba.eu/2018/07/10/dark-side-mac-2/)
