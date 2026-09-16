# Tanda 6b · Estructura societaria (backend) · Cierre — 16 de septiembre de 2026

**Para:** César. **Encargo (literal):** «distinguir grupo hotelero u hotel
individual» — Faranda = CELUISMA S.A. (CIF A33615980), oficina central + 7
hoteles bajo un solo NIF, sobre el módulo de Finanzas de la Tanda 6.
**Método:** documento de investigación y diseño
(`docs/design/FINANZAS-ESTRUCTURA-SOCIETARIA.md`: normativa, comparativa de ERP,
diagnóstico de cinco agujeros, tres propuestas y dos juicios) → L1 (schema,
migraciones, backfill, helpers) → L2 ∥ L3 ∥ L4 ∥ L5 (sociedad y centros;
facturación e instalaciones VeriFactu; libro, retenciones, nóminas y tesorería;
declarante, régimen SII, USALI y cuentas anuales) → revisión adversarial (17
hallazgos: 3 alta · 7 media · 7 baja) → seis lotes de corrección → esta
integración final. Todo sobre la demo local (Postgres local; API :3000 y Vite
:5173 sin reiniciar, verificación con unitarios e integración in-process).
**Ninguna escritura en las facturas, asientos, cobros ni envíos de Faranda**: lo
único que se escribió en el piloto fue la capa estructural del backfill (una
sociedad, dos códigos de centro, una instalación y los enlaces `legal_entity_id`
/ `installation_id`, todo nuevo o de `NULL` a valor, idempotente y reversible).
El NIF real de CELUISMA **no** aparece en ningún dato ni envío: la sociedad de
la demo lleva el NIF ficticio B99999997.

Este documento resume qué cambia para un grupo como Faranda, qué no cambia para
un hotel individual, qué se construyó y dónde, el estado de la revisión, lo que
el front tiene que consumir (L6/L7) y —lo más importante— la lista exacta de
datos que solo tú puedes aportar para migrar Faranda a CELUISMA (L8).
Operativa completa: `docs/runbooks/finanzas-contabilidad.md` §17 (modelo §17.1,
migraciones §17.2, backfill §17.3, helpers §17.4, tests §17.5, correcciones
§17.6, reglas §17.7, rutas y códigos §17.8, comandos §17.9, límites §17.10,
puertas §17.11); rutas en `docs/api-contracts.md` «Estructura societaria».

## 1. Qué cambia para Faranda / CELUISMA (una sociedad, varios centros)

| Tema | Antes (diagnóstico del diseño, §4) | Ahora (working tree 16/09) |
|---|---|---|
| Modelo | `Organization` = tenant sin concepto de sociedad; `Property` sin tipo; la oficina central no tenía dónde vivir | **Grupo → Sociedad → Centro de trabajo**: tabla `LegalEntity` (NIF único, razón social, domicilio fiscal y social, RM, CNAE, forma jurídica, régimen SII / gran empresa, plantilla PGC, inicio de ejercicio, política de cadena VeriFactu, CCC principal; exactamente **una** por organización en esta tanda); `Property.kind` hotel · oficina · otro, `code` (RA, LT, OC…), `tradeName` y 10 columnas censales (catastro, superficie, IAE, plazas, estrellas, meses de apertura, registro turístico, SES, CCC, centro laboral). La **oficina central es un centro de tipo oficina** sin habitaciones: nóminas, gastos, bancos, inmovilizado y retenciones cuelgan de ella; los bucles operativos la ignoran |
| Identidad emisora | La factura y el registro AEAT llevaban el nombre comercial del hotel como razón social (`Property.legalName`) y el NIF de la organización | Emisor **siempre la sociedad** (NIF, razón social, domicilio fiscal) + bloque «Establecimiento: <nombre comercial> (<código>) · <dirección>» en el PDF (RD 1619/2012 art. 6.1.c-e); XML VeriFactu / TBAI con `NombreRazon` = razón social; SES A.1 = sociedad. Los snapshots de las facturas emitidas no se reescriben nunca (trigger). Nadie lee ya `Property.legalName` ni `Organization.taxId/legalName` (contrato con lista vacía) |
| Series y numeración | Dos hoteles podían emitir `FAC-2026-000001` con el mismo NIF; solo se evitaba a mano (`FAC-LT-2026-`) | Prefijo por defecto condicional (`FAC-2026-` con un centro facturador, `FAC-RA-2026-` con varios); series únicas por sociedad (409 `SERIES_PREFIX_CLASH` al abrir o reactivar); dos `advisory lock` en la numeración (409 `INVOICE_NUMBER_DUPLICATE` si coincide un número bajo un NIF, 409 `WORK_CENTER_CODE_REQUIRED` si un segundo hotel no tiene código, 409 `SERIES_CLOSED` en serie cerrada); nunca se renumera: se cierra y se abre otra. Pantalla sociedad-wide de series y colisiones |
| Cadena VeriFactu | Siete cadenas paralelas presentadas como la **misma** instalación (`VERIFACTU_INSTALL_NUMBER` global) | Tabla `VerifactuInstallation` (número inmutable, alta y retiro); cadena, lock y `RegistroAnterior` por **instalación** (por centro o por sociedad según `verifactuChainScope`, fijado desde la consola de plataforma; 409 `CHAIN_ALREADY_STARTED` con registros reales; cambiar de ámbito nunca re-encadena); `NumeroInstalacion` del registro desde la instalación, env solo en sandbox; en preproducción / producción un centro sin instalación deja sus envíos en `retrying` con `INSTALLATION_NOT_DECLARED` en vez de mentir. Declaración responsable actualizada (`docs/compliance/verifactu-declaracion-responsable.md`) |
| Sociedad en SII / gran empresa | Un booleano por hotel (`sii_enabled` en Rías Altas) sin efecto | Un solo régimen en la sociedad: 303 / 111 / 115 mensuales forzados (RIVA 71.3), 347 y 390 «no se presenta» con motivo, **VeriFactu excluido con motivo** (RD 1007/2023 art. 3.3: la factura se expide sin huella, sin QR ni envío y lo dice), propuesta de cambio de régimen al cierre (`GET /fiscal/regime`); cambiar el régimen exige `accounting.configure` + confirmación de alto riesgo y se bloquea si hay registros VeriFactu reales sin respuesta |
| Retenciones y nóminas | Nómina o factura de profesional sin hotel → **sin registro** → Modelo 111 / 190 incompletos (descarte silencioso) | Sin centro → 409 `WORK_CENTER_REQUIRED` + auditoría (nunca se pierde el registro); el centro de la nómina (periodo > contrato > perfil) va al asiento y a la retención; empleador y CCC desde la sociedad / el centro en la exportación de nóminas (`nif_empresa;ccc`); remesas SEPA con la sociedad como ordenante |
| Diario | Asientos sin centro invisibles en cualquier hotel («consolidado ≠ suma») | Centro obligatorio en líneas de grupos 6/7 (400 `WORK_CENTER_REQUIRED`; exentos liquidación, regularización, cierre, apertura, reverso y asiento manual «de sociedad» con `societyLevel`); etiqueta «Sociedad (sin centro)»; un centro de otra organización → 404 opaco; ejercicios solo de sociedad (400 `FISCAL_YEAR_IS_ENTITY_SCOPED`) |
| Edición del NIF | Desde el perfil de **cualquier** hotel, sin aviso | Solo en «Sociedad › Datos fiscales»: `organization.structure.manage` + `ai.high_risk.confirm` + `confirmHighRisk: true`, checksum y unicidad del NIF, auditoría; el perfil del hotel responde 409 con enlace; el 200 del cambio avisa de las series que quedan bloqueadas con el NIF anterior |
| Permisos por centro | Un director de hotel veía el 303, el diario y las cuentas anuales de los otros | Clave `accounting.entity.read` («Finanzas de toda la sociedad»): sin ella, toda lectura contable / fiscal exige un `propertyId` asignado (404 opaco `ENTITY_SCOPE_REQUIRED`) y la estructura se muestra **redactada** (sin NIF, series ni instalaciones); tesorería `?scope=entity` con la misma regla |
| Tesorería y bancos | Posición solo por hotel | Posición, cobros, pagos y previsión «Sociedad · toda» (`?scope=entity`; cuentas con y sin centro); el banco «de la sociedad» sin centro exige el flip de `bank_accounts.property_id` (aplazado, §5) |
| USALI y PyG | El total de la organización incluía asientos sin centro sin etiqueta; sin oficina | USALI comparado con columnas «Oficina central», «Sociedad (sin centro)» y total = Σ hoteles + oficina + sin asignar; PyG por centro (`GET /accounting/pnl/by-property`); reparto de la oficina **solo informativo** (fila «Reparto corporativo (informativo · no contabilizado)», base única −GOP USALI de la oficina, clave ingresos / habitaciones / plantilla / porcentajes; cero asientos) |
| Cuentas anuales | Sin etiqueta de sociedad; memoria sin establecimientos | `entityLabel` = razón social · NIF; memoria con la lista de establecimientos (código, tipo, municipio); si la sociedad es gran empresa o PGC general, el formato Pymes se marca **no depositable** (LSC 257-258) hasta la plantilla general (L10, solo si tus cifras lo exigen) |
| Alta de hoteles y oficina | Solo `createTenant` (organización + 1 hotel) y un CLI por hotel | `POST /legal-entities/:id/properties` con `dryRun` (plan, series propuestas, colisiones en vivo), el mismo servicio detrás del CLI; alta de tenant y go-live de onboarding crean la sociedad implícita y el primer centro codificado; `PATCH /properties/:id/establishment` para código, tipo, nombre comercial y censo |
| Operación y switcher | La directora cambiaba siete veces de hotel | `GET /users/me/properties` devuelve `kind`, `code`, `legalEntityId`, `legalEntityName` para agrupar «Hoteles» / «Centros no alojativos» (front L6/L7); `GET /organizations/me/structure` es el único punto de verdad (`mode: single_hotel · multi_center · group`) |

## 2. Qué NO cambia para un hotel individual (contrato de producto, diseño §5.6)

`org_123` («HotelOS Demo SL», B12345674) es el caso de control y su 303 de
2026-Q3 sigue en 27 = 71 = 86,73 con 12 registros (C9):

1. El backfill creó su sociedad implícita (`HD`) y codificó sus centros (`AMC`,
   `ATS`) sin tocar facturas, series ni asientos; `mode` = `multi_center` solo
   porque la demo tiene dos hoteles — con un solo hotel es `single_hotel`.
2. Las series conservan el prefijo plano `FAC-2026-` (prefijo condicional: con un
   solo centro facturador nada cambia); ninguna factura se renumera.
3. No hay selector de ámbito, ni columna «Centro», ni palabra «Oficina» en ningún
   sitio (eso lo decide el front por `mode`); la única novedad visible es la
   línea «Establecimiento» del PDF y la tarjeta «Tu sociedad» (L6).
4. Informes, modelos AEAT, libros, cuentas anuales y USALI dan **exactamente las
   mismas cifras** que antes (ningún cálculo cambia de ámbito: todo sigue por
   `organizationId` = la sociedad única, resuelto por `resolveLedgerScope`).
5. El alta de tenant crea Organización + Sociedad implícita + hotel codificado; el
   NIF se fija en «Datos fiscales» (o al alta desde la consola).
6. `STRUCTURE_ENABLED=false` devuelve el API al comportamiento de hotel único
   (rutas de estructura 404, sin guardia de centro en el diario) sin tocar datos.

## 3. Qué se construyó (dónde está)

| Lote | Alcance | Ficheros principales | Rutas / comandos |
|---|---|---|---|
| L1 · Schema, backfill, helpers | `LegalEntity`, `VerifactuInstallation`, `PropertyKind`, columnas de `Property` / `InvoiceSequence` / `Invoice` / `VerifactuSubmission` / `BankAccount`, 3 migraciones (aditivas, 4 triggers de inmutabilidad, drift 0), backfill idempotente, `resolveLegalIdentity` / `resolveLedgerScope` / `listOperationalProperties`, `assertSeriesPrefixFree` / `defaultSeriesPrefix`, tipos y permisos, `STRUCTURE_ENABLED` | `packages/database/prisma/schema.prisma`, `migrations/20260916100000_estructura_societaria`, `…101000_estructura_societaria_harden`, `…102000_estructura_societaria_property_immutable`, `apps/api/src/scripts/backfill-legal-structure.ts`, `apps/api/src/lib/finance-scope.ts`, `apps/api/src/modules/invoicing/series-prefix.service.ts`, `packages/shared/src/legal-structure-types.ts`, `permissions.ts` | `backfill-legal-structure.ts --dry-run | --apply --confirm <org|all>` |
| L2 · Sociedad y centros (API) | Módulo `structure`: estructura, sociedad (CRUD con 409 en la segunda), alta de centro como servicio (extraído del CLI), perfil sin NIF, `createTenant` y onboarding con sociedad implícita, `listOperationalProperties` en night audit / portfolio / pace / HF board / health, política de cadena desde la consola | `apps/api/src/modules/structure/{legal-entity.service,property-provisioning.service,structure.routes,structure.schemas,route-permissions.partial}.ts`, `backoffice.service.ts`, `tenant-admin.service.ts`, `onboarding/{onboarding,bootstrap}.service.ts`, `lib/tenancy.ts`, `scripts/provision-pilot-property.ts` | 9 rutas `/organizations/me/structure`, `/legal-entities/**`, `/properties/:id/establishment`, `/admin/legal-entities/:id/verifactu-scope` |
| L3 · Facturación | Emisor desde la sociedad + establecimiento (PDF / XML / SES), prefijo condicional y locks de numeración, cadena por instalación, `software.ts` con instalación, exclusión SII, TBAI `NumSerieDispositivo` por instalación | `apps/api/src/modules/invoicing/{issuer-identity,invoice,invoice-pdf,verifactu-submission,tbai-submission,igic-submission,simplified-invoice}.service.ts`, `packages/compliance/src/spain/verifactu/{software,xml,submitter}.ts`, `tbai/tbai.ts`, `docs/compliance/verifactu-declaracion-responsable.md` | Sin rutas nuevas (contratos aditivos en `GET /invoices/:id`, `/verifactu/submissions`) |
| L4 · Libro, retenciones, nóminas, tesorería | `WORK_CENTER_REQUIRED` en 6/7, `FiscalYear` solo sociedad, retenciones y nóminas sin descarte, empleador / CCC desde la sociedad, tesorería `scope=entity`, SEPA con la sociedad, tenencia del centro en el motor | `apps/api/src/modules/accounting/{accounting,fiscal-year,fiscal-period}.service.ts`, `posting-rules/withholding-tax.ts`, `payroll/{periods,export}.service.ts`, `treasury/{treasury,sepa-remittance}.service.ts`, `treasury.routes.ts`, `banking-spain/banking.service.ts` | `GET /treasury/*?scope=entity`, `POST /accounting/journal { societyLevel }` |
| L5 · Declarante, régimen, USALI, cuentas anuales, permisos | Declarante = sociedad con badge, régimen R8 (periodicidad forzada, «no se presenta», VeriFactu excluido, propuesta al cierre), `GET /fiscal/regime`, columna «Oficina central», PyG por centro, reparto informativo, formato no depositable, memoria con establecimientos, `accounting.entity.read` en las tres familias de rutas | `apps/api/src/modules/accounting/{modelo-303,…,vat-books,vat-settlement}.service.ts`, `{fiscal,ledger}.routes.ts`, `financial-statements/{usali,annual-accounts,pnl-by-property,allocation,gestoria-export}.service.ts`, `financial-statements.routes.ts`, `source.ts`, `packages/shared/src/{fiscal,financial-statements}-types.ts` | `GET /fiscal/regime`, `GET /accounting/pnl/by-property`, `GET|PUT /accounting/allocation`, `GET /accounting/usali/compare?includeCorporate=1` |
| Integración final | Cierre de handoffs (códigos compartidos, guardias R11 en `lib/finance-scope.ts`, `PATCH /legal-entities` con `warnings`, `patchBillingSettings` bajo lock, `Property.legalName` sin escritores, `issuers[].verifactuExclusion`), 8 casos de los triggers R10 en integración, guard de solo lectura acotado a Faranda, probe C9 de org_123 solo con la BD en reposo, documentación (runbook §17, `api-contracts.md`, `CLAUDE.md`, este informe) | `packages/shared/src/{legal-structure,accounting}-types.ts`, `lib/finance-scope.ts`, `ledger.routes.ts`, `legal-entity.service.ts`, `backoffice.service.ts`, `compliance-health.service.ts`, `ses-submission.service.ts`, `vat-books.service.ts`, `tests/integration/{legal-structure-backfill,structure-l3-fixes,structure-l5}.test.mts`, `tests/estructura-integrador-fix-contract.test.mjs` | — |

Tests de la tanda: 216 casos unitarios nuevos en 17 ficheros (`apps/api/src/**/__tests__`),
99 casos de integración in-process en 7 suites (`tests/integration/{legal-structure-backfill,
structure-l2,structure-l3,structure-l3-fixes,structure-l4,structure-l5,integrador-fix-t6b}.test.mts`,
todas sobre organizaciones que crean y borran; Faranda solo se cuenta antes y
después) y 2 contratos documentales nuevos (`tests/legal-identity-readers-contract.test.mjs`:
ningún módulo de Finanzas, compliance, search ni dashboards lee las columnas
deprecadas; `tests/estructura-integrador-fix-contract.test.mjs`: ningún módulo
escribe `Organization.taxId/legalName` ni `Property.legalName`, imports relativos a
`packages/shared/src` en lista cerrada que solo encoge, schedulers por
`listSchedulerHotels`).

## 4. Estado de la BD local (solo lectura)

Backfill ejecutado el 16/09 sobre las dos organizaciones (`--apply --confirm all`,
213 ms; segunda pasada 0 escrituras):

| Organización | Sociedad | Centros | Instalaciones | Avisos del backfill |
|---|---|---|---|---|
| Faranda `cmrhw9jy30002fyvb6tsdiugt` | `FAR` «Faranda Hotels & Resorts» · **B99999997 (ficticio)** · Pymes · cadena por centro · SII y gran empresa `false` | `RA` Hotel Faranda Rías Altas by Ascend Collection (hotel) · `LT` Faranda Los Tilos, Ascend Hotel Collection (hotel) | `DEV-001` → RA (25 facturas encadenadas, 33 envíos sandbox) | `SII_FLAG_ON_PROPERTY` (RA: el flag de propiedad no se migra sin tu decisión) |
| org_123 «HotelOS Demo SL» | `HD` · B12345674 · Pymes · por centro | `AMC` Anfitorio Madrid Centro · `ATS` Anfitorio Tenerife Sur | `DEV-001` → prop_123 · `DEV-001-ATS` → prop_canary | `SERIES_PREFIX_CLASH` (`FAC-2026-` en ambos) · `INVOICE_NUMBER_DUPLICATE` (`FAC-2026-000001` × 2) · `INSTALLATION_NUMBER_SUFFIXED` |

Faranda antes y después de toda la tanda (idéntico): 25 facturas con sus tres
NIF históricos (B00000000 × 16 · B12345678 × 5 · B99999997 × 4), 61 asientos /
150 líneas / Σ 2.595,00 = 2.595,00, 33 envíos, 0 `vat_settings`, 0
`vat_book_entries`; series `FAC-2026-` (siguiente 23) y `REC-2026-` (4) en RA,
`FAC-LT-2026-` y `REC-LT-2026-` (1) en LT, activas y enlazadas a `FAR`. Faranda
303 2026-Q3: 27 = 71 = 74,94 (37 registros); 390 2026: volumen 805,76,
resultado 74,94 (C9, sin cambio respecto al cierre de la Tanda 6). Migraciones:
8 aplicadas, drift 0, 266 tablas / 30 enums, 4 funciones / 4 triggers.

## 5. Revisión adversarial: 17 hallazgos, 17 corregidos

| Id | Sev. | Lote | Hallazgo | Estado |
|---|---|---|---|---|
| t6b#1 | alta | L3 | Dos hoteles sin código emitían a la vez el mismo número bajo un NIF (la red R3 no existía en concurrencia) | Corregido: dos advisory locks (apertura de serie por sociedad + año; número por sociedad) → 409 `INVOICE_NUMBER_DUPLICATE`, `WORK_CENTER_CODE_REQUIRED`, `SERIES_CLOSED`; el backoffice abre series bajo el mismo lock |
| t6b#2 | alta | L3 | Sociedad en SII seguía encadenando y enviando a VeriFactu | Corregido: exclusión con motivo (sin huella, QR ni envío; aviso y snapshot; anulación sin `RegistroAnulacion`; health con `verifactuExclusion`) |
| t6b#3 | media | L2 | Reactivar una serie cerrada no comprobaba a las hermanas | Corregido: `seriesPrefixToCheck` (reactivación = prefijo nuevo) |
| t6b#4 | media | L5 | Exportaciones a gestoría de toda la sociedad accesibles a un usuario de un solo centro | Corregido: la familia entera es artefacto de sociedad (404 opaco) hasta que exista `GestoriaExport.propertyId` |
| t6b#5 | media | L5 | Un usuario de un centro contabilizaba asientos de sociedad (`societyLevel`) | Corregido: `assertFinanceWriteScope` en `POST /accounting/journal` y `/reverse` |
| t6b#6 | media | L4 | `postJournalEntry` aceptaba un centro de otra organización (solo el hook HTTP lo impedía) | Corregido: `requireJournalWorkCenter` en el motor (404 opaco `PROPERTY_NOT_FOUND`, `JOURNAL_ENTRY_NOT_FOUND`) |
| t6b#7 | media | integrador | El go-live de onboarding creaba la propiedad sin sociedad / código y escribía las columnas deprecadas | Corregido: `materialiseOnboardingStructure` (sociedad implícita, `code`, `kind`, `tradeName`; contrato de escritores) |
| t6b#8 | media | L2 | `PATCH /legal-entities` cambiaba SII / gran empresa / PGC / razón social sin confirmación ni `accounting.configure` | Corregido: seis campos de alto riesgo, régimen con `accounting.configure`, 409 `VERIFACTU_SUBMISSIONS_PENDING` |
| t6b#9 | baja | integrador | La estructura y la sociedad completas se leían con `accounting.read` (recepción veía NIF, series, instalaciones) | Corregido: redacción a los centros asignados; `GET /legal-entities/:id` con `accounting.entity.read` |
| t6b#10 | baja | L1 | R10.5 (centro con facturas no cambia de sociedad) sin protección en BD | Corregido: migración `20260916102000` (triggers R10.1 / R10.5 y sociedad pinada a su organización); 8 casos de integración |
| t6b#11 | baja | L3 | Tras cambiar el NIF, la serie quedaba bloqueada con un mensaje que remitía a la pantalla antigua | Corregido: regla de emisor por prefijo impreso, mensaje con base legal y los dos caminos, `warnings[]` en el 200 del PATCH |
| t6b#12 | baja | integrador | La carpeta de inspección, el buscador y el resumen de propiedad leían `Property.legalName` como razón social | Corregido: titular = sociedad; `tradeName` / `code`; contrato C8 ampliado a compliance, search y dashboards |
| t6b#13 | baja | integrador | Los schedulers de cupos y cut-off iteraban todas las propiedades (oficina incluida) | Corregido: `listSchedulerHotels` sobre `listOperationalProperties` |
| t6b#14 | baja | integrador | Imports relativos a `packages/shared/src` en tres ficheros de L5 | Corregido: `@hotelos/shared`; lista cerrada de 22 heredados que solo encoge |
| t6b#15 | baja | L4 | Tesorería `?scope=entity` respondía 403 y exigía la clave explícita | Corregido: misma regla que el resto de lecturas de sociedad (404 opaco `ENTITY_SCOPE_REQUIRED`) |
| t6b#16 | baja | L5 | USALI y PyG por centro repartían importes distintos y un coste negativo se repartía como ingreso | Corregido: base única −GOP USALI; GOP ≥ 0 → no se reparte (aviso); `basis` / `basisLabel` |
| t6b#17 | baja | L2 | El bloque `issuers` del health incluía la oficina central | Corregido: `selectIssuerProperties` (oficina solo con serie activa) |

Detalle, decisiones y lo que se dejó deliberadamente sin cambiar: runbook §17.6 y §17.10.

## 6. Decisiones de esta tanda que conviene que conozcas

- **Una sola sociedad por organización**: `POST /legal-entities` responde 409
  `MULTI_ENTITY_NOT_ENABLED` en la segunda. La fase grupo (varias sociedades,
  agregado informativo, certificados por sociedad) está diseñada (§5.7) pero no
  construida: se activa si existe otra sociedad del grupo con relación económica
  con CELUISMA (pregunta 3 de §8).
- **Cadena VeriFactu por centro por defecto** (`per_center`: cada hotel es un
  «centro de facturación independiente» con su instalación declarada), con
  `per_entity` disponible sin re-encadenar. La elección la fija la consola de
  plataforma por sociedad antes de la primera emisión real y consta en la
  declaración responsable; hoy no existe ninguna cadena real (todo sandbox).
- **Reparto de la oficina solo informativo**: cero asientos; base única −GOP
  USALI de la oficina; la etiqueta «informativo · no contabilizado» acompaña a
  cada fila y a la exportación. Un reparto contabilizado exigiría petición
  escrita del asesor.
- **Régimen SII / gran empresa en la sociedad**: la periodicidad forzada no se
  escribe en `VatSettings` (es efectiva en lectura); el SII como tal (envío de
  libros) **no** se construye y la UI lo dirá.
- **Índices únicos de prefijo y número aplazados** hasta limpiar org_123 (L8):
  mientras tanto la unicidad la garantizan `assertSeriesPrefixFree` y los dos
  advisory locks, verificados con emisión concurrente.
- **`Property.legalName`, `Organization.taxId/legalName` y
  `PropertyComplianceSetting.siiEnabled` quedan deprecados** (columnas
  conservadas, marcadas en el schema, sin lectores ni escritores en el API): se
  retiran en una tanda posterior con su migración.

## 7. Lo que necesita el front (L6 / L7, siguiente workflow)

Ninguna pantalla de `admin-web` consume todavía las rutas de la estructura
(`grep legal-entities apps/admin-web/src` = 0). Contratos en
`packages/shared/src/legal-structure-types.ts`, `fiscal-types.ts`,
`financial-statements-types.ts`, `treasury-types.ts`, `payments-types.ts`
(importes como cadenas, fechas `AAAA-MM-DD`, errores con `details.code`).

| Pantalla | Qué debe hacer | Rutas / contrato |
|---|---|---|
| **Configuración › Estructura societaria** (L6, nueva, `/configuracion/estructura`) | Split lista / detalle con pestañas Datos fiscales · Centros · Series y VeriFactu · IVA y ejercicio · Reparto (diseño §5.3); `mode` decide si es «Tu sociedad + Este hotel» (hotel individual) o la tabla de centros; con `scope: "assigned_properties"` ocultar Datos fiscales / Series / IVA y no mostrar «NIF pendiente» (`taxId` null por redacción) | `GET /organizations/me/structure`, `GET|PATCH /legal-entities/:id` (`LegalEntityPatchResponse.warnings`), `GET …/series`, `GET …/verifactu/installations`, `GET|PUT /accounting/allocation`, `GET|PUT /fiscal/vat-settings`, `GET /fiscal/regime` |
| Datos fiscales / IVA y ejercicio (L6) | NIF con checksum en vivo; `ConfirmDialog` de alto riesgo y reenvío con `confirmHighRisk: true`; pintar 409 `HIGH_RISK_CONFIRMATION_REQUIRED` con `details.fields` / `details.changes` (mensaje ya redactado con base legal), 409 `VERIFACTU_SUBMISSIONS_PENDING` como callout bloqueante, `warnings[]` del 200 (series bloqueadas por el NIF anterior); `CocoaSwitch` «Gran empresa / SII» y variante PGC gateados con `accounting.configure` además de `organization.structure.manage`; 409 `PERIODICITY_FORCED_BY_REGIME` | `PATCH /legal-entities/:id`, `PUT /fiscal/vat-settings` |
| Añadir centro (L6, asistente) | Pasos tipo y nombre → ubicación fiscal → facturación (solo hotel / otro; series propuestas con «Libre» / «Ya usado por …» vía `dryRun`) → resumen; exigir código cuando la sociedad ya factura en otro centro (409 `WORK_CENTER_CODE_REQUIRED` en la emisión) | `POST /legal-entities/:id/properties { …spec, dryRun }` → `plan.writes/skips/conflicts`, `series[]`, `prefixClash[]`, `property.code`; 409 `PROPERTY_NAME_IN_USE` / `CODE_IN_USE` / `SERIES_PREFIX_CLASH` |
| Ficha de centro (L6) | Sin NIF ni razón social (callout «Factura como <sociedad> · <NIF> — editar en Datos fiscales»); código, tipo, nombre comercial, censo; sin «Mover a otra sociedad» | `PATCH /properties/:id/establishment`; 409 `PROPERTY_KIND_CHANGE_BLOCKED` |
| Perfil del establecimiento (`PropertySetupForms.tsx`, L6) | Los campos `legalName` / `taxId` ya no existen en la definición del formulario (`tradeName` «Nombre comercial (en factura)» y `code`); `values` los devuelve en solo lectura; 409 `LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY { fields, legalEntityId, route }` → enlace a Estructura societaria | `PATCH /backoffice/properties/:id/setup/property_profile` |
| Consola de tenants (L6) | Alta con `legalEntity { legalName, taxId, code, legalForm }` y `property.kind / code`; política de cadena por sociedad con `confirm: true` (solo plataforma) | `POST /admin/tenants`, `POST /admin/legal-entities/:id/verifactu-scope` |
| Selector «Ámbito» único en Finanzas y Cumplimiento (L7, `services/financeScope.ts`) | «Sociedad · <razón social> (todo)» / «Centro · <hotel> (<código>)» / «Centro · Oficina central (OC)», estado separado del hotel activo, eyebrow y banner de shell; matriz forzado / defecto / filtro del diseño §5.3; oculto con un solo centro; usuario sin `accounting.entity.read` no ve la opción «Sociedad» | `propertyId` / `?scope=entity` en las lecturas; 404 `ENTITY_SCOPE_REQUIRED` |
| Modelos AEAT, libros, liquidación (L7, `FiscalModelReport.tsx`, `VatSettlementScreen.tsx`) | Badge «Declarante · razón social · NIF» desde `report.sociedad`; `presentacion.noSePresenta.motivo` como callout warning; avisos de régimen y «vista parcial, no liquidable»; texto «organización» → «sociedad»; pestaña «IVA y ejercicio» con `GET /fiscal/regime` (propuesta) | `FiscalDeclaranteBadge`, `FiscalRegimeSummary`, `FiscalRegimeReport` |
| USALI y PyG (L7, `UsaliScreen.tsx`, `ProfitAndLossScreen.tsx`) | Pedir `includeCorporate=1[&allocation=]`; columnas «Oficina central», «Sociedad (sin centro)», `rollup` y fila `allocation` con su `label` y `basisLabel`; vista «Por centro» con `GET /accounting/pnl/by-property`; `CocoaSwitch` «Aplicar reparto de oficina central (informativo)» | `CorporateAllocationResult`, `PnlByProperty` |
| Cuentas anuales (L7, `AnnualAccountsScreen.tsx`) | `entityLabel`, `format.depositable / reason` (bloqueo Pymes no depositable), `memoria.entity.properties[].code / kind` | `GET /accounting/annual-accounts*` |
| Tesorería y conciliación (L7, `treasuryApi.ts`) | `scope`, `propertyId: null` → «Sociedad · sin centro», `legalEntityId`, `entityLabel`, `banks[].propertyId`; `?scope=entity` por defecto en el ámbito Sociedad | `GET /treasury/*` |
| Facturación y cobros (L7, `BillingCenterScreen.tsx`, detalle de factura) | `issuer.establishment { code, tradeName, addressLine }` y `fiscalAddress`; badge «VeriFactu no aplica (SII)» con `issuer.verifactuExclusion` / `warnings` con prefijo `VERIFACTU_EXCLUDED_BY_SII:`; Envíos con `installationId` y `software.numeroInstalacion` | `InvoiceIssuer`, `VerifactuSubmissionListItem` |
| Nóminas (L7, `PayrollScreen.tsx`) | Bloque `employer` (NIF / razón social / CCC y sus avisos); CSV con `nif_empresa;ccc`; 409 `WORK_CENTER_REQUIRED` («Indica el hotel o la oficina central») | `PayrollExportResult.employer` |
| Switcher operativo (L7, `TopBar.tsx`, `activeProperty.ts`, nav-tree) | Agrupar «Hoteles» / «Centros no alojativos»; ocultar la oficina en Hoy / Recepción / Operaciones / Comercial / Revenue (gating por `propertyKind`); un usuario asignado solo a la oficina aterriza en `/finanzas/contabilidad` | `GET /users/me/properties` (`kind`, `code`, `legalEntityId`, `legalEntityName`) |
| `FINANCE_ERROR_MESSAGES` (`services/finance-contracts.ts`) | Textos para `SERIES_PREFIX_CLASH`, `INVOICE_NUMBER_DUPLICATE`, `WORK_CENTER_CODE_REQUIRED`, `SERIES_CLOSED`, `ISSUER_TAX_ID_SERIES_MISMATCH` (con `details.prefix`, `legalIdentityScreen`, `seriesScreen`), `WORK_CENTER_REQUIRED`, `FISCAL_YEAR_IS_ENTITY_SCOPED`, `ENTITY_SCOPE_REQUIRED`, `PROPERTY_NOT_FOUND`, `JOURNAL_ENTRY_NOT_FOUND`, `PERIODICITY_FORCED_BY_REGIME`, `ALLOCATION_*`, `HIGH_RISK_CONFIRMATION_REQUIRED`, `VERIFACTU_SUBMISSIONS_PENDING`, `VERIFACTU_EXCLUDED_BY_SII`, `LEGAL_IDENTITY_MANAGED_BY_LEGAL_ENTITY`, `MULTI_ENTITY_NOT_ENABLED`, `CODE_IN_USE`, `PROPERTY_KIND_CHANGE_BLOCKED`, `PROPERTY_NAME_IN_USE`, `WORK_CENTER_NOT_OPERATIONAL`, `STRUCTURE_DISABLED`, `TAX_ID_INVALID`, `TAX_ID_IN_USE`, `CHAIN_ALREADY_STARTED` | `LegalStructureErrorCode`, `LEDGER_ERROR_CODES` |

Permisos: las entradas de Estructura societaria se gatean con
`organization.structure.manage`; el ámbito «Sociedad» y Modelos AEAT / Cuentas
anuales de toda la sociedad con `accounting.entity.read` (`canDo(useNavGate(), clave)`
sobre las concesiones reales). Hasta `rbac:sync` un rol creado antes de la tanda
no tiene las claves nuevas (en dev la unión demo las concede a toda sesión real).

## 8. Migración de Faranda a CELUISMA (L8): lista exacta de lo que solo tú puedes aportar

Nada de esto está hardcodeado: los specs de L8 son parametrizados y no se
ejecutan sin tus respuestas. El NIF real A33615980 entra en la demo local solo
con tu consentimiento explícito y **nunca** se remite a preproducción ni
producción de la AEAT sin mandato de CELUISMA.

| # | Dato / decisión | Para qué | Formato que necesitamos |
|---|---|---|---|
| 1 | **Sociedad**: razón social exacta (CELUISMA S.A.), forma jurídica, CNAE (5510 según datos públicos), **domicilio fiscal** (Portugal 7, 33207 Gijón según el Registro; ¿o General Ampudia 8, Madrid?), domicilio social si difiere, Registro Mercantil, CCC principal de la Seguridad Social | `LegalEntity` (`legalName`, `legalForm`, `cnae`, `fiscalAddress/PostalCode/Municipality/Province`, `registeredOffice*`, `mercantileRegistry`, `cccPrincipal`); cabecera de todas las facturas | Texto tal como figura en el 036 / escrituras |
| 2 | **Consentimiento** para usar A33615980 en la demo local (hoy B99999997) | Paso 2 de la migración; el NIF es único y con checksum | Sí / no; si no, seguimos con el ficticio hasta producción |
| 3 | **Los 7 hoteles que explota A33615980** (la web lista 5 Faranda + 2 City House; los datos públicos —18 empleados, 2,5 M€— no cuadran con explotar 7 hoteles: confírmalo) y, por hotel: nombre comercial, dirección, CP, municipio, provincia, categoría (estrellas), plazas / habitaciones, registro turístico, código SES si lo tiene, CCC provincial si difiere, referencia catastral y epígrafe IAE si los tenéis, mes de apertura / cierre si es estacional | Specs `apps/api/src/scripts/specs/faranda-*.json` → `Property` (`kind: hotel`, `code`, `tradeName`, censales), series `FAC-<COD>-2026-`, `FS-<COD>-2026-`, `REC-<COD>-2026-`, instalación VeriFactu | Una fila por hotel (hoja o tabla); proponemos códigos RA · LT · PG · MC · AS · FN · LL, cámbialos si queréis otros |
| 4 | **Oficina central**: dónde está (Gijón o Madrid), dirección completa, superficie (IAE por superficie), CCC provincial, si emite alguna factura (si no, sin series) | `Property { kind: office, code: OC }`; nóminas, gastos, bancos e inmovilizado de la sede | Dirección + m² + CCC |
| 5 | **Cifras 2024 y 2025 de CELUISMA**: activo, cifra de negocios, plantilla media; si audita; **volumen de operaciones IVA** | PGC Pymes vs general (4 / 8 M€, 50 empleados → lote L10 «plantilla PGC general hotelero») y gran empresa / SII (> 6.010.121,04 € → 303 mensual, sin 347 / 390, **VeriFactu no aplicaría**) | Tres cifras por ejercicio + sí / no auditoría |
| 6 | **Régimen de IVA actual** (trimestral vs mensual / REDEME / SII), prorrata si hay actividad exenta, e **inicio del ejercicio** (natural?) | `VatSettings` de la sociedad, `LegalEntity.siiEnabled / largeCompany / fiscalYearStartMonth`, `FiscalYear 2026`; hoy Rías Altas tiene `sii_enabled = true` en su configuración de cumplimiento (residuo): confirma si CELUISMA está en el SII | Trimestral / mensual; SII sí / no; prorrata %; mes de inicio |
| 7 | **¿Existe otra sociedad del grupo** con relación económica con CELUISMA (propietaria de inmuebles que cobre alquiler, gestora que preste servicios, Faranda International Hotels S.L., B87303095)? | Adelantaría la fase grupo (segunda sociedad, honorarios / alquileres intragrupo a valor de mercado, LIS 18.5) y levantaría el 409 `MULTI_ENTITY_NOT_ENABLED` | Sí / no + nombre y NIF de la sociedad y tipo de relación |
| 8 | **Clave de reparto de la oficina central** que usa hoy la dirección (ninguna, ingresos, habitaciones, plantilla, porcentajes por hotel) | `corporateAllocation` por defecto (pestaña «Reparto», fila informativa en USALI y PyG) | Una de las cinco; si porcentajes, la tabla hotel → % (suma 100) |
| 9 | **Decisión del asesor fiscal sobre la cadena VeriFactu**: una instalación por hotel («centros de facturación independientes», por defecto) o una por sociedad | `verifactuChainScope` fijado desde la consola antes de la primera emisión real; consta en la declaración responsable y no se deshace sin retirar instalaciones | Por centro / por sociedad, por escrito |
| 10 | **Números de instalación reales** del registro del productor (uno por hotel con `per_center`; uno con `per_entity`) y certificado electrónico del representante | Retirar las instalaciones de relleno `DEV-001` y abrir las reales antes de `VERIFACTU_MODE=preproduction` (la cadena nueva empieza en `PrimerRegistro`) | Números tal como constan en el registro; certificado por canal seguro |
| 11 | **Series de Rías Altas**: cerrar `FAC-2026-` / `REC-2026-` (sandbox con tres NIF de prueba) y abrir `FAC-RA-2026-`, `FS-RA-2026-`, `REC-RA-2026-`; Los Tilos ya usa `-LT-`. Ninguna factura se renumera ni se reescribe | Paso 6 de la migración; la clave `(propertyId, sequenceCode, year)` obliga a liberar la fila sandbox (`active = false`, `sequence_code = FAC-SANDBOX`) antes de abrir la nueva | Confirmación |
| 12 | **Personas**: quién es Owner + «Finanzas de toda la sociedad» + «Estructura» (`direccion@farandariasaltas.es`), qué directores quedan limitados a su hotel, qué contratos son de la oficina | `accounting.entity.read`, `organization.structure.manage`, `user_property_roles`, `propertyId = OC` en contratos | Lista nombre → rol → centro |
| 13 | **Autorización para `rbac:sync`** (escribe `role_permissions` de Faranda: Owner +2, Dirección +1, Contabilidad +1) y para ejecutar el backfill y la migración en el VPS con backup y API parado | Sin el sync, Dirección y Contabilidad reciben 404 `ENTITY_SCOPE_REQUIRED` en las lecturas de toda la sociedad cuando la unión demo está apagada | Sí / no y ventana |
| 14 | **Decisiones sobre org_123** (demo): cerrar `FAC-2026-` de Anfitorio Tenerife Sur (`prop_canary`) y qué hacer con la factura `FAC-2026-000001` duplicada (sandbox con NIF de relleno) | Precondición para crear los índices únicos de prefijo y número por sociedad | Cerrar la serie (nunca renumerar) y conservar / anular la factura duplicada |

Cuando tengamos 1-12, L8 genera los specs, ejecuta `backfill` / `migrate-faranda-celuisma.ts` en dry-run, te enseña el plan (8 centros, `mode: multi_center`, 0 colisiones) y solo entonces se aplica.

## 9. Puertas (2026-09-16, working tree completo, sin commit)

| Puerta | Resultado |
|---|---|
| typecheck-all (`--parallel 2`) | 15 PASS · 0 FAIL · 1 SKIP explícito (apps/guest-web) · 22,3 s |
| Discoverability | 216 screens · 183/183 URLs · 0 broken links · placeholders 16/20 |
| Contratos (`tests/*.test.mjs`) | 431/431 (+21 casos en los 2 contratos nuevos) |
| Unitarios API | 1.456 (1.455 pass · 1 skipped preexistente · 0 fail); 216 casos nuevos |
| Integración (21 suites in-process sobre Postgres; 7 de la tanda con 99 casos) | 294 (289 pass · 0 fail · 5 skipped preexistentes, los mismos del cierre de la Tanda 6) |
| env-census / validate-env | 137/137 · contrato OK (14 avisos de valores de ejemplo) |
| Migraciones | 8/8 aplicadas · drift 0 · migraciones↔schema 266 tablas / 30 enums |
| Fresh-install (BD temporal) | OK (8 migraciones → 266 tablas, 79 permisos, 4 funciones / 4 triggers declarados, 4 s) |
| `install --frozen-lockfile --offline` | al día |
| `rbac:sync --dry-run` | 223 claves · +0 · 6 roles por completar + Local Super Admin +2 (no aplicado) |
| `.husky/pre-commit` | OK |
| Faranda (solo lectura) | 25 facturas · 61 asientos / 150 líneas / Σ 2.595,00 · 33 envíos, idéntico antes y después de todas las suites; 0 organizaciones de prueba residuales |

No hay commit: el árbol queda listo para que lo revises. Los API :3000 y :5173
siguen sirviendo el código anterior; tras reiniciarlos toca repetir
`test:integration` (una sola instancia del API: la clave del lock de cadena
cambia de `<propertyId>` a `installation:<id>`).

## 10. Deuda técnica que queda (resumen; detalle en runbook §17.10 y `CLAUDE.md` deuda 15)

- DDL aplazado: `prefix` / `legal_entity_id` `SET NOT NULL` (tras el backfill
  del VPS, 0 `NULL` en local); índices únicos `(legal_entity_id, upper(prefix),
  year)` y parcial `(legal_entity_id, invoice_number)` (tras limpiar org_123);
  `bank_accounts.property_id DROP NOT NULL` (≈ 50 referencias en banking; banco
  de la sociedad provisionalmente en la oficina); `TbaiSubmission.installationId`
  (la cadena TicketBAI sigue por centro y territorio); `GestoriaExport.propertyId`
  (ámbito por fila); FK de `JournalEntry.propertyId`.
- La activación de VeriFactu en un centro nuevo no abre todavía su
  `verifactu_installations` (backfill, consola o SQL); en modos reales el centro
  queda en `INSTALLATION_NOT_DECLARED` hasta que exista.
- `rbac:sync` pendiente (escribe el piloto); STRUCTURE_ENABLED como interruptor.
- Front L6 / L7 y migración L8 sin construir; plantilla PGC general (L10) solo si
  tus cifras lo exigen.
- La probe org_123 de C9 solo compara cifras con la BD en reposo (las suites
  hermanas escriben org_123 en paralelo); Faranda se compara siempre.
- Deuda heredada de la Tanda 6 sin cambio (runbook §12 / §15): `SepaRemittance`
  sin modelo, `Payment.method` / `JournalEntry.sourceType` como `String`, PDF /
  XLSX sin diseño, adjuntos y exportaciones inline, cadena de auditoría en
  memoria bifurcada por los CLI ejecutados con el API en marcha (se resuelve al
  reiniciar).
