/**
 * Importación contable desde Sage 200 (Tanda 7c · L0, 2026-09-17): contrato wire entre el
 * API (`apps/api/src/modules/accounting/import/*`, rutas `/accounting/ledger-imports*` y
 * `/accounting/ledger-imports/reconciliation`, el CLI `sage200:import`) y el admin-web
 * (Finanzas › Contabilidad › «Importar desde Sage 200»).
 *
 * Qué es. Sage 200 sigue siendo el sistema contable de registro de la sociedad (modo
 * sombra): administración exporta el plan de cuentas, los ejercicios y la apertura, el
 * diario, los libros de IVA, los terceros y los saldos por periodo; Anfitorio los importa
 * por LOTES (`LedgerImport`: un fichero de un tipo, identificado por el sha256 de las filas
 * normalizadas tras el mapeo), los pasa por un mapa de cuentas persistente Sage → PGC Pymes
 * hotelero (`LedgerAccountMap`, las 7 reglas del diseño §4.4) y por un mapa analítico
 * (`LedgerAnalyticsMap`: canal / delegación / departamento / sección / proyecto → centro de
 * trabajo y centro de coste USALI, §4.5) y contabiliza SIEMPRE por `postJournalEntry`: un
 * asiento por (asiento Sage, centro) con `sourceType sage200_journal`, o un asiento resumen
 * por (ejercicio, periodo, centro) con `sourceType sage200_balance` para los ejercicios sin
 * diario (§6). Los documentos nativos de Anfitorio (facturas emitidas y sus cobros) se
 * EXCLUYEN del lote (`skipped_native`, §5.1): nada se duplica ni se marca. La reconciliación
 * (`LedgerReconciliation`, §5.2) compara el balance de sumas y saldos de Sage con el diario
 * de Anfitorio por cuenta destino y periodo, con tolerancias y clasificación por diferencia.
 *
 * Convenciones (docs/design/FINANZAS-IMPORTACION-SAGE200.md §4.2, §4.6, §7.2):
 *   · Dinero como `MoneyString` ("1234.56", dos decimales, punto): el API calcula con
 *     Prisma.Decimal y nunca expone floats; el front solo formatea.
 *   · Meses como `periodCode` "YYYY-MM" (saldos: también "YYYY-Qn", "YYYY" o "apertura");
 *     fechas contables como `IsoDate` "YYYY-MM-DD"; instantes (`…At`) como ISO.
 *   · `entryNumber` lo asigna siempre el motor por (organización, ejercicio): el número de
 *     asiento de Sage viaja en `sourceEntryNumber` y en `JournalEntry.reference`.
 *   · Los estados de las tablas nuevas son texto con catálogo aquí, salvo
 *     `LedgerImport.status` (enum Prisma `LedgerImportStatus`, como el lote de nómina).
 *   · `propertyCode` "SOC" = fila a nivel sociedad (la unicidad no puede apoyarse en un
 *     `propertyId` NULL, semántica NULL de PostgreSQL).
 *   · Fixtures y ejemplos: empresa Sage ficticia, sin NIF reales.
 *
 * Sin dependencias de runtime; los imports son solo de tipo.
 */

import type { JournalEntryKind, JournalSourceType } from "./accounting-types.js";
import type { IsoDate, MoneyString, UsaliDepartmentKey, UsaliLineKey } from "./financial-statements-types.js";
import type { VatBookSourceTypeCode } from "./fiscal-types.js";

// ---------------------------------------------------------------------------
// Sistemas, tipos de lote, formatos y estados (diseño §4.1, §4.2, §4.3)
// ---------------------------------------------------------------------------

/** Sistemas contables de origen (`LedgerImport.system`, `LedgerAccountMap.system`, `LedgerAnalyticsMap.system`, `LedgerThirdParty.system`); extensible a contaplus / a3. */
export const LEDGER_IMPORT_SYSTEMS = ["sage200"] as const;
export type LedgerImportSystem = (typeof LEDGER_IMPORT_SYSTEMS)[number];

export const LEDGER_IMPORT_SYSTEM_LABELS_ES: Readonly<Record<LedgerImportSystem, string>> = Object.freeze({
  sage200: "Sage 200"
});

/** Sistema de toda la Tanda 7c. La columna `system` no lleva DEFAULT en la BD: el servicio lo escribe siempre. */
export const LEDGER_IMPORT_DEFAULT_SYSTEM = "sage200" as const satisfies LedgerImportSystem;

/**
 * Tipos de lote (`LedgerImport.kind`), IDÉNTICOS a los valores de `--type` del CLI `sage200:import`.
 * Orden recomendado de carga: plan → fiscal_years → journal → vat_books → third_parties → balances (§4.1).
 */
export const LEDGER_IMPORT_KINDS = ["plan", "fiscal_years", "journal", "vat_books", "third_parties", "balances"] as const;
export type LedgerImportKind = (typeof LEDGER_IMPORT_KINDS)[number];

export const LEDGER_IMPORT_KIND_LABELS_ES: Readonly<Record<LedgerImportKind, string>> = Object.freeze({
  plan: "Plan de cuentas",
  fiscal_years: "Ejercicios y apertura",
  journal: "Diario",
  vat_books: "Libros de IVA",
  third_parties: "Clientes y proveedores",
  balances: "Sumas y saldos por periodo"
});

/** Formatos de entrada (`LedgerImport.format`), §4.3. */
export const LEDGER_IMPORT_FORMATS = ["sage_excel", "sage_ime_csv", "sage_xml", "canonical_csv", "canonical_json"] as const;
export type LedgerImportFormat = (typeof LEDGER_IMPORT_FORMATS)[number];

export const LEDGER_IMPORT_FORMAT_LABELS_ES: Readonly<Record<LedgerImportFormat, string>> = Object.freeze({
  sage_excel: "Excel o CSV exportado de Sage 200",
  sage_ime_csv: "CSV de asientos de Sage 200 (formato de importación, 60 columnas)",
  sage_xml: "XML «Datos contables» de Sage 200",
  canonical_csv: "CSV canónico de Anfitorio",
  canonical_json: "JSON canónico de Anfitorio"
});

/** `LedgerImport.status` (enum Prisma `LedgerImportStatus`): draft (previsualizado, nada escrito) → posted → reversed. */
export const LEDGER_IMPORT_STATUSES = ["draft", "posted", "reversed"] as const;
export type LedgerImportStatusCode = (typeof LEDGER_IMPORT_STATUSES)[number];

export const LEDGER_IMPORT_STATUS_LABELS_ES: Readonly<Record<LedgerImportStatusCode, string>> = Object.freeze({
  draft: "Borrador",
  posted: "Contabilizado",
  reversed: "Revertido"
});

/** `LedgerImportEntry.status`: qué pasó con cada asiento Sage del lote. */
export const LEDGER_IMPORT_ENTRY_STATUSES = ["draft", "posted", "skipped_native", "skipped_existing", "unmapped", "unbalanced", "error"] as const;
export type LedgerImportEntryStatus = (typeof LEDGER_IMPORT_ENTRY_STATUSES)[number];

export const LEDGER_IMPORT_ENTRY_STATUS_LABELS_ES: Readonly<Record<LedgerImportEntryStatus, string>> = Object.freeze({
  draft: "Previsualizado",
  posted: "Contabilizado",
  skipped_native: "Omitido: documento propio de Anfitorio",
  skipped_existing: "Omitido: ya importado",
  unmapped: "Cuenta o analítica sin mapear",
  unbalanced: "Descuadrado",
  error: "Error"
});

/** Tipos de asiento que el lote reconoce (`LedgerImportEntry.entryKind`): apertura y cierres de Sage; nunca `reversal`. */
export const LEDGER_IMPORT_ENTRY_KINDS = ["normal", "opening", "regularization", "closing"] as const satisfies readonly JournalEntryKind[];
export type LedgerImportEntryKind = (typeof LEDGER_IMPORT_ENTRY_KINDS)[number];

export const LEDGER_IMPORT_ENTRY_KIND_LABELS_ES: Readonly<Record<LedgerImportEntryKind, string>> = Object.freeze({
  normal: "Asiento normal",
  opening: "Apertura",
  regularization: "Regularización (cierre de ejercicio de Sage)",
  closing: "Cierre (cierre de contabilidad de Sage)"
});

// ---------------------------------------------------------------------------
// Mapa de cuentas (§4.4) y mapa analítico (§4.5)
// ---------------------------------------------------------------------------

/** `LedgerAccountMap.action`: map (cuenta existente) · map_by_rate (472/477 + PorIva → prefijo.tipo apunte a apunte) · create (subcuenta nueva) · collapse (tercero → 4300 / 400 / 410) · block (no contabiliza). */
export const LEDGER_ACCOUNT_MAP_ACTIONS = ["map", "map_by_rate", "create", "collapse", "block"] as const;
export type LedgerAccountMapAction = (typeof LEDGER_ACCOUNT_MAP_ACTIONS)[number];

export const LEDGER_ACCOUNT_MAP_ACTION_LABELS_ES: Readonly<Record<LedgerAccountMapAction, string>> = Object.freeze({
  map: "Cuenta existente",
  map_by_rate: "Cuenta de IVA por tipo",
  create: "Crear subcuenta",
  collapse: "Agrupar tercero",
  block: "Bloquear"
});

/** `LedgerAnalyticsMap.dimension`: las cinco dimensiones analíticas de un apunte Sage. */
export const LEDGER_ANALYTICS_DIMENSIONS = ["canal", "delegacion", "departamento", "seccion", "proyecto"] as const;
export type LedgerAnalyticsDimension = (typeof LEDGER_ANALYTICS_DIMENSIONS)[number];

export const LEDGER_ANALYTICS_DIMENSION_LABELS_ES: Readonly<Record<LedgerAnalyticsDimension, string>> = Object.freeze({
  canal: "Canal",
  delegacion: "Delegación",
  departamento: "Departamento",
  seccion: "Sección",
  proyecto: "Proyecto"
});

/** Dimensión que identifica el hotel / oficina por defecto (César confirma cuál usan). */
export const LEDGER_DEFAULT_CENTRE_DIMENSION = "delegacion" as const satisfies LedgerAnalyticsDimension;
/** Dimensión que identifica el centro de coste USALI por defecto. */
export const LEDGER_DEFAULT_COST_CENTRE_DIMENSION = "departamento" as const satisfies LedgerAnalyticsDimension;

/** Códigos de centro de coste USALI admitidos en `LedgerAnalyticsMap.costCentreCode` (`cost_centers.code`, type usali). */
export const LEDGER_USALI_COST_CENTRE_CODES = ["ROOMS", "FNB", "POM", "ADMIN_GENERAL", "SALES_MARKETING", "OTHER_OPERATED", "IT"] as const;
export type LedgerUsaliCostCentreCode = (typeof LEDGER_USALI_COST_CENTRE_CODES)[number];

/**
 * Política para apuntes de grupos 6/7 SIN analítica de centro (R4 exige centro): `block` (defecto: la
 * previsualización los lista y bloquea) · `office` (van a la oficina central, como el coste de
 * personal) · `property:<propertyId>` (cadena libre documentada: van a ese centro). Nunca
 * `societyLevel`: mezclaría lo importado con lo manual.
 */
export const LEDGER_UNASSIGNED_POLICIES = ["block", "office"] as const;
export type LedgerUnassignedPolicyBase = (typeof LEDGER_UNASSIGNED_POLICIES)[number];
export const LEDGER_UNASSIGNED_POLICY_PROPERTY_PREFIX = "property:" as const;
export type LedgerUnassignedPolicy = LedgerUnassignedPolicyBase | `${typeof LEDGER_UNASSIGNED_POLICY_PROPERTY_PREFIX}${string}`;

export const LEDGER_UNASSIGNED_POLICY_LABELS_ES: Readonly<Record<LedgerUnassignedPolicyBase, string>> = Object.freeze({
  block: "Bloquear el lote hasta asignar centro",
  office: "Imputar a la oficina central"
});

/** `property:<propertyId>`: política que imputa los apuntes 6/7 sin analítica a ese centro. */
export function ledgerUnassignedPolicyForProperty(propertyId: string): LedgerUnassignedPolicy {
  return `${LEDGER_UNASSIGNED_POLICY_PROPERTY_PREFIX}${propertyId}`;
}

export function isLedgerUnassignedPolicy(value: string): value is LedgerUnassignedPolicy {
  return (LEDGER_UNASSIGNED_POLICIES as readonly string[]).includes(value) || (value.startsWith(LEDGER_UNASSIGNED_POLICY_PROPERTY_PREFIX) && value.length > LEDGER_UNASSIGNED_POLICY_PROPERTY_PREFIX.length);
}

/** `LedgerThirdParty.role`. */
export const LEDGER_THIRD_PARTY_ROLES = ["customer", "supplier"] as const;
export type LedgerThirdPartyRole = (typeof LEDGER_THIRD_PARTY_ROLES)[number];

export const LEDGER_THIRD_PARTY_ROLE_LABELS_ES: Readonly<Record<LedgerThirdPartyRole, string>> = Object.freeze({
  customer: "Cliente",
  supplier: "Proveedor"
});

// ---------------------------------------------------------------------------
// sourceType / sourceId de lo importado (§4.6)
// ---------------------------------------------------------------------------

/** `JournalEntry.sourceType` de los asientos importados (ambos en JOURNAL_SOURCE_TYPES). */
export const LEDGER_IMPORT_SOURCE_TYPES = {
  /** Diario: un asiento por (asiento Sage, centro). */
  journal: "sage200_journal",
  /** Saldos: un asiento resumen por (ejercicio, periodo, centro) y la apertura del ejercicio. */
  balance: "sage200_balance"
} as const satisfies Record<string, JournalSourceType>;
export type LedgerImportSourceType = (typeof LEDGER_IMPORT_SOURCE_TYPES)[keyof typeof LEDGER_IMPORT_SOURCE_TYPES];

/** `VatBookEntry.sourceType` de las filas de libros importadas (valor `sage200` de `VatBookSourceType`; `rebuildVatBooks` las conserva). */
export const LEDGER_VAT_BOOK_SOURCE_TYPE = "sage200" as const satisfies VatBookSourceTypeCode;

/** `propertyCode` de una fila a nivel sociedad (`LedgerImportEntry`, `LedgerImportBalance`, sufijo de `sourceId`). */
export const LEDGER_IMPORT_SOCIETY_PROPERTY_CODE = "SOC" as const;
/** `periodCode` del saldo de apertura de un ejercicio (`LedgerImportBalance`, `sourceId` del asiento opening). */
export const LEDGER_IMPORT_OPENING_PERIOD_CODE = "apertura" as const;
/** Separador de los `sourceId` importados. */
export const LEDGER_IMPORT_SOURCE_ID_SEPARATOR = ":" as const;

/**
 * `sourceId` de un asiento de diario importado: `<empresa>:<ejercicio>:<periodo>:<asiento>[:<canal>][:<centro>]`.
 * El periodo forma parte de la clave (en Sage el nº de asiento solo es único dentro de un periodo); el
 * canal / delegación solo si Sage numera por canal; el centro solo cuando el asiento se reparte por centro.
 * Tras un reverso el puente del diario libera la clave con `#<n>` (convención de `resolveSourceKey`).
 */
export function ledgerImportJournalSourceId(key: {
  companyCode: string;
  fiscalYear: string;
  period: string;
  entryNumber: string;
  channel?: string | null;
  propertyCode?: string | null;
}): string {
  const parts = [key.companyCode, key.fiscalYear, key.period, key.entryNumber];
  if (key.channel) parts.push(key.channel);
  if (key.propertyCode) parts.push(key.propertyCode);
  return parts.join(LEDGER_IMPORT_SOURCE_ID_SEPARATOR);
}

/** `sourceId` de un asiento resumen de saldos: `<empresa>:<ejercicio>:<periodo>:<centro|SOC>` (`periodo` = "YYYY-MM" | "YYYY-Qn" | "YYYY" | "apertura"). */
export function ledgerImportBalanceSourceId(key: { companyCode: string; fiscalYear: string; period: string; propertyCode: string }): string {
  return [key.companyCode, key.fiscalYear, key.period, key.propertyCode || LEDGER_IMPORT_SOCIETY_PROPERTY_CODE].join(LEDGER_IMPORT_SOURCE_ID_SEPARATOR);
}

/**
 * `VatBookEntry.sourceId` de una fila importada: `<empresa>:<ejercicio factura>:<serie>:<factura>[:<NIF>][:R]`
 * (R = rectificativa). En el libro de RECIBIDAS el número es el del PROVEEDOR (dos proveedores
 * numeran «1», «2»… a la vez), así que la clave lleva además su NIF (`counterpartyNif`); en
 * emitidas la serie + número propios ya son únicos y no se añade.
 */
export function ledgerImportVatBookSourceId(key: { companyCode: string; fiscalYear: string; series: string; number: string; rectification?: boolean; counterpartyNif?: string | null }): string {
  const parts = [key.companyCode, key.fiscalYear, key.series, key.number];
  if (key.counterpartyNif) parts.push(key.counterpartyNif);
  if (key.rectification) parts.push("R");
  return parts.join(LEDGER_IMPORT_SOURCE_ID_SEPARATOR);
}

// ---------------------------------------------------------------------------
// Límites y constantes operativas (§4.6, §7.1, §7.3)
// ---------------------------------------------------------------------------

/** Tamaño máximo del fichero en bytes (20 MiB) → 400 LEDGER_IMPORT_TOO_LARGE; ficheros mayores, por el CLI. */
export const LEDGER_IMPORT_MAX_BYTES = 20 * 1024 * 1024;
/** Longitud máxima de `contentBase64` en caracteres (28 MiB; base64 infla 4/3), como RESERVATION_IMPORT_MAX_BASE64_CHARS. Las rutas de carga fijan `bodyLimit` por ruta. */
export const LEDGER_IMPORT_MAX_BASE64_CHARS = 28 * 1024 * 1024;
/** Filas de datos máximas por fichero → 400 LEDGER_IMPORT_TOO_MANY_ROWS. */
export const LEDGER_IMPORT_MAX_ROWS = 250_000;
/** Asientos máximos por lote (una transacción) → 400 LEDGER_IMPORT_TOO_MANY_ENTRIES; un mes de la sociedad cabe. */
export const LEDGER_IMPORT_MAX_ENTRIES_PER_BATCH = 20_000;
/** Líneas máximas de un asiento importado (tras el reparto por centro). */
export const LEDGER_IMPORT_MAX_LINES_PER_ENTRY = 500;
/** Longitud máxima de `fileName`. */
export const LEDGER_IMPORT_MAX_FILE_NAME = 200;
/** Longitud máxima de `sheetName` (hoja XLSX pedida). */
export const LEDGER_IMPORT_MAX_SHEET_NAME = 64;
/** Longitud máxima de `notes` del lote. */
export const LEDGER_IMPORT_MAX_NOTES = 500;
/** `reason` del reverso: 3..500 caracteres (espejo de `POST /accounting/journal/:id/reverse`). */
export const LEDGER_IMPORT_REVERSAL_REASON_MIN = 3;
export const LEDGER_IMPORT_REVERSAL_REASON_MAX = 500;
/** `limit` de los listados de lotes y reconciliaciones. */
export const LEDGER_IMPORT_LIST_DEFAULT_LIMIT = 50;
export const LEDGER_IMPORT_LIST_MAX_LIMIT = 200;
/** Página de entradas del detalle de un lote (`GET /accounting/ledger-imports/:id?offset=&limit=`): un lote de 20.000 asientos se recorre por páginas. */
export const LEDGER_IMPORT_DETAIL_DEFAULT_LIMIT = 500;
export const LEDGER_IMPORT_DETAIL_MAX_LIMIT = 2_000;
/** Filas canónicas máximas que un borrador (`post: false`) conserva en `mappingJson.draftRows`; más filas → 400 LEDGER_IMPORT_TOO_MANY_ROWS (contabiliza directamente o usa el CLI). */
export const LEDGER_IMPORT_MAX_DRAFT_ROWS = 20_000;
/** Transacción del lote (`$transaction({ maxWait, timeout })`) bajo `pg_advisory_xact_lock('<prefijo><organizationId>')`, antes del lock de numeración del motor (orden constante → sin interbloqueos). */
export const LEDGER_IMPORT_ADVISORY_LOCK_PREFIX = "ledger_import:" as const;
export const LEDGER_IMPORT_TX_MAX_WAIT_MS = 15_000;
export const LEDGER_IMPORT_TX_TIMEOUT_MS = 600_000;
/** Usuario de sistema del CLI `sage200:import` y su `createdBy`. */
export const LEDGER_IMPORT_SYSTEM_USER_ID = "usr_system_sage200_import" as const;
export const LEDGER_IMPORT_CLI_CREATED_BY = "cli:import-sage200" as const;

/** Tolerancias de la reconciliación (§5.2), como MoneyString (igual que PMS_SHADOW_RECON_TOLERANCES). */
export const LEDGER_RECONCILIATION_TOLERANCES = Object.freeze({
  /** Consolidado de sociedad y cuentas solo importadas: exacto al céntimo. */
  consolidated: "0.00",
  /** Cuentas de balance POR CENTRO: 0,01 × nº de asientos repartidos por centro en el rango (el reparto deja céntimos residuales). */
  perCentrePerSplitEntry: "0.01",
  /** IVA por tipo impositivo (libro Sage frente a libros + cruce 472/477). */
  vatPerRate: "0.01"
} as const);

/** `LedgerReconciliation.status`. */
export const LEDGER_RECONCILIATION_STATUSES = ["ok", "differences", "error"] as const;
export type LedgerReconciliationStatus = (typeof LEDGER_RECONCILIATION_STATUSES)[number];

export const LEDGER_RECONCILIATION_STATUS_LABELS_ES: Readonly<Record<LedgerReconciliationStatus, string>> = Object.freeze({
  ok: "Cuadra",
  differences: "Con diferencias",
  error: "Error"
});

/** Clasificación de cada diferencia de la reconciliación (§5.2). */
export const LEDGER_RECONCILIATION_CLASSIFICATIONS = ["amount_diff", "native_only", "missing_in_ledger", "vat_diff"] as const;
export type LedgerReconciliationClassification = (typeof LEDGER_RECONCILIATION_CLASSIFICATIONS)[number];

export const LEDGER_RECONCILIATION_CLASSIFICATION_LABELS_ES: Readonly<Record<LedgerReconciliationClassification, string>> = Object.freeze({
  amount_diff: "Importe distinto",
  native_only: "Solo en Anfitorio",
  missing_in_ledger: "Falta en Anfitorio",
  vat_diff: "Diferencia de IVA"
});

// ---------------------------------------------------------------------------
// Códigos de error de las rutas y del CLI (`details.code`, §7.2)
// ---------------------------------------------------------------------------

/** Códigos con los que responden las rutas `/accounting/ledger-imports*` y el CLI `sage200:import`. */
export const LEDGER_IMPORT_ERROR_CODES = [
  /** 400 · issues zod (clave desconocida, tipo fuera de LEDGER_IMPORT_KINDS, `allowClosed` por HTTP…). */
  "VALIDATION_ERROR",
  /** 400 · `{ errors: [{ line, message }] }`: fichero legible pero inválido (cabecera obligatoria ausente, importe no numérico, fecha ilegible…). */
  "LEDGER_IMPORT_INVALID",
  /** 400 · el formato no se indicó y no se reconoce por extensión, firma ni cabecera. */
  "LEDGER_IMPORT_FORMAT_UNKNOWN",
  /** 400 · `{ blocks }`: XML «Datos contables» sin parser aún (lista de bloques encontrados). */
  "LEDGER_IMPORT_XML_UNSUPPORTED",
  /** 400 · el contenido no es del tipo de lote indicado (p. ej. un sumas y saldos enviado como `journal`). */
  "LEDGER_IMPORT_KIND_MISMATCH",
  /** 400 · el fichero no tiene filas de datos. */
  "LEDGER_IMPORT_EMPTY",
  /** 400 · `{ bytes, max }`: fichero > LEDGER_IMPORT_MAX_BYTES. */
  "LEDGER_IMPORT_TOO_LARGE",
  /** 400 · `{ rows, max }`: más de LEDGER_IMPORT_MAX_ROWS filas. */
  "LEDGER_IMPORT_TOO_MANY_ROWS",
  /** 400 · `{ entries, max }`: más de LEDGER_IMPORT_MAX_ENTRIES_PER_BATCH asientos (trocear por mes). */
  "LEDGER_IMPORT_TOO_MANY_ENTRIES",
  /** 400 · `{ fileCompany, entity }`: empresa / NIF del fichero distinto de la sociedad. */
  "LEDGER_IMPORT_COMPANY_MISMATCH",
  /** 400 · `{ accounts }`: cuentas Sage sin mapear o bloqueadas (la contabilización se bloquea). */
  "LEDGER_IMPORT_ACCOUNT_UNMAPPED",
  /** 400 · `{ accountCode }`: cuenta destino fuera de ACCOUNT_CODE_PATTERN, inexistente o no postable. */
  "LEDGER_IMPORT_ACCOUNT_CODE_INVALID",
  /** 400 · `{ codes }`: códigos analíticos (canal, delegación, departamento…) sin centro asignado. */
  "LEDGER_IMPORT_ANALYTICS_UNMAPPED",
  /** 400 · `{ entries }`: asientos con líneas 6/7 sin centro y política `block` (R4 WORK_CENTER_REQUIRED). */
  "LEDGER_IMPORT_CENTRE_REQUIRED",
  /** 400 · `{ entries }`: asientos Sage cuyo debe ≠ haber. */
  "LEDGER_IMPORT_UNBALANCED",
  /** 400 · `{ code }`: ejercicio con código distinto del año natural "YYYY". */
  "LEDGER_IMPORT_YEAR_CODE_INVALID",
  /** 400 · `{ errors }`: mapa de cuentas o analítico inválido (acción desconocida, `accountCode` null fuera de block, centro de otra organización…). */
  "LEDGER_IMPORT_MAP_INVALID",
  /** 409 · `{ importId, fileName, createdAt }`: mismo hash en un lote no revertido de la organización. */
  "LEDGER_IMPORT_DUPLICATE",
  /** 409 · `{ overlaps }`: otros lotes no revertidos cubren (empresa, ejercicio, periodo, asiento) del fichero; usa `replace`. */
  "LEDGER_IMPORT_OVERLAP",
  /** 409 · `{ journalEntryId, sourceId }`: el motor encontró un asiento vivo con esa clave fuera del lote (idempotencia defensiva). */
  "LEDGER_IMPORT_ENTRY_EXISTS",
  /** 409 · el lote ya está contabilizado. */
  "LEDGER_IMPORT_ALREADY_POSTED",
  /** 409 · el lote está revertido: no se contabiliza ni se revierte de nuevo. */
  "LEDGER_IMPORT_REVERSED",
  /** 409 · el lote no está `posted`: no hay nada que revertir. */
  "LEDGER_IMPORT_NOT_POSTED",
  /** 409 · la organización no tiene fila `vat_settings` (periodicidad): el lote `vat_books` y `vat_diff` esperan a la decisión. */
  "LEDGER_IMPORT_VAT_SETTINGS_MISSING",
  /** 404 opaco · lote inexistente o de otra organización. */
  "LEDGER_IMPORT_NOT_FOUND",
  /** 404 opaco · reconciliación inexistente o de otra organización. */
  "LEDGER_RECONCILIATION_NOT_FOUND",
  /** 409 · `{ fiscalYearId, importId }`: el ejercicio quedó cerrado por un lote importado (cierre de Sage): reabrir = revertir ese lote. */
  "FISCAL_YEAR_CLOSED_FROM_IMPORT",
  /** 400 · motor contable: cuenta destino inexistente en el plan. */
  "ACCOUNT_NOT_FOUND",
  /** 400 · motor contable: cuenta destino no postable (cabecera). */
  "ACCOUNT_NOT_POSTABLE",
  /** 400 · motor contable (R4): línea de grupos 6/7 sin centro de trabajo. */
  "WORK_CENTER_REQUIRED",
  /** 404 opaco · motor contable (R10.1): el centro no es de la organización. */
  "PROPERTY_NOT_FOUND",
  /** 409 · motor contable: periodo cerrado (rollback del lote entero). */
  "FISCAL_PERIOD_CLOSED",
  /** 409 · motor contable: ejercicio cerrado. */
  "FISCAL_YEAR_CLOSED",
  /** 400 · motor contable: asiento descuadrado (defensivo: el lote valida antes). */
  "JOURNAL_UNBALANCED"
] as const;
export type LedgerImportErrorCode = (typeof LEDGER_IMPORT_ERROR_CODES)[number];

/** Mensaje en español por código (fallback del front y del CLI). */
export const LEDGER_IMPORT_ERROR_LABELS_ES: Readonly<Record<LedgerImportErrorCode, string>> = Object.freeze({
  VALIDATION_ERROR: "La petición no es válida.",
  LEDGER_IMPORT_INVALID: "El fichero tiene errores: revisa las líneas indicadas.",
  LEDGER_IMPORT_FORMAT_UNKNOWN: "No se reconoce el formato del fichero: indícalo o revisa la cabecera.",
  LEDGER_IMPORT_XML_UNSUPPORTED: "El XML «Datos contables» de Sage 200 aún no se puede importar: exporta a Excel o CSV.",
  LEDGER_IMPORT_KIND_MISMATCH: "El contenido del fichero no corresponde al tipo de lote elegido.",
  LEDGER_IMPORT_EMPTY: "El fichero no contiene filas de datos.",
  LEDGER_IMPORT_TOO_LARGE: "El fichero supera el tamaño admitido (20 MB): usa el CLI o trocéalo por meses.",
  LEDGER_IMPORT_TOO_MANY_ROWS: "El fichero tiene demasiadas filas: trocéalo por meses.",
  LEDGER_IMPORT_TOO_MANY_ENTRIES: "El lote tiene demasiados asientos: trocéalo por meses.",
  LEDGER_IMPORT_COMPANY_MISMATCH: "La empresa del fichero no es la sociedad de esta organización.",
  LEDGER_IMPORT_ACCOUNT_UNMAPPED: "Hay cuentas de Sage sin mapear: complétalas en el mapa de cuentas antes de contabilizar.",
  LEDGER_IMPORT_ACCOUNT_CODE_INVALID: "La cuenta destino no existe en el plan o no admite apuntes.",
  LEDGER_IMPORT_ANALYTICS_UNMAPPED: "Hay códigos analíticos de Sage sin centro asignado: complétalos en el mapa analítico.",
  LEDGER_IMPORT_CENTRE_REQUIRED: "Hay asientos con gastos o ingresos sin centro de trabajo: asigna un centro o cambia la política.",
  LEDGER_IMPORT_UNBALANCED: "Hay asientos de Sage descuadrados: revisa la exportación.",
  LEDGER_IMPORT_YEAR_CODE_INVALID: "El código del ejercicio debe ser el año natural (por ejemplo 2026).",
  LEDGER_IMPORT_MAP_INVALID: "El mapa enviado no es válido: revisa las filas indicadas.",
  LEDGER_IMPORT_DUPLICATE: "Este fichero ya se importó: revierte el lote anterior o usa «sustituir».",
  LEDGER_IMPORT_OVERLAP: "Otros lotes ya cubren asientos de este fichero: usa «sustituir» (reverso + lote nuevo).",
  LEDGER_IMPORT_ENTRY_EXISTS: "Ya existe un asiento importado con esa clave de Sage.",
  LEDGER_IMPORT_ALREADY_POSTED: "El lote ya está contabilizado.",
  LEDGER_IMPORT_REVERSED: "El lote está revertido: crea uno nuevo.",
  LEDGER_IMPORT_NOT_POSTED: "El lote no está contabilizado: no hay nada que revertir.",
  LEDGER_IMPORT_VAT_SETTINGS_MISSING: "Falta la configuración de IVA de la organización (periodicidad y régimen): configúrala antes de importar libros.",
  LEDGER_IMPORT_NOT_FOUND: "Lote de importación no encontrado.",
  LEDGER_RECONCILIATION_NOT_FOUND: "Reconciliación no encontrada.",
  FISCAL_YEAR_CLOSED_FROM_IMPORT: "El ejercicio se cerró con el cierre importado de Sage 200: para reabrirlo, revierte ese lote.",
  ACCOUNT_NOT_FOUND: "La cuenta no existe en el plan.",
  ACCOUNT_NOT_POSTABLE: "La cuenta no admite apuntes (es una cabecera).",
  WORK_CENTER_REQUIRED: "Las líneas de gasto e ingreso exigen un centro de trabajo.",
  PROPERTY_NOT_FOUND: "Centro de trabajo no encontrado.",
  FISCAL_PERIOD_CLOSED: "El periodo contable está cerrado.",
  FISCAL_YEAR_CLOSED: "El ejercicio está cerrado: no se puede contabilizar ni revertir en él.",
  JOURNAL_UNBALANCED: "El asiento no cuadra (debe ≠ haber)."
});

// ---------------------------------------------------------------------------
// Mapas (DTOs compartidos por preview, lote y rutas de mapa)
// ---------------------------------------------------------------------------

/** Una fila del mapa de cuentas (`LedgerAccountMap`); en la preview, la propuesta del mapeador para una cuenta sin mapear. */
export type LedgerAccountMapDto = {
  /** Código de cuenta Sage literal. */
  sourceAccount: string;
  sourceName?: string | null;
  action: LedgerAccountMapAction;
  /** Cuenta PGC destino (map / create / collapse) o prefijo 472 / 477 (map_by_rate); null solo en block. */
  accountCode: string | null;
  /** Solo `create` en grupos 6/7. */
  usaliDepartment?: UsaliDepartmentKey | null;
  usaliLine?: UsaliLineKey | null;
  /** collapse: escribe «Sage <cuenta> · <NIF> · <nombre>» en la descripción de la línea. */
  carryCounterparty: boolean;
  /** true si la propuso el mapeador (reglas 2-7 del §4.4) y no una persona. */
  suggested?: boolean;
  /** Nº de apuntes del fichero que usan la cuenta (preview). */
  lineCount?: number;
};

/** Una fila del mapa analítico (`LedgerAnalyticsMap`). */
export type LedgerAnalyticsMapDto = {
  dimension: LedgerAnalyticsDimension;
  sourceCode: string;
  sourceName?: string | null;
  /** Centro de trabajo (dimensión de centro). */
  propertyId: string | null;
  /** Centro de coste USALI (dimensión de centro de coste). */
  costCentreCode: LedgerUsaliCostCentreCode | string | null;
  suggested?: boolean;
};

/** Configuración analítica de un lote (`mappingJson.analytics`). */
export type LedgerAnalyticsMappingInput = {
  centreDimension: LedgerAnalyticsDimension;
  costCentreDimension?: LedgerAnalyticsDimension | null;
  unassignedPolicy: LedgerUnassignedPolicy;
  entries: LedgerAnalyticsMapDto[];
};

/** Mapeo enviado con la preview / el lote; lo que falte se toma del mapa persistido de la organización. */
export type LedgerImportMappingInput = {
  accounts?: LedgerAccountMapDto[];
  analytics?: LedgerAnalyticsMappingInput;
};

/** `GET /accounting/ledger-imports/account-map`. */
export type LedgerAccountMapResponse = {
  system: LedgerImportSystem;
  entries: LedgerAccountMapDto[];
};

/** `PUT /accounting/ledger-imports/account-map` (valida cada `accountCode` y crea las subcuentas `create` por `createChartAccount`). */
export type LedgerAccountMapPutBody = {
  system?: LedgerImportSystem;
  entries: LedgerAccountMapDto[];
};

/** `GET /accounting/ledger-imports/analytics-map`. */
export type LedgerAnalyticsMapResponse = {
  system: LedgerImportSystem;
  centreDimension: LedgerAnalyticsDimension;
  costCentreDimension: LedgerAnalyticsDimension | null;
  unassignedPolicy: LedgerUnassignedPolicy;
  entries: LedgerAnalyticsMapDto[];
};

/** `PUT /accounting/ledger-imports/analytics-map` (`propertyId` de la organización; `assertFinanceReadScopeMany`). */
export type LedgerAnalyticsMapPutBody = {
  system?: LedgerImportSystem;
  centreDimension: LedgerAnalyticsDimension;
  costCentreDimension?: LedgerAnalyticsDimension | null;
  unassignedPolicy: LedgerUnassignedPolicy;
  entries: LedgerAnalyticsMapDto[];
};

// ---------------------------------------------------------------------------
// Previsualización (`POST /accounting/ledger-imports/preview`, nunca escribe)
// ---------------------------------------------------------------------------

/** Dimensiones por las que Sage puede numerar los asientos (`options.numberingDimension`). */
export const LEDGER_NUMBERING_DIMENSIONS = ["canal", "delegacion"] as const;
export type LedgerNumberingDimension = (typeof LEDGER_NUMBERING_DIMENSIONS)[number];

export type LedgerImportOptions = {
  /** Ejercicio esperado ("YYYY"); si el fichero trae otro → LEDGER_IMPORT_YEAR_CODE_INVALID. */
  fiscalYearCode?: string;
  unassignedPolicy?: LedgerUnassignedPolicy;
  /** Reversa ENTEROS los lotes que solapen y crea el nuevo en la misma transacción. */
  replace?: boolean;
  /** third_parties: alta / actualización de `Supplier` por NIF. */
  createSuppliers?: boolean;
  /** journal: lanza la reconciliación del mismo rango si se adjunta el balance de Sage. */
  reconcile?: boolean;
  /**
   * journal / fiscal_years: dimensión por la que Sage numera los asientos («Numeración canal/delegación»,
   * diseño §4.6): el canal o la delegación entra en la clave `<empresa>:<ejercicio>:<periodo>:<asiento>:<canal>`
   * y dos asientos nº N de delegaciones distintas no se funden. null / ausente = numeración única por periodo.
   */
  numberingDimension?: LedgerNumberingDimension | null;
  /** Solo CLI (`--allow-closed`, auditado): contabiliza en periodos cerrados de Anfitorio. Por HTTP → 400 VALIDATION_ERROR. */
  allowClosed?: boolean;
};

export type LedgerImportPreviewBody = {
  kind: LedgerImportKind;
  /** Si falta: extensión de `fileName` > firma > cabecera (400 LEDGER_IMPORT_FORMAT_UNKNOWN). */
  format?: LedgerImportFormat;
  fileName?: string;
  /** Exactamente uno de los dos: bytes en base64 (≤ LEDGER_IMPORT_MAX_BASE64_CHARS; siempre desde el navegador) o texto (CSV / JSON canónicos, CLI y tests). */
  contentBase64?: string;
  content?: string;
  /** Hoja del XLSX; por defecto la primera no oculta. */
  sheetName?: string;
  mapping?: LedgerImportMappingInput;
  options?: LedgerImportOptions;
};

export type LedgerImportPreviewMonthRow = {
  /** "YYYY-MM". */
  periodCode: string;
  entries: number;
  lines: number;
  debit: MoneyString;
  credit: MoneyString;
};

export type LedgerImportPreviewPropertyRow = {
  propertyId: string | null;
  /** Código del centro o "SOC". */
  propertyCode: string;
  entries: number;
  debit: MoneyString;
  credit: MoneyString;
};

export type LedgerImportUnmappedAccount = {
  sourceAccount: string;
  sourceName: string | null;
  lineCount: number;
  /** Propuesta del mapeador (reglas 2-7) o null si solo cabe `block`. */
  suggestion: LedgerAccountMapDto | null;
};

export type LedgerImportUnmappedAnalytics = {
  dimension: LedgerAnalyticsDimension;
  sourceCode: string;
  sourceName: string | null;
  lineCount: number;
};

/** Asiento con líneas 6/7 sin centro (política `block`). */
export type LedgerImportCentreRequiredRow = {
  sourceEntryNumber: string;
  sourcePeriod: string;
  accounts: string[];
};

export type LedgerImportUnbalancedRow = {
  sourceEntryNumber: string;
  sourcePeriod: string;
  debit: MoneyString;
  credit: MoneyString;
};

/** Asiento Sage excluido por ser un documento nativo de Anfitorio (§5.1). */
export type LedgerImportNativeSkippedRow = {
  sourceEntryNumber: string;
  sourcePeriod: string;
  /** Canal / delegación de la clave cuando Sage numera por canal (`options.numberingDimension`); libro (`emitidas` / `recibidas`) en un lote `vat_books`. */
  sourceChannel?: string | null;
  series: string | null;
  number: string | null;
  /** Número impreso completo de la factura Anfitorio con la que coincide. */
  invoiceNumber: string | null;
  /** Asiento nativo con el que colisiona (`JournalEntry.sourceType` / `sourceId`). */
  sourceType: string;
  sourceId: string;
};

/** Asiento Sage ya importado por un lote anterior (`skipped_existing`). */
export type LedgerImportExistingRow = {
  sourceEntryNumber: string;
  sourcePeriod: string;
  journalEntryId: string;
  entryNumber: number | null;
  fiscalYearCode: string | null;
};

/** Apertura / regularización / cierre de Sage detectados (el usuario confirma). */
export type LedgerImportClosingDetectedRow = {
  sourceEntryNumber: string;
  sourcePeriod: string;
  entryKind: LedgerImportEntryKind;
};

export type LedgerImportDuplicateOf = {
  importId: string;
  fileName: string | null;
  createdAt: string;
  status: LedgerImportStatusCode;
};

export type LedgerImportOverlapRow = {
  importId: string;
  status: LedgerImportStatusCode;
  periodFrom: string | null;
  periodTo: string | null;
  /** Asientos de este fichero que ese lote ya cubre. */
  entries: number;
};

/** Lote de coste de personal contabilizado en el rango (aviso: la nómina real de Sage lo duplicaría). */
export type LedgerImportPayrollOverlapRow = {
  importId: string;
  periodFrom: string;
  periodTo: string;
};

export type LedgerImportPreview = {
  kind: LedgerImportKind;
  format: LedgerImportFormat;
  system: LedgerImportSystem;
  fileName: string | null;
  contentHash: string;
  sourceCompanyCode: string | null;
  fiscalYearCode: string | null;
  /** "YYYY-MM". */
  periodFrom: string | null;
  periodTo: string | null;
  rowCount: number;
  entryCount: number;
  lineCount: number;
  totalDebit: MoneyString;
  totalCredit: MoneyString;
  byMonth: LedgerImportPreviewMonthRow[];
  byProperty: LedgerImportPreviewPropertyRow[];
  unmappedAccounts: LedgerImportUnmappedAccount[];
  unmappedAnalytics: LedgerImportUnmappedAnalytics[];
  centreRequired: LedgerImportCentreRequiredRow[];
  unbalanced: LedgerImportUnbalancedRow[];
  nativeSkipped: LedgerImportNativeSkippedRow[];
  existing: LedgerImportExistingRow[];
  closingDetected: LedgerImportClosingDetectedRow[];
  duplicateOf: LedgerImportDuplicateOf | null;
  overlaps: LedgerImportOverlapRow[];
  payrollCostImportsPosted: LedgerImportPayrollOverlapRow[];
  /** Asientos nativos que ya tiene el ejercicio (la numeración quedará intercalada). */
  existingNativeEntries: number;
  /** true si la organización no tiene fila `vat_settings` (bloquea `vat_books`). */
  vatSettingsMissing: boolean;
  warnings: string[];
  canPost: boolean;
  /** Motivos (en español) por los que `canPost` es false. */
  blockers: string[];
};

// ---------------------------------------------------------------------------
// Lotes (`POST /accounting/ledger-imports`, `GET …`, `GET …/:id`, `POST …/:id/post`, `POST …/:id/reverse`)
// ---------------------------------------------------------------------------

export type LedgerImportCreateBody = LedgerImportPreviewBody & {
  /** true por defecto: contabiliza en la misma petición; false deja el lote en `draft`. */
  post?: boolean;
  notes?: string;
};

export type LedgerImportRecord = {
  id: string;
  kind: LedgerImportKind;
  format: LedgerImportFormat;
  system: LedgerImportSystem;
  fileName: string | null;
  contentHash: string;
  sourceCompanyCode: string | null;
  fiscalYearCode: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  status: LedgerImportStatusCode;
  rowCount: number;
  entryCount: number;
  skippedCount: number;
  warningCount: number;
  totalDebit: MoneyString;
  totalCredit: MoneyString;
  journalEntryIds: string[];
  reversalJournalEntryIds: string[];
  replacedById: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  postedAt: string | null;
  reversedAt: string | null;
  reversedBy: string | null;
  reversalReason: string | null;
};

export type LedgerImportEntryDto = {
  id: string;
  sourceCompanyCode: string;
  sourceFiscalYear: string;
  sourcePeriod: string;
  sourceEntryNumber: string;
  sourceChannel: string | null;
  entryDate: IsoDate;
  propertyId: string | null;
  propertyCode: string;
  journalEntryId: string | null;
  /** Número Anfitorio del asiento producido (null si no se contabilizó). */
  entryNumber: number | null;
  fiscalYearCode: string | null;
  status: LedgerImportEntryStatus;
  entryKind: LedgerImportEntryKind;
  lineCount: number;
  debit: MoneyString;
  credit: MoneyString;
  /** Asiento nativo con el que colisiona (skipped_native / skipped_existing). */
  sourceType: string | null;
  sourceId: string | null;
  warnings: string[];
};

export type LedgerImportBalanceDto = {
  id: string;
  fiscalYearCode: string;
  periodCode: string;
  propertyId: string | null;
  propertyCode: string;
  sourceAccount: string;
  sourceName: string | null;
  accountCode: string;
  openingDebit: MoneyString;
  openingCredit: MoneyString;
  periodDebit: MoneyString;
  periodCredit: MoneyString;
  closingBalance: MoneyString;
};

export type LedgerImportCreateResult = {
  import: LedgerImportRecord;
  entries: LedgerImportEntryDto[];
  /** Asientos (o cuentas / ejercicios / filas de libros / terceros, según `kind`) creados. */
  created: number;
  skipped: number;
  warnings: string[];
  /** Reconciliación lanzada con el lote (`options.reconcile` + balance adjunto), si la hubo. */
  reconciliation: LedgerReconciliationDto | null;
};

export type LedgerImportDetail = {
  import: LedgerImportRecord;
  /** Página de entradas (ordenadas por fecha y nº Sage): `entryOffset` + `entries.length` de `entryTotal` (`GET …/:id?offset=&limit=`). */
  entries: LedgerImportEntryDto[];
  entryTotal: number;
  /** Desplazamiento de la página devuelta (0 en la primera). */
  entryOffset: number;
  /** Mapeo aplicado (`mappingJson`). */
  mapping: LedgerImportMappingInput;
  /** Solo `kind = balances`. */
  balances?: LedgerImportBalanceDto[];
};

/** Página de entradas del detalle de un lote (`GET /accounting/ledger-imports/:id`). */
export type LedgerImportDetailQuery = {
  /** Desplazamiento (≥ 0; por defecto 0). */
  offset?: number;
  /** Tamaño de página (1..LEDGER_IMPORT_DETAIL_MAX_LIMIT; por defecto LEDGER_IMPORT_DETAIL_DEFAULT_LIMIT). */
  limit?: number;
};

export type LedgerImportListQuery = {
  kind?: LedgerImportKind;
  status?: LedgerImportStatusCode;
  /** "YYYY-MM" (intersección con periodFrom / periodTo). */
  from?: string;
  to?: string;
  /** 1..LEDGER_IMPORT_LIST_MAX_LIMIT (por defecto LEDGER_IMPORT_LIST_DEFAULT_LIMIT). */
  limit?: number;
};

export type LedgerImportPostBody = {
  replace?: boolean;
};

export type LedgerImportReverseBody = {
  /** 3..500 caracteres. */
  reason: string;
};

// ---------------------------------------------------------------------------
// Reconciliación (`POST /accounting/ledger-imports/reconciliation`, `GET …/reconciliation[/:id]`)
// ---------------------------------------------------------------------------

export type LedgerReconciliationBody = {
  from: IsoDate;
  to: IsoDate;
  /** Centro comparado; sin él, consolidado de sociedad. */
  propertyId?: string;
  format?: LedgerImportFormat;
  /** Balance de sumas y saldos de Sage del rango: exactamente uno de los dos. */
  contentBase64?: string;
  content?: string;
  sheetName?: string;
  /** Lote `journal` que motiva la reconciliación (para `missingEntries`). */
  importId?: string;
};

/** Una cuenta destino comparada (`rowsJson[]`). */
export type LedgerReconciliationRow = {
  accountCode: string;
  /** Cuentas Sage agrupadas en esta cuenta destino por el mapa. */
  sourceAccounts: string[];
  accountName: string | null;
  sourceDebit: MoneyString;
  sourceCredit: MoneyString;
  ledgerDebit: MoneyString;
  ledgerCredit: MoneyString;
  diffDebit: MoneyString;
  diffCredit: MoneyString;
  sourceBalance: MoneyString;
  ledgerBalance: MoneyString;
  diffBalance: MoneyString;
  /** null si la fila cuadra dentro de la tolerancia. */
  classification: LedgerReconciliationClassification | null;
  /** Tolerancia aplicada a la fila (MoneyString). */
  tolerance: MoneyString;
  ok: boolean;
  note?: string;
};

export type LedgerReconciliationSummary = {
  nativeOnly: number;
  missingInLedger: number;
  amountDiff: number;
  vatDiff: number;
  /** Tolerancia consolidada aplicada (MoneyString). */
  tolerance: MoneyString;
  /** Regla de lectura del diario (en español): «status ≠ draft, sin parejas de reversión, movimientos sin regularization/closing/opening…». */
  criterion: string;
};

/** Asiento Sage del lote que no llegó al diario (unmapped / error / skipped_native). */
export type LedgerReconciliationMissingEntry = {
  sourceEntryNumber: string;
  sourcePeriod: string;
  status: LedgerImportEntryStatus;
};

export type LedgerReconciliationDto = {
  id: string;
  importId: string | null;
  periodFrom: IsoDate;
  periodTo: IsoDate;
  propertyId: string | null;
  /** Código del centro o "SOC". */
  propertyCode: string;
  status: LedgerReconciliationStatus;
  accountsCompared: number;
  differenceCount: number;
  rows: LedgerReconciliationRow[];
  summary: LedgerReconciliationSummary;
  missingEntries: LedgerReconciliationMissingEntry[];
  createdBy: string | null;
  createdAt: string;
};

export type LedgerReconciliationListQuery = {
  from?: IsoDate;
  to?: IsoDate;
  propertyId?: string;
  limit?: number;
};

// ---------------------------------------------------------------------------
// Plantillas canónicas (`GET /accounting/ledger-imports/template`)
// ---------------------------------------------------------------------------

export type LedgerImportTemplateQuery = {
  kind: LedgerImportKind;
  format: "csv";
};
