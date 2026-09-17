# Booking.com adapter (rate grid v2)

`apps/api/src/modules/channel-manager/adapters/booking.adapter.ts` +
`adapters/booking/xml.ts` + `adapters/booking/auth.ts`. Visión general de la
conectividad y de la decisión Channex en `docs/channel-manager-connectivity.md`.

## Estado honesto

Booking.com tiene **pausadas las altas de nuevos connectivity providers**
(externo · portal Connectivity de Booking · consultado 2026-09-14; revalidar
antes de contratar): ehotelOS no puede obtener `client_id`/`client_secret`
hoy. El adaptador está «contract-ready»: construye y parsea los mensajes OTA
2003B v1.1 y se valida contra el simulador local (`sandbox/simulator.ts`),
que hace una **validación estructural** (escáner por regex, sin XSD) y **no
sustituye la certificación de Booking** (diferencias conocidas en
`docs/channel-manager-connectivity.md` §2). El modo `real` está cableado y
sin usar. La vía a producción con Booking es Channex. Cierre de la
verificación adversarial 2026-09-15 (`fix:api-channel-manager`): los cambios
de builder/parser de esta página están en el working tree y los cubren
`adapters/__tests__/booking.test.mts` y `sandbox/__tests__/simulator.test.mts`.

## Modos (por canal, `Channel.mode`, capado por `CHANNEL_MAX_MODE`)

| Modo | Comportamiento |
| --- | --- |
| `stub` | Construye el XML real y lo valida en el simulador; no exige credenciales. |
| `sandbox` | Igual que real hasta el transporte: exige `client_id`/`client_secret`, el simulador hace la validación estructural del OTA XML (no la certificación de Booking) y responde `OTA_*RS` con `<Success/>` o `<Errors>` por mensaje (`RecordID`), 429 y timeouts según `credentials.simulator`. |
| `real` | Token exchange + POST XML a `BOOKING_API_BASE_URL`. |

Variables de entorno que SÍ lee el módulo (sección OTA de `lib/env.ts`):
`BOOKING_API_BASE_URL`, `BOOKING_OAUTH_URL` y `EXPEDIA_API_BASE_URL`, además
de las del partial (`CHANNEL_MAX_MODE`, `CHANNEX_BASE_URL`,
`CHANNEL_DRAIN_*`). Las del v1 (`BOOKING_ADAPTER_MODE`, `BOOKING_SANDBOX_URL`,
`BOOKING_OAUTH_SCOPE`, `EXPEDIA_ADAPTER_MODE`, `EXPEDIA_OAUTH_URL`, `AIRBNB_*`,
`HOTELBEDS_*`, `VRBO_*`) ya no se leen y han sido **retiradas del contrato**
(`ENV_CONTRACT`, `scripts/env-contract.json`, `.env.example`), no marcadas
`deprecated`: `scripts/validate-env.mjs` no avisa «obsoleta» si un `.env` de
campo las conserva (se ignoran en silencio; bórralas a mano). El comentario
de `channel-manager/env.partial.ts` («mark them deprecated in ENV_CONTRACT»)
describe la intención original, no el estado del contrato.

## Autenticación

```
POST https://connectivity-authentication.booking.com/token-based-authentication/exchange
Content-Type: application/json
{ "client_id": "...", "client_secret": "..." }   →   { "jwt": "..." }
```

JWT válido ~1 h: caché por canal 55 min, single-flight entre pushes
concurrentes, límite 30 intercambios/hora por canal (el 31.º falla en local).
`BOOKING_OAUTH_URL` sobreescribe el endpoint (ahora apunta a este exchange).
Un exchange con status 0 (red), 429 o 5xx es transitorio: las entregas quedan
`timeout` con backoff, no `rejected`; 400/401/403 es definitivo. Sin `hotelId`
en las credenciales, sandbox y real rechazan el push sin gastar exchange (el
`HotelCode` `SBX-HOTEL` solo existe en stub).

## Mensajes

| Operación | Endpoint (`BOOKING_API_BASE_URL`, por defecto `https://supply-xml.booking.com`) | Cuerpo |
| --- | --- | --- |
| Tarifas | `POST /hotels/ota/OTA_HotelRateAmountNotif` | `OTA_HotelRateAmountNotifRQ/RateAmountMessages[@HotelCode]/RateAmountMessage/StatusApplicationControl[@Start,@End,@InvTypeCode,@RatePlanCode] + Rates/Rate/BaseByGuestAmts/BaseByGuestAmt[@NumberOfGuests?,@AmountAfterTax,@DecimalPlaces="2",@CurrencyCode]` (moneda en `BaseByGuestAmt`, no en `<Rate>`; solo se envían tarifas en la moneda de la propiedad) |
| Disponibilidad | `POST /hotels/ota/OTA_HotelAvailNotif` | `AvailStatusMessages/AvailStatusMessage[@BookingLimit]/StatusApplicationControl[@Start,@End,@InvTypeCode]` |
| Restricciones | `POST /hotels/ota/OTA_HotelAvailNotif` | TRES `AvailStatusMessage` por item, cada uno con un solo `RestrictionStatus` (XSD OTA 0..1) y el mismo `StatusApplicationControl[+@RatePlanCode]`: `Master` (+ `LengthsOfStay/LengthOfStay[@MinMaxMessageType=SetMinLOS|SetMaxLOS|SetForwardMinStay,@Time]` y `@MinAdvancedBookingOffset`/`@MaxAdvancedBookingOffset="nD"`), `Arrival` y `Departure` (`@Status=Open|Close`) |
| Reservas | `GET https://secure-supply-xml.booking.com/hotels/ota/OTA_HotelResNotif?hotel_ids=…` (host de reservas distinto del de ARI; un `BOOKING_API_BASE_URL` no-default sirve ambos, para mocks) y `POST` del `OTA_HotelResNotifRS` de ack | `HotelReservation[@ResStatus=Commit|Modify|Cancel]/UniqueID[@ID]` … |

Los mensajes se numeran en el orden de emisión y `buildRestrictionsNotif`
devuelve `itemIndexByMessage`: el `RecordID` de cada `<Error>` del RS se
traduce al item y el drain marca solo esa `ChannelDelivery` como `rejected`;
un `RecordID` fuera de rango es un error request-level (nunca confirma el
item equivocado). Que `RecordID` sea el índice del mensaje (base 0) es una
convención del simulador: Booking documenta `Code`/`ShortText`/`Details` sin
`RecordID`, así que un `<Error>` sin él rechaza el lote entero; comprobar la
base (0 vs 1) en certificación. `closed` (plan) y `stopSell` (tipo) van ambos
a `RestrictionStatus Restriction="Master"` (Booking tiene un único cierre).

Reglas que el simulador aplica (subconjunto documentado por Booking, sin
XSD): importe 5..50.000, un solo `HotelCode` por petición, fechas ≤ 5 años
(«up to 5 years in future», externo · consultado 2026-09-14), `Start ≤ End`,
`RatePlanCode` obligatorio en tarifas; el `xmlns` OTA ausente solo es un
`warning` (el ejemplo oficial de `OTA_HotelAvailNotifRQ` de Booking va sin
xmlns). Tras el cierre 2026-09-15 el simulador rechaza (402 con `RecordID`)
más de un `RestrictionStatus` por `AvailStatusMessage` y offsets que no sean
`1D`/`12H`/`1D12H`; no rechaza `CurrencyCode` en `<Rate>` (el builder ya no lo
emite). Pasar el simulador no equivale a pasar la certificación.

## Credenciales (cifradas en `Channel.credentialsEncrypted`)

```json
{ "client_id": "...", "client_secret": "...", "hotelId": "12345678", "webhookSecret": "...", "simulator": { "failEvery": 0, "latencyMs": 0 } }
```

`PATCH /channel-manager/channels/:id/credentials` escribe; `GET` solo devuelve
`hasCredentials` y las claves presentes.

## Límites

`capabilities()`: 1.000 mensajes por petición, 75 peticiones/min por canal
(cifras publicadas por Booking, externo · consultado 2026-09-14: ~10.000
req/min globales y 75–700/min por endpoint; se toma la conservadora 75/min).
El drain trocea y aplica un token bucket por canal (por proceso).

## Tests

`adapters/__tests__/booking.test.mts` (simulador, token exchange con fetch
inyectado, clasificación 401/503/RecordID, reservas) y
`sandbox/__tests__/simulator.test.mts` (validación estructural OTA).
