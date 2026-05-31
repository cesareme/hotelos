# Migration Plan 07 — Management Workspace (Cocoa repaint)

**Scope**: `GeneralManagerScreen.tsx`, `OperationsDirectorScreen.tsx`
**Location**: `apps/admin-web/src/screens/operations/`
**Phase**: D (screens) — runs after Cocoa primitives (Phase B) and shell (Phase C) are live.
**Principle**: visual repaint only. No changes to data flow, services, polling intervals, or business logic.

---

## 1. Why these two together

Both are top-of-pyramid dashboards for hotel leadership:

- **GeneralManagerScreen** — strategic view for the property director. KPIs on occupancy, ADR, RevPAR, cash, reputation, productivity, alerts. Polls `/dashboards/general-manager` every 60s.
- **OperationsDirectorScreen** — cross-departmental snapshot one level above the heads of front desk / housekeeping / maintenance. Polls `/dashboards/operations-director` every 30s.

They share the same Aurora v2 surface (`bo-page-head`, `rev-kpi-grid`, `bo-card`, `bo-status`), the same `useApiData` polling pattern, the same `getActiveProperty / getActivePropertyId` access, and the same `navigateTo()` drilldown via `hotelos-nav` custom event. A single agent should own both files to keep the KPI tile, alert pill, and drilldown affordance identical.

---

## 2. Aurora v2 → Cocoa primitive mapping

| Aurora v2 (current markup) | Cocoa replacement | Notes |
|---|---|---|
| `bo-page-head` + eyebrow/title/subtitle | `CocoaPageHeader` with `eyebrow / title / subtitle / actions` slots | Trailing actions: loading/error badges, refresh button. |
| `<button className="ghost">↻</button>` | `CocoaButton variant="ghost" iconOnly aria-label="Refrescar"` with `CocoaIcon name="refresh"` | Replace `↻` with a semantic icon. |
| `<span className="bo-status info\|ok\|warn\|error">` | `CocoaBadge tone="info\|success\|warning\|danger"` | Shared tone map — extract into `screens/operations/managementBadges.ts`. |
| `<article className="rev-kpi rev-kpi-{ok\|warn\|error}">` | `CocoaCard variant="stat"` wrapping `StatTile` with `tone` prop | OperationsDirector: 4 summary tiles; GeneralManager: 6. |
| `rev-kpi-head` + `rev-kpi-label` + `rev-kpi-value` | `StatTile label / value / delta` slots | Delta pill goes in `delta` slot. |
| `rev-kpi-grid` | `CocoaGrid columns={{ base: 1, md: 2, lg: 4 }}` | OperationsDirector summary: 4 cols; GeneralManager hero: 3 cols. |
| `bo-card` for department blocks | `CocoaCard variant="highlight"` with `accent` driven by `health` | Map `ok/warn/error` → `success/warning/danger`. |
| Inline `HEALTH_STYLE` object (lines 43–47) | Deleted. Tones come from Cocoa tokens. | Do not port the hex literals. |
| Alert rows in OperationsDirector | `CocoaList` with `CocoaListItem`; each row has `CocoaIcon` + tone badge | Click row → `navigateTo()`. |
| `deltaPill()` helper (lines 58–68) | Returns `<CocoaTrend value direction tone suffix />` | Keep signature `(deltaPct, suffix)`. |
| Channel mix / segment mix tables | `CocoaTable` with columns `channel / reservations / revenue / pct` | Right-align numeric columns; pct via `CocoaProgressBar` if available. |
| Inline `fontSize: 11`, padding/margin literals | `var(--cocoa-spacing-*)` / `var(--cocoa-font-size-*)` tokens | No `px` literals remain. |

If any Cocoa primitive is missing at migration time, leave the Aurora markup in place and add `// TODO(cocoa): need CocoaX` per Master Plan rule 3.

---

## 3. Common rules across both screens

1. **No literals**. Inline styles (`fontSize: 11`, hex in `HEALTH_STYLE`, `rgba(...)`, padding numbers) move to `var(--cocoa-*)` tokens. The `HEALTH_STYLE` map is the worst offender — delete it outright.
2. **Formatters stay**. `fmtEur`, `fmtPct`, `fmtNumber` are pure helpers; do not touch their signatures or `Intl` locale (`es-ES`).
3. **`useApiData` contracts are frozen**. Endpoint paths, `pollIntervalMs` (60000 / 30000), and `propertyId` query param stay byte-identical.
4. **Navigation contract**. `navigateTo(screen)` and its `hotelos-nav` custom event are read by the app shell — do not rename the event or change the detail payload.
5. **Active property accessors**. `getActiveProperty()` and `getActivePropertyId()` stay; no context replacement here.
6. **No new state, no new effects** unless required to wire a Cocoa prop. If a refactor tempts you, add a TODO and stop.
7. **Polling indicator**. Both currently show `<span className="bo-status info">cargando</span>`. Replace with `CocoaBadge tone="info"` in `CocoaPageHeader actions`; keep the conditional render `{loading ? ... : null}`.
8. **Type unions are contracts**. `health: "ok" | "warn" | "error"`, `severity: "critical" | "warning"`, and `Kpi.tone` drive both data and rendering — do not widen or rename.
9. **Spanish copy is verbatim**. "Gerencia", "Dashboard del director", "Estado operativo", "Atención", "Críticos", "Alertas críticas" — unchanged.

---

## 4. Screen-by-screen tasks

### 4.1 GeneralManagerScreen.tsx

- **Header**: replace `bo-page-head` with `CocoaPageHeader` — eyebrow `"Gerencia · {propertyName}"`, title `"Dashboard del director"`, subtitle `"Vista estratégica del día y del mes en curso · datos a {asOf}"`. Trailing slot: loading/error `CocoaBadge` + refresh `CocoaButton` (ghost, icon-only).
- **KPI hero row** (occupancy / ADR / RevPAR): three `StatTile` inside `CocoaGrid columns={{ base: 1, md: 3 }}`. Value = `fmtPct` or `fmtEur`; `delta` slot consumes `deltaPill(today.vsYesterday?.pct, "vs ayer")`.
- **Revenue card**: `CocoaCard` with primary number = `fmtEur(revenue.today.value)`, secondary list = `revenue.mtdByType` mapped to `CocoaListItem` rows.
- **Productivity card**: small `CocoaCard` with paired metrics (check-ins done/planned, check-outs done/planned, no-shows, cancellations) via `CocoaDescriptionList`.
- **Channel mix / segment mix**: two `CocoaTable`s side by side under `CocoaGrid columns={{ base: 1, lg: 2 }}`. Columns: name / `fmtNumber(reservations)` / `fmtEur(revenue)` / `fmtPct(pct)` — last column right-aligned.
- **Alerts card**: `CocoaCard variant="highlight"` with `accent="danger"` when any of `overbookings / emergencyIncidents / openIncidents / blockedRooms / complianceFailing` is > 0; otherwise `accent="success"`. Body = grid of `StatTile`. Each tile clickable → `navigateTo()` matching existing routing.
- **Cash card**: `CocoaCard` with four `fmtEur` rows. `openBalanceEur > 0` → `CocoaBadge tone="warning"` next to label.
- **Reputation card** (optional render): `CocoaCard` showing `avgScore`, `reviewsLast30`, `npsLast30`. Hide entirely if `reputation` is `undefined`.
- **`deltaPill` helper**: keep signature and call sites; only the JSX changes to `<CocoaTrend ... />` per §2.
- **Out of scope**: replacing the `Data` shape, splitting into sub-components, drilldown on mtdByType rows.

### 4.2 OperationsDirectorScreen.tsx

- **Header**: `CocoaPageHeader` — eyebrow `"Operaciones · Director"`, title `"Estado operativo · {propertyName}"`, subtitle `"Foto cross-departamento. Cada bloque te lleva al tablero específico."`. Trailing slot mirrors GeneralManager.
- **Summary row** (four tiles): `CocoaGrid columns={{ base: 2, md: 4 }}` with `StatTile`s for `departmentsOk` (`success`), `departmentsWarn` (`warning`), `departmentsError` (`danger` when > 0 else `success`), `criticalAlerts` (`danger` when > 0 else `success`). The conditional className pattern maps to a ternary on the `tone` prop.
- **Departments grid**: `CocoaGrid columns={{ base: 1, lg: 2 }}` of `CocoaCard variant="highlight"`, one per `department`. Card `accent` = `success | warning | danger` from `health`. Header: `CocoaHeading level={3}>{name}</CocoaHeading>` + `CocoaBadge tone={...}` carrying the label ("OK" / "ATENCIÓN" / "CRÍTICO"). Body: `headline` + `CocoaDescriptionList` of `kpis[]`. Footer: `primaryAction` → `CocoaButton variant="secondary"` calling `navigateTo(primaryAction.screen)`.
- **Alerts panel**: `CocoaCard` with `CocoaList`. Each row: leading icon (`CocoaIcon name="alert" | "warn"`), title, optional detail, trailing `CocoaBadge tone={severity === "critical" ? "danger" : "warning"}>{department}</CocoaBadge>`. Empty state: `CocoaCard` empty variant `"Sin alertas"`.
- **`HEALTH_STYLE` deletion**: remove the inline hex/rgba map entirely. The `label` field migrates to a tiny `HEALTH_LABEL` const; colors come from Cocoa tones via the badge `tone` prop.
- **Drilldown**: keep `navigateTo()` calls and `hotelos-nav` event. Department cards and alert rows clickable.
- **Out of scope**: paginating departments, animating summary tiles on poll refresh, alert snooze.

---

## 5. Cross-cutting checklist (per Master Plan)

- [ ] No hex, rgb, rem, or px literals in either file (grep before commit). `HEALTH_STYLE` is the obvious deletion target.
- [ ] All icons via `cocoa-icons` — no inline glyphs (`↻`, `▲`, `▼` move into `CocoaTrend`).
- [ ] Dark mode verified via `<ColorSchemeProvider>`: KPI contrast 4.5:1, accent borders legible, focus rings visible.
- [ ] Keyboard reachability: refresh button, clickable `StatTile`s, department cards, alert rows, `primaryAction` buttons.
- [ ] `aria-label` on icon-only buttons.
- [ ] Liquid glass only on `CocoaPageHeader` — never on `StatTile` or alert rows.
- [ ] `npm run typecheck` clean in `apps/admin-web`.
- [ ] Polling intervals preserved (60000 / 30000 ms).
- [ ] `navigateTo` calls and `hotelos-nav` event payload identical.
- [ ] No deletion of Aurora v2 files; class names replaced, not removed.
- [ ] One commit, scoped to both files plus optional `managementBadges.ts`.

---

## 6. Risks and follow-ups

- **`CocoaTrend` availability**. If Phase B has not shipped `CocoaTrend`, fall back to `CocoaBadge tone={success|danger}` with `▲ / ▼` and file a Phase B follow-up.
- **`StatTile` clickability**. Confirm `StatTile` accepts `onClick` and renders semantically (`<a>` or `<button>`). If not, wrap in `CocoaPressable`.
- **Shared badge module**. The first screen migrated should extract `healthBadge(health)` and `severityBadge(severity)` into `screens/operations/managementBadges.ts`.
- **Polling visual feedback**. The current loading indicator is `bo-status info` text. Default: keep parity with `CocoaBadge`; discuss `CocoaSpinner` as a later enhancement.
- **Reputation block absence**. Verify the migrated component returns `null` (not an empty `CocoaCard`) when `reputation` is undefined.
- **Aurora cleanup**. Removing `rev-kpi-*` and `bo-*` CSS happens in a later sweep — do not touch in this commit.
