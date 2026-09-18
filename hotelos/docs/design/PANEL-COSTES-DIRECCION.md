# Dirección · Panel de costes — habitaciones, A&B, laboral, generales y resultado con KPIs USALI

Diseño del **Panel de costes de dirección** para el encargo de César (2026-09-18): «diseñar un panel de costes tanto de alimentación, como de ocupación de una habitación, como generales, laborales, utilizando los KPIs y ratios estándar en la industria; para implementarlo a nivel de director». Fecha: 2026-09-18. Documento de diseño (sin código): parte del libro diario PGC Pymes hotelero por centro (Tanda 6b), del USALI por centro de coste (Tanda 6c), de la importación Sage 200 (Tanda 7c) y del Dashboard del director, y define lo que falta (materialización de KPIs, presupuesto de costes, umbrales, benchmarks, consumos, cubiertos). Los lotes L0-L6 de §9 lo implementan; §12 registra la crítica de completitud (2026-09-18) con las correcciones aplicadas y los huecos abiertos. Se apoya en `docs/design/FINANZAS-COSTE-PERSONAL.md` (coste de personal, `salesSource`), `FINANZAS-ESTRUCTURA-SOCIETARIA.md` (ámbito R11), `FINANZAS-IMPORTACION-SAGE200.md`, `RRHH-PLANTILLA-NOMINA.md` (`LaborBudget`, KPIs laborales), `RBAC-DEPARTAMENTOS.md` y `COCOA-22.md`.

Leyenda: **[V]** verificado (código leído con fichero:línea, `SELECT` sobre la BD local de Faranda con la regla de lectura de los estados, o fuente pública leída con año) · **[S]** supuesto o decisión de diseño pendiente de confirmar con César.

Fuentes de trabajo: `apps/api/src/modules/financial-statements/{source.ts, usali.service.ts, money.ts, allocation.service.ts, financial-statements.routes.ts, route-permissions.partial.ts}`, `apps/api/src/modules/accounting/chart-of-accounts.service.ts`, `apps/api/src/modules/payroll/{cost-report.service.ts, cost-import.posting.ts}`, `apps/api/src/modules/dashboards/{general-manager, energy, housekeeping, pos}.service.ts`, `apps/api/src/lib/{degraded.ts, finance-scope.ts, rbac-scope.ts, env.ts}`, `apps/api/src/server.ts`, `packages/database/prisma/schema.prisma`, `packages/shared/src/{permissions.ts, financial-statements-types.ts, payroll-cost-types.ts}`, `apps/admin-web/src/screens/{operations/GeneralManagerScreen.tsx, finance/UsaliScreen.tsx}`, `apps/admin-web/src/components/cocoa/{CocoaKpi, CocoaChart, CocoaTable}.tsx`, `apps/admin-web/src/components/cocoa-extras/DegradedValue.tsx`, `docs/runbooks/finanzas-contabilidad.md` (§8, §13, §14, §18, §19), y la BD local (org Faranda `cmrhw9jy30002fyvb6tsdiugt`: 7 hoteles AS/FN/LL/LT/MC/PG/RA + oficina OC).

---

## §1 · Resumen y objetivo

1. **Qué pide César.** Un panel único de costes para el director de hotel (su centro), el director de operaciones (su grupo de hoteles) y la dirección general (toda la sociedad), con los ratios estándar del sector: coste por habitación ocupada (CPOR) y sus conceptos, food cost y beverage cost, coste laboral por departamento, gastos no distribuidos, GOP/GOPPAR/EBITDA y flow-through, comparados con presupuesto, año anterior, los otros hoteles de Faranda y benchmarks externos.
2. **De dónde sale hoy la verdad.** El libro diario con centro de coste USALI es la única fuente con volumen real: 3.990 asientos normales Sage 2025-01-01..2026-07-31 (+416 reversados en pareja; los 2 de apertura, 1 de regularización y 1 de cierre quedan fuera de la regla de movimientos), 48 asientos de coste de personal 2026-01-31..2026-08-31 y 11 asientos de saldos 2024 [V SQL]. `computeUsaliPnl` ya calcula por departamento ingresos, coste de ventas, personal, otros gastos y beneficio departamental, no distribuidos, GOP, EBITDA y ratios PAR/POR (`usali.service.ts:130-335`) [V]. El informe de coste de personal ya calcula coste por empleado, por habitación disponible y % s/ ventas con `salesSource` (`cost-report.service.ts:189-210`) [V].
3. **Lo que falla para un panel de director.** (a) Las habitaciones ocupadas del USALI salen de `reservations` (`source.ts:511-532`), vacías en Faranda salvo RA sept-2026 → ocupación «0,00 %» falsa (`usali.service.ts:317` + `money.ts:31-43`: `pct()` devuelve «0.00» con numerador 0 y denominador > 0) y todo POR nulo [V]; (b) no hay presupuesto de costes (`Budget` solo tiene habitaciones vendidas, ocupación, ADR e ingreso de habitaciones, `schema.prisma:1252`) [V]; (c) no hay umbrales, semáforos ni alertas de coste persistidas (`AnomalyEvent` solo lo escribe el seed, 2 filas) [V]; (d) no hay consumos (kWh, m³), cubiertos ni inventario F&B (tablas a 0) [V]; (e) el GOPPAR «proxy» del Dashboard del director se calcula con fichajes y comisiones que en Faranda no existen (`general-manager.service.ts:37-43, 432-477`) [V].
4. **Decisión central: el panel lee el libro, no el PMS.** Cada KPI se calcula sobre `journal_lines ⋈ journal_entries ⋈ accounts ⋈ cost_centers` con la regla única de lectura (`status <> 'draft'`, sin parejas de reverso, sin regularización/cierre/apertura; `source.ts:409-419`) y declara **fuente, ventana y grado de cobertura**: `ledger` (al céntimo), `estimated` (numerador o denominador de otra fuente, declarada) o `none` (sin datos, «—»). Nunca un 0 inventado [S, patrón de honestidad del Dashboard del director y de la Tanda 6c].
5. **Enrutado real por centro de coste en Faranda: los KPI «por cuenta» no salen de los departamentos de la `UsaliPnl`** [V SQL]. Sage asigna `departamento` a todas las líneas 6xx desde 2025-01: 628.1/628.2/628.3 y 622/622.1 llevan cc `POM` (MANT), 629.1 lleva `SALES_MARKETING` (COM), 628.4/629.3/6230/629.5 llevan `ADMIN_GENERAL` (ADM) y 629.2/629.4 `ROOMS` (HAB). Como `routeByCostCentre` (`usali.service.ts:96-106`) reenruta `other_expense` al departamento del cc, el `computeUsaliPnl` de Faranda muestra **suministros dentro de POM** (2025: `pom.other_expense` 1.240.426,54 € = 622 + 622.1 + 628.1-3), **comisiones de canal dentro de S&M** (`sales_marketing.other_expense` 1.152.357,17 € = 627 + 629.1), **IT y 6230 dentro de A&G** (`admin_general.other_expense` 149.204,48 €) y los departamentos `utilities` e `it` a 0. GOP y EBITDA no cambian (11.563.641,06 € por ambas vías), pero sí el beneficio departamental de Habitaciones (75,4 % por cuenta con 629.1 y 6230 en Habitaciones, como USALI Sch. 1, frente a 81,0 % en `departmentalProfit`) y los no distribuidos (4.448.056,25 € = 18,6 % por cuenta frente a 5.486.184,76 € = 22,9 % en `undistributed`). Decisión: los KPI marcados **(cuenta)** en §3 (suministros, IT, comisiones, CPOR y margen del dpto. Habitaciones, A&G/S&M/POM «por cuenta») se calculan agregando `accountBalances({ byCostCentre: true })` por prefijo de cuenta **sin** reenrutar; `computeUsaliPnl` alimenta GOP, EBITDA, `totalLabor`, personal por departamento (640/642 sí llevan su cc real) y la vista «USALI por cc» que ya pinta `UsaliScreen`. Pendiente para César/Tanda 7c: dejar sin `departamento` los 628.x/629.1/628.4/629.3 en `ledger_analytics_maps` (gana la cuenta) o aceptar la vista Sage; hasta entonces el panel muestra ambas cifras donde difieren [S decisión].
6. **Habitaciones ocupadas: un resolutor con precedencia declarada.** `revenue_daily_snapshots` de primer nivel (`data_source` `night_audit` o `pms_import:*`) → `reservations` (regla actual) → `rooms_occupied` declarado por importación (nuevo) → sin datos. Hoy solo LT tiene noches reales (12.698 rn en 409 días, OPERA H&F) y RA noches `demo` (36.974 rn, 430 días) más 49 rn `night_audit` (64 días) [V SQL]; AS/FN/LL/MC/PG no tienen ninguna → sus KPIs POR nacen «sin datos» hasta cargar el H&F de OPERA (§10).
7. **Materialización, no cálculo al vuelo.** Un snapshot por (centro, ventana, periodo, KPI) — `CostKpiSnapshot` — recalculado por scheduler cada noche y tras cada contabilización relevante; el panel lee snapshots y solo recalcula al vuelo el detalle (drill a cuenta, asiento y factura). Evita repetir 40 lecturas del libro por pantalla y deja un histórico auditable de lo que vio el director cada día [S].
8. **Presupuesto de costes = una tabla, tres consumidores.** `CostBudget` por centro × mes × departamento × línea USALI (importe, FTE y horas opcionales). Las líneas `labor` son el `LaborBudget` que RRHH §4 solo diseñó (`RRHH-PLANTILLA-NOMINA.md:141`); la línea `rooms.revenue` se deriva de `Budget.budgetedRoomRevenue` para no tener dos presupuestos de ingreso de habitaciones; el H&F board sigue leyendo `Budget` [S].
9. **Comparativos y semáforos con el patrón de la industria** (real vs presupuesto vs año anterior, mes y YTD; hotel vs grupo; benchmark por categoría) y umbrales por hotel (`warnPct` 3 / `riskPct` 8, espejo del H&F board `hf-board.service.ts:861-864`) [V patrón, S valores].
10. **Permisos.** Lectura `accounting.reports.read` (director de hotel: rol `manager`, N3, su centro), grupo por asignación `property_group` (`operations_director`, N4) y sociedad con `accounting.entity.read` (`general_manager`, N5) — todo verificado en `packages/shared/src/permissions.ts` [V]. Escritura de presupuesto y umbrales `accounting.configure`; exportación `analytics.export`.
11. **Entregables.** Motor puro `cost-kpis.ts` + servicio de snapshots + scheduler; `CostBudget` con importador CSV (preview → apply, patrón `cost-import.parser`); rutas `/accounting/cost-panel*` y `/accounting/cost-budgets*`; pestaña «Costes» en Dirección (`/hoy/direccion/costes`) y en Informes (`/informes/costes`); alertas en `AnomalyEvent` + plantilla `cost_kpi_alert`; runbook §20.

### 1.1 Alternativas descartadas

| Alternativa | Por qué se descarta | Conf. |
|---|---|---|
| Calcular el panel desde FolioLine/POS/TimeClock como el GOPPAR proxy del director | Sin datos en Faranda (0 fichajes, 1 comanda TPV, 0 devengos de comisión); «Ingresos hoy» excluye ventas TPV cash/card sin FolioLine; nunca cuadraría con el PyG | V `general-manager.service.ts:37-43`, SQL |
| Ampliar `Budget` con columnas de coste | `Budget` es por propiedad × mes sin departamento ni `organizationId` (`schema.prisma:1252-1265`); un presupuesto USALI necesita 12 departamentos × 4 líneas × versión | V |
| Calcular cada KPI al vuelo en la ruta | Diez lecturas del libro por hotel y periodo, sin histórico de lo mostrado ni base para alertas nocturnas; el USALI ya tarda por su SQL por centro de coste | S |
| Tomar `rooms_available_reported` del informe RRHH como denominador PAR | Difiere del inventario activo (AS 78 vs 53-57, RA 120 vs 95) y solo existe 2026-01..08 en 5 centros; el USALI usa `rooms.active` (`source.ts:513`) | V SQL |
| Ventas de referencia RRHH como denominador de todos los «% s/ ventas» | Solo 40 celdas de 2026; en LT el 705.1 de Sage es 2,3× la referencia (2026-04: 144.379,96 vs 62.948,78) | V SQL |
| Alertas como tabla nueva `CostAlert` | `AnomalyEvent` ya tiene organización, propiedad, `metricCode`, severidad y estado y lo leen el centro analítico y la IA | V `schema.prisma:2134` |

---

## §2 · Investigación

### 2.1 USALI 12ª edición (vigente desde el 1-ene-2026)

- Cascada del Estado Resumen de Operaciones: ingresos de departamentos operados (Habitaciones, A&B, Otros departamentos, Ingresos varios) → gastos departamentales (coste de ventas + personal + otros) → beneficio departamental total → gastos no distribuidos (A&G, IT&S, Ventas y marketing, POM y **Energía, agua y residuos**, Schedule 9, antes Utilities) → GOP → honorarios de gestión → no operativos (alquileres, tributos, seguros, otros) → EBITDA → reserva FF&E → EBITDA menos reserva [V deck DeFranco/IAHFME 2024; guía Hospitality Finance Network].
- Columnas estándar: mes actual y acumulado del año, cada uno con real / presupuesto / año anterior en importe y % [V AECA, USALI 11 vía ResearchGate].
- Bases de ratio: gastos de departamentos operados en % del ingreso **del propio departamento** y por habitación ocupada (POR) para variables; no distribuidos en % del ingreso **total** y por habitación disponible (PAR); personal en POR (habitaciones), por cliente (A&B), PAR y % ingreso [V HotStats citando USALI 11].
- Novedades relevantes: Schedule 15 «Payroll FTE» obligatorio (horas y FTE por departamento, management/no-management, mes y YTD, con año anterior y presupuesto; semana estándar declarada en cabecera) [V blog HFTP 2024]; Schedule 9 EWW con coste €/kWh, €/m³, €/kg y consumo kWh/m², agua m³ POR y PAR, residuos kg POR y PAR [V deck IAHFME]; Parte V: horas y salarios de horas extra, cargas sociales % de salarios, salario medio por hora, ingreso A&B por hora trabajada [V]; Schedule 16 costes obligatorios de marca/operador (anual, no benchmarkable) [V]. La fórmula literal de FTE y las nueve fórmulas laborales solo están en el libro de pago; divisor español ≈ jornada de convenio 1.780-1.800 h en vez de 2.000 h [S].

### 2.2 Fórmulas de referencia

| KPI | Fórmula | Fuente |
|---|---|---|
| CPOR total | gastos operativos totales ÷ habitaciones ocupadas | Duetto/HotStats 2026 [V] |
| CPOR de habitaciones | gastos del dpto. Habitaciones (pisos, amenities, lavandería, recepción) ÷ habitaciones vendidas | Lighthouse [V] |
| Labor CPOR / HPOR / MPOR | coste laboral ÷ hab. ocupadas; horas ÷ hab. ocupadas; minutos por habitación limpia | HotelData/Actabl 2025 [V] |
| Food cost % · Beverage cost % | coste de ventas de comida (bebida) ÷ ingreso de comida (bebida); real por inventario = (inv. inicial + compras − inv. final) ÷ ventas; teórico = Σ escandallo × mix | HotStats; Talent Hostelería [V] |
| Ticket medio (average check) | ingreso F&B ÷ nº de clientes (USALI 11 sustituyó «cover» por «customer») | HotStats [V] |
| Margen departamental | beneficio dpto. ÷ ingreso dpto. | estructura USALI [V] |
| GOP % · GOPPAR · TRevPAR | GOP ÷ ingreso total; GOP ÷ hab. disponibles; ingreso total ÷ hab. disponibles | Lighthouse/STR [V] |
| Flow-through · Flex | ΔGOP ÷ ΔIngreso (vs presupuesto o periodo anterior); flex = 1 − flow-through cuando cae el ingreso; signos mixtos por casos | DeFranco/Miller/Lund, Hospitality Net [V] |
| Reserva FF&E | 3-5 % del ingreso total en contratos europeos; 4-5 % estándar HVS | HVS [V] |
| EWW | €/kWh, €/m³, €/kg; kWh/m², m³ POR/PAR, kg POR/PAR | USALI 12 Sch. 9 [V] |

### 2.3 Benchmarks (categoría, mercado, año)

| Indicador | Valor | Ámbito · año | Fuente | Conf. |
|---|---|---|---|---|
| Margen GOP | 41,0 % · urbano 32-34 % · resort 42-45 % · MICE 33-35 % | España YTD nov-2025 | HotStats; Hosteltur | V |
| Margen GOP | 35,7 % (GOP 69,3 € PAR) | Europa FY2025 | HotStats | V |
| Margen dpto. Habitaciones · A&B | 72,0 % · 21,0 % | España YTD nov-2025 | HotStats | V |
| Personal % ingreso total | «≈30 % de ingresos y 40 % de gastos» | global 2024 | HFTP | V |
| Personal PAR | 60,5 € PAR (+5,7 %) ≈ 31-32 % del ingreso | Europa FY2025 | HotStats (derivado) | V / S |
| Personal % ingreso total | 32,4 % (2023); +4,8 % (2024) | EE.UU. | CBRE Trends | V |
| Subida nómina por dpto. | pisos +7 %, cocina +12 %, recepción +5 %, total +4 % | España 2025 | HotStats | V |
| Labor CPOR · HPOR · minutos camarera | 48,32 $ · 2,11 h · 24,67 min (2025); 46,79 $ · 2,105 h (1T-2026) | EE.UU. | HotelData/Actabl | V |
| Utilities | 5,0 € PAR (pico 7,0 € en 2023) | España YTD nov-2025 | HotStats | V |
| Utilities | 3,3 % ingreso; 2.478 $ PAR/año; 9,68 $ POR | EE.UU. 2023-24 | CBRE | V |
| S&M · comisiones tarjeta | 3,6 € PAR · 2,7 € PAR | España 2025 | HotStats | V |
| POM · no distribuidos | ≈4 % ingreso (personal 50 % del dpto.) · 24,6 % ingreso | EE.UU. 2015-19 · 2018 | CBRE | V |
| F&B dpto. | margen 29,1 %; gasto = personal 59,4 % / coste ventas 24,0 % / otros 16,6 % | EE.UU. H1-2025 | CBRE | V |
| Food cost · beverage cost · prime cost | 28-35 % · 18-24 % · 55-65 %; desayuno buffet 25-35 % del PVP; España: restaurante tradicional 28-32 % (alerta >36 %), cafetería/desayunos 15-22 % (>28 %) | restauración (no hotel 2-4★) | Whipplewood/Vanta (28-35 %), Backbar/Provi (18-24 %), KitchenNmbrs (desayuno), Talent Hostelería (España) | S |
| Coste desayuno buffet | 1,79 €/pax = 25,8 % (ejemplo didáctico); 4,50 €/pax media España (vendor) | España | AS Gestión; Miselup | V / S |
| Energía kWh POR · kWh/m² · agua L POR · kgCO2e POR | 2★ 18,3 · 105 · 210 · 3,4 — 3★ 23,5 · 143 · 255 · 4,3 — 4★ 48,7 · 203 · 301 · 9,2; Madrid no-resort 36,8 kWh POR; Bilbao 23,1 (n≤7) | España, datos 2023 | Cornell/Greenview CHSB 2025 (Excel) | V |
| Empleados por habitación | 3★ 0,28 · 4★ 0,37 (2024); A Coruña 0,21 · Asturias 0,25 · Cantabria 0,28 · Madrid 0,27 (2025) | España | INE vía Hosteltur | V |
| Coste laboral por empleado | 32.949 €/año alojamiento (+5,0 %) | España 2025 | INE | V |
| Absentismo | alojamiento 9,32 % | España 1T-2026 | Adecco Institute | V |
| Flow-through · flex | 50-60 % · 30-35 %; objetivo Lund: subida por tarifa 90 %/85 %, por ocupación 85 %/80 % | sector | Hospitality Net | V |
| RevPAR urbano | A Coruña 45,9 € · Santiago 59,0 € · Oviedo 48,3 € · Madrid 116,1 € | España 2024 | Exceltur | V |

Huecos de la investigación: HotStats no publica en abierto nómina por departamento ni A&G/IT/S&M/POM en % para España; CHSB no tiene Galicia/Asturias/Cantabria (usar España 2★/3★/4★ y Bilbao orientativo; ya existe CHSB 2026 con datos 2024 sin consultar); food/beverage cost específicos de hotel español inexistentes; mapeo oficial PGC→USALI inexistente en España (solo AECA 2005).

### 2.4 Control de costes F&B

- Food cost **real** por inventario y **teórico** por escandallo × mix, con desviación en puntos (best-in-class ≤1-2 pts, alerta >3-5 pts) [V Restaurant365, Talent]; objetivos por servicio: restaurante 28-32 % (alerta >36 %), cafetería/desayunos 15-22 % (>28 %), menú del día 30-36 % (>40 %) [V Talent].
- Personal F&B: EE.UU. 59,4 % del gasto F&B [V CBRE]; España restauración sano 25-32 % de ventas, >35 % sostenido problema de productividad [V Dato Consulting]; medir horas trabajadas ÷ clientes servidos separando sala y cocina [V Hotel Financial Coach].
- Mermas: buffet 300 g/cliente vs 130 g a la carta; producción por ocupación y desayunos prereservados evita 15-20 % de sobrecoste [V Nutritics; S vendor]. Rotación de inventario comida 4-8 veces/mes [V].
- Desayuno incluido en tarifa: asignar un valor interno del desayuno a F&B (si no, Habitaciones queda sobrevalorado) [S, práctica de gestión].

### 2.5 Patrones de los paneles líderes (HotStats, STR/CoStar, M3, Actabl, Inn-Flow, Otelier, Mews)

- Estructura USALI por departamento con cada línea en tres bases (€, % ingreso, PAR/POR) y cuatro columnas comparativas (real, presupuesto, forecast, año anterior) más comp set [V HotStats compare; STR P&L].
- Tres capas temporales: flash diario (≤1 página, el GM lo «firma»), semanal (plan laboral vs real) y cierre mensual con benchmark [V Actabl, Docyt].
- Drill-down hasta factura y asiento (M3), hasta transacción (Otelier), hasta persona (Inn-Flow) [V].
- Alertas por umbral con feed y comentario «qué cambió / por qué / qué pasa ahora»; semáforo verde = alcanzable el 90 % de las veces, rojo = obligatoriamente discutido, revisión trimestral de umbrales [V Hotel Online 2026; Lynch].
- Multi-hotel: agrupaciones flexibles, contribución de cada hotel al grupo, ranking [V M3, Otelier].

---

## §3 · Catálogo de KPIs del panel

Convenciones: **RN** = habitaciones ocupadas (resolutor §5.1); **RD** = habitaciones disponibles = `rooms.active` × noches (`source.ts:513`, `usali.service.ts:232`); **Ventana** = D día · M mes · YTD · LTM (12 meses móviles); **Fuente** = módulo de ehotelOS; **Cobertura Faranda hoy** = **L** al céntimo desde el libro (2025-01..2026-07 los 7 hoteles; 2026-08 solo personal en AS/LT/MC/OC/PG/RA [V SQL]) · **E** estimado (una parte de otra fuente, declarada) · **—** sin datos. Cuentas y líneas según el mapeo por defecto de `chart-of-accounts.service.ts:341-439` (grupo 6 :341-414, grupo 7 :416-439) y el enrutado por centro de coste `routeByCostCentre` (`usali.service.ts:96-106`, solo `labor` y `other_expense`) [V]. **(cuenta)** = KPI calculado por prefijo de cuenta sin el reenrutado por cc (§1 punto 5): en Faranda 628.x, 629.1, 628.4/629.3 y 6230 llevan cc de Sage que los saca de su departamento USALI de cuenta. 622.1, 629.5 y 705.5 no están en la plantilla: son cuentas de la organización creadas por la importación Sage con `pom.other_expense`, `admin_general.other_expense` y `rooms.revenue` [V SQL].

### 3.1 Bloque Habitaciones

| KPI | Fórmula | Cuentas PGC → línea USALI | Denominador | Ventana | Fuente | Faranda hoy |
|---|---|---|---|---|---|---|
| CPOR total | (gastos dptos. operados + no distribuidos) ÷ RN | todos los 6xx por encima del GOP | RN | D M YTD LTM | libro + resolutor RN | E (LT), — resto |
| CPOR del dpto. Habitaciones **(cuenta)** | (labor ROOMS + other_expense rooms) ÷ RN | 640/642 cc ROOMS; 6230 (:362), 629.1 (:374), 629.2 (:375), 629.4 (:377), 602 (:348), 607 (:350) → `rooms.other_expense` | RN | M YTD LTM | libro por cuenta (en `computeUsaliPnl` 629.1 y 6230 salen de Habitaciones por el cc de Sage) | E (LT), — resto |
| CPOR limpieza | (labor ROOMS del grupo pisos + 629.4) ÷ RN | 640/642 cc ROOMS por `PayrollCostLine.departmentLabel` de pisos; 629.4 | RN | M | libro + lote coste personal | E (LT 2026), — |
| CPOR lavandería | 629.2 ÷ RN | 629.2 → `rooms.other_expense` (`:375`) | RN | M YTD | libro | E (LT), — |
| CPOR amenities | 602 ÷ RN | 602 → `rooms.other_expense` (`:348`); sin movimiento en Faranda | RN | M | libro | — (601.x va a F&B; 602 sin apuntes) |
| Coste laboral de pisos y de recepción POR | labor ROOMS por `departmentLabel` (pisos / recepción) ÷ RN | 640/642 cc ROOMS | RN | M YTD | lote coste personal | E (6 centros 2026) |
| Comisiones de canal % | 629.1 ÷ 705.1 | 629.1 → `rooms.other_expense` (`:374`) | ingreso hab. | M YTD LTM | libro | L (5,3-6,0 % por hotel, §10) |
| Gasto Habitaciones por RD | rooms expense ÷ RD | idem CPOR dpto. | RD | M YTD LTM | `perDepartment.expensePAR` (`usali.service.ts:248`) | L |
| Margen dpto. Habitaciones **(cuenta)** | (705.1 + 705.5 − gastos) ÷ (705.1 + 705.5) | 705.1 (:421) → `rooms.revenue`; 705.5 cuenta de la org con `rooms.revenue` [S revisar: USALI lo sitúa en Otros] | ingreso hab. | M YTD LTM | libro por cuenta; `departmentalProfit` de `computeUsaliPnl` da 81,0 % en 2025 porque 629.1 va a S&M | L (75,4 % 2025) |

### 3.2 Bloque Alimentación y bebidas

| KPI | Fórmula | Cuentas PGC → línea USALI | Denominador | Ventana | Fuente | Faranda hoy |
|---|---|---|---|---|---|---|
| Food cost % | (601.1 + 611 parte alimentos) ÷ ingreso comida | 601.1, 611 → `fnb.cost_of_sales` (`:346, 355`) | ingreso F&B (705.2 no separa comida/bebida) | M YTD LTM | libro | L combinado (39,0 % 2025), — separado |
| Beverage cost % | 601.2 ÷ ingreso bebida | 601.2 → `fnb.cost_of_sales` (`:347`) | ingreso bebida (inexistente) | M YTD | libro | E (601.2 ÷ 705.2 total) |
| Food cost real vs teórico | inventario vs Σ `MenuRecipe` × ventas TPV | `StockMovement`, `InventoryItem.unitCost`, `MenuRecipe` (`schema.prisma:1712-1771`) | ingreso comida | M | fnb-inventory + TPV | — (0 filas) |
| Coste por cubierto | coste de ventas F&B ÷ cubiertos | 601.x, 611 | cubiertos (nuevo `FnbCoverDaily`) | D M | TPV/PMS | — |
| Ticket medio por cliente | ingreso F&B ÷ cubiertos | 705.2, 705.4 | cubiertos | D M | TPV (`dashboards/pos.service.ts` hoy por comanda) | — (1 comanda) |
| Coste desayuno por pax | coste desayuno ÷ desayunos servidos | 601.1 (subcuenta desayuno [S]) | pax alojados (`revenue_daily_snapshots.adults_children`: LT 22.752 pax / 12.698 rn; RA `demo` trae 0 pax [V SQL]) | D M | libro + snapshots | E (LT) |
| Laboral F&B % | labor FNB ÷ ingreso F&B | 640/642 cc FNB | 705.2 + 705.4 | M YTD LTM | libro | L (34,8 % 2025) |
| Margen dpto. F&B | (ingreso − coste ventas − labor − otros) ÷ ingreso | `departmentalProfit` fnb | 705.2 + 705.4 | M YTD LTM | `computeUsaliPnl` | L (26,2 % 2025) |
| Ingreso F&B por hora trabajada · F&B RevPAR | ingreso F&B ÷ horas; ingreso F&B ÷ RD | 705.2 | horas (`TimeClockEntry` 0) · RD | M | RRHH L2 · `revenuePAR` | — · L |

### 3.3 Bloque Laboral

| KPI | Fórmula | Cuentas PGC → línea USALI | Denominador | Ventana | Fuente | Faranda hoy |
|---|---|---|---|---|---|---|
| Coste laboral % ingresos (total) | Σ labor ÷ ingreso operativo total | 640, 641, 642, 649 → `labor` enrutado por cc (`:385-400`) | 70x del libro; fallback referencia RRHH con `salesSource` (`cost-report.service.ts:153-158`) | M YTD LTM | `totalLabor` (`usali.service.ts:213`) + cost-report | L (31,8 % 2025) |
| Coste laboral % por departamento | labor dpto. ÷ ingreso dpto. (Habitaciones, F&B); ÷ ingreso total (no distribuidos) | idem por cc | ingreso dpto. / total | M YTD | `computeUsaliPnl` | L |
| Labor CPOR | Σ labor ÷ RN | 64x | RN | M YTD | libro + resolutor | E (LT), — |
| FTE por habitación ocupada · por 100 habitaciones | FTE ÷ RN; empleados ÷ inventario × 100 | `payroll_cost_references.employees_reported` (hoy); Schedule 15 (RRHH L2) | RN · inventario | M | lote coste personal | E (5 centros 2026), — FN/LL |
| HPOR · MPOR pisos | horas ÷ RN; minutos por habitación limpia (`HousekeepingEvent`, `housekeeping.service.ts:116-138`) | — | RN · habitaciones limpiadas | D M | fichajes (0) · HK | — |
| Coste por empleado · PAR | total ÷ headcount; total ÷ RD | 64x | headcount · RD | M YTD | `costPerEmployee`, `costPerAvailableRoom` (`cost-report.service.ts:197, 206`) | E (5 centros 2026) |
| Horas extra % · cargas sociales % salarios | horas extra ÷ horas; 642 ÷ 640 | 642 ÷ 640 | horas · 640 | M | RRHH L2 · libro | — · L (29,2 % = 551.336,97 ÷ 1.891.222,19 [V SQL]) |
| Absentismo % | horas de ausencia ÷ horas teóricas | — | horas | M | RRHH (`GET /hr/kpis`, `RRHH-PLANTILLA-NOMINA.md:169`) | — |

### 3.4 Bloque Generales y no distribuidos

| KPI | Fórmula | Cuentas PGC → línea USALI | Denominador | Ventana | Fuente | Faranda hoy |
|---|---|---|---|---|---|---|
| A&G % · PAR **(cuenta)** | (labor ADMIN_GENERAL + 626 + 629 + 629.5) ÷ ingreso total; ÷ RD | 626 (:365), 629 (:373) → `admin_general.other_expense`; 629.5 cuenta de la org (no está en la plantilla: :378 es 629.9) [V SQL] | ingreso total · RD | M YTD LTM | libro por cuenta; `undistributed` de `computeUsaliPnl` (`usali.service.ts:205-211`) añade 628.4/629.3/6230 por el cc ADM (7,2 % 2025) | L (6,6 % 2025 con OC) |
| Ventas y marketing % · PAR **(cuenta)** | (labor S&M + 627) ÷ ingreso total | 627 (`:367`) | idem | M YTD LTM | libro por cuenta; `undistributed` añade 629.1 por el cc COM (8,1 % 2025) | L (3,9 % 2025) |
| POM % · PAR **(cuenta)** | (labor POM + 622 + 622.1) ÷ ingreso total | 622 (`:359`); 622.1 cuenta de la org con `pom.other_expense` (no está en la plantilla) [V SQL] | idem | M YTD LTM | libro por cuenta; `undistributed` añade 628.1-3 por el cc MANT (7,6 % 2025) | L (3,1 % 2025) |
| IT % · PAR **(cuenta)** | (628.4 + 629.3) ÷ ingreso total | 628.4, 629.3 → `it.other_expense` (`:372, 376`) | idem | M YTD | libro por cuenta (`it` sale a 0 en `computeUsaliPnl`: cc ADM) | L (0,5 % 2025) |
| Suministros € % · PAR · POR **(cuenta)** | (628.1 + 628.2 + 628.3) ÷ ingreso total; ÷ RD; ÷ RN | 628.x → `utilities.other_expense` (`:368-371`) | ingreso total · RD · RN | M YTD LTM | libro por cuenta (`utilities` sale a 0 en `computeUsaliPnl`: cc MANT → POM) | L (4,5 % 2025; 3,19 € PAR/día) · E POR |
| Energía kWh POR · kWh/m² · €/kWh | kWh ÷ RN; kWh ÷ m²; 628.1 ÷ kWh | 628.1 | RN · m² (`Property.surfaceM2`, `schema.prisma:485`, hoy null en los 8 centros [V SQL]) · kWh (`UtilityReading` 0 o `UtilityConsumption` nuevo) | M LTM | energy.service (`:17-33`) + libro | — (0 contadores) |
| Agua m³ POR · €/m³ · residuos kg POR | m³ ÷ RN; 628.2 ÷ m³; kg ÷ RN | 628.2 | RN | M LTM | `UtilityConsumption`, `SustainabilityMetric` (0) | — |
| No distribuidos PAR | Σ no distribuidos ÷ RD | todos | RD | M YTD LTM | `undistributedPAR` (`usali.service.ts:330`) | L |

### 3.5 Bloque Resultado

| KPI | Fórmula | Líneas USALI | Denominador | Ventana | Fuente | Faranda hoy |
|---|---|---|---|---|---|---|
| GOP % | GOP ÷ ingreso operativo total | `gop` (`usali.service.ts:214`) | ingreso total | M YTD LTM | `computeUsaliPnl` | L (48,2 % 2025 sin reparto de OC) |
| GOPPAR · TRevPAR | GOP ÷ RD; ingreso total ÷ RD | `ratios.goppar`, `.trevpar` (`:324-325`) | RD | M YTD LTM | idem | L (33,99 € · 70,47 € por RD-día 2025) |
| EBITDA · % · PAR | GOP − honorarios − no operativos | `ebitda` (`:223`), `ebitdaPAR` (`:329`) | ingreso · RD | M YTD LTM | idem | L (47,7 % 2025) |
| Flow-through · flex | ΔGOP ÷ Δingreso vs presupuesto y vs LY, por departamento y GOP | `usaliDeltas` (`:347`) + `CostBudget` | Δingreso | M YTD | nuevo `flowThrough()` | E vs LY 2026/2025 (sin presupuesto) |
| Reserva FF&E teórica | 4 % × ingreso total (parametrizable) | fila informativa (`ASSET-MANAGEMENT-INMOBILIARIO.md:190`) | ingreso | M YTD | cálculo | L |
| Reparto de oficina central | −GOP de OC por clave revenue/rooms_available/headcount | `allocation.service.ts:49-59`; Faranda `configuration_json {}` → `none` [V SQL] | según clave | M YTD | `GET /accounting/allocation` | L al fijar clave |

### 3.6 Bloque No operativos (por habitación disponible)

| KPI | Fórmula | Cuentas → línea | Denominador | Ventana | Fuente | Faranda hoy |
|---|---|---|---|---|---|---|
| Alquiler PAR · % | 621 ÷ RD; ÷ ingreso | 621 → `non_operating.rent` (`:358`) | RD | M YTD LTM | libro | L (60.800,00 € 2025-26) |
| IBI y tributos PAR | 631 ÷ RD | 631 → `non_operating.property_taxes` (`:381`) | RD | YTD LTM | libro | L (41.940,00 €) |
| Seguros PAR | 625 ÷ RD | 625 → `non_operating.insurance` (`:364`) | RD | YTD LTM | libro | L (65.016,00 €) |
| Honorarios de gestión % | 623.1 ÷ ingreso | 623.1 → `management_fees` (`:361`) | ingreso | M YTD | libro | — (sin apuntes) |

### 3.7 Códigos `kpiCode` del catálogo (clave de `CostKpiSnapshot`, `CostKpiThreshold` y `CostBenchmark`)

| Bloque | `kpiCode` |
|---|---|
| Habitaciones | `rooms.cpor_total` · `rooms.cpor_dept` · `rooms.cpor_cleaning` · `rooms.cpor_laundry` · `rooms.cpor_amenities` · `rooms.labor_hk_por` · `rooms.labor_fo_por` · `rooms.channel_pct` · `rooms.expense_par` · `rooms.margin_pct` |
| A&B | `fnb.food_cost_pct` · `fnb.beverage_cost_pct` · `fnb.food_cost_theoretical_pct` · `fnb.cost_per_cover` · `fnb.avg_check` · `fnb.breakfast_cost_pax` · `fnb.labor_pct` · `fnb.margin_pct` · `fnb.revenue_per_hour` · `fnb.revenue_par` |
| Laboral | `labor.pct_revenue` · `labor.pct_<dept>` (rooms, fnb, admin_general, sales_marketing, pom, it) · `labor.cpor` · `labor.fte_por` · `labor.fte_per_100_rooms` · `labor.hpor` · `labor.mpor_hk` · `labor.cost_per_employee` · `labor.par` · `labor.overtime_pct` · `labor.ss_pct_wages` · `labor.absenteeism_pct` |
| Generales y no distribuidos | `ag.pct` · `ag.par` · `sm.pct` · `sm.par` · `pom.pct` · `pom.par` · `it.pct` · `it.par` · `utilities.pct` · `utilities.par` · `utilities.por` · `eww.kwh_por` · `eww.kwh_m2` · `eww.eur_kwh` · `eww.m3_por` · `eww.eur_m3` · `eww.waste_kg_por` · `undistributed.par` |
| Resultado | `result.gop_pct` · `result.goppar` · `result.trevpar` · `result.ebitda` · `result.ebitda_pct` · `result.ebitda_par` · `result.flow_through_budget` · `result.flow_through_ly` · `result.ffe_reserve` · `result.oc_allocation` |
| No operativos | `nonop.rent_par` · `nonop.rent_pct` · `nonop.taxes_par` · `nonop.insurance_par` · `nonop.mgmt_fees_pct` |

Regla de nombres: `<bloque>.<métrica>[_<base>]` con bases `pct` (% ingreso), `par`, `por`/`cpor`; el catálogo vive en `packages/shared/src/cost-panel-types.ts` (`COST_KPI_CODES`, `COST_KPI_LABELS_ES`, `COST_KPI_POLARITY`) y el front no inventa códigos [S].

---

## §4 · Estado actual del código y qué se reutiliza

| Módulo | Qué hace hoy | Se reutiliza para | Conf. |
|---|---|---|---|
| `financial-statements/source.ts` | Lector único del libro: `ledgerEntryCounts` (:409-411) y su SQL (:419); `accountBalances({ byCostCentre })` una fila por (cuenta, tipo cc, código cc) (:441-465); `occupancy` desde `reservations` (:511-532); `headcount` recibos → lotes de coste (:588-604) | Todas las lecturas del panel pasan por aquí; se añade el flag `byMonth` (mismo SQL + `to_char(entry_date,'YYYY-MM')`) y el resolutor de RN de §5.1, sin tocar la SQL sin flag | V |
| `financial-statements/usali.service.ts` | `routeByCostCentre` (:96-106); `computeUsaliPnl` puro (:130-335) con no distribuidos (:205-211), `totalLabor` (:213), GOP (:214), EBITDA (:223), ratios (:240-262, :322-333); `usaliDeltas` (:347); `compareUsaliProperties` (:479); `compareUsaliPeriods` (:619-640) | El motor `cost-kpis.ts` recibe una `UsaliPnl` por (centro, mes) y deriva todos los KPIs de §3; comparativos LY por `compareUsaliPeriods` | V |
| `financial-statements/money.ts` | `ratio()` null con denominador 0 (:31-36); `pct()` (:39-43) | Misma aritmética; corrección: `occupancyPct` y todo POR devuelven `null` con RN = 0 **y** fuente `none` | V |
| `accounting/chart-of-accounts.service.ts` | Mapeo por defecto cuenta → departamento/línea (:341-439) y líneas admitidas (:78-91) | Catálogo de cuentas de cada KPI (§3); `usali_mappings` de Faranda vacío → aplica la cuenta | V SQL |
| `payroll/cost-report.service.ts` | `salesSourceOf` (:153-158, umbral 0,9 `payroll-cost-types.ts:526`); `metricsOf` (:189-210); RD con inventario reportado (:348-363); ventas 70x por centro × mes (:417-439) | Bloque laboral: coste por empleado, por grupo, `salesSource`; el panel usa `rooms.active` como RD y muestra el inventario reportado como aviso | V |
| `payroll/cost-import.posting.ts` | Un asiento por (centro, mes) D 640/642 por departamento con `costCenterId` (:13-18, :130-170) | Coste laboral por departamento al céntimo; `PayrollCostLine.departmentLabel` para pisos/recepción | V |
| `accounting/import/ledger-import.posting.ts` | Sage: `delegacion` → centro, `departamento` → cc en 6/7 (:528-551) | Origen del 100 % de `other_expense` con cc (solo 681 y 626 de OC sin cc) | V SQL |
| `financial-statements/allocation.service.ts` | Reparto informativo de OC = −GOP USALI (:49-59) | KPI «reparto OC» y GOP por hotel «con/sin oficina central» | V |
| `dashboards/general-manager.service.ts` | GOPPAR proxy, coste laboral hoy por fichajes (:37-43, :432-477); `createDegradedCollector` (`lib/degraded.ts:26-43`) | Patrón `safe()` + `degraded[]`; la tarjeta «Coste laboral hoy» se sustituye por «Coste MTD vs presupuesto» del panel | V |
| `dashboards/energy.service.ts` · `esrs.service.ts` | kWh y kWh/RN desde contadores (:17-33); indicadores ESRS anuales (`ESRS_DISCLOSURES` :23-47) | Bloque EWW cuando haya lecturas o `UtilityConsumption` | V |
| `pos/*`, `fnb-inventory.service.ts` | Ticket medio por comanda (`dashboards/pos.service.ts`); consumo de stock sin `unitCost` (:266-274); sin cubiertos (`pos.schemas.ts:9-15`) | Ticket medio y food cost teórico como fuentes degradables | V |
| `revenue/{strategy, hf-board}.service.ts` | `Budget` (`server.ts:2748-2750`); estados ok/warn/risk −3 %/−8 % (`hf-board.service.ts:861-864`) | Deriva `rooms.revenue` del presupuesto; umbrales por defecto | V |
| Front `GeneralManagerScreen.tsx`, `UsaliScreen.tsx` | Canon Cocoa 22 (11 KPI, `DegradedCard`, skeleton :874-884, 12 `style=` de 25); `FinanceScopeSelector` (:54, :366), «Comparar periodos» (:111), `expensePAR` (:473) | Composición de las dos pestañas «Costes» | V |

---

## §5 · Modelo de datos y cálculo

### 5.1 Hechos de entrada y resolutores

- **Libro por (centro, mes, cuenta, cc)**: `accountBalances({ byCostCentre: true, byMonth: true })` [S flag nuevo]. Ventanas D/M/YTD/LTM se agregan sobre meses; el flash diario D solo aplica a lo que tenga asiento diario (OPERA `pms_shadow_revenue`, TPV, facturas), nunca a los lotes mensuales de Sage o nómina (se muestran «M» y se declara).
- **Habitaciones ocupadas (RN)** — `resolveOccupancy(propertyId, from, to)` devuelve `{ roomsOccupied, source: "night_audit" | "pms_import" | "pms_stays" | "declared" | "none" }` con precedencia: `revenue_daily_snapshots` de primer nivel (todas las dimensiones nulas, `data_source` `night_audit`/`pms_import:*`; `demo` solo si `ALLOW_DEMO_OCCUPANCY`) → `reservations` (regla actual `source.ts:511-532`) → `OccupancyDeclared` (nuevo, centro × mes, importado con el H&F) → `none`. `UsaliStatistics.source` deja de ser el literal `"pms_stays"` (`financial-statements-types.ts:292`) [S].
- **Habitaciones disponibles (RD)** = `rooms.active` × noches (canónico, USALI). `payroll_cost_references.rooms_available_reported` se muestra como aviso «inventario del informe RRHH difiere un N %» [S].
- **Ventas**: 70x del libro por centro × mes. En el bloque laboral se conserva `salesSource` (libro si ≥ 90 % de la referencia, si no referencia) [V regla existente].
- **Headcount**: `source.headcount` (recibos → media de `employees_reported` → Σ `headcount` de líneas) [V :588-600]; FTE y horas llegan con RRHH L2 (Schedule 15).

### 5.2 Modelos nuevos (aditivos; migración generada con `prisma migrate diff`, nada a mano)

| Modelo (`@@map`) | Columnas | Unicidad / índices | Notas |
|---|---|---|---|
| **`CostKpiSnapshot`** (`cost_kpi_snapshots`) | `organizationId`; `propertyId?` (null = sociedad); `windowKind` (`day` · `month` · `ytd` · `ltm`); `periodCode` (`YYYY-MM-DD` o `YYYY-MM`); `kpiCode` (catálogo §3, p. ej. `rooms.cpor`, `fnb.food_cost_pct`, `labor.pct_revenue`, `utilities.par`, `result.goppar`); `value Decimal(14,4)?`; `numerator`, `denominator Decimal(14,2)?`; `coverage` (`ledger` · `estimated` · `none`); `sourcesJson` (`{ ledger: "sage200_journal+payroll_cost_import", occupancy: "pms_import", sales: "ledger" }`); `budgetValue?`; `lyValue?`; `benchmarkMedian?`; `status` (`ok` · `warn` · `risk` · `none`); `computedAt`; `engineVersion` | `@@unique([propertyId, windowKind, periodCode, kpiCode])` · `@@index([organizationId, windowKind, periodCode])` | Escrito solo por `cost-kpi-snapshot.service.ts`; `propertyId` null exige `accounting.entity.read` al leer |
| **`CostBudget`** (`cost_budgets`) | `organizationId`; `propertyId`; `periodCode YYYY-MM`; `usaliDepartment` (12 claves); `usaliLine` (validada con `isAdmittedUsali`, `usali-mapping.service.ts:50`); `accountPrefix?` (60x/62x opcional); `amount Decimal(14,2)`; `fte Decimal(6,2)?`; `hours Decimal(8,2)?`; `version Int`; `status` (`draft` · `approved`); `approvedBy?`; `approvedAt?`; `importHash?` | `@@unique([propertyId, periodCode, usaliDepartment, usaliLine, accountPrefix, version])` | Las filas `labor` son el `LaborBudget` de RRHH §4 (`RRHH-PLANTILLA-NOMINA.md:141`) y `aggregatePayrollCostReport` las lee como celdas `budget`; `rooms.revenue` se deriva de `Budget.budgetedRoomRevenue` |
| **`CostKpiThreshold`** (`cost_kpi_thresholds`) | `organizationId`; `propertyId?`; `kpiCode`; `basis` (`budget` · `ly` · `benchmark` · `absolute`); `direction` (`lower_is_better` · `higher_is_better`); `warn Decimal(8,2)`; `risk Decimal(8,2)`; `minAmount?`; `active` | `@@unique([organizationId, propertyId, kpiCode])` | Defecto por organización (warn 3 / risk 8 en %, espejo H&F); el hotel puede sobrescribir |
| **`CostBenchmark`** (`cost_benchmarks`) | `organizationId?` (null = catálogo del sistema); `category` (`urban_2`, `urban_3`, `urban_4`, `resort`); `market` (`ES`, `ES-MAD`, `ES-NORTE`, `EU`); `kpiCode`; `p25?`; `median?`; `p75?`; `unit`; `source`; `dataYear`; `notes?` | `@@unique([organizationId, category, market, kpiCode, dataYear])` | Semilla con §2.3 (CHSB 2025, HotStats 2025, INE 2025); `Property.benchmarkCategory?` y `benchmarkMarket?` nuevas, con defecto derivado de `Property.star_rating` (ya existe: AS 2, LL/PG/RA 3, FN/LT/MC 4 [V SQL]) y `kind` [S] |
| **`UtilityConsumption`** (`utility_consumptions`) | `propertyId`; `periodCode`; `utilityType` (`electricity` · `water` · `gas` · `waste`); `quantity Decimal(14,3)`; `unit` (`kWh` · `m3` · `kg`); `amount Decimal(12,2)?`; `source` (`invoice` · `meter` · `estimate`); `supplierBillId?`; `notes?` | `@@unique([propertyId, periodCode, utilityType, source])` | Mensual por factura; `UtilityMeter/UtilityReading` (`schema.prisma:1982-1999`) siguen para lecturas; kWh/m² usa `Property.surfaceM2` (ya existe, `schema.prisma:485`; null en Faranda), no se crea columna [V] |
| **`FnbCoverDaily`** (`fnb_cover_daily`) · `PosOrder.covers Int?` | `propertyId`; `businessDate`; `outletId?`; `mealPeriod` (`breakfast` · `lunch` · `dinner` · `bar` · `banquet`); `covers Int`; `source` (`pos` · `pms_breakfast` · `manual` · `import`) | `@@unique([propertyId, businessDate, outletId, mealPeriod, source])` | `PosTicketOpenSchema` gana `covers` opcional (`pos.schemas.ts:9-15`); desayunos = pax alojados de snapshots cuando no hay TPV [S] |
| `OccupancyDeclared` (`occupancy_declared`) | `propertyId`; `periodCode`; `roomsOccupied Int`; `roomsAvailable Int?`; `source` (`opera_hf` · `manual`) | `@@unique([propertyId, periodCode])` | Solo si no hay snapshots; el importador H&F de OPERA (runbook `pms-history-forecast-import.md`) la rellena de paso [S] |

Unicidad con columnas anulables: Postgres trata los NULL como distintos, así que `@@unique` con `propertyId?` (`CostKpiSnapshot`, `CostKpiThreshold`), `organizationId?` (`CostBenchmark`) o `accountPrefix?` (`CostBudget`) no impide duplicados. Regla: incluir `organizationId` en la clave y usar el centinela `"*"` en `propertyId` (sociedad), `accountPrefix` (sin detalle) y `organizationId` (catálogo del sistema), como hace `CashClosure.outletId = "*"` [S].

`AccountingSetting.configurationJson` (`schema.prisma:873-887`) gana `costPanel = { ffeReservePct: 4, allowDemoOccupancy: false, alertRecipients: [...] }` (informativo, como `corporateAllocation`) [S].

### 5.3 Motor de cálculo y materialización

- **`cost-kpis.ts` (puro, sin Prisma)**: `computeCostKpis({ pnl: UsaliPnl, occupancy, headcount, sales, costLines?, consumption?, covers?, budget?, ly?, thresholds, benchmarks }) → CostKpi[]` con `{ kpiCode, value, numerator, denominator, coverage, sources, budget, ly, benchmark, status, delta }`. Reglas: denominador 0 o fuente `none` → `value null, coverage none` (nunca 0); numerador del libro con denominador de otra fuente → `estimated`; `status` solo cuando `value` y la base del umbral existen. Flow-through por casos de signo (Δingreso ≤ 0 → flex) [S].
- **Ventanas**: M = mes; YTD = Σ meses del ejercicio hasta el mes; LTM = 12 meses móviles; D = solo KPIs con asiento diario. Los ratios se recalculan sobre las sumas (no media de ratios).
- **`cost-kpi-snapshot.service.ts`**: `materialize({ organizationId, propertyIds, months })` = por centro y mes `buildUsaliPnl` + resolutores + `computeCostKpis` → `upsert` en `CostKpiSnapshot`; sociedad = `computeUsaliPnl` sobre el libro sin filtro de centro (no suma de snapshots, para conservar «Sin asignar» y OC); YTD/LTM desde los meses ya materializados.
- **Disparadores**: scheduler diario `COST_KPI_SCHEDULER_DISABLED` / `COST_KPI_SCHEDULER_INTERVAL_MS` (patrón `env.ts:690-706`; líder `schedulerLeader` como el scheduler de pace `server.ts:8750-8772`, que no toma lock, y `pg_try_advisory_xact_lock('cost_kpi.materialize')` como el job de modo sombra OPERA `server.ts:8863-8871` / `startPmsShadowJob`) que recalcula mes en curso, mes anterior y YTD; recálculo inmediato tras `PAYROLL_COST_IMPORT_POSTED`, apply de Sage (Tanda 7c), `BUDGET_APPROVED`, cierre de periodo y `PUT` de umbrales; `engineVersion` permite recalcular todo tras un cambio de fórmula [S].
- **Trazabilidad**: `sourcesJson` guarda lote de nómina, lotes Sage y fuente de RN usados; el drill del front lee al vuelo `accountBalances` filtrado por KPI → cuentas → `journal_entries` → `supplier_bills` (`SupplierBillLine.expenseAccountCode`, `journalEntryId`) cuando existan.

### 5.4 Ejemplo de materialización: RA · 2026-06 (cifras del libro [V SQL], RN `demo` [V SQL] → estimado)

| `kpiCode` | Numerador | Denominador | `value` | `coverage` | `sourcesJson` |
|---|---:|---:|---:|---|---|
| `fnb.food_cost_pct` | 601.1 + 601.2 = 25.938,24 | 705.2 = 66.167,30 | 39,20 | `ledger` (combinado: 705.2 no separa bebida) | `{ ledger: "sage200_journal" }` |
| `fnb.labor_pct` | 640 + 642 cc FNB = 32.168,29 | 66.167,30 | 48,62 | `ledger` | `{ ledger: "sage200_journal+payroll_cost_import" }` |
| `labor.pct_revenue` | Σ labor = 68.382,80 | 70x + 752 = 313.198,54 | 21,83 | `ledger` (`salesSource: "ledger"`) | idem |
| `rooms.channel_pct` | 629.1 = 12.644,16 | 705.1 = 232.214,17 | 5,44 | `ledger` | `{ ledger: "sage200_journal" }` |
| `utilities.pct` · `utilities.par` | 628.1-3 = 10.505,69 | 313.198,54 · 120 × 30 | 3,35 · 2,92 | `ledger` | idem |
| `utilities.por` · `rooms.cpor_dept` | 10.505,69 · 45.640,22 (por cuenta: labor ROOMS 28.802,98 + 629.2 4.193,08 + 629.1 12.644,16; sin 629.1 serían 32.996,06 → 12,03) | RN 2.743 | 3,83 · 16,64 | `estimated` | `{ occupancy: "demo" }` → excluido de alertas y ranking |
| `result.gop_pct` · `result.goppar` | GOP 188.281,93 | 313.198,54 · 3.600 | 60,12 · 52,30 | `ledger` (sin reparto OC, `oc_allocation: none`) | `{ allocation: "none" }` |
| `fnb.cost_per_cover` · `labor.hpor` | — | cubiertos · horas | null | `none` | `{ covers: "none", hours: "none" }` |
| `result.flow_through_budget` | — | Δingreso vs presupuesto | null | `none` (sin `CostBudget`) | `{ budget: "none" }` |

`status`: `labor.pct_revenue` 21,83 contra benchmark España ≈ 30-32 % → `ok`; `fnb.food_cost_pct` 39,20 contra umbral absoluto 33/36 [S] → `risk`; los `estimated` y `none` → `status none`. Cada fila ocupa una columna del `CocoaKpi` con `caption` «libro · junio 2026» o «estimado: ocupación demo».

---

## §6 · Comparativos y alertas

- **Presupuesto**: `CostBudget` aprobado (versión vigente) por (centro, mes, departamento, línea); desviación € y % por línea, PAR/POR presupuestados con `Budget.budgetedRoomsSold` y `rooms.active`; presupuesto flexible estándar USALI: líneas variables (`cost_of_sales`, `rooms.other_expense`, `fnb.other_expense`) reescaladas por RN real ÷ RN presupuestada, fijas sin reescalar [S]. Sin presupuesto → columna «—» y chip «sin presupuesto», nunca 0.
- **Año anterior**: `compareUsaliPeriods([mes, mes LY, YTD, YTD LY])` (`usali.service.ts:619-640`, 2-6 periodos) → deltas de `usaliDeltas` (:347) y del motor. Faranda: 2025 completo por Sage, así que 2026 vs 2025 es real mes a mes; 2024 solo total anual sin centro de coste (`sage200_balance`, 11 asientos) → LY de 2025 «sin datos mensuales» [V SQL].
- **Otros hoteles de Faranda**: `compareUsaliProperties` (:479) + snapshots → ranking por KPI (mejor → peor), mediana del grupo y posición del hotel; los hoteles sin RN real no entran en el ranking de KPIs POR (chip «sin ocupación real»).
- **Benchmark**: `CostBenchmark` por `Property.benchmarkCategory` × `benchmarkMarket`; semáforo verde ≤ p25 (o ≥ para higher_is_better), ámbar entre p25 y mediana, rojo > p75; año del dato siempre visible.
- **Tendencia**: sparkline de 12 meses por KPI (`CocoaKpi.sparkline`) y flecha vs mes anterior; alerta de deriva cuando tres meses seguidos empeoran > `warn` sin superar `risk` [S].
- **Alertas persistidas**: `AnomalyEvent { anomalyType: "cost_kpi_threshold", metricCode: "<kpiCode>@<propertyId>@<periodCode>", severity: warn|risk, title, description }` (`schema.prisma:2134-2147`, sin unique → `findFirst({ status: "open", metricCode })` antes de crear, bajo el advisory lock del scheduler); se cierran (`status: "closed"`) al volver a banda. Envío por `dispatch()` (`notifications/dispatcher.service.ts:114-173`) con plantilla nueva `cost_kpi_alert` en `system-templates.ts` (existe sin seed; editable por organización), destinatarios = `configurationJson.costPanel.alertRecipients` y, por defecto, usuarios con `manager` del centro y `operations_director` del grupo [S]. Digest semanal opcional reutilizando el patrón `REAL_ESTATE_DIGEST_*` de Activo.

### 6.1 Umbrales por defecto de la organización (semilla de `CostKpiThreshold`; todos [S], referencias de §2.3)

| `kpiCode` | `basis` | `direction` | `warn` | `risk` | Referencia |
|---|---|---|---|---|---|
| `labor.pct_revenue` | `budget`, fallback `absolute` | lower | +3 % desfavorable · 32 % abs. | +8 % · 36 % abs. | HFTP ≈30 %; Europa FY25 ≈31-32 %; CBRE EE.UU. 32,4 % |
| `fnb.food_cost_pct` | `absolute` | lower | 33 % | 36 % | Talent Hostelería (restaurante 28-32 %, alerta >36 %) |
| `fnb.beverage_cost_pct` | `absolute` | lower | 24 % | 28 % | Backbar/Provi 18-24 % |
| `fnb.margin_pct` | `benchmark` | higher | < 21 % (mediana España) | < 15 % | HotStats España 21,0 % (2025) |
| `rooms.margin_pct` | `benchmark` | higher | < 72 % | < 65 % | HotStats España 72,0 % (2025) |
| `rooms.channel_pct` | `budget`, fallback `absolute` | lower | 12 % | 18 % | Hosteltur <12 % resorts; DESIGN-PROPOSAL #9 <18 % |
| `utilities.pct` | `budget`, fallback `absolute` | lower | 4,5 % | 6 % | CBRE 3,3 %; Faranda 2025 4,5 % |
| `eww.kwh_por` | `benchmark` (CHSB por categoría) | lower | > mediana | > p75 | 3★ 23,5 (20,1-30,0); 4★ 48,7 (39,0-66,8) |
| `result.gop_pct` | `budget`, fallback `benchmark` | higher | −3 % · < 34 % | −8 % · < 30 % | HotStats urbano 32-34 %, España 41 % |
| `result.flow_through_budget` | `absolute` | higher | < 50 % | < 35 % | DeFranco 50-60 %; Lund 80-90 % |
| `labor.absenteeism_pct` | `absolute` | lower | 7 % | 9,3 % | Adecco alojamiento 9,32 % (1T-2026) |
| `nonop.*`, `ag.*`, `sm.*`, `pom.*`, `it.*` | `budget` | lower | +3 % | +8 % | espejo H&F board (−3 %/−8 %) |

Semántica: para `budget`/`ly` los umbrales son % de desviación desfavorable; para `absolute` son valores del KPI; para `benchmark` se usan mediana y p75/p25 de `CostBenchmark`. `minAmount` (p. ej. 500 €) evita alertas sobre importes irrelevantes. Los umbrales se revisan trimestralmente por estacionalidad (patrón Lynch) y cada hotel puede sobrescribirlos.

---

## §7 · API y permisos

Partial `apps/api/src/modules/cost-panel/route-permissions.partial.ts` fusionado en `route-permissions.ts` (patrón `financial-statements/route-permissions.partial.ts:22-33`, que declara `accounting.read` y se remapea a `accounting.reports.read` en el borde con `requireAccountingReportsKey`; el partial nuevo declara `accounting.reports.read` directamente para no depender del remapeo, `security/__tests__/finance-report-keys.test.mts:1-8`). Ámbito por `assertFinanceReadScope` / `assertFinanceReadScopeMany` (`finance-scope.ts:236, 259`) y `loadUserScope` (`rbac-scope.ts:169`; grupos `property_group` :234-235, :267-269; `coversProperty` :354).

| Ruta | Permiso | Ámbito | Respuesta |
|---|---|---|---|
| `GET /accounting/cost-panel?propertyId&groupId&window=month\|ytd\|ltm\|day&period=2026-06&compare=budget,ly,group,benchmark` | `accounting.reports.read` | `propertyId` en `assignedPropertyIds`; `groupId` = grupo asignado (`operations_director`); sin ninguno → sociedad, exige `accounting.entity.read` (R11) | `{ scope, period, window, blocks: { rooms, fnb, labor, undistributed, result, nonOperating }, kpis: CostKpiDto[], degraded[], sources }` |
| `GET /accounting/cost-panel/departments?…&view=account\|cost_centre` | `accounting.reports.read` | idem | matriz departamento × línea × {real, presupuesto, forecast, LY, Δ, %, PAR, POR}; `view=account` (por cuenta, defecto del panel) o `cost_centre` (como `computeUsaliPnl`, §1 punto 5) |
| `GET /accounting/cost-panel/drilldown?kpiCode&propertyId&period` | `accounting.reports.read` | idem | cuentas → asientos (`journalEntryId`, fecha, descripción, `sourceType`) → factura si `supplier_bills.journal_entry_id` |
| `GET /accounting/cost-panel/ranking?groupId&kpiCode&period` | `accounting.reports.read` | solo hoteles del ámbito | ranking + mediana; hoteles sin RN real marcados |
| `GET /accounting/cost-panel/export?format=csv\|xlsx&…` | `accounting.reports.read` + `analytics.export` | idem | mismo contenido que `/departments` |
| `GET /accounting/cost-budgets?year&propertyId` · `PUT` | `accounting.reports.read` · `accounting.configure` | idem | líneas por versión; `PUT` crea versión `draft` |
| `POST /accounting/cost-budgets/import` (`{ csv, apply }`) | `accounting.configure` | idem | preview `{ rows, unmapped, totals }` → apply con `importHash` (409 `COST_BUDGET_DUPLICATE`) |
| `POST /accounting/cost-budgets/:year/approve` | `accounting.configure` + `ApprovalRequest` kind `budget` (nuevo en `ApprovalKind`, `schema.prisma:322-332`) | DirOps aprueba hoteles de su grupo, DG el consolidado (`RBAC-DEPARTAMENTOS.md:55, 62`) | versión `approved`; `FinancialStatementSnapshot` kind `usali` «presupuesto AAAA vN» |
| `GET /accounting/cost-panel/thresholds` · `PUT` | `accounting.reports.read` · `accounting.configure` | por hotel u organización | `CostKpiThreshold[]` |
| `GET /accounting/cost-benchmarks?category&market` | `accounting.reports.read` | — | catálogo + overrides de la organización |
| `GET /accounting/cost-panel/alerts?propertyId&status` · `POST …/alerts/:id/ack` | `accounting.reports.read` · `accounting.reports.read` | idem | `AnomalyEvent` de tipo `cost_kpi_threshold` |
| `POST /accounting/cost-panel/recompute` | `accounting.configure` | idem | encola materialización (respuesta 202) |

Nunca `revenue.configure` ni `payroll.read` para leer el panel (invariantes `finance-report-keys` / `route-read-keys`; el `GET /dashboards/*` actual va con `analytics.read`, `route-permissions.ts:1113`, y no sirve porque el panel muestra importes contables). Roles verificados en `permissions.ts`: `manager` (:1056-1057, N3 property) tiene `accounting.reports.read` y no `accounting.entity.read` → su hotel; `operations_director` (:1290-1291, N4 property_group) tiene ambos → su grupo por asignación; `general_manager` (:1811-1812, N5 organization) → todo [V]. Contrato en `docs/api-contracts.md` (bloque nuevo tras la entrada de la Tanda 6c, :221) y runbook §20.

### 7.1 Códigos de error y cabeceras

| Código | HTTP | Cuándo |
|---|---|---|
| `ENTITY_SCOPE_REQUIRED` (existente) | 404 opaco | sociedad o grupo sin `accounting.entity.read` / fuera de la asignación |
| `PROPERTY_NOT_FOUND` (existente) | 404 opaco | `propertyId` fuera del ámbito o de la organización |
| `COST_PANEL_PERIOD_INVALID` | 400 | `period` no `YYYY-MM` (o `YYYY-MM-DD` con `window=day`), rango > 36 meses en `/departments` |
| `COST_KPI_UNKNOWN` | 400 | `kpiCode` fuera de `COST_KPI_CODES` (drilldown, umbrales, ranking) |
| `COST_BUDGET_INVALID { errors: [{ line, message }] }` | 400 | CSV con cabecera, mes, departamento o importe inválidos |
| `USALI_LINE_NOT_ADMITTED { department }` (existente) | 400 | línea no admitida por el departamento (`USALI_DEPARTMENT_LINES`) |
| `COST_BUDGET_DUPLICATE { budgetVersionId }` | 409 | mismo `importHash` con versión viva |
| `COST_BUDGET_VERSION_APPROVED` | 409 | `PUT` sobre una versión aprobada (hay que crear versión nueva) |
| `APPROVAL_SELF_DECISION` (existente, CHECK de `ApprovalRequest`) | 409 | quien aprueba es quien solicitó |
| `COST_THRESHOLD_INVALID` | 400 | `warn` ≥ `risk` con `lower_is_better` (o al revés) |

Cabecera `X-Cost-Panel-Computed-At` con el `computedAt` más antiguo de los snapshots servidos; el front pinta «datos de <fecha/hora>» y ofrece «recalcular» solo a `accounting.configure`.

---

## §8 · Front (Cocoa 22, cero `style={}`)

- **Pestaña «Costes» en Dirección** (`/hoy/direccion/costes`, loader `DirectorCostsScreen` en `MiDiaTabs.tsx:35-40`, registro en `App.tsx:182-184` y `nav-tree.generated.json` bajo `/hoy/direccion` :62 vía `scripts/build-nav-tree.mjs`): vista **mes en curso** del hotel activo. `CocoaPage` → `CocoaKpiStrip stagger` con 8 `CocoaKpi` (`CocoaKpi.tsx:42-60`: `value` formateado, `delta` + `deltaUnit "pp"|"%"|"€"`, `deltaLabel "vs ppto"`, `polarity "negative-good"`, `status ok|warning|critical`, `sparkline` 12 meses, `degraded`): CPOR total, Coste laboral % ingresos, Food cost %, Suministros POR, GOP %, GOPPAR, Flow-through MTD, Coste MTD vs presupuesto → cada uno en `DegradedCard` (`DegradedValue.tsx:122`) cuando su fuente falte, con `DegradedBanner` (:140) en cabecera. Debajo `CocoaGrid` 6/6: `CocoaChart.Donut` mix de costes por departamento y `CocoaChart.Bars` flow-through por departamento (no hay waterfall ni barras apiladas en `CocoaChart.tsx:662-669`; se representa con `tone` por signo). En `GeneralManagerScreen.tsx:486-511` la tarjeta «Coste laboral» (fichajes, 0 en Faranda) pasa a leer `labor.pct_revenue` MTD del panel con `DegradedCard`; skeleton espejo `:874-884` sin cambios de forma.
- **Pestaña «Costes» en Informes** (`/informes/costes`, `CostPanelScreen`, loader en `CentroInformesTabs.tsx:14-17`, ítem propio del árbol junto a `/informes/rentabilidad-habitacion` :1829): vista completa. Cabecera: `FinanceScopeSelector` (sociedad / centro, `UsaliScreen.tsx:54, 366`) + `CocoaSegmentedControl` hotel · grupo · sociedad (según ámbito) + selector de periodo (`CocoaDatePicker` mes, segmentado M · YTD · LTM) + `CocoaSegmentedControl` comparar con (presupuesto · LY · grupo · benchmark). Cuerpo: (1) `CocoaKpiStrip` de 8; (2) **tarjetas por bloque** (`CocoaGrid` 4/4/4 · 4/4/4): Habitaciones, A&B, Laboral, Generales, Resultado, No operativos — cada `CocoaSection` con su lista de KPIs (`CocoaKpi size="compact"` con semáforo y flecha de tendencia) y `CocoaState kind="degraded"` en los sin datos (`COCOA-22.md:287`); (3) **tabla por departamento** en `CocoaSection padding="none"` + `overflow: clip` (`COCOA-22.md:286`): `CocoaTable` (`CocoaTable.tsx:62-97`; columnas declaradas fuera, `sortBy/onSort` controlados `COCOA-22.md:256`, `fit`/`showFrom` con ≥ 7 columnas, `footer` de totales, `stickyFirstColumn`, `density="compact"`) con filas departamento → línea (`onSelect` abre `CocoaDrawer` de cuentas → asientos → factura, `UsaliAccountAmount` + drilldown); (4) `CocoaGrid` 8/4: `CocoaChart.Line` tendencia 12 meses (series real · presupuesto · LY, `dashed` para LY) y `CocoaChart.Bars` flow-through; (5) ranking de hoteles (solo grupo/sociedad) con `CocoaTable` y `rowTone` por semáforo; (6) alertas abiertas en `CocoaTable density="compact"` con `rowActions` «reconocer» (no existe `CocoaList` en `components/cocoa`). `CocoaActionBar` con exportar CSV/XLSX (`analytics.export`). Presupuesto de `style=`: ≤ 12 como el canon (`COCOA-22.md:238`).
- **Honestidad visual**: cada KPI muestra `caption` con fuente y ventana («libro · junio 2026» / «estimado: RN de OPERA» / «sin datos: cubiertos»); los hoteles sin RN real muestran los POR como «—» con tooltip «cargar H&F de OPERA»; el año del benchmark va en la etiqueta.

### 8.1 Esqueleto, comandos y responsive

- Skeleton espejo de `CostPanelScreen`: `CocoaSkeleton.Strip count={8}` → `CocoaSkeleton.Grid rows={[[4, 4, 4], [4, 4, 4]]}` (tarjetas por bloque) → `CocoaSkeleton.Grid rows={[[12]]}` (tabla) → `CocoaSkeleton.Grid rows={[[8, 4]]}` (tendencia y flow-through); `DirectorCostsScreen`: `Strip count={8}` + `Grid rows={[[6, 6]]}`. Literales inline en JSX (`COCOA-22.md:257`).
- Comandos ⌘K (`commands` de `CocoaPage`, ids `costes-<acción>`): `costes-exportar`, `costes-periodo-anterior`, `costes-comparar-presupuesto`, `costes-recalcular` (solo con `accounting.configure`).
- Responsive: la tira baja a una columna < 600 px; la tabla oculta PAR/POR con `hideOnNarrow` y mantiene real · presupuesto · Δ % con `showFrom`; el ranking pasa a lista.
- Estados: `CocoaPage state="empty"` cuando no hay ningún snapshot para el ámbito («Sin datos materializados: ejecutar recálculo o esperar al scheduler nocturno»); `state="error"` solo ante 5xx; los 404 opacos de ámbito no se distinguen de «no existe».

---

## §9 · Lotes

Ficheros **exclusivos** por lote; tipos wire y schema en L0 para que L1, L2 y L4 corran en paralelo. Orden: **L0 → {L1 ∥ L2 ∥ L4} → L3 (tras L1-L2) → L5 (tras L1) → L6**.

| Lote | Ficheros exclusivos | Tests y puertas |
|---|---|---|
| **L0 · Schema + tipos** | `packages/database/prisma/schema.prisma` (7 modelos §5.2, `ApprovalKind.budget`, `Property.benchmarkCategory/benchmarkMarket`, `PosOrder.covers`; `Property.surfaceM2` y `star_rating` ya existen); `packages/database/prisma/migrations/2026MMDDHHMMSS_panel_costes_direccion/migration.sql` (`prisma migrate diff` verbatim); `packages/shared/src/{cost-panel-types.ts (nuevo), index.ts, financial-statements-types.ts (UsaliStatistics.source ampliado)}` | `prisma validate`; `db:migrate:status`; `db:drift:check` «No difference detected.»; `scripts/check-migrations-vs-schema.mjs`; `tests/finanzas-schema-contract.test.mjs` |
| **L1 · Motor + resolutores + snapshots** | `apps/api/src/modules/cost-panel/{cost-kpis.ts, occupancy-resolver.ts, cost-kpi-snapshot.service.ts, flow-through.ts}`; `apps/api/src/modules/financial-statements/source.ts` (flag `byMonth`, `occupancy` con resolutor); `apps/api/src/modules/cost-panel/__tests__/{cost-kpis, flow-through, occupancy-resolver, snapshot}.test.mts`; `apps/api/src/modules/financial-statements/__tests__/memory-source.mts` (+ snapshots y declarados) | 100 % de KPIs de §3 con casos: denominador 0 → null/none; RN estimado → `estimated`; flow-through con signos mixtos; YTD = Σ meses; los 8 ficheros de test previos de `financial-statements/__tests__` intactos (`allocation`, `annual-accounts`, `source`, `usali`, `usali-corporate`, `usali-cost-centre`, `usali-mapping`, `writers-and-export`); `tests/integration/cost-panel-snapshot.test.mts` sobre una organización AISLADA creada y borrada por la suite (contrato de `tests/integration/*`: Faranda y org_123 nunca se tocan, `financial-statements-reversals.test.mts:5-6`) con asientos que reproducen RA 2026-06 (F&B 39,2 %, laboral 21,8 %, GOP 60,1 % sin OC) y un caso con cc de Sage que compruebe la vista por cuenta frente a la reenrutada; la comprobación sobre Faranda real es la puerta SQL de L6 |
| **L2 · Presupuesto + umbrales + benchmarks** | `apps/api/src/modules/cost-panel/{cost-budget.parser.ts, cost-budget.service.ts, cost-threshold.service.ts, cost-benchmark.service.ts, cost-benchmark.seed.ts}`; `apps/api/src/modules/payroll/cost-report.service.ts` (celdas `budget`); `apps/api/src/modules/cost-panel/__tests__/{cost-budget-parser, cost-budget, thresholds}.test.mts` | CSV `centro;mes;departamento;linea;importe[;fte;horas]` preview/apply idempotente por hash; versión aprobada única; `rooms.revenue` = `Budget.budgetedRoomRevenue`; semilla de benchmarks con año y fuente |
| **L3 · Rutas + permisos + contratos** | `apps/api/src/modules/cost-panel/{cost-panel.routes.ts, route-permissions.partial.ts, cost-panel.schemas.ts}`; `apps/api/src/security/route-permissions.ts`; `apps/api/src/server.ts` (registro + scheduler); `apps/api/src/lib/env.ts` (`COST_KPI_SCHEDULER_*`); `docs/api-contracts.md` | `tests/api-route-permissions-contract.test.mjs`; `tests/env-contract.test.mjs`; integración: `manager` 403 fuera de su hotel, `operations_director` 404 opaco fuera del grupo, sociedad sin `accounting.entity.read` → `ENTITY_SCOPE_REQUIRED` |
| **L4 · Front** | `apps/admin-web/src/screens/costs/{CostPanelScreen.tsx, DirectorCostsScreen.tsx, cost-panel-helpers.ts, CostDrilldownDrawer.tsx}`; `apps/admin-web/src/services/costPanelApi.ts`; `apps/admin-web/src/screens/tabs/{hoy/MiDiaTabs.tsx, informes/CentroInformesTabs.tsx}`; `apps/admin-web/src/App.tsx`; `apps/admin-web/src/navigation/nav-tree.generated.json` (vía `scripts/build-nav-tree.mjs`); `apps/admin-web/src/screens/operations/GeneralManagerScreen.tsx` (tarjeta laboral); `apps/admin-web/src/screens/costs/__tests__/{cost-panel-helpers, cost-panel-contract}.test.mts` | `tests/{cocoa-22-contract, nav-tree-contract, rbac-nav-contract, admin-web-no-raw-fetch, admin-web-spanish-copy-contract}.test.mjs`; `scripts/check-discoverability.mjs`; cero `style=` nuevos fuera del presupuesto |
| **L5 · Alertas + notificaciones** | `apps/api/src/modules/cost-panel/cost-alert.service.ts`; `apps/api/src/modules/notifications/system-templates.ts` (`cost_kpi_alert`); `apps/api/src/modules/cost-panel/__tests__/cost-alert.test.mts` | idempotencia (`findFirst` abierta), cierre al volver a banda, `dispatch` una vez por (alerta, destinatario); `template_not_found` imposible |
| **L6 · Docs + demo** | `docs/runbooks/finanzas-contabilidad.md` (nueva §20); `docs/design/PANEL-COSTES-DIRECCION.md` (este documento); `packages/database/prisma/seed-cost-panel-demo.ts` (presupuesto, consumos, cubiertos **ficticios** solo para orgs demo, nunca Faranda; guardia `assertDemoTarget` de `prisma/lib/demo-guard.ts:115` como en `seed-fnb-inventory.ts`); `docs/audits/PANEL-COSTES-<fecha>.md` | `typecheck:all`; `pnpm test`; `test:integration`; `grep -c cost_kpi_snapshots` runbook ≥ 3; SQL en Faranda: snapshots para 7 hoteles × 19 meses × ≥ 40 KPIs con `coverage` coherente (§10) |

---

## §10 · Datos de demo (Faranda) y qué necesita de César

### 10.1 Lo que ya sale al céntimo desde el libro (regla de los estados) [V SQL]

Consolidado 2025 (7 hoteles + OC, 932 habitaciones activas): ingreso operativo 23.972.454,52 € (habitaciones 18.722.999,32; A&B 4.560.513,76; otros 674.541,44; varios 14.400,00); personal 7.613.515,43 € = **31,8 %**; coste de ventas A&B 1.778.148,54 € = **39,0 %** de A&B; margen Habitaciones **75,4 %** (por cuenta; 81,0 % en `departmentalProfit` porque 629.1 y 6230 llevan cc COM/ADM); margen A&B **26,2 %**; no distribuidos por cuenta 4.448.056,25 € = 18,6 % (A&G 6,6 %, S&M 3,9 %, POM 3,1 %, IT 0,5 %, suministros **4,5 %** = 3,19 € por RD-día; en `computeUsaliPnl` son 5.486.184,76 € = 22,9 % con 629.1 y 6230 dentro); GOP 11.563.641,06 € = **48,2 %** por ambas vías (sin repartir OC: A&G contiene la oficina central, 1.244.308,97 € de personal en 2025); EBITDA 47,7 %; GOPPAR 33,99 € y TRevPAR 70,47 € por habitación disponible y día. Coste de personal importado 2026-01..08: 2.442.559,16 € (bruto 1.891.222,19 + SS 551.336,97; 363 celdas) = rooms 910.384,67 · A&G 773.528,22 · F&B 546.288,21 · POM 195.314,10 · S&M 17.043,96; ventas de referencia RRHH 4.335.144,05 € (40 celdas, 5 centros).

| Hotel | Hab. | Ingreso 2025 (70x + 752) | Laboral % | F&B cost % | Suministros % | Comisiones % ing. hab. (629.1 ÷ 705.1) | Laboral pisos+recepción % ing. hab. (640/642 cc ROOMS ÷ 705.1) |
|---|---:|---:|---:|---:|---:|---:|---:|
| AS | 78 | 1.221.087 | 28,3 | 39,0 | 4,8 | 6,0 | 19,1 |
| FN | 399 | 12.164.600 | 26,2 | 38,8 | 4,6 | 5,5 | 16,2 |
| LL | 102 | 1.663.999 | 28,6 | 38,7 | 4,7 | 6,0 | 19,6 |
| LT | 92 | 2.314.638 | 26,3 | 38,9 | 4,4 | 5,4 | 16,3 |
| MC | 85 | 2.368.873 | 26,2 | 39,2 | 4,4 | 5,4 | 16,2 |
| PG | 56 | 957.672 | 28,8 | 38,8 | 4,8 | 6,0 | 19,3 |
| RA | 120 | 3.281.586 | 26,1 | 39,7 | 4,3 | 5,3 | 16,3 |

Ejemplo de tarjeta para RA · junio 2026 (todo del libro; RN = 2.743 noches `demo` de `revenue_daily_snapshots`, por tanto **estimado**): ingreso 313.198,54 €; coste de ventas A&B 25.938,24 € = 39,2 %; laboral A&B 48,6 %; margen A&B 12,2 %; margen Habitaciones 80,8 % por cuenta (86,1 % en `departmentalProfit`); comisiones 5,4 %; suministros 10.505,69 € (3,83 € POR, 2,92 € PAR); GOP 188.281,93 € = 60,1 % (RA no tiene personal de A&G: está en OC; sus 1.141,90 € de A&G son 628.4 y 629.3 con cc ADM); GOPPAR 52,30 € sobre 120 habitaciones (66,06 € sobre las 95 del informe RRHH); CPOR del dpto. Habitaciones 16,64 € por cuenta (12,03 € sin 629.1), labor CPOR de habitaciones 10,50 €, lavandería 1,53 € POR. La referencia RRHH del mes (33 empleados, 95 habitaciones, ventas 185.796,73 €) no cuadra con el 705.x de Sage (237.343,51 €, ×1,28) [V SQL]: el panel debe mostrar la fuente de ventas elegida en cada ratio.

### 10.2 Lo que falta en la demo [V SQL]

- **Habitaciones ocupadas**: solo LT tiene noches reales (OPERA H&F, 2025-08-01..2026-09-13, 12.698 rn) y RA noches `demo` (2025-05-12..2026-07-16, 430 días, 36.974 rn, 0 pax) + `night_audit` 64 días / 49 rn; AS/FN/LL/MC/PG ninguna; `reservations` con estancias solo en RA (10 reservas `checked_out`, 12 habitaciones, jul-2026..jul-2027). Todo KPI POR sale «sin datos» en 5 hoteles.
- **Cubiertos**: `PosOrder` sin pax (1 comanda en toda la BD); pax alojados solo en snapshots de LT (22.752 pax / 12.698 rn, 409 días) → coste de desayuno por pax estimable solo en LT.
- **Consumos**: `utility_meters` 0, `utility_readings` 0, `sustainability_metrics` 0 → kWh/m³ imposibles; solo euros 628.1 (1.156.901,40 € 2025-01..2026-07), 628.2 (180.116,85), 628.3 (387.424,25); `Property.surfaceM2` null en los 8 centros.
- **Presupuesto**: `budgets` 4 filas (RA 2026-07..10, solo habitaciones); sin presupuesto de costes → desviaciones «—» y flow-through solo vs LY.
- **Inventario F&B**: `inventory_items`, `menu_recipes`, `stock_movements` 0; sin 611 → food cost = compras, no consumo; 705.2 no separa comida y bebida.
- **Personal**: `staff_profiles`, `time_clock_entries`, `labor_forecasts` 0; headcount solo 2026-01..08 en 5 hoteles (FN/LL sin empleados) → FTE/RN, HPOR, horas extra y absentismo «—».
- **Cobertura temporal**: Sage 2025-01..2026-07 (70x y 6xx completos en los 7 hoteles, incluido julio: RA 399.223,11 € de 70x = 705.x Sage 398.012,78 + 752 1.200,00 + 705 nativo 10,33); agosto-2026 solo 64x en AS/LT/MC/OC/PG/RA; FN/LL sin agosto; 2024 sin meses ni centro de coste.
- **Decisiones de mapeo**: 705.5 parking en `rooms.revenue`; reparto de OC `none`; sin 623.1, 641, 649, 611, 602, 607; cc de Sage que reenrutan 628.x → POM, 629.1 → S&M, 628.4/629.3/6230 → A&G (§1 punto 5).

### 10.3 Lo que necesita de César

1. **Presupuesto 2026 por hotel, mes, departamento y línea USALI** (o al menos por cuenta 6xx y 70x): CSV del importador L2; si solo existe anual, se prorratea por estacionalidad 2025 con aviso.
2. **H&F de OPERA de AS, FN, LL, MC y PG** (mismo formato que LT, runbook `pms-history-forecast-import.md`) o, como mínimo, habitaciones ocupadas por hotel y mes 2025-2026 para `OccupancyDeclared`.
3. **Facturas de energía, agua y gas** por hotel y mes con kWh/m³ y € (y los m² de cada hotel para `Property.surfaceM2`, hoy vacía) para `UtilityConsumption`.
4. **Inventarios F&B**: existencias inicial y final por mes (o al menos trimestre), desglose comida/bebida de 705.2 (subcuentas o mapeo de outlets) y, si existen, escandallos del desayuno.
5. **Cubiertos**: desayunos servidos y cubiertos de restaurante por hotel y día (TPV o parte de cocina).
6. **Decisiones**: categoría/mercado de benchmark de cada hotel; parking (`705.5`) en Habitaciones u Otros; clave de reparto de OC (`PUT /accounting/allocation`); umbrales por hotel y destinatarios de alertas; jornada anual de convenio por centro para el FTE; si los 628.x/629.1/628.4/629.3 deben ir sin `departamento` en `ledger_analytics_maps` (vista por cuenta) o mantener la vista Sage.

---

## §11 · Riesgos

- **Ocupación**: mientras no haya RN reales, cinco hoteles muestran todos los POR como «—»; si se activa `allowDemoOccupancy` para RA, los KPIs se etiquetan `estimated` y jamás entran en alertas ni ranking. La fuente `demo` no debe llegar a producción de Faranda.
- **Dos verdades de ventas**: Sage 705.x vs OPERA vs referencia RRHH (LT 2026-04: 144.379,96 vs 62.948,77 vs 62.948,78). El panel fija el libro como base y declara `salesSource`; si César confirma que Sage trae ingresos brutos o agregados de otro modo, cambian todos los «% s/ ventas» de una vez (una constante, no diez pantallas).
- **Denominador PAR**: `rooms.active` (USALI) vs inventario reportado (cost-report); el panel unifica en `rooms.active` y avisa cuando difieren; `costPerAvailableRoom` de Nóminas y `expensePAR` del panel coincidirán solo cuando el inventario reportado se corrija en `rooms`.
- **Personal heterogéneo en 2026**: FN/LL desde Sage sin grupos ni headcount; el resto desde el lote de nómina; coste por empleado y por grupo solo en 5-6 centros; 2025 sin headcount. Sin doble cómputo verificado (ningún centro-mes con ambas fuentes) pero un lote futuro de FN/LL solapado con Sage lo produciría → guardia de solape por (centro, mes, cuenta 64x) antes de materializar.
- **F&B**: food cost por compras, combinado y sin merma; el «teórico» se etiqueta «sin datos» hasta que `fnb-inventory` tenga recetas con `unitCost`; los benchmarks 28-35 % son de restauración, no de hotel 2-4★ con desayuno incluido.
- **GOP sin oficina central**: con reparto `none` el GOP de cada hotel excluye el coste de OC (personal ene-ago 2026: 838.515,91 € = A&G 688.183,22 + POM 99.052,48 + ROOMS 34.236,25 + S&M 17.043,96, más 626/629.x; 1.244.308,97 € de personal en 2025) mientras el 48,2 % consolidado 2025 sí lo incluye; el panel muestra siempre las dos cifras hasta que se fije la clave.
- **Presupuesto duplicado**: si RRHH construye `LaborBudget` antes que L2, habrá dos presupuestos laborales; ambos diseños deben fijar que las filas `labor` viven en `CostBudget`.
- **Idempotencia de alertas**: `AnomalyEvent` sin índice único → `findFirst` bajo advisory lock; `Notification` in-app sin lector de producto (solo `auth.service.ts` la escribe) → no se escribe hasta que exista lector.
- **Rendimiento**: materializar 8 centros × 19 meses × ~40 KPIs con `buildUsaliPnl` por (centro, mes) son ~150 lecturas del libro por ejecución completa; el scheduler recalcula solo mes en curso y anterior salvo `engineVersion` nuevo.
- **Benchmarks envejecen**: CHSB 2025 son datos 2023 y ya existe CHSB 2026; HotStats es YTD nov-2025; el año va en la etiqueta y la semilla se revisa anualmente (tarea en runbook §20).
- **Permisos**: los lectores de estados exigen internamente `accounting.read` mientras el borde exige `accounting.reports.read` (deuda 14c); el panel exige explícitamente `accounting.reports.read` y no reabre esa deuda.

---

## §12 · Crítica de completitud (2026-09-18): correcciones aplicadas y huecos

Revisión contra el código del working tree, la BD local de Faranda (`SELECT` con la regla de lectura de los estados) y la investigación. Todo lo que sigue está ya corregido en el cuerpo del documento; se deja aquí la traza.

### 12.1 Correcciones de hechos [V]

| # | Dónde | Antes | Ahora | Prueba |
|---|---|---|---|---|
| 1 | §1.2 | 3.994 asientos Sage | 3.990 normales 2025-01-01..2026-07-31 (+416 reversados; 2 apertura, 1 regularización, 1 cierre fuera de la regla) | SQL `journal_entries` por `source_type/status/entry_kind` |
| 2 | §1.6, §10.2 | RA `demo` 37.023 rn; LT 408 días; estancias RA «sept-2026» | RA `demo` 430 días / 36.974 rn / 0 pax + `night_audit` 64 días / 49 rn; LT 409 días / 12.698 rn / 22.752 pax; RA 10 reservas `checked_out` jul-2026..jul-2027 | SQL `revenue_daily_snapshots` de primer nivel, `reservations` |
| 3 | §1.5 (nuevo), §3, §5.4, §10.1 | KPI de suministros, IT, comisiones y margen de Habitaciones atribuidos a los departamentos de `computeUsaliPnl` | En Faranda `routeByCostCentre` mueve 628.x → POM, 629.1 → S&M, 628.4/629.3/6230 → A&G por el `departamento` de Sage; los KPI «(cuenta)» se calculan por cuenta; margen Habitaciones 75,4 % (cuenta) vs 81,0 % (`departmentalProfit`) en 2025; no distribuidos 18,6 % vs 22,9 %; GOP igual por ambas vías | SQL `journal_lines ⋈ cost_centers` por cuenta y cc; `usali.service.ts:96-106` |
| 4 | §3.4 | 629.5 citada en `chart-of-accounts.service.ts:378`; 622.1 en :359 | :378 es 629.9; 629.5, 622.1 y 705.5 no están en la plantilla: son cuentas de la organización creadas por la importación Sage (`admin_general.other_expense`, `pom.other_expense`, `rooms.revenue`) | plantilla :341-439; SQL `accounts` de la org |
| 5 | §3.4, §5.2, §9 L0, §10.3 | `Property.grossFloorAreaM2` nueva | `Property.surfaceM2` ya existe (`schema.prisma:485`, null en los 8 centros); `Property.star_rating` existe (AS 2 · LL/PG/RA 3 · FN/LT/MC 4) y sirve de defecto para la categoría de benchmark | schema + SQL `properties` |
| 6 | §5.3 | Lock «como `server.ts:8750-8753`» | El scheduler de pace (:8750-8772) solo usa `schedulerLeader`; el advisory lock está en el job de modo sombra OPERA (:8863-8871) | `server.ts` |
| 7 | §8 | `CocoaList` | No existe en `components/cocoa`; se usa `CocoaTable density="compact"` + `rowActions` | `ls components/cocoa` |
| 8 | §9 L1 | «9 tests previos»; test de integración «sobre Faranda» | 8 ficheros de test; las suites de `tests/integration/*` crean una organización aislada y nunca tocan Faranda (`financial-statements-reversals.test.mts:5-6`); Faranda se comprueba en la puerta SQL de L6 | `ls __tests__`, cabecera de la suite |
| 9 | §10.1 | RA ingreso 2025 3.267.186 (sin 752); laboral 26,3 % | 3.281.586 (70x + 752, igual que el consolidado); 26,1 % | SQL por hotel |
| 10 | §10.2 | RA julio 2026 398.023,11 € de 70x | 399.223,11 € = 705.x Sage 398.012,78 + 752 1.200,00 + 705 nativo 10,33 | SQL RA 2026-07 |
| 11 | §11 | «~0,77 M€ de A&G de OC en 2026» | Personal de OC ene-ago 2026 838.515,91 € (A&G 688.183,22; POM 99.052,48; ROOMS 34.236,25; S&M 17.043,96); 1.244.308,97 € en 2025 | SQL `payroll_cost_import` por centro y cc |
| 12 | §2.3 | Food cost 28-35 % atribuido a Talent Hostelería/Backbar | Whipplewood/Vanta (28-35 %), Backbar/Provi (18-24 %), KitchenNmbrs (desayuno 25-35 %); Talent: restaurante 28-32 %, cafetería 15-22 % | investigación fnb-cost-control |
| 13 | §1.3, §3.5, §4, §3.3 | `money.ts:31-36`; `:325-326`; `:588-600`; `esrs :29-36`; `fnb :270`; `cost-report :196` | `money.ts:31-43` (`pct()` devuelve «0.00»); goppar/trevpar `:324-325`; `headcount :588-604`; `ESRS_DISCLOSURES :23-47`; `:266-274`; `costPerEmployee :197` | lectura del código |
| 14 | §5.2 | `@@unique` con `propertyId?`/`organizationId?`/`accountPrefix?` | Postgres no deduplica NULL: clave con `organizationId` y centinela `"*"` (patrón `CashClosure.outletId`) | contrato Postgres |
| 15 | §7 | Partial «como el de estados» | El partial de estados declara `accounting.read` y se remapea en el borde; el nuevo declara `accounting.reports.read` directo; `/departments` gana `view=account\|cost_centre` | `finance-report-keys.test.mts:1-8`, `route-permissions.partial.ts:22-33` |

Cifras del documento confirmadas al céntimo [V SQL]: consolidado 2025 (ingreso 23.972.454,52; personal 7.613.515,43 = 31,8 %; coste de ventas A&B 1.778.148,54 = 39,0 %; margen A&B 26,2 %; GOP 11.563.641,06 = 48,2 %; EBITDA 47,7 %; GOPPAR 33,99; TRevPAR 70,47; suministros 3,19 € por RD-día); tabla por hotel 2025 (salvo RA, corregida); coste de personal importado 2026-01..08 (2.442.559,16 = 1.891.222,19 + 551.336,97; 363 celdas; por departamento; 40 referencias, 4.335.144,05 €); 642 ÷ 640 = 29,2 %; RA 2026-06 (todas las cifras de §5.4 y §10.1, con la salvedad del CPOR/margen de Habitaciones por cuenta); LT 2026-04 (Sage 144.379,96 · OPERA 62.948,77 · referencia 62.948,78); 621/625/631/628.x totales; 24 cuentas 6xx con movimiento; `usali_mappings` 0; 46 centros de coste `usali`; tablas operativas a 0; `budgets` 4; `anomaly_events` 2; `configuration_json {}`; julio 2026 completo (16-18 cuentas 6xx y 70x en los 7 hoteles) y agosto solo 640/642 en 6 centros. Referencias a otros diseños comprobadas: `RRHH-PLANTILLA-NOMINA.md:141, 169`, `ASSET-MANAGEMENT-INMOBILIARIO.md:190`, `RBAC-DEPARTAMENTOS.md:55, 62`, `api-contracts.md:221`, `DESIGN-PROPOSAL.md` #9, `COCOA-22.md:238, 256, 257, 286, 287`; ficheros de tests y scripts de §9 existen (`tests/*.test.mjs`, `scripts/*.mjs`, `memory-source.mts`, `cost-import.parser.ts`, `pms-history-forecast-import.md`); `PAYROLL_COST_IMPORT_POSTED` existe (`cost-import.service.ts:1041`); `BUDGET_APPROVED` es nuevo.

### 12.2 Huecos abiertos

1. **Decisión de vista (cuenta vs cc) para Tanda 7c.** Mientras Sage etiquete 628.x/629.1/628.4/629.3 con `departamento`, la pantalla USALI y el panel mostrarán suministros/comisiones/IT en departamentos distintos; hay que decidir si `ledger_analytics_maps` deja esas cuentas sin cc (y re-aplicar los lotes) o si el panel es la única vista «por cuenta». Sin esa decisión los KPI `pom.pct`, `sm.pct`, `ag.pct` tienen dos valores legítimos.
2. **Benchmark de la investigación no cubierto por el catálogo:** no hay desglose España de A&G/IT/S&M/POM en % ingreso (solo agregados HotStats) ni food/beverage cost hotelero español; `CostBenchmark` nace con celdas vacías para esos `kpiCode` y el semáforo `benchmark` no aplica hasta que César aporte cifras propias o se contrate HotStats.
3. **CHSB 2026 (datos 2024) publicado y no consultado**: la semilla usa CHSB 2025; repetir la extracción antes de fijar umbrales `eww.*`.
4. **Fórmula FTE de USALI 12 y las nueve fórmulas laborales de la Parte V** siguen sin texto literal (libro de pago); `labor.fte_por` se documenta como «horas ÷ jornada de convenio declarada» [S].
5. **`OccupancyDeclared` depende de un importador que no existe** (el runbook `pms-history-forecast-import.md` carga snapshots, no un declarado mensual): o se amplía ese importador o se carga por CSV en L1; sin ello AS/FN/LL/MC/PG no tendrán ningún POR.
6. **Superficie y categoría**: `Property.surfaceM2` está vacía y `star_rating` no distingue urbano/resort; `benchmarkCategory` necesita confirmación por hotel (César, §10.3 #6).
7. **Alertas**: `AnomalyEvent.metricCode` lleva el periodo (`<kpiCode>@<propertyId>@<periodCode>`), así que «cerrar al volver a banda» solo aplica dentro del mismo periodo; la deriva de tres meses (§6) necesita un `metricCode` sin periodo o un `anomalyType` propio (`cost_kpi_drift`).
8. **Presupuesto laboral RRHH**: `LaborBudget` de `RRHH-PLANTILLA-NOMINA.md:141` sigue enunciado como tabla propia; ese documento debe actualizarse para apuntar a `CostBudget` (líneas `labor`) o habrá dos presupuestos.
9. **`fnb.food_cost_pct` combinado**: 705.2 no separa comida y bebida y no hay 611; el umbral absoluto 33/36 % se aplica a un ratio de compras combinado (601.1 + 601.2 ÷ 705.2), más alto que el food cost puro; conviene un umbral distinto (`fnb.fb_cost_pct` 36/40) hasta que exista el desglose.
10. **Rendimiento del cálculo por cuenta**: los KPI «(cuenta)» necesitan `accountBalances({ byCostCentre: true, byMonth: true })` con filas por (cuenta, cc, mes); la SQL de `source.ts:441-465` no agrupa por mes, y el flag `byMonth` es nuevo y sin test todavía (L1 lo añade a `memory-source.mts`).
