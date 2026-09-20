# Runbook · Activo inmobiliario (Tanda ACT)

Fuente: diseño [`docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md`](../design/ASSET-MANAGEMENT-INMOBILIARIO.md) (§4 modelo, §5 flujos y
alertas, §5.1 máquinas de estado, §6 contabilidad, §7 API y permisos con la nota «Estado tras la implementación», §8 front,
§9 lotes con la misma nota). Código: `apps/api/src/modules/real-estate/*` (agregador `real-estate.register.ts` llamado una vez
desde `server.ts`; ficha, unidades, cargas y valoraciones `real-estate.service.ts` + `core.routes.ts` +
`core-route-permissions.partial.ts`; tenencia `tenure.service.ts`; tributos y asiento propuesto `property-tax.service.ts` +
`tax-calendar.ts` + `taxes.routes.ts` + `taxes-route-permissions.partial.ts`; documentación con fichero `documents.service.ts` +
`documents.routes.ts` + `documents-route-permissions.partial.ts`; obras y capitalización `works.service.ts` +
`capex-execution.service.ts` + `works.routes.ts` + `works-route-permissions.partial.ts`; inspecciones, pólizas y alertas
`inspections.service.ts`, `insurances.service.ts`, `alerts.service.ts` + `alerts.pure.ts` + `inspections.routes.ts` +
`inspections-route-permissions.partial.ts`; vista de grupo, calendario y CSV `group.service.ts`, `calendar.service.ts`,
`export.service.ts` + `group.routes.ts` + `group-route-permissions.partial.ts`; puros `state-machines.ts`, `vigencias.ts`,
`cadastral.ts`, `errors.ts`; agregador de permisos `route-permissions.partial.ts`, solo spreads), esquemas zod `.strict()`
`apps/api/src/schemas/real-estate.schemas.ts`, contrato compartido `packages/shared/src/real-estate-types.ts`, schema y
migración `packages/database/prisma/schema.prisma` + `migrations/20260920170000_activo_inmobiliario/migration.sql`, front
`apps/admin-web/src/screens/realEstate/*` (+ `real-estate-helpers.ts`) y `services/realEstateApi.ts`, tenant de prueba
`packages/database/prisma/seed-real-estate.ts` (`db:seed:real-estate`). Rutas, cuerpos y permisos:
`docs/api-contracts.md` «Activo inmobiliario (Tanda ACT · 2026-09-20)».

**Todos los datos de este documento son ficticios**: tenant `org_act`, sociedad «ACT Pruebas Inmobiliarias SL», usuarios
`*@act.test`, referencia catastral con la forma real pero inventada. Nunca se pega aquí una escritura, un recibo real ni el
nombre de una persona; la organización real no aparece ni por nombre ni por id.

Estado 2026-09-20: escrito en el worktree de la Tanda ACT (rama `tanda-act`) con los lotes L0a…L7 y F0…F3 en el árbol; el
contrato documental `tests/activo-inmobiliario-docs-contract.test.mjs` ata §6.1 (rutas), §7 (códigos), §2 (modelos), §3
(máquinas) y §8 (alertas) al código. Marca del producto: ehotelOS.

## 1 · Qué es y decisiones

- **Hace**: una **ficha del inmueble por centro** (`RealEstateAsset`, `@@unique([propertyId])`) con sus unidades registrales /
  catastrales y cargas, valoraciones, tenencia (propiedad, arrendamiento de local o de industria, gestión, franquicia,
  usufructo, concesión), tributos locales con recibos y calendario, documentación con vigencia y versiones, inspecciones
  obligatorias con acta, pólizas, obras (`CapexProject` ampliado) y un motor de alertas; vista de grupo con totales y CSV.
- **Claves (4, ya creadas por la Tanda 8a; ninguna nueva en ACT)** en `packages/shared/src/permissions.ts` (versión de
  plantillas `ROLE_TEMPLATE_VERSION = 4`): `real_estate.read` (toda lectura, riesgo medium), `real_estate.manage` (ficha,
  unidades, cargas, valoraciones, tenencia, inspecciones, pólizas, retirar documentos y `legalHold`), `real_estate.documents.manage`
  (subir, versionar y editar metadatos de documentos) y `property_tax.manage` (tributos, recibos y el asiento propuesto). El
  diseño §7 preveía seis (`real_estate.documents.read/upload`, `real_estate.taxes.manage`, `real_estate.export`): no existen; la
  exportación va con `real_estate.read`. Obras: `capex.create` (datos de obra y transiciones) y `assets.manage` (capitalizar),
  claves existentes; el manifiesto de capex (`GET /properties/:propertyId/capex` → `capex.read`, `POST /capex-projects`,
  `PATCH /capex-projects/:id`, `POST …/items` → `capex.create`) ya venía remapeado por la Tanda 8a. Plantillas que las llevan
  (`ROLE_PERMISSION_MAP`): `asset_manager` las cuatro (+ `capex.read/create`, `assets.manage`); `controller` y `compliance`
  read + manage + property_tax.manage; `manager`, `maintenance_manager` y `admin_clerk` read + documents.manage (+ capex);
  `accountant` read + `assets.manage` + `accounting.journal.post`; `operations_director`, `general_manager`, `owner` y
  `auditor` solo read (owner y general_manager con `asset.capex.approve`); `receptionist`, `housekeeper`, `fnb`, `sales`,
  `revenue`, `payroll_hr`: ninguna (GET → 403 «requiere: real_estate.read», verificado con `recepcion@act.test`).
- **Almacén de ficheros = el de la Tanda T9**, nunca otro (§5): `getDocumentStorage()` (`inline | disk | s3` según
  `DOCUMENT_STORAGE_KIND`), clave `org/<org>/prop/<prop>/doc/<red_…>/<sha256>.<ext>` con el id del `RealEstateDocument`
  (prefijo `red`) como segmento `doc`; sin `DocumentFile` ni `IncomingDocument`.
- **Tributos = recibo manual + asiento propuesto en borrador** (§4): el módulo genera los recibos `previsto` del ejercicio,
  la administración los pasa a `recibido | domiciliado | pagado` y «Proponer asiento» crea un `JournalEntry` **`draft`**
  (`createJournalEntryDraft`, `sourceType property_tax_receipt`); lo contabiliza un contable con
  `POST /journal-entries/:id/post` (`accounting.journal.post` + `ai.high_risk.confirm`). Nunca se llama a `postJournalEntry`
  ni a `createExpense`; nunca se contabiliza solo.
- **Valoraciones sin asiento**: `RealEstateValuation` es un registro manual (tasación ECO 805, RICS, interna, notificación
  catastral, seguro) que solo refresca la caché `lastValuationValue / lastValuationAt` de la ficha y `valuePerRoom`.
- **Capex con ejecución leída del diario por centro**: `executedAmountLedger` = Σ (debe − haber) de las líneas `posted` de
  asientos `normal` del centro cuya cuenta empieza por `executionAccountPrefixes` (por defecto
  `211, 212, 213, 215, 216, 217, 219, 231, 232`); en la contabilidad importada de Sage la obra vive en las **21x** con el
  centro en las cifras 5-6 y las cuentas **23x** están vacías, así que la fuente real es 21x. Sin líneas, `executedAmountItems`
  (Σ `CapexItem.actualCost`). **Capitalizar = fila del registro de inmovilizado** (`createFixedAsset`, solo registro +
  auditoría) con coste = ejecución + ICIO (`capitalizationCost`) en la cuenta **212** si `workKind = eficiencia_energetica` y **211** en el
  resto (`capitalizationAccountFor`), `acquisitionDate` = fin de obra (`acquisitionDate` del cuerpo si llega; si no, `targetEndDate`
  ya cumplido; si no, hoy — `capitalizationDateFor`, ACT-REV-12); no asienta (los 21x ya vienen de Sage o de facturas `investmentGood`).
- **No hace**: OCR ni «Leer fechas» (sin proveedor de IA en el módulo), resumen diario ni scheduler (`REAL_ESTATE_DIGEST_*` no
  existe: las alertas se calculan en cada lectura), tesorería (ni conciliación del cargo domiciliado ni previsión de pagos),
  fila FF&E en USALI, `SafetyCheck` / `ComplianceTask`, consulta al Catastro ni tasadora externa, job de retención propio
  (`retentionUntil` se guarda pero no se ejecuta) ni segundo almacén.

## 2 · Modelos (migración `20260920170000_activo_inmobiliario`)

Migración única y aditiva (SQL verbatim de `prisma migrate diff`; posterior a `20260920160000_checkin_pago_en_recepcion`):
10 `CREATE TABLE`, 12 `ADD COLUMN` en `capex_projects`, 12 índices + 4 únicos, 9 FK internas `ON DELETE CASCADE` hacia
`real_estate_assets` (y `charges → units`, `receipts → taxes`), **0 enums nuevos** (catálogos `String` documentados con `///`
y fijados por los `as const` de `packages/shared/src/real-estate-types.ts`; `tests/finanzas-schema-contract` pina los enums
existentes), 0 DROP, 0 backfill. Rollback en la cabecera del fichero (hijos antes que padres). Todo importe `Decimal(14,2)`
(superficies `Decimal(12,2)`, `ratePct` `Decimal(8,4)`), días `@db.Date`, ids `cuid()`, `updatedAt @default(now()) @updatedAt`.

| Modelo (`@@map`) | Columnas | Reglas |
|---|---|---|
| **`RealEstateAsset`** (`real_estate_assets`) | `organizationId`, `legalEntityId?`, `propertyId`, `name`, `yearBuilt?`, `yearLastRefurbished?`, `builtSurfaceM2?`, `plotSurfaceM2?`, `floorsAbove?`, `floorsBelow?`, `roomsCount?`, `protectionLevel` (`none · catalogado · bic`), `energyRating?` (A-G) + `energyCertValidUntil?`, `cadastralValueTotal?`, `cadastralValueYear?`, `referenceValue?`, `lastValuationValue?` + `lastValuationAt?` (caché), `currentTenureKind?` (caché), `status` (`active · sold · closed`), `notes?` | `@@unique([propertyId])`, `@@index([organizationId, status])`; el alta crea la primera unidad (prellenada con `Property.cadastralReference / surfaceM2`) y la tenencia `propiedad` en borrador |
| **`RealEstateUnit`** (`real_estate_units`) | `organizationId`, `assetId`, `kind` (`finca_registral · referencia_catastral · local`), `registryOffice?`, `registryFincaNumber?`, `registryTomo?`, `registryLibro?`, `registryFolio?`, `cru?`, `cadastralReference?` (20 `[0-9A-Z]`, `cadastral.ts`), `useCode?`, `surfaceM2?`, `cadastralValueLand?`, `cadastralValueBuilding?`, `titleKind` (`pleno_dominio · usufructo · superficie · concesion · arrendamiento`), `titleHolderTaxId?`, `titleHolderName?`, `titleDeedDate?`, `notary?`, `fixedAssetId?` (210/211, sin FK) | `@@unique([organizationId, cadastralReference])` (NULL no colisiona), `@@index([assetId])`; duplicado → 409 `UNIQUE_VIOLATION` genérico |
| **`RealEstateCharge`** (`real_estate_charges`) | `unitId`, `kind` (`hipoteca · embargo · servidumbre · afeccion_fiscal · opcion · arrendamiento_inscrito · otra`), `holderName?`, `holderTaxId?`, `amount?`, `outstandingAmount?`, `registeredAt?`, `expiresAt?`, `cancelledAt?`, `documentId?`, `note?` | `@@index([unitId, cancelledAt])`; sin máquina de estados (se edita siempre) |
| **`RealEstateValuation`** (`real_estate_valuations`) | `assetId`, `kind` (`eco_805 · rics · interna · notificacion_catastral · seguro`), `purpose?` (`hipotecaria · contable · venta · seguro · ibi`), `valuedAt`, `value`, `valuePerRoom?`, `capRatePct?`, `method?`, `appraiser?`, `documentId?` | `@@index([assetId, valuedAt])`; al crear refresca la caché de la ficha con la más reciente por `valuedAt`; sin asiento |
| **`RealEstateTenure`** (`real_estate_tenures`) | `assetId`, `kind` (`propiedad · arrendamiento_local · arrendamiento_industria · gestion · franquicia · usufructo · concesion`), `counterpartyName?`, `counterpartyTaxId?`, `counterpartyNonResident`, `startDate`, `endDate?`, `noticeMonths?`, `renewal` (`tacita · expresa · ninguna`), `rentKind?`, `rentMonthly?`, `rentVariablePct?` + `rentVariableBase?` (`gor · gop`), `rentReviewIndex?` (`ipc · pct_fijo · ninguno`) + `rentReviewMonth?`, `depositAmount?`, `vatApplies`, `withholdingApplies` + `withholdingRatePct?`, `ibiPayer`, `insurancePayer`, `capexResponsibility`, `ffeReservePct?`, `brandName?`, `status` (`borrador · vigente · vencido · resuelto`), `documentId?`, `notes?` | `@@index([assetId, status])`; una sola `vigente` por ficha (409 `TENURE_ALREADY_ACTIVE`); `vencido` se deriva en el DTO (`endDate` < hoy); sin `baseFeePct / incentiveFeePct / pipDueAt` del diseño |
| **`PropertyTax`** (`property_taxes`) | `organizationId`, `propertyId`, `assetId`, `unitId?`, `kind` (`ibi · iae · residuos · vados · terrazas · ocupacion_via_publica · icio · plusvalia · otro_local`), `taxpayer` (`sociedad · propietario_tercero · arrendatario`), `authorityName`, `ineMunicipalityCode?`, `fiscalReference?`, `taxBase?`, `ratePct?`, `expectedAnnualAmount?`, `periodicity` (`anual · semestral · trimestral · mensual · unico`), `voluntaryFrom? / voluntaryTo?` (`MM-DD`), `directDebit`, `directDebitBonusPct?`, `installmentsJson?` (`[{ label, dueFrom, dueTo, pct }]`, `MM-DD`), `accountCode` (`631`; `231` para ICIO capitalizable), `capitalizable`, `legalBasis?`, `status` (`activo · baja`) | `@@index([propertyId, kind, status])`; el asiento solo se propone con `taxpayer = sociedad`; generar previstos de un tributo `baja` → 409 `PROPERTY_TAX_INACTIVE`; el comentario `///` del schema aún dice `dueOn` (deuda cosmética L0b) |
| **`PropertyTaxReceipt`** (`property_tax_receipts`) | `taxId`, `fiscalYear`, `period` (`anual · 1/2 · PAC-03…`), `issuedAt?`, `dueFrom?`, `dueTo?`, `amount`, `surchargeAmount`, `status` (`previsto · recibido · domiciliado · pagado · recurrido`), `paidAt?`, `paidWith?` (`cash · card · bank`), `journalEntryId?` (asiento propuesto o enlazado; sin FK), `capexProjectId?` (ICIO), `documentId?`, `appealRef?`, `notes?` | `@@unique([taxId, fiscalYear, period])` (409 `RECEIPT_ALREADY_EXISTS`), `@@index([journalEntryId])`; `overdue` (el «vencido» del diseño) se deriva: sin pagar y `dueTo` < hoy; el diseño decía `expenseId`, la implementación enlaza el `JournalEntry` |
| **`RealEstateDocument`** (`real_estate_documents`) | `organizationId`, `propertyId`, `assetId`, `category` (10 valores), `kind` (26 valores), `title`, `issuerName?`, `issueDate?`, `validFrom?`, `validUntil?`, `renewalDays?`, `version`, `supersedesId?`, `supersededById?`, `cdeState` (`wip · compartido · publicado · archivado`), `confidentiality` (`interno · solo_propiedad`), `linkedEntityType? / linkedEntityId?`, `complianceRequirementCode?`, `fileName?`, `mimeType?`, `sizeBytes?`, `sha256?`, `storageKind` (`inline · disk · s3`), `storageKey?` (`@unique`), `inline?` (base64 solo en `inline`), `encrypted`, `uploadedBy?`, `retentionUntil?`, `legalHold`, `deletedAt?` | `@@index([assetId, category, validUntil])`, `@@index([propertyId, deletedAt])`; `status` derivado (`vigente · caduca_pronto · caducado · sin_fecha · sustituido`); retirar = `deletedAt` (409 `LEGAL_HOLD`); en vez de `fileId / complianceItemId / pageCount` del diseño |
| **`RealEstateInspection`** (`real_estate_inspections`) | `organizationId`, `propertyId`, `assetId`, `kind` (`oca_bt · oca_ascensor · oca_pci · rite · gas · equipos_presion · legionella · piscina · iee_ite · cee · simulacro · otra`), `legalBasis?`, `periodicityMonths?`, `installationRef?`, `technicalAssetId?`, `providerName?`, `supplierId?`, `scheduledAt?`, `performedAt?`, `result?` (`favorable · condicionada · negativa · pendiente`), `defectsJson?` (`[{ severity, text, dueAt, fixedAt }]`), `correctionDueAt?`, `correctedAt?`, `nextDueAt?`, `documentId?`, `complianceRequirementCode?`, `status` (`programada · realizada · con_defectos · cerrada`), `notes?` | `@@index([assetId, kind, nextDueAt])`; `dueState` derivado (`sin_fecha · en_plazo · proxima · vencida`, aviso 90 días); acta favorable o subsanación completa crean la sucesora `programada`; sin `safetyCheckId` |
| **`RealEstateInsurance`** (`real_estate_insurances`) | `organizationId`, `propertyId`, `assetId`, `kind` (`rc · multirriesgo · perdida_beneficios · decenal · todo_riesgo_construccion · otro`), `insurerName`, `policyNumber`, `brokerName?`, `policyholder` (`sociedad · propietario_tercero`), `insuredSum?`, `deductible?`, `premiumAnnual?`, `validFrom`, `validUntil`, `autoRenew`, `noticeDays` (60), `mandatoryBasis?`, `documentId?`, `status` (`vigente · vencida · cancelada`), `notes?` | `@@index([assetId, validUntil])`; `vencida` se deriva en cada lectura (`validUntil` < hoy; 400 si el cuerpo la envía); la prima (625) sigue en payables |
| **`CapexProject`** (`capex_projects`, existente) | + `realEstateAssetId?`, `workKind?` (`reforma · ampliacion · mantenimiento_mayor · pip · eficiencia_energetica · accesibilidad`), `licenceRequired` (false), `licenceDocumentId?`, `licenceGrantedAt?`, `icioAmount?`, `projectDocumentId?`, `completionDocumentId?`, `executionAccountPrefixes?` («211,212»), `executedAmountLedger?` (caché al leer), `capitalizedFixedAssetId?`, `capitalizedAt?` (12 columnas, todas opcionales) | `@@index([realEstateAssetId, status])`; sin `roomsOutOfOrderJson / capitalizedAccountCode / completionCertificateDocumentId` del diseño; la aprobación (`asset.capex.approve`) sigue en `modules/assets/assets.service.ts` |

## 3 · Máquinas de estado (`state-machines.ts`, tablas `de → [a…]`)

`canTransition(machine, from, to)` y `assertTransition` (409 tipado con `details { machine, from, to, allowed }`; código por
defecto `INVALID_TRANSITION_CODES`: TENURE → `TENURE_INVALID_TRANSITION`, RECEIPT → `RECEIPT_NOT_PAYABLE`, INSPECTION →
`INSPECTION_INVALID_TRANSITION`, CAPEX_WORK → `CAPEX_NOT_COMPLETED`). Los efectos (caché de tenencia, asiento, sucesora de la
inspección, capitalización) los aplican los servicios, no las tablas. «—» = estado final.

**Tenencia** (`TENURE_TRANSITIONS`; «Activar» = `PATCH { action: "activar" }`, «Resolver» = `{ action: "resolver" }`; campos
editables solo en `borrador` o `vigente` con plazo abierto — el servicio mira el estado DERIVADO (`deriveTenureStatus`): una
vigente con `endDate` pasado es `vencido` y responde 409 `TENURE_INVALID_TRANSITION` (ACT-REV-14); `vencido` persistido solo por
datos importados. Al activar, o al cambiar `kind` / `ibiPayer` de la vigente, se proponen los `PropertyTax.taxpayer` de los IBI
activos de la ficha (`ibiTaxpayerFor`, diseño §5.1, ACT-REV-08): `propiedad` + `ibiPayer propietario` → `sociedad`; `propiedad` +
`arrendatario` → `arrendatario`; inmueble de un tercero (arrendamiento, gestión, franquicia, usufructo, concesión) →
`propietario_tercero` (solo calendario; la repercusión llega por factura del arrendador). Auditado `PROPERTY_TAX_UPDATED`
`source: "tenure"`):

| Desde | Hacia |
|---|---|
| `borrador` | `vigente` |
| `vigente` | `resuelto`, `vencido` |
| `vencido` | — |
| `resuelto` | — |

**Recibo** (`RECEIPT_TRANSITIONS`; «vencido» es derivado `overdue` (sin pagar: ni `pagado` ni `paidAt`); `recurrido` no impide
pagar y «Recurrir» vale también desde `pagado` conservando `paidAt` / `paidWith` (ACT-REV-10); pagar sin `paidWith` → `bank`,
sin `paidAt` → hoy; con asiento enlazado los importes y el pago quedan congelados, 409 `RECEIPT_ENTRY_EXISTS`, y el paso a
`pagado` regenera el borrador propio o propone el asiento de pago (§4)):

| Desde | Hacia |
|---|---|
| `previsto` | `recibido`, `domiciliado`, `pagado`, `recurrido` |
| `recibido` | `pagado`, `recurrido` |
| `domiciliado` | `pagado`, `recurrido` |
| `recurrido` | `pagado` |
| `pagado` | `recurrido` |

**Documento** (sin tabla en `state-machines.ts`: el ciclo es por versiones y la vigencia se deriva en `vigencias.ts`
`deriveDocumentStatus`): subir (`POST …/documents`, con o sin fichero) → «Nueva versión» (`POST …/:documentId/versions`, exige
`file`; crea la fila `version + 1` con `supersedesId`, hereda los metadatos que el cuerpo no cambia y deja la anterior
`sustituido` por `supersededById`; 409 `DOCUMENT_SUPERSEDED` si se versiona una que ya tiene sucesora) → «Retirar» (`DELETE`,
borrado lógico `deletedAt`; 409 `LEGAL_HOLD`; no reactiva la versión anterior). Vigencia derivada: `sustituido` (tiene
`supersededById`) · `sin_fecha` (sin `validUntil`) · `caducado` (`validUntil` < hoy) · `caduca_pronto` (≤ `expiringSoonDays`
del perfil de cumplimiento, 30 por defecto; 90 en `inspecciones` y `seguros`) · `vigente`.

**Inspección** (`INSPECTION_TRANSITIONS`; «Registrar acta» = `PATCH { performedAt, result }`: `favorable` → `realizada`,
`condicionada | negativa` → `con_defectos`, `pendiente` deja `programada`; cerrar exige todos los defectos con `fixedAt` o
`correctedAt`; el acta favorable y la subsanación completa crean la sucesora `programada` con `scheduledAt = nextDueAt`):

| Desde | Hacia |
|---|---|
| `programada` | `realizada`, `con_defectos` |
| `realizada` | `cerrada` |
| `con_defectos` | `cerrada` |
| `cerrada` | — |

**Obra** (`CAPEX_WORK_TRANSITIONS`; `proposed → approved` con `POST /capex-projects/:id/approve` (`asset.capex.approve`; motor
existente `updateCapexProject` con separación de funciones; ACT-REV-05); el `PATCH /capex-projects/:id` heredado (`capex.create`)
también respeta la tabla (409 `CAPEX_NOT_COMPLETED` fuera de ella), no cambia de estado una obra capitalizada (409
`CAPEX_ALREADY_CAPITALIZED`) y exige licencia para `in_progress` (ACT-REV-02); `PATCH /capex-projects/:id/work` solo admite
`status in_progress | completed` (`cancelled` → 400);
`in_progress` exige `licenceDocumentId` si `licenceRequired` → 409 `LICENCE_REQUIRED`, transaccional: no escribe ningún campo
del mismo cuerpo; `completed` es final):

| Desde | Hacia |
|---|---|
| `proposed` | `approved`, `cancelled` |
| `approved` | `in_progress`, `cancelled` |
| `in_progress` | `completed` |
| `completed` | — |
| `cancelled` | — |

## 4 · Asiento propuesto del recibo (`property-tax.service.ts` · `buildReceiptEntryProposal`)

`POST /properties/:propertyId/real-estate/receipts/:receiptId/propose-entry` (`property_tax.manage`, critical) → 201 con el
recibo y `journalEntryId` / `journalEntryStatus: "draft"`. Puro y auditado (`RECEIPT_ENTRY_PROPOSED` con las líneas):

| Línea | Cuenta | Importe | Concepto |
|---|---|---|---|
| Debe | `tax.accountCode`: **631** «Otros tributos» (`DEFAULT_TAX_ACCOUNT`); **231** «Construcciones en curso» (`CAPITALIZABLE_TAX_ACCOUNT`) para el ICIO `capitalizable` aunque el tributo conserve el 631 por defecto (`receiptDebitAccount`) | `amount + surchargeAmount` | «IBI 2026 (PAC-01) · cuota 9080.00 [+ recargo …]» |
| Haber | recibo `pagado`: **570** (`cash`), **5721** (`card`), **572** (`bank`, y por defecto) — `RECEIPT_COUNTER_ACCOUNTS`, copia de `EXPENSE_COUNTER_ACCOUNTS`; recibo `recibido | domiciliado | recurrido`: **475** «Hacienda Pública, acreedora por conceptos fiscales» (`TAX_LIABILITY_ACCOUNT`) | el mismo | «Pago IBI 2026 (PAC-01) (15/06/2026)» o «… pendiente de pago» |

- `entryDate = paidAt ?? dueTo ?? hoy`; `description` «`<kind> <ejercicio> (<periodo>)` · `<Property.code>` · `<fiscalReference>`»;
  `reference = fiscalReference`; el centro va en `propertyId` del asiento; `sourceType property_tax_receipt`, `sourceId` = recibo.
- Solo con `taxpayer = sociedad` (409 `TAXPAYER_NOT_ENTITY`), nunca sobre un `previsto` ni sin importe (409 `RECEIPT_NOT_PAYABLE`),
  una sola vez (409 `RECEIPT_ENTRY_EXISTS`; carrera entre dos propuestas: la segunda borra su propio borrador y responde 409).
  `recurrido` con importe sí se propone (la deuda existe hasta que se resuelva el recurso, H 475).
- El motor (`createJournalEntryDraft`) valida cuadre y cuentas, exige centro y ejercicio abierto: el 409 **`FISCAL_YEAR_CLOSED`**
  se propaga tal cual. Para ejercicios cerrados (2025 y anteriores, importados de Sage) no se propone: se **enlaza a mano** con
  `PATCH …/receipts/:receiptId { journalEntryId }` (acepta un asiento `posted` de la misma organización y centro; auditado
  `RECEIPT_ENTRY_LINKED source manual`); `journalEntryId: null` desenlaza: si el enlazado es el borrador PROPIO del recibo
  (`sourceType property_tax_receipt` + `sourceId` = recibo) se descarta (líneas + cabecera; `discardedDraftId` en la auditoría) y
  si es un asiento propio ya `posted` responde 409 `RECEIPT_ENTRY_EXISTS` (primero la anulación, `POST …/reverse`; ACT-REV-03).
- `propose-entry` rechaza además cualquier asiento no anulado del mismo recibo por (organización, `sourceType`, `sourceId`)
  (409 `RECEIPT_ENTRY_EXISTS` con `details.journalEntryId` / `journalEntryStatus`): un recibo nunca genera dos veces el 631.
- Pasar a `pagado` con asiento propio enlazado (ACT-REV-04): borrador → se REGENERA con la contrapartida de tesorería
  (`RECEIPT_ENTRY_LINKED source regenerated`); contabilizado con H 475 → se propone el **asiento de pago** D 475 / H 570 · 5721 ·
  572 (`buildReceiptPaymentProposal`, `sourceType property_tax_receipt_payment`, mismo `sourceId`; auditado
  `RECEIPT_PAYMENT_ENTRY_PROPOSED`; el recibo conserva el enlace al asiento de devengo). El borrador que acompaña al cambio se crea
  antes de la transacción (un 409 del motor deja el recibo intacto) y se descarta si la transacción falla.
- Contabilizar: `POST /journal-entries/:id/post` (`accounting.journal.post` + `ai.high_risk.confirm`; en el tenant de prueba lo
  tiene `contabilidad@act.test`, no `activos@act.test`); el recibo lo refleja en `journalEntryStatus: "posted"` en la siguiente
  lectura (`journalStatusesOf`). Devengo 1/12, ICIO definitivo al capitalizar y plusvalía: fuera de alcance.

## 5 · Documentos y almacén (reutilización exacta de la Tanda T9)

- **Subida** (`POST …/documents`, `POST …/documents/:documentId/versions`; `real_estate.documents.manage`): JSON con metadatos +
  `file { fileName, mimeType, base64 }` opcional en la subida y obligatorio en la versión; `bodyLimit` por ruta =
  `DOCUMENT_UPLOAD_BODY_LIMIT` (`getDocumentsUploadBodyLimit()`, 40 MiB) y 30 subidas por minuto; `prepareDocumentFile`: 413
  `DOCUMENT_TOO_LARGE` por encima de `DOCUMENT_MAX_BYTES` (25 MiB, calculado **antes** de decodificar), 400
  `DOCUMENT_MIME_NOT_ALLOWED` / `DOCUMENT_CONTENT_MISMATCH` con la misma lista blanca y los mismos **magic bytes** de
  `modules/documents/magic-bytes.ts` (`application/pdf`, `image/jpeg`, `image/png`, `image/tiff`, `application/xml` /
  `text/xml`; nada de HTML/SVG), `sha256` hex.
- **Almacén**: `getDocumentStorage()` de `modules/documents/documents.config.ts`; clave `buildStorageKey({ organizationId,
  propertyId, documentId: red_…, sha256, ext })` = `org/<org>/prop/<prop>/doc/<red_…>/<sha256>.<ext>`
  (`buildRealEstateDocumentStorageKey`). Con `inline` los bytes base64 van en la columna `inline` y `storageKey` queda null
  (T9 conserva la clave también en inline: única diferencia); con `disk` / `s3` se guarda la clave y `encrypted` según el
  almacén; `withStoredFile` hace `storage.put` antes de la fila y borra el objeto si la transacción falla. **No** se crea
  `DocumentFile` ni `IncomingDocument`; `/health` sigue informando `dependencies.objectStorage`.
- **Descarga** (`GET …/documents/:documentId/file?inline=1`, `real_estate.read`): sesión real obligatoria (`requireRealSession`
  → 401 al fallback demo), verifica el hash (500 `DOCUMENT_STORAGE_IO` si no coincide), cabeceras `content-type`,
  `content-length`, `content-disposition attachment|inline`, `x-content-type-options: nosniff`, `cache-control: private, no-store`;
  auditado `REAL_ESTATE_DOCUMENT_DOWNLOADED` (nunca bytes ni claves en `afterJson`). Sin fichero → 404 `DOCUMENT_NO_FILE`;
  retirado → 404 opaco (el objeto permanece en el almacén); sustituido → sigue descargable (histórico).
- **Metadatos y cumplimiento**: `PATCH …/documents/:documentId` (`real_estate.documents.manage`; `legalHold` solo con
  `real_estate.manage`, 403); si `complianceRequirementCode` está en el catálogo, la subida y el `PATCH` sincronizan
  `ComplianceItem.issueDate / expiryDate` del centro (patrón `createComplianceDocument`); un código desconocido se guarda sin
  sincronizar. Listado (`GET …/documents?category=&status=&kind=`) exige ficha (404 `ASSET_NOT_FOUND`), excluye retirados y
  deriva `status` con `expiringSoonDays` del perfil de cumplimiento.
- **Retención**: `retentionUntil` se guarda pero no aplica ningún job (el de T9 solo barre `incoming_documents`); nada se
  purga; `legalHold` bloquea retirar y versionar. Variables: las `DOCUMENT_*` de T9 (`docs/runbooks/documentos-digitalizacion.md`
  §2); ninguna propia.
- **Visibilidad por documento** (diseño §5.1; `isDocumentVisibleTo`, ACT-REV-11 / ACT-REV-03): un documento `cdeState = wip`
  solo lo ve (lista, descarga, metadatos, versión) quien lo subió (`uploadedBy`, siempre el actor de la subida, con o sin
  fichero) o quien tiene `real_estate.manage`; «Publicar» = `PATCH { cdeState: "publicado" }` (`real_estate.documents.manage`).
  Un documento `confidentiality = solo_propiedad` solo lo ven `real_estate.manage` (controller, compliance, asset_manager) o una
  asignación con plantilla `owner`; el resto (manager, accountant, auditor, admin_clerk…) ni lo lista ni lo descarga (404 opaco
  por id). Los enlaces por id desde obras (`licenceDocumentId`…) no aplican la regla (solo existencia en el centro).
- **Cableado (2026-09-20, ACT-REV-01)**: `real-estate.register.ts` llama a `registerRealEstateDocumentRoutes(app)`; las suites
  `real-estate-documents` y `real-estate-group` lo exigen con aserción dura (sin cableado de reserva) y `real-estate-core` cruza
  todas las entradas de los partials con `app.hasRoute` (una entrada sin ruta registrada rompe la puerta de integración).
- **Borrado físico**: no hay `DELETE` de la ficha; la FK `real_estate_documents.asset_id` es `ON DELETE CASCADE`, así que un
  `prisma.realEstateAsset.delete` (solo el `--reset` del seed sobre `prop_act_*`, cuyos documentos son `inline`) arrastra las filas
  sin mirar `legalHold` y sin purgar objetos `disk` / `s3` (el módulo nunca borra del almacén). En producción la ficha no se
  borra físicamente (ACT-REV-09).

## 6 · Rutas y permisos

### 6.1 Tabla exacta (manifiesto `security/route-permissions.ts` ← `modules/real-estate/route-permissions.partial.ts` ← 6 partials)

Fuente: `modules/real-estate/core-route-permissions.partial.ts`, 12 entradas · `modules/real-estate/taxes-route-permissions.partial.ts`,
9 entradas · `modules/real-estate/documents-route-permissions.partial.ts`, 6 entradas ·
`modules/real-estate/works-route-permissions.partial.ts`, 4 entradas · `modules/real-estate/inspections-route-permissions.partial.ts`,
7 entradas · `modules/real-estate/group-route-permissions.partial.ts`, 4 entradas (42 en total; el agregador
`route-permissions.partial.ts` solo hace los seis spreads y tiene 0 entradas propias). El riesgo es el del manifiesto; el
manifiesto expresa conjunciones y todas las rutas llevan exactamente una clave.

| Ruta | Clave(s) | Riesgo |
|---|---|---|
| `GET /properties/:propertyId/real-estate` | `real_estate.read` | medium |
| `POST /properties/:propertyId/real-estate` | `real_estate.manage` | high |
| `PATCH /properties/:propertyId/real-estate` | `real_estate.manage` | high |
| `POST /properties/:propertyId/real-estate/units` | `real_estate.manage` | high |
| `PATCH /properties/:propertyId/real-estate/units/:unitId` | `real_estate.manage` | high |
| `POST /properties/:propertyId/real-estate/units/:unitId/charges` | `real_estate.manage` | high |
| `PATCH /properties/:propertyId/real-estate/charges/:chargeId` | `real_estate.manage` | high |
| `GET /properties/:propertyId/real-estate/valuations` | `real_estate.read` | medium |
| `POST /properties/:propertyId/real-estate/valuations` | `real_estate.manage` | high |
| `GET /properties/:propertyId/real-estate/tenures` | `real_estate.read` | medium |
| `POST /properties/:propertyId/real-estate/tenures` | `real_estate.manage` | high |
| `PATCH /properties/:propertyId/real-estate/tenures/:tenureId` | `real_estate.manage` | high |
| `GET /properties/:propertyId/real-estate/taxes` | `real_estate.read` | medium |
| `POST /properties/:propertyId/real-estate/taxes` | `property_tax.manage` | high |
| `PATCH /properties/:propertyId/real-estate/taxes/:taxId` | `property_tax.manage` | high |
| `POST /properties/:propertyId/real-estate/taxes/:taxId/receipts` | `property_tax.manage` | high |
| `POST /properties/:propertyId/real-estate/taxes/:taxId/receipts/generate` | `property_tax.manage` | high |
| `GET /properties/:propertyId/real-estate/receipts` | `real_estate.read` | medium |
| `PATCH /properties/:propertyId/real-estate/receipts/:receiptId` | `property_tax.manage` | high |
| `POST /properties/:propertyId/real-estate/receipts/:receiptId/propose-entry` | `property_tax.manage` | critical |
| `GET /properties/:propertyId/real-estate/tax-calendar` | `real_estate.read` | medium |
| `GET /properties/:propertyId/real-estate/documents` | `real_estate.read` | medium |
| `POST /properties/:propertyId/real-estate/documents` | `real_estate.documents.manage` | high |
| `POST /properties/:propertyId/real-estate/documents/:documentId/versions` | `real_estate.documents.manage` | high |
| `PATCH /properties/:propertyId/real-estate/documents/:documentId` | `real_estate.documents.manage` | medium |
| `DELETE /properties/:propertyId/real-estate/documents/:documentId` | `real_estate.manage` | high |
| `GET /properties/:propertyId/real-estate/documents/:documentId/file` | `real_estate.read` | medium |
| `GET /properties/:propertyId/real-estate/works` | `real_estate.read` | medium |
| `POST /capex-projects/:id/approve` | `asset.capex.approve` | high |
| `PATCH /capex-projects/:id/work` | `capex.create` | high |
| `POST /capex-projects/:id/capitalize` | `assets.manage` | critical |
| `GET /properties/:propertyId/real-estate/inspections` | `real_estate.read` | medium |
| `POST /properties/:propertyId/real-estate/inspections` | `real_estate.manage` | high |
| `PATCH /properties/:propertyId/real-estate/inspections/:inspectionId` | `real_estate.manage` | high |
| `GET /properties/:propertyId/real-estate/insurances` | `real_estate.read` | medium |
| `POST /properties/:propertyId/real-estate/insurances` | `real_estate.manage` | high |
| `PATCH /properties/:propertyId/real-estate/insurances/:insuranceId` | `real_estate.manage` | high |
| `GET /properties/:propertyId/real-estate/alerts` | `real_estate.read` | medium |
| `GET /organizations/:organizationId/real-estate/overview` | `real_estate.read` | medium |
| `GET /organizations/:organizationId/real-estate/calendar` | `real_estate.read` | medium |
| `GET /organizations/:organizationId/real-estate/export` | `real_estate.read` | medium |
| `GET /properties/:propertyId/real-estate/calendar` | `real_estate.read` | medium |

### 6.2 Notas

- Tenencia: `/properties/:propertyId/*` pasa por la guardia global de `server.ts` (`pickPropertyId → grantPropertyAccess`, 404
  opaco «Propiedad no encontrada.» fuera del ámbito); cada fila se busca **a través de la ficha del centro** y responde 404
  tipado / opaco (no distingue «no existe» de «es de otro centro»). `/capex-projects/:id/*` y `/organizations/:organizationId/*`
  usan `assertEntityAccess` (`capexProject`, `organization`); la vista de grupo filtra centros con `hasEntityReadScope`
  (owner, `accounting.entity.read` o ámbito de organización → toda la sociedad) o `propertyWithinScope` (un director ve su
  fila); hoteles siempre (fila vacía sin ficha), oficina / `other` solo con ficha.
- Aprobación de obras (ACT-REV-05): `POST /capex-projects/:id/approve` (`asset.capex.approve`: owner, general_manager,
  controller; cuerpo opcional `{ supervisorAuthorizationId }`) llama a `updateCapexProject({ status: "approved" })` del motor
  existente (separación de funciones: nunca quien lo propuso, 409 del motor). El `PATCH /capex-projects/:id { status: approved }`
  heredado sigue exigiendo `capex.create` en el manifiesto **y** `asset.capex.approve` en el servicio (ninguna plantilla reúne
  ambas): se conserva por compatibilidad. El front gatea «Aprobar» solo con `asset.capex.approve`.
- Exportación: `GET /organizations/:organizationId/real-estate/export?format=csv&what=overview|calendar&year=` → `text/csv;
  charset=utf-8` con BOM, separador `;`, CRLF, cabeceras en español, coma decimal, `content-disposition: attachment;
  filename="activo-inmobiliario-<what>-<año>.csv"`, `cache-control: no-store`; la vista de grupo exporta una línea por centro
  **sin** línea de totales (verificado: 3 líneas para 2 centros).
- Listas sin paginación (arrays planos; el módulo es de decenas de filas por centro). Dinero como cadena `"1060.00"`,
  porcentajes como cadena decimal (`ratePct` con 4 decimales), días `AAAA-MM-DD`. Auditoría (`recordAuditEvent`, `entityType`
  `real_estate_asset | real_estate_unit | real_estate_charge | real_estate_valuation | real_estate_tenure | property_tax |
  property_tax_receipt | real_estate_document | real_estate_inspection | real_estate_insurance | capex_project`) en toda
  escritura y en cada descarga: `REAL_ESTATE_ASSET_CREATED/UPDATED`, `REAL_ESTATE_UNIT_CREATED/UPDATED`,
  `REAL_ESTATE_CHARGE_CREATED/UPDATED`, `REAL_ESTATE_VALUATION_CREATED`, `REAL_ESTATE_TENURE_CREATED/UPDATED/ACTIVATED/RESOLVED`,
  `PROPERTY_TAX_CREATED/UPDATED`, `PROPERTY_TAX_RECEIPT_CREATED/UPDATED`, `PROPERTY_TAX_RECEIPTS_GENERATED`,
  `RECEIPT_STATUS_CHANGED`, `RECEIPT_ENTRY_PROPOSED`, `RECEIPT_ENTRY_LINKED`, `REAL_ESTATE_DOCUMENT_CREATED/VERSION_CREATED/
  SUPERSEDED/UPDATED/RETIRED/DOWNLOADED`, `REAL_ESTATE_INSPECTION_CREATED/UPDATED`, `REAL_ESTATE_INSURANCE_CREATED/UPDATED`,
  `RECEIPT_PAYMENT_ENTRY_PROPOSED`, `CAPEX_WORK_UPDATED`, `CAPEX_CAPITALIZED`. Los identificadores fiscales (`counterpartyTaxId`,
  `titleHolderTaxId`, `holderTaxId`) van enmascarados `***123` (`maskTaxId`, ACT-REV-08); nombres de contraparte y notas nunca.
- `tests/rbac-nav-contract.test.mjs` (`loadManifest`) lee todos los `*route-permissions.partial.ts` y resuelve los spreads
  anidados del agregador real-estate (ACT-REV-07): las 42 entradas entran en el cruce plantilla × pantalla (0 huecos).

## 7 · Códigos de error (`REAL_ESTATE_ERROR_CODES`, `packages/shared/src/real-estate-types.ts`)

Todo 4xx tipado del módulo lleva `details.code` (`errors.ts` `realEstateError`; el handler global reenvía `details`); el front
traduce con `REAL_ESTATE_ERROR_MESSAGES` (`screens/realEstate/real-estate-helpers.ts`, `realEstateErrorMessage`, que añade
«Cambios posibles: …» con `details.allowed` en las transiciones). Cuerpos fuera del esquema zod `.strict()` → 400
`VALIDATION_ERROR` genérico (diccionario común de finanzas).

| Código | HTTP | Cuándo | Mensaje del API | Mensaje del front |
|---|---|---|---|---|
| `ASSET_ALREADY_EXISTS` | 409 | `POST …/real-estate` en un centro que ya tiene ficha | «Este centro ya tiene ficha de activo inmobiliario.» | Este centro ya tiene ficha de activo inmobiliario: edítala en vez de crear otra. |
| `ASSET_NOT_FOUND` | 404 | Cualquier ruta del centro sin ficha (detalle, valoraciones, tenencias, tributos, documentos, inspecciones, pólizas, calendario…) o ficha de otro centro al enlazar una obra | «Activo inmobiliario no encontrado.» | Este centro aún no tiene activo inmobiliario: crea la ficha antes de continuar. |
| `INVALID_CADASTRAL_REFERENCE` | 400 | `cadastralReference` que, normalizada (mayúsculas, sin espacios), no son 20 `[0-9A-Z]` (antes del parseo zod; `details.value`) | «Referencia catastral no válida: deben ser 20 caracteres alfanuméricos (sin guiones ni signos).» | La referencia catastral debe tener 20 caracteres alfanuméricos, sin guiones ni espacios. |
| `UNIT_NOT_FOUND` | 404 | `PATCH …/units/:unitId`, `POST …/units/:unitId/charges` o `unitId` de un tributo que no es de la ficha del centro | «Unidad registral no encontrada.» | La unidad registral no existe o no pertenece a este centro. |
| `TENURE_ALREADY_ACTIVE` | 409 | «Activar» con otra tenencia `vigente` en la ficha | «El activo ya tiene una tenencia vigente: resuélvela antes de activar otra.» | Ya hay una tenencia vigente en este centro: resuélvela antes de activar otra. |
| `TENURE_INVALID_TRANSITION` | 400 / 409 | 409: transición fuera de `TENURE_TRANSITIONS` o edición de campos en `resuelto` / `vencido` (`details.allowed`); 400: `endDate` anterior a `startDate` | «Transición no permitida: resuelto → vigente (resuelto es un estado final).» / «Tenencia no válida: endDate no puede ser anterior a startDate.» | La tenencia no admite ese cambio en su estado actual. |
| `RECEIPT_NOT_PAYABLE` | 409 | Transición fuera de `RECEIPT_TRANSITIONS`, pagar sin importe, o proponer asiento de un `previsto` o sin importe | «El recibo está previsto: regístralo como recibido o domiciliado (o pagado) antes de proponer el asiento.» / «El recibo no tiene importe: …» | El recibo no se puede marcar como pagado en su estado actual. |
| `RECEIPT_ENTRY_EXISTS` | 409 | Segunda propuesta (o carrera) sobre un recibo con `journalEntryId`; un asiento no anulado del mismo recibo en el diario; cambiar importes o pago con asiento enlazado; desenlazar un asiento propio ya contabilizado | «El recibo ya tiene un asiento propuesto o enlazado.» / «El recibo ya tiene asiento enlazado: desenlázalo antes de cambiar importes o pago.» | El recibo ya tiene un asiento enlazado: desenlázalo antes de cambiar importes o pago, o de proponer otro. |
| `RECEIPT_ALREADY_EXISTS` | 409 | `POST …/taxes/:taxId/receipts` con el mismo `(fiscalYear, period)` (`details.receiptId`) | «Ya existe el recibo PAC-01 de 2026 de este tributo.» | Ya existe un recibo de ese tributo para el mismo ejercicio y periodo. |
| `TAXPAYER_NOT_ENTITY` | 409 | `propose-entry` de un tributo con `taxpayer ≠ sociedad` | «El asiento solo se propone cuando el contribuyente es la sociedad (este tributo lo paga un tercero).» | Solo se propone asiento cuando el sujeto pasivo es la sociedad: este tributo lo paga un tercero. |
| `DOCUMENT_SUPERSEDED` | 409 | Nueva versión sobre un documento que ya tiene `supersededById`; `supersedesId` que apunta a uno sustituido | «Este documento ya tiene una versión posterior; versiona la última.» | El documento está sustituido por una versión posterior: trabaja sobre la versión vigente. |
| `LEGAL_HOLD` | 409 | `DELETE …/documents/:documentId` (o versionar) con `legalHold` | «El documento está bajo retención legal y no puede retirarse.» | El documento tiene bloqueo legal: no se puede retirar ni sustituir mientras siga activo. |
| `DOCUMENT_NO_FILE` | 404 | `GET …/documents/:documentId/file` de un documento sin bytes (`hasFile: false`) | «Este documento no tiene fichero.» | El documento no tiene fichero adjunto: sube una versión con el fichero. |
| `LICENCE_REQUIRED` | 409 | `PATCH /capex-projects/:id/work { status: in_progress }` (o el `PATCH /capex-projects/:id` heredado) con `licenceRequired` y sin `licenceDocumentId` | «La obra exige licencia: registra el documento de la licencia de obras (licenceDocumentId) antes de iniciarla.» | La obra requiere licencia: registra el documento de licencia antes de iniciarla. |
| `CAPEX_NOT_COMPLETED` | 409 | Capitalizar una obra que no está `completed`; transición fuera de `CAPEX_WORK_TRANSITIONS` (también en el `PATCH /capex-projects/:id` heredado) | «Solo se capitaliza una obra terminada (status completed).» | Solo se capitaliza una obra terminada: marca el proyecto como completado. |
| `CAPEX_ALREADY_CAPITALIZED` | 409 | Capitalizar una obra con `capitalizedFixedAssetId` (`details.capitalizedAt`); cambiar el `status` de una obra ya capitalizada | «La obra ya está capitalizada.» | La obra ya está capitalizada en el inmovilizado. |
| `CAPEX_NOT_LINKED` | 409 | Capitalizar sin `realEstateAssetId` | «La obra no está enlazada a la ficha del activo inmobiliario (realEstateAssetId): enlázala antes de capitalizar.» | El proyecto no está enlazado a la ficha del activo inmobiliario: enlázalo en los datos de obra. |
| `INSPECTION_INVALID_TRANSITION` | 409 | Transición fuera de `INSPECTION_TRANSITIONS`, acta sin `performedAt` / `result`, cierre con defectos sin `fixedAt` (`details.openDefects`), edición de una `cerrada` | «Transición no permitida: cerrada → realizada (cerrada es un estado final).» y variantes con el requisito que falta | La inspección no admite ese cambio en su estado actual. |

Códigos que llegan por `details.code` **sin** estar en el contrato compartido (`REAL_ESTATE_EXTRA_ERROR_CODES` del front):

| Código | HTTP | Cuándo | Mensaje del API | Mensaje del front |
|---|---|---|---|---|
| `FISCAL_YEAR_CLOSED` | 409 | `propose-entry` con la fecha contable en un ejercicio cerrado (motor contable) | mensaje del motor (`accounting.service.ts`) | El ejercicio está cerrado: enlaza el asiento importado en vez de proponer uno nuevo. |
| `DOCUMENT_TOO_LARGE` | 413 | Fichero mayor que `DOCUMENT_MAX_BYTES` (antes de decodificar) | «El fichero «…» supera el tamaño máximo admitido (… bytes).» | El fichero supera el tamaño máximo admitido (40 MiB): comprímelo o divide el documento. |
| `DOCUMENT_MIME_NOT_ALLOWED` | 400 | MIME fuera de la lista blanca de T9 | «Tipo de fichero no admitido: <mime>.» | Tipo de fichero no admitido: sube un PDF, una imagen (JPEG, PNG, TIFF) o un XML. |
| `DOCUMENT_CONTENT_MISMATCH` | 400 | Magic bytes distintos del MIME declarado | «El contenido del fichero no corresponde al tipo declarado (<mime>).» | El contenido del fichero no corresponde con su tipo: vuelve a exportarlo o escanéalo de nuevo. |
| `DOCUMENT_STORAGE_IO` | 500 | Hash distinto al descargar o fallo del almacén (`disk` / `s3`) | «La integridad del fichero no se ha podido verificar.» (hash distinto) y los mensajes del almacén de T9 | No se pudo guardar o leer el fichero en el almacén de documentos. Inténtalo de nuevo. |
| `PROPERTY_TAX_INACTIVE` | 409 | `POST …/taxes/:taxId/receipts/generate` de un tributo `baja` (ConflictError genérico) | «El tributo está de baja: no se generan recibos previstos.» | El tributo está de baja: reactívalo antes de generar los recibos previstos. |

## 8 · Alertas y calendario (`alerts.pure.ts` · `alerts.service.ts` · `calendar.service.ts`)

- **Umbrales** `REAL_ESTATE_ALERT_THRESHOLD_DAYS = [90, 30, 7]`: `severityForDaysLeft` → **baja** a ≤ 90 días, **media** a ≤ 30,
  **alta** a ≤ 7; siempre **alta** lo vencido (documento, inspección, póliza, recibo, preaviso), el acta negativa / condicionada
  o `con_defectos` sin `correctedAt`, el ascensor vencido («fuera de servicio a las 24 h», RD 355/2024) y la obra en curso sin
  licencia cuando la exige. Calculadas en cada lectura (sin tabla, sin scheduler, sin correo), ordenadas por gravedad, fecha,
  tipo e id; mensajes en español sin datos personales (ni contrapartes ni titulares).
- **Tipos** (`REAL_ESTATE_ALERT_KINDS`, 11) y entidad (`REAL_ESTATE_ALERT_ENTITY_TYPES`): `DOCUMENT_EXPIRED` / `DOCUMENT_EXPIRING`
  (`real_estate_document`; documentos vivos con `validUntil`: ni retirados ni sustituidos), `INSPECTION_DUE` /
  `INSPECTION_OVERDUE` / `INSPECTION_NEGATIVE_OPEN` (`real_estate_inspection`; abiertas: `status ≠ cerrada`; plazo =
  `scheduledAt` mientras está `programada`, después `nextDueAt`), `INSURANCE_EXPIRING` (`real_estate_insurance`; el motor omite
  las canceladas; dentro del preaviso propio `noticeDays` (60) una **baja** sube a **media**), `TENURE_NOTICE` / `RENT_REVIEW`
  (`real_estate_tenure`; vigentes: preaviso `endDate − noticeMonths`, vencimiento, revisión de renta el día 1 de
  `rentReviewMonth`), `TAX_DUE` / `TAX_OVERDUE` (`property_tax_receipt`; recibos `previsto | recibido | domiciliado | recurrido` sin `paidAt` y con
  `dueTo`: el recurso no oculta el vencimiento y el mensaje lleva «(recurrido)», ACT-REV-09), `CAPEX_LICENCE_MISSING` (`capex_project`; `in_progress` + `licenceRequired` sin
  `licenceDocumentId`). `MISSING_DOCUMENT` del diseño no existe.
- **Dónde se ven**: `GET /properties/:propertyId/real-estate/alerts` (todas), `GET /organizations/:organizationId/real-estate/overview`
  (`openAlerts` / `openAlertsHigh` por fila y las **altas** del grupo en `alerts`), `GET …/works` (`alerts` de obras) y la ficha
  (`GET /properties/:propertyId/real-estate`): mismo motor (`getRealEstateAlerts`) y mismas definiciones de KPI que la fila de
  grupo (`taxes` con los tributos de la ficha, `annualTaxBurden` = `computeAnnualTaxBurden`, `documentsValidPct` /
  `inspectionsOnTimePct` = `documentsValidPctOf` / `inspectionsOnTimePctOf`; ACT-REV-06).
- **Calendario anual** (`GET /properties/:propertyId/real-estate/calendar?year=` y `GET /organizations/:organizationId/real-estate/calendar?year=`
  → `{ year, properties[], months[12] { month, events[] }, totalEvents }` con `RealEstateCalendarEvent { kind, dueAt, entityType,
  entityId, propertyId, label }`): periodos voluntarios de cada tributo activo (`buildTaxCalendar`: inicio y fin de cada recibo
  del ejercicio y el periodo **previsto** de los que aún no tienen recibo, publicado con `entityType property_tax` y
  `entityId = PropertyTax.id` (ACT-REV-13); etiquetas con fechas DD/MM/AAAA e importes «18.000,00 €», ACT-REV-15), vencimientos de recibos, plazos de inspecciones
  abiertas, `validUntil` de documentos vivos y de pólizas no canceladas, preaviso, vencimiento y revisión de renta de la
  tenencia vigente. Solo eventos con `dueAt` dentro del año; orden cronológico. El calendario de tributos del centro
  (`GET …/tax-calendar?year=` → `{ year, events, pending }`) lista además los periodos sin recibo generado.
- **Calendario municipal** (`tax-calendar.ts` `voluntaryPeriodFor`): ventana del tributo (`voluntaryFrom/To`) → tabla por INE
  (solo **Madrid 28079** verificado: IBI e IAE 01-10 → 30-11, vados 01-04 → 01-06) → supletorio **art. 62.3 LGT**
  (01-09 → 20-11). `expectedReceiptsFor` reparte `expectedAnnualAmount` por periodicidad (partes iguales, el último plazo
  absorbe los céntimos) o por los plazos PAC de `installmentsJson`.

## 9 · Datos de prueba (`db:seed:real-estate`, tenant aislado `org_act`)

Script `packages/database/prisma/seed-real-estate.ts` (patrón `seed-checkin.ts`; todo por Prisma con ids fijos `*_act_*`,
idempotente, guardado por `assertDemoTarget` — `org_act` está en `DEMO_ORG_IDS` de `lib/demo-guard.ts`; nunca toca la
organización real ni `org_123`, `org_uxday`, `org_chk`):

```bash
corepack pnpm --filter @hotelos/database db:seed:real-estate                 # siembra o rearma (idempotente)
corepack pnpm --filter @hotelos/database db:seed:real-estate -- --dry-run    # plan sin escribir
corepack pnpm --filter @hotelos/database db:seed:real-estate -- --reset      # borra la capa ACT de prop_act_* y vuelve a sembrar
```

| Qué | Detalle |
|---|---|
| Tenant | Organización `org_act` «ACT (pruebas de activo inmobiliario)», sociedad `le_act` «ACT Pruebas Inmobiliarias SL» (NIF ficticio con letra válida), plan PGC Pymes hotelero (631, 572, 570, 5721, 475, 231, 211, 212 postables), ejercicio `2026` abierto. |
| Centros | `prop_act_a` «Hotel ACT Norte (prueba)» (INE 15030, 4★, 120 plazas) **propietaria**; `prop_act_b` «Hotel ACT Sur (prueba)» (INE 28079, 3★, 80 plazas) **arrendataria de industria**. |
| Usuarios (`*@act.test`) | `activos@act.test` (`asset_manager`, ámbito `legal_entity` `le_act`), `contabilidad@act.test` (`accountant`, organización: contabiliza el borrador), `direccion@act.test` (`manager` de `prop_act_a`), `recepcion@act.test` (`receptionist` de `prop_act_a`: 403 en todo el módulo). Contraseña común **`Act-Demo-2026!`** (`ACT_DEMO_PASSWORD` la sustituye; debe cumplir la política del API). Con `NODE_ENV=production` el seed aborta salvo `SEED_ACT_ALLOW_PRODUCTION=1`. |
| Norte (`prop_act_a`) | Ficha «Edificio Hotel ACT Norte» (1972, reformado 2018, 4.850 m², 6 plantas, 120 habitaciones, valor catastral 2.400.000 € de 2025); finca registral con referencia catastral ficticia de forma válida; hipoteca 3.500.000 € (saldo 2.100.000 €); tasación ECO 805 del 30-06-2025 por 9.800.000 € (`valuePerRoom` 81.666,67 €); tenencia `propiedad` vigente desde 1998; tributos IBI 27.240 € (domiciliado, PAC en 3 plazos: PAC-01 `pagado` por banco el 15-06-2026 sin asiento, PAC-02 y PAC-03 previstos), IAE 3.900 € y residuos 1.200 € (anuales en el supletorio 01-09 → 20-11); 8 documentos sin fichero + 1 `sustituido` (v1 de la póliza multirriesgo); inspecciones OCA BT vencida hace 20 días, OCA ascensor realizada (próxima 10-03-2027), CEE programada 2031; pólizas RC (hasta 31-03-2027) y multirriesgo (vence en 40 días); obra «Sustitución enfriadora» (48.000 €, eficiencia energética) `in_progress` con licencia exigida y sin registrar, 2 partidas y un asiento `posted` 212/572 de 31.500 € (ejecución `ledger`). |
| Sur (`prop_act_b`) | Ficha sin unidad; tenencia `arrendamiento_industria` vigente con «Inmuebles Demo Sur SL» (2020-2035, preaviso 12 meses, renta 32.000 €/mes + 4 % GOR, revisión IPC en enero, fianza 64.000 €, IBI a cargo del arrendatario, retención); IBI `propietario_tercero` (solo calendario); contrato como documento; CEE caducado en 2025 (documento caducado + inspección vencida). |
| Recuentos (SELECT en `hotelos_act`) | 2 fichas · 4 tributos · 5 recibos · 11 documentos · 4 inspecciones · 2 pólizas · 1 obra · 4 usuarios. |
| Alertas esperadas | Norte 7: `INSPECTION_OVERDUE` alta, `CAPEX_LICENCE_MISSING` alta, `INSURANCE_EXPIRING` media, `DOCUMENT_EXPIRING` baja, `TAX_DUE` baja ×3. Sur 2: `DOCUMENT_EXPIRED` alta, `INSPECTION_OVERDUE` alta. Vista de grupo: 2 centros, valor catastral 2.400.000,00, tasación 9.800.000,00, carga fiscal 32.340,00, 9 alertas (4 altas); Norte `documentsValidPct` 87,50 e `inspectionsOnTimePct` 66,67. |

Las fechas que disparan alertas son relativas a hoy (Europe/Madrid); el resto son literales. Ningún nombre de persona (los
usuarios llevan nombres de puesto), ningún NIF real, ningún IBAN. Contrato: `tests/seed-real-estate-contract.test.mjs`.

## 10 · Verificación

```bash
corepack pnpm run typecheck:all                                                            # shared, database, api, admin-web
node --test tests/activo-inmobiliario-docs-contract.test.mjs tests/seed-real-estate-contract.test.mjs tests/brand-contract.test.mjs
node --test tests/api-route-permissions-contract.test.mjs tests/finanzas-schema-contract.test.mjs tests/migrations-squash-contract.test.mjs
cd apps/api && node --import tsx --test src/modules/real-estate/__tests__/*.test.mts src/schemas/__tests__/real-estate-schemas.test.mts   # 12 + 1 suites puras
cd apps/api && node --env-file-if-exists=../../.env --import tsx --test --test-concurrency=1 ../../tests/integration/real-estate-*.test.mts   # core, taxes, documents, works, inspections, group (tenants propios con limpieza)
cd apps/admin-web && node --import ../api/node_modules/tsx/dist/loader.mjs --test "src/screens/realEstate/__tests__/*.test.mts"            # 7 suites del front
corepack pnpm --filter @hotelos/database db:migrate:status && corepack pnpm --filter @hotelos/database db:drift:check                     # «up to date» · «No difference detected.»
corepack pnpm --filter @hotelos/api rbac:sync -- --dry-run                                                                                 # 0 claves nuevas (las 4 son de T8a)
NAV_TREE_CSV=<ruta>/pilots/tanda5-nav-tree.csv bash scripts/gates.sh --quick --json <fichero>                                               # ola; completo sin --quick al final
```

Instancia propia del carril (puertos **:3925** API y **:5195** Vite; nunca `:3000` / `:5173`), desde `apps/api` y la raíz:

```bash
PORT=3925 RUN_SCHEDULERS=false TENANT_BOOTSTRAP_SKIP=true node --env-file-if-exists=../../.env --import tsx src/server.ts
VITE_API_URL=http://127.0.0.1:3925 corepack pnpm --filter @hotelos/admin-web dev -- --port 5195
curl -s -X POST http://127.0.0.1:3925/auth/login -H 'content-type: application/json' -d '{"email":"activos@act.test","password":"Act-Demo-2026!","deviceId":"d1"}'
curl -s http://127.0.0.1:3925/properties/prop_act_a/real-estate/alerts -H "authorization: Bearer <token>"        # 7 alertas
curl -s "http://127.0.0.1:3925/organizations/org_act/real-estate/export?format=csv&what=overview&year=2026" -H "authorization: Bearer <token>" -D -   # text/csv, BOM, 3 líneas
```

Recorrido en el navegador (`activos@act.test` → Finanzas › Activo inmobiliario, diseño §8): Ficha (KPIs, unidad, hipoteca,
tenencia, inspector de 90 días) → Documentación (subida con fichero, versión, visor y descarga) → Tributos (Generar previstos →
Recibido → Pagado → Proponer asiento; «Contabilizar» con `contabilidad@act.test`) → Obras (iniciar obra con licencia,
terminar, capitalizar → enlace a Inmovilizado) → Inspecciones y Seguros (acta, defectos, cierre; póliza que vence) → Grupo
(2 filas, totales, calendario, exportar CSV). **Estado 2026-09-20 (tras el lote de navegación ACT-F4)**: ítem **Finanzas › Activo
inmobiliario** (`/finanzas/activo-inmobiliario`, roles `finanzas|direccion|admin|activos|auditoria`, core, sin gate de módulo) con
seis filas en `pilots/tanda5-nav-tree.csv` (`RealEstateAssetScreen` Ficha + `merge-into` `/documentacion`, `/tributos`, `/obras`,
`/inspecciones` «Inspecciones y seguros», `/grupo`), `nav-tree.generated.json` regenerado con `node scripts/build-nav-tree.mjs --csv …`
(el CSV vive fuera del repo) y contenedor `screens/tabs/finanzas/ActivoInmobiliarioTabs.tsx` registrado en `App.tsx` (`lazyTab`);
`discoverability`, `nav-tree --check` y `route-access` en verde (203 URLs × 15 tokens). `recepcion@act.test` no ve el ítem (token
`recepcion`) y el API le responde 403. Las rutas de documentos están registradas desde `real-estate.register.ts` (ACT-REV-01).

## 11 · Límites y lo que solo César puede aportar

- **Límites de la tanda**: sin OCR ni «Leer fechas» (fechas a mano); sin resumen diario, scheduler ni correo (alertas solo
  al leer: `/alerts`, vista de grupo, `/works`); sin tesorería (el cargo domiciliado no se concilia, la previsión de pagos no
  existe); sin fila FF&E en USALI ni tarjeta en el cuadro de mando de cartera; sin `SafetyCheck` / `ComplianceTask`; sin
  consulta al Catastro (solo la forma de la referencia) ni tasadora; sin job de retención ni purga (`retentionUntil`
  informativo; el fichero de un documento retirado permanece); calendario municipal solo Madrid (`28079`), el resto en el
  supletorio LGT 62.3; `vence_pronto` de pólizas no es estado del DTO (`insuranceExpiresSoon` + alerta); devengo 1/12,
  ICIO definitivo, plusvalía y sociedad patrimonial fuera de alcance; el asiento propuesto necesita ejercicio abierto (los
  cerrados se enlazan a mano); listas sin paginación. Cableado pendiente del orquestador: rutas de documentos en
  `real-estate.register.ts` (ACT-L3 #1), `taxes` / `kpis` / `alerts` completos en la ficha (L2 #4, L5 #4, L6 #9), hueco RBAC de la aprobación de obras (L4 #3), `export * from
  "./real-estate.schemas.js"` en `schemas/index.ts` (L0a), comentario `installmentsJson` del schema (L0b), tipos del calendario y
  de las respuestas compuestas en el contrato compartido (F0 #2/#3), `RECEIPT_TRANSITIONS` duplicado en el front (F2 #9).
- **Lo que solo César puede aportar** (diseño §10.2): (1) **titularidad real** de cada hotel (propietaria, arrendataria o gestora,
  contraparte y contrato) y si hay sociedad patrimonial; (2) **catastro y registro**: notas simples, escrituras y certificaciones
  catastrales (referencia de 20 caracteres, superficie, valor catastral suelo / construcción) de los 7 hoteles y la oficina —
  hoy `Property.cadastralReference` sigue NULL; (3) **ordenanzas y recibos** de IBI, IAE, residuos, vados y terrazas 2025-2026
  con domiciliación y plazos (Santander 39075, Oviedo 33044, Teo 15082, Carreño 33014, Gijón 33024, Oleiros 15058: sin
  calendario verificado); (4) licencias, registro turístico, CEE y actas OCA / contratos de conservación vigentes; (5) **pólizas**
  (RC, multirriesgo, pérdida de beneficios) con sumas, primas y vencimientos; (6) **cuentas de ejecución** de las obras: qué
  prefijos 21x / 23x por centro llevan la obra en Sage (por defecto `211…232`; `executionAccountPrefixes` por proyecto) y si
  las certificaciones entran como `investmentGood`; (7) decisión del asesor sobre el **coeficiente 211** (2 % servicios / 3 %
  código), la exención IAE por INCN de grupo, el tipo de retención del alquiler y el devengo 1/12; (8) **almacén**:
  `DOCUMENT_STORAGE_KIND=disk` con `DOCUMENT_STORAGE_DIR` en el VPS o **S3 en la UE** (`DOCUMENT_S3_*`), y la clave de cifrado
  guardada con el backup (runbook de documentos §2); (9) quién es responsable del activo en central y los umbrales de aviso si
  90 / 30 / 7 no valen; (10) planos, proyectos, Libro del Edificio y tasaciones para que los KPIs de valor dejen de estar en blanco.
