# Runbook · Importación masiva de reservas desde CSV o XLSX (Tanda 7 · `reservations:import`)

Fuente: diseño [`docs/design/RESERVAS-IMPORTACION-MASIVA.md`](../design/RESERVAS-IMPORTACION-MASIVA.md)
(§1 motivación y alternativas descartadas, §2 formato, §3 lector, §4 modelo y parámetros
aditivos de `createReservation`, §5 previsualización y catálogo de códigos de fila, §6
importación y deshacer, §7 API y códigos de lote, §8 CLI, §9 front, §10 lotes, §11 riesgos y
decisiones abiertas). Rutas, permisos y límites: [`docs/api-contracts.md`](../api-contracts.md)
(bloque «### Importación masiva de reservas (Tanda 7)» bajo «## PMS»). Código:
`apps/api/src/modules/pms/{reservation-import.parser, reservation-import.mapping,
reservation-import.normalize, reservation-import.availability, reservation-import.service,
reservation-import.template, reservation-import.routes, route-permissions.partial}.ts`, lector
`apps/api/src/lib/xlsx-lite.ts`, esquemas `apps/api/src/schemas/reservation-import.schemas.ts`,
tipos wire `packages/shared/src/reservation-import-types.ts`, CLI
`apps/api/src/scripts/import-reservations.ts` (script pnpm `reservations:import`), front
`apps/admin-web/src/screens/reservations/{ReservationImportScreen.tsx,
reservation-import-helpers.ts}` y `services/reservationImportApi.ts`. Patrón operativo heredado
de la nómina agregada ([`finanzas-contabilidad.md`](finanzas-contabilidad.md) §18) y del
importador de History & Forecast ([`pms-history-forecast-import.md`](pms-history-forecast-import.md)).

Estado 2026-09-16: runbook escrito a partir del diseño **antes** de que los lotes de código
(L0-L4) y la demo (L6) aterricen. Los flags del CLI (§12) están copiados del diseño §8: si la
cabecera de uso del script difiere, manda el script y hay que actualizar aquí. Las cifras
reales de la demo de Rías Altas las fija el informe
`docs/audits/TANDA-7-RESERVAS-IMPORT-2026-09-16.md`. Todos los huéspedes de este runbook son
ficticios (`@example.com`).

## 1 · Qué hace, qué no hace y qué vía usar

| Vía | Dónde | Para qué | Permisos |
| --- | --- | --- | --- |
| **Pantalla** «Importar» | Recepción › Reservas › Importar (`/recepcion/reservas/importar`), también desde el botón «Importar reservas» de la lista y en ⌘K | ficheros de hasta ~1.000 filas, revisión visual columna a columna, deshacer con un clic | `pms.reservation.create` + `pms.reservation.modify` (deshacer: `modify`) |
| **CLI** `reservations:import` | `apps/api/src/scripts/import-reservations.ts` (§12) | migraciones y ficheros grandes (> 1.000 filas), cargas repetibles, demo; no depende del timeout del navegador ni del proxy | contexto de sistema (`cli:import-reservations`) con `read` + `create` + `modify` |
| **API** | `POST /properties/:propertyId/reservations/imports/preview` → `POST /properties/:propertyId/reservations/imports` (§10) | integraciones propias | las mismas claves que la pantalla |

**Qué hace por cada fila válida:** la convierte en una reserva **por el mismo camino que una
reserva de recepción**, `createReservation` (`apps/api/src/modules/pms/pms.service.ts`): lock
por (propiedad, tipo de habitación), comprobación de disponibilidad, código de reserva
consecutivo (`RES-00086…`), alta o reutilización del huésped principal (`Guest` de la
organización), `ReservationGuest` principal, folio abierto, evento de auditoría
`RESERVATION_CREATED` y evento de dominio `ReservationCreated`. La reserva queda
`confirmed` (o `cancelled` si la fila venía cancelada; `checked_out` si es histórica, §7),
con `bookingSource = "import:<importId>"`, `externalReference` de la fila y `bookerName`
«Nombre Apellidos».

**Qué NO hace, a propósito:** no envía correos de confirmación a los huéspedes importados
(`bookerEmail` queda vacío; el e-mail vive en la ficha del huésped); no guarda el fichero (solo
el resultado por fila, sin datos personales, §15); no modifica ni reactiva reservas existentes
(una referencia que ya existe se omite); no hace check-in ni cobra nada; no crea tentativas
reales (§8.3); no asigna habitaciones ocupadas.

**Orden operativo con el CLI:** parar los API (:3000 y :3400 en el Mac; cadena de auditoría en
memoria, deuda 12(c) de `CLAUDE.md`) → dry-run → `--apply` → reiniciar los API. Con la pantalla
no hay que parar nada.

## 2 · Plantilla y formatos de fichero

### 2.1 · Descargar la plantilla oficial

- Pantalla: paso 1 «Fichero» → «Descargar plantilla CSV» / «Descargar plantilla XLSX».
- API: `GET /properties/:propertyId/reservations/imports/template?format=csv|xlsx`
  (`pms.reservation.read`; `content-disposition: attachment`; `cache-control: no-store`).
- CLI: `corepack pnpm --filter @hotelos/api reservations:import -- --template csv --out plantilla-reservas.csv`
  (o `--template xlsx --out plantilla-reservas.xlsx`).

La plantilla CSV (`plantilla-reservas.csv`) lleva BOM UTF-8, separador «;», CRLF, las **33
cabeceras** en el orden canónico (`RESERVATION_IMPORT_FIELDS`) y dos filas de ejemplo con
huéspedes ficticios (llegada = hoy + 30 días). La XLSX (`plantilla-reservas.xlsx`) tiene la hoja
«Reservas» (cabecera en negrita, anchos ajustados, fechas como texto ISO) y la hoja
«Instrucciones» (campo · obligatorio · formato · valores admitidos, generada desde `HELP_ES`).

```
referencia_externa;llegada;salida;noches;tipo_habitacion;tarifa;habitacion;habitaciones;adultos;ninos;bebes;regimen;canal;segmento;estado;nombre;apellidos;email;telefono;nacionalidad;documento_tipo;documento_numero;empresa;agencia;grupo;importe_total;moneda;deposito;metodo_pago;hora_llegada;peticiones;notas;vip
```

No hace falta usar la plantilla: cualquier CSV o XLSX con cabecera sirve gracias al mapeo de
columnas (§3). Las columnas que sobren se ignoran; las que falten y no sean obligatorias se
dejan vacías.

### 2.2 · CSV

- **Separador** autodetectado entre «;», tabulador, «,» y «|» contando ocurrencias fuera de
  comillas en las 5 primeras líneas no vacías (empate: «;» > tabulador > «,» > «|»). Los
  ficheros de Excel en español (`;`) y los de OTA en inglés (`,`) entran sin tocar nada.
- **Codificación**: UTF-8 (con o sin BOM); si el texto no es UTF-8 válido se lee como
  Windows-1252 (latin1: «é», «ñ», «€» de un Excel «Guardar como CSV» antiguo). El navegador
  envía siempre los bytes en `contentBase64`, así que la codificación la decide el API, no el
  navegador.
- **Comillas** según RFC 4180: campos entre comillas dobles, `""` = una comilla, saltos de
  línea dentro de un campo entrecomillado conservados; CR, LF o CRLF.
- La **cabecera** es el primer registro no vacío; las filas totalmente vacías se descartan
  (el número de línea física se conserva para los mensajes); una cabecera vacía se llama
  `columna_<n>`; una fila corta se rellena con vacíos y una larga se recorta con aviso.
- Extensiones aceptadas: `.csv`, `.txt`, `.tsv` (el formato se decide por `format` explícito >
  extensión > firma del fichero).

### 2.3 · XLSX

- Se lee la **primera hoja visible** (o la indicada en `sheetName` / `--sheet`). Solo se leen
  los **valores** (`<v>` cacheados): una fórmula sin valor calculado llega vacía con aviso;
  guardar el libro desde Excel antes de subirlo lo resuelve.
- **Fechas**: una celda con formato de fecha se convierte sola; un número entero en una
  columna sin formato de fecha se interpreta como serial Excel (época 1900) con el aviso
  `RESERVATION_IMPORT_ROW_DATE_FROM_SERIAL`; el serial 60 («29/02/1900») es un error de
  celda. Las horas (`hora_llegada`) se leen de celdas de hora.
- **Números**: se conserva el texto crudo (312,5 no se redondea). Un teléfono o un documento
  guardado como número **pierde los ceros iniciales**: formatear esas columnas como texto en
  Excel antes de exportar.
- **No lee**: `.xls` antiguo (binario), libros cifrados, ZIP64, formatos condicionales; las
  macros de un `.xlsm` se ignoran. Ante «`RESERVATION_IMPORT_UNREADABLE`», abrir el fichero en
  Excel y «Guardar como… Libro de Excel (.xlsx)» o exportar a CSV.
- Límites (§11): 5 MiB, 5.000 filas de datos, 200 columnas, 2.000 caracteres por celda.

### 2.4 · Columnas (33)

| Campo | Obl. | Formato y valores admitidos | Va a |
| --- | --- | --- | --- |
| `referencia_externa` | no | texto ≤ 200 (localizador OTA/PMS). **Recomendado siempre**: es la clave de idempotencia por fila (§6) | `externalReference` |
| `llegada` | **sí** | `YYYY-MM-DD`, `YYYY/MM/DD`, `DD/MM/YYYY`, `DD-MM-YYYY`, `DD.MM.YYYY`, `D/M/YY` (→ 20YY), celda de fecha Excel, serial Excel (aviso). Calendario real: 31/02 es error | `arrivalDate` |
| `salida` | sí\* | igual que `llegada`; obligatoria si no hay `noches`; debe ser posterior a la llegada | `departureDate` |
| `noches` | sí\* | entero 1..365; sustituye a `salida` o se coteja con ella | derivado |
| `tipo_habitacion` | **sí** | código (`DBL`) o nombre («Doble Estándar») del tipo de la propiedad; sinónimos comunes con candidato único → aviso | `roomTypeId` |
| `tarifa` | no | código (`BAR`) o nombre; vacía → plan BAR activo por defecto (aviso) | `ratePlanId` |
| `habitacion` | no | número exacto de una habitación del tipo, libre en esas fechas; exige `habitaciones` = 1 | `assignedRoomId` (tras crear, vía `assignRoom`) |
| `habitaciones` | no | entero ≥ 1 (defecto 1): unidades del tipo en una sola reserva | `roomsCount` |
| `adultos` / `ninos` / `bebes` | no | enteros; `adultos` vacío → 1, `0` → error; `adultos + ninos ≤ ocupación máxima × habitaciones` | `adults` / `children` / `infants` |
| `regimen` | no | `RO BB HB FB AI`, `SA AD MP PC TI`, «solo alojamiento», «alojamiento y desayuno», «media pensión», «pensión completa», «todo incluido», b&b, bed and breakfast, room only, half board, full board, all inclusive | `boardType` |
| `canal` | no | directo/direct/web/hotel/motor/propia → `direct`; booking/booking.com → `booking_com`; expedia/hotels.com; airbnb; agencia/agency/travel_agent/tour_operator/tto → `agency`; empresa/corporate/company → `corporate`; telefono/phone → `phone`; email/correo → `email`; walk-in/mostrador → `walk_in`; grupo/group; gds/amadeus/sabre; wholesale/mayorista/bedbank; ota/online; vacío → `direct`; otro → se guarda plegado (≤ 80) con aviso | `channel` (+ `sourceCode` = valor original) |
| `segmento` | no | corporate/empresa/business; leisure/ocio/vacacional; mice/eventos/congresos; wedding/boda; sports/deportes; group/grupo; government/gobierno; wholesale/mayorista; complimentary/cortesia/invitacion; ota/online; otro → plegado con aviso | `marketSegment` |
| `estado` | no | vacío/confirmada/confirmed/ok/garantizada → **confirmada**; tentativa/tentative/draft/provisional/opcional/pendiente → **tentativa** (se crea confirmada con nota, §8.3); cancelada/cancelled/anulada/baja → **cancelada** (se crea y se cancela); otro → error | estado final |
| `nombre` | **sí** | ≤ 120. Si la columna mapeada es de nombre completo («Guest name», «Cliente», «Titular»…) se parte en nombre y apellidos («Apellidos, Nombre» por la coma; sin coma, primer token = nombre) | `Guest.firstName`, `bookerName` |
| `apellidos` | sí\* | ≤ 120; primer token → `surname1`, resto → `surname2`; exento cuando `nombre` es nombre completo | `Guest.surname1/2` |
| `email` | no | formato `usuario@dominio.tld`, en minúsculas; inválido → se descarta con aviso; clave de reutilización del huésped | `Guest.email` (**nunca** `bookerEmail`) |
| `telefono` | no | dígitos, «+» y separadores con 7..20 dígitos; ≤ 40; inválido → descartado con aviso | `Guest.phone` |
| `nacionalidad` | no | ISO alfa-3 (`ESP`); alfa-2 (`ES`, `PT`, `GB`/`UK`, `US`…) y nombres ES/EN de ~40 países se convierten; otro → descartada con aviso | `Guest.nationality` |
| `documento_tipo` | no | dni/nif → `DNI`; nie → `NIE`; pasaporte/passport/pas → `PASSPORT`; tie → `TIE`; otro → mayúsculas con aviso | `Guest.documentType` |
| `documento_numero` | no | mayúsculas sin espacios, ≤ 60; clave **prioritaria** de reutilización del huésped | `Guest.documentNumber` |
| `empresa` / `agencia` / `grupo` | no | ≤ 200 / ≤ 200 / ≤ 80 | `companyName` (+ `Guest.company`) / `travelAgentName` / `groupCode` |
| `importe_total` | no | «1.234,56», «1,234.56», «1234.56», «€ 312»; 0 ≤ x ≤ 999.999,99; vacío → se cotiza desde la tarifa (aviso) o queda a 0 si la tarifa no tiene precio (aviso) | `totalAmount` |
| `moneda` | no | `EUR` o «€»; vacía → moneda de la propiedad; distinta → error (convertir fuera) | `currency` |
| `deposito` | no | mismo parseo de importes | `depositAmount` |
| `metodo_pago` | no | efectivo/cash; tarjeta/card/visa/mastercard → `credit_card`; debito → `debit_card`; transferencia → `bank_transfer`; bono/voucher; factura/factura_a_empresa → `company_invoice`; prepago/prepaid/vcc/online → `online_prepaid`; cuenta/cargo_en_cuenta → `pms_account`; otro → plegado con aviso | `paymentMethod` |
| `hora_llegada` | no | `H:MM`, `HH:MM`, `HH.MM` o celda de hora Excel | `estimatedArrivalTime` |
| `peticiones` / `notas` | no | ≤ 2.000 cada una (se recortan con aviso) | `specialRequests` / `notes` |
| `vip` | no | sí/si/s/yes/y/true/1/x/vip → `true`; no/n/false/0/vacío → `false`; otro → `false` con aviso | `vipFlag` |

\* `salida` **o** `noches` (una de las dos); `apellidos` salvo nombre completo.

Regla de oro con las fechas: usar `YYYY-MM-DD`. Un fichero americano `MM/DD/YYYY` se leerá
como `DD/MM/YYYY` y solo fallará cuando el día sea > 12 (decisión abierta §11.1-8 del diseño):
convertirlo antes.

### 2.5 · Ejemplos (huéspedes ficticios)

Fichero mínimo (solo obligatorias, separador «;»):

```
llegada;noches;tipo_habitacion;nombre;apellidos
2026-11-03;2;DBL;Lucía;Ferreiro Castro
2026-11-03;3;IND;Antón;Souto Vila
```

Fichero de un tercero (cabeceras en inglés, «,», nombre completo): el mapeo propuesto resuelve
todas las columnas por sinónimo y no exige `apellidos`:

```
Booking ID,Check-in,Check-out,Room Type,Rate,Guest name,E-mail,Adults,Board,Channel,Total
BK-7781,2026-11-10,2026-11-12,DBL,BAR,"Nowak, Marek",marek.nowak@example.com,2,BB,booking.com,296.00
```

Fichero de demo de Rías Altas (fuera del repo, 30 filas `IMP-RA-2026-101…130` + 5 filas
`IMP-RA-2026-U11…U15` para la prueba de deshacer; tipos `DBL`, `DSV`, `IND`, `JSU`, `SRA` y
tarifas `BAR`, `BAR-BB`, `BAR-NR` reales de la BD local):
`/Users/cfernandez/anfitorio-demo/pilots/faranda-celuisma/reservas-demo-rias-altas.csv` y
`.xlsx` (mismo hash), `reservas-demo-rias-altas-lote2.csv` y `.xlsx`; salida del dry-run en
`RESERVAS-DRY-RUN-2026-09-16.md` de la misma carpeta (carpeta `/pilots/` git-ignored).

## 3 · Mapeo de columnas

### 3.1 · Cómo se propone y cómo se corrige

1. Cada cabecera se **pliega** (`foldHeader`: sin acentos, minúsculas, espacios/guiones/puntos/º
   → `_`): «Nº hab.» → `n_hab`, «Check-in» → `check_in`, «Fecha de entrada» → `fecha_de_entrada`.
2. Se busca, por este orden, coincidencia **exacta** con el nombre canónico del campo o con un
   sinónimo (§3.2), después **contención** (≥ 3 caracteres, gana el sinónimo más largo:
   `fecha_de_entrada` contiene `fecha_entrada` → `llegada`), y si nada casa la columna queda
   **sin mapear** (se ignora, con aviso en la revisión).
3. Cada campo solo puede venir de **una** columna: la primera gana y la repetida queda sin
   mapear.
4. En la pantalla (paso 2 «Columnas») cada fila muestra columna del fichero · ejemplo · campo
   (select con «Ignorar columna» y los campos obligatorios marcados) · origen
   (`explicit` / `synonym` / `fuzzy` / `none`). Cambiar un select relanza la previsualización.
5. Por API/CLI el mapeo explícito va en `mapping` (`{ "<cabecera>": "<campo>" | null }`;
   `null` = ignorar) y **prevalece** sobre la propuesta. Un campo asignado a dos columnas o
   una columna que no existe en la cabecera → 400 `RESERVATION_IMPORT_MAPPING_CONFLICT`; un
   obligatorio sin columna → 400 `RESERVATION_IMPORT_MAPPING_INCOMPLETE` (en la preview son
   `blockers`, no errores HTTP).

Ejemplo de `--mapping` para el fichero de tercero de §2.5 si la propuesta no bastara:

```json
{ "Booking ID": "referencia_externa", "Check-in": "llegada", "Check-out": "salida", "Room Type": "tipo_habitacion", "Rate": "tarifa", "Guest name": "nombre", "E-mail": "email", "Adults": "adultos", "Board": "regimen", "Channel": "canal", "Total": "importe_total" }
```

### 3.2 · Sinónimos reconocidos (`RESERVATION_IMPORT_SYNONYMS`, ya plegados)

| Campo | Sinónimos |
| --- | --- |
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
| `nombre` | first_name, firstname, given_name, name, nombre_completo, full_name, guest_name, guest, huesped, cliente, titular, customer, customer_name (los diez últimos son «nombre completo» y activan la partición si `apellidos` no está mapeado) |
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

## 4 · Validaciones por fila y catálogo de códigos

### 4.1 · Veredicto por fila

La previsualización (`POST /properties/:propertyId/reservations/imports/preview`, nunca
escribe) y la importación comparten el mismo análisis (`analyse({ strict })`): **lo que la
pantalla enseña es exactamente lo que el commit va a hacer**. Cada fila termina en uno de
cuatro estados (prioridad `error` > `skipped` > `warning` > `valid`):

| Estado | Significado | ¿Se crea? |
| --- | --- | --- |
| `valid` | sin incidencias | sí |
| `warning` | se crea, pero con avisos que conviene leer (huésped reutilizado, importe cotizado, canal desconocido…) | sí |
| `error` | no se puede crear tal cual | no; y **bloquea el lote entero** salvo «Omitir filas inválidas» (`omitirInvalidas` / `--skip-invalid`), que la deja en `skipped` con `RESERVATION_IMPORT_ROW_INVALID_SKIPPED` |
| `skipped` | omitida a propósito (referencia ya existente, repetida en el fichero, inválida omitida) | no |

El resumen (`summary`) cuenta válidas · con avisos · con errores · omitidas · históricas · a
crear, y `canImport` es verdadero solo si el mapeo está completo, no hay errores (o se omiten),
hay al menos una fila a crear y el fichero no está ya importado (o se fuerza, §6). Todos los
mensajes citan **columna y número de fila, nunca el valor** (§15).

### 4.2 · Errores de fila (bloquean la fila)

| Código | Significado | Qué hacer |
| --- | --- | --- |
| `RESERVATION_IMPORT_ROW_MISSING_FIELD` | falta un obligatorio: llegada, tipo, nombre/apellidos, salida o noches | rellenar la celda o mapear la columna |
| `RESERVATION_IMPORT_ROW_INVALID_DATE` | fecha no reconocida o inexistente (31/02) | escribir `YYYY-MM-DD` |
| `RESERVATION_IMPORT_ROW_DATE_ORDER` | salida ≤ llegada | corregir las fechas |
| `RESERVATION_IMPORT_ROW_NIGHTS_MISMATCH` | `salida` y `noches` presentes y no cuadran | dejar solo una o corregir |
| `RESERVATION_IMPORT_ROW_INVALID_NIGHTS` | noches < 1 o > 365 | corregir |
| `RESERVATION_IMPORT_ROW_PAST_ARRIVAL` | llegada anterior a hoy (zona horaria de la propiedad) sin la opción «histórico» | activar «Cargar llegadas pasadas como histórico» (`--historical`) o quitar la fila (§7) |
| `RESERVATION_IMPORT_ROW_IN_HOUSE_PAST` | llegada pasada y salida futura (estancia en curso) con «histórico» | crearla por recepción y hacer check-in a mano |
| `RESERVATION_IMPORT_ROW_ROOM_TYPE_UNKNOWN` | tipo no resuelto por código, nombre ni sinónimo (`details.suggestions` lista candidatos) | usar el código del catálogo de la propiedad |
| `RESERVATION_IMPORT_ROW_ROOM_TYPE_INACTIVE` | el tipo está desactivado | activarlo o cambiar de tipo |
| `RESERVATION_IMPORT_ROW_RATE_PLAN_UNKNOWN` | tarifa no resuelta | usar el código de tarifa o dejar la celda vacía (BAR) |
| `RESERVATION_IMPORT_ROW_RATE_PLAN_INACTIVE` | tarifa desactivada | otra tarifa |
| `RESERVATION_IMPORT_ROW_ROOM_UNKNOWN` | número de habitación inexistente | corregir o dejar vacío |
| `RESERVATION_IMPORT_ROW_ROOM_TYPE_MISMATCH` | la habitación es de otro tipo | corregir tipo o habitación |
| `RESERVATION_IMPORT_ROW_ROOM_UNAVAILABLE` | la habitación está ocupada, bloqueada o no es vendible en esas fechas | dejar vacío: se asigna después desde recepción |
| `RESERVATION_IMPORT_ROW_ROOM_DUPLICATE_IN_FILE` | la misma habitación con noches solapadas en otra fila del fichero | corregir |
| `RESERVATION_IMPORT_ROW_ROOM_WITH_MULTIPLE_ROOMS` | habitación fija con `habitaciones` > 1 | una fila por habitación |
| `RESERVATION_IMPORT_ROW_INVALID_NUMBER` | adultos/niños/bebés/habitaciones no son enteros | corregir |
| `RESERVATION_IMPORT_ROW_ADULTS_REQUIRED` | 0 adultos | al menos 1 |
| `RESERVATION_IMPORT_ROW_OCCUPANCY_EXCEEDED` | adultos + niños > ocupación máxima del tipo × habitaciones | más habitaciones u otro tipo |
| `RESERVATION_IMPORT_ROW_INVALID_STATUS` | estado fuera de confirmada / tentativa / cancelada | corregir |
| `RESERVATION_IMPORT_ROW_INVALID_AMOUNT` | importe no numérico, negativo o > 999.999,99 | corregir |
| `RESERVATION_IMPORT_ROW_INVALID_CURRENCY` | moneda distinta de la de la propiedad | convertir fuera o vaciar la celda |
| `RESERVATION_IMPORT_ROW_NO_AVAILABILITY` | la regla de rango del PMS no deja cupo (BD + filas anteriores del fichero, §5) | reducir, cambiar fechas o tipo, o «Permitir overbooking» |
| `RESERVATION_IMPORT_ROW_PERMISSION` | fila cancelada o con habitación y el usuario no tiene `pms.reservation.modify` | pedir el permiso o quitar habitación/estado |
| `RESERVATION_IMPORT_ROW_CREATE_FAILED` | (solo en el commit) `createReservation` rechazó la fila; el mensaje del servicio se guarda sin datos personales | leer el mensaje y reimportar la fila |
| `RESERVATION_IMPORT_ROW_CODE_CONFLICT` | (solo en el commit) no se pudo asignar código de reserva tras los reintentos | reimportar la fila |

### 4.3 · Omisiones (la fila no se crea, el lote sigue)

| Código | Significado | Qué hacer |
| --- | --- | --- |
| `RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE` | la `referencia_externa` ya existe en una reserva activa de la propiedad (`details.reservationCode`) | nada: ya está cargada |
| `RESERVATION_IMPORT_ROW_DUPLICATE_IN_FILE` | referencia repetida dentro del fichero (gana la primera) | quitar la fila |
| `RESERVATION_IMPORT_ROW_INVALID_SKIPPED` | fila con errores omitida por «Omitir filas inválidas» (`details` trae el primer error) | corregir y reimportar solo esas filas |

### 4.4 · Avisos (la fila se crea; conviene revisarlos)

| Código | Significado | Qué hacer |
| --- | --- | --- |
| `RESERVATION_IMPORT_ROW_DATE_FROM_SERIAL` | fecha leída de un serial Excel | comprobar que la fecha es la esperada |
| `RESERVATION_IMPORT_ROW_NAME_SPLIT` | nombre completo partido en nombre / apellidos | revisar el reparto en la ficha |
| `RESERVATION_IMPORT_ROW_EMAIL_DROPPED` | e-mail con formato inválido, descartado | completar en la ficha del huésped |
| `RESERVATION_IMPORT_ROW_PHONE_DROPPED` | teléfono sin 7..20 dígitos, descartado | completar en la ficha del huésped |
| `RESERVATION_IMPORT_ROW_NATIONALITY_DROPPED` | nacionalidad fuera de la tabla alfa-2 / alfa-3, descartada | usar el código ISO alfa-3 |
| `RESERVATION_IMPORT_ROW_BOARD_UNKNOWN` | régimen fuera del catálogo, descartado | usar RO/BB/HB/FB/AI o los nombres admitidos |
| `RESERVATION_IMPORT_ROW_CHANNEL_UNKNOWN` | canal desconocido, guardado plegado (≤ 80) | usar los canales admitidos |
| `RESERVATION_IMPORT_ROW_SEGMENT_UNKNOWN` | segmento desconocido, guardado plegado | usar los segmentos admitidos |
| `RESERVATION_IMPORT_ROW_PAYMENT_METHOD_UNKNOWN` | método de pago desconocido, guardado plegado (≤ 40) | usar los métodos admitidos |
| `RESERVATION_IMPORT_ROW_DOCUMENT_TYPE_UNKNOWN` | tipo de documento fuera de DNI/NIE/PASSPORT/TIE, guardado en mayúsculas | usar los tipos admitidos |
| `RESERVATION_IMPORT_ROW_VIP_UNKNOWN` | valor de `vip` no reconocido → `false` | usar sí/no |
| `RESERVATION_IMPORT_ROW_ROOM_TYPE_FUZZY` | tipo resuelto por contención de nombre o sinónimo | comprobar el tipo |
| `RESERVATION_IMPORT_ROW_RATE_PLAN_DEFAULTED` | tarifa vacía → BAR por defecto | — |
| `RESERVATION_IMPORT_ROW_REFERENCE_REUSED_CANCELLED` | la referencia existía en una reserva cancelada o no-show; se crea una reserva **nueva** | comprobar que no es una reactivación |
| `RESERVATION_IMPORT_ROW_POSSIBLE_DUPLICATE` | mismo huésped + misma llegada + mismo tipo ya en BD o en otra fila | comprobar (puede ser una segunda habitación del mismo cliente) |
| `RESERVATION_IMPORT_ROW_GUEST_REUSED` | huésped existente reutilizado por documento o e-mail | — (la ficha nunca se sobreescribe) |
| `RESERVATION_IMPORT_ROW_GUEST_NAME_MISMATCH` | el apellido del fichero difiere del de la ficha reutilizada | revisar la ficha del huésped |
| `RESERVATION_IMPORT_ROW_TOTAL_QUOTED` | importe vacío cotizado desde la tarifa | comprobar el importe |
| `RESERVATION_IMPORT_ROW_TOTAL_NOT_QUOTED` | importe vacío y la tarifa no tiene precio publicado → 0 | informar `importe_total` o publicar la parrilla |
| `RESERVATION_IMPORT_ROW_OVERBOOKING` | fila creada por encima del cupo con «Permitir overbooking» | decisión operativa consciente |
| `RESERVATION_IMPORT_ROW_FAR_FUTURE` | llegada a más de 730 días de hoy | comprobar el año |
| `RESERVATION_IMPORT_ROW_LONG_STAY` | más de 60 noches | comprobar las fechas |
| `RESERVATION_IMPORT_ROW_HISTORICAL` | fila creada como estancia cerrada (`checked_out`, folio cerrado) | — |
| `RESERVATION_IMPORT_ROW_STATUS_IGNORED_HISTORICAL` | `tentativa` / `cancelada` ignorado en una fila histórica | — |
| `RESERVATION_IMPORT_ROW_TENTATIVE_AS_CONFIRMED` | tentativa creada como confirmada con nota interna | confirmar con el cliente |
| `RESERVATION_IMPORT_ROW_CANCELLED_AT_IMPORT` | fila creada y cancelada en el mismo commit | — |
| `RESERVATION_IMPORT_ROW_CELL_TRUNCATED` | celda recortada al máximo del campo | acortar el texto |
| `RESERVATION_IMPORT_ROW_ROOM_ASSIGN_FAILED` | (solo en el commit) la reserva se creó pero la habitación no se pudo asignar (carrera) | asignar desde recepción |

## 5 · Disponibilidad

### 5.1 · Regla de rango del PMS frente a cupo por noche

`createReservation` rechaza una reserva cuando **la suma de habitaciones de las reservas
`confirmed` / `checked_in` del mismo tipo que solapan el rango completo** más las solicitadas
supera el cupo del tipo (habitaciones vendibles y no bloqueadas). **No es un cupo por noche.**
Ejemplo verificado con un tipo de 2 habitaciones:

| Fila | Estancia | Cabe por noche | Regla de rango del PMS |
| --- | --- | --- | --- |
| A | noche 1 → 2 | sí | sí (0 + 1 ≤ 2) |
| B | noche 3 → 4 | sí | sí (0 + 1 ≤ 2) |
| C | noche 1 → 4 | sí (máximo 2 por noche) | **no**: A y B solapan el rango 1 → 4 → 2 + 1 > 2 |

La previsualización replica exactamente esa regla (BD + filas anteriores del fichero) para que
nada pase de válido a rechazado en el commit, y además enseña la tabla informativa tipo × noche
(callout «Disponibilidad»: cupo, pico en BD, pico del fichero, noches excedidas y «N filas
rechazadas por la regla de rango del PMS aunque quepan por noche», `rangeRuleRows`). Cuando una
fila «que cabe» recibe `RESERVATION_IMPORT_ROW_NO_AVAILABILITY` es por esto: partir la estancia
larga, cambiar el tipo, cargarla por recepción con conocimiento de causa o permitir overbooking.

### 5.2 · Cómo cuentan las filas del fichero

Las filas se planifican **en el orden del fichero**: cada fila que va a crearse (no omitida,
sin errores, no histórica) suma `habitaciones` a las siguientes del mismo tipo con noches
solapadas. Las filas `cancelada` se comprueban pero **no** cuentan para las siguientes; las
`tentativa` se crean confirmadas y **sí** cuentan; las históricas (§7) no entran en el
planificador (no consumen inventario futuro). Si un fichero trae la misma reserva dos veces
sin referencia externa, la segunda consumirá cupo (y llevará
`RESERVATION_IMPORT_ROW_POSSIBLE_DUPLICATE`).

### 5.3 · Overbooking explícito

- Por defecto **nunca** se crea por encima del cupo: la fila queda en error
  `RESERVATION_IMPORT_ROW_NO_AVAILABILITY`.
- Con el interruptor «Permitir overbooking» (`permitirOverbooking: true` /
  `--allow-overbooking`) el error pasa a aviso `RESERVATION_IMPORT_ROW_OVERBOOKING`, la fila
  se crea **confirmada por encima del cupo** y sigue contando para las siguientes. El evento de
  auditoría `RESERVATION_CREATED` de esa reserva lleva `afterJson.overbooking = { totalRooms,
  bookedRooms, requested }`: queda rastro de que fue una decisión consciente.
- Entre la previsualización y el commit puede entrar una reserva de recepción: el commit
  vuelve a analizar y `createReservation` decide bajo lock; una fila puede salir como
  `RESERVATION_IMPORT_ROW_NO_AVAILABILITY` en el resultado aunque la preview la diera por
  válida. Sin el flag jamás se crea por encima del cupo.

### 5.4 · Habitación concreta

`habitacion` asigna un número exacto: debe existir, ser del tipo de la fila, estar libre
(`canAssignRoom`: ni ocupada, ni bloqueada, ni no vendible) y la fila debe pedir
`habitaciones` = 1. La asignación se hace **después** de crear la reserva, con el mismo
`assignRoom` de recepción (lock real y auditoría `ROOM_ASSIGNED`); si falla por una carrera la
reserva se conserva sin habitación con el aviso `RESERVATION_IMPORT_ROW_ROOM_ASSIGN_FAILED`.
Para una carga histórica, la habitación sí viaja en la creación (§7).

## 6 · Duplicados e idempotencia

| Ámbito | Regla | Resultado |
| --- | --- | --- |
| Fichero entero | hash sha256 de las **filas normalizadas** (mismo hash para CSV o XLSX, otro orden de filas, BOM o espacios; distinto al cambiar cualquier celda) ya presente en un lote de la propiedad que no esté `undone` ni `failed` | 409 `RESERVATION_IMPORT_DUPLICATE` (`details.importId`, `createdAt`, `status`, `fileName`); en la preview, blocker «Este fichero ya se importó (lote …)». Con «Importar de todos modos» (`force` / `--force`) se crea un lote nuevo que recuerda al anterior (`optionsJson.duplicateOfImportId`) |
| Fila, dentro del fichero | misma `referencia_externa` en dos filas | la segunda se omite (`RESERVATION_IMPORT_ROW_DUPLICATE_IN_FILE`) |
| Fila, dentro del fichero | misma habitación con noches solapadas | error `RESERVATION_IMPORT_ROW_ROOM_DUPLICATE_IN_FILE` |
| Fila, dentro del fichero | mismo huésped (documento, e-mail o nombre + apellidos plegados) + misma llegada + mismo tipo | aviso `RESERVATION_IMPORT_ROW_POSSIBLE_DUPLICATE` |
| Fila, contra BD | `referencia_externa` de una reserva **activa** (no cancelada ni no-show) de la propiedad | omitida `RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE` |
| Fila, contra BD | `referencia_externa` de una reserva cancelada / no-show | se crea una reserva nueva con aviso `RESERVATION_IMPORT_ROW_REFERENCE_REUSED_CANCELLED` (imprescindible para reimportar tras deshacer) |
| Huésped, contra BD | documento (prioritario) o e-mail ya existente en la organización | se reutiliza la ficha (`RESERVATION_IMPORT_ROW_GUEST_REUSED`; `RESERVATION_IMPORT_ROW_GUEST_NAME_MISMATCH` si el apellido difiere); **nunca se actualiza** la ficha existente; nunca se busca por nombre |
| Huésped, contra BD | huésped reutilizado con reserva en la misma llegada y tipo | aviso `RESERVATION_IMPORT_ROW_POSSIBLE_DUPLICATE` (no bloquea) |

Consecuencias prácticas:

- **Rellenar siempre `referencia_externa`** (localizador de la OTA, id del PMS antiguo, o un
  código propio `IMP-2026-001…`): es lo que permite reimportar un fichero corregido sin
  duplicar lo ya cargado.
- Reimportar un fichero **tras deshacer** funciona sin `force` (el hash queda libre) y crea
  reservas nuevas; reimportarlo **sin** deshacer exige `force` y **duplicará** las filas sin
  referencia externa.
- Un fichero corregido (una celda distinta) tiene otro hash y entra sin `force`; sus filas con
  referencia ya cargada se omiten como `RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE`.

## 7 · Fechas pasadas e histórico

Con el **hoy de la propiedad** (`today` en la preview: la fecha del calendario en la zona
horaria de la propiedad, la MISMA frontera que la guarda `historical` de `createReservation`;
corrección T7-FUN-01). La fecha de negocio (`business_dates`) NO decide: si hay días sin cerrar
va por detrás del calendario y dejaría crear confirmadas llegadas ya pasadas (que la auditoría
nocturna marcaría no-show al cerrar esos días) y rechazaría como «en curso» estancias ya
terminadas. Cuando `businessDate < today` la preview lo avisa en `warnings` («La fecha de
negocio … va por detrás del calendario …») y el CLI lo imprime en la cabecera.

| Fila | Sin «histórico» | Con «histórico» (`historico: true` / `--historical`) |
| --- | --- | --- |
| llegada ≥ hoy | normal | normal |
| llegada < hoy y salida ≤ hoy | error `RESERVATION_IMPORT_ROW_PAST_ARRIVAL` (la auditoría nocturna la marcaría no-show con cargo) | se crea como **estancia cerrada** en una sola transacción: `checked_out`, folio `closed`, y `Stay` (check-in 15:00 / check-out 11:00 en la zona de la propiedad) **solo si la fila trae `habitacion`**; aviso `RESERVATION_IMPORT_ROW_HISTORICAL`; `tentativa` / `cancelada` se ignoran con `RESERVATION_IMPORT_ROW_STATUS_IGNORED_HISTORICAL` |
| llegada < hoy y salida > hoy (en casa) | error `RESERVATION_IMPORT_ROW_PAST_ARRIVAL` | error `RESERVATION_IMPORT_ROW_IN_HOUSE_PAST`: no se fabrica un check-in retroactivo; crearla por recepción y hacer check-in |

Lo histórico **no** consume inventario futuro, **no** genera cargos ni asientos, **no** envía
partes SES ni notificaciones, y el deshacer lo **conserva** (`kept`). Para que la estancia
aparezca en los cuadros que cuentan `stays` (dirección, turno, cronología del huésped) el
fichero histórico debe traer `habitacion`. Ingresos históricos en el libro o partes SES
retroactivos no son cosa de este importador (decisión abierta §11.1-2 del diseño).

## 8 · Importar: qué ocurre en el commit

### 8.1 · Secuencia

1. `POST /properties/:propertyId/reservations/imports` con el mismo cuerpo de la preview +
   `mapping` + `commit: true` (+ `omitirInvalidas`, `permitirOverbooking`, `historico`,
   `force`). Exige `pms.reservation.create` **y** `pms.reservation.modify`.
2. Análisis estricto: cualquier error de fichero, mapeo o fila sin `omitirInvalidas` → 400; 0
   filas a crear → 400 `RESERVATION_IMPORT_EMPTY`; fichero ya importado sin `force` → 409.
   **Nada se escribe** hasta aquí.
3. Transacción corta bajo advisory lock por propiedad: se comprueba el hash y se crea el lote
   `ReservationImport` en estado `processing`. **El lote existe antes de la primera reserva.**
4. Bucle **secuencial** por fila (nunca en paralelo), cada fila en su propia transacción:
   huésped por documento → por e-mail → si no existe lo da de alta `createReservation` con los
   datos de la fila; reserva (`bookingSource = "import:<importId>"`, `externalReference`,
   `bookerName`, **sin `bookerEmail`**, `internalNotes` «Importada como tentativa: confirmar
   con el cliente (lote <id>)» si procede, importe del fichero o cotizado); habitación con
   `assignRoom`; estado `cancelada` → `transitionReservation(cancelled)` con motivo «Importada
   como cancelada (lote <id>)». Un fallo en una fila la marca `error` y el bucle sigue. Los
   resultados se persisten por bloques de 100 filas.
5. Cierre: contadores, rango de llegadas, importe total, duración y estado final. Auditoría
   `RESERVATION_IMPORT_COMMITTED` (contadores, mapeo, opciones, hash y nombre del fichero; sin
   datos de huéspedes). Respuesta **201 siempre que el lote exista**, aunque sea `failed`.

### 8.2 · Estados del lote

| Estado | Etiqueta | Significado | ¿Se puede deshacer? |
| --- | --- | --- | --- |
| `processing` | Interrumpida | el proceso murió a medias (corte de red, reinicio del API); las reservas creadas hasta entonces existen | **sí** (§9): el deshacer busca por `bookingSource`, no por las filas persistidas |
| `imported` | Importada | todas las filas de datos creadas | sí |
| `partial` | Parcial | creadas > 0 y (omitidas > 0 o errores > 0) | sí |
| `failed` | Fallida | 0 creadas | no (no hay nada que deshacer; no bloquea el hash) |
| `undone` | Deshecha | deshecha (§9) | idempotente (`alreadyUndone`) |

### 8.3 · Estados de reserva que produce el fichero

- `confirmada` (por defecto) → `confirmed`, consume inventario, la auditoría nocturna la trata
  como cualquier reserva de recepción.
- `tentativa` → **se crea confirmada** con aviso `RESERVATION_IMPORT_ROW_TENTATIVE_AS_CONFIRMED`
  y nota interna «Importada como tentativa: confirmar con el cliente». Motivo: el PMS no tiene
  transición `draft → confirmed` y un borrador no consumiría inventario ni admitiría check-in;
  decisión elevada a César (§11.1-1 del diseño). Filtrar por la nota para repasarlas.
- `cancelada` → se crea y se cancela en el mismo commit (`RESERVATION_IMPORT_ROW_CANCELLED_AT_IMPORT`):
  queda el rastro de la reserva y su referencia externa sin consumir inventario.

### 8.4 · Paso 4 «Resultado» e informe

La pantalla muestra creadas / omitidas / errores / avisos / importe, la tabla de filas con
enlace a cada reserva y los botones «Descargar informe CSV» (`fila;resultado;codigo_reserva;
referencia_externa;llegada;salida;tipo_habitacion;tarifa;habitaciones;codigo_error;mensaje;
avisos`, BOM, «;», CRLF: sin datos del huésped), «Deshacer importación» y «Nueva importación».
La sección «Importaciones anteriores» lista los lotes con estado y contadores
(`GET /properties/:propertyId/reservations/imports`) y abre cada uno con sus filas
(`GET /properties/:propertyId/reservations/imports/:id`).

Si la pantalla se queda en «Importando…» y el navegador corta (fichero grande): no reintentar
a ciegas. Abrir «Importaciones anteriores»: si el lote está «Interrumpida», comprobar por SQL
(§13) cuántas reservas llevan su `bookingSource` y, o bien deshacerlo y volver a cargar por CLI,
o bien reimportar el mismo fichero **con `referencia_externa`** (las ya creadas se omiten como
duplicadas de referencia y el hash exige `force` porque el lote interrumpido sigue vivo).

## 9 · Deshacer una importación

`POST /properties/:propertyId/reservations/imports/:id/undo` `{ reason? }` (`pms.reservation.modify`),
botón «Deshacer» del paso 4 o de «Importaciones anteriores» (diálogo con motivo), o CLI `--undo`.

| Reserva del lote (`bookingSource = import:<id>`) | Resultado | `undoOutcome` |
| --- | --- | --- |
| `draft` / `confirmed` | cancelada con el flujo normal (`transitionReservation`, motivo «Importación deshecha (lote <id>)» + motivo indicado) | `cancelled` |
| `checked_in` / `checked_out` (históricas incluidas) | se conserva: ya hay una estancia real detrás | `kept` |
| `cancelled` / `no_show` | nada que hacer | `skipped` |
| fallo individual | se registra y se conserva | `kept` |

- Es **idempotente**: un segundo deshacer devuelve `alreadyUndone: true` y no toca nada.
- Dos deshacer a la vez: el segundo recibe 409 `RESERVATION_IMPORT_UNDO_IN_PROGRESS` (la
  reclamación se libera sola a los 15 minutos si el primero murió).
- Como cualquier cancelación del PMS: **no** libera `assignedRoomId`, **no** cierra folios,
  **no** cobra gastos de cancelación.
- El lote pasa a `undone` con `undoneCount` / `undoKeptCount`; auditoría
  `RESERVATION_IMPORT_UNDONE`. Tras deshacer, el hash del fichero queda libre y las referencias
  externas de las reservas canceladas se pueden reutilizar (§6).
- Funciona igual sobre un lote «Interrumpida» (`processing`): busca las reservas por
  `bookingSource`, no por las filas persistidas.

Lo que **no** deshace: huéspedes dados de alta (siguen en la ficha, como tras cualquier
cancelación), folios (quedan como los deja la cancelación), estancias históricas.

## 10 · Permisos por ruta y por rol

| Método y ruta | Clave | Riesgo | Qué hace |
| --- | --- | --- | --- |
| `GET /properties/:propertyId/reservations/imports/template` | `pms.reservation.read` | low | plantilla CSV / XLSX |
| `POST /properties/:propertyId/reservations/imports/preview` | `pms.reservation.create` | medium | previsualización (nunca escribe; 30 peticiones/min) |
| `POST /properties/:propertyId/reservations/imports` | `pms.reservation.create` + `pms.reservation.modify` | high | importar (`commit: true`) |
| `GET /properties/:propertyId/reservations/imports` | `pms.reservation.read` | low | lista de lotes (`status?`, `limit` 50, máx. 200) |
| `GET /properties/:propertyId/reservations/imports/:id` | `pms.reservation.read` | low | lote con filas |
| `POST /properties/:propertyId/reservations/imports/:id/undo` | `pms.reservation.modify` | high | deshacer |

Importar exige `create` **y** `modify` porque asignar habitación y cancelar filas
(`assignRoom`, `transitionReservation`) exigen `modify`; deshacer exige `modify` como
`POST /reservations/:id/cancel`. Un lote de otra propiedad u organización responde 404 opaco
(`RESERVATION_IMPORT_NOT_FOUND`). Las rutas `high` rechazan el fallback demo sin token.

| Plantilla de rol (`packages/shared/src/permissions.ts`) | `read` | `create` | `modify` | Puede |
| --- | --- | --- | --- | --- |
| Propietario, Administrador, Dirección, Recepción, Comercial | sí | sí | sí | todo: plantilla, previsualizar, importar, ver lotes, deshacer |
| Pisos, Mantenimiento, Contabilidad, Cumplimiento, Revenue | sí | no | no | descargar la plantilla y consultar lotes; previsualizar / importar / deshacer → 403 |
| Punto de venta | no | no | no | nada (404/403) |

La pestaña «Importar» solo aparece con los tokens de menú `recepcion | direccion | comercial |
admin`; dentro, sin `create` + `modify` la pantalla muestra una nota y desactiva los botones
(el servicio lo vuelve a comprobar). Un rol personalizado con solo `create` no puede importar
(decisión §11.1-5 del diseño).

**Modo sincronizar (Tanda 7b, §18):** con `mode: "sync"` el mismo `POST /properties/:propertyId/reservations/imports`
exige **cuatro** claves: `pms.reservation.create` + `pms.reservation.modify` +
`pms.checkin.execute` + `pms.checkout.execute`, porque además de crear, actualizar, asignar
habitación y cancelar, el commit ejecuta check-ins sombra (`checkInReservation`) y check-outs sombra
(`checkOutReservationDetailed` + cierre del folio primario) según el estado que declara OPERA.
Sin las cuatro → 403 antes de leer el fichero. Comercial (sin `checkin` / `checkout`) no puede
sincronizar; Recepción, Dirección, Propietario y Administrador sí. Sin claves de permiso nuevas.

## 11 · Límites y rendimiento

| Límite | Valor | Al superarlo |
| --- | --- | --- |
| Tamaño del fichero | 5 MiB (`RESERVATION_IMPORT_MAX_BYTES`) | 400 `RESERVATION_IMPORT_TOO_LARGE`; el cuerpo HTTP admite 8 MiB (base64 infla 4/3): más → 413 del servidor |
| Filas de datos | 5.000 (`RESERVATION_IMPORT_MAX_ROWS`) | 400 `RESERVATION_IMPORT_TOO_MANY_ROWS` |
| Columnas | 200 | 400 `RESERVATION_IMPORT_UNREADABLE` |
| Caracteres por celda | 2.000 | recorte + `RESERVATION_IMPORT_ROW_CELL_TRUNCATED` |
| Noches por reserva | 365 (aviso desde 61) | `RESERVATION_IMPORT_ROW_INVALID_NIGHTS` |
| Nombre de fichero | 200 caracteres | 400 `VALIDATION_ERROR` |
| Muestra normalizada en la preview | 200 filas (`sampleSize`, máx. 1.000) | el resto llega solo con estado e incidencias |
| Motivo del deshacer | 500 caracteres | 400 `VALIDATION_ERROR` |
| Preview | 30 peticiones/min por usuario | 429 |
| Lista de lotes | 50 (máx. 200) | 400 `VALIDATION_ERROR` |

Rendimiento: cada fila pasa por `createReservation` (lock, código, huésped, folio, auditoría)
más `assignRoom` si lleva habitación, **en serie**. Un lote de miles de filas tarda varios
minutos y, por HTTP, puede toparse con el timeout del navegador o del proxy (el lote queda
«Interrumpida», §8.2). **Recomendación: a partir de ~1.000 filas usar el CLI** (§12), y
partir migraciones grandes en ficheros por mes o por tipo, cada uno con `referencia_externa`.

## 12 · CLI paso a paso (`reservations:import`)

Requisitos: `DATABASE_URL` en `hotelos/.env` (el script lo carga con
`--env-file-if-exists`), el paquete `@hotelos/database` generado, y los API **parados** para
`--apply` y `--undo` (cadena de auditoría en memoria; el orquestador los reinicia después). En
producción, backup previo (`backups/`), como con el resto de CLI. El usuario de sistema es
`usr_system_reservation_import` (también `createdBy` del lote, para que la pantalla lo nombre
«Sistema · importación masiva de reservas»; los lotes anteriores a la ronda 1 llevan
`"cli:import-reservations"` y se traducen igual; `deviceId "cli:import-reservations"`) con
`pms.reservation.read` + `create` + `modify`; el CLI pasa por **el mismo servicio** que la
pantalla, no re-implementa reglas.

### 12.1 · Plantilla

```bash
corepack pnpm --filter @hotelos/api reservations:import -- --template csv --out /tmp/plantilla-reservas.csv
corepack pnpm --filter @hotelos/api reservations:import -- --template xlsx --out /tmp/plantilla-reservas.xlsx
```

### 12.2 · Dry-run (por defecto: nada se escribe)

```bash
corepack pnpm --filter @hotelos/api reservations:import -- \
  --file /Users/cfernandez/anfitorio-demo/pilots/faranda-celuisma/reservas-demo-rias-altas.csv \
  --property cmrhw9jy40003fyvbuu2ec2w7
# equivalente sin script npm:
cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/import-reservations.ts \
  --file /Users/cfernandez/anfitorio-demo/pilots/faranda-celuisma/reservas-demo-rias-altas.csv --property cmrhw9jy40003fyvbuu2ec2w7
```

Salida: tabla en español (fila · estado · referencia · llegada → salida · noches · tipo ·
tarifa · hab. · huésped · importe · incidencias) limitada a `--sample` (200 por defecto),
resumen (válidas / con avisos / con errores / omitidas / histórico / a crear), disponibilidad
por tipo (cupo, pico en BD, pico del fichero, noches excedidas, filas rechazadas por la regla
de rango), duplicados, mapeo efectivo y columnas sin mapear, blockers. Salida **0** si
`canImport`, **1** si no. Repetir hasta 0 errores (o decidir `--skip-invalid`).

### 12.3 · Fichero de terceros: mapeo explícito y hoja

```bash
corepack pnpm --filter @hotelos/api reservations:import -- --file ~/Descargas/booking-export.xlsx --property <propertyId> \
  --sheet "Reservations" --mapping ./mapeo-booking.json
# o inline:
corepack pnpm --filter @hotelos/api reservations:import -- --file export.csv --property <propertyId> \
  --mapping '{"Booking ID":"referencia_externa","Check-in":"llegada","Check-out":"salida","Room Type":"tipo_habitacion","Guest name":"nombre","Notes":null}'
```

### 12.4 · Ida y vuelta XLSX (opcional)

```bash
corepack pnpm --filter @hotelos/api reservations:import -- --file reservas.csv --property <propertyId> --export-xlsx reservas.xlsx
corepack pnpm --filter @hotelos/api reservations:import -- --file reservas.xlsx --property <propertyId>
```

Tras el dry-run del CSV escribe el mismo contenido como `.xlsx` con la cabecera oficial; el
dry-run del `.xlsx` debe dar **el mismo `contentHash`** (así se genera el `.xlsx` de la demo y
se prueba el lector). Cuidado: importar los dos ficheros seguidos daría 409
`RESERVATION_IMPORT_DUPLICATE` en el segundo, que es lo esperado.

### 12.5 · Aplicar

```bash
corepack pnpm --filter @hotelos/api reservations:import -- --file <ruta.csv|.xlsx> --property <propertyId> --apply
# variantes:
#   --skip-invalid       omite las filas con errores en vez de abortar (RESERVATION_IMPORT_ROW_INVALID_SKIPPED)
#   --allow-overbooking  crea por encima del cupo con aviso y auditoría (§5.3)
#   --historical         llegadas pasadas como estancias cerradas (§7)
#   --force              importa aunque el hash ya exista en un lote vivo (§6)
#   --json               vuelca la respuesta del servicio (lote + filas + avisos)
```

Antes de escribir hidrata la cadena de auditoría (`hydrateAuditChainFromPostgres`); después
imprime `importId`, estado, contadores, rango de llegadas, importe total y las filas creadas /
omitidas / con error, y vacía las colas de auditoría y proyecciones antes de desconectar.
Salida **0** si el lote queda `imported` o `partial`, **1** si `failed` o error HTTP (400/409:
mensaje + `details.code`). Guardar el `importId` impreso: es lo que necesita el deshacer.

### 12.6 · Deshacer

```bash
corepack pnpm --filter @hotelos/api reservations:import -- --undo <importId> --property <propertyId> --reason "Fichero equivocado"
```

Imprime canceladas / conservadas / `alreadyUndone`. Salida 0. Repetirlo es inocuo.

### 12.7 · Flags y salidas

| Flag | Significado |
| --- | --- |
| `--file <ruta>` | CSV / TXT / TSV / XLSX (obligatorio salvo `--undo` y `--template`); los bytes se envían tal cual y el parser decide formato y codificación |
| `--property <id>` | propiedad destino (obligatorio; la organización se resuelve desde la propiedad) |
| `--sheet <nombre>` | hoja del XLSX (por defecto la primera visible) |
| `--mapping <ruta.json \| JSON>` | mapeo explícito columna → campo (`null` = ignorar) |
| `--apply` | escribe; sin él, dry-run |
| `--skip-invalid` / `--allow-overbooking` / `--historical` / `--force` | opciones del lote (`omitirInvalidas` / `permitirOverbooking` / `historico` / `force`) |
| `--sample <n>` | filas de la tabla del dry-run (200; máx. 1.000) |
| `--export-xlsx <ruta>` | tras el dry-run, escribe el fichero como `.xlsx` oficial |
| `--undo <importId>` `[--reason "…"]` | deshace un lote (excluye `--file`, `--apply`, `--template`) |
| `--template csv\|xlsx --out <ruta>` | escribe la plantilla oficial |
| `--json` | salida máquina |
| `--help` / `-h` | cabecera de uso, salida 0 |

Códigos de salida: `0` ok (dry-run con `canImport`, apply `imported` / `partial`, undo,
template) · `1` fallo (dry-run sin `canImport`, apply `failed`, 400/409 del servicio,
propiedad inexistente, BD) · `2` uso incorrecto (flag desconocido, `--apply` con `--undo`,
`--undo` con `--file`, fichero ilegible).

### 12.8 · Después del apply

1. Reiniciar los API (:3000 / :3400).
2. Verificar por SQL (§13) y, con el API arriba, `GET /properties/<id>/reservations/imports`
   (el lote con sus contadores) y `GET …/imports/<importId>` (filas sin datos personales).
3. Abrir Recepción › Reservas › Lista filtrando por fechas de llegada del lote; abrir una
   reserva y comprobar huésped principal, folio abierto e «Importada» en el origen.

## 13 · Verificación SQL

`psql "$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')"` desde `hotelos/`.
Sustituir `<propertyId>`, `<importId>` y `<orgId>`.

```sql
-- 1. Lotes de la propiedad (estado, contadores, autor, deshacer)
SELECT id, status, format, file_name, row_count, created_count, skipped_count, error_count, warning_count,
       total_amount, created_by, created_at, undone_at, undone_count, undo_kept_count
FROM reservation_imports WHERE property_id = '<propertyId>' ORDER BY created_at DESC;

-- 2. Reservas del lote por estado (esperado tras un apply limpio: confirmed = created_count − canceladas del fichero)
SELECT status, count(*), min(code), max(code), sum(rooms_count), round(sum(total_amount), 2) AS total
FROM reservations
WHERE property_id = '<propertyId>' AND booking_source = 'import:<importId>' AND deleted_at IS NULL
GROUP BY 1 ORDER BY 1;

-- 3. Filas del lote SIN datos personales (solo nº de fila, referencia, fechas, tipo/tarifa, código o error)
SELECT row_number, outcome, external_reference, arrival_date, departure_date, room_type_code, rate_plan_code,
       rooms_count, reservation_code, error_code, undo_outcome
FROM reservation_import_rows WHERE import_id = '<importId>' ORDER BY row_number;

-- 4. Cada reserva creada tiene huésped principal y folio; ninguna lleva booker_email (0 filas en la última)
SELECT count(*) AS reservas,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM reservation_guests rg WHERE rg.reservation_id = r.id AND rg.is_primary)) AS con_huesped,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM folios f WHERE f.reservation_id = r.id)) AS con_folio,
       count(*) FILTER (WHERE r.assigned_room_id IS NOT NULL) AS con_habitacion
FROM reservations r WHERE r.booking_source = 'import:<importId>' AND r.deleted_at IS NULL;
SELECT count(*) FROM reservations WHERE booking_source = 'import:<importId>' AND booker_email IS NOT NULL;   -- 0

-- 5. Huéspedes nuevos frente a reutilizados (creados en la ventana del lote)
SELECT count(*) FILTER (WHERE g.created_at >= i.created_at) AS nuevos,
       count(*) FILTER (WHERE g.created_at <  i.created_at) AS reutilizados
FROM reservation_imports i
JOIN reservations r ON r.booking_source = 'import:' || i.id
JOIN reservation_guests rg ON rg.reservation_id = r.id AND rg.is_primary
JOIN guests g ON g.id = rg.guest_id
WHERE i.id = '<importId>';

-- 6. Cupo tipo × noche nunca excedido (0 filas; con overbooking permitido, solo las noches conscientes)
WITH noches AS (
  SELECT r.room_type_id, d::date AS noche, sum(r.rooms_count) AS ocupadas
  FROM reservations r
  CROSS JOIN LATERAL generate_series(r.arrival_date, r.departure_date - 1, interval '1 day') AS d
  WHERE r.property_id = '<propertyId>' AND r.status IN ('confirmed', 'checked_in') AND r.deleted_at IS NULL
  GROUP BY 1, 2
), cupo AS (
  SELECT room_type_id, count(*) AS cupo FROM rooms
  WHERE property_id = '<propertyId>' AND sellable AND maintenance_status <> 'blocked' GROUP BY 1
)
SELECT rt.code, n.noche, n.ocupadas, c.cupo
FROM noches n JOIN room_types rt ON rt.id = n.room_type_id JOIN cupo c ON c.room_type_id = n.room_type_id
WHERE n.ocupadas > c.cupo ORDER BY 1, 2;

-- 7. Histórico: estancias cerradas con folio cerrado y stay (si traían habitación)
SELECT r.code, r.status, f.status AS folio, s.status AS stay
FROM reservations r LEFT JOIN folios f ON f.reservation_id = r.id LEFT JOIN stays s ON s.reservation_id = r.id
WHERE r.booking_source = 'import:<importId>' AND r.status = 'checked_out';

-- 8. Auditoría del lote (RESERVATION_IMPORT_COMMITTED y, si procede, RESERVATION_IMPORT_UNDONE)
SELECT action, entity_id, actor_user_id, correlation_id, created_at
FROM audit_events WHERE entity_type = 'reservation_import' AND entity_id = '<importId>' ORDER BY created_at;

-- 9. Tras deshacer: todas las confirmadas del lote canceladas y el lote undone
SELECT status, count(*) FROM reservations WHERE booking_source = 'import:<importId>' GROUP BY 1;
SELECT status, undone_count, undo_kept_count, undo_reason FROM reservation_imports WHERE id = '<importId>';

-- 10. Invariantes de Faranda (no deben moverse: 25 facturas · 33 envíos VeriFactu · 109 asientos · 1 lote de nómina)
SELECT count(*) FROM invoices i JOIN properties p ON p.id = i.property_id WHERE p.organization_id = '<orgId>';
SELECT count(*) FROM verifactu_submissions s JOIN invoices i ON i.id = s.invoice_id
JOIN properties p ON p.id = i.property_id WHERE p.organization_id = '<orgId>';
SELECT count(*) FROM journal_entries WHERE organization_id = '<orgId>';
SELECT count(*) FROM payroll_cost_imports WHERE organization_id = '<orgId>';
```

Nota: la fecha de negocio de la propiedad está en `business_dates."current_date"` (comillas:
es palabra reservada); es la que decide qué llegadas son «pasadas» (§7).

## 14 · Códigos de error de lote (HTTP)

Todos llegan con `details.code` (`RESERVATION_IMPORT_ERROR_CODES` en
`packages/shared/src/reservation-import-types.ts`); la pantalla los traduce
(`reservationImportErrorMessage`).

| Código | Status | `details` | Cuándo | Qué hacer |
| --- | --- | --- | --- | --- |
| `VALIDATION_ERROR` | 400 | issues zod en español | clave desconocida en el cuerpo, `content` y `contentBase64` a la vez, `commit` ≠ `true`, `limit` fuera de 1..200, `reason` > 500, `sampleSize` fuera de 1..1000 | corregir la petición |
| `RESERVATION_IMPORT_UNREADABLE` | 400 | `{ reason }` | no es un ZIP válido, ZIP64, libro cifrado, XML roto, > 200 columnas | «Guardar como .xlsx» normal o exportar a CSV (§2.3) |
| `RESERVATION_IMPORT_TOO_LARGE` | 400 | `{ bytes, max }` | > 5 MiB (413 del servidor si el cuerpo supera 8 MiB) | partir el fichero o usar el CLI |
| `RESERVATION_IMPORT_TOO_MANY_ROWS` | 400 | `{ rows, max }` | > 5.000 filas de datos | partir el fichero |
| `RESERVATION_IMPORT_EMPTY` | 400 | — | sin filas de datos, o 0 filas a crear en el commit | revisar el fichero o los blockers de la preview |
| `RESERVATION_IMPORT_MAPPING_INCOMPLETE` | 400 | `{ missing }` | campo obligatorio sin columna | mapear en el paso «Columnas» |
| `RESERVATION_IMPORT_MAPPING_CONFLICT` | 400 | `{ field, columns }` | campo en dos columnas o columna inexistente | corregir el mapeo |
| `RESERVATION_IMPORT_INVALID` | 400 | `{ errorCount, rows[≤ 50]: { rowNumber, code } }` | commit con errores de fila sin `omitirInvalidas` | corregir o activar «Omitir filas inválidas» |
| `RESERVATION_IMPORT_DUPLICATE` | 409 | `{ importId, createdAt, status, fileName }` | mismo hash en un lote no deshecho ni fallido, sin `force` | deshacer el anterior o «Importar de todos modos» |
| `RESERVATION_IMPORT_NOT_FOUND` | 404 (opaco) | — | lote inexistente, de otra propiedad u organización | — |
| `RESERVATION_IMPORT_UNDO_IN_PROGRESS` | 409 | `{ importId, undoneAt }` | otro deshacer reclamado hace menos de 15 min | esperar y repetir |
| `RESERVATION_IMPORT_SYNC_REQUIRES_FEED` | 400 | `{ missing: ["feed" \| "businessDate"] }` | `mode: "sync"` sin `feed` o sin `businessDate` (§18: la idempotencia y la ventana de ausencias dependen de ambos) | indicar `feed` (`arrivals` · `inhouse` · `departures` · `changes`) y `businessDate` (`YYYY-MM-DD`) |
| `RESERVATION_IMPORT_PROFILE_UNSUPPORTED_FEED` | 400 | `{ profile, feed }` | el perfil (`opera_cloud`) no tiene mapeo cerrado para ese feed (hoy `inhouse` y `changes`: columnas pendientes de muestra real) | usar `arrivals` (`RESPONSYS_RESV_AUTO`) o `departures` (`departure_all`); entregar la muestra (runbook OPERA §14) |
| `RESERVATION_IMPORT_HEADER_MISMATCH` | 400 | `{ expected[], received[], missing[], extra[] }` | la cabecera del fichero (o la primera fila con `headerOverride`) no coincide con la del perfil: informe reconfigurado, columna añadida, otro idioma; por el ingest abre además la alerta `OPERA_FEED_COLUMNS_CHANGED` | comprobar formato (Delimited frente a Delimited Data) y parámetros del informe en OPERA; con una cabecera nueva legítima, actualizar el perfil |

## 15 · GDPR y datos personales

- **El fichero nunca se guarda**: se analiza en memoria y se descarta. Ni el lote ni la
  auditoría conservan el contenido, solo el hash, el nombre del fichero, el mapeo, las
  opciones y los contadores.
- **Las filas del lote no llevan datos personales** (`reservation_import_rows`: nº de fila,
  referencia externa, fechas, tipo/tarifa, nº de habitaciones, código de reserva o código de
  error). Nombre, apellidos, e-mail, teléfono, documento, notas y peticiones están **prohibidos**
  en la fila por diseño; para verlos se abre la reserva o la ficha del huésped, con sus permisos.
- **Los mensajes de error y aviso citan columna y número de fila, nunca valores**
  (`stripRowValues`, `sanitizeRowError`; test unitario con una fila ficticia que afirma que
  ningún mensaje contiene el e-mail, el nombre ni el documento). Desde la ronda 1 (T7-FUN-02) la
  red de seguridad borra solo los valores **personales** de la fila (nombre, apellidos, e-mail,
  teléfono y documento como celda y como palabras; peticiones y notas solo como celda completa,
  porque sus palabras sueltas —«confirmar», «fecha», «con»— no identifican a nadie y mutilaban
  los mensajes de la propia fila) y solo como token completo: un código de catálogo o un
  estado que cite el propio mensaje («Estado» tentativa, tipo SRA) ya no aparece como
  «[valor omitido]». El informe CSV que descarga la pantalla tampoco lleva datos del huésped, y
  neutraliza la `referencia_externa` que empiece como una fórmula (`=`, `+`, `-`, `@`) para que
  la hoja de cálculo la muestre como texto (SEC-T7-02).
- Los datos del huésped viven donde siempre: `guests` (campos cifrados con hash de búsqueda por
  e-mail / documento / teléfono) y `reservations`; los derechos de acceso, rectificación y
  supresión se atienden por los mismos cauces que una reserva de recepción. La reutilización de
  fichas se hace por documento o e-mail, nunca por nombre, y **no sobreescribe** la ficha.
- **No se envían correos** a los huéspedes importados (`bookerEmail` vacío): un fichero de 500
  filas no dispara 500 confirmaciones.
- Recomendaciones operativas: guardar los ficheros de origen fuera del repositorio
  (`/Users/cfernandez/anfitorio-demo/pilots/<hotel>/`, git-ignored) o borrarlos tras importar;
  no enviarlos por correo ni pegarlos en tickets; los ficheros de prueba y de demo solo con
  huéspedes ficticios (`@example.com`); minimizar columnas (si no se necesita el documento, no
  incluirlo).

## 16 · FAQ

- **La preview marca `RESERVATION_IMPORT_ROW_NO_AVAILABILITY` en una fila que, mirando el
  planning, cabe.** Es la regla de rango del PMS (§5.1): las reservas que solapan el rango
  entero se suman aunque no coincidan la misma noche. Partir la estancia, cambiar de tipo o
  permitir overbooking a sabiendas.
- **¿Se avisa a los huéspedes?** No. Ningún correo ni SMS; el e-mail queda en la ficha para
  comunicaciones posteriores.
- **Subo el mismo fichero y recibo 409 `RESERVATION_IMPORT_DUPLICATE`.** Ya está importado y
  el lote sigue vivo. Si de verdad hay que repetir, deshacer el lote anterior o «Importar de
  todos modos» (y asumir duplicados en las filas sin referencia externa).
- **He importado un fichero con 3 filas mal; las he corregido y vuelvo a subir todo.** Bien
  si las filas tienen `referencia_externa`: las 3 se crean y el resto se omite como
  `RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE`. Sin referencia, subir solo las 3 filas.
- **Las fechas salen desplazadas / «31/12/1899».** Columna con seriales de Excel sin formato
  de fecha, o fichero `MM/DD/YYYY`. Formatear la columna como fecha o convertir a `YYYY-MM-DD`.
- **Los teléfonos han perdido el «0» inicial / el DNI sale como `1.2E7`.** Excel guardó la
  columna como número. Formatear como texto y volver a exportar; o exportar a CSV.
- **`RESERVATION_IMPORT_UNREADABLE` con un `.xlsx` que Excel abre sin problema.** Libro cifrado,
  `.xls` renombrado, ZIP64 o exportado por una herramienta que no escribe valores cacheados.
  «Guardar como… Libro de Excel (.xlsx)» desde Excel o exportar a CSV.
- **¿Por qué mis «tentativas» aparecen confirmadas?** Porque el PMS solo fija el estado al
  crear y una tentativa real no consumiría inventario (§8.3). Llevan nota interna para
  localizarlas; la decisión está elevada a César.
- **Quiero cargar el histórico del PMS anterior.** Activar «histórico» (`--historical`): las
  estancias terminadas se crean cerradas, sin cargos ni notificaciones; incluir `habitacion`
  para que cuenten como estancias (§7). Las reservas en casa se hacen por recepción.
- **¿Puede importar Recepción? ¿Y Contabilidad?** Recepción, Dirección, Comercial,
  Propietario y Administrador sí; Contabilidad, Revenue, Cumplimiento, Pisos y Mantenimiento
  solo consultan lotes y descargan la plantilla (§10).
- **La importación se cortó a medias.** El lote queda «Interrumpida» pero es deshacible y las
  reservas creadas son reales (§8.2, §8.4). Deshacer y repetir por CLI es lo más limpio.
- **¿Deshacer libera las habitaciones asignadas o borra los huéspedes?** No: cancela las
  reservas (como recepción), nada más (§9).
- **¿Qué hago con un fichero de 20.000 filas?** Partirlo (≤ 5.000 filas y ≤ 5 MiB cada uno,
  mejor por mes), con `referencia_externa` en todas las filas, y cargarlo por CLI (§12).
- **¿El importe es obligatorio?** No: vacío se cotiza desde la tarifa (`quoteReservationTotal
  × habitaciones`, aviso `RESERVATION_IMPORT_ROW_TOTAL_QUOTED`); si la tarifa no tiene precio
  publicado queda a 0 con `RESERVATION_IMPORT_ROW_TOTAL_NOT_QUOTED`. Para tarifas paquete sin
  parrilla (Rías Altas: `BAR-BB`, `BAR-NR`) es mejor traer `importe_total` en el fichero.

## 17 · Documentos relacionados

- Diseño: [`docs/design/RESERVAS-IMPORTACION-MASIVA.md`](../design/RESERVAS-IMPORTACION-MASIVA.md).
- Contrato de rutas: [`docs/api-contracts.md`](../api-contracts.md) («### Importación masiva de reservas (Tanda 7)» bajo «## PMS»).
- Patrón de importación por lotes (nómina agregada): [`docs/design/FINANZAS-COSTE-PERSONAL.md`](../design/FINANZAS-COSTE-PERSONAL.md) y [`finanzas-contabilidad.md`](finanzas-contabilidad.md) §18.
- Patrón CLI de importación con dry-run y reversión: [`pms-history-forecast-import.md`](pms-history-forecast-import.md).
- Permisos y plantillas de rol: [`rbac-sync.md`](rbac-sync.md); navegación y pestañas: [`navegacion-tanda-5.md`](navegacion-tanda-5.md).
- Guía de la pantalla (Cocoa 22): [`docs/design/COCOA-22.md`](../design/COCOA-22.md).
- Informe del integrador (cifras reales de la demo): `docs/audits/TANDA-7-RESERVAS-IMPORT-2026-09-16.md`.
- Modo sombra OPERA Cloud: [`opera-modo-sombra.md`](opera-modo-sombra.md) (alta, feeds, sincronización §7, ingresos §8, reconciliación y alertas §9) y diseño [`docs/design/OPERA-CLOUD-MODO-SOMBRA.md`](../design/OPERA-CLOUD-MODO-SOMBRA.md).

## 18 · Modo sincronizar (Tanda 7b · OPERA Cloud)

El mismo importador (`POST …/reservations/imports/preview` y `POST …/reservations/imports`) admite un
segundo modo en el que **cada fichero es un snapshot** de una ventana de OPERA Cloud (llegadas de hoy a
+30, salidas de hoy, en casa, cambios del día anterior) y no un lote de altas: las filas conocidas se
actualizan o se dejan como están, las nuevas se crean, y los estados de OPERA (check-in, check-out,
cancelación, no-show) se aplican como transiciones. `mode: "create"` (por defecto) **no cambia nada** de
lo descrito en §1-§17. La operativa completa (alta del perfil, feeds, buzón, SFTP, ingresos,
reconciliación, alertas, SQL y FAQ) está en [`opera-modo-sombra.md`](opera-modo-sombra.md); aquí solo
lo que cambia en el importador. Desde la pantalla: Reservas › Importar con
`?modo=sync&perfil=opera_cloud&feed=arrivals&fecha=2026-09-16` (o el botón «Subir corte manual» del
panel «Modo sombra OPERA», que enlaza así).

### 18.1 · Parámetros nuevos del cuerpo (preview y commit; `.strict()`)

| Campo | Valores | Regla |
| --- | --- | --- |
| `mode` | `"create"` (defecto) · `"sync"` | en `sync`, el análisis resuelve el enlace `PmsShadowLink` por `referencia_externa` **antes** de la validación de duplicados: una referencia conocida ya no es `RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE` sino candidata a `update` / `unchanged` |
| `profile` | `"opera_cloud"` | aplica el mapeo **explícito** del perfil preinstalado (`packages/shared/src/pms-shadow-profiles/opera-cloud.ts`: 33 cabeceras de `RESPONSYS_RESV_AUTO` para `arrivals`, 19 de `departure_all` para `departures`), su `statusMap`, sus diccionarios de canal / segmento / método de pago y `dateOrder`; el `mapping` del cuerpo, si viaja, solo puede ignorar columnas (`null`). Sin `profile` en `sync` se aplican los sinónimos de §3 (útil para un PMS distinto de OPERA) |
| `feed` | `arrivals` · `inhouse` · `departures` · `changes` | **obligatorio en `sync`** (400 `RESERVATION_IMPORT_SYNC_REQUIRES_FEED`); fija qué columnas exige el perfil, la ventana de ausencias y la sal del hash (§18.5). `inhouse` y `changes` → 400 `RESERVATION_IMPORT_PROFILE_UNSUPPORTED_FEED` hasta recibir la muestra real |
| `businessDate` | `YYYY-MM-DD` | **obligatorio en `sync`**; business date del corte (la del hotel en OPERA, no la fecha natural del fichero). Es la frontera de «llegada pasada» del lote y el `lastBusinessDate` que reciben los enlaces |
| `horizonDays` | entero, defecto 30 (540 en el snapshot semanal) | solo `arrivals`: ventana [businessDate, + horizonDays] de enlaces que «deberían» estar en el fichero; los ausentes suman `missingStreak` y abren `OPERA_MISSING_IN_SNAPSHOT` (nunca se cancelan solos) |
| `headerOverride` | `string[]` (≤ 200) | fichero **sin fila de cabecera** (Delimited Data de OPERA): la lista es la cabecera y **la primera fila del fichero ya es un dato**. El perfil `opera_cloud` la aporta sola para `departures` (`headerless`); para otros ficheros sin cabecera se pasa a mano |

Los demás campos (`fileName`, `format`, `content` XOR `contentBase64`, `sheetName`, `omitirInvalidas`,
`permitirOverbooking`, `force`, `sampleSize`, `commit`) se comportan igual. `historico` no hace falta:
en `sync` una fila `Checked Out` con llegada pasada toma sola el camino histórico.

### 18.2 · Permisos

`POST …/reservations/imports` con `mode: "sync"` exige `pms.reservation.create` +
`pms.reservation.modify` + `pms.checkin.execute` + `pms.checkout.execute` (§10); la preview sigue
con `pms.reservation.create`. Recepción, Dirección, Propietario y Administrador pueden; Comercial no.
El ingest por clave de API y el job usan el usuario de sistema `usr_system_pms_shadow`, que las tiene.

### 18.3 · Acción por fila

La preview y el resultado añaden `action` a cada fila (columna «Acción» en la pantalla):

| `action` | Cuándo | En el commit | Fila del lote |
| --- | --- | --- | --- |
| `create` | referencia sin enlace (estado destino vivo o cancelado / no-show) | `createReservation` (camino único de §8.1) + alta del enlace; si el estado destino no es `confirmed`, la transición en la misma fila | `outcome created`, `reservationId` y `reservationCode` |
| `update` | enlace con `rowHash` distinto | `updateReservationShadow`: fechas, tipo, tarifa, ocupación, unidades, importe, segmento, canal, grupo, habitación; **sin correos ni eventos de dominio**; diff sin PII en `warningsJson` | `outcome updated`, **sin `reservationId`** (ver §18.4), con `reservationCode` |
| `transition` | enlace y estado destino distinto del actual (acompaña a `update` o va sola) | `transitionReservation(cancelled \| no_show)`, check-in sombra (`checkInReservation` con firma centinela `opera:<confirmación>` y `allowEarlyCheckIn`), check-out sombra (`checkOutReservationDetailed` + cierre de folio) | `outcome updated` + aviso con la transición |
| `unchanged` | enlace y mismo `rowHash` | solo `lastSeenAt`, `lastBusinessDate`, `lastImportId`, `missingStreak = 0` del enlace | `outcome unchanged` |
| `skip` | waitlist, pseudo room, conflicto con reserva local sin enlace | nada | `outcome skipped` + código |

Códigos de fila nuevos (`RESERVATION_IMPORT_ROW_CODES`): `RESERVATION_IMPORT_ROW_OPERA_TOTAL_ESTIMATED`
(aviso: `importe_total` = `RATE` × noches × habitaciones; `RATE` es la tarifa de la primera noche),
`RESERVATION_IMPORT_ROW_OPERA_WAITLIST_SKIPPED`, `RESERVATION_IMPORT_ROW_OPERA_PSEUDO_ROOM`,
`RESERVATION_IMPORT_ROW_OPERA_CONFLICT_LOCAL_RESERVATION` (misma referencia en una reserva sin enlace:
omitida + alerta), `RESERVATION_IMPORT_ROW_OPERA_CHECKIN_WITHOUT_ROOM` (queda `confirmed` + alerta),
`RESERVATION_IMPORT_ROW_SYNC_STATUS_REGRESSION` (OPERA «retrocede» un estado: nada),
`RESERVATION_IMPORT_ROW_SYNC_CANCEL_AFTER_CHECKIN` (cancelación sobre una reserva ya en casa: nada),
`RESERVATION_IMPORT_ROW_SYNC_ROOM_MOVE_IGNORED` (cambio de habitación de una reserva en casa: se ignora
la habitación), `RESERVATION_IMPORT_ROW_SYNC_UPDATE_FAILED` y `RESERVATION_IMPORT_ROW_SYNC_TRANSITION_FAILED`
(errores del commit, mensaje sin valores) y `RESERVATION_IMPORT_ROW_SYNC_REQUIRES_REFERENCE` (fila sin
nº de confirmación en un feed que lo exige). Los estados de OPERA se traducen con el `statusMap` del
perfil a `confirmed` · `checked_in` · `checked_out` · `cancelled` · `no_show` · `skip`
(`RESERVATION_SYNC_TARGET_STATUSES`), no a los tres estados de §8.3; `Prospect` / `Requested` →
`confirmed` con `RESERVATION_IMPORT_ROW_TENTATIVE_AS_CONFIRMED`.

### 18.4 · Contadores nuevos y filas `updated`

- `summary` de la preview: además de `valid / warning / error / skipped / historical / toCreate`,
  `toUpdate`, `toTransition` y `unchanged`; `canImport` en `sync` exige `toCreate + toUpdate +
  toTransition + unchanged > 0` (un snapshot idéntico al anterior **sí** se importa: sus filas
  `unchanged` mantienen vivos los enlaces).
- Lote (`ReservationImport`): `createdCount` como siempre y, en `optionsJson`, `mode`, `profile`,
  `feed`, `businessDate`, `horizonDays`, `updatedCount`, `unchangedCount`, `transitionedCount` y
  `shadowRunId` (sin migración de esa tabla). El estado final tiene en cuenta los cuatro contadores:
  un lote con 0 creadas y N actualizadas / sin cambios es `imported`, no `failed`
  (`deriveImportStatus` extendido; en `create` sigue igual).
- Filas `updated` / `unchanged`: **sin `reservationId`** y con `reservationCode`. `ReservationImportRow.reservationId`
  es `@unique` (una reserva procede de una sola fila: la que la creó, en un lote anterior), así que las
  filas que la tocan después solo llevan el código para enlazar desde la pantalla; el enlace vivo está en
  `pms_shadow_links.reservation_id`.

### 18.5 · Idempotencia por corte

El `contentHash` del lote en `sync` es el de §6 (filas normalizadas) **salado con `feed` +
`businessDate`**: el mismo fichero, el mismo feed y el mismo business date → 409
`RESERVATION_IMPORT_DUPLICATE` salvo `force`; el mismo fichero en **otro** business date es un lote
nuevo con todas sus filas `unchanged` (así los enlaces reciben el nuevo `lastBusinessDate` y no se abren
ausencias falsas). Tras deshacer el lote, el hash queda libre como en `create`.

### 18.6 · Deshacer un lote `sync`

`POST …/reservations/imports/:id/undo` cancela **solo lo creado** por el lote (`bookingSource =
import:<id>` en `draft` / `confirmed`), como en §9. **No deshace** las actualizaciones (el diff queda en
`warningsJson`; OPERA manda), ni las transiciones, ni los check-ins / check-outs sombra (`kept`), ni
toca los enlaces de las reservas conservadas. Las reservas canceladas al deshacer conservan su enlace:
el siguiente corte las trata como reactivación (reserva nueva con
`RESERVATION_IMPORT_ROW_REFERENCE_REUSED_CANCELLED` y el enlace pasa a la nueva).

### 18.7 · Lo que no cambia

`bookingSource` sigue siendo `import:<importId>` (clave del lote y del deshacer; la propiedad OPERA de
la reserva la marca el enlace, no el `bookingSource`); `bookerEmail` vacío y ningún correo; el fichero
no se guarda; las filas del lote sin datos personales (§15); el CLI `reservations:import` **sigue sin**
`--mode` ni `--feed` (2026-09-19: no se han añadido): los cortes de OPERA entran por el ingest
(`pms-shadow:pull`), el buzón o el panel ([`opera-modo-sombra.md`](opera-modo-sombra.md) §5-§6) y, para la
carga real de los informes R&A por CLI, los suple el script nuevo `import-opera-reports.ts` (§19), que llama a
`importReservations` con `mode: "sync"` desde fuera del CLI de la Tanda 7. Con él se ejecutó la carga real de
los cinco hoteles el 2026-09-19 (10 lotes `sync`, 13.347 reservas, 0 errores: §19.10).

## 19 · Carga real OPERA Cloud R&A (formato real confirmado 2026-09-19)

El 2026-09-19 llegaron los primeros informes **reales** de OPERA Cloud R&A de los cinco hoteles de Faranda
(Rías Altas, Los Tilos, Pathos, Marsol y Alisas), exportados a `.xlsx` (hoja «Hoja1») y guardados FUERA del
repo (`~/anfitorio-demo/pilots/faranda-celuisma/opera-real/`, carpeta git-ignorada). No son los informes
sintéticos de la Tanda 7b (`RESPONSYS_RESV_AUTO` / `departure_all`): son otros dos informes con sus propias
cabeceras, así que **no** se importan con `profile: "opera_cloud"` sino con el CSV canónico de 33 campos que
produce el preprocesado (`prep`) del CLI `apps/api/src/scripts/import-opera-reports.ts`, en modo `sync` sin
perfil. Este apartado documenta el formato real, las decisiones del preprocesado, los tres cambios de código
que exigió y el procedimiento completo. Cifras y decisiones en `docs/audits/TANDA-7D-OPERA-REAL-2026-09-19.md`.

### 19.1 · Los dos informes reales

| Informe | Fichero | Filas / columnas | Cabeceras que se leen (el resto se ignora) |
| --- | --- | --- | --- |
| **Estancias** (reservas con noche en el periodo 01/08-18/09/2026, cualquier estado) | `<Hotel> - 01.08.26 to 18.09.26.xlsx` | 1.602-2.633 filas · **40 columnas** fijas: `RESORT GRPBY_DISP1 ROOM_CLASS GRPBY_DISP2 RESV_NAME_ID GUARANTEE_CODE RESV_STATUS ROOM FULL_NAME DEPARTURE PERSONS GROUP_NAME NO_OF_ROOMS ROOM_CATEGORY_LABEL RATE_CODE INSERT_USER INSERT_DATE GUARANTEE_CODE_DESC COMPANY_NAME TRAVEL_AGENT_NAME ARRIVAL NIGHTS COMP_HOUSE_YN SHARE_AMOUNT C_T_S_NAME SHORT_RESV_STATUS SHARE_AMOUNT_PER_STAY RC_* RES_* SUM* S_* LOGO` | `RESV_NAME_ID RESV_STATUS ROOM FULL_NAME ARRIVAL DEPARTURE NIGHTS PERSONS NO_OF_ROOMS ROOM_CATEGORY_LABEL RATE_CODE GUARANTEE_CODE GUARANTEE_CODE_DESC COMPANY_NAME TRAVEL_AGENT_NAME GROUP_NAME SHARE_AMOUNT SHARE_AMOUNT_PER_STAY COMP_HOUSE_YN INSERT_DATE` |
| **Llegadas** (reservas con llegada 18/09/2026-31/12/2028) | `Llegadas - <Hotel> (18.09.26 to 31.12.28).xlsx` | 317-3.278 filas · **108-119 columnas** (varía por hotel: `LIST_G_*`, `FC_*`, `GTV_*`, `DEPT_ID`, `TRACE_TEXT` aparecen o no) y **el orden cambia a partir de la columna ~60** → mapear SIEMPRE por nombre de cabecera, nunca por posición | `CONFIRMATION_NO RESV_NAME_ID EXTERNAL_REFERENCE ARRIVAL DEPARTURE ROOM_CATEGORY_LABEL DISP_ROOM_NO NO_OF_ROOMS ADULTS CHILDREN PERSONS MARKET_CODE RATE_CODE GUARANTEE_CODE COMPANY_NAME ORIGIN_OF_BOOKING GROUP_ID BLOCK_CODE VIP SHARE_AMOUNT CURRENCY_CODE DEPOSIT_PAID PAYMENT_METHOD PRODUCTS COMP_HOUSE FULL_NAME` |

Hechos del formato: fechas como **texto** `DD/MM/YY` (`ARRIVAL`, `DEPARTURE`, `INSERT_DATE`; el lector xlsx las
entrega como cadena, no como serial) y `UPDATE_DATE` como `DD-MON-YY` (`18-SEP-26`); números como números
(`97.75`, `238`); `RESV_STATUS` literal en mayúsculas con espacio (`CHECKED OUT`, `CHECKED IN`, `RESERVED`,
`NO SHOW`, `CANCELLED`); `SHORT_RESV_STATUS` es el estado corto (`CKOT`, `CKIN`, `CXL`, `NOSH`) o, en RESERVED, el
código de garantía; `GUARANTEE_CODE` vale `CHECKED IN` en las estancias ya alojadas o cerradas; `NIGHTS` =
`DEPARTURE − ARRIVAL` siempre; `FULL_NAME` es «APELLIDOS, NOMBRE» en el ~93 % de las filas.

**Importes.** En estancias `SHARE_AMOUNT` es la **tarifa por noche** (de la primera noche) y
`SHARE_AMOUNT_PER_STAY` el **total de la estancia** (Σ por estado cuadra con los totales del informe
`S_RATE`): `importe_total ← SHARE_AMOUNT_PER_STAY`. En llegadas solo hay `SHARE_AMOUNT` (tarifa/noche, igual a
`EFFECTIVE_RATE_AMOUNT`): `importe_total ← SHARE_AMOUNT × noches`, marcado en las notas como «importe estimado
tarifa×noches»; la fila de estancias del mismo `RESV_NAME_ID` (cuando la reserva ya está en el periodo) lo
corrige después con el total real. Cortesías y uso de casa con 0 € se escriben `0,00`: **nunca se cotiza**
(`tarifa` vacía y además ignorada con `mapping: { tarifa: null }`, así ninguna fila cae en
`RATE_PLAN_DEFAULTED` ni `OPERA_RATE_CODE_UNMAPPED`; el `RATE_CODE` de OPERA va a las notas).

### 19.2 · Pseudo rooms, dedupe y referencia

- **Pseudo rooms**: `ROOM_CATEGORY_LABEL` `PI` (uso de casa, habitaciones 9100-9115 y 9500) y `PM` (paymaster,
  9000-9099) no son tipos de habitación: sus filas se omiten en el prep (`<HOTEL>-omitidas.csv`, motivo
  `pseudo`). Regla: categoría `PI`/`PM` **o** habitación 9000-9500. Las habitaciones `001`-`016` de Marsol y
  `001`-`007` de Rías Altas son reales (planta 0).
- **Day-use** (`NIGHTS = 0`) y estancias de más de 365 noches (una cancelada de Marsol de 734 noches, tope
  `RESERVATION_IMPORT_MAX_NIGHTS`) se omiten (`day_use`, `over_365`).
- **Llegadas con filas repetidas**: el informe repite la fila de una reserva por cada marcador (`|ROUT`,
  `|TRACE`, `|MEMB`, `FC` en `FULL_NAME` y columnas `LIST_G_*` / `FC_*`): Rías Altas 855 filas → 383 reservas,
  Alisas 317 → 310. Se deduplica por `CONFIRMATION_NO` quedándose con la **primera** fila (las repetidas no
  difieren en ningún campo núcleo; `RESV_NAME_ID` ↔ `CONFIRMATION_NO` es 1:1).
- **Referencia externa = `RESV_NAME_ID` en los dos informes** (7-8 dígitos), porque es el único identificador
  que comparten: las llegadas traen además `CONFIRMATION_NO` (9 dígitos) y `EXTERNAL_REFERENCE` (localizador
  del canal, compartido por varias reservas multi-habitación), que van a las notas. Así las 144 filas
  `RESERVED` de estancias (todas con llegada 18/09) son las MISMAS reservas que las 144 llegadas del 18/09: el
  primer lote las crea y el segundo las encuentra enlazadas (`annotateSync` resuelve el enlace antes del
  chequeo `DUPLICATE_REFERENCE`) y solo actualiza el importe (y el nombre completo de agencia / empresa,
  truncado a 20 caracteres en el informe de llegadas). Para los cortes futuros por `RESPONSYS_RESV_AUTO`
  (`RESERVATION_ID` = `CONFIRMATION_NO`) hará falta reindexar los enlaces o mapear `RESV_NAME_ID`: ver
  [`opera-modo-sombra.md`](opera-modo-sombra.md) §15.
- Los enlaces sintéticos de la demo (`IMP-RA-*`, `RIAS-*`) no colisionan con los `RESV_NAME_ID` numéricos.

### 19.3 · Lo que hace el prep fila a fila (y por qué)

| Campo canónico | Estancias | Llegadas | Motivo |
| --- | --- | --- | --- |
| `nombre` / `apellidos` | `FULL_NAME` partido con la MISMA regla que `splitFullName`: «Apellidos, Nombre» → apellidos antes de la coma; sin coma → primer token nombre y resto apellidos; un solo token → nombre = apellidos = token | ídem | `splitName` solo se activa cuando la columna mapeada a `nombre` tiene cabecera de nombre completo y no hay `apellidos`; al escribir las dos columnas ya rellenas ninguna fila cae en `MISSING_FIELD` y el reparto es determinista |
| `estado` | `RESV_STATUS` literal | `RESERVED` | los literales reales los resuelve el `statusMap` de OPERA (§19.4) |
| `habitacion` | `ROOM`; **en blanco** en `CANCELLED` / `NO SHOW` (no consumen inventario) y en la fila que **solapa** a otra fila VIVA (`CHECKED IN` / `RESERVED`) en la misma habitación (se blanquea la que no es `CHECKED IN`; el número va a las notas «hab. OPERA n»). Dos `CHECKED OUT` solapadas —cambio de habitación a mitad de estancia; OPERA deja la última en `ROOM`— **conservan las dos su habitación** (corrección t8: antes se blanqueaba la posterior y 26 estancias cerradas quedaron sin habitación ni `Stay`) | `DISP_ROOM_NO` (preasignada); en un solape, la fila posterior | `ROOM_DUPLICATE_IN_FILE` ya no salta entre dos filas históricas (`normalizeTable`) y `annotateRooms` no exige habitación libre a una estancia cerrada (nace `checked_out` con su `Stay`, sin consumir inventario); las vivas siguen exigiendo habitación libre |
| `tipo_habitacion` | `ROOM_CATEGORY_LABEL`, o el **tipo físico** de la habitación (categoría dominante de esa habitación en los dos informes) cuando difiere | ídem con `DISP_ROOM_NO` | `ROOM_TYPE_MISMATCH` es error de fila; la categoría reservada va a las notas («categoría DND3») |
| `adultos` / `ninos` | `PERSONS` / 0 (0 → 1; > máximo del tipo → recorte con nota «PERSONS OPERA n») | `ADULTS` / `CHILDREN` | `OCCUPANCY_EXCEEDED` es error |
| `canal` / `segmento` / `metodo_pago` / `vip` / `deposito` / `grupo` | derivados de `TRAVEL_AGENT_NAME`, `COMPANY_NAME`, `GROUP_NAME`, `RATE_CODE`, `COMP_HOUSE_YN`, `GUARANTEE_CODE` (diccionarios en el script: `channelOfAgency`, `deriveChannel`, `deriveSegment`, `mapPayment`, `mapGuarantee`) | de `COMPANY_NAME` («T- » agencia / «C- » empresa), `ORIGIN_OF_BOOKING`, `MARKET_CODE`, `PAYMENT_METHOD`, `VIP`, `DEPOSIT_PAID`, `BLOCK_CODE` | las 144 `RESERVED` de estancias se **enriquecen** con su fila de llegadas (C9) para que el segundo lote solo tenga que actualizar el importe |
| `notas` | formato fijo «OPERA · conf … · ext … · garantía CC (desc) · tarifa … · tarifa/noche … · pago … · mercado … · origen … · categoría … · bloque id/código · productos … · VIP … · comp … · creada AAAA-MM-DD · hab. OPERA … · PERSONS OPERA … · importe estimado tarifa×noches» | ídem | solo códigos, fechas e importes; `INSERT_DATE` solo como fecha |
| `tarifa`, `regimen`, `email`, `telefono`, `nacionalidad`, `documento_*`, `hora_llegada`, `peticiones` | vacíos | vacíos | los informes no traen contacto ni documento (una ficha de huésped por reserva); `PRODUCTS` (régimen en OPERA) va a las notas |

**Columnas que jamás llegan a la salida ni a los logs** (`OUTPUT_DENYLIST`, con test): `INSERT_USER`,
`UPDATE_USER` (personal de OPERA), `CREDIT_CARD_NUMBER`, `EXP_DATE`, `BILL_TO_ADDRESS`, `SHARE_NAMES`,
`ACCOMPANYING_*`, `MEMBERSHIP_*`, `TRX_STRING`, `TRACE_TEXT`, `FC_*`, `BILL_RESORT`, `BILL_RESV`,
`GUEST_NAME_ID`, `RC_*`, `RES_*`, `S_*`, `SUM*`, `LOGO`. El prep nunca imprime celdas: el resumen
(`RESUMEN.json`) solo lleva recuentos, códigos, números de habitación y sha256.

**Columnas extra del CSV canónico (corrección t8, 2026-09-19).** Tras los 33 campos el prep escribe tres columnas
sin campo canónico que el importador reconoce por NOMBRE de cabecera (`resolveExtraColumns` en
`reservation-import.service.ts`; sinónimos `guarantee_code`, `total_estimado`, `deposit_paid`) y aplica solo al
CREAR la reserva (una enlazada no las actualiza: `ReservationShadowPatch` no las admite): `garantia`
(`GUARANTEE_CODE` real → `reservations.guarantee_type`; los literales de estado que OPERA escribe en las alojadas
y cerradas —`CHECKED IN`, `CHECKED OUT`, `DUE OUT`…— no son garantía y quedan vacíos; en las `RESERVED` de
estancias se toma la de la llegada), `importe_estimado` («si» cuando `importe_total` es tarifa × noches, es decir,
en todas las llegadas → `totalSource = quoted` → `price_source = quoted`, cuenta como cotizado en los totales y
**nunca pisa el total exacto** de una reserva enlazada porque `diffFields` solo compara importes `file`: reaplicar
`<HOTEL>-llegadas.csv` deja de ser peligroso) y `deposito_pagado` (`DEPOSIT_PAID`, ya cobrado en OPERA →
`reservations.deposit_paid`; `deposito` sigue llevando el mismo importe como depósito solicitado). Un fichero sin
estas columnas se importa exactamente igual que antes; con ellas la previsualización avisa «3 columna(s) extra
reconocida(s)» en vez de «sin mapear».

**Orden de las estancias** (determinista): `CANCELLED`, `NO SHOW`, `CHECKED OUT` (por llegada), `RESERVED` y
`CHECKED IN` al final, para que las filas que ocupan habitación se validen contra un fichero ya recorrido.

### 19.4 · Cambios de código (Tanda 7d: tres en la carga + cuatro en la corrección t8)

Corrección t8 (2026-09-19, tras la revisión de la carga):

4. **Columnas extra `garantia` / `importe_estimado` / `deposito_pagado`** (`reservation-import.service.ts`:
   `resolveExtraColumns`, `extraOf`, `AnalysedRow.extra`, `buildCreateReservationInput({ extra })`): ver §19.3.
   Sin tocar `packages/shared` (fuera del alcance): no son campos canónicos, se reconocen por cabecera.
5. **`ROOM_DUPLICATE_IN_FILE` no salta entre dos filas históricas** (`reservation-import.normalize.ts`,
   `seenRooms[].historical`): dos estancias cerradas solapadas en la misma habitación son un cambio de
   habitación a mitad de estancia, no un choque. Entre filas vivas (o viva + cerrada) sigue igual.
6. **`annotateRooms` no valida la habitación de una fila histórica** (`canAssignRoom` la rechazaría si la
   habitación está ocupada HOY por otro huésped; una estancia cerrada nace `checked_out` con su `Stay` y no
   consume inventario).
7. **Folio cerrado tras cancelación / no-show sombra** (`closeSettledFolio`, misma regla que el check-out sombra:
   solo si existe, está `open` y |saldo| < 0,005; un fallo se registra y no deshace la transición). Antes las
   2.511 canceladas / no-show de la carga dejaban el folio `open` (la cancelación nativa lo cierra; en RA y LT lo
   cerró el paso `close_settled_folios` del night audit de L5). Las 1.778 de PG / MC / AS siguen `open` hasta su
   primer night audit (no se han tocado por SQL).

CLI: subcomando **`backfill`** (corrección de reservas ya cargadas a partir del prep con las columnas extra:
`guarantee_type`, `price_source = quoted` en las llegadas estimadas no enlazadas, retirada de la nota «importe
estimado tarifa×noches» en las enlazadas cuyo total exacto puso el lote de estancias, `deposit_paid`, y
habitación + `Stay` cerrada de las `checked_out` que el prep de t0 blanqueó; dry-run por defecto, `--json` con el
`before` de cada reserva, un evento de auditoría `RESERVATION_IMPORT_BACKFILLED` por propiedad con recuentos e
ids, escrituras por Prisma dentro del CLI porque el producto no expone esos campos en `PATCH` para reservas
cerradas), **`verify --in <dir xlsx>`** (relee los informes brutos y compara: tabla «OPERA bruto → cargado» por
`RESV_STATUS` más las comprobaciones de garantía, `price_source`, `deposit_paid` y cerradas sin `Stay`; antes
solo comparaba con `RESUMEN.json`, ya filtrado, y no podía ver las 1.754 filas excluidas) e **`inventory`**
marca `sellable = false` los tipos sin habitación OPERA que sigan vendibles (`patchBackOfficeRoomType`;
`deactivateBackOfficeRoomType` solo pone `active = false`).

1. **`sync` sin perfil hereda el diccionario de estados de OPERA Cloud** (`reservation-import.service.ts`,
   `syncContext.statusMap = OPERA_CLOUD_PROFILE.statusMap` en vez de `{}`): los literales reales
   `CHECKED OUT` / `CHECKED IN` / `RESERVED` / `NO SHOW` / `CANCELLED` → `checked_out` / `checked_in` /
   `confirmed` / `no_show` / `cancelled` vía `foldValue` + `resolveSyncTargetStatus`; `WAITLIST` → omitida.
   **Cambio de comportamiento también en la ruta HTTP** `POST …/reservations/imports` con `mode: "sync"` y sin
   `profile`: antes toda fila salía `RESERVATION_IMPORT_ROW_INVALID_STATUS` (el modo era inutilizable sin
   perfil); ahora se aplica el diccionario OPERA. `normalizeRow` con `statusMap: {}` sigue dando
   `INVALID_STATUS` (el defecto vive en el servicio, no en el normalizador).
2. **`cutBusinessDate`** (`NormalizeRowOptions` / `NormalizeTableOptions`; el servicio lo rellena con el
   `businessDate` del corte): en `sync`, una fila con destino `confirmed` cuya llegada cae en
   `[min(businessDate, hoy), hoy)` ya NO es `PAST_ARRIVAL`. Necesario porque el corte es del 18/09 y se carga
   el 19/09: OPERA tenía 144 reservas `RESERVED` con llegada 18/09 (pendientes de check-in en recepción). La
   frontera solo se adelanta (un business date posterior a hoy no la atrasa) y `create` no cambia.
3. **`Stay.checkinAt` de un check-in sombra = llegada a las 15:00 hora local** (`arrivalCheckInAt(arrivalDate,
   timezone)`, exportada y con test; `ReservationImportCatalogs.timezone`): `checkInReservation` crea la `Stay`
   con `checkinAt = ahora`, y las 148 estancias `CHECKED IN` de los informes llevan días en casa. Solo en la
   transición `check_in` (`check_in_and_out` no la necesita: las `CHECKED OUT` nacen históricas con `Stay`
   15:00 → 11:00). Además `shadowCheckOut` pasa a exportarse para que `demo-retire` haga el check-out de la
   demo exactamente como el check-out sombra.

### 19.5 · Orden de carga: inventario → llegadas → estancias

`canAssignRoom` (`inventory.engine.ts`) trata una habitación **`occupied`** por otra reserva alojada como
conflicto **sin mirar fechas**. Si las estancias entraran antes, sus 22-52 check-ins sombra por hotel dejarían
esas habitaciones ocupadas y toda llegada preasignada a ellas —aunque llegue después de la salida del huésped
actual— fallaría con `ROOM_UNAVAILABLE`. Por eso: 1) `inventory` (tipos OPERA, re-tipado, altas,
desactivaciones), 2) `apply --feed arrivals` (confirmadas con habitación preasignada por `assignRoom`: solo
solape de fechas), 3) `apply --feed inhouse` (históricas, canceladas, no-show, check-ins sombra; las 144
`RESERVED` salen `update` / `unchanged`). Criterio para aplicar cada lote: 0 filas en error salvo las
documentadas en `RESUMEN.json`, 0 `ROOM_UNAVAILABLE` en filas `CHECKED IN`, 0
`OPERA_CONFLICT_LOCAL_RESERVATION`.

### 19.6 · Qué NO revierte `--undo` (copia `pg_dump` por tramo)

`undo` cancela solo lo creado en `draft | confirmed` (§18.6). **No** revierte: los check-ins sombra ni las
estancias históricas (`kept`), las cancelaciones y no-shows aplicados en el mismo lote, las fichas de huésped
creadas, los enlaces `PmsShadowLink`, las actualizaciones de importe del segundo lote ni los cambios de
inventario. Antes de cada tramo: `pg_dump "$DATABASE_URL" -Fc -f
~/anfitorio-demo/pilots/faranda-celuisma/opera-real/backups/pre-t<N>-<HOTEL>-<fecha>.dump`.

### 19.7 · CLI `import-opera-reports.ts` paso a paso

```bash
WT=~/anfitorio-demo-wt-opera/hotelos; OR=~/anfitorio-demo/pilots/faranda-celuisma/opera-real
cd $WT/apps/api; RUN=(node --env-file-if-exists=../../.env --import tsx)
# 1) prep (sin BD; reproducible: dos ejecuciones dan el mismo sha256 en RESUMEN.json)
"${RUN[@]}" src/scripts/import-opera-reports.ts prep --in "$OR" --out "$OR/prep" [--hotel RA] [--json]
grep -c '@' "$OR/prep"/*.csv                     # → 0 (sin correos ni usuarios de OPERA)
grep -il 'XXXX[0-9]\{4\}' "$OR/prep"/*.csv        # → nada (sin tarjetas)
# 2) copia previa
pg_dump "$(grep -E '^DATABASE_URL=' $WT/.env | cut -d= -f2- | tr -d '"')" -Fc -f "$OR/backups/pre-t0-$(date +%Y%m%d-%H%M).dump"
# 3) demo fuera (solo Rías Altas): --undo de los lotes y demo-retire (dry-run → --apply)
"${RUN[@]}" src/scripts/import-reservations.ts --undo <importId> --property <RA> --reason "…"
"${RUN[@]}" src/scripts/import-opera-reports.ts demo-retire --property <RA> --cancel RES-…,RES-… --checkout RES-… --reason "…" [--apply]
# 4) inventario (dry-run → --apply; idempotente)
"${RUN[@]}" src/scripts/import-opera-reports.ts inventory --property <id> --plan "$OR/prep/<HOTEL>-inventario.json" [--apply] [--json]
# 5) llegadas y después estancias (dry-run → --apply; --json solo recuentos y códigos)
"${RUN[@]}" src/scripts/import-opera-reports.ts apply --property <id> --file "$OR/prep/<HOTEL>-llegadas.csv" --feed arrivals --business-date 2026-09-18 --json > "$OR/prep/logs/<HOTEL>-llegadas.dryrun.json"
"${RUN[@]}" src/scripts/import-opera-reports.ts apply --property <id> --file "$OR/prep/<HOTEL>-llegadas.csv" --feed arrivals --business-date 2026-09-18 --apply --json > "$OR/prep/logs/<HOTEL>-llegadas.apply.json"
"${RUN[@]}" src/scripts/import-opera-reports.ts apply --property <id> --file "$OR/prep/<HOTEL>-estancias.csv" --feed inhouse --business-date 2026-09-18 [--apply] --json
# 6) verificación y, si hace falta, deshacer (solo draft | confirmed)
"${RUN[@]}" src/scripts/import-opera-reports.ts verify --property <id> --expected "$OR/prep/RESUMEN.json" --hotel <HOTEL>
"${RUN[@]}" src/scripts/import-opera-reports.ts verify --property <id> --in "$OR" --hotel <HOTEL>          # contra los xlsx BRUTOS (t8)
"${RUN[@]}" src/scripts/import-opera-reports.ts undo --property <id> --import <importId> --reason "…"
# 7) corrección posterior (t8): garantía, price_source, deposit_paid, habitación + Stay de las cerradas blanqueadas
"${RUN[@]}" src/scripts/import-opera-reports.ts backfill --property <id> --hotel <HOTEL> --out "$OR/prep" --json > "$OR/prep/logs/<HOTEL>-backfill.dryrun.json"
"${RUN[@]}" src/scripts/import-opera-reports.ts backfill --property <id> --hotel <HOTEL> --out "$OR/prep" --apply --json > "$OR/prep/logs/<HOTEL>-backfill.apply.json"
```

Opciones internas de `apply`: `importReservations({ mode: "sync", feed, businessDate, mapping: { tarifa: null },
omitirInvalidas: true, permitirOverbooking: true, horizonDays: 730, force }, source: "cli")` con el contexto de
sistema `usr_system_pms_shadow` (`pms-shadow.rules.ts`; `inventory` añade `property.map.manage`),
`hydrateAuditChainFromPostgres` antes y `flushAuditQueues` / `flushAccountingProjection` /
`flushExtraProjections` después (patrón de `pms-shadow:pull`). Un reintento del mismo fichero + feed +
business date sobre un lote vivo da 409 `RESERVATION_IMPORT_DUPLICATE` → `--force` (las filas ya creadas salen
`unchanged`); si TODO está enlazado, `canImport` exige `toCreate > 0` y no aplica (seguro). **Nunca** reaplicar
`<HOTEL>-llegadas.csv` con `--force` después de haber aplicado las estancias: el fichero de llegadas conserva el
importe estimado tarifa × noches y el `--force` sobrescribiría los totales reales que el lote de estancias
corrigió en las reservas enlazadas (45 en la carga del 2026-09-19). Marsol (3.278
llegadas) tarda minutos: `nohup … --apply > log.json 2> log.err &`. No hay script npm en `apps/api/package.json`
(fichero fuera del alcance de la tanda): se invoca con `node --import tsx`.

### 19.8 · Fechas de negocio (coordinación con la Tanda L5)

El corte es del **18/09/2026** y las fechas de negocio de la BD local van por detrás (RA 2026-09-13, LT 09-14,
PG 09-16, MC 09-17; AS sin fila). La carga no las mueve (`getCurrentBusinessDate` solo crea la fila si falta).
Reglas: 1) no cerrar días de RA con las reservas de la demo vivas (`processNoShows` las marcaría `no_show` con
penalización); 2) preferible avanzar RA/LT/PG/MC hasta 2026-09-18 entre la retirada de la demo y la carga de
llegadas (con 0 reservas vivas ningún audit postea cargos sobre estancias reales) e inicializar AS en
2026-09-18 ANTES de su primer dry-run (si no, la fila nace con la fecha del día y sus 23 llegadas del 18/09
quedan como llegada pasada para el audit); 3) **nunca cerrar el 18/09** hasta que recepción registre los
check-ins de las 144 llegadas de ese día (siguen `confirmed`: el importador no hace su check-in).

**Cómo quedó el 2026-09-19 (t7, 03:30 CEST):** L5 no avanzó las fechas antes de la carga, así que se cargó con RA
2026-09-13 · LT 09-14 · PG 09-16 · MC 09-17 y `night_audit_runs` 0. La fila de AS **la creó el primer dry-run**
(2026-09-19 01:08:28 UTC, `current_date = 2026-09-19`). Además de las 144 llegadas del 18/09, hay 21 alojados con
salida prevista 18/09 que en OPERA seguían CHECKED IN al corte (AS 2 · LT 9 · PG 7 · RA 3).

**Cómo quedó DESPUÉS de L5 (estado real a 2026-09-19 04:50 CEST, revisión t8):** entre las 01:48:15 y las
01:59:15 UTC (03:48-03:59 CEST, 8-20 min después del cierre de t7) la sesión L5 del árbol principal ejecutó **11
night audits** con `NIGHT_AUDIT_PREFLIGHT_OVERRIDDEN`: RA 2026-09-13 → 09-18 (6, actor `cmu6tni3h00ahfydal93bweag`)
y LT 09-14 → 09-18 (5, actor `cmu6tni3g00affydagdnxyyhe`). Fechas de negocio ahora: **RA = LT = AS = 2026-09-19**,
MC 09-17, PG 09-16. Consecuencias que la regla 3 quería evitar y que siguen ABIERTAS (decisión del orquestador,
no de este runbook):

- **Trampa de no-show:** 108 llegadas reales del 18/09 que OPERA tenía `RESERVED` al corte siguen `confirmed`
  con `arrival_date < current_date` (RA 33 · LT 52 · AS 23); el preflight de los tres hoteles las lista como
  «no-shows sin resolver» y `canClose = false`; el próximo cierre (el del 19/09) las marcaría `no_show` con
  penalización (`processNoShows`). El check-in por endpoint cabe HOY (referencia = max(business date, hoy) =
  09-19, ventana ±1 día); desde mañana exige `allowEarlyCheckIn` + `pms.reservation.modify`. PG (26) y MC (10)
  sufrirán lo mismo cuando L5 los avance.
- **Cargos de habitación sobre folios reales:** los audits postearon **153 líneas `room` = 15.867,35 €** en 47
  reservas reales en casa (RA 70 líneas / 7.314,63 € / 21 reservas · LT 83 / 8.552,72 € / 26), `price_source`
  `file`; Mi día pasa de saldo pendiente 0 a RA 6.312,68 € y LT 5.751,57 €; el preflight bloquea por «folios
  abiertos con saldo». Contradice la decisión 3 del brief (estancias reales sin cargos; contabilidad en Sage)
  salvo decisión explícita.
- **12 noches cobradas después de la salida (1.152,74 €):** `post_room_charges` del cierre del 18/09 cargó la
  noche del 18/09 a alojados con `departure_date = 2026-09-18` (RA 3 = 240,82 € en 416 / 424 / 414 · LT 9 =
  911,92 € en 221 / 328 / 215 / 312 / 326 / 302 / 217 / 230 / 320; ids de línea en el informe externo §7). El
  producto no expone anulación de líneas de folio (solo `POST /folios/:id/lines` y transferencias): decidir
  entre línea de ajuste negativa por el producto o corrección por el orquestador de L5.
- **Regla nueva:** los due-out del día del corte (21 a 18/09) deben salir por recepción **ANTES** de cerrar ese día,
  y el 18/09 no se cierra hasta los check-ins de sus llegadas; con la fecha ya en 19/09, hacer hoy los 108
  check-ins (o pausar el cierre del 19/09 en RA / LT / AS) es lo único que evita el no-show automático.
- Nada de esto lo revierte `--undo` ni lo toca esta tanda (night audit fuera del alcance); recuentos y SQL en
  el informe externo §7 y en `docs/audits/TANDA-7D-OPERA-REAL-2026-09-19.md` §5.
- **Estado a t9 (2026-09-19 05:17 CEST): idéntico** — RA = LT = AS 2026-09-19, MC 09-17, PG 09-16; `night_audit_runs`
  11; 108 llegadas del 18/09 `confirmed`; 153 líneas `room`; 0 `no_show` desde el corte (§19.12).

### 19.9 · SQL de verificación (solo lectura)

```sql
-- por estado (reales = referencia numérica de 7-8 dígitos)
select p.code, r.status, count(*) from reservations r join properties p on p.id=r.property_id
 where r.deleted_at is null and r.external_reference ~ '^[0-9]{7,8}$' and p.id in (…5 ids…) group by 1,2 order by 1,2;
-- en casa por habitación
select p.code, ro.number from reservations r join rooms ro on ro.id=r.assigned_room_id join properties p on p.id=r.property_id
 where r.status='checked_in' and p.id in (…) order by 1,2;
-- llegadas 18/09 y 19/09
select p.code, r.arrival_date, count(*) from reservations r join properties p on p.id=r.property_id
 where r.arrival_date in ('2026-09-18','2026-09-19') and r.status in ('confirmed','checked_in') and p.id in (…) group by 1,2 order by 1,2;
-- room-nights de agosto (reales)
select p.code, sum(least(r.departure_date,'2026-09-01'::date)-greatest(r.arrival_date,'2026-08-01'::date))
  from reservations r join properties p on p.id=r.property_id
 where r.status in ('checked_out','checked_in') and r.arrival_date<'2026-09-01' and r.departure_date>'2026-08-01'
   and r.external_reference ~ '^[0-9]{7,8}$' and p.id in (…) group by 1;
-- duplicados (debe devolver 0 filas) y lotes
select property_id, external_reference, count(*) from reservations where deleted_at is null
   and external_reference ~ '^[0-9]{7,8}$' group by 1,2 having count(*)>1;
select id,property_id,status,row_count,created_count,skipped_count,error_count,options_json->>'feed' from reservation_imports order by created_at;
-- invariantes: facturas 33 (RA 25) · VeriFactu 41 (RA 33) · permisos 250 · roles Faranda 24 · lotes de ingresos sombra 2
select (select count(*) from invoices),(select count(*) from verifactu_submissions),(select count(*) from permissions),
       (select count(*) from roles where organization_id='cmrhw9jy30002fyvb6tsdiugt'),(select count(*) from pms_shadow_revenue_imports);
```

### 19.10 · Resultado de la carga real (2026-09-19, tramos t0-t7)

| Tramo | Hotel · feed | Lote `reservation_imports` | Filas · creadas · actualizadas · sin cambio · omitidas · error |
| --- | --- | --- | --- |
| t0 | RA demo fuera + inventario | (sin lote; `--undo` de `cmu4t43gh…`, `cmu5bkqxi…`, `cmu5blcyj…`, `cmu5bml1o…` + `demo-retire`) | 110 reservas de demo → 13 `checked_out` + 97 `cancelled`; RA 6 tipos OPERA · 75 re-tipadas · 27 altas · 45 desactivadas · 5 tipos sintéticos desactivados |
| t1 | RA llegadas | `cmu7n7c2g0000fyd38pppgps0` | 383 · 383 · 0 · 0 · 0 · 0 |
| t2 | RA estancias | `cmu7nnkca0000fyl4vbkufvmp` | 1.620 · 1.587 · 14 · 19 · 0 · 0 |
| t3 | LT llegadas / estancias (inventario 5 tipos, 74/18/18/4) | `cmu7nwad60000fyccfk2wxx17` / `cmu7nxlg20000fyk3huyn1dw0` | 493 · 493 · 0 · 0 · 0 · 0 / 1.683 · 1.631 · 4 · 48 · 0 · 0 |
| t4 | PG llegadas / estancias (inventario 4 tipos, 35/20/21/3) | `cmu7o6l1h0000fy8dqaub1mca` / `cmu7o7pxb0000fyq9rglhimsh` | 459 · 459 · 0 · 0 · 0 · 0 / 1.617 · 1.591 · 11 · 15 · 0 · 0 |
| t5 | MC llegadas / estancias (inventario 9 tipos, 34/51/51/4) | `cmu7oi72b0000fyc8v6m2rn8l` / `cmu7olqui0000fycb75mp5xno` | 3.278 · 3.278 · 0 · 0 · 0 · 0 / 2.135 · 2.125 · 1 · 9 · 0 · 0 |
| t6 | AS llegadas / estancias (inventario 6 tipos, 13/49/65/3) | `cmu7ovk2d0000fyiqr94dj8am` / `cmu7owpj40000fy2z2w5dg05f` | 310 · 310 · 0 · 0 · 0 · 0 / 1.513 · 1.490 · 15 · 8 · 0 · 0 |
| **Total** | 10 lotes `imported` | | **13.491 · 13.347 · 45 · 99 · 0 · 0** (actualizadas + sin cambio = las 144 RESERVED enlazadas) |
| t8 (04:45-04:50) | Corrección post-revisión, 5 hoteles: `prep` regenerado (36 columnas; v1 en `prep/v1-t7/`), `backfill --apply`, `inventory --apply` (sellable), housekeeping RA | (sin lote; `RESERVATION_IMPORT_BACKFILLED` × 5, `ROOM_MARKED_CLEAN` × 13; copia `backups/pre-t8-correccion-20260919-0445.dump`) | 7.459 reservas corregidas (RA 776 · LT 843 · PG 1.049 · MC 4.070 · AS 721): `guarantee_type` 7.434 · `price_source` → `quoted` 4.779 · nota «importe estimado» retirada 144 · `deposit_paid` 63 · habitación + `Stay` 25 (de 26; la que queda solapa a la alojada de AS 114) · 0 fallos; 19 tipos sintéticos `sellable = false`; 13 habitaciones vacantes de RA limpias (104, 117 y 411 ocupadas se dejan) |

**Verificación (t7; la final del integrador, t9, está en §19.12):** por hotel y estado = OPERA (confirmed 4.923 · checked_in 148 · checked_out 5.765 · no_show
74 · cancelled 2.437); `verify` 9/9 OK en los 5 hoteles; en casa a 18/09 148 habitaciones = OPERA (AS 23 · LT 28 ·
MC 52 · PG 23 · RA 22; `rooms.status = occupied` 148; `stays in_house` 148 con `checkin_at` = llegada 15:00 local);
llegadas 18/09 `confirmed` 144 (AS 23 · LT 52 · MC 10 · PG 26 · RA 33) y 19/09 82 (AS 16 · LT 5 · MC 15 · PG 16 · RA
30); RN agosto AS 1.500 · LT 1.728 · MC 2.147 · PG 1.401 · RA 2.196; tipos sintéticos activos 0 y habitaciones
activas = las vistas en los informes (62 / 92 / 85 / 55 / 102); 0 duplicados por referencia; huéspedes 13.436 = 89
+ 13.347; invariantes idénticas (facturas 33 · VeriFactu 41 · permisos 250 · roles Faranda 24 ·
`pms_shadow_revenue_imports` 2 · `journal_entries` 143.279); cronograma de RA por API (`GET
/properties/<RA>/reservations?from=2026-09-01&to=2026-10-01&status=confirmed,checked_in`, instancia propia :3909
con `RUN_SCHEDULERS=false` y `TENANT_BOOTSTRAP_SKIP=true`, parada después) = 175 (153 + 22) = SQL. Batería SQL
en `opera-real/prep/logs/t7-verify.sql` (salida `t7-verify.out`). Informe: `docs/audits/TANDA-7D-OPERA-REAL-2026-09-19.md`.

**Avisos y desviaciones con causa (ninguna bloqueante):**

- `OVERBOOKING` en llegadas (LT 1, MC 12) = sobreventa de categoría **de OPERA** (bloques de grupo de Marsol en 4
  semanas de 2027 con un bloque preasignado a las 12 DND2 físicas y otro sin habitación; una noche de LT DND3):
  el recuento por noche y tipo en BD solo supera el cupo ahí y en 1 noche histórica de PG DND2 (solape en el
  informe, habitación blanqueada). Los `OVERBOOKING` de los lotes de estancias (RA 10 · LT 2 · PG 11 · MC 1 · AS 12)
  son de la regla de rango (§5.1), que suma reservas ya enlazadas por referencia: 0 excesos reales, 0
  `ROOM_UNAVAILABLE`, 0 dobles asignaciones físicas.
- 26 estancias cerradas quedaron sin habitación ni `Stay` en t0-t7 (solape en el propio informe: AS 10 · LT 7 ·
  MC 1 · PG 5 · RA 3); **t8 repuso 25** (habitación por `hab. OPERA n` de las notas + `Stay` cerrada 15:00 →
  11:00 local); la que queda (AS, ref. 38962355, solapa a la alojada de la 114) debe seguir sin habitación. 21
  alojados con salida prevista 18/09 (due-out al corte) siguen en casa.
- 63 reservas llevan un tipo distinto de la categoría reservada (`ROOM_CATEGORY_LABEL`) por la regla «tipo físico
  dominante de la habitación» (AS 33 · LT 10 · RA 20): la categoría reservada está en las notas («categoría
  DND3»); es fiel a la habitación física, no a lo vendido (a confirmar con `cf_roomtypes`).
- 17 reservas reales de OPERA no se cargan por límites del producto: 16 day-use (`NIGHTS = 0`; 1 NO SHOW y 2
  CANCELLED entre ellas) y 1 cancelada de 734 noches (`prep/<HOTEL>-omitidas.csv`, motivos `day_use` /
  `over_365`); `verify --in` las muestra en la tabla «OPERA bruto → cargado».
- Canal / segmento de las 8.424 estancias son INFERIDOS (agencia, `RATE_CODE`, `GROUP_NAME`) y en llegadas
  `ORIGIN_OF_BOOKING = SAL` / `SLC` sale `corporate` (2.554 filas, MC 2.514 de bloques `GR_*` con segmento
  `group`): pendiente de `cf_origincodes`.
- `POSSIBLE_DUPLICATE` (3.204 filas) es la heurística nombre + fechas + tipo: multi-habitación y series de grupos;
  ninguna por referencia.
- Persistencia de auditoría: 4 eventos no persistidos por colisión del id corto (`aud_`/`evt_` + 8 hex) con
  eventos previos del mismo día (RA llegadas 1 `RoomAssigned`; PG estancias 1 `RESERVATION_CANCELLED`; MC
  llegadas 1 `ROOM_ASSIGNED` + 1 `ReservationCreated`); las reservas y asignaciones están en BD. **La cadena hash
  queda rota en 4 puntos** (el servicio siguió encadenando con el hash del evento perdido: enlaces con
  `previous_hash` sin `current_hash` correspondiente), en UTC: `audit_events` PG 2026-09-19 00:50:23.761
  (`RESERVATION_CREATED`) y MC 00:58:26.374 (`RESERVATION_CREATED`); `event_stream` RA 00:22:00.338
  (`ReservationCreated`) y MC 00:58:38.027 (`RoomAssigned`). Cualquier verificación de la cadena de PG / MC / RA
  falla desde ahí. La causa vive en `audit.service.ts` líneas 76 y 107 (fuera de esta tanda): ampliar el id o
  reintentar con otro id al recibir `Unique constraint failed`; tarea pendiente para el orquestador.
- Un segundo `apply` del mismo fichero + feed + business date sobre un lote vivo devuelve 409
  `RESERVATION_IMPORT_DUPLICATE` (comprobado en t6 con dos agentes en paralelo): un solo lote por feed en BD.
- La CARGA no generó ingresos ni cargos (0 líneas de folio, 0 facturas, 0 asientos nuevos: los informes no traen
  transaction codes); **los night audits de L5 sí** (153 líneas `room` en RA / LT, §19.8). Las 13.347 reservas
  llevan el plan BAR por defecto (`RATE_CODE` en notas; `board_type` vacío aunque `PKBB*` son paquetes con
  desayuno) y la Rate Grid de los 30 tipos OPERA está vacía (§19.11): ninguna cotización L3 devuelve precio.
  `price_source`: `file` en las 8.568 con total exacto de OPERA (estancias + 144 enlazadas), `quoted` en las
  4.779 llegadas con total tarifa × noches (en la muestra contrastable de 144 el 27 % difería del total real:
  pedir a OPERA el informe con total por reserva o rate detail). `rate_days` huérfanos de los tipos sintéticos
  desactivados: RA 900, LT 1.460.


### 19.11 · Mapa de categorías OPERA, huéspedes, tarifas y cronograma (revisión t8, 2026-09-19)

**Mapa `ROOM_CATEGORY_LABEL` → tipo de ehotelOS** (código = código OPERA; nombre PROPUESTO por inferencia,
`ROOM_TYPE_PROPOSALS` del CLI; **recepción debe confirmarlo con `cf_roomtypes`**; máx. ocupación = máximo observado;
base 2 salvo `TND*` 1). Habitaciones activas por hotel entre paréntesis:

| Código | Nombre propuesto | Máx. | AS | LT | MC | PG | RA |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `DND2` | Doble estándar | 3 | 5 | 61 | 12 | 25 | 45 |
| `DND3` | Doble con supletoria / triple | 4 | 29 | 6 | 2 | 3 | 7 |
| `DND4` | Doble superior | 4 | 17 | — | 9 | — | 30 |
| `DSD3` | Doble superior vista, triple | 4 | — | — | 10 | — | — |
| `DSD4` | Doble superior vista mar | 4 | — | — | 29 | — | — |
| `DSD5` | Doble superior vista premium | 3 | — | — | 10 | — | — |
| `KND1` | Doble cama king | 3 | — | 16 | 2 | 19 | 10 |
| `KND2` | Doble king superior | 4 | — | — | — | — | 7 |
| `KNE1` | King ejecutiva / familiar | 5 | 1 | 3 | — | — | 3 |
| `TND1` | Individual | 2 | — | 6 | 3 | 8 | — |
| `TND2` | Individual superior / doble uso individual | 2 | 7 | — | 8 | — | — |
| `TND3` | Individual superior plus | 2 | 3 | — | — | — | — |
| `PI` / `PM` | pseudo (uso de casa / paymaster): NO son tipos, filas omitidas | — | 6 / 6 | 9 / 15 | 9 / 15 | 9 / 8 | 9 / 18 |

15 habitaciones aparecen con dos categorías en el periodo (se aplicó la dominante): AS 232, 238, 252, 253, 254 ·
LT 127, 130 · RA 117, 118, 217, 218, 317, 318, 417, 418 (detalle en `prep/<HOTEL>-inventario.json`, `ambiguous`).
Los 19 tipos sintéticos (`DBL`, `DBM`, `DSV`, `IND`, `JSU`, `SRA`, `SUI`) están `active = false` y, desde t8,
`sellable = false`; sus `rate_days` (RA 900, LT 1.460) son huérfanos.

**Huéspedes (decisión pendiente de César / orquestador).** La carga creó **una ficha por reserva** (13.347) sin
deduplicar: 953 nombres repetidos suman 5.310 fichas (mediana 2, máximo 200) y los 13 nombres con ≥ 50 fichas
(1.989) son rooming-lists de grupo / touroperador cargadas como huéspedes (100 % con `group_code`; en 11 de 13 el
nombre coincide con la empresa / agencia / bloque; el de 200 fichas tiene nombre = apellido por la regla «un
token → ambos» de `splitOperaName`). La única clave de deduplicación fiable de las llegadas, `GUEST_NAME_ID` (id
interno de perfil OPERA, no es un dato personal), está en `OUTPUT_DENYLIST` y no se conserva. Propuesta: (a)
decidir si las reservas de grupo sin nombre de persona deben crear ficha (hoy sí) o solo `group_booking`; (b) sacar
`GUEST_NAME_ID` de la denylist y guardarlo como enlace opaco (`guest_profile_links` / `pms_shadow_links`) para
deduplicar en cortes futuros; (c) hasta entonces, ninguna fusión de fichas por nombre (minimización: mejor una
ficha de más que fundir dos personas). La regla de §19.3 sigue siendo «una ficha por reserva».

**Rate Grid (plan de acción, pendiente de datos de César).** Los 30 tipos OPERA tienen 0 `rate_days`: publicar BAR
(`revenue/actuals.ts` filtra `active + sellable` → `no_rate_days`) y cotizar / crear reservas desde la UI no
funciona en los 5 hoteles. Opciones: 1) pedir `cf_ratecodeheader` + tarifas por temporada y cargarlas en Rate Grid
por tipo OPERA (correcto); 2) mientras tanto, derivar una BAR de referencia por tipo y mes de la media de
`SHARE_AMOUNT` de las reservas con `RATE_CODE = BASE` (SQL en el informe externo §8) y cargarla con
`rate-grid/bulk-update` marcada como derivada. No se ha ejecutado ninguna de las dos (decisión de negocio).

**Cronograma en vista «mes» (limitación de producto, fuera de esta tanda).**
`apps/admin-web/src/screens/timeline/LiveTimelineWorkspace.tsx` pide `from/to` ± 1 día con `limit: 500`, no sigue
`X-Next-Cursor` y no filtra estados: agosto de 2026 tiene 1.089-1.582 reservas por hotel en la ventana de 32 días
(RA 1.121 · LT 1.112 · PG 1.164 · MC 1.582 · AS 1.089; MC 18/09 → 20/10 = 593), así que la vista mes pinta solo las
500 últimas llegadas y omite el resto sin aviso. Las vistas semana / 14 días caben (RA 13-26/09 = 335, LT 433, MC
256). Para verificar ocupación histórica: vista semana, o el API con `status=confirmed,checked_in` y cursor.
Propuesta al orquestador: seguir el cursor o filtrar estados vivos en `LiveTimelineWorkspace`.

**Residuos de la demo de RA con salida futura (decisión pendiente).** `RES-00006` (411, 16 → 20/09), `RES-00007`
(601, 17 → 19/09), `RES-00008` (202, 18 → 20/09) y `RES-00156` (119, 17 → 19/09) son `checked_out` por el check-out
sombra de t0 pero conservan su `departure_date` original, así que siguen en el cronograma (la 411 muestra tres
barras el 19/09: demo + alojado real + llegada real) y en Mi día (`departuresToday` de RA cuenta 2 de demo).
`PATCH` no admite reservas cerradas y no hay otro mecanismo de producto: la corrección sería
`departure_date = 2026-09-19` (día del check-out sombra) para esas 4 por el orquestador (SQL en el informe externo
§7), o aceptarlas como historial. `RES-00028` (616, 10 → 12/07/2027, cerrada) es un residuo anterior a la tanda.

### 19.12 · Verificación final del integrador (t9, 2026-09-19 05:10-05:17 CEST)

Estado de la BD local sin ningún cambio de datos desde t8. Esta verificación no escribió reservas, folios, fechas
de negocio ni inventario (13.466 filas de `reservations` antes y después); su única huella son 6 eventos de
auditoría de inicio de sesión de la instancia :3909 (ver «Escrituras»).

- **SQL** (`opera-real/prep/logs/t9-verify.sql`, salida `t9-verify.out`; batería de t7 + secciones R-Z y L3):
  reservas reales 13.347 = confirmed 4.923 · checked_in 148 · checked_out 5.765 · no_show 74 · cancelled 2.437 (AS
  1.800 · LT 2.124 · MC 5.403 · PG 2.050 · RA 1.970); en casa por habitación 148 = OPERA (`rooms.status = occupied`
  148, `stays in_house` 148); llegadas 18/09 `confirmed` 144 (+ 3 `checked_in`) y 19/09 82; RN agosto 8.972; 0
  duplicados por referencia; enlaces sombra 13.347 reales (+ 34 de la demo de RA); huéspedes de Faranda 13.436
  (13.347 vínculos `reservation_guests`, 13.347 huéspedes distintos); tipos activos y vendibles 30 / 19 sintéticos
  `active = false, sellable = false`; habitaciones activas y vendibles AS 62 · LT 92 · MC 85 · PG 55 · RA 102; cupo por
  tipo: los 3 excesos de OPERA (MC DND2 19 noches de 2027, LT DND3 26/09, PG DND2 04/09); **dobles asignaciones
  físicas con alguna reserva viva: 0**; entre estancias cerradas 28 pares / 35 noches (AS 9 / 11 · LT 9 / 13 · MC 1 / 1
  · PG 5 / 5 · RA 4 / 5) = los cambios de habitación a mitad de estancia que t8 conserva por diseño (t7 daba 0
  porque los blanqueaba); `guarantee_type` 7.434 · `price_source` `quoted` 4.779 / `file` 8.568 · `deposit_paid` 63 ·
  cerradas sin `Stay` 1 (AS); invariantes idénticas (facturas 33 / RA 25 · VeriFactu 41 / RA 33 · permisos 250 ·
  roles Faranda 24 · asignaciones de rol vivas de Faranda 31 + 1 revocada · `pms_shadow_revenue_imports` 2 ·
  `journal_entries` 143.279); `users` 33 (Faranda 32), 0 creados hoy; `rate_days` huérfanos RA 900 · LT 1.460.
- **0 usuarios de OPERA en la BD**: los 83 valores distintos de `INSERT_USER` / `UPDATE_USER` de los 10 xlsx (42 con
  correo; 125 tokens contando la parte local del correo) no aparecen en `users` (correo ni nombre), `guests.email`,
  `reservations.notes`, `reservation_import_rows` (avisos y errores), `audit_events` ni `event_stream`: 0 en las 8
  comprobaciones (fichero temporal con permisos 600, borrado al terminar); 0 `@` en los 15 CSV del prep y en los
  logs; 0 tarjetas.
- **`verify --in` × 5** (`opera-real/prep/logs/<HOTEL>-verify-t9.txt`): 13/13 OK y «Todo cuadra» en RA, LT, PG, MC y
  AS; cuerpo idéntico al de t8.
- **API** (instancia propia :3909 arrancada desde el worktree con `PORT=3909 RUN_SCHEDULERS=false
  TENANT_BOOTSTRAP_SKIP=true node --env-file-if-exists=../../.env --import tsx src/server.ts`, parada al terminar;
  `opera-real/prep/logs/t9-api-3909.txt`): `GET /properties/<RA>/reservations?from=2026-09-01&to=2026-10-01&status=confirmed,checked_in&limit=500&envelope=1`
  → **175** (153 + 22; `X-Total-Count` 175, 172 con habitación, 175 con referencia OPERA, llegadas 19/08-30/09) y
  `<LT>` → **302** (274 + 28; 146 con habitación: las llegadas sin `DISP_ROOM_NO` no la tienen); noches con reservas
  vivas RA 18/09 52 · 19/09 65 · 20/09 42 · 21/09 48 · 22/09 50 · 23/09 56 · 24/09 49 · 25/09 16 · 26/09 20 y LT 71 · 73 ·
  64 · 37 · 56 · 67 · 86 · 86 · 69 = SQL; vista semana de RA sin filtro de estado (12-27/09) 430 items (< 500: cabe), con
  24 residuos de la demo (4 cerradas con salida ≥ 19/09 en 411 / 601 / 202 / 119 y 20 canceladas o cerradas de
  septiembre) y 1 habitación con dos barras el 19/09 (411: llegada real + `RES-00006` cerrada hasta el 20/09);
  llegadas 18/09 y 19/09 por API = SQL en los 5 hoteles (RA 34 / 30 · LT 53 / 5 · PG 27 / 16 · MC 10 / 15 · AS 23 / 16,
  `confirmed` + `checked_in`); Mi día (`GET /dashboards/front-desk?propertyId=…`): llegadas · salidas · saldo
  pendiente RA 30 · 12 (10 reales + 2 demo) · 6.312,68 € — LT 5 · 2 · 5.751,57 € — PG 16 · 6 · 0 — MC 15 · 23 · 0 — AS 16 ·
  10 · 0 (en casa = `inHouseNow` + salidas de hoy + vencidas: RA 9 + 10 + 3 = 22 · LT 17 + 2 + 9 = 28 · PG 10 + 6 + 7 =
  23 · MC 29 + 23 + 0 = 52 · AS 11 + 10 + 2 = 23); inventario por API = SQL (tipos activos 6 / 5 / 4 / 9 / 6, todos con
  código OPERA; habitaciones activas y vendibles 102 / 92 / 55 / 85 / 62); RBAC: `recepcion.rias` sobre las reservas
  de LT → 404 opaco. La contraseña de `recepcion.tilos` no es la del seed (1 intento, 401, sin reintentos): LT se
  consultó con el superusuario demo de `HOTELOS_ALLOW_DEMO_AUTH`.
- **Puertas** (05:10 CEST): `corepack pnpm --filter @hotelos/api typecheck` OK · `corepack pnpm --filter
  @hotelos/api test` 2.351 tests · 2.350 pass · 1 skipped (preexistente) · 0 fail.
- **Escrituras de la verificación y ruido concurrente**: la instancia :3909 escribió 6 `audit_events` (4
  `AUTH_LOGIN`, 1 `LOGIN_FAILED`, 1 `ACCESS_DENIED`); con :3000 vivo eso añade 2 puntos de bifurcación a la cadena
  en memoria (deuda 12(c) del CLAUDE.md; hoy hay 52 puntos de bifurcación / 127 eventos en `audit_events`, casi
  todos de L5, t8 y suites). En el mismo minuto (03:15:19-22 UTC) otra sesión ejecutó una suite de integración
  contra la misma BD como `usr_123` (`PROPERTY_SWITCHED` × 11, `ROLE_CREATED_FROM_TEMPLATE`,
  `SES_HOSPEDAJES_SUBMISSION_REFUSED`, `RESERVATION_CREATED` × 3 en RA, borradas después: 0 reservas creadas hoy
  en RA). Las cadenas conservan eventos de reservas que ya no existen; nada de esto es de la tanda.
- **Fechas de negocio y L5 (sin cambios desde t8)**: RA = LT = AS = 2026-09-19, MC 09-17, PG 09-16; `night_audit_runs`
  11 `completed`; 108 llegadas del 18/09 siguen `confirmed` (RA 33 · LT 52 · AS 23); 153 líneas `room` (15.867,35 €) en
  47 folios reales de RA / LT y 12 noches posteriores a la salida (1.152,74 €); 0 `no_show` desde el corte. Folios
  de reservas reales: cerrados AS 1.065 · LT 1.603 · MC 1.282 · PG 983 · RA 1.565; abiertos 735 · 521 · 4.121 · 1.067 · 405.
