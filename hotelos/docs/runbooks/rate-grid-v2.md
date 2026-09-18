# Runbook · Rate Grid v2 (parrilla de tarifas + outbox de canales)

Estado: operativo en demo (`prop_123`) y en el piloto Faranda Los Tilos
(`cmu1mifcp0000fyo1wzvq7txo`) desde 2026-09-14/15. Este documento es la
referencia operativa: arquitectura, procedimiento de alta de canal, comandos y
límites conocidos. La spec de producto (UX: grid, drawer, journal, mobile)
sigue en `docs/rate-manager/DESIGN-PROPOSAL.md`; su sección «Endpoints
backend» y el roadmap de fases (`GET /rate-grid?propertyId=`, `etag`,
`GET /rate-grid/journal`, `POST /rate-grid/schedule`, `ScheduledRateChange`)
están OBSOLETOS: las rutas reales son las de §1.2 (bajo
`/properties/:propertyId/…`, journal en `/rate-journal`, sin `schedule` ni
`etag`; `ScheduledRateChange` no existe en `schema.prisma`).

Cierre de la verificación adversarial (2026-09-15): todo lo que describe este
runbook está en el working tree (verificado por lectura de código en el
cierre; lo vigila `tests/rate-grid-docs-contract.test.mjs`: tabla §2.1 ↔
partials de permisos, límites §4 ↔ constantes, reglas del outbox ↔
`delivery.core`/`drain.*`, contrato compartido ↔ §1.1). Lo marcado
«confirmado por las puertas del integrador (2026-09-15)» pasó typecheck-all +
`corepack pnpm test` + unitarios del API + `corepack pnpm test:integration`
el 2026-09-15. Puesta en vigor el mismo día: el integrador humano reinició
los API :3000/:3400 con este código, repitió `test:integration` (80/80) y
contrastó en vivo que publicar 1 celda encola 1 entrega `rates` por canal,
que `sync-status` devuelve `stale` tras revertir y que `recommendations/apply`
acepta `currentPrice`/`suggestedPrice`. Lo marcado «verificado en navegador
(2026-09-15)» se ejercitó en :5173 como Carmen sobre Los Tilos (ventana
2027-08-01..14, 1280×800, parrilla restaurada a baseline) y lo marcado
«confirmado en vivo el 15/09/2026 (:3000/:3400 reiniciados)» se probó con
`curl`/`psql` contra los API reiniciados (Carmen y el admin de plataforma;
Los Tilos 2027-09-01..07 y `prop_123`, datos restaurados). Los hallazgos de
ese recorrido (BUX-01..14) y de la sonda del API (ALF-1..5) se corrigieron
el mismo día en cuatro lotes (`fix:admin-web`, `fix:api-channel-manager`,
`fix:api-rate-manager`, `fix:docs`) y los API se reiniciaron otra vez
después, así que :3000/:3400 sirven el working tree completo; lo que esos
lotes cambiaron en pantalla se vio en un recorrido final en navegador tras
el segundo reinicio (15/09/2026, Carmen, Los Tilos 2027-08-15..31, 1280×800,
parrilla restaurada con diff vacío) y va marcado «corregido el 2026-09-15
(lote …); verificado en navegador el 15/09/2026» (lista al final de §2.2 y
en el informe de cierre §6.5; la forma «verificado en navegador
(2026-09-15)» es el primer recorrido, 1–14 ago, y «verificado en navegador
el 15/09/2026» el recorrido final, 15–31 ago); lo que ese recorrido no pudo
cubrir conserva «pendiente de verificar en navegador (motivo: …)». El
contrato acordado entre lotes está en §6 y el informe de cierre para
dirección en `docs/audits/RATE-GRID-V2-CIERRE-2026-09-15.md`.

## 1. Arquitectura

### 1.1 Contrato

`packages/shared/src/rate-manager-types.ts` es el contrato de cable entre el API
y el editor (`apps/admin-web`, `cocoa-rate-grid`). Se programa tal cual: los
servicios reciben y devuelven esos tipos (`RateGridResponse`,
`RateGridBulkUpdateRequest/Response`, `RateGridPushRequest/Response`,
`RateGridSyncStatusResponse`, `RateChangeJournal*`, `RateRecommendationsResponse`).
Los bodies se validan con zod en `apps/api/src/modules/rate-manager/rate-grid.schemas.ts`
(400 `VALIDATION_ERROR` con `details.issues`).

Añadidos del cierre 2026-09-15 (todos compatibles hacia atrás):

- `RateGridCellPatch.expected?: { price?: number | null; lastModifiedAt?: string | null }`:
  lo que el editor veía al cargar la celda; un desajuste es el conflicto «la
  celda cambió desde que se cargó» (§1.3).
- `RateGridResponse.degraded?: string[]`: `["sync"]` cuando el mapa de
  sincronización no pudo leerse (la parrilla responde igual, las celdas salen
  `never`, el fallo se loguea con propiedad y ventana y el front debe decir
  «estado de sincronización no disponible»).
- `RateJournalRevertRequest { force?: boolean; reason?: string }`: cuerpo del
  revert; `force: true` salta el 409 `JOURNAL_STALE` (§1.3).
- `CellSyncStatus` añade `"stale"`: la última entrega confirmada de la celda
  ya no coincide con el valor actual de la parrilla (reversión o edición
  guardada sin publicar; `delivery.service.ts` recalcula el payload actual de
  cada celda entregada y compara hashes, sin contar los códigos de mapeo); el
  editor lo etiqueta «Pendiente de reenvío».
- `RateChangeJournalEntry.pushStatus` (`RateJournalPushStatus`) es
  `draft | queued | pushed | partial | failed | superseded` (ciclo en §1.6).
- Códigos `details.code` que el front debe conocer — 400: `VALIDATION_ERROR`,
  `NO_CELLS`, `TOO_MANY_CELLS`, `INACTIVE_RATE_PLANS`, `DERIVATION_CHAIN`,
  `DERIVATION_YIELDS_ZERO`, `UNKNOWN_IDS`; 409: `ALL_CELLS_CONFLICT`,
  `JOURNAL_STALE`, `RATE_GRID_BUSY` («reintenta en unos segundos»),
  `CHANNEL_HAS_PENDING_DELIVERIES`, `DELIVERY_NOT_RETRYABLE`; 413
  `Payload Too Large` en el webhook (`server.ts#errorLabels`).

### 1.2 Backend canónico (`apps/api/src/modules/rate-manager`)

| Ruta | Servicio | Notas |
| --- | --- | --- |
| `GET /properties/:id/rate-grid?from&to&ratePlanIds&roomTypeIds&channelId&demand=1` | `rate-grid.service.ts#getRateGrid` | Una celda por (plan, tipo, día). `basePrice` = `RateDay.price`; `effectivePrice` = base × (1 + markup del canal) cuando se pide `channelId`. Sin fila → `null`, nunca 0. `demand=1` añade OTB/forecast/STLY/pickup/compset/eventos. Puede traer `degraded: ["sync"]` (§1.1). La lista de canales de la parrilla (`GET /properties/:id/channels`) es `channel-manager/channels.service#listRateGridChannels`: una sola readiness (modo efectivo por `CHANNEL_MAX_MODE`), orden por `createdAt`, sin canales `archived`; markup = `defaultMarkupPercent ?? 0`, sin fallback a `commissionPercent` (misma fórmula que el outbox). |
| `POST /properties/:id/rate-grid/bulk-update` | `rate-grid.service.ts#bulkUpdateRateGrid` → `rate-grid.engine.ts` | UNA transacción: parches + rematerialización de derivados + journal (advisory lock por propiedad, §1.3). `cells[].expected` → conflicto optimista. `publish` opcional encola al outbox acotado a los tipos, planes (incluidos los hijos derivados rematerializados) y `kinds` que tocan los parches (`derivePushScope`: precio → `rates`, `available` → `availability`, restricciones → `restrictions`; un `publish.kinds` explícito manda), no a toda la ventana × catálogo; si ningún parche afecta a tarifas, disponibilidad o restricciones no se encola nada y se avisa. |
| `POST /properties/:id/rate-grid/push` | `pushRateGrid` | Encola sin escribir tarifas (permiso `distribution.sync`); `ratePlanIds`/`roomTypeIds`/`kinds` acotan el encolado; ids ajenos → 400 `UNKNOWN_IDS`. |
| `GET /properties/:id/rate-grid/sync-status?from&to&channelIds` | `getRateGridSyncStatus` | Estado por celda y canal desde `ChannelDelivery` (sin `superseded`); `channelIds` ajenos → 400 `UNKNOWN_IDS`. |
| `GET /properties/:id/rate-journal[/:journalId]` · `POST …/:journalId/revert` | `journal.service.ts` | Historial con before/after por campo (un item por celda y campo, §1.3); el revert es una entrada nueva (`published`) y marca la original `reverted` (409 si ya lo estaba). Cuerpo `RateJournalRevertRequest`: si un asiento posterior cambió alguna celda → 409 `JOURNAL_STALE` con `details.cells[]`, `{ force: true }` lo fuerza. Cursor inválido → 400. |
| `POST /properties/:id/rate-plans/:planId/rederive?from&to` | `rederiveRatePlan` | Rematerializa un plan derivado desde su padre (celdas manuales respetadas). |
| `GET/POST …/rate-grid/recommendations[/apply]`, `GET/PUT …/recommendations/config` | `modules/revenue/recommendations.routes.ts` + `rate-recommendation.service.ts` | RMS por día × tipo. `apply` NUNCA escribe `rate_days`: persiste `RevenueRecommendation` y devuelve `patches` que el front manda a `bulk-update`. Admite dos cuerpos (excluyentes): **ventana** `{ from, to, ratePlanId, roomTypeIds?, dates?, minConfidence? }` (acepta las recomendaciones del motor; `hold`/`no_data`/baja confianza → `skipped[]`) o **`cells[]`** `{ roomTypeId, date, action: accept \| adjust \| reject, suggestedPrice?, appliedPrice?, reason? }` con decisión por celda (`accept` → precio sugerido del motor o `suggestedPrice`; `adjust` → `appliedPrice` obligatorio; `reject` → `RevenueRecommendation` `rejected` sin parche; `minConfidence` no se aplica a celdas explícitas). Opcionales: `journalId` (debe ser de la propiedad → si no, 400; se guarda en `reasonJson.journalId`), `includeRestrictions` (añade `minLos`/`cta` sugeridos a los parches), `reason`. Respuesta: `applied`, `rejected`, `recorded`, `skipped[]`, `patches[]`, `reason`, `recommendationIds[]`. Ventana ≤ 120 días y `to` nunca en el pasado (400). `roomTypeIds` (o el `roomTypeId` de `cells`) ajenos o inactivos → 400 `UNKNOWN_IDS` con `details.roomTypeIds` (mismo contrato que `GET /rate-grid` y `bulk-update`); `ratePlanId` distinto del BAR → 404; en el formato por celdas el motivo `skipped` es «tipo sin inventario vendible o fecha anterior a hoy». Cada celda admite además `currentPrice?` (precio base que veía el cliente al decidir → se persiste en `currentValueJson.price` en lugar del recálculo) y `suggestedPrice?` (el que se mostró → `recommendedValueJson.shownPrice` además del recálculo), ambos 0..50.000; el editor llama a `apply` DESPUÉS de un `bulk-update` con éxito (`sendRecommendationTrace`), pasando `journalId`, `currentPrice` (el `before` del borrador) y `suggestedPrice`, así no quedan filas `applied` huérfanas si el `bulk-update` falla. |

Permisos: `rate-manager/route-permissions.partial.ts`,
`revenue/route-permissions.partial.ts`, `channel-manager/route-permissions.partial.ts`
(el contract test `tests/api-route-permissions-contract.test.mjs` lee
`*.routes.ts` + `route-permissions.partial.ts` de cada módulo); la tabla
«ruta · permiso · riesgo» completa está en §2.1. Variables de entorno del
módulo de canales: `channel-manager/env.partial.ts` (`CHANNEL_MAX_MODE`,
`CHANNEX_BASE_URL`, `CHANNEL_DRAIN_INTERVAL_MS`, `CHANNEL_DRAIN_DISABLED`,
`CHANNEL_DRAIN_BATCH_LIMIT`) más, en la sección OTA de `lib/env.ts`,
`BOOKING_API_BASE_URL`, `BOOKING_OAUTH_URL` (token exchange JWT) y
`EXPEDIA_API_BASE_URL`, que leen `booking.adapter.ts`, `booking/auth.ts` y
`expedia.adapter.ts`. Las variables v1 (`BOOKING_ADAPTER_MODE`,
`BOOKING_SANDBOX_URL`, `EXPEDIA_ADAPTER_MODE`, `AIRBNB_*`…) están retiradas
del contrato, no marcadas `deprecated` (ver `docs/booking-adapter.md`).

### 1.3 Reglas de `bulk-update` (api-polish + cierre, 2026-09-15)

- `ops` se expanden (`bulk-ops.ts`, puro) y se aplican ANTES que `cells`: una
  celda editada a mano tras una operación masiva gana sobre la op en esa celda.
  El `scope` de una op cubre como máximo 366 días; `ops` expandidas + `cells`
  > 5.000 parches → 400 `TOO_MANY_CELLS` (`assertPatchBudget`); si todo expande
  a 0 parches (ids ajenos, sin días, sin payload, `copyFrom` sin origen) → 400
  `NO_CELLS` con `warnings`/`skipped` y sin asiento. Con ≥ 1 parche válido los
  ids desconocidos del `scope` siguen siendo `warnings` (contrato).
- Una transacción por propiedad: el motor toma
  `pg_advisory_xact_lock(hashtext('rate-grid:<propertyId>'))` con
  `SET LOCAL lock_timeout = '30s'`; dos escrituras concurrentes se serializan
  (el segundo asiento registra el `before` real) y si el lock no llega en 30 s
  → 409 `RATE_GRID_BUSY` («reintenta en unos segundos»), nunca un 500.
- Idempotencia: `clientRequestId` repetido devuelve la respuesta guardada en
  el journal sin volver a escribir celdas ni journal (`executeRateGridWrite`);
  el lock precede al `findFirst`, así que dos reintentos en paralelo devuelven
  el MISMO `journalId` y un solo asiento. Cinturón y tirantes:
  `@@unique([propertyId, clientRequestId])` en `RateChangeJournal` (migración
  `20260915100000_rate_grid_v2_journal_unique`, aplicada en la BD local con
  drift 0 tras deduplicar el par `prop_123` / `csc-refute-9-1789426774979`
  que dejó la auditoría; en el VPS hay que deduplicar antes de `migrate
  deploy`). Un `clientRequestId` repetido con un cuerpo DISTINTO devuelve
  en silencio la respuesta almacenada (decisión documentada: el editor genera
  un uuid nuevo por guardado; un 409 por hash del cuerpo sería un
  endurecimiento opcional). Un replay con `publish` NO
  vuelve a encolar: el motor marca la respuesta almacenada como `replayed`
  (nunca viaja en el cable) y el servicio añade el aviso «petición repetida
  (clientRequestId ya procesado): los cambios y su publicación no se han
  vuelto a aplicar» (confirmado en vivo el 15/09/2026 (:3000/:3400
  reiniciados): repetición idéntica → mismo `journalId`, sin `queued`, un
  solo asiento; dos POST concurrentes con un id nuevo → mismo `journalId`).
  Deuda ALF-1 (media): la repetición SIN `publish` devuelve la respuesta
  almacenada sin ese aviso.
- Concurrencia optimista: `cells[].expected { price, lastModifiedAt }` se
  compara ANTES de escribir contra el estado inicial de la transacción (así
  la rematerialización de un padre no hace «stale» a su hijo); un desajuste
  salta el parche como conflicto «la celda cambió desde que se cargó: precio
  actual 92,00 € (esperado 91,46 €); última modificación actual 15/09/2026
  07:43:40 (esperado 14/09/2026 21:59:29)» (`journal.core.ts#staleReason`:
  etiquetas en español por campo, importes es-ES con la moneda de la
  propiedad, fechas `Europe/Madrid` —con milisegundos si dos sellos caen en
  el mismo segundo—, «sin tarifa»/«sin valor» para nulos; corregido el
  2026-09-15 (lote `fix:api-rate-manager`, BUX-08) con unitarios en
  `journal-core.test.mts`; el prefijo «la celda cambió desde que se cargó»
  se conserva porque lo afirma `rate-grid-v2.test.mts` y lo cita el editor;
  `conflicts[].date` sigue en ISO en el cable y el editor la formatea en
  largo con `formatDateLong`; verificado en navegador el 15/09/2026 con un
  `bulk-update` por `curl` bajo un borrador abierto: «BAR · Doble Estándar
  matrimonio · 20 de agosto de 2027: la celda cambió desde que se cargó:
  precio actual 126,00 € (esperado 125,14 €); última modificación actual
  15/09/2026 09:18:32 (esperado 14/09/2026 21:59:29)»). El editor envía en
  cada celda el precio y el `lastModifiedAt` que cargó (el borrador guarda
  `before`).
- Conflictos: si TODOS los parches entran en conflicto (nada escrito, ningún
  item de journal) → **409** `details.code = "ALL_CELLS_CONFLICT"` con
  `details.conflicts[]` y rollback (sin entrada de journal). Conflictos
  parciales → **200** con `conflicts[]`.
- Journal: los items se fusionan por (plan, tipo, fecha, canal, campo)
  (`journal.core.ts#coalesceJournalItems`): `before` del primer cambio, `after`
  del último, y se descarta el item si `before == after`; `changesCount`
  cuenta campos reales. `source` se journaliza en toda transición (también
  `import → null` al borrar). Un asiento con parches pero 0 cambios reales
  (guardar el mismo precio) sigue creándose con `changesCount 0`, igual que
  `rederive`.
- Revert (`POST …/rate-journal/:journalId/revert`, body
  `RateJournalRevertRequest`): rellena `expected` con el `after` del asiento;
  si un asiento posterior cambió alguna celda → 409 `{ code: "JOURNAL_STALE",
  cells: [{ ratePlanId, roomTypeId, date, channelId, fields: [{ field,
  expected, actual }] }] }` (≤ 200 celdas) sin escribir nada; `{ force: true }`
  revierte igual pisando lo posterior. El revert toma primer `before` /
  último `after` por (celda, campo) (asientos antiguos con items duplicados,
  orden por `id`), restaura la procedencia `import`/`rms` (`restoreSource`),
  puede escribir celdas de un plan desactivado después de la escritura
  (`allowInactivePlan`) y usa `conflictIfAllFail` (409 si nada se aplica; la
  original sigue revertible). El revert NO toca canales: la celda queda
  «pendiente de reenvío» hasta que el editor la envíe con el `journalId` de
  la reversión (§2.2). Su `reason` es «Reversión: <motivo original>[ — <texto
  del cliente>]» (sin id) y el asiento inverso expone `revertsJournalId`
  (guardado en `changesJson.revertsJournalId`, sin columna nueva; los asientos
  anteriores al cierre «Reversión de <id> (…)» se enlazan parseando la
  redacción).
- Planes: un plan derivado es de solo lectura: precio directo → conflicto
  (usa `convertToManual`); `revertToDerived` recalcula desde el padre;
  `revertToDerived`/`convertToManual` sobre un plan BASE → conflicto «no es un
  plan derivado» (409 `ALL_CELLS_CONFLICT` si es el único parche, sin
  asiento) y `manuallyOverridden` ya no cambia por sí solo en planes base
  (solo significa algo en hijos derivados). Ids de planes INACTIVOS de la
  propiedad en `cells` → 400 `INACTIVE_RATE_PLANS` («reactívalos…»), distinto
  de `UNKNOWN_IDS`; el revert es la excepción. En `ops` (`bulk-ops.ts`,
  corregido el 2026-09-15, lote `fix:api-rate-manager`, ALF-2) un plan
  inactivo en `scope.ratePlanIds` produce el aviso «op[i]: plan tarifario
  inactivo <código>: reactívalo para editar sus celdas» (distinto de
  «desconocido») y solo responde 400 `INACTIVE_RATE_PLANS` cuando TODAS las
  ops nombran planes explícitamente, todos inactivos y 0 parches; junto a
  planes activos sigue siendo aviso no fatal (decisión de contrato: los ids
  desconocidos del `scope` son avisos).
- Un parche solo de restricciones NUNCA crea `RateDay` (sin 0 € falsos);
  restricciones de un canal borrado → `warning`, no 400.
- Validación: `zodErrorMapEs` (`rate-grid.schemas.ts`) traduce los issues de
  zod («bulk-update no válido: reason: obligatorio», «clave no admitida: 'x'»,
  «debe ser menor o igual que 50000», «valor no admitido 'x'; valores
  válidos: …»); ningún mensaje lleva literales ingleses (19 sondas
  confirmadas en vivo el 15/09/2026 (:3000/:3400 reiniciados): 0 apariciones
  de Required / Invalid input / Expected). En `channel-manager`,
  `channelErrorMapEs` (envuelve `zodErrorMapEs`) traduce además `received:
  "nan"` de los parámetros coaccionados de query («se esperaba número y se
  recibió un valor no numérico», `limit=abc`) y `expected: "integer"` («debe
  ser un número entero»); en `rate-grid.schemas.ts#typeNameEs` el caso `nan`
  sigue sin traducir (ALF-4, deuda baja).

### 1.4 Derivación

`RatePlan.parentRatePlanId` + `derivationJson` (`{ mode: none|percent|amount,
value, roundTo?: 0|1|2|0.99 }`, `derivation.ts`). Al cambiar el precio del padre
el motor rematerializa los hijos (`derivedUpdated`), respetando celdas con
`manuallyOverridden` (`skippedManual`) salvo `respectManualOverrides: false`. Los
items automáticos se journalizan como `derivedPrice` y un revert no los replica:
revertir el padre vuelve a materializar.

Cierre 2026-09-15: un override manual del hijo pisado con
`respectManualOverrides: false` se journaliza como `price` + `source`
(`manual → derived`) y el revert SÍ lo restaura (vuelve `manual` con su
precio). Una derivación que produce ≤ 0 € NO se materializa: la fila derivada
existente se borra (`derivedPrice → null`; la manual se conserva) y sale en
`conflicts[]` («la derivación de X produce 0 € desde P € (regla)…»); al
configurar la regla, `percent` ≤ −100 o > 1000 → 400 de validación y
`validateDerivation` (create/update de planes) calcula el mínimo futuro del
padre → 400 `DERIVATION_YIELDS_ZERO` (`details.parentMinPrice`); un plan con
hijos activos no puede pasar a derivado → 400 `DERIVATION_CHAIN`
(`details.children`): el motor solo materializa un nivel.

### 1.5 Restricciones y centinela `"*"`

`RestrictionDay` se indexa por (tipo, plan | `"*"`, canal | `"*"`, fecha) y se
resuelve en capas (`rate-grid.merge.ts`): `("*","*")` < `(plan,"*")` <
`("*",canal)` < `(plan,canal)`. `closed` (plan no reservable) es distinto de
`stopSell` (tipo retirado de venta). El `ratePlanId: "*"` es el centinela de la
fila «Disponibles»: admite `restrictions` y `available` (escribe
`InventoryDay.availableCount`); con precio → 400.

Cierre 2026-09-15: un `stopSell` de tipo (fila `"*"`) fuerza `count = 0` en
la entrega `availability`, también cuando se publica solo
`kinds: ["availability"]` (el planificador carga las filas de restricción
para eso). `InventoryDay.stopSell` (disponibilidad enviada) y
`RestrictionDay.stopSell` (parrilla) siguen siendo dos fuentes de verdad (§5).

### 1.6 Outbox, drenaje y estados (`apps/api/src/modules/channel-manager`)

```
bulk-update/push ──► enqueueRateGridPush (delivery.service) ──► ChannelDelivery (queued)
                                                                     │
   drain cada CHANNEL_DRAIN_INTERVAL_MS (líder) / POST …/deliveries/drain
                                                                     ▼
   claimChannelDeliveries: UPDATE … FOR UPDATE SKIP LOCKED … RETURNING → sending
                                                                     ▼
   adaptador (stub/sandbox → simulador · real → HTTPS) ──► confirmed | rejected | timeout(+backoff)
```

- Una fila por (canal, kind ∈ rates|restrictions|availability, tipo, plan |
  `"*"`, fecha); `idempotencyKey = sha256(canal, kind, tipo, plan, fecha, payload)`.
  Mismo payload ya `queued/sending` → no se reencola (`skipped`); mismo
  payload con una fila anterior `rejected/timeout/superseded` → esa misma fila
  vuelve a `queued` con `attempts = 0` (`requeue`); payload distinto → la
  fila anterior `queued/timeout` pasa a `superseded`. El retry manual también
  reinicia `attempts` a 0.
- **Invariante (cierre 2026-09-15): la entrega más reciente por celda lleva
  el payload actual de la parrilla.** El planificador
  (`delivery.core.ts#planDeliveries`) sustituye SIEMPRE la fila pendiente de
  la celda con otro payload (`SUPERSEDABLE_STATUSES` = `queued/timeout`) antes
  de decidir nada; una fila `sent/confirmed` con el payload actual se
  REENCOLA si otra entrega de la celda con otro payload la adelantó
  (`sending/sent/confirmed` con `updatedAt` mayor: p. ej. volver al 97 €
  confirmado cuando un 130 € intermedio ya salió); el reencolado re-estampa
  `created_at` (= orden de plan) y el `journalId` de la publicación;
  supersede solo desde `queued/timeout`, requeue nunca desde
  `queued/sending` (`REQUEUE_FROM_STATUSES`), y lo que no se pudo tocar (fila
  ya en envío) se reporta en `warnings`, nunca se cuenta como encolado. En
  cada pasada del drenaje, `retireObsoleteDeliveries` marca `superseded` los
  reintentos vencidos y las `sending` obsoletas para las que exista una fila
  posterior de la misma celda (`retiredObsolete` en el `DrainSummary`), y
  `writeOutcomes` solo escribe sobre filas que sigan `sending` (lo demás se
  loguea).
- Encolado acotado: `roomTypeIds`/`ratePlanIds`/`kinds` limitan las
  combinaciones (publicar 1 celda no encola toda la ventana × 4 tipos);
  `bulk-update` con `publish` los deriva de los parches (`derivePushScope`) y
  el editor acota el push manual con los tipos y planes del rango guardado. La
  ventana sigue siendo `min..max` de las fechas parcheadas: dos celdas lejanas
  encolan también los días intermedios de esos productos.
- `availability`: `InventoryDay.availableCount` (0 si `stopSell`) o, sin
  fila, habitaciones vendibles − reservas solapadas. Un canal `status !=
  active` (incluido `archived`) no encola nada y devuelve un `warning`. No se
  encola una tarifa cuya moneda ≠ moneda de la propiedad ni un mapeo `obp`
  sin `occupancyPrices` (warning por producto); `extraAdult`/`extraChild` no
  se envían (warning explícito); `pricingModel: "los"` → 400 al mapear («no
  está implementado todavía»).
- Estados: `queued → sending → confirmed | rejected | timeout`; `superseded`
  cuando llega un valor más nuevo; `sent` está reservado en el contrato
  (`DeliveryStatus`, `CellSyncStatus`) y hoy no lo emite ningún adaptador ni
  el drenaje. Backoff 1 m, 5 m, 30 m, 2 h (o el `Retry-After` del proveedor
  si es mayor); el 5.º fallo es `rejected` «Reintentos agotados». Un rechazo
  del proveedor por item es final. Los avisos del proveedor viajan en
  `AdapterResult.warnings` y se guardan en
  `channel_sync_jobs.response_payload.warnings` (≤ 50).
- Drenaje multi-instancia (A4): la toma de candidatos es atómica
  (`drain.service.ts#claimChannelDeliveries`, `FOR UPDATE SKIP LOCKED`, orden
  `created_at`): dos líderes o un drenaje manual concurrente al scheduler
  toman filas disjuntas. Las filas diferidas por el limitador (token bucket
  por canal) vuelven a `queued` al final de la pasada; una fila `sending` de
  un worker caído se retoma tras `STALE_SENDING_MS` (10 min) salvo que exista
  una entrega posterior de la misma celda: entonces se retira como
  `superseded`. Los timestamps del SQL crudo (toma, retiro, `updated_at`) van
  como hora-pared UTC (`::timestamptz AT TIME ZONE 'UTC'`) para coincidir con
  el ORM aunque la sesión de Postgres esté en `Europe/Madrid` (antes el
  backoff se disparaba hasta 2 h antes).
- Retención: `CHANNEL_DELIVERY_RETENTION_DAYS` (entero 1..3650, 30 por
  defecto, `channel-manager/env.partial.ts`): la pasada de drenaje SIN ámbito
  (líder del scheduler o administrador de plataforma) borra las entregas
  `superseded` con `updated_at` anterior al corte, como máximo una vez por
  hora por proceso (`drain.service.ts#purgeSupersededDeliveries`,
  `purgedSuperseded` en el `DrainSummary`); un drenaje manual de tenant nunca
  purga y ningún otro estado se purga. `getCellSyncMap` excluye `superseded`;
  el planificador solo necesita las recientes para el reencolado.
- `journal.pushStatus` (`RateJournalPushStatus`): al encolar (`bulk-update`
  con `publish` o `push` con `journalId`) la entrada pasa a `status:
  published` y `pushStatus: queued` SOLO si se encoló o reencoló algo (si todo
  quedó `skipped` sigue `draft`: no se envió nada); después de cada pasada del
  drenaje que procese entregas suyas y cuando una publicación posterior
  sustituye sus filas se recalcula desde sus entregas
  (`delivery.service.ts#refreshJournalPushStatuses`, reglas puras en
  `delivery.core.ts#classifyJournalPushStatus`): `superseded` si todas sus
  filas fueron sustituidas; si no, `queued` mientras quede alguna
  `queued/sending/timeout`, `pushed` si todas las vivas están
  `confirmed/sent`, `failed` si todas `rejected`, `partial` en el resto. Sin
  `publish` la entrada queda `draft/draft`.
- Retry manual (`POST /channel-manager/deliveries/:id/retry`): solo
  `rejected`/`timeout`; `confirmed`/`superseded` → 409 `DELIVERY_NOT_RETRYABLE`;
  `queued` → no-op; `sending` → 400.
- Estado por celda (`sync-status`): último `rates` por celda y canal
  (`restrictions`/`availability` plegados como peor estado), sin
  `superseded`; `channelIds` ajenos → 400 `UNKNOWN_IDS`. `stale` marca la celda cuya última
  entrega confirmada ya no coincide con el valor actual de la parrilla
  (reversión o edición guardada sin publicar): el planificador recalcula el
  payload actual de cada celda entregada y compara hashes (sin códigos de
  mapeo); el editor lo pinta «Pendiente de reenvío» (§2.2).

### 1.7 Modos de canal y simulador

`Channel.mode ∈ stub | sandbox | real`, topado por `CHANNEL_MAX_MODE` (por
defecto `sandbox`: nada sale a Internet sin `real` en el canal Y en el entorno).

- `stub`: simulador en proceso, sin credenciales; `readyToPush` con solo
  mapeos. Para demos y tests.
- `sandbox`: simulador en proceso que hace una validación ESTRUCTURAL local
  del payload (OTA XML de Booking, EQC de Expedia, JSON de Channex: escáner
  por regex, sin XSD; no sustituye la certificación del proveedor, ver
  `docs/channel-manager-connectivity.md` §2) y exige credenciales (de
  simulación). Es lo que usa la demo (`channels:seed-sandbox`).
- `real`: HTTPS al proveedor con las credenciales cifradas.

Simulador: `channel-manager/sandbox/simulator.ts`; loopback público
`POST /channel-manager/_sandbox/:provider?endpoint=…` para validar un body sin
credenciales. Opciones por canal en credenciales: `simulator: { failEvery, latencyMs }`.

Cada cambio de `mode` se audita (`CHANNEL_MODE_CHANGED`: actor, modo pedido,
efectivo y tope) y el detalle del canal devuelve `requestedMode` junto al
modo efectivo. Un `PATCH` a `real` por encima de `CHANNEL_MAX_MODE` se acepta
y persiste (doble llave documentada, no un defecto): el canal saldría a
Internet solo con subir la variable, así que `CHANNEL_MAX_MODE=real`
únicamente en producción y con las credenciales reales ya cargadas.

### 1.8 Credenciales cifradas y webhooks

`Channel.credentialsEncrypted` está en `PII_FIELDS` (AES-GCM con
`ENCRYPTION_KEY`): se escribe por `POST /channel-manager/channels` o
`PATCH /channel-manager/channels/:id/credentials` (solo escritura; el GET
devuelve `hasCredentials` + claves). Credenciales legadas en
`configurationJson.credentials` (texto plano, agregador v1) se siguen leyendo,
se marcan `legacyPlaintextCredentials` y el seed las migra. Credenciales
indescifrables (clave rotada sin backfill) se marcan
`credentialsUndecryptable` en el detalle y la readiness pide «vuelva a
guardarlas» (se tratan como «sin credenciales», deliberadamente).

Webhook público `POST /channel-manager/webhooks/:provider/:channelId`: solo
dispara un `pull-reservations` (el payload nunca se confía). Verificación con
`X-Anfitorio-Webhook-Secret` (comparación en tiempo constante) o
`X-Anfitorio-Signature: sha256=<hex HMAC>` calculada sobre los **bytes
originales** (hook `preParsing` en `channel-manager.routes.ts` →
`request.rawBody`, límite 1 MiB → 413). Sin secreto en las credenciales → 401
siempre. Como la firma se verifica ANTES de cualquier parser, un JSON
malformado con firma inválida responde 401 (nunca 400); con firma válida un
cuerpo no JSON responde 202 y dispara el pull. El 413 sale etiquetado `error: "Payload Too
Large"` (`server.ts#errorLabels`). Todo ello confirmado en vivo el 15/09/2026
(:3000/:3400 reiniciados): HMAC sobre los bytes originales → 202, HMAC del
JSON compactado → 401, firma inválida → 401, `{not json` sin firma → 401 y
con firma válida → 202, 1.153.443 bytes → 413 `Payload Too Large`, canal
inexistente → 401 neutro. Comportamiento deliberado (no es un fallo): en un
canal `stub`/`sandbox` los adaptadores no tienen feed de reservas y fabrican
0..3 reservas deterministas por pull («Stub Guest N», job
`pull_reservations`, `adapters/stub-utils.ts#buildStubReservations`), así
que un webhook autenticado sobre ese canal SÍ añade filas simuladas al inbox
`ExternalReservation` (el hub «Sincronizar reservas» y el inbox de la demo
dependen de ello); en `real` el pull va al proveedor. Documentado en la
cabecera de `channel-manager.routes.ts` (ALF-5, nota de comportamiento).

### 1.9 Channex como vía a producción

Booking.com tiene pausado el alta de nuevos connectivity providers y Expedia
EQC exige contrato de proveedor (+ PCI para pagos) (externo · portal
Connectivity de Booking / docs EQC de Expedia · consultado 2026-09-14;
revalidar antes de contratar): la ruta realista es **Channex**
(`channex.adapter.ts`), agregador ya certificado con staging autoservicio
(`https://staging.channex.io`, externo · docs.channex.io · consultado
2026-09-14). Un canal `channex` en modo `real`
publica ARI a la propiedad Channex y esta abanica a las OTAs conectadas allí;
`airbnb`/`hotelbeds`/`vrbo` se enrutan vía Channex (`via-channex.adapter.ts`) y
en `real` responden «cree un canal channex».

Qué falta para producción con Channex:

1. Cuenta staging de Channex y una propiedad creada allí (room types + rate
   plans) → credenciales `{ apiKey (user-api-key), propertyId }`.
2. Ids de Channex por producto en los mapeos (`externalRoomCode` =
   `room_type_id`, `externalRateCode` = `rate_plan_id` de Channex).
3. `CHANNEL_MAX_MODE=real` en el entorno + `CHANNEX_BASE_URL` (staging para
   certificar; `https://app.channex.io` en producción).
4. Ronda de certificación (push ARI + feed de reservas con ack) y, después,
   conexión de la OTA real (ids de extranet de Booking/Expedia) en el lado de
   Channex.

## 2. Procedimiento: alta de canal y mapeo

1. Crear el canal: `POST /channel-manager/channels` `{ propertyId, providerCode,
   name, mode: "sandbox"|"real", status: "active", defaultMarkupPercent?,
   autoPushOnSave?, credentials? }` (permiso `channel_manager.manage`).
2. Credenciales (si no fueron en el alta): `PATCH
   /channel-manager/channels/:id/credentials { credentials, merge? }`.
3. Probar: `POST /channel-manager/channels/:id/test` (stub: ok sin verificar;
   sandbox: valida esquema; real: llamada al proveedor).
4. Mapear productos: `POST /channel-manager/channels/:id/product-mappings`
   `{ roomTypeId, ratePlanId, externalRoomCode, externalRateCode,
   pricingModel?: per_day|obp }` (`los` → 400 «no está implementado todavía»;
   uno por producto; `GET` lista;
   `DELETE /channel-manager/product-mappings/:id`); `…/product-coverage`
   muestra huecos y `…/product-mappings/migrate-legacy` convierte los mapeos
   room/rate del agregador v1. Avisos de códigos compartidos
   (`mapping.core.ts#productMappingWarnings`, corregido el 2026-09-15, lote
   `fix:api-channel-manager`, BUX-06): un `externalRoomCode` compartido entre
   tipos avisa en TODOS los proveedores («En Expedia cada código de habitación
   externo identifica un solo tipo de habitación: el código EX-DBL también
   está mapeado en DBL; la disponibilidad y las tarifas de ambos tipos irían a
   la misma habitación…»), porque la disponibilidad se direcciona por
   habitación en todos; un `externalRateCode` compartido avisa solo en
   channex/airbnb/vrbo/hotelbeds (en Channex cada `rate_plan_id` pertenece a
   un solo tipo; `RP-<plan>` compartido es legítimo en Booking y Expedia, que
   direccionan por (tipo, plan)). El upsert devuelve `warnings[]` (el hub los
   pinta: «Correspondencias guardadas con un aviso», verificado en navegador
   (2026-09-15) con el aviso de Channex; el aviso de código de habitación,
   verificado en navegador el 15/09/2026 con Expedia · IND `EX-IND` →
   `EX-DBL`: bloque «Correspondencias guardadas con un aviso / En Expedia cada código
   de habitación externo…», toast «1 correspondencia guardada con un aviso (ver
   arriba).», «4/4 productos», y restaurado a `EX-IND` con «1 correspondencia
   guardada.» sin aviso) y la readiness emite el check
   `product_codes` para todos los proveedores
   (`readiness.core.ts#productCodesCheck`: ok, warn en stub/sandbox, error en
   `real`; para Booking/Expedia solo códigos de habitación). El seed usa
   `RP-<plan>-<tipo>` para channex (Los Tilos resembrado:
   `RP-BAR-IND/DBL/DBM/SUI`, `product_codes` ok) y `RP-<plan>` para Booking y
   Expedia.
5. Readiness: `GET /channel-manager/channels/:id/readiness-v2` (modo,
   credenciales incluido `credentialsUndecryptable`, cobertura,
   `product_codes`, última entrega, adaptador). En la parrilla,
   `GET /properties/:id/channels` devuelve `readyToPush` + `readinessSummary`.
6. Publicar desde la parrilla (`bulk-update` con `publish`) o
   `POST /properties/:id/rate-grid/push`; seguir `sync-status` y
   `GET /channel-manager/deliveries?propertyId&channelId&status&from&to`.
7. Retirar un canal: `DELETE /channel-manager/channels/:id` es un archivado
   lógico (`status: archived`, `autoPushOnSave: false`, historial de entregas
   conservado; evento `CHANNEL_ARCHIVED`); con entregas `queued/sending/timeout`
   → 409 `CHANNEL_HAS_PENDING_DELIVERIES` (drenar o esperar). Desaparece de
   `GET /properties/:id/channels`; un `POST /channel-manager/channels` del
   mismo `providerCode` lo revive. Para pausar sin archivar:
   `PATCH …/channels/:id { status: "inactive" }` (no encola, sigue listado en
   el hub).

### 2.1 Rutas, permisos y riesgo

Fuente: los tres `route-permissions.partial.ts` (el contract test
`api-route-permissions-contract` falla si una ruta de `*.routes.ts` no tiene
entrada). Todas las rutas con `:propertyId` (o `propertyId` en body/query)
pasan por el guard global de tenant; las direccionadas por id de entidad
resuelven el canal padre con `assertEntityAccess({ entity: "channel" })`.

**Rate manager** (`rate-manager/route-permissions.partial.ts`, 9 entradas)

| Ruta | Permiso | Riesgo |
| --- | --- | --- |
| `GET /properties/:propertyId/rate-grid` | `revenue.read` | medium |
| `POST /properties/:propertyId/rate-grid/bulk-update` | `revenue.manage_rates` | critical |
| `POST /properties/:propertyId/rate-changes` | `revenue.manage_rates` | high |
| `POST /properties/:propertyId/rate-grid/push` | `distribution.sync` | critical |
| `GET /properties/:propertyId/rate-grid/sync-status` | `revenue.read` | medium |
| `GET /properties/:propertyId/rate-journal` | `revenue.read` | medium |
| `GET /properties/:propertyId/rate-journal/:journalId` | `revenue.read` | medium |
| `POST /properties/:propertyId/rate-journal/:journalId/revert` | `revenue.manage_rates` | critical |
| `POST /properties/:propertyId/rate-plans/:ratePlanId/rederive` | `revenue.manage_rates` | high |

**Recomendaciones** (`revenue/route-permissions.partial.ts`, 4 entradas del
rate grid; el mismo partial lleva las 4 del calendario de demanda
`/revenue/properties/:propertyId/demand-calendar[/:eventId]`)

| Ruta | Permiso | Riesgo |
| --- | --- | --- |
| `GET /properties/:propertyId/rate-grid/recommendations` | `revenue.read` | medium |
| `POST /properties/:propertyId/rate-grid/recommendations/apply` | `revenue.apply_recommendations` | high |
| `GET /properties/:propertyId/rate-grid/recommendations/config` | `revenue.read` | low |
| `PUT /properties/:propertyId/rate-grid/recommendations/config` | `revenue.configure` | medium |

**Channel manager** (`channel-manager/route-permissions.partial.ts`, 22
entradas; las dos rutas `public` deben estar ADEMÁS en `PUBLIC_PREFIXES` de
`lib/auth-context.ts` — el loopback `_sandbox` respondió 403 un día por tener
solo un comentario en el partial: el contract test ya no cuenta líneas
comentadas)

| Ruta | Permiso | Riesgo |
| --- | --- | --- |
| `GET /properties/:propertyId/channels` | `channel_manager.read` | medium |
| `GET /properties/:propertyId/channels/sync-status` | `channel_manager.read` | medium |
| `POST /channel-manager/channels` | `channel_manager.manage` | high |
| `GET /channel-manager/channels/:channelId` | `channel_manager.read` | medium |
| `PATCH /channel-manager/channels/:channelId` | `channel_manager.manage` | high |
| `DELETE /channel-manager/channels/:channelId` | `channel_manager.manage` | high |
| `PATCH /channel-manager/channels/:channelId/credentials` | `channel_manager.manage` | critical |
| `POST /channel-manager/channels/:channelId/test` | `channel_manager.sync` | medium |
| `POST /channel-manager/channels/:channelId/pull-reservations` | `channel_manager.sync` | high |
| `GET /channel-manager/channels/:channelId/product-mappings` | `channel_manager.read` | medium |
| `POST /channel-manager/channels/:channelId/product-mappings` | `channel_manager.mappings.manage` | high |
| `DELETE /channel-manager/product-mappings/:id` | `channel_manager.mappings.manage` | high |
| `POST /channel-manager/channels/:channelId/product-mappings/migrate-legacy` | `channel_manager.mappings.manage` | high |
| `GET /channel-manager/channels/:channelId/product-coverage` | `channel_manager.read` | medium |
| `GET /channel-manager/channels/:channelId/readiness-v2` | `channel_manager.read` | medium |
| `POST /channel-manager/deliveries/enqueue` | `channel_manager.sync` | critical |
| `GET /channel-manager/deliveries` | `channel_manager.read` | medium |
| `GET /channel-manager/deliveries/:id` | `channel_manager.read` | medium |
| `POST /channel-manager/deliveries/:id/retry` | `channel_manager.sync` | high |
| `POST /channel-manager/deliveries/drain` | `distribution.sync` | critical |
| `POST /channel-manager/webhooks/:provider/:channelId` | — (público: secreto o HMAC) | public |
| `POST /channel-manager/_sandbox/:provider` | — (público: secreto o HMAC) | public |

Rutas que el editor no usa pero el API expone:

- `POST /channel-manager/deliveries/enqueue` `{ propertyId, from, to,
  channelIds, ratePlanIds?, roomTypeIds?, kinds?, journalId?, drainNow? }`:
  invoca el mismo `enqueueRateGridPush` que `POST …/rate-grid/push`; con
  `drainNow: true` drena a continuación cada canal y añade `drained[]` a la
  respuesta. **Asimetría de permisos documentada, no corregida**: `enqueue`
  exige `channel_manager.sync` y `push` exige `distribution.sync` (ambas
  quedan cubiertas por el guard de tenant; un rol con solo
  `channel_manager.sync` puede encolar ARI por esta vía). Pendiente decidir
  si se unifica en `distribution.sync`.
- `GET /properties/:propertyId/channels/sync-status?from&to&channelIds`
  (`channel_manager.read`) devuelve lo mismo que
  `GET …/rate-grid/sync-status` (`revenue.read`); el editor solo usa la
  segunda (`services/rateGridApi.ts`).
- `POST /channel-manager/channels/:channelId/pull-reservations
  { since?: ISO datetime }` (`channel_manager.sync`): trae reservas del
  proveedor al inbox `ExternalReservation` (no crea `Reservation`, ver §5).

### 2.2 Política de la interfaz (editor `cocoa-rate-grid`, cierre 2026-09-15)

- Precios por canal: la fila de un canal solo admite restricciones (F2 sobre
  su precio no abre el editor y avisa al instante; celdas `aria-readonly`);
  «Precio visto por» muestra base × recargo y EDITA EL BASE; la hoja masiva
  con canales marcados no lleva precio (solo restricciones) y lo dice. El
  precio por canal es base × `defaultMarkupPercent` (§5).
- «Guardar sin enviar a canales» escribe tarifas reales en el PMS (el PMS ya
  vende el valor nuevo) y deja un `pendingPush` en el cliente (rango + planes
  + tipos + `journalId`, `localStorage` por propiedad y usuario); la barra
  muestra «N celdas guardadas sin enviar a canales · Enviar a canales» y el
  envío hace `POST …/rate-grid/push` con ese `journalId` acotado por tipos y
  planes.
- Revertir no toca canales: el editor marca las celdas del asiento de
  reversión como «pendiente de reenvío» (y `sync-status` devuelve `stale`, así
  que sobrevive a la recarga), crea un `pendingPush` de origen `revert` con
  los canales de la publicación original y ofrece «Enviar a canales». Ante
  409 `JOURNAL_STALE`, el historial y el drawer del editor abren
  `JournalStaleDialog` («La parrilla cambió después de este asiento», con
  «Precio: el asiento dejó X €, ahora hay Y €» por celda) y ofrecen «Forzar
  reversión» (`{ force: true }`); el asiento inverso muestra «revierte la
  entrada …<id>» en el historial (verificado en navegador el 2026-09-15). El
  reenvío va por `POST …/rate-grid/push` sin `kinds`, así que encola `rates`
  y `availability` (y `restrictions` si hay filas): 1 celda × 3 canales = 6
  entregas. Recuentos (corregido el 2026-09-15, lote `fix:admin-web`,
  BUX-07/10; verificado en navegador el 15/09/2026): el toast del envío
  manual cuenta lo que encola el API («6 entregas encoladas (tarifas y
  disponibilidad) para 1 celda en 3 canales»; «21 entregas encoladas … para
  2 celdas en 3 canales» al reenviar el rango completo de un `pendingPush`
  fusionado, idempotente pero ruidoso en el log de entregas;
  `helpers.ts#queuedDeliveriesSummary`) y el drawer etiqueta lo que devuelve
  `sync-status` como «celdas … (recuento del rango visible)» —aviso
  «Publicando en canales… / Booking.com: 1 celda pendiente · …» →
  «Publicación procesada / Booking.com: 1 celda confirmada · …», drawer «✓ 1
  celda confirmada en el rango visible» por canal, que crece a «✓ 2 …» y «✓
  4 …» conforme el rango acumula entregas—, porque el API no filtra por
  `journalId` (deuda en §5). La rama `bulk-update` + `publish` queda
  pendiente de verificar en navegador (motivo: allí el toast es «Guardado en
  ehotelOS: 1 celda. Publicación en cola.», no emite la frase de entregas,
  y los recuentos por asiento dependen del filtro `journalId`). Con un envío
  en curso el drawer conserva el flujo que lo lanzó
  (`rate-grid-utils.ts#resolveReviewDrawerMode`, sin mezclar la cabecera del
  `pendingPush` de otra celda; verificado en navegador el 15/09/2026: con un
  `pendingPush` vivo de DBM·20 ago se publicó SUI·21 ago y el drawer fue
  «Revisar y publicar» → «Publicación de 1 celda» → «Publicación enviada 1
  celda» sin el callout «Cambio revertido…» ni el texto del `pendingPush` de
  la otra celda, que la barra siguió mostrando intacto; el flujo de envío
  manual sí muestra su callout propio en reposo).
- El drawer «Revisar y publicar» no tiene «Programar la publicación»:
  `scheduleAt` no existe en el API (§5). Recuentos en una sola unidad
  (celdas); `expected` viaja en cada celda del borrador.
- Recomendaciones: `apply` se llama DESPUÉS del `bulk-update` con éxito, con
  `journalId`, `currentPrice` (precio antes del cambio) y `suggestedPrice` (el
  mostrado) (`sendRecommendationTrace`; verificado en navegador el
  2026-09-15: filas `applied`/`accept`, `applied`/`adjust` y `rejected` con
  `currentValueJson.price`, `recommendedValueJson.shownPrice`/`appliedPrice` y
  el mismo `journalId`). Sin recomendaciones accionables la capa lo dice
  («Sin recomendaciones accionables…») y «Aceptar todas» queda deshabilitado.
  Con una recomendación `hold`/`no_data` (sin `suggestedPrice`) el popover no
  ofrece «Aceptar» (antes aplicaba −5 %): quedan «Fijar otro precio» (stepper
  desde el precio ACTUAL) y «Rechazar» con la nota «No propone un precio
  nuevo…» (`helpers.ts#recommendationChoices`, corregido el 2026-09-15, lote
  `fix:admin-web`, BUX-03; verificado en navegador el 15/09/2026 en Los
  Tilos 15–31 ago con 68/68 `hold`: banner «Sin recomendaciones accionables
  en 15–31 ago / El motor sugiere mantener el precio en las 68 celdas del
  rango (confianza media 20 %)…», «Aceptar todas las recomendaciones
  visibles» deshabilitado y popover «Sin cambio sugerido» de SUI·23 ago con
  solo «Rechazar» y «Fijar otro precio»). Deuda: no hay vía para registrar
  «mantener» como decisión explícita en `revenue_recommendations` (haría
  falta `decision: hold` en `apply`, §5).
- `degraded: ["sync"]` en la parrilla → «Estado de sincronización no
  disponible» en el panel de sincronización, nunca todas las celdas «sin
  enviar» (no se puede provocar desde el navegador: exige que falle la lectura
  del mapa de sincronización; cubierto por typecheck y lectura de código, sin
  unitario). `classifyRateGridError` (`services/rateGridApi.ts`,
  `RATE_GRID_ERROR_CODES`) contempla los códigos de §1.1 (`RATE_GRID_BUSY` →
  «reintenta en unos segundos», `JOURNAL_STALE` → `staleCells`): en navegador
  (2026-09-15) se vieron `ALL_CELLS_CONFLICT` (aviso «Ninguna celda se aplicó:
  1 conflicto…», borrador conservado y re-basado) y `JOURNAL_STALE`; los demás
  mensajes los cubre `close-fixes.test.mts` (`rateGridErrorMessage`).
- Navegación del shell: Sidebar, ⌘K y `navigateTo()` despachan un
  `CustomEvent("hotelos-nav", { cancelable: true })` sobre `window`; el editor
  con borrador pendiente lo veta (`preventDefault` /
  `stopImmediatePropagation`) y re-despacha el mismo destino cuando el
  usuario confirma. El listener de `App` decide en un **microtask**
  (`queueMicrotask`) porque los listeners at-target sobre `window` corren en
  orden de registro (el del shell se registra antes que el de cualquier
  pantalla montada después, con o sin `capture`): solo tras el despacho
  síncrono se sabe si alguien vetó. Deuda: `BackOfficeLayout.selectHit` hace
  `pushState` ANTES de despachar, así que un veto deja la URL cambiada con el
  editor montado.
- Recorrido en navegador (2026-09-15, Carmen, Los Tilos 2027-08-01..14,
  1280×800): verificado lo anterior más la fila de canal en solo lectura (F2
  avisa, `aria-readonly`), «Precio visto por» editando el base, el guard
  `hotelos-nav` con ConfirmDialog («Tienes cambios sin guardar», URL intacta
  al seguir editando) y ⌘K con una sola paleta. También vistos: hub de
  canales (filas «activo … listo» con `readinessSummary`, fechas es-ES,
  «Efectivo: modo de pruebas (solicitado real…)», Archivar → ConfirmDialog
  danger → revival por «Dar de alta» → Desactivar, mismo id), Mapeos
  (modelos «por día»/«por ocupación», aviso de Channex, deep link
  `#channel=`), historial `/backoffice/revenue/rate-journal` con recarga,
  foco inicial en «Cancelar» de los ConfirmDialog `danger`, Esc en los
  drawers, sin errores de consola, red 200/204 y sin scroll horizontal a
  1280×800.
- Hallazgos del recorrido (BUX, lote `browser-ux-final`) y su estado.
  «Corregido» = en el working tree con unitarios
  (`cocoa-rate-grid/__tests__/final-fixes.test.mts`, 22 casos; en el API
  `journal-core.test.mts` y `mapping.core`), typecheck en verde y servido por
  :5173 (HMR) y :3000/:3400 (reiniciados después); «verificado en navegador
  el 15/09/2026» = visto en el recorrido final tras el segundo reinicio
  (Carmen, Los Tilos 2027-08-15..31, 1280×800; sin errores de consola salvo
  el 409 provocado, sin scroll horizontal, parrilla restaurada con diff
  vacío en las 68 celdas; informe de cierre §6.5); lo que ese recorrido no
  cubrió lleva «pendiente de verificar en navegador (motivo: …)». Sin
  regresiones.
  **BUX-01** (alta) «Revisar y publicar» ofrecía «0 canales» para los tipos
  no sincronizados en la ventana → corregido (`RateGridEditorScreen` carga
  los mapeos reales de cada canal activo por
  `GET …/channels/:id/product-mappings` y
  `rate-grid-utils.ts#isChannelMappedForProduct` los trata como autoritativos
  solo para los canales que cubre; un canal cuya carga falla cae a `cell.sync`
  y después a `mappedProducts > 0`, y el API descarta al encolar la entrega
  no mapeada); verificado en navegador el 15/09/2026 (DBM·20 ago, tipo sin
  entregas previas en la ventana: el drawer ofreció Booking.com, Expedia y
  Channex · agregador con 1 celda cada uno, chip «modo de pruebas», los tres
  marcados y habilitados, «Publicar en 3 canales» habilitado;
  `GET …/product-mappings` 200 por canal al montar y al abrir el drawer).
  **BUX-02** (alta) popover de recomendación fuera del viewport → corregido
  (`helpers.ts#placePopover`: debajo → encima → recortado, recolocado con
  `ResizeObserver`/`resize`, `max-height: calc(100vh − 16px)`); verificado
  en navegador el 15/09/2026 en la rama «Rechazar → Otro» (botón «=
  mantener» de SUI·23 ago en y=656 a 1280×800: `.crg-pop` con `max-height`
  784 px y `overflow-y: auto`, hoja «Motivo del rechazo» recolocada a
  160..629, botón «Rechazar recomendación» en (1184,596) dentro del viewport
  y devuelto por `elementFromPoint`, deshabilitado hasta escribir el
  detalle; cerrado con Escape sin rechazar); las ramas «Fijar otro precio»
  (stepper) y «Aceptar con ajuste» quedan pendientes de verificar en
  navegador (motivo: solo se midió la rama pedida y el popover no se
  confirmó). **BUX-03** (media) → corregido y verificado en navegador el
  15/09/2026 (bullet de recomendaciones). **BUX-04** (media) el drawer
  «Historial» no refrescaba tras publicar → corregido (`useRateJournal`
  recarga en cada apertura y el editor llama a `journal.refresh()` tras cada
  `bulk-update`, cada `push` y «Recargar»); verificado en navegador el
  15/09/2026 también «tras publicar»: sin recargar la página (`performance`
  navigation type `navigate`) el drawer «Historial de cambios · 50 entradas
  · hay más» mostró como primera entrada la publicación recién hecha
  («Corrección · 1 cambio … ✓ publicado / Ver cambios / Revertir») y, tras
  cada revert y envío, la entrada nueva al instante. **BUX-05** (media;
  Enter/Espacio sobre «Rechazar recomendación») se atribuye al driver del
  navegador, no al producto: el mismo Enter sintético tampoco activa los
  botones de ConfirmDialog, que sí responden al clic; sin cambio de código;
  pendiente de verificar en navegador (motivo: exige teclado físico, fuera
  del alcance del driver del pane). **BUX-06** (media) → corregido en el API
  y verificado en navegador el 15/09/2026 (§2, paso 4). **BUX-07** (baja)
  recuentos toast/drawer → corregido en el front y verificado en navegador
  el 15/09/2026 en el envío manual (bullet de la reversión); parcial
  mientras `sync-status` no filtre por `journalId`. **BUX-08** (baja) aviso
  de conflicto con campos en inglés y fechas ISO → corregido en el API
  (§1.3) y en el front (`formatDateLong` para la fecha de la celda en la
  lista del aviso); verificado en navegador el 15/09/2026 (aviso «Ninguna
  celda se aplicó: 1 conflicto / … BAR · Doble Estándar matrimonio · 20 de
  agosto de 2027: la celda cambió desde que se cargó: precio actual 126,00 €
  (esperado 125,14 €); última modificación actual 15/09/2026 09:18:32
  (esperado 14/09/2026 21:59:29)», borrador re-basado a «126 € → 130 €»).
  **BUX-09** (baja) toast sobre la barra sticky → corregido (`Toast.tsx` lee
  `--hotelos-toast-offset`, que `RateGridStatusBar` publica según su altura
  con `helpers.ts#toastOffsetForBar`); verificado en navegador el 15/09/2026
  a 1280×800: barra de 1 fila (52,5 px → `129px`) con el toast a bottom 682
  px frente a la barra a top 707,5 px; barra de 2 filas con `pendingPush`
  (86,5 px → `163px`) con el toast a 637 frente a 674; ningún solape y la
  variable vuelve a `129px` al desaparecer la segunda fila. **BUX-10** (baja)
  → corregido (`resolveReviewDrawerMode`); verificado en navegador el
  15/09/2026 (bullet de la reversión). **BUX-11** (baja) etiquetas de modo
  del hub → corregido (`helpers.ts#CHANNEL_MODE_LABELS`: «Simulado (sin red,
  sin proveedor) / Modo de pruebas (sandbox del proveedor) / Real
  (producción)», mismo vocabulario que la línea «Efectivo»); verificado en
  navegador el 15/09/2026 (selects de los 4 canales y del alta con las 3
  opciones; pills con `title` «Estado: activo» / «Estado: inactivo»; línea
  «⚠ Efectivo: modo de pruebas (solicitado real; la instancia lo limita a
  modo de pruebas)» —`title` «Solicitado: real · tope de la instancia
  (CHANNEL_MAX_MODE): modo de pruebas»— provocada con Prueba UX inactivo en
  `real` y desaparecida al restaurar `sandbox`; la línea usa la forma corta
  en minúsculas frente a la larga del select: mismo vocabulario, distinta
  forma); con un canal ACTIVO cuyo modo solicitado supere `CHANNEL_MAX_MODE`
  queda pendiente de verificar en navegador (motivo: solo se provocó con el
  canal inactivo). **BUX-12** (baja) enum crudo del proveedor/tipo en la
  tarjeta legacy del hub y en la tabla de Mapeos → corregido
  (`providerLabel`/`channelTypeLabel`: «Airbnb · alquiler vacacional»,
  «Expedia · OTA»; el hub filtra los `archived` de la lista legacy);
  verificado en navegador el 15/09/2026 («Prueba UX / Airbnb · alquiler
  vacacional / inactivo», «Expedia · OTA», «Booking.com · OTA», «Channex ·
  agregador»; enum crudo solo en `title`; ningún archivado en la lista).
  **BUX-13** (baja) el select de Mapeos no actualizaba `#channel=` →
  corregido (`lib/channel-hash.ts`, `history.replaceState`); verificado en
  navegador el 15/09/2026 (al cargar, `#channel=<Booking.com>`; al elegir
  «Expedia · modo de pruebas», `#channel=<Expedia>`). **BUX-14** (baja)
  marcadores del runbook → este documento (marcadores cerrados el
  15/09/2026 tras el recorrido final; el contrato documental impide desde
  entonces marcadores de navegador sin motivo).

## 3. Comandos

```bash
# Sembrar los 3 canales sandbox (booking_com, expedia, channex) + un mapeo por
# (tipo de habitación activo × plan BAR): en prop_123 es DBL×BAR (1 por canal), en
# Los Tilos 4 por canal; códigos BK-|EX-|CX-<tipo> / RP-<plan> (channex: RP-<plan>-<tipo>). Sin --apply es dry-run.
corepack pnpm --filter @hotelos/api channels:seed-sandbox -- --property prop_123 [--dry-run] [--json]
corepack pnpm --filter @hotelos/api channels:seed-sandbox -- --property prop_123 --apply --confirm prop_123 [--json]
# --apply exige --confirm <mismo id>; --dry-run y --apply son excluyentes; salida 2 = flags inválidos

# Drenaje manual (permiso distribution.sync). Con channelId drena ese canal; sin channelId,
# un usuario de tenant drena los canales de la propiedad de su sesión (respuesta { runs: DrainSummary[] })
# y un administrador de plataforma drena toda la instancia (respuesta DrainSummary). limit ≤ 20000.
curl -s -X POST http://localhost:3000/channel-manager/deliveries/drain \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"channelId":"<id>","limit":500}'

# Estado de entregas y reintento
curl -s "http://localhost:3000/channel-manager/deliveries?propertyId=prop_123&status=rejected" -H "Authorization: Bearer $TOKEN"
curl -s -X POST http://localhost:3000/channel-manager/deliveries/<id>/retry -H "Authorization: Bearer $TOKEN"

# Revertir una entrada del historial (nueva entrada published; la original queda reverted).
# 409 JOURNAL_STALE si un asiento posterior cambió alguna celda: repetir con {"force":true} para pisarlo.
curl -s -X POST http://localhost:3000/properties/prop_123/rate-journal/<journalId>/revert \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"reason":"motivo"}'

# Tests
corepack pnpm test:integration          # tests/integration/rate-grid-v2.test.mts + channel-outbox.test.mts (Postgres)
corepack pnpm --filter @hotelos/api test  # unitarios (bulk-ops, derivación, merge, delivery.core, drain.core, simulador)
```

Nota para tests con credenciales sembradas: los dos ficheros de integración
(`rate-grid-v2` y `channel-outbox`) cargan `hotelos/.env` con
`process.loadEnvFile` antes de nada (sin pisar variables ya definidas) porque
las credenciales sembradas están cifradas con la `ENCRYPTION_KEY` real; sin
`.env` usan valores por defecto de CI y los casos de publish encolan 0 (los
canales leen «faltan credenciales»). El líder de schedulers (:3000) drena la
misma BD cada 15 s, así que las aserciones aceptan `queued | sending |
confirmed` y sondean.

## 4. Límites duros (los aplica el código)

Fuera de rango → 400: los cuerpos zod responden `details.code =
"VALIDATION_ERROR"` con `details.issues`; las ventanas de fechas responden
400 con mensaje («la ventana máxima … es N días», «El rango no puede superar
400 días.»).

| Operación | Límite | Fuente |
| --- | --- | --- |
| `GET …/rate-grid` | ventana ≤ 366 días (`MAX_GRID_DAYS`); sin `from/to` → hoy..+29 | `rate-grid.schemas.ts`, `rate-grid.service.ts#parseGridWindow` |
| `POST …/rate-grid/bulk-update` | `cells` ≤ 5.000 (`MAX_CELLS`) y `ops` ≤ 50 (`MAX_OPS`), al menos 1 en total; `reason` 3..500; `price`/`minPrice`/`maxPrice`/`occupancyPrices` 0..50.000 (`MAX_PRICE`); ops `percent` −100..1000, `amount` ±50.000; restricciones enteras 0..365; `available` 0..10.000; scope `roomTypeIds`/`ratePlanIds` ≤ 200, `channelIds` ≤ 50, `weekdays` ≤ 7; `publish.channelIds` 1..50; `clientRequestId` 8..128; `scope` de cada op ≤ 366 días; ops expandidas + cells ≤ 5.000 parches → 400 `TOO_MANY_CELLS`; 0 parches → 400 `NO_CELLS`; lock por propiedad ≤ 30 s (`lock_timeout`) → 409 `RATE_GRID_BUSY`; `UNKNOWN_IDS`/`INACTIVE_RATE_PLANS` listan ≤ 20 ids | `rate-grid.schemas.ts`, `rate-grid.engine.ts` |
| `POST …/rate-grid/push` · `POST /channel-manager/deliveries/enqueue` | `channelIds` 1..50 (push); `ratePlanIds`/`roomTypeIds` ≤ 200 (push); rango `from..to` ≤ 400 días (`MAX_RANGE_DAYS`) | `rate-grid.schemas.ts`, `delivery.service.ts#requireRange` |
| `GET …/rate-grid/sync-status` | ventana ≤ 366 días (`parseGridWindow`, mismos defaults que el grid) | `rate-grid.service.ts#getRateGridSyncStatus` |
| `GET …/channels/sync-status` | `from`/`to` obligatorios; rango ≤ 400 días (`requireRange`) | `channel-manager.routes.ts`, `delivery.service.ts#getCellSyncMap` |
| `GET …/rate-journal` | `limit` 50 por defecto, máx. 200 (un `limit` mayor se recorta a 200, no da 400; paginación por cursor; cursor inválido → 400) | `rate-grid.routes.ts` |
| `POST …/rate-journal/:journalId/revert` | `details.cells` de `JOURNAL_STALE` ≤ 200 celdas; `force`/`reason` opcionales | `rate-grid.engine.ts`, `journal.service.ts` |
| `GET /channel-manager/deliveries` | `limit` 100 por defecto, máx. 500 (cursor) | `channel-manager.routes.ts`, `delivery.service.ts#listDeliveries` |
| `POST /channel-manager/deliveries/drain` | `limit` 1..20.000; sin `limit` → `CHANNEL_DRAIN_BATCH_LIMIT` (2.000 por defecto); reintentos 5 con backoff 1 m, 5 m, 30 m, 2 h; `sending` obsoleto a los 10 min (`STALE_SENDING_MS`); purga de `superseded` más antiguas que `CHANNEL_DELIVERY_RETENTION_DAYS` (30) una vez por hora en la pasada sin ámbito | `channel-manager.routes.ts`, `drain.service.ts`, `drain.core.ts` |
| `GET/POST …/rate-grid/recommendations[/apply]` | ventana ≤ 120 días (`RECOMMENDATION_MAX_DAYS`); `apply`: `cells` ≤ 5.000, precios 0..50.000, `reason` ≤ 200, `minConfidence` 0..100, `to` no puede ser pasado; `roomTypeIds` ajenos → 400 `UNKNOWN_IDS` (≤ 20 ids) | `rate-recommendation.service.ts`, `recommendations.routes.ts` |
| `POST /channel-manager/webhooks/:provider/:channelId` | cuerpo ≤ 1 MiB (`WEBHOOK_MAX_BYTES`) → 413 `Payload Too Large` | `channel-manager.routes.ts`, `server.ts#errorLabels` |
| Adaptadores (`capabilities()`) | Booking 1.000 mensajes/petición · 75/min; Expedia 500/petición · 60/min; Channex 1.000 values/petición · 60/min (el drenaje trocea, aplica el token bucket y respeta `Retry-After` si supera el backoff) | `docs/channel-manager-connectivity.md` §8 |

Reproducir: `GET /properties/:id/rate-grid?from=2026-01-01&to=2027-06-30`
→ 400 «la ventana máxima del grid es 366 días (pedidos 546)».

## 5. Límites conocidos (deuda)

- **Overrides de precio por canal**: `RateDay` no tiene dimensión canal. El
  precio por canal es base × `defaultMarkupPercent`; un parche/op con
  `channelId` + precio responde 400 («los precios por canal se calculan con el
  markup del canal…»). Las restricciones por canal SÍ persisten.
- **`pull-reservations` solo alimenta el inbox** (`ExternalReservation`): no
  crea `Reservation` (falta mapeo inverso de producto + reglas de huésped/folio).
- **Booking.com** en pausa de onboarding (externo · consultado 2026-09-14): el
  adaptador OTA XML está listo contra el simulador (validación estructural, no
  certificación), sin cuenta real. **Expedia** EQC: sin cuenta ni contrato (y
  PCI para tarjetas; externo · consultado 2026-09-14); adaptador listo contra
  el simulador. Producción → Channex.
- El token bucket del limitador es por proceso (no compartido entre
  instancias); el proveedor sigue protegido por su propio 429 → backoff.
- Si el drenaje cae entre la toma y el envío, las filas quedan `sending`
  hasta el retoma por antigüedad (10 min).
- `recommendations/apply` guarda `journalId` en `reasonJson` (sin columna en
  `RevenueRecommendation`).
- **TimeZone de sesión en SQL crudo**: el drenaje ya liga sus `Date` como
  `AT TIME ZONE 'UTC'`, pero el mismo patrón (`$queryRaw`/`$executeRaw` que
  compara o escribe un `Date` contra columnas `timestamp without time zone`)
  sigue sin revisar en `apps/api/src/server.ts`, `lib/tenancy.ts`,
  `lib/reservation-code.ts`, `modules/pms/pms.service.ts`,
  `modules/folio/folio.service.ts`, `modules/invoicing/invoice.service.ts`,
  `modules/invoicing/verifactu-submission.service.ts`,
  `modules/mobile-keys/wallet-pass.service.ts`,
  `modules/assistant/assistant.tools.ts`, `jobs/pii-backfill.ts` y
  `scripts/refresh-demo-dataset.ts`; alternativa global: fijar
  `?options=-c%20TimeZone%3DUTC` en `DATABASE_URL` (hoy sin `options`) y
  documentarlo en el contrato de env.
- **Agrupado de escrituras del `bulk-update`**: cada celda es un upsert
  secuencial dentro de la transacción (hasta 120 s); solo se ha acotado
  (366 días / 5.000 parches). Refactor pendiente: `createMany` / `INSERT …
  ON CONFLICT` multifila. Además `SET LOCAL lock_timeout = '30s'` aplica a
  toda la transacción: un bloqueo de fila > 30 s de un escritor externo
  (seed/import CLI) haría fallar el upsert con 55P03 → 500 saneado.
- **Programación de publicaciones (`scheduleAt`) no implementada**: el editor
  retiró el control «Programar la publicación» (era decorativo); si producto
  la quiere, va en `RateGridBulkUpdateRequest.publish` y `RateGridPushRequest`
  con un job programado.
- **Asimetría de permisos** `POST /channel-manager/deliveries/enqueue`
  (`channel_manager.sync`) vs `POST …/rate-grid/push` (`distribution.sync`):
  documentada en §2.1, decisión pendiente (unificar en `distribution.sync`).
- Semántica de `manuallyOverridden` en planes base: una edición ya no lo
  pone a `true` (se conserva el flag existente); solo afecta a escrituras
  futuras (Los Tilos: 18 filas `true` / 1.442 `false` quedan como están).
- `readinessSummary`: corregido en el cierre (`readiness.core.ts`: español y
  fecha es-ES «15/09/2026 01:29», sin ISO ni códigos internos); visto en el
  hub el 2026-09-15 («Modo sandbox: validado por el simulador local…», fechas
  «15/9, 07:44»).
- Puesta en vigor: los API :3000/:3400 sirven el working tree completo
  (reiniciados el 2026-09-15 tras el cierre —`test:integration` 80/80
  después— y otra vez tras los cuatro lotes de corrección del mismo día;
  tras estos últimos se repitieron typecheck-all 15/15 + 1 SKIP, contratos
  293/293 y unitarios del API 840 (839 pass · 1 skipped), pero no
  `test:integration`, que escribe en la BD: repetirlo antes del commit).
  Tras el segundo reinicio, un recorrido final en navegador (15/09/2026,
  Carmen, Los Tilos 2027-08-15..31, restaurado) verificó las correcciones
  de pantalla de los lotes sin regresiones (§2.2; informe §6.5). El
  VPS sigue pendiente y necesita deduplicar `(propertyId,
  client_request_id)` antes de `migrate deploy` de la migración `unique`
  (§6).
- Deuda abierta tras la verificación final (2026-09-15): `sync-status` no
  filtra por `journalId`, así que los recuentos «confirmadas» del drawer son
  del rango visible (etiquetados como tales; BUX-07 parcial: en el recorrido
  final del 15/09/2026 el drawer pasó de «✓ 2 celdas confirmadas…» a «✓ 4
  celdas…» para envíos de 1 y 2 celdas); no existe una decisión explícita
  «mantener» en `recommendations/apply` (`decision: hold`; BUX-03); un
  `clientRequestId` repetido SIN `publish` devuelve la respuesta almacenada
  sin el aviso «petición repetida» (ALF-1); `typeNameEs` de
  `rate-grid.schemas.ts` no traduce `nan` (ALF-4); BUX-05 (teclado en el
  popover) sin confirmar con teclado físico; y lo que el recorrido final no
  cubrió (§2.2: ramas «Fijar otro precio»/«Aceptar con ajuste» del popover,
  recuentos de `bulk-update` + `publish`, línea «Efectivo» con un canal
  activo). Observaciones menores de ese recorrido, sin regresión: el aviso
  «Cambio revertido en ehotelOS · los canales conservan el valor anterior»
  cerrado con ✕ reaparece tras una publicación posterior mientras el
  `pendingPush` siga vivo (la barra ya lo indica: posible doble
  recordatorio); el reenvío manual de un `pendingPush` de 2 celdas encoló 21
  entregas (rango completo por tipo/plan, idempotente pero ruidoso en el log
  de entregas); el motivo elegido por chip se recuerda entre publicaciones
  de la misma sesión.

## 6. Contrato acordado en el cierre (2026-09-15)

Nombres fijos pactados entre los lotes de corrección. Todos están en el
working tree, verificados por lectura de código en este cierre (columna
«Estado»); «confirmado por las puertas del integrador» = typecheck-all 15/15 +
`corepack pnpm test` 293/293 + unitarios API 814/815 + `corepack pnpm
test:integration` 80/80 en verde el 2026-09-15; «en vigor en :3000/:3400» =
servido por los API reiniciados el 2026-09-15 con este código (integración
80/80 repetida después); «verificado en navegador (2026-09-15)» = ejercitado
en :5173 como Carmen (Los Tilos, 2027-08-01..14, 1280×800); «confirmado en
vivo el 15/09/2026 (:3000/:3400 reiniciados)» = probado con `curl`/`psql`
contra los API reiniciados (Los Tilos 2027-09-01..07 y `prop_123`, datos
restaurados); «corregido el 2026-09-15 (lote …)» = cambio posterior de los
lotes de corrección finales, con unitarios y typecheck (puertas repetidas
tras ellos: typecheck-all 15/15 + 1 SKIP, contratos 293/293, unitarios API
840 = 839 pass · 1 skipped), servido por los API reiniciados después;
«verificado en navegador el 15/09/2026» = visto en el recorrido final tras
el segundo reinicio (Carmen, Los Tilos 2027-08-15..31, 1280×800, parrilla
restaurada con diff vacío; informe de cierre §6.5) y «pendiente de verificar
en navegador (motivo: …)» = lo que ese recorrido no pudo cubrir. Ventanas de
`prop_123` reservadas a los tests de integración (no
usarlas en sondas manuales): noviembre 2026 (10..15, 24 y 26 `rate-grid-v2`;
16..18 `channel-outbox`) y junio 2027 (01..15 `rate-grid-v2`; 16..30
`channel-outbox`).

| Elemento | Dónde | Estado |
| --- | --- | --- |
| `CellSyncStatus` += `"stale"` («Pendiente de reenvío») | `packages/shared/src/rate-manager-types.ts`, `delivery.service.ts` (mapa de sincronización por hash del valor), `cocoa-rate-grid/helpers.ts` | confirmado por las puertas del integrador (2026-09-15); en vigor en :3000/:3400 (reinicio 2026-09-15); «Pendiente de reenvío» visto en navegador tras revertir (2026-09-15); confirmado en vivo el 15/09/2026 (:3000/:3400 reiniciados): `sync-status` de la parrilla y de canales → `stale` con `deliveryId` tras revertir, `confirmed` tras reenviar el inverso |
| `pushStatus` (`RateJournalPushStatus`): `draft \| queued \| pushed \| partial \| failed \| superseded` | `rate-manager-types.ts`, `delivery.service.ts` (enqueue estampa `queued`, `refreshJournalPushStatuses`), `delivery.core.ts#classifyJournalPushStatus`, historial del editor | confirmado por las puertas del integrador (2026-09-15); en vigor en :3000/:3400 (reinicio 2026-09-15); confirmado en vivo el 15/09/2026 (:3000/:3400 reiniciados): `queued` justo tras encolar (`pushedTo` 3 canales) y `pushed` tras el drenaje del líder; el inverso de un revert queda `draft`/`pushedTo []` hasta reenviarlo |
| `RateGridCellPatch.expected { price?, lastModifiedAt? }` → conflicto / 409 `ALL_CELLS_CONFLICT` | `rate-manager-types.ts`, `rate-grid.schemas.ts`, `rate-grid.engine.ts`; el editor lo envía desde el `before` del borrador y re-basa tras recargar | en vigor en :3000/:3400 (reinicio 2026-09-15); envío desde el editor, aviso de conflicto y re-base del borrador verificados en navegador (2026-09-15); confirmado en vivo el 15/09/2026 (:3000/:3400 reiniciados): `expected.price` o `lastModifiedAt` obsoletos → 409 `ALL_CELLS_CONFLICT` sin asiento, correctos → 200; mensaje del conflicto en español corregido el 2026-09-15 (lote `fix:api-rate-manager`, §1.3) y verificado en navegador el 15/09/2026 (BUX-08: aviso en español con moneda y fechas es-ES, fecha de la celda en formato largo) |
| `RateJournalRevertRequest { force?, reason? }` · 409 `JOURNAL_STALE` + `details.cells[]` | `journal.service.ts`, `journal.core.ts`, `rate-grid.routes.ts`; `JournalStaleDialog` («Forzar reversión») | en vigor en :3000/:3400 (reinicio 2026-09-15); diálogo «Forzar reversión» verificado en navegador (2026-09-15); confirmado en vivo el 15/09/2026 (:3000/:3400 reiniciados): 409 `{ code, cells[].fields[{ field, expected, actual }] }`, `force: true` → inverso con `revertsJournalId`, segundo revert → 409 `JOURNAL_ALREADY_REVERTED` |
| Reversión: `reason` «Reversión: <motivo original>[ — <texto>]» + `revertsJournalId` en el asiento inverso (`changesJson`, sin columna) | `journal.core.ts` (`revertReason`, `readRevertsJournalId`), `journal.service.ts`; `HistoryDrawer` («revierte la entrada …») | confirmado por las puertas del integrador (2026-09-15: integración 80/80); en vigor en :3000/:3400 (reinicio 2026-09-15); enlace «revierte la entrada …» verificado en navegador (2026-09-15); confirmado en vivo el 15/09/2026 (:3000/:3400 reiniciados): `reason` «Reversión: <motivo> — <texto>», `revertsJournalId`, original `reverted` + `revertedByJournalId` |
| `RateGridErrorCode`: unión de todos los `details.code` 4xx del módulo (los acordados + `JOURNAL_ALREADY_REVERTED`, `VALIDATION_ERROR`) | `packages/shared/src/rate-manager-types.ts`; el front tipa los suyos en `cocoa-rate-grid/helpers.ts#RATE_GRID_ERROR_CODES` | en el working tree (typecheck-all 15/15 el 2026-09-15); `JOURNAL_ALREADY_REVERTED` confirmado en vivo el 15/09/2026 (:3000/:3400 reiniciados) |
| `RateGridResponse.degraded: ["sync"]` | `rate-grid.service.ts` (`createDegradedCollector`); `SyncStatusPanel` («Estado de sincronización no disponible») | en vigor en :3000/:3400 (reinicio 2026-09-15); el aviso no se puede provocar desde el navegador (exige que falle la lectura del mapa de sincronización) y no tiene unitario: typecheck + lectura de código |
| 400 `NO_CELLS`, `TOO_MANY_CELLS`, `INACTIVE_RATE_PLANS`, `DERIVATION_CHAIN`, `DERIVATION_YIELDS_ZERO`, `UNKNOWN_IDS` · 409 `RATE_GRID_BUSY`, `JOURNAL_STALE`, `ALL_CELLS_CONFLICT`, `CHANNEL_HAS_PENDING_DELIVERIES` | rate-manager, revenue, channel-manager; `RATE_GRID_ERROR_CODES` en `services/rateGridApi.ts` | en vigor en :3000/:3400 (reinicio 2026-09-15); en navegador (2026-09-15) se vieron `ALL_CELLS_CONFLICT` y `JOURNAL_STALE`; confirmados en vivo el 15/09/2026 (:3000/:3400 reiniciados) `NO_CELLS`, `TOO_MANY_CELLS` (5.844 > 5.000, 0 escrituras), `INACTIVE_RATE_PLANS` (`cells`), `UNKNOWN_IDS` (bulk-update, recommendations, sync-status, push), `JOURNAL_ALREADY_REVERTED` y `CHANNEL_HAS_PENDING_DELIVERIES` (`pending: 2`); `DERIVATION_*` y `RATE_GRID_BUSY` solo por unitarios (`close-fixes.test.mts`, `rateGridErrorMessage`); `INACTIVE_RATE_PLANS` en `ops` corregido el 2026-09-15 (lote `fix:api-rate-manager`, §1.3) |
| Encolado acotado: `enqueueRateGridPush` admite `roomTypeIds`/`ratePlanIds`/`kinds` y `bulk-update` los deriva de los parches | `channel-outbox.bridge.ts`, `delivery.service.ts` (admiten), `rate-grid.service.ts#derivePushScope` | confirmado por las puertas del integrador (2026-09-15); en vigor en :3000/:3400 (reinicio 2026-09-15); confirmado en vivo el 15/09/2026 (:3000/:3400 reiniciados) por el integrador, en navegador y por la sonda del API: publicar 1 celda encola 1 entrega `rates` por canal |
| Replay con `publish` no vuelve a encolar (`replayed`, solo interno) | `rate-grid.engine.ts`, `rate-grid.service.ts` | confirmado por las puertas del integrador (2026-09-15); en vigor en :3000/:3400 (reinicio 2026-09-15); confirmado en vivo el 15/09/2026 (:3000/:3400 reiniciados): repetición idéntica → mismo `journalId`, sin `queued`, aviso «petición repetida», entregas 663 → 663; deuda ALF-1 (sin `publish` no hay aviso, §1.3) |
| `recommendations/apply` (`cells`): `currentPrice?` → `currentValueJson.price`, `suggestedPrice?` → `recommendedValueJson.shownPrice`; el front llama a `apply` tras el `bulk-update` con `journalId` | `revenue/recommendations.routes.ts`, `RateGridEditorScreen.tsx#sendRecommendationTrace` | confirmado por las puertas del integrador (2026-09-15); en vigor en :3000/:3400 (reinicio 2026-09-15); `apply` tras el `bulk-update` verificado en navegador (2026-09-15); confirmado en vivo por el integrador tras el reinicio (rechazo → `rejected: 1, recorded: 1`) |
| `CHANNEL_DELIVERY_RETENTION_DAYS` (int 1..3650, 30): purga horaria de `superseded` en la pasada sin ámbito | `channel-manager/env.partial.ts` (censo regenerado: `.env.example`, `scripts/env-contract.json`), `drain.service.ts#purgeSupersededDeliveries` | confirmado por las puertas del integrador (2026-09-15); en vigor en :3000/:3400 (reinicio 2026-09-15); confirmado en vivo el 15/09/2026 (:3000/:3400 reiniciados): fila `superseded` sintética (−40 d) purgada por el drain sin ámbito (`purgedSuperseded: 1`), las de menos de 30 d conservadas, segundo drain → `null` (throttle horario) |
| `413: "Payload Too Large"` en `errorLabels` | `apps/api/src/server.ts` | confirmado por las puertas del integrador (2026-09-15); en vigor en :3000/:3400 (reinicio 2026-09-15); confirmado en vivo el 15/09/2026 (:3000/:3400 reiniciados): 1.153.443 bytes → 413 `{ error: "Payload Too Large" }` |
| `@@unique([propertyId, clientRequestId])` en `RateChangeJournal` + migración `20260915100000_rate_grid_v2_journal_unique` | `packages/database/prisma/schema.prisma`, `migrations/`; índice `rate_change_journals_propertyId_client_request_id_key` en la BD local | aplicada en local (drift 0, duplicados 0); confirmado en vivo el 15/09/2026 (:3000/:3400 reiniciados): dos POST concurrentes con el mismo `clientRequestId` nuevo → 1 asiento; en el VPS deduplicar antes de `migrate deploy` |
| Invariante del outbox (supersede incondicional, reencolado de confirmada adelantada, retiro `superseded`, UTC) | `delivery.core.ts`, `delivery.service.ts`, `drain.service.ts` | confirmado por las puertas del integrador (2026-09-15); en vigor en :3000/:3400 (reinicio 2026-09-15); confirmado en vivo el 15/09/2026 (:3000/:3400 reiniciados): revert → `stale` por canal, reenvío del inverso → `confirmed` en 3 canales (historial de 6 entregas coherente) |
| `DELETE /channel-manager/channels/:id` (archivado lógico) + entrada `_sandbox` en el manifiesto + seed channex `RP-<plan>-<tipo>` | `channel-manager.routes.ts`, `channels.service.ts`, `route-permissions.partial.ts`, `scripts/seed-sandbox-channels.ts` (Los Tilos resembrado) | confirmado por las puertas del integrador (2026-09-15); en vigor en :3000/:3400 (reinicio 2026-09-15); confirmado en vivo el 15/09/2026 (:3000/:3400 reiniciados, `prop_123`): 409 `CHANNEL_HAS_PENDING_DELIVERIES` con entregas en cola, 200 `{ status: archived, keptDeliveries }` idempotente, enqueue a archivado → `queued 0` + aviso, revival por `POST` con el mismo `providerCode`, `_sandbox/booking|channex` → 200 con `X-Anfitorio-Simulator`, `_sandbox/foo` → 400; en navegador (2026-09-15): Archivar → ConfirmDialog danger → «Dar de alta» revive la misma fila |
| Política UI de precios por canal, `pendingPush`, revert sin canales, sin «Programar», navegación `hotelos-nav` cancelable con decisión en microtask | `apps/admin-web` (§2.2) | verificado en navegador (2026-09-15): fila de canal solo restricciones, «Precio visto por» edita el base, revert → «Pendiente de reenvío» + «Enviar a canales», sin «Programar», guard `hotelos-nav` con ConfirmDialog y ⌘K con una sola paleta; hallazgos BUX-01..14 corregidos el 2026-09-15 (lote `fix:admin-web`; BUX-06/08 en el API) y verificados en navegador el 15/09/2026 en el recorrido final tras el segundo reinicio (BUX-01/02/03/04/06/07/08/09/10/11/12/13; sin regresiones), salvo lo que ese recorrido no cubrió (§2.2: BUX-02 en las ramas «Fijar otro precio»/«Aceptar con ajuste», BUX-07 en `bulk-update` + `publish`, BUX-11 con un canal activo por encima de `CHANNEL_MAX_MODE`); BUX-05 atribuido al driver del navegador, pendiente con teclado físico |
