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
