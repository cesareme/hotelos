# HotelOS Cocoa Edition — Design Tokens Spec

Definitive CSS custom properties consolidating the macOS Sequoia / Cocoa research (`03-color-system.md`, `04-typography.md`, `05-materials-blur.md`, `06-motion.md`). All values are production-ready and side-by-side for light + dark appearance.

Token namespace: `--cocoa-*`. Tokens consumed via `var()` only — never hardcode hex/px/ms in components.

---

## 0. Scaffolding

Two appearance scopes: `:root` carries light defaults, `[data-appearance="dark"]` (and `@media (prefers-color-scheme: dark)`) overrides. The data-attribute wins so the user can force a mode from the menu bar like macOS does.

```css
:root { color-scheme: light; }
[data-appearance="dark"],
[data-appearance="dark"] :where(*) { color-scheme: dark; }

@media (prefers-color-scheme: dark) {
  :root:not([data-appearance="light"]) { color-scheme: dark; }
}
```

---

## 1. Colors

All semantic label colors are encoded as `rgb(... / <alpha>)` matching AppKit's `labelColor` / `secondaryLabelColor` / `tertiaryLabelColor` / `quaternaryLabelColor` exact opacity (85% / 50% / 26% / 10%). Backgrounds use Apple's published windowBackground / underPageBackground values from Sequoia.

### 1.1 Light tokens (`:root`)

```css
:root {
  /* Labels — rgb(0,0,0) with AppKit alpha */
  --cocoa-label:               rgb(0 0 0 / 0.85);
  --cocoa-label-secondary:     rgb(0 0 0 / 0.50);
  --cocoa-label-tertiary:      rgb(0 0 0 / 0.26);
  --cocoa-label-quaternary:    rgb(0 0 0 / 0.10);

  /* Backgrounds */
  --cocoa-background-window:    #ECECEC;  /* windowBackgroundColor */
  --cocoa-background-content:   #FFFFFF;  /* textBackgroundColor / contentBackgroundColor */
  --cocoa-background-sidebar:   #E8E8E8;  /* sidebar material base (pre-blur) */
  --cocoa-background-toolbar:   rgb(246 246 246 / 0.72); /* titlebar/toolbar pre-blur */
  --cocoa-background-control:   #FFFFFF;  /* controlBackgroundColor */
  --cocoa-background-selection: #0064E1;  /* selectedContentBackgroundColor (Apple Blue) */

  /* Separators */
  --cocoa-separator:            rgb(0 0 0 / 0.10);   /* separatorColor */
  --cocoa-separator-opaque:     #C6C6C8;             /* fallback when alpha not allowed */

  /* Accent — controlAccentColor (Apple Blue / Sequoia) */
  --cocoa-accent:               #0064E1;
  --cocoa-accent-hover:         #0055C4;
  --cocoa-accent-pressed:       #0047A6;
  --cocoa-accent-contrast:      #FFFFFF;

  /* Status — Sequoia system tints */
  --cocoa-success:              #28A745;  /* systemGreen */
  --cocoa-warning:              #FF9500;  /* systemOrange */
  --cocoa-danger:               #FF3B30;  /* systemRed */
  --cocoa-info:                 #007AFF;  /* systemBlue (informational, distinct from accent) */

  /* Focus ring */
  --cocoa-focus-ring:           rgb(0 100 225 / 0.50); /* keyboardFocusIndicatorColor */

  /* Find highlight */
  --cocoa-find-highlight:       #FFFF00;
}
```

### 1.2 Dark tokens

```css
[data-appearance="dark"],
@media (prefers-color-scheme: dark) {
  :root:not([data-appearance="light"]) {
    /* Labels — rgb(255,255,255) with AppKit alpha */
    --cocoa-label:               rgb(255 255 255 / 0.85);
    --cocoa-label-secondary:     rgb(255 255 255 / 0.55);
    --cocoa-label-tertiary:      rgb(255 255 255 / 0.25);
    --cocoa-label-quaternary:    rgb(255 255 255 / 0.10);

    /* Backgrounds */
    --cocoa-background-window:    #323232;  /* windowBackgroundColor dark */
    --cocoa-background-content:   #1E1E1E;  /* textBackgroundColor dark */
    --cocoa-background-sidebar:   #2A2A2A;  /* sidebar dark base */
    --cocoa-background-toolbar:   rgb(40 40 40 / 0.72);
    --cocoa-background-control:   #3A3A3C;  /* controlBackgroundColor dark */
    --cocoa-background-selection: #0A84FF;  /* selectedContentBackgroundColor dark */

    /* Separators */
    --cocoa-separator:            rgb(255 255 255 / 0.10);
    --cocoa-separator-opaque:     #38383A;

    /* Accent */
    --cocoa-accent:               #0A84FF;  /* dark variant of Apple Blue */
    --cocoa-accent-hover:         #2E95FF;
    --cocoa-accent-pressed:       #006FE0;
    --cocoa-accent-contrast:      #FFFFFF;

    /* Status — dark variants */
    --cocoa-success:              #30D158;
    --cocoa-warning:              #FF9F0A;
    --cocoa-danger:               #FF453A;
    --cocoa-info:                 #0A84FF;

    /* Focus */
    --cocoa-focus-ring:           rgb(10 132 255 / 0.60);

    /* Find highlight */
    --cocoa-find-highlight:       #FFCC00;
  }
}
```

### 1.3 Side-by-side reference table

| Token | Light | Dark |
|---|---|---|
| `--cocoa-label` | `rgb(0 0 0 / .85)` | `rgb(255 255 255 / .85)` |
| `--cocoa-label-secondary` | `rgb(0 0 0 / .50)` | `rgb(255 255 255 / .55)` |
| `--cocoa-label-tertiary` | `rgb(0 0 0 / .26)` | `rgb(255 255 255 / .25)` |
| `--cocoa-label-quaternary` | `rgb(0 0 0 / .10)` | `rgb(255 255 255 / .10)` |
| `--cocoa-background-window` | `#ECECEC` | `#323232` |
| `--cocoa-background-content` | `#FFFFFF` | `#1E1E1E` |
| `--cocoa-background-sidebar` | `#E8E8E8` | `#2A2A2A` |
| `--cocoa-background-toolbar` | `rgb(246 246 246 / .72)` | `rgb(40 40 40 / .72)` |
| `--cocoa-background-control` | `#FFFFFF` | `#3A3A3C` |
| `--cocoa-background-selection` | `#0064E1` | `#0A84FF` |
| `--cocoa-separator` | `rgb(0 0 0 / .10)` | `rgb(255 255 255 / .10)` |
| `--cocoa-accent` | `#0064E1` | `#0A84FF` |
| `--cocoa-success` | `#28A745` | `#30D158` |
| `--cocoa-warning` | `#FF9500` | `#FF9F0A` |
| `--cocoa-danger` | `#FF3B30` | `#FF453A` |
| `--cocoa-info` | `#007AFF` | `#0A84FF` |

### 1.4 Native handoff

```css
:root {
  accent-color: var(--cocoa-accent);          /* native form controls */
  caret-color:  var(--cocoa-accent);          /* text caret matches */
  color:        var(--cocoa-label);
  background:   var(--cocoa-background-window);
}

::selection { background: var(--cocoa-background-selection); color: #fff; }
```

For Electron / WKWebView wrappers: inject the live `controlAccentColor` on `NSSystemColorsDidChangeNotification` by setting `document.documentElement.style.setProperty('--cocoa-accent', hex)`. The accent then propagates through every component via the cascade.

---

## 2. Typography

Per `04-typography.md`: SF Pro Text under 20pt, SF Pro Display at or above 20pt, SF Mono for code/codes. macOS auto-swaps; the web does not — we encode the swap into the type scale by selecting the family the moment a token crosses 20px.

### 2.1 Family stacks

```css
:root {
  --cocoa-font-family:
    "SF Pro Text", system-ui, -apple-system, BlinkMacSystemFont,
    "Helvetica Neue", "Inter", "Segoe UI", Roboto, sans-serif;

  --cocoa-font-display:
    "SF Pro Display", system-ui, -apple-system, BlinkMacSystemFont,
    "Helvetica Neue", "Inter", "Segoe UI", Roboto, sans-serif;

  --cocoa-font-mono:
    "SF Mono", ui-monospace, "Menlo", "Monaco",
    "JetBrains Mono", "Cascadia Code", Consolas, monospace;

  --cocoa-font-rounded:
    "SF Pro Rounded", system-ui, -apple-system, "Nunito", sans-serif;
}
```

### 2.2 Sizes (macOS HIG defaults, not iOS)

```css
:root {
  --cocoa-fs-large-title: 26px;  /* line-height 32px, Display family */
  --cocoa-fs-title-1:     22px;  /* 26px, Display */
  --cocoa-fs-title-2:     17px;  /* 22px, Text */
  --cocoa-fs-title-3:     15px;  /* 20px, Text */
  --cocoa-fs-headline:    13px;  /* 16px, Text Bold */
  --cocoa-fs-body:        13px;  /* 16px, Text */
  --cocoa-fs-callout:     12px;  /* 15px, Text */
  --cocoa-fs-subheadline: 11px;  /* 14px, Text */
  --cocoa-fs-footnote:    10px;  /* 13px, Text */
  --cocoa-fs-caption:     10px;  /* 13px, Text */
}
```

### 2.3 Line heights & weights

```css
:root {
  --cocoa-lh-large-title: 32px;
  --cocoa-lh-title-1:     26px;
  --cocoa-lh-title-2:     22px;
  --cocoa-lh-title-3:     20px;
  --cocoa-lh-headline:    16px;
  --cocoa-lh-body:        16px;
  --cocoa-lh-callout:     15px;
  --cocoa-lh-subheadline: 14px;
  --cocoa-lh-footnote:    13px;
  --cocoa-lh-caption:     13px;

  --cocoa-fw-regular:   400;
  --cocoa-fw-medium:    500;
  --cocoa-fw-semibold:  600;
  --cocoa-fw-bold:      700;

  --cocoa-tracking-tight:  -0.011em;  /* large titles */
  --cocoa-tracking-normal:  0;
  --cocoa-tracking-wide:    0.012em;  /* small caps, captions */
}
```

### 2.4 Feature recipes

```css
:root {
  --cocoa-font-numeric-tabular: "tnum" 1, "lnum" 1;  /* KPIs, prices, ADR/RevPAR */
  --cocoa-font-numeric-old:     "onum" 1;            /* prose body */
  --cocoa-font-confirmation:    "tnum" 1, "ss01" 1;  /* slashed zero on codes */
  --cocoa-font-smallcaps:       "smcp" 1, "c2sc" 1;
}

.cocoa-kpi { font-variant-numeric: tabular-nums; font-feature-settings: var(--cocoa-font-numeric-tabular); }
```

Pair tokens with rendering hints — `-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;` — applied once on `body` to match AppKit grayscale rendering.

---

## 3. Spacing — 4pt grid

```css
:root {
  --cocoa-space-1: 4px;
  --cocoa-space-2: 8px;
  --cocoa-space-3: 12px;
  --cocoa-space-4: 16px;
  --cocoa-space-5: 24px;
  --cocoa-space-6: 32px;
  --cocoa-space-7: 48px;
  --cocoa-space-8: 64px;
}
```

Use mapping reference (from `07-layout-patterns.md`):
- Inline icon ↔ label gap: `--cocoa-space-1` or `--cocoa-space-2`
- Form control vertical rhythm: `--cocoa-space-3`
- Card padding: `--cocoa-space-4`
- Section breaks: `--cocoa-space-5`
- Window edge insets: `--cocoa-space-5` / `--cocoa-space-6`
- Modal vertical padding: `--cocoa-space-7`

---

## 4. Radii

```css
:root {
  --cocoa-radius-sm:   4px;   /* buttons small, checkboxes, segmented controls */
  --cocoa-radius-md:   8px;   /* cards, default buttons, fields */
  --cocoa-radius-lg:  12px;   /* sidebars, sheets, popovers */
  --cocoa-radius-xl:  16px;   /* modals, large dialogs */
  --cocoa-radius-full: 9999px;/* pills, status badges, avatars */
}
```

macOS Sequoia uses continuous (squircle) corners. Approximate on web by combining the radius with `clip-path` only on hero surfaces — for buttons and cards, plain `border-radius` is visually close enough at these sizes.

---

## 5. Shadows — Cocoa depth model

Apple windows use a layered shadow (a soft ambient + a hairline edge). Tokens encode the dual layer in a single `box-shadow` declaration.

```css
:root {
  /* Subtle control affordance — used for raised buttons, segmented */
  --cocoa-shadow-control:
    0 1px 0 rgb(0 0 0 / 0.05),
    0 1px 2px rgb(0 0 0 / 0.08);

  /* Popovers, dropdown menus, comboboxes */
  --cocoa-shadow-popover:
    0 0 0 1px rgb(0 0 0 / 0.08),
    0 8px 16px rgb(0 0 0 / 0.12),
    0 2px 4px rgb(0 0 0 / 0.08);

  /* Floating panels, palette windows, sidebars in detached mode */
  --cocoa-shadow-window:
    0 0 0 1px rgb(0 0 0 / 0.10),
    0 24px 48px rgb(0 0 0 / 0.18),
    0 2px 6px rgb(0 0 0 / 0.10);

  /* Sheets, modal dialogs, alerts */
  --cocoa-shadow-modal:
    0 0 0 1px rgb(0 0 0 / 0.12),
    0 48px 96px rgb(0 0 0 / 0.28),
    0 8px 16px rgb(0 0 0 / 0.14);
}

[data-appearance="dark"] {
  --cocoa-shadow-control:
    0 1px 0 rgb(0 0 0 / 0.40),
    0 1px 2px rgb(0 0 0 / 0.50);

  --cocoa-shadow-popover:
    0 0 0 1px rgb(0 0 0 / 0.60),
    0 8px 16px rgb(0 0 0 / 0.45),
    0 2px 4px rgb(0 0 0 / 0.30);

  --cocoa-shadow-window:
    0 0 0 1px rgb(0 0 0 / 0.70),
    0 24px 48px rgb(0 0 0 / 0.55),
    0 2px 6px rgb(0 0 0 / 0.40);

  --cocoa-shadow-modal:
    0 0 0 1px rgb(0 0 0 / 0.80),
    0 48px 96px rgb(0 0 0 / 0.70),
    0 8px 16px rgb(0 0 0 / 0.45);
}
```

Side-by-side reference:

| Token | Light (ambient + edge) | Dark (ambient + edge) |
|---|---|---|
| `--cocoa-shadow-control` | 1px @ 5% + 2px @ 8% | 1px @ 40% + 2px @ 50% |
| `--cocoa-shadow-popover` | 16px @ 12% + 1px ring @ 8% | 16px @ 45% + 1px ring @ 60% |
| `--cocoa-shadow-window` | 48px @ 18% + 1px ring @ 10% | 48px @ 55% + 1px ring @ 70% |
| `--cocoa-shadow-modal` | 96px @ 28% + 1px ring @ 12% | 96px @ 70% + 1px ring @ 80% |

Notes from `05-materials-blur.md`:
- Dark mode multiplies shadow opacity (~3-4x) because the canvas is darker; the 1px ring becomes the dominant edge cue.
- Never animate `box-shadow` — animate a sibling `::after` overlay with `opacity` for hover lift.

---

## 6. Motion

Durations land on the AppKit defaults (`NSAnimationContext.duration` = 250ms) bracketed by hover-fast 100ms and modal-slow 400ms. Easings reflect Apple's preferred CAMediaTimingFunction curves.

```css
:root {
  /* Durations */
  --cocoa-duration-fast:  100ms;  /* hover, focus, tap feedback */
  --cocoa-duration-base:  200ms;  /* transitions, popover entry */
  --cocoa-duration-slow:  400ms;  /* sheets, window resize, page swap */

  /* Easings */
  --cocoa-ease-out:     cubic-bezier(0.2, 0, 0, 1);     /* Apple ease-out */
  --cocoa-ease-in-out:  cubic-bezier(0.4, 0, 0.2, 1);   /* standard */
  --cocoa-ease-spring:  cubic-bezier(0.5, 1.5, 0.5, 1); /* snappy overshoot */

  /* Bonus tokens used internally by sheets / drawers */
  --cocoa-ease-bouncy:  cubic-bezier(0.34, 1.56, 0.64, 1.0);
  --cocoa-ease-default: cubic-bezier(0.25, 0.1, 0.25, 1.0); /* kCAMediaTimingFunctionDefault */
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --cocoa-duration-fast: 0ms;
    --cocoa-duration-base: 0ms;
    --cocoa-duration-slow: 0ms;
    --cocoa-ease-spring:   linear;
    --cocoa-ease-out:      linear;
    --cocoa-ease-in-out:   linear;
  }
}
```

Pattern usage:
- Hover state: `transition: background var(--cocoa-duration-fast) var(--cocoa-ease-out);`
- Popover entry: `transition: opacity var(--cocoa-duration-base) var(--cocoa-ease-out), transform var(--cocoa-duration-base) var(--cocoa-ease-spring);`
- Sheet slide: `transition: transform var(--cocoa-duration-slow) var(--cocoa-ease-spring);`
- Reduce Motion: swap slide → cross-fade by transitioning only `opacity`, keeping the duration (Apple's reduce-motion contract is "remove parallax, not speed").

---

## 7. Materials — backdrop-filter recipes

Recipes mirror NSVisualEffectView semantic materials. Each token is a *layered* declaration: tint color + blur + saturation. Compose on a surface like `background: var(--cocoa-bg-toolbar); backdrop-filter: var(--cocoa-blur-toolbar);` — split tokens make it possible to provide the tint as an opaque fallback when `backdrop-filter` is unsupported.

```css
:root {
  /* Toolbar / titlebar */
  --cocoa-material-toolbar-bg:   rgb(246 246 246 / 0.72);
  --cocoa-material-toolbar-blur: saturate(180%) blur(20px);

  /* Sidebar */
  --cocoa-material-sidebar-bg:   rgb(232 232 232 / 0.78);
  --cocoa-material-sidebar-blur: saturate(180%) blur(30px);

  /* Popover / menu / combobox */
  --cocoa-material-popover-bg:   rgb(255 255 255 / 0.78);
  --cocoa-material-popover-blur: saturate(180%) blur(24px);

  /* HUD window — darkest, smallest */
  --cocoa-material-hud-bg:       rgb(40 40 40 / 0.78);
  --cocoa-material-hud-blur:     saturate(180%) blur(30px);
  --cocoa-material-hud-color:    rgb(255 255 255 / 0.95);

  /* Convenience combined tokens */
  --cocoa-material-toolbar: var(--cocoa-material-toolbar-blur);
  --cocoa-material-sidebar: var(--cocoa-material-sidebar-blur);
  --cocoa-material-popover: var(--cocoa-material-popover-blur);
  --cocoa-material-hud:     var(--cocoa-material-hud-blur);
}

[data-appearance="dark"] {
  --cocoa-material-toolbar-bg:   rgb(40 40 40 / 0.72);
  --cocoa-material-sidebar-bg:   rgb(42 42 42 / 0.78);
  --cocoa-material-popover-bg:   rgb(48 48 48 / 0.85);
  --cocoa-material-hud-bg:       rgb(20 20 20 / 0.78);
  --cocoa-material-hud-color:    rgb(255 255 255 / 0.95);
}

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  :root {
    --cocoa-material-toolbar-bg: #F6F6F6;
    --cocoa-material-sidebar-bg: #E8E8E8;
    --cocoa-material-popover-bg: #FFFFFF;
    --cocoa-material-hud-bg:     #282828;
  }
}
```

Material side-by-side:

| Material | Light tint | Dark tint | Blur | Saturate |
|---|---|---|---|---|
| Toolbar | `rgba(246,246,246,.72)` | `rgba(40,40,40,.72)` | 20px | 180% |
| Sidebar | `rgba(232,232,232,.78)` | `rgba(42,42,42,.78)` | 30px | 180% |
| Popover | `rgba(255,255,255,.78)` | `rgba(48,48,48,.85)` | 24px | 180% |
| HUD | `rgba(40,40,40,.78)` | `rgba(20,20,20,.78)` | 30px | 180% |

Application pattern (with WebKit fallback per `05-materials-blur.md`):

```css
.cocoa-toolbar {
  background: var(--cocoa-material-toolbar-bg);
  -webkit-backdrop-filter: var(--cocoa-material-toolbar);
          backdrop-filter: var(--cocoa-material-toolbar);
  border-bottom: 1px solid var(--cocoa-separator);
}
```

Performance budget enforced via lint:
- Max 2 large blurred surfaces visible simultaneously (toolbar + sidebar, or toolbar + popover).
- Never nest a material inside a material.
- Never animate `backdrop-filter` — animate `opacity` on a sibling layer.

---

## 8. Z-index scale

```css
:root {
  --cocoa-z-base:     0;
  --cocoa-z-sticky:   100;  /* sticky table headers */
  --cocoa-z-toolbar:  200;
  --cocoa-z-sidebar:  300;
  --cocoa-z-dropdown: 400;
  --cocoa-z-popover:  500;
  --cocoa-z-sheet:    600;
  --cocoa-z-modal:    700;
  --cocoa-z-toast:    800;
  --cocoa-z-tooltip:  900;
}
```

---

## 9. Composition example

A `Card` consumed entirely through tokens:

```css
.cocoa-card {
  background: var(--cocoa-background-content);
  color: var(--cocoa-label);
  border: 1px solid var(--cocoa-separator);
  border-radius: var(--cocoa-radius-md);
  padding: var(--cocoa-space-4);
  box-shadow: var(--cocoa-shadow-control);
  font: var(--cocoa-fw-regular) var(--cocoa-fs-body)/var(--cocoa-lh-body) var(--cocoa-font-family);
  transition: box-shadow var(--cocoa-duration-base) var(--cocoa-ease-out);
}
.cocoa-card:hover { box-shadow: var(--cocoa-shadow-popover); }
.cocoa-card:focus-visible {
  outline: 3px solid var(--cocoa-focus-ring);
  outline-offset: 2px;
}
```

---

## 10. Token inventory checklist

- Colors: 4 labels + 6 backgrounds + 2 separators + 4 accent + 4 status + focus + find = **22 light + 22 dark**
- Typography: 4 families + 10 sizes + 10 line-heights + 4 weights + 3 tracking + 4 numeric feature recipes = **35 tokens**
- Spacing: **8 steps**
- Radii: **5 tokens**
- Shadows: **4 × 2 modes = 8 declarations**
- Motion: 3 durations + 5 easings = **8 tokens**
- Materials: 4 × (bg + blur) + 1 HUD color = **9 tokens × 2 modes**
- Z-index: **10 steps**

Total surface area: **≈ 150 tokens** — every visual decision in HotelOS Cocoa Edition is a `var(--cocoa-*)` lookup.
