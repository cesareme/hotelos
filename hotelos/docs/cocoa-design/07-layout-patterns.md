# 07 · Layout Patterns from macOS Apps

Reference document distilling the structural patterns used by Apple's first-party apps (Mail, Notes, Reminders, Finder, Safari, Xcode) and translating them to a web stack for HotelOS.

---

## 1. Source List (Sidebar)

The Source List is the primary navigation pattern on macOS, implemented natively via `NSOutlineView` configured as `.sourceList`. It is what you see on the left of Mail, Finder, Notes, Music and Xcode.

### Specs

- **Width**: minimum **225-275 pt**, maximum **350-400 pt**. Default at launch: **240-260 pt** for most apps; Mail and Notes ship around 220-240 pt; Xcode opens at 260 pt.
- **Background**: vibrant translucent material (`NSVisualEffectView.sidebar`). On web, translate to `backdrop-filter: blur(30px) saturate(180%)` over a `rgba(246,246,246,0.72)` (light) / `rgba(30,30,30,0.72)` (dark) base.
- **Hierarchy**: maximum **two levels** of nesting. If you need deeper, introduce a second column rather than indenting further.
- **Sections**: uppercase, tracking +0.5, font weight 600, color secondary label. Each section is **collapsible** via a disclosure chevron that appears on hover.
- **Rows**: 28 pt tall in `.regular`, 22 pt in `.small`, 32 pt in `.large`. Icon 16x16 leading, label, optional badge trailing.
- **Icons**: SF Symbols at `.medium` weight, monochrome (label color), not tinted with accent unless selected. macOS Tahoe defaults sidebar glyphs to label-color (black/white) instead of accent.
- **Count badges**: pill-shaped, `tertiarySystemFill` background, tabular-numbers font, `caption2` size, right-aligned. Hidden when zero.
- **Selection**: full-row fill with `controlAccentColor` at 100% in active window, 60% inactive. Text becomes white on selection.
- **Bottom bar**: sidebar-scoped actions (Add list, Sync, Account status) live in a dedicated bottom bar — *not* in the window toolbar.

---

## 2. Inspector Panel

Inspector = contextual right-side panel that reveals metadata or settings for the current selection. Used by Xcode (File Inspector), Finder (Get Info inline), Notes (attachments), Pages and Numbers.

### Specs

- **Width**: **260-320 pt** typical. Xcode defaults to 280 pt; Pages to 304 pt. Min 220 pt, max 400 pt.
- **Reveal**: slides from right with spring animation (~280ms, damping 0.85). The center column compresses; the sidebar does not move.
- **Toggle**: trailing-most toolbar item. SF Symbol `sidebar.right`. Cmd-Opt-0 by convention.
- **Tab strip**: when the inspector has multiple modes (Xcode has 4, Pages has 4), a `NSSegmentedControl` sits at the top, full-width, icons only, label on hover.
- **Content**: vertically stacked grouped form. Section headers small uppercase, fields right-aligned labels with controls. Use `NSStackView` distribution `.fillEqually` for symmetrical pairs, `.fill` otherwise.
- **Contextuality**: empty state when nothing is selected ("No Selection" centered, secondary label). When multiple items selected: "Multiple Selection" with shared properties only.

---

## 3. Three-Column Layout (Mail / Notes / Reminders)

The canonical pattern for browsing collections: **Sidebar (sources) → List (items) → Detail (content)**. Since iPadOS 14 and macOS Big Sur this is built on `UISplitViewController` / `NSSplitViewController` with a *supplementary* column between sidebar and detail.

### Column proportions

| Column | Role | Width range | Default |
|---|---|---|---|
| Sidebar | Mailboxes / folders / lists | 200-280 pt | 240 pt |
| List | Messages / notes / reminders | 280-420 pt | 320 pt |
| Detail | Reading pane / editor | flex, min 480 pt | flex |

- Each divider is a 1 pt hairline (`separatorColor`) with a 4 pt invisible hit zone for resizing.
- Sidebar collapses below window width ~900 pt. List collapses below ~700 pt → app falls back to push navigation.
- Mail uses **column** mode by default; can switch to **classic** (list on top, preview below) via View menu. Reminders adds a **kanban column** view where each section becomes a column.

### Implementation notes
- The two left columns share the toolbar's left segment; the detail column owns the right segment with primary actions.
- Selecting in the sidebar pushes a fresh list; selecting in the list updates the detail without animation.

---

## 4. Toolbar (`NSToolbar`)

The unified window-chrome toolbar carries the most-frequent actions and the search field.

### Layout zones (left → right)

1. **Sidebar toggle** (leading-most when sidebar is collapsible).
2. **Navigation cluster**: back/forward, history.
3. **Primary actions**: 2-4 destructive or creation actions (Compose, New Note, Get Mail). Highest visibility = leftmost.
4. **Flexible space**.
5. **View options**: segmented control or popover (sort, filter, layout mode).
6. **Global Search**: `NSSearchToolbarItem` — shows a magnifying-glass button that expands into a search field on click or when window is wide enough.
7. **Share**: standard share-sheet item.
8. **Inspector toggle**: trailing-most.

### Specs

- Standard height **52 pt** (Unified), **38 pt** (Unified Compact), **76 pt** (Expanded with titles below icons).
- Toolbar items: 24-28 pt icon target, 38-44 pt hit area.
- Every toolbar item **must** be mirrored in a menu command — toolbar is augmentation, not the only entry point.
- Toolbar items can be customized by the user (View → Customize Toolbar) — design with reorder and removal in mind.

---

## 5. Tab Bar (Safari / Notes / Finder)

Document tabs live below the toolbar (Safari, Finder) or as an inline strip (Notes).

### Specs

- **Tab height**: 28 pt (Safari classic), 38 pt (Safari compact restored in macOS 26.4).
- **Max width per tab**: ~220 pt. **Min width**: ~80 pt (favicon + 4-6 chars + close). Below that, tabs collapse to just the favicon.
- **Active tab**: lifted with `windowBackgroundColor`; inactive tabs use `controlBackgroundColor` with a 1 pt bottom hairline.
- **Close button**: leading side, 14x14, appears on hover or when tab is active.
- **Overflow**: when tabs no longer fit at min-width, a **chevron menu** appears at the trailing end listing the hidden tabs. Safari additionally scrolls horizontally with two-finger swipe and pins the active tab in view.
- **Pinned tabs**: favicon-only, 32 pt wide, no close button, anchored leading.
- **New tab button**: `+`, 28 pt, trailing of the visible tab strip but before the overflow chevron.

---

## 6. Translating to Web

A faithful web port for HotelOS uses CSS Grid for skeleton, a resize handle component, and CSS custom properties for collapse state.

### Grid template

```css
:root {
  --sidebar-w: 240px;
  --list-w: 320px;
  --inspector-w: 300px;
  --sidebar-min: 200px;
  --sidebar-max: 360px;
}

.app-shell {
  display: grid;
  grid-template-columns:
    [sidebar] var(--sidebar-w)
    [list]    var(--list-w)
    [detail]  minmax(480px, 1fr)
    [inspector] var(--inspector-w);
  grid-template-rows: 52px 1fr;  /* toolbar | content */
  height: 100vh;
}

/* Sidebar collapsed */
.app-shell[data-sidebar="collapsed"] { --sidebar-w: 0px; }
.app-shell[data-inspector="collapsed"] { --inspector-w: 0px; }
```

Animate `--sidebar-w` with `transition: --sidebar-w 240ms cubic-bezier(0.32, 0.72, 0, 1);` after registering it via `@property` so the value interpolates smoothly.

### Resize handle

A 1 px visible hairline wrapped in a 6 px absolute-positioned `<div role="separator" aria-orientation="vertical">` with `cursor: col-resize`. On `pointerdown` capture the pointer, listen for `pointermove`, write the new value to the column's CSS variable, clamp to min/max, persist to `localStorage`.

### Collapse breakpoints

```css
@media (max-width: 900px) { .app-shell { --sidebar-w: 0; } }
@media (max-width: 700px) {
  .app-shell { grid-template-columns: 1fr; }
  .app-shell > :not([data-active]) { display: none; } /* push-nav fallback */
}
```

### Toolbar zones with Flexbox

```css
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  height: 52px;
  -webkit-app-region: drag;
  background: var(--toolbar-bg);
  backdrop-filter: blur(30px);
}
.toolbar > .spacer { flex: 1; }
.toolbar button { -webkit-app-region: no-drag; }
```

Left cluster (sidebar toggle, nav, primary actions) → `.spacer` → right cluster (view options, search, share, inspector toggle). Mirror Apple's trailing order exactly.

### Tab overflow

Use `IntersectionObserver` on each tab inside a horizontally scrollable container. When `intersectionRatio < 1`, push the tab into a popover triggered by a trailing chevron button. Apply `min-width: 80px; max-width: 220px;` to each tab and `flex: 1 1 auto`.

---

## Cheat sheet

| Pattern | Default px | Min | Max | Web property |
|---|---|---|---|---|
| Sidebar | 240 | 200 | 360 | `--sidebar-w` |
| List column | 320 | 280 | 420 | `--list-w` |
| Inspector | 300 | 220 | 400 | `--inspector-w` |
| Toolbar | 52 h | 38 (compact) | 76 (expanded) | `height` |
| Tab | 220 w | 80 | 220 | `min-width`/`max-width` |

---

## Sources

- [Sidebar Guidelines · Mario Guzmán](https://marioaguzman.github.io/design/sidebarguidelines/)
- [Toolbar Guidelines · Mario Guzmán](https://marioaguzman.github.io/design/toolbarguidelines/)
- [Apple HIG · Split Views](https://developer.apple.com/design/human-interface-guidelines/split-views)
- [Apple HIG · Toolbars](https://developer.apple.com/design/human-interface-guidelines/components/menus-and-actions/toolbars/)
- [NSSplitView · Apple Developer Documentation](https://developer.apple.com/documentation/appkit/nssplitview)
- [The Complete Guide to NSOutlineView · AppCoda](https://www.appcoda.com/macos-programming-nsoutlineview/)
- [NSOutlineView Tutorial · Kodeco](https://www.kodeco.com/1201-nsoutlineview-on-macos-tutorial)
- [iOS and iPadOS 14 Review · MacStories (three-column split)](https://www.macstories.net/stories/ios-and-ipados-14-the-macstories-review/12/)
- [Mail · Use column layout (Apple Support)](https://support.apple.com/guide/mail/use-column-layout-mlhlc18e666f/mac)
- [Reminders · List Sections and Column View](https://macmost.com/reminders-list-sections-and-column-view.html)
- [macOS 26.4 compact tab bar in Safari · 9to5Mac](https://9to5mac.com/2026/03/26/macos-tahoe-26-4-and-ipados-26-4-add-compact-tab-bar-in-safari/)
- [Nesting Split Views · Pilky](https://pilky.me/nesting-split-views/)
- [Realizing common layouts using grids · MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_grid_layout/Realizing_common_layouts_using_grids)
- [Use CSS Grid for fixed sidebar with scrollable main · Paige Niedringhaus](https://www.paigeniedringhaus.com/blog/use-css-grid-to-make-a-fixed-sidebar-with-scrollable-main-body/)
- [Adopt the new look of macOS · WWDC20](https://developer.apple.com/videos/play/wwdc2020/10104/)
