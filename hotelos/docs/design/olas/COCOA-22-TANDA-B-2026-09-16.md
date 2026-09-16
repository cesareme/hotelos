# Cocoa 22 · Tanda B (olas 3 · 5 · 7) — Informe de cierre · 16 de septiembre de 2026

**Para:** César. **Alcance:** segunda tanda de migración de pantallas al sistema
Cocoa 22 (spec `docs/design/COCOA-22.md`, plan `docs/design/COCOA-22-MIGRACION.md`)
sobre `efa8c8e` (cierre de la Tanda 6 · Finanzas): ola 3 · Recepción (lotes 3-A, 3-B,
3-C), ola 5 · Revenue (5-A, 5-B, 5-C) y ola 7 · Comercial (7-A, 7-B, 7-C), más la
verificación adversarial con navegador (18 hallazgos confirmados, `qa#1`–`qa#22` sin
`qa#4`, `qa#16`, `qa#20`, `qa#21`), catorce lotes de corrección (`fix:3-A`, `fix:3-A /
3-C (copy)`, `fix:3-A + css (fullBleed)`, `fix:3-C`, `fix:5-A (cocoa-rate-grid · css)`,
`fix:5-A (copy)`, `fix:5-B`, `fix:5-C`, `fix:5-C (copy)`, `fix:7-A (copy)`,
`fix:primitives (CocoaTable css)`, `fix:primitives (CocoaStepper)`, `fix:guidance`,
`fix:foundation (theme) / docs`), la integración de los handoffs de primitivas, hojas y
scripts, y este cierre (integrador sin navegador). **Sin commit**: todo está en el árbol
de trabajo de `hotelos/` (89 ficheros modificados · 1 retirado · 11 nuevos, este informe
incluido). Ningún dato de negocio de Faranda se ha escrito ni restaurado: todas las
comprobaciones contra el API fueron `GET` de solo lectura con la sesión de Carmen; los
servidores `:3000` y `:5173` no se han reiniciado.

Método de medida: `node scripts/cocoa-22-inventory.mjs` (puntos de deuda por pantalla;
fórmula en `docs/design/cocoa-22-inventory.json`), contrato
`tests/cocoa-22-contract.test.mjs` (reglas 1–15) y las puertas de §7.3 del plan.
«Antes» = inventario commiteado en `efa8c8e` (cierre de la Tanda 6); «después» =
inventario regenerado en este cierre. Ningún lote de la tanda tuvo navegador salvo la
verificación adversarial de QA: la matriz visual §5 de las pantallas migradas y la
medida en pantalla de las 18 correcciones quedan por hacer (§7).

## 1. Resumen en cifras

| Métrica | Antes (`efa8c8e`) | Después (cierre Tanda B) | Δ |
|---|---|---|---|
| Pantallas inventariadas | 217 | 216 | −1 (`reservations/QuickActionsDialogs.tsx`, muerta retirada) |
| Líneas en `screens/` | 86.883 | 84.869 | −2.014 |
| **Puntos de deuda** | **3.833** | **1.912** | **−1.921 (−50,1 %)** |
| `.bo-card` · otras `.bo-*` | 589 · 2.307 | 307 · 1.216 | −282 · −1.091 |
| `<button>` crudos (CocoaButton) | 419 (642) | 203 (820) | −216 (+178) |
| `<table>` crudas (CocoaTable) | 91 (158) | 40 (217) | −51 (+59) |
| Inputs crudos (Cocoa) | 409 (599) | 158 (830) | −251 (+231) |
| `style={` | 3.223 | 1.833 | −1.390 |
| Colores literales (fallbacks) | 402 (224) | 70 (38) | −332 (−186) |
| `<h1>` crudos · emoji | 29 · 115 | 15 · 26 | −14 · −89 |
| Con cabecera Cocoa · `useTabHost` | 139 · 65 | 167 · 58 | +28 · −7 |
| Tamaños S · M · L · XL | 82 · 103 · 29 · 3 | 92 · 96 · 25 · 3 | |
| `NOT_MIGRATED` = `ALLOWLIST_CEILING` | 125 | **68** | −57 (46 pantallas + 10 contenedores + 1 muerta) |
| Migradas (entradas fuera de la allowlist) | 92 (98 pts) | **148** (155 pts) | +56 |
| Pendientes (§6 del plan) | 125 ficheros · 51.744 líneas · 3.735 pts | **68 ficheros · 24.367 líneas · 1.757 pts** · S 30 · M 27 · L 10 · XL 1 · 8 lotes · 17 contenedores · 3 muertas | −1.978 pts |

Descomposición de los −1.921 puntos: **−1.921** por las 46 pantallas migradas y la muerta
retirada (1.978 → 57; incluye los −5 estructurales de `operations/GroupsPickupCard.tsx`,
tarjeta de `GroupsEventsDashboard` que entra en `HEADER_EXEMPT` del contrato y del
inventario); **0** por los 10 contenedores (solo salen de la allowlist); **0** en
`dev/StyleGuideScreen.tsx` (11 → 11: +49 líneas de ejemplos de las props nuevas de
§4, `style={` 39 → 40). Las 14 correcciones `fix:*` suman +136 líneas y 0 puntos (ningún
techo sube). Ninguna pantalla de otras olas cambia de puntos.

Por categoría (puntos): Recepción 686 → **26** (19 → 18 pantallas) · Operaciones 350 →
**38** (diálogos y tarjeta de grupos, que el menú cuelga de Operaciones) · Revenue 380
→ **7** · Comercial 591 → **15** · Desarrollo 44 → 44 (guía) · Compartido 26 ·
Configuración 1.086 · Cumplimiento 604 · Finanzas 36 · Hoy 17 · Informes 7 · Público 6
(sin cambios).

## 2. Pantallas migradas por ola (puntos antes → después)

Puntos y líneas del inventario (`efa8c8e` → cierre). Arquetipo = el de la receta §3 del
plan (entre paréntesis, el que asigna la heurística del inventario cuando difiere).
`st` = `style={` antes → después (presupuesto de la regla 6 entre corchetes cuando no es
el 25 por defecto). «Pendientes» = lo que no se ha podido cerrar sin navegador o depende
de un handoff (§6). Las correcciones `qa#` aplicadas por los lotes `fix:*` van citadas en
la fila de su pantalla.

### Ola 3 · Recepción — lote 3-A · Reservas · 272 → 13 pts

| Fichero (`screens/`) | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `timeline/LiveTimelineWorkspace.tsx` | calendario (cronograma, alojada en `ReservasTabs`) | 80 → 9 | 1.126 → 1.297 | CocoaPage `fullBleed` + `density="compact"` (state/skeleton/error/⌘K), CocoaToolbar (Anterior/Hoy/Siguiente + CocoaSegmentedControl 7/14/30 días), chips CocoaButton `aria-pressed` de estado y canal (`channelLabel`, qa#8), CocoaScrollArea `axis="both"` + `stickyFirstColumn` con la única `<table data-cocoa-grid-table>` (cabecera de fechas sticky sin blur), bloques con `toneBg/toneBorder/toneInk` arrastrables (left/top, Enter/Espacio), CocoaPopover `role="tooltip"` de ficha rápida, CocoaDrawer lg con CocoaStat ×12, CocoaDialog ×7 (mover, fechas, check-in/out, cancelar, no-show, asignar), `useToast`; se retiran `@hotelos/ui/timeline`, `States` y `NarrowViewportBanner`; `st` 58 → 24 [40] | fullBleed ahora solo sangra la CocoaScrollArea (qa#19, hoja): medir a 390; celdas de la parrilla con la regla por defecto de `cocoa-22-layout.css` (`leadHeadStyle`… siguen en objetos con tokens); barras de bloque como `div role="button"` hasta R30 |
| `operations/RoomRackScreen.tsx` | dashboard alojado (tablero) | 70 → 2 | 589 → 587 | CocoaPage (skeleton espejo Strip + Grid, badge «Sin actualizar» si el sondeo falla), CocoaKpiStrip ×6, CocoaToolbar (CocoaSearchInput + CocoaSelect de planta), CocoaSection por planta con CocoaCard interactiva por habitación (barra de tono 3 px, CocoaBadge dot), CocoaDrawer md con «Huésped actual» / «Próxima llegada» y acciones rápidas (abre `QuickCheckIn/OutDrawer`); `room-rack-labels.ts` (`normalizeFloor`, `floorTitle`: «Sin planta», «Planta 2», sin «Planta Planta 1», qa#11); `st` 40 → 7 | `CocoaCard aria-pressed` ya disponible para la selección del tile (hoy la marca el drawer abierto); Rías Altas tiene 120/120 habitaciones con `floor = ""` (dato demo) |
| `reservations/ReservationWorkspaceScreen.tsx` | workspace + detalle (`/recepcion/reservas/:id`) | 48 → 1 | 1.293 → 764 | CocoaPage con badge de estado y `tabs` Resumen/Folio/Actividad/Huéspedes/Documentos (HostedHead), CocoaGrid 8/4 con CocoaStat, CocoaDialog destructivo; nombre del huésped por `primaryGuest` (qa#7) y canal/segmento traducidos con `title` crudo (qa#8); se retira el export muerto `ReservationWorkspaceScreen` (0 importadores); `st` 75 → 2 [40] | declarar `primaryGuest` en `AdminReservation` (servicios); `bookerName` en blanco → «Sin definir» (`trim`) |
| `reservations/ReservationAgentScreen.tsx` | asistente de dictado (formulario) | 44 → 0 | 345 → 417 | CocoaPage, CocoaFormSection, CocoaInput `multiline`, CocoaCallout, CocoaActionBar; `st` 18 → 0 [15] | — |
| `reservations/ReservationCreateScreen.tsx` | asistente (seis pasos) | 24 → 1 | 1.474 → 1.143 | CocoaPage, barra de pasos = CocoaChart.Progress + `ol.c22-section__list` con CocoaBadge dot (un solo `aria-current="step"`, qa#12), CocoaFormSection por paso con salto al paso del campo inválido, CocoaActionBar `publishToastOffset`, `state="empty"` + `illustration="success"` al terminar; etiquetas inglesas de opciones traducidas (valores del API intactos); `st` 63 → 3 | `CocoaSteps` (R1) sustituiría la barra de pasos; producto: asistente de 6 pasos frente a formulario continuo (misma carga útil de `createReservation`) |
| `reservations/ReservationsListScreen.tsx` | lista (inventario: dashboard) | 6 → 0 | 571 → 502 | CocoaTable con columna Huésped por `reservation-guest-label.ts` (`fetchGuest` por id distinto, «Huésped pendiente» mientras tanto, qa#7); `st` 11 → 1 | el API de la lista no devuelve `primaryGuestName`: 18 `GET /guests/:id` en el primer pintado de Rías Altas (handoff API) |
| `tabs/recepcion/ReservasTabs.tsx` · `tabs/recepcion/NuevaReservaTabs.tsx` | contenedores | 0 → 0 | — | sin código; salen de `NOT_MIGRATED` | — |

Cambios de comportamiento deliberados del cronograma (a confirmar con producto): el bloque
arrastrado ignora punteros (antes `elementFromPoint` devolvía el propio bloque y nunca
cambiaba de habitación); «Limpiar filtros» restablece los filtros por defecto (antes
ocultaba todo); «Recorrido del huésped» abre `/recepcion/reservas/:id/recorrido` con el
id. El kit `packages/ui/src/components/timeline/**` queda sin consumidor (R32).

### Ola 3 · Recepción — lote 3-B · Grupos y eventos · 397 → 16 pts

| Fichero | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `operations/GroupDetailDialog.tsx` | diálogo/drawer | 87 → 1 | 1.427 → 943 | CocoaDrawer right/lg con 3 vistas en CocoaSegmentedControl (Resumen · Pickup y bloqueo · Eventos; `panelId` ya disponible): 10 CocoaFormSection con CocoaField + CocoaInput/Select/DatePicker/Switch (lectura/edición), CocoaCallout (attrition, folio maestro, error `role="alert"`), CocoaKpiStrip ×4 + CocoaChart.Bars del pickup, CocoaPopover `role="menu"` «Cambiar estado», CocoaDialog destructivo (cancelar grupo) y de descarte; enlaces `mailto:`/`tel:` como `.cocoa-link` (44 px en táctil, qa#15); `st` 113 → 4 [15] | visual §5; `role="tabpanel"` en cada vista con el `panelId` nuevo |
| `operations/NewGroupDialog.tsx` | diálogo/drawer | 74 → 0 | 865 → 559 | CocoaDrawer lg cuyo cuerpo es `<form id>` («Crear grupo» del pie envía por `form=`), 10 CocoaFormSection, CocoaSelect ×8, CocoaDatePicker min/max, CocoaSwitch ×5, CocoaCallout, `initialFocus`; validaciones y payload idénticos; `st` 88 → 1 [15] | visual §5 (hoja inferior a 390) |
| `operations/GroupsCalendarScreen.tsx` | calendario (Gantt sin `<table>`) | 56 → 4 | 711 → 567 | CocoaPage `density="compact"` → CocoaScreenInstructionsCard (copy de `content/screen-instructions/groups.ts` sin nombres de componente, qa#13) → CocoaToolbar content (CocoaSegmentedControl 30/90/180 + CocoaSelect ×2) → CocoaKpiStrip ×4 → CocoaSection con el Gantt en CocoaScrollArea `axis="both"` (`data-sticky-head`, `data-sticky-column`, barras `role="button"` tintadas por estado, marcador de fecha límite y de hoy), leyenda CocoaBadge dot; «Nuevo grupo» abre el drawer del tablero por hash; `st` 56 → 14 [40] | sin `fullBleed` (scroller anidado en CocoaSection; decisión a validar); barras como `div role="button"` hasta R30 |
| `operations/RoomingListImportDialog.tsx` | diálogo/drawer | 52 → 2 | 759 → 627 | CocoaDrawer con CocoaFileInput, CocoaTable de vista previa, CocoaCallout de errores, pie de dos botones; `st` 59 → 6 [15] | visual §5 |
| `operations/RoomBlockGridDialog.tsx` | diálogo/drawer | 41 → 6 | 582 → 460 | CocoaDrawer con la parrilla de bloqueo en CocoaScrollArea + `<table data-cocoa-grid-table>` (3 pts inherentes, como el editor de tarifas), CocoaInput por celda, CocoaCallout; `st` 56 → 10 [15] | visual §5 |
| `operations/NewEventDialog.tsx` | diálogo/drawer | 35 → 0 | 472 → 352 | CocoaDrawer con CocoaFormSection, CocoaSelect (tipos de evento y montaje en español), CocoaDatePicker `withTime`; `st` 36 → 1 [15] | — |
| `operations/GroupsPickupCard.tsx` | otro (tarjeta de `GroupsEventsDashboard`, exenta de cabecera) | 33 → 1 | 295 → 218 | CocoaSection + CocoaKpi + CocoaChart.Progress, vacío honesto en vez de desaparecer; entra en `HEADER_EXEMPT` (contrato + inventario); `st` 32 → 4 | — |
| `operations/GroupsEventsDashboard.tsx` | dashboard alojado | 19 → 2 | 947 → 505 | CocoaPage (alojada no repite «Calendario»/«Cupos»), CocoaKpiStrip, CocoaTable con `rowActions` (Bloquear habitaciones · Crear evento · Importar rooming list), abre los cuatro drawers; `st` 30 → 8 | — |
| `tabs/recepcion/GruposEventosTabs.tsx` | contenedor | 0 → 0 | — | sale de `NOT_MIGRATED` | — |

### Ola 3 · Recepción — lote 3-C · Huéspedes, cupos y conserjería · 338 → 6 pts (58 de la muerta)

| Fichero | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `admin/AllotmentsScreen.tsx` | dashboard alojado (`/recepcion/grupos/cupos`) | 107 → 1 | 1.240 → 945 | CocoaPage con 3 vistas como `tabs` (Pickup y liberación · Cupos contratados · Tour operadores) y 4 acciones (+ ⌘K), CocoaKpiStrip ×4, CocoaGrid 6/6 con una CocoaSection por cupo (CocoaChart.Progress + CocoaStat ×4 + CocoaChart.Line 60 días), CocoaTable de operadores (7 col) y de cupos (8 col), dos CocoaDrawer de alta con `key` distinta por sesión (`to-N` / `allot-N`, qa#5); mismos endpoints y payloads; `st` 123 → 3 | etiquetas X de `CocoaChart.Line` con 60 puntos en 320 px (handoff `maxLabels`); R8 alturas input/select en filas mixtas |
| `reservations/QuickActionsDialogs.tsx` | **muerta** (0 importadores) | 58 → — | 729 → — | retirada (git `D`; copia en `scratchpad/c22-removed/`); entrada del mapa `DEAD` de `scripts/cocoa-22-waves.mjs` sustituida por la nota «retired in wave 3» | `git rm` en el commit de la tanda |
| `guestJourney/GuestJourneyWorkspace.tsx` | workspace (`/recepcion/reservas/:id/recorrido`) | 52 → 2 | 481 → 678 | CocoaPage + CocoaGrid `align="start"` 4/8: lista en CocoaSection `scroll="y"` (maxHeight 640; 360 en `laptop`, qa#10) con CocoaSearchInput y filas CocoaButton `wrap` + `aria-current`, detalle con CocoaCallout «Siguiente paso», pasos `aria-current="step"`, peticiones y mensajes; en teléfono/tableta el detalle abre en CocoaDrawer lg; paso «Habitación asignada» con el número (`fetchRooms`, qa#9); canal traducido (qa#8); `navigateTo` tipado; `st` 32 → 8 [40] | apilado 12/12 en 900–1199 (hoja «lone halves»): medir a 1024 × 768 |
| `guests/GuestTimelineScreen.tsx` | calendario (cronología del huésped, alojada) | 48 → 2 | 483 → 435 | CocoaPage, CocoaKpiStrip, línea temporal en `ol.c22-section__list` con CocoaBadge dot, CocoaTable «Habitación · canal» con `channelLabel` (qa#8); `st` 39 → 8 [40] | sin subtítulo alojada (D20): confirmar en la QA visual |
| `guests/GuestProfileScreen.tsx` | ficha + formulario (inventario: dashboard) | 43 → 0 | 304 → 389 | CocoaPage, CocoaKpiStrip, 4 CocoaFormRow de CocoaField + CocoaInput/Select, CocoaActionBar `publishToastOffset` (⌘/Ctrl+Enter guarda); `st` 16 → 1 | R8 (alturas 34 vs 28 en filas mixtas) |
| `operations/ConciergeInboxDashboard.tsx` | workspace (bandeja) | 30 → 1 | 212 → 212 | CocoaPage, CocoaKpiStrip, CocoaGrid 6/6, CocoaTable de conversaciones, CocoaState; `st` 11 → 3 [40] | canal de mensajería crudo (whatsapp/email/app): dominio distinto al de qa#8 |
| `tabs/recepcion/HuespedesTabs.tsx` | contenedor | 0 → 0 | — | sale de `NOT_MIGRATED` | importa `CocoaButton` y `openTabPath` por rutas directas en vez del barrel (A1) |

### Ola 5 · Revenue — lote 5-A · Parrilla y demanda · 46 → 1 pt (+ `components/cocoa-rate-grid/**` alineado)

| Fichero | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `DemandCalendarAdminScreen.tsx` | formulario + lista (inventario: calendario) | 23 → 0 | 264 → 327 | CocoaPage (skeleton Strip + Grid 4/8, ⌘K), CocoaKpiStrip ×3, CocoaGrid 4/8: CocoaFormSection «Nuevo evento de demanda» (CocoaField/Input/Select/DatePicker, CocoaCallout `role="alert"`) + CocoaSection con CocoaTable (`fit`, `hideOnNarrow`, CocoaBadge por impacto) o CocoaState; `st` 3 → 1 [40] | visual §5 |
| `revenue/RateGridEditorScreen.tsx` | calendario / parrilla (alojada en `ParrillaTabs`) | 18 → 1 | 2.366 → 2.315 | CocoaPage `density="compact"` → CocoaToolbar content (presets CocoaButton `aria-pressed`, CocoaField inline + CocoaDatePicker small, CocoaSegmentedControl, CocoaSwitch ×3, filtro multi-selección = CocoaButton ancla + CocoaPopover listbox) → avisos CocoaCallout → `CocoaRateGrid` (parrilla virtual propia) → `RateGridStatusBar` sobre **CocoaActionBar** `publishToastOffset` + `wrap` (R12 cerrado) → CocoaSheet «Motivo del cambio» → CocoaDialog ×2; «diff» → «detalle de cada celda modificada» (qa#14); `st` 51 → 3 [40] | `fullBleed` aún no activado (la hoja ya lo permite tras qa#19: solo sangraría la `.crg`): medir a 1440/390 antes; 3 `style={` de la ancla y filas del filtro pueden pasar a `CocoaButton fullWidth/align` |
| `revenue/RateJournalScreen.tsx` | lista (inventario: otro) | 5 → 0 | 395 → 368 | CocoaPage, CocoaSection con `HistoryList` inline (ya no panel lateral fijo), CocoaBadge; subtítulo sin «diff» (qa#14); `st` 6 → 0 | — |
| `tabs/revenue/ParrillaTabs.tsx` | contenedor | 0 → 0 | — | sale de `NOT_MIGRATED` | — |
| `components/cocoa-rate-grid/**` (11 ficheros, +325/−241) | kit de la parrilla (fuera del inventario) | — | — | `RateGridStatusBar` = CocoaActionBar; `HistoryDrawer`, `JournalStaleDialog`, `BulkEditSheet` sobre CocoaDrawer/CocoaDialog/CocoaSheet; `shared-ui.tsx` con CocoaBadge/CocoaButton; `rate-grid.css` solo tokens (texto informativo de 11 px en `--cocoa-label-secondary`, qa#1); `helpers.providerLabel` conserva su mapa; contrato del outbox, `draft-store`, `expressions` y servicios intactos | `toastOffsetForBar` y su test sin consumidor (R31); blanco sobre acento a 4,36:1 en «hoy» (decisión de sistema, §6) |

### Ola 5 · Revenue — lote 5-B · Histórico, previsión y reuniones · 174 → 4 pts

| Fichero | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `revenue/RevenueHistoryForecastDashboard.tsx` | dashboard alojado (cuadro) | 49 → 1 | 599 → 504 | CocoaPage (skeleton Strip 4 + Grid), CocoaToolbar (CocoaSegmentedControl de rango + CocoaDatePicker ×2), CocoaCallout (sin previsión / sin presupuesto), CocoaKpiStrip ×4 con deltas («hab» admitido por `CocoaKpiDeltaUnit`), tarjetas de mes = CocoaSection con CocoaStat «Proyección del mes» y «Cierre del año anterior» (qa#2: el valor compuesto deja la lista y el `main` ya no desplaza 34 px), CocoaChart.Line ×2, CocoaTable «Fechas críticas»; `<style>` inyectado y `NarrowViewportBanner` retirados; `st` 36 → 5 | serie «Previsión (desde hoy)» rellena antes de hoy hasta que `CocoaChart.Line` admita huecos y marcador «hoy» (R26) |
| `revenue/RevenueMeetingScreen.tsx` | dashboard standalone | 35 → 2 | 238 → 316 | CocoaPage, CocoaKpiStrip ×4, CocoaGrid 6/6 (comp-set con CocoaStat, presupuesto/previsión/real en CocoaTable), CocoaTable de recomendaciones BAR, calculadora de desplazamiento con CocoaField + CocoaDatePicker/CocoaInput y CocoaCallout tonal; `st` 18 → 6 | defaults heredados de la calculadora (2026-06-10/13 · 10 · 95) |
| `revenue/RevenueHistoryForecastReport.tsx` | lista densa (27 columnas) | 32 → 1 | 482 → 410 | CocoaTable `fit` + `stickyFirstColumn` + `maxHeight` + `tfoot` del servidor (celda «Total» pegada con fondo inverso, qa#3) + `hideOnNarrow` por bloques; «Imprimir» con las reglas `@media print` de `cocoa-22.css`; `st` 16 → 4 [15] | cabecera agrupada por bloques (R27) |
| `revenue/RevenueComparisonDashboard.tsx` | dashboard | 25 → 0 | 225 → 258 | CocoaPage, CocoaKpiStrip, CocoaTable, CocoaChart; `st` 18 → 1 | — |
| `revenue/RevenueHomeDashboard.tsx` | dashboard | 20 → 0 | 241 → 262 | CocoaPage, CocoaKpiStrip, CocoaGrid de CocoaSection; `st` 5 → 0 | — |
| `revenue/RevenueForecastExplorer.tsx` | dashboard | 13 → 0 | 235 → 201 | CocoaPage, CocoaTable, CocoaChart.Line; `st` 8 → 1 | — |
| `tabs/revenue/HistoricoPrevisionTabs.tsx` | contenedor | 0 → 0 | — | sale de `NOT_MIGRATED` | — |

### Ola 5 · Revenue — lote 5-C · Ajustes de revenue · 160 → 2 pts

| Fichero | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `admin/RatePlansScreen.tsx` | lista + drawer (inventario: dashboard) | 47 → 0 | 426 → 550 | CocoaPage (⌘K), CocoaKpiStrip ×4, CocoaTable 11 columnas (`fit`, `showFrom`, `hideOnNarrow`, `rowTone="accent"` para las BAR), CocoaDrawer «Nuevo plan tarifario» con 2 CocoaFormSection, validación por campo, guardia de descarte; `st` 17 → 1 | desviación deliberada: una BAR ya no exige «valor de derivación» (el legacy lo hacía imposible salvo cambiar el tipo) |
| `admin/CancellationPoliciesScreen.tsx` | formulario (lista + drawer) | 46 → 0 | 361 → 492 | CocoaTable (fila abre la edición, `rowActions` Eliminar), CocoaDrawer lg con 3 CocoaFormSection («Penalizaciones progresivas» con «Añadir ventana»), CocoaDialog destructivo con `busy`; `st` 25 → 1 [15] | `PROPERTY_ID` a nivel de módulo (heredado; no sigue el cambio de propiedad sin recarga) |
| `RateShopperSettingsScreen.tsx` | dashboard | 35 → 1 | 255 → 351 | CocoaPage, CocoaKpiStrip ×4, CocoaGrid 7/5: CocoaTable de competidores con alta rápida en el `footer` (CocoaFormRow `role="group"` ya disponible) · alertas en `c22-section__list`; CocoaChart.Line mín/mediana/máx sobre CocoaTable compact; celdas `CodeCell` con `hotelCategoryLabel` («urban» → «Urbano»), `shopSourceLabel` («demo» → «Sondeo interno»), `availabilityLabel` (qa#18); `st` 12 → 4 | visual §5 |
| `RevenueRulesScreen.tsx` | dashboard | 32 → 1 | 228 → 329 | CocoaPage, CocoaKpiStrip, CocoaTable de recomendaciones (fecha como `<a class="cocoa-link">` de 44 px en táctil, qa#15), CocoaFormSection de reglas; `money` de `lib/format` (la de `revenueApi` queda sin consumidor); `st` 12 → 4 | — |

### Ola 7 · Comercial — lote 7-A · Canales · 190 → 3 pts

| Fichero | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `channelManager/ChannelAggregatorHub.tsx` | dashboard (alojado en `CanalesTabs`) | 137 → 2 | 1.612 → 1.738 | CocoaPage (skeleton Strip ×4 + 2 cards, ⌘K), CocoaScreenInstructionsCard, CocoaKpiStrip ×4, tres CocoaSection de la capa Rate grid v2 («Dar de alta un canal» = CocoaFormRow columns 4 + CocoaSelect/CocoaInput, R14 cerrado; «Canales conectados» = CocoaTable con CocoaSelect/CocoaInput small en celda, credenciales en CocoaDrawer sm `type="password"`, `rowActions` ×4 con `rowActionsVisible="always"` ya disponible; «Log de entregas» = CocoaToolbar + CocoaTable compact), agregador como CocoaGrid `align="start"` de CocoaSection por canal, CocoaDialog destructivo para archivar; «Mapeos» → «Correspondencias» (qa#17); `st` 98 → 8 | `tooSmall` de `CocoaInput/Select size="small"` en celdas con puntero grueso (medir); subtítulo alojado no pintado (D20/R20) |
| `ChannelMappingsScreen.tsx` | lista | 53 → 1 | 642 → 736 | CocoaPage, CocoaToolbar (CocoaSelect «Canal» con `aria-label`), CocoaSection con CocoaTable por producto (tipo × plan) con CocoaInput/CocoaSwitch por fila, CocoaCallout de avisos, CocoaState; copy sin «Channel Manager», «mapeos», «canal v2» ni «room id / rate id» (qa#17); `st` 24 → 4 [15] | ancho de «Correspondencias»/«Ocultar correspondencias» en acciones de fila a 400 px (medir) |
| `tabs/comercial/CanalesTabs.tsx` | contenedor | 0 → 0 | — | sale de `NOT_MIGRATED` | — |

### Ola 7 · Comercial — lote 7-B · Clientes, fidelización y reputación · 286 → 10 pts

| Fichero | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `loyalty/LoyaltyProgramScreen.tsx` | dashboard alojado con formulario | 59 → 0 | 537 → 663 | CocoaPage (⌘K guardar/actualizar, badge «cambios sin guardar»), CocoaKpiStrip ×4, CocoaGrid 5/7 (CocoaChart.Progress por nivel · CocoaFormSection «Configuración global»), CocoaSection «Niveles» con CocoaKpiStrip de CocoaSection por nivel, CocoaDrawer «Editar nivel», `useScreenModuleGate`; `st` 38 → 1 | color de nivel conservado pero no editable (R28) |
| `operations/SurveysDashboard.tsx` | dashboard alojado | 39 → 1 | 309 → 323 | CocoaKpiStrip ×4, CocoaChart.Progress ×3 + CocoaChart.Bars 0–10, lista de respuestas, CocoaTable de temas; `st` 25 → 5 | 11 barras a 390 (medir etiquetas) |
| `crm/GuestSegmentsScreen.tsx` | dashboard alojado (lista + drawer) | 34 → 2 | 406 → 538 | CocoaKpiStrip ×3, CocoaTable (criterios como CocoaBadge, `rowActions` Editar · Pausar/Activar), CocoaDrawer editor con filas de criterios (CocoaSelect ×2 + CocoaInput + botón icono); `st` 24 → 7 | color de segmento no editable (R28) |
| `operations/CrmDashboard.tsx` | dashboard alojado | 33 → 1 | 271 → 299 | CocoaKpiStrip ×5 (`polarity`), CocoaTable ×3 con CocoaChart.Progress de alcance, lista de cumpleaños; `st` 16 → 3 | — |
| `operations/ReputationDashboard.tsx` | dashboard alojado | 32 → 2 | 243 → 297 | CocoaKpiStrip, CocoaTable, «4,5 / 5» + `StarIcon` en vez de «★»; `st` 14 → 6 | — |
| `marketing/CampaignManagerScreen.tsx` | dashboard alojado (lista + drawer) | 31 → 1 | 368 → 447 | CocoaToolbar con CocoaSelect de estado (5 opciones), CocoaTable, CocoaDrawer «Nueva campaña»; `st` 19 → 5 | CocoaSelect frente a CocoaSegmentedControl (≤ 4 opciones, §3.8): decisión de una línea |
| `operations/QualityDashboard.tsx` | dashboard alojado | 30 → 2 | 245 → 333 | CocoaKpiStrip, CocoaTable, CocoaChart; `st` 9 → 6 | — |
| `operations/LoyaltyDashboard.tsx` | dashboard alojado | 28 → 1 | 243 → 266 | CocoaKpiStrip, CocoaTable, CocoaChart.Progress; `st` 10 → 3 | — |
| `tabs/comercial/ClientesTabs.tsx` · `tabs/comercial/ReputacionTabs.tsx` | contenedores | 0 → 0 | — | salen de `NOT_MIGRATED` | — |

Las ocho pantallas conservan rutas y `pollIntervalMs` (120 s CRM y reputación · 300 s
encuestas y fidelización · 60 s calidad) y traducen el copy inglés heredado («Response
rate», «Top themes», «SLA breached»…). Segmentos, campañas y programa siguen en la
memoria del API (`demo-store`); los estados vacíos lo dicen.

### Ola 7 · Comercial — lote 7-C · Ventas adicionales y portal · 115 → 2 pts

| Fichero | Arquetipo | Pts | Líneas | Primitivas | Pendientes |
|---|---|---|---|---|---|
| `upsells/UpsellsSettingsScreen.tsx` | lista + drawer (inventario: dashboard) | 37 → 0 | 337 → 456 | CocoaPage (⌘K), CocoaKpiStrip ×3, CocoaTable 7 columnas (`onSelect` abre la edición, `rowActions` Pausar/Activar), CocoaDrawer lg con CocoaFormSection «Oferta» y «Precio e impuestos» (CocoaInput `inputMode="decimal"`, CocoaSelect ×3, CocoaSwitch); iconos emoji de categoría retirados; `st` 16 → 1 [15] | visual §5 |
| `guest-portal/GuestPortalSettingsScreen.tsx` | formulario | 36 → 0 | 219 → 291 | CocoaPage, CocoaGrid 8/4 (CocoaCallout de la dirección pública + CocoaKpi «Conversión de ofertas»), 4 CocoaFormSection (marca con CocoaInput `type="color"`, idiomas como chips `aria-pressed`, ventanas, funciones con CocoaSwitch ×7), CocoaCallout con `LockIcon`, CocoaActionBar `publishToastOffset`; `st` 24 → 0 [15] | sigue sin endpoint de persistencia (guardado local + toast, como antes); swatch nativo de `type="color"` sin medir; `brandName` inicial = propiedad activa y color inicial = `--cocoa-accent` computado |
| `operations/SalesPipelineDashboard.tsx` | dashboard | 22 → 1 | 241 → 202 | CocoaPage, CocoaKpiStrip, CocoaTable con badge de fase; `st` 12 → 3 | fase con el valor crudo del API (`closed_won`…), texto de negocio |
| `operations/UpsellsDashboard.tsx` | dashboard | 20 → 1 | 219 → 177 | CocoaPage, CocoaKpiStrip, CocoaTable, CocoaChart; `st` 12 → 3 | `PROPERTY_ID` fijado al cargar el módulo (heredado) |
| `tabs/comercial/VentasAdicionalesTabs.tsx` | contenedor | 0 → 0 | — | sale de `NOT_MIGRATED` | — |

### Contenedores fuera de la allowlist (10 · 0 pts · sin código)

`tabs/recepcion/ReservasTabs.tsx` · `NuevaReservaTabs.tsx` · `GruposEventosTabs.tsx` ·
`HuespedesTabs.tsx` · `tabs/revenue/ParrillaTabs.tsx` · `HistoricoPrevisionTabs.tsx` ·
`tabs/comercial/CanalesTabs.tsx` · `ClientesTabs.tsx` · `ReputacionTabs.tsx` ·
`VentasAdicionalesTabs.tsx`.

## 3. Contrato, inventario y scripts

- `tests/cocoa-22-contract.test.mjs`: `NOT_MIGRATED` 125 → **68** líneas (46 pantallas,
  1 muerta, 10 contenedores) y `ALLOWLIST_CEILING` 125 → **68** (= longitud, comprobado
  en este cierre tras la edición concurrente de nueve lotes); `STYLE_BUDGET` 32 → **51**
  entradas (+19: `LiveTimelineWorkspace` 40 · `ReservationWorkspaceScreen` 40 ·
  `ReservationAgentScreen` 15 · `GroupDetailDialog` 15 · `NewGroupDialog` 15 ·
  `RoomingListImportDialog` 15 · `RoomBlockGridDialog` 15 · `NewEventDialog` 15 ·
  `GroupsCalendarScreen` 40 · `GuestJourneyWorkspace` 40 · `GuestTimelineScreen` 40 ·
  `ConciergeInboxDashboard` 40 · `DemandCalendarAdminScreen` 40 · `RateGridEditorScreen`
  40 · `RevenueHistoryForecastReport` 15 · `CancellationPoliciesScreen` 15 ·
  `ChannelMappingsScreen` 15 · `UpsellsSettingsScreen` 15 · `GuestPortalSettingsScreen`
  15); `HEADER_EXEMPT` + `operations/GroupsPickupCard.tsx` (tarjeta de
  `GroupsEventsDashboard`); `GLOBAL_CEILING` 589/419/91/409/402/3223 →
  **307/203/40/158/70/1833** (= totales regenerados, sin margen: las correcciones `fix:*`
  fueron netas cero en `style={` a propósito). 18/18 reglas en verde.
- `docs/design/cocoa-22-inventory.json` regenerado en este cierre (216 · 84.869 · 1.912;
  el JSON intermedio de la integración de las olas decía 84.733 líneas y la regla 15
  estaba en rojo por las +136 líneas de las correcciones) y
  `docs/design/COCOA-22-MIGRACION.md` §6 reescrito por `cocoa-22-waves.mjs --write` (68
  pendientes · 1.757 pts · 8 lotes); §0, §3 (pilotos reales de Detalle, Asistente,
  Workspace, Calendario y Diálogo), §4.4 (Workspace apilado 12/12 en 900–1199) y §8 (R29
  cerrado; R22 y R25 anotados) actualizados a mano en este cierre.
- `scripts/cocoa-22-inventory.mjs`: espejo de `HEADER_EXEMPT` con `GroupsPickupCard`;
  `scripts/cocoa-22-waves.mjs`: la entrada `DEAD` de `QuickActionsDialogs.tsx` pasa a
  nota de retirada (como las dos muertas de la ola 1).
- `docs/design/COCOA-22.md` §8.2 regenerado por `cocoa-22-api.mjs --write` (40 ficheros
  · 68 interfaces · 55 type aliases · 640 props · 162 funciones · 29 constantes · 1.873
  líneas): props nuevas de §4; §4.3 con los pilotos reales de Asistente, Workspace,
  Calendario y Diálogo/drawer; §7 (mapa legacy → Cocoa 22) con la fila de
  `RateGridStatusBar` hecha.
- Tests nuevos (untracked, 692 líneas en 10 ficheros): `__tests__/theme-contract`
  (qa#22), `components/cocoa/__tests__/{CocoaPage, CocoaStepper}` (qa#19, qa#6),
  `screens/operations/__tests__/{fix-3a-room-rack-contract, room-rack-labels}` (qa#11),
  `screens/reservations/__tests__/{fix-3a-reservations-contract, reservation-guest-label}`
  (qa#7); módulos puros junto a la pantalla: `operations/room-rack-labels.ts`,
  `reservations/reservation-guest-label.ts`, `rate-shopper-labels.ts` (qa#18). Tests
  modificados: `cocoa/__tests__/CocoaGrid.test.mts` (+51, «lone halves»),
  `CocoaOverlays.test.mts`, `CocoaTable.test.mts` (+70, qa#3), `lib/__tests__/format.test.mts`
  (`channelLabel`, `marketSegmentLabel`, `hotelCategoryLabel`, `availabilityLabel`),
  `screens/__tests__/screens-fixes-contract.test.mts` (qa#10, qa#15, qa#18).
- `docs/runbooks/rate-grid-v2.md:465-471`: las citas de la UI «Mapeos guardados…» pasan a
  «Correspondencias guardadas…» (qa#17).

## 4. Primitivas, hojas y componentes compartidos (handoffs resueltos en la tanda)

`components/cocoa/**` (9 primitivas + 3 tests, +339/−55), `components/cocoa-rate-grid/**`
(11 ficheros, +325/−241), `styles/**` + `styles.css` + `theme.ts` (7 ficheros, +125/−44),
`lib/format.ts` (+255) y la guía `dev/StyleGuideScreen.tsx` (+49 líneas; cada prop nueva
con ejemplo exigido por `style-guide-coverage`):

| Handoff (lote) | Resuelto con |
|---|---|
| `aria-controls` en las vistas de un segmented (3-B) | `CocoaSegmentedControl` prop `panelId` (como `CocoaRouteTabs`) |
| Estado compuesto de la barra de publicación recortado con elipsis (5-A) | `CocoaActionBar` prop `wrap` → `.c22-action-bar[data-wrap="true"] .c22-action-bar__status { white-space: normal }`; `rate-grid.css` deja de forzarlo |
| Ctrl/⌘+Enter de la barra dispara dentro de una hoja abierta (5-A) | `CocoaActionBar` ignora el atajo cuando el foco está dentro de un `role="dialog"`/`alertdialog` |
| Filas `role="option"` y anclas con `style={{ width: "100%" }}` (5-A) | `CocoaButton` props `fullWidth` y `align="start" · "center" · "between"` |
| Acciones por fila solo visibles al pasar el ratón (7-A) | `CocoaTable` prop `rowActionsVisible="always"` → `.c22-table[data-actions="always"] .c22-table__actions { opacity: 1 }` |
| Tiles seleccionables sin estado accesible (3-A) | `CocoaCard` prop `aria-pressed` |
| Formulario de alta en el pie de una sección sin nombre de grupo (5-C) | `CocoaFormRow` props `role="group"` + `aria-label` |
| Delta «12 hab · pickup 7 días» sin unidad (5-B) | `CocoaKpiDeltaUnit` admite cualquier unidad corta (`(string & {})`) |
| Celdas de las parrillas `data-cocoa-grid-table` repetidas en objetos (3-A, 3-B, 5-A) | `cocoa-22-layout.css`: regla por defecto de `th/td` dentro de `.c22-scroll-area [data-cocoa-grid-table]` y `thead th[aria-current="date"]` en acento |
| `<style>` de impresión del informe diario (5-B) | `@media print` de `cocoa-22.css`: `.c22-table-wrap` sin scroller ni sticky |
| Bloque `.crg-status` de `mobile.css` sin consumidor (5-A) | retirado (la barra es `CocoaActionBar`) |
| Hover legacy de `styles.css:1566` pintaba los carriles de la parrilla (3-A) | `table:where(:not([data-cocoa-grid-table])) tbody tr:hover td` |
| `<label>/<select>` crudos del alta de canal (R14) | `CocoaFormRow columns={4}` + `CocoaSelect`/`CocoaInput` en `ChannelAggregatorHub`; el tope genérico de `<select>` de `mobile.css` queda para la ola 11 |
| `RateGridStatusBar` → `CocoaActionBar` (R12) | hecho; `toastOffsetForBar` conservado solo por su test (R31) |
| Regla 7 para la tarjeta de pickup (3-B) | `HEADER_EXEMPT` + `operations/GroupsPickupCard.tsx` en contrato e inventario |
| Texto informativo de 11 px en `--cocoa-label-tertiary` a 1,88:1 (qa#1) | `rate-grid.css`: `.crg__colhead-month`, `.crg__price--empty`, `.crg__rec-hold`, `.crg__cell--restr .crg__price` en `--cocoa-label-secondary`; los tres usos decorativos («—», candado, flecha) se conservan |
| Valor compuesto de lista sin salto de línea desplaza el `main` 34 px (qa#2) | «Cierre del año anterior» como `CocoaStat` con `hint` (`occAdrHint`); la regla `.c22-section__list > li > strong { white-space: nowrap }` es por diseño |
| Celda «Total» pegada blanca sobre blanco (qa#3) | `CocoaTable` deja de pintar `background: inherit` en línea en la primera celda; `cocoa-22.css` pinta el pie pegado con `--inverse-surface`/`--inverse-ink` (+4 tests SSR) |
| Botones ± del stepper de 15 × 14 px en táctil (qa#6) | `CocoaStepper`: `useCoarsePointer` + `TAP_TARGET_PX` → envoltura 44 px y par «− +» horizontal de 44 × 44 (`data-direction="row"`); en escritorio geometría idéntica; helpers puros `stepperGeometry` / `stepperPartStyles` (+9 tests) |
| Mitad promocionada con hueco y detalle bajo el pliegue a 1024 (qa#10) | `cocoa-22-layout.css` bloque «lone halves»: una mitad promocionada cuyos vecinos son filas completas ocupa la fila (4/8 → 12/12 en 900–1199; 8/2/2 → 12/6/6 y 4/4/2/2 → 6/6/6/6 siguen emparejando); `GuestJourneyWorkspace` acorta la lista a 360 px en `laptop` |
| Enlaces de texto de 16 px de alto en táctil (qa#15) | `cocoa-base.css`: `@media (pointer: coarse) { .cocoa-link:not(p *) { display: inline-flex; min-height: var(--cocoa-touch-target) } }` (los enlaces dentro de un párrafo conservan su línea, WCAG 2.5.8) |
| `fullBleed` deja la barra y los chips a gutter 0 en 390 (qa#19, R29) | `cocoa-22-layout.css`: solo la `CocoaScrollArea` o la `.crg` hija directa del cuerpo sangra (`margin-inline` negativo + `max-width: calc(100% + 2 * gutter)`); la página conserva el gutter (+6 tests) |
| `<html style="color-scheme: …">` frente a V4 (qa#22) | `theme.ts` solo escribe `data-theme` (sin listener de `matchMedia`; `color-scheme` lo deriva `cocoa-tokens.css`); V4 y la sonda §5.4 pasan a «sin `--cocoa-*` en línea», `--hotelos-toast-offset` es el único inline admitido (+5 tests) |
| Valores crudos de canal y segmento en cuatro pantallas (qa#8) | `lib/format.ts`: `channelLabel(code, { empty })`, `marketSegmentLabel` (sufijo `_mock` → «(conector de pruebas)»; desconocidos humanizados) |
| Categoría, canal y disponibilidad crudos en Competencia (qa#18) | `lib/format.ts`: `hotelCategoryLabel`, `availabilityLabel`; `screens/rate-shopper-labels.ts` (`CodeCell` con el crudo en `title`, `shopSourceLabel`, `alertHeadLabel`) |
| Nombre de componente y jerga en la tarjeta de Grupos (qa#13) | `content/screen-instructions/groups.ts` reescrito (controles reales, «bloqueo de habitaciones», «fecha límite», liberación automática) |

## 5. Hallazgos de QA y estado

18 confirmados; **18 corregidos en código** por los lotes `fix:*` (todos sin navegador,
salvo la sonda DOM de `fix:5-A (css)` y el Chromium headless de solo lectura de
`fix:5-B`); la comprobación en pantalla de las correcciones sigue pendiente salvo donde
se indica.

| # | Sev. | Lote | Hallazgo | Estado |
|---|---|---|---|---|
| qa#1 | media | 5-A (cocoa-rate-grid · css) | «sin tarifa» y el mes de la cabecera de la parrilla a 1,88:1 (`--cocoa-label-tertiary`) | Corregido en `rate-grid.css` (4 reglas a `label-secondary`); verificado por `getComputedStyle` en claro y oscuro. Deriva un handoff de sistema: blanco sobre acento 4,36:1 en texto ≤ 13 px (§6) |
| qa#2 | media | 5-B | `main` desplaza 34 px a 1440 por «Cierre LY» sin salto de línea | Corregido (`CocoaStat` con `hint`); sonda DOM headless a 1440/1024/390 con `hScroll 0`. La alternativa CSS del hallazgo era inerte y no se aplicó |
| qa#3 | media | primitives (CocoaTable css) | Celda «Total» del `tfoot` pegado blanca sobre blanco | Corregido en la primitiva (causa real: `background: inherit` en línea) y en la hoja; 4 tests SSR. Sonda en `/revenue/historico-prevision/informe` pendiente (`rgb(26, 26, 26)` esperado) |
| qa#5 | baja | 3-C | Dos drawers hermanos con la misma `key` «0» en Cupos | Corregido (`to-N` / `allot-N`); 0 errores de consola por comprobar en navegador |
| qa#6 | media | primitives (CocoaStepper) | Botones «Aumentar/Reducir» de 15 × 14 px con puntero táctil | Corregido (44 × 44 en coarse, fila «− +»); render SSR con `matchMedia` falso; sonda `tooSmall: []` pendiente en las 5 URL consumidoras |
| qa#7 | baja | 3-A | Ids internos como nombre de huésped en la lista y el meta del detalle | Corregido (`reservation-guest-label.ts` + `fetchGuest`; `primaryGuest` en el detalle); réplica contra el API vivo (0 ids visibles) |
| qa#8 | baja | 3-A / 3-C (copy) | `booking_com`, `direct`, `corporate`, `ota` visibles como texto | Corregido (`channelLabel`/`marketSegmentLabel` en 4 pantallas; 24/24 tests de `format`); `providerLabel` del rate grid y el gráfico del canon quedan en §6 |
| qa#9 | baja | 3-C | Paso «Habitación asignada» con el id de la habitación | Corregido (`fetchRooms` en el `Promise.all`; «Habitación 204.» o «Habitación asignada.»); +1 ruta `GET /properties/:id/rooms` |
| qa#10 | baja | 3-C | A 1024 la lista se promociona a media fila con hueco; el detalle cae bajo el pliegue | Corregido en la hoja («lone halves») + `maxHeight` 360 en `laptop`; validado por parseo y simulación de cascada, no en motor real; mitigado, no eliminado (apilar es la única geometría sin hueco con 320 + 480) |
| qa#11 | baja | 3-A | «Planta » vacía en títulos y subtítulo del drawer | Corregido (`room-rack-labels.ts`: «Sin planta»; «Planta 1» sin duplicar en Los Tilos); 17 unitarios |
| qa#12 | baja | 3-A | `aria-current="step"` duplicado en el `<li>` y en su botón | Corregido (solo el botón lo lleva) |
| qa#13 | baja | guidance (3-B) | Nombre de componente y jerga en la tarjeta de instrucciones de Grupos | Corregido (`groups.ts`); el mismo patrón en `housekeeping.ts` y `reservations.ts` queda en §6 |
| qa#14 | baja | 5-A (copy) | «diff» en el subtítulo del historial y el estado vacío del drawer | Corregido en 4 ubicaciones del lote 5-A (2 del hallazgo + 2 hermanas) |
| qa#15 | baja | 5-C | Enlaces de fecha de 16 px de alto con puntero táctil | Corregido con criterio de sistema (`.cocoa-link` 44 px en coarse fuera de párrafo); contrato de regresión; sonda `tooSmall: []` pendiente |
| qa#17 | baja | 7-A (copy) | Inglés y jerga en Correspondencias; select «sin etiqueta» | Corregido el copy (30 sustituciones; «Mapeos» → «Correspondencias», «Channel Manager» → «Canales de venta»); la parte del select se refutó (`aria-label="Canal"` es nombre accesible válido) |
| qa#18 | baja | 5-C (copy) | Segmento del competidor en crudo («urban») | Corregido (`hotelCategoryLabel` + `CodeCell` con `title`; también canal «demo» y disponibilidad «available»); comprobado con las 3 fichas y 126 tarifas de Rías Altas |
| qa#19 | baja | 3-A + css (fullBleed) | A 390 la barra y los chips del cronograma a gutter 0 | Corregido en la hoja (solo sangra el scroller); `CocoaPage.test.mts` 6/6; sonda (`left 16` de la barra, `left 0 · width 390` de la parrilla) pendiente |
| qa#22 | baja | foundation (theme) / docs | `<html>` con `style="color-scheme: …"` frente a V4 | Corregido por las dos vías (código + criterio); `theme-contract` 5/5; comprobar que el toggle de tema sigue cambiando controles nativos en oscuro |

## 6. Handoffs pendientes

Ordenados por dueño. `fichero:línea` sobre el árbol de trabajo actual. Los resueltos en la
integración no aparecen (§4).

**Primitivas (`components/cocoa/**`)**

1. `CocoaSteps` (R1): `steps[{ key, label, state }]`, `current`, un solo `aria-current="step"`; sustituye la barra de pasos de `screens/reservations/ReservationCreateScreen.tsx:1087-1097` y la necesitan `GoLiveChecklist`, `NewTenantWizardDialog` (ola 10) y `OnboardingScreens` (ola 11).
2. `CocoaChart.tsx` (`CocoaLinePoint`) + `cocoa-chart-math.ts` (`lineGeometry`) (R26): huecos `y: number | null` (pen-up, «—» en el tooltip) y `referenceX`/marcador «hoy»; hoy `RevenueHistoryForecastDashboard.boardSeries()` rellena la previsión antes de hoy con el real.
3. `CocoaChart.tsx` (`CocoaLineProps`): `maxLabels` o adelgazado automático (≤ 8 etiquetas X); `admin/AllotmentsScreen.tsx` pinta 60 puntos diarios en `CocoaSpan cols=6 min=320`.
4. `CocoaTable.tsx:56` (`CocoaTableColumn`) (R27): `group?: string` para una fila de cabecera agrupada con `colSpan` (bloques Real/OTB · Pickup · Previsión · STLY · Presupuesto del informe diario).
5. `CocoaInput.tsx:68` · `CocoaSelect` · `CocoaStepper` (R8): alturas 34 vs 28 px en filas mixtas (`AllotmentsScreen`, `GuestProfileScreen`, `PosDashboard`).
6. `CocoaButton.tsx` (`tone`) (R30): tono semántico por estado o una primitiva de barra de cronograma; hoy `GroupsCalendarScreen`, `LiveTimelineWorkspace` y `RoomRackScreen` pintan `div role="button"` con tone helpers.
7. Control de color Cocoa (R28): `LoyaltyProgramScreen.tsx:70` y `GuestSegmentsScreen.tsx:71` conservan `color` sin editarlo ni pintarlo; `GuestPortalSettingsScreen` usa `CocoaInput type="color"` (swatch nativo sin medir; si no respeta 28 px / radio 8, rama `type === "color"` en `CocoaInput.tsx:243`).
8. `CocoaField.tsx`: un grupo de chips `aria-pressed` como hijo único deja `label[for]` apuntando a un `div role="group"` (`GuestPortalSettingsScreen` «Idiomas», patrón heredado de `PropertySetupForms`); primitiva `CocoaChoiceChips` con `fieldset`/`aria-labelledby`.
9. `CocoaStepper.tsx`: el hover de los botones ± usa `onMouseEnter/Leave`; en táctil el color de hover puede quedarse hasta el siguiente toque (pasar a `:hover` bajo `@media (hover: hover)` en `cocoa-22.css`). Preexistente, no cubierto por qa#6.
10. `CocoaTable` + `cocoa-22.css:661-681`: con la primera columna pegada ahora opaca, los lavados de zebra/hover/selección no alcanzan esa celda (antes tampoco: el `inherit` en línea los anulaba); si se quiere paridad, fondo opaco en un `::before` y `background` del `td` para los lavados.
11. `CocoaActionBar.tsx:98` (opcional): publicar `--hotelos-toast-offset` en `document.body` en vez de `<html>` si César prefiere `<html>` literalmente sin `style` (entonces V4, la sonda y la spec §7 vuelven a «sin atributo `style`»).
12. `styles/cocoa-tokens.css:64-67` (decisión de sistema, qa#1): blanco sobre `--cocoa-accent` a 4,36:1 en texto ≤ 13 px (el «hoy» de la parrilla y `CocoaButton filled` de 13 px); opciones: oscurecer `--accent` claro hasta ≥ 4,5:1 (`--accent-strong` rgb(8,107,72) → 6,56:1) o documentar la excepción en `COCOA-22.md` §2.1 y subir el «hoy» a 14 px.

**Hojas (`styles/**`)**

13. `cocoa-22-layout.css` (`fullBleed`): en < 600 la `CocoaScrollArea` sangrada pinta su borde de 1 px y radio 12 pegados al viewport; decidir tras verla si se quita `border-inline`/radio cuando sangra en teléfono.
14. `styles.css:105-106,188-189,247-248` → `styles/cocoa-tokens.css`: mover `--inverse-surface` / `--inverse-ink` (los usan `.c22-table tfoot td` y la regla nueva de qa#3) ANTES de borrar `styles.css` en la ola 11.
15. `mobile.css:257-260` (R14): retirar el tope genérico de `<select>` cuando `grep -rn '<select' apps/admin-web/src/screens` devuelva 0 (olas 10 · 11).
16. `styles/cocoa-22.css` (cabecera): cita `scripts/c22-css-check.mjs`, que no existe; restaurar el script o retirar la referencia.
17. `cocoa-base.css:142`: la excepción de prosa es `:not(p *)`; un `.cocoa-link` en texto corrido fuera de `<p>` (p. ej. cuerpo de un CocoaCallout en `div`) crecería a 44 px en táctil; ampliar a `:not(:is(p, li, dd) *)` si aparece el caso.

**Docs (`COCOA-22.md`) y guía**

18. §4.1: filas de piloto real para Calendario (`LiveTimelineWorkspace`: `CocoaScrollArea axis="both"` + `stickyFirstColumn`, bloques con tone helpers, popover fixed fuera del scroll, left/top para el arrastre; `GroupsCalendarScreen`: dos filas sticky sobre divs, sin `<table>`; `RateGridEditorScreen`: parrilla virtual propia, `fullBleed` pendiente), Workspace (`ReservationWorkspaceScreen`: tabs alojadas, 8/4 con CocoaStat, CocoaDialog destructivo), Asistente (`ReservationCreateScreen`), «Lista densa» (`RevenueHistoryForecastReport`: 27 columnas `fit` + `stickyFirstColumn` + `tfoot`), «dashboard de tres capas» (`ChannelAggregatorHub`: cabecera de grupo `plain/none` + rejilla de secciones; credenciales en `CocoaDrawer sm`), `CocoaSection padding="none"` con formulario en el `footer` (`RateShopperSettingsScreen`). §4.3 ya nombra los pilotos (este cierre).
19. §3.4 (:140) y cabecera de la plantilla `Workspace` (:1134-1142): párrafo «Filas sin hueco» (bloque «lone halves»; texto exacto en el informe de `fix:3-C`). §3 regla 21 (`c22-section__list`): el valor de una fila no envuelve por diseño; un valor compuesto va como `CocoaStat` o en filas separadas (qa#2).
20. D24 (:283): «cancela el gutter solo en la `CocoaScrollArea` (o la parrilla `.crg`) hija directa del cuerpo; cabecera, barra, chips, avisos y estados lo conservan». §3.8 fila «Touch» (:177): `CocoaStepper` 44 px con par «− +» horizontal · `.cocoa-link` fuera de párrafo 44 px. §4.2 D20/R20: las alojadas SÍ pasan `subtitle` (`ChannelAggregatorHub`, `ChannelMappingsScreen`, `GuestTimelineScreen`, `GuestProfileScreen` no lo pintan hoy). §3450: añadir `channelLabel`, `marketSegmentLabel`, `hotelCategoryLabel`, `availabilityLabel` a la lista de helpers de `lib/format`.
21. `dev/StyleGuideScreen.tsx`: ejemplo `CocoaTable stickyFirstColumn footer` (qa#3) + patrón en `style-guide-coverage.test.mts:57`; una `CocoaScrollArea` de demostración hija directa de la página junto al interruptor `fullBleed` (:1660/:1673 están dentro de una CocoaSection y el interruptor no tiene efecto visible); notas de `.cocoa-link` (:1049, :926) y del stepper táctil (:1134).
22. `docs/design/COCOA-22-MIGRACION.md` §5.4: la sonda no compone alfa ni entiende `color(srgb r g b)` (47–50 falsos positivos de `lowContrast` en `/revenue/parrilla` claro); ampliar `lum`/`bgOf` antes de la verificación visual de la tanda.

**Servicios y API**

23. `apps/api/src/modules/pms/pms.service.ts:300` `listReservations`: `primaryGuestName: string | null` por fila (y en `services/pmsCommerceApi.ts:185`); evita 18 `GET /guests/:id` en el primer pintado de `/recepcion/reservas/lista` de Rías Altas. No reiniciar `:3000` en esta sesión.
24. `services/pmsCommerceApi.ts:149-186` `AdminReservation`: declarar `primaryGuest?: { id, firstName, surname1, surname2, email }` (el API ya lo devuelve) y retirar el tipo local `ReservationDetail` de `ReservationWorkspaceScreen.tsx:99`; `:553` cita el export `ReservationWorkspaceScreen “Cobrar”` retirado (solo comentario).
25. `services/revenueApi.ts:310` `money`: sin importadores tras 5-C; retirar.
26. `admin/CancellationPoliciesScreen.tsx:45`, `operations/SalesPipelineDashboard.tsx`, `operations/UpsellsDashboard.tsx`: `PROPERTY_ID` a nivel de módulo (heredado) no sigue el cambio de propiedad sin recarga.
27. `guest-portal/GuestPortalSettingsScreen.tsx` `save()`: falta `PUT`/`GET /properties/:id/guest-portal/settings`; hasta entonces «Guardar configuración» solo confirma con toast (como antes).
28. Copy pendiente de la misma clase: `components/cocoa-rate-grid/helpers.ts:621` `providerLabel` → `channelLabel(code, { empty: "" })` (único cambio visible: «Google Hotels (simulado)» → «(conector de pruebas)»); `operations/GeneralManagerScreen.tsx:339` gráfico «ingresos por canal» con `channelLabel`; `notifications/NotificationsScreen.tsx:633` canal de envío crudo (ola 10); `revenue/RateGridEditorScreen.tsx:1240` y `cocoa-rate-grid/SyncStatusPanel.tsx:59` «log de entregas del Channel Manager» → «historial de entregas en Canales de venta»; `lib/channel-hash.ts:1` y `cocoa-rate-grid/README.md:129` «Mapeos» → «Correspondencias»; etiqueta de módulo «Channel Manager» en `admin/NewTenantWizardDialog.tsx:97`, `admin/TenantDetailScreen.tsx:60`, `marketplace/MarketplaceCatalogScreen.tsx:21` (nombre de módulo: decisión de producto).
29. `reservations/ReservationWorkspaceScreen.tsx:600`: `reservation.bookerName?.trim() || "Sin definir"` si un `bookerName` en blanco se confirma como hallazgo.

**Copy y contenido**

30. `content/screen-instructions/housekeeping.ts:2,4,6` («movil-first», «Priority queue», «Maintenance», «Operations Director») y `reservations.ts:3-20` (acentos: «busqueda», «huesped», «habitacion»…): texto propuesto en el informe de `fix:guidance`. Después, ampliar `tests/admin-web-spanish-copy-contract.test.mjs:27-28` a `src/content/screen-instructions/*.ts` (con el barrido de nombres de componente `/\b[A-Z][a-zA-Z]+(Dialog|Screen|Drawer)\b/`); hoy fallaría por esos dos ficheros.

**Ola 11 y limpieza**

31. `packages/ui/src/components/timeline/**` (14 ficheros · 1.039 líneas, colores literales) + alias `@hotelos/ui/timeline` en `apps/admin-web/vite.config.ts:18,38` (R32): sin consumidor en admin-web.
32. `components/cocoa-rate-grid/helpers.ts:956-969` `toastOffsetForBar` / `STATUS_BAR_BASE_HEIGHT_PX` / `TOAST_OFFSET_BASE_PX` + `__tests__/final-fixes.test.mts:137-140` (R31): retirar juntos.
33. `components/cocoa-guidance/CocoaScreenInstructionsCard.tsx`: sigue consumida (Cupos, Grupos, Canales); decidir si se mantiene o se pliega en una variante de `CocoaCallout`.
34. `tabs/recepcion/HuespedesTabs.tsx:14-15`: importar desde el barrel `../../../components/cocoa` (A1).
35. `reservations/QuickActionsDialogs.tsx`: `git rm` en el commit de la tanda (hoy `D` en el árbol).

**Datos demo y producto**

36. Rías Altas (`cmrhw9jy40003fyvbuu2ec2w7`): 120/120 habitaciones con `room.floor = ""`; la UI dice «Sin planta»; si se quieren plantas reales hay que corregir el dato, no la UI.
37. Decisiones deliberadas a validar: asistente de seis pasos en `ReservationCreateScreen`; tres ajustes de comportamiento del cronograma (§2, 3-A); `GroupsCalendarScreen` sin `fullBleed`; BAR sin «valor de derivación» en `RatePlansScreen`; eyebrows internos y avatar con inicial retirados del hub de canales; subtítulo alojado no pintado en cuatro pantallas (D20); colores de nivel/segmento no editables; filtro de Campañas como `CocoaSelect`; copy traducido en las 46 pantallas (F6).

## 7. Lo no verificado

- **Verificación visual §5 de las 46 pantallas, 10 diálogos/drawers y 18 correcciones**:
  ningún lote de migración ni de corrección tuvo navegador (la QA adversarial sí, sobre
  el estado anterior a las correcciones). Faltan la matriz 1440/1024/390 × claro/oscuro,
  la sonda §5.4 (gutter 24/16, `hScroll 0`, un `h1`, `raw 0`, `lowContrast []`,
  `tooSmall []` en coarse, `htmlInlineCocoa []`), la sonda de foco §5.5, Esc en
  CocoaDrawer/CocoaDialog y la tabla §5.6. URL por lote: `/recepcion/reservas/{lista,
  cronograma, tablero, :id, :id/recorrido, nueva, nueva/dictar}`,
  `/recepcion/grupos{,/calendario,/cupos}` y sus drawers (cancelar antes de confirmar),
  `/recepcion/huespedes/:id{,/cronologia}`, `/recepcion/mensajes`,
  `/revenue/{parrilla, parrilla/historial, calendario-demanda, historico-prevision,
  historico-prevision/informe, reunion, planes, politicas-cancelacion, competencia,
  reglas}`, `/comercial/canales{,/correspondencias}`,
  `/comercial/clientes{,/segmentos,/fidelizacion,/programa,/campanas}`,
  `/comercial/reputacion{,/encuestas,/calidad}`,
  `/comercial/ventas-adicionales{,/ofertas,/portal}`, `/comercial/ventas-empresas`.
- Sondas concretas de las correcciones (valores esperados en los informes `fix:*`):
  barra del cronograma `left 16` y parrilla `left 0 · width 390` a 390 (qa#19); recorrido
  a 1024 × 768 con ambos spans en `1 / -1` y lista de 360 px (qa#10); `tooSmall: []` con
  `[data-cocoa="stepper"] button` de 44 × 44 en `/recepcion/reservas/nueva`,
  `/operaciones/tpv`, `/operaciones/tpv/cierre-de-caja`, `/finanzas/facturacion/enrutamiento`
  (qa#6) y en `/revenue/reglas` (qa#15); `tfoot td:first-child` en `rgb(26, 26, 26)` /
  `rgb(255, 255, 255)` en el informe diario (qa#3); 0 «Encountered two children with the
  same key» en Cupos (qa#5); `htmlStyleAttr null` salvo `--hotelos-toast-offset` con
  CocoaActionBar montada (qa#22); chips «Booking.com · n» con `title` del código (qa#8);
  «Urbano»/«Sondeo interno»/«Disponible» en Competencia (qa#18).
- Puntos de atención visuales: hoja inferior de los 10 drawers a 390 × 844 con el
  diálogo de descarte encima (`z-sheet` 600 bajo `z-modal` 700); `CocoaTable` de 11
  columnas de Planes y de 27 del informe a 1024 (`fit`/`showFrom`, scroll interno sin
  perder el `thead` sticky); `CocoaInput/Select size="small"` dentro de tablas con puntero
  grueso (`CONTROL_HEIGHT_BY_SIZE.small` 22 px); `CocoaChart.Line` de 60 puntos en Cupos y
  de 11 barras en Encuestas a 390; `CocoaChart.Bars` del pickup en el drawer de grupo;
  CocoaActionBar fija a 390 con `safe-area` (perfil del huésped, portal, parrilla);
  popover de la ficha rápida del cronograma fuera del scroll; arrastre y redimensión de
  bloques con puntero real y ⌘/Ctrl+Enter.
- Estados no reproducibles con Carmen: «Módulo no activado» de las 8 pantallas de
  clientes/reputación (gate por `screenKey`), alertas de paridad (Faranda no tiene),
  recomendaciones «mantener» y la vista de restricciones de la parrilla (qa#1 verificado
  por token, no en pantalla), pantalla «Módulo…» solo en `prop_123`.
- `pnpm lint` no ejecutable en el repo (ESLint 9 sin `eslint.config.*`, R23).
- Los cambios de copy deliberados de cada lote (estados y opciones en español, «cuadro»
  por «board», «Correspondencias» por «Mapeos», riesgo Alto/Medio/Bajo, etc.) están
  pendientes de validación de producto (F6), no de código.

## 8. Puertas §7.3 (conteos literales, cierre 2026-09-16)

| Puerta | Resultado |
|---|---|
| `node scripts/typecheck-all.mjs --parallel 3` | **15 PASS · 0 FAIL · 0 XFAIL · 1 SKIP** (`apps/guest-web`, explícito) · 13,4 s |
| `corepack pnpm test` | **410 tests · 81 suites · 410 pass · 0 fail** (tras regenerar el inventario: la regla 15 estaba en rojo solo por `lines` 84.733 → 84.869) |
| `corepack pnpm --filter @hotelos/api test` | **1.233 tests · 371 suites · 1.232 pass · 1 skipped · 0 fail** |
| Unitarios front (`node --import tsx --test …/__tests__/*.test.mts`) | **756 tests · 235 suites · 756 pass · 0 fail** |
| `node scripts/check-discoverability.mjs` | OK · placeholders **16/20** · 0 enlaces rotos |
| `node scripts/build-nav-tree.mjs --check` | al día (**66 ítems · 94 pestañas · 205 redirecciones**) |
| `node scripts/cocoa-22-inventory.mjs` | escrito · **216 pantallas · 84.869 líneas · 1.912 puntos** · `--summary`: bo-card 307 · bo-* 1.216 · `<button>` 203 (CocoaButton 820) · `<table>` 40 (CocoaTable 217) · inputs crudos 158 · `style={}` 1.833 · colores literales 70 (38 fallbacks) · cabecera Cocoa 167 · `useTabHost` 58 |
| `node scripts/cocoa-22-waves.mjs --write` / `--check` | §6 escrito · **68 pendientes · 1.757 puntos · 8 lotes** · `--check`: §6 al día |
| `node docs/design/cocoa-22-api.mjs --write` / `--check` | §8 actualizado y al día · 40 ficheros · 68 interfaces · 55 type aliases · 640 props · 162 funciones · 29 constantes · 1.873 líneas |
| `node docs/design/cocoa-22-api.mjs --typecheck-examples` | 11 plantillas · **tsc 0 errores** en las plantillas y en admin-web |
| `bash .husky/pre-commit` | discoverability OK + `typecheck-all --parallel 2` **15 PASS · 0 FAIL · 1 SKIP** · 19,9 s · «Pre-commit checks passed» |
| Contrato `tests/cocoa-22-contract.test.mjs` | **18/18** (`ALLOWLIST_CEILING` 68 = `NOT_MIGRATED.length` 68; `GLOBAL_CEILING` = totales regenerados) |
| `tests/admin-web-spanish-copy-contract.test.mjs` | **6/6** |

## 9. Árbol de trabajo y siguiente paso

`git status` (raíz `~/anfitorio-demo`, todo bajo `hotelos/`): **89 modificados · 1
retirado (`D`: `reservations/QuickActionsDialogs.tsx`, copia en el scratchpad
`c22-removed/`) · 11 nuevos** (3 módulos puros + 7 tests + este informe); +16.423 /
−17.718 líneas sin contar el lockfile. Sin ficheros temporales, logs ni sondas en el
repositorio (el script de verificación de `fix:5-C (copy)` se movió al scratchpad
`c22b-removed/`). `hotelos/pnpm-lock.yaml` figura modificado desde antes de `efa8c8e`
(mtime 05:32; añade `@fontsource-variable/inter`, `zod`, `@playwright/test` y
`qrcode-terminal`, que los `package.json` de admin-web y api ya declaran en `HEAD`): no
es de esta tanda y no se ha tocado (R25); César decide si va en el commit.

Siguiente paso (plan §7.3, fuera de este cierre): un commit por ola —o uno por tanda— con
mensaje `feat(cocoa-22/olas-3-5-7): …` que incluya pantallas, primitivas, hojas, kit de
la parrilla, contrato, inventario, §0/§3/§4.4/§6/§8 del plan, §4.3/§8.2 de la spec, el
runbook y este informe (`git rm` de la muerta incluido); nunca `--no-verify`. Después
arrancan las olas 8 (Cumplimiento, 18 ficheros · 602 pts · 3 lotes), 10 (Configuración,
40 · 1.025 · 4 lotes) y 11 (Compartido, desarrollo y limpieza, 10 · 130 · 1 lote) según
§6, con los handoffs de §6 de este informe como primer lote de `primitives`/`css`/`docs`
y la verificación visual §5 de las tandas A y B como lote con navegador.
