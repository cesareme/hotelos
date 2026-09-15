# Tanda 6 · Finanzas backend (PGC Pymes + USALI + ERP) · Cierre — 15/16 de septiembre de 2026

**Para:** César. **Encargo (literal):** «revisa todo el módulo de finanzas, creo
que hay mucho mock y temas sin terminar»; «el módulo de finanzas debe adaptarse
al Plan General Contable español pero también dar la posibilidad de presentar
las cuentas según USALI para comparar»; «añadir un pequeño módulo contable para
pymes que haga las cuentas, presente el IVA, incluya gastos de proveedores y
otros elementos del PGC; asegurar un ERP potente adaptado a la legislación
fiscal y societaria española».
**Método:** reconocimiento previo en seis dimensiones (144 hallazgos brutos →
57 consolidados: 17 alta · 30 media · 10 baja; `pilots/finanzas/FINANZAS-RECON-2026-09-15.md`),
un lote de schema (contrato de datos + migración), siete lotes de construcción
en paralelo (ledger, IVA/modelos, facturación/cobros, TPV/noche,
proveedores/activos, tesorería/banca, USALI/cuentas anuales), una primera
integración, una revisión adversarial de la integración (15 hallazgos: 6 alta ·
7 media · 2 baja), seis lotes de corrección y este cierre. Todo sobre la demo
local (Postgres local, API :3000 y Vite :5173 sin reiniciar); **ninguna
escritura en las facturas, cobros ni folios de Faranda**: los tests escriben en
`org_123`/`prop_123` o en organizaciones de prueba que crean y borran, y lo
único que se hizo sobre Faranda fue provisionar su plan de cuentas y asentar
su histórico (61 asientos) en la BD local, ambas operaciones idempotentes y
auditadas.

Este documento resume qué era atrezzo y qué es real ahora, las cifras de
Faranda, los hallazgos de la revisión y su estado, lo que el front tiene que
consumir en el siguiente workflow y —lo más importante— lo que solo tú puedes
aportar. Operativa completa: `docs/runbooks/finanzas-contabilidad.md`
(contrato de datos §1, reglas con ejemplos §2, rutas y permisos §13, comandos
§14, límites §15, puertas §16); rutas: `docs/api-contracts.md` «Finanzas ·
módulos».

## 1. Qué era mock y qué es real ahora

| Área | Antes (reconocimiento 15/09) | Ahora (working tree 16/09) |
|---|---|---|
| Plan de cuentas | Plantilla de 78 cuentas solo en `org_123`; Faranda sin plan; `GET /organizations/:id/accounts` devolvía 7 cuentas estáticas inventadas | Plantilla «PGC Pymes hotelero» de 239 cuentas (grupos 1-7, subcuentas hoteleras `705.1-4`, `477.21/10/04`, `472.x`, `5721/5722`, `629.1`, `4759`…) provisionable e idempotente (CLI + auto-provisión al primer asiento); Faranda 239, org_123 249; sin plan → 409 `CHART_NOT_PROVISIONED`, nunca datos falsos |
| Asientos | La proyección fallaba en silencio (`console.error`): 4 asientos en toda la BD, ninguno de factura; sin fecha contable ni número; reabrir ejercicio borraba asientos | Motor único: numeración por ejercicio bajo advisory lock, fecha contable, cuadre exacto en `Decimal`, idempotencia por documento, reversos marcados (nunca se borra), guardia de periodo y de ejercicio cerrado (409 `FISCAL_YEAR_CLOSED`), fallos auditados (`ACCOUNTING_PROJECTION_FAILED`) y replay histórico (CLI y `POST /accounting/replay`, dry-run por defecto) |
| Facturas y rectificativas | No asentaban; la anulación revertía un ingreso nunca asentado; PDF = `window.print()`; «Email enviado» sin enviar nada; NIF emisor `B00000000` | Emisión que congela el folio (snapshot + huella), asiento y libro de IVA en la misma transacción; rectificativas I/S reflejadas en el folio; anulación que desvincula y devuelve cobros; PDF real con QR VeriFactu (escritor PDF y codificador QR propios); email con adjunto por proveedor real o `{ status: "simulated" }` auditado; NIF emisor obligatorio y único por serie |
| Cobros | «Tarjeta» y «Link de pago» registraban `captured` sin PSP; sin idempotencia; tokenización ficticia con PAN en claro; portal del huésped «pagaba» sin cobro | `POST /folios/:id/payments` idempotente por `clientRequestId` y transaccional; Stripe Checkout y Redsys (3DES-CBC + HMAC-SHA256, POST, notificación firmada) por variables de entorno; sin credenciales → 409 `PSP_NOT_CONFIGURED` (nunca `captured`); tokens solo del PSP (`PAN_NOT_ACCEPTED`); webhooks firmados; página de retorno con token HMAC (sin importe para quien no lo tenga) |
| TPV y arqueo | Ventas al contado sin factura simplificada, sin cobro ni IVA; 5 comandas sintéticas en memoria; arqueo = consulta sin persistir | Cada comanda es una fila; cierre cash/card = factura simplificada `SIM` (≤ 400 €) + asiento D 570/5721 / H 705.x / H 477.tipo + fila del libro, todo atómico e idempotente; cargo a habitación tipificado por outlet y tipo de IVA; `CashClosure` persistido (fondo, recuento por método y denominaciones, diferencias con asiento 659/759, bloqueo de ventas, aprobación) |
| Cierre del día | Nunca ejecutado en Faranda; cargaba 136 € inventados | Night audit idempotente por fecha de negocio con informe persistido; cargo de alojamiento desde la tarifa (BAR → plan → total repartido) y aviso de reservas sin tarifa; sin datos inventados |
| IVA y modelos AEAT | 303/390 devolvían 409 para Faranda y, cuando respondían, deducían el IVA por regex sobre descripciones | Libros registro de IVA (emitidas / recibidas / bienes de inversión) como fuente única; 303 por casilla desde los libros, 390, 347 (nuevo), 111/115/180 en `Decimal`; liquidación del IVA como asiento canónico (D 477 / H 472 / H 4750 o D 4700) con reverso; PDF resumen; `presentacion.modo = manual` (el fichero BOE no se afirma) |
| Proveedores, gastos, inmovilizado | Borrador de factura recibida que asentaba a ciegas; sin líneas, sin NIF validado; amortización inexistente | Proveedores con NIF (mod-23/CIF) e IBAN (mod-97) validados; facturas recibidas por líneas (6xx / 20x-21x, IVA por tipo, retención 15/7 %) con flujo borrador → aprobada → contabilizada → pagada / anulada, aging; gastos menores; registro de inmovilizado con coeficientes máximos art. 12 LIS y corridas mensuales sin huecos (409 `PREVIOUS_PERIOD_MISSING`), baja con resultado |
| Tesorería y banca | Tesorería sumaba pagos históricos (880,70 € «pendientes» frente a 574,00 € reales); CSB43 no persistía; comisiones nunca devengaban; nóminas duplicaban asientos al recalcular | Posición desde el libro (570/572 por cuenta) y el último extracto; cuentas a cobrar netas de rectificativas y cobros; cuentas a pagar (proveedores, nóminas, comisiones, 4750/4751/476); previsión 30/60/90; CSB43/CSV persistido con duplicados detectados y conciliación con efecto contable; remesas SEPA 19/34 con estado; comisiones que devengan al check-out/factura (D 629.1 / H 410) y se liquidan; nóminas que revierten antes de recalcular y pagan D 465 / H 572 |
| USALI y cuentas anuales | No existían | USALI 11.ª: mapeo cuenta PGC → departamento/línea editable por organización (defaults en la plantilla), PyG departamental con GOP/EBITDA/PAR/POR/RevPAR/TRevPAR/GOPPAR desde el PMS, comparación entre propiedades y periodos; balance, PyG, ECPN y memoria (14 notas) del modelo Pymes con comprobación de coherencia; snapshots; PDF/XLSX/CSV |
| Exportación a gestoría | No existía | CSV universal de asientos siempre; «compatible Contaplus/Sage 50 Diario» marcado «validar con la gestoría»; libros de IVA en CSV; A3 declarado no implementado (409) |
| Permisos | Recepción veía el diario, el 303 y las cuentas anuales; Contabilidad no podía dar de alta proveedores ni inmovilizado ni exportar | Clave `accounting.reports.read` (informes con importes) frente a `accounting.read` (calendario); plantilla Contabilidad completa (procurement, assets, banking.reconcile, payroll.manage, analytics.export) |
| Calidad | 0 tests de integración del dinero | +34 ficheros de unitarios y +10 suites de integración in-process sobre Postgres (todas limpian sus residuos); 3 contratos documentales nuevos |

Lo que sigue siendo simulado y **lo dice**: el PSP sin credenciales (409), el
email sin proveedor (`simulated`), VeriFactu en sandbox declarado, los ficheros
oficiales de AEAT (resumen JSON/PDF, «presentación manual»), el formato A3.

## 2. Qué se construyó (dónde está)

| Módulo | Ficheros principales | Rutas |
|---|---|---|
| `accounting` (motor, plan, IVA, modelos) | `accounting.service.ts` (motor y consultas), `posting-rules.ts` (+ `posting-rules/*`), `projection.ts` (+ replay), `chart-of-accounts.service.ts` (plantilla y provisionador), `vat-books.service.ts`, `vat-settlement.service.ts`, `modelo-303/390/347/111/115/180.service.ts`, `ledger.routes.ts`, `fiscal.routes.ts`, `customer-account-relabel.ts` | `/accounting/journal*`, `/accounting/ledger/:code`, `/accounting/chart*`, `/accounting/settings`, `/accounting/replay`, `/fiscal/*` |
| `invoicing` | `invoice.service.ts`, `invoice-snapshot.ts`, `simplified-invoice.service.ts`, `invoice-pdf.service.ts` + `pdf/{pdf-writer,qr-encoder}.ts`, `invoice-email.service.ts`, `vat-book.ts`, `ledger.port.ts`, `invoicing.routes.ts` | `/invoices/:id/pdf`, rutas heredadas de emisión/rectificación/anulación/mark-paid/send-email |
| `payments` | `payments.service.ts`, `payments.routes.ts`, `payment-method.ts`, `return-token.ts`, `psp/{stripe,redsys}.adapter.ts`, `env.partial.ts` | `/folios/:id/payments`, `/payments/:id/refund`, `/folios/:id/payment-links`, `/payment-intents/:id`, `/payments/webhooks/:provider`, `/payments/return/:intentId`, `/payment-tokens` |
| `pos` + `night-audit` | `pos.service.ts`, `pos-tax.ts`, `pos-cash-core.ts`, `pos-cash-closure.service.ts`, `pos.routes.ts`; `night-audit.service.ts`, `night-audit.routes.ts`, `pms/room-charge.service.ts` | `/pos/tickets*`, `/properties/:id/pos/{outlets,tickets,cash-summary,cash-closures*}`, `/properties/:id/night-audit/*` |
| `payables` + `fixed-assets` | `suppliers.service.ts`, `supplier-bills.service.ts`, `expenses.service.ts`, `validators.ts`, `money.ts`, `vat-book.ts`, `ledger-port.ts`, `payables.routes.ts`; `fixed-assets.service.ts`, `depreciation.service.ts`, `fixed-assets.routes.ts` | `/organizations/:id/payables/suppliers*`, `/properties/:id/payables/{supplier-bills,aging,expenses}*`, `/properties/:id/asset-register*`, `/organizations/:id/depreciation-runs*` |
| `treasury` (+ banking, commissions, payroll) | `treasury.service.ts`, `ledger-bridge.ts`, `sepa-remittance.service.ts`, `supplier-bill-payment.ts`, `treasury.routes.ts`; `banking/{matching.core,bank-statement,reconciliation}.ts`, `banking-spain/{csb43.parser,sepa-norma19,sepa-norma34}.ts`; `commissions/commission-accrual.service.ts`; `payroll/{periods,export}.service.ts` | `/treasury/*`, `/commissions/*`, `/payroll/periods/:id/{export,pay}` |
| `financial-statements` | `source.ts` (lector único del libro), `usali-mapping.service.ts`, `usali.service.ts`, `annual-accounts.service.ts`, `gestoria-export.service.ts`, `statement-render.ts`, `pdf-writer.ts`, `xlsx-writer.ts`, `financial-statements.routes.ts` | `/accounting/usali/*`, `/accounting/annual-accounts*`, `/accounting/gestoria-exports*` |
| Datos | `packages/database/prisma/schema.prisma` (+495 líneas: 13 enums, 10 modelos nuevos, ampliaciones), migración `20260915140000_finanzas_contabilidad_pgc` (aplicada en local, drift 0), `prisma/seed.ts` (kind/group/level) | — |
| Contratos compartidos | `packages/shared/src/{accounting,fiscal,payments,pos,payables,treasury,financial-statements}-types.ts` (exportados desde `@hotelos/shared`), `permissions.ts` (`accounting.reports.read`, plantillas) | — |
| Scripts | `apps/api/src/scripts/accounting-{provision-chart,replay,relabel-customer-account}.ts` (`accounting:*` en `apps/api/package.json`) | — |

Cifras del working tree (sin commit, tras este cierre): 62 ficheros modificados
(+11.257 / −5.523 líneas) y 82 rutas nuevas sin seguir (35.624 líneas, tests
y docs incluidos); 114 entradas de permisos en los diez partials de finanzas; 34
ficheros de unitarios y 10 suites de integración nuevos.

## 3. Faranda tras el replay (BD local, solo lectura)

- Plan de cuentas: 239 cuentas (0 → 239, `ACCOUNTING_CHART_PROVISIONED`).
- `accounting:replay --org cmrhw9jy30002fyvb6tsdiugt --from 2026-01-01 --to 2026-12-31`:
  dry-run 60 documentos / 0 fallos; apply → **61 asientos** numerados 1..61 en
  el ejercicio 2026 (22 facturas, 4 rectificativas —incluida la reversión
  marcada de FAC-2026-000018 sustituida por REC-2026-000003—, 8 anulaciones,
  23 cobros, 4 devoluciones), **150 líneas, Σ debe = Σ haber = 2.595,00**,
  ninguna línea sin cuenta; segundo dry-run: 60 «ya existían». Facturas de
  Faranda: 11 F1 emitidas, 3 R1, 8 anuladas, 3 rectificadas; 23 cobros por
  533,80 €.
- Saldos: clientes 430 D 379,00 (61 líneas: D 1.487,00 / H 1.108,00 —
  pendientes de trasladar a `4300`, §6), 570 caja 87,10, 5721 datáfono pendiente
  320,40, 572 banco 44,20, 477.10 −37,83, 477.21 −32,56, 4759 tasa turística
  −3,18, 705 −297,43 (17 facturas AUDIT emitidas sin categoría fiscal → cuenta
  genérica), 705.1 alojamiento −218,18, 705.2 restauración −56,81, 705.3 otros
  −184,71.
- Modelo 303 2026-Q3 (servicio, sin sesión, libros derivados de los
  documentos): casilla 27 = 71 = 74,94 (13 filas al 10 %: base 423,62 / cuota
  42,38; 6 al 21 %: 155,04 / 32,56), 45 = 0; 18 filas al 0 % (`ES_UNKNOWN_0`,
  IVA sin configurar cuando se emitieron: 227,10 € de base) en avisos; cotejo
  con el diario `cuadra = false` por **4,55 €** en 477.10: REC-2026-000003
  (sustitución, base 36,36 / cuota 3,64) se cuenta íntegra en los libros
  mientras el diario anuló FAC-2026-000018 (45,45 / 4,55). Q2 vacío. 347/2026
  vacío (33 filas sin NIF por 607,60 €).
- Tablas que siguen a 0 en Faranda por diseño (no se ha operado): `vat_settings`,
  `vat_book_entries` (los modelos derivan en memoria hasta `POST /fiscal/vat-books/rebuild`),
  `pos_orders`, `cash_closures`, `night_audit_runs`, `supplier_bills`,
  `fixed_assets`, `depreciation_runs`, `usali_mappings`, `gestoria_exports`.
- Las 33 comandas «cerradas» de Rías Altas (202,98 € + 81,10 €) que citaba el
  reconocimiento no existen en ninguna tabla ni captura: eran el tablero
  sintético en memoria del TPV, ya eliminado.

## 4. Revisión adversarial de la integración: 15 hallazgos, 15 corregidos

| Id | Sev. | Hallazgo | Estado |
|---|---|---|---|
| t6#1 | alta | Venta TPV al contado asentada dos veces (port síncrono + proyección de `InvoiceIssued`) | Corregido: un solo asiento `pos_ticket/<ticket>` compartido por port, proyección y replay; anulación devuelve tesorería |
| t6#2 | alta | Balance/PyG/ECPN/USALI excluían el asiento revertido pero incluían su reverso (resta doble) | Corregido: regla única de lectura (no borradores, fuera de parejas de anulación), idéntica a sumas y saldos; la gestoría conserva ambas mitades |
| t6#3 | alta | El motor aceptaba asientos dentro de un ejercicio cerrado | Corregido: 409 `FISCAL_YEAR_CLOSED` en todo escritor salvo cierre/reapertura |
| t6#4 | alta | Cuenta de clientes distinta por escritor (`430` vs `4300`) | Corregido: `4300` única; CLI de traslado (aplicado en org_123; Faranda pendiente de tu autorización) |
| t6#5 | alta | IDOR en `GET /payment-intents/:id` | Corregido: tenencia con 404 opaco |
| t6#6 | alta | `GET /payroll/contracts|periods` aceptaban `?organizationId` ajeno | Corregido: ámbito por `resolveOrganizationScope` + contrato que impide el patrón |
| t6#7 | media | El replay contaba las filas de devolución como cobros | Corregido: las filas con `reversalOfId` no se replayean |
| t6#8 | media | Cotejo 303 restaba dos veces cada anulación | Corregido: lee `posted+reversed`, excluye liquidación/cierre/apertura |
| t6#9 | media | Recepción abría diario, mayor, 303, libros, cuentas anuales y USALI | Corregido: clave `accounting.reports.read`; propagación a los roles existentes por `rbac:sync` (pendiente en Faranda) |
| t6#10 | media | Contabilidad sin proveedores, inmovilizado ni exportación | Corregido en la plantilla `accountant` |
| t6#11 | media | `POST /payroll/contracts` y `/commissions/rules` sin validación (500) | Corregido: zod estricto, 404 opaco para perfiles/canales ajenos |
| t6#12 | media | Amortización con meses saltados | Corregido: mes a mes sin huecos, `pendingPeriods` en la vista previa |
| t6#13 | media | Mayor de cuenta cargaba todo el diario en memoria | Corregido: consulta acotada en SQL; totales completos aunque el detalle se trunque |
| t6#14 | baja | Esquemas del dinero sin `.strict()` | Corregido (folios y, en este cierre, rectificativa y ejercicio fiscal) |
| t6#15 | baja | Página de retorno del PSP revelaba importes | Corregido: token de retorno HMAC de 7 días |

Detalle, decisiones y lo que se dejó deliberadamente sin cambiar: runbook §12.

## 5. Lo que el front debe consumir (siguiente workflow)

Ninguna pantalla de `admin-web` consume todavía las rutas nuevas; los
contratos están en `packages/shared/src/*-types.ts` (importes como cadenas
`"121.00"`, fechas `AAAA-MM-DD`, errores con `details.code`). Por pantalla:

| Pantalla (hoy) | Cambio | Rutas / contrato |
|---|---|---|
| Reserva · Cobrar (`ReservationWorkspaceScreen.tsx:604`, `pmsCommerceApi.applyPayment`) | Enviar `method` como enum (`cash · card_terminal · card_online · bank_transfer · payment_link · other`), `clientRequestId` (uuid por intento, reutilizado en reintentos) y `reference`; tratar `kind: "payment"` (201/200) y `kind: "payment_intent"` (202 con `redirect` GET url o POST fields → abrir el PSP); 409 `PSP_NOT_CONFIGURED` → mostrar `details.psp.message`, nunca «cobrado» | `POST /folios/:id/payments`, `POST /folios/:id/payment-links`, `GET /payment-intents/:id`, `GET /properties/:id/payments/psp-status` (`PaymentWire`, `CapturedPaymentResponse`, `PaymentIntentWire`) |
| Devoluciones | Enviar `clientRequestId`; la respuesta trae `reversal` e `idempotent`; en el folio, `payments[].kind === "refund"` son reversos | `POST /payments/:id/refund` |
| Facturas (`InvoiceDetailScreen.tsx:307/352`, `BillingCenterScreen.tsx:367`) | «Descargar PDF» → blob de `GET /invoices/:id/pdf?download=1` (no `window.print`); «Marcar pagada» con diálogo de método + referencia (400 sin ellos); «Enviar email» muestra «Simulado: proveedor de email no configurado» cuando `simulated = true`; rectificativa «I» con `lineAdjustments[{ lineId, quantity?, unitPrice? }]` | `GET /invoices/:id/pdf`, `POST /invoices/:id/mark-paid { method, reference, amount? }`, `POST /invoices/:id/send-email`, `POST /invoices/:id/rectify`, `POST /invoices/:id/cancel { refundPayments }` |
| Portal del huésped (`guest-web`) | Página de pago que consuma `redirect` del intento y vuelva por `GET /payments/return/:intentId?t=` | `GET /guest-portal/session/:token/folio`, `…/pay` |
| Contabilidad · diario / mayor / plan / ajustes (pantallas nuevas) | Diario paginado por keyset con filtros; asiento manual (alto riesgo); anulación con motivo; mayor con «detalle limitado a 5.000 apuntes; totales y saldo final completos» cuando `truncated`; selector de cuentas que excluye `isPostable = false` y muestra jerarquía por `parentCode`; ajustes (mes de inicio del ejercicio, periodicidad/régimen de IVA); capturar 409 `FISCAL_YEAR_CLOSED` (enlace a reabrir) y `CHART_NOT_PROVISIONED` | `GET /accounting/journal?from&to&propertyId&sourceType&status&accountCode&q&limit&cursor&envelope=1`, `GET /accounting/journal/:id`, `POST /accounting/journal`, `POST /accounting/journal/:id/reverse`, `GET /accounting/ledger/:code`, `GET /accounting/journal/export`, `GET|POST /accounting/chart`, `PATCH /accounting/chart/:code`, `GET|PATCH /accounting/settings`, `POST /accounting/replay`, `GET /accounting/projection/status` (`accounting-types.ts`) |
| Modelos AEAT (`Modelo303Screen.tsx:56/97/107/112`, 111/115/180/390) | Nuevo contrato `FiscalModelReport`: `casillas[]` (`casilla: null` → «sin casilla (validar)»), `totales`, `avisos`, `fuentes` (origen libros/documentos, cotejo `diario.cuadra/diferencias`), `detalle[]`, `presentacion.modo = manual`; botón «Descargar resumen» (PDF); pantallas nuevas de libros de IVA, ajustes de IVA y liquidación (vista previa → contabilizar → revertir) | `GET /fiscal/models/:modelo?period=2026-Q3|2026-09` o `?year=2026`, `GET …/pdf`, `GET /fiscal/vat-books?book=&period=`, `POST /fiscal/vat-books/rebuild`, `GET|PUT /fiscal/vat-settings`, `GET|POST /fiscal/vat-settlement`, `POST /fiscal/vat-settlement/reverse` (`fiscal-types.ts`) |
| TPV (`posApi.ts`, `PosDashboard.tsx`) | Ticket con `taxTotal`, `businessDate`, `invoiceId/invoiceNumber`, `journalEntryId`, `cashClosureId`, `lines[].productId`; `?status=open|closed|all`; pantalla de cierre de caja (abrir con fondo → recuento por método y denominaciones → cerrar → aprobar) y 409 `CASH_CLOSURE_CLOSED` al vender con caja cerrada | `GET /properties/:id/pos/tickets?status=`, `GET|POST /properties/:id/pos/cash-closures`, `GET …/:closureId`, `POST …/:closureId/close { countedByMethod, counts, notes }`, `POST …/:closureId/approve` (`pos-types.ts`) |
| Cierre del día | Informe persistido de la corrida (`NightAuditReportWire`), paso `payments_summary` (antes `reconcile_payments`), avisos de reservas sin tarifa | `GET /properties/:id/night-audit/runs/:runId`, `POST …/night-audit/run` |
| Proveedores, facturas recibidas, gastos (pantallas nuevas) | Alta de proveedor (NIF/IBAN validados en servidor, 400 en español); factura recibida por líneas con selector de cuentas 6xx/2xx sin cabeceras, flujo aprobar → contabilizar → pagar, adjunto ≤ 512 KiB; aging por cubos; gastos rápidos | `/organizations/:id/payables/suppliers*`, `/properties/:id/payables/supplier-bills*`, `…/aging?asOf=`, `…/expenses*` (`payables-types.ts`, `PayablesErrorCode`) |
| Inmovilizado y amortización (pantallas nuevas) | Registro de elementos (categoría/coeficiente ≤ tablas), vista previa mensual con `pendingPeriods` (deshabilitar «Contabilizar» y ofrecer los meses en orden), 409 `PREVIOUS_PERIOD_MISSING`, baja con `counterAccountCode 572|570|4300` | `/properties/:id/asset-register*`, `/organizations/:id/depreciation-runs*` |
| Tesorería (`FinancePositionDashboard`) y banca (`BankingSpainScreen`, `BankReconciliationScreen`, `bankingApi.ts`) | Usar `labels`, `banks`, `warnings`, `kpis.pendingSettlements`; `Csb43ImportResult` con `statementId`, `persisted`, `newLines`, `duplicateLines`, `warnings`, `matches[].matchType`; sugerencias y conciliación por línea (`matchType payment|card_settlement|supplier_bill|payroll_period|commission_accrual|bank_fee|bank_interest|manual`), desconciliar; remesas con estado | `GET /treasury/position|receivables|payables|forecast`, `POST /treasury/bank-accounts/:id/statements/import`, `GET /treasury/bank-lines/:id/suggestions`, `POST|DELETE /treasury/bank-lines/:id/reconcile`, `POST /treasury/statements/:id/auto-reconcile`, `/treasury/sepa/*` (`treasury-types.ts`) |
| Nóminas y comisiones (`PayrollScreen.tsx:471-509`, `CommissionsScreen.tsx:147`) | Mostrar el `message` de los 400 (en español, con la clave rechazada); `contractType` ∈ 6 modalidades; exportar con `POST /payroll/periods/:id/export` y pagar con `POST …/pay`; devengo automático de comisiones visible con base y aviso cuando se estima | `POST /payroll/contracts`, `POST /commissions/rules`, `POST /payroll/periods/:id/export|pay`, `POST /commissions/accrue`, `POST /commissions/accruals/:id/settle|reverse` |
| USALI, cuentas anuales y gestoría (pantallas nuevas) | Editor de mapeo con `coverage.unmappedAccounts` como aviso; PyG USALI con bloque «Sin asignar» siempre visible y ratios; comparación entre propiedades y periodos; cuentas anuales con `coherence.ok`, avisos y notas de la memoria `requires_input`; snapshots y descargas PDF/XLSX/CSV; exportación a gestoría con `implemented`/`validateWithAdvisor` por formato | `/accounting/usali/mappings|coverage|pnl|compare|periods`, `/accounting/annual-accounts*`, `/accounting/gestoria-exports*` (`financial-statements-types.ts`) |
| Navegación y permisos | Gating de las entradas de Finanzas por `accounting.reports.read` (no `accounting.read`, que solo abre el calendario fiscal); Recepción no ve diario/303/USALI | `packages/shared/src/permissions.ts` |

## 6. Lo que solo tú puedes aportar (y lo que queda por autorizar)

| Tema | Qué hace falta |
|---|---|
| Pasarela de pago | `STRIPE_SECRET_KEY` (`sk_test_`) + `STRIPE_WEBHOOK_SECRET` **o** `REDSYS_MERCHANT_CODE/TERMINAL/SECRET_KEY/MODE`, más `PAYMENTS_PUBLIC_BASE_URL`; registrar el webhook en Stripe o la URL de notificación en el TPV Virtual de Redsys; una prueba real contra `sis-t.redsys.es` (el vector de firma es autogenerado). Hasta entonces el API responde 409 `PSP_NOT_CONFIGURED` de forma honesta. |
| Banco | Extractos N43 reales, IBAN/BIC de las cuentas e identificador de acreedor SEPA; si se quiere API bancaria (PSD2/agregador) es un lote nuevo — hoy la remesa se descarga y se sube al banco a mano. |
| Gestoría | Programa que usa (Contaplus/Sage, A3, otro) y una importación de prueba del CSV universal; A3 exige su diseño de registro; validar la numeración de 390/347 y si hace falta el fichero de presentación de la AEAT. |
| VeriFactu y certificados | Certificado electrónico, `VERIFACTU_SOFTWARE_*` de la declaración responsable, paso sandbox → producción. |
| IVA de Faranda | Confirmar trimestral (por defecto) o REDEME mensual, prorrata y si hay actividad en Canarias/Ceuta/Melilla (IGIC/IPSI hoy fuera del 303 con aviso). Y el criterio de la rectificativa por sustitución REC-2026-000003 (restar la sustituida en los libros: art. 15.5 RD 1619/2012 / SII `TipoRectificativa S`) — cambia el 303 2026-Q3 en 4,55 €. |
| Nóminas | Convenio y bases de cotización reales o mantener las nóminas en la gestoría laboral y aquí solo asentarlas. |
| Email | `EMAIL_PROVIDER` + clave en el VPS (Postmark/SendGrid). |
| Faranda: operaciones que escriben en el piloto (autorización expresa, backup y API parados) | 1) `accounting:relabel-customer-account --org cmrhw9jy30002fyvb6tsdiugt` (61 líneas 430 → 4300; si los libros ya estuvieran legalizados, asiento manual D 4300 / H 430 por 379,00). 2) `rbac:sync` (8 roles reciben `accounting.reports.read` y las claves ERP; hasta entonces Contabilidad/Dirección/Cumplimiento con RBAC estricto reciben 403 en diario/303/USALI). 3) Night audit de Rías Altas (13/09) y Los Tilos (14/09), día a día tras revisar el preflight. 4) `POST /fiscal/vat-books/rebuild` por trimestre. 5) Decidir los 17 asientos de facturas AUDIT en `705` genérica y las 33 filas al 0 %. 6) En el VPS: `db:migrate:deploy` → `db:drift:check` → `db:generate` → reiniciar API → provisionar plan por organización → replay. |
| Front | Prioridad de las pantallas de §5. |

## 7. Puertas (2026-09-16, working tree completo)

| Puerta | Resultado |
|---|---|
| typecheck-all | 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) |
| Discoverability | 200 screens · 167/167 URLs · 0 broken links · placeholders 16/20 |
| Contratos (`tests/*.test.mjs`) | 410/410 |
| Unitarios API | 1.220 (1.219 pass · 1 skipped preexistente · 0 fail) |
| Integración (14 suites in-process sobre Postgres) | 194 (189 pass · 5 skipped preexistentes · 0 fail) |
| env-census / validate-env | 136/136 · contrato OK |
| Migraciones | 5/5 aplicadas · drift 0 · migraciones↔schema 264 tablas / 24 enums |
| Fresh-install (BD temporal) | OK (264 tablas, 79 permisos, 4 s) |
| `install --frozen-lockfile --offline` | al día (cierra la deuda 12(a) del lockfile) |
| `rbac:sync --dry-run` | 221 claves · +0 · 8 roles por completar (no aplicado) |
| `.husky/pre-commit` | OK |

No hay commit: el árbol queda listo para que lo revises. Los API :3000 y
:5173 siguen sirviendo el código anterior; tras reiniciarlos toca repetir
`test:integration` y un recorrido en navegador (el front aún no consume las
rutas nuevas, así que ese recorrido es del siguiente workflow).

## 8. Deuda técnica que queda (resumen; detalle en `CLAUDE.md` §14 y runbook §12/§15)

- Servicios de lectura que exigen `accounting.read` internamente mientras el
  borde exige `accounting.reports.read` (sin efecto en las plantillas; sí en
  un rol custom con solo la clave nueva).
- Mayor de cuenta (incluye ambas mitades de una anulación) frente a estados
  (las excluyen): coinciden dentro de la ventana, difieren para reversos
  fechados en un periodo posterior; una factura anulada tras declarar el
  periodo debe ir por rectificativa.
- `SepaRemittance` sin modelo (remesas en `worker_job_runs`); dispatcher de
  notificaciones sin adjuntos; `Payment.method` y `JournalEntry.sourceType`
  siguen `String`; `JournalLine` sin `@@index([accountId])`;
  `openingAccumulatedDepreciation` inexistente; duplicado residual de
  simplificada entre dos instancias del API; PDF/XLSX sin diseño; adjuntos
  inline (≤ 512 KiB) y exportaciones inline (≤ 20 MB) por falta de almacén
  de objetos; PAR USALI sin habitaciones fuera de servicio; fecha de negocio
  del TPV en hora local frente a Europe/Madrid del asiento.
- Reverso huérfano `cmu37gqkt0015fym4g9fcl0y4` en org_123 (residuo de test; no
  cuenta en los estados; se deja como está).
- Cadena de auditoría en memoria bifurcada por los CLI ejecutados con el API
  en marcha (deuda 12(c)): se resuelve en el próximo reinicio.
