# Runbook · OPERA Cloud en modo sombra (Tanda 7b · `pms-shadow`)

Fuente: diseño [`docs/design/OPERA-CLOUD-MODO-SOMBRA.md`](../design/OPERA-CLOUD-MODO-SOMBRA.md)
(§1 resumen, §2 las tres vías, §3 datasets y columnas confirmadas, §4 mapeo, §5 semántica de
sincronización y reconciliación, §6 implementación, §7 guía para César, §8 riesgos, §9 revisión,
§10 desvíos de implementación). Rutas, permisos y límites: [`docs/api-contracts.md`](../api-contracts.md)
(bloque «Modo sombra OPERA Cloud (Tanda 7b)»). Código: modelo en
`packages/database/prisma/schema.prisma` (bloque «OPERA Cloud · modo sombra», tablas
`pms_shadow_profiles`, `pms_shadow_links`, `pms_shadow_runs`, `pms_shadow_revenue_imports`,
`pms_shadow_alerts`), contrato wire `packages/shared/src/pms-shadow-types.ts`, perfil preinstalado
`packages/shared/src/pms-shadow-profiles/opera-cloud.ts`, modo `sync` del importador de reservas
`apps/api/src/modules/pms/reservation-import.*.ts` (Tanda 7), ingresos diarios
`apps/api/src/modules/pms-shadow/revenue-import.{parser,posting,service}.ts` + lector XML
`apps/api/src/lib/xml-lite.ts`, rutas y manifiesto `apps/api/src/modules/pms-shadow/{pms-shadow.routes,
route-permissions.partial}.ts`, CLI `apps/api/src/scripts/pms-shadow-pull.ts` (script pnpm
`pms-shadow:pull`), job del líder en el API, panel «Modo sombra OPERA» en Configuración › Módulos e
integraciones (pestaña de `ModuleManager`). Este runbook sustituye a la guía §7 del diseño como
documento operativo: los pasos en OPERA son los de §7 con las correcciones de §9 y §10.

Estado 2026-09-17: runbook escrito en paralelo con los lotes L1 (modo `sync`) y L2 (ingresos) y
antes de L3 (rutas, ingest, CLI, job) y L4 (panel). Las rutas, cuerpos y códigos de este documento son
los que fija el plan de la Tanda 7b y los que el integrador cruza por `grep` con el código tras L3:
si un nombre difiere, manda el código y hay que corregir aquí. **Todos los datos son ficticios**:
código de hotel OPERA `RIAS` (Rías Altas), huéspedes `@example.com`, sociedad CELUISMA S.A., centro
RA `cmrhw9jy40003fyvbuu2ec2w7`, buzón `opera-rias@example.com`, host SFTP `sftp.example.com`.

## 1 · Qué es el modo sombra y qué NO hace

**Qué es.** OPERA Cloud sigue siendo el **sistema de registro** del hotel: recepción, folios,
facturas, VeriFactu (vía partner fiscal a través de OFIS) y night audit ocurren en OPERA. ehotelOS
recibe **cada día** un corte (feed) de reservas (llegadas y próximos 30 días, en casa, salidas, nuevas /
canceladas / no-show del día anterior), los ingresos del día por transaction code y, con menos
frecuencia, estadísticas para conciliar; nunca escribe en OPERA; ante conflicto **gana OPERA**. Cada
fichero recibido es un `PmsShadowRun`; cada reserva conocida tiene un `PmsShadowLink` (clave natural:
propiedad + nº de confirmación de OPERA); cada día de ingresos es un `PmsShadowRevenueImport` con su
asiento; cada desviación es una `PmsShadowAlert` que se resuelve en el panel con motivo. Objetivo:
que el día del cambio de PMS ehotelOS ya tenga el histórico, las reservas futuras y la contabilidad
de gestión conciliados, y mientras tanto sirva de cuadro de mando y contabilidad PGC / USALI.

| Vía | Dónde | Para qué | Quién |
| --- | --- | --- | --- |
| **B1 · Informes por e-mail** (día 1) | Report Scheduler de OPERA → buzón `opera-<código>@…` → conector de correo con propósito `pms_shadow` (§4, §10) | reservas, cambios y conciliación, a diario y sin coste Oracle | César en OPERA (1 h por hotel); Dirección o Administrador en ehotelOS |
| **B2 · Exports por SFTP** (día 1 para ingresos) | Exports de OPERA → SFTP del VPS → agente `pms-shadow:pull` → `POST /integrations/pms-shadow/ingest` con clave de API (§5) | XML de ingresos `GEN_XMLBO_REVENUE` y, opcionalmente, reservas | César en OPERA + Toolbox; operador del VPS |
| **A · Manual** (arranque y contingencia) | panel «Modo sombra OPERA» › «Subir corte» o Reservas › Importar con perfil OPERA (§6) | cualquier informe descargado a mano | Dirección, Administrador; Recepción solo por Reservas › Importar |
| **C · OHIP REST** (fase 2) | fuera de esta tanda | deltas intradía, perfiles, disponibilidad | — |

**Qué NO hace, a propósito:**

- **No escribe en OPERA** ni tiene credenciales de OPERA: solo lee ficheros que OPERA produce.
- **Nada se borra.** Una reserva que desaparece del corte genera una alerta (`OPERA_MISSING_IN_SNAPSHOT`),
  nunca una cancelación automática (§7.5). Los asientos de ingresos se **revierten**, no se borran.
- **0 correos a huéspedes.** Las reservas sincronizadas nacen sin `bookerEmail` (como en la Tanda 7) y
  las actualizaciones (`updateReservationShadow`) no emiten eventos de dominio: ningún `ReservationCreated`
  / `ReservationConfirmed` que dispare la confirmación por correo (`event-hooks.service.ts:48-69`).
- **Sin facturas ni VeriFactu en ehotelOS** para estos ingresos: las emite OPERA + partner fiscal. El
  asiento diario (§8) es contabilidad de gestión conciliable con el Trial Balance, no facturación; los
  25 documentos y 33 envíos VeriFactu de Faranda no se tocan (§12).
- **Sin cargos de folio**: el check-in y el check-out sombra no cargan ni cobran nada (los cargos viven en
  OPERA); el ingreso entra agregado por día (§8), no por reserva.
- **Sin SES Hospedajes** desde ehotelOS para reservas `opera:*`: se sigue enviando desde OPERA / partner.
- **No guarda los ficheros** (GDPR, como la Tanda 7): se procesan en memoria y se descartan; los
  registros, alertas y JSON citan nº de confirmación, códigos OPERA, métricas e importes, nunca nombre,
  e-mail, teléfono ni documento. `NAME_ON_CARD` no se lee jamás.

## 2 · Prerrequisitos en OPERA Cloud (una vez por cadena; diseño §7.1)

1. **OPERA Controls.** General › `SCHEDULED REPORTS [REPORT_SCHEDULER]` activo (informes programados).
   Exports › `GENERAL EXPORTS [GENERAL_EXPORTS]` activo y suscripción `OPP_EXP` (si no aparece el menú
   Miscellaneous › Exports, pedirlo a Oracle). Sin `OPP_EXP` solo hay vía B1 (informes) y A (manual).
2. **Tasks del rol** que configure y programe: Miscellaneous › Exports › New/Edit General Exports,
   Generate General Exports, New/Edit Export Schedules, Download Exports y View Exports with Sensitive
   Data; report group tasks de Arrivals, Departures, Guests In-House, Financials, End of Day y
   Configuration.
3. **Usuario permanente** para programar: los informes dejan de generarse si el usuario que los programó
   queda inactivo en Identity Management. Crear una cuenta de servicio (p. ej. `anfitorio.scheduler`)
   que no caduque con una baja de personal.
4. **SFTP (solo vía B2), sin SR a Oracle.**
   (a) Toolbox › System Setup › Outbound › **Outbound Domain Allowlist** › New: Context Property
   (Global exige la task «Global Outbound Domain Allowlisting»), Hostname = `sftp.example.com` (host
   SFTP de ehotelOS), Protocol SFTP, Port 22 › Save; un usuario con la task «Approve Outbound Domain
   Allowlisting» aprueba la entrada «Awaiting Approval» (Actions › Approve); «Processing may take up to
   6 hours»: dejarlo el día anterior.
   (b) Toolbox › System Setup › **SFTP Configuration** › New: Context Property, SFTP Code (p. ej.
   `ANFITORIO_RIAS`), Host Name `sftp.example.com`, Port 22, Authentication Key, Username
   (`opera-rias`), **Private Key** (OPERA es el cliente SFTP: ehotelOS genera un par de claves por
   hotel, entrega la privada por canal seguro y pone la pública en `authorized_keys` del VPS), Host Key
   (salida de `ssh-keyscan -p 22 sftp.example.com`), Folder Name/Path por hotel (`/opera/rias/`),
   Validate cada carpeta antes de guardar.
5. **Datos que necesitamos antes de empezar** (§14): Hotel Code de Property Controls de cada hotel
   (`RIAS` en este runbook), hora habitual del night audit por hotel, y los listados de configuración
   de §3.1 para rellenar el mapeo.

## 3 · Alta en ehotelOS paso a paso

### 3.1 · Perfil «Modo sombra OPERA» (Configuración › Módulos e integraciones › Modo sombra OPERA)

Permiso: `integrations.connect` (Propietario, Dirección, Administrador). El panel es una pestaña de
`ModuleManager`; la misma configuración va por `GET|PUT /properties/:propertyId/pms-shadow/profile`.

1. **Código de hotel OPERA** (`operaHotelCode`): el Hotel Code de Property Controls, p. ej. `RIAS`. Es
   el `hotel_code` del XML de Revenue y el que identifica el hotel en cada fichero; si un fichero de
   ingresos trae otro código → 409 `PMS_SHADOW_REVENUE_HOTEL_MISMATCH`.
2. **Feeds y horas** (`scheduleJson.feeds[]`): por cada feed esperado, `feed`, `expectedTime` («HH:mm»,
   hora local del hotel), `businessDateOffset` (`-1` si el informe llega tras el night audit con datos
   del día anterior, `0` si trae el día en curso) y `required` (solo los `required` generan
   `OPERA_FEED_LATE` a la hora prevista + 120 min, `PMS_SHADOW_FEED_LATE_GRACE_MINUTES`). Ejemplo para
   Rías Altas con night audit a las 05:00:

   | `feed` | Informe / export | `expectedTime` | `businessDateOffset` | `required` |
   | --- | --- | --- | --- | --- |
   | `arrivals` | `res_detail` (llegadas +30) o `RESPONSYS_RESV_AUTO` | `06:00` | `0` | sí |
   | `departures` | `departure_all` con Date Option = business date **− 1** (salidas de ayer, ya «Checked Out» tras el night audit) | `06:00` | `-1` | sí |
   | `inhouse` | `gibyroom` | `06:10` | `0` | no (hasta tener la muestra) |
   | `changes` | `resreservyesterday` + `rescancel` + `nanoshow` | `06:10` | `-1` | no (hasta tener la muestra) |
   | `revenue` | `GEN_XMLBO_REVENUE` (SFTP) o `findeptcodes` | `06:30` | `-1` | sí |
   | `stats` | `manager_report` + `trial_balance` | `06:30` | `-1` | sí |

   Por qué `departures` va con `-1` (SC-07): el informe del business date en curso a primera hora lista
   las salidas todavía en casa («Due Out», que el sync deja en `checked_in`) y nunca «Checked Out»; el
   check-out sombra (§7.3) solo se produce con el informe del día anterior generado tras el night audit.
   Un perfil creado antes de esta corrección puede tener `departures` con `0`: cámbialo a `-1` en el
   panel (Perfil › Programación) o con `PUT …/pms-shadow/profile`.

3. **Mapeo de códigos maestros** (`mappingJson`, diseño §4.2): `roomTypes` (Room Type OPERA →
   `RoomType.code`; **obligatorio** para cada tipo que aparezca en un corte, si no la fila queda en error
   `RESERVATION_IMPORT_ROW_ROOM_TYPE_UNKNOWN` y el corte emite la alerta `OPERA_ROOM_TYPE_UNMAPPED` con los
   códigos), `pseudoRoomTypes` (`PM`, `HOUSE`…: filas omitidas, no son inventario), `rateCodes` (Rate Code →
   `RatePlan.code`; sin entrada ni `RatePlan.code` igual → tarifa por defecto BAR + aviso de fila
   `RESERVATION_IMPORT_ROW_OPERA_RATE_CODE_UNMAPPED` y alerta `OPERA_RATE_CODE_UNMAPPED` con los códigos; sin
   tarifa BAR activa la fila queda en error), `marketCodes` (→ segmento: `FIT`/`IND` → `leisure`, `CORP` → `corporate`,
   `GRP` → `group`), `sourceCodes` (→ canal: `BDC` → `booking_com`, `EXP` → `expedia`, `WEB`/`BE` →
   `direct`, `TA` → `agency`), `paymentTypes` (`CA` → `cash`, `VI`/`MC`/`AX` → `credit_card`, `CL`/`AR` →
   `company_invoice`). Los diccionarios del perfil preinstalado traen estos ejemplos; cada hotel completa
   los suyos con los listados `cf_roomtypes`, `cf_ratecodeheader`, `cf_marketcodes`, `cf_sourcecodes`,
   `cf_trxcodes1` (§14).
4. **Transaction codes → cuentas PGC + USALI** (`trxMappingJson[]`, diseño §4.3): una entrada por
   código con `code`, `description`, `transactionType`, `kind` (`revenue` · `tax` · `payment` · `ignore`),
   `accountCode` y `usaliDepartment` (solo `revenue`: `rooms` · `fnb` · `other_operated` · `misc_income`).
   El panel resalta «sin mapear» y el importador de ingresos **bloquea el día** con un código sin entrada
   (`OPERA_TRX_CODE_UNMAPPED`, §8). Ejemplo mínimo (ficticio) de Rías Altas:

   | `code` | `description` (OPERA) | `transactionType` | `kind` | `accountCode` | `usaliDepartment` |
   | --- | --- | --- | --- | --- | --- |
   | `1000` | Room Revenue | Lodging | `revenue` | `705.1` | `rooms` |
   | `2000` | Breakfast | Food and Beverage | `revenue` | `705.2` | `fnb` |
   | `3000` | Parking | Other Revenue | `revenue` | `705.3` | `other_operated` |
   | `8010` | VAT 10% | Tax | `tax` | `477.10` | — |
   | `8021` | VAT 21% | Tax | `tax` | `477.21` | — |
   | `9000` | Cash | Payment | `payment` | `570` | — |
   | `9010` | Visa/MC | Payment | `payment` | `5721` | — |
   | `9500` | Paid Out | Paid Out | `ignore` | — | — |

5. **Buzón y carpeta** (informativos para el panel): `inboxEmail` (`opera-rias@example.com`) y
   `sftpFolder` (`/srv/sftp/opera/rias`, ruta local en el VPS que recorre el CLI).
6. Guardar: `PUT /properties/:propertyId/pms-shadow/profile` con `{ operaHotelCode, status: "active" |
   "paused", mappingJson, trxMappingJson, scheduleJson, inboxEmail?, sftpFolder? }` (`.strict()`; cuerpo
   parcial admitido: lo que no viaja no cambia). En `paused` el ingest responde 409
   `PMS_SHADOW_PROFILE_PAUSED` y el job no reclama feeds ni emite `OPERA_FEED_LATE`. Sin perfil, todas
   las rutas `pms-shadow` de la propiedad responden 404 `PMS_SHADOW_PROFILE_NOT_FOUND`.

### 3.2 · Clave de API para el ingest (`DeveloperApp` con scope `pms.shadow.ingest`)

Solo la necesitan la vía B2 (agente SFTP) y cualquier integración propia. Desde Desarrolladores ›
Aplicaciones (`/developer/apps`, permiso `developer.manage_webhooks`: Propietario, Administrador):

1. `POST /developer/apps` con nombre (`OPERA sombra · Rías Altas`), tipo y **un scope ligado al centro**:
   `scopes: ["pms.shadow.ingest:<propertyId>"]` (`pmsShadowIngestScopeFor(propertyId)`; varios centros =
   varias entradas). Una app por hotel: si su clave se filtra, solo puede escribir en ese centro (SEC-04).
   El scope a secas `pms.shadow.ingest` (`PMS_SHADOW_INGEST_SCOPE`) admite cualquier centro de la
   organización y se reserva a una integración central. La respuesta muestra `clientId` y `clientSecret`
   **una sola vez**; el secreto se guarda con hash (`DeveloperApp.clientSecretHash`, schema.prisma:2082-2095).
2. La clave que usa el agente es `<clientId>.<clientSecret>` en la cabecera `X-Api-Key`
   (`PMS_SHADOW_INGEST_HEADER`). Guardarla en el VPS fuera del repositorio (`~/.config/anfitorio/pms-shadow.env`,
   permisos 600); nunca en un ticket ni en el `.env` del repo.
3. Rotación: `POST /developer/apps/:appId/rotate-secret`; después actualizar el agente. Una app
   revocada, sin el scope, de otra organización o ligada a otro centro (`pms.shadow.ingest:<otro>`) →
   401 `PMS_SHADOW_INGEST_UNAUTHORIZED` (un solo mensaje); una propiedad que no es de la organización de
   la app → 404 opaco (no se confirma que exista).

### 3.3 · Buzón con propósito `pms_shadow` (vía B1)

Un buzón **dedicado por hotel** (`opera-rias@example.com`), nunca el de reservas de recepción: el
conector con propósito `pms_shadow` no pasa por la extracción con IA ni por la cola HITL, entrega el
adjunto al importador. Desde IA › Correo entrante o por API
(`POST /properties/:propertyId/email/connections`, `integrations.connect`):

```json
{ "provider": "gmail", "emailAddress": "opera-rias@example.com", "purpose": "pms_shadow",
  "fromDomain": "oracle.com", "subjectContains": "RIAS" }
```

- `provider`: `gmail` | `microsoft` | `imap` (con `host`, `port`, `username`, `password`) | `manual`.
  Gmail y Microsoft exigen las credenciales OAuth del entorno (`GET /email/connections/:id/authorize-url`).
- `purpose: "pms_shadow"` se guarda en `EmailConnection.configJson.purpose` (creado en esta tanda; hasta
  ahora `configJson` solo llevaba `host`/`port`/`username` del IMAP, `email-reservation.service.ts:384`);
  sin `purpose` la conexión sigue siendo la de reservas por IA.
- `fromDomain` (**obligatorio** con `purpose: pms_shadow`, 400 `VALIDATION_ERROR` si falta: dominio del
  remitente del Report Scheduler, **a confirmar con la primera entrega real**; sin él cualquier remitente que
  conociera la dirección del buzón y el Hotel Code podría contabilizar ingresos o cancelar reservas) y
  `subjectContains?` (texto del asunto, p. ej. el código de hotel; recomendado) filtran qué correos se
  consideran cortes. El filtro compara el texto del `From`: la verificación DKIM/SPF (`Authentication-Results`
  de Gmail / Graph) queda pendiente (§13); los feeds que escriben (`revenue`, `changes`) deberían entrar por
  SFTP + clave de API. Un correo sin adjunto reconocido (`.csv`, `.txt`, `.xml`, `.xlsx`) o que no encaja con ningún
  feed → alerta `OPERA_FEED_UNRECOGNIZED` y el correo se deja marcado, sin reintentos.
- El sondeo lo hace el scheduler «mailbox poll» existente (cada 5 min bajo el líder,
  `MAILBOX_POLL_DISABLED` / `MAILBOX_POLL_INTERVAL_MS`); la descarga de adjuntos se añade en esta tanda
  a `fetchGmail` / `fetchGraph` / IMAP. Cada adjunto → `PmsShadowRun` con `source: "email"` y
  `createdBy: usr_system_pms_shadow`.

## 4 · Informes programados por e-mail (vía B1; diseño §7.2)

Reports › Manage Reports › Manage Scheduled Reports › New, Report Language Español, Repeat cada 1 Days
a las 06:00 hora del hotel (tras el night audit; ajustar por hotel), destino Email =
`opera-rias@example.com` y **además** SFTP si ya está configurado («One entry per Mode is allowed»: un
destino por modo, varios modos a la vez). **Un solo File Format por programación**: un informe en XML
y PDF son dos programaciones.

| # | Informe (`código`) | Formato | Parámetros (Date Option + Offset) | Feed en ehotelOS | Estado del perfil |
| --- | --- | --- | --- | --- | --- |
| 1 | Departures (`departure_all`) | Delimited Data | fecha = business date **− 1** (salidas de ayer, ya «Checked Out»; con + 0 a primera hora llegan «Due Out» y el check-out sombra no se produce, SC-07 en §3.1) | `departures` (offset `-1`) | 19 columnas confirmadas; fichero **sin fila de cabecera** (`headerOverride`, §6.2) |
| 2 | Arrivals: Detailed (`res_detail`), Include Checked-In Today, Display solo Room Number y Print Rate, Sort Room No. | Delimited Data | llegadas de business date + 0 a + 30 | `arrivals` (`horizonDays` 30) | columnas **no publicadas**: pendiente de muestra (paso 5). Mientras tanto, `RESPONSYS_RESV_AUTO` por SFTP (33 columnas confirmadas) |
| 2b | Arrivals: Detailed (`res_detail`), mismos parámetros, Repeat cada 7 Days | Delimited Data | llegadas de business date + 0 a + 540 | `arrivals` (`horizonDays` 540, snapshot semanal) | idem |
| 3 | Guests In-House By Room Number (`gibyroom`), Display Revenue | Delimited Data | — | `inhouse` | pendiente de muestra |
| 4 | Reservations - Made Yesterday (`resreservyesterday`), Reservation Cancellations (`rescancel`), No Shows of the Day (`nanoshow`) | Delimited Data | business date − 1 | `changes` | pendiente de muestra |
| 5 | Financial Payment and Revenue (`findeptcodes`) | **XML** (modelo de datos); Delimited Data solo si la muestra demuestra que los subtotales no rompen filas | business date − 1 | `revenue` (si no hay `GEN_XMLBO_REVENUE`) | columnas confirmadas (Trn. Code, Description, Day Gross, Day Net…); elementos XML pendientes de muestra |
| 6 | Trial Balance (`trial_balance`) | XML; segunda programación en PDF | business date − 1 (obligatorio < business date) | `stats` (Transaction Total Today → cuadre del asiento) | elementos XML pendientes de muestra; **no se puede regenerar**: añadirlo también al e-mail de End of Day Final Reports |
| 7 | Manager Report (`manager_report`) | XML; segunda programación en PDF | business date − 1 | `stats` (Arrival Rooms, Departure Rooms, Rooms Occupied, % Rooms Occupied, No Show Rooms, Room Revenue, Total Revenue, ADR) | elementos XML pendientes de muestra |

Canal alternativo para 6 y 7 sin Report Scheduler: Administration › Financial › Routine Management ›
End of Day Final Procedures and Reports permite, por informe del night audit, Destination Email, Email
Address, File Format y Frequency Daily.

**Paso 5 (imprescindible, antes de dejar nada programado):** generar cada informe **una vez a mano**
con Download As › Delimited Data **y** PDF y enviárnoslos (junto con el XML de Revenue de un día) para
cerrar las columnas del perfil: Oracle no publica las de `res_detail`, `gibyroom`,
`resreservyesterday`, `rescancel` ni `nanoshow` en Cloud. Hasta entonces esos feeds están `undefined` en
el perfil y un fichero suyo responde 400 `RESERVATION_IMPORT_PROFILE_UNSUPPORTED_FEED`. Si al elegir
Delimited pide delimitador, usar coma. Con la muestra, el integrador añade el mapeo y un test de
contrato que fija la cabecera recibida; a partir de ahí una cabecera distinta → `OPERA_FEED_COLUMNS_CHANGED`.

## 5 · Exports por SFTP (vía B2; diseño §7.3) y el agente `pms-shadow:pull`

### 5.1 · En OPERA

Miscellaneous › Exports › General › New from Template:

1. `GEN_XMLBO_REVENUE` («Generic XML Back Office-Revenue», End of Day) y, para días pasados, la variante
   «By Date» (el catálogo lista `GEN_XMLBO_REVENUE_DY` y `GEN_XMLBO_REV_DAY` con la misma descripción:
   preguntar a Oracle cuál está vigente). **No modificar nada salvo Actions › Delivery Configuration** →
   SFTP (SFTP Code `ANFITORIO_RIAS` + Folder `/opera/rias/`). Comprobar que el procedimiento End of Day
   `Generate_Export_NA_Data` está activo. Opcionales: `GEN_XMLBO_STATISTICS` (feed `stats` por room type).
2. Reservas por export (alternativa al informe 2): `RESPONSYS_RESV_AUTO` (Schedules › Daily, Hour 06;
   `.csv`; Delivery SFTP). Límites del scheduler: 5 exports por franja, 20 por día. `RESPONSYS_RESV_AUTO`
   **no incluye** canceladas, no-show ni waitlist: las cancelaciones llegan por `rescancel` (feed
   `changes`) o se detectan como ausencias (§7.5).
3. Sin SFTP: Actions › View Exports › Download cada día (cifrado 30 días) y subir por el panel (§6): vía A.

### 5.2 · En el VPS: carpeta por hotel y agente

Servidor OpenSSH con un usuario **por hotel** enjaulado en su carpeta (`/srv/sftp/opera/rias/`, clave
pública de OPERA en `authorized_keys`, sin shell). El agente es el CLI `pms-shadow:pull`, que recorre la
carpeta, sube cada fichero nuevo por el ingest HTTP y lo archiva:

```bash
corepack pnpm --filter @hotelos/api pms-shadow:pull -- --property <id> --folder <dir> [--feed auto] [--business-date YYYY-MM-DD] [--move-to procesados] [--dry-run|--apply] [--ingest-url http://localhost:3000 --api-key <clientId.secret>] [--json]
```

| Flag | Significado |
| --- | --- |
| `--property <id>` | propiedad de ehotelOS (`cmrhw9jy40003fyvbuu2ec2w7` para Rías Altas) |
| `--folder <dir>` | carpeta a recorrer (`/srv/sftp/opera/rias`); solo ficheros regulares `.csv`, `.txt`, `.xml`, `.xlsx`; ignora `procesados/` |
| `--feed auto` (defecto) | clasifica cada fichero por nombre y cabecera (`GEN_XMLBO_REVENUE*.xml` → `revenue`, cabecera `RESERVATION_ID,…` → `arrivals`, `departure_all` → `departures`…); un feed explícito (`--feed revenue`) fuerza el mismo para todos |
| `--business-date YYYY-MM-DD` | business date del corte; por defecto el más reciente entre el business date de ehotelOS (`business_dates."current_date"`, que en modo sombra no avanza) y hoy en la zona del hotel, corregido por el `businessDateOffset` del feed (misma regla que el conector de correo y el check-in) |
| `--move-to <dir>` | tras un 202 (o un 409 duplicado ya conocido) mueve el fichero a **esa carpeta tal cual** (sin subcarpeta por fecha; una ruta relativa se resuelve desde el directorio en que corre el CLI —`apps/api` con `pnpm --filter`—, así que conviene la absoluta: `/srv/sftp/opera/rias/procesados`; si ya existe un fichero con el mismo nombre se antepone una marca de tiempo); el cron de abajo **borra a los 30 días** lo que hay en `procesados/` (GDPR: nunca se conservan más) |
| `--dry-run` (defecto) / `--apply` | dry-run lista los ficheros con su tamaño y el feed clasificado (por nombre y por los primeros 4 KiB) sin llamar al API ni a la BD; `--apply` con `--ingest-url` sube por HTTP; `--apply` **sin** `--ingest-url` es el **modo directo**: llama al servicio en proceso con el usuario de sistema `usr_system_pms_shadow` (`source cli`), pensado para el arranque y la carga histórica **con los API parados** (cadena de auditoría in-memory, deuda 12(c) de `CLAUDE.md`) |
| `--ingest-url` + `--api-key` | endpoint y clave (`<clientId>.<clientSecret>`); si faltan se leen de `PMS_SHADOW_INGEST_URL` / `PMS_SHADOW_API_KEY` del entorno del agente (**preferible**: la clave en argv queda visible en `ps`, en el crontab y en el historial del shell; ponla en un fichero de entorno del cron con permisos 600). La carpeta se recorre con `lstat`: los enlaces simbólicos se ignoran. Con ingest el CLI **no toca la BD**: la cadena de auditoría la escribe el API (sin parar servidores) |
| `--json` | salida máquina (una línea por fichero: `{ file, feed, businessDate, status, runId | error }`) |

Salida 0 si todo subió (o 409 duplicado ya conocido), 1 si algún fichero falló (queda en la carpeta,
no se mueve). Cron de ejemplo en el VPS (cada 15 min, entre 06:00 y 12:00, log rotado):

```cron
*/15 6-12 * * *  cd /home/cesareme/projects/hotelos/hotelos && PMS_SHADOW_API_KEY=$(cat ~/.config/anfitorio/pms-shadow-rias.key) \
  corepack pnpm --filter @hotelos/api pms-shadow:pull -- --property cmrhw9jy40003fyvbuu2ec2w7 --folder /srv/sftp/opera/rias \
  --move-to procesados --apply --ingest-url http://localhost:3000 --json >> /var/log/anfitorio/pms-shadow-rias.log 2>&1
0 3 * * *  find /srv/sftp/opera/*/procesados -type f -mtime +30 -delete
```

Una carpeta por hotel y una línea de cron por hotel: nunca un cron con `--property` de un hotel sobre
la carpeta de otro (el XML trae `hotel_code` y el ingest lo contrasta con el perfil → 409
`PMS_SHADOW_REVENUE_HOTEL_MISMATCH`, pero los CSV de reservas no lo traen).

### 5.3 · El ingest (`POST /integrations/pms-shadow/ingest`)

Ruta **pública** (sin token de personal; prefijo en `PUBLIC_PREFIXES` de `auth-context.ts`), autenticada
solo por `X-Api-Key: <clientId>.<clientSecret>` de una `DeveloperApp` activa con scope
`pms.shadow.ingest`. Cuerpo JSON `.strict()`:

```json
{ "propertyId": "cmrhw9jy40003fyvbuu2ec2w7", "feed": "revenue", "businessDate": "2026-09-16",
  "fileName": "GEN_XMLBO_REVENUE_RIAS_20260916.xml", "contentBase64": "PD94bWwg…", "force": false }
```

| Campo | Regla |
| --- | --- |
| `propertyId` | obligatorio; debe pertenecer a la organización de la app |
| `feed` | `arrivals` · `inhouse` · `departures` · `changes` · `revenue` · `stats` · `auto` (clasificación por nombre y cabecera; no reconocible → 400 `PMS_SHADOW_FEED_UNKNOWN` + alerta `OPERA_FEED_UNRECOGNIZED`) |
| `businessDate?` | `YYYY-MM-DD`; por defecto el más reciente entre el business date de ehotelOS y hoy en la zona del hotel, más el `businessDateOffset` del feed (los ingresos toman la fecha del propio XML) |
| `fileName` | ≤ 200 caracteres; se guarda en el run (nunca el contenido) |
| `contentBase64` | bytes del fichero, ≤ 5 MiB reales (`PMS_SHADOW_MAX_FILE_BYTES`; 400 `PMS_SHADOW_FILE_TOO_LARGE`), ≤ 7·1024·1024 caracteres |
| `force?` | repite un fichero ya recibido para el mismo feed y día (crea un run nuevo) |
| `horizonDays?` | ventana del snapshot de llegadas (30 por defecto; 540 en el snapshot semanal): acota qué enlaces «deberían» estar en el corte (§7.5) |
| `declared?` | métricas declaradas por OPERA que acompañan al corte (claves de la tabla de reconciliación: `arrivals`, `departures`, `rooms_occupied`, `occupancy_pct`, `no_shows`, `revenue_total`, `revenue_rooms`, `tax_total`, `adr`, `revpar`, `reservations_made`, `cancellations`); el feed `stats` las extrae del XML de `manager_report` |
| `reconciliation?` | `{ transactionTotalToday }` del Trial Balance del mismo día para cuadrar el asiento (§8.4) |

Respuestas: **202** `{ runId, status, counts: { created, updated, unchanged, transitioned, skipped,
error }, alerts[] }` (el run se procesa **en línea**: nace `processing` y termina `done` · `partial` ·
`failed`; el 202 devuelve el estado final) · **401** `PMS_SHADOW_INGEST_UNAUTHORIZED` (clave ausente,
mal formada, app revocada, sin el scope o de otra organización) · **404** opaco (propiedad que no es de
la organización de la app o sin perfil: mismo cuerpo que una inexistente) · **409**
`PMS_SHADOW_RUN_DUPLICATE` (mismo fichero —sha256 del contenido—, mismo feed **y** mismo business date;
`details { runId, createdAt, status }`) · **409** `PMS_SHADOW_PROFILE_PAUSED` · **400**
`VALIDATION_ERROR` (clave desconocida, `feed` fuera del catálogo, base64 inválido, `businessDate` mal
formada) · **400** `PMS_SHADOW_FILE_UNREADABLE` / `PMS_SHADOW_FILE_TOO_LARGE`. El mismo fichero en
**otro** business date no es un duplicado: es un corte nuevo (§7.6, §13).

## 6 · Vía manual: subir un corte desde el panel o desde Reservas › Importar

### 6.1 · Panel «Modo sombra OPERA» › «Subir corte»

`POST /properties/:propertyId/pms-shadow/runs` (`integrations.connect`) con el mismo cuerpo del
ingest sin `propertyId` (`feed`, `businessDate?`, `fileName`, `contentBase64`, `force?`, `horizonDays?`,
`declared?`, `reconciliation?`) → 202 con el run (`source: "manual"`, `createdBy` = usuario). Sirve para
el arranque, para un día perdido (`OPERA_FEED_LATE`) y para repetir un fichero corregido (`force`). El
run aparece en `GET /properties/:propertyId/pms-shadow/runs` y su detalle
(`GET /properties/:propertyId/pms-shadow/runs/:id`) enlaza al lote de reservas
(`reservationImportId` → Reservas › Importar › Importaciones anteriores) o al lote de ingresos
(`revenueImportId`, §8).

### 6.2 · Reservas › Importar con perfil OPERA (asistente de la Tanda 7 en modo sincronizar)

`/recepcion/reservas/importar?modo=sync&perfil=opera_cloud&feed=arrivals&fecha=2026-09-16` abre el
asistente con el modo, el perfil, el feed y el business date fijados (la pantalla no usa react-router:
lee `window.location.search`; el botón «Subir corte manual» del panel enlaza así). Diferencias con el
modo crear ([`reservas-importacion.md`](reservas-importacion.md) §18):

- **Mapeo explícito del perfil**, no sugerido: el perfil «OPERA Cloud» fija columna a columna las 33
  cabeceras de `RESPONSYS_RESV_AUTO` y las 19 de `departure_all` (`OPERA_CLOUD_PROFILE.feeds`), porque
  `applyMapping` exige cabeceras literales y los sinónimos de la Tanda 7 habrían mapeado `RATE` →
  `tarifa` y `DISCOUNT_AMOUNT` → `importe_total`. La pantalla muestra el mapeo bloqueado; una cabecera
  que no coincide con la del perfil → 400 `RESERVATION_IMPORT_HEADER_MISMATCH` (y alerta
  `OPERA_FEED_COLUMNS_CHANGED` si el fichero llegó por el ingest).
- **Delimited Data = sin fila de cabecera**: el informe `departure_all` llega solo con datos; el perfil
  aporta `headerOverride` (las 19 cabeceras) y **la primera fila del fichero ya es un dato**. Un
  `res_detail` en Delimited (con cabecera) se mapeará cuando llegue la muestra.
- `feed` y `fecha` obligatorios en `sync` (400 `RESERVATION_IMPORT_SYNC_REQUIRES_FEED`); un feed sin
  perfil cerrado (`inhouse`, `changes` hoy) → 400 `RESERVATION_IMPORT_PROFILE_UNSUPPORTED_FEED`.
- La previsualización añade la columna **Acción** (`create` · `update` · `unchanged` · `transition` ·
  `skip`) y los contadores nuevos; el commit exige los **4 permisos** `pms.reservation.create` +
  `pms.reservation.modify` + `pms.checkin.execute` + `pms.checkout.execute` (§11).

## 7 · Semántica de sincronización (diseño §5.1-5.3 con las correcciones de §10)

### 7.1 · Clave, propiedad de la reserva y `bookingSource`

Clave natural: (`propertyId`, nº de confirmación OPERA) = `PmsShadowLink(propertyId, confirmationNo)`
(`@@unique`), el mismo valor que `Reservation.externalReference`. **Corrección respecto al diseño**:
las reservas creadas en `sync` llevan `bookingSource = "import:<importId>"` como cualquier lote de la
Tanda 7 (es la clave del lote y del deshacer: `bookingSourceOf` en `reservation-import.service.ts:286-288`,
usada en la creación, en `cancelLateCreations` y en el deshacer), **no** `opera:<hotel>`. Lo que marca
una reserva como «de OPERA» es el **enlace `PmsShadowLink`** (`reservationId @unique`), no el
`bookingSource`; `pmsShadowBookingSource("RIAS")` queda como etiqueta informativa del panel. Una reserva
con la misma `externalReference` **sin enlace** (creada en recepción, por un canal o por un lote en modo
crear) es una reserva local: la fila se omite con `RESERVATION_IMPORT_ROW_OPERA_CONFLICT_LOCAL_RESERVATION`
y se abre la alerta `OPERA_CONFLICT_LOCAL_RESERVATION` (Recepción decide: cancelar la local o dejar que
OPERA no la gobierne).

### 7.2 · Acción por fila (hash por fila)

Cada corte se procesa fila a fila, en serie, con el `analyse` de la Tanda 7 en modo `sync`:

| Situación | Acción | Qué se escribe |
| --- | --- | --- |
| sin enlace, estado destino `confirmed` / `checked_in` / `checked_out` | `create` | `createReservation` (camino único de la Tanda 7: lock, disponibilidad, código `RES-…`, huésped por documento / e-mail, folio, auditoría), `externalReference` = confirmación, `bookerEmail` vacío, `bookingSource import:<lote>`; alta del enlace (`firstImportId`, `rowHash`, `lastStatus`, `lastSeenAt`, `lastBusinessDate`); si el destino es `checked_in` / `checked_out`, transición en la misma fila (§7.3) |
| sin enlace, estado destino `cancelled` / `no_show` | `create` + `transition` | como la fila `cancelada` de la Tanda 7: se crea y se cancela / marca no-show en el commit (queda rastro y referencia sin consumir inventario) |
| sin enlace, `RESERVATION_STATUS` waitlist | `skip` | nada; aviso `RESERVATION_IMPORT_ROW_OPERA_WAITLIST_SKIPPED` |
| sin enlace, room type en `pseudoRoomTypes` (`PM`, `HOUSE`) | `skip` | nada; aviso `RESERVATION_IMPORT_ROW_OPERA_PSEUDO_ROOM` |
| con enlace y **mismo** `rowHash` | `unchanged` | solo `lastSeenAt`, `lastBusinessDate`, `lastImportId`, `missingStreak = 0` |
| con enlace y hash **distinto**, mismo estado | `update` | `updateReservationShadow` (`pms.service.ts`, aditiva): `arrivalDate`, `departureDate`, `roomTypeId`, `ratePlanId`, `adults` / `children`, `roomsCount`, `totalAmount`, `marketSegment`, `channel`, `groupCode`, `assignedRoomId`; **sin eventos de dominio ni correos**; el diff (campos, sin PII) va a `ReservationImportRow.warningsJson` |
| con enlace y estado destino distinto | `update` + `transition` | lo anterior y la transición de §7.3 |
| con enlace, reserva `cancelled` / `no_show` en ehotelOS y fila viva (`Reserved`…) | `create` (reactivación) | reserva **nueva** con `RESERVATION_IMPORT_ROW_REFERENCE_REUSED_CANCELLED`; el enlace pasa a apuntar a la nueva (decisión 4 de la Tanda 7) |
| fila sin nº de confirmación en un feed que lo exige (`arrivals`, `inhouse`, `changes`) | error | `RESERVATION_IMPORT_ROW_SYNC_REQUIRES_REFERENCE` |

El `rowHash` es sha256 de la fila normalizada (fechas ISO, códigos plegados, importes con dos decimales):
cambiar el orden de columnas o los espacios no altera el hash; cambiar una fecha, el tipo, la tarifa, la
ocupación, el importe estimado, la habitación o el estado sí.

**`importe_total` estimado.** `RATE` del export es la tarifa de la **primera noche**; el perfil no la
mapea a ningún campo (no hay 34.º campo `importe_noche`) y el modo `sync` la lee como columna auxiliar
para estimar `importe_total = RATE × noches × habitaciones` con el aviso
`RESERVATION_IMPORT_ROW_OPERA_TOTAL_ESTIMATED`. El importe real llegará en fase 2 (OHIP
`TotalCostOfStay`) o con `GEN_XMLBO_BILLS`; mientras tanto el ingreso contable no depende de él (§8).

**Estados.** El estado OPERA (cualquier grafía: `Reserved`, `DUE IN`, `Prospect`, `Checked In`, `IN
HOUSE`, `Due Out`, `Checked Out`, `Cancelled`, `No Show`, `Waitlist`…) se pliega y se traduce con
`OPERA_CLOUD_STATUS_MAP` a un **estado destino de sync** (`RESERVATION_SYNC_TARGET_STATUSES`: `confirmed`
· `checked_in` · `checked_out` · `cancelled` · `no_show` · `skip`), no a los tres estados del fichero de
la Tanda 7 (`confirmada` / `tentativa` / `cancelada`). `Prospect` y `Requested` → `confirmed` con
`RESERVATION_IMPORT_ROW_TENTATIVE_AS_CONFIRMED` y nota interna, como las tentativas de la Tanda 7.

### 7.3 · Transiciones y sus condiciones

| Transición OPERA | Acción en ehotelOS | Condición / si no se cumple |
| --- | --- | --- |
| → Cancelled | `transitionReservation(cancelled, "Cancelada en OPERA · <business date>")` | reserva `confirmed`. Si ya está `checked_in` / `checked_out` → **no se cancela**, aviso `RESERVATION_IMPORT_ROW_SYNC_CANCEL_AFTER_CHECKIN` y alerta (Recepción revisa en OPERA) |
| → No Show | `transitionReservation(no_show)` | reserva `confirmed` y business date ≥ llegada + 1; sin fee de ehotelOS |
| → Checked In | **check-in sombra**: `checkInReservation` (`pms.service.ts:1580`) con la habitación mapeada de `ROOM_NUMBER` / «Room No.» (si hay varias separadas por coma, la primera), firma centinela `signatureObjectKey = "opera:<confirmación>"` (no hay firma real: el registro se hizo en OPERA) y `allowEarlyCheckIn: true` en ambos sentidos (el corte puede llegar antes o después de la ventana de check-in del hotel) | habitación válida, disponible y del tipo (o compatible). Sin habitación válida → la reserva **permanece `confirmed`**, aviso `RESERVATION_IMPORT_ROW_OPERA_CHECKIN_WITHOUT_ROOM` + alerta `OPERA_CHECKIN_WITHOUT_ROOM`; el siguiente corte lo reintenta. Sin cargos de folio |
| → Checked Out | **check-out sombra**: `checkOutReservationDetailed` (`pms.service.ts:1782`) + cierre del folio primario si está a cero (mismo patrón que `POST /reservations/:id/check-out`, `server.ts:4849-4862`) → `checked_out`, folio `closed`, `Stay`. Si la reserva no estaba `checked_in` en ehotelOS (llegada pasada que nunca vimos) → camino `historical` de la Tanda 7: estancia cerrada atómica | sin importes de folio: el ingreso lo contabiliza §8, no la reserva |
| Checked In → Reserved, Checked Out → Checked In… (regresión) | **nada** | aviso `RESERVATION_IMPORT_ROW_SYNC_STATUS_REGRESSION`: OPERA no retrocede estados; casi siempre es un fichero viejo o del hotel equivocado |
| cambio de habitación de una reserva ya `checked_in` | **nada** en la habitación | aviso `RESERVATION_IMPORT_ROW_SYNC_ROOM_MOVE_IGNORED` (el traslado se hace en recepción con `move`, que es transaccional); el resto de campos sí se actualiza |
| fallo del `updateReservationShadow` | fila `error` | `RESERVATION_IMPORT_ROW_SYNC_UPDATE_FAILED` (mensaje sin valores); el bucle sigue |
| fallo de la transición | fila `error` | `RESERVATION_IMPORT_ROW_SYNC_TRANSITION_FAILED` (p. ej. habitación ocupada en el check-in sombra); la actualización de campos previa **se conserva** |

Por eso el commit en `sync` exige **cuatro permisos**: `pms.reservation.create` + `pms.reservation.modify`
(alta, actualización, `assignRoom`, cancelación) + `pms.checkin.execute` (`checkInReservation`) +
`pms.checkout.execute` (`checkOutReservationDetailed`). El usuario de sistema del job, del correo y del
ingest (`usr_system_pms_shadow`) los tiene.

### 7.4 · Reactivación

`Cancelled → Reserved` en OPERA (la reserva cancelada vuelve a estar viva) no reabre la reserva
cancelada de ehotelOS (el PMS no tiene esa transición): se crea una **nueva** con
`RESERVATION_IMPORT_ROW_REFERENCE_REUSED_CANCELLED`, el enlace pasa a apuntar a ella y la cancelada
conserva su historial. Lo mismo tras un deshacer del lote que la creó.

### 7.5 · Ausencias: alerta y `missingStreak`, nunca cancelación automática

Tras procesar un corte de reservas se revisan los enlaces cuya última llegada cae **dentro de la ventana
del corte** (`arrivals`: [business date, + `horizonDays`]; `departures`: salida = business date;
`inhouse`: en casa ese día) y que **no han aparecido** ni venían en `changes` como canceladas / no-show:

- `missingStreak += 1`. Con `missingStreak = 1` se abre `OPERA_MISSING_IN_SNAPSHOT` (`warning`, con nº
  de confirmación, feed y business date). Con 2 cortes consecutivos ausentes la alerta sube a `error`.
- **Nunca se cancela sola.** Recepción confirma en OPERA: si está cancelada, la cancela en ehotelOS
  desde la reserva (motivo «Cancelada en OPERA · confirmada manualmente») y resuelve la alerta; si sigue
  viva (p. ej. movida fuera de la ventana), resuelve la alerta con el motivo y el snapshot semanal la
  volverá a ver.
- Al reaparecer en un corte, `missingStreak` vuelve a 0 (la alerta abierta sigue abierta hasta resolverla
  con motivo: deja rastro de que OPERA la ocultó un día).

Una reserva con llegada **fuera** de la ventana del corte no cuenta como ausente: por eso existe el
snapshot semanal de horizonte completo (`horizonDays` 540, fila 2b de §4) y por eso no hay que subir un
`departure_all` como si fuera `arrivals`.

### 7.6 · Idempotencia por corte (feed + business date)

El hash del lote de reservas en `sync` es el de la Tanda 7 (filas normalizadas) **salado con el feed y
el business date**: el mismo fichero el mismo business date → 409 `RESERVATION_IMPORT_DUPLICATE` salvo
`force`; el mismo fichero **otro** business date (p. ej. un `res_detail` de +30 días sin ningún cambio
respecto a ayer) es un lote nuevo, legítimo, con todas sus filas `unchanged` (así los enlaces reciben
`lastSeenAt` / `lastBusinessDate` y no se abren ausencias falsas). El `PmsShadowRun` aplica la misma
regla con el sha256 del fichero crudo (`@@unique([propertyId, feed, businessDate, contentHash])` → 409
`PMS_SHADOW_RUN_DUPLICATE`).

### 7.7 · Deshacer

El deshacer de la Tanda 7 (`POST /properties/:propertyId/reservations/imports/:id/undo`) sobre un lote
`sync` cancela **solo lo creado** por ese lote (`bookingSource import:<id>` en `draft` / `confirmed`);
las actualizaciones y transiciones **no se deshacen** (OPERA manda; el diff queda en `warningsJson`); las
reservas con check-in / check-out sombra se conservan (`kept`). Tras deshacer, los enlaces de las reservas
canceladas quedan apuntando a reservas `cancelled`: el siguiente corte las tratará como reactivación
(§7.4).

## 8 · Ingresos diarios → asiento (diseño §4.3 y §6.4)

### 8.1 · Fuentes y lectura

| `source` | Fichero | Qué se lee | Notas |
| --- | --- | --- | --- |
| `xml_revenue` (preferente) | `GEN_XMLBO_REVENUE` / `GEN_XMLBO_REV_DAY` | `revenue{hotel_code,date}` › `transaction_total{transaction_type}` › `transaction_code`, `description`, `total_amount`, `total_guest_ledger`, `total_package_ledger`, `total_ar_ledger`, `total_deposit_ledger` | `trx_amount` es **neto sin impuestos** para ingresos (el impuesto va en su transaction code); importes con punto y signo «-» explícito; `hotel_code` ≠ perfil → 409 `PMS_SHADOW_REVENUE_HOTEL_MISMATCH`; `date` ≠ `businessDate` indicado → 409 `PMS_SHADOW_REVENUE_DAY_MISMATCH` |
| `findeptcodes_xml` | informe `findeptcodes` en XML | Trn. Code, Description, **Day Net** (Month / Year se ignoran) | subtotales por Group / Subgroup y Grand Total detectados y descartados; elementos literales del XML pendientes de muestra (§14) |
| `findeptcodes_csv` | `findeptcodes` en Delimited Data | idem | solo si la muestra demuestra que los subtotales no rompen filas (Oracle desaconseja Delimited con group-by) |
| `responsys_trx` | export `RESPONSYS_TRX_AUTO` | `TRANSACTION_DATE`, `REVENUE_TYPES`, `REVENUE_AMOUNTS` | solo revenue (sin impuestos ni pagos): asiento incompleto, útil para conciliar, no como fuente principal |

`source: "auto"` decide por extensión y raíz del documento. Un fichero sin líneas → 400
`PMS_SHADOW_REVENUE_EMPTY`.

### 8.2 · Previsualizar, contabilizar, sustituir, revertir

| Paso | Ruta | Cuerpo | Resultado |
| --- | --- | --- | --- |
| previsualizar (nunca escribe) | `POST /properties/:propertyId/pms-shadow/revenue/preview` (`accounting.journal.post`) | `{ source: "xml_revenue" \| "findeptcodes_xml" \| "findeptcodes_csv" \| "responsys_trx" \| "auto", contentBase64, businessDate?, fileName?, includePayments?, reconciliation? }` | `PmsShadowRevenuePreview`: `lines[]` (código, descripción, tipo, importe, ledgers, `kind` / `accountCode` / `usaliDepartment` resueltos, `mapped`), `totals { revenue, tax, payments, other }`, `unmapped[]`, `reconciliation`, `canPost`, `blockers[]`, `warnings[]` |
| contabilizar | `POST /properties/:propertyId/pms-shadow/revenue` (`accounting.journal.post`) | `{ source \| "auto", contentBase64, businessDate?, post: true, replace: false, includePayments?, force?, reconciliation? }` | 201 `PmsShadowRevenueImportRecord` `status: "posted"`, `journalEntryIds[]` (un asiento), `totals`; con `post: false` → lote `draft` sin asiento (revisable en el panel) |
| sustituir un día ya contabilizado | idem con `replace: true` | | en **una transacción**: reverso del asiento anterior (`reversalOfId`) + lote nuevo + asiento nuevo (`replacedById` en el viejo); sin `replace` → 409 `PMS_SHADOW_REVENUE_ALREADY_POSTED` |
| revertir | `POST /properties/:propertyId/pms-shadow/revenue/:id/reverse` (`accounting.journal.post`) | `{ reason, entryDate? }` (`reason` obligatorio, ≤ 500; `entryDate` = fecha contable del reverso, por defecto hoy) | lote `reversed`, `reversalJournalEntryIds[]`, `reversedBy` / `reversalReason`; nunca `deleteMany`. Lote no contabilizado → 409 `PMS_SHADOW_REVENUE_NOT_POSTED` |
| consultar | `GET /properties/:propertyId/pms-shadow/revenue` (`accounting.read`; `?businessDate=&status=&limit=`) · `GET /properties/:propertyId/pms-shadow/revenue/:id` | | lista por día y detalle con líneas |

Guardas (todas antes de escribir, en este orden): código sin mapear → 400 `OPERA_TRX_CODE_UNMAPPED`
`{ codes[] }` (el día queda **bloqueado** hasta completar `trxMappingJson`: un asiento parcial no cuadra
con el Trial Balance) · mismo fichero ya importado y no revertido → 409 `PMS_SHADOW_REVENUE_DUPLICATE`
salvo `force` · día ya `posted` → 409 `PMS_SHADOW_REVENUE_ALREADY_POSTED` salvo `replace` · ya existe un
asiento `pms_shadow_revenue` con `sourceId <propertyId>:<YYYY-MM-DD>` fuera de un lote (residuo) → 409
`PMS_SHADOW_REVENUE_ENTRY_EXISTS` · periodo contable cerrado → 409 `FISCAL_PERIOD_CLOSED` del motor y
**rollback completo** (también en `replace`: ni el reverso ni el nuevo) · ejercicio cerrado → 409
`FISCAL_YEAR_CLOSED` · línea de ingreso sin centro → 400 `WORK_CENTER_REQUIRED` (no ocurre con
`propertyId` de un centro `hotel`). La unicidad «un lote no revertido por día» la impone el servicio bajo
`pg_advisory_xact_lock` por propiedad (no hay índice único parcial en Prisma).

### 8.3 · Ejemplo numérico cuadrado (Rías Altas, `RIAS`, business date 2026-09-16, ficticio)

XML recibido (extracto de `total_amount` por `transaction_code`, mapeo de §3.1):

| Código | Descripción OPERA | Tipo | `total_amount` | `kind` | Cuenta | USALI |
| --- | --- | --- | ---: | --- | --- | --- |
| `1000` | Room Revenue | REVENUE | 3.200,00 | `revenue` | H `705.1` | `rooms` |
| `2000` | Breakfast | REVENUE | 480,00 | `revenue` | H `705.2` | `fnb` |
| `3000` | Parking | REVENUE | 60,00 | `revenue` | H `705.3` | `other_operated` |
| `8010` | VAT 10% | NON REVENUE | 368,00 | `tax` | H `477.10` | — |
| `8021` | VAT 21% | NON REVENUE | 12,60 | `tax` | H `477.21` | — |
| `9000` | Cash | PAYMENT | 900,00 | `payment` | D `570` | — |
| `9010` | Visa/MC | PAYMENT | 2.500,00 | `payment` | D `5721` | — |
| `9500` | Paid Out | PAID OUT | 40,00 | `ignore` | — (en `totals.other`, sin asiento) | — |

Asiento `pms_shadow_revenue` · `sourceId cmrhw9jy40003fyvbuu2ec2w7:2026-09-16` · `entryDate 2026-09-16` ·
centro RA (`includePayments: true`). Tras un `replace` o una reimportación de un día revertido el asiento
vivo nuevo lleva `sourceId …:2026-09-16#1` (`#2`…: el puente del diario libera la clave de los revertidos);
para localizarlo: `sourceId LIKE '<propertyId>:<fecha>%' AND status = 'posted'` o `journal_entry_ids` del lote.

| Cuenta | Descripción de la línea | Centro | Debe | Haber |
| --- | --- | --- | ---: | ---: |
| `4300` Clientes | Ingresos OPERA 2026-09-16 (base + IVA) | `RA` | 4.120,60 | |
| `705.1` Alojamiento | `1000 · Room Revenue` | `RA/ROOMS` | | 3.200,00 |
| `705.2` Restauración | `2000 · Breakfast` | `RA/FNB` | | 480,00 |
| `705.3` Otros servicios | `3000 · Parking` | `RA/OTHER` | | 60,00 |
| `477.10` IVA repercutido 10 % | `8010 · VAT 10%` | — | | 368,00 |
| `477.21` IVA repercutido 21 % | `8021 · VAT 21%` | — | | 12,60 |
| `570` Caja | `9000 · Cash` | `RA` | 900,00 | |
| `5721` Datáfono | `9010 · Visa/MC` | `RA` | 2.500,00 | |
| `4300` Clientes | Cobros OPERA 2026-09-16 | `RA` | | 3.400,00 |
| **Total** | | | **7.520,60** | **7.520,60** |

Comprobaciones: 3.200 + 480 + 60 = 3.740,00 de base; 3.680,00 × 10 % = 368,00 y 60,00 × 21 % = 12,60 de
IVA; 3.740,00 + 380,60 = **4.120,60** al debe de `4300`; cobros 900,00 + 2.500,00 = 3.400,00 (D `570` / D
`5721`, H `4300`); saldo de `4300` del día = 720,60 (pendiente de cobro en OPERA: city ledger / AR y
folios abiertos). Sin `includePayments` el asiento son las seis primeras líneas (4.120,60 = 4.120,60) y
los pagos quedan solo en `totals.payments`. El `PAID OUT` de 40,00 no genera línea (`ignore`) y aparece
en `totals.other` y en `warnings`.

**Sustituir** (`replace: true`, p. ej. OPERA corrigió el día con `naadjustments` y regeneró el XML): un
reverso exacto del asiento anterior (D `705.x` / D `477.x` / D `4300` 3.400,00 / H `4300` 4.120,60 / H
`570` / H `5721`, `reversalOfId` = asiento original, `entryDate` = hoy) y el asiento nuevo con los
importes corregidos, en la misma transacción. **Revertir** solo: el reverso y el lote `reversed`, sin
asiento nuevo. **Periodo cerrado**: si septiembre de 2026 está cerrado en Contabilidad › Cierre, tanto
contabilizar como sustituir responden 409 `FISCAL_PERIOD_CLOSED` sin escribir nada; un reverso con
`entryDate` en un periodo abierto sí es posible (es la vía para corregir un mes cerrado: reverso con fecha
de hoy + nuevo con `entryDate` de hoy y nota).

### 8.4 · Cuadre con el Trial Balance

Si el `reconciliation.transactionTotalToday` del Trial Balance del mismo día acompaña al fichero (o el
feed `stats` del día ya llegó), se guarda `reconciliationJson` y se comprueba Σ `total_amount` ≡ Transaction
Total Today (regla de Oracle para el XML de Revenue): `delta` > 1,00 € → alerta
`OPERA_RECON_REVENUE_MISMATCH` (`error`); el asiento **se contabiliza igual** (la alerta manda revisar,
no bloquea: el bloqueo es solo por código sin mapear). Por transaction code la tolerancia es 0,01 €.

## 9 · Reconciliación diaria y catálogo de alertas (diseño §5.4-5.5)

### 9.1 · Reconciliación

`GET /properties/:propertyId/pms-shadow/reconciliation?businessDate=2026-09-16` (`accounting.read`)
compara **lo que ehotelOS calcula** (reservas enlazadas y asiento del día) con **lo que OPERA declara**
(`declared` del feed `stats` del día o del corte que las trajo):

| `metric` | ehotelOS | OPERA (fuente) | Tolerancia (`PMS_SHADOW_RECON_TOLERANCES`) |
| --- | --- | --- | --- |
| `arrivals`, `departures`, `rooms_occupied`, `occupancy_pct`, `no_shows` | reservas enlazadas por fecha y estado | Manager Report: Arrival Rooms, Departure Rooms, Rooms Occupied, % Rooms Occupied, No Show Rooms (columna Day); o `GEN_XMLBO_STATISTICS` | `rooms: 0` (conteo exacto) |
| `revenue_total`, `revenue_rooms`, `tax_total` | Σ líneas del asiento `pms_shadow_revenue` del día (705.x, 705.1, 477.x) | Trial Balance «Transaction Total Today» / Revenue Total; Manager Report Room Revenue / Total Revenue; `findeptcodes` Day Net | `revenuePerCode: 0.01`, `revenueTotal: 1.00` |
| `adr`, `revpar` | 705.1 / habitaciones ocupadas; 705.1 / habitaciones disponibles | Manager Report ADR / Revenue per Available Room | `adr: 0.05` |
| `reservations_made`, `cancellations` | **sin dato** (`null` → fila `missing`, nunca `OPERA_RECON_COUNT_MISMATCH`): con snapshots la fecha de creación en ehotelOS es la del corte que la trajo (un corte inicial «hace» 30 días de reservas ese día) y la cancelación se ve el día del corte; se calcularán con el feed `changes` (`resreservyesterday` / `rescancel`) o con el async de OHIP (fase 2) | Manager Report Reservations Made Today / Cancellations Made Today | 0 |

Cada fila devuelve `{ metric, opera, anfitorio, delta, status: ok | mismatch | missing }` (`missing` =
OPERA no declaró la métrica: el feed `stats` no llegó; o ehotelOS no la calcula todavía, como
`reservations_made` / `cancellations`). La reconciliación se ejecuta al recibir el feed `stats` o `revenue`
del día (job §10) y a demanda; el KPI «último día conciliado» del panel (`lastReconciledDate`) es el último
business date con todas las filas `ok`. Un `mismatch` de conteo abre `OPERA_RECON_COUNT_MISMATCH`; uno de
importe, `OPERA_RECON_REVENUE_MISMATCH`. Solo el ingest (`revenue` / `stats`) crea y cierra esas alertas;
`GET …/reconciliation` es de lectura pura (calcula y compara, no escribe: `accounting.read` no debe crear
ni cerrar alertas). `arrivals` no cuenta los `no_show` (van en `no_shows`, como en el Manager Report).

### 9.2 · Catálogo de alertas (11 códigos, `PMS_SHADOW_ALERT_CODES`) y qué hacer

Las alertas viven en `pms_shadow_alerts` (hotel, business date, código, severidad, mensaje sin PII,
`expectedJson` / `actualJson`, run que la emitió, nº de confirmación si aplica) y se listan con
`GET /properties/:propertyId/pms-shadow/alerts` (`?open=true|false`, `?code=`, `?businessDate=`). Se
resuelven con `POST /properties/:propertyId/pms-shadow/alerts/:id/resolve` `{ note }` (`note` obligatoria,
≤ 500; auditoría `PMS_SHADOW_ALERT_RESOLVED`; ya resuelta → 409 `PMS_SHADOW_ALERT_ALREADY_RESOLVED`; de otra
propiedad → 404 `PMS_SHADOW_ALERT_NOT_FOUND`). Resolver **no** cambia datos: es el registro de que alguien
miró y decidió. Deduplicación: una alerta abierta por (hotel, código, business date); las alertas **por
reserva** (`OPERA_MISSING_IN_SNAPSHOT`, `OPERA_CONFLICT_LOCAL_RESERVATION`, `OPERA_CHECKIN_WITHOUT_ROOM`) se
deduplican por (hotel, código, nº de confirmación) sin el día: una ausencia que dura tres cortes es UNA
alerta cuyo business date, severidad (warning → error al 2.º corte), mensaje y `actualJson` se refrescan con
el último corte. En el panel el selector «Abiertas / Resueltas» corresponde a `?open=true|false` (el API no
tiene modo «todas»).

| Código | Severidad | Cuándo | Qué hacer |
| --- | --- | --- | --- |
| `OPERA_MISSING_IN_SNAPSHOT` | warning (error al 2.º corte) | reserva enlazada, en ventana, ausente del corte y sin cancelación / no-show en `changes` (§7.5) | comprobar en OPERA; si está cancelada, cancelarla en ehotelOS desde la reserva y resolver; si sigue viva, resolver con motivo |
| `OPERA_CONFLICT_LOCAL_RESERVATION` | warning | fila cuya confirmación coincide con la `externalReference` de una reserva **sin enlace** (creada en ehotelOS) | decidir cuál gobierna: cancelar la local (OPERA la sustituye en el siguiente corte) o dejarla y resolver; nunca se toca sola |
| `OPERA_CHECKIN_WITHOUT_ROOM` | warning | OPERA dice `Checked In` y la fila no trae habitación válida (vacía, no mapeada, de otro tipo u ocupada) | revisar `roomTypes` / el nº de habitación en OPERA; el siguiente corte reintenta; o hacer el check-in en recepción |
| `OPERA_TRX_CODE_UNMAPPED` | error | el fichero de ingresos trae un transaction code sin entrada en `trxMappingJson` (p. ej. OPERA creó un código nuevo) | completar el mapeo en el perfil (cuenta + USALI o `ignore`) y volver a contabilizar el día (el fichero queda en `procesados/` o se resube con `force`) |
| `OPERA_ROOM_TYPE_UNMAPPED` | error | room type de OPERA sin entrada en `roomTypes` ni en `pseudoRoomTypes` | añadir el mapeo; las filas afectadas quedaron en error y entran en el siguiente corte |
| `OPERA_RATE_CODE_UNMAPPED` | warning | rate code sin entrada en `rateCodes`: la reserva se creó con la tarifa por defecto | añadir el mapeo; el siguiente corte actualiza `ratePlanId` (hash distinto) |
| `OPERA_RECON_COUNT_MISMATCH` | error | conteos del día fuera de tolerancia (§9.1) | comparar `expected` / `actual`; causas típicas: `inhouse` sin programar, pseudo rooms contadas en OPERA, reserva local sin enlace, día-uso |
| `OPERA_RECON_REVENUE_MISMATCH` | error | Σ asiento ≠ Trial Balance / Manager Report | revisar códigos `ignore`, `PAID OUT`, package / wrapper, correcciones de días pasados (`naadjustments`); sustituir el día con `replace` si OPERA regeneró el XML |
| `OPERA_FEED_LATE` | warning | feed `required` sin run a `expectedTime` + 120 min | comprobar el Report Scheduler / el SFTP en OPERA y el cron del agente; subir el fichero a mano (§6); una sola alerta por feed y día |
| `OPERA_FEED_COLUMNS_CHANGED` | error | la cabecera recibida no es la del perfil (informe reconfigurado, columna añadida, otro idioma) | pedir la nueva muestra, actualizar el perfil (test de contrato) y resubir |
| `OPERA_FEED_UNRECOGNIZED` | warning | correo sin adjunto reconocible, fichero que no encaja con ningún feed en `auto`, o adjunto de otro hotel | revisar el filtro del buzón (`fromDomain`, `subjectContains`) y los nombres de fichero; resubir con `feed` explícito |

## 10 · Job, correo y registro (diseño §6.5 con §10)

- **Job del líder**, en el API (no hay dependencia de `apps/worker` hacia `@hotelos/api`), bajo el mismo
  interruptor que los demás schedulers (`isSchedulerLeader`, `server.ts:8467`; `RUN_SCHEDULERS=false` en
  las réplicas que no son líder). Variables: `PMS_SHADOW_JOB_DISABLED=true` lo apaga; `PMS_SHADOW_JOB_INTERVAL_MS`
  (por defecto 900000 = 15 min). En cada vuelta, por cada `PmsShadowProfile` `active`: (1) emite
  `OPERA_FEED_LATE` para los feeds `required` sin run del business date esperado pasada la hora + gracia
  (una por feed y día); (2) cierra como `failed` «interrumpido» los runs `processing` de más de 30 minutos
  (`PMS_SHADOW_STALE_RUN_MINUTES`; no hay cola de runs `received`: el ingest procesa en línea). La
  reconciliación (§9.1) **no** la ejecuta el job: la dispara cada ingest de `revenue` / `stats` del día con
  las métricas del propio fichero (corrección del integrador: el run que la dispara sigue `processing` y
  sus métricas entran en memoria, si no la desviación solo saltaba con el siguiente fichero del día); un día
  sin `stats` ni `revenue` se consulta a demanda con `GET …/reconciliation`. No sondea el correo (lo hace
  «mailbox poll») ni el SFTP (lo hace el cron del agente).
- **Correo**: cada adjunto reconocido → run `source: "email"`; el correo se marca como procesado; sin
  adjunto válido → `OPERA_FEED_UNRECOGNIZED`. Los adjuntos no se guardan (§1).
- **Runs** (`pms_shadow_runs`): `feed`, `source` (`email` · `sftp` · `api_key` · `manual` · `ohip` · `cli`),
  `businessDate`, `fileName`, `contentHash`, `status` (`received` → `processing` → `done` · `partial` ·
  `failed`), `reservationImportId` / `revenueImportId`, contadores `created` / `updated` / `unchanged` /
  `transitioned` / `skipped` / `error`, `resultJson` (cabecera reconocida, declarados, totales),
  `alertsJson`, `errorMessage` (sin valores), `correlationId`, `createdBy`, `startedAt` / `finishedAt`.
  `GET /properties/:propertyId/pms-shadow/runs` (`?feed=&status=&businessDate=&limit=` 50, máx. 200) y
  `GET /properties/:propertyId/pms-shadow/runs/:id` (404 `PMS_SHADOW_RUN_NOT_FOUND`, opaco entre
  propiedades).
- **Panel** (`GET /properties/:propertyId/pms-shadow/overview`): `lastRunAt`, `linkedReservations`,
  `openAlerts`, `lastReconciledDate`, `feeds[] { feed, expectedTime, required, state: ok | late | failed |
  pending | unscheduled, lastRun }`.
- **Auditoría** (`audit_events`, `entityType pms_shadow_run` / `pms_shadow_alert` /
  `pms_shadow_revenue_import` / `pms_shadow_profile`): `PMS_SHADOW_RUN_*` (un evento al crear el run y otro
  al terminar `done` / `partial` / `failed`, con contadores y hash, sin datos de huéspedes),
  `PMS_SHADOW_ALERT_RESOLVED` (motivo), los eventos del lote de reservas (`RESERVATION_IMPORT_COMMITTED`) y
  de cada reserva (`RESERVATION_CREATED`, check-in, check-out, cancelación), y los del asiento (posting y
  reverso). Actor: el usuario del panel, la app de desarrollador (`developer_app:<clientId>`) o
  `usr_system_pms_shadow`.
- **Retención**: ficheros nunca persistidos; SFTP `procesados/` 30 días; buzón: el correo queda en el
  proveedor con la etiqueta de procesado (purga según la política del buzón, recomendada 30 días).

## 11 · Permisos por ruta y por rol

| Método y ruta | Clave | Riesgo | Qué hace |
| --- | --- | --- | --- |
| `POST /integrations/pms-shadow/ingest` | pública + `X-Api-Key` (`DeveloperApp` con scope `pms.shadow.ingest`) | public | recibir un corte (§5.3) |
| `GET /properties/:propertyId/pms-shadow/overview` | `integrations.read` | low | KPIs y estado de los feeds |
| `GET /properties/:propertyId/pms-shadow/profile` | `integrations.read` | low | perfil (mapeos, feeds, buzón, carpeta) |
| `PUT /properties/:propertyId/pms-shadow/profile` | `integrations.connect` | high | crear / editar el perfil, pausar |
| `GET /properties/:propertyId/pms-shadow/runs` | `integrations.read` | low | lista de cortes |
| `POST /properties/:propertyId/pms-shadow/runs` | `integrations.connect` | high | subir un corte a mano (§6.1) |
| `GET /properties/:propertyId/pms-shadow/runs/:id` | `integrations.read` | low | detalle de un corte |
| `GET /properties/:propertyId/pms-shadow/alerts` | `integrations.read` | low | alertas (abiertas por defecto) |
| `POST /properties/:propertyId/pms-shadow/alerts/:id/resolve` | `integrations.connect` | high | resolver con motivo |
| `GET /properties/:propertyId/pms-shadow/reconciliation` | `accounting.read` en el partial → **`accounting.reports.read` en vigor** (remap t6#9 de `security/route-permissions.ts`, como toda lectura con importes) | low | tabla del día (`?businessDate=`) |
| `POST /properties/:propertyId/pms-shadow/revenue/preview` | `accounting.journal.post` | medium | previsualizar ingresos (nunca escribe) |
| `POST /properties/:propertyId/pms-shadow/revenue` | `accounting.journal.post` | high | contabilizar / sustituir |
| `GET /properties/:propertyId/pms-shadow/revenue` | `accounting.read` → `accounting.reports.read` en vigor | low | lotes de ingresos |
| `GET /properties/:propertyId/pms-shadow/revenue/:id` | `accounting.read` → `accounting.reports.read` en vigor | low | lote con líneas y asientos |
| `POST /properties/:propertyId/pms-shadow/revenue/:id/reverse` | `accounting.journal.post` | **critical** | revertir |
| `POST /properties/:propertyId/reservations/imports` con `mode: "sync"` | `pms.reservation.create` + `pms.reservation.modify` + `pms.checkin.execute` + `pms.checkout.execute` | high | vía manual del importador (§6.2) |
| `POST /properties/:propertyId/email/connections` con `purpose: "pms_shadow"` | `integrations.connect` | high | buzón del hotel (§3.3) |
| `POST /developer/apps` con scope `pms.shadow.ingest` | `developer.manage_webhooks` | high | clave de API (§3.2) |

Sin claves de permiso nuevas (no hace falta `rbac:sync`). Una propiedad de otra organización, o sin
perfil, responde 404 opaco en todas las rutas `pms-shadow`. Las rutas `high` rechazan el fallback demo
sin token. Riesgos según el manifiesto `modules/pms-shadow/route-permissions.partial.ts` (L3): si
difiere, manda el manifiesto.

| Plantilla de rol (`packages/shared/src/permissions.ts`) | `integrations.read` / `connect` | `accounting.read` | `accounting.journal.post` | 4 claves `pms.*` del sync | Puede |
| --- | --- | --- | --- | --- | --- |
| Propietario, Administrador | sí / sí | sí | sí | sí | todo, incluida la clave de API (`developer.manage_webhooks`) |
| Dirección | sí / sí | sí | **no** | sí | perfil, cortes, alertas, reconciliación, ver ingresos y sync manual; **no** contabiliza ni revierte |
| Contabilidad | no / no | sí | sí | no | reconciliación, previsualizar, contabilizar, sustituir y revertir ingresos; **no** ve el panel de feeds / runs / alertas (403) |
| Cumplimiento | no / no | sí | no | no | solo lectura de reconciliación y lotes de ingresos |
| Recepción | no / no | sí (solo `accounting.read`, sin `accounting.reports.read`) | no | sí | sync manual desde Reservas › Importar; **no** lee la reconciliación ni los lotes de ingresos (exigen `accounting.reports.read` en vigor: Propietario, Administrador, Dirección, Contabilidad, Cumplimiento) |
| Comercial | no / no | no | no | create + modify (sin check-in / check-out) | nada del modo sombra: el sync exige las 4 claves (403) |
| Pisos, Mantenimiento, Revenue, Punto de venta | no | no | no | no | nada (403 / 404) |

La pestaña «Modo sombra OPERA» de Configuración › Módulos e integraciones solo aparece con los tokens de
menú `admin | direccion`; dentro, sin `integrations.connect` los botones de guardar, subir y resolver se
desactivan (el servicio lo vuelve a comprobar); la sección «Ingresos» se desactiva sin
`accounting.journal.post`.

## 12 · Verificación SQL

`psql "$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')"` desde `hotelos/`. Sustituir
`<propertyId>` (Rías Altas `cmrhw9jy40003fyvbuu2ec2w7`) y `<orgId>` (Faranda / CELUISMA
`cmrhw9jy30002fyvb6tsdiugt`). `business_date` y `"current_date"` son `date` (comillas en el segundo:
palabra reservada).

```sql
-- 1. Perfil de la propiedad (código de hotel, estado, feeds programados, mapeos completos)
SELECT id, opera_hotel_code, status, inbox_email, sftp_folder,
       jsonb_array_length(schedule_json->'feeds') AS feeds, jsonb_array_length(trx_mapping_json) AS trx_codes
FROM pms_shadow_profiles WHERE property_id = '<propertyId>';

-- 2. Enlaces (reservas gobernadas por OPERA) por propiedad y último estado
SELECT property_id, last_status, count(*), max(last_business_date) AS ultimo_corte,
       count(*) FILTER (WHERE missing_streak > 0) AS ausentes
FROM pms_shadow_links WHERE property_id = '<propertyId>' GROUP BY 1, 2 ORDER BY 2;

-- 3. Runs por feed y estado con contadores (un run por fichero; el fichero nunca se guarda)
SELECT feed, status, count(*), max(business_date) AS ultimo_dia,
       sum(created_count) AS creadas, sum(updated_count) AS actualizadas, sum(unchanged_count) AS sin_cambios,
       sum(transitioned_count) AS transiciones, sum(skipped_count) AS omitidas, sum(error_count) AS errores
FROM pms_shadow_runs WHERE property_id = '<propertyId>' GROUP BY 1, 2 ORDER BY 1, 2;

-- 4. Idempotencia por corte: 0 filas (mismo fichero, feed y día nunca duplicado)
SELECT property_id, feed, business_date, content_hash, count(*)
FROM pms_shadow_runs GROUP BY 1, 2, 3, 4 HAVING count(*) > 1;

-- 5. Alertas abiertas por código y día (sin PII: solo nº de confirmación, métrica e importes)
SELECT code, severity, business_date, confirmation_no, left(message, 120) AS mensaje, run_id, created_at
FROM pms_shadow_alerts WHERE property_id = '<propertyId>' AND resolved_at IS NULL ORDER BY created_at;

-- 6. Asientos de ingresos de OPERA: cuadrados (SUM(debit) = SUM(credit)); esperado 0 filas descuadradas
SELECT e.id, e.entry_date, e.source_id, e.status, e.reversal_of_id,
       sum(l.debit) AS debe, sum(l.credit) AS haber, sum(l.debit) - sum(l.credit) AS diferencia
FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id
WHERE e.organization_id = '<orgId>' AND e.source_type = 'pms_shadow_revenue'
GROUP BY 1, 2, 3, 4, 5 HAVING sum(l.debit) <> sum(l.credit);
SELECT count(*) AS asientos_opera FROM journal_entries
WHERE organization_id = '<orgId>' AND source_type = 'pms_shadow_revenue';

-- 7. Lotes de ingresos por día: un solo lote no revertido por (propiedad, día)
SELECT id, business_date, source, status, total_revenue, total_tax, total_payments, total_other,
       journal_entry_ids, reversal_journal_entry_ids, replaced_by_id, reversal_reason
FROM pms_shadow_revenue_imports WHERE property_id = '<propertyId>' ORDER BY business_date DESC, created_at DESC;
SELECT property_id, business_date, count(*) FROM pms_shadow_revenue_imports
WHERE status <> 'reversed' GROUP BY 1, 2 HAVING count(*) > 1;   -- 0 filas

-- 8. Líneas del asiento del día por cuenta (el ejemplo de §8.3 debe dar 705.1 3200 · 705.2 480 · 705.3 60 · 477.10 368 · 477.21 12,60)
SELECT l.account_code, sum(l.debit) AS debe, sum(l.credit) AS haber
FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id
WHERE e.organization_id = '<orgId>' AND e.source_type = 'pms_shadow_revenue'
  AND e.source_id = '<propertyId>:2026-09-16' AND e.reversal_of_id IS NULL
GROUP BY 1 ORDER BY 1;

-- 9. Enlace ↔ reserva: external_reference = nº de confirmación; bookingSource del lote; sin booker_email (0 en la última)
SELECT l.confirmation_no, r.code, r.status, l.last_status, r.booking_source,
       r.external_reference = l.confirmation_no AS referencia_ok, l.missing_streak
FROM pms_shadow_links l JOIN reservations r ON r.id = l.reservation_id
WHERE l.property_id = '<propertyId>' ORDER BY l.confirmation_no;
SELECT count(*) FROM pms_shadow_links l JOIN reservations r ON r.id = l.reservation_id
WHERE l.property_id = '<propertyId>' AND r.booker_email IS NOT NULL;   -- 0: ningún correo a huéspedes

-- 10. Check-in / check-out sombra: estancia y folio coherentes con el estado
SELECT r.code, r.status, r.assigned_room_id IS NOT NULL AS con_habitacion, f.status AS folio, s.status AS stay
FROM pms_shadow_links l JOIN reservations r ON r.id = l.reservation_id
LEFT JOIN folios f ON f.reservation_id = r.id LEFT JOIN stays s ON s.reservation_id = r.id
WHERE l.property_id = '<propertyId>' AND r.status IN ('checked_in', 'checked_out') ORDER BY r.code;

-- 11. Invariantes de Faranda (no deben moverse): 25 facturas · 33 envíos VeriFactu · 109 asientos previos
SELECT count(*) AS facturas FROM invoices i JOIN properties p ON p.id = i.property_id WHERE p.organization_id = '<orgId>';   -- 25
SELECT count(*) AS envios FROM verifactu_submissions s JOIN invoices i ON i.id = s.invoice_id
JOIN properties p ON p.id = i.property_id WHERE p.organization_id = '<orgId>';                                          -- 33
SELECT count(*) AS asientos_previos FROM journal_entries
WHERE organization_id = '<orgId>' AND source_type <> 'pms_shadow_revenue';                                              -- 109
SELECT count(*) AS asientos_total FROM journal_entries WHERE organization_id = '<orgId>';   -- 109 + los de esta tanda (asientos + reversos)

-- 12. Reservas de demo de la Tanda 7 (IMP-RA-2026-1xx): intactas salvo las sincronizadas a propósito (con enlace)
SELECT r.external_reference, r.code, r.status, r.booking_source, l.id IS NOT NULL AS enlazada, l.last_status
FROM reservations r LEFT JOIN pms_shadow_links l ON l.reservation_id = r.id
WHERE r.property_id = '<propertyId>' AND r.external_reference LIKE 'IMP-RA-2026-1%' AND r.deleted_at IS NULL
ORDER BY r.external_reference;

-- 13. Auditoría del modo sombra (runs, alertas resueltas, lotes)
SELECT action, entity_type, entity_id, actor_user_id, correlation_id, created_at
FROM audit_events WHERE action LIKE 'PMS_SHADOW_%' ORDER BY created_at DESC LIMIT 50;

-- 14. Business date actual de la propiedad (la que usa el ingest sin businessDate)
SELECT "current_date" FROM business_dates WHERE property_id = '<propertyId>';
```

## 13 · FAQ

- **¿Por qué no se cancela sola una reserva que ya no viene en el corte?** Porque «ausente» no
  significa «cancelada»: la reserva puede haberse movido fuera de la ventana del informe (llegada > +30
  días), haber cambiado de hotel, o el informe puede haber salido con un filtro distinto. Cancelarla sola
  arriesgaría cancelar reservas vivas; por eso hay alerta `OPERA_MISSING_IN_SNAPSHOT`, `missingStreak` y
  cancelación manual con motivo (§7.5). Las cancelaciones reales llegan por `rescancel` (feed `changes`) y
  se aplican solas.
- **¿Por qué el importe total es estimado?** El export `RESPONSYS_RESV_AUTO` solo trae `RATE`, la tarifa
  de la **primera noche**; con tarifas por día distintas o paquetes, RATE × noches × habitaciones no es el
  total. Se marca `RESERVATION_IMPORT_ROW_OPERA_TOTAL_ESTIMATED` y no alimenta la contabilidad (el ingreso
  entra por el XML de Revenue, §8). El total real llega en fase 2 (OHIP) o con `GEN_XMLBO_BILLS`.
- **¿Qué pasa si OPERA añade un transaction code?** El día se **bloquea** (`OPERA_TRX_CODE_UNMAPPED`, con
  el código y su descripción) hasta que se mapea en el perfil: un asiento parcial no cuadraría con el
  Trial Balance. Mapearlo (cuenta + USALI o `ignore`) y contabilizar de nuevo; el fichero está en
  `procesados/` del SFTP o se resube desde el panel con `force`.
- **¿Delimited o Delimited Data?** Oracle no define la diferencia; la hipótesis de trabajo del perfil es
  que **Delimited Data trae solo filas de datos, sin cabecera**, y por eso el feed `departures` usa
  `headerOverride`: la primera fila del fichero ya es un dato. Si la muestra real trae cabecera, se quita
  el `headerOverride` del perfil. No mezclar los dos formatos en la misma programación.
- **¿Se mantiene la cadena de auditoría si uso el CLI?** Sí, si el CLI sube por el ingest HTTP
  (`--ingest-url` + `--api-key`, o `PMS_SHADOW_INGEST_URL` + `PMS_SHADOW_API_KEY` en el entorno): la
  escribe el API en marcha, sin parar nada; es el modo del cron del agente (§5.2). El CLI **también** tiene
  un modo directo (`--apply` sin `--ingest-url`: servicio en proceso con `usr_system_pms_shadow`, como
  `reservations:import --apply`), pensado para el arranque y la carga histórica: úsalo solo con los API
  parados, porque con el API arriba bifurca la cadena en memoria (deuda 12(c) de `CLAUDE.md`).
- **¿Por qué el mismo fichero de ayer no es un duplicado hoy?** Porque la idempotencia es por corte:
  (fichero, feed, business date). Un `res_detail` idéntico dos días seguidos es normal (nada cambió) y
  debe procesarse: sus filas salen `unchanged` y actualizan `lastSeenAt` / `lastBusinessDate` de los
  enlaces; sin eso, las ausencias (§7.5) se dispararían en falso. El mismo fichero **el mismo día** sí es
  409 (`PMS_SHADOW_RUN_DUPLICATE` / `RESERVATION_IMPORT_DUPLICATE`) salvo `force`.
- **¿Puedo deshacer un corte?** El lote de reservas del run (`reservationImportId`) se deshace desde
  Reservas › Importar como cualquier lote (§7.7): cancela lo creado por ese lote, no revierte
  actualizaciones ni transiciones. El lote de ingresos se **revierte** (§8.2). El run en sí no se borra.
- **¿Se envía algo a los huéspedes o a la AEAT?** No. Sin correos (`bookerEmail` vacío y sin eventos de
  dominio en las actualizaciones), sin facturas, sin VeriFactu, sin SES: todo eso sigue en OPERA (§1).
- **¿Qué hago con un hotel nuevo?** Perfil (§3.1) con su Hotel Code, feeds y mapeos; buzón propio (§3.3) o
  carpeta SFTP propia + línea de cron (§5.2) y **app de desarrollador propia** con el scope ligado a su
  centro (`pms.shadow.ingest:<propertyId>`, §3.2): la clave de otro hotel recibe 401 con `--property` de
  este, aunque sea de la misma organización.
- **¿Puede Contabilidad contabilizar sin ver el panel?** Sí: `accounting.journal.post` da acceso a
  `revenue/preview`, `revenue` y `reverse` y `accounting.read` a la reconciliación; el panel de feeds /
  runs / alertas exige `integrations.read` (§11).

## 14 · Qué tiene que entregar César (diseño §7.6) y huecos pendientes de muestra real

**Para arrancar Rías Altas (día 1):**

1. Hotel Code de Property Controls de cada hotel ↔ código ehotelOS (RA, LT, PG, MC, AS, FN, LL); en este
   runbook `RIAS` es ficticio.
2. Hora habitual del night audit por hotel (fija `expectedTime` y `businessDateOffset` de §3.1).
3. Listados de configuración (§7.4 del diseño, PDF o Delimited, una vez por hotel): `cf_roomtypes`,
   `cf_rooms`, `cf_ratecodeheader`, `cf_marketcodes`, `cf_sourcecodes`, `cf_origincodes`,
   `cf_trxcodes1`, `cf_taxtypesbytrxcodes`, `cf_reservationtypes` → rellenan `mappingJson` y
   `trxMappingJson`.
4. **Una salida real de cada informe de §4** (Delimited Data **y** PDF) y del XML `GEN_XMLBO_REVENUE` de
   un día (paso 5).
5. Criterio contable por transaction code (§3.1 punto 4) validado con la gestoría: en particular tasa
   turística (pasivo, no ingreso), paquetes / wrapper, paid-outs, anticipos y city ledger.
6. Dirección de correo del programador (usuario permanente) y, si hay SFTP, confirmación de la entrada en
   el Outbound Domain Allowlist.
7. Para OHIP (fase 2): Enterprise ID, Chain Code, Region, Environment Type, Hotel IDs y la decisión sobre
   el dueño del app key (§7.5 y §8.1 del diseño).

**Huecos que solo cierra la muestra real** (hasta entonces el perfil los deja `undefined` y el importador
responde `RESERVATION_IMPORT_PROFILE_UNSUPPORTED_FEED`):

| Hueco | Efecto hoy | Se cierra con |
| --- | --- | --- |
| Columnas de `res_detail` (Arrivals: Detailed) en Cloud | feed `arrivals` solo por `RESPONSYS_RESV_AUTO` (33 columnas confirmadas) | muestra Delimited Data + PDF del informe 2 |
| Columnas de `gibyroom` (In-House) | feed `inhouse` sin perfil; reconciliación de `rooms_occupied` solo por `stats` | muestra del informe 3 |
| Columnas de `resreservyesterday`, `rescancel`, `nanoshow` | feed `changes` sin perfil: cancelaciones y no-shows solo por ausencia (§7.5) o por `RESPONSYS_RESV_DAY` manual con esos estados | muestra del informe 4 |
| Elementos del XML de `findeptcodes` (BI Publisher, modelo de datos) | fuente de ingresos solo `GEN_XMLBO_REVENUE` (SFTP) | muestra XML del informe 5 |
| Elementos del XML de `manager_report` y `trial_balance` | feed `stats` solo con `declared` / `reconciliation` rellenados a mano o por `GEN_XMLBO_STATISTICS`; sin cuadre automático con Transaction Total Today | muestras XML de los informes 6 y 7 |
| Delimitador y definición de «Delimited» frente a «Delimited Data» en Cloud | perfil con `headerOverride` para `departure_all` (hipótesis: sin cabecera) y separador autodetectado (`;` `,` tab `|`) | cualquier muestra Delimited Data |
| Dominio remitente del Report Scheduler | `fromDomain` obligatorio en el buzón `pms_shadow` (poner el dominio previsto y ajustarlo con la primera entrega); comparación sobre el texto del `From`, sin DKIM/SPF | primera entrega real por correo |
| Cuál de las dos plantillas «Revenue By Date» está vigente (`GEN_XMLBO_REVENUE_DY` / `GEN_XMLBO_REV_DAY`) | histórico de ingresos pendiente | respuesta de Oracle / consultor |
| **Signo de los cobros** (`PAYMENT`) en `GEN_XMLBO_REVENUE` y en Day Net de `findeptcodes` | el importador asume el convenio del XML de los tests de L2 (cobros **negativos**, `received = −amount`); un `findeptcodes` con cobros positivos da `totals.payments` negativo y, con `includePayments: true`, contabilizaría los cobros al revés → mantener `includePayments: false` (valor por defecto) hasta la muestra | XML de Revenue y `findeptcodes` reales del mismo día |
| **Fila de cabecera del export Responsys** (`RESPONSYS_RESV_AUTO`) | el perfil y el clasificador del feed (`classifyFeed`: `RESERVATION_ID` + `ARRIVAL_DATE` en la primera línea) asumen que el CSV trae los nombres de columna; si el export real llega sin cabecera, se añade `headerless` a `feeds.arrivals` como en `departures` | primer export real (SFTP o descarga manual) |
| **Adopción de reservas ya existentes en ehotelOS** (creadas por recepción, canal o lote en modo crear) como gobernadas por OPERA | no hay ruta: la misma referencia sin enlace es `OPERA_CONFLICT_LOCAL_RESERVATION` (fila omitida, alerta); en la demo del integrador los 29 enlaces del lote de la Tanda 7 se crearon por SQL (`pms_shadow_links` con `first_import_id` del lote y `row_hash` centinela) | decisión de producto (§8.1 del diseño): opción `adoptLocal` del importador o CLI `pms-shadow:adopt` auditado |

Documentos relacionados: [`reservas-importacion.md`](reservas-importacion.md) (§18 modo sincronizar),
[`finanzas-contabilidad.md`](finanzas-contabilidad.md) (motor contable, reversos, periodos cerrados),
[`pms-history-forecast-import.md`](pms-history-forecast-import.md) (History & Forecast de OPERA ya
importado), [`rbac-sync.md`](rbac-sync.md) (plantillas de rol), diseño
[`docs/design/OPERA-CLOUD-MODO-SOMBRA.md`](../design/OPERA-CLOUD-MODO-SOMBRA.md) e informe del integrador
`docs/audits/TANDA-7B-OPERA-MODO-SOMBRA-2026-09-17.md` (cifras reales de la demo).
