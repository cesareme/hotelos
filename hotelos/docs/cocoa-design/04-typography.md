# macOS Typography — SF Pro System & Web Adaptation

Source-of-truth reference for the San Francisco type system on macOS (Sonoma 14.4 / Sequoia 15) and its web adaptation. SF Pro is a *family*, not a font — picking the wrong variant is the biggest mistake when porting Apple UI to the web.

---

## 1. The San Francisco Family — Four Faces, One System

| Face | Optical role | When to use |
|---|---|---|
| **SF Pro Text** | 6 weights, 19pt and below | Body, captions, labels, controls. Larger apertures, looser tracking, dot of `i` set closer to stem for small-size legibility. |
| **SF Pro Display** | 9 weights, 20pt and above | Titles, large headlines, hero text. Tighter tracking, more refined letterforms. |
| **SF Mono** | 6 weights, monospaced | Code, numeric tables when alignment > density, terminals, Xcode. |
| **SF Pro Rounded** | 9 weights, rounded terminals | Friendly / playful contexts: Fitness rings, kids apps, AirPods marketing. Avoid for dense business UI. |

**Critical rule:** macOS swaps Text ↔ Display automatically at **20pt** when you ask for `NSFont.systemFont(ofSize:)`. Design tools (Figma, Sketch) and the web do **not** — you must choose manually or rely on the `opsz` variable axis.

SF Pro also ships **three widths** (added 2022): Condensed, Compressed, Expanded — for badges and chrome where horizontal space is constrained. Use sparingly.

---

## 2. macOS HIG Text Styles — Default Sizes & Weights

These are the eleven semantic styles exposed via `NSFont.preferredFont(forTextStyle:)`. Sizes shown are the **macOS large** (default) content-size category. iOS uses different defaults (e.g. iOS `largeTitle` = 34pt, macOS = 26pt) — do not copy iOS specs into a macOS app.

| Text Style | Size (pt) | Weight | Line Height (pt) | Emphasized Weight |
|---|---|---|---|---|
| `largeTitle` | 26 | Regular | 32 | Bold |
| `title1` | 22 | Regular | 26 | Bold |
| `title2` | 17 | Regular | 22 | Bold |
| `title3` | 15 | Regular | 20 | Semibold |
| `headline` | 13 | **Bold** | 16 | Heavy |
| `body` | 13 | Regular | 16 | Semibold |
| `callout` | 12 | Regular | 15 | Semibold |
| `subheadline` | 11 | Regular | 14 | Semibold |
| `footnote` | 10 | Regular | 13 | Semibold |
| `caption1` | 10 | Regular | 13 | Medium |
| `caption2` | 10 | Medium | 13 | Semibold |

Notes:
- `headline` is the *only* style bold by default — it is the workhorse for cell titles and list-row primary text.
- All styles ≤19pt resolve to **SF Pro Text**; only `largeTitle` and `title1` resolve to **SF Pro Display**.
- Line heights here are tight HIG defaults (~1.20–1.30 ratio). For long-form prose, multiply by 1.4–1.5.
- macOS does **not** ship full Dynamic Type like iOS; instead it scales chrome via System Settings → Display → Larger Text.

---

## 3. OpenType Font Features — Numerics, Caps, Alternates

SF Pro exposes a rich OpenType feature set. Enable via `NSFontDescriptor.featureSettings` on AppKit or `font-feature-settings` on CSS.

### Tabular numbers (`tnum`) — REQUIRED for metrics
By default SF Pro uses **proportional** figures (1 is narrower than 8). In any UI where numbers *change* — counters, prices, KPIs, table columns, timers, occupancy %, RevPAR — switch to tabular so digits don't shimmy:

```css
font-variant-numeric: tabular-nums;
/* or low-level: */
font-feature-settings: "tnum" 1;
```

Apple's guidance: **monospaced for animation, proportional for static**. A hotel dashboard with live KPIs is almost entirely the former.

### Small caps (`smcp`, `c2sc`)
SF Pro ships true small caps (not faked from uppercase). Use for legal text, status labels in cards, eyebrow text:
```css
font-feature-settings: "smcp" 1, "c2sc" 1;
```

### Contextual alternates (`calt`)
Enabled by default in SF Pro — handles automatic letter substitution in pairs like `f` + `i`. Do not disable.

### Other useful tags
- `case` — punctuation positioning for ALL-CAPS strings (commas, quotes raise)
- `frac` — auto fractions (1/2 → ½)
- `sups` / `subs` — superior / inferior numerals (m², H₂O)
- `ss01`–`ss20` — stylistic sets: SS01 is the slashed-zero / open-four variant (great for code or numeric tables).

---

## 4. Web Fallback Stack — Faithful & Cross-Platform

The native system font is unreachable on the web without bundling. Use the standard cascade so each OS picks its own system face, with **Inter** as the closest free fallback (near-identical x-height and metrics to SF Pro Text).

```css
:root {
  --font-system:
    system-ui,
    -apple-system,            /* Safari macOS/iOS legacy alias */
    BlinkMacSystemFont,       /* Chrome macOS legacy alias */
    "SF Pro Text",            /* explicit if licensed/bundled */
    "Inter",                  /* near drop-in substitute */
    "Segoe UI",               /* Windows */
    Roboto,                   /* Android / ChromeOS */
    "Helvetica Neue",
    Arial,
    sans-serif;

  --font-mono:
    ui-monospace,
    "SF Mono",
    "JetBrains Mono",
    Menlo,
    Consolas,
    monospace;
}
```

Key gotchas:
- `system-ui` is the modern keyword and should appear *first*. Keep `-apple-system` and `BlinkMacSystemFont` for Safari < 14 / Chrome < 56 compatibility.
- There is a long-standing **Chromium bug** where `font-weight` does not apply correctly to `BlinkMacSystemFont` for weights 100–500 — pinning Inter as a same-metric fallback sidesteps it.
- SF Pro is not licensed for general web use; bundling requires the Apple Font Licensing Agreement and is only permitted on Apple platforms / Apple-platform docs.
- For pure marketing pages where licensing is in doubt, **Inter** at the same size/weight is visually indistinguishable to ~95% of users.

---

## 5. CSS Recommendations — Variable Axes & Features

SF Pro on macOS ships as a **variable font** with axes: `wght` (100–900), `wdth` (75–125), `opsz` (9–144), and Apple's registered `GRAD` (grade — adjusts stroke weight without changing letter width — perfect for dark-mode optical compensation).

```css
.kpi-value {
  font-family: var(--font-system);
  font-size: 28px;
  font-optical-sizing: auto;           /* lets opsz pick automatically */
  font-variation-settings: "wght" 590, /* between semibold & bold */
                           "opsz" 28;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "ss01" 1;     /* slashed zero */
  letter-spacing: -0.01em;             /* SF tightens slightly at display */
}

@media (prefers-color-scheme: dark) {
  .kpi-value {
    /* Grade trick: heavier strokes in dark mode without re-flowing */
    font-variation-settings: "wght" 590, "opsz" 28, "GRAD" 50;
  }
}
```

Defaults the design system should ship:

```css
body {
  font-family: var(--font-system);
  font-size: 13px;                  /* body */
  line-height: 16px;
  font-weight: 400;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
```

`-webkit-font-smoothing: antialiased` is mandatory on macOS Safari to match the native AppKit grayscale rendering — without it, Chrome renders SF noticeably heavier than the OS.

---

## 6. Quick Reference for the Hotel OS

| Use case | Style | Spec |
|---|---|---|
| Dashboard KPI value (e.g. RevPAR €248) | custom display | SF Display 28/32, weight 600, `tnum`, `ss01` |
| KPI label ("ADR last 7d") | `caption1` upper | 10pt Medium, `smcp` + `tracking 0.06em` |
| Booking row guest name | `headline` | 13pt Bold |
| Booking row metadata | `subheadline` | 11pt Regular, `secondaryLabelColor` |
| Inline price in narrative | `body` | 13pt Regular, **proportional** nums |
| Sidebar section title | `subheadline` | 11pt Semibold, uppercase, `tracking 0.04em` |
| Code / IDs / confirmation codes | SF Mono | 12pt Regular |

---

## Sources

- [Apple Developer — Fonts](https://developer.apple.com/fonts/)
- [Apple HIG — Typography](https://developer.apple.com/design/human-interface-guidelines/typography)
- [WWDC22 — Meet the expanded San Francisco family](https://developer.apple.com/videos/play/wwdc2022/110381/)
- [WWDC20 — The details of UI typography](https://developer.apple.com/videos/play/wwdc2020/10175/)
- [Jim Nielsen — Design Principles Applied to the SF Fonts](https://blog.jim-nielsen.com/2019/design-principles-applied-to-sf-fonts/)
- [Vidit B — San Francisco: Understanding the Features](https://blog.viditb.com/san-francisco-understanding-the-features/)
- [Chris Coyier — SF as a Variable Font](https://chriscoyier.net/2022/08/02/actually-the-san-francisco-typeface-does-ship-as-a-variable-font/)
- [MDN — font-variation-settings](https://developer.mozilla.org/en-US/docs/Web/CSS/font-variation-settings)
- [MDN — font-variant-numeric](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/font-variant-numeric)
- [CSS-Tricks — System Font Stack](https://css-tricks.com/snippets/css/system-font-stack/)
- [Bram.us — Chrome vs BlinkMacSystemFont workaround](https://www.bram.us/2020/04/24/chrome-vs-blinkmacsystemfont-a-workaround/)
- [Apple Developer — NSFont.TextStyle](https://developer.apple.com/documentation/appkit/nsfont/textstyle)
- [Microsoft Typography — OpenType registered features](https://learn.microsoft.com/en-us/typography/opentype/spec/features_pt)
