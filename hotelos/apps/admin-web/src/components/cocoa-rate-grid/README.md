# Cocoa Rate Grid v2 · `components/cocoa-rate-grid`

Editor de tarifas estilo hoja de cálculo (nivel revenue management) para
ehotelOS. Este directorio contiene **solo componentes y lógica pura**; la
pantalla que los orquesta (`screens/revenue/RateGridEditorScreen.tsx`) es del
lote *front-screen* y se cablea contra el **contrato de props** de `types.ts`.

Contrato wire: `packages/shared/src/rate-manager-types.ts` (`RateGridResponse`,
`RateGridCell`, `RateGridCellPatch`, `RateGridBulkOp`, journal, sync,
recomendaciones). Aquí no se redefine nada de eso.

## Mapa de ficheros

| Fichero | Qué es |
| --- | --- |
| `types.ts` | **Contrato de props** (CellKey, DraftState, Selection, props de cada componente). Aditivo: los campos nuevos son opcionales. |
| `helpers.ts` | Puro. `cellKey()/parseCellKey()`, fechas, dinero es-ES (`formatMoney`: «132 €», «132,50 €», «sin tarifa»), chips de restricción, derivación, estado de sync, `resolveViewCell` (celda persistida + parche del borrador). |
| `expressions.ts` | Puro. Parser/evaluador de «132», «+10 %», «−5 €», «=BAR−10 %». |
| `rate-grid-utils.ts` | Puro. Filas jerárquicas (`buildRows`), geometría (relleno/pegado), `expandBulkOp` (expansión local de una op masiva para la preview: ámbito × días × tipos × planes, derivados re-materializados, overrides manuales), diff del borrador y agrupación por tipo › plan › rango consecutivo, conteo por canal. |
| `draft-store.ts` | Puro. Reducer con pila undo/redo (operaciones `cell`, `quick`, `bulk`, `recommendation`, `discardCells`, `clear`, `restore`), poda de no-ops, serialización a localStorage por propiedad+usuario. |
| `useRateGridDraft.ts` | Hook React: reducer + autosave (400 ms) + banner de restauración. |
| `CocoaRateGrid.tsx` | El grid: ventana virtual propia (filas × columnas, sin dependencias), selección, teclado completo, edición inline con expresiones, handle de relleno, portapapeles, conversión de derivados. |
| `CocoaRateGridRows.tsx` · `CocoaRateGridCell.tsx` | Fila y celda memoizadas (`React.memo`, props primitivas/estables). |
| `RateGridHeader.tsx` · `RateGridDemandStrip.tsx` | Cabecera sticky de fechas (hoy, fin de semana, eventos, clic = columna) y capa de demanda. |
| `QuickEditPopover.tsx` | Edición rápida de una selección (precio con expresiones + chips tri-estado). |
| `BulkEditSheet.tsx` | Hoja lateral 420 px de edición masiva → `BulkEditSubmission` (ops del contrato + parches previsualizados). |
| `ReviewPublishDrawer.tsx` | Diff agrupado, canales con conteo y modo, progreso por canal (`publishState`); con borrador vacío y `pendingPush` pasa a modo «Enviar a canales» (`onPushPending` → POST /rate-grid/push). Sin «programar»: el API no tiene `scheduleAt`. |
| `SyncStatusPanel.tsx` | Matriz celda × canal, «Solo errores», reintentar, ver en historial, «Enviar pendientes» (celdas guardadas sin enviar). |
| `HistoryDrawer.tsx` | `HistoryList` (journal con diff por celda, revertir, cargar más; estados con `CocoaBadge`) y `HistoryDrawer`, que lo monta en el panel lateral del editor. La pestaña «Historial» (`RateJournalScreen`) pinta la misma lista dentro de una `CocoaSection`. |
| `RecommendationPopover.tsx` | Titular + factores con peso + señales ausentes; Aceptar / Aceptar con ajuste / Rechazar (motivo). |
| `RateGridStatusBar.tsx` | Sobre `CocoaActionBar` (Cocoa 22 · ola 5): estado «12 cambios sin guardar · 3 tipos · 2 planes» (aria-live), Deshacer/Rehacer, Descartar (`CocoaDialog` si > 20), «Guardar sin enviar a canales», «Revisar y publicar» / «Enviar a canales» (celdas guardadas sin enviar; Ctrl/⌘+Enter), banner de restauración como `CocoaCallout`. Sticky abajo (fija con safe-area en teléfono, solo las dos acciones); publica `--hotelos-toast-offset` con `publishToastOffset`. |
| `shared-ui.tsx` | Panel lateral con focus-trap + Esc (cierre con `CocoaButton` de icono), popover fijo, chips tri-estado, selector L-D, pestañas. |
| `rate-grid.css` | Estilos solo con tokens Cocoa (claro/oscuro heredado de `:root`; las recomendaciones usan el tono `--cocoa-tone-ai`, sin segundo acento ni colores literales). Prefijo `crg`. |
| `index.ts` | Barrel: exporta todo. |

## Claves de celda

`${ratePlanId}|${roomTypeId}|${date}` para celdas base;
`${ratePlanId}|${roomTypeId}|${date}|${channelId}` para overrides por canal
(vista *channels*). La fila «Disponibles» usa el centinela
`AVAILABILITY_PLAN_ID = "*"` como `ratePlanId`: la pantalla traduce esos
parches a `RateGridCellPatch.available` del tipo de habitación (el backend
ignora `ratePlanId` para `available`, o mapea `*` a su centinela).

## Flujo de edición

1. El grid emite `onCellEdit(patch)` por celda (inline, Supr, pegado, relleno,
   convertir/volver a derivado). La pantalla hace `dispatch({ type: "cell",
   patch, before: snapshotBefore(cell) })` y, si el plan tiene hijos derivados,
   añade `derivedChildPatches()` en `extra` para materializarlos en el borrador.
2. Selección ≥ 2 celdas al soltar o Ctrl/Cmd+Enter → `onOpenQuickEdit(selection,
   anchorRect)`. La pantalla renderiza `QuickEditPopover`; el resultado trae la
   expresión cruda (`evaluateInput` por celda, porque «+10 %» depende del precio
   actual de cada una) y un `RateRestrictionsPatch` tri-estado.
3. Ctrl/Cmd+B o «Más opciones…» → `onOpenBulkEdit(prefill)`; `BulkEditSheet`
   devuelve `ops` (una por rango de fechas) + `patches` de preview → `dispatch({
   type: "bulk", op, reason, patches })`.
4. `RateGridStatusBar` → «Revisar y publicar» → `ReviewPublishDrawer` →
   `onPublish({ channelIds })`. La pantalla manda
   `RateGridBulkUpdateRequest { cells: draftToCellPatches(draft), ops,
   reason, publish }` y pinta `publishState`. «Guardar sin enviar a canales»
   escribe `rate_days` de verdad (el PMS vende el precio nuevo al momento) y
   deja un `PendingPush` (rango guardado, persistido por propiedad+usuario) que
   la barra, el panel de sync y el drawer ofrecen enviar con
   `POST /rate-grid/push`. Una reversión del historial hace lo mismo con
   `source: "revert"` y marca sus celdas como «pendiente de reenvío» en la
   capa de envío (el API no toca los canales al revertir).
5. Los estados de sync llegan en `cell.sync` (por canal); el grid pinta el punto
   por celda; `SyncStatusPanel` recibe la matriz de `GET …/rate-grid/sync-status`.
6. Vistas: «Restricciones» atenúa el precio y lista cada restricción (o «—»);
   «Canales» rechaza la edición inline del precio en filas de canal
   (`onEditRefused`, base × recargo) y solo admite restricciones vía edición
   rápida/masiva; la capa «Recomendaciones» muestra «= mantener» en las celdas
   en *hold* (abre el popover con los factores) y la pantalla explica el estado
   vacío cuando nada es accionable.

## Teclado

Flechas (± Mayús) · Inicio/Fin · AvPág/RePág · Enter/F2 editar · Enter confirma y
baja · Tab confirma y avanza · Esc · Supr (quita el cambio del borrador; en
derivados con override → `revertToDerived`) · Ctrl/Cmd+Z / Mayús+Z ·
Ctrl/Cmd+C/V (patrón relativo) · Ctrl/Cmd+D rellenar a la derecha ·
Ctrl/Cmd+Mayús+D hacia abajo · Ctrl/Cmd+A · Ctrl/Cmd+B masiva · Ctrl/Cmd+Enter
edición rápida · teclear un dígito, «+», «−» o «=» empieza a editar.

## Rendimiento

Ventana virtual propia sobre la posición de scroll (overscan 4 filas / 4
columnas), filas y celdas memoizadas. Benchmark en
`__tests__/render-bench.test.mts`: 36 500 celdas (100 filas de plan × 365 días)
→ ~380 gridcells montadas, ~60 ms en `renderToString`.

## Tests

```bash
cd apps/api && TSX_TSCONFIG_PATH=../admin-web/tsconfig.json \
  node --import tsx --test "../admin-web/src/components/cocoa-rate-grid/__tests__/*.test.mts"
```

(Se lanza desde `apps/api` porque `tsx` no está en el `node_modules` de
admin-web; `TSX_TSCONFIG_PATH` hace que el JSX del benchmark use `react-jsx`.
Los cuatro suites puros no lo necesitan.)

## Accesibilidad

`role=grid` con `aria-label="Tarifas de <propiedad>"`, `aria-rowcount/colcount`,
`aria-rowindex/colindex`, `aria-selected`, roving tabindex, celda con
`aria-label` (tipo + plan + fecha + precio + restricciones + estado). Los
estados de sync llevan icono + texto además de color. Foco visible.

## Cierre 2026-09-15 (concurrencia, stale, revert forzado)

- `CellBeforeSnapshot.lastModifiedAt` + `expectedFromSnapshot()` (helpers): cada parche de celda base sale con `expected { price, lastModifiedAt }`; un 409/200 «la celda cambió desde que se cargó» entra en el flujo de conflictos y el borrador se **re-basa** sobre los valores recargados (`draftReducer` acción `rebase`).
- `CellSyncStatus` «stale» → «Pendiente de reenvío» (`SYNC_STATUS_META`, leyenda del `SyncStatusPanel`, `.crg__sync--stale`); el editor mantiene un overlay de sesión tras un revert mientras el API no lo devuelva.
- `RateGridResponse.degraded: ["sync"]` → `CocoaRateGrid.syncUnavailable`, `RateGridStatusBar.syncUnavailable`, `SyncStatusPanel.degraded` («Estado de sincronización no disponible»).
- `JournalStaleDialog` (409 `JOURNAL_STALE` del revert): lista `details.cells` y reenvía `{ force: true }` (`useRateJournal.forceRevert`).
- `journalStatusLabel` conoce `queued` / `superseded`; `journalFieldLabel` / `journalValueLabel` etiquetan «Origen» y «Precio derivado (automático)».
- `rateGridErrorMessage` (helpers) da el texto en español de NO_CELLS, TOO_MANY_CELLS, INACTIVE_RATE_PLANS, DERIVATION_CHAIN, DERIVATION_YIELDS_ZERO, UNKNOWN_IDS, RATE_GRID_BUSY, JOURNAL_STALE, CHANNEL_HAS_PENDING_DELIVERIES (`classifyRateGridError` lo consume).

## Corrección final 2026-09-15 (verificación en navegador)

- Mapeos por producto: `channelMappings` llega con los mapeos **reales** (activos) de cada canal (`GET /channel-manager/channels/:id/product-mappings`, cargados por la pantalla), ya no se infieren de las claves de `cell.sync`. `isChannelMappedForProduct` (rate-grid-utils) trata la lista como autoritativa SOLO para los canales que cubre; un canal ausente cae a `cell.sync` y después a `mappedProducts > 0`. Antes, tras publicar una celda IND, el drawer ofrecía «0 canales» para cualquier otro tipo de la ventana.
- `RateGridPopover` recoloca el popover cuando cambia su tamaño (`ResizeObserver` + `placePopover` en helpers: debajo → encima → recortado al viewport) y `.crg-pop` tiene `max-height` con scroll: el botón «Rechazar recomendación» ya no queda fuera de pantalla a 1280×800.
- `recommendationChoices` (helpers): con `hold` / `no_data` no hay «Aceptar» (el motor no propone precio; aplicar su `suggestedPrice` bajaba la celda un 5 %), solo «Fijar otro precio» (desde el precio ACTUAL) y «Rechazar»; la pantalla ignora `suggestedPrice` en un `accept` sin valor para esas acciones.
- `useRateJournal` recarga la primera página en cada apertura del drawer y la pantalla llama a `refresh()` tras cada guardado/publicación/envío y desde «Recargar»: el historial muestra los asientos nuevos sin F5.
- Recuentos: «entregas» solo para lo que el API encola (por tipo y canal, `queuedDeliveriesSummary`); lo que devuelve sync-status son **celdas del rango visible** (la ruta no filtra por journal) y así se etiqueta; `pluralize` en todos los resúmenes.
- `resolveReviewDrawerMode` (rate-grid-utils): con un envío en curso el drawer conserva el flujo que lo lanzó (título, subtítulo, aviso «Cambio revertido…»), aunque el borrador se vacíe y exista un `pendingPush` anterior.
- `RateGridStatusBar` publica `--hotelos-toast-offset` y `Toast.tsx` lo lee: la barra de dos filas ya no queda bajo el toast (desde Cocoa 22 · ola 5 lo hace `CocoaActionBar publishToastOffset`; el helper `toastOffsetForBar` y su test se retiraron en la ola 11 al quedarse sin consumidor, R31).
- Etiquetas: `CHANNEL_MODE_LABELS` (select del hub) usa el mismo vocabulario que `channelModeLabel`; `providerLabel` / `channelTypeLabel` para las tarjetas y tablas legacy del Channel Manager; `lib/channel-hash.ts` (`withChannelHash`) mantiene `#channel=` al cambiar de canal en Mapeos.
