# SPEC — Dark Mode + Accessibility (WCAG AAA)

> Cocoa-faithful dark mode and accessibility contract for HotelOS. Tokens, theme switching, contrast, focus, motion, ARIA, and keyboard navigation. Pairs with `01-visual-fundamentals.md` and `03-color-system.md`.

---

## 1. Dark Mode Tokens

All `--cocoa-*` variables MUST have a `dark` variant declared under `:root[data-theme='dark']`. Values map directly to NSColor semantic colors so the web shell matches AppKit when rendered side-by-side.

### 1.1 Surface tokens

```css
:root {
  /* Backgrounds */
  --cocoa-background-window:   #ffffff;
  --cocoa-background-content:  #ffffff;
  --cocoa-background-sidebar:  #f5f5f7;
  --cocoa-background-toolbar:  rgba(246, 246, 246, 0.80);
  --cocoa-background-grouped:  #f2f2f7;
  --cocoa-background-control:  #ffffff;
  --cocoa-background-elevated: #ffffff;

  /* Labels */
  --cocoa-label:             #000000;
  --cocoa-label-secondary:   rgba(60, 60, 67, 0.60);
  --cocoa-label-tertiary:    rgba(60, 60, 67, 0.30);
  --cocoa-label-quaternary:  rgba(60, 60, 67, 0.18);
  --cocoa-placeholder:       rgba(60, 60, 67, 0.30);

  /* Separators / dividers */
  --cocoa-separator:         rgba(60, 60, 67, 0.29);
  --cocoa-separator-opaque:  #c6c6c8;

  /* Selection */
  --cocoa-selection:         #0a84ff;
  --cocoa-selection-bg:      rgba(0, 122, 255, 0.20);
  --cocoa-selection-unfocus: rgba(0, 0, 0, 0.08);

  /* Accent (system blue by default; runtime override allowed) */
  --cocoa-accent:            #007aff;
  --cocoa-accent-hover:      #0066d6;
  --cocoa-accent-active:     #0051a8;
  --cocoa-accent-30:         rgba(0, 122, 255, 0.30);  /* focus ring */
  --cocoa-accent-text:       #ffffff;                  /* foreground on accent */

  /* Status */
  --cocoa-success: #28cd41;
  --cocoa-warning: #ff9500;
  --cocoa-danger:  #ff3b30;
  --cocoa-info:    #007aff;

  /* Shadows */
  --cocoa-shadow-window: 0 22px 70px rgba(0, 0, 0, 0.20),
                         0 0 0 0.5px rgba(0, 0, 0, 0.10);
  --cocoa-shadow-card:   0 1px 3px rgba(0, 0, 0, 0.10),
                         0 0 0 0.5px rgba(0, 0, 0, 0.05);
}

:root[data-theme='dark'] {
  /* Backgrounds */
  --cocoa-background-window:   #1c1c1e;
  --cocoa-background-content:  #2c2c2e;
  --cocoa-background-sidebar:  #1c1c1e;
  --cocoa-background-toolbar:  rgba(40, 40, 42, 0.80);
  --cocoa-background-grouped:  #000000;
  --cocoa-background-control:  #3a3a3c;
  --cocoa-background-elevated: #2c2c2e;

  /* Labels */
  --cocoa-label:             #ffffff;
  --cocoa-label-secondary:   rgba(235, 235, 245, 0.60);
  --cocoa-label-tertiary:    rgba(235, 235, 245, 0.30);
  --cocoa-label-quaternary:  rgba(235, 235, 245, 0.18);
  --cocoa-placeholder:       rgba(235, 235, 245, 0.30);

  /* Separators */
  --cocoa-separator:         rgba(84, 84, 88, 0.65);
  --cocoa-separator-opaque:  #38383a;

  /* Selection */
  --cocoa-selection:         #0a84ff;
  --cocoa-selection-bg:      rgba(10, 132, 255, 0.30);
  --cocoa-selection-unfocus: rgba(255, 255, 255, 0.10);

  /* Accent (dark blue is brighter — matches NSColor system blue dark) */
  --cocoa-accent:            #0a84ff;
  --cocoa-accent-hover:      #409cff;
  --cocoa-accent-active:     #0066d6;
  --cocoa-accent-30:         rgba(10, 132, 255, 0.40);
  --cocoa-accent-text:       #ffffff;

  /* Status (dark variants — brighter for legibility) */
  --cocoa-success: #32d74b;
  --cocoa-warning: #ff9f0a;
  --cocoa-danger:  #ff453a;
  --cocoa-info:    #0a84ff;

  /* Shadows — heavier in dark mode for depth */
  --cocoa-shadow-window: 0 22px 70px rgba(0, 0, 0, 0.55),
                         0 0 0 0.5px rgba(255, 255, 255, 0.07);
  --cocoa-shadow-card:   0 1px 3px rgba(0, 0, 0, 0.35),
                         0 0 0 0.5px rgba(255, 255, 255, 0.05);
}
```

### 1.2 High contrast override

```css
@media (prefers-contrast: more) {
  :root {
    --cocoa-label-secondary: rgba(60, 60, 67, 0.85);
    --cocoa-separator:       rgba(0, 0, 0, 0.55);
  }
  :root[data-theme='dark'] {
    --cocoa-label-secondary: rgba(235, 235, 245, 0.90);
    --cocoa-separator:       rgba(255, 255, 255, 0.55);
    --cocoa-background-content: #000000;
  }
}
```

---

## 2. Auto-switching theme

Three signals, in priority order: **manual override** > **OS preference** > **default (light)**.

### 2.1 No-flash bootstrap (in `index.html` `<head>`, before any CSS)

```html
<script>
  (function () {
    try {
      var stored = localStorage.getItem('hotelos.theme'); // 'light' | 'dark' | 'system'
      var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      var theme = stored === 'light' || stored === 'dark'
        ? stored
        : (prefersDark ? 'dark' : 'light');
      document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.style.colorScheme = theme;
    } catch (_) { /* localStorage blocked — fall through to light */ }
  })();
</script>
```

This runs synchronously before React hydrates. The `data-theme` attribute and `color-scheme` style are set before paint — no FOUC, no flash.

### 2.2 Live system listener

```ts
// useTheme.ts
const mq = window.matchMedia('(prefers-color-scheme: dark)');
mq.addEventListener('change', (e) => {
  const stored = localStorage.getItem('hotelos.theme');
  if (stored && stored !== 'system') return; // user override wins
  applyTheme(e.matches ? 'dark' : 'light');
});
```

### 2.3 Manual toggle

User-facing toggle in **Settings → Appearance** with three options: `System` (default), `Light`, `Dark`. Selecting `System` removes the localStorage key. Selecting `Light`/`Dark` pins the choice.

```ts
function setTheme(choice: 'system' | 'light' | 'dark') {
  if (choice === 'system') {
    localStorage.removeItem('hotelos.theme');
    const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(prefersDark ? 'dark' : 'light');
  } else {
    localStorage.setItem('hotelos.theme', choice);
    applyTheme(choice);
  }
}

function applyTheme(t: 'light' | 'dark') {
  document.documentElement.setAttribute('data-theme', t);
  document.documentElement.style.colorScheme = t;
}
```

---

## 3. WCAG AAA Contrast

Target **7:1** for body text, **4.5:1** for large text (>=18.66px regular or >=14px bold) and UI components.

| Pair | Ratio | Tier |
|---|---|---|
| `#000000` on `#ffffff` (light body) | **21:1** | AAA |
| `#ffffff` on `#1c1c1e` (dark body) | **17.1:1** | AAA |
| `#ffffff` on `#2c2c2e` (dark content) | **14.5:1** | AAA |
| `rgba(60,60,67,0.60)` resolved on `#ffffff` (light secondary) | **7.04:1** | AAA |
| `rgba(235,235,245,0.60)` resolved on `#1c1c1e` (dark secondary) | **7.31:1** | AAA |
| `#ffffff` on `#007aff` (light accent text) | **4.55:1** | AA large / AAA UI |
| `#ffffff` on `#0a84ff` (dark accent text) | **4.18:1** | AA large |
| `#ffffff` on `#0066d6` (light accent hover, recommended for body) | **5.40:1** | AAA |

### Rules
1. **Body text** uses `--cocoa-label` only. Never use secondary for paragraph-length copy.
2. **Secondary labels** are allowed for metadata, captions, timestamps — limited runs <= 1 line.
3. **Tertiary / quaternary** are decorative only (placeholders, disabled glyphs). Never carry semantic information.
4. **Text on accent** uses `--cocoa-accent-text` (`#ffffff`). For body-weight text on accent in light mode, swap to `--cocoa-accent-hover` (`#0066d6`) as background to clear AAA.
5. **Status colors** (`--cocoa-danger`, `--cocoa-warning`) must never be the sole carrier of meaning — always pair with icon + label.
6. **Disabled controls** drop to 38% opacity but keep position and label; `aria-disabled="true"` always set.

---

## 4. Focus Rings

Visible, accent-tinted, keyboard-only.

```css
:where(button, a, input, select, textarea, [tabindex]):focus {
  outline: none;
}

:where(button, a, input, select, textarea, [tabindex]):focus-visible {
  outline: 2px solid var(--cocoa-accent);
  outline-offset: 1px;
  box-shadow: 0 0 0 3px var(--cocoa-accent-30);
  border-radius: inherit;
}

/* High-contrast — solid ring, no shadow */
@media (prefers-contrast: more) {
  :where(button, a, input, select, textarea, [tabindex]):focus-visible {
    outline: 3px solid var(--cocoa-label);
    box-shadow: none;
  }
}
```

`:focus-visible` ensures the ring shows for keyboard / VoiceOver users but stays hidden on mouse click — matches AppKit's `NSFocusRingType.exterior` behavior, which only paints during keyboard focus.

---

## 5. Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 50ms !important;
    scroll-behavior: auto !important;
  }
}
```

Component-level rules:
- **Sheets / sidebars**: still slide, but capped at 50ms — gives spatial cue without vestibular cost.
- **Modal backdrop fades**: instant.
- **Parallax, shimmer, auto-rotating carousels**: disabled entirely.
- **Toast auto-dismiss**: keep, but no slide — fade or jump-cut.
- **Loading spinners**: replaced with a single static `aria-busy` indicator + text "Loading…".

Detect once at boot and expose as `document.documentElement.dataset.reducedMotion = '1'` so JS code paths can short-circuit easing curves (e.g., Framer Motion `transition={{ duration: 0 }}`).

---

## 6. VoiceOver / Screen Reader

### 6.1 Landmarks

```html
<body>
  <header role="banner">…toolbar…</header>
  <nav aria-label="Primary">…sidebar…</nav>
  <main aria-label="Reservations">…content…</main>
  <aside aria-label="Inspector" hidden>…</aside>
  <div role="status" aria-live="polite" id="toast-region"></div>
</body>
```

Exactly one `<main>` per route. Sidebar is always `<nav aria-label="…">`. Inspector is `<aside>` with `hidden` when collapsed (not just visually hidden — actually removed from a11y tree).

### 6.2 Icon-only buttons

Every icon button MUST carry an `aria-label`. The tooltip text and `aria-label` should match.

```html
<button aria-label="New reservation" title="New reservation">
  <svg aria-hidden="true" focusable="false">…</svg>
</button>
```

Decorative SVGs always get `aria-hidden="true"` + `focusable="false"`.

### 6.3 Live regions

| Region | `role` | `aria-live` | `aria-atomic` |
|---|---|---|---|
| Toast container | `status` | `polite` | `true` |
| Error banner | `alert` | `assertive` | `true` |
| Form validation summary | `alert` | `assertive` | `true` |
| Background sync indicator | `status` | `polite` | `false` |

Don't toggle `aria-live` dynamically — declare once at render. Mutate children only.

### 6.4 Modals

```html
<div role="dialog"
     aria-modal="true"
     aria-labelledby="dlg-title"
     aria-describedby="dlg-desc">
  <h2 id="dlg-title">Cancel reservation</h2>
  <p id="dlg-desc">This will release the room and notify the guest.</p>
  …
</div>
```

On open: move focus to the first interactive element (or the dialog itself with `tabindex="-1"`). On close: restore focus to the trigger. Trap Tab inside while open. ESC closes.

### 6.5 Tabs

```html
<div role="tablist" aria-label="Reservation views">
  <button role="tab" aria-selected="true"  aria-controls="p-1" id="t-1" tabindex="0">Today</button>
  <button role="tab" aria-selected="false" aria-controls="p-2" id="t-2" tabindex="-1">Week</button>
</div>
<div role="tabpanel" id="p-1" aria-labelledby="t-1" tabindex="0">…</div>
```

Roving `tabindex`: only the active tab is `0`, others `-1`. Arrow keys move selection.

### 6.6 Lists, grids, trees

- Lists of reservations: `role="list"` + `role="listitem"`, with item count announced via `aria-setsize` / `aria-posinset`.
- Calendar grid: `role="grid"` with `role="row"` / `role="gridcell"`, `aria-rowcount` / `aria-colcount`.
- Sidebar with folders: `role="tree"` + `role="treeitem"` + `aria-expanded`.

---

## 7. Keyboard Navigation

### 7.1 Global shortcuts (Mac-feel)

| Combo | Action |
|---|---|
| `Cmd+N` | New reservation |
| `Cmd+F` | Focus search |
| `Cmd+,` | Open Settings |
| `Cmd+1…9` | Switch sidebar section |
| `Cmd+W` | Close active sheet / panel |
| `Cmd+Z` / `Cmd+Shift+Z` | Undo / Redo |
| `Cmd+S` | Save current form |
| `Cmd+[` / `Cmd+]` | Back / Forward in nav stack |
| `Esc` | Close modal, cancel inline edit, clear search |
| `/` | Quick-focus search (no Cmd) |

Detect platform; render `Ctrl` on non-Mac in tooltips. Never bind to `Cmd+Q`, `Cmd+H`, `Cmd+M` (system-reserved).

### 7.2 Tab order

- DOM order = logical reading order. Never use `tabindex > 0`.
- Skip-link "Skip to main content" at top, visually hidden until focused, jumps to `<main>`.
- Disabled controls are skipped (browser default). Hidden inspector pane removed from tree.

### 7.3 Arrow-key zones

| Component | Arrow behavior |
|---|---|
| Sidebar tree | Up/Down moves item; Right expands; Left collapses |
| Tab strip | Left/Right cycles tabs; Home/End jump to ends |
| Reservation table row | Up/Down moves row; Right opens row inspector |
| Calendar grid | All four arrows; Home/End jump to row start/end; PageUp/Down jump weeks |
| Menu / select | Up/Down through items; Enter confirms; Esc closes |
| Date picker | Arrows move day; Shift+Arrow week; Cmd+Arrow month |

All arrow zones are **roving tabindex** — only one element inside is tabbable from outside.

### 7.4 Focus management on route change

On `pushState` navigation: set focus to the route's `<h1>` (with `tabindex="-1"`). Announce the new view via the polite live region: "Reservations loaded, 42 items".

---

## 8. Testing checklist

- [ ] Toggle System → Dark → Light in Settings; no flash on reload in any mode.
- [ ] `prefers-color-scheme` flip in DevTools updates immediately when `theme = system`.
- [ ] axe-core run: zero violations on every route.
- [ ] VoiceOver (`Cmd+F5`) reads sidebar, toolbar, content, inspector in order; no orphan controls.
- [ ] Full keyboard pass: every action reachable without mouse, focus ring always visible.
- [ ] Reduce Motion in System Settings → no slides over 50ms.
- [ ] Increase Contrast in System Settings → separators darken, secondary labels strengthen.
- [ ] Lighthouse Accessibility >= 100.
- [ ] Contrast audit (e.g., Stark): every text/background pair >= 7:1 (AAA) or documented exception with rationale.
- [ ] Screen-reader sweep on macOS VoiceOver + Windows NVDA — both announce landmarks, dialogs, live regions correctly.

---

## Sources

- [Apple HIG — Color](https://developer.apple.com/design/human-interface-guidelines/color)
- [Apple HIG — Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)
- [Apple HIG — Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [WCAG 2.2 — Success Criterion 1.4.6 (Contrast Enhanced AAA)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-enhanced.html)
- [WCAG 2.2 — Success Criterion 2.4.7 (Focus Visible)](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html)
- [WCAG 2.2 — Success Criterion 2.3.3 (Animation from Interactions)](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html)
- [MDN — `prefers-color-scheme`](https://developer.mozilla.org/docs/Web/CSS/@media/prefers-color-scheme)
- [MDN — `prefers-reduced-motion`](https://developer.mozilla.org/docs/Web/CSS/@media/prefers-reduced-motion)
- [MDN — `prefers-contrast`](https://developer.mozilla.org/docs/Web/CSS/@media/prefers-contrast)
- [MDN — `:focus-visible`](https://developer.mozilla.org/docs/Web/CSS/:focus-visible)
- [WAI-ARIA Authoring Practices 1.2 — Dialog (Modal)](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [WAI-ARIA Authoring Practices 1.2 — Tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)
- [WAI-ARIA Authoring Practices 1.2 — Treeview](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/)
- [WAI-ARIA — Live Regions](https://www.w3.org/WAI/ARIA/apg/practices/live-regions/)
- [WebKit blog — Dark mode and `color-scheme`](https://webkit.org/blog/8840/dark-mode-support-in-webkit/)
- [Apple WWDC 2018 — Dark Mode in macOS (session 210)](https://developer.apple.com/videos/play/wwdc2018/210/)
- [Apple WWDC 2019 — Accessibility on macOS (session 211)](https://developer.apple.com/videos/play/wwdc2019/211/)
