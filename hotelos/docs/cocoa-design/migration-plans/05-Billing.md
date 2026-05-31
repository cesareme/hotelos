# Migration Plan 05 — Billing Workspace (Cocoa repaint)

**Scope**: `BillingCenterScreen.tsx`, `FolioDetailScreen.tsx`, `InvoiceDetailScreen.tsx`
**Location**: `apps/admin-web/src/screens/billing/`
**Phase**: D (screens) — runs after Cocoa primitives (Phase B) and shell (Phase C) are live.
**Principle**: visual repaint only. No changes to data flow, services, routing, or business logic.

---

## 1. Why these three together

The three screens form one navigational unit:

- **BillingCenterScreen** — list/dashboard of invoices for the active property, with tabs (`draft / issued / pending / paid / cancelled`), folio sidebar, branding panel and draft creator.
- **FolioDetailScreen** — workspace for one folio with four tabs (`charges / payments / routing / notes`) and drag-and-drop charge moving.
- **InvoiceDetailScreen** — read-only invoice viewer with `markPaid` and `sendEmail` actions.

They share the same Aurora v2 primitives (`SegmentedControl`, `DataTable`, `StatTile`, `SearchInput`, `StatusBadge`, `PageHeader`), the same domain types (`InvoiceDraft`, `InvoiceFull`, `Folio`, `FolioLine`), and the same money/date formatting helpers. A single agent (or a tight pair) should own the migration to keep formatters and badge variants identical across the three views.

---

## 2. Aurora v2 → Cocoa primitive mapping

| Aurora v2 (current import) | Cocoa replacement | Notes |
|---|---|---|
| `components/v2/SearchInput` | `cocoa/CocoaSearchInput` | Same `value / onChange / placeholder` props. Confirm shortcut (`/` to focus) survives. |
| `components/v2/SegmentedControl` | `cocoa/CocoaSegmentedControl` | Used twice in BillingCenter (top tabs + folio tabs) and once in FolioDetail. Generic over `TabKey extends string`. |
| `components/v2/StatTile` | `cocoa/CocoaCard` with `size="lg"` variant | FolioDetail uses `size lg` for balance due — port the size prop. |
| `components/v2/DataTable` | `cocoa/CocoaTable` | Preserve `DataTableColumn` type alias under a new `CocoaTableColumn` export. Both invoice list and line tables. |
| `components/v2/StatusBadge` (`StatusBadgeVariant`) | `cocoa/CocoaStatusBadge` | Map `success / info / neutral / danger / warn` 1:1. Invoice statuses already enumerated in `statusBadgeVariant()` — copy that function verbatim. |
| `components/v2/PageHeader` | `cocoa/CocoaToolbar` (Phase C) | The toolbar is the new page header; trailing slot for actions. |
| `components/Toast` (`useToast`) | unchanged | Toast lives in app shell, no visual change required here. |

If any Cocoa primitive is missing at migration time, leave the Aurora import in place and add `// TODO(cocoa): need CocoaX` per Master Plan rule 3.

---

## 3. Common rules across the three screens

1. **No literals**. All inline styles using `rem`, `px`, hex, or `rgba()` must move to `var(--cocoa-*)` tokens. Existing `CSSProperties` blocks in InvoiceDetailScreen (header chrome, badge inline styles) are the heaviest offenders — audit first.
2. **Money / date formatters stay**. `fmtMoney`, `fmtNumber`, `fmtDate` in InvoiceDetail and `fmtMoney` in FolioDetail are pure helpers; do not touch their signatures.
3. **`sessionStorage` keys are contracts**. Both `hotelos.billing.paidInvoiceIds` and `hotelos.folio.note.<folioId>` are read by sibling screens — keep names and JSON shape unchanged.
4. **URL conventions**. `readInvoiceIdFromUrl()` and FolioDetail's `#folio=fol_xxx` hash parser must keep working byte-for-byte.
5. **No new state, no new effects** unless required to wire a Cocoa primitive prop. If a refactor tempts you, add a TODO and stop.
6. **Drag-and-drop in FolioDetail**: native HTML5 DnD via `DragEvent`. Cocoa repaint must not alter `draggable`, `onDragStart`, `onDrop` semantics. Visual affordance (drop target highlight) becomes a `--cocoa-color-accent-bg` ring; the move-charges PATCH endpoint stays the same.
7. **Empty states**: replace bespoke "no data" blocks with `CocoaCard` empty variant. Copy strings unchanged.

---

## 4. Screen-by-screen tasks

### 4.1 BillingCenterScreen.tsx

- **Header**: replace the implicit header with `CocoaToolbar` — title "Centro de facturación", subtitle from `status`. Trailing slot: branding-panel toggle and CSV export.
- **Tabs**: `TAB_DEFS` array maps directly into `CocoaSegmentedControl items={TAB_DEFS}` — keep `InvoiceTab` literal union.
- **Search**: `SearchInput` → `CocoaSearchInput`, preserve `search` state and the existing filter `useMemo`.
- **Invoice list**: `DataTable` columns array (`number / customer / total / status / actions`) ports 1:1 to `CocoaTable`. Status cell renders a `CocoaStatusBadge` via the variant map shared with InvoiceDetail (extract once into `billing/statusBadge.ts` if not yet shared).
- **Folio sidebar** (`folioTab` segmented control + notes textarea + payment list): wrap in `CocoaCard` with internal `CocoaSegmentedControl`. Notes textarea uses `CocoaInput` `multiline`.
- **Branding panel**: logo URL + legal footer inputs → `CocoaInput`. Save button → `CocoaButton variant="primary"`.
- **Draft creator** (customerType / invoiceType / taxId / totals): grid of `CocoaInput` and two `CocoaSegmentedControl`s. Create button → primary.
- **Preview modal** (`preview: InvoiceFull`): `CocoaSheet` (medium size) with the same body content.
- **Email composer** (`emailDraft`): `CocoaSheet` (small) — `to / subject / body` are `CocoaInput`, send is primary.
- **Persistence**: `paidIds` set + `readPaidIds / writePaidIds` untouched.
- **Out of scope here**: replacing the `fetchInvoices` API shape, adding pagination, refactoring tab filter logic.

### 4.2 FolioDetailScreen.tsx

- **Page header**: `CocoaToolbar`. Title = folio number, subtitle = reservation reference. Trailing actions: `Split folio` (secondary) and `Cerrar folio` (primary, disabled when `balanceDue !== 0`).
- **Balance hero**: existing `StatTile size="lg"` → `CocoaCard size="lg"` showing `balanceDue` via `fmtMoney`. Visual treatment uses `--cocoa-color-accent-fg` when balance is positive, `--cocoa-color-success-fg` when zero.
- **Tabs**: `FolioTab` segmented control → `CocoaSegmentedControl` with the four keys. Tab body lives below.
- **Charges tab**: list of `FolioLine` rows is a `CocoaTable` with `selectable` rows (multi-select for DnD). Drag handle column on the left. The "other folios" lateral list is a vertical `CocoaCard` stack; each card becomes a drop target — apply `data-dropzone` attribute and toggle `--cocoa-color-accent-bg` ring on `onDragOver`.
- **Payments tab**: `CocoaTable` of `PaymentRecord` — columns: capturedAt / method / amount / status (`CocoaStatusBadge`) / pspReference.
- **Routing tab**: list of `FolioRoutingRule` rows in a `CocoaTable`. "Nueva regla" button → `CocoaButton variant="secondary"` placeholder (no behavior change).
- **Notes tab**: `CocoaInput multiline rows={10}` bound to `folioNote`. Auto-save to `sessionStorage` via existing `writeNote` debounced effect — keep as is.
- **Empty states**: each tab gets `CocoaCard` empty variant ("Sin cargos", "Sin pagos", "Sin reglas").
- **Drag visuals**: replace inline highlight styles with `[data-dropzone="active"] { box-shadow: 0 0 0 2px var(--cocoa-color-accent-bg); }` in a colocated CSS module — no behavior change.

### 4.3 InvoiceDetailScreen.tsx

- **Toolbar**: existing `PageHeader` → `CocoaToolbar`. Title = `invoice.number`, subtitle = customer name. Trailing slot: `CocoaStatusBadge` + `Marcar pagada` (primary, hidden when already paid) + `Enviar por email` (secondary).
- **Status badge**: keep `InvoiceUiStatus` union, `statusBadgeVariant`, `statusBadgeLabel` exactly. They become the shared module mentioned above.
- **Summary card**: replace the inline-styled grid (`CSSProperties` block) with `CocoaCard` containing key/value rows. Currency cells use `fmtMoney`; date cells use `fmtDate`.
- **Line items**: `DataTable` columns (description / qty / unitPrice / tax / total) → `CocoaTable`. Number cells right-aligned via `align="end"` column option.
- **Tax breakdown**: a second smaller `CocoaTable`.
- **Totals footer**: `CocoaCard` highlighted (`tone="accent"`) showing `subtotal / taxTotal / total / amountPaid / balanceDue` via `fmtMoney`.
- **Email composer**: `CocoaSheet` (small) — identical fields to BillingCenter. Reuse the component if extracted.
- **URL parsing**: `readInvoiceIdFromUrl()` stays; do not introduce a router dependency.
- **Paid-mark sync**: `PAID_STORAGE_KEY` and helpers stay. `markInvoicePaid` call signature unchanged.

---

## 5. Cross-cutting checklist (per Master Plan)

- [ ] No hex, rgb, rem, or px literals in the three files (search-and-grep before commit).
- [ ] All icons via `cocoa/icons.ts` semantic map — no inline `lucide-react` imports.
- [ ] Dark mode verified via `<ColorSchemeProvider>` toggle: text contrast 4.5:1, badges remain legible, hover/focus rings visible.
- [ ] Keyboard reachability: tabs, table rows, sheet close, primary/secondary buttons all focusable; focus rings on every interactive element.
- [ ] `aria-label` on icon-only buttons (split folio handle, drag handle, close folio).
- [ ] Liquid glass only on toolbar/sheets/popovers — never on `CocoaTable` rows or `CocoaCard` bodies.
- [ ] `npm run typecheck` clean in `apps/admin-web`.
- [ ] `logBreadcrumb` calls preserved at every mutation (create draft, issue, mark paid, send email, move charges, save note, close folio).
- [ ] No deletion of Aurora v2 files; legacy imports replaced, not removed.
- [ ] One commit, scoped to `apps/admin-web/src/screens/billing/` plus any shared Cocoa primitive additions that landed in Phase B already.

---

## 6. Risks and follow-ups

- **CocoaTable column API parity**. If `align`, `selectable`, or custom cell renderers are missing in Phase B's CocoaTable, file a Phase B follow-up rather than diverging the screen logic.
- **Sheet sizing**. The preview sheet must hold a full invoice — confirm `CocoaSheet` supports `size="lg"` before this plan executes.
- **Shared badge module**. The first of the three screens migrated should extract `statusBadgeVariant / statusBadgeLabel / InvoiceUiStatus` into `screens/billing/invoiceStatus.ts` so the other two import it.
- **DnD a11y**. Native HTML5 DnD is not keyboard-accessible; tracked as out-of-scope but worth flagging for a future Phase F follow-up.
- **Aurora cleanup**. Removing `components/v2/*` happens in a later sweep — do not touch in this commit.
