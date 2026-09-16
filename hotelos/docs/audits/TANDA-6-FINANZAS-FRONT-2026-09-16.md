# Tanda 6 · Finanzas front (Cocoa 22 · ola 6 + Modelos AEAT + TPV/noche) · Cierre — 16 de septiembre de 2026

**Para:** César. **Encargo (literal):** «módulo de finanzas completo y honesto
(nada mock), contabilidad pyme sobre el PGC con presentación USALI, y toda la
UI en Cocoa 22» (canon: Dashboard del director, `/hoy/direccion`). Este
documento cierra la **mitad front** de la Tanda 6: el backend quedó
commiteado en `31bccc9` (`docs/audits/TANDA-6-FINANZAS-BACKEND-2026-09-15.md`)
y aquí se explica qué pantallas lo consumen ya, qué puede hacer un contable
en Anfitorio paso a paso, qué encontró la QA y qué queda.

**Método:** siete lotes de construcción en paralelo (6-A Facturación y
cobros · 6-B Tesorería, conciliación, nóminas y comisiones · 6-C Contabilidad
y estados contables · 6-D Proveedores, gastos e inmovilizado · 6-E TPV, cierre
de caja y cierre del día · 6-F USALI y cuentas anuales · 8-B Modelos AEAT,
libros y liquidación de IVA), una verificación adversarial con navegador (11
hallazgos confirmados, `qa#1`–`qa#12` sin `qa#9`), once lotes de corrección y
este cierre (integrador **sin navegador**). Todo sobre la demo local
(Postgres local, API :3000 y Vite :5173 **sin reiniciar**); **ninguna
escritura en los datos de Faranda** (solo `GET` con la sesión de Carmen): las
pruebas que escriben usaron `org_123`/`prop_123` con la cuenta admin y
restauraron lo restaurable (§7). **Sin commit**: todo está en el árbol de
trabajo de `hotelos/`.

Método de medida: `node scripts/cocoa-22-inventory.mjs` (puntos de deuda por
pantalla), contrato `tests/cocoa-22-contract.test.mjs` (reglas 1–15) y las
puertas de §7.3 del plan `docs/design/COCOA-22-MIGRACION.md`. «Antes» =
inventario commiteado en `31bccc9`; «después» = inventario regenerado en este
cierre.

## 1. Resumen en cifras

| Métrica | Antes (`31bccc9`) | Después (cierre Tanda 6 front) | Δ |
|---|---|---|---|
| Pantallas inventariadas | 200 | 217 | +17 (19 nuevas − 2 muertas retiradas) |
| Líneas en `screens/` | 77.083 | 86.883 | +9.800 |
| **Puntos de deuda Cocoa 22** | **4.600** | **3.833** | **−767 (−16,7 %)** |
| Categoría Finanzas (pantallas · líneas · puntos) | 21 · 8.584 · 618 | 33 · 16.834 · **36** | −582 pts |
| Categoría Cumplimiento | 25 · 6.975 · 787 | 29 · 7.232 · 604 | −183 pts (Modelos AEAT a 0) |
| Categoría Operaciones · Hoy | 26 · 11.216 · 352 · 10 · 4.340 · 17 | 27 · 12.202 · 350 · 10 · 4.601 · 17 | Cierre de caja nace a 0 |
| Ficheros de la tanda (51 de §2, retirados incluidos) | 808 pts | **41 pts** | −767 |
| `.bo-card` · otras `.bo-*` | 762 · 2.820 | 589 · 2.307 | −173 · −513 |
| `<button>` crudos (CocoaButton) | 488 (457) | 419 (642) | −69 (+185) |
| `<table>` crudas (CocoaTable) | 121 (76) | 91 (158) | −30 (+82) |
| Inputs crudos (Cocoa) | 491 (310) | 409 (599) | −82 (+289) |
| `style={` | 3.788 | 3.223 | −565 |
| Colores literales (fallbacks) | 419 (237) | 402 (224) | −17 (−13) |
| `<h1>` crudos · emoji | 42 · 127 | 29 · 115 | −13 · −12 |
| Con cabecera Cocoa · `useTabHost` | 112 · 52 | 139 · 65 | +27 · +13 |
| Tamaños S · M · L · XL | 70 · 103 · 23 · 4 | 82 · 103 · 29 · 3 | |
| `NOT_MIGRATED` = `ALLOWLIST_CEILING` | 153 | **125** | −28 (26 pantallas y contenedores fuera de la allowlist + 2 muertas retiradas) |
| Pendientes (§6 del plan) | 153 ficheros · 61.541 líneas · 4.538 pts | **125 · 51.744 · 3.735** · S 41 · M 63 · L 18 · XL 3 · 17 lotes · 27 contenedores · 4 muertas | −803 pts |
| Techos del contrato (regla 13) | 762 · 488 · 121 · 491 · 419 · 3.788 | **589 · 419 · 91 · 409 · 402 · 3.223** | rebajados al inventario |

Cifras del working tree (sin commit, tras este cierre): 78 ficheros
modificados (+10.679 / −9.540 líneas) · 2 retirados (`billing/InvoiceDetailScreen.tsx`,
`billing/SplitFolioDialog.tsx`, sin importadores) · 62 nuevos (16.884 líneas, este informe incluido):
19 `.tsx` en `screens/` (17 pantallas o cuerpos + 2 contenedores), 10 clientes
tipados en `services/` (1.578 líneas, 55 rutas distintas), 9 módulos puros de
apoyo en `screens/**` (1.849 líneas), `components/billing/**` (735 líneas:
`PaymentDialog`, `RefundDialog`, `payment-flow`, `charge-types`, `download`),
la primitiva `CocoaFileInput`, 2 ficheros de textos del API
(`night-audit-preflight.texts.ts`, `folio/folio-labels.ts`), 16 ficheros de
tests y este informe.

## 2. Pantallas nuevas y migradas (con URL)

Árbol de Finanzas: 8 ítems (≤ 12) · 18 pestañas; más Cumplimiento › Modelos
AEAT (8), Operaciones › Punto de venta › Cierre de caja y Hoy › Cierre del día:
**36 URL**. Roles: `finanzas | direccion | admin` (Recepción solo en
Facturación y cobros y Cierre de caja; Comisiones también `comercial`; TPV
gateado por el módulo `outlet_pos`). Lectura de finanzas: `accounting.reports.read`
(Recepción no ve diario, 303 ni USALI). Puntos = deuda Cocoa 22 antes → después
(`inventario`). **N** = fichero nuevo en esta tanda.

### Finanzas › Facturación y cobros (lote 6-A)

| URL | Pantalla · fichero | Arquetipo | Puntos | Qué hace |
|---|---|---|---|---|
| `/finanzas/facturacion` | `billing/BillingCenterScreen.tsx` | dashboard alojado | 71 → 1 | Folio de la reserva (cargos, cobros, saldo), borrador F1/F2 con líneas por categoría fiscal, emitir (alto riesgo; 409 `TAX_NOT_CONFIGURED` bloquea con motivo), PDF real con QR VeriFactu (`Blob`, nunca `window.print`), marcar pagada (método + referencia), correo («Simulado: proveedor de correo no configurado» cuando lo es), anular (desvincula o devuelve cobros), cobrar/devolver con `PaymentDialog`/`RefundDialog`, logo y avisos legales |
| `/finanzas/facturacion/folios/:id` | `billing/FolioDetailScreen.tsx` (piloto del arquetipo **Detalle**, spec §4.1) | detalle | 21 → 1 | Saldo, cargos y cobros del folio, Cobrar · Devolver · Dividir · Mover cargo (por fila, sin arrastrar) · Cerrar (solo saldo 0); tarjeta «Reserva» con código, titular y estancia |
| `/finanzas/facturacion/rectificativas` | `invoicing/InvoiceRectificationsScreen.tsx` + `InvoiceRectifyDialog.tsx` | dashboard + drawer | 21 + 26 → 0 + 0 | Rectificativas por anulación completa (I) o sustitución (S) contra `POST /invoices/:id/rectify`; resultado con número, huella VeriFactu y PDF; el ajuste de líneas por diferencias (I) queda bloqueado con aviso honesto hasta que el API exponga `InvoiceLine.id` (§7) |
| `/finanzas/facturacion/enrutamiento` | `admin/FolioRoutingScreen.tsx` | formulario | 60 → 1 | Folios secundarios (Empresa, Agencia), reglas origen → destino con prioridad, transferencia de cargos entre folios |

`components/billing/PaymentDialog.tsx` y `RefundDialog.tsx` (**N**) son los
únicos caminos de cobro y devolución del front (también en la pestaña Folio de
`/recepcion/reservas/:id`): método como enumerado, `clientRequestId` por
intento, 202 con redirección al PSP, 409 `PSP_NOT_CONFIGURED` mostrado como tal.

### Finanzas › Tesorería · Conciliación bancaria · Comisiones · Nóminas (lote 6-B)

| URL | Pantalla · fichero | Arquetipo | Puntos | Qué hace |
|---|---|---|---|---|
| `/finanzas/tesoreria` | `operations/FinancePositionDashboard.tsx` | dashboard | 35 → 3 | Posición desde el libro (caja 570, bancos con IBAN enmascarado y desvío frente al extracto, datáfono y pasarela pendientes), cuentas a cobrar y a pagar con antigüedad, previsión 30/60/90 con supuestos; «Cómo se calcula» por bloque |
| `/finanzas/tesoreria/tipos-de-cambio` | `finance/ExchangeRatesScreen.tsx` | formulario | 28 → 0 | Tipos de cambio por divisa y fecha |
| `/finanzas/conciliacion` | `banking/BankReconciliationScreen.tsx` | workspace 4/8 | 46 → 3 | Cuentas bancarias (alta), importar extracto N43/CSV (`CocoaFileInput`; duplicados detectados, 409 si ya importado), sugerencias por línea, conciliar/desconciliar con efecto contable, conciliación automática de confianza alta |
| `/finanzas/conciliacion/extractos-remesas` | `banking/BankingSpainScreen.tsx` | dashboard | 59 → 3 | Extractos importados, remesas SEPA Norma 19 (cobros) y 34 (pagos a proveedores) con estado, validación de IBAN |
| `/finanzas/comisiones` | `commissions/CommissionsScreen.tsx` | dashboard | 35 → 2 | Reglas por canal (alta, desactivar), devengos automáticos al check-out/factura con base y aviso «Base estimada», devengar una reserva, liquidar (fecha, cuenta 572, referencia), anular con motivo |
| `/finanzas/nominas` | `payroll/PayrollScreen.tsx` | dashboard con vistas | 55 → 2 | Contratos (6 modalidades, periodicidad, pagas, IRPF, grupo de cotización), periodos, calcular/recalcular (revierte antes), exportar a3/sage/csv («Validar con la gestoría»), pagar (D 465 / H 572), recibos |

### Finanzas › Contabilidad (lote 6-C · ítem nuevo)

| URL | Pantalla · fichero | Arquetipo | Puntos | Qué hace |
|---|---|---|---|---|
| `/finanzas/contabilidad` | `accounting/JournalScreen.tsx` **N** | lista | — → 1 | Libro diario paginado (keyset, «Cargar más», N de total) con filtros por fechas, origen, estado, cuenta, propiedad y texto; drawer del asiento con apuntes y enlaces original ↔ anulación; asiento manual (drawer con sumas en vivo y confirmación de alto riesgo); anular con motivo y fecha; exportar CSV; deep links `?asiento=` / `#id` («Ver en el diario» desde TPV y caja) y `?cuenta=` |
| `/finanzas/contabilidad/mayor` | `accounting/LedgerScreen.tsx` **N** | lista | — → 1 | Mayor de una cuenta con saldo inicial, Σ debe/haber y saldo final de toda la ventana, saldo corrido, «detalle limitado a 5.000 apuntes» cuando se trunca, CSV |
| `/finanzas/contabilidad/plan-de-cuentas` | `accounting/ChartOfAccountsScreen.tsx` **N** | lista | — → 1 | Plan PGC Pymes hotelero (239 cuentas en Faranda) en árbol, búsqueda y grupo, nueva cuenta (código validado, naturaleza, imputable, USALI), editar (409 `ACCOUNT_HAS_ENTRIES` tal cual), «Ver mayor» |
| `/finanzas/contabilidad/ajustes` | `accounting/AccountingSettingsScreen.tsx` **N** | formulario | — → 0 | Mes de inicio del ejercicio, régimen (REDEME fuerza mensual), periodicidad y figura del IVA, prorrata; estado de la proyección contable y re-proyección (dry-run por defecto; «Contabilizar de verdad» apagado) |
| `/finanzas/contabilidad/cierre-ejercicio` | `finance/YearEndCloseScreen.tsx` | dashboard | 44 → 1 | Ejercicios fiscales, cierre (con apertura del siguiente) y reapertura con motivo; 409 `FISCAL_YEAR_CLOSED` enlaza aquí desde el diario |
| `/finanzas/contabilidad/exportar-gestoria` | `accounting/GestoriaExportScreen.tsx` **N** | lista | — → 1 | Exportaciones a gestoría: CSV universal de asientos y libros de IVA, «compatible Contaplus/Sage 50 Diario» marcado «validar con la gestoría», A3 declarado no implementado (409) |

### Finanzas › Estados contables (lotes 6-C y 6-F)

| URL | Pantalla · fichero | Arquetipo | Puntos | Qué hace |
|---|---|---|---|---|
| `/finanzas/estados-contables` | `finance/TrialBalanceScreen.tsx` | dashboard | 21 → 1 | Sumas y saldos por periodo y propiedad, descarga |
| `/finanzas/estados-contables/balance` | `finance/BalanceSheetScreen.tsx` | dashboard | 23 → 1 | Balance Pymes con subtotales, comparativo, badge Cuadrado/Descuadrado, PDF/XLSX/CSV, drawer con las cuentas de cada partida |
| `/finanzas/estados-contables/perdidas-y-ganancias` | `finance/ProfitAndLossScreen.tsx` **N** | dashboard | — → 0 | PyG Pymes (18 partidas, A/B/C/D) por periodo, comparativo y descarga |
| `/finanzas/estados-contables/flujos` | `finance/CashFlowScreen.tsx` | dashboard | 21 → 2 | Flujos de efectivo por método indirecto, por actividad, conciliación de tesorería («Cuadra con el libro») |
| `/finanzas/estados-contables/cuentas-anuales` | `finance/AnnualAccountsScreen.tsx` **N** | dashboard con vistas | — → 0 | Resumen con los tres cuadres, balance, PyG, patrimonio neto (ECPN), memoria (14 notas: automáticas o «requiere tu aportación», borrador solo en este navegador y lo dice), instantáneas con descarga PDF/XLSX/CSV |
| `/finanzas/estados-contables/usali` | `finance/UsaliScreen.tsx` **N** | dashboard + formulario | — → 0 | PyG USALI departamental con GOP/EBITDA y RevPAR/TRevPAR/GOPPAR/ADR desde el PMS, cobertura del mapeo con «Sin asignar», comparación entre propiedades y entre 2–6 periodos, editor de reglas cuenta → departamento/línea |

### Finanzas › Proveedores y gastos (lote 6-D · ítem nuevo)

| URL | Pantalla · fichero | Arquetipo | Puntos | Qué hace |
|---|---|---|---|---|
| `/finanzas/proveedores` | `payables/SupplierBillsScreen.tsx` **N** | lista | — → 3 | Facturas recibidas por líneas (6xx / 20x-21x, IVA por tipo, retención), flujo borrador → aprobar → contabilizar → pagar (fecha, banco/caja, referencia) o anular con motivo; antigüedad por cubos; adjunto PDF/JPEG/PNG ≤ 512 KiB; asiento de devengo y de pago en el detalle |
| `/finanzas/proveedores/gastos` | `payables/ExpensesScreen.tsx` **N** | lista | — → 3 | Gastos menores con cuenta 6xx, contrapartida 570/572, IVA, adjunto; contabilizar y revertir |
| `/finanzas/proveedores/directorio` | `payables/SuppliersScreen.tsx` **N** | lista | — → 1 | Proveedores con NIF (mod-23/CIF) e IBAN (mod-97) validados por el API, activar/desactivar |
| `/finanzas/proveedores/inmovilizado` | `payables/FixedAssetsScreen.tsx` **N** | dashboard | — → 4 | Registro de elementos (categoría y coeficiente ≤ tablas art. 12 LIS), vista previa mensual con periodos pendientes, corridas mes a mes (409 `PREVIOUS_PERIOD_MISSING` nombra los meses), reverso, baja con resultado y contrapartida 572/570/4300 |

### Cumplimiento › Modelos AEAT (lote 8-B)

| URL | Pantalla · fichero | Arquetipo | Puntos | Qué hace |
|---|---|---|---|---|
| `/cumplimiento/modelos-aeat` (303) · `/390` · `/347` **N** · `/111` · `/115` · `/180` | `fiscal/Modelo{303,390,347,111,115,180}Screen.tsx` (envoltorios de 19 líneas) sobre `fiscal/FiscalModelReport.tsx` **N** | dashboard | 29 · 44 · — · 30 · 28 · 45 → 0 (cuerpo 1) | Un cuerpo para los seis modelos: periodo (trimestre o mes según la periodicidad, ejercicio), ámbito «Toda la organización» (declarable) o «Solo propiedad (vista parcial)», casillas por sección (`casilla: null` → «sin casilla (validar)»), cotejo con el diario Cuadra/No cuadra con diferencias, fuentes (libros/documentos), avisos, detalle virtualizado, «Descargar resumen» (PDF), callout «Presentación manual en la sede de la AEAT» |
| `/cumplimiento/modelos-aeat/libros-iva` | `fiscal/VatBooksScreen.tsx` **N** | dashboard | — → 1 | Libros registro de IVA (emitidas, recibidas, bienes de inversión) por periodo, totales por tipo, CSV local, ajustes de IVA en solo lectura, «Reconstruir libros» (autorización expresa sobre Faranda) |
| `/cumplimiento/modelos-aeat/liquidacion-iva` | `fiscal/VatSettlementScreen.tsx` **N** | dashboard | — → 0 | Vista previa de la liquidación (D 477 / H 472 / H 4750 o D 4700), contabilizar (fecha del asiento) y anular con motivo; 409 `PERIOD_NOT_ENDED`, `NOTHING_TO_SETTLE`, `ALREADY_SETTLED` en español |

`fiscal/ReportErrorCard.tsx` (9 → 0) es la tarjeta de error compartida
(exenta de cabecera en `HEADER_EXEMPT`, espejo en el inventario).

### Operaciones › Punto de venta y Hoy › Cierre del día (lote 6-E)

| URL | Pantalla · fichero | Arquetipo | Puntos | Qué hace |
|---|---|---|---|---|
| `/operaciones/tpv/cierre-de-caja` | `pos/CashClosureScreen.tsx` **N** | workspace 4/8 | — → 0 | Abrir caja con fondo (409 `CASH_CLOSURE_EXISTS` → «Ver el cierre existente»), recuento por los 6 métodos con previsto como pista y recuento físico por 15 denominaciones (el efectivo contado es la suma: el 400 `CASH_COUNT_MISMATCH` no puede producirse desde la UI), cerrar (confirmación con la diferencia y la regla D 659/H 570 · D 570/H 759), aprobar (`accounting.journal.post`), «Ver en el diario» |
| `/operaciones/tpv` | `operations/PosDashboard.tsx` (ya migrada en la tanda A) | workspace | 4 → 2 | Comandas abiertas/cerradas/todas; cierre cash/card = factura simplificada + asiento (enlace al diario); 409 `CASH_CLOSURE_CLOSED` al vender con la caja cerrada |
| `/hoy/cierre-del-dia` | `operations/NightAuditScreen.tsx` (ya migrada) + `night-audit-report.ts` **N** | dashboard | 1 → 1 | Comprobaciones previas en español y con importes es-ES (tras reiniciar :3000), ejecutar el cierre (autorización de César sobre Faranda), informe persistido de la corrida (cargos de alojamiento, cobros por método, ingresos por tipo, avisos de reservas sin tarifa) |

### Contenedores y navegación

`tabs/finanzas/ContabilidadTabs.tsx` **N**, `ProveedoresTabs.tsx` **N**,
`FacturacionTabs`, `TesoreriaTabs`, `ConciliacionTabs`, `EstadosContablesTabs`,
`tabs/cumplimiento/ModelosAeatTabs` y `tabs/operaciones/PuntoVentaTabs` fuera
de la allowlist (0 puntos). `tabs/NavItemTabs.tsx` (qa#12): un contenedor sin
pestañas visibles pinta «Módulo no activado» (con «Activar módulo» si el perfil
tiene `modules.enable`) o «Sin acceso», nunca el texto genérico. Árbol
`pilots/tanda5-nav-tree.csv` → `nav-tree.generated.json`: 66 ítems · 94
pestañas · 205 redirecciones; `BACKOFFICE_ROUTES` 183; `SCREEN_COMPONENTS` 207
claves; presupuesto de marcadores 16/20.

### Primitivas y sistema (integrador · lote primitives)

`CocoaFileInput` (nueva: botón + `<input type="file">` oculto, `accept`,
`maxBytes`, `onPick`/`onReject`), `CocoaKpi caption` (línea secundaria bajo la
cifra), `CocoaTable fit / nowrap / showFrom` (qa#2: una columna corta se ajusta
a su contenido, `align="right"` nunca parte la cifra, una secundaria solo ≥
1200 px), `CocoaDialog initialFocus`. §8.2 de la spec regenerado
(`cocoa-22-api.mjs --check` al día · 40 ficheros · 66 interfaces · 625 props);
§4.1 con la fila «Detalle» (FolioDetail); regla D20 corregida (`tab-helpers.tsx:42`
ya lleva `flex: "0 0 auto"`). La guía viva `/desarrollo/guia-estilo?dev=1` es
la primera consumidora de cada prop nueva (`fit`, `showFrom`, `CocoaFileInput`).

## 3. Qué puede hacer ya un contable en Anfitorio (paso a paso)

Con el rol Contabilidad (`finanzas`; plantilla `accountant`: `accounting.reports.read`,
`accounting.journal.post`, `accounting.configure`, `ai.high_risk.confirm`,
`invoice.issue/cancel`, `banking.reconcile`, `payroll.manage`, `procurement.*`,
`assets.*`, `analytics.export`…) o Dirección/Owner. En Faranda, Carmen (Owner)
tiene todas las claves; los demás roles de Faranda reciben `accounting.reports.read`
con `rbac:sync` (pendiente de tu autorización, backend §6).

1. **Poner la contabilidad en marcha** · `/finanzas/contabilidad/ajustes`: mes
   de inicio del ejercicio, periodicidad y régimen del IVA (trimestral por
   defecto; REDEME → mensual), prorrata. Si la organización no tiene plan, el
   API responde 409 `CHART_NOT_PROVISIONED` y la pantalla lo dice (Faranda ya
   tiene 239 cuentas; el plan se provisiona por CLI, runbook §14).
   `/finanzas/contabilidad/plan-de-cuentas`: revisar cuentas, crear subcuentas
   (`705.5`…), marcar imputables y asignar departamento USALI.
2. **Facturar y cobrar** · `/finanzas/facturacion`: elegir la reserva, revisar
   el folio, «Cobrar» (efectivo, datáfono, transferencia; tarjeta en línea y
   enlace de pago solo cuando exista PSP: hasta entonces 409 honesto), crear el
   borrador de factura (F1 completa o F2 simplificada) con sus líneas por
   categoría fiscal, «Emitir» (congela las líneas, numera la serie, genera la
   huella VeriFactu y el asiento D 4300 / H 705.x / H 477.x en la misma
   transacción), «Descargar PDF», «Marcar pagada» o «Enviar por correo».
   Para corregir una emitida: «Rectificar» → `/rectificativas` (anulación
   completa o sustitución). Para repartir cargos entre huésped, empresa y
   agencia: `/enrutamiento` (folios secundarios y reglas) o «Mover cargo» en
   `/folios/:id`.
3. **Registrar lo que se compra** · `/finanzas/proveedores/directorio`: alta del
   proveedor (NIF e IBAN validados). `/finanzas/proveedores`: «Nueva factura
   recibida» por líneas (cuenta 6xx o 20x-21x, tipo de IVA, retención 15/7 %),
   adjuntar el PDF, «Aprobar», «Contabilizar» (D 6xx / D 472 / H 400 o 4100) y
   «Registrar pago» cuando se pague (D 400 / H 572). Gastos menores en
   `/gastos`. Inmovilizado en `/inmovilizado`: alta con coeficiente, «Vista
   previa» de la amortización del mes y «Contabilizar corrida» (mes a mes, sin
   huecos).
4. **Cuadrar el banco** · `/finanzas/conciliacion`: crear la cuenta (IBAN),
   «Importar extracto» (N43 o CSV), revisar sugerencias por línea, «Conciliar»
   (las liquidaciones de datáfono contabilizan su comisión) o «Conciliar
   automáticamente» las de confianza alta; `/extractos-remesas` para remesas
   SEPA 19/34 (se descargan y se suben al banco a mano). `/finanzas/tesoreria`
   muestra la posición real (libro + último extracto), qué falta por cobrar y
   por pagar y la previsión a 30/60/90 días.
5. **Cerrar el día y la caja** · `/operaciones/tpv/cierre-de-caja`: «Abrir caja»
   con el fondo, al final «Cerrar» con el recuento (la diferencia va a 659/759)
   y «Aprobar». `/hoy/cierre-del-dia`: revisar las comprobaciones previas y
   ejecutar el cierre (carga la noche desde la tarifa; en Faranda solo con tu
   autorización, backend §6).
6. **Liquidar el IVA y presentar modelos** · `/cumplimiento/modelos-aeat`:
   Modelo 303 del trimestre por casilla desde los libros, con «Cotejo con el
   diario»; `/libros-iva` para ver y reconstruir los libros; `/liquidacion-iva`
   para contabilizar la liquidación (solo con el periodo terminado) y anularla
   si hace falta; 390, 347, 111, 115 y 180 en sus pestañas. La presentación es
   manual en la sede de la AEAT («Descargar resumen» en PDF); no hay fichero
   BOE y la pantalla lo dice.
7. **Leer los estados y comparar** · `/finanzas/estados-contables`: sumas y
   saldos, balance, PyG, flujos; `/cuentas-anuales` para el modelo Pymes
   completo (con las tres comprobaciones de coherencia y las notas de la
   memoria que requieren tu aportación) y «Guardar instantánea» antes de
   entregar; `/usali` para el PyG departamental, los ratios por habitación y
   la comparación entre Rías Altas y Los Tilos o entre periodos.
8. **Cerrar el ejercicio y entregar a la gestoría** · `/finanzas/contabilidad/cierre-ejercicio`
   (cierre con apertura del siguiente; reapertura con motivo) y
   `/exportar-gestoria` (CSV universal de asientos y libros; «compatible
   Contaplus/Sage 50» a validar con la gestoría; A3 no implementado).
9. **Nóminas y comisiones** · `/finanzas/nominas`: contratos, abrir el periodo,
   «Calcular», «Exportar» (a3/sage/csv, a validar con la gestoría laboral) y
   «Pagar»; `/finanzas/comisiones`: reglas por canal, devengos automáticos,
   «Liquidar» y «Anular».

Todo lo que escribe pasa por un diálogo de confirmación (`CocoaDialog`, alto
riesgo o destructivo), todo error del API llega en español por `details.code`
(`FINANCE_ERROR_MESSAGES` en `services/finance-contracts.ts`), los importes
viajan como cadenas decimales (`"121.00"`) y se pintan con `money()`, y ningún
estado vacío inventa datos: Faranda hoy no tiene comandas, cierres de caja,
facturas recibidas, inmovilizado, ejercicios fiscales ni corridas de cierre del
día, y las pantallas lo muestran como vacío honesto.

## 4. Lo que sigue siendo simulado o limitado (y lo dice en pantalla)

- Pasarela de pago: 409 `PSP_NOT_CONFIGURED` (tarjeta en línea y enlace de
  pago); el envío de correo con la factura: «Simulado: proveedor de correo no
  configurado»; VeriFactu en sandbox declarado; modelos AEAT con presentación
  manual (sin fichero BOE); exportación A3 (409 `EXPORT_FORMAT_NOT_IMPLEMENTED`);
  «compatible Contaplus/Sage 50» y exportación de nóminas marcadas «Validar con
  la gestoría».
- Rectificativa «Ajuste de líneas por diferencias (I)»: bloqueada con aviso
  hasta que `GET /invoices/:id` exponga `InvoiceLine.id` (§7).
- Notas de la memoria `requires_input`: borrador solo en este navegador
  (`localStorage`), no se incluye en el PDF/XLSX (no hay ruta para persistirlo).
- Inmovilizado heredado (`depreciable = false`): solo «Dar de baja» o registrar
  de nuevo (el `PATCH` del API no admite categoría ni cuenta).
- Reserva de un folio para un rol sin `pms.reservation.read`: la tarjeta
  muestra el id interno como respaldo (ningún rol de las plantillas actuales
  que vea Finanzas lo sufre).
- Modelos 111/115 solo por trimestre en el selector (el API admite mes).
- CSV de Libros de IVA generado en el cliente con las filas en pantalla (no es
  un fichero oficial; el oficial es la exportación a gestoría).
- Cifras USALI por habitación de Faranda minúsculas (0,01 €): 212 habitaciones
  × 259 noches frente a 9 ocupadas — es el dato, no un fallo.
- Modelo 303 2026-Q3 de Faranda «No cuadra con el diario» por 4,55 € (477.10):
  decisión pendiente sobre la rectificativa por sustitución REC-2026-000003
  (art. 15.5 RD 1619/2012 / SII `TipoRectificativa S`), backend §6.

## 5. Hallazgos de la QA y estado (11 confirmados · 11 tratados)

| Id | Sev. | Hallazgo | Estado |
|---|---|---|---|
| qa#1 | media | Cuentas anuales y USALI gateaban `accounting.configure` con la unión demo del login: Carmen no podía guardar instantáneas ni editar el mapeo USALI | **Corregido**: `canDo(useNavGate(), "accounting.configure")` sobre las concesiones reales (misma receta que Plan de cuentas/Diario); test `finance/__tests__/configure-gate.test.mts` |
| qa#2 | media | `CocoaTable` a 1024 aplastaba la columna de texto (Concepto 117 px, 6 líneas) | **Corregido en la primitiva** (`fit`, `nowrap`, `showFrom`; `align="right"` nunca parte la cifra; 16 tests) y **aplicado en este cierre** a `JournalScreen`, `InvoiceRectificationsScreen` y la guía de estilo; la medida a 1024 (sonda §5.4) queda para el lote con navegador |
| qa#3 | media | Balance: el badge «Cuadrado» se encogía a «CUA…» | **Corregido**: el badge sale del clúster `nowrap` con el `CocoaSelect` (cuyo wrapper es `width: 100 %`); test `statement-header-actions.test.mts` vigila la combinación en `finance/**` y `accounting/**` |
| qa#4 | media | Cierre del día: textos del preflight con anglicismos e importes «€764.75»; badges por debajo de 4,5:1 | **Textos corregidos en el API** (`night-audit-preflight.texts.ts`, 9 tests: «13 folios con 764,75 € sin cobrar», «Hora prevista 16:30», «Limpieza: sucia»…) — visibles tras reiniciar :3000; **contraste refutado** (la sonda no componía el alfa de los fondos tintados; corregida en el scratchpad de QA) |
| qa#5 | baja | Detalle de folio: «Tipo» con códigos crudos y tarjeta «Reserva» con el id interno | **Corregido**: vocabulario compartido `components/billing/charge-types.ts` (restaurant → «Restaurante», no_show_fee → «Penalización por no presentarse»), tarjeta con código RES-, titular y estancia (`GET /reservations/:id` de mejor esfuerzo) |
| qa#6 | baja | Etiqueta de folio «guest» sin traducir en Enrutamiento y Tesorería | **Corregido en las dos capas**: `folio/folio-labels.ts` (API: `PRIMARY_FOLIO_LABEL`, «RES-00081 · Huésped» en cuentas a cobrar — tras reiniciar :3000) y `content/data-labels.ts` (front); el valor almacenado no cambia |
| qa#7 | baja | KPI truncados por elipsis (Rectificativas, Tesorería, Modelo 390, Ajustes) | **Corregido por contenido**: código en el valor y motivo en `caption`, «Datáfono y pasarela» + caption, `KPI_LABELS` ≤ 24 caracteres con test |
| qa#8 | baja | Ayuda «Centro de facturación» sin tildes ni eñes | **Corregido**: `content/screen-instructions/billing.ts` reescrito y alineado con lo que la pantalla hace (sin «descuentos por línea», que no existen) |
| qa#10 | baja | Drawer del asiento «por usr_system_accounting_replay»; botón primario a 4,36:1 | **Mitad corregida**: `accounting/actor-label.ts` («Sistema · re-proyección contable», «ti», «otro usuario»; 6 tests). El 4,36:1 del texto blanco sobre `--cocoa-accent` es canon documentado (`COCOA-22.md` §2): decisión de sistema para César, no de pantalla |
| qa#11 | baja | Conciliación a 1024: «Cuentas banca…» | **Corregido**: la acción «Nueva cuenta bancaria» pasa a la fila de acciones de la página; handoff de sistema (cabecera de `CocoaSection` en spans estrechos) en §7 |
| qa#12 | baja | Con `outlet_pos` desactivado: «No hay secciones disponibles para tu perfil» | **Corregido**: `emptyTabsReason` en `tabs/nav-item-tabs.ts` (módulo · módulos desconocidos · rol) + `CocoaState` con «Activar módulo» (6 tests; runbook de navegación actualizado) |

`qa#9` no consta entre los confirmados del veredicto de QA; no hubo lote de
corrección.

## 6. Puertas (2026-09-16, working tree completo, tras este cierre)

| Puerta | Resultado |
|---|---|
| `node scripts/typecheck-all.mjs --parallel 2` | 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 20,9 s |
| `corepack pnpm test` (contratos) | 410/410 (regla 15 de Cocoa 22 verde con el inventario regenerado) |
| `corepack pnpm --filter @hotelos/api test` (unitarios API) | 1.233 (1.232 pass · 1 skipped preexistente · 0 fail) |
| Unitarios front (`node --test` sobre `apps/admin-web/src/**/__tests__/*.test.mts`) | 692/692 |
| `node scripts/check-discoverability.mjs` | 217 screens · 183/183 URLs · 0 enlaces rotos · marcadores 16/20 |
| `node scripts/build-nav-tree.mjs --check` | al día (66 ítems · 94 pestañas · 205 redirecciones) |
| `node scripts/cocoa-22-inventory.mjs` + `cocoa-22-waves.mjs --write/--check` | 217 pantallas · 86.883 líneas · 3.833 puntos · §6 al día (125 pendientes · 3.735 puntos · 17 lotes) |
| `tests/cocoa-22-contract.test.mjs` | 18/18 · `NOT_MIGRATED` 125 = `ALLOWLIST_CEILING` · `GLOBAL_CEILING` 589 · 419 · 91 · 409 · 402 · 3.223 (= inventario) · `STYLE_BUDGET` 33 entradas |
| `node docs/design/cocoa-22-api.mjs --check` · `--typecheck-examples` | §8.2 al día (40 ficheros · 66 interfaces · 53 aliases · 625 props · 159 funciones · 29 constantes) · 11 plantillas · 0 errores |
| `tests/admin-web-spanish-copy-contract` · `admin-web-no-raw-fetch` · `rbac-nav-contract` · `sidebar-nav-contract` | verdes (dentro de los 410) |
| `bash .husky/pre-commit` | OK (discoverability + typecheck-all) |
| `install --frozen-lockfile --offline` | al día (`pnpm-lock.yaml` con las dependencias ya declaradas en `31bccc9`: `@fontsource-variable/inter`, `zod`, `@playwright/test`, `qrcode-terminal`; +52 líneas, va en el commit) |

No ejecutado en este cierre: `test:integration` (escribe en `org_123`/`prop_123`
y los API no se han reiniciado; repetir tras el reinicio, como en el cierre
backend) y la verificación visual §5 (ningún lote de la tanda tuvo navegador
salvo la QA adversarial).

## 7. Pendientes (ordenados por lo que desbloquean)

1. **Reiniciar :3000 y :5173** (tsx sin `watch`): hasta entonces el preflight
   del cierre del día sirve los textos antiguos (qa#4), Tesoreria pinta
   «RES-00081 · guest» (qa#6) y los seeds no usan `PRIMARY_FOLIO_LABEL`.
   Después: `corepack pnpm test:integration` y el recorrido en navegador.
2. **Verificación visual §5** (lote con navegador, Carmen): las 36 URL de §2 a
   1440/1024/390 claro/oscuro, sondas 5.4/5.5, foco y `Esc` en drawers y
   diálogos; medir en concreto qa#2 (`/finanzas/contabilidad` y
   `/rectificativas` a 1024: `th[data-fit="true"]`, Origen ausente < 1200,
   Concepto ≥ 200 px), qa#3 (badge entero a 1440 y 390), qa#11 (título de
   «Cuentas bancarias» sin recorte a 1024 y entre 1200 y 1300), qa#12 (admin
   en `prop_123` con `outlet_pos` apagado: `data-nav-empty="module"`).
3. **API · `GET /invoices/:id` sin `InvoiceLine.id`** (`invoice.service.ts`
   `hydrateInvoiceRecords`, líneas ~655-665): añadir `id: l.id` para desbloquear
   «Ajuste de líneas por diferencias (I)» en `InvoiceRectifyDialog.tsx` (el
   tipo front `InvoiceLineFull.id?` ya lo admite).
4. **API (pequeños, sin bloqueo)**: `POST /accounting/journal/:id/reverse`
   responde 201 cuando el reverso ya existía (→ 200 o 409
   `ENTRY_ALREADY_REVERSED`); `lib/validate.ts` deja el prefijo «Validation
   failed (body)» en inglés y sin `details.code`; `reverseVatSettlement` 404 sin
   `details.code` (`NOT_SETTLED`); no existe `DELETE /accounting/annual-accounts/snapshots/:id`
   (residuo `cmu3e3eiz000rfyob3nkjhkir` en `org_123`); no hay ruta para
   persistir las notas `requires_input` de la memoria; el `PATCH` de
   inmovilizado no admite `category`/`accountCode`; la importación CSV de
   extractos ignora `autoMatch`; rutas legacy de banca sin consumidor
   (`POST /banking/accounts/:id/statements/import-csv`, `/banking/statements/:id/auto-match`,
   `/banking/lines/:id/match`, `POST /banking/sepa/remittances`) candidatas a
   deprecar; `finance-position.service.ts:63` conserva la etiqueta larga
   «Datáfono y pasarela pendientes de liquidar» que el KPI ya no lee.
5. **Producto / RBAC (decisiones tuyas)**: `POST /commissions/rules` exige
   `accounting.journal.post` (Dirección ve Comisiones pero recibe 403 al crear
   reglas: ¿`commissions.manage` para `manager`?); `ROUTING_SOURCE_TYPES`
   ofrece `f_and_b` mientras el TPV publica `restaurant | bar | room_service`
   (una regla «Restauración» nunca mueve las comandas: añadir los tipos o
   normalizar en el API); vocabulario transversal check-in / check-out /
   no-show (conservado a propósito) frente a «registro de entrada/salida» y «no
   presentado»; el 4,36:1 del botón `filled` (canon) frente a AA estricto.
6. **Faranda (escrituras que solo autorizas tú)**: `rbac:sync`, night audit de
   Rías Altas (13/09) y Los Tilos (14/09) tras revisar el preflight (13 folios
   con saldo por 764,75 € y 2 reservas sin presentarse pendientes: datos del
   piloto, no tocados), `POST /fiscal/vat-books/rebuild` por trimestre,
   `accounting:relabel-customer-account` (61 líneas 430 → 4300), criterio de
   REC-2026-000003.
7. **No ejercitado contra datos reales** (verificado por tipos, ramas de error
   y tests): cierre/reapertura de ejercicio (Faranda y `org_123` sin
   ejercicios), `POST /accounting/gestoria-exports` con formato implementado,
   `POST /accounting/replay` con `apply`, corridas de amortización, liquidación
   del IVA (409 `PERIOD_NOT_ENDED` hasta el 2026-10-01; Q1/Q2 «zero»), cierre
   de caja y comandas en Faranda (vacíos), PSP real, adjunto real en base64.
8. **Residuos de las pruebas en `org_123`/`prop_123`** (el motor contable y la
   auditoría son append-only por diseño): asientos 247 (baja de inmovilizado),
   248/249 (manual + anulación, neto 0); proveedor «Lote 6-E prueba» (inactivo),
   factura recibida L6E-001 (anulada), gasto «Prueba lote 6-E» (revertido),
   elemento «Lote 6-E prueba» (dado de baja); instantánea de PyG 2026 «Prueba
   lote 6-F»; cobro de 1,00 € y su reverso en `folio_18392`; entrega de correo
   simulada sobre FAC-2026-000004; `audit_events` de los cierres de caja y
   remesas de prueba (las filas de negocio se borraron por SQL). Faranda
   intacta.
9. **`pilots/screens-inventory.csv`** (fuera de git): columna
   `api_paths_principales` desactualizada en 12 filas (BillingCenter,
   FolioDetail, Rectificativas, FinancePosition, BankReconciliation,
   Commissions, Payroll, BankingSpain, BalanceSheet, Journal,
   AccountingSettings, YearEndClose, SupplierBills/Expenses/FixedAssets,
   Modelo111/115/180/303/390); las rutas reales están en los informes de lote
   y en `services/*Api.ts`. `tests/rbac-nav-contract` sigue verde con el CSV
   actual.
10. **Sistema (opcional, integrador de la siguiente ola)**: `CocoaSelect`
    reclama la línea entera dentro de una fila `nowrap` (prop `width` o nota
    en §8); `tab-helpers.tsx` `actionsStyle` sin `flexShrink: 0` (simetría con
    `CocoaPageHeader`); cabecera de `CocoaSection` con título `nowrap` en spans
    de 4/12 entre 1200 y 1300 px (consulta de contenedor); `CocoaKpi` sin
    `title` al truncar; `CocoaDialog confirmDisabled`; `CocoaRouteTabs
    emptyState`; contrato que prohíba `getUser()?.permissions` fuera de
    `services/`; `night-audit-report.ts` podría derivar sus etiquetas de
    `charge-types.ts`; `NightAuditScreen` usa `apiRequest` en vez de
    `runNightAudit` por la regla CF-05 (`admin-web-no-raw-fetch`).

## 8. Lo que hizo el integrador final (esta pasada)

- Puertas completas repetidas en verde (§6); inventario y §6 del plan
  regenerados; techos del contrato ya rebajados al inventario
  (`ALLOWLIST_CEILING` 125 = `NOT_MIGRATED.length`; `GLOBAL_CEILING` = totales).
- Handoffs cruzados sin dueño, aplicados con el cambio mínimo:
  `accounting/JournalScreen.tsx` e `invoicing/InvoiceRectificationsScreen.tsx`
  con `fit` / `showFrom` / `minWidth` (qa#2), la guía de estilo como primera
  consumidora de `fit` y `showFrom`, «Penalización por no presentarse» en
  `night-audit-report.ts` (+ test), «Aparcamiento» en el selector de cargos de
  la reserva, `PRIMARY_FOLIO_LABEL` en `seeds/chain-reservations.ts`, y
  `scripts/cocoa-22-inventory.mjs` rechaza opciones desconocidas sin escribir
  el JSON (un `--help` lo había regenerado por accidente).
- `CLAUDE.md` (§Sistema de calidad y deuda 14 · Tanda 6) y `docs/design/COCOA-22-MIGRACION.md`
  §0 con el estado tras la tanda.

No hay commit: el árbol queda listo para que lo revises. El commit de la ola
debe llevar juntos las pantallas, `docs/design/cocoa-22-inventory.json`, §6
del plan, las allowlists del contrato, el lockfile y este informe.
