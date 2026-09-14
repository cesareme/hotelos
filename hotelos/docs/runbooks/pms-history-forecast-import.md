# Runbook · `pilot:provision-property` + `import:pms-history-forecast` (alta de un hotel real y carga del History & Forecast de su PMS)

Fuente: `apps/api/src/scripts/provision-pilot-property.ts` (provisionador,
spec en `apps/api/src/scripts/specs/<hotel>.json`) y
`apps/api/src/scripts/import-pms-history-forecast.ts` (importador, script
pnpm `import:pms-history-forecast`), ambos con el patrón CLI de
`fix-demo-legal-identity.ts` (dry-run por defecto, `--apply --confirm <id>`,
`--json`, exit 0/1/2, entrypoint guard `entryFile === argFile`, cadena de
auditoría hidratada antes de `recordAuditEvent` y `flushAuditQueues` al
final). Primer uso: piloto Faranda Los Tilos
(`docs/pilots/FARANDA-LOS-TILOS-2026-09-14.md`). Los flags de este runbook
están copiados de la cabecera de uso de cada script (2026-09-14); si el
script cambia, manda su cabecera y hay que actualizar aquí.

## 1 · Qué hace cada script y en qué orden

| Paso | Script | Qué hace | Escribe en |
| --- | --- | --- | --- |
| 1 | `pilot:provision-property` | Crea una propiedad **dentro de una organización existente** con sus satélites (lo mismo que `createTenant` / `bootstrap`, pero **nunca** crea ni modifica `organizations.*` ni usuarios): `properties`, `user_property_roles` (usuarios existentes con un rol existente de la org), `departments` + `user_departments`, `ensurePropertySettings` (`property_ai_settings`, `property_compliance_settings`; `ensurePropertyTaxes` no-op si la org ya tiene el IVA de la región), `property_modules`, `buildings` + `floors`, `room_types`, `rooms`, `rate_plans` (BAR **sin** `rate_days`), `invoice_sequences`, `compliance_property_profiles` | tablas de configuración; 1 `audit_event` |
| — | **reiniciar el API** | `hydrateTenantMirrors` carga los espejos in-memory de tenants **solo al arrancar**: hasta reiniciar, la propiedad nueva no existe para el runtime (404/403 en rutas por propiedad) | — |
| 2 | `import:pms-history-forecast` | Lee el CSV del informe *History and Forecast* del PMS y escribe `history` en `revenue_daily_snapshots` (top-level) y `forecast` en `revenue_forecasts` (top-level), ambas marcadas con `--source` (`pms_import:*`); con `--publish-bar` deriva además una BAR de referencia en `rate_days` | `revenue_daily_snapshots`, `revenue_forecasts`, (`rate_days`); 1 `audit_event` (`corr_pms_import_<source>`) |
| 3 | readiness + board | `POST /backoffice/properties/:id/readiness/recalculate` y `GET /revenue/properties/:id/history-forecast/board` para cotejar cifras con el informe | `property_readiness_checks` |

Orden obligatorio: provisionar → reiniciar → importar. Importar antes de
reiniciar funciona a nivel de BD (Prisma directo) pero la verificación por
GET falla hasta el reinicio.

**Aviso operativo (cadena de auditoría):** ejecutar los dos CLI con los API
parados (:3000 y :3400 en el Mac; la única instancia en producción). Cada
script hidrata la cadena de `audit_events`/`event_stream` desde Postgres y
encadena su evento al tip real, pero las instancias en marcha guardan su tip
**en memoria** (deuda 12(c) de CLAUDE.md): si siguen arrancadas, su siguiente
evento enlaza al tip antiguo y la cadena se bifurca (válida como grafo,
no lineal). Si se acepta ejecutar con los API en marcha, hay que asumir esa
bifurcación y reiniciarlos justo después.

## 2 · Provisionador · `pilot:provision-property`

```bash
corepack pnpm --filter @hotelos/api pilot:provision-property -- --spec src/scripts/specs/faranda-los-tilos.json                                   # dry-run (default)
corepack pnpm --filter @hotelos/api pilot:provision-property -- --spec src/scripts/specs/faranda-los-tilos.json --apply --confirm cmrhw9jy30002fyvb6tsdiugt
corepack pnpm --filter @hotelos/api pilot:provision-property -- --spec src/scripts/specs/faranda-los-tilos.json --json
corepack pnpm --filter @hotelos/api pilot:provision-property -- --help
```

| Flag | Significado |
| --- | --- |
| `--spec <fichero>` | JSON con la ficha de la propiedad (obligatorio; ruta relativa a `apps/api`) |
| `--dry-run` | (default) valida el spec (`validateSpec`) e imprime el plan: qué filas se crearían, qué existe ya; no escribe |
| `--apply` | escribe; exige `--confirm` |
| `--confirm <organizationId>` | id exacto de la organización del spec; cualquier otro → `assertConfirmMatches` lanza **dentro de `runProvision`** → exit **1** («does not match the spec organizationId … Nothing written»), no 2 |
| `--json` | salida máquina |
| `--help` / `-h` | imprime la cabecera de uso y sale con 0; gana a cualquier otro flag, también a un `--spec` ausente (cierre 2026-09-14, `parseFlags` → `help: true`; antes era «Unknown flag» → exit 2) |

Códigos de salida: `0` ok · `1` fallo (org inexistente, usuario/rol no
pertenecen a la org, CP/INE incoherentes según `resolveFiscalLocation`,
Σ `count` ≠ `totalRooms`, `totalRooms` no divisible entre `building.floors`,
**`--confirm` distinto del `organizationId` del spec**, conflictos de
convergencia, BD inaccesible) · `2` flag desconocido (`parseFlags`), `--apply`
sin `--confirm`, `--confirm` sin `--apply`, spec ilegible.

### 2.1 · Spec JSON (`apps/api/src/scripts/specs/faranda-los-tilos.json`)

Bloques (las claves `_notes`, `_estimated`, `_estimatedReason` son
documentación dentro del spec y el script las ignora):

| Bloque | Contenido | Destino |
| --- | --- | --- |
| `organizationId` | org **existente** | nada: solo se lee |
| `property` | columnas 1:1 de `Property`: `name`, `legalName` (**`null`** en Los Tilos: el emisor de facturas cae a la razón social de la org, `issuer-identity.service`), `address`, `municipality`, `province`, `country`, `postalCode`, `ineMunicipalityCode`, `taxRegion`, `fiscalTerritory`, `timezone`, `sesHospedajesEnabled`, `verifactuEnabled` | `properties` |
| `profile` | `hotelType`, `autonomousCommunity`, `has*` → columnas de `CompliancePropertyProfile`; el resto (`starRating`, `brandAffiliation`, `tourismRegistry`, `plazas`, `phone`, `email`, `coordinates`, `built`, `renovated`, `hasBar`) no tiene columna y se guarda en `property_compliance_settings.configurationJson.pilotProfile` | `compliance_property_profiles`, `property_compliance_settings` |
| `owners[]` | `{userId, roleId}`: usuario y rol **existentes** de la org (los roles son por organización) | `user_property_roles` |
| `modules[]` | ids del catálogo `HOTEL_MODULES` a habilitar; los no listados quedan sin fila (= disabled por defecto del catálogo) | `property_modules` |
| `building` | `{name, code, floors}`: 1 edificio con N plantas «Planta n» (`floorNumber n`, code `P<n>`) | `buildings`, `floors` |
| `totalRooms` | total REAT (92); `validateSpec` exige Σ `roomTypes.items[].count == totalRooms` y divisible entre `floors` | — |
| `roomTypes.items[]` | `{code, name, baseCapacity, maxOccupancy, count, defaultRateCategory}`; upsert por `code` | `room_types` (ids `rt_*`) |
| `rooms[]` (opcional) | `{number, roomTypeCode}` explícito. Si falta, numeración determinista `planRooms`: plantas × (totalRooms/plantas) → `101…123, 201…223, 301…323, 401…423`; `x01`/`x02` → IND; `223/323/423` → SUI (la planta 1 no tiene suite); resto impar → DBL, par → DBM | `rooms` (`sellable=true`, `status clean`) |
| `ratePlans[]` | `{code, name, ratePlanType, mealPlan}`; el módulo revenue resuelve la BAR por `code "BAR"` o `ratePlanType "bar"` | `rate_plans` (sin `rate_days`) |
| `invoiceSequences[]` | `{sequenceCode, invoiceType, prefix, year}`; padding 6, `nextNumber 1`; FAC↔F1, REC↔R1 (`assertSeriesCodeMatchesType`) | `invoice_sequences` (unique `propertyId+sequenceCode+year`) |
| `departments[]` | `{code, name, users:[{userId, roleLabel}]}` | `departments`, `user_departments` |

Reglas: códigos de tipo únicos por propiedad; `postalCode` de 5 dígitos e
`ineMunicipalityCode` con el mismo prefijo de provincia (`resolveFiscalLocation`,
`backoffice.service.ts` ~1125; 15894 ↔ 15082 OK). Los datos «ESTIMADO»
(reparto por tipo, numeración) se marcan en el spec (`_estimated`) y en el
doc del piloto, nunca se presentan como verificados.

### 2.2 · Idempotencia

Reejecutar con el mismo spec es seguro: el script busca la propiedad por
`(organizationId, name)`; si existe, **no** crea otra y reporta por bloque lo
que ya está (`exists`/`skip`) y lo que falta (`create`): tipos por `code`,
habitaciones por **`number`** (`roomRows.find(x => x.number === r.number)`; el
`roomCode` se genera como `RM<number>` solo al crear), secuencias por
`sequenceCode+year`, módulos por `moduleId`, rol de usuario por
`(userId, propertyId)`, departamentos por `(propertyId, code)`. Un segundo
`--apply` converge: rellena campos `null`, salta los iguales y reporta como
**conflicto** (bloquea el apply) cualquier campo con un valor distinto. Con
Los Tilos ya provisionado, el dry-run reportaba 18 skips (propiedad,
rol, departamento, 6 módulos, edificio, 4 plantas, 4 tipos, plan BAR, 2
series) y, tras el fix del lote scripts del cierre (`capacityFill`: una
columna de capacidad **NULL** en la habitación toma el valor del tipo, una
con valor se respeta), 0 conflictos y `update rooms ×92` (capacidades por
habitación que el alta inicial dejó a NULL; antes del fix salían como
conflictos falsos). Nunca borra nada: deshacer un alta es una decisión
manual con backup (no hay `--revert` en el provisionador).

### 2.3 · Después del apply

1. Reiniciar el API (:3000 / :3400 según entorno).
2. En el log de arranque, `[revenue:daily-snapshot] N/M propiedades omitidas:
   … sin reservas (<propertyId>)` debe listar la propiedad nueva entre las
   omitidas por `skipped.noReservations`, nunca entre las escritas (§4, §6).
3. `GET /properties` con la sesión de Carmen debe listar las dos propiedades;
   comprobar con cuál arranca el JWT (fijado a la primera propiedad).

## 3 · Importador · `import:pms-history-forecast`

### 3.1 · Formato CSV

Columnas mapeadas **por nombre**, orden libre (`parseDelimited` de
`@hotelos/ai-tools`, `packages/ai-tools/src/onboarding/csv-parser.ts` ~74).
`REQUIRED_COLUMNS` (falta una → exit 1; columna repetida → exit 1):

```
date,section,totalOcc,arrRooms,compRooms,houseUse,deductIndiv,nonDedIndiv,deductGroup,nonDedGroup,occPct,revenue,adr,depRooms,dayUse,noShow,ooo,adlChl
```

`dow` es opcional (`OPTIONAL_COLUMNS`); columnas desconocidas → error.

- `date` `YYYY-MM-DD` real; `section` ∈ {`history`, `forecast`}.
- Contadores (`totalOcc … adlChl`) deben ser **enteros** (`Number("9.0") = 9`
  se acepta; `9.5` no) y **no negativos** (error). `occPct`, `revenue`, `adr`
  decimales con punto (coma decimal **no**).
- Fechas: sin duplicados (`duplicate_date`, error) y contiguas (`gap`,
  error).
- Invariantes del informe comprobadas fila a fila (aviso, no bloquean):
  `deductIndiv+nonDedIndiv+deductGroup+nonDedGroup = totalOcc`;
  `occPct ≈ (totalOcc−houseUse)/(rooms−ooo)·100` (tolerancia
  `OCC_TOLERANCE_PP` 0,06 pp); `adr ≈ revenue/(totalOcc−houseUse)`.
- `revenue` negativo → aviso `negative_revenue` («ajuste del PMS, se importa
  tal cual»).
- Filas `forecast` con fecha `< hoy` → aviso `forecast_in_past` y se omiten
  (ya son historia). Las filas `history` se escriben tal cual (los lectores
  del board solo miran días `< hoy`).

#### Cómo obtener el CSV desde el PDF de Opera (pasos genéricos)

1. Exportar el informe **History and Forecast** del PMS en PDF con el rango
   deseado (Opera lo genera con cabecera por página y una fila por día;
   secciones «History», «History Total», «Forecast», «Forecast Total»,
   «Total»).
2. `pdftotext -layout "<informe>.pdf" informe.txt` (poppler; `-layout`
   conserva las columnas alineadas).
3. Parsear `informe.txt` con un script (python) que: (a) ignore cabeceras
   repetidas por página y las filas de totales, (b) detecte la sección por
   los rótulos «History»/«Forecast», (c) parta cada línea por espacios
   múltiples en las 19 columnas del informe, (d) normalice fecha
   `DD/MM/YY` → `YYYY-MM-DD` y números (`1,234.56` → `1234.56`; negativos con
   signo o paréntesis), (e) escriba el CSV con la cabecera anterior.
4. Validar antes de importar: número de filas = días del rango, sumas por
   sección iguales a las filas «History Total» / «Forecast Total» del PDF
   (Σ `totalOcc`, Σ `revenue`), y las tres invariantes de arriba (el propio
   dry-run del importador las repite y lista los avisos).
5. Guardar PDF + CSV en `/Users/cfernandez/anfitorio-demo/pilots/<hotel>/`
   (carpeta `/pilots/` en el `.gitignore` de la raíz: datos reales, nunca al
   repo).

### 3.2 · Uso y flags (cabecera del script, 2026-09-14)

```bash
# dry-run (default)
corepack pnpm --filter @hotelos/api import:pms-history-forecast -- --file <csv> --property <id> --rooms 92 --source opera_hf_2026-09-14 --publish-bar BAR
# apply
corepack pnpm --filter @hotelos/api import:pms-history-forecast -- --file <csv> --property <id> --rooms 92 --source opera_hf_2026-09-14 --publish-bar BAR --apply --confirm <id>
# reversión (dry-run / apply); rate_days solo con --force
corepack pnpm --filter @hotelos/api import:pms-history-forecast -- --property <id> --source opera_hf_2026-09-14 --revert
corepack pnpm --filter @hotelos/api import:pms-history-forecast -- --property <id> --source opera_hf_2026-09-14 --revert --publish-bar BAR --force --apply --confirm <id>
corepack pnpm --filter @hotelos/api import:pms-history-forecast -- --help
```

| Flag | Significado |
| --- | --- |
| `--file <csv>` | informe exportado del PMS (obligatorio salvo `--revert`) |
| `--property <id>` | propiedad destino, debe existir (obligatorio) |
| `--rooms <n>` | inventario con el que el PMS calculó el informe: base del occ % de la invariante y del `revpar` (obligatorio salvo `--revert`; Los Tilos = 92) |
| `--source <s>` | id del lote; se normaliza al espacio `pms_import:` (`opera_hf_2026-09-14` → `pms_import:opera_hf_2026-09-14`; default `pms_import:opera_hf_<hoy>`); se guarda como `snapshot.dataSource` y `forecast.modelVersion`; sin espacios |
| `--section history\|forecast\|both` | qué sección escribir (default `both`) |
| `--from` / `--to` | restringe las filas escritas a ese rango inclusive (YYYY-MM-DD) |
| `--publish-bar <code>` | además deriva la BAR de referencia en `rate_days` del plan con ese `code` (§3.3) |
| `--force` | sobrescribe snapshots de **otro** `dataSource` y borra forecasts de **otro** `modelVersion` en el rango (los lista); con `--revert`, borra también los `rate_days` que escribió la herramienta |
| `--revert` | borra lo que escribió `--source` (snapshots + forecasts; `rate_days` solo con `--force`) en vez de importar |
| `--dry-run` | (default) parsea, valida, planifica; no escribe |
| `--apply` | escribe; exige `--confirm <propertyId>` igual a `--property` |
| `--json` | salida máquina |
| `--help` / `-h` | imprime la cabecera de uso y sale con 0; gana a cualquier otro flag (cierre 2026-09-14, `parseFlags` → `help: true`; antes «Unknown flag» → exit 2) |

Códigos de salida: `0` ok · `1` fallo (errores de validación del CSV,
propiedad o plan inexistente, error de BD) · `2` flag desconocido, valor
inválido, `--apply` sin `--confirm`, `--confirm` ≠ `--property` (aquí sí
se comprueba en `parseFlags`, a diferencia del provisionador),
`--revert --publish-bar` sin `--force`.

### 3.3 · Qué escribe exactamente

- `history` → `revenue_daily_snapshots` top-level (`roomTypeId/ratePlanId/channelId/segment/market = NULL`),
  find-then-write con `TOP_LEVEL_SNAPSHOT_WHERE` (`actuals.ts` ~176-182):
  **nunca** `upsert` por el unique (Postgres trata las dimensiones NULL como
  distintas y crearía duplicados). Columnas 1:1 con el informe (`totalOcc`
  con house use, `arrivalRooms`, `departureRooms`, `compRooms`,
  `houseUseRooms`, `dayUseRooms`, `noShowRooms`, `oooRooms`, los cuatro
  `…IndividualRooms/…GroupRooms`, `adultsChildren`) + `roomRevenue =
  netRoomRevenue = totalRevenue = revenue` + `adr` y `occupancyPercent` del
  PMS + `revpar = revenue / rooms` + `dataSource = pms_import:<source>`.
  Regla por día (cabecera del script):

  | Fila top-level existente | Acción |
  | --- | --- |
  | ninguna | `create` |
  | mismo `dataSource` | `update` (re-import idempotente) |
  | `night_audit` con 0 habitaciones y 0 revenue | `update` con aviso (artefacto del scheduler en una propiedad sin reservas) |
  | cualquier otro `dataSource` (`demo`, `night_audit` con datos, otro `pms_import:*`) | `skipped protected` salvo `--force` |

- `forecast` → `revenue_forecasts` top-level: `expectedRoomsSold = totalOcc`
  (**con** house use, `mapRowToForecast` ~470; decisión del cierre 2026-09-14:
  coherente con la historia, donde `totalOcc` del snapshot también lo
  incluye, y con el board, que recalcula `fcOccPct`/`fcAdr` sobre esa cifra;
  el `expectedAdr` del PMS, calculado sobre las pagadas, se guarda explícito y
  es el que se muestra — Los Tilos: Σ 1.637, no 1.586). El forecast **no lleva
  pax**: `RevenueForecast` no tiene campo para `adlChl` (solo el snapshot
  guarda `adultsChildren`). `expectedOccupancy = occPct`, `expectedAdr = adr`,
  `expectedRoomRevenue = expectedTotalRevenue = revenue`, `expectedRevpar =
  revenue / rooms`, `confidence = 80` (`FORECAST_CONFIDENCE`), `modelVersion =
  pms_import:<source>`, `driversJson = [{ "driver": "adr_source", "value":
  "pms_forecast" }]`. Escritura en una transacción: `deleteMany` de las filas
  top-level del **mismo** `modelVersion` en el rango + `createMany`; otros
  `modelVersion` (`deterministic-v1`) no se tocan sin `--force`.
- `--publish-bar <code>`: `rate_days` del plan con ese `code` para cada tipo
  activo, horizonte `[hoy, hoy+365)` (`BAR_HORIZON_DAYS`), precio = ADR del
  PMS del día (forecast) → si no hay, ADR del mismo día del año anterior
  (d−364, d−371) → si no, media del mes; × multiplicador por tipo
  (`RATE_CATEGORY_MULTIPLIERS`: standard 1, suite 1,5;
  `SINGLE_ROOM_MULTIPLIER` 0,85 para `baseCapacity 1`). Días sin candidato
  (0 habitaciones, ajuste negativo) se saltan. Filas marcadas `updatedBy =
  usr_system_pms_import` (`RateDay` no tiene otro campo de origen). Es una
  BAR **de referencia**, no el tarifario del hotel.
- Auditoría: `hydrateAuditChainFromPostgres()` antes de `recordAuditEvent`
  (`correlationId corr_pms_import_<source>`, con conteos, rango, sumas y
  hash del fichero) y `flushAuditQueues()` al final. No lanzar dos `--apply`
  a la vez.

### 3.4 · Idempotencia y reversión

- Re-importar el mismo CSV con el mismo `--source` converge: el dry-run
  reporta `update N · create 0` y el forecast se reemplaza por el mismo
  contenido; las cifras no cambian.
- Un CSV corregido con el mismo `--source` sobrescribe los días presentes;
  los snapshots de días que ya no estén en el CSV **no** se borran (usar
  `--revert` primero si el rango se acorta). El forecast sí se reemplaza en
  el rango escrito.
- `--revert --source <id>` deja la propiedad como antes de la importación
  para ese lote (borra solo `pms_import:<id>`; nunca `night_audit`, `demo` ni
  `deterministic-v1`). Los `rate_days` derivados solo se borran con
  `--revert --publish-bar <code> --force`. Es la reversión oficial; nunca
  `DELETE` manual.
- Cambiar de source (`opera_hf_2026-10-01`) sin revertir el anterior deja los
  días solapados como `skipped protected`: revertir el antiguo o importar solo
  el rango nuevo con `--from/--to`.

## 4 · Protecciones alrededor de los datos importados (código del lote api de esta tanda, sin commit a 2026-09-14)

| Componente | Comportamiento | Dónde |
| --- | --- | --- |
| `writeDailySnapshot` / scheduler nocturno | `decideSnapshotWrite`: (1) propiedad **sin ninguna reserva** → `skipped no_reservations` (nada escrito; evita un cierre a 0 que enterraría la historia importada); (2) fila top-level existente con `dataSource ≠ night_audit` → `skipped protected` salvo `{force:true}`. `writeYesterdayDailySnapshotsForAllProperties` devuelve `skipped.noReservations` / `skipped.protected` y lo loguea (`[revenue:daily-snapshot] N/M propiedades omitidas: … sin reservas · … con cierre protegido`) | `apps/api/src/modules/revenue/hf-board.service.ts` (`decideSnapshotWrite`, `NIGHT_AUDIT_DATA_SOURCE`) · `server.ts` ~8635-8656 |
| `backfill:snapshots` | propiedad sin reservas → `skippedNoReservations` (nunca forzable); día con `dataSource ≠ night_audit` → `skippedProtected` salvo `--force`. **Nunca** `--force` sobre una propiedad con `pms_import:*` | `apps/api/src/scripts/backfill-snapshots.ts` |
| `generateForecasts` | `forecastDeleteFilter`: el `deleteMany` del rango excluye `modelVersion LIKE 'pms_import:%'` (y lista explícitamente los `NULL`); además el generador **no escribe su curva en los días cubiertos** por un forecast importado (evita doble fila por día) y los reporta como `skippedImported` | `apps/api/src/modules/revenue/forecast.service.ts` (`PMS_IMPORT_MODEL_PREFIX`, `isImportedForecastModelVersion`) |
| `adrSourceFromDrivers` | reconoce `pms_forecast`; una fila con `modelVersion pms_import:*` sin driver también se etiqueta `pms_forecast` («previsión del PMS (importada)»), nunca «sin previsión» | `forecast.service.ts` (`adrSourceFromDrivers(drivers, modelVersion)`) |
| `demo:refresh` | actúa por predicados AUDIT; no conoce `pms_import:*`. Comprobar el dry-run antes de cada `--apply` posterior al alta | `apps/api/src/scripts/refresh-demo-dataset.ts` |
| Lectores | usan `snapshotDate = dayUtc(YYYY-MM-DD)` y solo días `< hoy`; `adr/occupancyPercent/revpar` del snapshot prevalecen si no son NULL | `actuals.ts` ~214-368, `hf-board.service.ts` ~243-948, `forecast.service.ts` ~283-380 |

Tests que fijan estas reglas (sin BD):
`apps/api/src/modules/revenue/__tests__/snapshot-protection.test.mts`,
`…/forecast-protection.test.mts`, `apps/api/src/scripts/__tests__/*.test.mts`
con el fixture `apps/api/src/scripts/__tests__/fixtures/pms-history-forecast-sample.csv`
(`corepack pnpm --filter @hotelos/api test`).

## 5 · Verificación tras importar

```bash
# segundo dry-run con el MISMO --source: update N · create 0 · 0 skipped protected (los días ya cargados se
# reconocen por dataSource; con otro --source saldrían como skipped protected, §3.4)
corepack pnpm --filter @hotelos/api import:pms-history-forecast -- --file <csv> --property <id> --rooms 92 --source <source>
```

```sql
SELECT data_source, count(*), min(snapshot_date), max(snapshot_date), round(sum(net_room_revenue),2), sum(total_occ)
FROM revenue_daily_snapshots
WHERE property_id = '<id>' AND room_type_id IS NULL AND rate_plan_id IS NULL AND channel_id IS NULL AND segment IS NULL AND market IS NULL
GROUP BY 1;
SELECT model_version, count(*), round(sum(expected_room_revenue),2), sum(expected_rooms_sold) FROM revenue_forecasts WHERE property_id = '<id>' GROUP BY 1;
SELECT count(*), min(date), max(date) FROM rate_days rd JOIN rate_plans rp ON rp.id = rd.rate_plan_id
WHERE rp.property_id = '<id>' AND rp.code = 'BAR';
```

Y `GET /revenue/properties/<id>/history-forecast/board?from=…&to=…` para un
mes cerrado: el total va en `rows[]` con `rowType "total"` (no hay `.totals`):
`jq '.rows[] | select(.rowType=="total")'`. Habitaciones, revenue y llegadas
deben coincidir con las filas «History Total» del PDF; el **ADR y el occ % del
total no**: el board los recalcula sobre `totalOcc` con house use y base
`totalRooms` (Los Tilos agosto: ADR 99,73 y 60,59 % frente a 104,57 y
63,29 % del PMS). Las filas diarias sí llevan el ADR/occ % del PMS, y
`GET …/period-metrics` (cierre 2026-09-14) devuelve `adr` sobre `paidRooms`
(104,57). Cifras esperadas de Los Tilos en el doc del piloto §4 paso 5.

## 6 · Estado actual (Los Tilos, verificado por SELECT y curl el 2026-09-14 tras el cierre)

- Propiedad Los Tilos: **provisionada** · propertyId: `cmu1mifcp0000fyo1wzvq7txo` · apply 2026-09-14 21:15:57 CEST (`audit_events` `aud_321d4e0b` `PROPERTY_PROVISIONED`, `corr_pilot_los_tilos`; API parado) · backup previo: `backups/hotelos-pre-los-tilos-20260914-210102.dump` (252 tablas).
- Salida de `pilot:provision-property --spec src/scripts/specs/faranda-los-tilos.json` (dry-run **antes del alta**): 15 escrituras previstas · 0 skips · 0 conflictos · 92 habitaciones (IND=8 · DBL=41 · DBM=40 · SUI=3) · WARN reparto de tipos ESTIMADO. **Hoy** (propiedad existente) el mismo dry-run reporta 18 skips (propiedad, rol, departamento, 6 módulos, edificio, 4 plantas, 4 tipos, plan BAR, 2 series) y, con el fix del lote scripts del cierre, 0 conflictos y `update rooms ×92` (capacidades); antes del fix salían conflictos falsos en las habitaciones (§2.2).
- Salida de `… --apply --confirm cmrhw9jy30002fyvb6tsdiugt`: [pilot:provision-property] APPLIED · spec src/scripts/specs/faranda-los-tilos.json · 158 ms · propiedad creada cmu1mifcp0000fyo1wzvq7txo «Faranda Los Tilos, Ascend Hotel Collection» · 15 escrituras (properties 1, user_property_roles 1, departments 1, user_departments 1, property_modules 6, buildings 1, floors 4, room_types 4, rooms 92, rate_plans 1, invoice_sequences 2, compliance_property_profiles 1, property_ai_settings 1, property_compliance_settings 1+1) · errores 0 · audit PROPERTY_PROVISIONED (corr_pilot_los_tilos). Post-condiciones por SELECT: rooms sellable 92 · room_types 4 · user_property_roles 1 · property_modules enabled 6 · buildings 1 · floors 4 · rate_plans 1 · invoice_sequences 2 (FAC-LT-2026-, REC-LT-2026-).
- Reinicio del API (:3000 y :3400) tras el import, ~21:20 CEST · log de arranque: `[revenue:daily-snapshot] 2/4 propiedades omitidas: 2 sin reservas (prop_canary, cmu1mifcp0000fyo1wzvq7txo) (escritas: 2)`.
- Salida de `import:pms-history-forecast … --rooms 92 --source opera_hf_2026-09-14 --publish-bar BAR` (dry-run): 457 filas (409 history · 12.698 rn · 1.139.904,23 € · ADR 97,24 · 37,97 % ; 48 forecast · 1.637 rn · 150.622,88 € · ADR 94,97) · sha256 852f2297… · snapshots 409 create · forecasts 48 · BAR 1460 rate_days (365 × 4 tipos) · 5 avisos (3 revenue negativo, 2 compRooms ≠ houseUse).
- Cierre (2026-09-14 ~21:5x CEST, API parado): `pilot:provision-property … --apply --confirm cmrhw9jy30002fyvb6tsdiugt` → «update rooms ×92 — capacidad desde el tipo» (`Audit aud_a7d15b21`), rooms sin capacidad 0; dry-run posterior: 0 escrituras · 19 sin cambios · 0 conflictos · exit 0. Tercera pasada de BAR `… --section forecast --publish-bar BAR --apply` con la regla de representatividad también en la rama forecast: «forecast 35 (13 no representativos) · STLY d−364 239 · d−371 31 · media mes 60», rate_days 1460 (min 44,06 · mediana 99,43 · max 285,95), `Audit aud_13f7e385`.
- `--apply --confirm cmu1mifcp0000fyo1wzvq7txo` (historia+forecast, 383 ms): snapshots escritos 409 · forecasts escritos 48 · `Audit: aud_c26df67f (corr_pms_import_pms_import:opera_hf_2026-09-14)`. Segunda pasada `--section forecast --publish-bar BAR --apply` tras afinar `deriveBarPrice` (≥ 5 habitaciones pagadas y banda 0,6–1,8× del ADR del mes; antes un día con 3 habitaciones a 326,88 € se colaba como BAR): forecasts reescritos 48 · rate_days 1460 (origen: forecast 41 · STLY d−364 233 · d−371 31 · media de mes 60) · `Audit: aud_ba80b998`. Verificado por SELECT: 409 snapshots `pms_import:opera_hf_2026-09-14` (Σ 12.698 rn · 1.139.904,23 €), 48 forecasts (Σ 1.637 · 150.622,88 €), 1460 rate_days `updated_by = usr_system_pms_import` (mediana 99,61 €).
- SELECT de verificación (2026-09-14, tras el cierre): snapshots `pms_import:opera_hf_2026-09-14 | 409 | 2025-08-01 | 2026-09-13 | 1139904.23 | 12698` (Σ `house_use_rooms` 976) · forecasts `pms_import:opera_hf_2026-09-14 | 48 | 150622.88 | 1637` (`expectedRoomsSold` con house use, §3.3) · rate_days BAR `1460 | 2026-09-14 | 2027-09-13` (mediana 99,61 €) · rooms vendibles 92 (`101|RM101`, `102|RM102`, `103|RM103`) · series `FAC | FAC-LT-2026-`, `REC | REC-LT-2026-` · reservas 0.
- Readiness (`GET /backoffice/properties/<id>/readiness`, foto del `recalculate`): `status ready` · `blockingCount 0` · 17 checks en `pass`, de ellos 7 por «No aplica»/informativos (`invoice_sequence_configured` «módulo de facturación y cumplimiento no activado», Payment Vault, SES ×2, VeriFactu, IPSI, certificado AEAT stub). Es `ready` porque SES/VeriFactu están desactivados: al activarlos volverán a bloquear.
- Board agosto 2026 (`rows[rowType="total"]`): roomsSold 1728 · roomRevenue 172338.23 · arrivals 855 · departures 847 · ooo 248 · adr 99.73 · occPct 60.59 · revpar 60.43 (el PMS da ADR 104,57 sobre 1.648 pagadas y 63,29 % base 92 − OOO: divergencia de base documentada en el doc del piloto §4/§5; `period-metrics` añade `paidRooms` y ADR sobre pagadas en el cierre, lote revenue). Board septiembre: roomsSold 600 · roomRevenue 66236.67 · fcRooms 861 · fcRevenue 76729.68 · `months[2026-09].projectedRevenue` 142966.35.
- API corregida en el cierre (lotes api/revenue; efectiva en :3400 al reiniciar): `history-forecast/report` mantiene `REPORT_MAX_DAYS = 120` pero una ventana mayor responde HTTP 400 con el límite en el mensaje en vez de truncar (`parseReportWindow` → `parseRevenueWindow`, `actuals.ts`); `?from/?to` malformados, día inexistente o `to < from` → 400 tipado (la instancia en marcha aún devuelve 500); `period-metrics` devuelve `paidRooms`, `houseUseRooms` y `adr = roomRevenue / paidRooms` (104,57 en agosto), `roomsSold` sigue con house use.
