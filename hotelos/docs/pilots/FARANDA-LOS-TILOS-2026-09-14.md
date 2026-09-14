# Piloto · Faranda Los Tilos, Ascend Hotel Collection (alta como 2.ª propiedad de Faranda · 2026-09-14)

Lote `docs-piloto` del alta del segundo hotel piloto en la organización real
«Faranda Hotels & Resorts» (`cmrhw9jy30002fyvb6tsdiugt`). Este documento fija
(1) la ficha del hotel con el grado de verificación de cada dato, (2) qué
contiene el informe *History and Forecast* exportado del PMS actual (Opera),
(3) las decisiones de mapeo a las tablas de Anfitorio, (4) el procedimiento
exacto que ejecuta el integrador, (5) intocables y riesgos, (6) los datos que
hay que pedir a Carmen/dirección y (7) las discrepancias detectadas de paso en
Rías Altas. Runbook de los dos scripts:
`docs/runbooks/pms-history-forecast-import.md`.

Convención de grados: **REAT/INE** = verificado en fuente oficial de la Xunta /
INE · **cadena** = web oficial de la cadena o de Choice Hotels · **secundario**
= OTAs, directorios, agregadores mercantiles · **ESTIMADO** = deducido por
nosotros, pendiente de confirmar por el hotel · **NO SE INVENTA** = dato que
solo puede aportar el hotel.

Fuentes primarias usadas (copias en el scratchpad de la sesión, referenciadas
en `tilos-research-notes.md`):

- REAT · *Registro de Empresas e Actividades Turísticas de Galicia*, CSV
  oficial `reat_directorio-alojamientos_esp.csv` (Xunta, fecha de referencia
  2026-09-01; https://aei.turismo.gal/es/directorio-alojamientos). Las dos
  filas de Faranda en Galicia están copiadas en `reat_faranda_galicia.csv`.
- INE · PDF «Relación de municipios y códigos por provincias a 1-1-2023»:
  `15 058 Oleiros · 15 078 Santiago de Compostela · 15 082 Teo`.
- Cadena · farandahotels.com (ficha es105) y choicehotels.com
  (`/spain/santiago-de-compostela/ascend-hotels/es105`); Hosteltur 31-10-2024
  (acuerdo Faranda–Choice, 8 hoteles del norte bajo Ascend Hotel Collection).
- Turismo de Galicia (ficha pública 1973 de turismo.gal): año de construcción
  y reforma, servicios declarados.

## 1 · Ficha del hotel (grado de verificación por dato)

| Dato | Valor | Grado · fuente |
| --- | --- | --- |
| Nombre registral | **FARANDA LOS TILOS, ASCEND HOTEL COLLECTION** | REAT H-CO-001327 |
| Nombre en Anfitorio (`properties.name`) | «Faranda Los Tilos, Ascend Hotel Collection»; nombre corto interno «Faranda Los Tilos» | decisión (forma registral + cadena) |
| Afiliación de marca | **Ascend Hotel Collection** = soft-brand de **Choice Hotels**; código Choice **ES105**. NO es una marca propia de Faranda (las suyas son Faranda Grand / Collection / Boutique / Express). El brief decía «Ascendo Collection»: **errata**, corregida en todo el plan | cadena (farandahotels.com, choicehotels.com, Hosteltur 31-10-2024) |
| Categoría | 4 estrellas · tipo HOTEL | REAT |
| Registro turístico Galicia | **H-CO-001327** | REAT |
| Habitaciones / plazas | **92 habitaciones · 176 plazas** | REAT |
| Dirección | Urbanización Los Tilos, Estrada Santiago-A Estrada (AC-841) km 2, **15894 Os Tilos – Teo (A Coruña)**. La cadena añade «Rúa do Morcego» (sin número) | REAT (forma registrada) · cadena (Rúa do Morcego) |
| Municipio | **Teo** (INE **15082**), provincia A Coruña (15). La web de la cadena y las OTAs ponen «Santiago de Compostela» (INE 15078): es marketing, **no** el municipio fiscal | REAT + INE (verificado) |
| Código postal | 15894 (coherente con INE 15082 para `resolveFiscalLocation`, `backoffice.service.ts` ~1125) | REAT (todas las fuentes coinciden) |
| Coordenadas | lat 42,84644 · lon −8,54075 | REAT |
| Teléfono | 981 819 200 (REAT); turismo.gal añade 981 819 100 | REAT · turismo.gal |
| Email de reservas | reservas.tilos@farandahotels.com | REAT |
| Construido / reformado | 1982 / 2004 | turismo.gal (oficial Xunta, ficha 1973) |
| Restauración | Restaurante **«Panzzoni Los Tilos»** (cocina italiana) + bar-cafetería; desayuno de pago | cadena (ficha es105) |
| Salas / eventos | Salas de reuniones y eventos (capacidades y nombres de las salas: secundario, no confirmados) | cadena (existencia) · secundario (detalle) |
| Parking | Parking propio (byfaranda.com «renovado con parking»); **tarifa desconocida** (OTAs contradictorias: gratuito vs. de pago) | cadena (existencia) · secundario (tarifa) |
| Piscina / spa | **No** (turismo.gal lista sauna, tenis y terraza-jardín; ninguna fuente lista piscina ni spa) | turismo.gal · cadena |
| Tipos de habitación vendidos | Individual Estándar (1 pax), Doble Estándar 2 camas (2), Doble Estándar matrimonio (2), Triple Estándar (3), Suite | cadena (ficha es105; **sin** número de habitaciones por tipo) |
| **Reparto por tipo (para el provisionador)** | **ESTIMADO: 8 IND (1 pax) · 41 DBL 2 camas (2) · 40 DBM matrimonio (2) · 3 SUI (2)** = 92 habitaciones y 8+82+80+6 = **176 plazas** exactas. Fuente secundaria alternativa (engalicia/hoteles.net): 6 individuales / 83 dobles / 3 suites (no cuadra 176 plazas). No se crea el tipo Triple hasta tener el rooming real | **ESTIMADO** → pedir rooming real (§6) |
| Plantas | 4 plantas (secundario); el provisionador crea 1 edificio + 4 plantas y reparte 23 habitaciones por planta | secundario · **ESTIMADO** |
| Organización / NIF | Se mantiene la org `cmrhw9jy30002fyvb6tsdiugt` «Faranda Hotels & Resorts», NIF **ficticio B99999997** (válido por checksum, fijado por `demo:fix-identity` el 2026-09-14). Los NIF que aparecen en agregadores mercantiles (Celuisma S.A. A33615980; Faranda International Hotels S.L. B87303095) **no** proceden de aviso legal ni de factura del hotel: **NO usar** | decisión · secundario (descartado) |
| Número de registro SES.HOSPEDAJES | **Desconocido** (NO SE INVENTA). La propiedad nace con `sesHospedajesEnabled=false`: con SES y VeriFactu desactivados sus checks de readiness resuelven «No aplica» (`pass`) y el readiness queda **`ready`** (§4.1). En cuanto se active `sesHospedajesEnabled` sin registro ni credenciales, `ses_hospedajes_credentials` / `ses_establishment_profile` volverán a bloquear, igual que en Rías Altas hoy (`docs/audits/DEMO-DATASET-2026-09-14.md` §6.4) | NO SE INVENTA |
| Tarifario (BAR real) | Desconocido. La BAR que publica el importador es una **referencia derivada del ADR** del PMS (§3), no el tarifario del hotel | NO SE INVENTA |
| Zona horaria / territorio fiscal | `Europe/Madrid` · `taxRegion ES_PENINSULA_BALEARES` · `fiscalTerritory common` (mismos valores que Rías Altas; `ensurePropertyTaxes` no crea impuestos nuevos porque la org ya tiene el IVA de la región, `tenant-hydration.ts` ~217-279) | decisión (misma org) |

## 2 · Qué contiene el informe *History and Forecast* (Opera)

Origen: PDF «tilos - history forecast - mes futuro24760127.pdf» generado por el
PMS actual el 14/09/26 04:00 (cabecera «Faranda Los Tilos Santiago · History
and Forecast»). Copia y CSV parseado en la carpeta **fuera del repo**
`/Users/cfernandez/anfitorio-demo/pilots/faranda-los-tilos/`
(`history-forecast-2026-09-14.pdf`, `history-forecast-2025-08-01_2026-10-31.csv`;
la carpeta `pilots/` está en `.gitignore` porque son datos reales de un
hotel).

### 2.1 · Columnas del CSV (cabecera obligatoria del importador)

`date,dow,section,totalOcc,arrRooms,compRooms,houseUse,deductIndiv,nonDedIndiv,deductGroup,nonDedGroup,occPct,revenue,adr,depRooms,dayUse,noShow,ooo,adlChl`

| Columna | Significado (Opera) | Destino en `revenue_daily_snapshots` |
| --- | --- | --- |
| `date` / `dow` | fecha de negocio (YYYY-MM-DD) y día de la semana | `snapshotDate = dayUtc(date)` |
| `section` | `history` (≤ 2026-09-13) o `forecast` (≥ 2026-09-14) | decide tabla destino (§3) |
| `totalOcc` | habitaciones ocupadas **incluyendo house use** | `totalOcc` |
| `arrRooms` / `depRooms` | llegadas / salidas (habitaciones) | `arrivalRooms` / `departureRooms` |
| `compRooms` | habitaciones de cortesía | `compRooms` |
| `houseUse` | uso interno (no producen ingreso ni cuentan para occ %/ADR) | `houseUseRooms` |
| `deductIndiv` / `nonDedIndiv` / `deductGroup` / `nonDedGroup` | desglose individual/grupo, deducible/no deducible | `deductIndividualRooms` / `nonDeductIndividualRooms` / `deductGroupRooms` / `nonDeductGroupRooms` |
| `occPct` | ocupación % según el PMS | `occupancyPercent` |
| `revenue` | **ingreso de alojamiento NETO** (sin IVA, sin F&B) | `roomRevenue`, `netRoomRevenue`, `totalRevenue` |
| `adr` | ADR según el PMS | `adr` |
| `dayUse` / `noShow` / `ooo` | day use · no-show · habitaciones fuera de orden | `dayUseRooms` / `noShowRooms` / `oooRooms` |
| `adlChl` | adultos + niños en casa | `adultsChildren` |

### 2.2 · Semántica verificada (457/457 filas, script python sobre el CSV)

- `deductIndiv + nonDedIndiv + deductGroup + nonDedGroup = totalOcc` (0 desviaciones).
- `occPct = (totalOcc − houseUse) / (92 − ooo) · 100` (0 desviaciones > 0,01).
- `adr = revenue / (totalOcc − houseUse)` (0 desviaciones > 0,01).
- `revenue` es neto de alojamiento: no incluye F&B, salas ni parking → no
  hay TRevPAR ni GOP posibles desde este informe.
- Valores numéricos con decimales tipo `9.0` (el parser debe aceptar
  `Number()` de `"9.0"`).

### 2.3 · Totales

| Bloque | Filas | Occ. total (con house use) | RN pagadas | Revenue neto | ADR | Occ. % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Historia 2025-08-01 → 2026-09-13 | 409 | **12.698** | 11.722 | **1.139.904,20 €** (Σ de filas 1.139.904,23 por redondeo) | **97,24** | **37,97 %** |
| Forecast 2026-09-14 → 2026-10-31 | 48 | **1.637** | 1.586 | **150.622,89 €** (Σ de filas 150.622,88 por redondeo) | **94,97** | 37,44 % |
| Total | 457 | **14.335** | 13.308 | **1.290.527,10 €** (Σ de filas 1.290.527,11 por redondeo) | **96,97** | **37,91 %** |

«RN pagadas» = `totalOcc − houseUse` (1.027 noches de house use en total),
que es la base del ADR y del occ % del PMS. Las cifras en negrita son las
filas «Total» del PDF; el importador, los SELECT y el board devuelven la suma
de las filas diarias (1.139.904,23 · 150.622,88 · 1.290.527,11): diferencias
de 1 céntimo por redondeo del PMS en sus totales, no un error de carga.

Anomalías a conocer antes de importar (todas se importan tal cual, fidelidad
al PMS):

- **3 días con revenue negativo** (ajustes/abonos del PMS): 2025-08-11
  −47,08 € · 2025-09-30 −1.570,97 € · 2025-10-22 −15,55 €. El importador los
  escribe tal cual; el ADR del PMS en esos días también es negativo.
- **OOO hasta 89 de 92** en cierres estacionales (5 días con OOO ≥ 80; 18 días
  con 0 RN pagadas). Por eso el occ % del PMS (base 92 − OOO) difiere del que
  calcularía Anfitorio (base 92): ver §5.
- **Máximo 90 habitaciones ocupadas** en un día (nunca 92).
- **2 días con `compRooms ≠ houseUse`** que el dry-run del importador marca
  como aviso «revisar en el PMS; se importa tal cual»: 2026-01-14 (comp 1,
  house use 2) y 2026-07-22 (comp 2, house use 4). En el resto de los 457
  días ambas columnas coinciden.

### 2.4 · Tabla mensual (calculada con python sobre el CSV; RN pagadas = totalOcc − houseUse; Occ % base 92 − OOO; ADR = revenue / RN pagadas)

| Mes | Sección | Días | Occ. total (con house use) | RN pagadas | House use | Occ. % | Revenue neto € | ADR € | Llegadas | RN grupo | OOO media/día |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2025-08 | history | 31 | 1.163 | 1.066 | 97 | 46,94 | 97.950,19 | 91,89 | 482 | 153 | 18,7 |
| 2025-09 | history | 30 | 1.338 | 1.282 | 56 | 59,99 | 124.006,45 | 96,73 | 787 | 714 | 20,8 |
| 2025-10 | history | 31 | 1.478 | 1.395 | 83 | 68,52 | 112.466,12 | 80,62 | 694 | 713 | 26,3 |
| 2025-11 | history | 30 | 562 | 499 | 63 | 24,59 | 44.599,44 | 89,38 | 228 | 402 | 24,4 |
| 2025-12 | history | 31 | 407 | 360 | 47 | 16,04 | 31.155,10 | 86,54 | 110 | 108 | 19,6 |
| 2026-01 | history | 31 | 145 | 113 | 32 | 5,75 | 15.039,62 | 133,09 | 57 | 0 | 28,6 |
| 2026-02 | history | 28 | 274 | 219 | 55 | 10,53 | 23.103,30 | 105,49 | 80 | 125 | 17,7 |
| 2026-03 | history | 31 | 348 | 297 | 51 | 13,77 | 30.548,29 | 102,86 | 132 | 201 | 22,4 |
| 2026-04 | history | 30 | 738 | 672 | 66 | 29,15 | 62.948,77 | 93,67 | 219 | 390 | 15,2 |
| 2026-05 | history | 31 | 1.660 | 1.517 | 143 | 55,96 | 144.664,85 | 95,36 | 445 | 1.351 | 4,5 |
| 2026-06 | history | 30 | 1.253 | 1.169 | 84 | 45,22 | 120.920,57 | 103,44 | 619 | 628 | 5,8 |
| 2026-07 | history | 31 | 1.004 | 913 | 91 | 34,52 | 93.926,63 | 102,88 | 471 | 287 | 6,7 |
| 2026-08 | history | 31 | 1.728 | 1.648 | 80 | 63,29 | 172.338,23 | 104,57 | 855 | 268 | 8,0 |
| 2026-09 (01–13) | history | 13 | 600 | 572 | 28 | 51,95 | 66.236,67 | 115,80 | 313 | 241 | 7,3 |
| 2026-09 (14–30) | forecast | 17 | 861 | 843 | 18 | 57,54 | 76.729,68 | 91,02 | 270 | 606 | 5,8 |
| 2026-10 | forecast | 31 | 776 | 743 | 33 | 26,81 | 73.893,20 | 99,45 | 190 | 584 | 2,6 |
| **Total** | | 457 | 14.335 | 13.308 | 1.027 | 37,91 | 1.290.527,11 | 96,97 | 5.952 | 6.771 | 15,2 |

Lectura: hotel muy estacional (enero 5,75 % con 28,6 OOO/día de media;
mayo–junio y agosto–septiembre > 45 %), peso de grupos alto en primavera
(mayo 1.351 RN de grupo sobre 1.517), ADR neto entre 80 y 105 € salvo enero
(133 € con 113 noches).

## 3 · Decisiones de mapeo

| Decisión | Valor | Motivo |
| --- | --- | --- |
| Historia (409 días) → `revenue_daily_snapshots` **top-level** (`roomTypeId/ratePlanId/channelId/segment/market = NULL`) | `dataSource = pms_import:opera_hf_2026-09-14` | Es lo que leen `actuals.ts realizeDays` (~214-368), el board H&F (`hf-board.service.ts` ~243-948), comparison/strategy, `forecast.service` (~283-380) y los dashboards. Solo se leen días `< hoy`; los 409 días son ≤ 2026-09-13. |
| Fidelidad al PMS en el snapshot | `totalOcc` **con** house use · `occupancyPercent` = occ % del PMS (base 92 − OOO) · `adr` = ADR del PMS · `revpar = revenue / 92` (calculado; el informe no lo trae) · `roomRevenue = netRoomRevenue = totalRevenue = revenue` · sin F&B ni GOP | Los lectores dan prioridad a `adr/occupancyPercent/revpar` del snapshot cuando no son NULL: así el board reproduce las cifras del informe de Opera, que es lo que Carmen puede cotejar. |
| Escritura | find-then-write con `TOP_LEVEL_SNAPSHOT_WHERE` (`actuals.ts` ~176-182), patrón `writeDailySnapshot` (`hf-board.service.ts` ~959-1035) | El unique de la tabla tiene dimensiones NULL y Postgres las trata como distintas: **nunca** `upsert` por el unique. |
| Forecast (48 días) → `revenue_forecasts` **top-level** | `modelVersion = pms_import:opera_hf_2026-09-14` · `confidence = 80` · `driversJson = [{driver:"adr_source", value:"pms_forecast"}]` · `expectedRoomsSold = totalOcc` (**con** house use: Σ 1.637 en BD, no las 1.586 pagadas; `mapRowToForecast`, `import-pms-history-forecast.ts` ~470) · `expectedOccupancy` = occ % PMS · `expectedAdr` = ADR PMS · `expectedRoomRevenue = expectedTotalRevenue = revenue` · `expectedRevpar = revenue / 92` | **Decisión** (cierre 2026-09-14): `expectedRoomsSold` lleva `totalOcc` con house use por coherencia con la historia, donde `totalOcc` del snapshot también lo incluye, y con el board, que recalcula `fcOccPct`/`fcAdr` sobre esa cifra; por eso el ADR que Anfitorio recalcularía (`revenue / 1.637` = 92,01) diverge del `expectedAdr` del PMS (94,97, sobre las 1.586 pagadas), que se guarda explícito y es el que muestra el board. La versión anterior de este doc y del runbook (`totalOcc − houseUse`) estaba equivocada. El board prefiere las filas top-level (`hf-board` ~386-388). `adrSourceFromDrivers(drivers, modelVersion)` (`forecast.service.ts`, lote api de esta tanda) reconoce `pms_forecast` y etiqueta el ADR como «previsión del PMS (importada)»; `generateForecasts` ya no borra ni pisa los días con `modelVersion pms_import:*` (`forecastDeleteFilter`, `skippedImported`). |
| BAR de referencia | El provisionador crea el plan `BAR` (`ratePlanType bar`, `mealPlan room_only`) **sin** `rate_days`; el importador con `--publish-bar BAR` deriva `rate_days` para los 4 tipos en `[hoy, hoy+365)`: ADR del PMS del día (forecast) → ADR del mismo día del año anterior (d−364/d−371) → media del mes, × multiplicador (IND 0,85 · DBL/DBM 1 · SUI 1,5), `updatedBy usr_system_pms_import` | El módulo revenue resuelve la BAR por `code "BAR"` o `ratePlanType "bar"` (`actuals.ts` ~379-388) y «BAR publicada» = `rate_days × tipos vendibles` (~414-440); sin ella el readiness y el forecast del motor quedan cojos. **No es el tarifario real**: hay que sustituirlo cuando dirección lo aporte (§6). |
| Series de facturación | `invoice_sequences` `FAC` prefijo **`FAC-LT-2026-`** y `REC` prefijo **`REC-LT-2026-`** (unique `propertyId+sequenceCode+year`) | Las dos propiedades facturan con el mismo NIF (org): series distintas por hotel evitan colisiones de numeración con `FAC-2026-`/`REC-2026-` de Rías Altas. |
| SES.HOSPEDAJES / VeriFactu | `sesHospedajesEnabled = false` · `verifactuEnabled = false` | No hay número de registro SES ni credenciales; VeriFactu sigue en sandbox en todo el demo. |
| Reservas | **Ninguna reserva sintética.** La recepción de Los Tilos queda vacía hasta migrar reservas reales (rooming list/OTB real del PMS) | Decisión explícita. Alternativa descartada por ahora: «generador OTB» que fabrique reservas a partir de las llegadas/ocupación del informe. Riesgos que lo descartan: contamina recepción (llegadas/salidas falsas hoy), housekeeping (tareas por check-out), partes de viajeros/SES (huéspedes inventados) y el night-audit real (`writeDailySnapshot` calcularía cierres desde reservas ficticias). Si se hace en el futuro debe ir en un script separado, con marca propia (`bookingSource`/`sourceCode` `pms_import`) y borrable por predicado. |
| Módulos | Mismos que Rías Altas: `pms_core, compliance_hub, distribution_hub, guest_experience, outlet_pos, revenue_profit_engine` habilitados; `maintenance` deshabilitado (`ensurePropertyModulePersisted`, `product-modules.service.ts` ~234-266) | Paridad de UI entre los dos hoteles de la org. |
| Inventario | 1 edificio «Edificio principal» (`PRINCIPAL`) + 4 plantas (`P1…P4`); tipos `IND/DBL/DBM/SUI` (ids `rt_*`; en el spec `maxOccupancy` IND 1 · DBL 3 · DBM 2 · SUI 3, `baseCapacity` 1/2/2/2 = 176 plazas) con el reparto **ESTIMADO** de §1; 92 rooms con numeración determinista `planRooms` (spec `apps/api/src/scripts/specs/faranda-los-tilos.json`): `101…123, 201…223, 301…323, 401…423`; `x01`/`x02` → IND (8); `223/323/423` → SUI (3); resto impar → DBL (41), par → DBM (40); `sellable=true`, `status clean`. La numeración real se fija después con `rooms[]` explícito en el spec | `totalRooms = prisma.room.count({propertyId, sellable:true})` en board/report/variance: **tiene que dar 92** para que el revpar y el occ % base 92 cuadren. |
| Usuaria | Carmen (`cmrhw9jyb0005fyvb4ykaumyc`) → `user_property_roles` con el rol **Owner** existente (`cmrhw9jy60004fyvbjvur0uqt`, 211 permisos; los roles son por organización) + departamento `MGMT` / `user_departments` (`roleLabel owner`) | Mismo patrón que `createTenant` (`tenant-admin.service.ts` ~540-690) y `bootstrap.service.ts` (~161-215). No se crea usuaria nueva. |
| Razón social de la propiedad | `properties.legalName = null` | El emisor de facturas cae a la razón social de la org (`issuer-identity.service`: `Property.legalName ?? Organization.legalName`); Faranda no ha facilitado una razón social distinta para este hotel (NO SE INVENTA). |
| Satélites | `ensurePropertySettings` (`property_ai_settings` + `property_compliance_settings`), `property_modules`, `compliance_property_profiles` (`hotelType hotel`, `hasRestaurant/hasBar/hasEvents/hasParking/hasLaundry/hasTerrace = true`, `hasPool/hasSpa = false`, `autonomousCommunity Galicia`; upsert `compliance-center.service.ts` ~203). Los datos sin columna (4★, «Ascend Hotel Collection (Choice Hotels) · código ES105», REAT H-CO-001327 con fecha y URL de verificación, 176 plazas, teléfono, email, coordenadas, 1982/2004) van a `property_compliance_settings.configurationJson.pilotProfile` | Lo mismo que crea `createTenant`; sin ellos el readiness y la IA fallan con 500. |

## 4 · Procedimiento (ejecutado por el integrador el 2026-09-14, 21:15–21:20 CEST; salida real bajo cada comando)

Prerrequisitos: `DATABASE_URL` en `hotelos/.env`, API en marcha en :3000/:3400,
CSV en `/Users/cfernandez/anfitorio-demo/pilots/faranda-los-tilos/history-forecast-2025-08-01_2026-10-31.csv`.
Todos los comandos desde `/Users/cfernandez/anfitorio-demo/hotelos`.

```bash
# 0. Backup obligatorio (irreversible sin él)
pg_dump -Fc "$DATABASE_URL" > ../backups/hotelos-pre-tilos-$(date +%F).dump

# 1. Provisionar la propiedad (dry-run por defecto; leer el plan completo).
#    Spec: apps/api/src/scripts/specs/faranda-los-tilos.json (ruta relativa a apps/api)
corepack pnpm --filter @hotelos/api pilot:provision-property -- --spec src/scripts/specs/faranda-los-tilos.json
# Salida real (2026-09-14 21:0x CEST, dry-run):
# [pilot:provision-property] DRY-RUN (no writes) · spec src/scripts/specs/faranda-los-tilos.json · 39 ms
#   Organización: Faranda Hotels & Resorts (cmrhw9jy30002fyvb6tsdiugt)
#   Propiedad: «Faranda Los Tilos, Ascend Hotel Collection» → NUEVA (se creará)
#   Habitaciones planificadas: 92 · IND=8 · DBL=41 · DBM=40 · SUI=3 · muestra 101:IND, 102:IND, 103:DBL, 223:SUI, 323:SUI, 423:SUI
#   Escrituras previstas por tabla (15):
#   create     properties ×1 — name="Faranda Los Tilos, Ascend Hotel Collection"
#   create     user_property_roles ×1 — user=cmrhw9jyb0005fyvb4ykaumyc role=cmrhw9jy60004fyvbjvur0uqt
#   create     departments ×1 — code=MGMT
#   create     user_departments ×1 — cmrhw9jyb0005fyvb4ykaumyc→MGMT (owner)
#   create     property_modules ×6 — enabled: pms_core, compliance_hub, distribution_hub, guest_experience, outlet_pos, revenue_profit_engine
#   create     buildings ×1 — Edificio principal
#   create     floors ×4 — plantas 1, 2, 3, 4
#   create     room_types ×4 — IND ×8, DBL ×41, DBM ×40, SUI ×3
#   createMany rooms ×92 — IND=8 · DBL=41 · DBM=40 · SUI=3
#   create     rate_plans ×1 — BAR
#   create     invoice_sequences ×2 — FAC/2026 FAC-LT-2026-, REC/2026 REC-LT-2026-
#   create     compliance_property_profiles ×1
#   upsert     property_ai_settings ×1 — ensurePropertySettings (tenant-hydration)
#   upsert     property_compliance_settings ×1 — ensurePropertySettings (tenant-hydration) + ensurePropertyTaxes
#   update     property_compliance_settings ×1 — configurationJson.pilotProfile
#   Sin cambios (0):
#   (nada que saltar: propiedad nueva)
corepack pnpm --filter @hotelos/api pilot:provision-property -- --spec src/scripts/specs/faranda-los-tilos.json --apply --confirm cmrhw9jy30002fyvb6tsdiugt
# Salida real (apply, 2026-09-14 ~21:05 CEST; backup previo backups/hotelos-pre-los-tilos-20260914-210102.dump):
# [pilot:provision-property] APPLIED · spec src/scripts/specs/faranda-los-tilos.json · 158 ms · propiedad creada cmu1mifcp0000fyo1wzvq7txo «Faranda Los Tilos, Ascend Hotel Collection» · 15 escrituras (properties 1, user_property_roles 1, departments 1, user_departments 1, property_modules 6, buildings 1, floors 4, room_types 4, rooms 92, rate_plans 1, invoice_sequences 2, compliance_property_profiles 1, property_ai_settings 1, property_compliance_settings 1+1) · errores 0 · audit PROPERTY_PROVISIONED (corr_pilot_los_tilos). Post-condiciones por SELECT: rooms sellable 92 · room_types 4 · user_property_roles 1 · property_modules enabled 6 · buildings 1 · floors 4 · rate_plans 1 · invoice_sequences 2 (FAC-LT-2026-, REC-LT-2026-).

# 2. Reiniciar el API (espejos in-memory de tenants: hydrateTenantMirrors solo carga al arrancar).
#    Ejecutado: :3000 y :3400 reiniciados ~21:20 CEST tras el import (log de arranque en §4.1).
#    Aviso operativo: ejecutar los CLI con los API parados; si siguen en marcha, su tip in-memory de la
#    cadena de auditoría se bifurca respecto al audit_event que escribe el script (deuda 12(c) de CLAUDE.md).

# 3. Importar historia + forecast (dry-run por defecto). --rooms 92 = inventario con el que
#    Opera calculó el informe; --source se normaliza a pms_import:opera_hf_2026-09-14
corepack pnpm --filter @hotelos/api import:pms-history-forecast -- \
  --file /Users/cfernandez/anfitorio-demo/pilots/faranda-los-tilos/history-forecast-2025-08-01_2026-10-31.csv \
  --property cmu1mifcp0000fyo1wzvq7txo --rooms 92 \
  --source opera_hf_2026-09-14 --publish-bar BAR
# Salida real (dry-run):
# [pms:import-hf] IMPORT · DRY-RUN (nada escrito) · 57 ms
#   Propiedad: Faranda Los Tilos, Ascend Hotel Collection (cmu1mifcp0000fyo1wzvq7txo) · org cmrhw9jy30002fyvb6tsdiugt · 92 hab. vendibles en BD · --rooms 92
#   Source/batch: pms_import:opera_hf_2026-09-14 · sección both · rango 2025-08-01 → 2026-10-31
#   Fichero: /Users/cfernandez/anfitorio-demo/pilots/faranda-los-tilos/history-forecast-2025-08-01_2026-10-31.csv · sha256 852f22978ef1f55eac202c39e7a6a2f0e6a1019c5ffebea8d3dd2ad8658021e9
#   Informe:
#     history    409 filas · 2025-08-01 → 2026-09-13 · 12698 rn (11722 pagadas) · 1.139.904,23 € · ADR 97.24 · occ media 37.97 %
#     forecast    48 filas · 2026-09-14 → 2026-10-31 · 1637 rn (1586 pagadas) · 150.622,88 € · ADR 94.97 · occ media 37.44 %
#     total      457 filas · 2025-08-01 → 2026-10-31 · 14335 rn (13308 pagadas) · 1.290.527,11 € · ADR 96.97 · occ media 37.91 %
#   En BD (rango, top-level): snapshots ninguno · forecasts ninguno
#   Snapshots (history): 409 a escribir → 409 create · 0 update mismo source · 0 update night_audit 0/0 · 0 force · 0 skipped protected
#   Forecasts: 48 a escribir (2026-09-14 → 2026-10-31) · borra 0 del mismo modelVersion · 0 omitidos (pasado)
#   BAR de referencia (plan BAR cmu1mife5002ufyo12l92q79n): 1460 rate_days = 365 días × 4 tipos (IND×0.85, DBL×1, DBM×1, SUI×1.5) · horizonte 2026-09-14 → 2027-09-13
#     origen del precio base: forecast 41 · STLY d−364 312 · d−371 10 · media mes 2 · sin precio 0 · marca rate_days.updated_by = usr_system_pms_import
#     muestra: 2026-09-14=78.83 (forecast), 2026-09-15=76.15 (forecast), 2026-09-16=75.84 (forecast), 2026-09-17=82.07 (forecast), 2026-09-18=108.22 (forecast), 2026-10-01=77.35 (forecast), 2026-11-01=326.88 (stly_364), 2026-12-01=63.89 (stly_364), 2027-01-01=116.23 (stly_364), 2027-02-01=84.52 (stly_364), 2027-03-01=97.29 (stly_371), 2027-04-01=100.75 (stly_364), 2027-05-01=242.98 (stly_364), 2027-06-01=107.57 (stly_364), 2027-07-01=91.43 (stly_364), 2027-08-01=137.81 (stly_364), 2027-09-01=102.07 (stly_364)
#     NOTA: BAR derivada del ADR del PMS para que el módulo revenue tenga una BAR publicada; NO es el tarifario real.
#   AVISOS (5):
corepack pnpm --filter @hotelos/api import:pms-history-forecast -- \
  --file /Users/cfernandez/anfitorio-demo/pilots/faranda-los-tilos/history-forecast-2025-08-01_2026-10-31.csv \
  --property cmu1mifcp0000fyo1wzvq7txo --rooms 92 \
  --source opera_hf_2026-09-14 --publish-bar BAR --apply --confirm cmu1mifcp0000fyo1wzvq7txo
# Salida real (apply historia+forecast, 21:1x CEST):
# [pms:import-hf] IMPORT · APPLIED · 383 ms
#   Propiedad: Faranda Los Tilos, Ascend Hotel Collection (cmu1mifcp0000fyo1wzvq7txo) · org cmrhw9jy30002fyvb6tsdiugt · 92 hab. vendibles en BD · --rooms 92
#   Source/batch: pms_import:opera_hf_2026-09-14 · sección both · rango 2025-08-01 → 2026-10-31
#   Fichero: /Users/cfernandez/anfitorio-demo/pilots/faranda-los-tilos/history-forecast-2025-08-01_2026-10-31.csv · sha256 852f22978ef1f55eac202c39e7a6a2f0e6a1019c5ffebea8d3dd2ad8658021e9
#   Informe:
#     history    409 filas · 2025-08-01 → 2026-09-13 · 12698 rn (11722 pagadas) · 1.139.904,23 € · ADR 97.24 · occ media 37.97 %
#     forecast    48 filas · 2026-09-14 → 2026-10-31 · 1637 rn (1586 pagadas) · 150.622,88 € · ADR 94.97 · occ media 37.44 %
#     total      457 filas · 2025-08-01 → 2026-10-31 · 14335 rn (13308 pagadas) · 1.290.527,11 € · ADR 96.97 · occ media 37.91 %
# Segunda pasada «--section forecast --publish-bar BAR --apply» tras afinar deriveBarPrice (≥5 habitaciones pagadas y banda 0,6–1,8× ADR del mes):
#   BAR de referencia (plan BAR cmu1mife5002ufyo12l92q79n): 1460 rate_days = 365 días × 4 tipos (IND×0.85, DBL×1, DBM×1, SUI×1.5) · horizonte 2026-09-14 → 2027-09-13
#     origen del precio base: forecast 41 · STLY d−364 233 · d−371 31 · media mes 60 · sin precio 0 · marca rate_days.updated_by = usr_system_pms_import
#     rate_days escritos: 1460
#   Audit: aud_ba80b998 (corr_pms_import_pms_import:opera_hf_2026-09-14)
# rate_days: 1460 filas · min 9,08 (IND, día de forecast con ADR 10,68) · mediana 99,61 · max 285,95 (SUI) · DBL por mes 77–133 €.
# Tercera pasada (cierre, 21:5x CEST, API parado) tras extender la regla de representatividad (≥ 5 habitaciones pagadas y banda 0,6–1,8× del ADR del mes) TAMBIÉN a la rama forecast:
#   origen del precio base: forecast 35 (13 días de forecast no representativos → STLY/media) · STLY d−364 239 · d−371 31 · media mes 60 · sin precio 0
#   rate_days escritos: 1460 · Audit: aud_13f7e385 · min 44,06 (IND) · mediana 99,43 · max 285,95 (SUI); 2026-10-25 pasa de 10,68 (bloqueo de grupo sin tarifa) a 125,28.
# Provisionador re-aplicado en el cierre (Audit aud_a7d15b21): «update rooms ×92 — capacidad desde el tipo (maxOccupancy, standardOccupancy; solo columnas NULL)»; el dry-run posterior converge: 0 escrituras · 19 sin cambios · 0 conflictos.

# 4. Readiness (recalcular; el GET /readiness sirve la última foto)
curl -s -X POST -H "Authorization: Bearer $CARMEN_TOKEN" \
  http://localhost:3400/backoffice/properties/cmu1mifcp0000fyo1wzvq7txo/readiness/recalculate | jq '{status, blockingCount}'
# Real (2026-09-14): {"status":"ready","blockingCount":0} · 17 checks en pass. NO queda blocked: con SES y VeriFactu
# desactivados sus checks resuelven «No aplica»; al activarlos sin registro/credenciales volverán a bloquear (§1, §4.1).

# 5. Verificación del board H&F (mes cerrado y mes con corte). El payload NO tiene «.totals»: el total va en
#    rows[] con rowType "total" (junto a data / weekSubtotal / monthSubtotal); .months trae la proyección mensual.
curl -s -H "Authorization: Bearer $CARMEN_TOKEN" \
  "http://localhost:3400/revenue/properties/cmu1mifcp0000fyo1wzvq7txo/history-forecast/board?from=2026-08-01&to=2026-08-31" \
  | jq '.rows[] | select(.rowType=="total") | {roomsSold, occPct, adr, revpar, roomRevenue, arrivals, departures, ooo}'
# Real agosto 2026: roomsSold 1728 · occPct 60.59 · adr 99.73 · revpar 60.43 · roomRevenue 172338.23 · arrivals 855 · departures 847 · ooo 248
#   = informe en habitaciones (1.728 con house use), revenue y llegadas. ADR 99,73 = 172.338,23 / 1.728 (board, base con
#   house use) frente a 104,57 del PMS (sobre 1.648 pagadas); occ 60,59 % = 1.728 / (92 × 31) frente a 63,29 % del PMS
#   (base 92 − OOO). Corregido en el cierre (lote revenue, comparison.service.ts): period-metrics devuelve paidRooms
#   (1.648), houseUseRooms (80) y adr = roomRevenue / paidRooms = 104,57 (convención del PMS); roomsSold sigue siendo
#   1.728 con house use. Efectivo en :3400 al reiniciarlo (la instancia en marcha aún sirve 99,73). El board sigue
#   dando 99,73 en la fila total (§5).
curl -s -H "Authorization: Bearer $CARMEN_TOKEN" \
  "http://localhost:3400/revenue/properties/cmu1mifcp0000fyo1wzvq7txo/history-forecast/board?from=2026-09-01&to=2026-09-30" \
  | jq '(.rows[] | select(.rowType=="total") | {roomsSold, roomRevenue, fcRooms, fcRevenue}), (.months[] | select(.month=="2026-09") | {actualRevenue, forecastRevenue, projectedRevenue})'
# Real septiembre 2026 (corte 13/14): roomsSold 600 · roomRevenue 66236.67 (historia 01–13) · fcRooms 861 · fcRevenue 76729.68
#   (previsión 14–30) · months[2026-09]: actualRevenue 66236.67 + forecastRevenue 76729.68 = projectedRevenue 142966.35
#   (= total de septiembre del informe).
```

Verificación SQL (solo `SELECT`) tras el apply:

```sql
SELECT data_source, count(*), min(snapshot_date), max(snapshot_date),
       round(sum(net_room_revenue), 2) AS revenue, sum(total_occ) AS occ
FROM revenue_daily_snapshots
WHERE property_id = 'cmu1mifcp0000fyo1wzvq7txo' AND room_type_id IS NULL AND rate_plan_id IS NULL
  AND channel_id IS NULL AND segment IS NULL AND market IS NULL
GROUP BY 1;
-- esperado: pms_import:opera_hf_2026-09-14 | 409 | 2025-08-01 | 2026-09-13 | 1139904.23 | 12698

SELECT model_version, count(*), round(sum(expected_room_revenue), 2), sum(expected_rooms_sold)
FROM revenue_forecasts WHERE property_id = 'cmu1mifcp0000fyo1wzvq7txo' GROUP BY 1;
-- esperado: pms_import:opera_hf_2026-09-14 | 48 | 150622.88 | 1637
-- (expectedRoomsSold = totalOcc CON house use, decisión §3; 1.586 serían las pagadas. Verificado 2026-09-14 tras el cierre.)

SELECT count(*) FROM rooms WHERE property_id = 'cmu1mifcp0000fyo1wzvq7txo' AND sellable;   -- 92
SELECT sequence_code, prefix FROM invoice_sequences WHERE property_id = 'cmu1mifcp0000fyo1wzvq7txo';
-- FAC | FAC-LT-2026-  ·  REC | REC-LT-2026-
```

Estado: **ejecutado** el 2026-09-14 por el integrador — provisión a las
21:15:57 CEST (`audit_events` `aud_321d4e0b`, `PROPERTY_PROVISIONED`,
`corr_pilot_los_tilos`), import 21:16–21:20 CEST (`aud_c26df67f`,
`aud_7f98471b`, `aud_ba80b998`, `PMS_HISTORY_FORECAST_IMPORTED`), reinicio de
:3000/:3400 ~21:20 CEST. Los SELECT de arriba, repetidos tras el cierre del
mismo día, devuelven exactamente lo esperado (409 · 1.139.904,23 · 12.698 ·
48 · 150.622,88 · 1.637 · rooms 92 · FAC-LT-2026- / REC-LT-2026-).

### 4.1 · Resultado de la verificación (2026-09-14, :3400 con la sesión de Carmen)

- `GET /properties` → 2 propiedades: «Faranda Los Tilos, Ascend Hotel Collection» (Teo) y «Hotel Faranda Rías Altas by Ascend Collection».
- `POST /backoffice/properties/cmu1mifcp0000fyo1wzvq7txo/readiness/recalculate` → `status: ready`, `blockingCount: 0`, 17 checks en `pass`: 10 comprobados de verdad (razón social y NIF del emisor, dirección fiscal completa, zona horaria, región fiscal IVA con tipos vigentes, edificio activo, 4 tipos, 92 habitaciones vendibles, usuario activo, `invoice_series_current_year` «Serie de facturas completas del ejercicio 2026 disponible») y 7 que pasan por «No aplica» o son informativos: `invoice_sequence_configured` pasa por «No aplica: el módulo de facturación y cumplimiento no está activado y el establecimiento no ha emitido facturas» (`backoffice.service.ts` ~3545; **no** por las series FAC/REC), Payment Vault no activado, SES.HOSPEDAJES desactivado (×2), VeriFactu desactivado, IPSI (solo Ceuta y Melilla) y certificado AEAT en stub (sandbox). Es `ready` **porque** SES/VeriFactu están desactivados y facturación/Payment Vault «no aplican»: al activarlos sin registro ni credenciales volverán a bloquear (§1).
- Board `GET /revenue/properties/cmu1mifcp0000fyo1wzvq7txo/history-forecast/board?from=2026-09-01&to=2026-10-31` → `totalRooms 92`, `sources.history = snapshots`, `sources.forecast = pms_import:opera_hf_2026-09-14`, `sources.forecastAdr = previsión del PMS (importada)`, `forecastMissing false`, `budgetMissing true`; fila 2026-09-13 (último día de historia): 58 hab · 65,48 % · ADR 106,33 · 5.848,37 € · 35 llegadas · 35 salidas · 8 OOO (= informe); fila 2026-09-14 (primer día de previsión): fcRooms 47 · fcRevenue 3.547,56 · fcConfidence 80 (fcOccPct 51,09 y fcAdr 75,48 recalculados por el board sobre 92 habitaciones y sobre las 47 ocupadas: el PMS da 51,14 % y 78,83 € porque descuenta OOO y house use — divergencia documentada en §5); mes 2026-09: actual 66.236,67 + previsión 76.729,68 = proyectado **142.966,35 €** (= total de septiembre del informe), LY 124.006,45; mes 2026-10: previsión 73.893,20 (= informe), LY 112.466,12.
- `GET …/period-metrics?from=2026-08-01&to=2026-08-31` → 31 días de snapshot, 1.728 room-nights (incluye house use), 172.338,23 €, ADR 99,73 (el informe da 104,57 sobre 1.648 habitaciones pagadas: misma divergencia de base), 63,16 %. Corregido en el cierre (lote revenue, `comparison.service.ts`): `PeriodMetrics` incorpora `paidRooms` (= `totalOcc − houseUseRooms`, 1.648 en agosto) y `houseUseRooms` (80), y `adr` pasa a ser `roomRevenue / paidRooms` (104,57, convención del PMS) mientras `roomsSold` sigue siendo 1.728; la instancia :3400 en marcha devuelve 99,73 hasta que se reinicie con el código del cierre.
- `GET …/forecast` → 48 filas `modelVersion pms_import:opera_hf_2026-09-14`, `adrSource pms_forecast`.
- Arranque del API :3000 tras el import: `[revenue:daily-snapshot] 2/4 propiedades omitidas: 2 sin reservas (prop_canary, cmu1mifcp0000fyo1wzvq7txo)` → el cierre nocturno ya no escribe ceros sobre Los Tilos.
- `demo:refresh` (dry-run) tras el alta: 0 grupos de borrado, nada planificado sobre Los Tilos.
- Board agosto/septiembre por curl (forma real del payload y cifras): ver §4 paso 5.

### 4.2 · Hallazgos de la verificación adversarial (front y API) y su estado

Verificación de 2026-09-14 (40 PASS · 10 PARTIAL · 4 FAIL). Lo que afecta a
lo que Carmen ve en Los Tilos, con el estado al cierre de los lotes del mismo
día (`front-admin`, `api`/`revenue`, `scripts`):

| Hallazgo | Dónde | Estado |
| --- | --- | --- |
| Centro de configuración: al Owner le salen módulos con «no access» (`ConfigurationCenterScreen.tsx` ~73 pinta «no access» cuando falta el permiso del catálogo BD, que no cubre 79 claves del manifiesto; deuda 8 de CLAUDE.md) | admin-web | corregido en el cierre (lote front-admin, 2026-09-14) |
| Readiness sin ruta propia en el sidebar: el estado `ready` solo se ve desde `/backoffice/onboarding/go-live` (`GoLiveChecklist`) y el `SetupCenterScreen` | admin-web | corregido en el cierre (lote front-admin, 2026-09-14) |
| `FirstRunWelcomeCard` (`FrontDeskDashboard.tsx` ~195/716) se muestra en Los Tilos porque la recepción no tiene reservas (`isCleanSlate`): correcto por diseño (§3 «ninguna reserva sintética»), pero el texto debe decir que la historia del PMS ya está cargada | admin-web | corregido en el cierre (lote front-admin, 2026-09-14) |
| Explorador de previsión limitado a 30 días (`RevenueForecastExplorer.tsx` `rangeFrom(30)`): no enseña octubre completo (48 días importados) | admin-web | corregido en el cierre (lote front-admin, 2026-09-14) |
| Occ % del PMS (base 92 − OOO) mostrado tal cual, sin recalcular ni acotar: en la BD ningún día supera el 100 % (máx. 98,89 % el 2025-09-27: 90 ocupadas, 2 OOO) y en 0 de 403 días con OOO `totalOcc > 92 − OOO`; si el front recalculase sobre `92 − OOO` con `totalOcc` (con house use) podría superar el 100 % | admin-web | documentado (§5 «dos bases de ocupación»); no se «corrige» el dato |
| STLY con abono negativo visible (2025-09-30 −1.570,97 € aparece como STLY del 2026-09-29): fidelidad al PMS, se muestra tal cual | admin-web | documentado (§2.3, §5) |
| `GET …/history-forecast/report` truncaba en silencio a 120 días (`Math.min(120, …)`: 2025-08-01→2026-09-13 devolvía 123 filas, no 409) | api | corregido en el cierre (lote api): `REPORT_MAX_DAYS = 120` se mantiene como ventana máxima, pero `parseReportWindow` → `parseRevenueWindow` (`actuals.ts`) responde **HTTP 400** («la ventana máxima del informe es 120 días») en vez de truncar; el informe de los 409 días se pide por tramos ≤ 120 días. Efectivo en :3400 al reiniciar |
| Fechas malformadas en `?from/?to` → 500 en la instancia en marcha (`board?from=2026-13-99` devuelve 500 el 2026-09-14) | api | corregido en el cierre (lote api): `parseRevenueWindow` devuelve 400 tipado («from debe ser una fecha YYYY-MM-DD válida», día inexistente, `to < from`, ventana > máximo). Efectivo en :3400 al reiniciar |
| `period-metrics` sin `paidRooms` ni ADR sobre pagadas (ADR 99,73 con house use frente a 104,57 del PMS) | api | corregido en el cierre (lote revenue, `comparison.service.ts`): `paidRooms`, `houseUseRooms` y `adr = roomRevenue / paidRooms` (104,57); `roomsSold` sigue con house use. Efectivo en :3400 al reiniciar |
| `expectedRoomsSold` del forecast = `totalOcc` con house use (Σ 1.637) y la documentación decía `totalOcc − houseUse` | docs | corregido en el cierre (§3, §4, runbook §3.3): se mantiene el dato, se corrige el texto |
| `pilot:provision-property --confirm` distinto → exit 1 (no 2); habitaciones casadas por `number`; sin `--help`; conflictos falsos por capacidades NULL de las habitaciones en un segundo dry-run | scripts/docs | runbook corregido; lote scripts: `--help`/`-h` en los dos CLI (gana a cualquier otro flag, salida 0) y `capacityFill` (relleno solo de capacidades NULL, nunca sobrescribe → `update rooms ×92`, 0 conflictos) |

## 5 · Intocables y riesgos

- **Scheduler nocturno** (`server.ts` ~8635-8656): al arrancar y cada 24 h,
  `writeYesterdayDailySnapshotsForAllProperties` → `writeDailySnapshot`
  reescribe la fila top-level de **ayer** desde las reservas reales con
  `dataSource night_audit` **sin mirar el dataSource existente** (`hf-board`
  ~1017-1033, código en HEAD). Con Los Tilos sin reservas, el primer
  reinicio tras la importación pisaría el snapshot del 2026-09-13 con 0
  ocupación. El lote api de esta tanda (diff sin commit) añade
  `decideSnapshotWrite`: propiedad sin reservas → `skipped no_reservations`;
  fila con `dataSource ≠ night_audit` → `skipped protected` salvo `force`.
  **Verificar en el log del primer arranque** (`[revenue:daily-snapshot] …
  sin reservas (cmu1mifcp0000fyo1wzvq7txo)`) y por SELECT que el 2026-09-13 sigue con
  `pms_import:*`.
- **`generateForecasts`** (`forecast.service.ts` ~113-210) hace `deleteMany`
  de **todas** las filas del rango antes de reinsertar (~186). Si alguien
  pulsa «regenerar forecast» en Los Tilos sobre 2026-09-14 → 2026-10-31, borra
  el forecast del PMS. El lote api de esta tanda (diff sin commit) excluye
  `modelVersion pms_import:*` del borrado (`forecastDeleteFilter`) y no
  escribe su curva en esos días (`skippedImported`); hasta que esté
  desplegado, **no regenerar** forecasts en Los Tilos. La reversión es
  `import:pms-history-forecast --revert --source …` + re-import.
- **`backfill:snapshots`** protege `dataSource ≠ night_audit` salvo `--force`
  (`backfill-snapshots.ts` ~120-124) y, con el lote api, salta propiedades
  sin reservas (`skippedNoReservations`): nunca `--force` sobre Los Tilos.
- **`demo:refresh --scope faranda`** limpia residuos AUDIT de la **org**
  Faranda por predicados (nombre/marca AUDIT): Los Tilos no lleva marcas
  AUDIT, pero conviene comprobar el dry-run antes del próximo `--apply` (que
  no liste snapshots ni forecasts de la propiedad nueva).
- **Orden alfabético en `GET /properties`**: «Faranda Los Tilos, Ascend Hotel
  Collection» se ordena antes que «Hotel Faranda Rías Altas by Ascend
  Collection»; cualquier pantalla o test que asuma «la primera propiedad =
  Rías Altas» cambia de objetivo.
- **JWT fijado a la primera propiedad**: la sesión de Carmen se emite con la
  propiedad por defecto; tras el alta hay que comprobar con qué propiedad
  arranca su sesión y que el selector de propiedad muestra las dos (la lista
  viene de `user_property_roles`).
- **Dos bases de ocupación**: el PMS calcula occ % sobre `92 − OOO`; Anfitorio
  calcula sobre `totalRooms = 92` cuando el snapshot no trae
  `occupancyPercent`. Al importar el occ % del PMS, el board muestra la cifra
  de Opera, pero cualquier KPI que recalcule desde `totalOcc / 92` (portfolio,
  variance) dará un número **más bajo** en los meses con OOO alto (enero 2026:
  5,75 % PMS vs 4,0 % base 92 sobre RN pagadas y 5,1 % base 92 sobre totalOcc con house use). Documentar en
  la demo a Carmen, no «corregir» los datos.
- `totalOcc` importado incluye house use (fidelidad al PMS): el ADR
  `revenue/totalOcc` recalculado por Anfitorio sería ligeramente inferior al
  del PMS; por eso el snapshot lleva el `adr` del PMS explícito.
- Los 3 días de revenue negativo se importan tal cual: no filtrar ni
  «arreglar».
- Cadena de auditoría global (`audit_events` / `event_stream`): los scripts
  hidratan la cadena desde Postgres antes de `recordAuditEvent` y hacen
  `flushAuditQueues` al final; no ejecutar dos `--apply` en paralelo.

## 6 · Datos pendientes de Carmen / dirección de Los Tilos

| # | Dato | Para qué | Estado hoy |
| --- | --- | --- | --- |
| 1 | **Rooming real**: habitaciones por tipo, por planta y numeración real (¿triples?) | Sustituir el reparto ESTIMADO 8/41/40/3 y la numeración determinista `101…423` (`rooms.number`; el `roomCode` generado es `RM101…RM423`, SELECT 2026-09-14: `101|RM101`, `102|RM102`, `103|RM103`) por los números reales antes de migrar reservas | ESTIMADO |
| 2 | **Tarifario BAR** vigente (por tipo y temporada) y planes derivados (NR, B&B) | Reemplazar la BAR de referencia derivada del ADR | derivada del ADR |
| 3 | **Nº de registro SES.HOSPEDAJES** y credenciales del establecimiento | Activar `sesHospedajesEnabled` y desbloquear el readiness | desconocido |
| 4 | **NIF / razón social** con la que factura Los Tilos, si es distinta de la de la org (Faranda Hotels & Resorts, NIF ficticio B99999997) | Emisor de facturas y VeriFactu; podría requerir una org separada | ficticio compartido |
| 5 | **Presupuestos 2026** (RN, revenue, ADR por mes) | Módulo de variance / budgets | no disponible |
| 6 | **Parking**: ¿de pago? tarifa y IVA | Centro de ingresos / POS | existencia confirmada, tarifa no |
| 7 | Nombres y aforos de las salas; horario y aforo del restaurante «Panzzoni» | Eventos / outlets | secundario |
| 8 | Reservas reales OTB (rooming list) desde 2026-09-14 | Recepción y night-audit real; hasta entonces recepción vacía | no migradas (decisión §3) |

## 7 · Discrepancias detectadas en Rías Altas (propuesta para César; NO ejecutada)

Al verificar Los Tilos en el REAT aparece también la ficha oficial de Rías
Altas (**H-CO-000713**, `reat_faranda_galicia.csv`), que no coincide con lo
que hay en el demo:

| Dato | Demo hoy (`properties` `cmrhw9jy40003fyvbuu2ec2w7`, SELECT 2026-09-14) | REAT oficial (H-CO-000713) |
| --- | --- | --- |
| Categoría | (sin campo; la demo la presenta como 4★) | **3 estrellas** |
| Habitaciones | **120** rooms vendibles (DBL 60 + DSV 30 + JSU 15 + IND 10 + SRA 5) | **103 habitaciones · 196 plazas** (OTAs: 103-104; ninguna fuente dice 120) |
| Dirección | «Paseo Marítimo, 1» (fijada por `demo:fix-identity`) | **Avenida de las Américas nº 57** |
| CP / municipio / INE | 15172 · Perillo (Oleiros) · 15058 | 15172 · Oleiros · 15058 (coincide) |
| Teléfono / email | — | 981 635 300 · reservas.riasaltas@farandahotels.com |
| Nombre | «Hotel Faranda Rías Altas by Ascend Collection» | «HOTEL FARANDA RÍAS ALTAS» (REAT) · Choice ES104 |

Propuesta (decisión de César, sin ejecutar en este lote): corregir la
dirección a «Avenida de las Américas, 57» (ampliar `IDENTITY_TARGETS` de
`fix-demo-legal-identity.ts`, que hoy escribe «Paseo Marítimo, 1»), añadir
teléfono/email de reservas si el modelo los admite, y **no** tocar el
inventario de 120 habitaciones mientras existan reservas y snapshots demo
sobre él (`demo:refresh` nunca re-tipa habitaciones con reservas); anotar la
diferencia 120 vs 103 en la demo como «inventario de demostración». La
categoría no tiene campo en `Property`.
