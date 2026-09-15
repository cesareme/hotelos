# Runbook · Finanzas y contabilidad (PGC Pymes + USALI)

Estado al cierre de la **Tanda 6 · Finanzas (2026-09-16, integración final)**:
diez módulos cableados en `server.ts` con sus partials de permisos, un solo
motor de asientos, plan «PGC Pymes hotelero» provisionado para Faranda y
org_123, histórico de Faranda asentado en la BD local (61 asientos, Σ debe =
Σ haber = 2.595,00), los 15 hallazgos de la revisión adversarial corregidos
(§12) y todas las puertas en verde (§16). Índice de lo operativo: §11
integración · §12 correcciones · §13 rutas y permisos por módulo · §14
comandos · §15 límites y lo que solo César puede aportar · §16 puertas.
Informe de cierre para César: `docs/audits/TANDA-6-FINANZAS-BACKEND-2026-09-15.md`.

Historial: lote «schema» aplicado en la BD local el 2026-09-15 (migración
`20260915140000_finanzas_contabilidad_pgc`, drift 0, cliente Prisma regenerado)
y plan de cuentas «PGC Pymes hotelero» provisionado para Faranda
(`cmrhw9jy30002fyvb6tsdiugt`, 239 cuentas) y org_123 (249 = 78 heredadas + 171).
Este documento es el **contrato de datos** de la tanda de finanzas: los demás
lotes (facturación, cobros, TPV/arqueo, proveedores y gastos, nóminas,
comisiones, amortizaciones, IVA/AEAT, cuentas anuales/USALI, exportación a
gestoría, front) usan estos nombres tal cual. Origen del encargo: «revisa todo el
módulo de finanzas, creo que hay mucho mock y temas sin terminar»; «adaptarse
al PGC español y presentar las cuentas según USALI para comparar»; «pequeño
módulo contable para pymes: cuentas, IVA, gastos de proveedores y otros
elementos del PGC». Diagnóstico previo: `pilots/finanzas/hallazgos-brutos.md`.

Convenciones de todo el módulo: dinero en `Decimal` (Prisma.Decimal), nunca
float; redondeo a 2 decimales por línea y cuadre al céntimo del total; zod
estricto en los bodies; errores 4xx tipados con `details.code`; mensajes en
español; comentarios de código en inglés.

## 1. Contrato de datos

Todo lo que sigue está en `packages/database/prisma/schema.prisma` (sección
`Finanzas · contabilidad PGC Pymes`) y en la migración de la tanda. Los
campos marcados «heredado» existían antes y se mantienen por compatibilidad.

### 1.1 Enums

| Enum | Valores | Uso |
| --- | --- | --- |
| `AccountKind` | `asset` · `liability` · `equity` · `income` · `expense` | Naturaleza PGC de la cuenta (`Account.kind`). `Account.accountType` (texto) queda como alias heredado: `revenue` ≡ `income`; balance/PyG/cash-flow siguen leyéndolo hasta que migren a `kind`. |
| `PaymentMethod` | `cash` · `card_terminal` · `card_online` · `bank_transfer` · `payment_link` · `other` | Método canónico de cobro (`Payment.methodCode`). Contrapartida: cash→570, card_terminal→5721, card_online→5722, bank_transfer→572, payment_link→5722, other→572. |
| `SupplierBillStatus` | `draft` · `approved` · `posted` · `paid` · `cancelled` | Ciclo de la factura recibida. `posted` = asiento de devengo creado; `paid` = asiento de pago creado. |
| `ExpensePaidWith` | `cash` · `card` · `bank` | Con qué se pagó el ticket (570 · 5721 [572 si es tarjeta de débito de empresa] · 572). |
| `FixedAssetStatus` | `active` · `fully_depreciated` · `disposed` | Ciclo del elemento de inmovilizado. |
| `DepreciationRunStatus` | `draft` · `posted` · `reversed` | Corrida mensual de amortización. |
| `CashClosureStatus` | `open` · `closed` · `approved` | Arqueo: abierto (turno) → cerrado (recuento) → aprobado (dirección). |
| `VatBook` | `emitidas` · `recibidas` · `bienes_inversion` | Libros registro de IVA (RD 1619/2012). |
| `VatBookSourceType` | `invoice` · `rectification` · `simplified` · `supplier_bill` · `expense` | Documento origen de una fila del libro. |
| `VatPeriodicity` | `quarterly` · `monthly` | Modelo 303 trimestral (general) o mensual (REDEME / gran empresa). |
| `VatRegime` | `general` · `redeme` · `recargo` | Régimen de IVA de la organización. |
| `FinancialStatementKind` | `balance` · `pyg` · `ecpn` · `memoria` · `usali` | Estado guardado en `FinancialStatementSnapshot`. |
| `GestoriaExportFormat` | `csv_universal` · `contaplus_diario` · `a3` · `vat_books_csv` | `csv_universal` SIEMPRE; `contaplus_diario`/`a3` solo con diseño de registro validado (`validateWithAdvisor=true` mientras tanto). |

Enums **documentales** (columnas que siguen siendo texto porque los escritores
heredados las tipan como `string`; los lotes nuevos DEBEN usar exactamente estos
valores):

- `JournalEntry.sourceType`: `folio_line` · `payment` · `payment_refund` ·
  `invoice` · `invoice_rectification` · `invoice_cancellation` · `pos_ticket` ·
  `supplier_bill` · `supplier_bill_payment` · `expense` · `payroll_slip` ·
  `payroll_payment` · `commission` · `depreciation` · `vat_settlement` ·
  `cash_closure` · `card_settlement` · `tourist_tax` · `manual` ·
  `regularization` · `closing` · `opening` · `reversal` · `fixed_asset_disposal`
  (baja de inmovilizado: D 28xx / D 671 / [D 572|570|4300] / H 21x / [H 771],
  lote proveedores-activos).
- Convenciones de `sourceId` (idempotencia por `(organizationId, sourceType,
  sourceId)`): factura → `invoiceId`; rectificativa por sustitución «S» →
  además `<rectId>:supersedes:<origId>` para la reversión marcada de la
  sustituida; venta TPV al contado → `pos_ticket` / `posOrderId` (UN solo
  asiento: el port síncrono del TPV, `InvoiceIssued` y el replay comparten la
  clave, t6#1); cobro → `paymentId`; devolución → `PaymentRefund.id`;
  liquidación del IVA → `vat-settlement:<periodo>`; liquidación de datáfono →
  `card_settlement` / id de la línea bancaria; comisiones e intereses
  bancarios → `manual` / `bankline:<id>:fee|interest`; anulación de factura
  recibida → `supplier_bill_cancel:<billId>`; reverso de gasto →
  `expense_reversal:<expenseId>`; corrida de amortización → `<runId>` (y
  `<runId>#n` al recontabilizar una anulada); reverso de corrida →
  `depreciation_reversal:<runId>`; reapertura de ejercicio → `year-reopen:*`.
  Tras un reverso, el mismo documento vuelve a contabilizarse con
  `sourceId#n` (`treasury/ledger-bridge.ts`: volver a pagar una nómina tras
  desconciliar).
- `JournalEntry.entryKind` (heredado): `normal` · `regularization` · `closing` ·
  `opening` · `reversal`.
- `Payment.method` (heredado, texto libre): `cash` · `card` · `bank_transfer` ·
  `payment_link` · `ota_virtual_card`. Los lotes nuevos escriben `methodCode` **y**
  `method` (compatibilidad con `folio.service.postPayment`, que sigue
  escribiendo `method`).
- `FixedAsset.category`: `mobiliario` (10 %) · `instalaciones` (10 %) ·
  `informatica` (25 %) · `construcciones` (3 %) · `vehiculos` (16 %) ·
  `intangible` · `otro` — coeficientes máximos de tablas art. 12 LIS.
- `CommissionAccrual.status`: `accrued` · `settled` · `reversed`.
- `UsaliMapping.usaliDepartment` / `usaliLine`: ver §4.

### 1.2 Plan de cuentas

**`Account`** (tabla `accounts`, única por `(organizationId, code)`):

| Campo | Semántica |
| --- | --- |
| `code` | Código PGC: grupo (1 dígito), subgrupo (2), cuenta (3), subcuenta (`4300`, `5721`, `705.1`, `477.21`). Los códigos con punto son las subcuentas analíticas hoteleras de las reglas canónicas. |
| `name` | Nombre oficial en español (plantilla) o el que puso la organización. El provisionador NUNCA renombra. |
| `kind` | `AccountKind`. |
| `accountType` | Alias heredado (`revenue` ≡ `income`). Se escribe siempre a partir de `kind`. |
| `group` (columna `pgc_group`) | 1-7 en Pymes. |
| `level` | 1 grupo · 2 subgrupo · 3 cuenta · 4 subcuenta. |
| `isPostable` | `false` en grupos y subgrupos: no admiten apuntes. Las cuentas de 3 dígitos siguen siendo contabilizables (compatibilidad con los apuntes heredados a `705`/`477`), pero las reglas canónicas contabilizan en la subcuenta más específica. |
| `parentId` | Cabecera (prefijo existente más largo): `477.21` → `477` → `47` → `4`. |
| `usaliDepartment` / `usaliLine` | Mapeo USALI por defecto de la plantilla (solo cuentas de PyG contabilizables). `UsaliMapping` lo sobreescribe por organización. |

`AccountingSetting` (heredada): la fila de organización (`propertyId = null`)
lleva `chartTemplate = "pgc_pymes_hotelero_v1"` cuando el plan está
provisionado. Una organización sin esa fila (o con `chartTemplate` null) es una
organización **sin plan**: la proyección contable debe fallar en voz alta
(`details.code = "CHART_NOT_PROVISIONED"`), nunca en silencio.

**`UsaliMapping`** (`usali_mappings`, única por `(organizationId, accountPrefix)`):
`accountPrefix` (código exacto o prefijo, p. ej. `62`), `usaliDepartment`,
`usaliLine`, `priority`, `active`. Resolución (§4): coincidencia activa de mayor
`priority`; a igualdad, el prefijo más largo; sin coincidencia → valor por
defecto de la cuenta (o de su prefijo en la plantilla); sin nada → «sin mapear»
(la línea USALI «Sin asignar» debe mostrarse, nunca desaparecer).

### 1.3 Diario

**`JournalEntry`** (`journal_entries`):

| Campo | Semántica |
| --- | --- |
| `entryDate` (`DATE`, NOT NULL, default hoy) | **Fecha contable** (devengo). Ordena el diario, fija ejercicio y periodo, filtra balance/PyG/303. `postedAt` es solo el instante técnico de la proyección. Los escritores heredados no la pasan (queda la fecha del día = lo que hacían con `postedAt`); los lotes nuevos la pasan SIEMPRE (fecha de factura, de cobro, de nómina…). |
| `entryNumber` (`Int?`) + `fiscalYearCode` (`String?`) | Número de asiento secuencial por `(organizationId, fiscalYearCode)`, único (índice `journal_entries_organization_id_fiscal_year_code_entry_numb_key`). `fiscalYearCode` = `FiscalYear.code` si existe el ejercicio, si no el año natural de `entryDate` (`"2026"`). `null` = pendiente de numerar: SOLO puede dejarlo así un escritor heredado; el lote asientos numera al contabilizar (`max+1` dentro de la transacción con `pg_advisory_xact_lock(hashtext(organizationId || fiscalYearCode))`) y una tarea de saneamiento numera lo heredado en orden `(entryDate, postedAt, id)`. Los 4 asientos existentes quedaron numerados 1-4 en `2026` por la migración. |
| `description` | Concepto en español (diario, exportación a gestoría). |
| `reference` | Documento: número de factura, nómina, extracto, cierre. |
| `reversalOfId` / `reversedById` | Asiento inverso total. Reabrir un ejercicio genera asientos de anulación (`sourceType = reversal`, `entryKind = reversal`) marcados así; **nunca se borra un asiento** (`fiscal-year.service.reopen` debe dejar de hacer `deleteMany`). |
| `sourceType` / `sourceId` | Documento origen (valores en §1.1); `(organizationId, sourceType, sourceId)` es la clave de idempotencia de la proyección (índice nuevo). |
| `status` | `draft` · `posted` · `reversed` (heredado). **Regla única de lectura de los estados** (fix t6#2, 2026-09-16): balance, PyG, ECPN, memoria, USALI, sumas y saldos y la regularización del cierre cuentan todo asiento con `status ≠ draft` que **no** sea mitad de una pareja de anulación marcada (`reversed_by_id IS NULL AND reversal_of_id IS NULL`) — el mismo criterio que `accounting.service.aggregateAccountBalances` (`LEDGER_ENTRY_COUNTS_SQL` en `financial-statements/source.ts`). El libro diario, el mayor de una cuenta y la exportación a gestoría conservan las DOS mitades (art. 28 CCom: la anulación es una operación, nunca se borra). Consecuencia asumida: una pareja a caballo de dos periodos (original en Q1, reverso fechado en Q2) queda fuera de ambos en los estados por periodo; una factura anulada después de declarar el periodo se documenta con rectificativa (art. 15 RD 1619/2012), que genera su propio asiento y no es pareja marcada. |
| `fiscalYearId`, `entryKind`, `currencyCode`, `fxRate`, `createdBy`, `propertyId` | Heredados, misma semántica. |

**`JournalLine`** (`journal_lines`): `accountCode` (`String?`, = `Account.code`
del `accountId`; `null` solo en filas heredadas, ya rellenado por la migración
para las 10 existentes; los lotes nuevos lo escriben SIEMPRE), `costCenterId`
(`CostCenter.id`, para el reparto USALI de personal/suministros),
`taxRateCode` (`"21"`, `"10"`, `"4"`, `"7"`, `"3"`, `"2"`, `"0"` en líneas de
cuota 472/477 y en la línea de base que la acompaña), `taxBase` (base imponible
asociada a una línea de cuota, para que el 303 no reconstruya la base desde la
cuota). Regla de líneas: importes siempre **positivos** en `debit` o `credit`
(nunca líneas negativas); una rectificativa es un asiento en sentido contrario.

### 1.4 IVA

**`VatSettings`** (`vat_settings`, una fila por organización): `periodicity`,
`regime`, `prorrataPct` (null = deducción íntegra), `taxFigure` (`IVA` ·
`IGIC` · `IPSI`). Sin fila → trimestral, general, IVA. El lote IVA/AEAT la crea
al primer uso (`ensureVatSettings`).

**`VatBookEntry`** (`vat_book_entries`): una fila por documento **y tipo
impositivo** (una factura con 10 % y 21 % son dos filas), única por
`(organizationId, book, sourceType, sourceId, rate)`. Campos: `book`, `date`
(expedición en emitidas; recepción/devengo en recibidas), `series`, `number`,
`counterpartyNif`, `counterpartyName`, `base`, `rate` (%), `quota`, `total`,
`retention` (IRPF practicada en recibidas de profesionales/alquileres),
`taxFigure`, `surchargeRate`/`surchargeQuota` (recargo de equivalencia),
`sourceType`, `sourceId`, `period` (`"2026-Q3"` o `"2026-09"`, calculado con
`VatSettings` al registrar), `deductible` (false → la cuota va a gasto; tickets
sin NIF del destinatario), `propertyId`. **Es la fuente única del Modelo
303/390/347**: la fila se escribe en la misma transacción que la factura
emitida/rectificativa/simplificada, la factura recibida contabilizada o el
gasto; las cuotas de una rectificativa van con signo negativo en `base`/`quota`
(en el libro sí; en el asiento, en sentido contrario).

Escritores (todos dentro de la transacción del documento; `delete + insert`
por clave, idempotentes): `invoicing/vat-book.ts` (`writeIssuedVatBookRows`:
emitidas F1/F2/R, contra-filas negativas de anulación y sustitución) y, para
otros lotes, `accounting/vat-books.service.ts` (`registerInvoiceInVatBooks`,
`registerInvoiceCancellationInVatBooks` — fila negativa fechada en `cancelledAt`
con `sourceId = <invoiceId>:anulacion`, porque `VatBookSourceType` no tiene
valor `cancellation` —, `registerSupplierBillInVatBooks` — recibidas +
bienes_inversion por línea y tipo; solo `posted`/`paid` —,
`registerExpenseInVatBooks`); `payables/vat-book.ts` escribe recibidas y
bienes de inversión al contabilizar la factura recibida o el gasto y **borra**
sus filas al anular (decisión del lote; si el periodo ya se declaró, el lote
IVA puede preferir filas negativas). `POST /fiscal/vat-books/rebuild
{ period | from,to }` rematerializa un rango por transacción (auditoría
`VAT_BOOKS_REBUILT`). Cuando un rango no tiene filas materializadas, los
modelos derivan las mismas filas en memoria desde `Invoice`+`InvoiceLine` /
`SupplierBill` / `Expense` y lo declaran (`fuentes.origen = "documentos"` +
aviso): nunca responden 409 por falta de libro.

### 1.5 Facturación y cobros

**`Invoice`** (heredada + nuevos): `snapshotJson` (líneas, totales, desglose de
IVA e ids de `FolioLine` congelados al emitir: `{ lines, totals, taxBreakdown,
folioLineIds }`; inmutable después; el PDF y VeriFactu se generan desde aquí),
`seriesCode` (`InvoiceSequence.sequenceCode`: `FAC` para F1, `SIM`
simplificada F2 — es la serie que numera `simplified-invoice.service`; el
runbook decía `FS` y no existe ninguna secuencia `FS` —, `REC` rectificativa), `simplified` (art. 4 RD 1619/2012: serie
propia, sin NIF de cliente hasta 400 € IVA incluido; la restauración y otras
actividades del art. 4.2 admiten hasta 3.000 €), `customerRequired` (`false`
solo en simplificadas dentro de límite). `issuerTaxId`/`issuerLegalName`
(heredados, Tanda 2) son el snapshot del emisor: el lote facturación deja de
aceptar `issuerTaxIdPlaceholder = true` al emitir.

**`Payment`** (heredada + nuevos): `clientRequestId` (clave de idempotencia del
cliente, única por folio: `@@unique([folioId, clientRequestId])`; un reintento
con la misma clave devuelve el mismo cobro), `methodCode` (`PaymentMethod?`;
`null` = fila heredada, el lector cae a `method`; la migración rellenó las 25
existentes: cash→cash, card→card_terminal, bank_transfer→bank_transfer),
`reversalOfId` (cobro que este registro deshace: importe positivo, asiento
inverso; el original pasa a `status = refunded`), `journalEntryId`.
`PaymentIntent` y `PaymentProviderConnection` se mantienen **pendientes de PSP**:
un cobro `card_online`/`payment_link` debe nacer como `PaymentIntent` y
convertirse en `Payment` solo cuando el PSP confirme; sin PSP cableado la UI no
puede marcar `captured` (hoy lo hace: hallazgo alta).

**`PosOrder`** (heredada + nuevos): `invoiceId` (factura simplificada de la venta
al contado), `journalEntryId` (D 570|5721 / H 705.2 / H 477.tipo),
`cashClosureId`, `taxTotal`, `businessDate` (fecha de negocio; la migración la
rellenó con el día local de `closedAt` para los tickets cerrados). Una venta con
`settlement = room` no genera asiento ni factura: queda en el folio hasta la
factura. Las ventas al contado del TPV **no crean `Payment`** (no hay folio):
el arqueo suma `Payment` (cash/card_terminal del día) + `PosOrder` cerrados con
`settlement` cash/card del `businessDate`.

**`CashClosure`** (`cash_closures`, única por `(propertyId, outletId,
businessDate)`; `outletId = "*"` = caja de recepción): `openingFloat`,
`expectedCash` (= fondo + cobros en efectivo − devoluciones en efectivo − gastos
pagados en efectivo), `countedCash`, `difference` (= contado − esperado),
`expectedByMethodJson`/`countedByMethodJson` (`{ cash: {expected, counted,
difference}, card_terminal: {...}, ... }`, importes como string decimal),
`countsJson` (recuento por denominación y lotes de datáfono), `notes`,
`openedBy`/`closedBy`/`approvedBy`/`approvedAt`, `journalEntryId` (diferencia de
arqueo: faltante D 659 / H 570; sobrante D 570 / H 759; y traspaso a banco si
procede), `status`.

### 1.6 Proveedores y gastos

**`Supplier`** (heredada + nuevos): `taxId` = NIF/CIF normalizado (mayúsculas,
sin espacios); `nifValidatedAt` (cuándo pasó la validación de dígito de control
NIF/NIE/CIF; null = sin validar), `address`, `postalCode`, `city`, `province`,
`countryCode`, `iban` (para SEPA Norma 19/34; sin cifrar como `BankAccount.iban`),
`defaultExpenseAccountCode` (6xx por defecto de sus facturas),
`retentionRate` (15 profesionales, 7 nuevos profesionales, 19 alquileres),
`retentionRowCode` (clave Modelo 111 `02` / Modelo 115).

**`SupplierBill`** (heredada + nuevos): `organizationId` (`null` solo en filas
heredadas; el lote proveedores lo escribe siempre = `Property.organizationId`),
`baseTotal`, `status` (`SupplierBillStatus`), `journalEntryId` (devengo),
`paidJournalEntryId` (pago), `postedAt`, `approvedAt`/`approvedBy`,
`cancelledAt`, `documentObjectKey` (= adjunto), única por `(organizationId,
supplierId, invoiceNumber)` (una factura de proveedor no puede entrar dos veces).
Cuadre: `total = baseTotal + taxTotal − retentionAmount`, con `baseTotal = Σ
base`, `taxTotal = Σ quota` de las líneas.

**`SupplierBillLine`** (`supplier_bill_lines`, FK a la factura, cascade):
`lineNo`, `description`, `expenseAccountCode` (6xx, o 21x/20x si
`investmentGood`), `base`, `taxRate`, `quota` (redondeada por línea), `retention`,
`costCenterId`, `investmentGood` (→ libro de bienes de inversión y alta de
`FixedAsset` con `fixedAssetId`).

**`Expense`** (`expenses`): gasto menor / ticket pagado en el acto: `date`,
`supplierName`, `supplierNif`, `concept`, `accountCode` (6xx), `base`, `taxRate`,
`quota`, `total`, `paidWith`, `vatDeductible` (true solo con factura completa o
simplificada con NIF del destinatario; si false la cuota se suma al gasto),
`receiptObjectKey`, `journalEntryId`, `reversalJournalEntryId`/`cancelledAt`
(un gasto contabilizado no se borra: se revierte).

### 1.7 Inmovilizado

**`FixedAsset`** (heredada + nuevos): `organizationId` (`null` solo heredadas;
la migración rellenó la existente), `category`, `accountCode` (21x/20x),
`depreciationAccountCode` (28xx por elemento: 2811 construcciones, 2812
instalaciones, 2816 mobiliario, 2817 informática, 2818 vehículos, 2806
aplicaciones informáticas), `expenseAccountCode` (681 material, 680 intangible),
`coefficientPct` (≤ máximo de tablas), `startDate` (puesta en condiciones de
funcionamiento; null = `acquisitionDate`), `residualValue`, `status`,
`disposedAt`, `supplierBillId`. `usefulLifeMonths`/`depreciationMethod`/
`accumulatedDepreciation` son heredados: `accumulatedDepreciation` se actualiza
con cada corrida.

**`DepreciationRun`** (`depreciation_runs`, única por `(organizationId,
period)`, `period = "YYYY-MM"`): `periodStart`/`periodEnd`, `status`,
`totalAmount`, `journalEntryId` (un asiento D 68x / H 28xx con una línea por
elemento), `reversalJournalEntryId`. **`DepreciationLine`** (FK a la corrida,
única por `(runId, fixedAssetId)`): `amount` (= coste − residual × coeficiente /
12, redondeado por elemento; el último mes ajusta al céntimo para que
acumulado + residual = coste), `accumulatedAfter`, `netBookValueAfter`.

Regla de las corridas (fix t6#12, 2026-09-16): **mes a mes y sin huecos**. Un
periodo solo se contabiliza cuando lo están todos los meses anteriores en los
que algún elemento tuviera cuota; tras la última corrida contabilizada la
cadena es consecutiva; la primera corrida de la organización arranca en la
puesta en funcionamiento más antigua de sus elementos amortizables; los meses
sin cuota (elementos aún no en servicio, totalmente amortizados, dados de baja
o sin coeficiente) no se exigen. `POST /organizations/:id/depreciation-runs`
responde 409 `PREVIOUS_PERIOD_MISSING` con `details.pendingPeriods` y
`details.latestPostedPeriod` antes de crear fila alguna; `GET
…/depreciation-runs/preview?period=` devuelve `pendingPeriods` (vacío cuando
se puede contabilizar). Base: amortización sistemática (PGC NRV 2.ª.2.1) y
coeficiente anual de tablas (art. 12.1 LIS). Sin amortización acumulada de
apertura (`createFixedAsset` fija `accumulatedDepreciation = 0`): un elemento
heredado con puesta en funcionamiento en un ejercicio cerrado exigiría los
meses históricos y el motor respondería `FISCAL_YEAR_CLOSED` (cambio de schema
pendiente: `openingAccumulatedDepreciation`).

### 1.8 Nóminas y comisiones

**`PayrollPeriod`** (heredada + nuevos): `journalEntryIds` (asientos de devengo,
uno por nómina, `sourceType = payroll_slip`), `reversalJournalEntryIds` (sus
inversos al recalcular: recalcular NUNCA deja asientos huérfanos ni duplica
gasto), `postedAt`, `reversedAt`, `paymentJournalEntryId` (D 465 / H 572),
`paidAt`.

**`CommissionAccrual`** (heredada + nuevos): `journalEntryId` (D 629.1 / H 410,
devengo en check-out o factura según la regla), `reversalJournalEntryId`,
`settledAt`/`settlementJournalEntryId` (liquidación al canal: D 410 / H 572),
única por `(propertyId, reservationId, channelCode)` (una comisión por reserva
y canal; un re-devengo actualiza la fila tras revertirla).

### 1.9 Estados y exportación

**`FinancialStatementSnapshot`** (`financial_statement_snapshots`):
`organizationId`, `fiscalYearId?`, `kind`, `periodFrom`/`periodTo`, `json`
(el estado completo tal como se presentó), `label`, `generatedAt`/`generatedBy`.

**`GestoriaExport`** (`gestoria_exports`): `format`, `periodFrom`/`periodTo`,
`objectKey` (almacén) o `inline` (ficheros pequeños), `rowCount`,
`validateWithAdvisor`, `createdBy`. CSV universal de asientos: columnas
`fecha, asiento, cuenta, concepto, debe, haber, documento, nif, base, iva`
(una fila por línea de asiento, `;` como separador, UTF-8 con BOM, importes con
coma decimal).

## 2. Reglas contables canónicas (PGC de Pymes)

Copia literal del encargo; son las reglas que implementan los lotes y contra las
que se escriben los tests de integración (cada regla con su cuadre al céntimo).

- **Factura emitida**: D 4300 (total) / H 705.x (base por departamento) / H
  477.tipo (cuota) [/ H 4759 tasa turística]. (El encargo decía «430»; la
  cuenta de clientes es UNA para todos los escritores, la subcuenta `4300`
  — `CUSTOMER_ACCOUNT_CODE` en `packages/shared/src/accounting-types.ts` —, y
  `430` queda como cabecera de `4300`/`4304`; fix t6#4.) **Rectificativa (R1-R4)**: asiento
  inverso proporcional con importes positivos en sentido contrario (nunca
  líneas negativas). **Anulación**: inverso total.
- **Cobro**: D 570 (efectivo) | 5721 (tarjeta datáfono) | 572 (transferencia) |
  5722 (enlace de pago / PSP) / H 4300. **Liquidación datáfono**: D 572 / D 626
  (comisión) / H 5721. **Devolución**: inverso.
- **TPV al contado**: factura simplificada (serie propia `SIM`, sin NIF de
  cliente hasta 400 €) y D 570|5721 / H 705.2 / H 477.tipo. **Cargo a
  habitación**: sin asiento hasta la factura (queda en el folio).
- **Factura recibida**: D 6xx (por línea) / D 472.tipo / H 400|410; retención
  profesional: H 4751 (15 % o 7 %); **pago**: D 400|410 / H 572.
- **Nómina**: D 640 / D 642 / H 476 (SS trabajador + empresa) / H 4751 (IRPF)
  / H 465; **pago**: D 465 / H 572.
- **Comisión de canal**: D 629.1 / H 410 (devengo en check-out o factura, según
  regla).
- **Amortización mensual**: D 681 / H 281x por elemento; coeficientes máximos de
  tablas art. 12 LIS (mobiliario 10 %, instalaciones 10 %, equipos informáticos
  25 %, construcciones 3 %, vehículos 16 %).
- **Liquidación de IVA del periodo**: D 477 / H 472 / H 4750 (a ingresar) o D
  4700 (a compensar/devolver).
- **Regularización**: 6xx → 129 ← 7xx; cierre y apertura; **reabrir = asientos
  de anulación marcados (`reversalOfId`), nunca borrar**.
- **Libros de IVA** (RD 1619/2012): emitidas y recibidas con fecha,
  serie-número, NIF, base, tipo, cuota, total; bienes de inversión. **Modelo
  303**: devengado por tipo (casillas 01-09), soportado corriente (28-29) y
  bienes de inversión (30-31), resultado (64-71); periodicidad trimestral o
  mensual (REDEME) por organización; **390** anual; **347** operaciones con
  terceros > 3.005,06 € por NIF y trimestre; **111/115/180** desde
  `WithholdingTaxRecord`. Exportación AEAT: resumen por casilla en JSON y PDF;
  fichero oficial solo con diseño de registro BOE correcto (si no, «presentación
  manual en la sede»).
- **USALI (11.ª ed.)**: departamentos operativos Habitaciones / Alimentos y
  bebidas / Otros departamentos operados / Ingresos varios; no distribuidos
  Administración y general, Tecnología, Ventas y marketing, Mantenimiento (POM),
  Suministros; GOP; honorarios de gestión; no operativos (alquiler, impuestos
  sobre la propiedad, seguros); EBITDA; ratios PAR/POR, RevPAR, TRevPAR, GOPPAR
  con datos del PMS. Tabla de mapeo cuenta PGC → línea USALI editable por
  organización con valores por defecto (§4).
- **Cuentas anuales PGC Pymes**: balance (activo no corriente/corriente;
  patrimonio neto, pasivo no corriente/corriente), PyG (70x, 60x, 64x, 62x/631,
  68x, resultado de explotación, financiero, antes de impuestos, 630,
  resultado), ECPN pymes, memoria (plantilla con las notas obligatorias).
  Exportación a gestoría: CSV universal SIEMPRE; Contaplus/Sage 50 Diario y A3
  solo con diseño de registro validado.

Las cuentas que usan estas reglas están en
`CANONICAL_RULE_ACCOUNT_CODES` (`chart-of-accounts.service.ts`); el test de la
plantilla exige que todas existan y el provisionador informa si alguna faltase
tras un run.

### 2.1 Ejemplos de asiento tal como los produce el motor

Todos los importes son `Decimal` redondeados a 2 decimales por línea (HALF_UP)
y cuadran al céntimo; las líneas son siempre positivas en un solo lado. Regla
→ función pura de `apps/api/src/modules/accounting/posting-rules.ts` (o del
módulo indicado) → asiento.

| Regla (función) | Documento de ejemplo | Asiento |
| --- | --- | --- |
| Factura emitida F1 (`buildInvoiceEntry`; en la emisión HTTP, `invoicing/invoice-snapshot.buildInvoiceJournalLines`) | 1 noche 100,00 base al 10 % + parking 6,05 base al 21 % (cuota 1,27) | D 4300 117,32 / H 705.1 100,00 / H 477.10 10,00 (`taxRateCode 10`, `taxBase 100,00`) / H 705.3 6,05 / H 477.21 1,27 (`taxBase 6,05`) |
| Cobro con datáfono (`buildPaymentEntry`) | cobro `card_terminal` de esa factura | D 5721 117,32 / H 4300 117,32 |
| Liquidación del datáfono (`buildCardSettlementEntry`) | abono bancario 115,56 con comisión 1,76 | D 572 115,56 / D 626 1,76 / H 5721 117,32 |
| Devolución (`buildPaymentRefundEntry`) | devolución de 20,00 en efectivo | D 4300 20,00 / H 570 20,00 |
| Anulación (`buildInvoiceReversalEntry`, reverso marcado con `reversalOfId`) | anulación de la F1 anterior el día `cancelledAt` | D 705.1 100,00 / D 477.10 10,00 / D 705.3 6,05 / D 477.21 1,27 / H 4300 117,32 |
| Rectificativa «I» por diferencias (`buildInvoiceEntry` sobre la R con importes negativos → lado contrario) | R1 que rebaja el parking a 5,00 base (−1,05 base, −0,22 cuota) | D 705.3 1,05 / D 477.21 0,22 / H 4300 1,27 |
| Venta TPV al contado (`buildInvoiceEntry` con `settledInAct`, clave `pos_ticket`) | ticket bar 24,00 IVA incluido al 10 % en efectivo (base 21,82, cuota 2,18) | D 570 24,00 / H 705.2 21,82 / H 477.10 2,18 |
| Diferencia de arqueo (`buildCashClosureDifferenceEntry`) | faltante de efectivo 3,00 | D 659 3,00 / H 570 3,00 (sobrante: D 570 / H 759) |
| Factura recibida (`buildSupplierBillEntry`, `payables/supplier-bills.service.ts`) | lavandería base 200,00 al 21 % | D 607 200,00 / D 472.21 42,00 / H 400 242,00 |
| Factura recibida de profesional con retención | asesoría base 500,00 al 21 %, IRPF 15 % | D 623 500,00 / D 472.21 105,00 / H 4751 75,00 / H 410 530,00 |
| Pago a proveedor (`buildSupplierBillPaymentEntry`) | transferencia de la anterior | D 410 530,00 / H 572 530,00 |
| Gasto menor sin NIF (`buildExpenseEntry`) | ticket de taxi 12,10 pagado en efectivo, IVA no deducible | D 624 12,10 / H 570 12,10 (con NIF: D 624 10,00 / D 472.21 2,10 / H 570 12,10) |
| Nómina (`posting-rules/payroll.ts`, `postPayrollPeriod`) | bruto 1.800,00; SS trabajador 6,35 % = 114,30; SS empresa 30,5 % = 549,00; IRPF 15 % = 270,00 | D 640 1.800,00 / D 642 549,00 / H 476 663,30 / H 4751 270,00 / H 465 1.415,70 |
| Pago de nóminas (`buildPayrollPaymentEntry`) | transferencia del neto | D 465 1.415,70 / H 572 1.415,70 |
| Comisión de canal (`commissions/commission-accrual.service.ts` al `GuestCheckedOut`/`InvoiceIssued`) | reserva OTA 300,00 al 15 % | D 629.1 45,00 / H 410 45,00; liquidación al canal (`buildCommissionSettlementEntry`): D 410 45,00 / H 572 45,00 |
| Amortización mensual (`buildDepreciationEntry`, `fixed-assets/depreciation.service.ts`) | mobiliario 12.000,00 al 10 % (residual 0) | D 681 100,00 / H 2816 100,00 (una pareja por elemento en el mismo asiento; primer mes prorrateado por días, último mes cierra al céntimo) |
| Baja de inmovilizado (`fixed-assets.service.buildDisposalLines`) | camas coste 12.000, amortizado 1.100, venta 5.000 por banco | D 2816 1.100,00 / D 572 5.000,00 / D 671 5.900,00 / H 216 12.000,00 |
| Liquidación del IVA (`buildVatSettlementEntry`, `vat-settlement.service.settlementLinesFrom`) | 2026-Q3 con 477.10 37,83 y 477.21 32,56 repercutido, sin soportado | D 477.10 37,83 / D 477.21 32,56 / H 4750 70,39 (a compensar: D 4700 en vez de H 4750; con prorrata la diferencia va a 634, aviso) |
| Regularización, cierre y apertura (`fiscal-year.service`) | cierre del ejercicio | 6xx → 129 ← 7xx (`regularization`), saldos de balance a cero (`closing`), apertura el día 1 (`opening`); reabrir = reversos marcados `year-reopen:*`, nunca `deleteMany` |
| Asiento manual (`POST /accounting/journal`) | reclasificación D 4300 / H 430 (libros ya legalizados, §12) | numerado por el motor, 409 `FISCAL_YEAR_CLOSED` si el ejercicio está cerrado |

Cifras de Faranda tras el replay (BD local, 2026): 61 asientos (22 `invoice`,
4 `invoice_rectification`, 8 `invoice_cancellation`, 23 `payment`, 4
`payment_refund`), 150 líneas, Σ debe = Σ haber = 2.595,00; saldos: 430 D
379,00 (61 líneas pendientes de traslado a 4300, §12), 570 87,10, 5721 320,40,
572 44,20, 477.10 −37,83, 477.21 −32,56, 4759 −3,18, 705 −297,43 (17 facturas
AUDIT sin categoría fiscal), 705.1 −218,18, 705.2 −56,81, 705.3 −184,71.

## 3. Quién escribe y quién lee cada tabla

| Tabla | Escribe | Lee |
| --- | --- | --- |
| `accounts`, `accounting_settings.chartTemplate` | lote schema (provisionador / CLI); alta manual de subcuentas por el lote cuentas anuales | todos los lotes contables (`accountCode` → `accountId`) |
| `usali_mappings` | lote USALI (editor por organización) | lote USALI (estado USALI) |
| `journal_entries`, `journal_lines` | lote asientos (servicio único `postJournalEntry` con numeración, `entryDate`, `accountCode`, `taxRateCode`/`taxBase`); lo invocan facturación, cobros, TPV, proveedores/gastos, nóminas, comisiones, amortizaciones, IVA, cierre | balance/PyG/sumas y saldos/cash-flow, 303/390, USALI, exportación a gestoría, cierre de ejercicio |
| `vat_settings` | lote IVA/AEAT (`ensureVatSettings`, ajustes) | libros, 303/390/347, periodo de `VatBookEntry` |
| `vat_book_entries` | facturación (emitidas: F1/F2, rectificativas, simplificadas del TPV), proveedores/gastos (recibidas, bienes de inversión) | 303/390/347, exportación a gestoría (`vat_books_csv`) |
| `invoices.snapshotJson/seriesCode/simplified/customerRequired` | lote facturación (emitir), lote TPV (simplificadas) | PDF, VeriFactu, libro de emitidas, folio |
| `payments.clientRequestId/methodCode/reversalOfId/journalEntryId` | lote cobros (`postPayment` idempotente y transaccional) | arqueo, tesorería, conciliación bancaria, liquidación de datáfono |
| `pos_orders.invoiceId/journalEntryId/cashClosureId/taxTotal/businessDate` | lote TPV | arqueo, libro de emitidas |
| `cash_closures` | lote TPV/arqueo | tesorería, conciliación |
| `suppliers` (nuevos campos), `supplier_bills`, `supplier_bill_lines`, `expenses` | lote proveedores y gastos | 303 (soportado), 347, 111/115, tesorería (pagos pendientes), amortizaciones (`investmentGood`) |
| `fixed_assets` (nuevos campos), `depreciation_runs`, `depreciation_lines` | lote amortizaciones | balance, PyG, memoria (cuadro de inmovilizado) |
| `payroll_periods` (nuevos campos) | lote nóminas | PyG, 111/190, USALI (personal por departamento vía `costCenterId`) |
| `commission_accruals` (nuevos campos) | lote comisiones | PyG, USALI (Habitaciones · otros gastos), pagos a canales |
| `financial_statement_snapshots` | lote cuentas anuales / USALI | front (histórico de estados), exportación |
| `gestoria_exports` | lote exportación | front (descargas) |

## 4. USALI: resolución del mapeo

`usaliDepartment` ∈ `rooms` · `fnb` · `other_operated` · `misc_income` ·
`admin_general` · `it` · `sales_marketing` · `pom` · `utilities` ·
`management_fees` · `non_operating` · `below_ebitda`; `usaliLine` ∈ `revenue` ·
`cost_of_sales` · `labor` · `other_expense` · `management_fee` · `rent` ·
`property_taxes` · `insurance` · `other` · `interest` ·
`depreciation_amortization` · `income_tax`. Las combinaciones admitidas por
departamento están en `USALI_DEPARTMENT_LINES` (`chart-of-accounts.service.ts`).

Orden de resolución para una línea de asiento con `accountCode`:

1. `UsaliMapping` activo de la organización cuyo `accountPrefix` sea prefijo del
   código: mayor `priority`; a igualdad, prefijo más largo.
2. `Account.usaliDepartment/usaliLine` de la cuenta.
3. `templateUsaliFor(code)`: la plantilla, por prefijo (`640.7` → `640`).
4. Sin mapeo → línea «Sin asignar» del estado USALI (visible, nunca omitida).

Defaults relevantes de la plantilla: `705.1` Habitaciones · ingresos; `705.2` y
`705.4` A&B · ingresos; `705.3`/`700` Otros departamentos · ingresos; `629.1`
(comisiones de canales) Habitaciones · otros gastos (USALI 11.ª: las comisiones
van en Habitaciones); `623.1` honorarios de gestión; `621` alquiler; `631`
impuestos sobre la propiedad; `625` seguros; `628.x` suministros salvo `628.4`
telecomunicaciones (Tecnología); `640.x`/`642.x` personal por departamento
(`640`/`642` sin desglosar → Administración y general); `68x` amortización;
`66x`/`76x` intereses; `630` impuesto sobre beneficios. Ratios (PAR/POR, RevPAR,
TRevPAR, GOPPAR) los calcula el lote USALI con habitaciones disponibles y
ocupadas del PMS por `propertyId` y periodo.

## 5. Plantilla «PGC Pymes hotelero» y provisionado

- Plantilla: `PGC_PYMES_HOTEL_TEMPLATE` en
  `apps/api/src/modules/accounting/chart-of-accounts.service.ts` — 239 cuentas
  (grupos 1-7, subgrupos, cuentas de 3 dígitos con nombre oficial y las
  subcuentas hoteleras). `validateChartTemplate()` la comprueba (códigos únicos,
  naturaleza por grupo, cabecera de cada cuenta, USALI en toda cuenta de PyG,
  cuentas canónicas presentes). Test: `apps/api/src/modules/accounting/__tests__/chart-of-accounts.test.mts`.
- `provisionOrganizationChart(organizationId, { dryRun?, store? })`: idempotente y
  aditivo. Crea las cuentas que faltan, enlaza `parentId` (también en las
  heredadas), rellena el USALI por defecto de las cuentas de PyG heredadas que
  no tengan ninguno, escribe `accounting_settings.chartTemplate`. **Nunca borra,
  renombra ni cambia la naturaleza** de una cuenta existente; las diferencias de
  nombre se listan en el plan (`nameDiffers`).
- CLI: `apps/api/src/scripts/accounting-provision-chart.ts`
  (`--org <id> [--org …] [--dry-run | --apply --confirm <id> …] [--json]`), un
  evento de auditoría `ACCOUNTING_CHART_PROVISIONED` por organización. El API no
  guarda espejo en memoria de las cuentas: no hace falta reiniciar.

Ejecución del 2026-09-15 (BD local, `--apply --confirm` para ambas):

| Organización | Antes | Creadas | Enlazadas | USALI rellenado | Después |
| --- | --- | --- | --- | --- | --- |
| Faranda `cmrhw9jy30002fyvb6tsdiugt` | 0 | 239 | 232 (todas menos los 7 grupos) | 0 | 239 |
| org_123 | 78 (seed) | 171 | 242 | 27 | 249 (incluye 10 códigos del seed fuera de la plantilla: `1130`, `4310`… conservados) |

Segundo run en dry-run: crear 0 · enlazar 0 · rellenar 0 · setting `keep`.

Alta de una organización nueva: `createTenant`/`bootstrapPilot` deben llamar a
`provisionOrganizationChart` (handoff al integrador); hasta entonces el CLI.

## 6. Migración

`packages/database/prisma/migrations/20260915140000_finanzas_contabilidad_pgc/migration.sql`,
generada con `prisma migrate diff --from-schema-datasource … --to-schema-datamodel
… --script` y revisada a mano (la cabecera del fichero explica cada edición):
`accounts.kind/level/pgc_group` se añaden nullable, se rellenan y luego `SET NOT
NULL`; `supplier_bills.status` se convierte a enum in situ (`ALTER COLUMN … TYPE …
USING`) en vez de DROP+ADD; pasos de datos idempotentes (fecha contable,
ejercicio y número de los asientos existentes; `account_code` de las líneas;
`organization_id` de facturas de proveedor e inmovilizado; `method_code` de los
cobros; `business_date` de los tickets cerrados). Pre-checks previos por `psql`
(sin violaciones de los uniques nuevos) en la cabecera.

Aplicar en otro entorno (VPS): `corepack pnpm db:migrate:deploy` →
`corepack pnpm db:drift:check` (debe salir 0) → `corepack pnpm db:generate` →
reiniciar el API → `accounting-provision-chart.ts --org <id> --apply --confirm <id>`
por organización. `tests/migrations-squash-contract.test.mjs` y
`scripts/check-migrations-vs-schema.mjs` vigilan que la cadena cubra cada modelo
y enum; `tests/finanzas-schema-contract.test.mjs` vigila este contrato.

## 7. Pendientes que este lote deja a otros

- **Numeración y fecha contable en los escritores heredados**
  (`accounting/projection.ts`, `posting-rules/*.ts`, `invoice.service.postCancellationReversal`,
  `fiscal-year.service`): pasar `entryDate`, `fiscalYearCode`, `entryNumber`,
  `description`, `reference` y `JournalLine.accountCode` a través del servicio
  único del lote asientos; `fiscal-year.service.reopen` deja de borrar asientos.
- **`prisma/seed.ts` (org_123)**: el bloque de cuentas (`prisma.account.upsert`,
  línea ~409) no pasa `kind/group/level` (NOT NULL): un seed en BD nueva falla
  hasta que el integrador lo cambie por `provisionOrganizationChart("org_123")`
  o añada `kind: kindFromLegacyType(accountType), group, level, isPostable`.
- **`GET /organizations/:id/accounts`** (`server.ts` ~5232) devuelve una plantilla
  estática de 7 cuentas cuando la organización no tiene plan: debe devolver 409
  `CHART_NOT_PROVISIONED` (o provisionar) y exponer `kind`, `level`,
  `isPostable`, `parentId`, `usaliDepartment/usaliLine`.
- **`apps/api/package.json`**: script `accounting:provision-chart`.
- **Payment.method → methodCode**: cuando `folio.service.postPayment` escriba
  `methodCode`, una migración posterior puede hacer `method` derivado.
- **PSP**: `PaymentIntent`/`PaymentProviderConnection` siguen sin lector ni
  escritor; el lote cobros no marca `captured` sin confirmación del PSP.

## 8. USALI · estado de resultados y ratios (lote usali-cuentas)

Módulo `apps/api/src/modules/financial-statements/` (rutas en
`financial-statements.routes.ts`, permisos en `route-permissions.partial.ts`,
contrato de datos compartido en `packages/shared/src/financial-statements-types.ts`
— solo tipos: los `.js` de `packages/shared/src` son stubs `export {}`, así que
una constante de runtime allí no llegaría al API). Todo importe del contrato es
un `MoneyString` («1234.56», dos decimales, nunca float); un ratio es `null`
cuando el denominador es 0 (nunca un 0 falso).

Lectura del libro (`source.ts`, una sola consulta SQL agregada por consulta;
solo asientos `posted`, siempre por `entryDate`):

- `balance_at(to)`: saldos acumulados hasta `to` inclusive, **excluyendo el
  asiento de cierre fechado exactamente en `to`** (el balance «a 31/12» es el
  anterior al cierre; un cierre fechado antes de `to` se incluye porque su
  apertura del día siguiente lo repone).
- `movements(from, to)`: movimientos de `[from, to]` **excluyendo**
  `entryKind` `regularization` / `closing` / `opening` (dejarían la PyG a cero
  o duplicarían los saldos de apertura). La PyG incluye el último día del
  rango (hallazgo 33 cerrado).

Mapeo USALI (`usali-mapping.service.ts`, orden de §4): `UsaliMapping` activo
(mayor `priority`, luego prefijo más largo) → `Account.usaliDepartment/usaliLine`
→ `templateUsaliFor(code)` → «Sin asignar». Una combinación departamento ×
línea que `USALI_DEPARTMENT_LINES` no admite se trata como ausente y se informa
(`issue`), nunca mueve dinero en silencio. Editor: `PATCH /accounting/usali/mappings`
(`{ mappings: [{ accountPrefix, usaliDepartment, usaliLine, priority?, active? }] }`,
zod estricto; `accountPrefix` solo grupos 6-7 → 400 `VALIDATION_ERROR`;
combinación no admitida → 400 `USALI_LINE_NOT_ADMITTED`; upsert por
`(organizationId, accountPrefix)`; auditoría `USALI_MAPPING_UPDATED`) y
`DELETE /accounting/usali/mappings/:mappingId` (404 opaco fuera de la
organización). Cobertura (`GET …/coverage?from&to`): cuentas de PyG
contabilizables sin mapeo y, con periodo, las que además tienen movimientos.
En org_123 hoy: 82 cuentas de PyG, 81 mapeadas (por columna de la cuenta), 1
sin mapeo (`689`, código del seed sin equivalente en la plantilla).

Estado USALI (`usali.service.ts`, `GET /accounting/usali/pnl?propertyId?&from&to[&format=pdf|xlsx|csv]`):
líneas de ingreso = haber − debe; el resto = debe − haber; departamentos
operativos (Habitaciones, A&B, Otros operados, Ingresos varios: ingresos, coste
de ventas, personal, otros gastos, beneficio departamental) → no distribuidos
(A&G, Tecnología, Ventas y marketing, POM, Suministros) → **GOP** →
honorarios de gestión → no operativos (alquiler, impuestos sobre la propiedad,
seguros, otros) → **EBITDA** → intereses, amortización, impuesto sobre
beneficios → resultado neto. La línea **«Sin asignar»** (cuentas 6/7 con
movimientos y sin mapeo) siempre se muestra y el bloque `reconciliation`
demuestra que `netIncome + unassigned.net = resultado PGC` de las mismas filas.
Estadísticas del PMS (`statistics`): noches del periodo, inventario =
habitaciones activas, disponibles = inventario × noches (las fuera de servicio
no se descuentan: el PMS no las registra por noche), ocupadas = noches de
habitación de reservas `checked_in`/`checked_out` que solapan el periodo
(estancias reales, no reservas confirmadas). Ratios: RevPAR, TRevPAR, GOPPAR,
ADR, ingresos/GOP/EBITDA por habitación disponible (PAR) y ocupada (POR), y
PAR/POR por departamento. Comparaciones: `GET /accounting/usali/compare?from&to[&propertyIds=a,b]`
(una PyG por propiedad + consolidado: libro completo de la organización si se
comparan todas, suma por cuenta si es un subconjunto; una propiedad ajena →
404) y `GET /accounting/usali/periods?periods=2026-01-01..2026-03-31,2025-01-01..2025-03-31[&propertyId]`
(2-6 periodos; deltas absolutos y en % respecto al primero).

## 9. Cuentas anuales PGC Pymes (lote usali-cuentas)

`annual-accounts.service.ts`, `GET /accounting/annual-accounts[/balance|/pyg|/ecpn|/memoria]?fiscalYearId|from&to[&propertyId][&comparative=1][&format=pdf|xlsx|csv]`
(`fiscalYearId` debe ser un `FiscalYear` de la organización → si no, 404;
`comparative=1` añade el periodo anterior de la misma longitud). Tres lecturas:
`balance_at(to)`, `balance_at(from − 1)` y `movements(from, to)`.

- **Balance**: clasificación por prefijo de código (dígitos, sin punto:
  `477.21` → `477`; el prefijo más largo gana; tablas `BALANCE_PREFIXES` y
  `BALANCE_LINES`) en el modelo de Pymes (activo no corriente I-VI, corriente
  I-VI; PN I-VIII + subvenciones; pasivo no corriente I-V; corriente I-V).
  Activo en saldo deudor (28x/29x/39x/49x aparecen negativos dentro de su
  epígrafe), PN y pasivo en saldo acreedor. Lo que las tablas no cubren va a
  un epígrafe visible «sin clasificar» de su lado según `Account.kind`, nunca
  se omite: **activo = PN + pasivo se cumple para cualquier libro cuadrado**.
  «VII. Resultado del ejercicio» = ingresos − gastos del periodo (idéntico al
  resultado de la PyG); `129` se presenta como resultado de ejercicios
  anteriores pendiente de aplicación (saldo a `from − 1` más sus movimientos
  no regularizadores: la distribución); saldos 6/7 anteriores al periodo sin
  regularizar van a su propia línea con aviso. Así la identidad se mantiene
  con el ejercicio abierto, regularizado o cerrado (verificado con
  regularización + cierre + apertura en los tests).
- **PyG** (`PYG_PREFIXES`, `PYG_LINES`): partidas 1-18 del modelo de Pymes,
  ingresos positivos y gastos negativos; A) explotación, B) financiero, C)
  antes de impuestos, 18 impuesto sobre beneficios, D) resultado; comprobación
  `netResult = Σ 7xx − Σ 6xx`; una cuenta 6/7 sin partida va a «Otras partidas
  sin clasificar» con aviso.
- **ECPN**: A) ingresos y gastos reconocidos (resultado + movimientos de 13x);
  B) estado total de cambios por columna (capital, prima, reservas, resultados
  anteriores, otras aportaciones, resultado, dividendo a cuenta,
  subvenciones): saldo inicial (`from − 1`), ajustes (no derivables: fila a
  cero), total ingresos y gastos, operaciones con socios (100-104/110/118/557),
  otras variaciones (11x/120/121/129: incluye la distribución del resultado),
  saldo final; `reconciled` = inicial + filas = saldo del libro por columna.
- **Memoria**: 14 notas de la memoria de Pymes con `status: auto`
  (rellenadas desde el libro: bases de presentación, normas de valoración,
  cuadro de inmovilizado por grupo + registro de `FixedAsset`, activos y
  pasivos financieros, fondos propios, situación fiscal desde `VatBookEntry`
  y saldos 472/477/4700/4750/4751/630, ingresos y gastos, subvenciones) o
  `requires_input` (actividad/domicilio, aplicación del resultado, partes
  vinculadas, plantilla media —se informa el número de personas con nómina si
  hay `PayrollSlip`—, periodo medio de pago, hechos posteriores). Nunca
  inventa datos: lo que el libro no sabe se marca.
- **Coherencia** (`coherence`): balance cuadrado, `balance.periodResult ===
  pyg.netResult`, ECPN reconciliado.
- **Snapshots** (`FinancialStatementSnapshot`): `POST /accounting/annual-accounts/snapshots`
  (`{ kind: balance|pyg|ecpn|memoria|usali, fiscalYearId|from+to, propertyId?, label? }`,
  201, auditoría `FINANCIAL_STATEMENT_SNAPSHOT_CREATED`), `GET …/snapshots[?kind&fiscalYearId]`,
  `GET …/snapshots/:id`, `GET …/snapshots/:id/download?format=pdf|xlsx|csv`
  (se renderiza desde el `json` guardado, nunca se recalcula).
- **Ficheros** (`statement-render.ts`): en `node_modules` NO existe ninguna
  librería PDF ni XLSX (pdfkit, pdf-lib, pdfmake, exceljs, xlsx, jszip: ninguna,
  ni transitiva) y no se pueden añadir paquetes, así que el módulo lleva sus
  propios escritores: `pdf-writer.ts` (PDF 1.4 con Helvetica/Helvetica-Bold
  en WinAnsi, tablas de texto paginadas, xref correcta) y `xlsx-writer.ts`
  (SpreadsheetML real en un ZIP escrito con `node:zlib`, celdas de importe
  numéricas con formato `#,##0.00`, negrita). El CSV es `;` con BOM y coma
  decimal. Son documentos válidos, sin diseño; si más adelante entra una
  librería, solo cambia `statement-render.ts`.

## 10. Exportación a gestoría (lote usali-cuentas)

`gestoria-export.service.ts`, `GET /accounting/gestoria-exports/formats`,
`POST /accounting/gestoria-exports` (`{ format, from, to, propertyId?,
subaccountLength? }`, 201, auditoría `GESTORIA_EXPORT_CREATED`),
`GET /accounting/gestoria-exports[?format]`, `GET …/:id`, `GET …/:id/download`
(permiso `analytics.export`). El contenido se guarda `inline` en
`GestoriaExport` (no hay almacén de objetos en el API); más de 20 MB → 413
`EXPORT_TOO_LARGE` («divide el periodo»).

| Formato | Estado | Diseño |
| --- | --- | --- |
| `csv_universal` | SIEMPRE | `fecha;asiento;cuenta;concepto;debe;haber;documento;nif;base;iva`: una fila por línea de asiento, `;`, UTF-8 con BOM, `DD/MM/AAAA`, coma decimal, orden `(entryDate, entryNumber, id)`. `asiento` = `entryNumber`; un asiento heredado sin numerar sale como `P-<id>` (sus líneas siguen agrupadas) y la respuesta lo cuenta en `unnumbered`. `documento` = `reference` del asiento o número del documento origen; `nif` del documento origen (`Invoice.customerTaxId`, `SupplierBill.supplierTaxId`, `Expense.supplierNif` según `sourceType`); `base`/`iva` solo en líneas 472/477 con `taxBase`/`taxRateCode`. |
| `vat_books_csv` | SIEMPRE | `libro;fecha;serie;numero;nif;nombre;base;tipo;cuota;total;retencion;figura;recargo_tipo;recargo_cuota;periodo;deducible;origen_tipo;origen_id` desde `VatBookEntry`. |
| `contaplus_diario` | compatible · **validar con la gestoría** | Columnas nucleares del Diario de ContaPlus / Sage 50: `ASIEN;FECHA;SUBCTA;CONTRA;CONCEPTO;EURODEBE;EUROHABER;FACTURA;BASEEURO;IVA;DOCUMENTO` en CSV `;`. `SUBCTA` = dígitos del código rellenados con ceros por la derecha a la longitud de subcuenta de la empresa (`subaccountLength`, 8 por defecto: `705.1` → `70510000`, `4300` → `43000000`, `477.21` → `47721000`); `CONTRA` solo en asientos de dos líneas; `CONCEPTO` a 40 caracteres. `validateWithAdvisor = true` siempre: la gestoría confirma longitud de subcuenta y vía de importación antes del primer uso real. |
| `a3` | **no implementado** | El diseño de registro del enlace contable de A3 no se conoce con confianza: 409 `EXPORT_FORMAT_NOT_IMPLEMENTED` con `alternative: csv_universal` (A3ECO/A3CON importan CSV/Excel con su asistente). |

Tests: `apps/api/src/modules/financial-statements/__tests__/*.test.mts` (40
casos sobre un libro de referencia en memoria: resolución y cobertura USALI,
estado USALI con sus cuadres, balance/PyG/ECPN/memoria con el ejercicio abierto
y cerrado, identidad del balance sobre asientos aleatorios cuadrados,
escritores PDF/XLSX/CSV y exportaciones) y `tests/integration/financial-statements.test.mts`
(HTTP sobre org_123/prop_123 en una ventana propia de febrero de 2031 y una
organización de test aislada con el libro de referencia a través del lector
SQL; limpia todo al terminar). Cuadres literales del libro de referencia:
activo 60.184,80 = PN 58.098,00 + pasivo 2.086,80; resultado −1.902,00 (=
balance); USALI GOP −1.285,00, EBITDA −1.785,00, neto −1.895,00 + sin asignar
−7,00 = −1.902,00; 10 habitaciones × 90 noches = 900 disponibles, 45 ocupadas
(5,00 %), RevPAR 0,11, ADR 2,22, GOPPAR −1,43.

Pendiente que este lote deja: pantalla del front; habitaciones fuera de
servicio por noche para el PAR; el formato A3. (El registro de rutas, partial
y export los hizo la integración del 2026-09-16, §11.)

## 11. Integración (2026-09-16, primera pasada)

Qué quedó cableado en el working tree (sin commit):

- **Rutas** (`apps/api/src/server.ts`, tras `registerChannelManagerRoutes`):
  `registerLedgerRoutes`, `registerFiscalRoutes(app, { ledger: canonicalLedgerEngine })`,
  `registerInvoicingRoutes` / `registerPaymentsRoutes` (con `assertBillingAccess`
  como guardia de inquilino), `registerPosRoutes`, `registerNightAuditRoutes`,
  `registerPayablesRoutes`, `registerFixedAssetsRoutes`, `registerTreasuryRoutes`,
  `registerFinancialStatementsRoutes`. Los seis handlers TPV y los cuatro de
  night audit inline se retiraron (mismos paths, ahora en los módulos); sus
  entradas del manifiesto viven en el primer array de cada partial. Las rutas
  heredadas del diario (`/organizations/:id/journal-entries`, `/journal-entries/*`),
  de proveedores (`/supplier-bills/drafts`) y de modelos (`/accounting/reports/modelo-*`,
  ahora también con `?period=`) siguen registradas y numeran por el motor.
  `GET /organizations/:id/accounts` responde 409 `CHART_NOT_PROVISIONED` sin plan.
- **Permisos**: spread de los diez partials en `security/route-permissions.ts`;
  el contract test descubre cualquier `*route-permissions.partial.ts` (accounting
  tiene dos). CSB43/SEPA pasan a `banking.reconcile` (FIN-17) y la plantilla
  `accountant` gana `banking.reconcile` + `payroll.manage` (`rbac:sync` aplicado
  en local: Contabilidad de org_123 y Faranda +2). `PUBLIC_PREFIXES` incluye
  `/payments/webhooks` y `/payments/return`.
- **Un solo motor de asientos**: `accounting.service.postJournalEntry/reverseJournalEntry`.
  Los ports que aún numeran MAX+1 por su cuenta (`payables/ledger-port.ts`,
  `vat-settlement.service.ts` interino) usan `journalNumberingLockKey()` del
  motor, así que ya no hay carrera de numeración entre lotes en paralelo; las
  rutas `/fiscal/vat-settlement*` del servidor asientan por el motor canónico
  (`canonicalLedgerEngine`). `posting-rules/index.ts` escucha `GuestCheckedOut`
  e `InvoiceIssued` con `accrueCommissionFromEvent` (el handler heredado de
  comisiones nunca disparaba) y ya no encola el handler de nóminas (el cálculo
  asienta síncrono).
- **Contrato compartido**: `packages/shared/src/index.ts` exporta
  accounting/fiscal/payments/pos/payables/treasury/financial-statements-types
  (`MoneyString`, `PaymentMethodCode` y `VatBookRowDto` desambiguados con
  re-exports explícitos). Scripts `accounting:provision-chart` y
  `accounting:replay` en `apps/api/package.json`. `RectifyInvoiceSchema.lineAdjustments`
  admite `{ lineId, quantity?, unitPrice? }` (antes zod descartaba los campos y
  toda rectificativa «I» con ajustes era 400). `prisma/seed.ts` escribe
  `kind/group/level/isPostable` (fresh install del seed vuelve a pasar).
  `createSimplifiedInvoice` acepta `pos.order.pay` o `folio.charge.post`
  además de `invoice.issue` (cajeros).
- **Faranda (BD local)**: plan provisionado (239 cuentas), `accounting:replay`
  en dry-run (60 documentos, 0 fallos) y `--apply --confirm`: 61 asientos
  numerados 1..61 en 2026 (60 documentos + la reversión marcada de
  FAC-2026-000018 sustituida por REC-2026-000003), 150 líneas, Σ debe = Σ haber
  = 2.595,00 (diferencia 0,00; ningún asiento descuadrado; ninguna línea sin
  `account_code`); segundo dry-run: 60 «existían». Sumas y saldos: 430 D
  1.487,00 / H 1.108,00; 570 87,10; 5721 320,40; 572 44,20; 477.10 −37,83;
  477.21 −32,56; 4759 −3,18; 705 (genérica, 17 facturas AUDIT sin categoría
  fiscal) −297,43; 705.1 −218,18; 705.2 −56,81; 705.3 −184,71. Modelo 303
  2026-Q3 de Faranda (servicio, sin sesión): 27 = 71 = 74,94 · 45 = 0 ·
  `fuentes.origen = documentos` (libros sin materializar: `POST /fiscal/vat-books/rebuild`
  los escribe) · 33 avisos (facturas al 0 % `ES_UNKNOWN_0`) · cotejo con el
  diario: `cuadra = false` por una diferencia de 4,55 en 477.10 (REC-2026-000003,
  rectificativa por sustitución contada íntegra en los libros mientras el
  diario anuló FAC-2026-000018; §12 t6#8 y §15) — antes 23,65 por las 3
  anulaciones que el cotejo excluía (corregido: el cotejo lee `posted` +
  `reversed` y excluye liquidación/cierre/apertura y sus reversos); las
  facturas al 0 % no entran en el cotejo (solo avisos). Sumas y saldos: las 61
  líneas de clientes siguen en `430` hasta ejecutar
  `accounting:relabel-customer-account` (§12, §14). Ojo: el replay se ejecutó con el API :3000 en marcha, así que
  su cadena de auditoría en memoria queda bifurcada hasta el próximo reinicio
  (deuda 12(c) de CLAUDE.md).
- **Puertas** (2026-09-16): typecheck-all 15 PASS · contratos 393/393 ·
  unitarios API 1.164 (1.163 pass · 1 skipped) · integración 168 (163 pass ·
  5 skipped) · env-census 136/136 · drift 0 · fresh-install: pasos 1-7 OK, el
  paso 8 (`adopt-baseline` en dry-run) está corregido en esta pasada (trataba
  como «stale» toda fila de `_prisma_migrations` que no fuese la baseline).

## 12. Correcciones de la revisión adversarial (fix lots, 2026-09-16)

Quince hallazgos (6 alta · 7 media · 2 baja) de la revisión de la primera
integración, todos corregidos en el working tree con test que los pina
(unitario + integración + contrato). Ninguno escribió en Faranda.

| Id | Sev. | Hallazgo | Corrección y decisión | Pina |
| --- | --- | --- | --- | --- |
| t6#1 | alta | Venta TPV al contado asentada dos veces (port síncrono `pos_ticket` + proyección `InvoiceIssued` de la simplificada). | UN asiento con clave `pos_ticket/<posOrderId|invoiceId>`: `buildInvoiceEntry` con `settledInAct` (D 570/5721 en vez de 4300), `projection.postInvoiceIssuance` y el replay reutilizan la clave (`issuanceSourceKeys`); una F1 «cobrada en el acto» es 400 `INVOICE_CASH_SALE_NOT_SIMPLIFIED`; la anulación devuelve la tesorería. | `posting-rules.test.mts`, `accounting-ledger.test.mts`, `finanzas-ledger-contract` |
| t6#2 | alta | Balance/PyG/ECPN/USALI leían `status='posted'`: excluían el original revertido e incluían su reverso (resta doble). | Regla única de lectura (§1.3): `status ≠ draft` y fuera de parejas marcadas; la exportación a gestoría conserva ambas mitades. Se descartó «incluir ambos» porque rompe las exclusiones por `entry_kind` al reabrir. | `financial-statements-reversals.test.mts` (4), `annual-accounts.test.mts` |
| t6#3 | alta | El motor aceptaba asientos dentro de un ejercicio CERRADO (solo miraba periodos). | Guardia por `FiscalYear.status` en post, borrador, reverso y todo escritor de documentos: 409 `FISCAL_YEAR_CLOSED` (salvo cierre/reapertura). `closeFiscalYear` no cierra periodos automáticamente (política, no implementada). | `ledger-engine.test.mts`, `accounting-ledger.test.mts` |
| t6#4 | alta | Cuenta de clientes distinta por escritor (motor/replay `430`, HTTP `4300`). | `CUSTOMER_ACCOUNT_CODE = "4300"` único en `packages/shared`; `posting-rules` lo importa; CLI `accounting:relabel-customer-account` (dry-run por defecto, auditado `ACCOUNTING_CUSTOMER_ACCOUNT_RELABELED`, rechaza ejercicios cerrados) aplicado en org_123 (31 líneas). **Faranda sigue en 430 (61 líneas)**: §14. Libros legalizados → asiento de reclasificación D 4300 / H 430. | `finanzas-ledger-contract`, integración |
| t6#5 | alta | IDOR: `GET /payment-intents/:id` devolvía intentos de otra organización. | `assertPaymentIntentAccess` en `payments.service.ts` (404 opaco «Intento de pago no encontrado.», admins de plataforma re-apuntados). | `payments-tenancy.test.mts` |
| t6#6 | alta | `GET /payroll/contracts|periods` aceptaban `?organizationId` ajeno. | `resolveOrganizationScope` + `PayrollListQuerySchema`; contrato que impide el patrón `query.organizationId ?? request.userContext.organizationId` en `server.ts`. | `integrador-fixes.test.mts`, `finanzas-integrador-contract` |
| t6#7 | media | El replay trataba las filas `Payment` de reverso (`reversalOfId`) como cobros. | La proyección y el replay ignoran las filas con `reversalOfId`; la rama `<paymentId>:refund` queda solo para originales heredados sin `PaymentRefund`. | `ledger-engine.test.mts`, replay dry-run de Faranda (60 «existían») |
| t6#8 | media | El cotejo diario↔libros del 303 filtraba `posted`: cada anulación restaba dos veces. | `LEDGER_CROSS_CHECK_STATUSES = posted+reversed`; `isNonAccrualVatEntry` excluye liquidación, cierre, apertura y sus reversos. Residual de Faranda 2026-Q3: 4,55 (§15). | `modelo-303.test.mts`, `fiscal-models.test.mts` |
| t6#9 | media | Recepción llevaba `accounting.read` (calendario) y abría diario, mayor, CSV, 303, libros, cuentas anuales y USALI. | Clave nueva y aditiva `accounting.reports.read` (manager/accountant/compliance/owner); `accounting.read` queda como clave de calendario; remap en el compositor `security/route-permissions.ts` (`requireAccountingReportsKey`) sobre los partials de finanzas; los 9 `GET /accounting/reports/*` heredados pasan de `analytics.read` a la clave nueva. Propagación a los roles existentes: `rbac:sync` (§14, pendiente en Faranda). | `finance-report-keys.test.mts`, `integrador-fixes.test.mts` |
| t6#10 | media | Contabilidad no podía dar de alta proveedores, facturas recibidas ni inmovilizado, ni exportar a gestoría. | Plantilla `accountant` + `procurement.read/manage`, `assets.read/manage`, `analytics.export` (y `banking.reconcile`, `payroll.manage` de la primera pasada). | `finanzas-integrador-contract` |
| t6#11 | media | `POST /payroll/contracts` y `POST /commissions/rules` sin zod (500 con basura; `staffProfileId` inexistente aceptado). | `schemas/payroll-commissions.schemas.ts` (strict, mensajes en español; `contractType` ∈ 6 modalidades RDL 32/2021; `payFrequency` monthly/biweekly/weekly); 404 opaco si el perfil o el canal no son de la propiedad. | `payroll-commissions.schemas.test.mts`, `integrador-fixes.test.mts` |
| t6#12 | media | Corridas de amortización con meses saltados (los omitidos nunca se amortizaban). | Regla «mes a mes y sin huecos» (§1.7): 409 `PREVIOUS_PERIOD_MISSING` + `pendingPeriods` en la vista previa. Sin recuperación automática (`catchUp` sería un bucle sobre el mismo código). | `depreciation.test.mts` (15), `payables-assets.test.mts` |
| t6#13 | media | Mayor de cuenta: cargaba TODOS los asientos del rango en memoria antes de filtrar. | Consulta acotada en SQL (índice `journal_lines_account_code_idx`); `totals`/`closingBalance` de toda la ventana; `truncated` solo corta el detalle (5.000). Índice directo `@@index([accountId])` pendiente (migración futura, sin urgencia). | `ledger-engine.test.mts`, `accounting-ledger.test.mts` |
| t6#14 | baja | Esquemas heredados del dinero sin `.strict()`. | `folios.schemas.ts` (líneas, cobros, devoluciones, borrador de factura) y, en esta pasada final, `finance.schemas.ts` (`RectifyInvoiceSchema` con sus objetos anidados, `CreateFiscalYearSchema`, `CloseFiscalYearSchema`, `ReopenFiscalYearSchema`) con `STRICT_BODY_MESSAGE`. | `schemas/__tests__`, `billing-money.test.mts` |
| t6#15 | baja | `GET /payments/return/:intentId` pública revelaba el importe a quien conociera el id. | Token de retorno HMAC-SHA256 derivado de `JWT_SECRET` (`payments/return-token.ts`, `?t=<exp>.<firma>`, 7 días) en las URL OK/KO entregadas al PSP; sin token la página es neutra sin importe. Rotar `JWT_SECRET` invalida los tokens vigentes (el cobro se registra igualmente por el webhook firmado). | `return-token` unitarios, `payments-tenancy.test.mts` |

Cambios de esta pasada final del integrador (fuera de los lotes): script
`accounting:relabel-customer-account` en `apps/api/package.json`; `.strict()`
en `finance.schemas.ts`; `counterAccountCode` de la baja de inmovilizado
admite `4300` en vez de `430`; el contrato `tests/finanzas-schema-contract`
pina «D 4300 (total)».

Decisiones que quedan documentadas y NO se han cambiado en código:

- Los servicios de lectura (`accounting.service` diario/mayor/plan/ajustes,
  `modelo-*`, `vat-books`, `vat-settlement` preview, `annual-accounts`,
  `usali*`, `ledger.routes.ts:254` estado de la proyección) siguen exigiendo
  `accounting.read` internamente; el borde exige `accounting.reports.read`.
  Las cuatro plantillas que tienen la clave nueva tienen también la de
  calendario, así que no hay efecto práctico; un rol custom con solo la clave
  nueva recibiría 403 en el servicio. Los modelos heredados (`/accounting/reports/modelo-*`)
  mantienen además `analytics.read` en `balance-sheet`, `cash-flow`,
  `trial-balance` y `reporting`. Traspaso a los lotes dueños: aceptar
  `accounting.reports.read` como alternativa (`requireAnyPermission`).
- Mayor de una cuenta (`includeReversedPairs: true`) frente a sumas y saldos /
  estados (parejas excluidas): para parejas dentro de la ventana coinciden;
  para un reverso fechado en un periodo posterior difieren por ese importe. Un
  único criterio («kind efectivo» del reverso según el tipo de su original)
  exigiría cambiar `aggregateAccountBalances` y `ledgerWhere` a la vez.
- `430` sigue siendo contabilizable en la plantilla (PGC de Pymes lo admite;
  Contaplus/A3 solo contabilizan en la subcuenta más larga): convertirla en
  cabecera (`isPostable=false`) va con el traslado de Faranda y
  `patchChartAccount` ya rechaza (409 `ACCOUNT_HAS_ENTRIES`) hacerlo con
  apuntes.
- Reverso huérfano `cmu37gqkt0015fym4g9fcl0y4` en org_123 (residuo de un test
  de sustitución cuyo original fue borrado): con la regla de lectura no cuenta
  en los estados; se conserva (org_123, demo) — borrarlo sería una limpieza de
  la BD demo, no una corrección.

## 13. Rutas y permisos por módulo

Convención: cada módulo registra sus rutas (`registerXRoutes(app)` en
`server.ts` tras `registerChannelManagerRoutes`) y sus entradas del
manifiesto (`route-permissions.partial.ts`; `modules/accounting` tiene además
`fiscal-route-permissions.partial.ts`; el contract test lee cualquier
`*route-permissions.partial.ts`). El manifiesto es «todas las claves
requeridas»; el nivel de riesgo decide si el fallback demo sin token alcanza la
ruta (nunca `high`/`critical`). Las claves de lectura con importes que los
partials escriben como `accounting.read` se remapean a `accounting.reports.read`
en `security/route-permissions.ts` (`requireAccountingReportsKey`); en la tabla
figura la clave EFECTIVA en el borde. 114 entradas.

| Módulo (partial) | Ruta | Clave efectiva | Riesgo |
| --- | --- | --- | --- |
| accounting (ledger) | `GET /accounting/journal`, `GET …/journal/export`, `GET …/journal/:id`, `GET /accounting/ledger/:accountCode`, `GET /accounting/chart`, `GET /accounting/settings`, `GET /accounting/projection/status` | `accounting.reports.read` | medium |
| | `POST /accounting/journal` | `accounting.journal.post` | high |
| | `POST /accounting/journal/:id/reverse`, `POST /accounting/replay` | `accounting.journal.post` + `ai.high_risk.confirm` | critical |
| | `POST /accounting/chart`, `PATCH /accounting/chart/:code`, `PATCH /accounting/settings` | `accounting.configure` | high |
| accounting (fiscal) | `GET /fiscal/vat-settings`, `GET /fiscal/vat-books`, `GET /fiscal/models/:modelo`, `GET …/:modelo/pdf`, `GET /fiscal/vat-settlement` | `accounting.reports.read` | medium |
| | `PUT /fiscal/vat-settings`, `POST /fiscal/vat-books/rebuild` | `accounting.configure` | high |
| | `POST /fiscal/vat-settlement`, `POST /fiscal/vat-settlement/reverse` | `accounting.journal.post` | critical |
| invoicing | `GET /invoices/:id/pdf` | `invoice.read` | medium |
| payments | `GET /properties/:propertyId/payments/psp-status`, `GET /payment-intents/:id` (tenencia: 404 opaco) | `payment.capture` | low |
| | `POST /folios/:id/payment-links` | `payment.capture` | high |
| | `POST /payments/webhooks/:provider`, `GET /payments/return/:intentId` (`?t=` firmado) | — (`PUBLIC_PREFIXES`) | public |
| pos | `GET …/pos/outlets`, `GET …/pos/tickets`, `GET …/pos/cash-summary`, `GET …/pos/cash-closures`, `GET …/cash-closures/:closureId` | `pos.read` | low |
| | `POST /pos/tickets`, `POST /pos/tickets/:id/lines` | `folio.charge.post` | low |
| | `POST /pos/tickets/:id/close` (contado: el servicio acepta `pos.order.pay`, `folio.charge.post` o `invoice.issue`) | `folio.charge.post` | medium |
| | `POST …/pos/cash-closures` (abrir) | `pos.order.pay` | high |
| | `POST …/cash-closures/:closureId/close` | `pos.order.pay` | critical |
| | `POST …/cash-closures/:closureId/approve` | `accounting.journal.post` | high |
| night-audit | `GET …/night-audit/business-date`, `GET …/runs`, `GET …/runs/:runId`, `GET …/preflight` | `analytics.read` | low |
| | `POST …/night-audit/run` | `accounting.journal.post` | high |
| payables | `GET|POST /organizations/:organizationId/payables/suppliers`, `GET|PATCH …/suppliers/:supplierId` | `procurement.read` (GET) · `procurement.manage` | medium · high |
| | `GET …/payables/supplier-bills`, `GET …/supplier-bills/:billId`, `GET …/:billId/attachment`, `GET …/payables/aging`, `GET …/payables/expenses`, `GET …/expenses/:expenseId` | `accounting.reports.read` | medium |
| | `POST …/payables/supplier-bills`, `PATCH …/supplier-bills/:billId`, `POST …/:billId/approve` | `procurement.manage` | high |
| | `POST …/:billId/post|pay|cancel`, `POST …/expenses/:expenseId/reverse` | `accounting.journal.post` | critical |
| | `POST …/payables/expenses` | `accounting.journal.post` | high |
| fixed-assets | `GET …/asset-register`, `GET …/asset-register/:assetId` | `assets.read` | medium |
| | `POST …/asset-register`, `PATCH …/asset-register/:assetId` | `assets.manage` | high |
| | `POST …/asset-register/:assetId/dispose`, `POST /organizations/:organizationId/depreciation-runs`, `POST …/depreciation-runs/:runId/reverse` | `accounting.journal.post` | critical |
| | `GET …/depreciation-runs`, `GET …/depreciation-runs/preview`, `GET …/depreciation-runs/:runId` | `accounting.reports.read` | medium |
| treasury | `GET /treasury/position|receivables|payables|forecast`, `GET /treasury/bank-lines/:bankLineId/suggestions`, `GET /treasury/sepa/remittances[/:id]` | `banking.read` | medium |
| | `POST /treasury/bank-accounts/:id/statements/import`, `POST|DELETE /treasury/bank-lines/:bankLineId/reconcile`, `POST /treasury/statements/:id/auto-reconcile`, `POST /treasury/sepa/remittances`, `POST …/remittances/:id/status`, `POST /treasury/sepa/supplier-payments` | `banking.reconcile` (servicio: o `accounting.journal.post`) | high |
| | `GET /commissions/accruals/:id` | `commissions.read` | medium |
| | `POST /commissions/accrue`, `POST /commissions/accruals/:id/settle|reverse` | `accounting.journal.post` (servicio: o `banking.reconcile`) | high |
| | `GET /payroll/periods/:id` | `payroll.read` | medium |
| | `POST /payroll/periods/:id/export` | `payroll.manage` (servicio: o `accounting.journal.post` / `workforce.payroll_export`) | high |
| | `POST /payroll/periods/:id/pay` | `payroll.manage` (servicio: o `accounting.journal.post`) | critical |
| financial-statements | `GET /accounting/usali/mappings|coverage|pnl|compare|periods`, `GET /accounting/annual-accounts[/balance|/pyg|/ecpn|/memoria]`, `GET …/annual-accounts/snapshots[/:snapshotId[/download]]` | `accounting.reports.read` | medium |
| | `PATCH /accounting/usali/mappings`, `DELETE …/mappings/:mappingId`, `POST …/annual-accounts/snapshots` | `accounting.configure` | high |
| | `GET /accounting/gestoria-exports/formats` (low), `GET …/gestoria-exports[/:exportId[/download]]`, `POST /accounting/gestoria-exports` (high) | `analytics.export` | low · medium · high |

Rutas heredadas de `server.ts` que siguen vivas y numeran por el motor:
`GET /organizations/:organizationId/accounts` (409 `CHART_NOT_PROVISIONED` sin
plan), `GET /organizations/:organizationId/journal-entries`, `POST
/journal-entries/drafts`, `POST /journal-entries/:id/post` (las tres con
`accounting.journal.post`, heredado), `GET /accounting/journal-entries/recent`,
`GET /accounting/reports/{trial-balance,balance-sheet,cash-flow,pnl,modelo-111|115|180|303|390}`
(`accounting.reports.read`), `GET|POST /accounting/fiscal-years`, `GET
…/fiscal-years/:id/status`, `POST …/fiscal-years/:id/close|reopen`, `GET|POST
/accounting/fiscal-periods`, `POST …/fiscal-periods/:id/close|reopen`,
`GET /finance/exchange-rates` (calendario: `accounting.read`), `GET
/properties/:propertyId/supplier-bills` y `POST /supplier-bills/drafts`
(borrador heredado: ya no asienta), `GET /properties/:propertyId/fixed-assets`,
`POST /properties/:propertyId/banking/csb43/import` y `POST
/banking/sepa/remittances` (`banking.reconcile`), `GET /payroll/contracts|periods`
(ámbito por `resolveOrganizationScope`), `POST /payroll/contracts`, `POST
/commissions/rules` (zod estricto), `GET /payroll/periods/:id/export`
(vista previa de solo lectura), `GET /dashboards/finance-position`
(`analytics.read`: cobros, pagos y tesorería visibles para toda la plantilla —
sin cambiar, decisión pendiente).

Plantillas (`packages/shared/src/permissions.ts`, catálogo 221 claves = 220 de
organización + 1 de plataforma): `accountant` = lectura de calendario e
informes, `accounting.journal.post`, `accounting.configure`, `banking.read/reconcile`,
`payroll.read/manage`, `procurement.read/manage`, `assets.read/manage`,
`analytics.export`, `commissions.read`…; `manager` y `compliance` llevan
`accounting.reports.read`; `receptionist` conserva `accounting.read`
(calendario) y NO lleva la clave de informes. Propagar a los roles existentes:
§14 (`rbac:sync`).

## 14. Comandos

Desde `/Users/cfernandez/anfitorio-demo/hotelos` salvo indicación; en el Mac solo
existe `corepack pnpm`. Los CLI son dry-run por defecto y exigen `--apply
--confirm <organizationId>` para escribir; auditan un evento por organización;
la cadena de auditoría en memoria del API en marcha se bifurca hasta su
reinicio (deuda 12(c) de `CLAUDE.md`): ejecútalos con los API parados y con
backup previo.

```bash
# 1. Plan de cuentas (idempotente; nunca renombra ni borra)
corepack pnpm --filter @hotelos/api accounting:provision-chart -- --org <orgId> --dry-run
corepack pnpm --filter @hotelos/api accounting:provision-chart -- --org <orgId> --apply --confirm <orgId>

# 2. Re-proyección histórica (facturas, cobros, tickets → asientos; idempotente por documento)
corepack pnpm --filter @hotelos/api accounting:replay -- --org <orgId> --from 2026-01-01 --to 2026-12-31            # dry-run
corepack pnpm --filter @hotelos/api accounting:replay -- --org <orgId> --from 2026-01-01 --to 2026-12-31 --apply --confirm <orgId>
#   (o POST /accounting/replay { from, to, apply, kinds?, propertyId? } con accounting.journal.post + ai.high_risk.confirm)
#   Faranda: dry-run → 60 documentos; apply → 61 asientos; segundo dry-run → 60 «existían».

# 3. Traslado del subledger de clientes 430 → 4300 (fix t6#4; Faranda PENDIENTE, 61 líneas: D 1.487,00 / H 1.108,00)
corepack pnpm --filter @hotelos/api accounting:relabel-customer-account -- --org cmrhw9jy30002fyvb6tsdiugt --dry-run
corepack pnpm --filter @hotelos/api accounting:relabel-customer-account -- --org cmrhw9jy30002fyvb6tsdiugt --apply --confirm cmrhw9jy30002fyvb6tsdiugt
#   Después: replay dry-run 2026 = 60 «existían»; GET /accounting/ledger/4300 muestra el histórico.
#   Libros ya legalizados → NO ejecutar: asiento manual D 4300 / H 430 por el saldo (379,00).

# 4. Propagar la clave accounting.reports.read (y las claves ERP de Contabilidad) a los roles existentes
corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run     # esperado hoy: +0 claves, 8 roles topped up (Faranda Owner +1, Dirección +1, Contabilidad +6, Cumplimiento +1; org_123 ídem), Local Super Admin +1
corepack pnpm --filter @hotelos/api rbac:sync                  # (o reiniciar el API: el arranque hace el mismo top-up)
```

Operaciones por API (todas con zod estricto; importes como cadenas `"121.00"`):

- **Cierre de ejercicio**: `POST /accounting/fiscal-years { code, startDate,
  endDate, propertyId? }` → cerrar cada periodo (`POST
  /accounting/fiscal-periods/:id/close`; exige que no queden borradores) →
  `POST /accounting/fiscal-years/:id/close { createNextYear? }` (regularización
  6xx/7xx → 129, cierre, apertura; `GET …/:id/status` antes) → reabrir: `POST
  …/:id/reopen { reason }` (reversos marcados `year-reopen:*`). Con el
  ejercicio cerrado, cualquier asiento fechado dentro responde 409
  `FISCAL_YEAR_CLOSED`.
- **Amortización**: `GET /organizations/:id/depreciation-runs/preview?period=AAAA-MM`
  (cuotas por elemento, `skipped`, `pendingPeriods`) → `POST
  /organizations/:id/depreciation-runs { period }` mes a mes en orden → `POST
  …/:runId/reverse { reason }` (solo la última). Alta de elementos: `POST
  /properties/:id/asset-register` (categoría o cuenta 20x/21x; coeficiente ≤
  tablas) o desde una línea de factura recibida con `investmentGood`.
- **Liquidación del IVA**: `PUT /fiscal/vat-settings { periodicity, regime,
  prorrataPct?, taxFigure }` (REDEME ⇒ mensual) → `POST /fiscal/vat-books/rebuild
  { period }` si el rango no está materializado → `GET /fiscal/models/303?period=2026-Q3`
  (`casillas`, `avisos`, `fuentes.diario.cuadra`) y `GET …/303/pdf` → `GET
  /fiscal/vat-settlement?period=2026-Q3` (vista previa del asiento) → `POST
  /fiscal/vat-settlement { period }` (D 477.x / H 472.x / H 4750 | D 4700; 409
  `PERIOD_NOT_ENDED` / `ALREADY_SETTLED` / `NOTHING_TO_SETTLE`) → `POST
  …/reverse { period, reason }`. Anuales: `GET /fiscal/models/390|347|180?year=2026`;
  retenciones: `111`/`115` por periodo. `presentacion.modo = "manual"` siempre.
- **Exportaciones**: diario `GET /accounting/journal/export?from&to[&propertyId]`
  (CSV `;` con BOM); mayor `GET /accounting/ledger/:accountCode?from&to&format=csv`;
  gestoría `GET /accounting/gestoria-exports/formats` → `POST
  /accounting/gestoria-exports { format: csv_universal | contaplus_diario |
  vat_books_csv, from, to, propertyId?, subaccountLength? }` → `GET
  …/:exportId/download` (`a3` → 409 `EXPORT_FORMAT_NOT_IMPLEMENTED`;
  `contaplus_diario` con `validateWithAdvisor = true`); cuentas anuales `GET
  /accounting/annual-accounts?fiscalYearId=|from&to[&comparative=1]&format=pdf|xlsx|csv`
  y `POST …/snapshots { kind, fiscalYearId | from,to }`; USALI `GET
  /accounting/usali/pnl?from&to[&propertyId][&format=]`, `…/compare?propertyIds=`,
  `…/periods?periods=2026-01-01..2026-03-31,2025-01-01..2025-03-31`; nóminas
  `POST /payroll/periods/:id/export { format }`.
- **Puertas** (todas en verde el 2026-09-16, §16): `node scripts/typecheck-all.mjs
  --parallel 2` · `node --test tests/*.test.mjs` · `corepack pnpm --filter
  @hotelos/api test` · `cd apps/api && node --import tsx --test
  "../../tests/integration/*.test.mts"` · `node scripts/env-census.mjs` ·
  `node scripts/validate-env.mjs .env --role app` · `node
  scripts/check-discoverability.mjs` · `corepack pnpm --filter @hotelos/database
  db:migrate:status` / `db:drift:check` · `node scripts/check-migrations-vs-schema.mjs`
  · `bash scripts/check-fresh-install.sh` · `corepack pnpm install
  --frozen-lockfile --offline` · `bash .husky/pre-commit`.

## 15. Límites conocidos y qué solo puede aportar César

Lo que el código deja resuelto de forma honesta (nunca simula éxito) pero no
puede completar sin datos, cuentas o decisiones externas:

| Tema | Estado del código | Qué hace falta (solo César) |
| --- | --- | --- |
| Pasarela de pago (PSP) | Stripe Checkout y Redsys (3DES-CBC + HMAC-SHA256, formulario POST, notificación firmada) implementados y probados con `fetch` inyectado y vector propio; sin credenciales el API responde 409 `PSP_NOT_CONFIGURED` y nunca marca `captured`. Una cuenta por instancia (credenciales de entorno). | `STRIPE_SECRET_KEY` (`sk_test_`) + `STRIPE_WEBHOOK_SECRET` o `REDSYS_MERCHANT_CODE/TERMINAL/SECRET_KEY/MODE`, `PAYMENTS_PUBLIC_BASE_URL`; registrar el webhook (Stripe: `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded`) o la URL de notificación en el TPV Virtual; una prueba real contra `sis-t.redsys.es` con un comercio de pruebas. Credenciales por propiedad: lote posterior. |
| Banco | Importación CSB43/CSV persistida, conciliación con efecto contable, remesas SEPA 19/34 generadas y con estado (persistidas en `worker_job_runs` hasta el modelo `SepaRemittance`). | Extractos N43 reales de Faranda (o acceso PSD2/agregador, no implementado), IBAN y BIC de las cuentas, identificador de acreedor SEPA; decidir si las remesas se envían a mano al banco (hoy) o por API bancaria. |
| Gestoría y formatos | CSV universal siempre; «compatible Contaplus/Sage 50 Diario» con `validateWithAdvisor`; A3 no implementado (409). PDF/XLSX con escritores propios (no hay librería en `node_modules` y la regla impide añadirlas): válidos pero sin diseño. | Nombre del programa de la gestoría de Faranda y una importación de prueba del CSV (longitud de subcuenta, codificación); si es A3, el diseño de registro oficial. |
| Modelos AEAT | 303 con casillas seguras (01-09, 16-24, 27-31, 45, 46, 64-66, 69-71, 77, 78, 87, 110); 390 y 347 por clave sin numeración afirmada; 111/115/180 numerados; resumen JSON + PDF; `presentacion.modo = manual`. Fichero oficial (diseño de registro BOE) no generado. | Confirmar con la gestoría la numeración de 390/347 y si se quiere el fichero de presentación (exige el diseño de registro y pruebas en la sede). Rectificativa por sustitución REC-2026-000003: decidir el criterio de libros (restar la sustituida: art. 15.5 RD 1619/2012 / SII `TipoRectificativa S`) — cambia el 303 2026-Q3 de Faranda en 4,55. |
| Certificados y VeriFactu | Cadena VeriFactu en sandbox declarado (`stub://verifactu-mock`); QR y huella en el PDF. | Certificado electrónico del representante, `VERIFACTU_SOFTWARE_*` de la declaración responsable y el paso sandbox → producción (`docs/compliance/verifactu-declaracion-responsable.md`). |
| Periodicidad y régimen de IVA de Faranda | `VatSettings` con defaults trimestral/general/IVA; Faranda sin fila (se crea al primer `PUT /fiscal/vat-settings` o uso). | Confirmar trimestral vs REDEME (mensual), prorrata (si hay actividad exenta) y si alguna propiedad está en Canarias/Ceuta/Melilla (IGIC/IPSI: excluidos del 303 con aviso; Modelo 420 no implementado). |
| Faranda: saneamientos que escriben en el piloto | CLI verificados en dry-run: traslado 430 → 4300 (61 líneas), `rbac:sync` (8 roles), night audit de Rías Altas (13/09) y Los Tilos (14/09) nunca ejecutado (cargará el alojamiento desde la tarifa y avisará de las reservas sin tarifa; 13 folios AUDIT con saldo se conservan). | Autorizar y ejecutar (backup + API parados) en el orden §14; decidir los 17 asientos de facturas AUDIT en `705` genérica (sin categoría fiscal) y las 33 filas al 0 % (`ES_UNKNOWN_0`, IVA sin configurar en su día). |
| Nóminas | Cálculo con los porcentajes de SS del régimen general (6,35 % / 30,5 %) sin tablas de cotización reales ni `payCount` 14 pagas; exportes «compatible A3/Sage» marcados `validateWithAdvisor`; NIF de empleado no almacenado. | Datos de convenio y bases de cotización reales (o la gestoría laboral sigue llevando las nóminas y aquí solo se asientan). |
| Email de factura | Adjunta el PDF real; sin proveedor responde `{ status: "simulated" }` y lo audita. | `EMAIL_PROVIDER` + clave (Postmark/SendGrid) en el VPS; el dispatcher de notificaciones aún no reenvía adjuntos (handoff `providers/types.ts`). |
| Front | Ninguna pantalla consume todavía las rutas nuevas (siguiente workflow): lista en el informe de cierre §5. | Prioridad de pantallas. |

Límites técnicos asumidos: PDF/XLSX sin diseño gráfico; contenido de las
exportaciones inline en `GestoriaExport` (tope 20 MB, sin almacén de objetos);
adjuntos de facturas recibidas como `data:` URI ≤ 512 KiB; comisiones con base
`net_revenue` estimadas cuando no hay factura (aviso); PAR USALI sin descontar
habitaciones fuera de servicio (el PMS no lo registra por noche); fecha de
negocio del TPV = día natural local (Atlantic/Canary puede diferir de la fecha
contable en Europe/Madrid entre 23:00 y 00:00); duplicado residual de
simplificada entre DOS instancias del API cerrando la misma comanda en el
mismo instante (mutex por proceso; el segundo cierre responde 409 pero puede
dejar una F2 huérfana); estado de la proyección por proceso.

## 16. Puertas del cierre (2026-09-16, integración final)

Working tree completo, sin commit, servidores :3000/:5173 sin reiniciar (sirven
el código anterior hasta que el integrador humano los reinicie):

| Puerta | Resultado |
| --- | --- |
| `node scripts/typecheck-all.mjs --parallel 2` | 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 24,0 s |
| `node scripts/check-discoverability.mjs` | 200 screens alcanzables · 167/167 URLs · 0 broken links · placeholders 16/20 |
| `node --test tests/*.test.mjs` (contratos) | 410 tests · 410 pass · 0 fail |
| `corepack pnpm --filter @hotelos/api test` (unitarios) | 1.220 tests · 1.219 pass · 0 fail · 1 skipped (preexistente) |
| `test:integration` (`tests/integration/*.test.mts`, 14 ficheros — 10 nuevos en esta tanda —, in-process sobre Postgres local) | 194 tests · 189 pass · 0 fail · 5 skipped (preexistentes: H2 sin folio abierto en el demo; 4 casos de sesión limitada sin `INTEGRATION_RECEPTION_EMAIL/_PASSWORD`) |
| `node scripts/env-census.mjs` · `validate-env.mjs .env --role app` | 136 variables leídas · 136 documentadas · ficheros generados en sincronía · contrato OK (14 avisos de valores de ejemplo) |
| `db:migrate:status` · `db:drift:check` · `check-migrations-vs-schema.mjs` | 5 migraciones aplicadas, «Database schema is up to date!» · «No difference detected.» · 264 tablas / 24 enums en sincronía |
| `bash scripts/check-fresh-install.sh` | OK: 5 migraciones → 264 tablas, 1 organización, 79 permisos, sin drift, sin objetos fuera de Prisma (4 s) |
| `corepack pnpm install --frozen-lockfile --offline` | «Lockfile is up to date» · «Already up to date» (el lockfile se regeneró con `install --offline` al declarar `qrcode-terminal` 0.11.0 como devDependency del API — referencia del test del codificador QR — y de paso cubre `@fontsource-variable/inter`, `zod` y `@playwright/test` de admin-web, deuda 12(a)) |
| `rbac:sync -- --dry-run` | catálogo 221 claves · +0 · 8 roles por completar (no aplicado: escribe `role_permissions` de Faranda) |
| `bash .husky/pre-commit` | discoverability + typecheck-all OK |

Faranda (solo lectura): 61 asientos / 150 líneas / Σ 2.595,00 = 2.595,00 (sin
cambios respecto a §11); 0 `vat_settings`, 0 `vat_book_entries`, 0
`pos_orders`, 0 `cash_closures`, 0 `night_audit_runs`, 0 `supplier_bills`, 0
`fixed_assets`; roles sin `accounting.reports.read` hasta `rbac:sync`.
