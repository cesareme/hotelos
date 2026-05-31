# HotelOS Cocoa Redesign — Master Implementation Plan

**Version**: 1.0
**Status**: Ready for execution
**Target**: 40 agents across 7 phases
**Goal**: Migrate `apps/admin-web` from Aurora v2 to a Cocoa-native (macOS Tahoe / Liquid Glass) look without breaking functionality.

---

## 0. Executive summary

We are repainting, not rebuilding. The React tree, routing, data layer, and screen logic stay intact. Only the **visual layer** — tokens, primitives, shell, screens — changes. The work is sliced into seven phases (A through G) executed by 40 agents. Phases A through D are productive (tokens, primitives, shell, screens). Phases E through G are review and verification (supervisors, reviewers, verifiers).

All output flows into two new locations:

- `apps/admin-web/src/styles/cocoa-tokens.css` — new design tokens.
- `apps/admin-web/src/components/cocoa/` — new primitive components.

The old Aurora v2 stack stays in place during the transition and is only removed in a future cleanup pass (out of scope here).

---

## 1. Guiding principles (non-negotiable)

1. **Function over form**: no agent may change behavior, data flow, props of consumed APIs, routing, or business logic. If a refactor is needed to repaint, stop and add a TODO.
2. **Additive only**: new tokens, new components, new file paths. Do not delete Aurora v2 files in this pass.
3. **Cocoa primitives are the only allowed visual atoms in repainted screens**. If a `CocoaX` does not exist, leave the Aurora component in place and register `// TODO(cocoa): need CocoaX`.
4. **Tokens, not literals**: no hex codes, no rem/px size literals inside component files. Every color, radius, spacing, shadow, blur is a CSS variable from `cocoa-tokens.css`.
5. **Dark mode is automatic**: every token has a light and dark value, switched by `prefers-color-scheme` plus a manual override class.
6. **Accessibility floor**: 4.5:1 contrast on body text, 3:1 on large text and UI, focus rings always visible, all interactive elements keyboard reachable, all icons paired with `aria-label` when not decorative.
7. **No emojis** in production UI. Icons come from `lucide-react` (web) or SF Symbols (future native app only).
8. **Concentric radii**: parent radius equals child radius plus child padding. Hardcoded radii must derive from `--cocoa-radius-*` tokens.
9. **Liquid Glass with restraint**: vibrancy/blur on sidebar, toolbar, popovers, sheets. Never on body content, never on data tables.
10. **One commit per agent**, scoped to its file set. No cross-agent file editing.

---

## 2. File and folder contract

```
apps/admin-web/src/
  styles/
    cocoa-tokens.css        (NEW — Phase A)
  styles.css                (MODIFIED — Phase A, imports cocoa-tokens.css)
  components/
    cocoa/                  (NEW — Phase B)
      CocoaButton.tsx
      CocoaInput.tsx
      CocoaSelect.tsx
      CocoaSearchInput.tsx
      CocoaSegmentedControl.tsx
      CocoaStepper.tsx
      CocoaDatePicker.tsx
      CocoaSwitch.tsx
      CocoaCard.tsx
      CocoaTable.tsx
      CocoaPopover.tsx
      CocoaSheet.tsx
      CocoaToolbar.tsx      (Phase C)
      CocoaSidebar.tsx      (Phase C)
      CocoaSplitView.tsx    (Phase C)
      icons.ts              (Phase A — semantic icon map)
      index.ts              (barrel export)
  layouts/
    BackOfficeLayout.tsx    (MODIFIED — Phase C)
  screens/
    ...                     (MODIFIED — Phase D)
```

---

## 3. Phase A — Foundations (5 agents, parallel)

**Objective**: design tokens, base CSS, dependency, font stack, icon map.

| # | Agent | Output |
|---|-------|--------|
| A1 | Tokens author | Create `styles/cocoa-tokens.css` with the full `--cocoa-*` palette (colors, radii, spacing, shadows, materials, motion). Two `@media (prefers-color-scheme)` blocks plus `.dark` / `.light` override classes. |
| A2 | Token migrator | In `styles.css`, replace Aurora token usages with `--cocoa-*` equivalents via a mapping table (Aurora → Cocoa). Aurora variables stay defined as fallbacks pointing to Cocoa. |
| A3 | Dark mode wiring | Add a small `useColorScheme` hook plus a `<ColorSchemeProvider>` in `App.tsx`. Default: system. Override: localStorage `cocoa.colorScheme = light | dark | system`. |
| A4 | Dependency installer | `npm install lucide-react` inside `apps/admin-web`. Pin to a known stable major. Update `package.json` and lockfile only. |
| A5 | Font + icon map | Update font stack in `styles.css` to `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Inter", system-ui, sans-serif`. Create `components/cocoa/icons.ts` exporting semantic icons (`IconGuest`, `IconReservation`, `IconBilling`, `IconCompliance`, `IconCalendar`, `IconSearch`, `IconClose`, `IconChevronRight`, `IconAdd`, `IconEdit`, `IconTrash`, `IconCheck`, `IconWarning`, `IconError`, `IconInfo`, `IconHome`, `IconSettings`, `IconUser`) mapping each to a `lucide-react` icon. |

**Gate**: Phase A merges before Phase B starts. Tokens, dark mode, and icon map must compile.

---

## 4. Phase B — Cocoa primitives (12 agents, parallel)

**Objective**: build the visual atoms. Each agent owns one file under `components/cocoa/`. All primitives:

- Are typed React function components with forward refs where applicable.
- Accept `className` and merge it after internal classes (consumer override wins).
- Use CSS Modules or plain class names; no inline `style` except for dynamic values.
- Expose `data-cocoa="<name>"` for QA hooks.
- Include `disabled`, `loading`, error states where semantically meaningful.
- Include a tiny JSDoc with a usage example.

| # | Agent | File | Notes |
|---|-------|------|-------|
| B1 | Button | `CocoaButton.tsx` | Variants: `primary`, `secondary`, `tinted`, `plain`, `destructive`. Sizes: `sm`, `md`, `lg`. Loading spinner. Icon slot left/right. |
| B2 | Input | `CocoaInput.tsx` | Text/email/password/number. Leading and trailing slots. Error and helper text. Focus ring uses accent. |
| B3 | Select | `CocoaSelect.tsx` | Native select for a11y, repainted chrome. Chevron icon. |
| B4 | SearchInput | `CocoaSearchInput.tsx` | Pill shape, leading magnifying-glass, clear button when value present. ⌘F shortcut hint slot. |
| B5 | SegmentedControl | `CocoaSegmentedControl.tsx` | Pill background, sliding selection indicator. Controlled component. |
| B6 | Stepper | `CocoaStepper.tsx` | +/- with numeric value. Min, max, step props. Keyboard arrows. |
| B7 | DatePicker | `CocoaDatePicker.tsx` | Calendar popover (uses `CocoaPopover` once available — declare temporary inline popover, leave TODO). Range mode optional. |
| B8 | Switch | `CocoaSwitch.tsx` | iOS-style toggle. Accent color on. Keyboard space toggles. |
| B9 | Card | `CocoaCard.tsx` | Squircle, optional header, footer, divider. Material variants: `elevated`, `flat`, `glass`. |
| B10 | Table | `CocoaTable.tsx` | Header, sortable columns (visual only, sort logic stays on caller), zebra optional, hover row, selection. Sticky header. |
| B11 | Popover | `CocoaPopover.tsx` | Floating panel with arrow, glass material, focus trap, escape to close. Anchored to a ref. |
| B12 | Sheet | `CocoaSheet.tsx` | Modal sheet sliding from top (macOS sheet metaphor). Backdrop dim, focus trap, escape to close. |

**Gate**: every primitive renders in isolation with all variants. A simple Storybook-less sanity page (`/__cocoa-preview`) may be added by B12 if needed.

---

## 5. Phase C — Shell macro (4 agents, parallel)

**Objective**: rebuild the window chrome around existing content.

| # | Agent | Output |
|---|-------|--------|
| C1 | CocoaToolbar | Top toolbar with title slot, leading slot (sidebar toggle), trailing slot (actions, search). Unified style by default. Translucent material, sticky. |
| C2 | CocoaSidebar | Full-height left panel with material `.sidebar`. Source-list semantics: sections, items, badges, icons via `icons.ts`. Collapsible. |
| C3 | CocoaSplitView | Wrapper that places sidebar and content side-by-side, with a resizable divider and persisted width in localStorage. |
| C4 | BackOfficeLayout migrate | Swap the current shell in `layouts/BackOfficeLayout.tsx` for `CocoaSplitView` + `CocoaSidebar` + `CocoaToolbar`, wrapping the existing `<Outlet/>` content area. Routes and nav data unchanged. |

**Gate**: app loads, sidebar navigates, toolbar shows, all existing screens render inside the new shell (even if their internals are still Aurora — that's Phase D).

---

## 6. Phase D — Screen repaint (8 agents, parallel)

**Objective**: replace Aurora primitives with Cocoa primitives inside the 8 highest-traffic screens. **No logic changes.**

| # | Agent | Screen file |
|---|-------|-------------|
| D1 | FrontDeskDashboard | `screens/.../FrontDeskDashboard.tsx` |
| D2 | GroupsEventsDashboard | `screens/.../GroupsEventsDashboard.tsx` |
| D3 | AllotmentsScreen | `screens/.../AllotmentsScreen.tsx` |
| D4 | ReservationCreateScreen | `screens/.../ReservationCreateScreen.tsx` |
| D5 | BillingCenterScreen | `screens/.../BillingCenterScreen.tsx` |
| D6 | FolioDetailScreen | `screens/.../FolioDetailScreen.tsx` |
| D7 | ComplianceCenterScreen | `screens/.../ComplianceCenterScreen.tsx` |
| D8 | GeneralManagerScreen | `screens/.../GeneralManagerScreen.tsx` |

Each D-agent must:

1. Replace Aurora buttons, inputs, cards, tables, etc. with the Cocoa equivalents.
2. Replace ad-hoc hex colors and pixel values with `--cocoa-*` tokens.
3. Replace inline icons / emoji with `icons.ts` exports.
4. Keep all props passed to data-bound components untouched.
5. If a needed primitive is missing, leave the Aurora component, add `// TODO(cocoa): missing CocoaX`, and continue.
6. Verify the screen still mounts (no runtime error) by running the dev server once at the end.

**Gate**: each screen renders, navigates, and submits without regressions. Visual diffs are expected and welcome.

---

## 7. Phase E — Supervisors (3 agents, sequential after D)

| # | Supervisor | Scope |
|---|------------|-------|
| E1 | Visual consistency | Walks all 8 repainted screens. Flags inconsistent spacing, radii, accent usage, typography scale. Produces a delta list. May apply micro-fixes. |
| E2 | Accessibility | Runs axe-style checks: contrast, focus visibility, keyboard traversal, ARIA on icons, motion-reduce respect. Reports violations with file:line. |
| E3 | Performance | Measures bundle size before/after (`vite build` + analyzer). Verifies lucide-react tree-shaking. Flags any new chunk over 50 KB gzipped. Confirms backdrop-filter is gated behind `@supports`. |

**Gate**: supervisor reports merged into a single findings list. Blocker-level items must be fixed before Phase F.

---

## 8. Phase F — Reviewers (3 agents, parallel after E)

| # | Reviewer | Scope |
|---|----------|-------|
| F1 | Bugs and race conditions | Reviews diffs from B, C, D for null derefs, effect cleanup, stale closures, unbounded re-renders, focus traps that leak, popovers that don't unmount. |
| F2 | Design system | Audits Cocoa primitives for API drift (props named consistently, variants spelled the same, default values aligned), and screens for token leakage (any literal hex/px should be flagged). |
| F3 | Types and tests | `tsc --noEmit` clean across api + web. Adds smoke tests for each Cocoa primitive (renders, fires handler, respects disabled). Verifies existing tests still pass. |

**Gate**: all reviewer comments triaged. Must-fix items resolved.

---

## 9. Phase G — Verifiers (5 agents, parallel)

| # | Verifier | Action |
|---|----------|--------|
| G1 | Typecheck | `pnpm -F api typecheck && pnpm -F admin-web typecheck` — exit code 0. |
| G2 | Tests | `pnpm -F admin-web test --run` — green. |
| G3 | Build + bundle | `pnpm -F admin-web build`, capture `dist` size, compare to baseline captured before Phase A, report delta. |
| G4 | Visual smoke | Boots the app, navigates to each of the 8 repainted screens, screenshots them in light and dark mode, attaches to final report. |
| G5 | Final report | Aggregates G1 to G4 outputs plus the supervisor and reviewer findings, writes the closeout summary, attaches before/after screenshots. |

**Gate**: final report green. If any verifier fails, route back to the responsible phase.

---

## 10. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Bundle size jumps with lucide-react | Medium | Medium | Import per-icon (`import { Search } from 'lucide-react'`) in `icons.ts`, never the barrel. Verified in G3. |
| SF Pro not freely licensed for web | High | Low | Use `-apple-system` first (renders SF on macOS), Inter as fallback elsewhere. No font file shipped. |
| `backdrop-filter` GPU cost on mobile | Medium | Medium | Gate behind `@supports (backdrop-filter: blur(10px))`. Fallback to opaque material with raised opacity. Disable on `prefers-reduced-transparency`. |
| Token migration breaks Aurora screens not yet repainted | Medium | High | A2 keeps Aurora variables defined as aliases of Cocoa tokens. Aurora components keep working visually-close. |
| Agents touching same file | Low | High | Strict file ownership per agent (this doc is the source of truth). Reviewers (F1) flag cross-edits. |
| Time overrun beyond 45 min | Medium | Low | Phases A, B, D run parallel — total wall time dominated by D (longest screen). Hard cap per agent: 12 min; if exceeded, agent files a TODO and exits clean. |
| Dark mode regressions | Medium | Medium | Every token has a dark value at creation (A1). G4 captures dark screenshots. |
| Accessibility regression from glass materials | Medium | Medium | E2 enforces contrast on glass surfaces. Materials carry a built-in tint to maintain 4.5:1 on text. |

---

## 11. Deliverables

At completion of Phase G, the repository contains:

1. `apps/admin-web/src/styles/cocoa-tokens.css` — complete, dual-theme token set.
2. `apps/admin-web/src/components/cocoa/` — 15 components plus `icons.ts` and `index.ts`.
3. `apps/admin-web/src/layouts/BackOfficeLayout.tsx` — rebuilt around `CocoaSplitView`.
4. 8 repainted screens (D1 to D8), 100 percent Cocoa primitives.
5. Automatic light/dark mode driven by system, overridable per user.
6. Typecheck, tests, build all green.
7. Bundle delta within agreed budget (target: under +60 KB gzipped).
8. Before/after screenshots, light and dark, for each repainted screen.
9. Closeout report (G5) listing residual TODOs for the cleanup pass.

---

## 12. Out of scope (next pass)

- Removing Aurora v2 source files.
- Repainting secondary screens beyond the priority 8.
- Native macOS app (SF Symbols, AppKit) — design parity only.
- Motion polish beyond default transitions.
- Storybook or visual regression infra.

---

## 13. Execution order recap

```
A (5 parallel)  →  B (12 parallel)  →  C (4 parallel)  →  D (8 parallel)
                                                              ↓
                                            E (3 sequential supervisors)
                                                              ↓
                                            F (3 parallel reviewers)
                                                              ↓
                                            G (5 parallel verifiers)
```

Total agents: 5 + 12 + 4 + 8 + 3 + 3 + 5 = **40**.

End of master plan.
