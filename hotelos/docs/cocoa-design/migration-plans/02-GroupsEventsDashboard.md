# Migration Plan 02 · GroupsEventsDashboard

**File**: `apps/admin-web/src/screens/operations/GroupsEventsDashboard.tsx` (485 LOC)
**Domain**: Commercial · Groups & Events
**Phase**: D — Screen repaint
**Owner**: 1 agent
**Dependencies**: Phases A, B, C (tokens, primitives, shell) merged.

---

## 1. Scope and intent

Repaint a read-only dashboard: page head with two CTAs, four primary KPI cards plus a toggleable secondary KPI, collapsible pickup section, upcoming-groups table with kebab row actions, and a two-column block (events list + top-accounts table). Five modal dialogs hang off row actions and the primary CTA. Behavior, polling (`useApiData` every 120s), data shape, and dialog wiring stay untouched. Only the visual layer changes.

---

## 2. Component mapping (Aurora v2 → Cocoa)

| Aurora v2 element | Cocoa primitive | Notes |
|---|---|---|
| `div.bo-page-head` + `h1.bo-page-title` + `p.bo-page-subtitle` | `CocoaPageHeader` (eyebrow / title / subtitle slots) | Eyebrow becomes `--cocoa-label-secondary` caption. |
| `button.primary` "+ Nuevo grupo" | `CocoaButton variant="primary"` with `IconAdd` | Drop the `"+ "` literal — semantic icon replaces it. |
| `button.ghost` "↻ Refresh" | `CocoaButton variant="ghost"` with `IconRefresh` | Drop `"↻"`. |
| `section.bo-card` error banner | `CocoaCard tone="danger"` | Inline `style={{color:"var(--danger-ink)"}}` removed. |
| `section.rev-kpi-grid` + `article.rev-kpi` | `CocoaKpiGrid` + `CocoaKpiCard` (status: ok / warn / error) | One primitive replaces `rev-kpi-ok/warn/error` modifier classes. |
| Show-more KPI toggle (`button.ghost`) | `CocoaDisclosureButton` | Replaces ad-hoc `▾/▸` glyphs with `IconChevronDown` rotation. |
| Pickup accordion `<button>` with inline style block | `CocoaDisclosureSection` (header + collapsible body) | Removes the 17-line inline `style={...}`. |
| `section.bo-card` + `.bo-card-head` + `h3` + `.bo-chip` | `CocoaCard` + `CocoaCardHeader` (title slot, trailing `CocoaBadge`) | `bo-chip` → `CocoaBadge variant="neutral"`. |
| `table.cm-table` (upcoming groups, top accounts) | `CocoaTable` with typed columns | Numeric columns get `align="end"`; replaces inline `textAlign:"right"`. |
| `pickupPill()` `span.cm-pill cm-pill-ok/warn/error` | `CocoaStatusPill tone="ok/warn/error/neutral"` | `"no block"` becomes `tone="neutral"`. |
| Anonymous button styled as link (`background:none; border:none; color:var(--accent)`) for group name | `CocoaButton variant="link"` | Removes 11-line inline style. |
| Kebab `<button>` `⋯` + manual menu | `CocoaPopoverMenu` triggered by `CocoaIconButton icon={IconMore}` | Replaces overlay + portal + role="menu" hand-roll. Menu items use `IconBed`, `IconMic`, `IconClipboard` (no emoji). |
| Inline menu items with emojis (🛏️ 🎤 📋) | `CocoaMenuItem icon={…}` with lucide icons | Required by principle 7 (no emojis). |
| `section.bo-grid.two` | `CocoaGrid columns={2}` | Existing primitive. |
| `ul.bo-list` + `li` event rows | `CocoaList` with `CocoaListItem` | `bo-pill` → `CocoaBadge`. |
| `p.bo-muted` empty states | `CocoaEmptyState size="sm"` | Use existing primitive; only text passed. |
| Dialogs (`NewGroupDialog`, `RoomBlockGridDialog`, `NewEventDialog`, `RoomingListImportDialog`, `GroupDetailDialog`) | **No change in this pass** | Each dialog is its own migration. Keep imports as-is. |
| `GroupsPickupCard` child | **No change in this pass** | Separate migration. |
| `useToast` toasts | Keep — surface migration handled in Phase C | API stays the same. |

---

## 3. Required changes

### 3.1 Imports
Add:
```ts
import {
  CocoaPageHeader, CocoaButton, CocoaIconButton, CocoaCard, CocoaCardHeader,
  CocoaKpiGrid, CocoaKpiCard, CocoaDisclosureButton, CocoaDisclosureSection,
  CocoaTable, CocoaBadge, CocoaStatusPill, CocoaPopoverMenu, CocoaMenuItem,
  CocoaGrid, CocoaList, CocoaListItem, CocoaEmptyState,
} from "../../components/cocoa";
import {
  IconAdd, IconRefresh, IconMore, IconBed, IconMic, IconClipboard,
  IconChevronDown,
} from "../../components/cocoa/icons";
```

### 3.2 Markup substitutions
- `bo-page-head` block → `<CocoaPageHeader eyebrow="…" title="…" subtitle="…" actions={…} />`. Actions slot receives the two `CocoaButton`s.
- KPI grid: map the four `article.rev-kpi` into `<CocoaKpiCard label value caption status />`. Compute `status` from the existing `groupsStatus / blockedStatus / pickupStatus / eventsStatus` strings remapped to `"ok" | "warn" | "error"`.
- Secondary KPI toggle: `setShowSecondaryKpis` stays; wrap in `<CocoaDisclosureButton label="Mostrar más KPIs" expanded={showSecondaryKpis} onToggle={…} align="end" />`. The 5th KPI card moves inside the disclosure body.
- Pickup section: convert to `<CocoaDisclosureSection title="Pickup de grupos · ciclo y release" hint={pickupExpanded ? "Click para colapsar" : "Click para expandir"} expanded={pickupExpanded} onToggle={…}>{<GroupsPickupCard />}</CocoaDisclosureSection>`. Drops the ~25 lines of inline style.
- Upcoming groups table: declare typed columns array with `align: "end"` for the three numeric cells. Group-name cell renders `<CocoaButton variant="link" onClick={() => setDetailGroupId(g.id)}>{g.name}</CocoaButton>`. Pickup cell renders `pickupPill()` rewritten to return `<CocoaStatusPill tone="…">…</CocoaStatusPill>`. Actions cell renders a `CocoaPopoverMenu` with three `CocoaMenuItem`s; the popover replaces the manual overlay + zIndex juggling. Remove `openKebabId` state — popover owns its open state internally — and remove the fixed-inset overlay div.
- Events list: `bo-list` → `CocoaList`; each item uses `CocoaBadge` for date and revenue, `CocoaLabel level="secondary"` for the muted line.
- Top accounts table: same pattern as upcoming groups; numeric columns `align="end"`. Account name is plain bold text — no link in this pass.

### 3.3 Code deletions
- Remove every `style={{…}}` literal in the body (15 occurrences). All visual concerns must move to tokens / primitive props.
- Remove `openKebabId` state and its setters.
- Remove inline `style` on the link-button for group names.
- Remove emoji glyphs in menu items (🛏️ 🎤 📋) and toggle indicators (▾/▸); icons supplied by `IconBed`, `IconMic`, `IconClipboard`, `IconChevronDown`.

### 3.4 Code preserved verbatim
- `useApiData` call, polling interval, `EMPTY` fallback.
- All five dialog mountings at the bottom (`newGroupOpen`, `blockGroupId`, `eventGroupId`, `roomingGroupId`, `detailGroupId`) and their handlers.
- `eurFormat`, `numFormat`, `formatEur`, `formatNumber`, `formatDate`, `formatDateTime`.
- Toast calls and their messages.
- Status-threshold logic (KPI ok/warn/error mapping) — only the consumed class names change.

### 3.5 Functional non-changes
- No prop changes to imported dialogs; endpoint contract unchanged.
- ARIA semantics (`aria-expanded`, `aria-haspopup`, `role="menu"`) move into the primitives, guaranteed by their contract.

---

## 4. Tokens consumed

| Concern | Token | Source |
|---|---|---|
| Page background | `--cocoa-background-window` | SPEC-tokens §1.1 |
| Card surface | `--cocoa-background-content` | §1.1 |
| Card border / table dividers | `--cocoa-separator` | §1.1 |
| Body text | `--cocoa-label` | §1.1 |
| Muted text (subtitle, captions, "no events") | `--cocoa-label-secondary` | §1.1 |
| Primary button bg + link-button text | `--cocoa-accent`, `--cocoa-accent-hover`, `--cocoa-accent-pressed` | §1.1 |
| Status pill green / orange / red | `--cocoa-success`, `--cocoa-warning`, `--cocoa-danger` | §1.1 |
| KPI card status backgrounds | `--cocoa-status-ok-bg`, `--cocoa-status-warn-bg`, `--cocoa-status-error-bg` | SPEC-components |
| Card / pill / button radii | `--cocoa-radius-card`, `--cocoa-radius-pill`, `--cocoa-radius-control` | §radii |
| Spacing | `--cocoa-space-2 / 3 / 4` | §spacing |
| Popover surface + shadow | `--cocoa-background-control`, `--cocoa-shadow-popover` | SPEC-materials |
| Focus ring | `--cocoa-focus-ring` | §1.1 |
| Type ramp | `--cocoa-text-title-2` (h1), `--cocoa-text-headline` (card h3), `--cocoa-text-body`, `--cocoa-text-caption-1` | SPEC-typography |

No raw hex, px, or rem may remain inside the file after the pass.

---

## 5. Risk

**Overall: Medium-Low.**

| Risk | Likelihood | Mitigation |
|---|---|---|
| Kebab regression (focus trap, ESC, click-outside) | Medium | `CocoaPopoverMenu` must cover these (Phase B). If missing, keep manual menu + `// TODO(cocoa)`. |
| KPI status colors fail 3:1 contrast | Low | Reuse tokens audited in SPEC-darkmode-a11y; do not invent. |
| Table alignment regressions | Low | Visual snapshot before/after; numeric columns `align="end"`. |
| `CocoaDisclosureSection` not yet built | Medium | Keep button + conditional render; move inline styles into a `cocoa-pickup-disclosure` class. Add TODO. |
| Emoji removal hurts scanability | Low | Lucide icons preserve meaning; labels stay in Spanish. |
| Dialog children clash with new shell mid-transition | Medium | Expected; document in PR. Each dialog has its own plan. |

No data-loss, no business-logic, no auth surface affected.

---

## 6. Estimation

| Task | Effort |
|---|---|
| Read screen + cross-reference SPEC-components | 0.25 h |
| Replace head + KPI grid + secondary toggle | 0.5 h |
| Convert pickup disclosure | 0.25 h |
| Migrate upcoming-groups table including link + popover menu | 0.75 h |
| Migrate events list + top-accounts table | 0.5 h |
| Remove inline styles, run typecheck, run lint | 0.25 h |
| Manual smoke (light + dark, polling refresh, each kebab action opens its dialog) | 0.5 h |
| Total | **~3 h** |

LOC delta estimate: ~485 → ~330 (≈ −30 %), driven by inline-style removal and popover/disclosure consolidation. One commit, one agent, scope limited to this file plus any new class names added to `cocoa-tokens.css` if disclosure section is not yet a primitive.

---

## 7. Acceptance criteria

1. No inline `style={…}` literal remains in the file.
2. No hex, px, rem, or ms literal remains in the file.
3. No emoji glyphs remain (▾ ▸ ⋯ 🛏️ 🎤 📋 ↻ +).
4. All five dialogs open from the same triggers as before.
5. Polling continues every 120 s; manual Refresh still calls `state.refresh()`.
6. Dark mode toggles cleanly with no contrast regressions on KPI cards, status pills, or popover menu.
7. Keyboard: Tab order unchanged; popover menu opens with Enter/Space, closes with Esc, traps focus while open.
8. Typecheck and lint pass; visual diff reviewed against a screenshot baseline.
