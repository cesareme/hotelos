# Channel manager · conectividad real (rate grid v2)

Estado a 2026-09-15 (lotes `api-channel-outbox` + `api-polish`; revisión
documental `fix:docs`; cierre de la verificación adversarial
`fix:api-channel-manager` + `cierre:docs`). Código en
`apps/api/src/modules/channel-manager/**`. Todo lo descrito está en el working
tree (verificado por lectura de código en el cierre) y lo sirven los API
:3000/:3400 desde su reinicio del 2026-09-15 (`test:integration` 80/80
después). El contrato acordado entre lotes está en
`docs/runbooks/rate-grid-v2.md` §6.
Este documento sustituye la nota «OTAs son MOCK» del CLAUDE.md (Deuda 7,
cerrada por la Deuda 13) como descripción honesta de lo que hay. Los hechos
de terceros (pausa de altas de Booking, contrato de Expedia, límites
publicados, staging de Channex) van marcados «externo» con su fecha de
consulta: cambian sin avisar y hay que revalidarlos antes de contratar.

## 1. Estado real de cada canal

| Canal | Adaptador | stub | sandbox | real | Estado comercial |
| --- | --- | --- | --- | --- | --- |
| Booking.com | `adapters/booking.adapter.ts` · OTA 2003B v1.1 XML + token exchange JWT | simulador | simulador (validación estructural OTA, ver §2) | cableado, **sin credenciales** | Booking.com tiene **PAUSADAS las altas de nuevos connectivity providers** (externo · portal Connectivity de Booking · consultado 2026-09-14). No se puede pedir `client_id`/`client_secret` hoy. |
| Expedia | `adapters/expedia.adapter.ts` · EQC AR/BR/BC XML (credenciales en el cuerpo) | simulador | simulador (validación estructural EQC, ver §2) | cableado, **sin credenciales** | EQC exige acuerdo de proveedor de conectividad + certificación (externo · docs EQC de Expedia · consultado 2026-09-14). El comentario «v3 JSON» del v1 era incorrecto: EQC es XML. |
| Channex (agregador) | `adapters/channex.adapter.ts` · REST JSON | simulador | simulador (validación estructural JSON, ver §2) | cableado contra `CHANNEX_BASE_URL` (staging por defecto) | **Vía realista a producción**: staging self-service, certificación documentada (externo · https://docs.channex.io · consultado 2026-09-14), conecta Booking/Expedia/Airbnb/Vrbo/Hotelbeds desde la cuenta Channex. |
| Airbnb · Vrbo · Hotelbeds | `adapters/via-channex.adapter.ts` | simulador Channex | simulador Channex | **rechazado** con mensaje: «se distribuye a través de Channex» | Sin API de conectividad self-service para un PMS pequeño. |

`packages/integrations/src/channel-manager.ts` (los `*_mock`) queda **deprecado**;
sigue existiendo por los tableros demo.

Nada sale a Internet salvo canal con `mode=real` **y** `CHANNEL_MAX_MODE=real`.

## 2. Decisión Channex

Booking.com no admite nuevos proveedores y Expedia exige un acuerdo de
conectividad (externo, consultado 2026-09-14). Channex (https://docs.channex.io,
consultado 2026-09-14) es un channel manager ya certificado en ambas con:

- API REST JSON con clave por cabecera `user-api-key`.
- Entorno **staging** (`https://staging.channex.io`) con alta self-service: se
  crea la propiedad, room types y rate plans, y se conecta una cuenta de
  pruebas de Booking.com sin paso comercial.
- Feed de reservas (`booking_revisions/feed` + `ack`) y webhooks.

Los adaptadores directos de Booking y Expedia quedan «contract-ready»: sus
builders y parsers se validan contra el simulador local, de modo que si
mañana aparecen credenciales solo cambia `Channel.mode` y las credenciales.

Qué es (y qué no es) esa validación: el simulador (`sandbox/simulator.ts`)
es una **validación estructural local** — un escáner de elementos/atributos
por regex, sin librería XML ni XSD — que comprueba raíz, contenedores,
atributos obligatorios y las reglas de negocio documentadas por cada
proveedor (importe 5..50.000, un `HotelCode` por petición, `Start ≤ End`,
fechas ≤ 5 años, campos obligatorios de Channex). **No sustituye la
certificación del proveedor.** Estado tras el cierre 2026-09-15 (sonda
`adapters-spec`, corregida por `fix:api-channel-manager`): los builders emiten
UN `RestrictionStatus` por `AvailStatusMessage` (tres mensajes por restricción,
XSD OTA 0..1) y el simulador rechaza con error 402 más de uno u offsets
malformados; `CurrencyCode`/`DecimalPlaces` van en `BaseByGuestAmt` (el
builder ya no los pone en `<Rate>`; el simulador no lo rechazaría);
`min_advance_days`/`max_advance_days` ya no se envían a Channex (aviso «no
admite restricciones de antelación»); la forma 422 parcial del simulador se
retiró: un aviso por valor es 200 + `meta.warnings[]` que ecoa el valor (ese
item queda `rejected`, el resto confirmado) y un error estructural es 400
`bad_request` (lote rechazado, nunca confirma nada). El tope de fechas de
Expedia (EQC) no está verificado: el simulador reutiliza el de 5 años de
Booking. El `xmlns` OTA ausente solo es `warning` a propósito (el ejemplo
oficial de Booking de `OTA_HotelAvailNotifRQ` va sin xmlns). Pendiente
comprobar en staging la forma exacta del objeto `warning` de Channex (el
parser tolera `warning` o `errors` y casa por `rate_plan_id`/`room_type_id` +
fecha o rango).

## 3. Qué pide cada extranet (credenciales por canal)

Las credenciales se guardan cifradas en `Channel.credentialsEncrypted`
(AES-GCM vía la extensión Prisma; `Channel` está en `PII_FIELDS`). El API
**nunca las devuelve**: `GET /channel-manager/channels/:id` responde
`hasCredentials` y `credentialKeys`.

| Canal | JSON de credenciales (`PATCH /channel-manager/channels/:id/credentials`) |
| --- | --- |
| booking_com | `{ "client_id", "client_secret", "hotelId", "webhookSecret"?, "simulator"? }` |
| expedia | `{ "username", "password", "hotelId", "webhookSecret"?, "simulator"? }` |
| channex | `{ "apiKey", "propertyId" (id de la propiedad en Channex), "webhookSecret"?, "simulator"? }` |
| airbnb / vrbo / hotelbeds | ninguna (van vía Channex) |

`simulator: { failEvery?: N, latencyMs?: ms }` solo actúa en stub/sandbox:
cada N-ésima petición responde 429 y una latencia ≥ timeout produce timeout
(para ensayar reintentos en la demo).

Deuda leída en lectura: si un canal v1 guardó `configurationJson.credentials`
en claro, `channels.service.readChannelCredentials` lo usa y lo marca
(`legacyPlaintextCredentials`); `channels:seed-sandbox` y el primer `PATCH
…/credentials` lo mueven al campo cifrado. Credenciales que ya no se pueden
descifrar (clave rotada sin backfill) se tratan como «sin credenciales» pero se
señalan: `credentialsUndecryptable` en el detalle y la readiness pide «vuelva a
guardarlas». Sin `hotelId` en las credenciales, Booking y Expedia rechazan el
push en sandbox y real sin gastar token exchange (`SBX-HOTEL` solo en stub).

## 4. Modos

| Modo | Qué hace | Credenciales |
| --- | --- | --- |
| `stub` | Construye el payload real y lo valida en el simulador; confirma sin credenciales. | No |
| `sandbox` | Igual que real hasta el transporte: el simulador hace la validación estructural local del payload (ver §2; no es la certificación del proveedor) y responde como él (errores por item, 429, timeout). | Sí (presentes, no se verifican contra nadie) |
| `real` | HTTPS al proveedor. | Reales |

`CHANNEL_MAX_MODE` (env, por defecto `sandbox` en todos los entornos) capa el
modo de todos los canales de la instancia; `real` hay que escribirlo a mano.
`readiness.service` informa cuando el modo pedido queda capado y el detalle
del canal devuelve `requestedMode` junto al efectivo. Un `PATCH` a `real` por
encima del tope se acepta y persiste (doble llave documentada) y se audita
(`CHANNEL_MODE_CHANGED`: actor, modo pedido, efectivo y tope): el canal saldría
a Internet solo con subir la variable, así que `CHANNEL_MAX_MODE=real`
únicamente en producción.

## 5. Outbox (ChannelDelivery) y estados

`enqueueRateGridPush({propertyId, from, to, channelIds, ratePlanIds?,
roomTypeIds?, kinds?, journalId?, actorUserId})` (delivery.service) genera una
`ChannelDelivery` por (canal, kind, tipo, plan | `*`, fecha) con el payload ya
traducido a códigos externos:

- `rates`: `{ externalRoomCode, externalRateCode, pricingModel, amount, occupancyPrices?, currency }`
  con `amount = base × (1 + markup del canal)`.
- `restrictions`: objeto fusionado (fila (canal, plan) > (canal, `*`) > (`*`, plan) > (`*`, `*`); flags en OR).
- `availability`: `InventoryDay.availableCount` (**0 si `stopSell`**) o, si no hay fila, habitaciones vendibles (activas, no bloqueadas por mantenimiento) − reservas `confirmed`/`checked_in` solapadas (`computeRealAvailability`).

Un canal con `status != active` no encola nada y devuelve un `warning`
(«Canal <providerCode>: inactivo, no se encola nada.»).

`idempotencyKey = sha256(channelId|kind|roomTypeId|ratePlanId|date|payloadHash)`:
mismo payload ya `queued/sending` (o `sent/confirmed` sin nada más nuevo) →
`skipped`; mismo payload con una fila anterior `rejected/timeout/superseded` →
**esa misma fila vuelve a `queued` con `attempts = 0`** (`REQUEUEABLE_STATUSES`,
`delivery.core.ts`); misma celda con payload distinto en cola
(`queued/timeout`, `SUPERSEDABLE_STATUSES`) → la anterior pasa a `superseded`;
productos sin mapeo → `warnings` por canal y tipo × plan (nunca silencio). El
retry manual (`POST /channel-manager/deliveries/:id/retry`) también reinicia
`attempts` a 0 (vuelve a disponer de los 5 intentos).

**Invariante (cierre 2026-09-15): la entrega más reciente por celda lleva el
payload actual de la parrilla.** `planDeliveries.place()` ejecuta SIEMPRE el
supersede de la fila pendiente con otro payload antes de decidir nada (antes,
volver a un valor ya confirmado dejaba la intermedia en cola: el canal se
quedaba con el 130 € y la parrilla con el 97 €, `sync-status` «confirmed»);
una fila `sent/confirmed` con el payload actual se REENCOLA si otra entrega
de la celda con otro payload la adelantó (`sending/sent/confirmed` con
`updatedAt` mayor); el reencolado re-estampa `created_at` (= orden de plan:
el drenaje envía la más antigua primero) y el `journalId`. Guardas de estado
dentro de la transacción: supersede solo desde `queued/timeout`, requeue nunca
desde `queued/sending` (`REQUEUE_FROM_STATUSES`), `writeOutcomes` solo sobre
filas que sigan `sending`; lo que no se pudo sustituir/reencolar (fila ya en
envío) sale en `warnings` de la respuesta y se envía después. Reglas de
contenido: no se encola una tarifa cuya moneda ≠ moneda de la propiedad ni un
mapeo `obp` sin `occupancyPrices` (warning agregado por producto);
`extraAdult`/`extraChild` no se emiten (warning explícito); `pricingModel:
"los"` → 400 al mapear; un stop sell de tipo (`RestrictionDay` `"*"`) fuerza
`count = 0` en `availability` incluso publicando solo `kinds:
["availability"]`. Los avisos del proveedor viajan en `AdapterResult.warnings`
y se guardan en `channel_sync_jobs.response_payload.warnings` (≤ 50).

Estados: `queued → sending → confirmed | rejected | timeout (reintento)`;
`superseded` cuando llega un valor más nuevo. `sent` existe en el contrato
(`DeliveryStatus`, `CellSyncStatus`, filtro `status` del listado) pero hoy no
lo escribe ningún adaptador ni el drenaje (`computeOutcomes` solo produce
`confirmed | rejected | timeout`): queda reservado para proveedores con ack
asíncrono.
Backoff 1 m, 5 m, 30 m, 2 h — o el `Retry-After` del proveedor (segundos o
fecha, `HttpResult.retryAfterMs`) si es mayor —; al 5.º intento fallido →
`rejected` («Reintentos agotados»). Solo reintentan fallos transitorios
(timeout, 429, 5xx, red, token exchange 0/429/5xx, EQC `<Error code 4xxx>`);
una respuesta 4xx del proveedor, un exchange 400/401/403 o un rechazo por item
es definitivo.

`getCellSyncMap(propertyId, from, to, channelIds?)` devuelve
`Map<"${ratePlanId}|${roomTypeId}|${date}", Record<channelId, CellSyncState>>`
(último `rates` por celda, sin `superseded`; `restrictions`/`availability`
plegados como peor estado). El editor lo pinta por celda y canal. `stale`
marca la celda cuya última entrega confirmada ya no coincide con el valor
actual de la parrilla (reversión o edición guardada sin publicar: se compara
el hash del payload actual con el entregado, sin códigos de mapeo); el editor
lo etiqueta «Pendiente de reenvío».

Drenaje: `startChannelDeliveryDrain({ intervalMs })` (líder de schedulers,
`CHANNEL_DRAIN_INTERVAL_MS`, `CHANNEL_DRAIN_DISABLED`) y `POST
/channel-manager/deliveries/drain`. Cada lote deja un `ChannelSyncJob`
(`push_rates` …) y cada pasada sella `CHANNEL_DELIVERIES_DRAINED` en auditoría.

Toma atómica (api-polish A4): cada pasada ejecuta UNA sentencia `UPDATE …
WHERE queued | timeout con nextRetryAt vencido | sending desde hace > 10 min
(STALE_SENDING_MS) … FOR UPDATE SKIP LOCKED … RETURNING`
(`drain.service.ts#claimChannelDeliveries`) que marca los candidatos
`sending` ANTES de enviar nada: dos instancias (líder :3000 y un drenaje
manual, o dos líderes sobre la misma BD) toman filas disjuntas. Las filas que
el token bucket del canal no deja enviar vuelven a `queued` al final de la
pasada (`releaseDeferred`); una fila `sending` de un worker caído se retoma a
los 10 min salvo que exista una entrega posterior de la misma celda: entonces
se retira como `superseded`. Antes de cada toma, `retireObsoleteDeliveries`
marca `superseded` (misma sentencia `FOR UPDATE SKIP LOCKED`) los reintentos
vencidos y las `sending` obsoletas adelantadas por otra fila de su celda
(`retiredObsolete` en el `DrainSummary`), y la toma excluye esos candidatos
(`NOT EXISTS`) devolviéndolos en orden de plan. Los `Date` ligados en el SQL
crudo (comparaciones y `updated_at`) van como `::timestamptz AT TIME ZONE
'UTC'`: con la sesión de Postgres en `Europe/Madrid` el cast ingenuo disparaba
el backoff hasta 2 h antes y dejaba `updated_at` 2 h en el futuro.
Retención: `CHANNEL_DELIVERY_RETENTION_DAYS` (int 1..3650, 30 por defecto): la
pasada SIN ámbito (líder del scheduler o administrador de plataforma) borra
las `superseded` más antiguas que el corte, como máximo una vez por hora por
proceso (`purgeSupersededDeliveries`; `purgedSuperseded` en el
`DrainSummary`); un drenaje de tenant nunca purga y ningún otro estado se
purga. `journal.pushStatus` (`draft | queued | pushed | partial | failed |
superseded`) se estampa `queued` al encolar algo y se recalcula desde las
entregas tras cada pasada y tras cada sustitución
(`refreshJournalPushStatuses`; reglas en
`delivery.core.ts#classifyJournalPushStatus`).

Alcance de `POST /channel-manager/deliveries/drain` (`distribution.sync`):
con `channelId` drena ese canal; sin él, un usuario de tenant drena los
canales de la propiedad de su sesión (respuesta `{ runs: DrainSummary[] }`) y
un administrador de plataforma drena toda la instancia (respuesta
`DrainSummary`).

## 6. Rutas

Prefijo `/channel-manager` y `/properties/:propertyId/channels` para el
editor. Ver `channel-manager.routes.ts` y `route-permissions.partial.ts`.
Webhook público `POST /channel-manager/webhooks/:provider/:channelId`
verificado con `X-Anfitorio-Webhook-Secret` (comparación en tiempo constante)
o `X-Anfitorio-Signature: sha256=<hex HMAC-SHA256 de los BYTES ORIGINALES del
cuerpo>` (hook `preParsing` de `channel-manager.routes.ts` → `request.rawBody`;
cuerpos > 1 MiB → 413; secreto `webhookSecret` en las credenciales; sin
secreto → 401 siempre) y que solo dispara un `pull-reservations`. Un HMAC
calculado sobre el cuerpo re-serializado (claves reordenadas) → 401
(`tests/integration/channel-outbox.test.mts`). Loopback público `POST
/channel-manager/_sandbox/:provider` (`?endpoint=`) para validar un XML OTA /
EQC o un JSON Channex a mano (entrada `public` en el partial de permisos Y en
`PUBLIC_PREFIXES`). `DELETE /channel-manager/channels/:channelId` es un
archivado lógico (`status: archived`, `autoPushOnSave: false`, historial
conservado, evento `CHANNEL_ARCHIVED`): 409 `CHANNEL_HAS_PENDING_DELIVERIES`
mientras haya entregas `queued/sending/timeout`; el canal desaparece de
`GET /properties/:id/channels` y un `POST` del mismo `providerCode` lo
revive. La firma del webhook se comprueba en `preParsing`, antes de cualquier
parser: JSON malformado + firma inválida → 401 (no 400); cuerpo > 1 MiB → 413 `Payload Too
Large` (`server.ts#errorLabels`). La tabla completa «ruta · permiso · riesgo»
está en `docs/runbooks/rate-grid-v2.md` §2.1.

Comportamiento por adaptador tras el cierre 2026-09-15:

- **Channex**: 200 con `meta.warnings[]` cuyo `warning{campo:[msg]}` ecoa un
  valor enviado → ese item `rejected`, los demás confirmados; cualquier 4xx
  (`errors.details` string[]) → lote rechazado, no confirma nada; no se emiten
  `min_advance_days`/`max_advance_days` (aviso); cada `rate_plan_id` de
  Channex pertenece a un solo tipo, así que un `externalRateCode` compartido
  entre tipos avisa en el upsert del mapeo y la readiness lo marca
  (`product_codes`: warn en stub/sandbox, error en `real`; el seed usa
  `RP-<plan>-<tipo>` para channex y Los Tilos está resembrado así).
- **Booking**: tres `AvailStatusMessage` por restricción (`Master` con
  `LengthsOfStay` y offsets `MinAdvancedBookingOffset`/
  `MaxAdvancedBookingOffset="nD"`, `Arrival`, `Departure`) repitiendo
  `StatusApplicationControl`; `buildRestrictionsNotif` devuelve
  `itemIndexByMessage` y el `RecordID` de cada `<Error>` se traduce al item
  (fuera de rango = error request-level, nunca confirma el item equivocado);
  `CurrencyCode`/`DecimalPlaces="2"` en `BaseByGuestAmt`; reservas por
  `GET https://secure-supply-xml.booking.com/hotels/ota/OTA_HotelResNotif?hotel_ids=`
  (host distinto del de ARI; un `BOOKING_API_BASE_URL` no-default sirve ambos,
  para mocks); token exchange 0/429/5xx reintentable, 400/401/403 definitivo.
- **Expedia**: la disponibilidad ya no emite `RoomType@closed` (solo el push
  de restricciones cierra); `<Success>` con `<Warning>` hijos = aplicado (aviso
  recogido); `<Error code 4xxx>` (errores de sistema EQC) reintentable con
  backoff, el resto definitivo; «Probar conexión» en `real` es una LECTURA
  (`BookingRetrievalRQ` a `/eqc/br`; la sonda AR de escritura solo en sandbox);
  avisa de que no admite restricciones de antelación.

## 7. Procedimiento de certificación Channex

1. Alta en https://staging.channex.io (self-service) → API key en Settings → API keys.
2. Crear la propiedad, room types y rate plans en Channex; anotar sus ids.
3. En Anfitorio: `POST /channel-manager/channels {providerCode:"channex", mode:"sandbox"}`,
   `PATCH …/credentials {apiKey, propertyId}`, mapear productos
   (`POST …/product-mappings` con los ids de Channex como `externalRoomCode` /
   `externalRateCode`; `pricingModel` `obp` si el rate plan es por ocupación).
4. `POST …/test` en sandbox (simulador) → readiness sin errores.
5. `CHANNEL_MAX_MODE=real`, `PATCH …/channels/:id {mode:"real"}`, `POST …/test`
   (real: `GET /api/v1/channels` con la clave).
6. Publicar un rango corto desde el editor → drenaje → `GET /channel-manager/deliveries`
   debe mostrar `confirmed`; comprobar en Channex → Inventory.
7. Conectar en Channex la cuenta de pruebas de Booking.com y repetir 6; pedir a
   Channex la revisión de certificación (checklist en su documentación:
   full sync inicial, reservas nuevas/modificadas/canceladas con `ack`,
   webhooks). Después `CHANNEX_BASE_URL=https://app.channex.io`.

## 8. Límites

| Proveedor | Límite declarado en `capabilities()` | Notas |
| --- | --- | --- |
| Booking.com | 1.000 mensajes/petición · 75 peticiones/min por canal | Cifras publicadas por Booking (externo · portal Connectivity · consultado 2026-09-14): ~10.000 req/min globales y 75–700/min por endpoint; `capabilities()` toma la conservadora 75/min. Token exchange ≤ 30/h (cache 55 min). |
| Expedia EQC | 500 updates/petición · 60/min | AR es todo-o-nada. |
| Channex | 1.000 values/petición · 60/min | 429 con `Retry-After`; el drain espera max(backoff, `Retry-After`). |

El `TokenBucket` en memoria por canal (drain.core, por proceso) aplica
`rateLimitPerMinute`; lo que no cabe ya se había tomado como `sending` y
vuelve a `queued` al final de la pasada para la siguiente (§5).

## 9. Seed de demo

`corepack pnpm --filter @hotelos/api channels:seed-sandbox -- --property <id>`
(dry-run) y `--apply --confirm <id>`: crea booking_com / expedia / channex en
sandbox con credenciales de simulación cifradas y un mapeo por (tipo activo ×
plan BAR) con códigos `BK-|EX-|CX-<tipo>` / `RP-<plan>`. Idempotente. Para
channex el código de plan es `RP-<plan>-<tipo>` (en Channex un rate plan
pertenece a un solo tipo); Los Tilos quedó resembrado así
(`RP-BAR-IND/DBL/DBM/SUI`). Con los ids reales de Channex se sustituyen los
placeholders; la readiness señala códigos compartidos en `product_codes`.

## 10. Pendiente (P2)

- `pull-reservations` deja `ExternalReservation`; no crea `Reservation` PMS
  (requiere mapeo inverso, huésped y folio).
- Tarifas por canal (override de celda por `channelId`) no persisten en
  `RateDay` (sin columna); hoy se aplica `defaultMarkupPercent`.
- Endurecer el simulador en lo que queda de §2 (o validar los XML contra los
  XSD OTA/EQC en tests unitarios) para que «pasa en sandbox» se acerque más a
  «pasa la certificación»; comprobar en staging la base del `RecordID` (0 vs
  1) y la forma del `warning` de Channex.
- Unificación de permisos `deliveries/enqueue`
  (`channel_manager.sync`) vs `rate-grid/push` (`distribution.sync`) y
  `readinessSummary` en español con fecha formateada (hoy llega en mayúsculas
  e ISO al hub).
