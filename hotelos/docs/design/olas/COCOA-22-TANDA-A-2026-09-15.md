# Cocoa 22 · Tanda A (olas 1 · 2 · 4 · 9) — Informe de cierre · 15 de septiembre de 2026

**Para:** César. **Alcance:** primera tanda de migración de pantallas al sistema
Cocoa 22 (spec `docs/design/COCOA-22.md`, plan `docs/design/COCOA-22-MIGRACION.md`)
sobre la fundación commiteada en `3a232dc`: ola 1 · Público (lote 1-A), ola 2 · Hoy
(2-A, 2-B), ola 4 · Operaciones (4-A, 4-B, 4-C) y ola 9 · Informes (9-A), más una
verificación adversarial con navegador (18 hallazgos confirmados, `qa#1`–`qa#19`
sin `qa#12`), ocho lotes de corrección (`fix:1-A`, `fix:2-A`, `fix:2-B`, `fix:4-A`,
`fix:4-B`, `fix:4-C`, `fix:9-A`, `fix:primitives`), la integración de los handoffs de
primitivas/CSS/scripts y este cierre (integrador sin navegador). **Sin commit**: todo
está en el árbol de trabajo de `hotelos/` (73 ficheros modificados · 2 retirados ·
16 nuevos, este informe incluido). Ningún dato de negocio se ha escrito ni restaurado
(todas las comprobaciones contra el API fueron `GET` de solo lectura).

Método de medida: `node scripts/cocoa-22-inventory.mjs` (puntos de deuda por
pantalla; fórmula en `docs/design/cocoa-22-inventory.json`), contrato
`tests/cocoa-22-contract.test.mjs` (reglas 1–15) y las puertas de §7.3 del plan.
«Antes» = inventario commiteado en `3a232dc`; «después» = inventario regenerado en
este cierre.

## 1. Resumen en cifras

| Métrica | Antes (`3a232dc`) | Después (cierre tanda A) | Δ |
|---|---|---|---|
| Pantallas inventariadas | 202 | 200 | −2 (muertas retiradas) |
| Líneas en `screens/` | 77.564 | 77.083 | −481 |
| **Puntos de deuda** | **5.729** | **4.600** | **−1.129 (−19,7 %)** |
| `.bo-card` · otras `.bo-*` | 928 · 3.505 | 762 · 2.820 | −166 · −685 |
| `<button>` crudos (CocoaButton) | 634 (324) | 488 (457) | −146 (+133) |
| `<table>` crudas (CocoaTable) | 158 (35) | 121 (76) | −37 (+41) |
| Inputs crudos (Cocoa) | 546 (251) | 491 (310) | −55 (+59) |
| `style={` | 4.513 | 3.788 | −725 |
| Colores literales (fallbacks) | 514 (269) | 419 (237) | −95 (−32) |
| `<h1>` crudos · emoji | 50 · 164 | 42 · 127 | −8 · −37 |
| Con cabecera Cocoa · `useTabHost` | 91 · 59 | 112 · 52 | +21 · −7 |
| Tamaños S · M · L · XL | 62 · 109 · 27 · 4 | 70 · 103 · 23 · 4 | |
| `NOT_MIGRATED` = `ALLOWLIST_CEILING` | 197 | **153** | −44 (35 pantallas + 2 muertas + 7 contenedores) |
| Migradas (entradas fuera de la allowlist) | 5 (pilotos, 8 pts) | **47** (40 pantallas + 7 contenedores, 62 pts) | +42 |
| Pendientes (§6 del plan) | 197 ficheros · 5.721 pts | **153 ficheros · 61.541 líneas · 4.538 pts** · S 47 · M 81 · L 21 · XL 4 · 20 lotes · 32 contenedores · 6 muertas | −1.183 pts |

Descomposición de los −1.129 puntos: **−1.065** por las 35 pantallas migradas y las
2 muertas retiradas (1.119 → 54); **−65** estructurales porque
`scripts/cocoa-22-inventory.mjs` ya no penaliza «sin cabecera» a diálogos, drawers,
contenedores y sub-vistas exentas (espejo de `HEADER_EXEMPT` del contrato; 13 ficheros
sin tocar bajan 5 puntos cada uno: `ScreenScaffold`, `ModuleSettingsPlaceholder`,
`tabs/configuracion/tab-helpers`, `InviteUserDialog`, `NewTenantWizardDialog`,
`ResetPasswordConfirmDialog`, `SplitFolioDialog`, `InvoiceRectifyDialog`,
`GroupDetailDialog`, `NewEventDialog`, `NewGroupDialog`, `RoomBlockGridDialog`,
`RoomingListImportDialog`); **+1** en `dev/StyleGuideScreen.tsx` (9 → 10: +113 líneas
de ejemplos de las primitivas nuevas, `style={` 37 → 39).

Por categoría (puntos): Hoy 219 → **17** · Informes 208 → **7** · Operaciones 967 →
**352** · Público 78 → **6** (8 → 6 pantallas) · Compartido 36 → 26 · Configuración
1.106 → 1.086 · Finanzas 628 → 618 · Desarrollo 42 → 43 · Comercial 591 ·
Cumplimiento 787 · Recepción 687 · Revenue 380 (sin cambios).

## 2. Pantallas migradas por ola (puntos antes → después)

Puntos y líneas del inventario (`3a232dc` → cierre). Arquetipo = el de la receta §3
del plan (entre paréntesis, el que asigna la heurística del inventario cuando
difiere). «Pendientes» = lo que no se ha podido cerrar sin navegador o depende de un
handoff (§6).

### Ola 1 · Público — lote 1-A · 76 → 4 pts (marco `auth/AuthShell.tsx` reescrito)

| Fichero (`screens/`) | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `auth/AcceptInviteScreen.tsx` | otro (auth, PlantillaBase sobre AuthShell) | 12 → 1 | 193 → 228 | CocoaPageHeader (eyebrow `AUTH_EYEBROW`), CocoaState loading, CocoaField + CocoaInput password, CocoaCallout danger/success, CocoaButton filled large `loading`, datos en `ul.c22-section__list`, `lib/format dateTime` | fases «ready»/«done» solo estáticas; el saludo «Hola, {nombre}» va en el subtítulo (ya existe `wrap` en CocoaPageHeader: puede volver al título) |
| `auth/ChangePasswordScreen.tsx` | otro (auth) | 11 → 1 | 152 → 198 | mismo marco; errores de validación como `CocoaField.error`; pie `ACTIONS.signOut` / `ACTIONS.signIn` | verificación visual (sesión con `mustChangePassword`) |
| `auth/ResetPasswordScreen.tsx` | otro (auth) | 11 → 1 | 136 → 164 | mismo marco; estados «Enlace no válido» / «Contraseña restablecida» | visual |
| `auth/ForgotPasswordScreen.tsx` | otro (auth) | 6 → 1 | 128 → 130 | CocoaPageHeader, `CopyLinkRow` = CocoaField + CocoaInput readOnly + CocoaButton bordered | estado submitted + testLink solo estático |
| `errors/CocoaNotFoundScreen.tsx` | otro | 6 → 0 | 112 → 50 | CocoaPage `state="error"` + CocoaState error `illustration="search"` con «Volver al inicio» / «Buscar…» (⌘K) | ilustración en tono error (handoff `illustrationTone`, opcional) |
| `auth/CocoaLoginScreen.tsx` | **muerta** (0 importadores) | 21 → — | 548 → — | retirada (git `D`; copia en `scratchpad/c22-removed/`) | — |
| `errors/CocoaServerErrorScreen.tsx` | **muerta** (0 importadores) | 9 → — | 217 → — | retirada (git `D`; copia en `scratchpad/c22-removed/`) | — |
| `auth/AuthShell.tsx` (compartido, fuera del inventario) | marco auth | — | +126/−82 | `<main>` centrado con safe-area · CocoaCard elevated `maxWidth 440` · AuthAlert = CocoaCallout · PasswordChecklist con CheckCircleIcon + sr-only · HiddenUsername · gutter `--cocoa-content-padding` (24 → 16 px en < 600, qa#16) | medida DOM a 390 |
| `auth/LoginScreen.tsx` (piloto) | otro (auth) | 6 → 6 | 992 → 992 | solo el gutter (qa#16) | — |

### Ola 2 · Hoy — lote 2-A · 205 → 11 pts (+ `components/cocoa-director/*`)

| Fichero | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `operations/QuickCheckInDrawer.tsx` | diálogo/drawer | 50 → 3 | 818 → 759 | CocoaDrawer right/md (`initialFocus` + `focusKey`), cronómetro CocoaBadge, 4 pasos CocoaSection, CocoaField + CocoaSelect (habitación, método), CocoaSegmentedControl cobro, CocoaCallout (sugerencia, folio, SES), CocoaState; estancias previas por `GET /guests/:id/timeline` (qa#6); etiqueta de habitación sin «planta ?» (qa#7) | hoja inferior en 390 sin medir |
| `operations/QuickCheckOutDrawer.tsx` | diálogo/drawer | 48 → 3 | 572 → 576 | CocoaDrawer, folio en CocoaTable compact + totales, CocoaSwitch ×3, CocoaCallout 409 `BALANCE_DUE`, estado de bloqueo en español (qa#8) | visual |
| `operations/OperationsDirectorScreen.tsx` | dashboard alojado (Mi día) / standalone | 47 → 1 | 1.360 → 747 | CocoaPage con `tabs` (HostedHead), CocoaKpiStrip, `DirectorOpsHealthMini` (píldoras con `toneInk`, qa#4), CocoaSegmentedControl «Detalle» (etiquetas cortas en teléfono + fade por `segmentedOverflows`, qa#5) + 4 CocoaTable, CocoaChart.Line, polling 30 s intacto | medida a 390 |
| `owner/OwnerHomeScreen.tsx` | dashboard alojado | 24 → 1 | 173 → 214 | CocoaPage, CocoaKpiStrip ×6, CocoaGrid 6/6, CocoaTable, polling 60 s | — |
| `operations/FrontDeskActionQueue.tsx` | lista (sub-vista de `/hoy`, exenta de cabecera) | 23 → 1 | 431 → 422 | CocoaSection + CocoaToolbar content (CocoaSegmentedControl con recuentos) + CocoaGrid de CocoaCard por acción, CocoaState | — |
| `operations/FrontDeskDashboard.tsx` | dashboard standalone | 13 → 2 | 1.040 → 753 | CocoaPage, tarjeta de instrucciones en español (qa#11, `content/screen-instructions/frontdesk-cockpit.ts`) | — |
| `components/cocoa-director/` (6 ficheros) | tiles del canon | — | +238/−988 | `DirectorKpiTile` = alias de CocoaKpi; gauge/donut/pace/pickup sobre `cocoa-chart-math`; `DirectorOpsHealthMini` con `tone: CocoaTone` | literales residuales en `DirectorVipList`, `DirectorAiInsightCard`, `DirectorBarRecommendations` (ola 11) |
| `operations/GeneralManagerScreen.tsx` (canon) | dashboard | 3 → 3 | — | píldora «críticas» con `tone: "danger"` | — |

### Ola 2 · Hoy — lote 2-B · 131 → 9 pts

| Fichero | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `operations/NightAuditScreen.tsx` | dashboard standalone | 42 → 1 | 355 → 312 | CocoaPage, banner CocoaCallout con «Cerrar día», CocoaKpiStrip, checklist de CocoaCallout con badges, CocoaTable del historial, toast fijo retirado | banner con acción a 390 (CSS ya envuelve `.c22-callout` < 600; sin medir) |
| `aiOperations/AiHumanReviewQueueScreen.tsx` | lista + KPI | 40 → 3 | 499 → 525 | CocoaPage + CocoaKpiStrip + CocoaToolbar (CocoaSelect ×2, CocoaSwitch) + CocoaTable con `rowActions` + CocoaDrawer de detalle; etiquetas y valores en español por `ai-review-labels.ts` (qa#15) | valores libres de la semilla en inglés (dato, no UI) |
| `aiOperations/AiOwnerSummaryScreen.tsx` | dashboard standalone | 27 → 1 | 215 → 301 | CocoaPage, CocoaKpiStrip de CocoaKpi / CocoaCallout, CocoaGrid 6/6 | — |
| `assistant/AssistantChatScreen.tsx` | chat | 22 → 4 | 196 → 254 | CocoaPage + CocoaGrid 8/4: hilo en CocoaSection `scroll="y"` (ahora `maxHeight` real), compositor CocoaInput multiline + CocoaButton, aside de herramientas | — |

### Ola 4 · Operaciones — lote 4-A · 157 → 7 pts (+ `CocoaScreenInstructionsCard`)

| Fichero | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `operations/MaintenanceMobileScreen.tsx` | otro (móvil; inventario: dashboard) | 43 → 2 | 302 → 368 | CocoaPage, chips CocoaButton `aria-pressed`, CocoaKpiStrip de CocoaCard por avería, CocoaButton large ≥ 44 px, CocoaDrawer «Añadir nota», CocoaActionBar mobileOnly, useToast | copy de `content/screen-instructions/maintenance.ts` (handoff) |
| `operations/HousekeepingMobileScreen.tsx` | otro (móvil; inventario: dashboard) | 40 → 2 | 425 → 406 | misma receta; CocoaCallout petición especial; CocoaDrawer «Reportar incidencia» | copy de `housekeeping.ts` (handoff) |
| `operations/MaintenanceDashboard.tsx` | workspace (`STYLE_BUDGET` 40) | 42 → 1 | 264 → 461 | CocoaPage, CocoaKpiStrip ×5, CocoaGrid 4/8 lista + ficha (CocoaDrawer en teléfono/tablet), alta en CocoaDrawer | — |
| `operations/HousekeepingDashboard.tsx` | dashboard standalone | 32 → 2 | 277 → 363 | CocoaPage, CocoaKpiStrip ×5, `<style>` inyectado eliminado | — |
| `components/cocoa-guidance/CocoaScreenInstructionsCard.tsx` | compartido | — | +13/−54 | cierre = CocoaButton plain small con `CloseIcon` (≥ 44 px en pointer coarse, qa#10); 12 importadores | medida coarse a 390 |

### Ola 4 · Operaciones — lote 4-B · 199 → 9 pts

| Fichero | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `operations/PosDashboard.tsx` | workspace (`STYLE_BUDGET` 40; inventario: asistente) | 66 → 4 | 354 → 527 | CocoaPage, CocoaKpiStrip, «Arqueo de caja» con CocoaFormRow(4) de CocoaDatePicker ×2 + CocoaSelect + acciones alineadas abajo (qa#1), CocoaTable por outlet, comandas en CocoaGrid de CocoaSection (CocoaStepper, CocoaInput), CocoaDrawer de detalle | R8 alturas CocoaInput 34 vs CocoaStepper/CocoaSelect 28 en la fila de consumo; `style={bottomAligned}` hasta la utilidad `[data-self="end"]` |
| `admin/FnbMenuScreen.tsx` | dashboard alojado | 42 → 1 | 352 → 455 | CocoaPage, CocoaKpiStrip, tablist WAI-ARIA de CocoaButton `role="tab"` (id, `aria-controls`, roving tabindex, flechas; qa#18), CocoaTable, CocoaDrawer «Nuevo item» (chips de categoría; `CocoaInput suggestions` ya disponible) | — |
| `operations/InventoryDashboard.tsx` | dashboard alojado | 36 → 1 | 344 → 292 | CocoaPage, CocoaKpiStrip ×5, CocoaTable ×2, CocoaChart.Bars | — |
| `admin/FnbInventoryScreen.tsx` | dashboard alojado | 30 → 2 | 176 → 254 | CocoaPage `tabs`, CocoaTable (`rowTone` ya disponible para stock bajo) | recuento en el label de la pestaña (handoff `count` en CocoaPageHeaderTab) |
| `operations/ProcurementDashboard.tsx` | dashboard alojado | 25 → 1 | 234 → 227 | CocoaPage, CocoaKpiStrip, CocoaTable; «Pedidos» en vez de «PO/POs» (qa#17) | no medido en pantalla (Carmen sin módulo Compras) |

### Ola 4 · Operaciones — lote 4-C · 143 → 7 pts (+ `module-gate.ts`, `useScreenModuleGate.ts`)

| Fichero | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `operations/WorkforceDashboard.tsx` | workspace ligero (`STYLE_BUDGET` 40) | 49 → 2 | 265 → 531 | CocoaPage (estado «Módulo no activado» + CTA «Activar módulo», sin peticiones hasta `moduleGate.ready`, qa#14), CocoaKpiStrip ×5, CocoaGrid, CocoaTable ×2 con `rowActions`/`onSelect`, CocoaChart.Bars, 3 CocoaDrawer (`CocoaDatePicker withTime` ya disponible para Inicio/Fin) | rama «unknown» (sin `modules.read`) sigue como antes hasta `useApiData.status` |
| `operations/SafetyDashboard.tsx` | workspace ligero (`STYLE_BUDGET` 40) | 44 → 2 | 226 → 475 | ídem con `useScreenModuleGate("SafetyDashboard")`, CocoaDrawer ficha + alta | ídem |
| `operations/AssetsDashboard.tsx` | dashboard standalone | 32 → 2 | 313 → 326 | CocoaPage, CocoaKpiStrip, CocoaTable ×3, CocoaChart.Progress | — |
| `operations/EnergyDashboard.tsx` | dashboard standalone | 18 → 1 | 266 → 258 | CocoaPage sobre `treeHeaderFor`, CocoaKpiStrip, CocoaTable, CocoaChart.Line | — |

### Ola 9 · Informes — lote 9-A · 208 → 7 pts

| Fichero | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `operations/PropertyDetailScreen.tsx` | dashboard alojado (Cartera) | 36 → 1 | 353 → 391 | CocoaPage, CocoaKpiStrip ×8, CocoaGrid 4/4/4 de listas, CocoaTable «Reservas recientes» | `avgReviewRating` sin escala |
| `revenue/RevenueExportCenter.tsx` | dashboard alojado (Centro de informes) | 35 → 1 | 528 → 460 | CocoaSection plain por ritual (meta ≤ 24 caracteres, «cuándo» como párrafo; qa#2) + CocoaGrid de tarjetas con CocoaFormRow + CocoaDatePicker, CocoaTable de la sesión; `export-center-rituals.ts` | medida a 390 |
| `operations/ChannelPerformanceDashboard.tsx` | dashboard standalone | 30 → 1 | 337 → 249 | CocoaPage, CocoaKpiStrip, CocoaTable + CocoaChart.Progress (`max` ya disponible) + CocoaChart.Donut | — |
| `operations/RoomProfitabilityDashboard.tsx` | dashboard standalone | 28 → 1 | 265 → 219 | CocoaPage, CocoaKpiStrip (deltaLabel ≤ 22 caracteres, qa#9), CocoaTable ×3, CocoaChart.Bars | elipsis real en `.c22-delta__label` (handoff) |
| `reports/ReportingCenterScreen.tsx` | dashboard alojado | 28 → 1 | 249 → 338 | CocoaPage con estado honesto, CocoaKpiStrip ×3, CocoaGrid 6/6, CocoaFormRow + CocoaSelect ×2, tablas sin claves duplicadas (`uniqueByFolio`, qa#3) | ventana fija `2026-05-01/31` heredada; causa raíz en el API |
| `operations/PortfolioDashboard.tsx` | dashboard standalone | 26 → 1 | 452 → 402 | CocoaPage, CocoaTable ancha (10 columnas sortable, `stickyFirstColumn`, `maxHeight` 520), CocoaCallout de alertas | medida 1024/390 |
| `operations/AnalyticsCenterDashboard.tsx` | dashboard alojado | 25 → 1 | 301 → 199 | CocoaPage, CocoaKpiStrip, CocoaTable | — |

### Contenedores fuera de la allowlist (7 · 0 pts · sin código)

`tabs/hoy/MiDiaTabs.tsx` · `tabs/informes/CarteraTabs.tsx` ·
`tabs/informes/CentroInformesTabs.tsx` · `tabs/operaciones/ComprasInventarioTabs.tsx`
· `tabs/operaciones/MantenimientoTabs.tsx` · `tabs/operaciones/PisosTabs.tsx` ·
`tabs/operaciones/PuntoVentaTabs.tsx`.

## 3. Contrato, inventario y scripts

- `tests/cocoa-22-contract.test.mjs`: `NOT_MIGRATED` 197 → **153** líneas (35 pantallas,
  2 muertas, 7 contenedores) y `ALLOWLIST_CEILING` 197 → **153** (= longitud);
  `STYLE_BUDGET` +7 entradas (`QuickCheckInDrawer` 15 · `QuickCheckOutDrawer` 15 ·
  `FrontDeskActionQueue` 15 · `PosDashboard` 40 · `WorkforceDashboard` 40 ·
  `SafetyDashboard` 40 · `MaintenanceDashboard` 40); `HEADER_EXEMPT` +
  `operations/FrontDeskActionQueue.tsx` (sub-vista de `/hoy`); `GLOBAL_CEILING`
  941/647/159/553/539/4607 → **762/488/121/491/419/3788** (este cierre rebaja
  `inlineStyles` 3795 → 3788 a los totales regenerados; el resto ya estaba en el
  total). 18/18 reglas en verde.
- `docs/design/cocoa-22-inventory.json` regenerado (200 · 77.083 · 4.600) y
  `docs/design/COCOA-22-MIGRACION.md` §6 reescrito por `cocoa-22-waves.mjs --write`
  (153 pendientes · 4.538 pts · 20 lotes); §0 actualizado a mano en este cierre.
- `scripts/cocoa-22-inventory.mjs`: `debtPoints(m, headerExempt)` con el espejo de
  `HEADER_EXEMPT` (diálogos, drawers, `tabs/`, `ScreenScaffold`,
  `ModuleSettingsPlaceholder`, `FrontDeskActionQueue`) y `headerExempt` en cada fila
  del JSON; `scripts/cocoa-22-waves.mjs`: notas `DEAD` de las dos pantallas retiradas
  eliminadas.
- `docs/design/COCOA-22.md` §8.2 regenerado por `cocoa-22-api.mjs --write` (39
  ficheros · 65 interfaces · 53 type aliases · 607 props · 153 funciones · 29
  constantes · 1.756 líneas): props nuevas de §4.
- Tests nuevos (untracked, 959 líneas en 15 ficheros): `auth/__tests__/auth-gutter-contract`,
  `cocoa-guidance/__tests__/CocoaScreenInstructionsCard`, `cocoa/__tests__/CocoaSection`,
  `aiOperations/__tests__/ai-review-labels`, `operations/__tests__/{frontdesk-labels,
  module-gate, room-profitability-kpi-foot}`, `reports/__tests__/reporting-center-rows`,
  `revenue/__tests__/export-center-rituals`; módulos puros junto a la pantalla:
  `ai-review-labels.ts`, `frontdesk-labels.ts`, `module-gate.ts`, `useScreenModuleGate.ts`,
  `reporting-center-rows.ts`, `export-center-rituals.ts`. Tests modificados:
  `screens/__tests__/screens-fixes-contract.test.mts` (`/<CocoaPage(?:Header)?\b/`),
  `dev/__tests__/style-guide-coverage.test.mts` (+9 usos exigidos en la guía),
  `cocoa/__tests__/CocoaControls.test.mts` (`segmentedOverflows`).

## 4. Primitivas, hojas y componentes compartidos (handoffs resueltos en la tanda)

`components/cocoa/**` (13 ficheros, +174/−72), `styles/**` (3 hojas, +101/−4) y la guía
`dev/StyleGuideScreen.tsx` (+113 líneas, cada prop nueva con ejemplo exigido por
`style-guide-coverage`):

| Handoff (lote) | Resuelto con |
|---|---|
| Título de auth recortado en escritorio (1-A) | `CocoaPageHeader`/`CocoaPage` prop `wrap` (`headerTitleStyle(isNarrow, wrap)`) |
| Foco inicial tras la carga del drawer (2-A) | `CocoaDrawer` prop `focusKey` (re-evalúa `initialFocus`) |
| Opción «ninguno» real en CocoaSelect (2-A) | documentado en la prop `placeholder` (§8.2) |
| Fila meta/acción de CocoaSection en teléfono (2-A, 9-A, qa#19 → qa#1/qa#2) | cabecera sin estilos inline en `CocoaSection.tsx`; `styles/cocoa-22-layout.css` < 600: `.c22-section__head { flex-wrap: wrap }`, `.c22-section__action { flex-wrap: wrap; min-width: 0; max-width: 100% }`, `.c22-section__meta { white-space: normal }`; `.c22-section__title { min-width: 0 }`; cabecera a ras con `plain` + `padding="none"` |
| Banner CocoaCallout con acciones a 390 (2-B) | `.c22-callout { flex-wrap: wrap }` + `.c22-callout__actions { flex-basis: 100% }` < 600 |
| `maxHeight` de CocoaSection = altura fija (2-B) | ahora es `max-height` real (el hilo vacío queda corto) |
| Prompt de un campo en CocoaDialog (4-A) | `CocoaDialog` prop `initialFocus` |
| Filas seleccionables multilínea (4-A) | `CocoaButton` prop `wrap` |
| `datalist` en CocoaInput (4-B) | `CocoaInput` prop `suggestions` |
| Tono por fila en CocoaTable (4-B) | `CocoaTable` prop `rowTone` (+ reglas `tr[data-tone=…]`) y `rowTitle` (9-A) |
| Fecha y hora (4-C) | `CocoaDatePicker` prop `withTime` (`datetime-local`) |
| Progreso escalado (9-A) | `CocoaChart.Progress` props `max` y `valueLabel` |
| Enlace y caption sin control (9-A, 4-B) | utilidades `.cocoa-link` y `.cocoa-caption` en `styles/cocoa-base.css` |
| Pista «opcional» a 1,88:1 (qa#13) | `.c22-field__hint` en `--cocoa-label-secondary` (6,04:1 claro · 6,2:1 oscuro, medido con las hojas reales) |
| Segmented de 4 opciones desborda a 390 (qa#5) | `segmentedOverflows()` + `data-fade` con `mask-image`, scroll-snap y padding final; etiquetas cortas por `useViewportTier` en la pantalla |
| Textos de 11 px con tono crudo (qa#4) | `DirectorOpsHealthBreakdownItem.tone: CocoaTone` → `toneInk` (contraste 6,55–10,10 claro · 4,71–6,28 oscuro, calculado) |
| Botón de cierre de 24 px (qa#10) | `CocoaScreenInstructionsCard` con CocoaButton plain small (44 × 44 en coarse) |
| Regla 7 para sub-vistas y penalización del inventario (2-A) | `HEADER_EXEMPT` en contrato e inventario |
| `screens-fixes-contract` exige `<CocoaPageHeader` (4-C) | acepta `<CocoaPage` |
| `content/actions.ts` (2-B) | `ACTIONS.escalate`, `ACTIONS.assignToMe`, `STATUS_LABELS.failed` |
| `authApi.formatExpiry` (1-A) | se conserva: lo usan `UserRoleManager.tsx:133` y `admin/TenantAdminConsoleScreen.tsx:54` |

## 5. Hallazgos de QA y estado

18 confirmados; **18 corregidos en código** por los lotes `fix:*`; la comprobación en
navegador de las correcciones sigue pendiente salvo donde se indica.

| # | Sev. | Lote | Hallazgo | Estado |
|---|---|---|---|---|
| qa#1 | media | 4-B | hScroll del `main` a 390 por el cluster `action` de «Arqueo de caja» | Corregido: acciones en la 4.ª celda de la CocoaFormRow + meta corto; causa raíz en qa#19 (CSS). Medido antes/después a 1440 por `fix:4-B` |
| qa#2 | media | 9-A | hScroll a 390 por meta/action de las secciones plain de ritual | Corregido: `meta` ≤ 24 caracteres (test) + «cuándo» como párrafo; CSS de qa#19. Sin medir a 390 |
| qa#3 | media | 9-A | Claves React duplicadas en el centro de informes | Corregido en cliente (`uniqueByFolio`); causa raíz en `reporting.service.ts:189` (folio por reserva → duplicado) pendiente (§6) |
| qa#4 | media | 2-A | Textos de 11 px con tonos crudos < AA en salud operativa | Corregido (`toneInk`); contraste calculado, sonda `lowContrast` sin ejecutar |
| qa#5 | media | 2-A | Segmented de 4 opciones desborda a 390 sin fade | Corregido (primitiva + etiquetas cortas); sin medir |
| qa#6 | media | 2-A | `GET /reservations/:id/guest-history` 404 en cada check-in | Corregido: `GET /guests/:id/timeline` (`metrics.totalStays`); optimización `priorStays` pendiente (§6) |
| qa#7 | baja | 2-A | «Hab. 119 · planta · limpia» / «planta ?» | Corregido (`frontdesk-labels.ts` + test) |
| qa#8 | baja | 2-A | Estado crudo en inglés en el aviso de bloqueo del check-out | Corregido (`RESERVATION_STATUS_LABELS`) |
| qa#9 | baja | 9-A | deltaLabel recortados sin elipsis en KPI de 221 px | Corregido en la pantalla (≤ 22 caracteres, test); elipsis en la primitiva pendiente (§6) |
| qa#10 | baja | 4-A | «Cerrar instrucciones» de 24 px en pointer coarse | Corregido (CocoaButton; test SSR con `pointer: coarse`) |
| qa#11 | baja | 2-A | Copy en inglés/jerga sin tildes en la tarjeta de Mi día | Corregido (`screen-instructions/frontdesk-cockpit.ts`); el mismo patrón en `maintenance.ts` y `housekeeping.ts` pendiente (§6) |
| qa#13 | baja | primitives | Pista «opcional» en label-tertiary (1,88:1) | Corregido (`--cocoa-label-secondary`, medido con Chromium headless) |
| qa#14 | baja | 4-C | 403 silenciosos en Personal y Seguridad sin módulo | Corregido (`useScreenModuleGate` + estado «Módulo no activado» + CTA); rama «unknown» pendiente de `useApiData.status` |
| qa#15 | baja | 2-B | Drawer de revisión con título y claves en inglés | Corregido (`ai-review-labels.ts`, 11 tests); valores libres de la semilla en inglés (§6) |
| qa#16 | baja | 1-A | Gutter de 24 px en teléfono en acceso | Corregido (`--cocoa-content-padding`; test de contrato); medida DOM a 390 pendiente |
| qa#17 | baja | 4-B | «POs abiertos» → «POS ABIERTOS» | Corregido («Pedidos abiertos»…); no medido (Carmen sin módulo Compras) |
| qa#18 | baja | 4-B | Tablist de puntos de venta sin `aria-controls` ni flechas | Corregido (tablist WAI-ARIA completo) |
| qa#19 | baja | primitives | Cabecera de CocoaSection sin wrap (origen de qa#1/qa#2) | Corregido en primitiva + CSS (7 tests); 600–899 px sigue sin envolver por decisión pendiente |

## 6. Handoffs pendientes

Ordenados por dueño. `fichero:línea` sobre el árbol de trabajo actual.

**Primitivas (`components/cocoa/**`)**

1. `styles/cocoa-22.css:221` `.c22-delta__label` y `components/cocoa/CocoaKpi.tsx:185` — sin elipsis: el contenedor `.c22-delta` es `inline-flex` y su `text-overflow` no aplica al hijo (qa#9, medido: `scrollWidth` 258 en 197 px). Añadir `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap` al label.
2. `styles/cocoa-22.css:838` `.c22-form-row` (`align-items: start`) — utilidad `.c22-form-row > [data-self="end"] { align-self: end; }` para que `operations/PosDashboard.tsx` (`bottomAligned`) pierda su último `style={}` (−1 punto).
3. `components/cocoa/CocoaSegmentedControl.tsx` — prop `panelId` → `id`/`aria-controls` en cada `[role="tab"]` (consumidores: `operations/FrontDeskActionQueue.tsx`, receta ya aplicada a mano en `admin/FnbMenuScreen.tsx`).
4. `components/cocoa/CocoaPageHeader.tsx` (`CocoaPageHeaderTab`) y `screens/tabs/tab-helpers.tsx` (HostedHead) — `count?: number` / `badge?: ReactNode` en las vistas internas (`admin/FnbInventoryScreen.tsx` lleva «Stock · 12» en el label).
5. Primitiva `CocoaTabs`/`CocoaChipTabs` (N pestañas dinámicas > 4 con roving tabindex y flechas) — `admin/FnbMenuScreen.tsx:165-183`, `fiscal/FiscalDashboard.tsx:127` (ola 8), `operations/GroupDetailDialog.tsx:654` (ola 3).
6. Primitiva `CocoaDescriptionList`/`CocoaDetailRow` (lista clave/valor de fichas en drawer) — `DetailRow` local en `WorkforceDashboard.tsx`, `SafetyDashboard.tsx`, `DetailRows` en `AiHumanReviewQueueScreen.tsx`; lo necesitará `FolioDetail` (ola 6).
7. `components/cocoa/CocoaChart.tsx:209` Bars — `labelFormat` u `orientation="horizontal"` (etiquetas largas en «Plantilla por departamento»).
8. `components/cocoa/CocoaState.tsx:109` — `illustrationTone` opcional (el 404 pinta la lupa en tono error).
9. `components/cocoa/CocoaInput.tsx` · `CocoaStepper` · `CocoaSelect` (R8) — alturas 34 vs 28 px en la fila «Consumo · Cantidad · Precio · Añadir» de `PosDashboard.tsx`; unificar `CONTROL_HEIGHT_BY_SIZE.regular`.
10. `styles/cocoa-22-layout.css:346-352` — decidir si `.c22-section__head { flex-wrap: wrap }` se aplica también entre 600 y 899 px (a 600 «Arqueo de caja» queda `CLIPPED` con la fila de 447 px en 518 px interiores; a 1440 no cambiaría nada en el canon). Y regla `.c22-section[data-padding="none"]:not([data-variant="plain"]) > .c22-section__footer { margin-top: 0; padding: var(--cocoa-space-3) var(--cocoa-space-4) }` para retirar el último estilo inline de `CocoaSection.tsx` (footer).

**Hooks / servicios del front**

11. `hooks/useApiData.ts:5-45` — `status: number | null` en `ApiState` y guarda de polling `status === 403 || status === 404` (rama «unknown» del gate de módulo: usuario sin `modules.read` que entra por URL).
12. `screens/operations/useScreenModuleGate.ts` + `module-gate.ts` → promover a `hooks/useModuleGate.ts` + `lib/module-gate.ts` para el resto de pantallas con `modulesAny` (olas 5–10).

**Copy / contenido**

13. `content/screen-instructions/maintenance.ts:2-12` y `housekeeping.ts:2-4` — jerga visible («Gestion de work orders», «Bloquear room», «Photo evidence», «Pizarra HK movil-first», «Priority queue»); texto propuesto en el informe del lote 4-A. Y `tests/admin-web-spanish-copy-contract.test.mjs:26` recorre solo `src/screens`: añadir `src/content/screen-instructions`.
14. `packages/database/prisma/seed.ts:805-915` — valores de la cola de revisión en inglés (`summary`, `draftReply`, `_review.notes`, `_review.reason`); traducir en la semilla (upsert por id).

**API**

15. `apps/api/src/modules/reporting/reporting.service.ts:189` — `getReservationFolio(folio.reservationId)` devuelve el folio principal dos veces cuando una reserva tiene dos folios (Rías Altas: 36 filas, 35 folios; `cmu1jic6q00bjfywhnr7671sc` ×2) y `openFolioBalances` suma el saldo por duplicado; resolver por id de folio. Es la misma clave que aparecía en la consola de `/operaciones/tpv` (informe `fix:4-B`).
16. Opcional · `GET /reservations/:id` → `primaryGuest.priorStays` para que `QuickCheckInDrawer` no cargue `/guests/:id/timeline` completo.

**Docs (`COCOA-22.md`) y guía**

17. §4.1: filas nuevas «Otro (auth)» (piloto `auth/AcceptInviteScreen.tsx` + marco `AuthShell.tsx`), «workspace ligero» (`WorkforceDashboard.tsx`: tablas + drawer de ficha + drawer de alta), «tarjetas de exportación» (`RevenueExportCenter.tsx`), «tabla ancha» (`PortfolioDashboard.tsx`); fila Dashboard: los `Director*` de listas se conservan hasta la ola 11 (no la 2); §4.2 D20/R20: las alojadas SÍ pasan `subtitle`; §3.5: la cabecera de tarjeta envuelve en < 600; §3.10 + `dev/StyleGuideScreen.tsx`: patrón «Módulo no activado» (`CocoaPage state="empty"` + `UI_STATES.moduleDisabled` + `ACTIONS.enableModule`, peticiones en `null`); §4 auth: gutter con `--cocoa-content-padding`, no `--cocoa-space-5`.
18. `components/cocoa-director/DirectorVipList.tsx:37-92,127-324`, `DirectorAiInsightCard.tsx:57-63,90-105,198,236`, `DirectorBarRecommendations.tsx:80-83,149,192,197` — tokens Aurora con fallbacks hex, `rgba(...)` y `toFixed`: ola 11 (o lote 2-A bis).
19. `components/cocoa-guidance/CocoaHelpButton.tsx:819` («Cerrar ayuda») y `CocoaSearchableHelpModal.tsx:745` — mismo patrón que qa#10; comprobar con la sonda antes de aplicar la receta.

## 7. Lo no verificado

- **Verificación visual §5 de las 35 pantallas y 2 drawers**: ninguno de los lotes de
  migración ni de corrección (salvo `fix:4-B`, que midió `/operaciones/tpv` y
  `/operaciones/tpv/cartas` a 1440) tuvo navegador. Faltan la matriz 1440/1024/390 ×
  claro/oscuro, la sonda §5.4 (gutter 24/16, hScroll 0, un `h1`, raw 0, `lowContrast []`,
  `tooSmall []` en coarse), la sonda de foco §5.5 y Esc en CocoaDrawer/CocoaDialog, y
  la tabla §5.6. Puntos concretos: hoja inferior de los drawers a 390×844; HostedHead
  con `tabs` en Mi día; `PortfolioDashboard` con `stickyFirstColumn` a 1024/390;
  `RevenueExportCenter` a 390; KpiStrip de 10 tiles a 1024; fade del segmented en
  `/hoy/operaciones`; `.c22-delta__label` a 1440; gutter de acceso a 390; botón de
  cierre de instrucciones en coarse; «Módulo no activado» + CTA (solo en `prop_123`).
- Fases «ready»/«done» de `AcceptInviteScreen`, estado submitted + testLink de
  `ForgotPasswordScreen`, `ChangePasswordScreen` (sesión con `mustChangePassword`).
- qa#17 (`ProcurementDashboard`) no medido en pantalla; corrección determinista.
- Rama «unknown» del gate de módulo (sin `modules.read`): no reproducible con Carmen.
- Los cambios de copy deliberados listados por cada lote (estados en español, «MTD» →
  «mes en curso», «Work orders» → «Órdenes de trabajo», CTAs sin «→», etc.) están
  pendientes de validación de producto (F6), no de código.

## 8. Puertas §7.3 (conteos literales, cierre 2026-09-15)

| Puerta | Resultado |
|---|---|
| `node scripts/typecheck-all.mjs --parallel 3` | **15 PASS · 0 FAIL · 0 XFAIL · 1 SKIP** (`apps/guest-web`, explícito) · 14,8 s |
| `corepack pnpm test` | **385 tests · 72 suites · 385 pass · 0 fail** (tras regenerar el inventario y rebajar `inlineStyles` a 3788) |
| `corepack pnpm --filter @hotelos/api test` | **875 tests · 246 suites · 874 pass · 1 skipped · 0 fail** |
| Unitarios front (`node --import tsx --test …/__tests__/*.test.mts`) | **559 tests · 177 suites · 559 pass · 0 fail** |
| `node scripts/check-discoverability.mjs` | OK · placeholders **16/20** · 0 enlaces rotos |
| `node scripts/build-nav-tree.mjs --check` | al día (**64 ítems · 80 pestañas · 205 redirecciones**) |
| `node scripts/cocoa-22-inventory.mjs` | escrito · **200 pantallas · 77.083 líneas · 4.600 puntos** |
| `node scripts/cocoa-22-waves.mjs --write` / `--check` | §6 escrito · **153 pendientes · 4.538 puntos · 20 lotes** · `--check`: §6 al día |
| `node docs/design/cocoa-22-api.mjs --write` / `--check` | §8 actualizado y al día · 39 ficheros · 65 interfaces · 53 type aliases · 607 props · 153 funciones · 29 constantes · 1.756 líneas |
| `node docs/design/cocoa-22-api.mjs --typecheck-examples` | 11 plantillas · **tsc 0 errores** |
| `bash .husky/pre-commit` | discoverability OK + `typecheck-all --parallel 2` **15 PASS · 0 FAIL · 1 SKIP** · 20,7 s · «Pre-commit checks passed» |
| Contrato `tests/cocoa-22-contract.test.mjs` | **18/18** (`ALLOWLIST_CEILING` 153 = `NOT_MIGRATED.length` 153; `GLOBAL_CEILING` = totales regenerados) |

## 9. Árbol de trabajo y siguiente paso

`git status` (raíz `~/anfitorio-demo`): **73 modificados · 2 retirados (`D`:
`auth/CocoaLoginScreen.tsx`, `errors/CocoaServerErrorScreen.tsx`, copias en el
scratchpad `c22-removed/`) · 16 nuevos** (15 módulos/tests + este informe); sin
ficheros temporales ni logs en el repositorio. `hotelos/pnpm-lock.yaml` figura
modificado desde el 14/09 (añade `@fontsource-variable/inter`, `zod` y
`@playwright/test`, que `apps/admin-web/package.json` ya declara en `HEAD`): no es de
esta tanda y no se ha tocado; decidir aparte si va en el commit.

Siguiente paso (plan §7.3, fuera de este cierre): un commit por ola —o uno por tanda—
con mensaje `feat(cocoa-22/olas-1-2-4-9): …` que incluya pantallas, primitivas, hojas,
contrato, inventario, §0/§6 del plan, §8.2 de la spec y este informe; nunca
`--no-verify`. Después arrancan las olas 3 (Recepción, 1.008 pts), 5 (Revenue, 380),
6 (Finanzas, 618), 7 (Comercial, 591), 8 (Cumplimiento, 787) y 10 (Configuración,
1.025) según §6, con los handoffs de §6 de este informe como primer lote de
`primitives`/`css`.
