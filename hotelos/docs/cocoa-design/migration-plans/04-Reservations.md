# Migration Plan 04 — Reservations

**Scope**: `ReservationCreateScreen.tsx` (D4) + `ReservationWorkspaceScreen.tsx` (added).
**Phase**: D — Screen repaint.
**Owners**: D4a (Create), D4b (Workspace). Independent commits, no shared file edits.
**Guiding rule**: function over form. Replace visual atoms only. No changes to data flow, props of consumed APIs, routing, or business logic.

---

## 1. Common context

Both screens belong to the Reservations vertical and share the same data layer (`pmsCommerceApi`), property scoping (`getActivePropertyId`), and toast system (`useToast`). They are the two highest-traffic flows in the Front Desk: creating bookings and operating on the in-house pipeline.

**Files touched (per agent)**:

- D4a: `apps/admin-web/src/screens/reservations/ReservationCreateScreen.tsx`
- D4b: `apps/admin-web/src/screens/reservations/ReservationWorkspaceScreen.tsx`

**Files not touched**: services, API types, breadcrumb logger, navigation events, CSV exporter, `States` (Loading/Empty/Error remain Aurora until a future pass).

**Imports to add (both)**:

```ts
import {
  CocoaButton, CocoaInput, CocoaSelect, CocoaCard,
  CocoaSegmentedControl, CocoaTable, CocoaSearchInput,
  CocoaStepper, CocoaDatePicker, CocoaSwitch,
  CocoaPopover, CocoaSheet
} from "../../components/cocoa";
import {
  IconReservation, IconGuest, IconCalendar, IconSearch,
  IconAdd, IconEdit, IconClose, IconCheck, IconChevronRight,
  IconWarning, IconInfo
} from "../../components/cocoa/icons";
```

**Tokens to use** (no literals):

- Spacing: `--cocoa-space-1` … `--cocoa-space-6`.
- Radii: `--cocoa-radius-sm|md|lg|xl` (concentric rule applies).
- Colors: `--cocoa-text-primary|secondary|tertiary`, `--cocoa-fill-primary|secondary`, `--cocoa-accent`, `--cocoa-success|warning|danger`.
- Materials: `--cocoa-material-thin|regular|thick` (only on toolbars/popovers/sheets).
- Shadows: `--cocoa-shadow-card|popover|sheet`.
- Motion: `--cocoa-duration-fast|base`, `--cocoa-ease-standard`.

---

## 2. D4a — ReservationCreateScreen

### 2.1 Current shape

A long, multi-section form (Estancia, Tarifa, Origen, Pagos, Titular, Documento, Residencia, Acompañantes, Preferencias, Notas). State held in a single `defaultForm` flat object. Side effects: `quoteAvailability` debounce, `scanIdDocument` OCR, `createReservation` on submit, `fetchRoomTypes` / `fetchRooms` / `fetchConfigurationCategories` on mount.

### 2.2 Repaint mapping

| Aurora / native element | Cocoa replacement |
|---|---|
| `<form>` outer container | `<CocoaCard variant="flat">` wrapping each fieldset, stacked with `--cocoa-space-5` gap |
| `<fieldset>` + `<legend>` | `<CocoaCard variant="elevated">` with `header={...}` slot; legend goes into header title |
| `<input type="text|email|tel|number">` | `CocoaInput` with `leading` / `trailing` slots where icons exist |
| `<input type="date">` | `CocoaDatePicker` (single, controlled). Arrival/departure pair uses `range` mode if available; otherwise two adjacent pickers |
| `<input type="time">` | `CocoaInput type="time"` (no dedicated primitive yet — leave `// TODO(cocoa): CocoaTimePicker`) |
| `<select>` (board type, doc type, sex, title, nationality, payment method, source, channel, market segment, rate plan, room type, assigned room) | `CocoaSelect` — keep native `<select>` semantics for a11y |
| Adults / children / infants / rooms count | `CocoaStepper` with `min={0}` and `step={1}` |
| Submit and secondary buttons | `CocoaButton` — `primary` for "Crear reserva", `secondary` for "Cotizar", `tinted` for "Escanear DNI", `destructive` for "Cancelar" |
| Add/remove companion buttons | `CocoaButton variant="plain"` with `IconAdd` / `IconClose` |
| Marketing consent, VIP flag | `CocoaSwitch` (replaces select with yes/no) |
| Availability quote panel | `CocoaCard variant="glass"` pinned to the right rail on wide viewports |
| OCR scan dropzone | `CocoaCard variant="flat"` with dashed border via `--cocoa-border-secondary` |
| Inline error rows | `CocoaInput` `error` + `helper` props; no ad-hoc red text |

### 2.3 Layout

Two-column on `≥1100px`: left column = form sections in `CocoaCard` stack; right column = sticky availability + price summary (`position: sticky; top: var(--cocoa-space-5)`). Single column below that breakpoint. Use CSS grid via tokenized gaps. No inline `style` except dynamic `gridColumn` spans.

### 2.4 State and behavior — untouched

- `useState` shape of `defaultForm` stays identical (do not rename keys, do not split into nested objects). Cocoa primitives accept controlled `value` + `onChange`.
- `Dispatch<SetStateAction<...>>` typed setters keep working.
- `quoteAvailability` debounce, `scanIdDocument` Promise, `createReservation` submit handler, `logBreadcrumb` calls, `useToast()` calls — verbatim.
- Companion list operations (`newCompanion`, add/remove by id) — verbatim.

### 2.5 Acceptance checklist (D4a)

1. No hex codes, no `px`/`rem` literals inside the component file. Every value through `--cocoa-*`.
2. All Aurora primitives (`Button`, `Input`, `Select`, `Card`, `Field`, `Fieldset`) removed; only Cocoa primitives plus raw HTML where no primitive exists (with TODO).
3. No emoji. Icons via `icons.ts`.
4. `tsc --noEmit` clean. No `any` introduced.
5. Form submits successfully against the mock service — manual smoke: create reservation, observe toast, observe breadcrumb log.
6. Light and dark mode both legible; focus rings visible on every interactive element.
7. Keyboard path from arrival date → submit is unbroken; tab order matches visual order.
8. `// TODO(cocoa): ...` comments for: time picker, OCR dropzone affordance, nationality combobox.

---

## 3. D4b — ReservationWorkspaceScreen

### 3.1 Current shape

A list/detail workspace: KPI strip on top, status tabs, search and status filter, sortable reservations table, right-hand detail panel with folio, activity feed, and action buttons (assign room, check-in, check-out, cancel, no-show, post charge, post payment). Row multi-select with bulk actions stub. CSV export.

### 3.2 Repaint mapping

| Aurora / native element | Cocoa replacement |
|---|---|
| KPI cards (arrivals, total value, status counts) | `CocoaCard variant="flat"` row; numerals in `--cocoa-text-primary`, captions in `--cocoa-text-secondary` |
| Status tabs (`STATUS_TABS`) | `CocoaSegmentedControl` controlled by `statusTab` — keep keys and labels |
| Secondary status filter (`STATUS_FILTERS`) | `CocoaSelect` next to the search field |
| Search field | `CocoaSearchInput` with `IconSearch` leading and clear button |
| Reservations table | `CocoaTable` — column defs map to existing `SortKey`s. Sort indicators (`▲▼`) replaced by Cocoa's built-in sort arrow icons; sort logic (`sortKey`, `sortDir`) remains in caller |
| Sticky table header | provided by `CocoaTable` |
| Row checkboxes for `selectedRowIds` | `CocoaTable` selection prop; do not roll own |
| Empty / loading / error blocks | keep `LoadingBlock`, `EmptyState`, `ErrorState` from `components/States` until a Cocoa equivalent ships (TODO) |
| Detail panel | `CocoaCard variant="elevated"` with sticky header (`CocoaToolbar` slot inside the card) |
| Action buttons (check-in, check-out, cancel, no-show, assign room, post charge, post payment) | `CocoaButton` — `primary` for check-in / check-out, `tinted` for assign room / post charge, `destructive` for cancel / no-show. Group in a `display: flex; gap: var(--cocoa-space-2)` row |
| Activity feed items | `CocoaCard variant="flat"` per item, icon from `icons.ts` matched by activity kind |
| Folio breakdown | `CocoaTable` compact density variant |
| Confirmation dialogs for destructive actions | `CocoaSheet` (modal) replacing `window.confirm` if currently used. If not used yet, leave a `// TODO(cocoa): use CocoaSheet for cancel/no-show confirmation` |
| Row count cap notice (`ROW_CAP`) | `CocoaCard variant="flat"` with `IconInfo` |

### 3.3 Layout

`CocoaSplitView` is provided by the layout shell — do **not** re-wrap. Inside, two columns: list (flex 2) and detail (flex 1, min 360 px). Below `1100px`, detail collapses into a `CocoaSheet` opened on row click. Spacing via `--cocoa-space-4` / `--cocoa-space-5`.

### 3.4 State and behavior — untouched

- `useState` keys (`reservations`, `roomTypes`, `selected`, `folio`, `loading`, `error`, `query`, `statusFilter`, `statusTab`, `sortKey`, `sortDir`, `selectedRowIds`) — verbatim.
- `load()`, the folio-loading effect on `selected`, `statusCounts` memo, `arrivals` computation, `roomTypeName` helper, `openReservation` async handler — verbatim.
- All API calls and the `nav()` custom event helper — verbatim.
- CSV export via `exportToCsv` — verbatim.
- The `today` bug fix comment stays; do not regress to a hard-coded date.

### 3.5 Acceptance checklist (D4b)

1. No hex codes or pixel literals inside the component file. All values via `--cocoa-*` tokens.
2. Aurora `SegmentedControl` import removed; replaced by `CocoaSegmentedControl`. (The Aurora import currently in the file is the only one to delete.)
3. Table sorts on click, filter narrows rows, search debounce (if any) untouched, KPI counts match.
4. Selected reservation loads folio without flicker; effect cleans up on rapid selection changes.
5. Light and dark mode both legible; sticky header keeps contrast on scroll.
6. Keyboard: tab into segmented control, arrow keys move between segments; table rows reachable via tab, Enter opens detail.
7. `tsc --noEmit` clean; no `any` added.
8. `// TODO(cocoa): ...` left for: States primitives, confirmation sheet, activity icon mapping completeness.

---

## 4. Gate (shared)

Both screens render, navigate, and submit/operate without functional regression. Visual delta vs Aurora is expected and welcome. Hand off to E1 (visual consistency), E2 (a11y), and E3 (bundle) supervisors.

End of plan 04.
