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
| `PayrollCostImportStatus` | `draft` · `posted` · `reversed` | Lote de coste de personal importado (`PayrollCostImport.status`, Tanda 6c, §18): borrador sin asientos → contabilizado (un asiento por centro × mes) → revertido (todos sus asientos reversados; el hash del fichero queda libre). |
| `CashClosureStatus` | `open` · `closed` · `approved` | Arqueo: abierto (turno) → cerrado (recuento) → aprobado (dirección). |
| `VatBook` | `emitidas` · `recibidas` · `bienes_inversion` | Libros registro de IVA (RD 1619/2012). |
| `VatBookSourceType` | `invoice` · `rectification` · `simplified` · `supplier_bill` · `expense` · `sage200` | Documento origen de una fila del libro. `sage200` (Tanda 7c, §19): fila importada del Libro Registro de IVA de Sage 200 (`sourceId <empresa>:<ejercicio factura>:<serie>:<factura>[:<NIF>][:R]`, el NIF solo en recibidas); `rebuildVatBooks` la conserva y el lote omite los documentos propios de Anfitorio (nunca la misma factura como `sage200` e `invoice` / `supplier_bill`). Primer `ALTER TYPE … ADD VALUE` de la cadena de migraciones (`20260917110000_sage200_importacion`). |
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
  `payroll_payment` · `payroll_cost_import` (coste de personal importado, Tanda 6c,
  §18: D 640 / D 642 por centro de coste USALI, H 465 / H 476) ·
  `pms_shadow_revenue` (ingresos diarios de OPERA en modo sombra, Tanda 7b,
  `docs/runbooks/opera-modo-sombra.md` §8: un asiento por (hotel, business date)) ·
  `sage200_journal` (diario importado de Sage 200, Tanda 7c, §19: un asiento por
  (asiento Sage, centro), con el número Sage en `reference`) · `sage200_balance`
  (saldos importados de Sage 200 por periodo, Tanda 7c, §19: un asiento resumen
  por (ejercicio, periodo, centro) más la apertura del ejercicio) · `commission` ·
  `depreciation` · `vat_settlement` ·
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
  `depreciation_reversal:<runId>`; reapertura de ejercicio → `year-reopen:*`;
  coste de personal importado → `payroll_cost_import` /
  `<importId>:<propertyId>:<periodCode>` (un asiento por centro y mes; nunca el
  sufijo `#n`: cada lote lleva un `importId` nuevo, y el reverso del lote reversa
  por asiento con `reverseJournalEntry`); ingresos diarios de OPERA →
  `pms_shadow_revenue` / `<propertyId>:<YYYY-MM-DD>` (un asiento por hotel y
  business date; `replace` reversa el del día y vuelve a contabilizar con `#n`);
  diario importado de Sage 200 → `sage200_journal` /
  `<CodigoEmpresa>:<Ejercicio>:<NumeroPeriodo>:<Asiento>[:<CodigoCanal|IdDelegacion>][:<propertyCode>]`
  (el periodo forma parte de la clave porque en Sage el número de asiento solo es
  único dentro de un periodo; el canal solo si Sage numera por canal; el centro
  solo cuando el asiento se reparte por centro; la apertura de Sage usa el mismo
  `sourceType` con `entryKind opening`; tras un reverso la clave se reutiliza con
  `#n`); saldos importados de Sage 200 → `sage200_balance` /
  `<CodigoEmpresa>:<Ejercicio>:<periodo>:<propertyCode|SOC>` (`periodo` =
  `YYYY-MM` · `YYYY-Qn` · `YYYY` · `apertura` · `regularizacion` · `cierre`).
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
- `PayrollCostImport.source`: `csv` · `json` · `informe_rrhh` (origen del lote de coste
  de personal importado, Tanda 6c, §18.2).
- `PayrollCostLine.costGroup`: `operaciones` · `extras` · `estructura` ·
  `mantenimiento_obra` · `familia` (`PAYROLL_COST_GROUPS` en
  `packages/shared/src/payroll-cost-types.ts`).
- `PayrollCostLine.usaliDepartment`: `rooms` · `fnb` · `other_operated` ·
  `admin_general` · `it` · `sales_marketing` · `pom` (solo los departamentos que
  admiten la línea `labor`; §4 paso 0 y §18.2).
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

**`PayrollCostImport`** (`payroll_cost_imports`, Tanda 6c, §18.2): un lote por fichero
de coste de personal AGREGADO (nunca por persona): `organizationId`, `legalEntityId?`
(de `resolveLedgerScope`), `source` (`csv` · `json` · `informe_rrhh`), `fileName?`,
`contentHash` (sha256 del contenido normalizado: idempotencia, 409
`PAYROLL_IMPORT_DUPLICATE` mientras exista un lote no revertido con el mismo hash),
`periodFrom`/`periodTo` (`YYYY-MM`), `status` (`PayrollCostImportStatus`), `rowCount`,
`totalGross`/`totalEmployerSs`/`totalCost` (= Σ bruto + SS empresa, lo contabilizado),
`reportedTotalCost?` (Σ `coste_total` del fichero, informativo), `headcountAverage?`,
`mappingJson` (mapeo aplicado), `journalEntryIds[]` (un asiento por centro × mes,
`sourceType = payroll_cost_import`), `reversalJournalEntryIds[]`, `notes?`,
`createdBy?`, `postedAt?`, `reversedAt?`, `reversedBy?`, `reversalReason?`.

**`PayrollCostLine`** (`payroll_cost_lines`, FK al lote con `onDelete: Cascade`):
fila agregada centro × mes × grupo × departamento: `organizationId` (desnormalizado,
sin FK), `propertyId`, `workCenterLabel` (etiqueta ORIGINAL del informe: varias
etiquetas pueden ir al mismo centro), `costGroup`, `departmentLabel` (original),
`usaliDepartment`, `costCenterId?` (se rellena al contabilizar), `periodCode`,
`gross`/`employerSs`/`totalCost`/`reportedTotalCost?`, `headcount` (decimal, admite
jornadas parciales); única por `(importId, workCenterLabel, periodCode, costGroup,
departmentLabel)`.

**`PayrollCostReference`** (`payroll_cost_references`, FK Cascade): referencia del
informe por centro × mes para los ratios y el headcount USALI de respaldo:
`organizationId`, `propertyId`, `workCenterLabel?`, `periodCode`, `employeesReported?`,
`roomsAvailableReported?` (inventario de habitaciones, no habitaciones-noche),
`netSalesReported?`; única por `(importId, propertyId, periodCode)`.

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
| `payroll_cost_imports`, `payroll_cost_lines`, `payroll_cost_references` (Tanda 6c, §18) | lote coste de personal importado (`payroll/cost-import.service.ts`: la previsualización nunca escribe; crear / contabilizar / revertir en una transacción bajo advisory lock; CLI `payroll:import-cost`) | informe `GET /payroll/cost-report` (líneas de lotes `posted` + referencias), USALI y PyG por centro / reparto (headcount de respaldo cuando no hay recibos: `employeesReported` o Σ `headcount`), front Nóminas › Coste de personal |
| `cost_centers` (`type = usali`, `code` = departamento USALI en mayúsculas) y `journal_lines.cost_center_id` | lote coste de personal importado (`upsert` por `(propertyId, code)` al contabilizar), nóminas reales con contrato con centro de coste, asientos manuales | USALI por centro de coste (`accountBalances({ byCostCentre: true })`, §4 paso 0); el resto de estados ignora el centro de coste |
| `ledger_imports`, `ledger_import_entries`, `ledger_import_balances`, `ledger_account_maps`, `ledger_analytics_maps`, `ledger_third_parties`, `ledger_reconciliations` (Tanda 7c, §19) | lote importación desde Sage 200 (`accounting/import/ledger-import.service.ts`: la previsualización nunca escribe; crear / contabilizar / revertir en una transacción bajo `pg_advisory_xact_lock('ledger_import:<org>')`; reconciliación en `ledger-reconciliation.service.ts` tras el commit; CLI `sage200:import`). Efectos fuera de sus tablas: `journal_entries` / `journal_lines` SIEMPRE vía `postJournalEntry` (`sourceType sage200_journal` / `sage200_balance`, `entryKind` apertura / regularización / cierre de Sage); `accounts` por `prismaChartStore(tx).createAccounts` (solo altas, nunca renombra ni borra); `fiscal_years` / `fiscal_periods` por `tx.fiscalYear` / `tx.fiscalPeriod.create` replicando las validaciones de `createFiscalYear`, y cerrados por `markFiscalYearClosedFromImport` (sin asientos propios; reabrir = revertir el lote, 409 `FISCAL_YEAR_CLOSED_FROM_IMPORT`); `vat_book_entries` con `sourceType sage200` **protegidas de `rebuildVatBooks`**; `cost_centers usali` por `upsert`; `suppliers` solo con `createSuppliers` (`findFirst` por NIF + create / update) | diario, mayor, sumas y saldos, balance, PyG, cuentas anuales (`comparative`), USALI por centro, 303 / 347 / 390 (libros importados + nativos), reconciliación (`aggregateAccountBalances`), front Finanzas › Contabilidad › «Importar desde Sage 200» (`/finanzas/contabilidad/importar-sage200`); runbook `docs/runbooks/finanzas-importacion-sage200.md` |
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

0. **Centro de coste `usali`** (Tanda 6c, §18.6). Si la línea lleva `costCenterId` y ese
   `CostCenter` tiene `type = "usali"` y `code` = departamento USALI en mayúsculas
   (`ROOMS`, `FNB`, `POM`, `SALES_MARKETING`, `ADMIN_GENERAL`, `OTHER_OPERATED`, `IT`),
   la línea `labor` / `other_expense` resuelta por los pasos 1-3 se **enruta al
   departamento del centro de coste** (`routeByCostCentre` en `usali.service.ts`;
   la cuenta aparece con `source: "cost_center"` en el detalle por departamento).
   Solo se mueven `labor` y `other_expense` y solo si `USALI_DEPARTMENT_LINES` admite
   la combinación (`utilities.labor` no está admitida → no se mueve); `revenue`,
   `cost_of_sales`, honorarios, no operativos y bajo EBITDA nunca cambian de
   departamento; los centros `operating` / `cost` de los seeds y los códigos
   desconocidos se ignoran; una cuenta sin mapeo sigue en «Sin asignar». Invariantes:
   los totales PGC (`pgcRevenue` / `pgcExpense`) se acumulan ANTES del enrutado, así
   que `reconciliation`, GOP, EBITDA y resultado son idénticos con y sin centros de
   coste (solo cambia el reparto de la línea entre departamentos); el lector agrupa
   por `(cost_centers.type, code)` —nunca por `id`—, la partición suma exactamente el
   total de la cuenta y el consolidado funde `RA/ROOMS` con `LT/ROOMS`; sumas y
   saldos, balance, PyG, ECPN, memoria, PyG por centro y gestoría siguen leyendo por
   cuenta. **Advertencia de alcance:** el enrutado afecta a CUALQUIER apunte con
   `cost_center_id` de tipo `usali` — el coste de personal importado (§18), las
   nóminas reales cuyo contrato tenga centro de coste (`contract.costCenterId`,
   `posting-rules.ts`) y los asientos manuales con centro de coste —. Es la capacidad
   buscada (un solo origen de verdad del departamento), pero un centro de coste
   `usali` mal asignado mueve gasto entre departamentos del USALI sin tocar el PGC.
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
(`640`/`642` sin desglosar → Administración y general, salvo que el apunte lleve
centro de coste `usali`: paso 0); `68x` amortización;
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

Coste de personal por centro de coste (Tanda 6c, §18.6): las cuatro lecturas que
alimentan `computeUsaliPnl` (`buildUsaliPnl` y las tres de `compareUsaliProperties`)
piden `accountBalances({ byCostCentre: true })` y cada fila `labor` / `other_expense`
con centro de coste `usali` se enruta al departamento del centro (§4 paso 0); en
`accountsByDepartment[].accounts[]` esa cuenta lleva `source: "cost_center"`
(`UsaliAmountSource = UsaliMappingSource | "cost_center"`; `UsaliMappingSource` no
cambia, así que `buildCoverage` y las etiquetas del front siguen igual) y el front la
marca con el badge «Centro de coste». `statistics.headcount` /
`statistics.headcountSource` (`payroll_slips` · `payroll_cost_import` · `null`):
recibos de nómina del periodo por centro como hasta ahora; si no hay, media mensual
de los empleados de los lotes de coste importado `posted` (`employeesReported` de la
referencia del informe por centro × mes o, en su defecto, Σ `headcount` de las
celdas; media solo de los meses con dato, 2 decimales; redondeo de la suma de
centros a personas enteras); sin datos → `null`, nunca 0. `ratios.laborPerEmployee`
= Σ línea `labor` de todos los departamentos / `headcount` (`null` si el headcount es
nulo o 0). La SQL sin flag (balance, PyG, ECPN, memoria, PyG por centro, gestoría) es
byte-idéntica a la anterior.

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
figura la clave EFECTIVA en el borde. Desglose por partial (el total único dejó de
tener sentido cuando los partials de PMS empezaron a llevar rutas con importes):
118 entradas de Finanzas (partials `accounting` ledger + fiscal, `invoicing`,
`payments`, `pos`, `night-audit`, `payables`, `fixed-assets`, `treasury`,
`financial-statements`) + 9 del módulo `structure` (Tanda 6b, §17.8) + 7 del partial
`payroll` (coste de personal importado, Tanda 6c, §18.7) + **15 del partial
`accounting (ledger-import)`** (importación desde Sage 200, Tanda 7c, §19:
`modules/accounting/ledger-import-route-permissions.partial.ts`, envuelto con
`requireAccountingReportsKey`; la lectura de la plantilla incluida). Fuera de
Finanzas pero en el mismo manifiesto: 6 del partial `pms` (importación masiva de
reservas, Tanda 7) y 15 del partial `pms-shadow` (OPERA Cloud en modo sombra, Tanda
7b), documentados en `docs/api-contracts.md` y no en esta tabla.

| Módulo (partial) | Ruta | Clave efectiva | Riesgo |
| --- | --- | --- | --- |
| accounting (ledger) | `GET /accounting/journal`, `GET …/journal/export`, `GET …/journal/:id`, `GET /accounting/ledger/:accountCode`, `GET /accounting/chart`, `GET /accounting/settings`, `GET /accounting/projection/status` | `accounting.reports.read` | medium |
| | `POST /accounting/journal` | `accounting.journal.post` | high |
| | `POST /accounting/journal/:id/reverse`, `POST /accounting/replay` | `accounting.journal.post` + `ai.high_risk.confirm` | critical |
| | `POST /accounting/chart`, `PATCH /accounting/chart/:code`, `PATCH /accounting/settings` | `accounting.configure` | high |
| accounting (fiscal) | `GET /fiscal/vat-settings`, `GET /fiscal/regime` (Tanda 6b), `GET /fiscal/vat-books`, `GET /fiscal/models/:modelo`, `GET …/:modelo/pdf`, `GET /fiscal/vat-settlement` | `accounting.reports.read` | medium |
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
| financial-statements | `GET /accounting/usali/mappings|coverage|pnl|compare|periods`, `GET /accounting/annual-accounts[/balance|/pyg|/ecpn|/memoria]`, `GET …/annual-accounts/snapshots[/:snapshotId[/download]]`, `GET /accounting/pnl/by-property` y `GET /accounting/allocation` (Tanda 6b) | `accounting.reports.read` | medium |
| | `PATCH /accounting/usali/mappings`, `DELETE …/mappings/:mappingId`, `POST …/annual-accounts/snapshots`, `PUT /accounting/allocation` (Tanda 6b) | `accounting.configure` | high |
| | `GET /accounting/gestoria-exports/formats` (low), `GET …/gestoria-exports[/:exportId[/download]]`, `POST /accounting/gestoria-exports` (high) | `analytics.export` | low · medium · high |
| structure (Tanda 6b) | `GET /organizations/me/structure` (redactada sin `accounting.entity.read` ∨ `organization.structure.manage`) | `accounting.read` | medium |
| | `GET /legal-entities/:legalEntityId` | `accounting.entity.read` | medium |
| | `GET /legal-entities/:legalEntityId/series` | `billing.configure` | medium |
| | `GET /legal-entities/:legalEntityId/verifactu/installations` | `accounting.configure` | medium |
| | `POST /legal-entities` (409 `MULTI_ENTITY_NOT_ENABLED` con sociedad existente), `PATCH /legal-entities/:legalEntityId` (+ `ai.high_risk.confirm` y `confirmHighRisk` en NIF, razón social, SII, gran empresa, PGC y ejercicio; régimen además `accounting.configure`), `POST /legal-entities/:legalEntityId/properties`, `PATCH /properties/:propertyId/establishment` | `organization.structure.manage` | high |
| | `POST /admin/legal-entities/:legalEntityId/verifactu-scope` (consola de plataforma) | `admin.tenants.manage` | critical |
| payroll (Tanda 6c · coste de personal importado, `modules/payroll/route-permissions.partial.ts`) | `POST /payroll/cost-imports/preview` (nunca escribe) | `payroll.manage` (servicio: o `accounting.journal.post`) | medium |
| | `POST /payroll/cost-imports` (crear + contabilizar; `post: false` deja borrador) | `payroll.manage` (servicio: o `accounting.journal.post`) | high |
| | `GET /payroll/cost-imports` (solo lotes con TODOS sus centros en ámbito) | `payroll.read` (servicio: o `payroll.manage` / `accounting.journal.post`) | medium |
| | `GET /payroll/cost-imports/:id` (tenencia: 404 opaco `PAYROLL_IMPORT_NOT_FOUND`) | `payroll.read` | medium |
| | `POST /payroll/cost-imports/:id/post` (borrador → contabilizado) | `payroll.manage` (servicio: o `accounting.journal.post`) | high |
| | `POST /payroll/cost-imports/:id/reverse` (espejo de `POST /payroll/periods/:id/pay`; idempotente) | `payroll.manage` (servicio: o `accounting.journal.post`) | critical |
| | `GET /payroll/cost-report` (sin `propertyId` = toda la sociedad → `accounting.entity.read`; nunca `accounting.read` ni `analytics.read`) | `payroll.read` | medium |
| accounting (ledger-import) (Tanda 7c · importación desde Sage 200, `modules/accounting/ledger-import-route-permissions.partial.ts`, envuelto con `requireAccountingReportsKey`; rutas en `modules/accounting/ledger-import.routes.ts`, registradas en `server.ts` junto a `registerLedgerRoutes`; ámbito R11 por `assertFinanceReadScopeMany` sobre los centros del mapa) | `POST /accounting/ledger-imports/preview` (nunca escribe; `bodyLimit` 30 MiB) · `POST /accounting/ledger-imports/reconciliation` (escribe solo `ledger_reconciliations`; `bodyLimit` 30 MiB) | `accounting.journal.post` | medium |
| | `POST /accounting/ledger-imports` (crear + contabilizar; `post: false` deja borrador; `bodyLimit` 30 MiB) · `POST /accounting/ledger-imports/:id/post` (borrador → contabilizado, `{ replace? }`) | `accounting.journal.post` | high |
| | `POST /accounting/ledger-imports/:id/reverse` (`{ reason 3..500 }`; 200 idempotente; espejo de `POST /accounting/journal/:id/reverse`) | `accounting.journal.post` + `ai.high_risk.confirm` | critical |
| | `GET /accounting/ledger-imports` (`?kind=&status=&from=&to=&limit=`), `GET /accounting/ledger-imports/:id` (`?offset=&limit=` pagina las entradas, 500 / máx. 2.000; tenencia: 404 opaco `LEDGER_IMPORT_NOT_FOUND`, resolver `ledgerImport` en `lib/tenancy.ts`), `GET /accounting/ledger-imports/account-map`, `GET /accounting/ledger-imports/analytics-map`, `GET /accounting/ledger-imports/reconciliation` (`?from=&to=&propertyId=&limit=`), `GET /accounting/ledger-imports/reconciliation/:id`, `GET /accounting/ledger-imports/reconciliation/:id/csv` (404 opaco `LEDGER_RECONCILIATION_NOT_FOUND`) | `accounting.reports.read` (el partial escribe `accounting.read`; remap obligatorio: `finance-report-keys.test.mts` rechaza cualquier GET `/accounting/*` con `accounting.read`) | medium |
| | `GET /accounting/ledger-imports/template` (`?kind=&format=csv`, plantilla canónica) | `accounting.reports.read` | low |
| | `PUT /accounting/ledger-imports/account-map` (valida `accountCode` con el patrón, existencia y postabilidad; `create` da de alta la subcuenta en la misma transacción que persiste el mapa, `prismaChartStore(tx)`), `PUT /accounting/ledger-imports/analytics-map` (`propertyId` de la organización) | `accounting.configure` | high |

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

# 5. Coste de personal importado (Tanda 6c, §18.9): informe de RRHH AGREGADO (CSV o JSON, nunca por persona) → un asiento por centro y mes
corepack pnpm --filter @hotelos/api payroll:import-cost -- --file <ruta.json|ruta.csv> --organization <orgId>                 # dry-run (por defecto): nada escrito
corepack pnpm --filter @hotelos/api payroll:import-cost -- --file <ruta> --organization <orgId> --apply --confirm <orgId> [--replace] [--json]
#   Faranda: dry-run → 363 filas · 48 celdas centro × mes · 40 referencias · 0 sin mapear · 1 aviso de coste_total; apply UNA vez → 48 asientos (62..109).
#   --replace reversa ENTEROS los lotes que dupliquen o solapen: nunca sobre Faranda salvo para sustituir el rango completo.

# 6. Importación contable desde Sage 200 (Tanda 7c, §19; runbook docs/runbooks/finanzas-importacion-sage200.md §7): un lote por fichero y tipo
corepack pnpm --filter @hotelos/api sage200:import -- --type plan|fiscal_years|journal|vat_books|third_parties|balances --file <ruta> --organization <orgId> \
    [--entity <legalEntityId>] [--format sage_excel|sage_ime_csv|sage_xml|canonical_csv|canonical_json] [--sheet <hoja>] [--mapping <ruta.json>] \
    [--unassigned block|office] [--dry-run | --apply --confirm <orgId>] [--replace] [--allow-closed --reason "…"] \
    [--reconcile --balance <sumas-y-saldos> [--from AAAA-MM-DD --to AAAA-MM-DD --property <código>]] [--json]
corepack pnpm --filter @hotelos/api sage200:import -- --type plan --file plan-cuentas.xlsx --organization <orgId>                       # dry-run: acción propuesta por cuenta Sage
corepack pnpm --filter @hotelos/api sage200:import -- --type journal --file diario-2026-09.csv --organization <orgId> --json           # dry-run: LedgerImportPreview íntegro
corepack pnpm --filter @hotelos/api sage200:import -- --type journal --file diario-2026-09.csv --organization <orgId> \
    --reconcile --balance sumas-y-saldos-2026-09.xlsx --from 2026-09-01 --to 2026-09-30 --apply --confirm <orgId>                       # contabiliza y reconcilia el mes
corepack pnpm --filter @hotelos/api sage200:import -- --reverse <importId> --reason "Mes reexportado desde Sage" --confirm <orgId>     # reverso por lote (idempotente)
corepack pnpm --filter @hotelos/api sage200:import -- --template journal --out plantilla-diario.csv                                    # plantilla canónica
#   Orden: plan → fiscal_years → journal (por meses) → vat_books → third_parties → balances (ejercicios sin diario) → reconciliación.
#   Usuario de sistema usr_system_sage200_import; salida 2 uso · 1 fallo o canPost:false · 0 ok. Ficheros > 20 MiB o > 20.000 asientos: solo por CLI y troceados por meses.
#   --replace reversa ENTEROS los lotes que dupliquen o solapen (empresa, ejercicio, periodo, asiento): nunca sobre Faranda salvo para sustituir un mes completo.
#   --allow-closed --reason: contabiliza en periodos cerrados de Anfitorio (auditado); por HTTP allowClosed → 400 VALIDATION_ERROR.
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

## 17. Estructura societaria (Tanda 6b · 2026-09-16)

Diseño: `docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md` (§5.1 modelo, §5.2 reglas
R1-R11, §5.4 API, §5.5 migración, §6 lotes). Informe de cierre para César:
`docs/audits/TANDA-6B-ESTRUCTURA-BACKEND-2026-09-16.md`. Esta sección es la
operativa completa del **backend** de la tanda: L1 (schema, migraciones, backfill y
helpers, §17.1-17.5), las reglas y rutas de L2-L5 (§17.7-17.8), las 17 correcciones
de la revisión adversarial (§17.6), los comandos (§17.9), los límites y aplazados
(§17.10) y las puertas del cierre (§17.11). Ningún cálculo de la Tanda 6 cambia de
ámbito: plan, diario, libros, modelos, ejercicios, cuentas anuales y USALI siguen
por `organizationId` = la sociedad única, resuelto por `resolveLedgerScope`; lo que
cambia son la identidad emisora, las series, la cadena VeriFactu, las guardias
(centro obligatorio en 6/7, permisos por centro, alto riesgo en la sociedad) y las
etiquetas. El front (L6/L7) y la migración de Faranda a CELUISMA (L8) quedan fuera.

### 17.1 Modelo: Grupo → Sociedad → Centro de trabajo

```
Organization (grupo · tenant: usuarios, roles, proveedores, mapeo USALI, módulos)
 └── LegalEntity (sociedad = NIF · exactamente UNA por organización en esta tanda, isDefault)
      ├── Property kind=hotel  (RA, LT…)  series · instalación VeriFactu · habitaciones, TPV, tasa, SES
      └── Property kind=office (OC)       sin habitaciones · nóminas, gastos, bancos, inmovilizado, retenciones
```

- **`LegalEntity`** (`legal_entities`): `organizationId`, `code` (2-6 mayúsculas,
  `@@unique(organizationId, code)`), `legalName`, `taxId` (normalizado, checksum
  válido o `null` = «NIF pendiente»; **único** cuando existe), `legalForm`
  (`LegalForm`: sa · sl · slu · coop · persona_fisica · otra), domicilio fiscal
  (`fiscalAddress/PostalCode/Municipality/IneCode/Province`), domicilio social
  (`registeredOffice*`), `mercantileRegistry`, `cnae`, `pgcVariant` (`PgcVariant`:
  pymes · general), `fiscalYearStartMonth`, `largeCompany`, `siiEnabled`,
  `verifactuChainScope` (`VerifactuChainScope`: per_center · per_entity, defecto
  per_center), `cccPrincipal`, `isDefault`, `status` (`LegalEntityStatus`).
- **`VerifactuInstallation`** (`verifactu_installations`): una «facturación» por
  centro (`per_center`) o por sociedad (`per_entity`): `legalEntityId`, `propertyId?`,
  `numeroInstalacion` (**inmutable por trigger**, `@@unique(legalEntityId,
  numeroInstalacion)`), `route` (`VerifactuRoute`: verifactu · tbai · igic),
  `territory?`, `active`, `retiredAt?`. Cambiar de ámbito nunca re-encadena: se
  retira la fila y se abre otra con número nuevo. Sustituye a
  `VERIFACTU_INSTALL_NUMBER` (env = fallback solo sandbox, L3 lo cablea).
- **`Property`** gana `legalEntityId` (FK `Restrict`), `kind` (`PropertyKind`: hotel ·
  office · other, defecto hotel), `code` (`@@unique(legalEntityId, code)`),
  `tradeName` (nombre comercial en el bloque establecimiento de la factura) y las
  columnas censales `cadastralReference`, `surfaceM2` (Decimal 10,2), `iaeEpigraph`,
  `bedCapacity`, `starRating`, `openingMonths`, `tourismRegistryNumber`,
  `sesEstablishmentCode`, `socialSecurityCcc`, `laborCenterCode` (se informan y
  exportan a la gestoría; Anfitorio no liquida IAE ni TGSS).
- **`InvoiceSequence.legalEntityId`**, **`Invoice.legalEntityId` /
  `installationId`**, **`VerifactuSubmission.installationId`**,
  **`BankAccount.legalEntityId`**: nulables, rellenados por el backfill.
- **`AccountingSetting.configurationJson.corporateAllocation`** (solo contrato, sin
  columna): `{ method: none|revenue|rooms_available|headcount|manual, weights? }`,
  reparto de la oficina central **solo en informes** (L5).

Dónde vive cada dato (contrato): NIF, razón social, domicilios, RM, CNAE, forma,
CCC principal, gran empresa/SII, plantilla PGC, inicio de ejercicio y política de
cadena → **sociedad** (única fuente). Nombre comercial, código, dirección, INE,
territorio, censales, series y prefijos, `verifactuEnabled`, instalación y cadena,
tasa turística, `PropertyComplianceSetting`, facturas recibidas, gastos,
inmovilizado, arqueos, retenciones → **centro** (la oficina incluida). Bancos →
sociedad por defecto (centro opcional). Plan, numeración, ejercicios, libros IVA,
modelos, cuentas anuales → sociedad, con ámbito `organizationId` resuelto por
`resolveLedgerScope`. Proveedores, usuarios, roles, `UsaliMapping`, módulos → grupo.

**Deprecados (columnas conservadas, marcadas `/// deprecated` en el schema):**
`Organization.legalName`, `Organization.taxId` (solo los lee `resolveLegalIdentity`
como fallback de un tenant sin backfill), `Property.legalName` (copiado a
`tradeName` cuando difería de la razón social; nadie lo lee como emisor),
`PropertyComplianceSetting.siiEnabled` (el régimen es de la sociedad). El contract
test `tests/legal-identity-readers-contract.test.mjs` hace `grep` de los módulos de
Finanzas y `packages/compliance`: los siete lectores heredados (`modelo-303`,
`issuer-identity`, `annual-accounts`, `financial-statements/source` y `.routes`,
`sepa-remittance`, `payroll/export`) están en una lista que **solo puede encoger**
(L3/L4/L5 la vacían; C8 es este test con la lista vacía).

### 17.2 Migraciones (dos pasos, drift 0)

- `20260916100000_estructura_societaria` (paso 1, aditivo y nulable): 6 enums, 2
  tablas, columnas nuevas, 2 FK (`properties` y `verifactu_installations` →
  `legal_entities`, `ON DELETE RESTRICT`) y dos triggers escritos a mano (Prisma no
  los declara y `migrate diff --from-schema-datasource` los ignora, verificado en
  una BD de prueba):
  - `verifactu_installations_numero_inmutable`: `numero_instalacion` y
    `legal_entity_id` no cambian nunca (excepción `integrity_constraint_violation`).
  - `invoices_issuer_inmutable` (`BEFORE UPDATE OF issuer_tax_id, issuer_legal_name`):
    en una factura que ya no es borrador el snapshot del emisor no se reescribe; un
    snapshot `NULL` sí puede **rellenarse** (`backfillInvoiceIssuerSnapshots`).
- `20260916101000_estructura_societaria_harden` (paso 2): informe de duplicados en
  la BD local (2026-09-16) → **NIF limpio** (2 organizaciones, 2 NIF válidos y
  distintos) → se crea `legal_entities_tax_id_key` (índice único simple = parcial
  `WHERE tax_id IS NOT NULL`, porque Postgres trata los NULL como distintos y así
  Prisma lo declara con `@unique`). Rellena `invoice_sequences.prefix` heredados
  nulos (`<code>-<year>-`; en local 8/8 ya lo tenían). **Aplazado y documentado en
  la cabecera**: `prefix NOT NULL` (`patchBillingSettings`, fichero de L2, aún
  escribe `null` para «prefijo por defecto» y el typecheck del API rompe con la
  columna no nulable → cae con L2 mapeando vacío al prefijo R3);
  `properties/invoice_sequences/invoices.legal_entity_id NOT NULL` (tras L2/L3, que
  hacen que todo escritor lo rellene); el índice único `(legal_entity_id,
  upper(prefix), year)` y el parcial `(legal_entity_id, invoice_number) WHERE
  deleted_at IS NULL AND status <> 'draft'` — **org_123 no está limpio**: `FAC-2026-`
  activo en `prop_123` y `prop_canary` y `FAC-2026-000001` emitido en ambos
  (sandbox con NIF de relleno); L8 cierra la serie de `prop_canary` (nunca
  renumera) y decide sobre la factura duplicada; mientras tanto la unicidad la
  garantiza `assertSeriesPrefixFree`. `bank_accounts.property_id DROP NOT NULL`
  → L4 (≈100 referencias en tesorería/banca).
- `20260916102000_estructura_societaria_property_immutable` (corrección t6b#10; solo
  funciones y triggers, sin DDL de tablas ni paso de datos, drift 0):
  - `properties_sociedad_inmutable` (`BEFORE INSERT OR UPDATE OF legal_entity_id,
    organization_id`): **R10.1** — una `legal_entity_id` no nula debe ser de una
    sociedad de la misma organización (en alta y en edición; la sociedad inexistente
    la rechaza la FK); **R10.5** — si el centro tiene alguna factura con `status <>
    'draft'` (borradas lógicamente incluidas: una factura emitida es un registro
    fiscal, RD 1619/2012 art. 6 y 19) o alguna fila en `verifactu_installations`
    (activa o retirada: el número no se reutiliza nunca, Orden HAC/1177/2024 7.c),
    no puede cambiar de sociedad (a otra ni a `NULL`) ni de organización. Sigue
    permitido rellenar una `legal_entity_id` nula (backfill en el VPS, relleno de L2)
    y editar cualquier otra columna. El traspaso de un establecimiento es un centro
    nuevo y una instalación retirada.
  - `legal_entities_organizacion_inmutable` (`BEFORE UPDATE OF organization_id`): una
    sociedad no cambia de organización (otro lado de R10.1).
- `scripts/check-fresh-install.sh` paso 6 ahora admite exactamente las funciones y
  triggers que declaran las migraciones (`CREATE FUNCTION` / `CREATE TRIGGER`
  contados en `prisma/migrations/*/migration.sql`; 4 y 4 tras la corrección); vistas
  siguen prohibidas.

### 17.3 Backfill

`apps/api/src/scripts/backfill-legal-structure.ts` (dry-run por defecto,
`--apply --confirm <orgId|all>` repetible, `--org <id>` para limitar, `--install-number
<n>`, `--json`, `--help`; una transacción y un evento de auditoría
`LEGAL_STRUCTURE_BACKFILLED` por organización vía `audit.service`; idempotente:
la segunda pasada planifica 0 escrituras). Por organización: sociedad implícita
(`legalName ?? name`, NIF solo si es válido, no es el relleno `B00000000` y no lo
tiene otra sociedad → si no, `null` + aviso `TAX_ID_*`), `code` derivado (iniciales
sin palabras genéricas ni de marca: Rías Altas → RA, Los Tilos → LT, Anfitorio
Madrid Centro → AMC, Anfitorio Tenerife Sur → ATS; sufijo numérico si colisiona),
`kind` hotel (defecto), `tradeName` desde el `legalName` antiguo cuando difiere de la
razón social, una `VerifactuInstallation` solo para propiedades **con envíos**
(número = el `NumeroInstalacion` declarado en su `software_json` si es único, si
no `--install-number` / `VERIFACTU_INSTALL_NUMBER`, si no `DEV-001` con aviso;
segunda propiedad con el mismo número → `<número>-<code>` con aviso
`INSTALLATION_NUMBER_SUFFIXED`), enlace de facturas encadenadas y envíos a la
instalación, `legalEntityId` en series, facturas y bancos. Avisos de informe:
`SERIES_PREFIX_CLASH`, `INVOICE_NUMBER_DUPLICATE`, `SII_FLAG_ON_PROPERTY` (el flag
de propiedad no se migra aquí: L8 lo revisa con César).

Ejecutado en la BD local el 2026-09-16 (`--apply --confirm all`, 213 ms; segunda
pasada 0 escrituras):

| Organización | Sociedad | Centros | Instalaciones | Series | Facturas | Envíos | Bancos | Avisos |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| org_123 «HotelOS Demo SL» | `HD` · B12345674 | AMC (prop_123, tradeName «Anfitorio Madrid Centro SL»), ATS (prop_canary, tradeName «Anfitorio Tenerife Sur SL») | `DEV-001` → prop_123 (7 facturas, 7 envíos) · `DEV-001-ATS` → prop_canary (1, 1) | 4/4 | 8/8 | 8/8 | 0 | INSTALLATION_NUMBER_SUFFIXED · SERIES_PREFIX_CLASH (FAC-2026-/2026) · INVOICE_NUMBER_DUPLICATE (FAC-2026-000001) |
| Faranda `cmrhw9jy30002fyvb6tsdiugt` | `FAR` «Faranda Hotels & Resorts» · B99999997 (ficticio, checksum ✔) | RA (Rías Altas, tradeName «Hotel Faranda Rías Altas by Ascend Collection»), LT (Los Tilos) | `DEV-001` → RA (25 facturas encadenadas, 33 envíos) | 4/4 | 25/25 | 33/33 | 0 | SII_FLAG_ON_PROPERTY (RA) |

Faranda tras el backfill (solo lectura): 25 facturas con sus tres NIF históricos
intactos (B00000000 · B12345678 · B99999997), 61 asientos / 150 líneas / Σ 2.595,00
sin cambios; 2 eventos `LEGAL_STRUCTURE_BACKFILLED` encadenados en `audit_events`.
Reversión: `DELETE` de `verifactu_installations` y `legal_entities` tras poner a
`NULL` `legal_entity_id` / `installation_id` en `properties`, `invoice_sequences`,
`invoices`, `verifactu_submissions` y `bank_accounts` (todo columnas nuevas). Desde
`20260916102000`, poner a `NULL` la sociedad de un centro con facturas emitidas o
instalación exige, en la misma transacción, `ALTER TABLE properties DISABLE TRIGGER
properties_sociedad_inmutable` … `ENABLE TRIGGER` (R10.5 no se salta con un `UPDATE`
ordinario). La verificación de post-condiciones informa además
`propertiesInForeignEntity` (R10.1; debe ser 0).

### 17.4 Helpers y contratos compartidos

- `apps/api/src/lib/finance-scope.ts`: `resolveLegalIdentity(organizationId)`
  (lector único; `source: legal_entity | organization_fallback`, `taxIdValid`),
  `requireLegalIdentity`, `resolveLedgerScope(context, { legalEntityId?, propertyId? })`
  (en esta tanda siempre la sociedad única; otro `legalEntityId` o una propiedad de
  otra organización / no asignada / de otra sociedad → 404 opaco),
  `listOperationalProperties(organizationId)` (**único** filtro `kind = hotel`;
  `isOperationalKind`, `filterOperationalProperties` para espejos in-memory),
  `deriveStructureMode`, `isStructureEnabled` (`STRUCTURE_ENABLED`, defecto true).
  Desde la integración final viven aquí también las guardias de ámbito de sociedad
  (R11): `ENTITY_READ_PERMISSION`, `FinanceScopeContext`, `hasEntityReadScope`
  (admin de plataforma ∨ `accounting.entity.read` ∨ contexto sin asignaciones),
  `assertFinanceReadScope` (con `propertyId`: centro dentro del ámbito o 404
  «Propiedad no encontrada.»; sin él: ámbito de toda la sociedad o 404 opaco
  `ENTITY_SCOPE_REQUIRED { requiredPermission }`), `assertFinanceWriteScope` (misma
  regla para `POST /accounting/journal` y `/reverse`) y `assertFinanceReadScopeMany`;
  `modules/accounting/ledger.routes.ts` los reexporta y ningún servicio importa ya
  un módulo de rutas.
- `apps/api/src/modules/invoicing/series-prefix.service.ts`:
  `assertSeriesPrefixFree({ propertyId, prefix, year, excludeSequenceId? })` → 409
  `SERIES_PREFIX_CLASH { conflictingPropertyId, conflictingSequenceId, prefix, year }`
  entre centros de la misma sociedad (misma organización si aún no hay backfill;
  case-insensitive; series cerradas no colisionan); `defaultSeriesPrefix` (R3:
  `FAC-2026-` con un centro facturador, `FAC-RA-2026-` con varios).
- `packages/shared/src/legal-structure-types.ts`: `PropertyKind`, `LegalForm`,
  `PgcVariant`, `VerifactuChainScope`, `LegalEntityDto`, `PropertyEstablishmentDto`,
  `VerifactuInstallationDto`, `LegalIdentityDto`, `FinanceScope`, `StructureMode`,
  `CorporateAllocation`, `LegalStructureErrorCode` (unión completa en §17.8),
  `LegalEntityPatchResponse`, `SeriesPrefixClashDetails`; reexportado por
  `@hotelos/shared` (`packages/shared/src/index.ts`), la única forma de importarlo
  (`tests/estructura-integrador-fix-contract.test.mjs`: la lista de imports
  relativos a `packages/shared/src` solo encoge).
- Permisos (`packages/shared/src/permissions.ts` + `types.ts`):
  `accounting.entity.read` («Finanzas de toda la sociedad»: owner/admin por
  catálogo, `manager` y `accountant` por plantilla) y
  `organization.structure.manage` (alta/edición de sociedad y centros; owner/admin;
  `riskLevel high` en sus rutas, L2). Requiere `rbac:sync` (no ejecutado: escribe
  `role_permissions` de Faranda).
- `STRUCTURE_ENABLED` (env, sección Proceso, `true` por defecto): interruptor de la
  estructura para L2-L7; las tablas, el backfill y `resolveLegalIdentity` no
  dependen de él. `VERIFACTU_INSTALL_NUMBER` documentado como fallback sandbox.

### 17.5 Tests y puertas del lote

Unitarios (`apps/api/src/**/__tests__`): `backfill-legal-structure.test.mts`
(flags, códigos, NIF, informes, instalaciones, plan Faranda/org_123 e
**idempotencia** sobre el post-estado), `finance-scope.test.mts` (identidad,
fallback, ámbito, 404 opacos, paridad con `isPropertyAssigned`, filtro operativo),
`series-prefix.test.mts`, `legal-structure-migrations.test.mts` (contrato del SQL de
`20260916102000`: disparadores, ramas R10.1/R10.5, censo funciones == triggers).
Integración in-process
(`tests/integration/legal-structure-backfill.test.mts`, organización aislada
`org_lsb_*`): dry-run → apply → apply (0 escrituras), triggers, unique de NIF,
helpers y guardia sobre filas reales, y (integración final) los 8 casos de
`properties_sociedad_inmutable` / `legal_entities_organizacion_inmutable` sobre
organizaciones propias `org_lsbp_*` (centro con factura emitida o instalación
retirada no cambia de sociedad ni de organización, ni a `NULL`; borrador sí;
relleno `NULL → sociedad` permitido y pinado desde entonces; alta en sociedad
foránea rechazada; una sociedad no cambia de organización). Contratos: `tests/legal-identity-readers-contract.test.mjs`
(lectores + schema + migraciones + tipos + permisos + este runbook),
`migrations-squash-contract`, `check-migrations-vs-schema`, `env-contract`.

Lo que L1 dejó a otros quedó cerrado en la misma tanda: L2 (sociedad implícita en
`createTenant`, onboarding y provisioning; `patchBillingSettings` con prefijo R3 y
`assertSeriesPrefixFree`; `listOperationalProperties` reexportado desde
`lib/tenancy.ts`), L3 (emisor desde la sociedad + bloque establecimiento; lock y
`RegistroAnterior` por instalación; `software.ts` con instalación), L4 (SEPA y
nóminas desde la sociedad; `WORK_CENTER_REQUIRED`), L5 (`declaranteOf` →
`resolveLegalIdentity`; régimen SII de la sociedad) e integración (`export *` en
`@hotelos/shared`, lista de lectores heredados vacía = C8). Siguen abiertos:
`rbac:sync` (escribe `role_permissions` de Faranda: solo con consentimiento), los
DDL aplazados de §17.2 y todo L8 (§17.10).

### 17.6 Correcciones de la revisión adversarial de la Tanda 6b (17 hallazgos · 17 corregidos, 2026-09-16)

Revisión adversarial sobre el working tree de L1-L5 (3 alta · 7 media · 7 baja),
seis lotes de corrección (fix:L1, fix:L2, fix:L3, fix:L4, fix:L5, fix:integrador)
y la integración final. Todo pinado con test; ninguna escritura en Faranda.

| Id | Sev. | Hallazgo | Corrección y decisión | Pina |
| --- | --- | --- | --- | --- |
| t6b#1 | alta | Dos hoteles sin código de centro emitían a la vez el MISMO número (`FAC-2026-000001` × 2) bajo un NIF: la red R3/R10.3 no existía en concurrencia. | `allocateInvoiceNumber` toma `pg_advisory_xact_lock` de apertura de serie por sociedad + año (`lockSeriesOpening`, clave `series-open:<entity|org>:<año>`) antes de abrir una fila, y `assertInvoiceNumberFreeInEntity` toma `invoice-number:<sociedad>:<número>` antes de leer a las hermanas (dos centros con prefijo heredado común, caso org_123: exactamente uno emite, el otro 409 `INVOICE_NUMBER_DUPLICATE`). Con varios centros facturadores y sin `Property.code` → 409 `WORK_CENTER_CODE_REQUIRED` (nunca cae al prefijo plano); serie con `active = false` → 409 `SERIES_CLOSED` (una serie cerrada no vuelve a numerar). `patchBillingSettings` (integración final) abre o reabre la serie bajo el mismo lock y comprueba a las hermanas dentro de la transacción. Los índices únicos aplazados siguen siendo de L8 (org_123 sucio): los dos locks son la red hasta entonces. | `structure-l3-invoicing`, `structure-l3-fixes` (unitario e integración) |
| t6b#2 | alta | Sociedad con `siiEnabled`: las facturas se seguían encadenando (huella, `RegistroAnterior`) y enviando a VeriFactu; R7/R8 exigen desactivación con motivo. | `resolveIssuerIdentity` expone `verifactuExclusion` (`VERIFACTU_EXCLUDED_BY_SII` + motivo «RD 1007/2023 art. 3.3», frase única en `@hotelos/compliance`); emisión y rectificativa sin huella, sin `previousInvoiceHash`, sin QR ni `installationId`, aviso `VERIFACTU_EXCLUDED_BY_SII: …` en `warningsJson`, exclusión congelada en `snapshotJson.verifactuExclusion`, evento de auditoría `VERIFACTU_EXCLUDED_BY_SII`; la anulación no genera `RegistroAnulacion`; el submitter retira con ese `errorCode` los registros ya hasheados si la sociedad entra en el SII después; el health de cumplimiento muestra `issuers[].verifactuExclusion`. Aplica en todos los modos (sandbox incluido); TicketBAI sigue enviando (huella propia). | `structure-l3-fixes` (unitario e integración) |
| t6b#3 | media | Reactivar una serie cerrada (`PATCH billing-settings { active: true }`) no pasaba por `assertSeriesPrefixFree`: dos centros de la misma sociedad quedaban con el mismo prefijo activo. | `seriesPrefixToCheck` (puro): serie nueva activa → su prefijo; prefijo cambiado en serie activa → el nuevo; reactivación (`false → true`) → `effectivePrefix ?? existing.prefix`; cierre o solo numeración → `null`. `patchBillingSettings` lo usa con `excludeSequenceId`. | `invoice-series-policy.test.mts`, `structure-l2.test.mts` |
| t6b#4 | media | R11: las exportaciones a gestoría de TODA la sociedad las listaba y descargaba un usuario de un solo centro sin `accounting.entity.read`. | `GestoriaExport` no tiene columna de centro y su contenido son los libros del NIF: toda la familia (create, list, get, download; `/formats` no) es artefacto de sociedad → `assertGestoriaExportScope` (404 opaco `ENTITY_SCOPE_REQUIRED`), como los snapshots de cuentas anuales. Ámbito por fila cuando exista `GestoriaExport.propertyId` (§17.10). | `structure-l5.test.mts` |
| t6b#5 | media | R4/R11: un usuario con rol en un solo centro contabilizaba asientos de sociedad (sin centro) con `societyLevel: true`. | `assertFinanceWriteScope` (= regla de lectura) en `POST /accounting/journal` (`body.propertyId ?? null`) y en `POST /accounting/journal/:id/reverse` (centro del asiento objetivo): sin centro exige `accounting.entity.read` (o contexto sin asignaciones). No existe clave `accounting.entity.post`: decisión deliberada de reutilizar la de lectura de sociedad. | `structure-l5.test.mts`, `fiscal-regime.test.mts` |
| t6b#6 | media | `createManualJournalEntry` / `postJournalEntry` aceptaban un `propertyId` de OTRA organización: la única guardia era el hook HTTP. | `requireJournalWorkCenter(db, organizationId, propertyId)` dentro de la transacción del motor (tras la búsqueda idempotente, antes de `assertWorkCenter`): centro inexistente o ajeno → 404 opaco `PROPERTY_NOT_FOUND { propertyId }` (nunca 403/409); también en `createJournalEntryDraft` y `postDraftJournalEntry` (borrador de otra organización → 404 `JOURNAL_ENTRY_NOT_FOUND`). Ambos códigos en `LEDGER_ERROR_CODES`. `JournalEntry.propertyId` sigue sin FK (§17.10). | `structure-l4-ledger.test.mts`, `structure-l4.test.mts` |
| t6b#7 | media | El go-live de onboarding (`materialiseOnboardingProject`) creaba la `Property` sin `legalEntityId`/`kind`/`code` y escribía `Organization.legalName/taxId` y `Property.legalName` (columnas deprecadas): tenants nuevos caían en `organization_fallback`. | `materialiseOnboardingStructure` (exportada) en una transacción: organización solo con `name`; sociedad implícita con `createImplicitLegalEntity` (400 `TAX_ID_INVALID` / 409 `TAX_ID_IN_USE`) o, si la organización ya existe, `ensureDefaultLegalEntity` (conserva su NIF; un tenant pre-backfill lo toma de las columnas deprecadas como el backfill); `Property` con `legalEntityId`, `kind` (payload `kind`, defecto `hotel`), `code` único en la sociedad (`planPropertyCode`, 409 `CODE_IN_USE`) y `tradeName` (el `legalName` heredado del payload si difiere de la razón social). Idempotente; un `id` de propiedad de otra organización → 404 opaco (R10.5). La respuesta añade `structure { legalEntityId, legalEntityCode, propertyCode, kind }`. Contrato de escritores: ningún módulo escribe `Organization.taxId/legalName`; `Property.legalName` solo en la lista heredada (`backoffice.service.ts`, L2). | `estructura-integrador-fix-contract`, `integrador-fix-t6b.test.mts` |
| t6b#8 | media | `PATCH /legal-entities` cambiaba `siiEnabled` / `largeCompany` / `pgcVariant` / `legalName` sin confirmación de alto riesgo ni `accounting.configure`: forzaba 303 mensual, 347/390 «no se presenta» y la razón social de todas las facturas futuras. | `HIGH_RISK_LEGAL_ENTITY_FIELDS = [taxId, legalName, siiEnabled, largeCompany, pgcVariant, fiscalYearStartMonth]` y `REGIME_LEGAL_ENTITY_FIELDS = [siiEnabled, largeCompany, pgcVariant, fiscalYearStartMonth]` (`fiscalYearStartMonth` entra por LSC art. 26). Orden en `patchLegalEntity`: `organization.structure.manage` → régimen exige `accounting.configure` (403) → alto riesgo exige `ai.high_risk.confirm` (403) → `siiEnabled: true` con registros VeriFactu REALES sin `accepted` / `rejected` → 409 `VERIFACTU_SUBMISSIONS_PENDING { unresolvedSubmissions }` → sin `confirmHighRisk: true` → 409 `HIGH_RISK_CONFIRMATION_REQUIRED { field, fields, changes }` (mensaje con la base legal por campo) → NIF (checksum, unicidad) → código. Mismo valor no es cambio. Auditoría `LEGAL_ENTITY_UPDATED` con `highRiskFields` / `regimeFields`. | `legal-entity.service.test.mts`, `structure-l2.test.mts` |
| t6b#9 | baja | `GET /organizations/me/structure` y `GET /legal-entities/:id` con `accounting.read`: recepción leía NIF, domicilio fiscal, series (`nextNumber`) e instalaciones de centros no asignados. | Lectura de sociedad = `ENTITY_WIDE_READ` (`accounting.entity.read` ∨ `organization.structure.manage` ∨ admin de plataforma). `getStructure` conserva `accounting.read` en la ruta (el front necesita `mode`) pero sin lectura de sociedad **redacta**: solo centros asignados (`propertyWithinScope`), sin series, instalación ni `vatSettings`, `LegalEntityDto` sin NIF/domicilios/RM/CNAE/CCC (`redactLegalEntityDto`), avisos de configuración omitidos y `scope: "assigned_properties"`; `mode` y `counts` siguen siendo de toda la organización. `GET /legal-entities/:id` pasa a `accounting.entity.read` (manifiesto + `requireEntityWideRead`) y sale de `ACCOUNTING_CALENDAR_GET_PATHS`. §5.3: el director de hotel no ve Datos fiscales ni Series. | `integrador-fix-t6b.test.mts`, `finance-report-keys.test.mts`, contrato |
| t6b#10 | baja | R10.5 (una Property con facturas emitidas no cambia de sociedad ni de organización) no estaba protegida en BD: solo había triggers para `numero_instalacion` y el emisor. | Migración `20260916102000_estructura_societaria_property_immutable` (§17.2): `properties_sociedad_inmutable` (R10.1 en alta y edición; R10.5 con toda factura `status <> 'draft'` — borradas lógicamente incluidas — o cualquier instalación, activa o retirada; relleno `NULL → sociedad` permitido) y `legal_entities_organizacion_inmutable`; post-condición `propertiesInForeignEntity` en el backfill. | `legal-structure-migrations.test.mts` (contrato del SQL), `legal-structure-backfill.test.mts` (8 casos sobre Postgres) |
| t6b#11 | baja | Tras cambiar el NIF de la sociedad, la serie del año quedaba bloqueada con un mensaje que remitía a la pantalla antigua («Perfil del establecimiento»). | `findSeriesIssuerTaxId` se clava por el prefijo IMPRESO (una serie sucesora con otro prefijo no queda bloqueada por las facturas de la antigua); `issuerSeriesMismatchError` nombra el prefijo, cita RD 1619/2012 art. 6.1.a y 15 y da los dos caminos (NIF erróneo → rectificativas + «Datos fiscales»; cambio de emisor → cerrar la serie y abrir otra con otro prefijo en «Series y VeriFactu»; nunca renumerar) con `details.legalIdentityScreen` / `seriesScreen`. `PATCH /legal-entities/:id` (integración final) devuelve `warnings[]` (`findSeriesBlockedByTaxIdChange`, una frase por serie bloqueada) en su 200 y los audita (`blockedSeries`). | `structure-l3-fixes` (unitario e integración), `structure-l2.test.mts` |
| t6b#12 | baja | La carpeta de inspección imprimía `Property.legalName` (nombre comercial deprecado) como razón social; `search.service.ts` y `property-overview.service.ts` también lo leían. | Titular = `resolveIssuerIdentity(propertyId)` (razón social + NIF + domicilio fiscal de la sociedad, `establishment.tradeName` del centro; línea «Titular: … · NIF …» en el HTML); el buscador busca/muestra `tradeName` y `code`; el resumen de propiedad devuelve `legalName` de la sociedad (`resolveLegalIdentity`) más `tradeName`/`code`. `FINANCE_ROOTS` del contrato C8 incluye ahora `compliance`, `search` y `dashboards`. | `legal-identity-readers-contract`, `integrador-fix-t6b.test.mts` |
| t6b#13 | baja | Los schedulers de liberación de cupos y cut-off de grupos iteraban todas las propiedades (oficina incluida) con `property.findMany`. | `listSchedulerHotels()` en `server.ts`: por organización, `listOperationalProperties(orgId, prisma, { includeClosed: true })` (único filtro `kind = hotel`, R6) descartando `archived` como antes. | contrato (`server.ts`) |
| t6b#14 | baja | Tres ficheros de L5 importaban `packages/shared/src/financial-statements-types.js` por ruta relativa. | `allocation.service.ts`, `pnl-by-property.service.ts` y `financial-statements.routes.ts` importan de `@hotelos/shared`; contrato con lista cerrada (22 ficheros heredados de L3/L4/L5/payments/folio/schemas/scripts) que **solo encoge**: cualquier import relativo nuevo falla. | `estructura-integrador-fix-contract` |
| t6b#15 | baja | Tesorería `?scope=entity` respondía 403 y exigía la clave explícita, mientras las demás lecturas de sociedad responden 404 `ENTITY_SCOPE_REQUIRED` y admiten el contexto sin asignaciones. | `assertTreasuryEntityScope` = `assertFinanceReadScope(context, null)`: admin de plataforma, `accounting.entity.read` o contexto sin asignaciones pasan; usuario de centro → 404 opaco `ENTITY_SCOPE_REQUIRED { requiredPermission }`, idéntico al resto de lecturas de sociedad. | `structure-l4-treasury.test.mts`, `structure-l4.test.mts` |
| t6b#16 | baja | USALI y PyG por centro repartían importes corporativos distintos para el mismo mes y el PyG repartía un «coste» negativo como ingreso a los hoteles. | Base única `basis: "usali_corporate_gop"`: coste corporativo = −GOP USALI de los centros `office` / `other` (gastos departamentales y no distribuidos menos ingresos operativos, sobre las mismas filas y mapeos; nunca el resultado neto PGC); GOP corporativo ≥ 0 → `applied: false`, 0,00 repartido y aviso «resultado operativo positivo»; cuentas de la oficina sin mapeo USALI fuera de la base con aviso; `basis` / `basisLabel` en `CorporateAllocationResult`. Las partidas bajo el GOP de la oficina (76x/66x, 68x, 621/625/631) se quedan en la oficina. | `allocation.test.mts`, `usali-corporate.test.mts`, `structure-l5.test.mts` |
| t6b#17 | baja | El bloque `issuers` del health de cumplimiento incluía la oficina central (R6: solo filtraba el bloque SES). | `selectIssuerProperties` (puro): hoteles siempre + oficina / otro solo con serie ACTIVA (`isOperationalKind`); `nonCanonicalTaxRegion` y `foralPropertyIds` siguen incluyendo la oficina a propósito (región fiscal de sus facturas recibidas, TBAI del obligado foral). | `compliance-health.test.mts` |
| integración final | — | Handoffs abiertos por los lotes de corrección. | `LegalStructureErrorCode` += `WORK_CENTER_CODE_REQUIRED`, `SERIES_CLOSED`, `VERIFACTU_EXCLUDED_BY_SII`, `VERIFACTU_SUBMISSIONS_PENDING` (+ doc de los seis campos de alto riesgo) y tipo `LegalEntityPatchResponse`; `LEDGER_ERROR_CODES` += `PROPERTY_NOT_FOUND`, `JOURNAL_ENTRY_NOT_FOUND`; guardias R11 movidas a `lib/finance-scope.ts` (reexportadas desde `ledger.routes.ts`); `VERIFACTU_EXCLUDED_BY_SII_MOTIVO` con fuente única en `@hotelos/compliance`; `backoffice.service.ts` deja de escribir `Property.legalName` (lista de escritores heredados vacía) y `ses-submission.service.ts` deja de seleccionarla; `patchBillingSettings` bajo `lockSeriesOpening`; `PATCH /legal-entities` con `warnings`; `issuers[].verifactuExclusion`; el guard de solo lectura de `structure-l3-fixes` se acota a Faranda y el probe org_123 de C9 (`structure-l5`) solo compara cifras con la BD en reposo (las suites hermanas escriben y limpian org_123 en paralelo). | `estructura-integrador-fix-contract`, `legal-identity-readers-contract`, `legal-structure-backfill`, `structure-l2/l3-fixes/l4/l5`, `integrador-fix-t6b` |

### 17.7 Reglas de negocio (diseño §5.2) y dónde viven

| Regla | Implementación (fichero → función) | Códigos 4xx |
| --- | --- | --- |
| **R1 · Qué se agrega dónde** | Plan, diario, libros, modelos, ejercicios, cuentas anuales, USALI por `organizationId` = sociedad única (`lib/finance-scope.ts` `resolveLedgerScope`); `propertyId` = filtro informativo («vista parcial, no liquidable» en 303/111/115: `modelo-*.service.ts`); tesorería con `?scope=entity` (`treasury.service.ts` `resolveTreasuryScope`: suma todas las cuentas de la organización, `banks[].propertyId` null = «Sociedad · sin centro»). | `ENTITY_SCOPE_REQUIRED` (404) |
| **R2 · Identidad emisora** | `invoicing/issuer-identity.service.ts` `resolveIssuerIdentity` = `resolveLegalIdentity` (NIF, razón social, domicilio fiscal) + `establishment { code, name, tradeName ?? name, kind, addressLine }` de la Property; `Property.legalName` no se lee en ningún módulo de Finanzas, compliance, search ni dashboards (C8: `tests/legal-identity-readers-contract.test.mjs` con lista vacía). PDF (`invoice-pdf.service.ts`): cabecera sociedad · NIF · «Domicilio fiscal» y línea «Establecimiento: <nombre comercial> (<código>) · <dirección>» desde el snapshot congelado (`snapshotJson.establishment / issuerFiscalAddress / legalEntityId / installationId / numeroInstalacion`). XML VeriFactu / TBAI: `NombreRazon` = razón social de la sociedad. SES: A.1 titular = sociedad (`ses-submission.service.ts` vía `requireIssuerIdentity`). Trigger `invoices_issuer_inmutable`. Perfil del establecimiento (`backoffice.service.ts` `savePropertySetupForm property_profile`): campos `tradeName` («Nombre comercial en factura») y `code`; `legalName` / `taxId` en solo lectura → 409 si intenta cambiarlos (`assertProfileDoesNotWriteLegalIdentity`). | `ISSUER_TAX_ID_MISSING` (409, apunta a «Configuración › Estructura societaria › Datos fiscales»), `LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY` (409 `{ fields, legalEntityId, route }`) |
| **R3 · Series y numeración** | `invoicing/series-prefix.service.ts` `defaultSeriesPrefix` (`FAC-2026-` con UN centro facturador, `FAC-RA-2026-` con varios; centro facturador = hotel / otro + oficina con serie activa), `assertSeriesPrefixFree` / `findPrefixClash` (case-insensitive, series cerradas no colisionan); `invoice.service.ts` `allocateInvoiceNumber` (`resolveSeriesScope`, `lockSeriesOpening`, `assertInvoiceNumberFreeInEntity`; colisión PREEXISTENTE = aviso en `warningsJson`, nunca renumera), `backoffice.service.ts` `patchBillingSettings` (prefijo nunca `NULL`; `seriesPrefixToCheck`; upsert bajo `lockSeriesOpening`), `structure/property-provisioning.service.ts` `resolveSeriesPrefixes` (alta de centro), `legal-entity.service.ts` `listLegalEntitySeries` / `markSeriesClashes`. `Invoice.legalEntityId` en toda emisión. | `SERIES_PREFIX_CLASH` (409 `{ conflictingPropertyId, conflictingSequenceId, prefix, year }`), `INVOICE_NUMBER_DUPLICATE` (409 `{ conflictingPropertyId, conflictingInvoiceId }`), `WORK_CENTER_CODE_REQUIRED` (409), `SERIES_CLOSED` (409), `ISSUER_TAX_ID_SERIES_MISMATCH` (409 `{ prefix, seriesTaxId, currentTaxId, legalIdentityScreen, seriesScreen }`) |
| **R4 · Centro en el diario** | `accounting/accounting.service.ts` `assertWorkCenter` (líneas de grupos 6/7 sin `propertyId`; exentos `regularization`, `closing`, `opening`, `reversal`, `sourceType vat_settlement`, `manual` con `societyLevel: true`; gateado por `isStructureEnabled()`); dentro de la transacción tras la búsqueda idempotente; `requireJournalWorkCenter` (R10.1). `ledger.routes.ts` `ManualEntrySchema.societyLevel`; `ManualJournalEntryInput.societyLevel` en `@hotelos/shared`. Retenciones: `posting-rules/withholding-tax.ts` `draftFromEvent` (con retención y sin centro → 409 en vez de descarte; en la proyección asíncrona → `ACCOUNTING_PROJECTION_FAILED` con `details.code`), `requireWithholdingWorkCenter`; nóminas: `payroll/periods.service.ts` `resolvePayrollWorkCenter` (periodo > contrato > perfil) → asiento y `WithholdingTaxRecord`, sin centro → auditoría `PAYROLL_WORK_CENTER_REQUIRED` + 409 con rollback. Ejercicios: `fiscal-year.service.ts` y `fiscal-period.service.ts` `assertEntityScopedFiscalInput` (GET/POST `/accounting/fiscal-years` y POST `/accounting/fiscal-periods` con `propertyId` → 400; el listado de periodos no se guarda a propósito, `rbac-scope.test.mts:189`). | `WORK_CENTER_REQUIRED` (400 en el diario `{ lines, entryKind, sourceType }`; 409 en retenciones / nóminas), `FISCAL_YEAR_IS_ENTITY_SCOPED` (400 `{ subject, propertyId }`), `PROPERTY_NOT_FOUND` (404) |
| **R5 · Oficina central y reparto** | `financial-statements/allocation.service.ts` (`parseCorporateAllocation`, `allocateAmount` al céntimo con resto al mayor peso, `weightsFor` revenue · rooms_available · headcount · manual, `computeCorporateAllocation` etiqueta fija «Reparto corporativo (informativo · no contabilizado)», `posted: false`, `basis: usali_corporate_gop`; `getCorporateAllocationView` / `putCorporateAllocation` escriben SOLO `AccountingSetting.configurationJson.corporateAllocation`, auditoría `CORPORATE_ALLOCATION_UPDATED`); `usali.service.ts` `compareUsaliProperties` (`includeCorporate=1` → `properties` = hoteles, `corporate` = office/other «Oficina central», `unassigned` = «Sociedad (sin centro)», `rollup`, fila `allocation`); `pnl-by-property.service.ts` (matriz cuenta × centro, columnas «Sin asignar» y total sociedad, `reconciliation` por fila). Cero asientos de reparto. | `ALLOCATION_WEIGHTS_REQUIRED`, `ALLOCATION_DUPLICATE_PROPERTY`, `ALLOCATION_UNKNOWN_PROPERTY`, `ALLOCATION_TARGET_NOT_HOTEL`, `ALLOCATION_WEIGHT_INVALID`, `ALLOCATION_WEIGHTS_SUM`, `ALLOCATION_WEIGHTS_NOT_ALLOWED` (400) |
| **R6 · Centro `office` / `other`** | `lib/finance-scope.ts` `listOperationalProperties` (ÚNICO filtro `kind = hotel`; reexportado por `lib/tenancy.ts` con `isOperationalKind` / `filterOperationalProperties`): night audit (`night-audit.service.ts`, guard 409 en la oficina), portfolio (`dashboards/portfolio.service.ts`), pace y HF board (`revenue/*`), health de cumplimiento (`compliance-health.service.ts`: SES e `issuers`), schedulers de cupos y cut-off (`server.ts` `listSchedulerHotels`). Alta de oficina sin edificio, habitaciones, tipos, tarifas ni SES (`property-provisioning.service.ts` `validateCentreSpec`); un hotel con habitaciones no pasa a oficina (`patchEstablishment`). Switcher: `GET /users/me/properties` con `kind`, `code`, `legalEntityId`, `legalEntityName`. Tasa turística y SES no tienen bucle por propiedad (por folio / reserva / envío): la oficina queda fuera por construcción. | `WORK_CENTER_NOT_OPERATIONAL` (409), `PROPERTY_KIND_CHANGE_BLOCKED` (409) |
| **R7 · Cadena VeriFactu por (obligado; instalación)** | `issuer-identity.service.ts` `resolveVerifactuChainScope` (política de la sociedad; instalación activa del centro con `per_center`, de la sociedad — `propertyId null` — con `per_entity`; `lockKey` `installation:<id>` · `entity:<id>` · `propertyId` heredado sin instalación), `chainInvoiceWhere`, `lockVerifactuChainScope` (`pg_advisory_xact_lock`), `adoptOrphanChainRecords` (relleno `NULL → valor` de `installation_id` / `legal_entity_id` bajo el lock); `invoice.service.ts` `lockVerifactuChain` / `findPreviousChainLink` por instalación; `verifactu-submission.service.ts` `resolveSoftwareForSend` (`NumeroInstalacion` de la instalación; env solo sandbox; fuera de sandbox sin instalación → fila `retrying` con `INSTALLATION_NOT_DECLARED` sin consumir intentos), `verifactu_submissions.installation_id`; `packages/compliance` `resolveVerifactuSoftware(env, { installation, requireInstallation })`; TBAI `NumSerieDispositivo` desde la instalación `route = tbai`. Política: `legal-entity.service.ts` `setVerifactuChainScope` (consola; no-op si igual; 409 si hay envíos `preproduction` / `production`; evento `VERIFACTU_CHAIN_SCOPE_CHANGED`; nunca re-encadena); `listInstallations`. Trigger `verifactu_installations_numero_inmutable`. | `CHAIN_ALREADY_STARTED` (409), `INSTALLATION_NOT_DECLARED` (`errorCode`), `VERIFACTU_EXCLUDED_BY_SII` |
| **R8 · Gran empresa / SII (una sola fuente)** | `accounting/vat-books.service.ts` `resolveFiscalRegime(identity, persistedPeriodicity)` (mensual forzado por `sii` / `large_company`; `modelosNoPresentados [347, 390]` con SII; `verifactu { aplica: false, motivo }`), `declaranteBadge` / `regimeAvisos` / `siiModelNotFiledMotivo`, `LARGE_COMPANY_THRESHOLD` 6.010.121,04; `getVatSettings` devuelve `periodicity` EFECTIVA + `sociedad`; `updateVatSettings` nunca escribe la forzada; `modelo-303/111/115.service.ts` `resolveSettlementPeriod` (mensual forzado, `details.forcedBy`), `modelo-347/390` `presentacion.noSePresenta`; `modelo-390.service.ts` `proposeRegime` (RIVA 71.3, puro, nunca escribe) y `buildFiscalRegimeReport` (`GET /fiscal/regime?year=`). Emisión: exclusión VeriFactu con motivo (t6b#2). `PropertyComplianceSetting.siiEnabled` deprecado y nunca leído. | `PERIODICITY_FORCED_BY_REGIME` (409), `PERIOD_MISMATCH.details.forcedBy` |
| **R9 · Cuentas anuales y plantilla PGC** | `financial-statements/annual-accounts.service.ts`: `entityLabel` = razón social · NIF, `entity` desde `resolveLegalIdentity`, `format { template, pgcVariant, depositable, reason }` (`largeCompany` o `pgcVariant = general` con plantilla Pymes → `depositable: false`, «Formato Pymes no depositable para esta sociedad (LSC 257-258)» hasta L10), memoria nota 1 con los establecimientos (código, tipo, municipio). | — (bloqueo informado en `format.reason`) |
| **R10 · Invariantes** | (1) trigger `properties_sociedad_inmutable` R10.1 + `requireJournalWorkCenter`; (2) `requireIssuerIdentity` 409 `ISSUER_TAX_ID_MISSING`; (3) `assertSeriesPrefixFree` + locks (índice aplazado); (4) trigger `verifactu_installations_numero_inmutable`; (5) trigger R10.5 + 404 opaco en onboarding / provisioning; (6) `validateCentreSpec` / `patchEstablishment`; (7) `createLegalEntity` 409 `MULTI_ENTITY_NOT_ENABLED` (regla de servicio; en BD la segunda sociedad es posible: la usa el test de R10.5). | `MULTI_ENTITY_NOT_ENABLED`, `CODE_IN_USE`, `PROPERTY_NAME_IN_USE`, `TAX_ID_INVALID` (400), `TAX_ID_IN_USE` (409) |
| **R11 · Permisos** | `accounting.entity.read` («Finanzas de toda la sociedad»: owner/admin por catálogo; `manager` y `accountant` por plantilla) y `organization.structure.manage` (owner/admin; rutas `high`). `lib/finance-scope.ts` `assertFinanceReadScope` en libros, modelos, liquidación, régimen, diario (sin `propertyId`), mayor, USALI compare / pnl, PyG por centro, cuentas anuales, snapshots, gestoría, tesorería `scope=entity`; `assertFinanceWriteScope` en `POST /accounting/journal` y `/reverse`; `getStructure` REDACTA sin lectura de sociedad (`scope: "assigned_properties"`, `redactLegalEntityDto`); `GET /legal-entities/:id` exige `accounting.entity.read`; cambio de NIF / razón social / régimen: `organization.structure.manage` + `ai.high_risk.confirm` + `confirmHighRisk` (+ `accounting.configure` en régimen). Requiere `rbac:sync` para roles creados antes de la tanda. | `ENTITY_SCOPE_REQUIRED` (404 `{ requiredPermission }`), `HIGH_RISK_CONFIRMATION_REQUIRED` (409), `VERIFACTU_SUBMISSIONS_PENDING` (409) |

### 17.8 Rutas, contratos y códigos de la estructura

Rutas nuevas (`apps/api/src/modules/structure/structure.routes.ts`, registradas en
`server.ts` tras `registerFinancialStatementsRoutes`; manifiesto
`modules/structure/route-permissions.partial.ts`, 9 entradas; todo cuerpo con zod
`.strict()` en `structure.schemas.ts`):

| Ruta | Contrato | Clave · riesgo |
| --- | --- | --- |
| `GET /organizations/me/structure` | `{ organization, legalEntity: { …LegalEntityDto, vatSettings, properties: [{ id, code, name, tradeName, kind, municipality, series[], installation }] }, mode: single_hotel · multi_center · group, counts, warnings: [LEGAL_ENTITY_PENDING · TAX_ID_PENDING · PROPERTIES_UNLINKED], scope: "entity" · "assigned_properties" }`. Sin `accounting.entity.read` ∨ `organization.structure.manage`: solo centros asignados, `series: []`, `installation: null`, `vatSettings: null`, DTO sin NIF / domicilios / RM / CNAE / CCC, avisos de configuración omitidos; `mode` y `counts` describen toda la organización. Con `STRUCTURE_ENABLED=false` → 404 `STRUCTURE_DISABLED` (todas las rutas de structure). | `accounting.read` · medium |
| `POST /legal-entities` | `legalEntityCreateSchema` (`legalName` obligatorio; `taxId` con checksum → 400 `TAX_ID_INVALID`, 409 `TAX_ID_IN_USE` sin oráculo del otro tenant); primera sociedad → 201 (`isDefault`); segunda → 409 `MULTI_ENTITY_NOT_ENABLED { legalEntityId }`. Tras el backfill y `createTenant` siempre existe: en la práctica responde 409. | `organization.structure.manage` · high |
| `GET /legal-entities/:legalEntityId` | `LegalEntityDto` completo (NIF, domicilios, RM, CNAE, régimen, CCC). | `accounting.entity.read` · medium |
| `PATCH /legal-entities/:legalEntityId` | `legalEntityPatchSchema` (al menos un campo; nunca `verifactuChainScope`; `confirmHighRisk`; `taxId: null` = retirar). Alto riesgo y régimen: §17.6 t6b#8. Respuesta `LegalEntityPatchResponse = LegalEntityDto & { warnings: string[] }` (t6b#11). Mismo valor no es cambio; `code` único por organización (409 `CODE_IN_USE`). `demoStore.organization` solo LEE la sociedad (nunca se escriben las columnas deprecadas). | `organization.structure.manage` · high (+ `ai.high_risk.confirm`, `accounting.configure`) |
| `POST /legal-entities/:legalEntityId/properties` | `propertyCreateBodySchema` = spec de centro compartido con el CLI `provision-pilot-property.ts` (`kind` hotel · office · other, `code`, `tradeName`, `census`, secciones hoteleras opcionales, `prefix` de serie opcional) + `dryRun`. `dryRun: true` → `{ plan: { writes, skips, conflicts }, series[], prefixClash[], property: { code } }` sin escrituras (validación en vivo del asistente). Apply: sociedad por defecto (o implícita), `code` (spec · existente · derivado), `kind` / `tradeName` / `census`, oficina sin edificio / habitaciones / tipos / tarifas / SES, prefijos R3 (`FAC-<COD>-<año>-`, `FS-`, `R-`), `legalEntityId` en Property e InvoiceSequence, departamento MGMT y roles del llamante por defecto, evento `PROPERTY_PROVISIONED`. | `organization.structure.manage` · high |
| `GET /legal-entities/:legalEntityId/series` | `{ legalEntityId, series: [{ …serie, propertyCode, propertyName, propertyKind, clash: { propertyId, sequenceId } · null }], clashCount }` sociedad-wide. Cerrar / reabrir series: `PATCH /backoffice/properties/:propertyId/billing-settings` (`active`); nunca renumerar. | `billing.configure` · medium |
| `GET /legal-entities/:legalEntityId/verifactu/installations` | `{ legalEntityId, chainScope, installations: [{ …VerifactuInstallationDto, propertyCode, propertyName, submissions, lastInvoice }] }`. Al crear una instalación para un centro con facturas ya hasheadas, la siguiente emisión / anulación las enlaza (`adoptOrphanChainRecords`). | `accounting.configure` · medium |
| `PATCH /properties/:propertyId/establishment` | `establishmentPatchSchema`: `kind`, `code`, `tradeName`, censales (nunca NIF / razón social); hotel con habitaciones → office/other = 409 `PROPERTY_KIND_CHANGE_BLOCKED`; `sesHospedajesEnabled = false` al pasar a no alojativo; evento `ESTABLISHMENT_UPDATED`. | `organization.structure.manage` · high |
| `POST /admin/legal-entities/:legalEntityId/verifactu-scope` | `{ scope: per_center · per_entity, confirm: true }` (consola de plataforma, `isPlatformAdmin`); no-op si igual; 409 `CHAIN_ALREADY_STARTED` con envíos `preproduction` / `production` (sandbox y legacy `mode NULL` no bloquean); evento `VERIFACTU_CHAIN_SCOPE_CHANGED`; nunca re-encadena. | `admin.tenants.manage` · critical |

Rutas existentes con contrato ampliado (todo aditivo):

- `GET /users/me/properties` y `GET /properties`: `+ kind, code, legalEntityId, legalEntityName` (`listSwitchableProperties` en `modules/structure/legal-entity.service.ts`).
- `POST /admin/tenants` (consola, `createTenant`): admite `legalEntity { legalName?, taxId?, code?, legalForm? }` y `property.kind?` / `property.code?`; crea la sociedad implícita (`isDefault`, NIF pendiente si no se envía) y el primer centro codificado. Onboarding (`POST /onboarding/projects/:id/migration/apply`, `materialiseOnboardingStructure`) y `bootstrap.service.ts` igual: nunca escriben `Organization.legalName/taxId` ni `Property.legalName`; la respuesta añade `structure { legalEntityId, legalEntityCode, legalEntityCreated, propertyCode, kind }`.
- Perfil del establecimiento (`property_profile`): campos `tradeName`, `code`; `legalName` / `taxId` en solo lectura → 409 `LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY { fields, legalEntityId, route: "/configuracion/estructura-societaria" }` si intenta cambiarlos (valores iguales tolerados hasta que L6 deje de enviarlos).
- `GET|PATCH /backoffice/properties/:propertyId/billing-settings`: prefijo nunca `NULL` (vacío → R3), 409 `SERIES_PREFIX_CLASH` (también al reactivar), upsert bajo `lockSeriesOpening`.
- `GET /invoices/:id` → `issuer { legalEntityId, fiscalAddress, establishment { code, tradeName, addressLine }, verifactuExclusion }`; `warnings` con prefijo `VERIFACTU_EXCLUDED_BY_SII:` cuando aplica; `GET /invoices/:id/pdf` imprime sociedad + «Establecimiento». `GET /properties/:propertyId/verifactu/submissions` y `/verifactu/submissions/:id` → `+ installationId`, `software.numeroInstalacion`.
- `POST /accounting/journal` → `+ societyLevel`; 400 `WORK_CENTER_REQUIRED`; 404 `PROPERTY_NOT_FOUND` / `ENTITY_SCOPE_REQUIRED`. `POST /accounting/journal/:id/reverse` → 404 `ENTITY_SCOPE_REQUIRED` sin ámbito del centro del asiento. `POST /journal-entries/:id/post` → 404 `JOURNAL_ENTRY_NOT_FOUND` (borrador de otra organización).
- `GET|POST /accounting/fiscal-years`, `POST /accounting/fiscal-periods` con `propertyId` → 400 `FISCAL_YEAR_IS_ENTITY_SCOPED`.
- `GET|PUT /fiscal/vat-settings` → `+ sociedad` (`FiscalDeclaranteBadge`), `periodicity` efectiva, `persisted`; PUT trimestral bajo SII / gran empresa → 409 `PERIODICITY_FORCED_BY_REGIME`. `GET /fiscal/regime?year=AAAA` (nueva, `FiscalRegimeReport`: volumen, umbral, `propuesta`). `GET /fiscal/models/:modelo` → `+ sociedad`, `presentacion.noSePresenta { motivo }` (347 / 390 en SII), avisos de régimen y «Vista parcial por establecimiento (no liquidable)» con `propertyId`; el PDF imprime «Sociedad: código · razón social · régimen · periodicidad» y «NO SE PRESENTA: motivo». Sin `accounting.entity.read` y sin `propertyId` → 404 `ENTITY_SCOPE_REQUIRED` (también en los handlers heredados `GET /accounting/reports/modelo-*`, porque la guardia vive en los servicios).
- `GET /accounting/usali/compare` → `+ includeCorporate=1[&allocation=]` (columnas `corporate`, `unassigned`, `rollup`, fila `allocation`); `GET /accounting/pnl/by-property?from&to[&allocation]` (nueva, `PnlByProperty`); `GET|PUT /accounting/allocation` (nueva, `CorporateAllocationView` / `CorporateAllocationPutBody`; alias `/legal-entities/:id/allocation` del diseño no registrado para no colisionar con el parámetro de ruta de structure). `GET /accounting/annual-accounts*` → `+ entityLabel, entity, format { depositable, reason }, memoria.entity.properties[]`. Familia `/accounting/gestoria-exports` (salvo `/formats`): ámbito de toda la sociedad.
- `GET /treasury/position|receivables|payables|forecast?scope=entity` → `scope`, `propertyId: string | null`, `legalEntityId`, `entityLabel`, `banks[].propertyId`. `POST /payroll/periods/:id/export` → `+ employer { legalEntityId, legalName, taxId, taxIdValid, identitySource, workCenterId, ccc, cccSource }`; CSV universal `+ ;nif_empresa;ccc` al final; A3 con el NIF de la sociedad. Remesas SEPA: ordenante = sociedad (409 `ISSUER_TAX_ID_MISSING` sin NIF válido; sustituye a `ORGANIZATION_WITHOUT_TAX_ID`).
- `GET /properties/:propertyId/ses/establishment` → `legalName` = razón social de la sociedad. Health de cumplimiento → `issuers[] { taxIdSource: legal_entity · organization · missing, verifactuExclusion }` solo de centros emisores.

`LegalStructureErrorCode` (`packages/shared/src/legal-structure-types.ts`, `details.code`):
`MULTI_ENTITY_NOT_ENABLED`, `SERIES_PREFIX_CLASH`, `WORK_CENTER_REQUIRED`,
`FISCAL_YEAR_IS_ENTITY_SCOPED`, `CHAIN_ALREADY_STARTED`, `TAX_ID_INVALID`,
`TAX_ID_IN_USE`, `LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY`, `LEGAL_ENTITY_REQUIRED`
(fase grupo), `LEGAL_ENTITY_NOT_FOUND`, `ISSUER_TAX_ID_MISSING`,
`HIGH_RISK_CONFIRMATION_REQUIRED`, `VERIFACTU_SUBMISSIONS_PENDING`, `CODE_IN_USE`,
`PROPERTY_KIND_CHANGE_BLOCKED`, `PROPERTY_NAME_IN_USE`, `WORK_CENTER_NOT_OPERATIONAL`,
`STRUCTURE_DISABLED`, `INVOICE_NUMBER_DUPLICATE`, `INSTALLATION_NOT_DECLARED`,
`WORK_CENTER_CODE_REQUIRED`, `SERIES_CLOSED`, `VERIFACTU_EXCLUDED_BY_SII`. Fuera de la
unión pero de esta tanda: `ENTITY_SCOPE_REQUIRED` (404, `lib/finance-scope.ts`),
`PROPERTY_NOT_FOUND` y `JOURNAL_ENTRY_NOT_FOUND` (`LEDGER_ERROR_CODES`),
`PERIODICITY_FORCED_BY_REGIME` y `ALLOCATION_*` (`fiscal-types.ts` /
`financial-statements-types.ts`), `ISSUER_TAX_ID_SERIES_MISMATCH` (facturación).
Eventos de auditoría nuevos: `LEGAL_STRUCTURE_BACKFILLED`, `LEGAL_ENTITY_UPDATED`,
`VERIFACTU_CHAIN_SCOPE_CHANGED`, `PROPERTY_PROVISIONED`, `ESTABLISHMENT_UPDATED`,
`CORPORATE_ALLOCATION_UPDATED`, `PAYROLL_WORK_CENTER_REQUIRED`,
`VERIFACTU_EXCLUDED_BY_SII`.

### 17.9 Comandos: backfill, instalaciones, series y régimen

```bash
# Desde apps/api (DATABASE_URL en el entorno o ../../.env). Dry-run por defecto; SOLO
# las organizaciones nombradas con --confirm se escriben; idempotente (segunda pasada = 0 escrituras);
# una transacción y un evento LEGAL_STRUCTURE_BACKFILLED por organización.
node --env-file-if-exists=../../.env --import tsx src/scripts/backfill-legal-structure.ts --dry-run [--org <orgId>] [--json]
node --env-file-if-exists=../../.env --import tsx src/scripts/backfill-legal-structure.ts --apply --confirm <orgId|all> [--install-number <n>]
#   Salida: sociedad implícita (code, NIF o «pendiente» + aviso TAX_ID_*), códigos de centro, instalaciones
#   (solo centros con envíos; número heredado del software_json, si no --install-number / VERIFACTU_INSTALL_NUMBER,
#   si no DEV-001 con aviso), avisos SERIES_PREFIX_CLASH / INVOICE_NUMBER_DUPLICATE / SII_FLAG_ON_PROPERTY,
#   post-condiciones (propertiesInForeignEntity debe ser 0). Exit 0 ok · 1 fallo · 2 uso.

# Alta de centro desde el CLI (spec = centreSpecSchema + organizationId; delega en modules/structure/property-provisioning.service.ts)
node --env-file-if-exists=../../.env --import tsx src/scripts/provision-pilot-property.ts --spec src/scripts/specs/<centro>.json --dry-run
node --env-file-if-exists=../../.env --import tsx src/scripts/provision-pilot-property.ts --spec src/scripts/specs/<centro>.json --apply --confirm <orgId>

# Propagar accounting.entity.read / organization.structure.manage a los roles existentes (escribe role_permissions: con consentimiento)
corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run      # hoy: 223 claves · 6 roles por completar (Owner +2, Dirección +1, Contabilidad +1 en Faranda y org_123) · Local Super Admin +2
corepack pnpm --filter @hotelos/api rbac:sync
```

Comprobaciones SQL (solo lectura) antes de crear los índices únicos aplazados:

```sql
-- colisiones de prefijo por sociedad y año (debe devolver 0 filas)
SELECT legal_entity_id, upper(prefix) AS prefix, year, count(*) FROM invoice_sequences
 WHERE active AND legal_entity_id IS NOT NULL GROUP BY 1, 2, 3 HAVING count(*) > 1;
-- números repetidos bajo un NIF (0 filas)
SELECT legal_entity_id, invoice_number, count(*) FROM invoices
 WHERE deleted_at IS NULL AND status <> 'draft' AND legal_entity_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;
-- centros cuya sociedad es de otra organización (R10.1; 0 filas)
SELECT count(*) FROM properties p JOIN legal_entities le ON le.id = p.legal_entity_id WHERE le.organization_id <> p.organization_id;
-- NULL pendientes antes de los SET NOT NULL
SELECT (SELECT count(*) FROM properties WHERE legal_entity_id IS NULL), (SELECT count(*) FROM invoice_sequences WHERE legal_entity_id IS NULL OR prefix IS NULL), (SELECT count(*) FROM invoices WHERE legal_entity_id IS NULL);
```

Operaciones por API (zod estricto; alto riesgo con `confirmHighRisk: true`):

- **Sociedad**: `GET /organizations/me/structure` → `PATCH /legal-entities/:id { legalName, taxId, legalForm, cnae, fiscalAddress…, confirmHighRisk: true }` (NIF / razón social: `ai.high_risk.confirm`; el 200 trae `warnings[]` con las series que quedan bloqueadas por el cambio de NIF) → `PATCH /legal-entities/:id { siiEnabled, largeCompany, pgcVariant, fiscalYearStartMonth, confirmHighRisk: true }` (+ `accounting.configure`; 409 `VERIFACTU_SUBMISSIONS_PENDING` si hay registros reales sin resolver).
- **Centro**: `POST /legal-entities/:id/properties { …spec, dryRun: true }` (plan, series propuestas, `prefixClash[]`) → sin `dryRun` (crea) → `PATCH /properties/:propertyId/establishment { code, tradeName, kind, census }`.
- **Series**: `GET /legal-entities/:id/series` (colisiones) → cerrar `PATCH /backoffice/properties/:propertyId/billing-settings { invoiceSequence: { sequenceCode, invoiceType, active: false } }` → abrir la sucesora con otro prefijo (`prefix` explícito o vacío = R3). Nunca `nextNumber` hacia atrás con facturas emitidas (`invoiceSequencePatchViolations`).
- **VeriFactu**: `GET /legal-entities/:id/verifactu/installations`; política solo desde la consola `POST /admin/legal-entities/:id/verifactu-scope { scope, confirm: true }` antes de la primera emisión real. La fila `verifactu_installations` de un centro nuevo se crea hoy por el backfill (centros con envíos) o a mano (SQL / consola): la apertura automática al activar `verifactuEnabled` es un pendiente (§17.10). En `preproduction` / `production` un centro sin instalación activa deja sus envíos en `retrying` con `INSTALLATION_NOT_DECLARED`.
- **Régimen**: `GET /fiscal/regime?year=2026` (propuesta RIVA 71.3) → `PATCH /legal-entities/:id { largeCompany | siiEnabled }` → `GET /fiscal/vat-settings` (periodicidad efectiva) → 303 mensual, 347 / 390 «no se presenta», VeriFactu excluido con motivo.
- **Reparto informativo**: `PUT /accounting/allocation { method, weights? }` → `GET /accounting/usali/compare?includeCorporate=1&allocation=<method>` y `GET /accounting/pnl/by-property?from&to&allocation=<method>` (misma base `usali_corporate_gop`; cero asientos).

Orden en el VPS (fuera de este workflow, con backup y API parado): `db:migrate:deploy`
(aplica `20260916100000`, `20260916101000`, `20260916102000`) → `db:drift:check` (0) →
`db:generate` → comprobación R10.1 (SQL de arriba = 0) → `backfill-legal-structure.ts
--dry-run` → `--apply --confirm all` → reiniciar el API con UNA instancia (la clave del
advisory lock de un centro con instalación pasa de `<propertyId>` a `installation:<id>`
y dos versiones en paralelo no se serializarían entre sí) → `rbac:sync` → en sandbox
nada más cambia (Rías Altas emite con la instalación `DEV-001` del backfill). En el
**VPS demo** (org_123 + Faranda + residuos AUDIT) `demo:refresh --apply` y
`demo:fix-identity --apply` van ANTES de `backfill-legal-structure.ts --apply`:
`refresh-demo-dataset.ts` no conoce `legal_entities` (si el backfill ya corrió deja
las sociedades de las orgs AUDIT huérfanas y sale con exit 1 «Filas residuales de orgs
AUDIT: legal_entities=5») y `fix-demo-legal-identity.ts` no toca `legal_entities`
(la sociedad de Faranda quedaría «AUDIT-T1 SL» con NIF nulo y el backfill la daría
por convergida). Orden ensayado el 2026-09-17 y procedimiento completo en
`docs/runbooks/vps-demo-actualizacion-2026-09-17.md` §7. ANTES de
`VERIFACTU_MODE=preproduction`: retirar las instalaciones de relleno (`active = false`,
`retired_at`) y abrir por hotel una instalación con el número real del registro del
productor (la cadena nueva empieza en `PrimerRegistro`; los registros sandbox nunca
llegaron a la AEAT).

### 17.10 Límites, aplazados y lo que solo puede aportar César

| Tema | Estado del código | Qué falta y quién |
| --- | --- | --- |
| DDL aplazado (cabecera de `20260916101000`) | `invoice_sequences.prefix` sigue `String?` (ningún escritor guarda `NULL` desde L2: 0 filas `NULL` en local); `properties / invoice_sequences / invoices.legal_entity_id` nulables (0 `NULL` en local; onboarding, provisioning, `createTenant` y la emisión los rellenan); índices únicos `(legal_entity_id, upper(prefix), year)` y parcial `(legal_entity_id, invoice_number)` no creados; `bank_accounts.property_id` NOT NULL. | `SET NOT NULL` de `prefix` y de los tres `legal_entity_id`: migración nueva + `schema.prisma` cuando el VPS haya pasado el backfill (comprobar 0 `NULL`). Índices únicos: L8, tras limpiar org_123 (`prop_canary` `FAC-2026-` → `active = false`, nunca renumerar; decidir la factura `FAC-2026-000001` duplicada). `bank_accounts.property_id DROP NOT NULL`: exige adaptar `modules/banking/{bank-account,bank-statement,reconciliation}.service.ts` y `server.ts` `/banking/accounts` (≈ 50 referencias); alternativa provisional del diseño §8.2: el banco de la sociedad colgado de la oficina. Hasta entonces los advisory locks son la unicidad. |
| Instalación VeriFactu al activar un centro | `listInstallations` muestra las filas del backfill; `POST …/properties` y `verifactuEnabled = true` NO crean `verifactu_installations`. | L2 / L8: crear la fila (route `verifactu` o `tbai` si foral; `propertyId` con `per_center`, `null` con `per_entity`) con el número del registro del productor. |
| `TbaiSubmission.installationId` | No existe: la cadena TicketBAI sigue por `(propertyId, territory)` (`tbai-submission.service.ts`, `tbai/tbai.service.ts` `fetchPreviousHash`); solo `<Software>/<NumSerieDispositivo>` y `<Emisor>` siguen a la instalación y la sociedad. | Schema (L1/L8) si se quiere `per_entity` en TBAI. IGIC legacy sin instalación (la ruta real de Canarias es VeriFactu Impuesto 03). |
| `GestoriaExport.propertyId` | No existe: toda la familia es artefacto de sociedad (t6b#4). | Schema (L1/L8) + rellenar en `createGestoriaExport` + relajar `assertGestoriaExportScope` → ámbito por fila. |
| `JournalEntry.propertyId` | `String?` sin FK; la tenencia la garantiza `requireJournalWorkCenter` (0 asientos con centro ajeno o inexistente en local). | FK `Restrict` hacia `properties` como red estructural (schema). |
| Escritores interinos del diario | `vat-settlement.service.ts` (motor interino), `invoicing/ledger.port.ts`, `payables/ledger-port.ts` insertan `journal_entries` sin `postJournalEntry`: R4 no se evalúa ahí (hoy irrelevante: `vat_settlement` es exento y `SupplierBill.propertyId` / `Invoice.propertyId` son NOT NULL). | Llamar a `assertWorkCenter` al converger al motor único. |
| Guardia del perfil | `LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY` tolera valores IGUALES a los de la sociedad (el front actual sigue enviando `legalName` / `taxId` prefijados). | Endurecer `assertProfileDoesNotWriteLegalIdentity` cuando L6 deje de enviarlos. |
| `CHAIN_ALREADY_STARTED` | Solo cuenta envíos `preproduction` / `production`: los 19 envíos legacy de Faranda con `mode NULL` y los 22 sandbox no congelan la política. | L3 escribe `mode` en todo envío nuevo (hecho); decisión documentada en `REAL_VERIFACTU_MODES`. |
| `STRUCTURE_ENABLED` | Interruptor de rollback: `false` → rutas de structure 404 `STRUCTURE_DISABLED`, `assertWorkCenter` desactivado, sin ámbito «Sociedad» en el switcher. La identidad va siempre por `resolveLegalIdentity` (fallback a las columnas deprecadas para tenants sin backfill), las guardias R11 no dependen de él. | — |
| Reparto corporativo | −GOP USALI de los centros office/other; partidas bajo el GOP de la oficina no se reparten; clave `headcount` depende de `PayrollPeriod.propertyId`. | El asesor puede pedir otro nivel de reparto (decisión de producto). |
| Periodicidad forzada | No se escribe en `VatSettings` (efectiva en lectura); las filas de `vat_book_entries` materializadas antes de un cambio de régimen conservan su `period` trimestral (los modelos filtran por fecha). | — |
| C9 equivalencia en paralelo | `structure-l5.test.mts` compara las cifras de org_123 solo con la BD en reposo (las suites hermanas escriben y limpian org_123 en paralelo: `t.skip` con diagnóstico si los recuentos cambian); Faranda se compara siempre (nunca se escribe). | Ejecutar el fichero solo para la equivalencia numérica de org_123. |
| Roles | `accounting.entity.read` y `organization.structure.manage` existen en el catálogo y en las plantillas; los roles creados antes de la tanda no las tienen hasta `rbac:sync`. En dev la unión demo las concede a toda sesión real (`demo-store.ts` baseline). | César: autorizar `rbac:sync` (escribe `role_permissions` de Faranda). |
| Faranda → CELUISMA (L8) | Sociedad `FAR` con el NIF ficticio B99999997; centros RA (`FAC-2026-` con tres NIF históricos, 25 facturas, instalación `DEV-001`) y LT; `sii_enabled = true` de RA sigue en `property_compliance_settings` (aviso `SII_FLAG_ON_PROPERTY`); oficina central y 5 hoteles inexistentes; códigos RA / LT / FAR derivados por heurística. | Lista exacta de datos en el informe de cierre §8 (`docs/audits/TANDA-6B-ESTRUCTURA-BACKEND-2026-09-16.md`): hoteles y oficina, cifras 2024-25, otras sociedades, clave de reparto, decisión del asesor sobre la cadena, consentimiento para el NIF real, régimen de IVA y ejercicio, CCC, numeración de instalaciones reales. El NIF real A33615980 solo entra en L8 con consentimiento y nunca se remite a la AEAT sin mandato. |
| Front | Ninguna pantalla consume las rutas de structure ni los campos aditivos (`grep legal-entities apps/admin-web/src` = 0). | L6 (Estructura societaria, perfil sin NIF, consola) y L7 (ámbito único, badge de declarante, aviso SII, vistas por centro): contratos en §17.8 y en el informe §7. |

### 17.11 Puertas del cierre de la Tanda 6b (2026-09-16, integración final)

Working tree completo, sin commit, servidores :3000 / :5173 sin reiniciar (sirven el
código anterior; verificación con unitarios e integración in-process):

| Puerta | Resultado |
| --- | --- |
| `node scripts/typecheck-all.mjs --parallel 2` | 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 22,3 s |
| `node scripts/check-discoverability.mjs` | 216 screens alcanzables · 183/183 URLs · 0 broken links · placeholders 16/20 |
| `corepack pnpm test` (contratos, sin BD) | 431 tests · 431 pass · 0 fail (+2 contratos nuevos de la tanda: `legal-identity-readers-contract` 10, `estructura-integrador-fix-contract` 11) |
| `corepack pnpm --filter @hotelos/api test` (unitarios) | 1.456 tests · 1.455 pass · 0 fail · 1 skipped (preexistente); 216 casos nuevos en 17 ficheros de la tanda |
| `test:integration` (`tests/integration/*.test.mts`, 21 ficheros — 7 de la tanda con 99 casos —, in-process sobre Postgres local) | 294 tests · 289 pass · 0 fail · 5 skipped (preexistentes, los mismos del cierre de la Tanda 6: H2 sin folio abierto en el demo y los 4 casos de sesión limitada sin `INTEGRATION_RECEPTION_EMAIL/_PASSWORD`); la probe org_123 de C9 se ejecutó con la BD en reposo (se salta con diagnóstico si una suite hermana está escribiendo org_123); Faranda idéntica antes y después; 0 organizaciones de prueba residuales |
| `node scripts/env-census.mjs` · `validate-env.mjs .env --role app` | 137 variables leídas · 137 documentadas · ficheros generados en sincronía · contrato OK (14 avisos de valores de ejemplo) |
| `db:migrate:status` · `db:drift:check` · `check-migrations-vs-schema.mjs` | 8 migraciones aplicadas, «Database schema is up to date!» · «No difference detected.» · 266 tablas / 30 enums en sincronía |
| `bash scripts/check-fresh-install.sh` | OK: 8 migraciones → 266 tablas, 1 organización, 79 permisos, sin drift, 4 funciones / 4 triggers declarados por las migraciones (4 s) |
| `corepack pnpm install --frozen-lockfile --offline` | «Lockfile is up to date» · «Already up to date» |
| `rbac:sync -- --dry-run` | catálogo 223 claves (222 org + 1 plataforma) · +0 · 6 roles por completar (Owner +2, Dirección +1, Contabilidad +1 en Faranda y en org_123) · Local Super Admin +2 (no aplicado) |
| `bash .husky/pre-commit` | discoverability + typecheck-all OK |

Faranda (solo lectura, idéntico antes y después de todas las suites): 25 facturas
(NIF históricos B00000000 × 16 · B12345678 × 5 · B99999997 × 4), 61 asientos / 150
líneas / Σ 2.595,00 = 2.595,00, 33 envíos sandbox, 0 `vat_settings`, 0
`vat_book_entries`; sociedad `FAR` «Faranda Hotels & Resorts» B99999997 (`pymes`,
`per_center`, SII y gran empresa `false`); centros RA (`hotel`, instalación `DEV-001`
activa) y LT (`hotel`); series `FAC-2026-` (siguiente 23) y `REC-2026-` (4) en RA,
`FAC-LT-2026-` y `REC-LT-2026-` (1) en LT, todas activas y con `legal_entity_id`. org_123:
sociedad `HD` B12345674, AMC / ATS, instalaciones `DEV-001` y `DEV-001-ATS`, 8 facturas,
8 envíos. 2 organizaciones en la BD: ninguna organización de prueba queda tras las
suites.

**Cierre del front de la Tanda 6b (L6 «Estructura societaria» · L7 «Ámbito» · L9 tests + integrador, 2026-09-16; working tree sin commit, :3000 / :5173 sin reiniciar):**

| Puerta | Resultado |
| --- | --- |
| `node scripts/typecheck-all.mjs --parallel 3` | 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 14,0 s (cierre documental tras los tres lotes de corrección fix:L6 / fix:L7 / fix:primitives; `tsc --noEmit` de admin-web y de api: 0 errores) |
| `node scripts/check-discoverability.mjs` | 224 screens alcanzables · 188/188 URLs · 0 broken links · placeholders 16/20 |
| `node scripts/build-nav-tree.mjs --check` | al día (67 ítems · 98 pestañas · 205 redirecciones; Configuración con 11 ítems ≤ 12 tras «Estructura societaria») |
| `corepack pnpm test` (contratos, sin BD) | 445 tests · 445 pass · 0 fail (+14 de `legal-structure-contract`) |
| unitarios front (`apps/admin-web/src/**/__tests__/*.test.mts`) | 939 tests · 939 pass · 0 fail (287 suites; +18 de los lotes de corrección: `CocoaSelect`, `CocoaSection` rejilla inline, `CocoaControls` relleno del acento, `finance-scope-usage` WAITS_FOR_STRUCTURE, `structure-ui` concordancia) |
| `corepack pnpm --filter @hotelos/api test` | 1.512 tests · 1.511 pass · 0 fail · 1 skipped (preexistente); 466 suites |
| `corepack pnpm test:integration` | dos pasadas completas en el cierre documental: 1.ª 337 tests · 331 pass · **1 fail** · 5 skipped — el fallo es `structure-l6-l7-contract` «rollup totalUndistributed: Total sociedad = Σ hoteles + Oficina + sin asignar» (`ok: false`), una lectura de `GET /accounting/usali/compare?includeCorporate=1` sobre org_123 mientras suites hermanas (`accounting-ledger`, `fiscal-models`, `treasury-banking`, `pos-cash-night`…) contabilizaban asientos en org_123 entre la consulta por hotel y la consolidada; la suite sola pasa 14/14 y la 2.ª pasada completa da 337 · **332 pass · 0 fail · 5 skipped** (solo los 5 preexistentes: la probe C9 de org_123 corrió con la BD en reposo). Misma familia que la probe C9 (§17.10): lectura de org_123 sin BD en reposo. `structure-e2e` 29/29 en ambas pasadas |
| Cocoa 22 (`tests/cocoa-22-contract.test.mjs`) | 18/18; inventario regenerado 224 pantallas · 88.428 líneas · 1.912 puntos; `NOT_MIGRATED` 68 = techo; `GLOBAL_CEILING` 307 · 203 · 40 · 158 · 70 · 1.832 (`inlineStyles` 1.833 → 1.832; sin cambio con los lotes de corrección); §6 del plan (`cocoa-22-waves.mjs --write`) al día: 68 pendientes · 24.545 líneas · 1.755 puntos · 8 lotes |
| `node docs/design/cocoa-22-api.mjs --check` · `--typecheck-examples` | §8 al día · 11 plantillas · 0 errores |
| `bash .husky/pre-commit` | discoverability + typecheck-all OK |

Faranda (solo lectura, idéntica antes y después de las dos pasadas completas de
integración): 25 facturas · 61 asientos / Σ 2.595,00 · 33 envíos · 2 centros · sociedad
`FAR` sin cambios (`updated_at` 2026-09-16 07:25:05). org_123 vuelve al dataset de
referencia AMC + ATS: el centro de prueba que L6 dio de alta por el asistente («Oficina
de prueba», código `ODP`, id `cmu406yul000wfyzt8fxbzras`) y sus filas satélite
(departamento MGMT, rol de `usr_123`, ajustes de cumplimiento e IA, perfil de
cumplimiento) se retiraron por SQL en una sola transacción porque no existe ruta de
archivado de centro (copia de las 7 filas en el scratchpad de la sesión; los 4
`audit_events` del alta se conservan como historial) y
`AccountingSetting.configurationJson.corporateAllocation` volvió a no persistido.
Cerrados por el integrador: `EstructuraSocietariaTabs` exportado por el barrel
`screens/tabs/index.ts` y cargado con `lazyTab`; `SYSTEM_ACTOR_LABELS` con los actores
`usr_system_legal_structure` y `usr_system_faranda_celuisma`; `STRUCTURE_ROUTE` del API
(`LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY.route`) = `/configuracion/estructura-societaria`;
`treasuryApi.scope()` respeta `scope: "entity"`; `SwitchableProperty` declara `kind`,
`code`, `legalEntityId`, `legalEntityName`; `accounting-ui.ts` sin los helpers de ámbito
anteriores a L7 (`ORGANIZATION_SCOPE_LABEL`, `usePropertyScopeOptions`, `scopeLabel`).

### 17.12 Front y ámbito (L6 / L7 · contrato que fijan los tests de L9, 2026-09-16)

Lo que el front de la Tanda 6b (L6 «Configuración › Estructura societaria», L7
selector «Ámbito» en Finanzas y Cumplimiento) consume del API está fijado por cuatro
suites de L9; ninguna escribe en Faranda ni en org_123 (la e2e crea y borra su
propia organización; la de contrato HTTP solo lee).

**Un solo punto de ámbito.** En el API es `apps/api/src/lib/finance-scope.ts`
(`resolveLedgerScope`, `assertFinanceReadScope` / `assertFinanceWriteScope` /
`assertFinanceReadScopeMany`, `hasEntityReadScope`, `propertyWithinScope`): es el
único fichero que emite el 404 opaco `ENTITY_SCOPE_REQUIRED { requiredPermission:
"accounting.entity.read" }` y el único que declara esas guardias
(`ledger.routes.ts` solo las reexporta). En el front el equivalente es
`apps/admin-web/src/services/financeScope.ts`: estado `FinanceScope { kind:
entity | property | group, id, label }` (tipo de `@hotelos/shared`, nunca
redefinido), persistido en `localStorage["hotelos-finance-scope"]` y reflejado en
`?ambito=`, separado de `hotelos-active-property` (cambiar el hotel activo no cambia
el ámbito); ninguna pantalla construye o persiste el ámbito por su cuenta. El
selector no se renderiza con un solo centro y sin `accounting.entity.read` no ofrece
la opción «Sociedad».

**Cabecera, lectores y selectores del ámbito (correcciones fix:L7, 2026-09-16).** El
contenedor de pestañas (`screens/tabs/NavItemTabs.tsx`) pinta el eyebrow «Finanzas ·
<sociedad o centro>» / «Cumplimiento · …» que la pantalla alojada registra a través del
contexto del host (`useHostedEyebrow`, llamado por `CocoaPage` y `HostedHead` con su prop
`eyebrow`); `containerEyebrow` (`nav-item-tabs.ts`) solo acepta un eyebrow que prolongue
la propia categoría, así que la regla «eyebrow = categoría» de la Tanda 5 sigue vigente y
el ámbito es su única extensión. Los lectores por centro de Facturación y cobros
(`BillingCenterScreen`) y Cierre de caja (`CashClosureScreen`) esperan a
`useFinanceScope().loading === false` antes de pedir datos: hasta conocer la estructura
el ámbito sería la propiedad activa aunque fuera la oficina central (que esas pantallas
excluyen) y cada lectura se hacía dos veces. Los selectores de periodo de Modelos AEAT y
Liquidación de IVA van `inline` (`CocoaSelect inline`: ancho de la opción más larga) en la
fila de acciones, y la columna izquierda de `HostedHead` toma el ancho de sus vistas
segmentadas, de modo que las acciones bajan de línea antes de recortar una vista.

**`GET /organizations/me/structure` decide la pantalla.** `mode` (`single_hotel` →
tarjeta «Tu sociedad» + fila «Este hotel», sin selector, sin la palabra «centro»;
`multi_center` → tabla de centros y selector; `group` → fase holding) y `scope`
(`entity` → pestañas completas; `assigned_properties` → solo los centros asignados,
`series: []`, `installation: null`, `vatSettings: null`, DTO sin NIF / domicilios /
RM / CNAE / CCC y sin el aviso `TAX_ID_PENDING`: la pantalla oculta Datos fiscales,
Series y VeriFactu e IVA y ejercicio y no pinta «NIF pendiente»). `mode` y `counts`
describen siempre toda la organización, también para el lector redactado.

**Lo que ve por HTTP un director de un solo centro** (rol REAL, unión demo apagada):
404 `ENTITY_SCOPE_REQUIRED` en toda lectura con importes sin `propertyId` o con
`?scope=entity` (303, USALI comparado, PyG por centro, diario, balance, tesorería);
404 «Propiedad no encontrada.» con el centro hermano; 200 solo con su centro; 403 en
`GET /legal-entities/:id`, `GET …/series`, `PATCH /legal-entities/:id`, `POST
…/properties` (también con `dryRun`), `PATCH /properties/:id/establishment` y `POST
/legal-entities`; 404 `ENTITY_SCOPE_REQUIRED` al contabilizar un asiento de sociedad
(`societyLevel`). La directora con `accounting.entity.read` real lee toda la
sociedad; la sociedad y los centros de otra organización son 404 opacos en lectura y
en escritura para ambos (nunca aparecen la razón social ni el NIF ajenos).

**Suites y qué fijan.**

| Fichero | Casos | Cubre |
| --- | --- | --- |
| `tests/integration/structure-e2e.test.mts` | 29 (bloques A-I) | Recorrido completo por HTTP con sesiones reales sobre una organización creada con `createTenant`: hotel individual (`single_hotel`, NIF con `confirmHighRisk`, serie plana `FAC-<año>-`, switcher, 409 `MULTI_ENTITY_NOT_ENABLED`); asistente «Añadir centro» (`dryRun` con «Libre» / «Ya usado por …», segundo hotel `FAC-H2-<año>-`, oficina sin habitaciones, `multi_center`, 0 colisiones, 409 `SERIES_PREFIX_CLASH` y `PROPERTY_KIND_CHANGE_BLOCKED`); emisión en dos hoteles del mismo NIF sin colisión con emisor = sociedad + establecimiento; triggers de inmutabilidad del emisor y de la instalación; oficina (gasto con centro 201 / sin centro 400 `WORK_CENTER_REQUIRED` / centro ajeno 404; nómina → 111 de la sociedad 2.000,00 / 300,00; `FISCAL_YEAR_IS_ENTITY_SCOPED`; fuera de cierre del día, portfolio, bloque SES y filtro operativo); USALI por centro (GOP 100 · 300, Oficina −80, roll-up 320, reparto «ingresos» 20,00 + 60,00 = 80,00 con cero asientos, PyG por centro); permisos y aislamiento (tabla anterior); régimen SII (mensual forzado, `PERIODICITY_FORCED_BY_REGIME`, 347/390 «no se presenta», `PERIOD_MISMATCH`, factura sin registro con `VERIFACTU_EXCLUDED_BY_SII`); backfill idempotente en dos pasadas; equivalencia de Faranda (61 asientos, 4300 = 379,00, 303 Q3 bases 423,62 + 155,04 = 578,66 · 27 = 71 = 74,94 · 37 registros, `multi_center` RA / LT bajo FAR). |
| `tests/integration/structure-l6-l7-contract.test.mts` | 14 | Formas de respuesta que leen las pantallas, sobre org_123 con la sesión demo y solo lectura: `GET /organizations/me/structure` (claves exactas de `LegalEntityDto`, enumeraciones, `counts` que suman, `mode` derivado), `GET /legal-entities/:id` (DTO exacto, 400 estricto sin escribir), `…/series` (`clashCount` = filas con `clash`, simetría), `…/verifactu/installations`, `GET /users/me/properties` (`kind`, `code`, `legalEntityId`, `legalEntityName`), `GET|PUT /accounting/allocation` (400 `ALLOCATION_*`), `GET /fiscal/vat-settings` y `/fiscal/regime` (`FiscalDeclaranteBadge`, umbral 6.010.121,04), `GET /fiscal/models/303|347|390` (badge, «no liquidable» con `propertyId`, `noSePresenta` solo en SII), `GET /accounting/usali/compare?includeCorporate=1[&allocation=]` (`corporate`, `unassigned`, `rollup[].ok`, fila `allocation`; respuesta legada intacta sin el flag), `GET /accounting/pnl/by-property`, `GET /accounting/annual-accounts[/memoria]` (`entityLabel`, `format`, `memoria.entity.properties[]`), `GET /treasury/position?scope=entity`, `GET /invoices/:id` (`issuer.establishment`), 404 opaco con un `propertyId` ajeno. |
| `tests/legal-structure-contract.test.mjs` (sin BD, `corepack pnpm test`) | 14 | Manifiesto de las 9 rutas (clave y riesgo exactos, registro 1:1 en `structure.routes.ts`, `assertStructureEnabled()` en cada handler, fusión en `routePermissionManifest`, switcher sin clave); catálogo, unión de tipos y plantillas de `accounting.entity.read` / `organization.structure.manage`; lectores deprecados (`PropertyComplianceSetting.siiEnabled` fuera de Finanzas en lista cerrada; el front sin `organization.taxId/legalName` y con `property.legalName` en lista cerrada); un solo punto de ámbito (API y front); esta subsección y `api-contracts.md`. |
| `apps/api/src/modules/structure/__tests__/structure-read-scope.test.mts` (unitario, BD falsa) | 16 | Matriz `mode × scope` de `getStructure` sin Postgres (redacción que además no lee series / instalaciones / IVA, avisos solo para quien gestiona, fase grupo, 403 / 404), `deriveStructureMode`, `redactLegalEntityDto` (campos exactos), `listSwitchableProperties` (campos del switcher, aislamiento por organización), mappers DTO, guardias de `finance-scope.ts` y manifiesto. |

```bash
# Desde la raíz del repo
cd apps/api && node --import tsx --test "../../tests/integration/structure-e2e.test.mts" "../../tests/integration/structure-l6-l7-contract.test.mts"
cd apps/api && node --import tsx --test src/modules/structure/__tests__/structure-read-scope.test.mts
node --test tests/legal-structure-contract.test.mjs
```

**Hallazgo de la e2e (deuda §17.10 confirmada):** un hotel creado desde el producto
nace con `verifactuEnabled` por defecto y emite en sandbox con el número del env sin
fila en `verifactu_installations`; la primera pasada del backfill abre exactamente esa
instalación (1 fila + facturas y envíos enlazados) y la segunda es 0 escrituras. Hasta
que la activación de VeriFactu abra la instalación, en `preproduction` / `production`
ese centro quedaría en `INSTALLATION_NOT_DECLARED`.

### 17.13 Migración Faranda → CELUISMA (L8): dry-run → confirmación → apply → comprobaciones

Diseño §5.5 pasos 1-11 y §6 fila L8; datos que solo César puede aportar en el informe de
cierre §8. CLI `apps/api/src/scripts/migrate-faranda-celuisma.ts` (script npm
`structure:migrate-faranda-celuisma`), **dry-run por defecto**, que orquesta los servicios ya
existentes sin duplicar lógica: `patchLegalEntity` (sociedad, alto riesgo con
`confirmHighRisk`), `patchEstablishment` (censo fill-only de RA / LT), `buildPlan` /
`applyProvisionPlan` (oficina y cinco hoteles desde `specs/faranda-*.json`),
`patchBillingSettings` (apertura de las series de RA bajo `lockSeriesOpening` +
`assertSeriesPrefixFree`), `detectPrefixClashes` y `verifyOrganization` del backfill
(colisiones y post-condiciones), `deriveStructureMode` (modo esperado). Unitarios:
`src/scripts/__tests__/migrate-faranda-celuisma.test.mts` (specs válidos, códigos únicos,
prefijos sin colisión, planificadores puros e idempotencia sobre el post-estado).

**Specs** (`apps/api/src/scripts/specs/`, formato de `faranda-los-tilos.json`; todos con
`taxRegion ES_PENINSULA_BALEARES`, `fiscalTerritory common`, SES y VeriFactu desactivados,
Carmen Owner, módulos de Los Tilos, plan BAR sin precios y series
`FAC-<COD>-2026-` (F1) · `REC-<COD>-2026-` (R1) · `FS-<COD>-2026-` (serie `SIM`, F2)):
`faranda-pathos-gijon.json` (PG, 56 hab., 3★, Gijón 33024), `faranda-marsol-candas.json`
(MC, 85, 4★, Carreño 33014), `faranda-alisas-santander.json` (AS, 78, 2★ a confirmar,
Santander 39075), `faranda-florida-norte.json` (FN, 399, 4★, Madrid 28079),
`faranda-las-lomas.json` (LL, 102, 3★, Oviedo 33044; reparto PÚBLICO 16/83/3 con `rooms`
explícito) y `faranda-oficina-central.json` (OC, `kind office`, sin habitaciones ni series;
dirección parametrizada en `_notes.addressOptions` madrid | gijon). El reparto por tipo de
PG / MC / AS / FN es ESTIMADO con la regla de Los Tilos (`_estimated`, fuente en `_notes`);
`bedCapacity` = Σ count × baseCapacity; registros turísticos, SES, IAE, superficie y CCC en
`census` a `null` hasta que Faranda los aporte.

```bash
# Desde la raíz (corepack pnpm) o apps/api (node --env-file-if-exists=../../.env --import tsx …).
# 1. Dry-run (por defecto): plan completo paso a paso, conteos, 0 colisiones, decisiones abiertas. No escribe.
corepack pnpm --filter @hotelos/api structure:migrate-faranda-celuisma
corepack pnpm --filter @hotelos/api structure:migrate-faranda-celuisma -- --json > plan.json
#   Opciones: --fiscal-address gijon|madrid|florida (domicilio FISCAL de la sociedad; SIN valor por defecto: sin él el
#   dry-run no planifica las 9 columnas de dirección y --apply se niega con salida 2) · --registered-office
#   gijon|madrid|florida (domicilio SOCIAL; por defecto = fiscal, art. 48 LGT) · --office-city madrid|gijon|florida
#   (sede de la oficina OC; por defecto madrid) · --sandbox-installations (relleno DEV-001-<COD> también en los
#   hoteles con verifactuEnabled=false; por defecto solo en los ya activados, §5.5 paso 8) · --skip-hotels PG,MC.
#   Candidatos (fuentes públicas 2026-09-16): gijon = Avenida de Portugal 7, 33207 Gijón (extracto registral vía
#   Empresia «PORTUGAL, 7», sede histórica) · madrid = Calle General Ampudia 8, bajo A-dcha, 28003 (dirección
#   anterior al cambio de 2014; oficina operativa según Alimarket) · florida = Paseo de la Florida 5, 28008 Madrid
#   (domicilio actual según eInforma; sede del Florida Norte). Empresia y eInforma inscriben la sociedad en el
#   Registro Mercantil de MADRID (incompatible con un domicilio social en Gijón): por eso no hay valor por defecto.
# 2. Confirmación de César (informe §8: direcciones, régimen, cadena, personas) sobre el plan guardado en
#    /Users/cfernandez/anfitorio-demo/pilots/faranda-celuisma/PLAN-DRY-RUN-2026-09-16.md (fuera del repo: CIF real).
# 3. Apply (integrador humano): backup + API :3000/:3400 parados; cada paso es su propia transacción /
#    servicio y deja un evento FARANDA_CELUISMA_MIGRATION_STEP (correlación corr_faranda_celuisma_l8).
corepack pnpm --filter @hotelos/api structure:migrate-faranda-celuisma -- --apply --confirm cmrhw9jy30002fyvb6tsdiugt --fiscal-address gijon|madrid|florida [--registered-office …] [--office-city …] [--sandbox-installations]
# 4. Reiniciar UNA instancia del API; el dry-run CON LOS MISMOS FLAGS debe planificar 0 escrituras (idempotente).
# 5. Rollback (solo lectura): qué escribió el apply y cómo deshacer cada paso.
corepack pnpm --filter @hotelos/api structure:migrate-faranda-celuisma -- --print-rollback
```

Plan del dry-run local (2026-09-16, BD tras el backfill, tras el lote de corrección L8):
**873 escrituras · 0 errores · 0 colisiones** sin flags de dirección (879 con
`--sandbox-installations`). Paso 2: 5 campos confirmados de la sociedad (`FAR` B99999997 →
`CEL` «CELUISMA S.A.» A33615980, `sa`, CNAE 5510; NIF y razón social = alto riesgo) y, SOLO
con `--fiscal-address` / `--registered-office`, las 9 columnas de domicilio (14 campos en
total); sin flag las direcciones quedan como están y el plan imprime los tres candidatos con
su fuente. Régimen (`pgcVariant pymes`, gran empresa, SII, ejercicio) intacto: datos públicos
(eInforma 2024: 62 empleados, capital 4.735.729,75 €) → PGC general probable, decide César.
Paso 3: RA `starRating 3`, `bedCapacity 196`, `tourismRegistryNumber H-CO-000713` (REAT;
las 120 habitaciones demo de RA frente a 103 reales son decisión abierta, no se tocan); LT
`starRating 4`, `bedCapacity 176`, `H-CO-001327`. Paso 4: OC (8 filas). Paso 5: PG 82 · MC
113 · AS 106 · FN 429 · LL 127 filas (720 habitaciones, 15 series). Paso 6: cerrar
`FAC-2026-` (siguiente 23) y `REC-2026-` (4) de RA → `active = false` y `sequence_code`
`FAC-SANDBOX` / `REC-SANDBOX` (libera la clave `(propertyId, sequenceCode, year)`; prefijo,
padding y `nextNumber` intactos, **ninguna factura se renumera**), abrir `FAC-RA-2026-`,
`REC-RA-2026-`, `FS-RA-2026-`. Paso 7: sin escrituras (VatSettings, FiscalYear 2026, SII /
gran empresa / PGC y el `sii_enabled` residual de RA son decisiones de César). Paso 8:
**0 instalaciones por defecto** — los 6 hoteles sin instalación tienen
`verifactuEnabled = false` y, como dice el diseño §5.5 paso 8, la suya se abre al activar
VeriFactu en cada centro (RA conserva `DEV-001`; OC ninguna); un hotel ya activado sin
instalación recibe el relleno `DEV-001-<COD>` **solo con `VERIFACTU_MODE=sandbox`**, y
`--sandbox-installations` extiende ese relleno a los desactivados (6 filas permanentes: el
número es inmutable y no se reutiliza). Paso 11: 8 centros → `mode multi_center`, 20 series
activas, invariantes fiscales idénticos (25 facturas · 33 envíos · 61 asientos / 150 líneas).
Idempotencia: los planificadores puros devuelven 0 cambios sobre su post-estado (tests) y el
dry-run tras el apply, con los mismos flags, debe planificar 0 escrituras.

**Identidad de centro y renombrados.** El script identifica un centro existente por la
clave natural `(legalEntityId, code)` (índice único `properties_legal_entity_id_code_key`) y
por `name` solo como respaldo para filas sin código; `buildPlan` de
`property-provisioning.service.ts` sigue resolviendo por `name`, así que el script le pasa
el spec con el nombre / `tradeName` actuales de la BD (`specForExistingCentre`). Renombrar
un centro (p. ej. Las Lomas «Faranda Express» → «City House») se hace con
`PATCH /properties/:id/establishment { name, tradeName }` y **no rompe la convergencia**: el
dry-run posterior sigue tratándolo como EXISTE y planifica 0 escrituras. Deuda para el dueño
del módulo `structure`: aceptar `(legalEntityId, code)` también en `buildPlan`.

**Convenciones (aviso al cierre documental).** La serie rectificativa es `REC-<COD>-2026-`
(convención de Los Tilos y del validador `assertSeriesCodeMatchesType`, REC ↔ R*); el
diseño §5.5 / §6 y el informe §8 escriben `R-<COD>-2026-` y `cityhouse-*.json`: los ficheros
reales son `faranda-florida-norte.json` y `faranda-las-lomas.json`. Lo corrige el dueño de
`docs/design/**` y `docs/audits/**` en el cierre documental (no en este lote).

**Auditoría en `--apply`.** Cada salida del script (camino feliz, paso fallido o error
inesperado) pasa por `finalizeSummary` / `flushAuditForExit`, que espera la cola
fire-and-forget de `recordAuditEvent` (marcas `FARANDA_CELUISMA_MIGRATION_STEP` y eventos de
los servicios: `LEGAL_ENTITY_UPDATED`, `PROPERTY_PROVISIONED`, `InvoiceSequenceCreated`,
`VERIFACTU_INSTALLATION_OPENED`) antes de `prisma.$disconnect()`; el resumen (`--json`)
lleva `audit.flushed`. Así `--print-rollback` ve un apply parcial en vez de «nada que
deshacer».

**Comprobaciones tras el apply:** `GET /organizations/me/structure` → `mode multi_center`,
`counts.properties 8` (7 hoteles + 1 oficina), cada hotel con sus 3 series activas y su
instalación, OC sin series; `GET /legal-entities/:id/series` → `clashCount 0` y el SQL de
colisiones de §17.9 = 0 filas; `GET /legal-entities/:id` → CELUISMA S.A. · A33615980 ·
`taxIdValid true`; `GET /fiscal/models/303?year=2026&period=Q3` → declarante CELUISMA S.A.
con las MISMAS cifras del cierre de la Tanda 6 (27 = 71 = 74,94; el declarante cambia, la
base no); equivalencia del libro: `GET /fiscal/vat-books` y `SELECT count(*), sum(total)
FROM invoices WHERE property_id = RA` idénticos a antes (25 / snapshots inmutables);
`findSeriesBlockedByTaxIdChange` = 0 (las sandbox están cerradas); `verifyOrganization`
OK; Carmen abre los 8 centros en el switcher. Emitir una factura de prueba en RA en sandbox:
`FAC-RA-2026-000001` con `NombreRazon` CELUISMA S.A. y bloque establecimiento; en LT
`FAC-RA-` → 409 `SERIES_PREFIX_CLASH`.

**Reversible (documentado en `--print-rollback`):** sociedad → PATCH inverso con el
`beforeJson` de `LEGAL_ENTITY_UPDATED`; centros nuevos → `status archived` (solo se borran
con sus satélites si no tienen facturas ni instalación, trigger R10.5); instalaciones de
relleno → `active = false`, `retired_at` (el número es inmutable y no se reutiliza); series
sandbox → `sequence_code` original tras cerrar la serie `-RA-`; series de RA nuevas →
`active = false`; censo → PATCH establishment con el `beforeJson` de `ESTABLISHMENT_UPDATED`.
Los eventos de auditoría no se borran. **Nunca** se remite A33615980 a preproducción /
producción de la AEAT sin mandato de CELUISMA: antes de `VERIFACTU_MODE=preproduction`
retirar `DEV-*` y abrir las instalaciones reales — comprobación previa obligatoria:
`SELECT count(*) FROM verifactu_installations WHERE active AND numero_instalacion LIKE
'DEV-%'` debe devolver **0** (hoy `resolveSoftwareForSend` solo bloquea fuera de sandbox
cuando la instalación es `null`, `INSTALLATION_NOT_DECLARED`; una fila `DEV-…` se enviaría
literal). Pendiente fuera de este lote, en `resolveVerifactuSoftware` /
`resolveSoftwareForSend`: rechazar un `numeroInstalacion` que empiece por
`SANDBOX_INSTALL_NUMBER` cuando `mode ≠ sandbox` (código nuevo, p. ej.
`INSTALLATION_SANDBOX_FILLER`, mismo backoff de configuración).

## 18. Coste de personal importado (Tanda 6c · 2026-09-16)

Diseño: `docs/design/FINANZAS-COSTE-PERSONAL.md` (§1 motivación y alternativas
descartadas, §2 modelo, §3 contabilización, §4 USALI, §5 API, §6 formato, §7 CLI, §8
front, §9 lotes, §10 riesgos y decisiones abiertas). Rutas: `docs/api-contracts.md`
«Coste de personal importado». Código: `apps/api/src/modules/payroll/{cost-import.parser,
cost-import.posting, cost-import.service, cost-report.service, cost-import.routes,
route-permissions.partial}.ts`, esquemas `apps/api/src/schemas/payroll-cost.schemas.ts`,
tipos wire `packages/shared/src/payroll-cost-types.ts`, CLI
`apps/api/src/scripts/import-payroll-cost.ts`, lector USALI
`modules/financial-statements/{source,usali.service}.ts`, front
`apps/admin-web/src/screens/payroll/{PayrollScreen,PayrollCostImportDrawer}.tsx`.

### 18.1 Objetivo, alcance y GDPR

Faranda (CELUISMA S.A., 8 centros bajo un NIF) no calcula las nóminas en el ERP: la
gestoría las hace fuera y RRHH entrega un informe mensual de coste. Hasta esta tanda el
diario de la sociedad no tenía ningún coste de personal (la partida mayor del PyG) y el
USALI cargaba todo el 640/642 en Administración y general. Esta tanda **devenga el coste
de empresa** (D 640 sueldos y salarios / D 642 Seguridad Social a cargo de la empresa) por
centro de trabajo y mes a partir de un informe **agregado**, y enruta la línea `labor`
del USALI por el **centro de coste** del apunte (§4 paso 0). No sustituye a la nómina real
de Anfitorio (`PayrollPeriod` → recibos → `payroll_slip`): cuando un centro y mes ya
tenga nómina real contabilizada, la previsualización lo avisa (`payrollPeriodsPosted`) y el
resultado de create / post repite el aviso en `warnings` —el cajón y el CLI `--apply` lo
muestran— (corrector 6c, contable-6C-08) para no devengar dos veces; no bloquea porque el lote
importado puede ser la única nómina del centro.

**GDPR — agregar antes de importar, nunca nombres.** El formato de importación es
agregado por construcción (centro × mes × grupo × departamento) y no admite columnas de
persona; las tres tablas nuevas guardan solo agregados; el fichero real de Faranda se
agrega FUERA del repositorio (`<raíz git>/pilots/faranda-celuisma/nomina-2026-ene-ago.json`,
carpeta git-ignored) y ningún fichero del repo, de la documentación ni de los tests
contiene nombres, DNI, retribuciones individuales ni categorías por persona: los tests
usan cifras sintéticas. El desglose por persona sigue en la gestoría; el ERP no lo
necesita para el PGC ni para el USALI.

### 18.2 Modelo de datos (§1.8) y catálogo

Tres tablas aditivas (migración `20260916120000_coste_personal_importado`, SQL de
`prisma migrate diff` verbatim con cabecera «reviewed by hand»; 3 `CREATE TABLE`, 1
`CREATE TYPE`, 2 `FOREIGN KEY`, 9 índices más `journal_lines_cost_center_id_idx`; `db:migrate:status`
9/9, `db:drift:check` «No difference detected.»):

| Tabla | Qué es | Clave |
| --- | --- | --- |
| `payroll_cost_imports` (**`PayrollCostImport`**) | UN lote por fichero importado: `source`, `fileName`, `contentHash` (sha256 del contenido normalizado), `periodFrom`/`periodTo`, `status` (`PayrollCostImportStatus`), totales (`totalGross`, `totalEmployerSs`, `totalCost = Σ(gross + employerSs)`, `reportedTotalCost` = Σ `coste_total` del fichero, informativo), `headcountAverage`, `mappingJson` (mapeo aplicado), `journalEntryIds[]`, `reversalJournalEntryIds[]`, `createdBy`, `postedAt`, `reversedAt`, `reversedBy`, `reversalReason` | `@@index([organizationId, status, periodFrom, periodTo])` · `@@index([organizationId, contentHash])` |
| `payroll_cost_lines` (**`PayrollCostLine`**) | Filas AGREGADAS del informe con la etiqueta ORIGINAL del centro (`workCenterLabel`) y del departamento (`departmentLabel`), el centro del ERP (`propertyId`), el grupo (`costGroup`), el departamento USALI (`usaliDepartment`), el mes (`periodCode`), `gross` / `employerSs` / `totalCost` / `reportedTotalCost`, `headcount` (decimal: jornadas parciales) y el `costCenterId` que se rellena al contabilizar | `@@unique([importId, workCenterLabel, periodCode, costGroup, departmentLabel])` (con `propertyId` en vez de la etiqueta habría 30 colisiones en OC: tres etiquetas van al mismo centro) |
| `payroll_cost_references` (**`PayrollCostReference`**) | Referencia del informe por centro × mes: `employeesReported`, `roomsAvailableReported` (INVENTARIO de habitaciones, no habitaciones-noche), `netSalesReported` | `@@unique([importId, propertyId, periodCode])` |

`CostCenter` no cambia: la importación hace `upsert` por `(propertyId, code)` de filas
`{ code: "ROOMS" | "FNB" | "POM" | "SALES_MARKETING" | "ADMIN_GENERAL" | "OTHER_OPERATED" | "IT", name: USALI_DEPARTMENTS[dept], type: "usali", active: true }`
en la misma transacción del asiento. `JournalEntry` y `JournalLine` tampoco añaden
columnas: solo `payroll_cost_import` en el catálogo de `sourceType` (§1.1) y el índice
`@@index([costCenterId])` para el lector USALI.

Catálogo (texto en BD, enums documentales de §1.1): `PayrollCostImport.source` ∈ `csv` ·
`json` · `informe_rrhh`; `PayrollCostLine.costGroup` ∈ `operaciones` (personal de hotel)
· `extras` (refuerzos) · `estructura` (oficinas) · `mantenimiento_obra` (equipo de
mantenimiento/obra) · `familia` (administradores / propiedad); `PayrollCostLine.usaliDepartment`
∈ `rooms` · `fnb` · `other_operated` · `admin_general` · `it` · `sales_marketing` · `pom`
(los que admiten la línea `labor`; `utilities`, `misc_income`, `management_fees`,
`non_operating` y `below_ebitda` → 400 `USALI_LINE_NOT_ADMITTED`). Estados:
`draft` (sin asientos) → `posted` (un asiento por centro × mes) → `reversed` (todos sus
asientos reversados; el hash queda libre para reimportar).

### 18.3 Formato de importación (CSV y JSON), normalización y mapeo

**CSV** — cabecera obligatoria con nombres de columna en minúsculas y sin acentos;
separador `;` (o `,` si la cabecera no contiene `;`); decimales con coma o punto y miles
opcionales («1.234,56»); mes `YYYY-MM` o `MM/YYYY`; BOM admitido; UTF-8 (desde el
navegador el fichero debe guardarse como UTF-8; latin1 solo por el CLI, que decodifica);
columnas desconocidas → aviso; fila con error → `errors[{ line, message }]` con número
de línea 1-based; filas con la misma clave se fusionan sumando importes y empleados (con
aviso «filas N y M fusionadas»). **Topes por valor** (corrector 6c, SEC-6C-02: lo que
pasa el parser cabe en las columnas, nunca un 500 de Prisma dentro de la transacción):
importes < 10^12 (`Decimal(14,2)`), `empleados` / `empleadosInforme` < 10^6
(`Decimal(8,2)`), `hab_disponibles` ≤ 2.147.483.647, etiquetas de centro / grupo /
departamento ≤ 200 caracteres y sin caracteres de control (NUL…); fuera de tope → error
con nº de línea. **Importes ambiguos** (contable-6C-07): «1.234» (un solo punto y tres
cifras detrás) se lee como 1,23 —la regla es «un solo punto = decimal»— y el fichero lo
avisa UNA vez listando las líneas; si son miles, escribir «1.234,00» o «1234». **Topes
por lote** (SEC-6C-03, `PAYROLL_COST_IMPORT_MAX_*` en `payroll-cost-types.ts`): ≤ 24
meses distintos, ≤ 240 celdas (centro, mes) = asientos y ≤ 5.000 filas; superarlos es
400 `PAYROLL_IMPORT_INVALID { errors }` (la preview los lista en `errors`), porque la
transacción del lote retiene el lock de numeración del diario del ejercicio hasta el
commit (≈ 100 ms por asiento) y el resto de asientos de la organización espera. Las tres
columnas opcionales alimentan `PayrollCostReference` por (centro, mes) y `usali` fija el
departamento sin diccionario:

```
centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados[;ventas_sin_iva;hab_disponibles;usali]
```

Ejemplo sintético (dos centros, un mes):

```
centro;mes;grupo;departamento;salario_bruto;coste_ss;coste_total;empleados;ventas_sin_iva;hab_disponibles;usali
HOTEL DEMO;2026-02;operaciones;3 RECEPCIO;6.000,00;1.800,00;7.800,00;3;42.000,00;40;rooms
HOTEL DEMO;2026-02;operaciones;6 PISOS;4.000,00;1.200,00;5.200,00;4;42.000,00;40;rooms
HOTEL DEMO;2026-02;operaciones;5 COCINA;5.000,00;1.500,00;6.500,00;2;42.000,00;40;fnb
OFICINA DEMO;02/2026;estructura;ADMINISTRACION;3.500,00;1.050,00;4.550,00;2;;;admin_general
```

**JSON** — el agregado del informe de RRHH (`{ fuente, organizationId, periodo, mapping:
{ centros, grupos }, lineas: [{ centro, centroCode, mes, grupo, departamento,
usaliDepartment, salarioBruto, costeSs, costeTotal, empleados }], referencia:
[{ centroCode, mes, empleadosInforme, habitacionesDisponibles, ventasSinIva }] }`) o
`{ rows: PayrollCostRowDto[] }`. Si el JSON declara `organizationId` debe coincidir con
la organización destino (400 `PAYROLL_IMPORT_ORGANIZATION_MISMATCH`).

**Normalización y hash.** Etiquetas `trim` + espacios colapsados + mayúsculas (acentos
conservados); importes a 2 decimales; `contentHash` = sha256 del JSON canónico de filas y
referencias ordenadas por `(workCenterLabel, periodCode, costGroup, departmentLabel)`: el
CSV y el JSON equivalentes producen el mismo hash, independiente del formato, los
espacios y el BOM.

**Mapeo** (`applyPayrollCostMapping`, puro; el mapeo aplicado se guarda en `mappingJson`):

| Dimensión | 1.º | 2.º | 3.º | Sin mapear |
| --- | --- | --- | --- | --- |
| Centro | `mapping.centres[etiqueta]` → `propertyId` | `centroCode` del fichero ≡ `Property.code` | etiqueta ≡ `code` / `name` / `tradeName` normalizados | preview: `unmappedCentres[].suggestions`; crear: 400 `PAYROLL_IMPORT_CENTRE_UNMAPPED` |
| Departamento | `mapping.departments[etiqueta]` | columna `usali` / `usaliDepartment` del fichero | diccionario: `RECEP*` / `PISOS` / `SIN DEPARTAMENTO` → `rooms`; `CAF*` / `REST*` / `COCINA` → `fnb`; `MANTENIM*` → `pom`; `DIRECCI*` / `ADMINISTRACION` / `PROPIEDAD` → `admin_general`; `COMERCIAL` → `sales_marketing` | preview: `unmappedDepartments`; crear: 400 `PAYROLL_IMPORT_DEPARTMENT_UNMAPPED` |

Un centro `kind = office` cuyo departamento resuelve a `rooms` / `fnb` / `other_operated`
(«OFICINA ASTURIAS · RECEPCION → rooms», 34.236,25 € en el dataset de Faranda) se
respeta pero se AVISA por (centro, departamento) (contable-6C-06): el personal de una
oficina suele ir a `admin_general`; corregirlo es `mapping.departments` o la columna
`usali` y, si ya está contabilizado, reimportar con `replace`.
| Grupo | `mapping.groups[etiqueta]` | `mapping.grupos` del JSON (`mant-obra` → `mantenimiento_obra`) | valor canónico | 400 `PAYROLL_IMPORT_GROUP_INVALID` |

Los `propertyId` del mapeo llegan anidados en el cuerpo (el hook global de tenencia no
los concede): el servicio comprueba que pertenecen a la organización y al ámbito del
usuario (`assertFinanceReadScopeMany`) → 404 opaco `PROPERTY_NOT_FOUND` /
`ENTITY_SCOPE_REQUIRED`.

### 18.4 El asiento: regla, ejemplo sintético y simplificaciones

Regla pura en `cost-import.posting.ts` con las mismas piezas que el resto de reglas
canónicas (§2): `signedLine` / `assertBalanced` y las constantes `SALARIES_ACCOUNT = "640"`,
`EMPLOYER_SS_ACCOUNT = "642"`, `WAGES_PAYABLE_ACCOUNT = "465"`, `SOCIAL_SECURITY_ACCOUNT = "476"`.
**Un asiento por (centro, mes)**, nunca por grupo (el grupo vive en las líneas del lote y
en el informe; el diario distingue por centro de coste = departamento):

| Campo | Valor |
| --- | --- |
| `sourceType` / `sourceId` | `payroll_cost_import` / `<importId>:<propertyId>:<periodCode>` (§1.1; cada lote lleva un `importId` nuevo, nunca el sufijo `#n` del puente) |
| `propertyId` / `entryDate` | el centro (todas las líneas 6 llevan centro: el 400 `WORK_CENTER_REQUIRED` de la Tanda 6b es inalcanzable) / último día del mes en UTC (`2028-02` → 29) |
| `description` / `reference` | «Coste de personal MM/AAAA · <código o nombre del centro> (importado)» / `periodCode` |
| Líneas | por departamento USALI ordenado por clave: D `640` bruto «Sueldos y salarios · <departamento>» y D `642` SS empresa «Seguridad Social empresa · <departamento>», ambas con `costCenterId` del `CostCenter` `usali` del centro; al final H `465` Σ bruto «Remuneraciones pendientes de pago · coste importado» y H `476` Σ SS empresa «Seguridad Social acreedora · coste importado» |
| Casos límite | importe 0 → sin línea; celda toda a 0 → sin asiento + aviso; plan sin celdas → 400 `PAYROLL_IMPORT_EMPTY`; el parser rechaza importes y empleados negativos |

Ejemplo **sintético** (centro `HD`, febrero 2026, las cuatro filas del CSV de §18.3 para
HOTEL DEMO; Habitaciones bruto 10.000,00 / SS 3.000,00; A&B bruto 5.000,00 / SS 1.500,00):

| Cuenta | Centro de coste | Debe | Haber |
| --- | --- | ---: | ---: |
| 640 Sueldos y salarios · Habitaciones | `HD/ROOMS` | 10.000,00 | |
| 640 Sueldos y salarios · Alimentos y bebidas | `HD/FNB` | 5.000,00 | |
| 642 Seguridad Social empresa · Habitaciones | `HD/ROOMS` | 3.000,00 | |
| 642 Seguridad Social empresa · Alimentos y bebidas | `HD/FNB` | 1.500,00 | |
| 465 Remuneraciones pendientes de pago · coste importado | — | | 15.000,00 |
| 476 Seguridad Social acreedora · coste importado | — | | 4.500,00 |
| **Total** (`entryDate` 2026-02-28, `sourceId` `imp_1:HD:2026-02`) | | **19.500,00** | **19.500,00** |

La oficina del mismo ejemplo produce su propio asiento (640 3.500,00 · 642 1.050,00 con
centro de coste `ADMIN_GENERAL`; 465 3.500,00 · 476 1.050,00).

**Simplificaciones documentadas** (diseño §3.4 y §10.1):

- **Devengo del coste de empresa, sin IRPF ni SS del trabajador.** El informe trae bruto
  y SS empresa; no se conoce el líquido. Por eso 465 recoge el BRUTO (no el líquido) y
  476 solo la SS a cargo de la empresa; no hay 4751 ni desglose de 476 por
  trabajador/empresa. El pago de la nómina (D 465 / H 572), el pago a la TGSS (D 476 /
  H 572) y las retenciones se registran aparte por tesorería cuando lleguen los
  extractos; el Modelo 111 NO se alimenta de estos asientos. Si César quiere el líquido y
  el 111 desde el ERP, hacen falta dos columnas más (IRPF retenido y SS del trabajador)
  y una regla D 465 / H 4751 · H 476: extensión aditiva del formato.
- **Sin IVA.** Ninguna cuenta 47x de IVA → los libros y el Modelo 303 son invariantes.
- **`coste_total` es informativo.** Se contabiliza SIEMPRE bruto + SS empresa; si
  `coste_total` difiere más de 0,01 se avisa (línea y diferencia) y se conserva en
  `reportedTotalCost` para conciliar con el Excel; nunca bloquea.

### 18.5 Flujo: previsualizar → contabilizar → revertir

1. **Previsualizar** (`POST /payroll/cost-imports/preview`, nunca escribe): filas
   normalizadas, `byCentreMonth`, `unmappedCentres[].suggestions`, `unmappedDepartments`,
   `warnings`, `duplicateOf`, `overlaps`, `payrollPeriodsPosted` y `canPost` (= sin
   errores ∧ sin pendientes de mapeo ∧ (sin duplicado ∧ sin solapes, o `replace`)).
2. **Crear y contabilizar** (`POST /payroll/cost-imports`, `post` por defecto `true`;
   `post: false` deja un `draft` que se contabiliza después con `POST …/:id/post`;
   `replace: true` exige `post: true` —400 `VALIDATION_ERROR` en el esquema y en el
   servicio, contable-6C-01: un borrador revertiría los lotes anteriores y dejaría el
   diario sin el coste; el borrador se sustituye al contabilizarlo con `POST …/:id/post
   { replace: true }`). Todo
   en UNA transacción interactiva propia (`maxWait` 15 s, `timeout` 180 s) que empieza
   con `SELECT pg_advisory_xact_lock(hashtext('payroll_cost_import:<organizationId>'))`
   (orden de locks constante importación → numeración del motor, sin interbloqueos):
   duplicado → solape → `payrollCostImport.create` + `createMany` de líneas y
   referencias → `upsert` de los centros de coste → un `ledger().postJournalEntry({ …,
   db: tx })` por celda (`created === false` → 409 `PAYROLL_IMPORT_ENTRY_EXISTS`) →
   lote `posted` con `journalEntryIds`, `postedAt`, `headcountAverage` y `costCenterId`
   en cada línea. El motor aplica 404 `PROPERTY_NOT_FOUND` y 409 `FISCAL_PERIOD_CLOSED`
   / `FISCAL_YEAR_CLOSED`: ante cualquier fallo TODO (lote, líneas, referencias, centros
   de coste, asientos) hace rollback, nada queda a medias. La auditoría
   (`PAYROLL_COST_IMPORTED` / `PAYROLL_COST_IMPORT_POSTED`, `entityType
   payroll_cost_import`, before/after con hash, fichero, periodo, totales, asientos,
   `replacedImportIds` y mapeo) se escribe fuera de la transacción.
3. **Revertir** (`POST /payroll/cost-imports/:id/reverse { reason, entryDate? }`): por
   cada `journalEntryId` del lote, `ledger().reverseJournalEntry` (descripción «Reverso
   coste de personal <mes> · <centro> — <motivo>», referencia `periodCode`; el reverso
   conserva `costCenterId`); si un asiento ya tiene `reversedById` se reutiliza y si su
   estado no es `posted` se salta. Un `draft` pasa a `reversed` sin asientos; un lote ya
   `reversed` devuelve `alreadyReversed: true` (idempotente). **Solo se reversan los
   asientos cuyos ids están en `journalEntryIds` del lote: los asientos previos de la
   organización no se tocan nunca.** **Mes cerrado a posteriori → 409
   `FISCAL_PERIOD_CLOSED` (o `FISCAL_YEAR_CLOSED`) AUNQUE el cuerpo traiga una
   `entryDate` abierta** (corrector 6c, contable-6C-02): el servicio comprueba el periodo
   del asiento ORIGINAL (`assertOriginalPeriodOpen`) porque la regla única de lectura de
   los estados excluye la pareja marcada entera (`reversed_by_id IS NULL AND
   reversal_of_id IS NULL`), así que un reverso fechado en un periodo abierto haría
   desaparecer el 640/642 del mes cerrado del balance, PyG, USALI y ECPN sin que el mes
   abierto recibiera el abono (deuda 14(d)). Procedimiento: reabrir el periodo
   (Contabilidad › Periodos, `reopenFiscalPeriod`), revertir y volver a cerrar; `entryDate`
   solo cambia la fecha del reverso entre periodos abiertos. Lo mismo vale para `replace`
   (revierte lotes enteros con la misma guarda). Auditoría `PAYROLL_COST_IMPORT_REVERSED`.

**Idempotencia en tres capas:**

| Capa | Comprobación | Sin `replace` | Con `replace: true` |
| --- | --- | --- | --- |
| Contenido | mismo `contentHash` en un lote `status ≠ reversed` de la organización | 409 `PAYROLL_IMPORT_DUPLICATE { importId, status, fileName, postedAt }` | el lote anterior se revierte entero y se crea el nuevo en la misma transacción |
| Celdas | alguna (centro, mes) del fichero ya está en un lote `posted` | 409 `PAYROLL_IMPORT_OVERLAP { overlaps[{ importId, fileName, periodFrom, periodTo, propertyId, periodCode }] }` | todos los lotes afectados se revierten enteros (`replacedImportIds`) y se crea el nuevo |
| Asiento | el puente devuelve `created: false` para un `sourceId` | 409 `PAYROLL_IMPORT_ENTRY_EXISTS { sourceId }` (defensivo: imposible en la práctica, el `importId` es nuevo) | ídem |

**`replace` solo revierte lotes cuyos centros están TODOS en el ámbito R11 del usuario**
(SEC-6C-01): un CSV solo de HA no puede revertir un lote HA+HB; el servicio responde el
mismo 404 opaco que el reverso directo y el lote nuevo hace rollback. La preview y los
409 de duplicado / solape enmascaran `fileName` y `postedAt` de los lotes con centros
fuera del ámbito (SEC-6C-04) y con `replace` la preview responde `canPost: false` con
aviso. Cubierto en `tests/integration/payroll-cost-import.test.mts`.

**`replace` reversa lotes ENTEROS: reimportar siempre el rango completo.** Si un lote
cubre 2026-01 → 2026-08 y se reimporta solo 2026-06 con `replace: true`, el lote de ocho
meses se revierte completo y solo queda contabilizado junio: los otros siete meses
desaparecen del diario. La previsualización y el drawer listan los lotes que se
revertirían con su rango; la regla operativa es reimportar el fichero del rango completo
(o revertir a mano y volver a importar). Tras un reverso el hash queda libre y el
`importId` (y por tanto los `sourceId`) del nuevo lote son nuevos.

### 18.6 USALI por centro de coste y headcount

El lector `accountBalances({ byCostCentre: true })` (§4 paso 0, §8) hace `LEFT JOIN
cost_centers` y agrupa por `(cost_centers.type, code)` —nunca por `id`: el consolidado
funde `RA/ROOMS` con `LT/ROOMS`—; la SQL sin flag (balance, PyG, ECPN, memoria, PyG por
centro y gestoría) es byte-idéntica a la anterior. `routeByCostCentre` mueve la línea
`labor` / `other_expense` al departamento del centro de coste `usali` cuando
`USALI_DEPARTMENT_LINES` lo admite y marca la cuenta con `source: "cost_center"`; GOP,
EBITDA, resultado y `reconciliation` no cambian (los totales PGC se acumulan antes del
enrutado). **Advertencia de alcance:** afecta a cualquier apunte con `cost_center_id`
de tipo `usali` — nóminas reales cuyo contrato tenga centro de coste y asientos manuales
incluidos — porque el objetivo es un solo origen de verdad del departamento; un centro de
coste `usali` mal asignado mueve gasto entre departamentos del USALI sin tocar el PGC.

Headcount (`statistics.headcount` / `headcountSource`): recibos de nómina por centro
(`payroll_slips`) como antes; si no hay, lotes `posted` (`payroll_cost_import`):
`employeesReported` de la referencia por (centro, mes) o, en su defecto, Σ `headcount`
de las celdas; media de los meses CON dato (2 decimales) y `Math.round` de la suma de
centros; sin datos → `null`, nunca 0. `ratios.laborPerEmployee` = Σ `labor` / headcount
(`null` si el headcount es nulo o 0). Prioridad de la referencia: Σ `empleados` por celda
sobrecuenta a quien figura en dos grupos (§18.12). `pnl-by-property` y `allocation`
reciben el mismo headcount para la clave de reparto.

### 18.7 Rutas, permisos y ámbito (R11)

Partial `modules/payroll/route-permissions.partial.ts` (7 entradas; tabla completa en
§13): lectura `payroll.read` (`GET /payroll/cost-imports`, `GET …/:id`, `GET
/payroll/cost-report`; nunca `accounting.read` ni `analytics.read`: invariantes
`finance-report-keys` / `route-read-keys`), escritura `payroll.manage` (`POST …/preview`
medium, `POST /payroll/cost-imports` y `POST …/:id/post` high, `POST …/:id/reverse`
critical — espejo de `POST /payroll/periods/:id/pay`). El manifiesto exige TODAS las
claves de la entrada y por eso la ruta pide solo `payroll.manage`: con `["payroll.manage",
"accounting.journal.post"]` la plantilla de Dirección (que tiene `payroll.manage` sin
`accounting.journal.post`) recibiría 403. En el servicio las escrituras aceptan cualquiera
de `PAYROLL_WRITE_KEYS` (`payroll.manage` o `accounting.journal.post`) y las lecturas
`PAYROLL_READ_KEYS = ["payroll.read", "payroll.manage", "accounting.journal.post"]`
(`treasury/permissions.ts`). Las rutas high/critical rechazan el fallback demo sin token.

Ámbito (R11 de la Tanda 6b): un lote es visible y actuable solo cuando TODOS los centros
que toca están en el ámbito del usuario (`assertFinanceReadScopeMany`; el listado filtra
con `propertyWithinScope`); `GET /payroll/cost-imports/:id` resuelve la tenencia con
`assertEntityAccess(request, { entity: "payrollCostImport", id })` (404 opaco
`PAYROLL_IMPORT_NOT_FOUND`); `GET /payroll/cost-report` sin `propertyId` = toda la
sociedad → exige `accounting.entity.read` o un contexto sin asignaciones, si no 404
`ENTITY_SCOPE_REQUIRED`. Cuerpos zod `.strict()` con mensajes en español (`content` ≤
1.000.000 caracteres —el JSON de Faranda pesa 103 KB—, `fileName` ≤ 200, `notes` ≤ 2000,
`reason` 3..500, `from`/`to` `YYYY-MM` con `to ≥ from` y ≤ 24 meses).

Informe (`GET /payroll/cost-report?from&to[&propertyId][&group]`): líneas de lotes
`posted`, referencias (la del último `postedAt` gana), ventas netas del libro por centro
× mes en una sola `$queryRaw` sobre cuentas `70%` (misma regla de exclusión que los
estados: sin borradores, sin parejas de reverso marcadas, sin regularización / cierre /
apertura) e inventario `room.count({ propertyId, active: true })`. Por celda:
`headcount = employeesReported ?? Σ headcount` (`headcountSource` `reference` | `lines`;
con filtro de grupo siempre Σ de las filas del grupo), `costPerEmployee`,
`roomsAvailable = (roomsInventoryReported ?? roomsInventory) × días del mes`,
`costPerAvailableRoom`, `laborPctLedger = 100 × totalCost / ledgerNetSales`,
`laborPctReference = 100 × totalCost / netSalesReported`, `byGroup`, `byDepartment`;
`null` con denominador 0; `group` filtra solo las líneas de coste (ventas y referencia
no); `salesSource` en cada celda, centro, mes y sociedad = fuente PRINCIPAL de ventas
por la **regla de cobertura del libro** (corrector 6c, contable-6C-03,
`PAYROLL_COST_LEDGER_COVERAGE_MIN = 0,9`): `ledger` solo cuando el libro tiene ventas y,
si hay referencia, alcanza al menos el 90 % de ella; si no, `reference` cuando la hay;
`null` sin ventas. Ambos `laborPct*` se calculan siempre; el front pinta el de
`salesSource` (en Faranda, 10,33 € en el libro frente a 837.898,72 de referencia en
julio daban un «Personal s/ ventas» de 23.645.296,81 %: ahora el KPI y la barra usan la
referencia, 56,34 %). En `totals`, `headcountAverage` y `costPerEmployeeAverage` (=
coste ACUMULADO del rango entre los empleados medios, no una media mensual).

### 18.8 Códigos de error

| Código | Status | `details` | Cuándo |
| --- | --- | --- | --- |
| `VALIDATION_ERROR` | 400 | issues zod (español) | clave desconocida, formato inválido, rango > 24 meses, motivo corto, `replace: true` con `post: false` |
| `PAYROLL_IMPORT_INVALID` | 400 | `{ errors: [{ line, message }] }` | cabecera, mes no `YYYY-MM`/`MM/YYYY`, importes o empleados negativos, no numéricos o fuera de tope (importes ≥ 10^12, empleados ≥ 10^6, inventario > 2^31-1, etiquetas > 200 caracteres o con caracteres de control), lote > 24 meses / 240 celdas / 5.000 filas |
| `PAYROLL_IMPORT_EMPTY` | 400 | — | sin líneas de coste (o todas a 0) |
| `PAYROLL_IMPORT_GROUP_INVALID` | 400 | `{ labels }` | grupo fuera de los 5 canónicos y sin mapeo |
| `PAYROLL_IMPORT_ORGANIZATION_MISMATCH` | 400 | `{ sourceOrganizationId }` | `organizationId` del JSON ≠ organización destino |
| `PAYROLL_IMPORT_CENTRE_UNMAPPED` | 400 | `{ labels, rows }` | etiqueta de centro sin `Property` (la preview no lanza: `unmappedCentres`) |
| `PAYROLL_IMPORT_DEPARTMENT_UNMAPPED` | 400 | `{ labels }` | etiqueta de departamento sin USALI |
| `USALI_LINE_NOT_ADMITTED` | 400 | `{ department, labels }` | departamento que no admite `labor` |
| `JOURNAL_REVERSAL_REASON_REQUIRED` | 400 | — | reverso sin motivo |
| `PROPERTY_NOT_FOUND` / `ENTITY_SCOPE_REQUIRED` | 404 (opaco) | — | centro de otra organización / centro fuera de ámbito o informe de toda la sociedad sin `accounting.entity.read` |
| `PAYROLL_IMPORT_NOT_FOUND` | 404 (opaco) | — | lote inexistente o de otra organización («Importación de coste de personal no encontrada.») |
| `PAYROLL_IMPORT_DUPLICATE` | 409 | `{ importId, status, fileName, postedAt }` | mismo hash vivo sin `replace` |
| `PAYROLL_IMPORT_OVERLAP` | 409 | `{ overlaps: [{ importId, fileName, periodFrom, periodTo, propertyId, periodCode }] }` | celda (centro, mes) ya contabilizada sin `replace` |
| `PAYROLL_IMPORT_ALREADY_POSTED` / `PAYROLL_IMPORT_REVERSED` | 409 | `{ importId }` | `post` sobre un lote que no está en borrador |
| `PAYROLL_IMPORT_ENTRY_EXISTS` | 409 | `{ sourceId, journalEntryId }` | el puente devolvió `created: false` (defensivo) |
| `FISCAL_PERIOD_CLOSED` / `FISCAL_YEAR_CLOSED` | 409 | del motor o `{ periodCode | yearCode, entryDate, journalEntryId }` del servicio | mes o ejercicio cerrado (rollback completo del lote); en el reverso, el periodo del asiento ORIGINAL cerrado aunque `entryDate` sea abierta → reabrir el periodo antes |

El front traduce cada código por `details.code` (`FINANCE_ERROR_MESSAGES` de
`services/finance-contracts.ts`). Catálogo en `PAYROLL_COST_ERROR_CODES`
(`packages/shared/src/payroll-cost-types.ts`).

### 18.9 CLI `payroll:import-cost`

`apps/api/src/scripts/import-payroll-cost.ts` (estilo `migrate-faranda-celuisma.ts`;
salida 0 ok · 1 fallo · 2 uso); script npm `payroll:import-cost` en `apps/api/package.json`:

```bash
corepack pnpm --filter @hotelos/api payroll:import-cost -- --file <ruta.json|ruta.csv> --organization <orgId>            # dry-run (por defecto)
corepack pnpm --filter @hotelos/api payroll:import-cost -- --file <ruta> --organization <orgId> --apply --confirm <orgId> [--replace] [--json]
# equivalente: cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/import-payroll-cost.ts --file … --organization …
```

- Lectura del fichero: `Buffer` → UTF-8 estricto y, si falla, latin1; quita el BOM;
  formato por extensión o por el primer carácter `{` / `[`.
- Contexto de sistema: `userId usr_system_payroll_cost_import`, `deviceId
  cli:import-payroll-cost`, permisos `payroll.manage`, `payroll.read`,
  `accounting.journal.post`, `accounting.read`, `accounting.entity.read`, sin
  `assignedPropertyIds` (toda la sociedad); `createdBy "cli:import-payroll-cost"`,
  `correlationId "corr_payroll_cost_import"`; `source informe_rrhh` cuando el JSON trae
  `fuente`.
- **Dry-run (por defecto)**: cabecera (organización, sociedad vía `resolveLedgerScope`,
  fichero, hash, periodo), tabla centro × mes (código, mes, líneas, bruto, SS, total,
  empleados, empleados del informe), totales por grupo, avisos (discrepancias de
  `coste_total` con número de línea), etiquetas sin mapear, `duplicateOf` / `overlaps` /
  `payrollPeriodsPosted`, `canPost` y «Nada escrito»; salida 1 si hay errores, centros
  sin mapear o duplicado / solape sin `--replace`.
- **`--apply --confirm <orgId>`** (el `--confirm` debe repetir exactamente el
  `--organization`): `hydrateAuditChainFromPostgres`, `createPayrollCostImport`, flush
  de auditoría y de las proyecciones antes de `$disconnect`; imprime `importId`, número
  de asientos, primer y último número y ejercicio, totales 640/642/465/476,
  `reportedTotalCost` y diferencia, `replacedImportIds`; `--json` vuelca el resultado.
  Como el resto de CLI contables: backup previo y API parados (cadena de auditoría en
  memoria, deuda 12(c)).
- **`--replace`** reversa ENTEROS los lotes que dupliquen o solapen (§18.5): nunca sobre
  un lote real cargado salvo para sustituir el rango completo.

### 18.10 Carga de Faranda (L6): dataset, discrepancia verificada, invariantes y SQL de comprobación

Dataset agregado (fuera del repo, sin datos personales): 363 líneas · 6 centros del ERP
(AS, LT, MC, OC, PG, RA; las etiquetas OFICINA ASTURIAS, OFICINA MADRID y REG. CORUÑA
van a OC conservando la etiqueta original) · 48 celdas centro × mes (2026-01 → 2026-08)
· 40 referencias · 5 grupos. Verificado sobre el fichero el 2026-09-16:

| Magnitud | Importe |
| --- | ---: |
| Σ `salarioBruto` (→ 640) | 1.891.222,19 |
| Σ `costeSs` (→ 642) | 551.336,97 |
| **Total contabilizado** (640 + 642 = 465 + 476) | **2.442.559,16** |
| Σ `costeTotal` del informe (→ `reportedTotalCost`) | 2.442.027,24 |
| Diferencia | −531,92 |
| Por grupo (Σ `costeTotal`): operaciones · extras · estructura · mantenimiento_obra · familia | 1.450.402,34 · 35.608,45 · 384.693,04 · 142.931,02 · 428.392,39 |

**Discrepancia verificada — pregunta abierta para César.** Una sola fila descuadra:
`RA · 2026-04 · extras · «4 CAF/REST»` trae `coste_total` 1.047,75 frente a bruto + SS
1.579,67 (−531,92); el resto de las 362 filas cumple `coste_total = bruto + SS` al
céntimo. La regla de §18.4 contabiliza bruto + SS (1.579,67) y guarda 1.047,75 en
`reportedTotalCost`; por eso el diario de Faranda sumará **2.442.559,16** (640
1.891.222,19 + 642 551.336,97) y no los 2.442.027,24 del brief, que es la Σ `coste_total`
del informe y se conserva en `PayrollCostImport.reportedTotalCost`. El dry-run y la
previsualización lo avisan con el número de línea. ¿Tiene razón el Excel (p. ej. una
regularización de abril en esa celda) o la fila viene mal sumada? Si el Excel tiene razón, corregir el agregado y reimportar el rango completo con
`replace`; si es un error del informe, nada que hacer.

Procedimiento (integrador de L6; puertas completas en verde antes): dry-run → apply
**una vez** (`--apply --confirm cmrhw9jy30002fyvb6tsdiugt`, nunca `--replace`) →
comprobaciones SQL → segundo apply → 409 `PAYROLL_IMPORT_DUPLICATE` sin escrituras →
`db:drift:check` y `db:migrate:status`. Estado a la escritura de esta sección (BD local):
0 lotes, 0 líneas, 0 referencias, 0 `cost_centers` `usali`; Faranda con 61 asientos /
150 líneas / Σ 2.595,00, `entry_number` máximo 61, 25 facturas, 33 envíos VeriFactu, 0
`payroll_periods`, 0 `fiscal_periods`. Esperado tras el apply: 48 asientos nuevos
numerados 62..109 en el ejercicio 2026 y 21 centros de coste `usali` (AS 4 · LT 3 · MC 4
· OC 4 · PG 3 · RA 3).

**Resultado (2026-09-16).** Apply único a las 19:20 CEST (17:20 UTC en `posted_at`) por el integrador
de L6: lote `cmu4d93ri0000fyajr2krjs55` `posted` (`informe_rrhh`, hash `e4ed6a76d1c7d50c…`, 363 filas,
40 referencias, `headcount_average` 128,75, `created_by cli:import-payroll-cost`, evento
`aud_43788d08`); 48 asientos 2026/62 → 2026/109 (RA, LT, OC, PG, MC, AS por mes, último día del mes)
con 640 D 1.891.222,19 · 642 D 551.336,97 · 465 H 1.891.222,19 · 476 H 551.336,97; 21 centros de coste
`usali`. Re-verificación del integrador final a las 21:20 CEST: todas las consultas de abajo con el
valor esperado (61 / 150 / 2.595,00 previos intactos; 0 líneas 640 / 642 sin centro ni centro de
coste; 25 facturas · 33 envíos · 0 `payroll_periods`; Modelo 303 2026-Q3 27 = 71 = 74,94) y el
**dry-run repetido devuelve duplicado + 48 solapes con `canPost: no` y 0 escrituras** (salida en
`<raíz git>/pilots/faranda-celuisma/NOMINA-DRY-RUN-2026-09-16.md`). Ni segundo apply ni `--replace`.
Informe: `docs/audits/TANDA-6C-COSTE-PERSONAL-2026-09-16.md` §4.

```sql
-- Sustituir <orgId> por cmrhw9jy30002fyvb6tsdiugt (Faranda). Todo solo lectura.
-- 1. Lote: 1 fila posted · 2026-01 → 2026-08 · 363 filas · 1891222.19 · 551336.97 · 2442559.16 · 2442027.24 · 48 asientos
SELECT id, status, source, period_from, period_to, row_count, total_gross, total_employer_ss, total_cost,
       reported_total_cost, headcount_average, array_length(journal_entry_ids, 1) AS asientos,
       array_length(reversal_journal_entry_ids, 1) AS reversos, posted_at
FROM payroll_cost_imports WHERE organization_id = '<orgId>';
SELECT count(*) FROM payroll_cost_lines WHERE organization_id = '<orgId>';        -- 363
SELECT count(*) FROM payroll_cost_references WHERE organization_id = '<orgId>';   -- 40
SELECT count(*) FROM payroll_cost_lines WHERE organization_id = '<orgId>' AND cost_center_id IS NULL;  -- 0

-- 2. Asientos nuevos: 48, uno por (centro, mes), último día del mes, ejercicio 2026, numerados 62..109, 6 centros
SELECT count(*) AS asientos, min(entry_number), max(entry_number), count(DISTINCT property_id) AS centros,
       count(DISTINCT fiscal_year_code) AS ejercicios,
       bool_and(entry_date = (date_trunc('month', entry_date) + interval '1 month - 1 day')::date) AS ultimo_dia,
       count(DISTINCT source_id) = count(*) AS source_id_unicos
FROM journal_entries
WHERE organization_id = '<orgId>' AND source_type = 'payroll_cost_import' AND status = 'posted';

-- 3. Cuadre: 640 D 1891222.19 · 642 D 551336.97 · 465 H 1891222.19 · 476 H 551336.97 (Σ debe = Σ haber = 2442559.16)
SELECT jl.account_code, sum(jl.debit) AS debe, sum(jl.credit) AS haber
FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
WHERE je.organization_id = '<orgId>' AND je.source_type = 'payroll_cost_import' AND je.status = 'posted'
GROUP BY jl.account_code ORDER BY jl.account_code;

-- 4. Toda línea 640/642 lleva centro de coste usali (0 filas) y solo cuentas 640/642/465/476 (4 filas)
SELECT count(*) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
WHERE je.source_type = 'payroll_cost_import' AND jl.account_code IN ('640', '642') AND jl.cost_center_id IS NULL;
SELECT DISTINCT jl.account_code FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
WHERE je.organization_id = '<orgId>' AND je.source_type = 'payroll_cost_import' ORDER BY 1;

-- 5. Centros de coste usali: 21 (AS 4 · LT 3 · MC 4 · OC 4 · PG 3 · RA 3), códigos = departamento USALI en mayúsculas
SELECT p.code AS centro, count(*) AS centros_de_coste, string_agg(cc.code, ',' ORDER BY cc.code) AS codigos
FROM cost_centers cc JOIN properties p ON p.id = cc.property_id
WHERE cc.type = 'usali' AND p.organization_id = '<orgId>' GROUP BY p.code ORDER BY p.code;

-- 6. Invariantes: los 61 asientos previos intactos (61 / 150 líneas / Σ 2595.00, ninguno reversado), 25 facturas,
--    33 envíos VeriFactu, 0 payroll_periods, 0 líneas nuevas en cuentas 47x de IVA (472/477)
SELECT count(*) FROM journal_entries WHERE organization_id = '<orgId>' AND source_type <> 'payroll_cost_import';   -- 61
SELECT count(*), sum(jl.debit) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
WHERE je.organization_id = '<orgId>' AND je.source_type <> 'payroll_cost_import';                                    -- 150 | 2595.00
SELECT count(*) FROM journal_entries WHERE organization_id = '<orgId>' AND entry_number <= 61 AND reversed_by_id IS NOT NULL; -- 0
SELECT count(*) FROM invoices i JOIN properties p ON p.id = i.property_id WHERE p.organization_id = '<orgId>';      -- 25
SELECT count(*) FROM verifactu_submissions s JOIN invoices i ON i.id = s.invoice_id
JOIN properties p ON p.id = i.property_id WHERE p.organization_id = '<orgId>';                                        -- 33
SELECT count(*) FROM payroll_periods WHERE organization_id = '<orgId>';                                              -- 0
SELECT count(*) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
WHERE je.source_type = 'payroll_cost_import' AND (jl.account_code LIKE '472%' OR jl.account_code LIKE '477%');       -- 0
```

Por API tras el reinicio de :3000: `GET /fiscal/models/303?period=2026-Q3` (la forma
`?year=&period=Q3` responde 400) con las
MISMAS cifras del cierre de la Tanda 6 (27 = 71 = 74,94: la nómina no lleva IVA); `GET
/accounting/usali/pnl?from=2026-01-01&to=2026-08-31` con la línea `labor` repartida
entre Habitaciones, A&B, POM, Ventas y marketing y A&G (antes todo en A&G) y GOP / EBITDA
/ resultado idénticos a `GET /accounting/reports/pnl` del mismo rango; `GET
/payroll/cost-report?from=2026-01&to=2026-08` → `totals.totalCost "2442559.16"`. Informe
de cierre de la tanda: `docs/audits/TANDA-6C-COSTE-PERSONAL-2026-09-16.md`.

### 18.11 Front (Nóminas › Coste de personal)

`PayrollScreen.tsx` añade la pestaña «Coste de personal» (`view "cost"`, Cocoa 22, sin
`.bo-*` ni estilos inline): KPIs (coste total del rango, coste por empleado, personal
sobre ventas con la fuente de las ventas, empleados medios), selectores «Desde» /
«Hasta» (meses) y «Grupo» (Todos + 5 grupos), centro desde el `FinanceScopeSelector`
(sin centro = toda la sociedad), matriz centros × meses con filas Empleados / Coste /
Coste por empleado / % s/ ventas y desglose por departamento USALI al expandir un centro,
dos gráficos de barras (coste por mes; ventas netas por mes, libro o referencia), lista
de importaciones (estado Borrador / Contabilizado / Revertido, asientos) con acciones
«Contabilizar» (borrador) y «Revertir» (diálogo destructivo con motivo obligatorio) solo
con `payroll.manage`. Drawer «Importar informe» (`PayrollCostImportDrawer.tsx`): fichero
CSV/JSON (`CocoaFileInput`, ≤ 1 MB) o texto pegado → previsualización con mapeo de los
centros no reconocidos a centros del ERP y de los departamentos a USALI → avisos de
duplicado / solapes (lista de lotes que se revertirían ENTEROS con su rango) / nóminas
reales contabilizadas + interruptor «Sustituir los lotes anteriores» → «Contabilizar» →
resultado con los asientos («2026/62 · RA · ene 2026 · …»). Corrector 6c: la primera
sugerencia de centro se aplica y la previsualización se repite con ella (el select queda
listado para confirmar o cambiar: FU-01); el cajón se reinicia en cada apertura (FU-04);
sin `payroll.manage` explica que tampoco puede previsualizar (FU-10); el diálogo
«Revertir» ofrece «Fecha de la anulación» como el diario, con la nota de reabrir el mes
cerrado (FU-06); «Contabilizar» un borrador ofrece «Sustituir los lotes anteriores»
(FU-12); en móvil cada tarjeta lleva su centro y solo el último mes + Total (FU-05);
insignia «Cargando» al cambiar rango o grupo (FU-07); el KPI «Coste por empleado» se
rotula «acumulado del rango por empleado medio» (FU-03) y «Empleados medios» dice «sin
dato de empleados» cuando no hay ninguno (FU-11). `UsaliScreen.tsx` muestra el
badge «Centro de coste» en el detalle de cuentas cuando `account.source === "cost_center"`;
`accounting-ui.ts` etiqueta `payroll_cost_import` como «Coste de personal importado» en
el diario. Clientes tipados en `services/payrollApi.ts`; mensajes por código en
`services/finance-contracts.ts`.

### 18.12 Límites y decisiones abiertas para César

- **Headcount por celda sobrecuenta.** Σ `empleados` de las celdas cuenta dos veces a
  quien figura en dos grupos (en el dataset de Faranda, en un centro y mes la suma de
  celdas da 25 frente a 16 en el resumen del informe). Por eso el coste por empleado y
  el headcount USALI priman `employeesReported` de la referencia (`headcountSource`
  explícito); con filtro de grupo el informe usa la Σ del grupo.
- **OFICINA MADRID y REG. CORUÑA** no existen como centros del ERP y van a OC con la
  etiqueta original en `workCenterLabel`. Si César quiere centros propios: alta de dos
  `Property kind = office` (o `other`) con `code` (p. ej. `OM`, `RC`) desde Estructura
  societaria y reimportación del rango completo con `replace`.
- **Grupo `familia`** (PROPIEDAD, administradores; 428.392,39 € en ocho meses) va a
  640/642 en `admin_general` como el resto. Si son retribuciones de administradores el
  PGC también las presenta en 640 (con nota en la memoria); separarlas es un mapeo
  `groups` a otro departamento admitido o una cuenta distinta en una tanda posterior.
- **Subcuentas 640.x / 642.x** descartadas (diseño §1.1): el departamento vive en
  `CostCenter`. Si la gestoría exige subcuentas en sumas y saldos, se añade un mapeo
  cuenta ← (640, centro de coste) en la exportación a gestoría sin tocar los asientos.
- **Pago y retenciones** fuera de estos asientos (§18.4): el 111 y el líquido exigen
  importar además IRPF retenido y SS del trabajador por celda.
- **Ventas del libro** (grupo 70 por centro y mes) solo existen en Faranda desde julio
  2026 (10,33 €): la regla de cobertura del libro (§18.7) deja la referencia del informe
  como fuente principal en todo el rango (`salesSource: "reference"`, 56,34 %). Cargar la
  facturación histórica o aceptar la referencia como cifra de gestión.
- **Un lote por ejercicio como máximo** (transacción larga bajo dos advisory locks,
  `timeout` 180 s) y topes por lote (≤ 24 meses · ≤ 240 celdas · ≤ 5.000 filas, §18.3);
  informes mayores de 1.000.000 caracteres o en latin1 → CLI.
- **Personal de la oficina central en departamentos operativos** (OFICINA ASTURIAS ·
  RECEPCION → `rooms`, 34.236,25 €): el lote cargado lo conserva tal como lo mapeó el
  informe; el parser avisa (§18.3) y corregirlo es un `mapping.departments` o la columna
  `usali` + reimportación con `replace`. Decisión de César.
- **`coste_total` del informe frente a bruto + SS**: el lote de Faranda contabiliza
  2.442.559,16 € (Σ 640 + 642) frente a los 2.442.027,24 € declarados (+531,92 €): una
  línea del grupo `extras` con `costeTotal ≠ salarioBruto + costeSs` (35.608,45 frente a
  36.140,37). El asiento sigue la regla §1.7 (bruto + SS, lo que el PGC devenga en 640 y
  642); el lote guarda `reportedTotalCost` y la discrepancia queda avisada. Si RRHH
  confirma que el `costeTotal` es el bueno, corregir el fichero y reimportar con
  `replace`.
- **La carga real añade 48 asientos de 2026 a Faranda**: cualquier pin futuro sobre
  cifras USALI / PyG de Faranda 2026 cambia; documentado en el informe de cierre de L6.
- **Nómina real y coste importado en el mismo centro y mes** no se bloquean (solo
  aviso `payrollPeriodsPosted`): cuando Faranda calcule nóminas en el ERP, revertir el
  lote importado de esos meses antes de contabilizar la nómina real.
- **Importación directa de `.xlsx`**: no construida a propósito. El Excel de RRHH es por
  persona y no debe entrar en el ERP (§18.1); el ERP acepta el agregado en CSV `;` o JSON
  (drawer o CLI). Camino recomendado: RRHH exporta su tabla dinámica agregada (centro × mes ×
  grupo × departamento) como CSV UTF-8 y la sube en Nóminas › Coste de personal. Un lector
  `.xlsx` en el API exigiría una librería (hoy ninguna en `node_modules`, regla de §9) y
  garantizar que solo se persisten agregados: solo si el CSV falla en la práctica. Decisión
  de César (informe de cierre §6).

## 19. Importación contable desde Sage 200 (Tanda 7c · 2026-09-17)

Runbook operativo completo (qué pedir a administración, formatos y cabeceras, orden de
carga, mapas, modo sombra, reconciliación, CLI paso a paso, SQL de verificación, FAQ y
decisiones): **`docs/runbooks/finanzas-importacion-sage200.md`**. Diseño:
`docs/design/FINANZAS-IMPORTACION-SAGE200.md` (§4 modelo, §5 modo sombra, §6 saldos sin
diario, §7 API / CLI / front, §10.4 correcciones tras el plan de lotes). Rutas:
`docs/api-contracts.md` «Importación contable desde Sage 200 (Tanda 7c)» y §13 de este
runbook (partial `accounting (ledger-import)`, 15 entradas). Comandos: §14 comando 6.
Correcciones de la revisión adversarial (ronda 1, 2026-09-17; diseño §10.4.4): el lote
`vat_books` excluye los documentos propios y solapa por fila de libro; el sourceId de recibidas
lleva el NIF del proveedor; `balances` rehúsa ejercicios con diario o apertura importados;
la reconciliación toma el saldo acumulado de la última fila, compara el IVA por tipo por
prefijo y deja fuera la regularización fechada en `to`; cobros consumidos una sola vez;
destinos del mapa comprobados en la preview; `closeFiscalYear` rehúsa (409
`FISCAL_YEAR_CLOSED_FROM_IMPORT`) un ejercicio con cierre importado; listados a nivel sociedad
con `accounting.entity.read`; `options.numberingDimension` / `--numbering`. Código:
`packages/shared/src/ledger-import-types.ts` (catálogos, límites, `LEDGER_IMPORT_ERROR_CODES`
y DTOs), `apps/api/src/modules/accounting/import/{sage200.parser, sage200.xml,
ledger-import.mapping, ledger-import.posting, ledger-import.canonical, ledger-import.service,
ledger-reconciliation.service}.ts`, `apps/api/src/modules/accounting/{ledger-import.routes,
ledger-import-route-permissions.partial, fiscal-year.service (markFiscalYearClosedFromImport),
vat-books.service (rebuild excluye sage200; toVatBookCreateInput)}.ts`, esquemas
`apps/api/src/schemas/ledger-import.schemas.ts`, CLI `apps/api/src/scripts/import-sage200.ts`
(`sage200:import`), front `apps/admin-web/src/screens/accounting/{Sage200ImportScreen.tsx,
sage200-import-helpers.ts}` y `services/ledgerImportApi.ts`.

### 19.1 Objetivo y alcance

Encargo de César (2026-09-16/17): «importar toda la información contable, a cualquier nivel,
desde el diario hasta el balance, desde Sage 200». Sage 200 sigue siendo el sistema contable
de registro de CELUISMA (modo sombra: Sage sigue, Anfitorio replica y compara, luego cambia).
Administración exporta por listado (Diario con desglose analítico, Sumas y saldos nivel 0,
Plan de cuentas, Libro Registro de IVA formato AEAT, Clientes / Proveedores) y Anfitorio los
importa por **lotes de seis tipos** (`plan` · `fiscal_years` · `journal` · `vat_books` ·
`third_parties` · `balances`, `LEDGER_IMPORT_KINDS`, idénticos a `--type` del CLI) en
**cinco formatos** (`sage_excel` por cabecera con sinónimos, `sage_ime_csv` de 60 columnas,
`sage_xml` —hoy `LEDGER_IMPORT_XML_UNSUPPORTED`—, `canonical_csv`, `canonical_json`), a
través de un **mapa de cuentas** persistente Sage → PGC Pymes hotelero (7 reglas, §19.3) y un
**mapa analítico** (canal / delegación / departamento / sección / proyecto → centro de trabajo
y centro de coste USALI), y contabiliza **siempre** por `postJournalEntry`. Toda la
presentación PGC (diario, mayor, sumas y saldos, balance, PyG, cuentas anuales con
`comparative`) y USALI por centro sale del diario: importar diario o saldos basta.

### 19.2 Modelo (§1.1 y §3): siete tablas, una migración

Migración `20260917110000_sage200_importacion` (**12.ª** de la cadena; 11 antes, 12 después;
salida verbatim de `prisma migrate diff`, sin pasos de datos; `db:drift:check` 0): 7 `CREATE
TABLE` (`ledger_imports`, `ledger_import_entries`, `ledger_import_balances`,
`ledger_account_maps`, `ledger_analytics_maps`, `ledger_third_parties`,
`ledger_reconciliations`), 1 `CREATE TYPE "LedgerImportStatus"` (`draft` · `posted` ·
`reversed`, gemelo de `PayrollCostImportStatus`) y el **primer `ALTER TYPE … ADD VALUE` del
repo** (`VatBookSourceType` gana `sage200`; PostgreSQL ≥ 12 lo admite en la transacción de
`migrate deploy` mientras el valor no se use en la misma transacción, por eso la migración es
DDL puro). **Aditiva**: ninguna columna nueva en `JournalEntry` / `JournalLine` (bloques
pinados por `tests/finanzas-schema-contract.test.mjs`); `vat_book_entries` conserva su unicidad
`(org, book, sourceType, sourceId, rate)`; sin FK a `properties` / `suppliers` /
`journal_entries` (convención de `payroll_cost_imports`). Contrato pinado por
`tests/sage200-schema-contract.test.mjs`. `sourceType` nuevos en `JOURNAL_SOURCE_TYPES` y
en §1.1: `sage200_journal` (un asiento por (asiento Sage, centro)) y `sage200_balance` (un
asiento resumen por (ejercicio, periodo, centro) y la apertura), con `SOURCE_TYPE_LABELS`
«Diario importado de Sage 200» / «Saldos importados de Sage 200».

| Tabla | Qué guarda | Clave |
| --- | --- | --- |
| `ledger_imports` | el lote: sociedad (`resolveLedgerScope`), `system sage200`, `kind`, `format`, `contentHash` (sha256 de las filas normalizadas **antes** del mapa), empresa Sage, ejercicio, `periodFrom` / `periodTo` (`YYYY-MM`), estado, contadores, `mappingJson`, totales `Decimal(14,2)`, `journalEntryIds[]`, `reversalJournalEntryIds[]`, `replacedById`, datos del reverso | índices `(org, kind, status, periodFrom, periodTo)` y `(org, contentHash)` |
| `ledger_import_entries` | un asiento Sage por (asiento, centro): clave Sage (empresa, ejercicio, periodo, asiento, canal), fecha, `propertyCode` (`SOC` a nivel sociedad), asiento Anfitorio producido, `status` (`draft` · `posted` · `skipped_native` · `skipped_existing` · `unmapped` · `unbalanced` · `error`), `entryKind`, líneas, debe / haber, asiento nativo con el que colisiona | única `(importId, empresa, ejercicio, periodo, asiento, propertyCode)` |
| `ledger_import_balances` | fila del sumas y saldos de Sage por ejercicio × periodo (`YYYY-MM` · `YYYY-Qn` · `YYYY` · `apertura`) × centro × cuenta Sage, con la cuenta PGC mapeada y apertura / periodo / saldo; se conserva aunque el lote se revierta | única `(importId, periodCode, propertyCode, sourceAccount)` |
| `ledger_account_maps` | mapa de cuentas: `action` (`map` · `map_by_rate` · `create` · `collapse` · `block`), cuenta destino (`null` solo en `block`), USALI de la subcuenta nueva, `carryCounterparty` | única `(org, system, sourceAccount)` |
| `ledger_analytics_maps` | mapa analítico: dimensión + código Sage → `propertyId` y / o `costCentreCode` USALI | única `(org, system, dimension, sourceCode)` |
| `ledger_third_parties` | tercero Sage: rol `customer` / `supplier`, subcuenta Sage, NIF normalizado, país, razón social, `supplierId` opcional | única `(org, system, role, sourceCode)`; índice `(org, taxId)` para el 347 |
| `ledger_reconciliations` | ejecución de la reconciliación: lote, rango, centro, sha256 del balance, `status` (`ok` · `differences` · `error`), cuentas comparadas, diferencias, `rowsJson`, `summaryJson` | índice `(org, periodFrom, periodTo, createdAt)` |

### 19.3 Contabilización: idempotencia en tres capas, numeración y reparto R4

**Idempotencia (patrón §18.5):** (1) `contentHash` vivo en la organización → 409
`LEDGER_IMPORT_DUPLICATE { importId, fileName, createdAt }`; solape por `(empresa, ejercicio,
periodo, asiento)` con un lote no revertido → 409 `LEDGER_IMPORT_OVERLAP { overlaps }`, salvo
`replace` (reversa **enteros** los lotes afectados y crea el nuevo en la misma transacción);
(2) por asiento, `findJournalEntryBySource` antes de contabilizar → fila `skipped_existing`
(no 409: permite reimportar un mes al que Sage añadió asientos); (3) el motor devuelve
`created: false` si la clave existe → 409 defensivo `LEDGER_IMPORT_ENTRY_EXISTS`. Tras un
reverso la clave queda `reversed` y se reutiliza con `#n`. El motor se llama con `{ tx }`
directo (el puente `treasury/ledger-bridge.ts` no transporta `entryKind`, `fiscalYearId` ni
`ignoreClosedPeriod`), por lo que el sufijo `#n` y `assertOriginalPeriodOpen` están
reimplementados en el servicio.

**Numeración:** `entryNumber` = MAX+1 por `(org, fiscalYearCode)` bajo advisory lock; **no se
conserva el número de Sage**: va en `reference` («Sage 200 · asiento 2026/1501 · periodo 9 ·
diario 0», recortado a 200) y en `sourceEntryNumber`. El lote ordena por `(fecha, asiento
Sage)` y contabiliza en secuencia en UNA transacción (`maxWait` 15 s, `timeout` 600 s, `SELECT
pg_advisory_xact_lock(hashtext('ledger_import:<org>'))` antes del lock de numeración:
orden constante, sin interbloqueos; ≤ 20.000 asientos y ≤ 500 líneas por asiento). Cualquier
409 del motor (`FISCAL_PERIOD_CLOSED`, `FISCAL_YEAR_CLOSED`, `WORK_CENTER_REQUIRED`,
`PROPERTY_NOT_FOUND`) hace rollback del lote entero; los `JournalEntryPosted` encolados por
asiento antes del commit no se retiran (herencia del lote de nómina); el evento de lote
`LEDGER_IMPORT_POSTED` se registra tras el commit.

**Mapa de cuentas (7 reglas, `ledger-import.mapping.ts`):** 1 fila explícita · 2 código sin
ceros finales ≡ cuenta postable (`6400000 → 640`) · 3 prefijo + serial ≤ 999 existente
(`4770021 → 477.21`) · 4 prefijo de tercero 430 / 431 / 435 / 400 / 401 / 410 / 411 →
`collapse` a `4300` / `400` / `410` con el tercero en la descripción · 5 `472` / `477` sin
serial + bloque IVA → `map_by_rate` (`477` + PorIva 10 → `477.10` apunte a apunte) · 6 regla 3
sin destino → `create` (USALI obligatorio en 6/7; alta por `prismaChartStore(tx).createAccounts`,
porque `createChartAccount` usa el `prisma` raíz y exige `UserContext`) · 7 resto → `block`
(400 `LEDGER_IMPORT_ACCOUNT_UNMAPPED { accounts }`). `ACCOUNT_CODE_PATTERN` está duplicado en
`ledger-import.mapping.ts` con un test que lo pina contra el del motor (:250).

**Reparto R4 (`WORK_CENTER_REQUIRED`):** un asiento Sage con líneas 6/7 de **un** centro → un
asiento con ese `propertyId`; de **varios** centros → **un asiento por (asiento Sage, centro)**
con las líneas 6/7 del centro y las líneas de balance repartidas en proporción a Σ|6/7|,
céntimos residuales al centro de mayor peso, `taxBase` con la misma proporción, `sourceId` con
sufijo `:<centro>`; cada parte cuadra por construcción y el consolidado es exacto al céntimo
(la reconciliación tolera 0,01 × nº de asientos repartidos en las cuentas de balance por
centro). Apuntes 6/7 sin analítica → `unassignedPolicy` `block` (defecto) · `office` ·
`property:<id>`; nunca `societyLevel`.

**Modo sombra (§5 del diseño):** el lote **excluye** los asientos de documentos nativos de
Anfitorio (`skipped_native`: factura por serie + número normalizados contra `seriesCode` +
`invoiceNumber` de las facturas de los centros de la organización —`Invoice` no lleva
`organizationId`—, y su cobro por documento o por importe + fecha ± 3 días contra
`payment/<paymentId>`); los asientos propios se conservan tal cual; el replay y la proyección
no cambian. Faranda: la preview avisa con `payrollCostImportsPosted[]` si Sage trae la nómina
real de 2026-01..08 (nada se reversa solo; §18.5 o `block` en 640 / 642 / 465 / 476).

### 19.4 Cierre importado y reapertura

Los periodos «Cierre ejercicio» y «Cierre Contabilidad» de Sage se importan con `entryKind
regularization` / `closing` (detección por periodo o por cuenta 129 + fin de ejercicio;
`closingDetected[]` en la preview) y la apertura del siguiente con `opening` (lote
`fiscal_years`); después `markFiscalYearClosedFromImport({ fiscalYearId, closingEntryId,
openingEntryId, netResult })` (`fiscal-year.service.ts`) deja el ejercicio `closed` **sin**
asientos propios. Corrección del diseño (§10.4): `reopenFiscalYear` **sí** alcanzaría esos
asientos (busca por `fiscalYearId` + `entryKind`, que `postJournalEntry` rellena en :648), así
que `POST /accounting/fiscal-years/:id/reopen` responde **409 `FISCAL_YEAR_CLOSED_FROM_IMPORT {
fiscalYearId, importId }`** y la regla es **reabrir = revertir el lote**
(`POST /accounting/ledger-imports/:id/reverse` / `--reverse`): el reverso devuelve el ejercicio a
`open` sin `year-reopen:*`. Como el reverso exige el periodo del asiento original abierto
(`assertOriginalPeriodOpen`), el orden es reabrir el periodo 12 → revertir → reimportar →
cerrar. Ejercicios sin cierre importado siguen `open` con todos sus periodos `closed`; el
cierre de periodo tras cada reconciliación `ok` protege el mes de la proyección y el replay.

### 19.5 Reconciliación (`ledger-reconciliation.service.ts`)

Sumas y saldos nivel 0 de Sage del rango (por centro solo con la «Hoja adicional
canales/delegaciones») frente a `aggregateAccountBalances` por cuenta destino tras el mapa, con
la **misma regla de lectura que los estados** (`status ≠ draft`, sin parejas de reversión,
`movements` sin `regularization` / `closing` / `opening`, `balance_at` en `to` para grupos
1-5). Tolerancias (`LEDGER_RECONCILIATION_TOLERANCES`): **0,00** consolidado y cuentas solo
importadas; **0,01 × asientos repartidos** en cuentas de balance por centro; **0,01 por tipo**
de IVA. Clasificación: `amount_diff` · `native_only` (esperado en `4300`, `705.x`, `477.x`,
`57x` mientras Anfitorio emita, y en `28x` / `68x` por `payables/ledger-port.ts`) ·
`missing_in_ledger` (asientos del lote `unmapped` / `error` / `skipped_native`) · `vat_diff`.
Se lanza **tras el commit** del lote (`aggregateAccountBalances` lee con el `prisma` raíz),
por HTTP (`POST /accounting/ledger-imports/reconciliation`), por CLI (`--reconcile --balance`)
o adjuntando el balance al lote `journal`; resultado en `ledger_reconciliations` con `rows[]`,
`summary` (`criterion` en español) y CSV (`GET /accounting/ledger-imports/reconciliation/:id/csv`). A fin de año no
coincide con la pantalla «Sumas y saldos» (`buildTrialBalance` no excluye `entryKind`):
runbook nuevo §6. Cadencia mensual: importar → reconciliar → si `ok`, cerrar el periodo; relevo
tras dos cierres mensuales `ok` y un trimestre declarado con los libros de Anfitorio.

### 19.6 Rutas, CLI, front y códigos

Rutas y claves efectivas: §13, partial `accounting (ledger-import)` (15 entradas; lectura con
`accounting.reports.read` por el remap, incluida la plantilla; el partial vive a profundidad 1
en `modules/accounting/` porque `tests/api-route-permissions-contract.test.mjs` solo lee
`modules/<módulo>/*route-permissions.partial.ts`). Cuerpos `.strict()` en español
(`schemas/ledger-import.schemas.ts`); `contentBase64` ≤ 28 MiB de caracteres con `bodyLimit`
30 MiB en las tres rutas de carga (preview, lote, reconciliación); `allowClosed` por HTTP →
400 `VALIDATION_ERROR`. CLI: §14 comando 6 (usuario de sistema `usr_system_sage200_import`,
`createdBy cli:import-sage200`). Front: pestaña «Importar desde Sage 200» de Finanzas ›
Contabilidad (`/finanzas/contabilidad/importar-sage200`; `Sage200ImportScreen.tsx`, fila nueva
de orden 6 en el CSV de navegación tras `GestoriaExportScreen`; cero `style={}`), con tres
vistas —Importar (Fichero · Cuentas · Analítica · Revisión · Resultado), Reconciliación y
Lotes—, política de ámbito `entity_default`: el centro de la reconciliación se elige en el
selector de ámbito único de la cabecera. Códigos (`LEDGER_IMPORT_ERROR_CODES`, siempre en
`details.code`): 400 `VALIDATION_ERROR`, `LEDGER_IMPORT_INVALID { errors }`,
`LEDGER_IMPORT_FORMAT_UNKNOWN`, `LEDGER_IMPORT_XML_UNSUPPORTED { blocks }`,
`LEDGER_IMPORT_KIND_MISMATCH`, `LEDGER_IMPORT_EMPTY`, `LEDGER_IMPORT_TOO_LARGE { bytes, max }`,
`LEDGER_IMPORT_TOO_MANY_ROWS { rows, max }`, `LEDGER_IMPORT_TOO_MANY_ENTRIES { entries, max }`,
`LEDGER_IMPORT_COMPANY_MISMATCH`, `LEDGER_IMPORT_ACCOUNT_UNMAPPED { accounts }`,
`LEDGER_IMPORT_ACCOUNT_CODE_INVALID { accountCode }`, `LEDGER_IMPORT_ANALYTICS_UNMAPPED {
codes }`, `LEDGER_IMPORT_CENTRE_REQUIRED { entries }`, `LEDGER_IMPORT_UNBALANCED { entries }`,
`LEDGER_IMPORT_YEAR_CODE_INVALID { code }`, `LEDGER_IMPORT_MAP_INVALID { errors }`; 409
`LEDGER_IMPORT_DUPLICATE`, `LEDGER_IMPORT_OVERLAP`, `LEDGER_IMPORT_ENTRY_EXISTS`,
`LEDGER_IMPORT_ALREADY_POSTED`, `LEDGER_IMPORT_REVERSED`, `LEDGER_IMPORT_NOT_POSTED`,
`LEDGER_IMPORT_VAT_SETTINGS_MISSING`, `FISCAL_YEAR_CLOSED_FROM_IMPORT { fiscalYearId,
importId }`; 404 opacos `LEDGER_IMPORT_NOT_FOUND`, `LEDGER_RECONCILIATION_NOT_FOUND`; del
motor `ACCOUNT_NOT_FOUND`, `ACCOUNT_NOT_POSTABLE`, `WORK_CENTER_REQUIRED`,
`PROPERTY_NOT_FOUND`, `FISCAL_PERIOD_CLOSED`, `FISCAL_YEAR_CLOSED`, `JOURNAL_UNBALANCED`.
Decisiones fijadas por el plan: el importador **nunca crea** la fila `vat_settings`
(`getVatSettings` devuelve defaults sin fila, así que la ausencia se detecta con
`vatSettings.findUnique` → 409 `LEDGER_IMPORT_VAT_SETTINGS_MISSING` hasta que César decida);
`Supplier` solo con `options.createSuppliers` (sin unique `(org, taxId)` y con la comprobación
de NIF privada: `findFirst` + create / update); las filas de libros se escriben con
`toVatBookCreateInput` (el antiguo `toCreateInput` de `vat-books.service.ts`, exportado);
las hojas AEAT se leen con `readXlsxTable` localizando la cabecera por contenido; `parseXml`
con límites explícitos.

### 19.7 Puertas y estado

Puertas de la tanda: `corepack pnpm run typecheck:all` (15/15 + 1 SKIP) · `corepack pnpm
--filter @hotelos/api test` · unitarios front · `node --test tests/*.test.mjs` (incluye
`sage200-schema-contract`, `finanzas-schema-contract`, `api-route-permissions-contract`,
`legal-identity-readers-contract`, `cocoa-22-contract` con el inventario regenerado en L4) ·
integración `tests/integration/{ledger-import,ledger-import-routes}.test.mts` sobre una
organización aislada · `db:migrate:status` 12/12 · `db:drift:check` 0 · `build-nav-tree
--check` · `check-discoverability`. Estado de Faranda **antes** de la primera carga (BD local,
2026-09-17, tras la Tanda 7b; invariantes que la importación no debe alterar): **112 asientos**
(22 `invoice` · 8 `invoice_cancellation` · 4 `invoice_rectification` · 23 `payment` · 4
`payment_refund` · 48 `payroll_cost_import` · 2 `pms_shadow_revenue` · 1 `reversal`) / **599
líneas** / Σ debe = Σ haber = **2.456.852,66** · 25 facturas · 33 envíos VeriFactu · 22
`cost_centers` · 0 `fiscal_years` · 0 `vat_book_entries` · 0 `suppliers` · 0 `vat_settings`
(SQL de comprobación en el runbook nuevo §8). Cifras de la demo sintética y resultado del
apply único: `docs/audits/TANDA-7C-SAGE200-2026-09-17.md` (L6).

### 19.8 Lo que solo puede aportar César

Las siete necesidades del diseño §9 (runbook nuevo §1): exportaciones reales de un mes
(Diario con desglose analítico, Sumas y saldos nivel 0 con «Comparativo periodo acumulado» y
«Hoja adicional canales/delegaciones», Plan de cuentas con NIF, Libro Registro de IVA formato
AEAT, XML opcional) para fijar cabeceras y parser; versión y edición de Sage; dimensión
analítica del hotel y códigos, numeración por canal; longitud de cuenta y convención de
subcuentas; acceso SQL de lectura (cadencia diaria); ejercicios a cargar y fecha de relevo;
decisiones abiertas (`pgc_variant`, `VatSettings`, SII, facturas sandbox de RA). Decisiones
por defecto de esta tanda (diseño §10.1 y runbook nuevo §10): colapso de terceros a `4300` /
`400` / `410`, dimensión `delegacion` y política `block`, reparto proporcional a Σ|6/7|,
nómina real frente a coste importado solo avisada, exclusión de las facturas de RA emitidas en
Anfitorio, saldos para los ejercicios sin diario, relevo tras dos cierres `ok` + un trimestre
declarado, `vat_settings` nunca creada por el importador.
