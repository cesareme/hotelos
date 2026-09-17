# Reservas · Importación masiva desde CSV o XLSX — lote reversible con resultado por fila

Diseño de la **Tanda 7 · Importación masiva de reservas** para la petición de César (2026-09-16): «poder subir reservas en bulk partiendo de un formato Excel o CSV». Fecha: 2026-09-16. Documento de diseño final, **escrito antes de codificar** (lote L5, sin dependencias): los lotes L0-L6 de §10 lo implementan y el informe `docs/audits/TANDA-7-RESERVAS-IMPORT-2026-09-16.md` recogerá las cifras reales. Ángulo elegido: **robustez operativa** — cada reserva importada nace por el mismo camino que una reserva de recepción (`createReservation`), el lote existe antes de la primera reserva y siempre se puede deshacer, y el fichero nunca se guarda. Correspondencia: runbook operativo [`docs/runbooks/reservas-importacion.md`](../runbooks/reservas-importacion.md) (plantilla, mapeo, validaciones, disponibilidad, deshacer, permisos por rol, CLI paso a paso, SQL de verificación, GDPR, FAQ) y bloque «### Importación masiva de reservas (Tanda 7)» bajo «## PMS» de [`docs/api-contracts.md`](../api-contracts.md) (rutas, permisos, límites, códigos). Patrón de referencia: nómina agregada de la Tanda 6c ([`docs/design/FINANZAS-COSTE-PERSONAL.md`](FINANZAS-COSTE-PERSONAL.md): parser puro → `analyse` compartido por preview y commit → lote con hash/estado/mapeo → partial de permisos → CLI dry-run → drawer Cocoa 22). Índice de documentos relacionados en §12.

Leyenda: **[V]** verificado (código leído con fichero:línea, SQL sobre la BD local o cálculo reproducible) · **[I]** inferido (decisión de diseño pendiente de confirmar con César).

Fuentes de trabajo: `apps/api/src/modules/pms/pms.service.ts` (`createReservation` 521-760: lock por (propiedad, tipo) y consulta de disponibilidad 628-655, estado `confirmed` 725, check-in exige `confirmed` 1559, `processNoShows`), `apps/api/src/modules/pms/inventory.engine.ts:36` (`canAssignRoom`), `apps/api/src/modules/pms/room-charge.service.ts:223` (`quoteReservationTotal`), `apps/api/src/modules/notifications/event-hooks.service.ts:110-142` (`handleReservationConfirmed` → plantilla `reservation_confirmed` a `bookerEmail`), `apps/api/src/modules/payroll/{cost-import.parser,cost-import.service,cost-import.routes}.ts` (patrón), `apps/api/src/modules/financial-statements/xlsx-writer.ts` (escritor XLSX existente), `apps/api/src/lib/{tenancy.ts:287, crypto-fields.ts:355, reservation-code.ts}`, `apps/api/src/security/route-permissions.ts`, `apps/admin-web/src/screens/payroll/PayrollCostImportDrawer.tsx`, `apps/admin-web/src/screens/reservations/ReservationCreateScreen.tsx`, `tests/cocoa-22-contract.test.mjs` y el recon `scratchpad/tanda7-recon/{schema.enum.prisma, schema.models.prisma, migration.sql, reservas-demo-rias-altas.muestra.csv}`.

---

## §1 · Resumen y motivación

1. **Qué pide César.** Cargar decenas o cientos de reservas de golpe desde un Excel o CSV: migraciones desde otro PMS, rooming lists de touroperador, ficheros de OTA o de agencia, o el propio Excel de recepción. Hoy la única vía masiva es la rooming list de grupos (`importRoomingList`, `tx.reservation.create` directo, sin huésped ni folio ni disponibilidad), y la alta unitaria por pantalla.
2. **Una sola vía de creación.** Cada fila se convierte en reserva con **`createReservation`** [V pms.service.ts:521]: es la única función con lock por (propiedad, tipo de habitación), comprobación de disponibilidad, código de reserva con reintento (`allocateReservationCode`, MAX+1 bajo advisory lock), alta o reutilización de `Guest`, `ReservationGuest` principal, folio, auditoría `RESERVATION_CREATED` y evento `ReservationCreated`. Nunca `tx.reservation.create` directo (§1.1).
3. **Pipeline determinista y puro hasta la BD.** bytes (siempre `contentBase64` desde el navegador; `content` texto solo CLI y tests) → tabla (`ParsedTable`: CSV RFC 4180 propio o XLSX-lite sin dependencias, §3) → mapeo con sinónimos ES/EN (explícito > exacto > `includes`, §5.2) → normalización pura con catálogos inyectados (tipos, tarifas, habitaciones, fecha de negocio, moneda, §5.3) → duplicados (§5.4) → planificador de disponibilidad que **replica la consulta real del PMS** (§5.5) → hash canónico → veredicto por fila `valid | warning | error | skipped`, `canImport` y `blockers`. Preview y commit comparten **`analyse({ strict })`**: lo que la pantalla enseña es exactamente lo que el commit va a hacer.
4. **Lote reversible desde el primer instante.** `ReservationImport` se crea en estado `processing` **antes** de la primera reserva, bajo advisory lock por propiedad junto al chequeo de hash; cada fila es una transacción propia (`createReservation` → `assignRoom` → `transitionReservation` si viene cancelada); las filas se persisten por bloques de 100; el cierre deja `imported | partial | failed`. Si el proceso muere a medias, el lote queda `processing` («Interrumpida» en la UI) y **se puede deshacer igual**, porque el deshacer busca por `bookingSource = import:<id>` y no por las filas persistidas.
5. **Idempotencia doble.** Hash sha256 de las filas normalizadas (mismo hash para CSV/XLSX, otro orden de filas o espacios) → 409 `RESERVATION_IMPORT_DUPLICATE` mientras exista un lote no `undone`/`failed` con ese hash en la propiedad, salvo `force`; y `referencia_externa` ya presente en una reserva activa de la propiedad → fila omitida `RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE`. Las referencias de reservas `cancelled`/`no_show` **se pueden reutilizar** (aviso): imprescindible para reimportar tras deshacer.
6. **Disponibilidad honesta.** El PMS rechaza con 409 cuando `Σ roomsCount` de las reservas `confirmed | checked_in` **que solapan el rango completo** más lo solicitado supera el cupo del tipo [V pms.service.ts:628-655]; no es un cupo por noche. La preview replica esa regla sumando además las filas anteriores aceptadas del fichero, y muestra aparte la tabla tipo × noche para explicar por qué una fila «que cabe por noche» recibe `RESERVATION_IMPORT_ROW_NO_AVAILABILITY`. `permitirOverbooking` convierte el error en aviso y crea la reserva por encima del cupo, auditada.
7. **Tres parámetros aditivos en `createReservation`** (§4.4): `primaryGuestId` (reutilizar un `Guest` hallado por documento o e-mail), `allowOverbooking` (saltar el 409 con rastro en `afterJson.overbooking`) e `historical` (llegadas pasadas como estancia cerrada en la **misma** transacción: `checked_out` + folio `closed` + `Stay` si hay habitación). Todo lo demás de `createReservation` queda intacto.
8. **Estados del fichero.** `confirmada` (por defecto) → `confirmed`; `cancelada` → creada y cancelada vía `transitionReservation` (aviso `RESERVATION_IMPORT_ROW_CANCELLED_AT_IMPORT`); `tentativa` → **creada como confirmada** con aviso e `internalNotes` «Importada como tentativa: confirmar con el cliente», porque en el PMS solo la creación fija el estado [V :725], no existe transición `draft → confirmed`, el check-in exige `confirmed` [V :1559], un `draft` no consumiría inventario y la auditoría nocturna lo pasaría a `no_show` igualmente. Decisión elevada a César (§11.1).
9. **Sin correos a los importados.** El evento `ReservationCreated` despacha la plantilla `reservation_confirmed` al `bookerEmail` de la reserva [V event-hooks.service.ts:110-142]; el importador **no rellena `bookerEmail`** (el e-mail vive en `Guest`) para que un lote de 500 filas no envíe 500 correos. `bookerName` sí se rellena («Nombre Apellidos»).
10. **GDPR por construcción.** El fichero no se persiste; `ReservationImportRow` guarda solo nº de fila, referencia externa, fechas, tipo/tarifa, nº de habitaciones, código de reserva o código de error; los mensajes de error y aviso citan **columna y nº de fila, nunca valores** (`stripRowValues` + test unitario que afirma que ningún mensaje contiene el e-mail, el nombre ni el documento de una fila ficticia). Ronda 1 (T7-FUN-02): la red de seguridad borra solo los valores **personales** de la fila (`personalValuesOf`: nombre, apellidos, e-mail, teléfono y documento como celda y como palabras ≥ 3 caracteres; peticiones y notas solo como celda completa —integración: sus palabras sueltas mutilaban los mensajes de la propia fila—) y solo como **token completo**: los códigos de catálogo que los propios mensajes citan («Estado» tentativa, tipo SRA, PASAPORTE) y los trozos de palabra («Ana» en «Analizando», «Mar» en «marcaría») ya no se mutilan.
11. **Permisos honestos con el código.** Importar exige `pms.reservation.create` **y** `pms.reservation.modify` (`assignRoom` y `transitionReservation` exigen `modify`); deshacer exige `modify` (espejo de `POST /reservations/:id/cancel`, riesgo high); leer y descargar la plantilla, `pms.reservation.read`. Difiere del brief (solo `create`) pero todas las plantillas con `create` tienen `modify` hoy (manager, receptionist, sales, owner, admin) [V rbac].
12. **Entregables.** 6 rutas `/properties/:propertyId/reservations/imports*`, CLI `reservations:import` (dry-run por defecto, `--apply`, `--undo`, `--template`, `--export-xlsx`), pestaña «Importar» en Recepción › Reservas con asistente de 4 pasos y lista de importaciones anteriores, runbook, bloque en `api-contracts.md`, fichero de demo ficticio para Rías Altas (30 filas + 5 para el deshacer) e informe del integrador.

### 1.1 Alternativas descartadas

| Alternativa | Por qué se descarta | Conf. |
|---|---|---|
| `tx.reservation.create` directo por fila (patrón `importRoomingList`) | Se saltaría el lock por (propiedad, tipo), la disponibilidad, el código con reintento, el huésped principal, el folio, la auditoría y el evento; una reserva importada sería «menos reserva» que una de recepción | V pms.service.ts:521-760 |
| Cupo tipo × noche como veredicto de disponibilidad | Aprobaría filas que `createReservation` rechaza: con 2 habitaciones, A 1→2, B 3→4 y C 1→4 caben por noche pero la regla de rango del PMS (suma de reservas que solapan) devuelve 409 [V ejemplo reproducido]. La tabla por noche se conserva **informativa** (`nightsExceeded`, `rangeRuleRows`) | V :640-655 |
| Importar «tentativa» como `draft` | No hay transición `draft → confirmed`; solo la creación fija el estado (:725) y el check-in exige `confirmed` (:1559); un draft no consume inventario y `processNoShows` lo marca `no_show` igual | V |
| Histórico en dos pasos (crear `confirmed` → pasar a `checked_out`) con compensación | Ventana entre pasos en la que la auditoría nocturna (`processNoShows`) cobraría fee; el segundo paso exige lógica de check-in/check-out con `Stay` y folio; con `Folio.status` y `Stay` disponibles el modelo permite la estancia cerrada **atómica** dentro de `createReservation` («checked_out, sin bloquear inventario ni crear folios abiertos», como pide el brief) | V |
| Enlazar el huésped hallado **después** de crear la reserva | `createReservation` solo reutiliza por `documentNumber`; enlazar a posteriori deja `ReservationGuest` en estado parcial si falla; `primaryGuestId` es aditivo y atómico | V :660 |
| Rellenar `bookerEmail` con el e-mail del huésped | `handleReservationConfirmed` enviaría `reservation_confirmed` por cada `ReservationCreated`; si más adelante se quiere, hará falta un flag de supresión del evento | V event-hooks:110-142 |
| Librería XLSX (`exceljs`, `xlsx`) o CSV | Sin red y sin dependencias nuevas (regla del runbook); el escritor XLSX propio ya existe; `readZipEntries` de `financial-statements` no lee el directorio central ni data descriptors y `parseDelimited` de `@hotelos/ai-tools` rompe campos entrecomillados con saltos de línea y desempata a favor de «,» | V |
| `file.text()` en el navegador y `content` texto por HTTP | `file.text()` decodifica siempre como UTF-8 y destruye latin1; por eso el navegador envía **siempre** `contentBase64` (CSV incluido) y el API decide codificación (utf-8 `fatal` → windows-1252) | V |
| Deshacer a partir de las filas persistidas | Un corte a media importación dejaría reservas sin fila; se deshace por `bookingSource = import:<id>` (fuente de verdad en `reservations`) | V |
| Índice único parcial «un lote vivo por hash» | Drift entre schema y migración; el mismo efecto con `pg_advisory_xact_lock('reservation_import:' \|\| propertyId)` dentro de la transacción del lote (patrón nómina) | V |
| Crear las filas en paralelo | `allocateReservationCode` y el lock por (propiedad, tipo) serializan igualmente; en paralelo solo se ganarían interbloqueos y códigos no consecutivos | V lib/reservation-code.ts |

---

## §2 · Formato de fichero

### 2.1 Plantilla oficial

`GET /properties/:propertyId/reservations/imports/template?format=csv|xlsx` devuelve `plantilla-reservas.csv` (BOM UTF-8, separador «;», CRLF, 33 cabeceras + 2 filas de ejemplo ficticias `@example.com`, llegada = hoy + 30 días en ISO, DBL/BAR, BB, directo, confirmada, 250,00 EUR) o `plantilla-reservas.xlsx` (hoja «Reservas» con cabecera en negrita y anchos, hoja «Instrucciones» con campo · obligatorio · formato · valores admitidos generada desde `HELP_ES`; fechas como texto ISO). `RESERVATION_IMPORT_FIELDS` (33, orden canónico) es la cabecera:

```
referencia_externa;llegada;salida;noches;tipo_habitacion;tarifa;habitacion;habitaciones;adultos;ninos;bebes;regimen;canal;segmento;estado;nombre;apellidos;email;telefono;nacionalidad;documento_tipo;documento_numero;empresa;agencia;grupo;importe_total;moneda;deposito;metodo_pago;hora_llegada;peticiones;notas;vip
```

**Obligatorias:** `llegada`, `tipo_habitacion`, `nombre`, `apellidos`, más la regla «`salida` **o** `noches`». `apellidos` queda exento cuando la columna mapeada a `nombre` es de nombre completo (`nombre_completo`, `full_name`, `guest_name`, `guest`, `huesped`, `cliente`, `titular`, `customer`, `customer_name`, `name`): se parte por coma («Apellidos, Nombre») o, si no hay coma, primer token = nombre y resto = apellidos (aviso `RESERVATION_IMPORT_ROW_NAME_SPLIT`).

### 2.2 Columnas

| Campo | Obl. | Formato y valores admitidos | Destino |
|---|---|---|---|
| `referencia_externa` | no | texto ≤ 200; localizador OTA/PMS; base de la idempotencia por fila | `Reservation.externalReference` |
| `llegada` / `salida` | sí / sí* | `YYYY-MM-DD` (hora opcional), `YYYY/MM/DD`, `DD/MM/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY`, `D/M/YY` (→ 20YY), celda de fecha Excel, entero 20000..80000 (serial Excel 1900, aviso); calendario real | `arrivalDate` / `departureDate` (`@db.Date`) |
| `noches` | sí* | entero 1..365; sustituye a `salida` o se coteja con ella (`RESERVATION_IMPORT_ROW_NIGHTS_MISMATCH` si difieren) | derivado |
| `tipo_habitacion` | sí | código o nombre del `RoomType` de la propiedad; `ROOM_TYPE_SYNONYMS` (copia de `reservation-agent.service.ts:215-243`) con candidato único → aviso | `roomTypeId` |
| `tarifa` | no | código o nombre del `RatePlan`; vacío → plan BAR activo con menor código (`defaultRatePlanId`) | `ratePlanId` |
| `habitacion` | no | número exacto de `Room`; debe ser del tipo de la fila, estar libre (`canAssignRoom`) y `habitaciones` = 1 | `assignedRoomId` (vía `assignRoom`) |
| `habitaciones` | no | entero ≥ 1 (default 1): unidades del tipo | `roomsCount` |
| `adultos` / `ninos` / `bebes` | no | enteros; `adultos` vacío → 1, 0 → error; `adultos + ninos ≤ maxOccupancy × habitaciones` | `adults` / `children` / `infants` |
| `regimen` | no | `RO BB HB FB AI` o `SA AD MP PC TI`, «solo alojamiento», «alojamiento y desayuno», «media pensión», «pensión completa», «todo incluido», b&b, bed and breakfast, room only, half/full board, all inclusive | `boardType` |
| `canal` | no | directo/direct/web/hotel/motor/propia → `direct`; booking/booking.com/bcom → `booking_com`; expedia/hotels.com; airbnb; agencia/agency/travel_agent/tour_operator/tto → `agency`; empresa/corporate/company → `corporate`; telefono/phone/llamada → `phone`; email/correo/mail → `email`; walk_in/walkin/walk-in/mostrador → `walk_in`; grupo/group; gds/amadeus/sabre; wholesale/mayorista/bedbank; ota/online; vacío → `direct`; otro → plegado ≤ 80 + aviso | `channel` (+ `sourceCode` = valor crudo ≤ 80) |
| `segmento` | no | corporate/empresa/business; leisure/ocio/vacacional; mice/eventos/congresos; wedding/boda; sports/deportes; group/grupo; government/gobierno/administracion; wholesale/mayorista; complimentary/cortesia/invitacion; ota/online; otro → plegado + aviso | `marketSegment` |
| `estado` | no | vacío/confirmada/confirmed/confirm/ok/garantizada → `confirmada`; tentativa/tentative/draft/provisional/opcional/option/pendiente → `tentativa`; cancelada/cancelled/canceled/anulada/baja → `cancelada`; otro → error | estado final (§1.8) |
| `nombre` / `apellidos` | sí / sí* | ≤ 120 cada uno; `apellidos` → `surname1` + `surname2` (segundo token en adelante) | `Guest.firstName` / `surname1` / `surname2`; `bookerName` |
| `email` | no | `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, minúsculas; inválido → descartado con aviso; clave de reutilización del huésped | `Guest.email` (**nunca** `bookerEmail`) |
| `telefono` | no | dígitos, `+` y separadores con 7..20 dígitos; ≤ 40; inválido → descartado con aviso | `Guest.phone` |
| `nacionalidad` | no | alfa-3 tal cual; alfa-2 → alfa-3 con tabla de ~40 países (ES→ESP, PT→PRT, FR→FRA, DE→DEU, GB/UK→GBR, IT→ITA, US→USA, NL, BE, IE, PL, CH, AT, BR, AR, MX, CN, JP, MA, CO, SE, NO, DK, FI, CZ, RO, RU, UA, CA, AU, IN, KR, IL, TR, GR) y nombres ES/EN; otro → descartada con aviso | `Guest.nationality` |
| `documento_tipo` / `documento_numero` | no | dni/nif → `DNI`; nie → `NIE`; pasaporte/passport/pas/ppt/pass → `PASSPORT`; tie → `TIE`; otro → mayúsculas ≤ 40 + aviso; número en mayúsculas sin espacios ≤ 60; clave prioritaria de reutilización | `Guest.documentType` / `documentNumber` |
| `empresa` / `agencia` / `grupo` | no | ≤ 200 / ≤ 200 / ≤ 80 | `companyName` (+ `Guest.company`) / `travelAgentName` / `groupCode` |
| `importe_total` | no | «1.234,56», «1,234.56», «1234.56», «€ 312»; 0 ≤ x ≤ 999.999,99; vacío → cotización `quoteReservationTotal × habitaciones` (aviso) | `totalAmount` (`MoneyString`) |
| `moneda` | no | «€» → EUR; vacía → moneda de la propiedad; distinta → error | `currency` |
| `deposito` | no | mismo parseo de importes | `depositAmount` |
| `metodo_pago` | no | cash/efectivo/metalico; credit_card/tarjeta/card/visa/mastercard; debit_card/debito; bank_transfer/transferencia; voucher/bono; company_invoice/factura/factura_a_empresa/credito_empresa; online_prepaid/prepago/prepaid/vcc/virtual_card/online; pms_account/cuenta/cargo_en_cuenta/pms; otro → plegado ≤ 40 + aviso | `paymentMethod` |
| `hora_llegada` | no | `H:MM`, `HH:MM`, `HH.MM` o celda de hora Excel → `HH:MM` | `estimatedArrivalTime` / `eta` |
| `peticiones` / `notas` | no | ≤ 2.000 cada una (truncado con aviso) | `specialRequests` / `notes` |
| `vip` | no | si/sí/s/yes/y/true/1/x/vip → `true`; no/n/false/0/vacío → `false`; otro → `false` + aviso | `vipFlag` |

### 2.3 Sinónimos de cabecera (`RESERVATION_IMPORT_SYNONYMS`, ya plegados con `foldHeader`)

`foldHeader` = NFD sin diacríticos → minúsculas → `[\s\-./º°()]+` → `_` → sin `_` extremos; así «Nº hab.» → `n_hab`, «Check-in» → `check_in`, «Fecha de entrada» → `fecha_de_entrada` (casa por `includes` con `fecha_entrada`).

| Campo | Sinónimos |
|---|---|
| `referencia_externa` | referencia, ref, reference, external_reference, external_ref, booking_id, booking_ref, reservation_id, reservation_number, localizador, locator, confirmation_number, confirmation, ota_reference, pms_id, id_reserva, numero_reserva, n_reserva |
| `llegada` | entrada, fecha_entrada, fecha_llegada, check_in, checkin, arrival, arrival_date, from, desde, inicio, fecha_inicio, start_date |
| `salida` | fecha_salida, check_out, checkout, departure, departure_date, to, hasta, fin, fecha_fin, end_date |
| `noches` | nights, num_noches, n_noches, estancia |
| `tipo_habitacion` | tipo, tipo_hab, categoria, room_type, roomtype, room_category, category, unit_type, tipologia |
| `tarifa` | rate, rate_plan, rateplan, rate_code, ratecode, plan, tarifa_codigo, codigo_tarifa, plan_tarifario |
| `habitacion` | room, room_number, room_no, hab, num_hab, numero_habitacion, unit |
| `habitaciones` | rooms, rooms_count, num_habitaciones, unidades, units, qty_rooms |
| `adultos` | adults, adult, ad, pax, pax_adultos, personas, guests_count |
| `ninos` | children, child, kids, ch, menores, pax_ninos |
| `bebes` | infants, infant, babies, cunas, bb |
| `regimen` | board, board_type, meal_plan, mealplan, pension, alimentacion, plan_comidas |
| `canal` | channel, source, origen, fuente, procedencia, booking_source, distribution_channel |
| `segmento` | segment, market_segment, mercado, market |
| `estado` | status, state, estado_reserva, reservation_status, situacion |
| `nombre` | first_name, firstname, given_name, name, nombre_completo, full_name, guest_name, guest, huesped, cliente, titular, customer, customer_name (los 10 últimos activan `splitName` si `apellidos` no está mapeado) |
| `apellidos` | apellido, last_name, lastname, surname, surnames, family_name, apellido1, primer_apellido |
| `email` | e_mail, correo, correo_electronico, mail, guest_email |
| `telefono` | tel, phone, telephone, movil, mobile, celular, guest_phone |
| `nacionalidad` | nationality, pais, country, country_code, nacion |
| `documento_tipo` | tipo_documento, document_type, id_type, doc_type |
| `documento_numero` | numero_documento, documento, document_number, dni, nif, nie, pasaporte, passport, id_number, doc_number, num_doc |
| `empresa` | company, company_name, compania, razon_social, corporate |
| `agencia` | agency, travel_agent, travel_agency, tour_operator, touroperador, intermediario, agente |
| `grupo` | group, group_code, codigo_grupo, evento, event |
| `importe_total` | importe, total, total_amount, amount, precio, price, total_price, pvp, revenue |
| `moneda` | currency, divisa, currency_code |
| `deposito` | deposit, prepago, prepaid, anticipo, senal, paid_amount |
| `metodo_pago` | forma_pago, payment_method, payment, pago, garantia, guarantee |
| `hora_llegada` | hora, eta, arrival_time, check_in_time, hora_entrada |
| `peticiones` | special_requests, requests, preferencias, observaciones, remarks, guest_remarks |
| `notas` | notes, comments, comentarios, internal_notes, note |
| `vip` | vip_flag, is_vip, es_vip |

### 2.4 Ejemplos ficticios

Plantilla oficial (dos filas; huéspedes inventados, `@example.com`; tipos y tarifas de Rías Altas):

```
referencia_externa;llegada;salida;noches;tipo_habitacion;tarifa;habitacion;habitaciones;adultos;ninos;bebes;regimen;canal;segmento;estado;nombre;apellidos;email;telefono;nacionalidad;documento_tipo;documento_numero;empresa;agencia;grupo;importe_total;moneda;deposito;metodo_pago;hora_llegada;peticiones;notas;vip
IMP-RA-2026-001;2026-10-12;2026-10-15;;DBL;BAR;111;1;2;0;0;RO;directo;leisure;confirmada;Lucía;Ferreiro Castro;lucia.ferreiro@example.com;+34 600 111 001;ES;DNI;11111111H;;;;312,00;EUR;0;tarjeta;16:30;Cama de matrimonio;;no
IMP-RA-2026-002;13/10/2026;;2;Doble Superior Vista Ría;BAR-BB;;1;2;1;0;Alojamiento y desayuno;booking;ota;confirmada;Marek;Nowak;marek.nowak@example.com;+48 600 111 002;PL;PAS;AB1234567;;;;296,00;EUR;59,20;prepago OTA;;Cuna para el niño;Booking.com 4411223344;no
```

Fichero de terceros (cabeceras EN, «,», nombre completo): `Booking ID,Check-in,Check-out,Room Type,Rate,Guest name,E-mail,Adults,Board,Channel,Total` → mapeo propuesto `referencia_externa · llegada · salida · tipo_habitacion · tarifa · nombre (splitName) · email · adultos · regimen · canal · importe_total`, todas por `synonym`, ninguna columna sin mapear, `apellidos` no exigido.

---

## §3 · Lector XLSX y parser CSV

### 3.1 Entrada, formato y límites (`reservation-import.parser.ts`)

`parseReservationImportFile({ format?, fileName?, content?, contentBase64?, sheetName? }): ParsedTable`. Bytes de `contentBase64` (siempre desde el navegador) o texto `content` (CLI/tests). Formato: `body.format` > extensión de `fileName` (`.xlsx`/`.xlsm` → xlsx; `.csv`/`.txt`/`.tsv` → csv) > firma («PK\x03\x04», en base64 prefijo `UEsDB`) > csv. Límites (`packages/shared`): `RESERVATION_IMPORT_MAX_BYTES` 5 MiB → `RESERVATION_IMPORT_TOO_LARGE`; `_MAX_BASE64_CHARS` 7·1024·1024 (zod); `_MAX_ROWS` 5.000 → `RESERVATION_IMPORT_TOO_MANY_ROWS`; `_MAX_COLUMNS` 200 → `RESERVATION_IMPORT_UNREADABLE`; `_MAX_CELL_CHARS` 2.000 → truncar + `RESERVATION_IMPORT_ROW_CELL_TRUNCATED`; sin filas de datos → `RESERVATION_IMPORT_EMPTY`; `_MAX_NIGHTS` 365; `_MAX_FILE_NAME` 200; muestra 200 (máx. 1.000). Errores tipados `ReservationImportParseError { code, details }`.

Salida común: `ParsedTable = { header: string[]; rows: Array<{ rowNumber; line; cells: string[]; kinds: CellKind[] }>; format; encoding?: "utf-8" | "windows-1252"; bom; delimiter?; sheetName?; warnings: string[]; truncated }` con `CellKind = empty | string | number | bool | date | time | error`. Solo filas de datos tras la cabecera (`rowNumber` 1 = primera fila de datos; `line` = línea física 1-based del fichero para citar en los mensajes); filas totalmente vacías descartadas; espacios/NBSP/BOM residual recortados; cabecera vacía → `columna_<n>`; filas cortas rellenadas con `""`, largas → aviso.

### 3.2 CSV (`parseCsvTable(input: Uint8Array | string)`)

BOM `EF BB BF` eliminado; `new TextDecoder("utf-8", { fatal: true })` y, si lanza, `new TextDecoder("windows-1252")` (0x80 = €) con `encoding` informado; texto ya decodificado con U+FFFD → aviso «codificación no reconocida». `detectDelimiter(text)` propio: recuento fuera de comillas de `;` `\t` `,` `|` sobre las 5 primeras líneas no vacías, desempate `;` > `\t` > `,` > `|` (no se reutiliza el de `@hotelos/ai-tools`, que empata a favor de «,»). Autómata RFC 4180 sobre el texto completo (estados `FIELD_START / IN_FIELD / IN_QUOTES / QUOTE_IN_QUOTES`; `""` → `"`; saltos de línea dentro de comillas conservados; CR/LF/CRLF); la cabecera es el primer registro no vacío.

### 3.3 XLSX-lite (`apps/api/src/lib/xlsx-lite.ts`, solo `node:zlib`)

`readXlsxTable(buffer, { sheetName?, maxRows = 5001, maxCols = 200, maxCellChars = 2000 }): { sheetName; rows: Array<{ row; cells: Array<{ raw; kind; dateStyle }> }>; warnings; truncated }` y helpers exportados y testeables: `readZipCentralDirectory(bytes)`, `inflateZipEntry`, `excelSerialToIso(serial, date1904)`, `excelFractionToTime(fraction)`, `isDateNumFmt(numFmtId, formatCode?)`, `columnIndexFromRef("AB12") → 28`, `decodeXmlText` (entidades `&lt; &gt; &amp; &quot; &apos; &#N; &#xH;` y escapes `_xHHHH_`).

- **ZIP:** EOCD `0x06054b50` buscado desde `len-22` hacia atrás (≤ 65535 + 22); entradas u16@10, cdSize u32@12, cdOffset u32@16; cabecera central `0x02014b50` (método@10, compSize@20, uncompSize@24, nameLen@28, extraLen@30, commentLen@32, localOffset@42); cabecera local `0x04034b50` (nameLen@26, extraLen@28) y datos desde `off + 30 + n + e` con el `compSize` **del directorio central** (fiable aunque haya data descriptor); método 0 copia, 8 `inflateRawSync(data, { maxOutputLength })`, otro → error; rechazo de ZIP64 (`0xFFFFFFFF`), > 2.000 entradas, parte > 32 MiB, suma > 64 MiB; acceso perezoso por nombre. Errores `XlsxLiteError { code: XLSX_NOT_ZIP | XLSX_ZIP64 | XLSX_TOO_MANY_ENTRIES | XLSX_BOMB | XLSX_COMPRESSION | XLSX_NO_WORKBOOK | XLSX_NO_SHEET | XLSX_BAD_XML | XLSX_BAD_DATE }` → el parser los traduce a `RESERVATION_IMPORT_UNREADABLE`.
- **Workbook:** `xl/workbook.xml` (`date1904="1|true"` en `<workbookPr>`; hoja pedida por `sheetName` o la primera sin `state="hidden"`) → `xl/_rels/workbook.xml.rels` Id → Target (sin «/» inicial, prefijo `xl/` si es relativo) → fallback `xl/worksheets/sheet1.xml`. `sharedStrings`: cada `<si>` = concatenación de todos sus `<t>` (runs `<r><t>`), ignorando `<rPh>`. `styles`: `<numFmts>` id → formatCode y `<cellXfs><xf numFmtId>` por índice; estilo de fecha = `numFmtId ∈ {14-22, 27-36, 45-47, 50-58}` o formatCode (sin tramos `"…"`, `[…]`, `\x`) con `/[dmyhs]/i`.
- **Hoja:** `<row>` (`r` opcional → fila siguiente) y `<c>` (`r` opcional → columna siguiente; autocerradas; `<f>` ignorado, se toma `<v>` cacheado); `t=s` → sharedStrings[i]; `str`/`inlineStr` (`<is>` concatenando `<t>`) → string; `b` → TRUE/FALSE kind `bool`; `e` → `""` + aviso kind `error`; `d` → ISO kind `date`; sin `t` → número con el **texto crudo conservado** (nunca redondear), notación científica de enteros expandida por `BigInt` (`6.00123456E8` → `600123456`), aviso si > 2^53; con `dateStyle`: entero 1..2958465 → kind `date` ISO (época 1900: serial ≥ 61 → 1899-12-30 + días, 1..59 → 1899-12-31 + días, 60 → `XLSX_BAD_DATE` «29/02/1900 no existe» como error de celda; 1904: 1904-01-01 + días); 0 < v < 1 → kind `time` `HH:MM`; no entero > 1 → `date` con la parte de fecha. Datos cortados en `maxRows` con `truncated` y aviso.
- **Lo que no lee (documentado):** fórmulas sin `<v>` (celda vacía + aviso), ZIP64, libros cifrados, formatos condicionales; teléfonos o documentos guardados como número pierden los ceros iniciales (aviso).

### 3.4 Límites (resumen de las constantes de `packages/shared/src/reservation-import-types.ts`)

| Constante o regla | Valor | Efecto al superarlo | Dónde se aplica |
|---|---|---|---|
| `RESERVATION_IMPORT_MAX_BYTES` | 5 MiB | 400 `RESERVATION_IMPORT_TOO_LARGE` (`{ bytes, max }`) | parser (bytes reales, tras base64) |
| `RESERVATION_IMPORT_MAX_BASE64_CHARS` | 7·1024·1024 caracteres | 400 `VALIDATION_ERROR` (zod) | esquema `contentBase64` |
| `bodyLimit` de las rutas preview / import | 8 MiB | 413 de Fastify (etiqueta «El fichero supera el tamaño admitido (5 MB)» en la UI) | rutas |
| `RESERVATION_IMPORT_MAX_ROWS` | 5.000 filas de datos | 400 `RESERVATION_IMPORT_TOO_MANY_ROWS` (`{ rows, max }`) | parser (XLSX-lite corta en `maxRows` 5.001 con `truncated`) |
| `RESERVATION_IMPORT_MAX_COLUMNS` | 200 | 400 `RESERVATION_IMPORT_UNREADABLE` | parser |
| `RESERVATION_IMPORT_MAX_CELL_CHARS` | 2.000 | recorte + aviso `RESERVATION_IMPORT_ROW_CELL_TRUNCATED` | parser y normalización (longitudes por campo de §2.2) |
| `RESERVATION_IMPORT_MAX_NIGHTS` | 365 (aviso `LONG_STAY` desde 61) | error `RESERVATION_IMPORT_ROW_INVALID_NIGHTS` | normalización |
| `RESERVATION_IMPORT_MAX_FILE_NAME` | 200 caracteres | 400 `VALIDATION_ERROR` | esquema `fileName` |
| `sampleSize` | 200 por defecto, máx. 1.000 | 400 `VALIDATION_ERROR` fuera de 1..1000 | preview (`normalized` solo en la muestra) |
| `mapping` | ≤ 200 claves, valores `RESERVATION_IMPORT_FIELDS \| null` | 400 `VALIDATION_ERROR` | esquema |
| `sheetName` / `reason` | ≤ 64 / ≤ 500 caracteres | 400 `VALIDATION_ERROR` | esquemas |
| Rate limit de la preview | 30 peticiones/min por usuario | 429 | ruta preview |
| `limit` de la lista de lotes | 50 por defecto, máx. 200 | 400 `VALIDATION_ERROR` | ruta `GET …/imports` |
| ZIP del XLSX | sin ZIP64, ≤ 2.000 entradas, parte ≤ 32 MiB, suma ≤ 64 MiB | `XlsxLiteError` → 400 `RESERVATION_IMPORT_UNREADABLE` | `xlsx-lite.ts` |
| Filas persistidas por bloque | 100 | — (rendimiento; el lote `processing` es deshacible si se corta) | commit |
| Reclamación del deshacer | 15 min | 409 `RESERVATION_IMPORT_UNDO_IN_PROGRESS` hasta que expire | undo |

Rendimiento esperado: commit **secuencial** (`createReservation` + `assignRoom` por fila); un lote de miles de filas tarda minutos por HTTP, de ahí la recomendación del runbook de usar el CLI a partir de ~1.000 filas y partir las migraciones grandes por mes o por tipo.

---

## §4 · Modelo de datos y migración

```
Organization ── Property (sin FK desde las tablas nuevas, convención PayrollCostLine)
 └── ReservationImport      (LOTE: formato, fichero, hash, estado processing→imported|partial|failed→undone, contadores, mapeo, opciones, deshacer)
      └── ReservationImportRow  (RESULTADO por fila SIN PII: nº de fila, referencia, fechas, tipo/tarifa, reservationId único o errorCode, avisos, undoOutcome)
Reservation { bookingSource "import:<importId>", externalReference, bookerName, bookerEmail NULL } ── ReservationGuest(isPrimary) ── Guest (por organización)
             ── Folio (open | closed si histórico) ── Stay (solo histórico con habitación)
```

**`ReservationImportStatus`** (enum Prisma tras la línea 108 del schema, con `processing` añadido como primer valor al enum del recon): `processing` (lote creado y filas en curso; deshacible) · `imported` (todas las filas de datos creadas) · `partial` (creadas > 0 y (omitidas > 0 o errores > 0)) · `failed` (0 creadas) · `undone` (deshecho). Etiquetas ES: «Interrumpida», «Importada», «Parcial», «Fallida», «Deshecha».

| Modelo (`@@map`) | Columnas | Índices y unicidad |
|---|---|---|
| **`ReservationImport`** (`reservation_imports`) | `id` cuid; `organizationId`, `propertyId` (desnormalizados, sin FK); `format` (`csv` · `xlsx`); `fileName?`; `contentHash` (sha256 de las filas normalizadas); `status` `@default(processing)`; `rowCount` / `createdCount` / `skippedCount` / `errorCount` / `warningCount` (`Int @default(0)`); `mappingJson` (`{ "<cabecera>": "<campo>" }`); `optionsJson` (`{ omitirInvalidas, permitirOverbooking, historico, force, encoding, delimiter, sheetName, duplicateOfImportId?, durationMs, source: http \| cli }`); `arrivalFrom` / `arrivalTo` (`Date?`); `totalAmount` `Decimal(14,2)` (Σ creadas); `currency` `EUR`; `createdBy?`; `createdAt`; `undoneAt?` / `undoneBy?` / `undoReason?`; `undoneCount` / `undoKeptCount` | `@@index([propertyId, status, createdAt])` · `@@index([propertyId, contentHash])` · `@@index([organizationId, createdAt])` |
| **`ReservationImportRow`** (`reservation_import_rows`) | `id`; `importId` (FK `onDelete: Cascade`); `organizationId`, `propertyId`; `rowNumber` (1 = primera fila de datos); `outcome` (`created` · `skipped` · `error`); `externalReference?`; `arrivalDate?` / `departureDate?` (`Date`); `roomTypeCode?`; `ratePlanCode?`; `roomsCount` `@default(1)`; `reservationId?` `@unique`; `reservationCode?`; `errorCode?`; `errorMessage?` (≤ 500, sin PII); `warningsJson` (`[{ code, message, column? }]`); `undoOutcome?` (`cancelled` · `kept` · `skipped`) | `@@unique([importId, rowNumber])` · `@@index([importId, outcome])` · `@@index([propertyId, externalReference])` |
| `Reservation` / `Guest` / `Folio` / `Stay` | **sin columnas nuevas**; `bookingSource = "import:<importId>"` es la clave de pertenencia al lote y del deshacer | — |

**Prohibido en la fila:** nombre, apellidos, e-mail, teléfono, documento, notas, peticiones. Si hace falta el dato, se abre la reserva (`reservationId`).

**Migración** `packages/database/prisma/migrations/20260916130000_reservas_importacion/migration.sql`: generada **antes** de aplicar con `prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` y la cabecera del recon (enum con **5** valores) antepuesta; nada escrito a mano. Esperado: 1 `CREATE TYPE`, 2 `CREATE TABLE`, 7 `CREATE INDEX`, 1 `FOREIGN KEY … ON DELETE CASCADE`; después `db:migrate:status` 10/10, `db:drift:check` «No difference detected.», `check-migrations-vs-schema` 271 tablas / 32 enums / 18 FK; Faranda intacta (25 facturas · 109 asientos · 1 lote de nómina).

### 4.3 Tipos wire (`packages/shared/src/reservation-import-types.ts`, reexportado desde `index.ts`)

Límites (§3.1); `RESERVATION_IMPORT_FIELDS` (33) + `RESERVATION_IMPORT_REQUIRED_FIELDS`; `RESERVATION_IMPORT_LABELS_ES` / `HELP_ES` por campo; catálogos `RESERVATION_IMPORT_STATUSES`, `_ROW_STATUSES` (`valid, warning, error, skipped`), `_ROW_OUTCOMES` (`created, skipped, error`), `_UNDO_OUTCOMES` (`cancelled, kept, skipped`), `_ESTADOS` (`confirmada, tentativa, cancelada`), `_CHANNELS` (14), `_SEGMENTS` (10), `_PAYMENT_METHODS` (8), `_BOARDS` (`RO BB HB FB AI`), `_DOCUMENT_TYPES` (`DNI NIE PASSPORT TIE`); DTOs `ReservationImportIssue { code; message; column? }`, `ReservationImportMapping = Record<string, Field | null>`, `ReservationImportOptions { omitirInvalidas; permitirOverbooking; historico; force }`, `NormalizedReservationRow` (fila resuelta: fechas ISO, `nights`, `roomTypeId/Code`, `ratePlanId/Code?`, `roomId/Number?`, `roomsCount`, pax, `boardType?`, `channel`, `sourceCode?`, `marketSegment?`, `estado`, `historical`, `guest { firstName, surname1, surname2?, email?, phone?, nationality?, documentType?, documentNumber? }`, `companyName?`, `travelAgentName?`, `groupCode?`, `totalAmount: MoneyString`, `totalSource: file | quoted | none`, `currency`, `depositAmount?`, `paymentMethod?`, `estimatedArrivalTime?`, `specialRequests?`, `notes?`, `vipFlag`), `ReservationImportPreviewRow { rowNumber; line; status; issues; guestReuse?: document | email | null; normalized? (solo en la muestra); availability?: { totalRooms; bookedDb; bookedFile; exceeds } }`, `ReservationImportAvailabilityByType { roomTypeId; code; name; totalRooms; rowsRequested; peakBookedDb; peakBookedFile; nightsExceeded: string[]; rangeRuleRows: number[] }`, `ReservationImportPreview` (§5.7), `ReservationImportRecord` (lote con fechas ISO, importes `MoneyString`, `alreadyUndone?`), `ReservationImportRowRecord`, `ReservationImportDetail = Record & { rows }`, `ReservationImportResult = Detail & { warnings }`, `ReservationImportUndoResult = Record & { alreadyUndone; cancelledReservationIds }`; cuerpos `ReservationImportPreviewBody { fileName?; format?; content?; contentBase64?; sheetName?; mapping?; omitirInvalidas?; permitirOverbooking?; historico?; force?; sampleSize? }`, `CreateBody = PreviewBody & { commit: true }`, `UndoBody { reason? }`, `ListQuery { status?; limit? }`; `RESERVATION_IMPORT_ERROR_CODES` (§7.3) y `RESERVATION_IMPORT_ROW_CODES` (§5.8) `as const` con JSDoc por código; etiquetas ES de estados, outcomes y undo. Sin dependencias de runtime.

### 4.4 Parámetros aditivos de `createReservation` (`pms.service.ts`, L2)

| Parámetro | Comportamiento | Rastro |
|---|---|---|
| `primaryGuestId?: string` | `tx.guest.findFirst({ where: { id, organizationId: context.organizationId } })` → si no existe, 400 «primaryGuestId no pertenece a la organización.»; si viene, `guestId` = ese id, se ignora `primaryGuest` y **no se crea ni actualiza** ningún huésped | `ReservationGuest { isPrimary: true }` como hoy |
| `allowOverbooking?: boolean` (default `false`) | Si `true` y `bookedRooms + requested > totalRooms`, no lanza el 409 de :640-655 | `afterJson.overbooking = { totalRooms, bookedRooms, requested }` en `RESERVATION_CREATED` |
| `historical?: boolean` (default `false`) | Exige `departureDate ≤ hoy` en la zona de la propiedad (si no, 400 «Una reserva histórica debe haber terminado.»); en la **misma transacción**: `status "checked_out"`, folio con `status "closed"`, y si `assignedRoomId` → `tx.stay.create({ reservationId, roomId, checkinAt: llegada 15:00 tz propiedad, checkoutAt: salida 11:00, status: "checked_out" })` | `afterJson.historical = true`; el evento `ReservationCreated` se emite igual (inocuo sin `bookerEmail`) |

Todo lo demás intacto (estado `confirmed` por defecto :725, lock, código, folio, auditoría). Riesgo: sin tests previos que fijen `createReservation` [V]; L2 re-ejecuta `tests/integration/api-integration.test.mts:888-970` y los contratos raíz que leen `pms.service.ts` (`concierge-booking`, `reservation-billing-reporting`).

---

## §5 · Previsualización (`analyse({ context, propertyId, body, strict })`)

### 5.1 Pipeline compartido por preview y commit

1. `requirePermissions(context, ["pms.reservation.create"])` + `assertPropertyInOrg(propertyId, organizationId)`.
2. `parseReservationImportFile` → en preview (`strict = false`) los errores de fichero se devuelven como `blockers` con `canImport = false`; en commit → 400 con `details.code`.
3. `applyMapping(header, body.mapping)` → `missingRequired` / conflicto → blocker (commit: 400 `RESERVATION_IMPORT_MAPPING_INCOMPLETE` / `RESERVATION_IMPORT_MAPPING_CONFLICT`).
4. Catálogos en **5-6 consultas totales, nunca por fila**: `property` (currency, timezone); `businessDate = getCurrentBusinessDate(propertyId)`; `roomTypes` de la propiedad + `totalRooms` por tipo con **la misma consulta** que `createReservation` (`room.count({ propertyId, roomTypeId, sellable: true, maintenanceStatus: { not: "blocked" } })` [V :628-634]); `ratePlans` activos e inactivos (para distinguir `RATE_PLAN_INACTIVE`); `rooms` (id, number, roomTypeId, sellable, maintenanceStatus).
5. `normalizeTable(parsed, mapping, catalogs, options)` (puro, §5.3) incluidos los duplicados **dentro del fichero**.
6. Duplicados contra BD (§5.4): referencias, huéspedes por documento/e-mail, heurística huésped + llegada + tipo.
7. Habitación: `canAssignRoom({ propertyId, reservationId: "import-preview", roomId, arrivalDate, departureDate })` [V inventory.engine.ts:36] no permitido → `RESERVATION_IMPORT_ROW_ROOM_UNAVAILABLE`.
8. Permisos por fila (defensa en profundidad; el manifiesto ya lo exige): fila cancelada o con habitación sin `pms.reservation.modify` → `RESERVATION_IMPORT_ROW_PERMISSION`.
9. Total: importe del fichero → `totalSource: file`; vacío → `quoteReservationTotal({ propertyId, roomTypeId, ratePlanId, arrivalDate, departureDate }) × roomsCount` [V room-charge.service.ts:223] → `priceSource rate_plan` → `quoted` + aviso; `partial | none` → `0` + aviso.
10. Disponibilidad (`planAvailability`, §5.5).
11. Veredicto por fila (`error > skipped > warning > valid`), `summary { valid, warning, error, skipped, historical, toCreate }`, `contentHash`, `duplicates.ofImport`, `canImport`, `blockers`, `warnings`.

`previewReservationImport` **nunca escribe** (salvo la fila `business_dates` que `getCurrentBusinessDate` crea si falta, comportamiento existente) y devuelve `rows` completas con `issues` pero `normalized` solo en la muestra (`sampleSize` 200, máx. 1.000). Con `strict` (commit): errores de fila sin `omitirInvalidas` → 400 `RESERVATION_IMPORT_INVALID`; 0 a crear → 400 `RESERVATION_IMPORT_EMPTY`; duplicado sin `force` → 409 `RESERVATION_IMPORT_DUPLICATE`.

### 5.2 Mapeo (`reservation-import.mapping.ts`, puro)

`suggestMapping(header)`: por columna, exacto plegado contra campo y sinónimos → `includes` bidireccional (≥ 3 caracteres, gana el sinónimo más largo) → sin mapear; `mappingSource` por columna `explicit | synonym | fuzzy | none`; cada campo una sola vez (la primera columna gana; la repetida queda sin mapear con aviso). `applyMapping(header, explicit?)`: el mapeo explícito prevalece (`null` = «Ignorar columna»); campo asignado a dos columnas → conflicto; columna del mapeo ausente en la cabecera → conflicto; devuelve `{ mapping, mappingSource, unmappedColumns, missingRequired, splitName }`. Los normalizadores de catálogo (regimen, canal, segmento, metodo_pago, estado, vip, documento_tipo, nacionalidad) viven aquí y son funciones puras sobre el valor plegado (§2.2).

### 5.3 Validaciones por fila (`reservation-import.normalize.ts`, puro, catálogos inyectados)

`normalizeRow(cells, kinds, mappingByIndex, catalogs, options): { normalized?; issues[] }` y `normalizeTable(...)`. Reglas: fechas de §2.2 con calendario real (round-trip `Date.UTC`; 31/02 → `INVALID_DATE`); `salida` vacía + `noches` → llegada + noches; ambas presentes e incoherentes → `NIGHTS_MISMATCH`; salida ≤ llegada → `DATE_ORDER`; noches < 1 o > 365 → `INVALID_NIGHTS`; llegada > `businessDate` + 730 días → aviso `FAR_FUTURE`; noches > 60 → aviso `LONG_STAY`; importes con `parseAmount` de `payroll/cost-import.parser.ts` (reutilizado); enteros (`adultos` vacío → 1, 0 → `ADULTS_REQUIRED`; `ninos`/`bebes` → 0; `habitaciones` → 1; no enteros → `INVALID_NUMBER`); moneda ≠ propiedad → `INVALID_CURRENCY`; tipo: código plegado igual → nombre plegado igual → nombre contiene / `ROOM_TYPE_SYNONYMS` con candidato único (aviso `ROOM_TYPE_FUZZY`) → `ROOM_TYPE_UNKNOWN` (details `suggestions`); `active = false` → `ROOM_TYPE_INACTIVE`; tarifa: código → nombre → vacío = `defaultRatePlanId` (aviso `RATE_PLAN_DEFAULTED` solo si la columna está mapeada y vacía); inexistente → `RATE_PLAN_UNKNOWN`; inactiva → `RATE_PLAN_INACTIVE`; habitación: número inexistente → `ROOM_UNKNOWN`; de otro tipo → `ROOM_TYPE_MISMATCH`; `habitaciones > 1` con habitación → `ROOM_WITH_MULTIPLE_ROOMS`; misma habitación en otra fila con noches solapadas → `ROOM_DUPLICATE_IN_FILE`; ocupación `adultos + ninos > maxOccupancy × habitaciones` → `OCCUPANCY_EXCEEDED`; longitudes (§2.2) → truncar + `CELL_TRUNCATED`; `documento_numero` en mayúsculas sin espacios.

### 5.4 Duplicados

| Ámbito | Regla | Resultado |
|---|---|---|
| Dentro del fichero | misma `referencia_externa` en dos filas (la primera gana) | 2.ª fila `skipped` `RESERVATION_IMPORT_ROW_DUPLICATE_IN_FILE` |
| Dentro del fichero | misma habitación con noches solapadas | error `ROOM_DUPLICATE_IN_FILE` |
| Dentro del fichero | mismo huésped (documento, e-mail o apellidos + nombre plegados) + misma llegada + mismo tipo | aviso `POSSIBLE_DUPLICATE` |
| Contra BD | `reservation.findMany({ propertyId, externalReference: { in }, deletedAt: null })` con `status ∉ { cancelled, no_show }` | `skipped` `DUPLICATE_REFERENCE` (details `reservationCode`) |
| Contra BD | referencia existente en reserva `cancelled` / `no_show` | aviso `REFERENCE_REUSED_CANCELLED`; se crea una reserva nueva |
| Contra BD | `guest.findMany({ organizationId, OR: [{ documentNumber: { in } }, { email: { in } }] })` (`equals`/`in` reescritos a lookup hash por `crypto-fields.ts:355`) | `guestReuse: document \| email` + aviso `GUEST_REUSED`; `GUEST_NAME_MISMATCH` si el apellido plegado difiere; **nunca se sobreescribe el huésped** |
| Contra BD | con `guestId`: `reservation.findFirst({ propertyId, arrivalDate, roomTypeId, status ∉ { cancelled, no_show }, reservationGuests: { some: { guestId } } })` | aviso `POSSIBLE_DUPLICATE` (no bloquea: puede ser una segunda habitación del mismo cliente) |

### 5.5 Disponibilidad (`reservation-import.availability.ts`, puro)

`planAvailability({ rows, inventory: Map<roomTypeId, totalRooms>, existing }) → { perRow, byRoomType }` con `existing` = `reservation.findMany({ propertyId, status: { in: [confirmed, checked_in] }, arrivalDate: { lt: maxDeparture }, departureDate: { gt: minArrival } }, select roomTypeId/arrivalDate/departureDate/roomsCount)` (sin filtrar `deletedAt`, igual que el servicio [V :640-650]). Para cada fila que se va a crear (no omitida, sin errores previos, **no histórica**), en orden de fichero: `bookedDb` = Σ `roomsCount` de reservas del tipo con `arrival < salidaFila` y `departure > llegadaFila`; `bookedFile` = Σ `roomsCount` de las filas **anteriores** aceptadas del mismo tipo que solapan y quedan confirmadas (las canceladas se comprueban pero no cuentan para las siguientes; las tentativas se crean confirmadas y cuentan); `exceeds = bookedDb + bookedFile + roomsCount > totalRooms` → error `RESERVATION_IMPORT_ROW_NO_AVAILABILITY` o, con `permitirOverbooking`, aviso `RESERVATION_IMPORT_ROW_OVERBOOKING` (la fila sigue contando para las siguientes). Además, tabla tipo × noche **informativa**: `nightsExceeded` (noches en las que Σ por noche supera el cupo) y `rangeRuleRows` (filas rechazadas por la regla de rango que cabrían por noche) para que la UI explique la conservadoridad del PMS.

**Ejemplo verificado** [V reproducido contra :640-655]: tipo con 2 habitaciones, A 1→2, B 3→4, C 1→4: por noche caben (máx. 2 por noche), pero para C el PMS suma A y B (ambas solapan el rango 1→4) → 2 + 1 > 2 → 409. La preview marca C con `NO_AVAILABILITY` y la lista en `rangeRuleRows`.

**Concurrencia preview → commit:** el commit vuelve a analizar y `createReservation` decide bajo lock; una fila puede pasar de válida a `NO_AVAILABILITY` / `CREATE_FAILED` en el resultado; **nunca** se crea por encima del cupo sin `permitirOverbooking`.

### 5.6 Fechas pasadas e histórico

Con el **hoy de la propiedad** (`catalogs.today` = `todayInTimezone(property.timezone)`, exportado por pms.service: la MISMA frontera que la guarda `historical` de `createReservation`; ronda 1, T7-FUN-01 — la fecha de negocio no sirve porque con días sin cerrar va por detrás del calendario y dejaba crear confirmadas llegadas ya pasadas y rechazaba como «en curso» estancias terminadas): llegada ≥ `today` → normal. Llegada < `today`: sin `historico` → error `RESERVATION_IMPORT_ROW_PAST_ARRIVAL` («la auditoría nocturna la marcaría no-show con cargo; activa «histórico»»); con `historico` y salida ≤ `today` → `historical = true` + aviso `HISTORICAL` (estado `tentativa`/`cancelada` ignorado con aviso `STATUS_IGNORED_HISTORICAL`; se crea `checked_out`); con `historico` y salida > `today` (estancia en curso) → error `IN_HOUSE_PAST` (no se puede fabricar un check-in retroactivo: se hace por recepción). La preview devuelve `businessDate` y `today`; si `businessDate < today` añade un aviso en `warnings` (días sin cerrar). Las filas históricas no entran en el planificador de disponibilidad (no consumen inventario futuro) y su `Stay` solo existe si la fila trae `habitacion` (§11.2).

### 5.7 Hash, veredicto y GDPR

`reservationImportContentHash(rows)` = sha256 hex del JSON canónico (claves ordenadas) de las filas normalizadas ordenadas por `(externalReference ?? "", arrivalDate, departureDate, roomTypeCode, email ?? documentNumber ?? apellidos+nombre plegados)` → mismo hash para CSV/XLSX, otro orden de filas, BOM o espacios; distinto al cambiar una celda. Ronda 1 (T7-FUN-03): las filas del hash salen de `contentHashRowsOf(parsed, mapping, catalogs)` = `normalizeTable` con `today = 1900-01-01` y sin `historico`, de modo que el hash no depende de la opción «histórico» ni del día de la importación (antes una llegada pasada era error → celdas sin la opción y fila normalizada con ella, y el mismo fichero daba dos lotes distintos). `duplicates.ofImport = reservationImport.findFirst({ propertyId, contentHash, status: { notIn: [undone, failed] } }, orderBy createdAt desc)` → sin `force` blocker «Este fichero ya se importó (lote …)»; con `force` aviso + `optionsJson.duplicateOfImportId`. `canImport = mapeo completo ∧ (error === 0 ∨ omitirInvalidas) ∧ toCreate > 0 ∧ (¬ofImport ∨ force)`. `ReservationImportPreview` = `{ propertyId; format; fileName; contentHash; encoding; delimiter?; sheetName?; header; mapping; mappingSource; unmappedColumns; missingRequired; catalog { roomTypes[{ id, code, name, maxOccupancy, totalRooms, active }], ratePlans[{ id, code, name }], defaultRatePlanCode, currency }; businessDate; rowCount; summary; rows; sampleSize; availability { byRoomType; overbookingRows }; duplicates { byReferenceRows; inFileRows; possibleRows; ofImport }; totals { fromFile; quoted; currency }; options; canImport; blockers; warnings }`. `stripRowValues` garantiza que todo `errorMessage` / `warnings` persistido o devuelto cita columna y nº de fila, nunca valores.

### 5.8 Catálogo de códigos de fila (`RESERVATION_IMPORT_ROW_CODES`)

| Código | Tipo | Significado | Acción del usuario |
|---|---|---|---|
| `RESERVATION_IMPORT_ROW_MISSING_FIELD` | error | falta un campo obligatorio (llegada, tipo, nombre/apellidos, salida o noches) | rellenar la celda o mapear la columna |
| `RESERVATION_IMPORT_ROW_INVALID_DATE` | error | fecha no reconocida o inexistente (31/02) | usar `YYYY-MM-DD` |
| `RESERVATION_IMPORT_ROW_DATE_ORDER` | error | salida ≤ llegada | corregir fechas |
| `RESERVATION_IMPORT_ROW_NIGHTS_MISMATCH` | error | `salida` y `noches` presentes e incoherentes | dejar solo una o corregir |
| `RESERVATION_IMPORT_ROW_INVALID_NIGHTS` | error | noches < 1 o > 365 | corregir |
| `RESERVATION_IMPORT_ROW_PAST_ARRIVAL` | error | llegada anterior a hoy (zona de la propiedad) sin `historico` | activar «histórico» o quitar la fila |
| `RESERVATION_IMPORT_ROW_IN_HOUSE_PAST` | error | llegada pasada y salida futura (estancia en curso) con `historico` | crear por recepción y hacer check-in |
| `RESERVATION_IMPORT_ROW_ROOM_TYPE_UNKNOWN` | error | tipo no resuelto por código, nombre ni sinónimo (details `suggestions`) | usar el código del catálogo |
| `RESERVATION_IMPORT_ROW_ROOM_TYPE_INACTIVE` | error | tipo desactivado | activarlo o cambiar de tipo |
| `RESERVATION_IMPORT_ROW_RATE_PLAN_UNKNOWN` | error | tarifa no resuelta | usar código de tarifa o dejar vacío (BAR) |
| `RESERVATION_IMPORT_ROW_RATE_PLAN_INACTIVE` | error | tarifa desactivada | otra tarifa |
| `RESERVATION_IMPORT_ROW_ROOM_UNKNOWN` | error | número de habitación inexistente | corregir o dejar vacío |
| `RESERVATION_IMPORT_ROW_ROOM_TYPE_MISMATCH` | error | la habitación es de otro tipo | corregir tipo o habitación |
| `RESERVATION_IMPORT_ROW_ROOM_UNAVAILABLE` | error | `canAssignRoom` la rechaza (ocupada, bloqueada, no vendible) | dejar vacío: se asigna después |
| `RESERVATION_IMPORT_ROW_ROOM_DUPLICATE_IN_FILE` | error | misma habitación con noches solapadas en otra fila | corregir |
| `RESERVATION_IMPORT_ROW_ROOM_WITH_MULTIPLE_ROOMS` | error | habitación fija con `habitaciones > 1` | una fila por habitación |
| `RESERVATION_IMPORT_ROW_INVALID_NUMBER` | error | adultos/niños/bebés/habitaciones no enteros | corregir |
| `RESERVATION_IMPORT_ROW_ADULTS_REQUIRED` | error | 0 adultos | al menos 1 |
| `RESERVATION_IMPORT_ROW_OCCUPANCY_EXCEEDED` | error | adultos + niños > ocupación máxima × habitaciones | más habitaciones u otro tipo |
| `RESERVATION_IMPORT_ROW_INVALID_STATUS` | error | estado fuera de confirmada/tentativa/cancelada | corregir |
| `RESERVATION_IMPORT_ROW_INVALID_AMOUNT` | error | importe no numérico, negativo o > 999.999,99 | corregir |
| `RESERVATION_IMPORT_ROW_INVALID_CURRENCY` | error | moneda distinta de la de la propiedad | convertir fuera o vaciar |
| `RESERVATION_IMPORT_ROW_NO_AVAILABILITY` | error | regla de rango del PMS excedida (BD + filas anteriores) | reducir, cambiar fechas/tipo o «permitir overbooking» |
| `RESERVATION_IMPORT_ROW_PERMISSION` | error | fila cancelada o con habitación sin `pms.reservation.modify` | pedir el permiso |
| `RESERVATION_IMPORT_ROW_CREATE_FAILED` | error (commit) | `createReservation` rechazó la fila (mensaje del servicio sin PII) | leer el mensaje y reimportar la fila |
| `RESERVATION_IMPORT_ROW_CODE_CONFLICT` | error (commit) | `RESERVATION_CODE_CONFLICT` tras reintentos | reimportar la fila |
| `RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE` | omisión | referencia ya existe en una reserva activa (details `reservationCode`) | nada: ya está |
| `RESERVATION_IMPORT_ROW_DUPLICATE_IN_FILE` | omisión | referencia repetida en el fichero (gana la primera) | quitar la fila |
| `RESERVATION_IMPORT_ROW_INVALID_SKIPPED` | omisión | fila con errores omitida por `omitirInvalidas` (primer error en details) | corregir y reimportar solo esas filas |
| `RESERVATION_IMPORT_ROW_DATE_FROM_SERIAL` | aviso | fecha leída de un serial Excel | comprobar la fecha |
| `RESERVATION_IMPORT_ROW_NAME_SPLIT` | aviso | nombre completo partido en nombre/apellidos | revisar si el reparto es correcto |
| `RESERVATION_IMPORT_ROW_EMAIL_DROPPED` | aviso | e-mail con formato inválido, descartado (no bloquea) | completar en la ficha del huésped |
| `RESERVATION_IMPORT_ROW_PHONE_DROPPED` | aviso | teléfono sin 7..20 dígitos, descartado | completar en la ficha del huésped |
| `RESERVATION_IMPORT_ROW_NATIONALITY_DROPPED` | aviso | nacionalidad fuera de la tabla alfa-2/alfa-3, descartada | usar el código ISO alfa-3 |
| `RESERVATION_IMPORT_ROW_BOARD_UNKNOWN` | aviso | régimen fuera del catálogo, descartado | usar RO/BB/HB/FB/AI o los nombres admitidos |
| `RESERVATION_IMPORT_ROW_CHANNEL_UNKNOWN` | aviso | canal desconocido, guardado plegado (≤ 80) | usar los canales admitidos |
| `RESERVATION_IMPORT_ROW_SEGMENT_UNKNOWN` | aviso | segmento desconocido, guardado plegado | usar los segmentos admitidos |
| `RESERVATION_IMPORT_ROW_PAYMENT_METHOD_UNKNOWN` | aviso | método de pago desconocido, guardado plegado (≤ 40) | usar los métodos admitidos |
| `RESERVATION_IMPORT_ROW_DOCUMENT_TYPE_UNKNOWN` | aviso | tipo de documento fuera de DNI/NIE/PASSPORT/TIE, guardado en mayúsculas | usar los tipos admitidos |
| `RESERVATION_IMPORT_ROW_VIP_UNKNOWN` | aviso | valor de `vip` no reconocido → `false` | usar sí/no |
| `RESERVATION_IMPORT_ROW_ROOM_TYPE_FUZZY` | aviso | tipo resuelto por contención o sinónimo | comprobar el tipo |
| `RESERVATION_IMPORT_ROW_RATE_PLAN_DEFAULTED` | aviso | tarifa vacía → BAR por defecto | — |
| `RESERVATION_IMPORT_ROW_REFERENCE_REUSED_CANCELLED` | aviso | referencia existente en una reserva cancelada/no-show | comprobar que no es una reactivación |
| `RESERVATION_IMPORT_ROW_POSSIBLE_DUPLICATE` | aviso | mismo huésped + llegada + tipo en BD o en el fichero | comprobar |
| `RESERVATION_IMPORT_ROW_GUEST_REUSED` | aviso | huésped existente reutilizado por documento o e-mail | — (nunca se sobreescribe la ficha) |
| `RESERVATION_IMPORT_ROW_GUEST_NAME_MISMATCH` | aviso | el apellido del fichero difiere del de la ficha reutilizada | revisar la ficha del huésped |
| `RESERVATION_IMPORT_ROW_TOTAL_QUOTED` | aviso | importe vacío cotizado desde la tarifa (`quoteReservationTotal`) | comprobar el importe |
| `RESERVATION_IMPORT_ROW_TOTAL_NOT_QUOTED` | aviso | importe vacío y sin precio en la tarifa → 0 | informar `importe_total` o publicar la parrilla |
| `RESERVATION_IMPORT_ROW_OVERBOOKING` | aviso | fila por encima del cupo con `permitirOverbooking` | decisión operativa consciente |
| `RESERVATION_IMPORT_ROW_FAR_FUTURE` | aviso | llegada a más de 730 días de hoy | comprobar el año |
| `RESERVATION_IMPORT_ROW_LONG_STAY` | aviso | más de 60 noches | comprobar las fechas |
| `RESERVATION_IMPORT_ROW_HISTORICAL` | aviso | fila creada como estancia cerrada (`checked_out`, folio cerrado) | — |
| `RESERVATION_IMPORT_ROW_STATUS_IGNORED_HISTORICAL` | aviso | `tentativa`/`cancelada` ignorado en una fila histórica | — |
| `RESERVATION_IMPORT_ROW_TENTATIVE_AS_CONFIRMED` | aviso | tentativa creada como confirmada con nota interna | confirmar con el cliente |
| `RESERVATION_IMPORT_ROW_CANCELLED_AT_IMPORT` | aviso | fila creada y cancelada en el mismo commit | — |
| `RESERVATION_IMPORT_ROW_CELL_TRUNCATED` | aviso | celda recortada al máximo del campo | acortar el texto |
| `RESERVATION_IMPORT_ROW_ROOM_ASSIGN_FAILED` | aviso (commit) | la reserva se creó pero `assignRoom` falló (carrera) | asignar desde recepción |

---

## §6 · Importación y deshacer

### 6.1 `importReservations({ context, propertyId, body, createdBy?, correlationId, source: http | cli })`

1. `requirePermissions(["pms.reservation.create", "pms.reservation.modify"])` + `assertPropertyInOrg`.
2. `analysis = analyse({ strict: true })` (400/409 de §5.1 antes de escribir nada).
3. Transacción **corta** bajo `pg_advisory_xact_lock(hashtext('reservation_import:' || propertyId))`: `findFirst` duplicado por hash (`status notIn [undone, failed]`) → 409 salvo `force`; `tx.reservationImport.create({ status: "processing", format, fileName, contentHash, rowCount, mappingJson, optionsJson, currency, createdBy, organizationId, propertyId })`. **El `importId` existe antes de la primera reserva.**
4. Bucle **estrictamente secuencial** por fila (nunca en paralelo: lock por (propiedad, tipo) y `allocateReservationCode`), cada iteración en `try/catch`: fila omitida → resultado `skipped` con su código; `guest = resolveGuest(row)` (§6.3); `created = await createReservation(buildCreateReservationInput(...))` (§6.2); habitación no histórica → `assignRoom({ context, reservationId, roomId, correlationId })` (lock real, auditoría `ROOM_ASSIGNED`; fallo → aviso `ROOM_ASSIGN_FAILED`, reserva conservada sin habitación); estado `cancelada` no histórica → `transitionReservation({ context, reservationId, status: "cancelled", reason: "Importada como cancelada (lote <id>)", correlationId })` + aviso; `tentativa` → aviso; resultado `created` con `reservationId`/`code` y avisos (normalización + commit). Errores: `ConflictError` de disponibilidad → `NO_AVAILABILITY`; `RESERVATION_CODE_CONFLICT` → `CODE_CONFLICT`; `BadRequest`/`HttpError` → `CREATE_FAILED` con el mensaje del servicio (sin PII); Prisma → `describePrismaError`; otro → «Error interno al crear la reserva.» + log con `correlationId` (`sanitizeRowError`). Cada 100 resultados y al final, `reservationImportRow.createMany` (`organizationId`/`propertyId` desnormalizados, sin PII).
5. Cierre: `update` de contadores (`warningCount` = filas con ≥ 1 aviso), `arrivalFrom`/`arrivalTo` y `totalAmount` (Σ creadas), `optionsJson.durationMs`, `status = deriveImportStatus(...)` = `createdCount === 0 ? failed : (errorCount + skippedCount > 0 ? partial : imported)`. Si el proceso muere, el lote queda `processing` («Interrumpida», deshacible).
6. Fuera de transacción: `recordAuditEvent({ organizationId, propertyId, actorUserId, actorType: "user", action: "RESERVATION_IMPORT_COMMITTED", entityType: "reservation_import", entityId: importId, afterJson: { status, rowCount, createdCount, skippedCount, errorCount, warningCount, mapping, options, contentHash, fileName }, deviceId, correlationId })`. Devuelve lote + filas + `warnings` (HTTP **201 siempre que el lote exista**, incluso `failed`).

### 6.2 `buildCreateReservationInput` (fila → `createReservation`)

| Campo de `createReservation` | Origen |
|---|---|
| `propertyId, roomTypeId, ratePlanId, arrivalDate, departureDate, adults, children, infants, roomsCount, boardType, marketSegment, channel, sourceCode, externalReference, companyName, travelAgentName, groupCode, specialRequests, notes, estimatedArrivalTime, eta, paymentMethod, depositAmount, vipFlag` | fila normalizada |
| `totalAmount` / `currency` | `Number(total)` del fichero o cotizado / moneda de la propiedad |
| `bookingSource` | `import:<importId>` (clave del lote y del deshacer) |
| `bookerName` | «<nombre> <apellidos>» |
| `bookerEmail` | **nunca** (evita la plantilla `reservation_confirmed`) |
| `internalNotes` | tentativa → «Importada como tentativa: confirmar con el cliente (lote <id>)» |
| `primaryGuestId` / `primaryGuest` | huésped hallado → `primaryGuestId`; si no → `primaryGuest { firstName, surname1, surname2, email, phone, nationality, documentType, documentNumber, company }` |
| `allowOverbooking` | `options.permitirOverbooking` (ronda 1, T7-FUN-07: antes solo si la fila excedía el cupo en el análisis, y una fila que dejaba de caber entre el análisis y su creación acababa en 409 pese a la opción; `createReservation` solo anota `overbooking` en la auditoría cuando de verdad excede) |
| `historical` / `assignedRoomId` | `row.historical` / solo si histórica y con habitación (las no históricas pasan por `assignRoom`) |
| `correlationId` | el del lote (una correlación por importación) |

### 6.3 Huéspedes (`resolveGuest`)

Por documento → `guest.findFirst({ organizationId, documentNumber })`; si no, por e-mail → `findFirst({ organizationId, email })`; **nunca por nombre**; **nunca se actualiza** un huésped existente (la ficha manda; el aviso `GUEST_NAME_MISMATCH` avisa de la discrepancia). Sin coincidencia → `createReservation` da de alta el `Guest` con los datos del fichero (como una reserva de recepción). Un mismo e-mail repetido dentro del fichero reutiliza el huésped creado por la primera fila (el commit es secuencial).

### 6.4 Idempotencia doble

| Capa | Mecanismo | Efecto |
|---|---|---|
| Fichero | hash de filas normalizadas bajo advisory lock por propiedad; lotes `undone`/`failed` no cuentan | 409 `RESERVATION_IMPORT_DUPLICATE` (details `importId`, `createdAt`, `status`, `fileName`) salvo `force`; con `force`, lote nuevo con `optionsJson.duplicateOfImportId` |
| Fila | `externalReference` en reserva activa de la propiedad | `skipped` `DUPLICATE_REFERENCE`; referencias de canceladas/no-show reutilizables (aviso) |

Consecuencia: reimportar un fichero sin referencias externas tras un `--undo` funciona (hash libre) y crea reservas nuevas; reimportarlo **sin** deshacer exige `force` y duplicará las filas sin referencia (aviso `POSSIBLE_DUPLICATE` por huésped + llegada + tipo).

### 6.5 Deshacer (`undoReservationImport({ context, propertyId, importId, reason?, correlationId })`)

`requirePermissions(["pms.reservation.modify"])`; lote de la propiedad o 404 `RESERVATION_IMPORT_NOT_FOUND`; `status = undone` → `{ ...lote, alreadyUndone: true, cancelledReservationIds: [] }` (idempotente). Reclamación **atómica**: `updateMany({ where: { id, status: { not: undone }, OR: [{ undoneAt: null }, { undoneAt: { lt: now − 15 min } }] }, data: { undoneAt: now, undoneBy, undoReason: reason ?? "Importación deshecha" } })` → `count 0` → 409 `RESERVATION_IMPORT_UNDO_IN_PROGRESS` (otro deshacer en curso; se libera solo a los 15 min). Reservas = `reservation.findMany({ propertyId, bookingSource: "import:<id>", deletedAt: null }, select id/status/code)` (**no depende de las filas persistidas**). Por reserva: `draft | confirmed` → `transitionReservation(cancelled, reason "Importación deshecha (lote <id>)" + motivo)` → `cancelled`; `checked_in | checked_out` (históricas incluidas) → `kept`; `cancelled | no_show` → `skipped`; fallo individual → log + `kept` con aviso. `rows.updateMany` de `undoOutcome` por `reservationId`; cierre `status undone`, `undoneCount`, `undoKeptCount`; auditoría `RESERVATION_IMPORT_UNDONE` (counts + reason). Como la cancelación del PMS: **no** libera `assignedRoomId`, **no** cierra folios ni cobra fee.

### 6.6 Lecturas y plantilla

`listReservationImports({ context, propertyId, query })` (`pms.reservation.read`; `orderBy createdAt desc`; `limit` 50, máx. 200; filtro `status`); `getReservationImport({ context, propertyId, importId })` (lote + filas por `rowNumber`); `buildReservationImportTemplate(format): { buffer, contentType, fileName }` (`reservation-import.template.ts`, `csvDocument` / `writeXlsx` existentes, §2.1).

---

## §7 · API

Fichero `apps/api/src/modules/pms/reservation-import.routes.ts` (`registerReservationImportRoutes(app)`, paths literales para el extractor del contrato), registro en `server.ts` (import junto a la línea 96; `registerReservationImportRoutes(app); // Importación masiva de reservas (Tanda 7 · L3)` tras la 2717; orden: `template` antes que `:id`, `preview` antes que `:id/undo`). El preHandler global (`server.ts:1389-1398` → `grantPropertyAccess`) cubre `:propertyId` con 404 opaco. Partial **`apps/api/src/modules/pms/route-permissions.partial.ts`** (nombre exacto que lee `rbac-nav-contract`; `export const reservationImportRoutePermissions: ApiRoutePermission[]`, seis entradas, una por línea, claves `method, path, permissions, riskLevel`) e inserción en `security/route-permissions.ts` (`...reservationImportRoutePermissions,` tras `...payrollRoutePermissions,`, l.125). Sin claves nuevas → sin `rbac:sync`. Tenencia: `lib/tenancy.ts` añade `reservationImport: byProperty("Importación de reservas no encontrada.", (id) => prisma.reservationImport.findUnique({ where: { id }, select: selectProperty }))` junto a `reservation` (l.287).

| Método y ruta | Clave (riesgo) | Cuerpo / query | Respuesta |
|---|---|---|---|
| `POST /properties/:propertyId/reservations/imports/preview` | `pms.reservation.create` (medium) | `PreviewReservationImportSchema` (§7.2); `bodyLimit` 8 MiB; rate limit 30/min | 200 `ReservationImportPreview` (nunca escribe) |
| `POST /properties/:propertyId/reservations/imports` | `pms.reservation.create` + `pms.reservation.modify` (high) | preview + `{ commit: true }`; mismas opciones de ruta; `correlationId = createId("corr")`, `createdBy = userId`, `source: "http"` | 201 `ReservationImportResult` (incluso `failed`) |
| `GET /properties/:propertyId/reservations/imports` | `pms.reservation.read` (low) | `{ status?: ReservationImportStatus; limit?: 1..200 = 50 }` | 200 `ReservationImportRecord[]` (`createdAt` desc) |
| `GET /properties/:propertyId/reservations/imports/template` | `pms.reservation.read` (low) | `?format=csv\|xlsx` (default csv) | fichero (`content-type`, `content-disposition: attachment`, `cache-control: no-store`; patrón `financial-statements.routes.ts:72-77`) |
| `GET /properties/:propertyId/reservations/imports/:id` | `pms.reservation.read` (low) | `assertEntityAccess(request, { entity: "reservationImport", id, propertyId })` | 200 `ReservationImportDetail` (lote + filas) |
| `POST /properties/:propertyId/reservations/imports/:id/undo` | `pms.reservation.modify` (high) | `assertEntityAccess` + `{ reason?: ≤ 500 }` | 200 `ReservationImportUndoResult` (idempotente) |

Las rutas high rechazan el fallback demo sin token (`server.ts:1339-1344`): el test HTTP de integración solo ejercita lecturas y preview; el commit y el deshacer se prueban en la integración de servicio sobre una organización aislada y en la demo con el CLI.

### 7.2 Esquemas zod (`apps/api/src/schemas/reservation-import.schemas.ts`)

`.strict({ message: "Campo no admitido en el cuerpo de la petición." })`, mensajes en español. `previewShape = { fileName: string trim 1..200 opt; format: enum csv|xlsx opt; content: string 1..5·1024·1024 opt; contentBase64: string 1..7·1024·1024 regex /^[A-Za-z0-9+/=\r\n]+$/ opt; sheetName: string 1..64 opt; mapping: z.record(z.string().min(1).max(200), z.enum(RESERVATION_IMPORT_FIELDS).nullable()).refine(≤ 200 claves) opt; omitirInvalidas / permitirOverbooking / historico / force: boolean default false; sampleSize: coerce int 1..1000 opt }` + `refine` «Indica content (texto) o contentBase64 (fichero), no ambos.»; `CreateReservationImportSchema = previewShape + { commit: z.literal(true) }`; `ListReservationImportsQuerySchema { status?; limit }`; `UndoReservationImportSchema { reason: string trim max 500 opt }`; `TemplateQuerySchema { format default csv }`; tipos `z.infer` exportados.

### 7.3 Códigos de error de lote (`RESERVATION_IMPORT_ERROR_CODES`; `details.code` siempre; helpers `importBadRequest` / `importConflict` / `importNotFound` con la forma de `accounting.service.ts:170-186`)

| Código | Status | `details` | Cuándo | Acción del usuario |
|---|---|---|---|---|
| `VALIDATION_ERROR` | 400 | issues zod (español) | clave desconocida, `content` y `contentBase64` a la vez, `commit` ≠ true, `limit` fuera de 1..200, `reason` > 500 | corregir la petición |
| `RESERVATION_IMPORT_UNREADABLE` | 400 | `{ reason }` | no es ZIP, ZIP64, bomba, XML roto, > 200 columnas | guardar como .xlsx normal o CSV |
| `RESERVATION_IMPORT_TOO_LARGE` | 400 | `{ bytes, max }` | > 5 MiB (413 de Fastify si el cuerpo supera los 8 MiB de `bodyLimit`) | partir el fichero o usar el CLI |
| `RESERVATION_IMPORT_TOO_MANY_ROWS` | 400 | `{ rows, max }` | > 5.000 filas de datos | partir el fichero |
| `RESERVATION_IMPORT_EMPTY` | 400 | — | sin filas de datos, o 0 filas a crear en el commit | revisar el fichero o los blockers |
| `RESERVATION_IMPORT_MAPPING_INCOMPLETE` | 400 | `{ missing }` | campo obligatorio sin columna | mapear en el paso «Columnas» |
| `RESERVATION_IMPORT_MAPPING_CONFLICT` | 400 | `{ field, columns }` | campo en dos columnas o columna inexistente | corregir el mapeo |
| `RESERVATION_IMPORT_INVALID` | 400 | `{ errorCount, rows[≤ 50]: { rowNumber, code } }` | commit con errores de fila sin `omitirInvalidas` | corregir o activar «Omitir filas inválidas» |
| `RESERVATION_IMPORT_DUPLICATE` | 409 | `{ importId, createdAt, status, fileName }` | mismo hash en lote no deshecho/fallido sin `force` | deshacer el anterior o «Importar de todos modos» |
| `RESERVATION_IMPORT_NOT_FOUND` | 404 (opaco) | — | lote inexistente, de otra propiedad u organización | — |
| `RESERVATION_IMPORT_UNDO_IN_PROGRESS` | 409 | `{ importId, undoneAt }` | otro deshacer reclamado hace < 15 min | esperar |

Docs: bloque «### Importación masiva de reservas (Tanda 7)» bajo «## PMS» de `docs/api-contracts.md` (tras la línea 101), un bullet denso (rutas, permisos/riesgo, cuerpos, límites, códigos, idempotencia/deshacer/histórico, CLI, tests) sin tocar las frases pinneadas «Route Permissions», «Every registered route», «RBAC_STRICT», «service-level validation».

---

## §8 · CLI (`apps/api/src/scripts/import-reservations.ts`, script npm `reservations:import`)

Clon estructural de `import-payroll-cost.ts`: cabecera de uso, `SYSTEM_USER_ID = "usr_system_reservation_import"`, `CREATED_BY = SYSTEM_USER_ID` (ronda 1, FUX-02: el `createdBy` del lote es el propio actor de sistema para que la pantalla lo nombre por su proceso; `DEVICE_ID = "cli:import-reservations"` queda como `deviceId`), `CORRELATION_ID`, `SCRIPT_LABEL = "[reservations:import]"`, `CLI_PERMISSIONS = ["pms.reservation.read", "pms.reservation.create", "pms.reservation.modify"]`, `parseFlags` con `VALUE_FLAGS` y salida 2 en uso incorrecto, bytes con `readFileSync` → `contentBase64` (el parser decide codificación y formato), `systemContext(organizationId, propertyId)` resolviendo la organización desde `prisma.property` (exit 1 si no existe), guarda `entryFile === argFile`, `prisma.$disconnect` y exit code.

```
corepack pnpm --filter @hotelos/api reservations:import -- --file <ruta.csv|.xlsx> --property <propertyId> \
  [--sheet <nombre>] [--mapping <ruta.json | JSON inline>] [--apply] [--allow-overbooking] [--skip-invalid] \
  [--historical] [--force] [--sample <n>] [--json] [--export-xlsx <ruta.xlsx>]
corepack pnpm --filter @hotelos/api reservations:import -- --undo <importId> --property <propertyId> [--reason "…"]
corepack pnpm --filter @hotelos/api reservations:import -- --template <csv|xlsx> --out <ruta>
# equivalente: cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/import-reservations.ts …
```

| Modo | Qué hace | Exit |
|---|---|---|
| **Dry-run** (defecto) | `previewReservationImport` → tabla en español (fila · estado · referencia · llegada→salida · noches · tipo · tarifa · hab · huésped · importe · incidencias) limitada a `--sample` (200), resumen (válidas/avisos/errores/omitidas/histórico/a crear), disponibilidad por tipo (cupo, pico BD, pico fichero, noches excedidas, filas rechazadas por regla de rango), duplicados, mapeo efectivo y columnas sin mapear, blockers. **Nada escrito** | 0 si `canImport`, 1 si no |
| `--apply` | `hydrateAuditChainFromPostgres()` antes; `importReservations({ source: "cli", createdBy: CREATED_BY })`; imprime id, estado, contadores, rango de llegadas, total y filas creadas/omitidas/con error; `finally` `flushAuditQueues` + `flushAccountingProjection` + `flushExtraProjections` antes de `$disconnect`; `HttpError` → mensaje + `details.code` | 0 si `imported \| partial`, 1 si `failed` o error |
| `--undo <importId>` | `undoReservationImport` → canceladas / conservadas / `alreadyUndone` | 0 |
| `--template csv\|xlsx --out <ruta>` | escribe la plantilla oficial | 0 |
| `--export-xlsx <ruta>` | tras el dry-run, escribe las filas del fichero como `.xlsx` con la cabecera oficial (`writeXlsx`, fechas ISO como texto): genera el `.xlsx` de la demo y prueba el lector en ida y vuelta (**mismo `contentHash`**) | como el dry-run |
| `--json` | vuelca la respuesta del servicio | — |

Exclusiones: `--apply` / `--undo` / `--template`; `--undo` excluye `--file`. Aviso operativo heredado: ejecutar `--apply` y `--undo` con los API parados (cadena de auditoría in-memory, deuda 12(c)); el orquestador reinicia el API después. Invocación de referencia de la demo: `--file ~/anfitorio-demo/pilots/faranda-celuisma/reservas-demo-rias-altas.csv --property cmrhw9jy40003fyvbuu2ec2w7`.

---

## §9 · Front (Cocoa 22)

Restricciones verificadas: ficheros nuevos con **cero** `style={`, sin `.bo-*`, sin `<button>` / `<table>` / `<input>` crudos (salvo el `<input type="file">` interno de `CocoaFileInput`), sin colores literales, sin emoji, sin `Intl` / `toLocale*` / `toFixed` (`lib/format`: `date`, `dateRange`, `money`, `number`, `plural`, `EMPTY`), copy en español sin `FORBIDDEN_EN`, sin `fetch` crudo (solo `api-client`), sin `file.text()`. No existe primitiva de pasos utilizable sin `style={}` (el `CocoaStepper` del brief no está en `cocoa-22-api.mjs`; `ReservationCreateScreen.tsx:1100` usa `style={{ flex }}`): el asistente se compone con `CocoaChart.Progress` + `ol.c22-section__list` + `CocoaActionBar`.

| Pieza | Diseño |
|---|---|
| **Navegación** (5 toques en el mismo lote) | fila `ReservationImportScreen;nueva (Tanda 7);merge-into;ReservationWorkspace;Importar;/recepcion/reservas/importar;Importar;recepcion\|direccion\|comercial\|admin;core;<justificación sin «;»>;6` al final de `pilots/tanda5-nav-tree.csv` + `node scripts/build-nav-tree.mjs` (pestañas 98 → 99) y `--check`; fila en `pilots/screens-inventory.csv` (`api_paths` solo con rutas `pms.reservation.read`); `App.tsx` `ReservationImportScreen: ReservasTabs,`; `ReservasTabs.tsx` loader en una línea + botón de cabecera «Importar reservas» (`CocoaButton variant="bordered" tone="neutral" icon={<UploadIcon />}`); asserts `backoffice.routes.test.mts` 188 → 189, `nav-tree.test.mts` 98 → 99 y `67 + 99 + 21 + 2`, `reservation-route.test.mts` + «importar». Acción también en `ReservationsListScreen.tsx` (`commands` `reservas-importar` + botón bordered en `actions` no-hosted) y en `CocoaGlobalProvider.tsx` (`nav.reservation-import`, categoría «Navegación») |
| **Servicio** `services/reservationImportApi.ts` | `previewReservationImport`, `createReservationImport`, `listReservationImports`, `getReservationImport`, `undoReservationImport`, `downloadReservationImportTemplate` → `NamedDownload`, `reservationImportErrorMessage(error, fallback)` (`financeErrorMessage` + `switch details.code`: DUPLICATE → «Este fichero ya se importó (lote …). Activa «Importar de todos modos».», INVALID → «Hay N filas con errores: corrígelas o activa «Omitir filas inválidas».», MAPPING_INCOMPLETE, MAPPING_CONFLICT, TOO_LARGE, TOO_MANY_ROWS, UNREADABLE, EMPTY, UNDO_IN_PROGRESS; 413 → «El fichero supera el tamaño admitido (5 MB)»); solo `import type` de `@hotelos/shared` |
| **Helpers puros** `screens/reservations/reservation-import-helpers.ts` | `IMPORT_STEPS` (fichero · columnas · revisión · resultado), `stepTone`, `base64OfArrayBuffer` (btoa por trozos de 32 KiB), `detectFormatFromName`, `fieldOptions` (opción «Ignorar columna» + campos con «(obligatorio)»), `buildMapping`, `missingRequiredLabels`, `previewBlockers`, `rowStatusTone`, `importStatusLabel` / `importStatusTone` (5 estados), `filterRows`, `summaryKpis`, `issueText`, `buildImportReportCsv` (BOM, «;», CRLF: `fila;resultado;codigo_reserva;referencia_externa;llegada;salida;tipo_habitacion;tarifa;habitaciones;codigo_error;mensaje;avisos`), `undoSummary`; sin React, sin `api-client`, sin `import.meta` |
| **Pantalla** `ReservationImportScreen.tsx` | `<CocoaPage eyebrow="Recepción · Reservas" title="Importar reservas" …>`; `canImport = canDo(gate, "pms.reservation.create") && canDo(gate, "pms.reservation.modify")` + `cocoa-note` explicativa; `CocoaGrid columns={12} align="start"` → `CocoaSpan cols={4} min={240}` con `CocoaSection` «Pasos» (`meta` «n / 4`, `CocoaChart.Progress`, `ol.c22-section__list` de `CocoaButton variant="plain" wrap fullWidth align="start" aria-current="step"` + `CocoaBadge variant="dot"` hecho/actual/pendiente) y `CocoaSpan cols={8} min={480}` con `div.cocoa-stack[data-gap="4"]` y `renderStep()` |
| Paso 1 «Fichero» | `<CocoaFileInput accept=".csv,.txt,.xlsx" maxBytes={5 * 1024 * 1024} onPick={(file) => void pickFile(file)} onReject={setFileError} …/>` → `file.arrayBuffer()` → `base64OfArrayBuffer` → preview automática sin mapeo → paso 2; «Quitar fichero», badge de formato, nota (CSV con `;` `,` o tabulador, UTF-8 o Windows-1252; XLSX primera hoja; 5 MB y 5.000 filas; «el fichero no se guarda: solo el resultado por fila»; > 1.000 filas mejor por CLI), «Descargar plantilla CSV» / «XLSX» (`DownloadIcon` → `saveDownload` de `screens/accounting/accounting-ui`), `CocoaStat` propiedad activa, callouts `danger` |
| Paso 2 «Columnas» | `CocoaTable density="compact"` con filas = `preview.header`: «Columna del fichero» (`cocoa-mono`), «Ejemplo» (primer valor no vacío de la muestra, truncado a 32), «Campo» (`CocoaSelect inline` con `fieldOptions`), «Origen» (badge explicit/synonym/fuzzy/none); callout `warning` con `missingRequired` y `unmappedColumns`; re-preview con debounce 400 ms; `CocoaActionBar` «Anterior» / «Aplicar y validar» (deshabilitado hasta mapeo completo) |
| Paso 3 «Revisión» | `CocoaKpiStrip` (Válidas · Con avisos · Con errores · Omitidas · Histórico · A crear); `CocoaSegmentedControl` filtro todas/válidas/avisos/errores/omitidas; `CocoaTable virtualize maxHeight density="compact" rowTone` (fila, estado, referencia, `dateRange`, noches, tipo, tarifa, hab. `showFrom laptop`, huésped solo en la muestra, importe `money`, incidencias truncadas + `rowTitle`); callout «Disponibilidad» con `ul.c22-section__list` por tipo (cupo, pico BD, pico fichero, noches excedidas, «N filas rechazadas por la regla de rango del PMS aunque quepan por noche»); callout «Duplicados» (referencia existente, en el fichero, posibles, fichero ya importado + `CocoaSwitch` «Importar de todos modos»); `CocoaSwitch size="small"` «Omitir filas inválidas», «Permitir overbooking» (hint: por encima del cupo, auditadas), «Cargar llegadas pasadas como histórico» (hint: estancias cerradas, sin cargos) → re-preview; lista de blockers; `CocoaActionBar` «Anterior» / `Importar ${plural(n, "reserva", "reservas")}` (`disabled={!preview?.canImport \|\| !canImport \|\| importing}`, `loading`) |
| Paso 4 «Resultado» | `CocoaCallout` success/warning/danger según estado (`role="status"`); `CocoaKpiStrip` creadas/omitidas/errores/avisos/importe; `CocoaTable` de filas con «Reserva» como `CocoaButton variant="plain"` → `openTabPath(urlForScreen("ReservationDetailWorkspace", { id }) ?? "/recepcion/reservas")`, resultado, error, avisos; «Descargar informe CSV» (`buildImportReportCsv` + `saveDownload`), «Deshacer importación» (`CocoaDialog tone="destructive"` con `CocoaField` «Motivo» `CocoaInput multiline rows={3} maxLength={500}` → `undoReservationImport` → toast), «Nueva importación»; `showToast("N reservas importadas", { variant: "success" })` |
| **Importaciones anteriores** (`CocoaSection` bajo el asistente, siempre visible) | `useApiData<ReservationImportRecord[]>` → `CocoaTable` (fecha, fichero, estado badge, filas/creadas/omitidas/errores, importe, autor) con `rowActions` «Ver» (→ paso 4 en modo consulta) y «Deshacer» (`variant="plain" tone="destructive"`, `disabled={!canImport \|\| status ∈ { undone, failed }}`), `emptyState` «Todavía no hay importaciones», refresco tras importar/deshacer |
| **Tests** | `__tests__/reservation-import-helpers.test.mts` (base64 con bytes 0x00-0xFF, `buildMapping`, `previewBlockers` en español, `filterRows`, `buildImportReportCsv` con BOM/`;`/CRLF y escapado, `importStatusLabel` 5 estados) y `__tests__/reservation-import-screen-contract.test.mts` (`assertCocoaRules`, `count(src, /\bstyle=\{/g) === 0`, `<CocoaPage`, `<CocoaFileInput`, `accept=".csv,.txt,.xlsx"`, `maxBytes={5 * 1024 * 1024}`, `aria-current={`, `canDo(`, `openTabPath(urlForScreen("ReservationDetailWorkspace"`, `saveDownload(`, ausencia de `file.text()` y `fetch(`). El integrador regenera `docs/design/cocoa-22-inventory.json` y las olas |

---

## §10 · Lotes

Ficheros **exclusivos** por lote. Orden: **L0 → {L1 ∥ L4 ∥ L5} → L2 (tras L1) → L3 (tras L2) → L6 (tras L3, L4, L5)**. L5 (este documento y el runbook) se escribe antes de codificar y no toca código.

| Lote | Ficheros exclusivos | Tests y puertas |
|---|---|---|
| **L0 · Schema + migración + tipos wire** | `packages/database/prisma/schema.prisma`; `packages/database/prisma/migrations/20260916130000_reservas_importacion/migration.sql`; `packages/shared/src/{reservation-import-types.ts (nuevo), index.ts}` | `node scripts/check-migrations-vs-schema.mjs` (271 tablas / 32 enums); `tests/migrations-squash-contract.test.mjs`; `db:migrate:deploy` → `db:migrate:status` 10 · `db:drift:check` 0 → `db:generate`; `corepack pnpm run typecheck:all` (15/15 + 1 SKIP); SQL `count(*) FROM reservation_imports` = 0 y `enum_range(NULL::"ReservationImportStatus")` = `{processing,imported,partial,failed,undone}`; Faranda 25 facturas / 109 asientos / 1 lote de nómina |
| **L1 · XLSX-lite + parser CSV + mapeo + normalización** (todo puro) | `apps/api/src/lib/xlsx-lite.ts` + `lib/__tests__/xlsx-lite.test.mts`; `apps/api/src/modules/pms/{reservation-import.parser, reservation-import.mapping, reservation-import.normalize}.ts` + `__tests__/reservation-import-{parser,mapping,normalize}.test.mts` | `cd apps/api && node --import tsx --test …` y `corepack pnpm --filter @hotelos/api test`: xlsx-lite (fichero de `writeXlsx` leído íntegro; libro sintético con sharedStrings con runs y entidades, numFmt 14 serial 46000 → 2025-12-09, serial 60 → error, 0.6875 con `hh:mm` → 16:30, época 1904, celda/fila sin `r`, autocerrada, `<f>`+`<v>`, `6.00123456E8` → `600123456`, 312.5 conservado, `t=b`, `t=e`, `_x000D_`, hoja oculta saltada, rels absoluto; data descriptor; no-ZIP/ZIP64/> 2.000 entradas/bomba; `maxRows`); CSV (4 separadores, `""` y saltos dentro de campo, CRLF/LF/CR, BOM, latin1 `E9 F1 80` → é ñ €, líneas vacías con `line` correcto, filas corta/larga, `columna_n`, 201 columnas → UNREADABLE, > 5.000 → TOO_MANY_ROWS, > 5 MiB → TOO_LARGE, firma PK → xlsx); mapeo (cabeceras ES/EN/mixtas, explícito gana, columna repetida, `splitName`, `missingRequired`, conflicto); normalización (12 formatos de fecha, serial con aviso, salida por noches, incoherencia, 31/02, salida ≤ llegada, ocupación, `PAST_ARRIVAL` / histórico / `IN_HOUSE_PAST` con `businessDate` 2026-09-16, régimen, canal, vip, «1.234,56», USD, e-mail inválido, «Ferreiro Castro, Lucía», ES → ESP, habitación repetida, hash estable/distinto, **test GDPR**) |
| **L2 · Servicio + disponibilidad + plantilla + `createReservation` aditivo** | `apps/api/src/modules/pms/{reservation-import.service, reservation-import.availability, reservation-import.template, pms.service}.ts`; `__tests__/reservation-import-{availability,service,template}.test.mts`; `tests/integration/reservation-import.test.mts` | unitarios (ejemplo verificado A/B/C → `exceeds` y `rangeRuleRows`; filas descontándose con `roomsCount`; canceladas no cuentan; históricas fuera; overbooking → aviso; `nightsExceeded`; `deriveImportStatus`; `sanitizeRowError`; `buildCreateReservationInput` sin `bookerEmail`; plantilla CSV BOM/«;»/33 y XLSX legible por xlsx-lite); integración (org aislada `org_ri_<RUN>`, DBL max 2 con 201-203 e IND max 1 con 101, BAR con `rate_days`, `business_dates`; preview de 9 filas ficticias; commit 400 `INVALID` → 201 `partial` con `bookingSource`, códigos consecutivos, folio abierto, `ReservationGuest`, `bookerEmail null`, cancelada, tentativa con `internalNotes`, habitación por `assignRoom`, filas sin PII; reutilización por e-mail y `DUPLICATE_REFERENCE`; 409 `DUPLICATE` y `force`; histórico `checked_out` + folio `closed` + `Stay`; `allowOverbooking` con `afterJson.overbooking`; undo → `cancelled` / `kept` / `alreadyUndone`; sin `modify` → 403); re-ejecutar `api-integration.test.mts` y los contratos `concierge-booking` / `reservation-billing-reporting` |
| **L3 · Rutas + partial + tenencia + esquemas + CLI + docs API** | `apps/api/src/modules/pms/{reservation-import.routes, route-permissions.partial}.ts`; `apps/api/src/security/route-permissions.ts`; `apps/api/src/server.ts`; `apps/api/src/lib/tenancy.ts`; `apps/api/src/schemas/reservation-import.schemas.ts`; `__tests__/reservation-import-{schemas,routes}.test.mts`; `apps/api/src/scripts/import-reservations.ts`; `apps/api/package.json`; `docs/api-contracts.md`; `tests/integration/reservation-import-routes.test.mts` | `tests/{api-route-permissions-contract, rbac-nav-contract, audit-integrity-contract}.test.mjs` (6 rutas cubiertas, sin huérfanas ni duplicados); esquemas (strict, XOR, mapping inválido, límites, `commit` literal, `limit`, `reason`); rutas (cada `app.*` con entrada y viceversa, riesgos, import exige create+modify); `corepack pnpm --filter @hotelos/api test`; integración `app.inject` (STRICT_ENV, login `reception@example.com`, **solo lecturas y preview** sobre Rías Altas: 400 VALIDATION_ERROR / campo no admitido / XOR, template csv (BOM + 33) y xlsx (PK, legible), lista 200, `:id` inexistente 404, preview 2 filas ficticias, cuerpo ~2 MB → 200, sin token → 401 en import/undo, sesión fnb → 403); `typecheck:all`; CLI dry-run exit 0, `--help` 0, flag desconocido 2, `--json` válido |
| **L4 · Front** | `apps/admin-web/src/screens/reservations/{ReservationImportScreen.tsx, reservation-import-helpers.ts, ReservationsListScreen.tsx}`; `__tests__/reservation-import-{helpers,screen-contract}.test.mts`; `__tests__/reservation-route.test.mts`; `services/reservationImportApi.ts`; `screens/tabs/recepcion/ReservasTabs.tsx`; `providers/CocoaGlobalProvider.tsx`; `App.tsx`; `navigation/nav-tree.generated.json`; `routes/__tests__/backoffice.routes.test.mts`; `navigation/__tests__/nav-tree.test.mts`; `styles/cocoa-22.css` (solo si hace falta una clase); `pilots/{tanda5-nav-tree.csv, screens-inventory.csv}` | suite front completa (1.017 + nuevos; backoffice 189, tabs 99, loader, «importar» reservado, pisos no ve «Importar»); `tests/{cocoa-22-contract, admin-web-spanish-copy-contract, admin-web-no-raw-fetch, nav-tree-contract, rbac-nav-contract}.test.mjs`; `check-discoverability` 189/189; `build-nav-tree --check`; typecheck y build de admin-web; prueba manual en :5173 cuando el API lleve el código nuevo |
| **L5 · Docs** | `docs/design/RESERVAS-IMPORTACION-MASIVA.md` (este documento); `docs/runbooks/reservas-importacion.md` | `node --test tests/*.test.mjs`; grep de los 6 paths y de cada código de `reservation-import-types.ts` en ambos documentos; enlaces relativos existentes |
| **L6 · Demo + verificación end-to-end + informe** (integrador) | `pilots/faranda-celuisma/{reservas-demo-rias-altas.csv, reservas-demo-rias-altas.xlsx, reservas-demo-rias-altas-undo.csv}` (fuera del repo, huéspedes ficticios); `docs/audits/TANDA-7-RESERVAS-IMPORT-2026-09-16.md`; `docs/design/cocoa-22-inventory.json` (+ olas) | todas las puertas en verde; `--export-xlsx` con el mismo `contentHash`; CLI dry-run (0 errores, avisos esperados) → `--apply` lote 1 `imported` (30 creadas = 29 `confirmed` + 1 `cancelled`); XLSX → 409 `DUPLICATE`; lote 2 (5 filas) → `--undo` → 5 `cancelled` / 0 `kept` / `undone`; segundo `--undo` → `alreadyUndone`; SQL (reservas por `booking_source`, códigos RES-00086…, huéspedes 27 + 29, folios `open`, 5 habitaciones asignadas, cupo tipo × noche ≤ capacidad con `generate_series`, `booker_email` NULL); invariantes Faranda (25 facturas · 33 VeriFactu · 109 asientos · 1 lote de nómina); tras el reinicio del API, `GET …/imports` (2 lotes), `GET …/imports/:id` (30 filas sin PII), template csv/xlsx |

---

## §11 · Riesgos y decisiones abiertas para César

### 11.1 Decisiones que solo César puede tomar

| # | Decisión | Estado en esta tanda (por defecto) | Efecto si cambia |
|---|---|---|---|
| 1 | **«Tentativa» como confirmada** | Se crea `confirmed` con aviso `TENTATIVE_AS_CONFIRMED` e `internalNotes`; consume inventario y la auditoría nocturna la trata como cualquier confirmada [I] | Si César quiere tentativas reales hace falta una transición `draft → confirmed` en el PMS (y decidir si un draft consume inventario): tanda posterior, sin cambio en el importador |
| 2 | **Histórico**: estancia cerrada atómica (`checked_out`, folio `closed`, `Stay` solo con habitación); sin cargos, sin SES, sin notificaciones | Los cuadros que cuentan `stays` (general-manager, shift-manager, guest-timeline) ven menos históricos sin habitación; el runbook recomienda incluir `habitacion` en ficheros históricos [I] | Si César quiere ingresos históricos en el libro o partes SES retroactivos, es otra tanda (night audit histórico), no este importador |
| 3 | **Overbooking explícito** crea reservas confirmadas por encima del cupo (auditadas con `afterJson.overbooking`) | Interruptor con aviso en la UI y flag `--allow-overbooking` en el CLI; nunca por defecto [I] | Si se prefiere prohibirlo, basta ocultar el interruptor: el servicio sigue rechazando sin el flag |
| 4 | **Referencias externas de reservas canceladas / no-show reutilizables** | Necesario para reimportar tras deshacer; una referencia OTA cancelada y reactivada crea una reserva **nueva** con aviso `REFERENCE_REUSED_CANCELLED` en vez de reactivar la antigua [I] | Alternativa: bloquear también las canceladas y exigir borrar antes de reimportar; hoy se prefiere la vía reversible |
| 5 | **Permisos**: importar exige `create` + `modify`; deshacer `modify` | Todas las plantillas con `create` tienen `modify` hoy; un rol custom con solo `create` no puede importar [V rbac] | Un permiso propio `pms.reservation.import` exigiría `rbac:sync` (escribe `role_permissions` de Faranda) y tocar 10 plantillas |
| 6 | **Sin confirmaciones por e-mail a los importados** (`bookerEmail` vacío) | Ningún correo automático por lote; el e-mail queda en la ficha del huésped [I] | Si se quieren confirmaciones, hay que añadir un flag de supresión del evento `ReservationCreated` y decidir el remitente/plantilla: extensión aditiva |
| 7 | **Tarifas BAR-BB / BAR-NR sin `rate_days`** en Rías Altas | La cotización cae al precio BAR o a `none` (`TOTAL_NOT_QUOTED`); el importador prefiere `importe_total` del fichero; la demo lleva importe en todas las filas salvo 3 con BAR para demostrar la cotización [V BD local] | Publicar parrillas para BAR-BB / BAR-NR (Rate Grid v2) y las filas sin importe cotizarán correctamente |
| 8 | **Fechas `DD/MM` sin configuración de ambigüedad** | Un fichero `MM/DD/YYYY` se leerá mal cuando el día ≤ 12; la plantilla recomienda `YYYY-MM-DD` y el runbook lo advierte [I] | Opción `dateOrder: dmy \| mdy` en el cuerpo: aditiva, sin cambio de modelo |

### 11.2 Riesgos técnicos

| Riesgo | Mitigación |
|---|---|
| `createReservation` cambia (tres parámetros opcionales) sin tests que la fijen | Aditivo con defaults `false`/`undefined`; L2 re-ejecuta `api-integration.test.mts:888-970` y los contratos raíz que leen `pms.service.ts`; la integración de importación cubre los tres parámetros |
| Regla de rango más conservadora que el cupo por noche (reservas cortas encadenadas del mismo tipo reciben `NO_AVAILABILITY` aunque quepan) | Es un límite del PMS (:628-655), no del importador; la UI lo explica con `rangeRuleRows`; `permitirOverbooking` lo salva conscientemente |
| Concurrencia preview → commit y `assignRoom` tras crear (ventana mínima) | El commit vuelve a analizar y `createReservation` decide bajo lock; nunca por encima del cupo sin el flag; `ROOM_ASSIGN_FAILED` conserva la reserva sin habitación |
| Rendimiento: 5.000 filas × (`createReservation` + lock + código + folio + auditoría + `assignRoom`) ≈ minutos por HTTP; posible timeout del navegador/proxy | Lote `processing` antes de la primera fila y deshacible si se corta; filas persistidas por bloques de 100; la UI recomienda el CLI a partir de ~1.000 filas; sin transacción larga global |
| Riesgo high en import/undo rechaza el fallback demo sin token | El test HTTP no ejercita commit ni undo; se prueban en la integración de servicio (org aislada) y en la demo con el CLI |
| `bodyLimit` por ruta (8 MiB) sin precedente en el repo; base64 infla 4/3 | zod limita `contentBase64` a 7·1024·1024 caracteres y el parser a 5 MiB reales; el test de integración envía un cuerpo de ~2 MB; 413 documentado en la UI |
| XLSX-lite lee valores cacheados (fórmulas sin `<v>` → vacío), sin ZIP64 ni libros cifrados; números pierden ceros iniciales | Avisos por celda; guía en el runbook («guardar como .xlsx normal», «columna de documento como texto») |
| Deshacer no libera `assignedRoomId` ni cierra folios; históricas (`checked_out`) se conservan | Coherente con la cancelación del PMS (12 canceladas del dataset); `undoKeptCount` y `undoOutcome` lo hacen visible; folio abierto se trata como cualquier cancelación |
| Contratos front sensibles al orden de edición (JSON del árbol, `SCREEN_COMPONENTS`, inventario de pantallas, 3 asserts) | Orden obligatorio en L4; cualquier `style={` en ficheros nuevos rompe el techo global 801; el integrador regenera inventario y olas |
| Cadena de auditoría in-memory por instancia (deuda 12(c)) | `--apply` / `--undo` con los API parados; `hydrateAuditChainFromPostgres` antes y `flushAuditQueues` después, como los CLI existentes |
| GDPR: un mensaje de error del servicio (`CREATE_FAILED`) podría citar un valor | `sanitizeRowError` y `stripRowValues` sobre todo mensaje persistido; test unitario con fila ficticia; `errorMessage` ≤ 500 |
| API :3000 con código antiguo hasta el reinicio del orquestador | CLI y tests de integración usan su propio proceso; comprobaciones HTTP y UI condicionadas al reinicio |

---

## §12 · Documentos relacionados

| Documento | Qué contiene | Cuándo leerlo |
|---|---|---|
| [`docs/runbooks/reservas-importacion.md`](../runbooks/reservas-importacion.md) | Runbook operativo: plantilla y formatos (§2), mapeo y sinónimos (§3), catálogo de códigos de fila con acción del usuario (§4), disponibilidad —regla de rango frente a cupo por noche, overbooking explícito— (§5), duplicados (§6), histórico (§7), commit y estados del lote (§8), deshacer (§9), permisos por rol (§10), límites y recomendación de CLI a partir de ~1.000 filas (§11), CLI paso a paso (§12), verificación SQL (§13), códigos de lote (§14), GDPR (§15), FAQ (§16) | Antes de importar un fichero real o de responder a una incidencia de recepción |
| [`docs/api-contracts.md`](../api-contracts.md) | Bloque «### Importación masiva de reservas (Tanda 7)» bajo «## PMS»: las 6 rutas con clave y riesgo, cuerpos, límites, códigos, idempotencia, deshacer, histórico, CLI y tests (lo escribe L3; las frases pinneadas «Route Permissions», «Every registered route», «RBAC_STRICT» y «service-level validation» no se tocan) | Al integrar por HTTP o al revisar el manifiesto de permisos |
| [`docs/design/FINANZAS-COSTE-PERSONAL.md`](FINANZAS-COSTE-PERSONAL.md) y [`docs/runbooks/finanzas-contabilidad.md`](../runbooks/finanzas-contabilidad.md) §18 | Patrón de referencia (Tanda 6c): parser puro, `analyse` compartido, lote con hash/estado/mapeo, partial de permisos, CLI dry-run, drawer Cocoa 22 | Para entender por qué el importador tiene esta forma y no otra |
| [`docs/runbooks/pms-history-forecast-import.md`](../runbooks/pms-history-forecast-import.md) | Patrón CLI con dry-run, `--apply`, reversión por lote y aviso de la cadena de auditoría (API parados) | Al ejecutar el CLI en un piloto real |
| [`docs/runbooks/rbac-sync.md`](../runbooks/rbac-sync.md) | Plantillas de rol y sincronización del catálogo de permisos (sin claves nuevas en esta tanda) | Si se plantea un permiso propio `pms.reservation.import` (§11.1-5) |
| [`docs/design/COCOA-22.md`](COCOA-22.md) | Guía de primitivas y contrato sin margen del front | Antes de tocar `ReservationImportScreen.tsx` |
| `docs/audits/TANDA-7-RESERVAS-IMPORT-2026-09-16.md` | Informe del integrador (L6): cifras reales de la demo de Rías Altas, puertas y pendientes | Al cerrar la tanda (lo escribe L6) |
