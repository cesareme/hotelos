# Tanda TL · Live Timeline (visor de reservas en casa y proyectadas por habitación) · Integración, puertas, verificación funcional y líneas de fusión — 18 de septiembre de 2026

**Para:** César. **Encargo (18/09/2026, prioridad alta):** «Necesitamos el LIVE TIMELINE que había en la demo de julio
(demo.hotelos.es): las habitaciones en casa con su cliente asignado y las reservas proyectadas, por habitación, en un
calendario interactivo con pop-ups de información, como FNS Rooms o Mews; pero con el nuevo look and feel del UI», y el
añadido de las 22:50: «primera opción del menú lateral, visible para TODOS los usuarios». **Método:** brief verificado
(`scratchpad/tandaTL-brief.md`: diagnóstico contra la pantalla Cronograma de HEAD 99dc3c3 y el código de julio exportado a
`~/anfitorio-demo/pilots/timeline-julio-referencia/`) → TL-1 (motor puro) → TL-2 (presentación pura, 9 componentes y
hoja) → TL-3 (parrilla virtualizada, arrastre, teclado) → TL-4 (inspector, diálogos, copy) → TL-5 (pantalla, barrel,
instrucciones, contrato) → TL-6 (integración: puertas, sondas HTTP, revisión de código, líneas de fusión) → ronda de
corrección 1 (§8, 22 hallazgos) → **TL-7 (este documento, ejecutado el 19/09/2026 de 02:20 a 02:55 en el worktree
`~/anfitorio-demo-wt-timeline/hotelos`, rama `tanda-timeline` sobre 99dc3c3): verificación funcional REAL** — API propio
en :3906 con `RBAC_STRICT=true` y front propio en :5176 apuntando a :3906, sonda de 19 pasos (lecturas, escrituras
reversibles y su vuelta atrás, 403 de un perfil sin permiso, motor puro sobre los datos reales), **recorrido en navegador
de la pantalla nueva** montada en un arnés temporal (sin tocar `App.tsx` ni las rutas; borrado al terminar), las ocho
puertas repetidas después y las líneas de fusión revificadas con `sed -n`. Ambas instancias matadas al terminar; el API
de :3000 y el front de :5173 no se han tocado.

**Resultado en una línea:** el Live Timeline nuevo (30 ficheros, 7.497 líneas: 4.545 de código —motor, pantalla, 15
componentes, hook, presentación, barrel, copy y el prefijado de Nueva reserva—, 2.331 de tests, 452 de hoja y 25 de
instrucciones; más +12/−1 líneas en `ReservationCreateScreen.tsx`) pasa typecheck, los 1.366 tests del front (1.365 ✔ ·
1 omitido preexistente · 0 ✖; 147 propios de la tanda), el build de producción, las 15 reglas del contrato Cocoa 22 con el
inventario regenerado (227 pantallas; `inlineStyles` 679 → 679 y `rawTables` 2 → 2 porque la pantalla tiene 0 `style={`
y 0 `<table`; `debtPoints` 193 → 193) y los tres contratos de copy/fetch/marca; **contra la API real de Rías Altas**
(hoy: 147 habitaciones, 11 tipos y 485 reservas tras la importación OPERA de la madrugada, ver §5.0) los 19 pasos de la
sonda son verdes, incluidos `POST assign-room` ida y vuelta y `PATCH` de fechas ida y vuelta sobre RES-00254 (estado final
idéntico al inicial) y el 403 honesto de `rrhh`; **en navegador** la pantalla pinta 147 filas con 304 barras, la ficha
rápida, el panel acoplado (escritorio) y el cajón (teléfono), el teclado (flechas, Intro, Escape), el arrastre con
diálogo de confirmación → `PATCH` → barra de deshacer → `PATCH` inverso («Cambio deshecho.»), el rechazo local de un
solape («La habitación 213 ya está asignada a la reserva RES-00196 en esas fechas»), la creación por celdas y el
callout de 403 sin pantalla en blanco. La única «puerta roja» es la esperada: `LiveTimeline` queda huérfana en
`check-discoverability` hasta que el orquestador aplique las líneas (a)-(g) de §6. Los 22 hallazgos de la revisión están
corregidos salvo los dos que viven en ficheros prohibidos (lockfile y `permissions.ts`), líneas para el orquestador en §8.

---

## §1 Encargo y diagnóstico corregido

El brief partía de que la pantalla Cronograma actual (`apps/admin-web/src/screens/timeline/LiveTimelineWorkspace.tsx`,
**1.296 líneas** por `wc -l`, 1.297 en el inventario, **24 `style={`**, **1 `<table>`** envuelta en `CocoaScrollArea`
con `data-cocoa-grid-table`) había perdido el arrastre, los solapes, la granularidad y los filtros del Live Timeline de
julio. La lectura del fichero corrige el diagnóstico: **la pantalla actual conserva** el arrastre con pointer events
(mover de habitación y redimensionar), el aviso de solapes por habitación, el selector Día/Semana/Mes con Hoy y
anterior/siguiente, y la barra de filtros por estado y canal. Lo que **faltaba de verdad** y motiva la pantalla nueva:

1. El nombre «Live Timeline» y su sitio: primera entrada del menú para todos los perfiles (hoy es la pestaña Cronograma
   de Reservas, visible solo para recepción, pisos, dirección, admin y auditoría).
2. Media celda de llegada/salida como en Mews (hoy los bloques ocupan celdas enteras y dos estancias consecutivas en
   la misma habitación se solapan visualmente).
3. Mover de fechas arrastrando (hoy solo cambia de habitación o redimensiona) y confirmación previa que muestre el
   cambio (noches, habitación, aviso de tarifa) con deshacer.
4. Overbooking por **tipo y día** (reservas confirmadas + en casa > habitaciones vendibles) con lista de días; hoy solo
   hay solapes por habitación.
5. Fila de disponibilidad por tipo y día bajo la cabecera, grupos por tipo colapsables, leyenda, búsqueda por
   código/huésped/habitación y filtro por tipo, «Limpiar filtros».
6. Crear reserva seleccionando celdas (habitación × noches).
7. Inspector con folio (saldo), actividad y acciones en un panel acoplado (cajón en teléfono), y ficha rápida al pasar el
   ratón que **no** re-renderiza toda la pantalla.
8. Teclado (flechas, Intro, Escape) y accesibilidad (roles, `aria-label` en bloques, foco visible, live region).
9. Rendimiento con 120-150 habitaciones × 30 días (virtualización de filas propia; hoy `<table>` completa).
10. Fecha de negocio de la propiedad como «hoy» (hoy la fecha local).
11. Degradación honesta con 403 (perfiles sin `pms.reservation.read`) en vez de pantalla en blanco.
12. Cero `style={` (hoy 24) y cero `<table>` (hoy 1) para bajar los techos globales al retirar la pantalla vieja.

## §2 Arquitectura

- **Motor puro** `screens/timeline/timeline-engine.ts` (1.277 líneas; solo dos `import type`: `pmsCommerceApi` y
  `cocoa-tones`; sin DOM, red, `Intl` ni `toLocale*`). Fechas solo-día en UTC, «hoy» de referencia
  `referenceToday = max(fecha de negocio, día local)` (:66, la regla del check-in del API), escala
  `CELL_WIDTH = { day: 150, week: 118, month: 64 }` para **7/14/30 días** (`GRANULARITY_DAYS`, :78-79) y
  `CELL_WIDTH_NARROW = { day: 120, week: 88, month: 48 }` + `LEAD_WIDTH_NARROW = 104` en teléfonos (:81, :86;
  `rangeFor(anchor, g, { narrow })`, :111), `blockFor` con **media celda** (`laneStart = offset + 0.5`, :341;
  `laneEnd = offset + nights + 0.5`) y `barGeometry` sobre `laneStart/laneEnd × cellWidth`, reparto en carriles por
  interval partitioning (dos estancias consecutivas comparten carril), filas por tipo y habitación, ventana de
  virtualización (+ `pinRow`, :606, que fija la fila origen de un arrastre), `dragAllowed` (en casa solo habitación,
  cerradas nada), `roomAssignmentConflict` (:707, espejo de `canAssignRoom`: bloqueada / ocupada / solape → motivo de
  rechazo) dentro de `resolveDrop` → `DropResolution = { pending, rejected }` (:747), `patchFor` (:835; un solo PATCH
  `{ arrivalDate, departureDate, assignedRoomId? }`; `null` cuando solo cambia la habitación → POST assign-room),
  `undoPatchFor` / `undoEntryFor` (:879; deshacer local, con `note` honesta en casa, :864), colisiones
  (`roomOverlapCount` solo estados vivos y todos los pares, :904), overbooking por tipo y día con `roomsCount`
  (`roomUnits`, :942), filtros, teclado y creación por celdas (`newReservationSearch`, :1198).
- **Presentación pura** `components/timeline/timeline-presentation.ts` (156 líneas): la geometría sale como
  **variables CSS en funciones con nombre** (`barVars`, `ghostVars`, `rowVars`, `selectionVars`, `gridVars`,
  `spacerVars`) que la hoja `styles/cocoa-22-timeline.css` (452 líneas, 0 colores literales) consume en `.tl-bar`,
  `.tl-ghost`, `.tl-cell-select`, `.tl-row`, `.tl-lane`, `.tl-grid`, `.tl-spacer`, `.tl-panel`.
- **Parrilla de divs con ganchos sticky** `TimelineGrid.tsx` (479 líneas): cabecera de días y fila global «Libres»
  sticky bajo la cabecera, grupos por tipo colapsables (`TimelineAvailabilityRow`), filas `TimelineRow` memoizadas
  (`memo(`, `TimelineRow.tsx:65`) dentro de un `CocoaScrollArea` con ambos ejes. **Virtualización propia:** sumas
  prefijas (`rowOffsets`) + búsqueda binaria (`rowWindow`) sobre `scrollTop` y altura del scroller, localizado con
  `rootRef.current?.closest<HTMLElement>(SCROLLER_SELECTOR)` (:126, :194), listener `scroll` pasivo + `ResizeObserver`
  coalescidos en un `requestAnimationFrame`; fuera de la ventana solo dos espaciadores. Hover **local** (`CocoaPopover`
  + `TimelineQuickCard`; la pantalla no conoce el hover). Selección de celdas con fase `click`/`drag` (`dragPhase`, :369;
  `onCreateFromCells` solo en fase `drag`, :381). `useImperativeHandle` (:229) expone `focusBar` a la pantalla.
- **Ghost imperativo** `useTimelineDrag.ts` (231 líneas) + `TimelineDragLayer.tsx`: pointer events colgados de
  `window` durante la pulsación (sin `setPointerCapture`, sin librerías), umbral `DRAG_THRESHOLD_PX = 4` (engine :99),
  estado en un ref y un único `useState` (`dragging`); el fantasma se mueve con `style.setProperty` sobre las variables
  de `ghostVars` (cero re-render por movimiento); **Escape y `pointercancel` cancelan** sin `onDrop` (:186, :214);
  autoscroll horizontal y vertical (:139).
- **Pantalla** `screens/timeline/LiveTimeline.tsx` (993 líneas, **0 `style={`**, **0 `<table`**): carga por rango
  visible con una noche de margen a cada lado paginando el sobre hasta agotar `nextCursor` (:170-180,
  `RANGE_PAGE_LIMIT = 500`, tope `MAX_RANGE_PAGES = 10`), **fecha de negocio** por `fetchNightAuditBusinessDate` con
  fallback a la fecha local si el endpoint responde 403 o falla (:283-288, `referenceToday`), nombres de huésped por
  lotes de `GUEST_BATCH_SIZE = 20` (o «Sin huésped» / «Huésped no visible» si el 403 lo impide, :423), filtros,
  `applyPending` como **único punto de escritura** además de `onUndo` (:658-710 y :712-730): move con fechas → **un solo
  PATCH** `updateReservation` (:668), move solo de habitación o `checked_in` → `assignReservationRoom` (:669), resize
  (:672), asignar (:684), check-in con habitación, check-out con `acknowledgeBalance`, cancel/no-show con motivo;
  **deshacer local** con `undoEntryFor` y `TimelineUndoBar` (`onUndo` :712; assign-room :720 / PATCH :722); 404 de
  folio → «Sin folio» (:493 + `TimelineInspector.tsx`); 403 → `CocoaCallout` (textos `FORBIDDEN_TITLE`/`FORBIDDEN_MESSAGE`
  :138-139) con «Actualizar» deshabilitado (:781); una sola live region (`CocoaLiveRegion`, :973); roving tabindex
  (`TimelineBar.tsx:59`, `aria-label` completo por `barAriaLabel` :42-68); badge «Cierre nocturno pendiente · fecha de
  negocio …» (:848) cuando la fecha de negocio va por detrás.
- **Inspector, diálogos y copy** `TimelineInspector.tsx` (panel acoplado NO modal `tl-panel` `role="complementary"` en
  escritorio, `CocoaDrawer` en teléfono, :107), `TimelineActionDialog.tsx` (`confirmDisabled` :93; gancho L3-F1 :153),
  `TimelineCreateDialog.tsx`, `timeline-dialog-copy.ts` (`dialogCopy` para los siete tipos: move, resize, assign,
  checkin, checkout, cancel, noshow).

## §3 Lotes TL-1..TL-7 (ficheros, líneas y tests)

| Lote | Ficheros (líneas, `wc -l` del 19/09) | Tests (casos · suites) |
|---|---|---|
| TL-1 · motor puro | `screens/timeline/timeline-engine.ts` (1.277) | `screens/timeline/__tests__/timeline-engine.test.mts` (1.034): **86 · 17** — fechas (+ referenceToday), escala y columnas (+ narrow), estado visual, habitación, guestLabel (+ no visible), blockFor (media celda), barGeometry, carriles, buildRows, virtualización (+ pinRow), arrastre (+ bloqueada / ocupada / solape rechazados), parches y deshacer (+ note), colisiones y disponibilidad (+ roomsCount), filtros, teclado, crear por celdas, errores del API y actividad |
| TL-2 · presentación + 9 componentes + hoja | `components/timeline/timeline-presentation.ts` (156), `TimelineHeader.tsx` (46), `TimelineDateSelector.tsx` (95), `TimelineFilterBar.tsx` (97), `TimelineLegend.tsx` (23), `TimelineAvailabilityRow.tsx` (68), `TimelineBar.tsx` (112), `TimelineQuickCard.tsx` (68), `TimelineGapAlert.tsx` (53), `TimelineUndoBar.tsx` (80), `styles/cocoa-22-timeline.css` (452) | `components/timeline/__tests__/timeline-presentation.test.mts` (305): **18 · 4** — variables CSS de bloques (+ lead estrecho); disponibilidad, iniciales y leyenda (variante por estado); contrato Cocoa 22 sobre el fuente de los 9 .tsx; hoja (+ alturas fijas, trazos, dedo, panel) |
| TL-3 · parrilla, arrastre, teclado | `TimelineGrid.tsx` (479), `TimelineRow.tsx` (149), `TimelineDragLayer.tsx` (50), `useTimelineDrag.ts` (231) | `components/timeline/__tests__/timeline-grid.test.mts` (248): **10 · 2** — funciones puras de useTimelineDrag; contrato de fuente TL-3 (+ selección ≠ detalle, umbral de celdas) |
| TL-4 · inspector, diálogos, copy | `TimelineInspector.tsx` (294), `TimelineActionDialog.tsx` (195), `TimelineCreateDialog.tsx` (52), `timeline-dialog-copy.ts` (104) | `components/timeline/__tests__/timeline-inspector.test.mts` (247): **10 · 2** — dialogCopy para los siete tipos; contrato de fuente TL-4 (panel no modal, Sin folio, gancho L3-F1, motivo obligatorio) |
| TL-5 · pantalla, barrel, instrucciones | `screens/timeline/LiveTimeline.tsx` (993), `components/timeline/index.ts` (19), `content/screen-instructions/timeline.ts` (25) | `screens/timeline/__tests__/live-timeline-contract.test.mts` (428): **18 · 2** — Cocoa 22 estricto (pantalla, instrucciones, componentes, motor, hoja); composición y contrato de pantalla (+ 5f-bis selección ≠ detalle; 7 hoja por una sola vía) |
| §8 · corrección 1 (fuera de `timeline/`) | `screens/reservations/reservation-create-prefill.ts` (48, nuevo) + `screens/reservations/ReservationCreateScreen.tsx` (+12/−1, fichero existente NO prohibido) | `screens/reservations/__tests__/reservation-create-prefill.test.mts` (69): **7 · 2** — query válida/inválida y contrato de fuente del formulario |
| TL-6 / TL-7 · integrador | `docs/audits/TANDA-TL-LIVE-TIMELINE-2026-09-18.md` (este), `docs/design/cocoa-22-inventory.json` (regenerado, +48/−13) | sondas y arnés de §5 (ficheros temporales en el scratchpad, fuera del árbol) |

Total: **30 ficheros nuevos, 7.497 líneas** (+12/−1 en `ReservationCreateScreen.tsx`); **147 casos en 29 suites**
propios de la tanda (cifras del runner). Los seis tests puros importan solo `.ts` (`timeline-engine.ts`,
`timeline-presentation.ts`, `useTimelineDrag.ts`, `timeline-dialog-copy.ts`, `screen-instructions/timeline.ts`,
`reservation-create-prefill.ts`, tipos de `pmsCommerceApi.ts`) y nunca el barrel `../cocoa`.

## §4 Puertas (cifras reales del 19/09/2026 02:50, repetidas tras borrar el arnés y matar las instancias)

| # | Puerta | Estado | Cifra |
|---|---|---|---|
| 1 | `git -C ~/anfitorio-demo-wt-timeline status --short` | verde (con la salvedad del lockfile) | ` M hotelos/pnpm-lock.yaml` (+52/−0: resync de un lockfile obsoleto frente a dependencias YA declaradas; **fichero prohibido, no tocado**: línea para el orquestador en §8) + ` M …/ReservationCreateScreen.tsx` (+12/−1, §8 UXC-03/TLF-01) + ` M hotelos/docs/design/cocoa-22-inventory.json` (+48/−13) + **30** ficheros nuevos sin seguimiento + este informe; nada más. Los dos ficheros del arnés (§5.2) no existen ya; ningún prohibido tocado |
| 2 | `corepack pnpm --filter @hotelos/admin-web typecheck` | verde | exit 0 (`tsc --noEmit` sin errores; 8,4 s) |
| 3 | tests del front (`node --import tsx --test` sobre 103 ficheros `__tests__/*.test.mts`) | verde | **1.366 tests · 382 suites · 1.365 ✔ · 0 ✖ · 1 omitido** (preexistente) · 2,3 s; subconjunto de la tanda (6 ficheros): **147 · 29 · 147 ✔** |
| 4 | `corepack pnpm --filter @hotelos/admin-web build` | verde | `✓ built in 2.43s`; dos avisos `(!)` preexistentes de Vite sobre `auth-storage.ts`/`activeProperty.ts` importados dinámica y estáticamente (ajenos a la tanda). `LiveTimeline.tsx` no genera chunk porque `App.tsx` no lo importa aún (esperado); `LiveTimelineWorkspace-FVjVZ-Ih.js` 26,42 kB sigue |
| 5 | `node scripts/cocoa-22-inventory.mjs` + `node --test tests/cocoa-22-contract.test.mjs` | verde | `Escrito docs/design/cocoa-22-inventory.json · 227 pantallas · 193 puntos de deuda`; contrato **18 ✔ · 0 ✖ · 5 suites**. Totals: files **227**, lines **94.256**, inlineStyles **679** (= techo), rawTables **2**, cocoaButtons 1.093, withPageHeader 202, withTabHost 90, debtPoints **193**. Regeneración idempotente (`git diff --stat`: `1 file changed, 48 insertions(+), 13 deletions(-)` antes y después). La pantalla entra como `LiveTimeline` · arquetipo `calendario` · categoría `compartido` · `screenKeys []` · 994 líneas · 4 `cocoaButtons` · 0 `inlineStyles` · 0 `rawTables` · `debtPoints 0` · tamaño L. `LiveTimelineWorkspace.tsx` sigue con 1.297 líneas · 9 `debtPoints` |
| 6 | `node scripts/check-discoverability.mjs` | rojo **esperado** | exit 1: `❌ 1 orphan screens found` → `LiveTimeline -> apps/admin-web/src/screens/timeline/LiveTimeline.tsx:135`. Resto verde: 227 pantallas, 192 URLs del árbol cubiertas, 26 whitelisted, 0 literales de sidebar, 0 claves sin URL, placeholders 16/20. **No** añadida a `apps/admin-web/.discoverability-whitelist.json`: se resuelve con §6 (c)-(d) |
| 7 | `node --test tests/admin-web-spanish-copy-contract.test.mjs tests/admin-web-no-raw-fetch.test.mjs tests/brand-contract.test.mjs` | verde | **20 ✔ · 0 ✖ · 3 suites** |
| 8 | recuentos Cocoa 22 estricto | verde | `style={` en `LiveTimeline.tsx` **0**; en `LiveTimelineWorkspace.tsx` **24** (+ 1 `<table`, 1.296 líneas); en `components/timeline/*.tsx` **7** (Bar 1 · DragLayer 1 · Grid 3 · Row 2; los otros 11 a 0), todos geometría vía variables CSS; `style={{` **0**; `<button|input|table|select|textarea>` crudos **0**; colores literales (`#hex`, `rgb()`, `hsl()`) en componentes, motor, pantalla, hoja y prefijado **0**; `bo-` **0**. Techo proyectado tras sustituir la pantalla vieja: 679 − 24 + 7 = **662** (la hoja nueva vive fuera del inventario) |

## §5 Verificación funcional real (TL-7, 19/09/2026 02:20-02:55)

### §5.0 El dato ha cambiado bajo la tanda: Rías Altas tras la importación OPERA

La premisa del brief (RA con 120 habitaciones, 5 tipos, 3 reservas en casa en 202/411/601 y ~25 en la ventana) era
cierta a las 00:30 (sonda de TL-6) y **ya no lo es**: la «carga de datos» que tenía parado el API de :3000 era una
importación OPERA (las notas de las reservas dicen `OPERA · conf … · ext …`; huéspedes creados a las 00:22) que terminó
entre las 02:21 y las 02:23 mientras corría la primera sonda (que aún vio 25 reservas en la ventana; la segunda vio 320).
Estado real de RA a las 02:25 (estable en dos lecturas separadas 6 s):

| Dato | Antes (00:30) | Ahora (02:25) |
|---|---|---|
| Habitaciones | 120 | **147** (45 no vendibles según `roomBlocked`: 37 `clean` + 8 `dirty` con `sellable=false`; 0 `occupied`) |
| Tipos | 5 | **11** (Individual 3, Doble estándar 45, **Doble Estándar 2** —duplicado de la importación—, Doble con supletoria / triple 7, Doble Superior Vista Ría 20, Junior Suite 15, Doble superior 30, Suite Rías Altas 5, Doble cama king 10, Doble king superior 7, King ejecutiva / familiar 3) |
| Reservas (06/2026 → 03/2027) | — | **485**: 377 confirmadas · 96 canceladas · 12 salidas; llegadas 12/07/2026 → 22/01/2027 (62 el 02/10) |
| Ventana de 30 días (18/09 → 18/10) | 25 | **320** (295 confirmadas · 21 canceladas · 4 salidas), 304 con habitación, `nextCursor: null` |
| En casa | 3 (202, 411, 601) | **0** en cualquier fecha (`status=checked_in` → total 0); 202 y 411 `dirty`, 601 `dirty` y no vendible |
| Fecha de negocio | 2026-09-13 | 2026-09-13 (sigue seis días por detrás del día local 19/09) |

Consecuencia: la verificación de «en casa» se hace con el motor (estado `checked_in` cubierto por los tests) y no con
datos vivos; a cambio la pantalla se ha probado con un volumen realista (147 filas × 30 días, 320 reservas).

### §5.1 Sonda HTTP + motor (API propio en :3906, `RBAC_STRICT=true`; `scratchpad/probe-timeline.mts`, 19 pasos)

Arranque desde el worktree: `PORT=3906 RBAC_STRICT=true node --env-file=../../.env --import tsx src/server.ts` en
`apps/api` (pid 40985; `.env` de la raíz del worktree, `NODE_ENV=development` → el fallback CORS de desarrollo admite
`localhost:5176`). La sonda importa **el motor real** (`timeline-engine.ts` vía tsx) y lo ejecuta sobre las respuestas.
Usuario `recepcion.rias@faranda.test`, `x-property-id: cmrhw9jy40003fyvbuu2ec2w7`.

| # | Paso | Resultado |
|---|---|---|
| 1 | `GET /health` | 200 |
| 2 | `POST /auth/login` recepcion.rias | 200; claves `token, sessionId, user, property`; 75 permisos (`pms.reservation.read`, `pms.reservation.modify`, `guests.read`, `analytics.read` = true) |
| 3 | `GET /properties/:id/night-audit/business-date` | 200 `currentDate: 2026-09-13`; local 2026-09-19 → `referenceToday` = **2026-09-19** |
| 4 | `rangeFor(anchorForToday, "month")` | from 2026-09-18 · to 2026-10-18 · 30 columnas · cellWidth 64 · hoy = columna 1 |
| 5 | `GET …/reservations?from&to&envelope=true&limit=500` | 200; `items` 320 = `total` 320, `nextCursor: null`; el sobre trae `primaryGuestId` y **no** `primaryGuestName` (→ §6 (l)) |
| 6 | `GET …/rooms` · `GET …/room-types` | 200 · 147 habitaciones (array) · 200 · 11 tipos |
| 7 | En casa | 0 (ver §5.0) |
| 8 | `GET /guests/:id` (lote de 20 de 319 ids únicos) | 20/20 → 200; `{ guest: { fullName } }` (muestra: «ARTEMIA DACOSTA SANCHEZ», «Xoán Barreiro Lois», «Camille Dubois») |
| 9 | `GET /reservations/:id/folio` + `/activity` (RES-00193) | 200 (`folio, lines, payments, chargesTotal, paymentsTotal, refundsTotal`; saldo 0) · 200 (0 eventos) |
| 10 | Motor sobre datos reales: `availabilityByType` + `buildRows` | **159 filas** = 1 «Sin asignar» (4 barras) + 11 grupos + 147 habitaciones; **304 barras** en habitaciones (262 confirmadas · 29 llega hoy · 4 salidas · 9 canceladas); `overbookingDays` 0; `roomOverlapCount` 0; altura total 8.852 px (virtualización necesaria) |
| 11 | Candidata de escritura | RES-00254 (confirmada, 20→22 sept, hab. 425 Doble cama king, total 176,80 €); destino libre hab. 007 |
| 12 | `POST /reservations/:id/assign-room { roomId: 007 }` (ida) | 200, `assignedRoomId` → 007 |
| 13 | `POST …/assign-room { roomId: 425 }` (vuelta) | 200; `GET` posterior: hab. 425, 20→22 sept, total 176,80 € |
| 14 | `PATCH /reservations/:id { arrivalDate, departureDate: 23 sept, assignedRoomId }` (+1 noche, un solo PATCH como `patchFor`) | 200, `departureDate` → 2026-09-23; **total 176,80 → 176,80 (NO recotizado, como avisa el diálogo)** |
| 15 | `PATCH` inverso (vuelta) | 200; `GET`: 20→22 sept, hab. 425, `confirmed`, total 176,80 € — **estado final idéntico al inicial** |
| 16 | `POST …/assign-room` a la hab. 106 (bloqueada / no vendible) | **409** «No se puede asignar la habitación 106: La habitación está bloqueada por mantenimiento o no es vendible.»; la reserva sigue en 425; el motor lo rechaza antes con el mismo texto (`roomAssignmentConflict` → `ROOM_BLOCKED_REASON`) |
| 17 | `POST /auth/login` rrhh (payroll_hr) | 200; `pms.reservation.read = false` |
| 18 | rrhh: `GET …/reservations` · `GET …/rooms` | **403** «No tienes permiso para realizar esta acción (requiere: pms.reservation.read).» · 403; `isForbidden(engine)` = true |
| — | Resumen | **19 pasos · 19 OK · 0 KO** |

Escrituras totales registradas en el log del API de :3906 durante toda la sesión: 3 `POST assign-room` (2 de la sonda +
1 rechazado con 409) y 6 `PATCH` (2 de la sonda sobre RES-00254 + 4 del navegador sobre RES-00166, §5.2), todas con su
vuelta atrás; 11 `POST /auth/login` (límite 10/min respetado).

### §5.2 Recorrido en navegador (front propio en :5176 → API :3906; arnés temporal, borrado)

`App.tsx` y `routes/` son ficheros prohibidos y el router no admite una ruta de desarrollo por variable de entorno
(`?dev=1` solo activa `devOnly` de rutas ya registradas), así que la pantalla se montó con un **arnés temporal** en el
worktree —`apps/admin-web/tl-harness.html` + `apps/admin-web/src/tl-harness.tsx`, 12 + 48 líneas, **borrados al
terminar** (puerta 1 de §4 lo confirma)— que reproduce la pila real: `initTheme()`, `styles.css`, `POST /auth/login`
→ `setSession` como `LoginScreen`, `writeActiveProperty` como `AuthGate`, y `<ToastProvider><CocoaGlobalProvider>
<LiveTimeline/></CocoaGlobalProvider><ToastHost/></ToastProvider>` como `App.tsx:876-890`. Vite en :5176 con
`VITE_API_URL=http://localhost:3906` (pid 41688). Vite transforma sin error `LiveTimeline.tsx` (143,8 kB, 20 imports),
`cocoa-22-timeline.css`, `TimelineGrid.tsx` y `timeline-engine.ts`. Lo comprobado (evidencia por DOM, red y
capturas; viewport 1280 × 1500 salvo donde se indica):

| Flujo | Evidencia |
|---|---|
| Carga inicial | Peticiones reales: `rooms`, `room-types`, `night-audit/business-date`, `reservations?from=2026-09-17&to=2026-10-03&limit=500&envelope=1` (semana: 14 días + una noche de margen a cada lado), `guests/:id` por lotes; todas 200 (la única entrada 404 de la consola es un recurso del propio arnés, no del API: ninguna petición a :3906 devolvió ≠ 2xx) |
| Cabecera y badges | Eyebrow «HOY», título «Live Timeline», subtítulo de julio, «Actualizar»; selector Anterior/Hoy/Siguiente + fecha + Día · 7 / Semana · 14 / Mes · 30; badges `147 HABITACIONES · 222 RESERVAS VISIBLES · EN CASA: 0 · LLEGADAS HOY: 30 · SALIDAS HOY: 2 · CIERRE NOCTURNO PENDIENTE · FECHA DE NEGOCIO 13 SEPT`; «Sin selección» |
| Filtros | Chips por estado (Confirmada · 218, Cancelada · 9, Salida · 4), canal (Mayorista/TTOO, GDS, Booking.com, Teléfono, Correo electrónico, Expedia, Corporativo, Directo, OTA, Hotels com, Agencia de viajes, Walk-in) y tipo (los 11) con recuentos reales; buscador «Código, huésped o habitación» |
| Parrilla | Cabecera de días sticky con «19 sept · hoy» resaltado, fila «Libres» por columna (69 · 46 · 65 · 55 · 53 · 47 · 54 · 87 · 83…), carril «Sin asignar» arriba, filas «Hab. 205 · DOBLE ESTÁNDAR · 3 PAX» con punto de estado; barras con nombre y «Confirmada · 2 noches · 153,00 €», llegada/salida a **media celda** (dos estancias consecutivas en la misma fila sin solaparse), «Llega hoy» en verde; leyenda al pie (LLEGA HOY, EN CASA, SALE HOY, CONFIRMADA, BORRADOR, Salida, NO-SHOW, CANCELADA, BLOQUEADA · MANTENIMIENTO). Virtualización: la ventana muestra ~10 filas de 159 y desplaza con la rueda |
| Ficha rápida | Hover sobre «Elda Sela del Rio» → popover: iniciales, RES-00166, Confirmada, Booking.com, Hab. 205, entrada vie 18 sept, salida dom 20 sept, 2 noches, 2 ad., 153,00 €, Mayorista, «Haz clic para ver el detalle» |
| Detalle (escritorio) | Clic → panel acoplado a la derecha (`.tl-panel`, sin scrim): RES-00166 · Elda Sela del Rio · Hab. 205; chips Confirmada / Booking.com / Hab. 205 / 2 noches; «Huéspedes» (principal, 2 adultos); «Estancia y folio» (estado, entrada, salida, noches, tipo, habitación, canal, importe 153,00 €, saldo pendiente 0,00 €, cobros 0,00 €, actividad abierta 0); «Actividad reciente · 0 eventos · Sin datos»; «Ir a» (Recorrido del huésped, Folio y facturación, Limpieza, Mantenimiento, Mensajes); «Acciones» (Check-in, Check-out deshabilitado, Cambiar habitación, Cancelar reserva, Marcar no-show); `Esc` · «Abrir reserva». Peticiones `folio` y `activity` solo al abrir. Badge «Selección: RES-00166 · Elda Sela del Rio» |
| Teclado | `document.activeElement` tras el clic = la barra (`tl-bar cocoa-focus-ring`, `aria-label` «Reserva RES-00166 de Elda Sela del Rio, Confirmada, 2 noches, Hab. 205, 18–20 sept»); **Escape** cierra el panel y el foco sigue en la barra; **ArrowDown** → selección RES-00167 (Hab. 206) con foco en su barra y `aria-pressed`; **Enter** → panel de RES-00167; Escape → cierra; Escape otra vez → «Sin selección». Live region: «Seleccionada la reserva RES-00168». (Con las teclas «Down»/«Return» de la herramienta de automatización no pasó nada: son nombres de tecla no estándar, no un fallo de la pantalla; con `ArrowDown`/`Enter` y con `KeyboardEvent` reales funciona) |
| Arrastre con fechas → PATCH → deshacer | Arrastre de RES-00166 +7 días en su fila → diálogo «Mover reserva — Mover RES-00166 (Elda Sela del Rio), nuevas fechas 25–27 sept (2 noches). Cambio: ANTES 18–20 sept (2 noches) Hab. 205 → DESPUÉS 25–27 sept (2 noches) Hab. 205. El precio no se recalcula al cambiar las fechas: revísalo en la reserva. Cancelar / Mover» → «Mover» → **`PATCH /reservations/cmu7n7c7e0016fyd3pbn05ip3` 200** → la parrilla recarga el rango, la barra aparece en 25–27 y «Libres» se recalcula (69→70 el 18, 87→86 el 25) → barra de deshacer «Reserva RES-00166 movida de fechas · Se puede deshacer el cambio en la reserva RES-00166 durante 7 s · Deshacer · Cerrar» → «Deshacer» dentro del plazo → **`PATCH` inverso 200** → toast «Cambio deshecho.», barra otra vez en 18–20. Hecho dos veces (la primera vez el plazo de 8 s venció antes del clic y se devolvió con un segundo arrastre −7 días + «Mover»); cuatro `PATCH` en total, **estado final verificado por API: RES-00166 confirmada 18→20 sept, hab. 205, total 153 €** |
| Rechazo local de un solape | Arrastre de RES-00166 (hab. 205, 18–20) sobre la fila de la hab. 213 (RES-00196, 19→20) → sin diálogo y sin petición: toast «La habitación 213 ya está asignada a la reserva RES-00196 en esas fechas» (`roomAssignmentConflict` → `roomOverlapReason`) |
| Crear por celdas | Arrastre sobre celdas vacías de la hab. 213 (25→27 sept) → selección punteada y diálogo «Nueva reserva — Hab. 213 · Doble estándar · 25–27 sept · 2 noches · Se abrirá el formulario…» (`role="dialog"`); Escape lo cierra. El salto a Nueva reserva no se ejecutó (fuera del router en el arnés); el prefijado por query lo cubre `reservation-create-prefill.test.mts` y §6 (j) |
| Granularidad | «Mes · 30» → «18 sept – 17 oct 2026», petición `from=2026-09-17&to=2026-10-19`; «Día · 7» → «18–24 sept 2026», `from=2026-09-17&to=2026-09-26`; recuentos de chips y badges recalculados por rango («137 reservas visibles» en Día) |
| Teléfono (375 × 812) | Controles apilados, chips que envuelven, columna de recursos estrecha con elipsis («DOBLE ESTÁND…»), celdas de 120 px, cabecera sticky; tocar una barra abre el **`CocoaDrawer`** (no el panel) con la misma ficha; Escape lo cierra |
| 403 honesto | Arnés con `rrhh@faranda.test` (payroll_hr): `rooms` y `room-types` → 403; la pantalla muestra el callout «Tu perfil no puede leer reservas — Pide acceso a dirección para ver el Live Timeline.» con «Actualizar», sin parrilla y **sin pantalla en blanco** |

Cierre: `kill` de 41688 (Vite) y 40985 (API, necesitó `-9` como en TL-6); `lsof -iTCP:3906/5176 -sTCP:LISTEN` vacíos;
`:3000` (pid 78677) y `:5173` (pid 57597) siguen siendo los del árbol principal, intactos; ficheros del arnés borrados;
`git status` como en la puerta 1.

### §5.3 Revisión de código de los cinco lotes (lectura, anclas del 19/09)

| Comprobación | Resultado (fichero:línea) |
|---|---|
| Media celda por `laneStart/laneEnd` en `blockFor`/`barGeometry` | ✔ `timeline-engine.ts:341` (`offset + 0.5`) y `barGeometry` (:350) sobre `laneStart × cellWidth`, `MIN_BAR_WIDTH` :100; visto en navegador (§5.2) |
| Un solo PATCH en move con fechas | ✔ `patchFor` (engine :835) devuelve `{ arrivalDate, departureDate, ...assignedRoomId }`; `LiveTimeline.tsx:668` una sola llamada a `updateReservation`; confirmado en red (un `PATCH` por movimiento) |
| `checked_in` solo habitación (assign-room) | ✔ `dragAllowed` (engine :655, `IN_HOUSE_DRAG_REASON` :630); `patchFor` → `null` sin fechas nuevas → `assignReservationRoom` (`LiveTimeline.tsx:669`); deshacer en casa también por assign-room (:720, `roomOnly`) |
| 404 de folio como «Sin folio» | ✔ `LiveTimeline.tsx:493` (`isNotFound` → `missing: true`) → `TimelineInspector.tsx` |
| 403 con callout, sin duplicar estado | ✔ `LiveTimeline.tsx:138-139` textos; «Actualizar» `disabled={forbidden}` :781; visto en navegador con rrhh |
| Iteración de `nextCursor` | ✔ `LiveTimeline.tsx:170-180` (`RANGE_PAGE_LIMIT = 500`, tope `MAX_RANGE_PAGES = 10`); con 320 ítems en una página `nextCursor` es `null` |
| Escape y `pointercancel` cancelan el arrastre | ✔ `useTimelineDrag.ts:186`, :214 |
| Roving tabindex + aria-label completo | ✔ `TimelineBar.tsx:59`, `barAriaLabel` :42; visto en `document.activeElement` |
| `memo(` en TimelineRow | ✔ `TimelineRow.tsx:65`; `aria-rowindex` :76 |
| Hover local a la parrilla | ✔ `TimelineGrid.tsx` (estado local, popover); la pantalla no tiene estado de hover; la ficha rápida no dispara peticiones |
| Scroller vía `closest('[data-cocoa="scroll-area"]')` | ✔ `TimelineGrid.tsx:126` y :194 |
| Selección ≠ detalle, foco de vuelta a la barra | ✔ `LiveTimeline.tsx:226` `inspectorOpen`, :530 `onOpen`, :537 `closeInspector`, :742 `handleEscape`; `TimelineGrid.tsx:229` `useImperativeHandle` → `focusBar`; visto en navegador |
| Cero `style={{` | ✔ 0 en los 15 .tsx de componentes y 0 en la pantalla; los 7 `style={` son `style={barVars(...)}` y equivalentes |
| Tests puros solo `.ts`, nunca el barrel `../cocoa` | ✔ imports listados en §3 |

**Desviaciones encontradas en el código: ninguna.** Dos imprecisiones del encargo, corregidas en §6: la ruta del JSON de
rutas legacy es `scripts/legacy-backoffice-routes.json` (no `apps/admin-web/src/scripts/…`) y `pms.service.ts` está en
`apps/api/src/modules/pms/`.

## §6 Líneas de fusión exactas para el orquestador (cada ancla verificada con `sed -n` el 19/09 02:50)

(a) `apps/admin-web/src/styles.css`: insertar `@import './styles/cocoa-22-timeline.css';` como **nueva línea 26**, tras
la línea 25 `@import './styles/cocoa-22-guide.css';` y antes de la actual línea 26 `@import './styles/mobile.css';`.
Retirar el gancho temporal de `apps/admin-web/src/screens/timeline/LiveTimeline.tsx:26`:
`import "../../styles/cocoa-22-timeline.css"; // Tanda TL: gancho temporal; …`. **El test 7 de
`live-timeline-contract.test.mts:382` admite las dos situaciones** (gancho antes de la fusión, `styles.css` después:
exige exactamente una vía y, tras la fusión, que la hoja vaya justo después de `cocoa-22-guide.css` y antes de
`mobile.css`), así que (a) no deja la suite en rojo (hallazgo TL-R2 de §8).

(b) `apps/admin-web/src/screens/tabs/recepcion/ReservasTabs.tsx:27`:
`LiveTimelineWorkspace: () => import("../../timeline/LiveTimelineWorkspace").then((m) => ({ default: m.LiveTimelineWorkspace })),`
→ `LiveTimelineWorkspace: () => import("../../timeline/LiveTimeline").then((m) => ({ default: m.LiveTimeline })),`
y en el comentario :6 «Cronograma (LiveTimelineWorkspace)» → «Live Timeline (LiveTimeline)». (Solo en la variante
pestaña de (d); en la variante alias la línea :27 se retira.)

(c) `apps/admin-web/src/App.tsx` (bloque `SCREEN_COMPONENTS` :177; el helper `lazyNamed` está en :50). **Dos líneas,
no una** (hallazgo TL-R4): el inventario Cocoa (`scripts/cocoa-22-inventory.mjs:205`) solo reconoce la forma
`const <Var> = lazyNamed(() => import("./screens/<ruta>")…)` a nivel de módulo + la clave en el bloque (:215, regex
`^\s*(\w+)(?::\s*(\w+))?,?\s*$`), así que la forma inline `LiveTimeline: lazyNamed(...)` dentro del bloque dejaría la
pantalla con `screenKeys []` / categoría «compartido». Líneas exactas:
1. tras `App.tsx:106` (`const AiHumanReviewQueueScreen = lazyNamed(…)`), nueva línea:
   `const LiveTimeline = lazyNamed(() => import("./screens/timeline/LiveTimeline"), "LiveTimeline");`
2. en `SCREEN_COMPONENTS`, bloque `// --- Hoy ---` (:181), nueva entrada **antes** de `FrontDeskDashboard: MiDiaTabs,` (:182):
   `LiveTimeline,`
La ruta `/hoy/live-timeline` la genera `build-nav-tree` desde la fila (d) (`routes/backoffice.routes.tsx` no se edita a
mano). La línea `:195` `LiveTimelineWorkspace: ReservasTabs,` se trata en (d) según la variante elegida.

(d) `~/anfitorio-demo/pilots/tanda5-nav-tree.csv` (fuera de git; cabecera
`screenKey;estadoActual;decision;destino;etiquetaES;url;tab;roles;modulo;justificacion;orden`): fila nueva **exacta**:
`LiveTimeline;funcional;keep;Hoy;Live Timeline;/hoy/live-timeline;;recepcion|pisos|mantenimiento|fnb|direccion|comercial|revenue|finanzas|administracion|rrhh|propiedad|activos|auditoria|sistemas|admin;core;Petición de César 2026-09-18: visor de reservas en casa y proyectadas por habitación, primera entrada del menú para todos los perfiles;1`
Renumerar «Hoy» (`orden`, última columna): línea 52 `FrontDeskDashboard` Mi día 1 → **2**; 78 `AssistantChat` 2 → **3**;
22 `ShiftManagerScreen` 3 → **4**; 20 `NightAuditScreen` 4 → **5**; 104 `ApprovalsInbox` 5 → **6**; 103
`AiOwnerSummaryScreen` 6 → **7**; 101 `AiHumanReviewQueueScreen` 7 → **8**. Fila **166** actual
`LiveTimelineWorkspace;funcional;merge-into;ReservationWorkspace;Cronograma;/recepcion/reservas/cronograma;Cronograma;recepcion|pisos|direccion|admin|auditoria;core;«Live Timeline» → pestaña Cronograma de Reservas (ocupación en el tiempo), como pide el plan §2.2.;2`
**Aviso:** el árbol no admite la misma clave en dos sitios, así que hay dos variantes (lo decide el orquestador), cada
una con su línea exacta (hallazgo TL-R5):
- **Variante alias** (la pestaña desaparece de Reservas y la URL vieja redirige): fila 166 →
  `LiveTimelineWorkspace;alias;duplicate-of;LiveTimeline;—;;;;core;Tanda TL: la pestaña Cronograma pasa a ser el Live Timeline de Hoy; se conserva solo como redirección /recepcion/reservas/cronograma → /hoy/live-timeline.;`
  (el generador resuelve la URL de un `duplicate-of`/`retire` siguiendo `destino`, `scripts/build-nav-tree.mjs:262-270`,
  y lo vuelca en `aliases`/`retired`, :396-406). `tests/nav-tree-contract.test.mjs:228-246` exige que cada alias apunte
  al **componente de su clave canónica**, así que `App.tsx:195` `LiveTimelineWorkspace: ReservasTabs,` pasa a
  `LiveTimelineWorkspace: LiveTimeline,` **y se mueve al bloque `LEGACY_SCREEN_KEYS`** (tras :385, junto a
  `ChannelManagerDashboard: CanalesTabs,` :390); retirar la línea :27 de `ReservasTabs.tsx` (no aplicar (b)).
- **Variante pestaña** (la pestaña se conserva con la etiqueta «Live Timeline» y carga la pantalla nueva): fila 166 →
  `LiveTimelineWorkspace;funcional;merge-into;ReservationWorkspace;Live Timeline;/recepcion/reservas/cronograma;Live Timeline;recepcion|pisos|direccion|admin|auditoria;core;Tanda TL: la pestaña Cronograma pasa a llamarse Live Timeline y carga la pantalla nueva (LiveTimeline.tsx) vía ReservasTabs; la entrada canónica es Hoy › Live Timeline (/hoy/live-timeline).;2`
  `App.tsx:195` sigue `LiveTimelineWorkspace: ReservasTabs,`, se aplica (b) y no hay alias.
Después `node scripts/build-nav-tree.mjs` → `apps/admin-web/src/navigation/nav-tree.generated.json` (hoy :227-229
`"screenKey": "LiveTimelineWorkspace"`, `"label": "Cronograma"`, `"url": "/recepcion/reservas/cronograma"`).

(e) `scripts/legacy-backoffice-routes.json:190-191` (ruta corregida; no existe `apps/admin-web/src/scripts/…`):
`"path": "/backoffice/timeline",` / `"screen": "LiveTimelineWorkspace"` → `"screen": "LiveTimeline"`.

(f) `apps/admin-web/src/screens/operations/FrontDeskDashboard.tsx:585`
`<CocoaButton … onClick={() => navigateTo("LiveTimelineWorkspace")}>` y `:613`
`{ id: "front-desk-timeline", label: "Abrir cronograma", run: () => navigateTo("LiveTimelineWorkspace") }` →
`navigateTo("LiveTimeline")` (y la etiqueta «Cronograma»/«Abrir cronograma» → «Live Timeline»/«Abrir Live Timeline»
si César lo prefiere).

(g) `tests/cocoa-22-contract.test.mjs:118` `"timeline/LiveTimelineWorkspace.tsx": 40,` → `"timeline/LiveTimeline.tsx": 0,`
(o borrar la entrada: 25 por defecto, `DEFAULT_STYLE_BUDGET` :173); `:176` `GLOBAL_CEILING`, tras retirar
`LiveTimelineWorkspace.tsx`: `inlineStyles: 679` → **655** (679 − 24) y `rawTables: 2` → **1** (2 − 1), anotándolo en el
comentario de :175; regenerar `node scripts/cocoa-22-inventory.mjs` (files 227 → 226, lines −1.297) y volver a pasar el
contrato (regla 13 exige `≤` techo y `≤` inventario commiteado).

(h) Retirada de `apps/admin-web/src/screens/timeline/LiveTimelineWorkspace.tsx` traspasando lo de L3-F1. En este
worktree SÍ existen `apps/admin-web/src/services/cancellationApi.ts:36` `previewCancellationCharge(reservationId)` (GET
`/reservations/:id/cancellation-charge`) y `apps/admin-web/src/services/finance-contracts.ts:231` `financeErrorMessage`,
pero **NO** `lifecycleOutcomeSummary`/`penaltyPreviewSummary` en `apps/admin-web/src/components/billing/charge-types.ts`
(exports :16 `ANY_CHARGE_TYPE`, :18 `CHARGE_TYPE_LABELS`, :77 `ROUTING_SOURCE_TYPES`, :93 `normalizeChargeType`, :107
`chargeTypeLabel`, :116 `routingSourceOptions`) ni el envío de `{ applyPolicy: true }` en cancel/no-show (grep vacío en
`LiveTimelineWorkspace.tsx`). Puntos de enganche: `apps/admin-web/src/components/timeline/TimelineActionDialog.tsx:153`
(rama cancel/noshow, comentario «gancho L3-F1: aquí irá la previsualización de penalización…»: pasar la previsualización
por props, p. ej. `penaltyPreview?: string | null`, y pintarla como `CocoaCallout` bajo el campo Motivo) y `applyPending`
de `LiveTimeline.tsx:658-710` (cancel `cancelReservation(res.id, input.reason)`, no-show `noShowReservation(res.id,
input.reason)`: añadir `{ applyPolicy: true }` cuando `pmsCommerceApi` lo exponga).

(i) `packages/shared/src/permissions.ts` (fichero de L3): añadir `"pms.reservation.read"` **y `"guests.read"`** a las
plantillas `payroll_hr` (:1679-1696), `asset_manager` (:1772-1811) y `admin` (:2150-2231). `pms.reservation.read` cubre
las tres lecturas de la parrilla: `GET /properties/:id/rooms`, `/room-types` y `/reservations` están en
`apps/api/src/security/route-permissions.ts:674, :676, :677` con `permissions: ["pms.reservation.read"]`; pero **los
nombres de huésped** salen de `GET /guests/:id` (`route-permissions.ts:916`, `guests.read`, riesgo medio) y sin esa
clave los tres perfiles verían todos los bloques como «Huésped no visible» (hallazgo TL-R3; la pantalla ya degrada con
honestidad). Alternativa sin abrir `guests.read` a RRHH/activos: aplicar (l) —`primaryGuestName` en el sobre de
`listReservations`— y entonces la pantalla no necesita `GET /guests/:id` para pintar nombres. Decisión de política para
el orquestador. La fecha de negocio `GET /properties/:id/night-audit/business-date` pide `analytics.read`
(`apps/api/src/modules/night-audit/route-permissions.partial.ts:17`): con rrhh respondió 200 en §5.2, así que las tres
plantillas ya la tienen o no hace falta añadirla; si alguna no la tuviera la pantalla usa la fecha local sin avisar
(`LiveTimeline.tsx:283-288`). Subir `ROLE_TEMPLATE_VERSION = 2` (:2372) a 3 y aplicar el mecanismo aditivo de la Tanda
8a: `corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run --upgrade-templates` y después sin `--dry-run`
(`apps/api/package.json:15`; procedimiento en `docs/audits/TANDA-8A-RBAC-2026-09-18.md:159` y :430-432). Hasta entonces
la pantalla degrada con el callout verificado en §5.2.

(j) **YA APLICADO en este worktree** (ronda de corrección 1, hallazgos UXC-03 / TLF-01; `ReservationCreateScreen.tsx`
no está en la lista de ficheros prohibidos): `apps/admin-web/src/screens/reservations/ReservationCreateScreen.tsx:332-334`
lee una vez al montar `parseReservationPrefill(window.location.search)` (módulo puro nuevo
`screens/reservations/reservation-create-prefill.ts`) y el formulario nace de `{ ...defaultForm, ...prefill }`; el paso
Estancia muestra el callout «Fechas, tipo y habitación prefijados desde el Live Timeline: revísalos antes de continuar».
El orquestador solo tiene que **incluir esos tres ficheros en el commit de fusión**; nada que editar.

(k) `apps/admin-web/src/content/screen-instructions/reservations.ts:15`
`'Los colores de las reservas reflejan el estado: verde confirmada, amarillo pendiente, rojo cancelada, gris no-show.',`
está desfasado: en el Live Timeline confirmada = azul info, llegada hoy / en casa / sale hoy tienen tono propio y las
canceladas solo se ven con su filtro (leyenda en `content/screen-instructions/timeline.ts` `tips[0]`).

(l) API: que `listReservations` devuelva `primaryGuestName` — `apps/api/src/modules/pms/pms.service.ts:331-339`
(`attachPrimaryGuestIds`) ya trae el `guestId` en lote; basta incluir el nombre en ese `findMany`. Confirmado otra vez
en §5.1 (paso 5): el sobre trae `primaryGuestId` y no `primaryGuestName`, así que la pantalla hace lotes de
`GET /guests/:id` (`GUEST_BATCH_SIZE = 20`; con 319 ids únicos en la ventana de un mes son 16 lotes).

(m) Opcional: acción «Deshacer» en el toast — `apps/admin-web/src/components/Toast.tsx:13-27` (`ToastOptions` solo
`variant`/`duration`) y :55-61 (`push`), `apps/admin-web/src/components/cocoa/CocoaToast.tsx:57-64` (`CocoaToastProps`
sin acción) — para sustituir `TimelineUndoBar` (`components/timeline/TimelineUndoBar.tsx`, 80 líneas).

## §7 Pendientes

1. **Precio re-cotizado:** el PATCH de fechas no recotiza (`apps/api/src/modules/pms/pms.service.ts:1340-1364` solo
   llama a `quotedTotalForStay` cuando cambia `totalAmount`; verificado en §5.1 paso 14: 176,80 € antes y después);
   el diálogo avisa «El precio no se recalcula al cambiar las fechas: revísalo en la reserva», y el importe real lo
   pondrá L3 cuando exponga el quote.
2. **Previsualización de penalización** en cancelación/no-show (L3-F1): gancho en `TimelineActionDialog.tsx:153` y
   `applyPending`; ver (h).
3. **Huésped en el importador T7:** las reservas importadas sin huésped principal se pintan «Sin huésped» (dato real,
   no inventado). Tras la importación OPERA de RA todas traen `primaryGuestId` (319 ids únicos en la ventana), así que
   hoy no hay ningún «Sin huésped» en RA.
4. **Bloqueos de mantenimiento por rango de fechas:** el API solo expone `maintenanceStatus` por habitación; la fila se
   marca bloqueada entera, sin fechas. Tras la importación hay 45 habitaciones no vendibles en RA (37 limpias): si son
   un artefacto de la carga (sin `sellable`) hay que corregirlo en datos, no en la pantalla.
5. **Check-in fuera de ±1 día:** `checkInReservation` (`apps/admin-web/src/services/pmsCommerceApi.ts:458-463`) no
   expone `allowEarlyCheckIn`; el diálogo muestra el 409 del API.
6. **Discoverability huérfana** hasta aplicar (c)-(d) — no whitelisted a propósito.
7. **Pruebas en navegador con el API :3000 cuando vuelva, ya fusionada:** esta ronda las hizo contra :3906 con un arnés
   (§5.2); queda repetir el recorrido dentro de la app real (menú Hoy › Live Timeline, pestaña de Reservas, redirección
   legacy, salto a Nueva reserva con prefijado, «Ir a» del panel) con recepción de RA y con un perfil sin
   `pms.reservation.read` (rrhh) y otro sin `guests.read`; y ver el panel bajo la parrilla en tableta (600-899 px), que
   el arnés no cubrió.
8. **Datos de RA tras la importación OPERA:** 0 reservas en casa (las 3 del brief ya no existen como `checked_in`) y
   fecha de negocio 2026-09-13 (seis días por detrás): decidir si se hace check-in a alguna llegada y se cierra el día
   antes de la demo para que «En casa» y «Hoy» luzcan; tipo «Doble Estándar» (2 habitaciones) duplicado de «Doble
   estándar» (45): dato de la importación, no de la pantalla.
9. **Tabla de reservas** `LiveTimelineWorkspace.tsx` sigue en el árbol (1.296 líneas, 24 `style={`, 1 `<table>`) hasta (h).
10. **Mover una estancia con el dedo** (tabletas y teléfonos): desde §8 (UXC-04) las barras dejan pasar el
    desplazamiento (`touch-action: pan-x pan-y` bajo `pointer: coarse`), así que arrastrar para MOVER una reserva es
    solo de ratón; redimensionar por los asideros sí funciona con el toque. Si César quiere mover con el dedo, la vía
    es una pulsación larga (no implementada; el hook ya cancela en `pointercancel`).
11. **Ocupada local vs. huérfana:** `roomAssignmentConflict` rechaza soltar sobre una habitación con `status:
    "occupied"` aunque no haya ninguna reserva en casa cargada en ella; el API permitiría ese caso «huérfano» con una
    nota. Falso rechazo solo en habitaciones mal marcadas (hoy 0 en RA); el diálogo «Asignar» sigue admitiéndolas.
12. **Plazo de deshacer de 8 s:** suficiente con el ratón (§5.2), justo para una automatización; si César lo quiere más
    largo es `DEFAULT_UNDO_SECONDS` en `TimelineUndoBar.tsx` (o el toast con acción de (m)).
13. **Barra de filtros en teléfono:** los chips de canal y tipo ocupan ~1,5 pantallas antes de la parrilla (§5.2); una
    cabecera plegable («Filtros · 3») sería la mejora obvia para móvil.

## §8 Ronda de corrección 1 (19/09/2026) — 22 hallazgos de la revisión

Método: los fallos de puertas y los hallazgos llegaron con fichero:línea y reproducción; cada uno se corrigió en el
worktree (nunca en ficheros prohibidos) con su test, y las ocho puertas de §4 se repitieron después (cifras ya
actualizadas allí y confirmadas otra vez en TL-7). Los dos hallazgos que viven en ficheros prohibidos quedan como
líneas para el orquestador.

### Fallo de puertas

| Hallazgo | Estado | Línea para el orquestador |
|---|---|---|
| `hotelos/pnpm-lock.yaml` modificado (+52: resync de dependencias ya declaradas —`@fontsource-variable/inter`, `zod`, `@playwright/test`, `playwright-core`, `qrcode-terminal`, `fsevents`—, no nuevas; su mtime es el de la creación del worktree, anterior al primer fichero de la tanda; fichero prohibido) | **no tocado** (prohibido) | `git -C ~/anfitorio-demo-wt-timeline checkout -- hotelos/pnpm-lock.yaml` (o commitear el resync si el orquestador prefiere cerrar la deuda; en CI `install --frozen-lockfile` falla con el lockfile de HEAD, no con este) |

### Confirmados

| Id | Corrección (fichero:línea) | Test |
|---|---|---|
| **UXC-01 / TL-R1 (alto)** selección = inspector modal | Selección ≠ detalle. `LiveTimeline.tsx:226` `inspectorOpen`, `:530` `onOpen(id, via)` (clic / Intro / Espacio), `:537` `closeInspector` conserva la selección y devuelve el foco por `gridHandle.focusBar`, `:742` `handleEscape` (diálogo → celdas → detalle → selección; también lo usa la parrilla vía `onEscape`). `TimelineGrid.tsx` las flechas solo `onSelect(next)`; el clic selecciona y abre; `:229` `useImperativeHandle`. `TimelineInspector.tsx` elige por viewport: panel acoplado NO modal `tl-panel` `role="complementary"` sin scrim ni focus trap (toma el foco solo con `focusToken` de apertura por teclado) o `CocoaDrawer` en teléfono (:107). Hoja `.tl-workspace[data-panel="open"]` (panel sticky a la derecha; bajo la parrilla en < 900 px). **Verificado en navegador en §5.2 (escritorio y teléfono, teclado)** | `live-timeline-contract.test.mts` (5f-bis) · `timeline-grid.test.mts` · `timeline-inspector.test.mts` (panel) |
| UXC-02 clic en hueco abre «Nueva reserva» | `TimelineGrid.tsx:369-381`: la selección de celdas tiene fase `click`/`drag` con `dragPhase` (umbral 4 px); nada se pinta en el pointerdown y `onCreateFromCells` solo en fase `drag`; un toque para desplazar termina en `pointercancel`. Verificado en §5.2 (crear por celdas) | `timeline-grid.test.mts` |
| UXC-03 / TLF-01 la query de Nueva reserva se ignoraba | Ver §6 (j): `reservation-create-prefill.ts` + `ReservationCreateScreen.tsx:332-334` y callout | `reservation-create-prefill.test.mts` (7) |
| UXC-04 teléfono: columna de 200 px, barras que no dejan desplazar | Motor `LEAD_WIDTH_NARROW = 104` (:86) y `CELL_WIDTH_NARROW` (:81) vía `rangeFor(…, { narrow })` (:111; pantalla `:267`); `gridVars(range, todayIndex, leadWidth)`; celda de recursos con elipsis en una línea; sin tarjeta rápida en teléfonos; `@media (pointer: coarse) .tl-bar { touch-action: pan-x pan-y }` y asideros `none`; `.tl-quick` `min(280px, 80vw)`. Verificado en §5.2 (375 × 812) | engine test (narrow) · presentation test (gridVars, hoja) · grid test |
| TLF-02 arrastre no alineado con canAssignRoom | `roomAssignmentConflict` (engine:707): bloqueada → `ROOM_BLOCKED_REASON`, ocupada por otra en casa o `status: "occupied"` → `ROOM_OCCUPIED_REASON`, otra confirmada/en casa con solape → `roomOverlapReason`; `resolveDrop` (:747) lo aplica al mover y al redimensionar y lo devuelve como `rejected` (toast) en vez de un diálogo que iba a 409. Verificado en §5.2 (toast de la hab. 213) y §5.1 (paso 16: mismo texto que el 409 del API) | `timeline-engine.test.mts` |
| TLF-04 «hoy» = fecha de negocio a secas | `referenceToday` (engine:66) = max(fecha de negocio, día local), como `pms.service.ts:2098-2103`; `LiveTimeline.tsx:288`; badge «Cierre nocturno pendiente · fecha de negocio 13 sept» (`:848`) cuando va por detrás; notas del check-in y `CHECK_IN_DATE_OUT_OF_RANGE` dicen la regla real. Verificado en §5.1 (paso 3) y §5.2 (badge) | engine test (referenceToday) · 5c · inspector test |
| TL-R2 test 7 vs línea (a) | Test 7 reescrito (`live-timeline-contract.test.mts:382`): exactamente una vía; ver §6 (a) | 7 |
| TL-R3 guests.read en payroll_hr / asset_manager / admin | Fuera del worktree: §6 (i) ampliado (`guests.read` o (l)). En el worktree: 403 de `GET /guests/:id` → `HIDDEN_GUEST_LABEL` «Huésped no visible» (engine:273, `LiveTimeline.tsx:423`) + callout «Nombres de huésped no visibles» (`:864`) | 5d · engine test (guestLabel) |

### Bajos

| Id | Corrección | Test |
|---|---|---|
| UXC-05 / TL-R6 alturas supuestas ≠ medidas | `.tl-row { height: var(--tl-row-h) }` y `.tl-row--group { height: var(--tl-group-h) }` fijas, `.tl-lead { overflow: hidden }`, el badge «Bloqueada» en la misma línea que el tipo; el carril se estira con la pista | presentation test |
| UXC-06 / TL-R7 ARIA de la parrilla | `aria-rowindex` en cabecera (1), «Libres» (2) y filas (`TimelineRow.tsx:76`); el botón Desplegar/Plegar pierde el `aria-controls` a sí mismo y su `aria-label` nombra el tipo; `barAriaLabel` (`TimelineBar.tsx:42`) añade habitación y fechas (visto en §5.2) | presentation test · grid test |
| UXC-07 borrador / salida / no-show indistinguibles | no-show → tono `warning` + borde punteado + título tachado; salida → `opacity .6`; borrador → discontinuo; leyenda `LEGEND_VARIANT` con pareja tono/variante única por estado | presentation test (leyenda) · engine test (tonos) |
| UXC-08 sin autoscroll vertical; fantasma desaparece | `useTimelineDrag.ts:139` `scrollTop += deltaY`; `pinRow` (engine:606) mantiene la fila origen en la ventana virtual | engine test (pinRow) · grid test |
| UXC-09 copy | Sin `title` con ids técnicos; aria-labels «Periodo anterior / siguiente»; eyebrow «Hoy»; «Folio y facturación» abre `FolioDetail` del folio de la reserva y solo si existe (`LiveTimeline.tsx:607`) | presentation · inspector · 5a |
| UXC-10 sin estado «sin resultados» | Callout `role="status"` «Sin reservas que coincidan» (con Limpiar filtros) o «Sin reservas en este periodo» (con Ir a hoy) sobre la parrilla (`LiveTimeline.tsx:892`) | 5f |
| UXC-11 403 por duplicado | Solo el `CocoaCallout` (sin `CocoaState degraded`), «Actualizar» `disabled={forbidden}` (`:781`) y comandos vacíos (visto en §5.2 con rrhh) | 5d |
| UXC-12 triple feedback | Una voz por resultado: deshacible → barra de deshacer (`role=status`); el resto → toast; la live region solo anuncia la selección (`:973`) (visto en §5.2) | 5g |
| TLF-05 soltar fuera de toda fila proponía fechas | `useTimelineDrag.ts:170`: en `move` con `targetRoomId === null` → `onCancel()` | grid test (hook) |
| TLF-06 falsos solapes | `roomOverlapCount` (engine:904) solo estados vivos y todos los pares | engine test |
| TLF-07 roomsCount ignorado | `roomUnits` (engine:942) en `bookedByType` → disponibilidad y overbooking descuentan unidades | engine test (roomsCount) |
| TLF-08 deshacer traslado en casa | `undoEntryFor` añade `note` (`IN_HOUSE_UNDO_NOTE`, engine:864) que la barra muestra; al deshacer, toast «Traslado revertido. Revisa la limpieza de la habitación intermedia.» (`LiveTimeline.tsx:727`) | engine test · presentation test · 5g |
| TL-R4 línea (c) no reconocida por el inventario | §6 (c) reescrito con las dos líneas exactas | — |
| TL-R5 variante alias sin su línea | §6 (d) con las dos variantes y su línea en `App.tsx` | — |
| TL-R8 «7/14/31 días» | §2 corregido: 7/14/30 | — |
| TL-R0 verificación de puertas | Informativo; §4 repetido tras la corrección y otra vez en TL-7 | — |

## §9 Qué se ha tocado en TL-7 y qué no

- **Tocado:** este informe; `docs/design/cocoa-22-inventory.json` (regenerado, idéntico diff +48/−13). Ficheros
  temporales fuera del árbol (scratchpad): `probe-timeline.mts`, `inspect-data.mts`, `inspect-window.mts`,
  `stability.mts`, `room205.mts`, `check166.mts`, `api-3906.log`, `vite-5176.log`.
- **Creado y borrado dentro del worktree:** `apps/admin-web/tl-harness.html` y `apps/admin-web/src/tl-harness.tsx`
  (arnés de §5.2). No forman parte de la tanda ni del commit.
- **Escrituras en la base de datos (todas revertidas y verificadas por `GET`):** RES-00254 (assign-room 425 → 007 → 425;
  PATCH salida 22 → 23 → 22 sept) y RES-00166 (PATCH 18–20 → 25–27 → 18–20 → 25–27 → 18–20 sept, hab. 205). Estado
  final: ambas `confirmed`, en su habitación y fechas originales, `totalAmount` sin cambios. Las sesiones de login
  quedan en el audit trail (`AUTH_LOGIN`), como en la Tanda 8a.
- **No tocado a propósito:** `pnpm-lock.yaml`, `packages/shared`, `packages/ui`, `App.tsx`, `routes/`, `Sidebar`,
  `ReservasTabs.tsx`, `LiveTimelineWorkspace.tsx`, `server.ts`, `schema.prisma`, el árbol de navegación; el API de
  :3000 y el front de :5173 del árbol principal; ninguna dependencia nueva; ningún `git add/commit/stash/checkout`.
