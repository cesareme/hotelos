# SPEC — Layout & Navigation (HotelOS Cocoa Edition)

> App-wide shell architecture. Translates the three-column Mail/Notes/Reminders pattern (`07-layout-patterns.md`) and the material/vibrancy system (`05-materials-blur.md`) into HotelOS-specific structure.

---

## 1. Shell macro

```
┌──────────────────────────────────────────────────────────────┐
│ TOOLBAR · 48px · material titlebar + vibrancy                │ ← fixed
├──────────┬──────────────────────────────────┬────────────────┤
│          │                                  │                │
│ SIDEBAR  │        MAIN CONTENT              │   INSPECTOR    │
│  240px   │        flex (min 480px)          │   320px        │
│  source  │        contentBackground         │   optional     │
│  list    │        scroll-y                  │   slide-in     │
│          │                                  │                │
├──────────┴──────────────────────────────────┴────────────────┤
│ STATUS BAR · 24px · optional · tabular-numbers stats         │ ← fixed
└──────────────────────────────────────────────────────────────┘
```

**CSS Grid root:**

```css
.app-shell {
  display: grid;
  grid-template-columns: var(--sidebar-w, 240px) 1fr var(--inspector-w, 0px);
  grid-template-rows: 48px 1fr var(--statusbar-h, 0px);
  grid-template-areas:
    "toolbar  toolbar  toolbar"
    "sidebar  main     inspector"
    "statusbar statusbar statusbar";
  height: 100vh;
  background: var(--mat-window-bg);
}

@property --sidebar-w   { syntax: "<length>"; inherits: true; initial-value: 240px; }
@property --inspector-w { syntax: "<length>"; inherits: true; initial-value: 0px; }
```

State toggles set `--inspector-w: 320px` and `--statusbar-h: 24px` with a 280ms spring transition (`var(--ease-spring)` from `06-motion.md`).

---

## 2. Toolbar (48 px, fixed top)

**Material:** `titlebar` (semantic), `backdrop-filter: blur(20px) saturate(180%)`, 1 px hairline bottom `border-bottom: 0.5px solid var(--separator)`.

**Drag region:** `-webkit-app-region: drag` on container; interactive children opt out with `-webkit-app-region: no-drag`.

### Zones (left → right)

| Zone | Content | Width | Notes |
|---|---|---|---|
| L1 | Traffic-light decoratives (3 × 12 px dots) | 78 px | red/yellow/green, no behavior — pure ornament; 20 px left inset |
| L2 | **PropertySwitcher**: 24 px avatar + property name + chevron | auto | opens popover with property list |
| L3 | Sidebar toggle (icon, 28 × 28 px) | 28 px | `Cmd+0` |
| C  | *flex spacer* (drag region) | 1fr | window dragging happens here |
| R1 | **CocoaSearchInput** (`Cmd+K`) | 240 px | shrinks to icon < 900 px |
| R2 | Theme toggle (sun/moon icon) | 28 px | persists to localStorage |
| R3 | Notifications bell + badge | 28 px | unread count in red pill |
| R4 | User avatar dropdown (28 px) | 28 px | menu: profile, prefs, sign out |

**Spacing:** 8 px gap between items, 12 px gap between zones. Items vertically centered.

**Heights:** 48 px default · 38 px `compact` (preference) · 76 px `expanded` (when title displayed below toolbar row).

---

## 3. Sidebar (240 px, Source List)

**Material:** `sidebar` (semantic, tinted by current accent color at ~3 % opacity), backdrop-blur 30 px. Vibrancy enabled on label text via `mix-blend-mode: plus-lighter` (light) / `plus-darker` (dark).

**Width:** 240 px default, resizable 200–320 px via drag handle on right edge (4 px hit area, cursor `col-resize`, pointer capture).

### 3.1 Sticky header — PropertySwitcher

```
┌────────────────────────────────────┐
│ [avatar] Property Name        ⌄    │ ← 56 px tall, sticky top
│          Tier · Hotel              │
└────────────────────────────────────┘
```

- 12 px padding all sides
- 32 px avatar with property logo or initials
- Title `text-body-emphasized` + subtitle `text-caption-secondary`
- Click → popover with all properties + "Add property…"
- Bottom separator: 0.5 px hairline

### 3.2 Sections (collapsible, max 2 levels)

```
▾ OPERACIONES                       ⌄
  • Reservations             12
  • Front Desk                3
  • Housekeeping            127
  • Maintenance               
▸ BACK OFFICE
▸ REPORTS
▸ SETTINGS
```

- Section header: `text-footnote` uppercased, `var(--text-secondary)`, 11 px tracking 0.05em
- 28 px row height per item, 6 px vertical padding
- Item layout: `[16px icon] [12px gap] [label] [auto spacer] [badge]`
- Icons: `lucide-react` (web) — `CalendarCheck`, `Concierge`, `Sparkles`, `Wrench`, etc. Stroke 1.5 px to match SF Symbols weight.
- Badge: pill with `font-variant-numeric: tabular-nums`, 16 px tall, 6 px horizontal padding, `var(--fill-tertiary)` background

### 3.3 States

| State | Background | Foreground |
|---|---|---|
| Default | transparent | `var(--text-primary)` |
| Hover | `var(--fill-quaternary)` rounded 6 px | inherits |
| Selected | `var(--accent)` rounded 6 px | white + bold |
| Selected + window inactive | `var(--fill-tertiary)` | `var(--text-primary)` |
| Drop target | 2 px `var(--accent)` ring | inherits |

Selection background extends with 8 px horizontal inset from sidebar edges.

### 3.4 Bottom bar (sidebar-scoped actions, NOT toolbar)

Pinned to bottom of sidebar, 36 px tall, `+` `⚙` `…` icon buttons. Hairline separator above. Per Mario Guzmán: sidebar actions live IN the sidebar, never the toolbar.

---

## 4. Main content area (flex, min 480 px)

**Material:** `contentBackground` (raised neutral, slightly lighter than window in light, darker in dark).

### 4.1 PageHeader

```
┌─────────────────────────────────────────────────┐
│ EYEBROW · uppercased footnote                   │
│ Page title · large-title                        │
│ Subtitle description · body-secondary           │
│                              [Action] [Primary] │
└─────────────────────────────────────────────────┘
```

- 24 px top padding, 16 px bottom, 32 px horizontal
- Eyebrow: `text-footnote` uppercased + 0.05em tracking + `var(--text-tertiary)`
- Title: `text-large-title` (28 px / 34 px line)
- Subtitle: `text-body-secondary`
- Actions cluster top-right: secondary buttons + 1 primary; vertically centered with title row
- 0.5 px hairline bottom separator that fades to transparent at edges

### 4.2 Scroll behavior

- Vertical scroll on main only; sidebar + inspector independent
- Scroll-linked toolbar shadow: when `main.scrollTop > 8`, toolbar gains `box-shadow: 0 1px 0 var(--separator)` (motion: 200ms ease-out)
- Scrollbar: `overlay` style, auto-hide, 8 px wide on hover
- Top inset `24 px`, bottom `48 px` for breathing room

### 4.3 Cards

`CocoaCard` component grid; 16 px gap; `repeat(auto-fill, minmax(280px, 1fr))` default. Cards use vibrancy on hover (subtle elevation lift, see `06-motion.md`).

---

## 5. Inspector panel (320 px, right, optional)

**Material:** `contentBackground` (same family as main), vertical hairline on left edge.

**Width:** 320 px typical (matches Pages 304 + 16 px); range 260–380 px via drag handle.

### 5.1 Entry / exit

- Slide-in from right: `transform: translateX(100%)` → `0`
- Duration 280 ms with spring `cubic-bezier(0.4, 0, 0.2, 1.4)`
- Grid column animates `--inspector-w` 0 → 320 px in parallel (`@property` enables this)
- Exit reverses; on `prefers-reduced-motion`, fade-only 150 ms

### 5.2 Internal layout

```
┌──────────────────────────────────┐
│ Close ╳   Title          [⋯]     │ ← 44 px header
├──────────────────────────────────┤
│ [Details] [Activity] [Files]     │ ← segmented control, 32 px
├──────────────────────────────────┤
│                                  │
│   Tab content                    │
│   scroll-y                       │
│                                  │
└──────────────────────────────────┘
```

- Header: 12 px padding, close button left, title center-left, overflow menu right
- Segmented tab strip directly below header (NSSegmentedControl style, 32 px tall)
- Each tab pane scrolls independently
- Empty state when nothing selected: vibrancy-rendered glyph + "Select an item to inspect"

### 5.3 Trigger

Toolbar inspector toggle (`R-most` icon, optional) and `Cmd+Opt+I`. Auto-close on `Esc` if focus inside inspector.

---

## 6. Modal patterns

| Pattern | Geometry | Use case | Dismiss |
|---|---|---|---|
| **Sheet** | Drops from window top, centered, max-width 560 px, animates Y: `-100%` → `0` over 350 ms spring | Forms: create reservation, new guest profile, add property | `Esc`, Cancel button, click on backdrop disabled (modal) |
| **Popover** | Anchored to source element with arrow notch (8 × 8 px), positioned via Floating UI, material `popover` (HUD-light) | Confirms, quick edits, color/date pickers, the property switcher | `Esc`, click outside, scroll on body |
| **Window** | Detached panel, draggable by titlebar, resizable, material `hudWindow`, persistent until explicit close | Deep dive: invoice editor, multi-step config, side-by-side comparison | Close button, `Cmd+W` |

**Backdrop:** Sheets darken background 20 % (`rgba(0,0,0,0.2)`) + 4 px blur over main content. Popovers no backdrop. Windows no backdrop.

**Stacking:** `z-index` tiers — sheet 1000, window 900, popover 800, toolbar 700, sidebar/inspector 600.

---

## 7. Status bar (24 px, fixed bottom, optional)

Hidden by default. Shown for data-dense pages (reports, dashboards).

- Material `titlebar` (mirrors top toolbar tone)
- Left zone: connection indicator (green/yellow/red dot + label)
- Center: contextual stats with `font-variant-numeric: tabular-nums` — "127 reservations · €48,320 today"
- Right zone: zoom controls (− 100 % +) for tables/charts, plus help `?` icon
- Top hairline separator
- Font: `text-caption` (11 px)

---

## 8. Responsive

| Breakpoint | Behavior |
|---|---|
| **≥ 1200 px** | Full shell: sidebar 240 + main + inspector 320. All toolbar zones visible. |
| **900–1199 px** | Inspector becomes overlay (absolute positioned over main, drop-shadow), not grid column. Sidebar stays. |
| **700–899 px** | Sidebar collapses to drawer; toolbar shows hamburger toggle (replaces sidebar toggle icon). Inspector overlay full-height. Search shrinks to icon. |
| **< 700 px** | Toolbar drops traffic lights + theme toggle to overflow menu. Inspector becomes bottom sheet (drag handle, snaps 50 % / 90 %). Sidebar drawer slides over everything. |

Transitions: grid template + custom properties animate smoothly; resize observed via `ResizeObserver` on `.app-shell`.

---

## 9. Keyboard shortcuts (Mac idiom)

Global, registered in app-shell mount.

| Shortcut | Action |
|---|---|
| `Cmd+K` | Open command palette (search + quick actions) |
| `Cmd+F` | Find within current view |
| `Cmd+/` | Open help / shortcut reference overlay |
| `Cmd+,` | Open Settings (sheet) |
| `Cmd+N` | New (contextual: reservation, guest, task — depends on active section) |
| `Cmd+Shift+N` | New Window (detached) |
| `Cmd+W` | Close current sheet/window/inspector (in priority order) |
| `Cmd+0` | Toggle sidebar |
| `Cmd+Opt+I` | Toggle inspector |
| `Cmd+1…9` | Jump to sidebar section 1…9 |
| `Cmd+[` / `Cmd+]` | Navigate back / forward |
| `Cmd+R` | Refresh active view |
| `Esc` | Close topmost modal/popover; if none, clear selection |
| `Tab` / `Shift+Tab` | Focus next/previous control |
| `↑` `↓` | Move selection in lists/tables |
| `←` `→` | Collapse/expand source-list sections; nav cells horizontally in tables |
| `Space` | Quick Look on selected item (preview popover) |
| `Return` | Open selected item |
| `Cmd+Delete` | Delete with confirm |

All shortcuts mirrored in menubar (electron) and command palette so they remain discoverable.

---

## 10. Component contract (quick ref)

```tsx
<AppShell>
  <Toolbar>
    <Toolbar.TrafficLights />
    <Toolbar.PropertySwitcher />
    <Toolbar.SidebarToggle />
    <Toolbar.Spacer />        {/* drag region */}
    <Toolbar.Search />
    <Toolbar.ThemeToggle />
    <Toolbar.Notifications />
    <Toolbar.UserMenu />
  </Toolbar>

  <Sidebar>
    <Sidebar.Header />        {/* property switcher sticky */}
    <Sidebar.Section title="Operaciones" defaultOpen>
      <Sidebar.Item icon={Calendar} label="Reservations" badge={12} />
      …
    </Sidebar.Section>
    <Sidebar.BottomBar>
      <IconButton icon={Plus} />
      <IconButton icon={Settings} />
      <IconButton icon={MoreHorizontal} />
    </Sidebar.BottomBar>
  </Sidebar>

  <Main>
    <PageHeader eyebrow="…" title="…" subtitle="…" actions={…} />
    <Main.Content>{/* cards, tables */}</Main.Content>
  </Main>

  <Inspector open={…} onClose={…}>
    <Inspector.Header title="…" />
    <Inspector.Tabs items={…} />
    <Inspector.Body>{…}</Inspector.Body>
  </Inspector>

  <StatusBar visible={…}>{…}</StatusBar>
</AppShell>
```

---

## Cheat sheet

| Surface | Size | Material | Notes |
|---|---|---|---|
| Toolbar | 48 px tall | `titlebar` + blur 20 px | Drag region, hairline bottom |
| Sidebar | 240 px (200–320) | `sidebar` + blur 30 px | Vibrancy on text, resizable |
| Main | flex (min 480 px) | `contentBackground` | Scroll-y only |
| Inspector | 320 px (260–380) | `contentBackground` | Slide-in 280 ms spring |
| Status bar | 24 px tall | `titlebar` | Optional, tabular-numbers |
| Sheet | max 560 px wide | `windowBackground` | Drops from top, 350 ms |
| Popover | content-sized | `popover` (HUD) | Arrow notch, Floating UI |
| Window | resizable | `hudWindow` | Detached, `Cmd+W` |

**Grid template:**

```css
grid-template-columns: var(--sidebar-w) 1fr var(--inspector-w);
grid-template-rows: 48px 1fr var(--statusbar-h);
```

**Breakpoints:** `1200 / 900 / 700 px`.

---

## Sources

- Apple HIG — Layout, Toolbars, Sidebars, Windows
- Mario Guzmán — *Sidebar Guidelines*, *Toolbar Guidelines* (macOS app design blog)
- `07-layout-patterns.md` (this design system) — Source List, Inspector, Three-column patterns
- `05-materials-blur.md` — material tokens, blur + vibrancy specs
- `06-motion.md` — spring curves, durations, reduced-motion
- NSSplitViewController docs (Apple Developer)
- WWDC20 *Design with iOS pickers, menus and actions* — popover anchoring
- MDN — CSS `@property`, CSS Grid, `backdrop-filter`
- Floating UI docs — popover positioning
- Pilky.me — macOS design tear-downs (toolbar layouts)
