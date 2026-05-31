# Migration Plan 03 — AllotmentsScreen

**Source**: `apps/admin-web/src/screens/admin/AllotmentsScreen.tsx` (1232 lines, single file)
**Phase**: D — Screen repaint
**Risk**: Medium-high. Largest screen in the admin app, mixes 3 domains (Pickup / Allotments / Tour Operators), two full-form dialogs, an inline `ReleasePreview`, and a custom timeline visualisation (`AllotmentLifecycleRow`). One agent, scoped to this single file. No behaviour change.

---

## 0. Scope and non-goals

In scope: replace every Aurora v2 class (`bo-card`, `bo-card-head`, `bo-row`, `bo-muted`, `bo-status`, `bo-chip`, `rev-kpi*`, `rev-report-wrap`, `cm-table`, `.primary`, `.ghost`) and every raw `<button>` / `<input>` / `<select>` with the matching Cocoa primitive from `components/cocoa/`. Keep markup structure, hooks, `useApiData` calls, `useMemo` derivations, `setBusy/setMsg`, `release()`, `setToOpen/setAllotOpen`, tab state, form payloads, and all dialog submit logic byte-for-byte identical.

Out of scope: API shape, polling intervals (`60000`), KPI math, the `windowDays=60` query, `releaseExpired()` semantics, toast text, copy in Spanish, the three-tab information architecture (already a previous declutter pass — DEV #5), file split (stays as one file).

---

## 1. Surface inventory (top 200 lines)

| Block | Lines | Aurora artifact | Cocoa target |
|---|---|---|---|
| Outer container | 69 | `section.bo-card` flex column gap 18 | `CocoaCard` variant `section`, padding `--cocoa-space-5`, gap `--cocoa-space-4` |
| Header | 70–84 | `header.bo-card-head` + eyebrow + h2 + paragraph + button row | `CocoaToolbar` (titlebar slot) with eyebrow caption, `h2` in `--label-primary`, secondary paragraph in `--label-secondary` |
| Refresh + Release buttons | 81–82 | raw `<button>` + `<button class="primary">` | `CocoaButton variant="bordered"` (↻ Actualizar), `CocoaButton variant="filled-accent"` (Liberar). Spinner kept inline. |
| Status banner | 86 | `<p class="bo-status ok">` | `CocoaBanner` tone `success`, `role="status"` and `aria-live="polite"` preserved verbatim |
| KPI grid | 91–96 | `.rev-kpi-grid` + 4 `.rev-kpi.rev-kpi-ok` | `CocoaCard variant="kpi"` × 4 inside `CocoaGrid columns={4}`. `bo-status info` chips → `CocoaBadge tone="info" size="xs"` |
| Tab strip | 100–127 | `<nav role="tablist">` with `.primary` / `.ghost` buttons | `CocoaSegmentedControl` with three segments. `role="tab"` + `aria-selected` automatic from primitive. Keep `setActiveTab(tab.id)`. |
| Pickup panel | 130–132 | `PickupLifecycleCard` child component | Repainted in section 3 (same file, internal helper) |
| Operators panel | 134–172 | `article.bo-card` + `cm-table` | `CocoaCard` + `CocoaTable` (section 4) |
| Allotments panel | 174–end of slice | `article.bo-card` + `cm-table` | Same pattern as Operators (section 4) |

---

## 2. Token / class substitutions (mechanical pass)

These run as a single search-and-replace across the file, no logic touched:

- `className="bo-card"` → `className="cocoa-card"` (and drop inline `style={{ display: "flex", flexDirection: "column", gap: 18 }}` — covered by `cocoa-card--section` modifier)
- `className="bo-card-head"` → `className="cocoa-card__head"`
- `className="bo-row"` → `className="cocoa-row"` (gap stays via `style` only if not 8/12/16; otherwise use `--cocoa-space-2` modifier)
- `className="bo-muted"` → drop, replace with `<CocoaText tone="secondary" size="caption">` or rely on `--label-secondary` in surrounding component
- `className="bo-status ok"` → `<CocoaBadge tone="success">`
- `className="bo-status info"` → `<CocoaBadge tone="info">`
- `className="bo-chip"` → `<CocoaBadge tone="neutral" size="sm">`
- `className="rev-kpi-grid"` → `<CocoaGrid columns={4} gap="md">`
- `className="rev-kpi rev-kpi-ok"` → `<CocoaCard variant="kpi" tone="success">`
- `className="rev-kpi-head"` / `rev-kpi-label` / `rev-kpi-value` → slot props of `CocoaCard variant="kpi"` (`label`, `value`, `badge`)
- `className="rev-report-wrap"` → `<CocoaTable.Wrap>` (handles overflow + scroll affordance)
- `className="cm-table"` → `<CocoaTable>` (renders its own `<table>`)
- `className="mono"` → `<CocoaText family="mono">` or `className="cocoa-mono"`
- Inline `style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}` (line 72) → drop; use `<CocoaText variant="eyebrow">` which already encodes that style
- Inline `style={{ color: "var(--ink)" }}` (lines 73, 137, 177) → drop; `CocoaCard__head` enforces `--label-primary`
- Inline `style={{ marginTop: 4 }}` (line 74) → use `--cocoa-space-1` margin via wrapper, or drop (card padding already spaces siblings)
- Inline `style={{ fontSize: 10 }}` on badges (line 164) → drop; `CocoaBadge size="xs"` is the token-anchored equivalent

The two raw button row entries (lines 81–82) must read `<CocoaButton onClick={...} disabled={busy}>` with the spinner moved into the toolbar's `accessory` slot (toolbar primitive renders it on the leading edge).

---

## 3. Internal sub-components

The slice declares `PickupLifecycleCard` (lines 131, 1041–1077) and `AllotmentLifecycleRow` (1072, 1079–1208) as helpers in the same file. They render the pickup timeline visualisation (per-allotment bars with colored segments for confirmed / pickup / unsold / released). They are NOT extracted to their own files in this pass — additive only, see MASTER-PLAN §1.

Repaint plan for `PickupLifecycleCard`:
- Wrapping `<article class="bo-card">` → `<CocoaCard variant="section" tone="surface">`.
- Section header → `CocoaCard.Head` slot.
- The skeleton path (loading state) → `<CocoaSkeleton variant="timeline" rows={3} />`.
- The empty state currently using `EmptyState` from `components/States` stays as-is — `EmptyState` will be repainted by its own agent in Phase B; this agent does NOT modify it.
- Per-row bars in `AllotmentLifecycleRow` are SVG-ish divs with inline backgrounds. Backgrounds must move from literal HSL/hex to tokens: confirmed → `--cocoa-color-success`, pickup → `--cocoa-color-accent`, unsold → `--cocoa-color-warning`, released → `--cocoa-color-neutral-tertiary`. `Stat` and `Legend` helpers (1209+) become thin wrappers over `CocoaBadge` and `CocoaText`.

If any color cannot be mapped to a token, the agent leaves a `// TODO(cocoa): missing token for X` comment and keeps the literal (per Principle 4 + escape hatch).

---

## 4. Tables (Operators + Allotments)

Both `<table class="cm-table">` blocks (lines 153 and 191) collapse to `<CocoaTable>` with:

```tsx
<CocoaTable
  columns={[
    { id: "code", header: "Code", align: "left", mono: true },
    { id: "name", header: "Nombre" },
    ...
  ]}
  rows={tourOperators}
  rowKey={(t) => t.id}
  empty={<EmptyState .../>}  // keep existing EmptyState passthrough
/>
```

Behaviour preserved:
- `<th>` text identical.
- `mono` class on the code column maps to `column.mono`.
- The status cell (`bo-status ok|info` ternary based on `t.active`) becomes `<CocoaBadge tone={t.active ? "success" : "neutral"}>activo|inactivo</CocoaBadge>` rendered via a `column.cell` render prop, NOT pre-rendered, to keep the conditional inline like the original.
- Allotments table same approach: 8 columns, dates via `fmtDate`, numbers via `fmtNum` (untouched).
- Hover / zebra striping comes from `CocoaTable` defaults; no custom CSS needed.

---

## 5. Dialog handlers (NewTourOperatorDialog, NewAllotmentDialog)

The screen owns two pieces of dialog state and their handlers:

```ts
const [toOpen, setToOpen] = useState(false);
const [allotOpen, setAllotOpen] = useState(false);
```

Plus the open/close wiring around line 215 and 228:

```ts
onClose={() => setToOpen(false)}
onCreated={() => { setToOpen(false); tos.refresh(); }}
onClose={() => setAllotOpen(false)}
onCreated={() => { setAllotOpen(false); allots.refresh(); pickup.refresh(); }}
```

These handlers are NOT touched. The dialog component shells (`NewTourOperatorDialog`, `NewAllotmentDialog`) are wrapped in `CocoaSheet` (full-form variant, anchored to viewport). Inside the dialog the agent repaints:
- The `<form>` skeleton → `CocoaForm` (purely a styling primitive, no submit logic).
- `Field(props)` helper (line 1029) → swap the label/hint markup for `CocoaField` primitive (props identical: `label`, `hint`, `children`).
- Raw inputs/selects/dates inside the dialog body → `CocoaInput`, `CocoaSelect`, `CocoaDatePicker`, `CocoaStepper` (for room counts), `CocoaSwitch` (for `active` boolean).
- Submit button row → `CocoaButton variant="filled-accent" type="submit"` + `CocoaButton variant="bordered" onClick={onClose}`.
- The inline `ReleasePreview` (line 982) inside `NewAllotmentDialog` → `CocoaCard variant="hint" tone="info"`, content untouched.
- `submitting` spinner state stays — it now drives `CocoaButton loading={submitting}` rather than swapping label text.
- Error banner (`setError`) → `CocoaBanner tone="critical"` placed directly above the action row.

The `setToOpen(false)` and `setAllotOpen(false)` callbacks must remain the close handlers. Refreshes (`tos.refresh`, `allots.refresh`, `pickup.refresh`) are called in the exact same order to keep cache invalidation deterministic.

---

## 6. Things the agent MUST NOT touch

- `useApiData` URLs, intervals, and refresh order.
- `release()` body, including the toast-equivalent `setMsg` Spanish text.
- KPI math in `useMemo` (line 61–66).
- The `activeTab` segmented control values: `"pickup" | "allotments" | "operators"`. Default stays `"pickup"`.
- `fmtDate` and `fmtNum` helpers (lines 20–26).
- Spanish copy. Every label, button, eyebrow, empty-state text, and error string is preserved verbatim. This includes `"⤓ Liberar cuotas vencidas"`, `"+ Nuevo TT.OO."`, `"+ Nuevo cupo"`, etc. The leading glyph (`⤓`, `+`, `↻`) is replaced by the matching `lucide-react` icon (`Download`, `Plus`, `RefreshCw`) passed as `leadingIcon` to `CocoaButton`. The text itself stays.
- Form payload shapes (`CreateTourOperatorPayload`, `CreateAllotmentForm`).
- `EmptyState`, `ErrorState`, `LoadingBlock`, `Spinner` imports from `components/States` (those are owned by their own Phase B agent).
- `useToast` and `showToast` plumbing.

---

## 7. Verification checklist

1. `npm run typecheck` in `apps/admin-web` is clean.
2. `npm run lint` does not report any newly introduced `style={...}` literals other than dynamic values (e.g. bar widths in `AllotmentLifecycleRow` driven by `pickupPct`).
3. Manual smoke: switch tabs, open both dialogs, submit each with valid data, verify refresh propagates to KPI counts, trigger `release()` and verify banner appears.
4. Dark mode toggle: every newly introduced class resolves through `--cocoa-*` tokens; no hex codes appear in the diff (grep `git diff` for `#[0-9a-fA-F]{3,6}` → expect zero hits).
5. Keyboard: Tab order remains header → refresh → release → segmented control → active panel content → dialog trigger.
6. Reduced-motion: `CocoaSheet` and `CocoaSegmentedControl` already honour `prefers-reduced-motion`; no extra wiring needed.

---

## 8. Commit

One commit, scoped to `apps/admin-web/src/screens/admin/AllotmentsScreen.tsx`. Message: `feat(cocoa): repaint AllotmentsScreen onto Cocoa primitives`. No co-edits to tokens, primitives, or sibling screens. If a Cocoa primitive is missing during the repaint, the agent stops and files a TODO in the file rather than inventing one.
