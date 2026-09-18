// Importación contable desde Sage 200 (Tanda 7c · L2) — servicio de lotes
// (`LedgerImport`): previsualización, creación, contabilización, reverso, listado,
// detalle, mapas persistentes (cuentas y analítica) y plantillas canónicas.
//
// Un lote = un fichero de UN tipo (`plan` · `fiscal_years` · `journal` · `vat_books` ·
// `third_parties` · `balances`, design §4.1) identificado por el sha256 de sus filas
// normalizadas ANTES del mapa (`contentHashOf`, L1). El servicio no parsea ni mapea
// nada por su cuenta: llama a los puros de L1 (`sage200.parser`, `ledger-import.canonical`,
// `ledger-import.mapping`, `ledger-import.posting`) y contabiliza SIEMPRE por
// `postJournalEntry` / `reverseJournalEntry` del motor (`accounting.service.ts`) con la
// transacción del lote (`{ tx }`): nunca el puente `ledger()`, que no transporta
// `entryKind`, `fiscalYearId` ni `ignoreClosedPeriod` (design §10.4.2 #6).
//
// Orden de guardas (cada una falla antes de escribir nada):
//   1. permisos: preview / create / post / reverse `accounting.journal.post`; list / get
//      `accounting.read`; mapas GET `accounting.read`, PUT `accounting.configure`;
//   2. tamaño: contentBase64 ≤ LEDGER_IMPORT_MAX_BASE64_CHARS, bytes ≤ LEDGER_IMPORT_MAX_BYTES
//      → 400 LEDGER_IMPORT_TOO_LARGE { bytes, max };
//   3. parseo (L1) → 400 LEDGER_IMPORT_INVALID / _FORMAT_UNKNOWN / _KIND_MISMATCH / _EMPTY / …;
//   4. ejercicio = año natural "YYYY" → 400 LEDGER_IMPORT_YEAR_CODE_INVALID { code };
//   5. mapa de cuentas efectivo = LedgerAccountMap persistido ⊕ body.mapping.accounts (el del
//      cuerpo gana) sobre el plan de la organización; mapa analítico ⊕ persistido ⊕
//      sugerencias por igualdad exacta (`suggestAnalyticsMapping`, como el coste de personal);
//   6. índice de documentos nativos (`ledger-import.native.ts`) → `skipped_native` (§5.1): en el
//      diario por serie + número y cobros; en `vat_books` las emitidas propias (serie + número) y
//      las recibidas ya contabilizadas (NIF + número del proveedor) tampoco se importan;
//   7. bloqueantes de la regla contable (400): LEDGER_IMPORT_ACCOUNT_UNMAPPED { accounts } ·
//      _ANALYTICS_UNMAPPED { codes } · _CENTRE_REQUIRED { entries } · _UNBALANCED { entries } ·
//      _TOO_MANY_ENTRIES { entries, max }; 409 LEDGER_IMPORT_VAT_SETTINGS_MISSING (vat_books);
//   8. ámbito R11: `resolveLedgerScope` (sociedad; otra → 404 opaco) y
//      `assertFinanceReadScopeMany` sobre los centros del lote (asientos a nivel sociedad
//      exigen accounting.entity.read → 404 opaco ENTITY_SCOPE_REQUIRED);
//   9. transacción propia `{ maxWait 15 s, timeout 600 s }` bajo
//      `pg_advisory_xact_lock(hashtext('ledger_import:<org>'))` ANTES de cualquier
//      postJournalEntry (el motor toma después su lock de numeración: orden constante):
//      duplicado por hash vivo → 409 LEDGER_IMPORT_DUPLICATE (journal / balances / vat_books;
//      en plan / fiscal_years / third_parties el duplicado es solo aviso: los maestros son
//      idempotentes por construcción, filas `skipped_existing`); solape por (empresa,
//      ejercicio, periodo, asiento) con lotes `posted` del mismo tipo — y en `vat_books` por
//      `sourceId` de fila de libro con otros lotes `vat_books` posted — → 409
//      LEDGER_IMPORT_OVERLAP { overlaps } salvo `replace` (reversa ENTEROS los lotes
//      solapados en la misma transacción); un lote `balances` sobre un ejercicio que ya tiene
//      diario o apertura importados (o un `journal` sobre un ejercicio con saldos importados)
//      → 409 LEDGER_IMPORT_OVERLAP sin `replace` posible (diseño §4.1: saldos solo para
//      ejercicios sin diario); lote `draft` + entradas → por tipo:
//        · plan: altas SOLO de las filas `create` con `prismaChartStore(tx).createAccounts`
//          (padre = prefijo existente más largo, kind heredado, USALI obligatorio en 6/7),
//          nunca renombra ni borra (409 ACCOUNT_CODE_EXISTS solo si el nombre difiere);
//          LedgerAccountMap upsert por (org, system, sourceAccount); LedgerThirdParty de las
//          cuentas con NIF;
//        · fiscal_years: FiscalYear { code YYYY, propertyId null, año natural, open } + 12
//          FiscalPeriod mensuales (replicando createFiscalYear / openFiscalPeriod, que no
//          aceptan tx) + asiento de apertura si el fichero lo trae;
//        · journal / balances: CostCenter usali por (centro, código) + un postJournalEntry por
//          PlannedEntry en orden de fecha y nº Sage con `sourceId` = `resolveSourceKey`
//          (sufijo #n si toda clave previa está reversed; clave viva → fila skipped_existing);
//          `created !== true` → 409 LEDGER_IMPORT_ENTRY_EXISTS; balances: filas
//          LedgerImportBalance; regularization + closing del ejercicio →
//          `markFiscalYearClosedFromImport` (sin asientos propios);
//        · vat_books: deleteMany por (org, book, sage200, sourceId) + createMany
//          (`toVatBookCreateInput`), LedgerThirdParty por NIF; NUNCA crea vat_settings;
//        · third_parties: LedgerThirdParty upsert; Supplier SOLO con options.createSuppliers
//          (findFirst por NIF normalizado → update { name } / create mínimo);
//      cierre del lote: status posted, postedAt, journalEntryIds, totales, contadores,
//      mappingJson, warningsJson;
//  10. tras el commit: auditoría (LEDGER_IMPORT_POSTED / LEDGER_IMPORTED, ACCOUNT_CREATED por
//      cuenta, FISCAL_YEAR_OPENED / FISCAL_PERIOD_OPENED) y, si `options.reconcile` con el
//      balance de Sage adjunto (`balance` del input, CLI --reconcile --balance), la
//      reconciliación (segunda operación: `aggregateAccountBalances` lee el prisma raíz; si
//      falla, el lote sigue posted y se devuelve el aviso).
// Reverso (`reverseLedgerImport`, idempotente): draft → 409 LEDGER_IMPORT_NOT_POSTED; ya
// reversed → el lote con `alreadyReversed`; los ejercicios que ESTE lote cerró vuelven a
// `open` (sin `year-reopen:*`) y los periodos que cerró («cerrado por importación <id>»)
// se reabren en la misma transacción; cada asiento exige el periodo / ejercicio del
// ORIGINAL abierto (`assertOriginalPeriodOpen`, leída a través de la transacción) y se
// reversa con `reverseJournalEntry` (sourceId `ledger-import-reverse:<importId>:<entryId>`);
// filas VatBookEntry sage200 del lote → deleteMany; LedgerImportBalance se conserva;
// cuentas, ejercicios y terceros creados por un lote nunca se borran.
// Borradores (`post: false`): el fichero no se guarda; las filas canónicas normalizadas
// viajan en `mappingJson.draftRows` hasta `postLedgerImport`, que las reanaliza.
// `legalEntityId` sale de `resolveLedgerScope` (nunca de organization.taxId).

import { prisma } from "@hotelos/database";
import { BRAND } from "../../../lib/brand.js";
import { Prisma } from "@prisma/client";
import {
  LEDGER_ACCOUNT_MAP_ACTIONS,
  LEDGER_ANALYTICS_DIMENSIONS,
  LEDGER_DEFAULT_CENTRE_DIMENSION,
  LEDGER_DEFAULT_COST_CENTRE_DIMENSION,
  LEDGER_IMPORT_DEFAULT_SYSTEM,
  LEDGER_IMPORT_ADVISORY_LOCK_PREFIX,
  LEDGER_IMPORT_DETAIL_DEFAULT_LIMIT,
  LEDGER_IMPORT_DETAIL_MAX_LIMIT,
  LEDGER_IMPORT_KINDS,
  LEDGER_IMPORT_LIST_DEFAULT_LIMIT,
  LEDGER_IMPORT_LIST_MAX_LIMIT,
  LEDGER_IMPORT_MAX_BASE64_CHARS,
  LEDGER_IMPORT_MAX_BYTES,
  LEDGER_IMPORT_MAX_DRAFT_ROWS,
  LEDGER_IMPORT_MAX_ENTRIES_PER_BATCH,
  LEDGER_IMPORT_OPENING_PERIOD_CODE,
  LEDGER_IMPORT_SOCIETY_PROPERTY_CODE,
  LEDGER_IMPORT_SOURCE_TYPES,
  LEDGER_IMPORT_TX_MAX_WAIT_MS,
  LEDGER_IMPORT_TX_TIMEOUT_MS,
  LEDGER_USALI_COST_CENTRE_CODES,
  LEDGER_NUMBERING_DIMENSIONS,
  LEDGER_VAT_BOOK_SOURCE_TYPE,
  isLedgerUnassignedPolicy,
  type LedgerAccountMapDto,
  type LedgerAccountMapPutBody,
  type LedgerAccountMapResponse,
  type LedgerAnalyticsDimension,
  type LedgerAnalyticsMapDto,
  type LedgerAnalyticsMapPutBody,
  type LedgerAnalyticsMapResponse,
  type LedgerAnalyticsMappingInput,
  type LedgerImportBalanceDto,
  type LedgerImportCreateBody,
  type LedgerImportCreateResult,
  type LedgerImportDetail,
  type LedgerImportDetailQuery,
  type LedgerImportEntryDto,
  type LedgerImportEntryKind,
  type LedgerImportEntryStatus,
  type LedgerImportExistingRow,
  type LedgerImportFormat,
  type LedgerImportKind,
  type LedgerImportListQuery,
  type LedgerImportMappingInput,
  type LedgerImportNativeSkippedRow,
  type LedgerImportOptions,
  type LedgerImportOverlapRow,
  type LedgerImportPayrollOverlapRow,
  type LedgerImportPreview,
  type LedgerImportPreviewBody,
  type LedgerImportPreviewMonthRow,
  type LedgerImportPreviewPropertyRow,
  type LedgerImportRecord,
  type LedgerImportStatusCode,
  type LedgerImportUnmappedAccount,
  type LedgerReconciliationDto,
  type LedgerUnassignedPolicy,
  type MoneyString,
  type VatPeriodicityCode
} from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { assertFinanceReadScopeMany, hasEntityReadScope, propertyWithinScope, resolveLedgerScope, type LedgerScope } from "../../../lib/finance-scope.js";
import { HttpError } from "../../../lib/http-error.js";
import { recordAuditEvent } from "../../audit/audit.service.js";
import { requirePermissions } from "../../auth/auth.service.js";
import { resolveSupplierTaxId } from "../../payables/suppliers.service.js";
import {
  CHART_MAX_ACCOUNTS,
  ZERO,
  dateOnlyUtc,
  findJournalEntryBySource,
  isoDay,
  ledgerBadRequest,
  ledgerConflict,
  ledgerNotFound,
  money,
  postJournalEntry,
  resolveFiscalYear,
  reverseJournalEntry,
  type Decimal
} from "../accounting.service.js";
import {
  USALI_DEPARTMENTS,
  USALI_DEPARTMENT_LINES,
  accountGroup,
  accountLevel,
  isPostableCode,
  legacyAccountType,
  prismaChartStore,
  resolveParentCode,
  templateUsaliFor,
  type AccountKind,
  type NewChartAccountRow,
  type UsaliDepartment,
  type UsaliLine
} from "../chart-of-accounts.service.js";
import { assertEntityScopedFiscalInput } from "../fiscal-period.service.js";
import { importClosingNote, markFiscalYearClosedFromImport } from "../fiscal-year.service.js";
import { getVatSettings, normalizeNif, toVatBookCreateInput, type VatBookRow } from "../vat-books.service.js";
import {
  LedgerImportParseError,
  buildCanonicalTemplate,
  canonicalTemplateFileName,
  contentHashOf,
  groupJournalRows,
  normalizeRows,
  sageEntryKeyString,
  type CanonicalBalanceRow,
  type CanonicalJournalRow,
  type CanonicalPlanRow,
  type CanonicalRow,
  type CanonicalRowOf,
  type CanonicalThirdPartyRow,
  type CanonicalVatRow,
  type SageJournalEntry
} from "./ledger-import.canonical.js";
import { LEDGER_ACCOUNT_CODE_PATTERN, isPostableMapping, resolveAccountMapping, suggestAnalyticsMapping, type ChartLookup, type ChartLookupEntry } from "./ledger-import.mapping.js";
import { buildNativeIndex } from "./ledger-import.native.js";
import {
  buildBalanceEntries,
  buildJournalEntries,
  buildVatBookRows,
  type BalanceImportRow,
  type BalancePostingResult,
  type FiscalYearWindow,
  type JournalPostingResult,
  type PlannedEntry,
  type PostingProperty
} from "./ledger-import.posting.js";
import { parseLedgerImportFile } from "./sage200.parser.js";
import { reconcileLedger, type ReconciliationBalanceInput } from "./ledger-reconciliation.service.js";

// ---------------------------------------------------------------------------
// Constantes y tipos
// ---------------------------------------------------------------------------

export const TX_OPTIONS = { maxWait: LEDGER_IMPORT_TX_MAX_WAIT_MS, timeout: LEDGER_IMPORT_TX_TIMEOUT_MS } as const;
const SYSTEM = LEDGER_IMPORT_DEFAULT_SYSTEM;
const IMPORT_NOT_FOUND = "Lote de importación no encontrado.";
const PROPERTY_NOT_FOUND = "Propiedad no encontrada.";
const ENTRY_PAGE_SIZE = 500;
/** Fila de LedgerAnalyticsMap que guarda la configuración (dimensiones y política) del mapa analítico. */
const ANALYTICS_CONFIG_DIMENSION = "config";
const ANALYTICS_CONFIG_CODE = "analytics";
/** Clave de `mappingJson` con las filas canónicas de un borrador (hasta que se contabiliza). */
const DRAFT_ROWS_KEY = "draftRows";
/** Tipos de lote cuyo duplicado por hash es solo aviso (maestros idempotentes). */
const MASTER_KINDS: readonly LedgerImportKind[] = ["plan", "fiscal_years", "third_parties"];
/** Tipos de lote que producen asientos. */
const POSTING_KINDS: readonly LedgerImportKind[] = ["journal", "fiscal_years", "balances"];
/** Tipos de lote con detección de solapes por clave Sage (empresa, ejercicio, periodo, asiento); `vat_books` solapa por sourceId de fila de libro (`findVatOverlaps`). */
const OVERLAP_KINDS: readonly LedgerImportKind[] = ["journal", "balances"];
/** entryKind de los asientos de cierre importados (regularización de Sage + cierre de contabilidad). */
const CLOSING_ENTRY_KINDS: readonly string[] = ["regularization", "closing"];
const IMPORTED_SOURCE_TYPES: readonly string[] = [LEDGER_IMPORT_SOURCE_TYPES.journal, LEDGER_IMPORT_SOURCE_TYPES.balance];
const USALI_COST_CENTRE_TYPE = "usali";
const MAX_SOURCE_KEY_ATTEMPTS = 100;

export type Db = Prisma.TransactionClient | typeof prisma;
type ImportRow = NonNullable<Awaited<ReturnType<typeof prisma.ledgerImport.findUnique>>>;
type EntryRow = NonNullable<Awaited<ReturnType<typeof prisma.ledgerImportEntry.findFirst>>>;
type BalanceRow = NonNullable<Awaited<ReturnType<typeof prisma.ledgerImportBalance.findFirst>>>;
type ChartRow = { id: string; code: string; name: string; kind: string; isPostable: boolean; usaliDepartment: string | null; usaliLine: string | null };
export type PropertyLite = { id: string; code: string | null; name: string; tradeName: string | null; kind: string };

/** Cliente mínimo de `findJournalEntryBySource` (los tests pasan un doble). */
export type SourceKeyClient = Parameters<typeof findJournalEntryBySource>[0];

/** Motivo tipado por el que un lote no se puede contabilizar (la preview lo lista en `blockers`; create lo lanza). */
export type ImportBlocker = { status: 400 | 409; code: string; message: string; details?: Record<string, unknown> };

/** Balance de Sage adjunto a un lote `journal` para reconciliar tras el commit (CLI `--reconcile --balance`). */
export type LedgerImportBalanceAttachment = ReconciliationBalanceInput & { propertyId?: string | null };

// ---------------------------------------------------------------------------
// Errores y decodificación
// ---------------------------------------------------------------------------

/** LedgerImportParseError (L1) → error HTTP tipado con `details.code`; cualquier otro error sigue su camino. */
export function toHttpError(error: unknown): never {
  if (error instanceof LedgerImportParseError) throw ledgerBadRequest(error.code, error.message, error.details ?? {});
  throw error;
}

function blockerError(blocker: ImportBlocker): HttpError {
  return blocker.status === 409 ? ledgerConflict(blocker.code, blocker.message, blocker.details ?? {}) : ledgerBadRequest(blocker.code, blocker.message, blocker.details ?? {});
}

/**
 * `contentBase64` (navegador) o `content` (CSV / JSON canónicos): exactamente uno; bytes >
 * LEDGER_IMPORT_MAX_BYTES → 400 LEDGER_IMPORT_TOO_LARGE { bytes, max }.
 */
export function decodeImportContent(body: { contentBase64?: string | null; content?: string | null }): { bytes?: Uint8Array; content?: string; byteLength: number } {
  const base64 = body.contentBase64?.trim() ?? "";
  if (base64.length > 0) {
    if (base64.length > LEDGER_IMPORT_MAX_BASE64_CHARS) throw ledgerBadRequest("LEDGER_IMPORT_TOO_LARGE", "El fichero supera el tamaño admitido (20 MB): usa el CLI o trocéalo por meses.", { bytes: Math.floor((base64.length * 3) / 4), max: LEDGER_IMPORT_MAX_BYTES });
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));
    if (bytes.length > LEDGER_IMPORT_MAX_BYTES) throw ledgerBadRequest("LEDGER_IMPORT_TOO_LARGE", "El fichero supera el tamaño admitido (20 MB): usa el CLI o trocéalo por meses.", { bytes: bytes.length, max: LEDGER_IMPORT_MAX_BYTES });
    if (bytes.length === 0) throw ledgerBadRequest("LEDGER_IMPORT_EMPTY", "El fichero no contiene datos.");
    return { bytes, byteLength: bytes.length };
  }
  const content = body.content ?? "";
  if (content.length === 0) throw ledgerBadRequest("LEDGER_IMPORT_EMPTY", "No se ha recibido ningún fichero (contentBase64 o content).");
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > LEDGER_IMPORT_MAX_BYTES) throw ledgerBadRequest("LEDGER_IMPORT_TOO_LARGE", "El fichero supera el tamaño admitido (20 MB): usa el CLI o trocéalo por meses.", { bytes: byteLength, max: LEDGER_IMPORT_MAX_BYTES });
  return { content, byteLength };
}

// ---------------------------------------------------------------------------
// Tenencia, ámbito, plan y mapas (compartidos con la reconciliación)
// ---------------------------------------------------------------------------

export async function loadProperties(db: Db, organizationId: string): Promise<PropertyLite[]> {
  const rows = await db.property.findMany({ where: { organizationId }, select: { id: true, code: true, name: true, tradeName: true, kind: true }, orderBy: { createdAt: "asc" } });
  return rows.map((row) => ({ ...row, kind: String(row.kind) }));
}

function officePropertyIdOf(properties: readonly PropertyLite[]): string | null {
  return properties.find((property) => property.kind === "office")?.id ?? null;
}

function assertPropertiesOwned(propertyIds: readonly string[], properties: readonly PropertyLite[]): void {
  const known = new Set(properties.map((property) => property.id));
  for (const propertyId of propertyIds) {
    if (!known.has(propertyId)) throw ledgerNotFound("PROPERTY_NOT_FOUND", PROPERTY_NOT_FOUND, { propertyId });
  }
}

export function propertyCodeOf(properties: readonly PropertyLite[], propertyId: string | null): string {
  if (!propertyId) return LEDGER_IMPORT_SOCIETY_PROPERTY_CODE;
  return properties.find((property) => property.id === propertyId)?.code?.trim() || propertyId;
}

async function lockOrganization(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${LEDGER_IMPORT_ADVISORY_LOCK_PREFIX}${organizationId}`}))`;
}

/** Plan de cuentas de la organización como `ChartLookup` (L1) más las filas con id (altas y padres). */
export async function loadChartLookup(db: Db, organizationId: string): Promise<{ lookup: ChartLookup; rows: ChartRow[] }> {
  const rows = await db.account.findMany({ where: { organizationId }, select: { id: true, code: true, name: true, kind: true, isPostable: true, usaliDepartment: true, usaliLine: true }, orderBy: { code: "asc" }, take: CHART_MAX_ACCOUNTS });
  const lookup = new Map<string, ChartLookupEntry>();
  const out: ChartRow[] = [];
  for (const row of rows) {
    const chartRow: ChartRow = { id: row.id, code: row.code, name: row.name, kind: String(row.kind), isPostable: row.isPostable, usaliDepartment: row.usaliDepartment, usaliLine: row.usaliLine };
    out.push(chartRow);
    lookup.set(row.code, { isPostable: row.isPostable, kind: chartRow.kind, usaliDepartment: row.usaliDepartment, usaliLine: row.usaliLine, name: row.name });
  }
  return { lookup, rows: out };
}

type AccountMapRow = { sourceAccount: string; sourceName: string | null; action: string; accountCode: string | null; usaliDepartment: string | null; usaliLine: string | null; carryCounterparty: boolean };

function accountMapDto(row: AccountMapRow): LedgerAccountMapDto {
  return {
    sourceAccount: row.sourceAccount,
    sourceName: row.sourceName,
    action: row.action as LedgerAccountMapDto["action"],
    accountCode: row.accountCode,
    usaliDepartment: (row.usaliDepartment ?? null) as LedgerAccountMapDto["usaliDepartment"],
    usaliLine: (row.usaliLine ?? null) as LedgerAccountMapDto["usaliLine"],
    carryCounterparty: row.carryCounterparty,
    suggested: false
  };
}

/** Mapa de cuentas persistido de la organización (`LedgerAccountMap`, sistema sage200) por cuenta Sage literal. */
export async function loadPersistedAccountMap(db: Db, organizationId: string): Promise<Map<string, LedgerAccountMapDto>> {
  const rows = await db.ledgerAccountMap.findMany({ where: { organizationId, system: SYSTEM }, orderBy: { sourceAccount: "asc" } });
  return new Map(rows.map((row) => [row.sourceAccount, accountMapDto(row)]));
}

/** Persistido ⊕ enviado (el del cuerpo gana), por cuenta Sage literal. */
export function mergeAccountMaps(persisted: ReadonlyMap<string, LedgerAccountMapDto>, sent: readonly LedgerAccountMapDto[] | undefined): Map<string, LedgerAccountMapDto> {
  const out = new Map(persisted);
  for (const entry of sent ?? []) {
    const sourceAccount = entry.sourceAccount.trim();
    if (!sourceAccount) continue;
    out.set(sourceAccount, { ...entry, sourceAccount, carryCounterparty: entry.carryCounterparty ?? false, suggested: false });
  }
  return out;
}

export type SourceAccountUse = { account: string; name?: string | null; porIva?: string | null };

/**
 * Mapa de cuentas EFECTIVO de un fichero: la entrada explícita (regla 1) o la propuesta de las
 * reglas 2-7 (L1) por cada cuenta Sage usada; `suggested` marca las propuestas.
 */
export function resolveEffectiveAccountMap(uses: readonly SourceAccountUse[], explicit: ReadonlyMap<string, LedgerAccountMapDto>, chart: ChartLookup): Map<string, LedgerAccountMapDto> {
  const byAccount = new Map<string, { name: string | null; porIva: string | null }>();
  for (const use of uses) {
    const account = use.account.trim();
    if (!account) continue;
    const existing = byAccount.get(account) ?? { name: null, porIva: null };
    if (!existing.name && use.name) existing.name = use.name;
    if (!existing.porIva && use.porIva) existing.porIva = use.porIva;
    byAccount.set(account, existing);
  }
  const out = new Map<string, LedgerAccountMapDto>();
  for (const [account, info] of byAccount) {
    const resolved = resolveAccountMapping(account, { explicit, chart, sourceName: info.name, porIva: info.porIva });
    const { rule: _rule, ...dto } = resolved;
    out.set(account, dto);
  }
  return out;
}

type AnalyticsConfig = { centreDimension: LedgerAnalyticsDimension; costCentreDimension: LedgerAnalyticsDimension | null; unassignedPolicy: LedgerUnassignedPolicy };

const DEFAULT_ANALYTICS_CONFIG: AnalyticsConfig = { centreDimension: LEDGER_DEFAULT_CENTRE_DIMENSION, costCentreDimension: LEDGER_DEFAULT_COST_CENTRE_DIMENSION, unassignedPolicy: "block" };

function parseAnalyticsConfig(raw: string | null | undefined): AnalyticsConfig {
  if (!raw) return DEFAULT_ANALYTICS_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<AnalyticsConfig>;
    const centre = (LEDGER_ANALYTICS_DIMENSIONS as readonly string[]).includes(parsed.centreDimension ?? "") ? (parsed.centreDimension as LedgerAnalyticsDimension) : DEFAULT_ANALYTICS_CONFIG.centreDimension;
    const cost = parsed.costCentreDimension === null ? null : (LEDGER_ANALYTICS_DIMENSIONS as readonly string[]).includes(parsed.costCentreDimension ?? "") ? (parsed.costCentreDimension as LedgerAnalyticsDimension) : DEFAULT_ANALYTICS_CONFIG.costCentreDimension;
    const policy = typeof parsed.unassignedPolicy === "string" && isLedgerUnassignedPolicy(parsed.unassignedPolicy) ? parsed.unassignedPolicy : "block";
    return { centreDimension: centre, costCentreDimension: cost, unassignedPolicy: policy };
  } catch {
    return DEFAULT_ANALYTICS_CONFIG;
  }
}

/** Mapa analítico persistido: configuración (fila `config`) + entradas por (dimensión, código Sage). */
export async function loadPersistedAnalyticsMap(db: Db, organizationId: string): Promise<{ config: AnalyticsConfig; persisted: boolean; entries: LedgerAnalyticsMapDto[] }> {
  const rows = await db.ledgerAnalyticsMap.findMany({ where: { organizationId, system: SYSTEM }, orderBy: [{ dimension: "asc" }, { sourceCode: "asc" }] });
  const configRow = rows.find((row) => row.dimension === ANALYTICS_CONFIG_DIMENSION && row.sourceCode === ANALYTICS_CONFIG_CODE);
  const entries = rows
    .filter((row) => row.dimension !== ANALYTICS_CONFIG_DIMENSION)
    .map((row) => ({ dimension: row.dimension as LedgerAnalyticsDimension, sourceCode: row.sourceCode, sourceName: row.sourceName, propertyId: row.propertyId, costCentreCode: row.costCentreCode, suggested: false }));
  return { config: parseAnalyticsConfig(configRow?.sourceName), persisted: configRow !== undefined, entries };
}

function analyticsKey(entry: Pick<LedgerAnalyticsMapDto, "dimension" | "sourceCode">): string {
  return `${entry.dimension}:${entry.sourceCode.trim()}`;
}

function dimensionValueOf(row: CanonicalJournalRow, dimension: LedgerAnalyticsDimension): string | null {
  switch (dimension) {
    case "canal":
      return row.canal;
    case "delegacion":
      return row.delegacion;
    case "departamento":
      return row.departamento;
    case "seccion":
      return row.seccion;
    default:
      return row.proyecto;
  }
}

/**
 * Mapa analítico EFECTIVO: cuerpo (gana) ⊕ persistido ⊕ sugerencias por igualdad exacta de
 * código / nombre / nombre comercial (`suggestAnalyticsMapping`) para los códigos del fichero
 * que sigan sin entrada; la política de apuntes sin analítica sale de options > cuerpo > persistido > block.
 */
export function resolveEffectiveAnalytics(input: {
  sent: LedgerAnalyticsMappingInput | undefined;
  persisted: { config: AnalyticsConfig; entries: LedgerAnalyticsMapDto[] };
  properties: readonly PropertyLite[];
  centreCodes: readonly string[];
  costCentreCodes: readonly string[];
  optionsPolicy: LedgerUnassignedPolicy | undefined;
}): LedgerAnalyticsMappingInput {
  const config: AnalyticsConfig = input.sent
    ? { centreDimension: input.sent.centreDimension, costCentreDimension: input.sent.costCentreDimension ?? null, unassignedPolicy: input.sent.unassignedPolicy }
    : input.persisted.config;
  const merged = new Map<string, LedgerAnalyticsMapDto>();
  for (const entry of input.persisted.entries) merged.set(analyticsKey(entry), { ...entry, suggested: false });
  for (const entry of input.sent?.entries ?? []) merged.set(analyticsKey(entry), { ...entry, sourceCode: entry.sourceCode.trim(), suggested: false });
  const analyticsProperties = input.properties.map((property) => ({ id: property.id, code: property.code, name: property.name, tradeName: property.tradeName }));
  const missingCentres = input.centreCodes.filter((code) => !merged.has(`${config.centreDimension}:${code}`)).map((code) => ({ code }));
  for (const suggestion of suggestAnalyticsMapping(missingCentres, analyticsProperties, config.centreDimension)) {
    if (suggestion.propertyId) merged.set(analyticsKey(suggestion), { ...suggestion, costCentreCode: null, suggested: true });
  }
  if (config.costCentreDimension) {
    const missingCost = input.costCentreCodes.filter((code) => !merged.has(`${config.costCentreDimension}:${code}`)).map((code) => ({ code }));
    for (const suggestion of suggestAnalyticsMapping(missingCost, analyticsProperties, config.costCentreDimension)) {
      if (suggestion.costCentreCode) merged.set(analyticsKey(suggestion), { ...suggestion, propertyId: null, suggested: true });
    }
  }
  return {
    centreDimension: config.centreDimension,
    costCentreDimension: config.costCentreDimension,
    unassignedPolicy: input.optionsPolicy ?? config.unassignedPolicy,
    entries: [...merged.values()].sort((a, b) => a.dimension.localeCompare(b.dimension) || a.sourceCode.localeCompare(b.sourceCode))
  };
}

/** true si la organización NO tiene fila `vat_settings` (getVatSettings devolvería los defaults: no sirve para detectarlo). Nunca la crea. */
export async function isVatSettingsMissing(client: Pick<Prisma.TransactionClient, "vatSettings">, organizationId: string): Promise<boolean> {
  const row = await client.vatSettings.findUnique({ where: { organizationId }, select: { id: true } });
  return row === null;
}

// ---------------------------------------------------------------------------
// Ejercicio, periodos y claves
// ---------------------------------------------------------------------------

const YEAR_CODE = /^\d{4}$/;

function naturalYearWindow(code: string): FiscalYearWindow {
  return { code, startDate: `${code}-01-01`, endDate: `${code}-12-31` };
}

async function fiscalYearWindow(db: Db, organizationId: string, code: string): Promise<{ window: FiscalYearWindow; row: { id: string; status: string } | null }> {
  const row = await db.fiscalYear.findFirst({ where: { organizationId, propertyId: null, code }, select: { id: true, status: true, startDate: true, endDate: true } });
  if (!row) return { window: naturalYearWindow(code), row: null };
  return { window: { code, startDate: isoDay(row.startDate), endDate: isoDay(row.endDate) }, row: { id: row.id, status: row.status } };
}

function yearCodeBlocker(code: string): ImportBlocker {
  return { status: 400, code: "LEDGER_IMPORT_YEAR_CODE_INVALID", message: `El código del ejercicio debe ser el año natural (por ejemplo 2026); el fichero trae «${code}».`, details: { code } };
}

/** "YYYY-MM" del primer / último asiento planificado (o del periodo de saldos). */
function periodRangeOf(entries: readonly PlannedEntry[], balances: readonly BalanceImportRow[]): { periodFrom: string | null; periodTo: string | null } {
  const months = new Set<string>();
  for (const entry of entries) months.add(entry.entryDate.slice(0, 7));
  for (const balance of balances) {
    if (balance.periodCode === LEDGER_IMPORT_OPENING_PERIOD_CODE) continue;
    let match = /^(\d{4})-(\d{2})$/.exec(balance.periodCode);
    if (match) months.add(balance.periodCode);
    match = /^(\d{4})-Q(\d)$/.exec(balance.periodCode);
    if (match) {
      const quarter = Number(match[2]);
      months.add(`${match[1]}-${String(quarter * 3 - 2).padStart(2, "0")}`);
      months.add(`${match[1]}-${String(quarter * 3).padStart(2, "0")}`);
    }
    if (/^\d{4}$/.test(balance.periodCode)) {
      months.add(`${balance.periodCode}-01`);
      months.add(`${balance.periodCode}-12`);
    }
  }
  const sorted = [...months].sort();
  return { periodFrom: sorted[0] ?? null, periodTo: sorted[sorted.length - 1] ?? null };
}

/**
 * Clave de idempotencia que verá el motor: `sourceId`, o `sourceId#<n>` cuando toda clave
 * previa está reversed (reimplementación de treasury/ledger-bridge.ts `resolveSourceKey`).
 * Devuelve también el asiento VIVO si la clave ya está contabilizada (→ fila skipped_existing).
 */
export async function resolveSourceKey(client: SourceKeyClient, organizationId: string, sourceType: string, sourceId: string): Promise<{ key: string; live: { id: string; entryNumber: number | null; fiscalYearCode: string | null } | null }> {
  for (let n = 0; n < MAX_SOURCE_KEY_ATTEMPTS; n++) {
    const candidate = n === 0 ? sourceId : `${sourceId}#${n}`;
    const existing = await findJournalEntryBySource(client, organizationId, sourceType, candidate);
    if (!existing) return { key: candidate, live: null };
    if (existing.status !== "reversed") return { key: candidate, live: { id: existing.id, entryNumber: existing.entryNumber, fiscalYearCode: existing.fiscalYearCode } };
  }
  return { key: `${sourceId}#${Date.now()}`, live: null };
}

/**
 * Índice de claves de idempotencia ya usadas por (sourceType, ejercicio): UNA consulta por lote en
 * vez de una por asiento planificado (hasta 20.000 por petición). `resolveSourceKeyFromIndex`
 * replica en memoria la lógica de `resolveSourceKey` (clave viva → skipped_existing; toda clave
 * previa reversed → sufijo #n libre).
 */
export type SourceKeyIndex = Map<string, Array<{ id: string; sourceId: string; status: string; entryNumber: number | null; fiscalYearCode: string | null }>>;

function baseSourceKey(sourceId: string): string {
  return sourceId.replace(/#\d+$/, "");
}

export async function loadSourceKeyIndex(db: Db, organizationId: string, sourceTypes: readonly string[], fiscalYearCodes: readonly string[]): Promise<SourceKeyIndex> {
  const index: SourceKeyIndex = new Map();
  if (sourceTypes.length === 0) return index;
  const rows = await db.journalEntry.findMany({
    where: { organizationId, sourceType: { in: [...sourceTypes] }, ...(fiscalYearCodes.length > 0 ? { fiscalYearCode: { in: [...fiscalYearCodes] } } : {}) },
    select: { id: true, sourceType: true, sourceId: true, status: true, entryNumber: true, fiscalYearCode: true }
  });
  for (const row of rows) {
    if (!row.sourceId) continue;
    const key = `${row.sourceType}|${baseSourceKey(row.sourceId)}`;
    index.set(key, [...(index.get(key) ?? []), { id: row.id, sourceId: row.sourceId, status: row.status, entryNumber: row.entryNumber, fiscalYearCode: row.fiscalYearCode }]);
  }
  return index;
}

/** Misma respuesta que `resolveSourceKey`, resuelta sobre el índice cargado (sin consultas). */
export function resolveSourceKeyFromIndex(index: SourceKeyIndex, sourceType: string, sourceId: string): { key: string; live: { id: string; entryNumber: number | null; fiscalYearCode: string | null } | null } {
  const rows = index.get(`${sourceType}|${sourceId}`) ?? [];
  const bySourceId = new Map(rows.map((row) => [row.sourceId, row]));
  for (let n = 0; n < MAX_SOURCE_KEY_ATTEMPTS; n++) {
    const candidate = n === 0 ? sourceId : `${sourceId}#${n}`;
    const existing = bySourceId.get(candidate);
    if (!existing) return { key: candidate, live: null };
    if (existing.status !== "reversed") return { key: candidate, live: { id: existing.id, entryNumber: existing.entryNumber, fiscalYearCode: existing.fiscalYearCode } };
  }
  return { key: `${sourceId}#${Date.now()}`, live: null };
}

/** Empresa del fichero frente a la sociedad: solo se compara cuando el fichero trae un NIF (un CodigoEmpresa numérico no es comparable). */
export function assertCompanyMatches(fileCompany: string | null | undefined, identityTaxId: string | null | undefined): void {
  const raw = fileCompany?.trim() ?? "";
  if (!raw || !/[A-Za-z]/.test(raw) || raw.length < 8) return;
  const normalized = normalizeNif(raw);
  const entity = normalizeNif(identityTaxId ?? null);
  if (normalized && entity && normalized !== entity) {
    throw ledgerBadRequest("LEDGER_IMPORT_COMPANY_MISMATCH", "La empresa del fichero no es la sociedad de esta organización.", { fileCompany: normalized, entity });
  }
}

// ---------------------------------------------------------------------------
// Análisis (parseo + mapeo + regla contable): compartido por preview, create y post
// ---------------------------------------------------------------------------

type PlanOutcome = "create" | "exists" | "conflict" | "mapped" | "blocked";

export type PlanAction = {
  row: CanonicalPlanRow;
  mapping: LedgerAccountMapDto;
  outcome: PlanOutcome;
  /** Solo `create`: fila lista para `createAccounts`. */
  newAccount?: Omit<NewChartAccountRow, "organizationId"> & { parentCode: string | null };
  message?: string;
};

export type Analysis = {
  kind: LedgerImportKind;
  format: LedgerImportFormat;
  fileName: string | null;
  contentHash: string;
  rowCount: number;
  rows: CanonicalRow[];
  sourceCompanyCode: string | null;
  fiscalYearCode: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  scope: LedgerScope;
  properties: PropertyLite[];
  officePropertyId: string | null;
  chart: ChartLookup;
  chartRows: ChartRow[];
  accountMap: Map<string, LedgerAccountMapDto>;
  analytics: LedgerAnalyticsMappingInput;
  options: LedgerImportOptions;
  /** Asientos planificados (journal / fiscal_years / balances) en orden de contabilización. */
  planned: PlannedEntry[];
  sageEntries: Map<string, SageJournalEntry>;
  journal: JournalPostingResult | null;
  balances: BalancePostingResult | null;
  vatRows: VatBookRow[];
  /** Filas del libro de Sage que son documentos propios de Anfitorio (§5.1): no se importan. */
  vatSkippedNative: LedgerImportNativeSkippedRow[];
  planActions: PlanAction[];
  thirdParties: CanonicalThirdPartyRow[];
  fiscalYears: Map<string, { window: FiscalYearWindow; row: { id: string; status: string } | null }>;
  existing: LedgerImportExistingRow[];
  duplicate: ImportRow | null;
  overlaps: LedgerImportOverlapRow[];
  payrollCostImportsPosted: LedgerImportPayrollOverlapRow[];
  existingNativeEntries: number;
  vatSettingsMissing: boolean;
  periodicity: VatPeriodicityCode;
  warnings: string[];
  blockers: ImportBlocker[];
  totals: { debit: Decimal; credit: Decimal; lines: number };
};

type AnalyseInput = {
  organizationId: string;
  scopeContext: UserContext;
  kind: LedgerImportKind;
  format: LedgerImportFormat;
  fileName: string | null;
  rows: CanonicalRow[];
  rowCount: number;
  parseWarnings: string[];
  company: string | null;
  mapping: LedgerImportMappingInput | undefined;
  options: LedgerImportOptions;
  legalEntityId?: string | null;
  db: Db;
  excludeImportId?: string;
};

function rowsAs<K extends LedgerImportKind>(rows: CanonicalRow[]): CanonicalRowOf<K>[] {
  return rows as unknown as CanonicalRowOf<K>[];
}

function isPnlCode(accountCode: string): boolean {
  const group = accountGroup(accountCode);
  return group === 6 || group === 7;
}

function thirdPartyRoleOf(sourceAccount: string): "customer" | "supplier" | null {
  const prefix = sourceAccount.trim().slice(0, 3);
  if (["430", "431", "435"].includes(prefix)) return "customer";
  if (["400", "401", "410", "411"].includes(prefix)) return "supplier";
  return null;
}

function usaliFor(mapping: LedgerAccountMapDto, code: string): { usaliDepartment: string; usaliLine: string } | null {
  if (mapping.usaliDepartment && mapping.usaliLine) return { usaliDepartment: mapping.usaliDepartment, usaliLine: mapping.usaliLine };
  const prefix = code.split(".")[0] ?? code;
  const template = templateUsaliFor(prefix) ?? templateUsaliFor(prefix.slice(0, 3));
  return template ? { usaliDepartment: template.usaliDepartment, usaliLine: template.usaliLine } : null;
}

function usaliValid(usali: { usaliDepartment: string; usaliLine: string }): boolean {
  const lines = USALI_DEPARTMENT_LINES[usali.usaliDepartment as UsaliDepartment];
  return Array.isArray(lines) && (lines as readonly string[]).includes(usali.usaliLine as UsaliLine);
}

/** Acciones del lote `plan` sobre el plan de la organización (puro sobre el lookup del plan). */
export function planActionsOf(rows: readonly CanonicalPlanRow[], explicit: ReadonlyMap<string, LedgerAccountMapDto>, chart: ChartLookup): { actions: PlanAction[]; blockers: ImportBlocker[] } {
  const actions: PlanAction[] = [];
  const blockers: ImportBlocker[] = [];
  const codesKnown = new Set(chart.keys());
  const conflicts: string[] = [];
  const kindRequired: string[] = [];
  const usaliMissing: string[] = [];
  for (const row of rows) {
    const resolved = resolveAccountMapping(row.cuenta, { explicit, chart, sourceName: row.titulo });
    const { rule: _rule, ...mapping } = resolved;
    if (mapping.action === "block" || !mapping.accountCode) {
      actions.push({ row, mapping, outcome: "blocked" });
      continue;
    }
    if (mapping.action !== "create") {
      actions.push({ row, mapping, outcome: "mapped" });
      continue;
    }
    const code = mapping.accountCode;
    const name = (row.titulo ?? mapping.sourceName ?? "").trim() || `Cuenta ${row.cuenta}`;
    const existing = chart.get(code);
    if (existing) {
      if ((existing.name ?? "").trim() === name) {
        actions.push({ row, mapping, outcome: "exists" });
      } else {
        conflicts.push(code);
        actions.push({ row, mapping, outcome: "conflict", message: `La cuenta ${code} ya existe con otro nombre («${existing.name ?? ""}»); el plan nunca renombra.` });
      }
      continue;
    }
    if (!LEDGER_ACCOUNT_CODE_PATTERN.test(code)) {
      actions.push({ row, mapping, outcome: "blocked", message: `Código ${code} fuera del patrón PGC.` });
      continue;
    }
    if (name.length < 2 || name.length > 200) {
      actions.push({ row, mapping, outcome: "blocked", message: `El nombre de la cuenta ${code} debe tener entre 2 y 200 caracteres.` });
      continue;
    }
    const parentCode = resolveParentCode(code, codesKnown);
    const parent = parentCode ? chart.get(parentCode) : undefined;
    if (!parent) {
      kindRequired.push(code);
      actions.push({ row, mapping, outcome: "blocked", message: `La cuenta ${code} no tiene cuenta padre en el plan de la que heredar la naturaleza.` });
      continue;
    }
    const group = accountGroup(code);
    let usali: { usaliDepartment: string; usaliLine: string } | null = null;
    if (group === 6 || group === 7) {
      usali = usaliFor(mapping, code);
      if (!usali || !usaliValid(usali)) {
        usaliMissing.push(code);
        actions.push({ row, mapping, outcome: "blocked", message: `La cuenta ${code} (grupo ${group}) necesita departamento y línea USALI válidos.` });
        continue;
      }
    }
    const kind = parent.kind as AccountKind;
    actions.push({
      row,
      mapping: { ...mapping, usaliDepartment: (usali?.usaliDepartment ?? null) as LedgerAccountMapDto["usaliDepartment"], usaliLine: (usali?.usaliLine ?? null) as LedgerAccountMapDto["usaliLine"] },
      outcome: "create",
      newAccount: {
        code,
        name,
        kind,
        accountType: legacyAccountType(kind),
        group,
        level: accountLevel(code),
        isPostable: isPostableCode(code),
        usaliDepartment: usali?.usaliDepartment ?? null,
        usaliLine: usali?.usaliLine ?? null,
        parentCode
      }
    });
    codesKnown.add(code);
  }
  if (conflicts.length > 0) blockers.push({ status: 409, code: "ACCOUNT_CODE_EXISTS", message: `${conflicts.length} cuenta(s) ya existen en el plan con otro nombre (${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? "…" : ""}): el plan nunca renombra.`, details: { accounts: conflicts } });
  if (kindRequired.length > 0) blockers.push({ status: 400, code: "ACCOUNT_KIND_REQUIRED", message: `${kindRequired.length} cuenta(s) sin cuenta padre de la que heredar la naturaleza: ${kindRequired.slice(0, 5).join(", ")}.`, details: { accounts: kindRequired } });
  if (usaliMissing.length > 0) blockers.push({ status: 400, code: "USALI_MAPPING_INCOMPLETE", message: `${usaliMissing.length} cuenta(s) de grupos 6/7 sin departamento y línea USALI válidos: ${usaliMissing.slice(0, 5).join(", ")}.`, details: { accounts: usaliMissing } });
  return { actions, blockers };
}

async function findDuplicateImport(db: Db, organizationId: string, contentHash: string, excludeImportId?: string): Promise<ImportRow | null> {
  return db.ledgerImport.findFirst({ where: { organizationId, contentHash, status: { not: "reversed" }, ...(excludeImportId ? { id: { not: excludeImportId } } : {}) }, orderBy: { createdAt: "desc" } });
}

export type SageEntryKey = { sourceCompanyCode: string; sourceFiscalYear: string; sourcePeriod: string; sourceEntryNumber: string };

export function sageKeyOf(key: SageEntryKey): string {
  return [key.sourceCompanyCode, key.sourceFiscalYear, key.sourcePeriod, key.sourceEntryNumber].join(":");
}

/** Claves Sage (empresa, ejercicio, periodo, asiento) de los asientos planificados (los de saldos usan el periodo como nº). */
export function plannedKeysOf(entries: readonly PlannedEntry[]): SageEntryKey[] {
  const out = new Map<string, SageEntryKey>();
  for (const entry of entries) {
    const key = entryKeyOf(entry);
    out.set(sageKeyOf(key), key);
  }
  return [...out.values()];
}

function entryKeyOf(entry: PlannedEntry): SageEntryKey {
  if (entry.source) return { sourceCompanyCode: entry.source.companyCode, sourceFiscalYear: entry.source.fiscalYear, sourcePeriod: entry.source.period, sourceEntryNumber: entry.source.entryNumber };
  const [company = "", year = entry.fiscalYearCode, period = ""] = entry.sourceId.split(":");
  return { sourceCompanyCode: company, sourceFiscalYear: year, sourcePeriod: period, sourceEntryNumber: period };
}

/** Solapes agrupados por lote a partir de las filas `posted` de otros lotes que comparten clave (puro). */
export function overlapRowsOf(keys: readonly SageEntryKey[], posted: ReadonlyArray<SageEntryKey & { importId: string; status: string; periodFrom: string | null; periodTo: string | null }>): LedgerImportOverlapRow[] {
  const wanted = new Set(keys.map(sageKeyOf));
  const byImport = new Map<string, LedgerImportOverlapRow & { seen: Set<string> }>();
  for (const row of posted) {
    const key = sageKeyOf(row);
    if (!wanted.has(key)) continue;
    const existing = byImport.get(row.importId) ?? { importId: row.importId, status: row.status as LedgerImportStatusCode, periodFrom: row.periodFrom, periodTo: row.periodTo, entries: 0, seen: new Set<string>() };
    if (!existing.seen.has(key)) {
      existing.seen.add(key);
      existing.entries += 1;
    }
    byImport.set(row.importId, existing);
  }
  return [...byImport.values()].map(({ seen: _seen, ...row }) => row).sort((a, b) => a.importId.localeCompare(b.importId));
}

async function findOverlaps(db: Db, organizationId: string, kind: LedgerImportKind, keys: readonly SageEntryKey[], excludeImportId?: string): Promise<LedgerImportOverlapRow[]> {
  if (keys.length === 0 || !OVERLAP_KINDS.includes(kind)) return [];
  const years = [...new Set(keys.map((key) => key.sourceFiscalYear))];
  const rows = await db.ledgerImportEntry.findMany({
    where: { organizationId, status: "posted", sourceFiscalYear: { in: years }, import: { status: "posted", kind, ...(excludeImportId ? { id: { not: excludeImportId } } : {}) } },
    select: { importId: true, sourceCompanyCode: true, sourceFiscalYear: true, sourcePeriod: true, sourceEntryNumber: true, import: { select: { status: true, periodFrom: true, periodTo: true } } }
  });
  return overlapRowsOf(keys, rows.map((row) => ({ importId: row.importId, status: row.import.status, periodFrom: row.import.periodFrom, periodTo: row.import.periodTo, sourceCompanyCode: row.sourceCompanyCode, sourceFiscalYear: row.sourceFiscalYear, sourcePeriod: row.sourcePeriod, sourceEntryNumber: row.sourceEntryNumber })));
}

async function findPayrollCostImportsPosted(db: Db, organizationId: string, periodFrom: string | null, periodTo: string | null): Promise<LedgerImportPayrollOverlapRow[]> {
  if (!periodFrom || !periodTo) return [];
  const rows = await db.payrollCostImport.findMany({ where: { organizationId, status: "posted", periodFrom: { lte: periodTo }, periodTo: { gte: periodFrom } }, select: { id: true, periodFrom: true, periodTo: true }, orderBy: { periodFrom: "asc" } });
  return rows.map((row) => ({ importId: row.id, periodFrom: row.periodFrom, periodTo: row.periodTo }));
}

/** Asientos vivos del ejercicio que NO vienen de Sage (la numeración quedará intercalada). */
async function countNativeEntries(db: Db, organizationId: string, fiscalYearCode: string | null): Promise<number> {
  if (!fiscalYearCode) return 0;
  return db.journalEntry.count({ where: { organizationId, fiscalYearCode, status: { not: "draft" }, sourceType: { notIn: [...IMPORTED_SOURCE_TYPES] } } });
}

/** Asientos planificados cuya clave ya está viva en el diario (importados antes, por este u otro tipo de lote); una consulta por lote. */
async function findExistingEntries(db: Db, organizationId: string, planned: readonly PlannedEntry[]): Promise<LedgerImportExistingRow[]> {
  if (planned.length === 0) return [];
  const index = await loadSourceKeyIndex(db, organizationId, [...new Set(planned.map((entry) => entry.sourceType))], [...new Set(planned.map((entry) => entry.fiscalYearCode))]);
  const out: LedgerImportExistingRow[] = [];
  for (const entry of planned) {
    const resolved = resolveSourceKeyFromIndex(index, entry.sourceType, entry.sourceId);
    if (!resolved.live) continue;
    const key = entryKeyOf(entry);
    out.push({ sourceEntryNumber: key.sourceEntryNumber, sourcePeriod: key.sourcePeriod, journalEntryId: resolved.live.id, entryNumber: resolved.live.entryNumber, fiscalYearCode: resolved.live.fiscalYearCode });
  }
  return out;
}

/** Solapes de un lote `vat_books`: otros lotes `vat_books` posted que ya escribieron alguna de las filas (mismo sourceId de libro). */
async function findVatOverlaps(db: Db, organizationId: string, vatRows: readonly VatBookRow[], excludeImportId?: string): Promise<LedgerImportOverlapRow[]> {
  const sourceIds = [...new Set(vatRows.map((row) => row.sourceId))];
  if (sourceIds.length === 0) return [];
  const rows = await db.ledgerImportEntry.findMany({
    where: { organizationId, status: "posted", sourceType: LEDGER_VAT_BOOK_SOURCE_TYPE, sourceId: { in: sourceIds }, import: { status: "posted", kind: "vat_books", ...(excludeImportId ? { id: { not: excludeImportId } } : {}) } },
    select: { importId: true, sourceId: true, import: { select: { status: true, periodFrom: true, periodTo: true } } }
  });
  const byImport = new Map<string, LedgerImportOverlapRow & { seen: Set<string> }>();
  for (const row of rows) {
    const existing = byImport.get(row.importId) ?? { importId: row.importId, status: row.import.status as LedgerImportStatusCode, periodFrom: row.import.periodFrom, periodTo: row.import.periodTo, entries: 0, seen: new Set<string>() };
    if (row.sourceId && !existing.seen.has(row.sourceId)) {
      existing.seen.add(row.sourceId);
      existing.entries += 1;
    }
    byImport.set(row.importId, existing);
  }
  return [...byImport.values()].map(({ seen: _seen, ...row }) => row).sort((a, b) => a.importId.localeCompare(b.importId));
}

/** Solapes del análisis según el tipo de lote: por clave Sage (journal / balances) o por sourceId de fila de libro (vat_books). */
async function findOverlapsOf(db: Db, organizationId: string, analysis: Pick<Analysis, "kind" | "planned" | "vatRows">, excludeImportId?: string): Promise<LedgerImportOverlapRow[]> {
  return analysis.kind === "vat_books" ? findVatOverlaps(db, organizationId, analysis.vatRows, excludeImportId) : findOverlaps(db, organizationId, analysis.kind, plannedKeysOf(analysis.planned), excludeImportId);
}

/**
 * Diseño §4.1: `balances` solo para ejercicios SIN diario. Un lote de saldos sobre un ejercicio con
 * diario o apertura importados duplicaría apertura, movimientos, regularización y cierre (y al
 * revés: un diario sobre un ejercicio con saldos importados). 409 LEDGER_IMPORT_OVERLAP que
 * `replace` no levanta (habría que revertir el lote anterior a mano).
 */
async function findYearKindConflicts(db: Db, organizationId: string, kind: LedgerImportKind, fiscalYearCode: string | null, plansOpening: boolean, excludeImportId?: string): Promise<ImportBlocker[]> {
  if (!fiscalYearCode || (kind !== "balances" && kind !== "journal")) return [];
  const otherKinds: LedgerImportKind[] = kind === "balances" ? ["journal", "fiscal_years"] : ["balances"];
  const posted = await db.ledgerImportEntry.findMany({
    where: { organizationId, status: "posted", sourceFiscalYear: fiscalYearCode, journalEntryId: { not: null }, import: { status: "posted", kind: { in: otherKinds }, ...(excludeImportId ? { id: { not: excludeImportId } } : {}) } },
    select: { importId: true, import: { select: { kind: true, periodFrom: true, periodTo: true } } }
  });
  const blockers: ImportBlocker[] = [];
  if (posted.length > 0) {
    const byImport = new Map<string, { kind: string; periodFrom: string | null; periodTo: string | null; entries: number }>();
    for (const row of posted) {
      const existing = byImport.get(row.importId) ?? { kind: row.import.kind, periodFrom: row.import.periodFrom, periodTo: row.import.periodTo, entries: 0 };
      existing.entries += 1;
      byImport.set(row.importId, existing);
    }
    const overlaps = [...byImport].map(([importId, row]) => ({ importId, status: "posted" as LedgerImportStatusCode, periodFrom: row.periodFrom, periodTo: row.periodTo, entries: row.entries }));
    const message = kind === "balances"
      ? `El ejercicio ${fiscalYearCode} ya tiene ${posted.length} asiento(s) importados de diario o apertura (${[...byImport.keys()].join(", ")}): el lote de saldos solo es para ejercicios sin diario; revierte antes esos lotes.`
      : `El ejercicio ${fiscalYearCode} ya tiene saldos importados (${[...byImport.keys()].join(", ")}): un diario sobre ese ejercicio duplicaría los movimientos; revierte antes el lote de saldos.`;
    blockers.push({ status: 409, code: "LEDGER_IMPORT_OVERLAP", message, details: { overlaps, fiscalYearCode } });
  }
  if (kind === "balances" && plansOpening) {
    const opening = await db.journalEntry.findFirst({ where: { organizationId, fiscalYearCode, entryKind: "opening", status: { not: "draft" }, reversedById: null }, select: { id: true, sourceType: true, entryNumber: true } });
    if (opening && !posted.length) {
      blockers.push({ status: 409, code: "LEDGER_IMPORT_OVERLAP", message: `El ejercicio ${fiscalYearCode} ya tiene un asiento de apertura (${opening.sourceType}, nº ${opening.entryNumber ?? "?"}): el lote de saldos crearía una segunda apertura.`, details: { overlaps: [], fiscalYearCode, journalEntryId: opening.id } });
    }
  }
  return blockers;
}

/** Bloqueantes de un análisis (en español; `create` lanza el primero). Puro sobre el resultado. */
export function computeBlockers(input: {
  kind: LedgerImportKind;
  replace: boolean;
  duplicate: { id: string; status: string; fileName: string | null; createdAt: Date } | null;
  overlaps: readonly LedgerImportOverlapRow[];
  journal: Pick<JournalPostingResult, "unmapped" | "unmappedAnalytics" | "centreRequired" | "unbalanced" | "errors"> | null;
  balances: Pick<BalancePostingResult, "unmapped" | "centreRequired" | "unbalanced"> | null;
  plannedCount: number;
  vatSettingsMissing: boolean;
  extra?: readonly ImportBlocker[];
}): ImportBlocker[] {
  const blockers: ImportBlocker[] = [...(input.extra ?? [])];
  const unmapped = [...(input.journal?.unmapped ?? []), ...(input.balances?.unmapped ?? [])];
  if (unmapped.length > 0) blockers.push({ status: 400, code: "LEDGER_IMPORT_ACCOUNT_UNMAPPED", message: `${unmapped.length} cuenta(s) de Sage sin mapear o bloqueadas: ${unmapped.slice(0, 5).map((row) => row.sourceAccount).join(", ")}${unmapped.length > 5 ? "…" : ""}. Complétalas en el mapa de cuentas.`, details: { accounts: unmapped.map((row) => row.sourceAccount), unmappedAccounts: unmapped } });
  const unmappedAnalytics = input.journal?.unmappedAnalytics ?? [];
  if (unmappedAnalytics.length > 0) blockers.push({ status: 400, code: "LEDGER_IMPORT_ANALYTICS_UNMAPPED", message: `${unmappedAnalytics.length} código(s) analítico(s) sin centro asignado: ${unmappedAnalytics.slice(0, 5).map((row) => row.sourceCode).join(", ")}${unmappedAnalytics.length > 5 ? "…" : ""}. Complétalos en el mapa analítico.`, details: { codes: unmappedAnalytics.map((row) => row.sourceCode), unmappedAnalytics } });
  const centreRequired = [...(input.journal?.centreRequired ?? []), ...(input.balances?.centreRequired ?? [])];
  if (centreRequired.length > 0) blockers.push({ status: 400, code: "LEDGER_IMPORT_CENTRE_REQUIRED", message: `${centreRequired.length} asiento(s) con gastos o ingresos sin centro de trabajo (política «block»): asigna un centro o cambia la política.`, details: { entries: centreRequired } });
  const unbalanced = [...(input.journal?.unbalanced ?? []), ...(input.balances?.unbalanced ?? [])];
  if (unbalanced.length > 0) blockers.push({ status: 400, code: "LEDGER_IMPORT_UNBALANCED", message: `${unbalanced.length} asiento(s) de Sage descuadrado(s): revisa la exportación.`, details: { entries: unbalanced } });
  const errors = input.journal?.errors ?? [];
  if (errors.length > 0) blockers.push({ status: 400, code: "LEDGER_IMPORT_INVALID", message: `${errors.length} asiento(s) no se pueden contabilizar: ${errors.slice(0, 3).map((error) => `${error.sourceEntryNumber}: ${error.message}`).join("; ")}${errors.length > 3 ? "…" : ""}`, details: { errors: errors.map((error) => ({ line: 0, message: `asiento ${error.sourceEntryNumber} (periodo ${error.sourcePeriod}): ${error.message}` })) } });
  if (input.plannedCount > LEDGER_IMPORT_MAX_ENTRIES_PER_BATCH) blockers.push({ status: 400, code: "LEDGER_IMPORT_TOO_MANY_ENTRIES", message: `El lote produce ${input.plannedCount} asientos y el máximo es ${LEDGER_IMPORT_MAX_ENTRIES_PER_BATCH}: trocéalo por meses.`, details: { entries: input.plannedCount, max: LEDGER_IMPORT_MAX_ENTRIES_PER_BATCH } });
  if (input.kind === "vat_books" && input.vatSettingsMissing) blockers.push({ status: 409, code: "LEDGER_IMPORT_VAT_SETTINGS_MISSING", message: "Falta la configuración de IVA de la organización (periodicidad y régimen): configúrala antes de importar libros." });
  if (input.duplicate && !MASTER_KINDS.includes(input.kind) && !input.replace) blockers.push({ status: 409, code: "LEDGER_IMPORT_DUPLICATE", message: `Este fichero ya se importó (lote ${input.duplicate.id}, ${input.duplicate.status === "posted" ? "contabilizado" : "en borrador"}): revierte el lote anterior o usa «sustituir».`, details: { importId: input.duplicate.id, fileName: input.duplicate.fileName, createdAt: input.duplicate.createdAt.toISOString(), status: input.duplicate.status } });
  if (input.overlaps.length > 0 && !input.replace) blockers.push({ status: 409, code: "LEDGER_IMPORT_OVERLAP", message: `${input.overlaps.length} lote(s) ya cubren asientos de este fichero: usa «sustituir» (reverso entero + lote nuevo).`, details: { overlaps: input.overlaps } });
  return blockers;
}

async function analyseRows(input: AnalyseInput): Promise<Analysis> {
  const { db, organizationId, kind, options } = input;
  const replace = options.replace === true;
  const warnings = [...input.parseWarnings];
  const scope = await resolveLedgerScope(input.scopeContext, { legalEntityId: input.legalEntityId ?? null }, db);
  assertCompanyMatches(input.company, scope.identity.taxId);
  const [properties, chartLoaded, persistedMap, persistedAnalytics] = await Promise.all([loadProperties(db, organizationId), loadChartLookup(db, organizationId), loadPersistedAccountMap(db, organizationId), loadPersistedAnalyticsMap(db, organizationId)]);
  const explicit = mergeAccountMaps(persistedMap, input.mapping?.accounts);
  const officePropertyId = officePropertyIdOf(properties);
  const postingProperties: PostingProperty[] = properties.map((property) => ({ id: property.id, code: property.code, name: property.name }));
  const vatSettingsMissing = await isVatSettingsMissing(db, organizationId);
  const periodicity: VatPeriodicityCode = vatSettingsMissing ? "quarterly" : (await getVatSettings(organizationId, db)).periodicity;

  const analysis: Analysis = {
    kind,
    format: input.format,
    fileName: input.fileName,
    contentHash: contentHashOf(kind, rowsAs(input.rows)),
    rowCount: input.rowCount,
    rows: input.rows,
    sourceCompanyCode: input.company,
    fiscalYearCode: null,
    periodFrom: null,
    periodTo: null,
    scope,
    properties,
    officePropertyId,
    chart: chartLoaded.lookup,
    chartRows: chartLoaded.rows,
    accountMap: new Map(),
    analytics: { centreDimension: persistedAnalytics.config.centreDimension, costCentreDimension: persistedAnalytics.config.costCentreDimension, unassignedPolicy: options.unassignedPolicy ?? persistedAnalytics.config.unassignedPolicy, entries: persistedAnalytics.entries },
    options,
    planned: [],
    sageEntries: new Map(),
    journal: null,
    balances: null,
    vatRows: [],
    vatSkippedNative: [],
    planActions: [],
    thirdParties: [],
    fiscalYears: new Map(),
    existing: [],
    duplicate: null,
    overlaps: [],
    payrollCostImportsPosted: [],
    existingNativeEntries: 0,
    vatSettingsMissing,
    periodicity,
    warnings,
    blockers: [],
    totals: { debit: ZERO, credit: ZERO, lines: 0 }
  };
  const extraBlockers: ImportBlocker[] = [];

  if (kind === "journal" || kind === "fiscal_years") {
    const rows = rowsAs<"journal">(input.rows);
    const years = [...new Set(rows.map((row) => row.ejercicio))].sort();
    const expected = options.fiscalYearCode?.trim();
    if (expected && !YEAR_CODE.test(expected)) extraBlockers.push(yearCodeBlocker(expected));
    for (const year of years) {
      if (!YEAR_CODE.test(year)) extraBlockers.push(yearCodeBlocker(year));
      else if (expected && YEAR_CODE.test(expected) && year !== expected) extraBlockers.push({ status: 400, code: "LEDGER_IMPORT_YEAR_CODE_INVALID", message: `El fichero trae el ejercicio ${year} y el lote esperaba ${expected}.`, details: { code: year, expected } });
    }
    if (kind === "journal" && years.length > 1) extraBlockers.push({ status: 400, code: "LEDGER_IMPORT_YEAR_CODE_INVALID", message: `El diario mezcla ${years.length} ejercicios (${years.join(", ")}): importa un ejercicio por lote.`, details: { code: years.join(",") } });
    analysis.fiscalYearCode = expected && YEAR_CODE.test(expected) ? expected : years.find((year) => YEAR_CODE.test(year)) ?? null;
    analysis.accountMap = resolveEffectiveAccountMap(rows.map((row) => ({ account: row.cuenta, name: row.concepto, porIva: row.tipo_iva })), explicit, chartLoaded.lookup);
    const config = input.mapping?.analytics ? { centreDimension: input.mapping.analytics.centreDimension, costCentreDimension: input.mapping.analytics.costCentreDimension ?? null } : persistedAnalytics.config;
    const centreCodes = [...new Set(rows.map((row) => dimensionValueOf(row, config.centreDimension)).filter((code): code is string => !!code))];
    const costCodes = config.costCentreDimension ? [...new Set(rows.map((row) => dimensionValueOf(row, config.costCentreDimension!)).filter((code): code is string => !!code))] : [];
    analysis.analytics = resolveEffectiveAnalytics({ sent: input.mapping?.analytics, persisted: persistedAnalytics, properties, centreCodes, costCentreCodes: costCodes, optionsPolicy: options.unassignedPolicy });
    const { index: nativeIndex, stats } = await buildNativeIndex(db, organizationId);
    if (stats.invoices > 0) warnings.push(`Modo sombra: ${stats.invoices} factura(s) propia(s) de ${BRAND.name} se cotejan por serie y número; sus asientos de Sage se omiten.`);
    const numberingDimension = options.numberingDimension ?? null;
    if (numberingDimension !== null && !(LEDGER_NUMBERING_DIMENSIONS as readonly string[]).includes(numberingDimension)) extraBlockers.push({ status: 400, code: "VALIDATION_ERROR", message: `options.numberingDimension debe ser ${LEDGER_NUMBERING_DIMENSIONS.join(" o ")}.`, details: { field: "options.numberingDimension" } });
    if (numberingDimension) warnings.push(`Numeración por ${numberingDimension === "canal" ? "canal" : "delegación"}: el código forma parte de la clave de cada asiento (empresa:ejercicio:periodo:asiento:${numberingDimension === "canal" ? "canal" : "delegación"}).`);
    const validYears = years.filter((year) => YEAR_CODE.test(year));
    const merged: JournalPostingResult = { entries: [], skippedNative: [], unmapped: [], unmappedAnalytics: [], unmappedCostCentres: [], centreRequired: [], unbalanced: [], closingDetected: [], errors: [], warnings: [], statuses: new Map() };
    for (const year of validYears) {
      const yearInfo = await fiscalYearWindow(db, organizationId, year);
      analysis.fiscalYears.set(year, yearInfo);
      const grouped = groupJournalRows(rows.filter((row) => row.ejercicio === year), { numberingDimension: numberingDimension && (LEDGER_NUMBERING_DIMENSIONS as readonly string[]).includes(numberingDimension) ? numberingDimension : null });
      for (const entry of grouped) analysis.sageEntries.set(sageEntryKeyString(entry.key), entry);
      const result = buildJournalEntries(grouped, { accountMap: analysis.accountMap, analytics: { centreDimension: analysis.analytics.centreDimension, costCentreDimension: analysis.analytics.costCentreDimension ?? null, unassignedPolicy: analysis.analytics.unassignedPolicy, map: analysis.analytics.entries }, properties: postingProperties, officePropertyId, fiscalYear: yearInfo.window, nativeIndex, isPostableCode: (code) => chartLoaded.lookup.get(code)?.isPostable === true });
      merged.entries.push(...result.entries);
      merged.skippedNative.push(...result.skippedNative);
      for (const row of result.unmapped) {
        const existing = merged.unmapped.find((item) => item.sourceAccount === row.sourceAccount);
        if (existing) existing.lineCount += row.lineCount;
        else merged.unmapped.push(row);
      }
      merged.unmappedAnalytics.push(...result.unmappedAnalytics.filter((row) => !merged.unmappedAnalytics.some((item) => item.sourceCode === row.sourceCode)));
      merged.unmappedCostCentres.push(...result.unmappedCostCentres.filter((row) => !merged.unmappedCostCentres.some((item) => item.sourceCode === row.sourceCode)));
      merged.centreRequired.push(...result.centreRequired);
      merged.unbalanced.push(...result.unbalanced);
      merged.closingDetected.push(...result.closingDetected);
      merged.errors.push(...result.errors);
      merged.warnings.push(...result.warnings);
      for (const [key, status] of result.statuses) merged.statuses.set(key, status);
    }
    if (kind === "fiscal_years") {
      const nonOpening = merged.entries.filter((entry) => entry.entryKind !== "opening");
      if (nonOpening.length > 0) warnings.push(`${nonOpening.length} asiento(s) del fichero no son de apertura: el lote «ejercicios» solo contabiliza aperturas; se omiten.`);
      merged.entries = merged.entries.filter((entry) => entry.entryKind === "opening");
    }
    if (merged.unmappedCostCentres.length > 0) warnings.push(`${merged.unmappedCostCentres.length} código(s) de departamento sin centro de coste USALI (${merged.unmappedCostCentres.slice(0, 5).map((row) => row.sourceCode).join(", ")}): sus líneas 6/7 van sin centro de coste.`);
    warnings.push(...merged.warnings);
    analysis.journal = merged;
    analysis.planned = merged.entries;
  } else if (kind === "balances") {
    const rows = rowsAs<"balances">(input.rows);
    const years = [...new Set(rows.map((row) => row.ejercicio))].sort();
    const expected = options.fiscalYearCode?.trim();
    const year = expected || years[0] || "";
    if (!YEAR_CODE.test(year)) extraBlockers.push(yearCodeBlocker(year));
    else if (years.length > 1 && !expected) warnings.push(`El fichero trae ${years.length} ejercicios (${years.join(", ")}): se importa ${year} (indica options.fiscalYearCode para otro).`);
    analysis.fiscalYearCode = YEAR_CODE.test(year) ? year : null;
    analysis.accountMap = resolveEffectiveAccountMap(rows.map((row) => ({ account: row.cuenta, name: row.titulo })), explicit, chartLoaded.lookup);
    const centreCodes = [...new Set(rows.map((row) => row.delegacion).filter((code): code is string => !!code))];
    analysis.analytics = resolveEffectiveAnalytics({ sent: input.mapping?.analytics, persisted: persistedAnalytics, properties, centreCodes, costCentreCodes: [], optionsPolicy: options.unassignedPolicy });
    if (analysis.fiscalYearCode) {
      const yearInfo = await fiscalYearWindow(db, organizationId, analysis.fiscalYearCode);
      analysis.fiscalYears.set(analysis.fiscalYearCode, yearInfo);
      const centreMap = new Map<string, string | null>();
      for (const entry of analysis.analytics.entries) if (entry.dimension === analysis.analytics.centreDimension) centreMap.set(entry.sourceCode, entry.propertyId);
      const result = buildBalanceEntries(rows, { accountMap: analysis.accountMap, fiscalYear: yearInfo.window, properties: postingProperties, unassignedPolicy: analysis.analytics.unassignedPolicy, officePropertyId, centreMap, companyCode: input.company ?? undefined, isPostableCode: (code) => chartLoaded.lookup.get(code)?.isPostable === true });
      warnings.push(...result.warnings);
      analysis.balances = result;
      analysis.planned = result.entries;
    }
  } else if (kind === "plan") {
    const rows = rowsAs<"plan">(input.rows);
    const { actions, blockers } = planActionsOf(rows, explicit, chartLoaded.lookup);
    analysis.planActions = actions;
    extraBlockers.push(...blockers);
    analysis.accountMap = new Map(actions.map((action) => [action.row.cuenta, action.mapping]));
  } else if (kind === "vat_books") {
    const rows = rowsAs<"vat_books">(input.rows);
    // Modo sombra (§5.1): las facturas emitidas por Anfitorio y las recibidas ya contabilizadas en Anfitorio tienen
    // su fila de libro materializada por el propio documento; la fila de Sage se omite (el 303 / 347 / 390 no las suma dos veces).
    const { index: nativeIndex } = await buildNativeIndex(db, organizationId);
    const built = buildVatBookRows(rows, { periodicity, organizationId, companyCode: input.company ?? undefined, nativeIndex });
    warnings.push(...built.warnings);
    analysis.vatRows = built.rows;
    analysis.vatSkippedNative = built.skippedNative;
    const months = [...new Set(rows.map((row) => row.fecha.slice(0, 7)))].sort();
    analysis.periodFrom = months[0] ?? null;
    analysis.periodTo = months[months.length - 1] ?? null;
    analysis.fiscalYearCode = rows[0]?.ejercicio ?? null;
    if (vatSettingsMissing) warnings.push("La organización no tiene configuración de IVA (vat_settings): el periodo de liquidación de las filas se muestra con la periodicidad trimestral por defecto y el lote no se contabiliza hasta que exista.");
  } else {
    analysis.thirdParties = rowsAs<"third_parties">(input.rows);
  }

  if (analysis.planned.length > 0) {
    const range = periodRangeOf(analysis.planned, analysis.balances?.balances ?? []);
    analysis.periodFrom = range.periodFrom;
    analysis.periodTo = range.periodTo;
    analysis.totals = {
      debit: analysis.planned.reduce((sum, entry) => sum.plus(entry.totalDebit), ZERO),
      credit: analysis.planned.reduce((sum, entry) => sum.plus(entry.totalCredit), ZERO),
      lines: analysis.planned.reduce((sum, entry) => sum + entry.lines.length, 0)
    };
  } else if (kind === "balances" && analysis.balances) {
    const range = periodRangeOf([], analysis.balances.balances);
    analysis.periodFrom = range.periodFrom;
    analysis.periodTo = range.periodTo;
  }

  // Tenencia y ámbito R11: los centros del lote deben ser de la organización y estar en el ámbito del usuario.
  const propertyIds = [...new Set(analysis.planned.map((entry) => entry.propertyId).filter((id): id is string => !!id))];
  assertPropertiesOwned(propertyIds, properties);
  assertFinanceReadScopeMany(input.scopeContext, propertyIds);

  // Duplicado, solapes, nómina importada, nativos previos y existentes.
  analysis.duplicate = input.rows.length > 0 ? await findDuplicateImport(db, organizationId, analysis.contentHash, input.excludeImportId) : null;
  if (analysis.duplicate && MASTER_KINDS.includes(kind)) warnings.push(`Este fichero ya se importó (lote ${analysis.duplicate.id}): los maestros son idempotentes, las filas ya existentes se omiten.`);
  analysis.overlaps = await findOverlapsOf(db, organizationId, analysis, input.excludeImportId);
  if (kind === "balances" || kind === "journal") extraBlockers.push(...(await findYearKindConflicts(db, organizationId, kind, analysis.fiscalYearCode, analysis.planned.some((entry) => entry.entryKind === "opening"), input.excludeImportId)));
  if (POSTING_KINDS.includes(kind)) {
    analysis.payrollCostImportsPosted = await findPayrollCostImportsPosted(db, organizationId, analysis.periodFrom, analysis.periodTo);
    if (analysis.payrollCostImportsPosted.length > 0) warnings.push(`${analysis.payrollCostImportsPosted.length} lote(s) de coste de personal ya contabilizado(s) en el rango: si el diario de Sage trae la nómina real, revierte ese lote antes o bloquea 640/642/465/476 en el mapa.`);
    analysis.existingNativeEntries = await countNativeEntries(db, organizationId, analysis.fiscalYearCode);
    if (analysis.existingNativeEntries > 0) warnings.push(`El ejercicio ${analysis.fiscalYearCode} ya tiene ${analysis.existingNativeEntries} asiento(s) propios: la numeración de ${BRAND.name} quedará intercalada (el nº de Sage se conserva en la referencia).`);
    analysis.existing = await findExistingEntries(db, organizationId, analysis.planned);
    if (analysis.existing.length > 0) warnings.push(`${analysis.existing.length} asiento(s) ya importados (misma clave de Sage viva en el diario): se omiten como «ya importado».`);
  }
  analysis.blockers = computeBlockers({ kind, replace, duplicate: analysis.duplicate, overlaps: analysis.overlaps, journal: analysis.journal, balances: analysis.balances, plannedCount: analysis.planned.length, vatSettingsMissing, extra: extraBlockers });
  return analysis;
}

/** Parsea el cuerpo (L1) y analiza; errores de fichero → 400 tipados. */
async function analyseBody(input: { organizationId: string; scopeContext: UserContext; body: LedgerImportPreviewBody; db: Db; legalEntityId?: string | null; excludeImportId?: string }): Promise<Analysis> {
  const { body } = input;
  if (!(LEDGER_IMPORT_KINDS as readonly string[]).includes(body.kind)) throw ledgerBadRequest("VALIDATION_ERROR", `Tipo de lote desconocido: ${String(body.kind)}.`, { field: "kind" });
  const decoded = decodeImportContent(body);
  const options = body.options ?? {};
  if (options.unassignedPolicy !== undefined && !isLedgerUnassignedPolicy(options.unassignedPolicy)) throw ledgerBadRequest("VALIDATION_ERROR", "options.unassignedPolicy debe ser block, office o property:<id>.", { field: "options.unassignedPolicy" });
  let parsed;
  try {
    parsed = parseLedgerImportFile({ kind: body.kind, format: body.format, fileName: body.fileName?.trim() || undefined, bytes: decoded.bytes, content: decoded.content, sheetName: body.sheetName, fiscalYearCode: options.fiscalYearCode, periodCode: options.fiscalYearCode });
  } catch (error) {
    toHttpError(error);
  }
  if (parsed.rows.length === 0) throw ledgerBadRequest("LEDGER_IMPORT_EMPTY", "El fichero no contiene filas de datos.");
  const rows = normalizeRows(body.kind, parsed.rows as CanonicalRowOf<typeof body.kind>[]) as CanonicalRow[];
  const parseWarnings = [...parsed.warnings];
  if (parsed.unknownHeaders.length > 0) parseWarnings.push(`Columnas no reconocidas (se ignoran): ${parsed.unknownHeaders.slice(0, 10).join(", ")}${parsed.unknownHeaders.length > 10 ? "…" : ""}.`);
  return analyseRows({ organizationId: input.organizationId, scopeContext: input.scopeContext, kind: body.kind, format: parsed.format, fileName: body.fileName?.trim() || null, rows, rowCount: parsed.rowCount, parseWarnings, company: parsed.company, mapping: body.mapping, options, legalEntityId: input.legalEntityId, db: input.db, excludeImportId: input.excludeImportId });
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

function moneyString(value: Decimal | Prisma.Decimal | string): MoneyString {
  return money(value).toFixed(2);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mappingOf(row: ImportRow): LedgerImportMappingInput {
  const raw = (row.mappingJson ?? {}) as Record<string, unknown>;
  const accounts = Array.isArray(raw.accounts) ? (raw.accounts as LedgerAccountMapDto[]) : [];
  const analytics = raw.analytics && typeof raw.analytics === "object" ? (raw.analytics as LedgerAnalyticsMappingInput) : undefined;
  return analytics ? { accounts, analytics } : { accounts };
}

function draftRowsOf(row: ImportRow): CanonicalRow[] | null {
  const raw = (row.mappingJson ?? {}) as Record<string, unknown>;
  return Array.isArray(raw[DRAFT_ROWS_KEY]) ? (raw[DRAFT_ROWS_KEY] as CanonicalRow[]) : null;
}

function optionsOf(row: ImportRow): LedgerImportOptions {
  const raw = (row.mappingJson ?? {}) as Record<string, unknown>;
  return raw.options && typeof raw.options === "object" ? (raw.options as LedgerImportOptions) : {};
}

export function toImportRecord(row: ImportRow): LedgerImportRecord {
  return {
    id: row.id,
    kind: row.kind as LedgerImportKind,
    format: row.format as LedgerImportFormat,
    system: row.system as LedgerImportRecord["system"],
    fileName: row.fileName,
    contentHash: row.contentHash,
    sourceCompanyCode: row.sourceCompanyCode,
    fiscalYearCode: row.fiscalYearCode,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    status: row.status as LedgerImportStatusCode,
    rowCount: row.rowCount,
    entryCount: row.entryCount,
    skippedCount: row.skippedCount,
    warningCount: row.warningCount,
    totalDebit: moneyString(row.totalDebit),
    totalCredit: moneyString(row.totalCredit),
    journalEntryIds: row.journalEntryIds,
    reversalJournalEntryIds: row.reversalJournalEntryIds,
    replacedById: row.replacedById,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    reversedAt: row.reversedAt ? row.reversedAt.toISOString() : null,
    reversedBy: row.reversedBy,
    reversalReason: row.reversalReason
  };
}

type JournalRef = { entryNumber: number | null; fiscalYearCode: string | null };

function entryDto(row: EntryRow, journal: ReadonlyMap<string, JournalRef>): LedgerImportEntryDto {
  const ref = row.journalEntryId ? journal.get(row.journalEntryId) : undefined;
  return {
    id: row.id,
    sourceCompanyCode: row.sourceCompanyCode,
    sourceFiscalYear: row.sourceFiscalYear,
    sourcePeriod: row.sourcePeriod,
    sourceEntryNumber: row.sourceEntryNumber,
    sourceChannel: row.sourceChannel,
    entryDate: isoDay(row.entryDate),
    propertyId: row.propertyId,
    propertyCode: row.propertyCode,
    journalEntryId: row.journalEntryId,
    entryNumber: ref?.entryNumber ?? null,
    fiscalYearCode: ref?.fiscalYearCode ?? null,
    status: row.status as LedgerImportEntryStatus,
    entryKind: row.entryKind as LedgerImportEntryKind,
    lineCount: row.lineCount,
    debit: moneyString(row.debit),
    credit: moneyString(row.credit),
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    warnings: stringArray(row.warningsJson)
  };
}

function balanceDto(row: BalanceRow): LedgerImportBalanceDto {
  return {
    id: row.id,
    fiscalYearCode: row.fiscalYearCode,
    periodCode: row.periodCode,
    propertyId: row.propertyId,
    propertyCode: row.propertyCode,
    sourceAccount: row.sourceAccount,
    sourceName: row.sourceName,
    accountCode: row.accountCode,
    openingDebit: moneyString(row.openingDebit),
    openingCredit: moneyString(row.openingCredit),
    periodDebit: moneyString(row.periodDebit),
    periodCredit: moneyString(row.periodCredit),
    closingBalance: moneyString(row.closingBalance)
  };
}

async function journalRefs(db: Db, ids: readonly string[]): Promise<Map<string, JournalRef>> {
  if (ids.length === 0) return new Map();
  const rows = await db.journalEntry.findMany({ where: { id: { in: [...ids] } }, select: { id: true, entryNumber: true, fiscalYearCode: true } });
  return new Map(rows.map((row) => [row.id, { entryNumber: row.entryNumber, fiscalYearCode: row.fiscalYearCode }]));
}

async function entryDtosOf(db: Db, importId: string, take = ENTRY_PAGE_SIZE, skip = 0): Promise<{ entries: LedgerImportEntryDto[]; total: number }> {
  const [rows, total] = await Promise.all([
    db.ledgerImportEntry.findMany({ where: { importId }, orderBy: [{ entryDate: "asc" }, { sourceEntryNumber: "asc" }, { propertyCode: "asc" }], take, skip }),
    db.ledgerImportEntry.count({ where: { importId } })
  ]);
  const refs = await journalRefs(db, rows.map((row) => row.journalEntryId).filter((id): id is string => !!id));
  return { entries: rows.map((row) => entryDto(row, refs)), total };
}

function byMonthOf(entries: readonly PlannedEntry[]): LedgerImportPreviewMonthRow[] {
  const out = new Map<string, { entries: number; lines: number; debit: Decimal; credit: Decimal }>();
  for (const entry of entries) {
    const periodCode = entry.entryDate.slice(0, 7);
    const row = out.get(periodCode) ?? { entries: 0, lines: 0, debit: ZERO, credit: ZERO };
    row.entries += 1;
    row.lines += entry.lines.length;
    row.debit = row.debit.plus(entry.totalDebit);
    row.credit = row.credit.plus(entry.totalCredit);
    out.set(periodCode, row);
  }
  return [...out].sort((a, b) => a[0].localeCompare(b[0])).map(([periodCode, row]) => ({ periodCode, entries: row.entries, lines: row.lines, debit: row.debit.toFixed(2), credit: row.credit.toFixed(2) }));
}

function byPropertyOf(entries: readonly PlannedEntry[]): LedgerImportPreviewPropertyRow[] {
  const out = new Map<string, { propertyId: string | null; entries: number; debit: Decimal; credit: Decimal }>();
  for (const entry of entries) {
    const row = out.get(entry.propertyCode) ?? { propertyId: entry.propertyId, entries: 0, debit: ZERO, credit: ZERO };
    row.entries += 1;
    row.debit = row.debit.plus(entry.totalDebit);
    row.credit = row.credit.plus(entry.totalCredit);
    out.set(entry.propertyCode, row);
  }
  return [...out].sort((a, b) => a[0].localeCompare(b[0])).map(([propertyCode, row]) => ({ propertyId: row.propertyId, propertyCode, entries: row.entries, debit: row.debit.toFixed(2), credit: row.credit.toFixed(2) }));
}

function unmappedOfAnalysis(analysis: Analysis): LedgerImportUnmappedAccount[] {
  if (analysis.kind === "plan") return analysis.planActions.filter((action) => action.outcome === "blocked").map((action) => ({ sourceAccount: action.row.cuenta, sourceName: action.row.titulo, lineCount: 1, suggestion: action.mapping.action !== "block" ? action.mapping : null }));
  return [...(analysis.journal?.unmapped ?? []), ...(analysis.balances?.unmapped ?? [])];
}

function previewOf(analysis: Analysis): LedgerImportPreview {
  const skipped = analysis.kind === "vat_books" ? analysis.vatSkippedNative : analysis.journal?.skippedNative ?? [];
  const lineCount = analysis.kind === "vat_books" ? analysis.vatRows.length : analysis.kind === "plan" ? analysis.planActions.length : analysis.kind === "third_parties" ? analysis.thirdParties.length : analysis.totals.lines;
  const entryCount = analysis.kind === "vat_books" ? analysis.vatRows.length : analysis.kind === "plan" ? analysis.planActions.filter((action) => action.outcome === "create").length : analysis.kind === "third_parties" ? analysis.thirdParties.length : analysis.planned.length;
  return {
    kind: analysis.kind,
    format: analysis.format,
    system: SYSTEM,
    fileName: analysis.fileName,
    contentHash: analysis.contentHash,
    sourceCompanyCode: analysis.sourceCompanyCode,
    fiscalYearCode: analysis.fiscalYearCode,
    periodFrom: analysis.periodFrom,
    periodTo: analysis.periodTo,
    rowCount: analysis.rowCount,
    entryCount,
    lineCount,
    totalDebit: analysis.totals.debit.toFixed(2),
    totalCredit: analysis.totals.credit.toFixed(2),
    byMonth: byMonthOf(analysis.planned),
    byProperty: byPropertyOf(analysis.planned),
    unmappedAccounts: unmappedOfAnalysis(analysis),
    unmappedAnalytics: analysis.journal?.unmappedAnalytics ?? [],
    centreRequired: [...(analysis.journal?.centreRequired ?? []), ...(analysis.balances?.centreRequired ?? []).map((row) => ({ sourceEntryNumber: row.periodCode, sourcePeriod: row.periodCode, accounts: row.accounts }))],
    unbalanced: [...(analysis.journal?.unbalanced ?? []), ...(analysis.balances?.unbalanced ?? []).map((row) => ({ sourceEntryNumber: row.periodCode, sourcePeriod: row.periodCode, debit: row.debit, credit: row.credit }))],
    nativeSkipped: skipped,
    existing: analysis.existing,
    closingDetected: analysis.journal?.closingDetected ?? analysis.planned.filter((entry) => entry.entryKind !== "normal").map((entry) => ({ sourceEntryNumber: entryKeyOf(entry).sourceEntryNumber, sourcePeriod: entryKeyOf(entry).sourcePeriod, entryKind: entry.entryKind })),
    duplicateOf: analysis.duplicate ? { importId: analysis.duplicate.id, fileName: analysis.duplicate.fileName, createdAt: analysis.duplicate.createdAt.toISOString(), status: analysis.duplicate.status as LedgerImportStatusCode } : null,
    overlaps: analysis.overlaps,
    payrollCostImportsPosted: analysis.payrollCostImportsPosted,
    existingNativeEntries: analysis.existingNativeEntries,
    vatSettingsMissing: analysis.vatSettingsMissing,
    warnings: analysis.warnings,
    canPost: analysis.blockers.length === 0,
    blockers: analysis.blockers.map((blocker) => blocker.message)
  };
}

function mappingJsonOf(analysis: Analysis, draft: boolean): Prisma.InputJsonValue {
  const accounts = [...analysis.accountMap.values()];
  const json: Record<string, unknown> = { accounts, analytics: analysis.analytics, options: analysis.options };
  if (draft) json[DRAFT_ROWS_KEY] = analysis.rows;
  return json as Prisma.InputJsonValue;
}

// ---------------------------------------------------------------------------
// Contabilización dentro de la transacción
// ---------------------------------------------------------------------------

type EntryCreate = Prisma.LedgerImportEntryCreateManyInput;

type PostOutcome = {
  row: ImportRow;
  created: number;
  skipped: number;
  journalEntryIds: string[];
  warnings: string[];
  createdAccounts: Array<{ id: string; code: string; name: string; kind: string; parentCode: string | null; usaliDepartment: string | null; usaliLine: string | null }>;
  createdYears: Array<{ id: string; code: string }>;
  createdPeriods: Array<{ id: string; periodCode: string }>;
  closedYears: Array<{ fiscalYearId: string; code: string }>;
};

function emptyOutcome(row: ImportRow): PostOutcome {
  return { row, created: 0, skipped: 0, journalEntryIds: [], warnings: [], createdAccounts: [], createdYears: [], createdPeriods: [], closedYears: [] };
}

function baseEntry(importId: string, organizationId: string, entry: PlannedEntry): Omit<EntryCreate, "status" | "journalEntryId" | "sourceType" | "sourceId" | "warningsJson"> {
  const key = entryKeyOf(entry);
  return {
    importId,
    organizationId,
    sourceCompanyCode: key.sourceCompanyCode,
    sourceFiscalYear: key.sourceFiscalYear,
    sourcePeriod: key.sourcePeriod,
    sourceEntryNumber: key.sourceEntryNumber,
    sourceChannel: entry.source?.channel ?? null,
    entryDate: dateOnlyUtc(entry.entryDate),
    propertyId: entry.propertyId,
    propertyCode: entry.propertyCode,
    entryKind: entry.entryKind,
    lineCount: entry.lines.length,
    debit: entry.totalDebit,
    credit: entry.totalCredit
  };
}

function skippedNativeEntries(importId: string, organizationId: string, analysis: Analysis): EntryCreate[] {
  const out: EntryCreate[] = [];
  for (const skipped of analysis.journal?.skippedNative ?? []) {
    const sage = [...analysis.sageEntries.values()].find((entry) => entry.key.entryNumber === skipped.sourceEntryNumber && entry.key.period === skipped.sourcePeriod && (entry.key.channel ?? null) === (skipped.sourceChannel ?? null));
    if (!sage) continue;
    out.push({
      importId,
      organizationId,
      sourceCompanyCode: sage.key.companyCode,
      sourceFiscalYear: sage.key.fiscalYear,
      sourcePeriod: sage.key.period,
      sourceEntryNumber: sage.key.entryNumber,
      sourceChannel: sage.key.channel,
      entryDate: dateOnlyUtc(sage.entryDate),
      propertyId: null,
      propertyCode: LEDGER_IMPORT_SOCIETY_PROPERTY_CODE,
      journalEntryId: null,
      status: "skipped_native",
      entryKind: "normal",
      lineCount: sage.lines.length,
      debit: sage.lines.reduce((sum, line) => sum.plus(line.debe), ZERO).toFixed(2),
      credit: sage.lines.reduce((sum, line) => sum.plus(line.haber), ZERO).toFixed(2),
      sourceType: skipped.sourceType,
      sourceId: skipped.sourceId,
      warningsJson: [`Documento propio de ${BRAND.name}${skipped.invoiceNumber ? ` (${skipped.invoiceNumber})` : ""}: asiento ${skipped.sourceType}/${skipped.sourceId}.`]
    });
  }
  return out;
}

/** Filas del libro de Sage omitidas por ser documentos propios de Anfitorio (§5.1): quedan en el lote como `skipped_native`. */
function skippedVatEntries(importId: string, organizationId: string, analysis: Analysis): EntryCreate[] {
  return analysis.vatSkippedNative.map((skipped) => ({
    importId,
    organizationId,
    sourceCompanyCode: analysis.sourceCompanyCode ?? "",
    sourceFiscalYear: analysis.fiscalYearCode ?? skipped.sourcePeriod.slice(0, 4),
    sourcePeriod: skipped.sourcePeriod,
    sourceEntryNumber: `${skipped.sourceChannel ?? ""}:${skipped.series ?? ""}:${skipped.sourceEntryNumber}`,
    sourceChannel: skipped.sourceChannel ?? null,
    entryDate: dateOnlyUtc(isoDay(new Date())),
    propertyId: null,
    propertyCode: LEDGER_IMPORT_SOCIETY_PROPERTY_CODE,
    journalEntryId: null,
    status: "skipped_native",
    entryKind: "normal",
    lineCount: 1,
    debit: "0.00",
    credit: "0.00",
    sourceType: skipped.sourceType,
    sourceId: skipped.sourceId,
    warningsJson: [`Documento propio de ${BRAND.name}${skipped.invoiceNumber ? ` (${skipped.invoiceNumber})` : ""}: la fila del libro de Sage se omite (${skipped.sourceType}/${skipped.sourceId}).`]
  }));
}

/** CostCenter usali por (centro, código USALI): se reutiliza el existente sin reescribirlo (patrón cost-import.service.ts). */
async function ensureUsaliCostCentres(tx: Prisma.TransactionClient, pairs: ReadonlyArray<{ propertyId: string; code: string }>, properties: readonly PropertyLite[]): Promise<{ ids: Map<string, string>; warnings: string[] }> {
  const ids = new Map<string, string>();
  const warnings: string[] = [];
  // L2-05: precarga de los centros existentes de todas las parejas (una consulta), createMany de los que faltan
  // (skipDuplicates bajo el lock de la organización) y relectura de sus ids: tres consultas en vez de dos por pareja.
  const wanted = new Map<string, { propertyId: string; code: string }>();
  for (const pair of pairs) {
    const key = `${pair.propertyId}|${pair.code}`;
    if (!wanted.has(key)) wanted.set(key, { propertyId: pair.propertyId, code: pair.code });
  }
  if (wanted.size === 0) return { ids, warnings };
  const propertyIds = Array.from(new Set(Array.from(wanted.values(), (w) => w.propertyId)));
  const codes = Array.from(new Set(Array.from(wanted.values(), (w) => w.code)));
  const select = { id: true, propertyId: true, code: true, type: true, active: true } as const;
  const existing = await tx.costCenter.findMany({ where: { propertyId: { in: propertyIds }, code: { in: codes } }, select, take: propertyIds.length * codes.length });
  const byKey = new Map(existing.map((centre) => [`${centre.propertyId}|${centre.code}`, centre]));
  const missing = Array.from(wanted.values()).filter((w) => !byKey.has(`${w.propertyId}|${w.code}`));
  if (missing.length > 0) {
    await tx.costCenter.createMany({
      data: missing.map((w) => ({ propertyId: w.propertyId, code: w.code, name: USALI_DEPARTMENTS[w.code.toLowerCase() as UsaliDepartment] ?? w.code, type: USALI_COST_CENTRE_TYPE, active: true })),
      skipDuplicates: true
    });
    const created = await tx.costCenter.findMany({ where: { OR: missing.map((w) => ({ propertyId: w.propertyId, code: w.code })) }, select, take: missing.length });
    for (const centre of created) byKey.set(`${centre.propertyId}|${centre.code}`, centre);
  }
  for (const [key, w] of wanted) {
    const centre = byKey.get(key);
    if (!centre) throw ledgerConflict("LEDGER_IMPORT_COST_CENTRE_MISSING", `No se pudo resolver el centro de coste ${w.code} del centro ${w.propertyId}.`, { propertyId: w.propertyId, code: w.code });
    if (centre.type !== USALI_COST_CENTRE_TYPE || !centre.active) {
      warnings.push(`centro de coste ${w.code} de ${propertyCodeOf(properties, w.propertyId)} ya existía (tipo «${centre.type}»${centre.active ? "" : ", inactivo"}) y se reutiliza sin modificarlo`);
    }
    ids.set(key, centre.id);
  }
  return { ids, warnings };
}

/** FiscalYear del año natural + 12 periodos mensuales `open` (replica createFiscalYear / openFiscalPeriod, que no aceptan tx). */
async function ensureFiscalYearInTx(tx: Prisma.TransactionClient, organizationId: string, code: string, outcome: PostOutcome): Promise<{ id: string; status: string }> {
  if (!YEAR_CODE.test(code)) throw ledgerBadRequest("LEDGER_IMPORT_YEAR_CODE_INVALID", "El código del ejercicio debe ser el año natural (por ejemplo 2026).", { code });
  assertEntityScopedFiscalInput(undefined, "ejercicio");
  const window = naturalYearWindow(code);
  const startDate = dateOnlyUtc(window.startDate);
  const endDate = dateOnlyUtc(window.endDate);
  let year = await tx.fiscalYear.findFirst({ where: { organizationId, propertyId: null, code }, select: { id: true, status: true, startDate: true, endDate: true } });
  if (year) {
    if (isoDay(year.startDate) !== window.startDate || isoDay(year.endDate) !== window.endDate) {
      throw ledgerConflict("FISCAL_YEAR_OVERLAP", `El ejercicio ${code} ya existe con otras fechas (${isoDay(year.startDate)} – ${isoDay(year.endDate)}).`, { yearCode: code, fiscalYearId: year.id });
    }
  } else {
    const overlapping = await tx.fiscalYear.findFirst({ where: { organizationId, propertyId: null, startDate: { lte: endDate }, endDate: { gte: startDate } }, select: { code: true } });
    if (overlapping) throw ledgerConflict("FISCAL_YEAR_OVERLAP", `El ejercicio ${code} se solapa con ${overlapping.code}.`, { yearCode: overlapping.code });
    const created = await tx.fiscalYear.create({ data: { organizationId, propertyId: null, code, startDate, endDate, status: "open" }, select: { id: true, status: true, startDate: true, endDate: true } });
    year = created;
    outcome.createdYears.push({ id: created.id, code });
  }
  for (let month = 1; month <= 12; month++) {
    const periodCode = `${code}-${String(month).padStart(2, "0")}`;
    const periodStart = dateOnlyUtc(`${periodCode}-01`);
    const periodEnd = new Date(Date.UTC(Number(code), month, 0));
    const existing = await tx.fiscalPeriod.findFirst({ where: { organizationId, propertyId: null, periodCode }, select: { id: true } });
    if (existing) continue;
    const overlapping = await tx.fiscalPeriod.findFirst({ where: { organizationId, propertyId: null, periodType: "month", startDate: { lte: periodEnd }, endDate: { gte: periodStart } }, select: { periodCode: true } });
    if (overlapping) {
      outcome.warnings.push(`El periodo ${periodCode} ya está cubierto por ${overlapping.periodCode}: se reutiliza.`);
      continue;
    }
    const created = await tx.fiscalPeriod.create({ data: { organizationId, propertyId: null, periodCode, periodType: "month", startDate: periodStart, endDate: periodEnd, status: "open" }, select: { id: true } });
    outcome.createdPeriods.push({ id: created.id, periodCode });
  }
  return { id: year.id, status: year.status };
}

/** Resultado del ejercicio que dejó la regularización importada (Σ haber − Σ debe de la 129 de TODAS las regularizaciones del lote). */
function netResultOf(entries: readonly PlannedEntry[]): Decimal {
  return entries.reduce((total, entry) => total.plus(entry.lines.filter((line) => line.accountCode === "129" || line.accountCode.startsWith("129.")).reduce((sum, line) => sum.plus(line.credit).minus(line.debit), ZERO)), ZERO);
}

type ImportedYearEndEntries = { regularizations: Array<{ id: string }>; closing: { id: string } | null; netResult: Decimal };

/** Asientos de cierre importados (sage200_*) vivos de un ejercicio que NO vienen de este lote (lote `journal` anterior a «ejercicios», o solo con regularización). */
async function importedYearEndOf(tx: Prisma.TransactionClient, organizationId: string, fiscalYearCode: string, exceptIds: ReadonlySet<string>): Promise<ImportedYearEndEntries> {
  const rows = await tx.journalEntry.findMany({
    where: { organizationId, fiscalYearCode, status: "posted", reversedById: null, sourceType: { in: [...IMPORTED_SOURCE_TYPES] }, entryKind: { in: [...CLOSING_ENTRY_KINDS] } },
    select: { id: true, entryKind: true },
    orderBy: { entryNumber: "asc" }
  });
  const out: ImportedYearEndEntries = { regularizations: [], closing: null, netResult: ZERO };
  const previous = rows.filter((row) => !exceptIds.has(row.id));
  const regularizationIds = previous.filter((row) => row.entryKind !== "closing").map((row) => row.id);
  const lines = regularizationIds.length > 0 ? await tx.journalLine.findMany({ where: { journalEntryId: { in: regularizationIds } }, select: { accountCode: true, debit: true, credit: true } }) : [];
  for (const row of previous) {
    if (row.entryKind === "closing") out.closing = { id: row.id };
    else out.regularizations.push({ id: row.id });
  }
  out.netResult = lines.filter((line) => line.accountCode === "129" || (line.accountCode ?? "").startsWith("129.")).reduce((sum, line) => sum.plus(money(line.credit)).minus(money(line.debit)), ZERO);
  return out;
}

/** Apertura importada del ejercicio siguiente (la que enlaza `FiscalYear.openingEntryId`), si ya está en el diario. */
async function importedOpeningOf(tx: Prisma.TransactionClient, organizationId: string, nextYearCode: string): Promise<string | null> {
  const row = await tx.journalEntry.findFirst({ where: { organizationId, fiscalYearCode: nextYearCode, status: "posted", reversedById: null, sourceType: { in: [...IMPORTED_SOURCE_TYPES] }, entryKind: "opening" }, select: { id: true }, orderBy: { entryNumber: "asc" } });
  return row?.id ?? null;
}

async function postPlannedEntriesInTx(tx: Prisma.TransactionClient, importRow: ImportRow, analysis: Analysis, input: { createdBy: string | null; correlationId?: string; allowClosed: boolean }, outcome: PostOutcome): Promise<EntryCreate[]> {
  const organizationId = importRow.organizationId;
  const pairs = analysis.planned.flatMap((entry) => (entry.propertyId ? entry.lines.filter((line) => line.costCenterCode && isPnlCode(line.accountCode)).map((line) => ({ propertyId: entry.propertyId!, code: line.costCenterCode! })) : []));
  const { ids: costCentres, warnings: costCentreWarnings } = await ensureUsaliCostCentres(tx, pairs, analysis.properties);
  outcome.warnings.push(...costCentreWarnings);
  const yearIds = new Map<string, { id: string; status: string }>();
  for (const [code, info] of analysis.fiscalYears) {
    if (analysis.kind === "journal") {
      if (info.row) yearIds.set(code, info.row);
    } else {
      yearIds.set(code, await ensureFiscalYearInTx(tx, organizationId, code, outcome));
    }
  }
  const entries: EntryCreate[] = [];
  const postedByKind = new Map<string, Map<LedgerImportEntryKind, Array<{ id: string; entry: PlannedEntry }>>>();
  // Una consulta por lote (bajo el advisory lock de la organización el índice es exacto), no una por asiento.
  const keyIndex = await loadSourceKeyIndex(tx, organizationId, [...new Set(analysis.planned.map((entry) => entry.sourceType))], [...new Set(analysis.planned.map((entry) => entry.fiscalYearCode))]);
  for (const entry of analysis.planned) {
    const resolved = resolveSourceKeyFromIndex(keyIndex, entry.sourceType, entry.sourceId);
    if (resolved.live) {
      outcome.skipped += 1;
      entries.push({ ...baseEntry(importRow.id, organizationId, entry), status: "skipped_existing", journalEntryId: resolved.live.id, sourceType: entry.sourceType, sourceId: resolved.key, warningsJson: [...entry.warnings, `Ya importado: asiento ${resolved.live.fiscalYearCode ?? ""}/${resolved.live.entryNumber ?? "?"}.`] });
      continue;
    }
    const record = await postJournalEntry({
      organizationId,
      propertyId: entry.propertyId,
      entryDate: entry.entryDate,
      sourceType: entry.sourceType,
      sourceId: resolved.key,
      description: entry.description,
      reference: entry.reference,
      entryKind: entry.entryKind,
      lines: entry.lines.map((line) => ({
        accountCode: line.accountCode,
        debit: line.debit,
        credit: line.credit,
        description: line.description ?? null,
        taxRateCode: line.taxRateCode ?? null,
        taxBase: line.taxBase ?? null,
        costCenterId: entry.propertyId && line.costCenterCode && isPnlCode(line.accountCode) ? costCentres.get(`${entry.propertyId}|${line.costCenterCode}`) ?? null : null
      })),
      createdBy: input.createdBy,
      fiscalYearId: yearIds.get(entry.fiscalYearCode)?.id ?? null,
      tx,
      ignoreClosedPeriod: input.allowClosed,
      autoProvisionChart: false,
      correlationId: input.correlationId
    });
    if (record.created !== true) throw ledgerConflict("LEDGER_IMPORT_ENTRY_EXISTS", `Ya existe un asiento importado con la clave ${resolved.key}.`, { sourceId: resolved.key, journalEntryId: record.id });
    outcome.created += 1;
    outcome.journalEntryIds.push(record.id);
    entries.push({ ...baseEntry(importRow.id, organizationId, entry), status: "posted", journalEntryId: record.id, sourceType: entry.sourceType, sourceId: resolved.key, warningsJson: entry.warnings });
    // Actualiza en el mismo diario la clave recién usada (dos asientos del lote con la misma base nunca colisionan).
    keyIndex.set(`${entry.sourceType}|${entry.sourceId}`, [...(keyIndex.get(`${entry.sourceType}|${entry.sourceId}`) ?? []), { id: record.id, sourceId: resolved.key, status: "posted", entryNumber: null, fiscalYearCode: entry.fiscalYearCode }]);
    const byKind = postedByKind.get(entry.fiscalYearCode) ?? new Map<LedgerImportEntryKind, Array<{ id: string; entry: PlannedEntry }>>();
    byKind.set(entry.entryKind, [...(byKind.get(entry.entryKind) ?? []), { id: record.id, entry }]);
    postedByKind.set(entry.fiscalYearCode, byKind);
    // Un ejercicio anterior cerrado por importación sin apertura enlazada gana la apertura que llega ahora.
    if (entry.entryKind === "opening" && analysis.kind !== "journal") {
      const previousCode = String(Number(entry.fiscalYearCode) - 1);
      await tx.fiscalYear.updateMany({ where: { organizationId, propertyId: null, code: previousCode, status: "closed", openingEntryId: null, closingEntryId: { not: null } }, data: { openingEntryId: record.id } });
    }
  }
  // Cierre importado: regularization + closing del ejercicio, contabilizados en este lote o en uno anterior (lote
  // `journal` anterior a «ejercicios»: `ensureFiscalYearInTx` crea el ejercicio open y aquí se marca cerrado).
  const yearsToClose = new Set<string>([...postedByKind.keys(), ...(analysis.kind === "fiscal_years" ? analysis.fiscalYears.keys() : [])]);
  for (const code of yearsToClose) {
    const byKind = postedByKind.get(code) ?? new Map<LedgerImportEntryKind, Array<{ id: string; entry: PlannedEntry }>>();
    const postedIds = new Set([...byKind.values()].flat().map((item) => item.id));
    const ownClosing = byKind.get("closing")?.at(-1) ?? null;
    const previous = analysis.kind === "journal" && !ownClosing ? null : await importedYearEndOf(tx, organizationId, code, postedIds);
    const closingId = ownClosing?.id ?? previous?.closing?.id ?? null;
    if (!closingId) continue;
    const year = yearIds.get(code);
    if (!year) {
      outcome.warnings.push(`El lote trae el cierre del ejercicio ${code} pero ${BRAND.name} no tiene ese ejercicio: importa antes «ejercicios» para marcarlo cerrado.`);
      continue;
    }
    if (year.status === "closed") continue;
    const ownRegularizations = byKind.get("regularization") ?? [];
    const netResult = netResultOf(ownRegularizations.map((item) => item.entry)).plus(previous?.netResult ?? ZERO);
    if (ownRegularizations.length === 0 && (previous?.regularizations.length ?? 0) === 0) outcome.warnings.push(`El cierre del ejercicio ${code} llega sin regularización: el resultado se toma como 0,00.`);
    const nextCode = String(Number(code) + 1);
    const nextOpening = postedByKind.get(nextCode)?.get("opening")?.[0]?.id ?? (await importedOpeningOf(tx, organizationId, nextCode));
    // Los asientos de cierre importados antes de que existiera el ejercicio quedan enlazados a él (guardas de reopenFiscalYear / closeFiscalYear).
    if (previous) await tx.journalEntry.updateMany({ where: { organizationId, fiscalYearCode: code, fiscalYearId: null, sourceType: { in: [...IMPORTED_SOURCE_TYPES] }, status: "posted" }, data: { fiscalYearId: year.id } });
    const closed = await markFiscalYearClosedFromImport(tx, { fiscalYearId: year.id, closingEntryId: closingId, openingEntryId: nextOpening, netResult: netResult.toFixed(2), importId: importRow.id });
    yearIds.set(code, { id: year.id, status: "closed" });
    outcome.closedYears.push({ fiscalYearId: closed.fiscalYearId, code: closed.code });
    outcome.warnings.push(`Ejercicio ${code} marcado cerrado con el cierre importado${ownClosing ? "" : " por un lote anterior"} (${closed.closedPeriods} periodo(s) cerrados por importación).`);
  }
  return entries;
}

async function upsertThirdParty(tx: Prisma.TransactionClient, organizationId: string, party: { sourceCode: string; role: "customer" | "supplier"; sourceAccount: string | null; taxId: string | null; countryCode: string | null; name: string; supplierId?: string | null }): Promise<void> {
  await tx.ledgerThirdParty.upsert({
    where: { organizationId_system_role_sourceCode: { organizationId, system: SYSTEM, role: party.role, sourceCode: party.sourceCode } },
    create: { organizationId, system: SYSTEM, role: party.role, sourceCode: party.sourceCode, sourceAccount: party.sourceAccount, taxId: party.taxId, countryCode: party.countryCode ?? "ES", name: party.name, supplierId: party.supplierId ?? null },
    update: { sourceAccount: party.sourceAccount, taxId: party.taxId, countryCode: party.countryCode ?? "ES", name: party.name, ...(party.supplierId ? { supplierId: party.supplierId } : {}) }
  });
}

async function upsertAccountMap(tx: Prisma.TransactionClient, organizationId: string, entry: LedgerAccountMapDto, updatedBy: string | null): Promise<void> {
  await tx.ledgerAccountMap.upsert({
    where: { organizationId_system_sourceAccount: { organizationId, system: SYSTEM, sourceAccount: entry.sourceAccount } },
    create: { organizationId, system: SYSTEM, sourceAccount: entry.sourceAccount, sourceName: entry.sourceName ?? null, action: entry.action, accountCode: entry.accountCode, usaliDepartment: entry.usaliDepartment ?? null, usaliLine: entry.usaliLine ?? null, carryCounterparty: entry.carryCounterparty ?? false, updatedBy },
    update: { sourceName: entry.sourceName ?? null, action: entry.action, accountCode: entry.accountCode, usaliDepartment: entry.usaliDepartment ?? null, usaliLine: entry.usaliLine ?? null, carryCounterparty: entry.carryCounterparty ?? false, updatedBy }
  });
}

async function postPlanInTx(tx: Prisma.TransactionClient, importRow: ImportRow, analysis: Analysis, createdBy: string | null, outcome: PostOutcome): Promise<EntryCreate[]> {
  const organizationId = importRow.organizationId;
  const store = prismaChartStore(tx);
  const current = await store.listAccounts(organizationId);
  const byCode = new Map(current.map((row) => [row.code, row]));
  const toCreate = analysis.planActions.filter((action) => action.outcome === "create" && action.newAccount && !byCode.has(action.newAccount.code));
  const rows: NewChartAccountRow[] = toCreate.map((action) => {
    const { parentCode: _parentCode, ...account } = action.newAccount!;
    return { organizationId, ...account };
  });
  await store.createAccounts(rows);
  const refreshed = await store.listAccounts(organizationId);
  const refreshedByCode = new Map(refreshed.map((row) => [row.code, row]));
  for (const action of toCreate) {
    const created = refreshedByCode.get(action.newAccount!.code);
    if (!created) continue;
    const parent = action.newAccount!.parentCode ? refreshedByCode.get(action.newAccount!.parentCode) : undefined;
    if (parent && created.parentId !== parent.id) await store.updateAccount(created.id, { parentId: parent.id });
    outcome.created += 1;
    outcome.createdAccounts.push({ id: created.id, code: created.code, name: created.name, kind: String(created.kind), parentCode: action.newAccount!.parentCode, usaliDepartment: created.usaliDepartment, usaliLine: created.usaliLine });
  }
  const entries: EntryCreate[] = [];
  for (const action of analysis.planActions) {
    await upsertAccountMap(tx, organizationId, action.mapping, createdBy);
    const role = thirdPartyRoleOf(action.row.cuenta);
    if (role && action.row.nif) {
      await upsertThirdParty(tx, organizationId, { sourceCode: action.row.cuenta, role, sourceAccount: action.row.cuenta, taxId: normalizeNif(action.row.nif), countryCode: action.row.pais, name: action.row.titulo ?? action.row.cuenta });
    }
    const status: LedgerImportEntryStatus = action.outcome === "create" && toCreate.includes(action) ? "posted" : action.outcome === "blocked" ? "unmapped" : "skipped_existing";
    if (status !== "posted") outcome.skipped += 1;
    entries.push({
      importId: importRow.id,
      organizationId,
      sourceCompanyCode: analysis.sourceCompanyCode ?? "plan",
      sourceFiscalYear: analysis.fiscalYearCode ?? "plan",
      sourcePeriod: "plan",
      sourceEntryNumber: action.row.cuenta,
      sourceChannel: null,
      entryDate: dateOnlyUtc(isoDay(new Date())),
      propertyId: null,
      propertyCode: LEDGER_IMPORT_SOCIETY_PROPERTY_CODE,
      journalEntryId: null,
      status,
      entryKind: "normal",
      lineCount: 0,
      debit: "0.00",
      credit: "0.00",
      sourceType: action.mapping.action,
      sourceId: action.mapping.accountCode,
      warningsJson: action.message ? [action.message] : []
    });
  }
  return entries;
}

async function postVatBooksInTx(tx: Prisma.TransactionClient, importRow: ImportRow, analysis: Analysis, outcome: PostOutcome): Promise<EntryCreate[]> {
  const organizationId = importRow.organizationId;
  if (await isVatSettingsMissing(tx, organizationId)) throw ledgerConflict("LEDGER_IMPORT_VAT_SETTINGS_MISSING", "Falta la configuración de IVA de la organización (periodicidad y régimen): configúrala antes de importar libros.");
  const keys = new Map<string, { book: VatBookRow["book"]; sourceId: string }>();
  for (const row of analysis.vatRows) keys.set(`${row.book}|${row.sourceId}`, { book: row.book, sourceId: row.sourceId });
  for (const key of keys.values()) {
    await tx.vatBookEntry.deleteMany({ where: { organizationId, book: key.book, sourceType: LEDGER_VAT_BOOK_SOURCE_TYPE, sourceId: key.sourceId } });
  }
  if (analysis.vatRows.length > 0) {
    const created = await tx.vatBookEntry.createMany({ data: analysis.vatRows.map(toVatBookCreateInput) });
    outcome.created = created.count;
  }
  const seenParties = new Set<string>();
  for (const row of analysis.vatRows) {
    if (!row.counterpartyNif || seenParties.has(`${row.book}|${row.counterpartyNif}`)) continue;
    seenParties.add(`${row.book}|${row.counterpartyNif}`);
    await upsertThirdParty(tx, organizationId, { sourceCode: row.counterpartyNif, role: row.book === "emitidas" ? "customer" : "supplier", sourceAccount: null, taxId: row.counterpartyNif, countryCode: null, name: row.counterpartyName ?? row.counterpartyNif });
  }
  const entries: EntryCreate[] = [];
  const seen = new Set<string>();
  for (const row of analysis.vatRows) {
    const entryNumber = `${row.sourceId}:${row.rate.toFixed(2)}`;
    if (seen.has(entryNumber)) continue;
    seen.add(entryNumber);
    entries.push({
      importId: importRow.id,
      organizationId,
      sourceCompanyCode: analysis.sourceCompanyCode ?? row.sourceId.split(":")[0] ?? "",
      sourceFiscalYear: row.date.slice(0, 4),
      sourcePeriod: row.period,
      sourceEntryNumber: entryNumber,
      sourceChannel: row.book,
      entryDate: dateOnlyUtc(row.date),
      propertyId: null,
      propertyCode: LEDGER_IMPORT_SOCIETY_PROPERTY_CODE,
      journalEntryId: null,
      status: "posted",
      entryKind: "normal",
      lineCount: 1,
      debit: row.book === "recibidas" ? row.total.toFixed(2) : "0.00",
      credit: row.book === "emitidas" ? row.total.toFixed(2) : "0.00",
      sourceType: LEDGER_VAT_BOOK_SOURCE_TYPE,
      sourceId: row.sourceId,
      warningsJson: []
    });
  }
  return entries;
}

async function postThirdPartiesInTx(tx: Prisma.TransactionClient, importRow: ImportRow, analysis: Analysis, outcome: PostOutcome): Promise<EntryCreate[]> {
  const organizationId = importRow.organizationId;
  const createSuppliers = analysis.options.createSuppliers === true;
  const entries: EntryCreate[] = [];
  // L2-05: proveedores precargados por NIF (una consulta), createMany de los NIF que faltan y relectura de sus ids —
  // tres consultas en vez de findFirst + create por tercero. La semántica fila a fila se conserva: el primer tercero
  // del fichero con un NIF nuevo lo da de alta (`created`), los siguientes con el mismo NIF y los ya existentes cuentan
  // como «existente» (`skipped_existing`) y actualizan el nombre si difiere.
  const supplierByTaxId = new Map<string, { id: string; name: string }>();
  const preexistingTaxIds = new Set<string>();
  if (createSuppliers) {
    const resolvedRows = analysis.thirdParties
      .filter((row) => row.rol === "supplier")
      .map((row) => ({ row, resolved: resolveSupplierTaxId(row.nif, (row.pais ?? "ES").toUpperCase()) }))
      .filter((entry): entry is { row: (typeof analysis.thirdParties)[number]; resolved: ReturnType<typeof resolveSupplierTaxId> & { taxId: string } } => !!entry.resolved.taxId);
    const taxIds = Array.from(new Set(resolvedRows.map((entry) => entry.resolved.taxId)));
    if (taxIds.length > 0) {
      const existingSuppliers = await tx.supplier.findMany({ where: { organizationId, taxId: { in: taxIds } }, select: { id: true, name: true, taxId: true }, take: taxIds.length });
      for (const supplier of existingSuppliers) {
        if (!supplier.taxId || supplierByTaxId.has(supplier.taxId)) continue;
        supplierByTaxId.set(supplier.taxId, { id: supplier.id, name: supplier.name });
        preexistingTaxIds.add(supplier.taxId);
      }
      const toCreate = new Map<string, Prisma.SupplierCreateManyInput>();
      for (const { row, resolved } of resolvedRows) {
        if (supplierByTaxId.has(resolved.taxId) || toCreate.has(resolved.taxId)) continue;
        toCreate.set(resolved.taxId, { organizationId, name: (row.nombre ?? "").trim() || row.codigo, taxId: resolved.taxId, nifValidatedAt: resolved.nifValidatedAt, contactJson: {}, paymentTermsJson: {}, countryCode: (row.pais ?? "ES").toUpperCase(), active: true });
      }
      if (toCreate.size > 0) {
        await tx.supplier.createMany({ data: Array.from(toCreate.values()) });
        const created = await tx.supplier.findMany({ where: { organizationId, taxId: { in: Array.from(toCreate.keys()) } }, select: { id: true, name: true, taxId: true }, take: toCreate.size });
        for (const supplier of created) if (supplier.taxId && !supplierByTaxId.has(supplier.taxId)) supplierByTaxId.set(supplier.taxId, { id: supplier.id, name: supplier.name });
      }
    }
  }
  const createdTaxIds = new Set<string>();
  for (const row of analysis.thirdParties) {
    const countryCode = (row.pais ?? "ES").toUpperCase();
    const name = (row.nombre ?? "").trim() || row.codigo;
    let supplierId: string | null = null;
    let status: LedgerImportEntryStatus = "posted";
    const warningsJson: string[] = [];
    if (createSuppliers && row.rol === "supplier") {
      const { taxId } = resolveSupplierTaxId(row.nif, countryCode);
      if (!taxId) {
        warningsJson.push("Proveedor sin NIF: no se da de alta como Supplier.");
      } else {
        const supplier = supplierByTaxId.get(taxId);
        if (!supplier) throw ledgerConflict("LEDGER_IMPORT_SUPPLIER_MISSING", `No se pudo resolver el proveedor con NIF ${taxId}.`, { taxId });
        supplierId = supplier.id;
        if (preexistingTaxIds.has(taxId) || createdTaxIds.has(taxId)) {
          if (supplier.name !== name) {
            await tx.supplier.update({ where: { id: supplier.id }, data: { name } });
            supplier.name = name;
          }
          status = "skipped_existing";
        } else {
          createdTaxIds.add(taxId);
          outcome.created += 1;
        }
      }
    }
    await upsertThirdParty(tx, organizationId, { sourceCode: row.codigo, role: row.rol, sourceAccount: row.cuenta, taxId: normalizeNif(row.nif), countryCode, name, supplierId });
    if (!createSuppliers || row.rol !== "supplier") outcome.created += 1;
    if (status !== "posted") outcome.skipped += 1;
    entries.push({
      importId: importRow.id,
      organizationId,
      sourceCompanyCode: analysis.sourceCompanyCode ?? "terceros",
      sourceFiscalYear: "terceros",
      sourcePeriod: row.rol,
      sourceEntryNumber: row.codigo,
      sourceChannel: null,
      entryDate: dateOnlyUtc(isoDay(new Date())),
      propertyId: null,
      propertyCode: LEDGER_IMPORT_SOCIETY_PROPERTY_CODE,
      journalEntryId: null,
      status,
      entryKind: "normal",
      lineCount: 0,
      debit: "0.00",
      credit: "0.00",
      sourceType: supplierId ? "supplier" : "ledger_third_party",
      sourceId: supplierId ?? row.codigo,
      warningsJson
    });
  }
  return entries;
}

/** Contabiliza un lote `draft` ya creado (todas las escrituras van por `tx`). */
async function postImportInTx(tx: Prisma.TransactionClient, importRow: ImportRow, analysis: Analysis, input: { createdBy: string | null; correlationId?: string; allowClosed: boolean }): Promise<PostOutcome> {
  const outcome = emptyOutcome(importRow);
  let entries: EntryCreate[];
  switch (analysis.kind) {
    case "plan":
      entries = await postPlanInTx(tx, importRow, analysis, input.createdBy, outcome);
      break;
    case "vat_books":
      entries = await postVatBooksInTx(tx, importRow, analysis, outcome);
      entries.push(...skippedVatEntries(importRow.id, importRow.organizationId, analysis));
      outcome.skipped += analysis.vatSkippedNative.length;
      break;
    case "third_parties":
      entries = await postThirdPartiesInTx(tx, importRow, analysis, outcome);
      break;
    default: {
      entries = await postPlannedEntriesInTx(tx, importRow, analysis, input, outcome);
      entries.push(...skippedNativeEntries(importRow.id, importRow.organizationId, analysis));
      outcome.skipped += analysis.journal?.skippedNative.length ?? 0;
      if (analysis.kind === "balances" && analysis.balances) {
        await tx.ledgerImportBalance.createMany({
          data: analysis.balances.balances.map((row) => ({
            importId: importRow.id,
            organizationId: importRow.organizationId,
            fiscalYearCode: row.fiscalYearCode,
            periodCode: row.periodCode,
            propertyId: row.propertyId,
            propertyCode: row.propertyCode,
            sourceAccount: row.sourceAccount,
            sourceName: row.sourceName,
            accountCode: row.accountCode,
            openingDebit: row.openingDebit,
            openingCredit: row.openingCredit,
            periodDebit: row.periodDebit,
            periodCredit: row.periodCredit,
            closingBalance: row.closingBalance
          })),
          skipDuplicates: true
        });
      }
      break;
    }
  }
  await tx.ledgerImportEntry.deleteMany({ where: { importId: importRow.id } });
  if (entries.length > 0) await tx.ledgerImportEntry.createMany({ data: entries });
  const warnings = [...analysis.warnings, ...outcome.warnings];
  const row = await tx.ledgerImport.update({
    where: { id: importRow.id },
    data: {
      status: "posted",
      postedAt: new Date(),
      journalEntryIds: outcome.journalEntryIds,
      entryCount: outcome.created,
      skippedCount: outcome.skipped,
      warningCount: warnings.length,
      totalDebit: analysis.totals.debit.toFixed(2),
      totalCredit: analysis.totals.credit.toFixed(2),
      mappingJson: mappingJsonOf(analysis, false),
      warningsJson: warnings as Prisma.InputJsonValue,
      contentHash: analysis.contentHash,
      fiscalYearCode: analysis.fiscalYearCode,
      periodFrom: analysis.periodFrom,
      periodTo: analysis.periodTo,
      reversedAt: null,
      reversedBy: null,
      reversalReason: null
    }
  });
  outcome.row = row;
  outcome.warnings = warnings;
  return outcome;
}

// ---------------------------------------------------------------------------
// Reverso dentro de la transacción
// ---------------------------------------------------------------------------

/**
 * El periodo y el ejercicio del asiento ORIGINAL deben estar abiertos para revertirlo
 * (patrón cost-import.service.ts `assertOriginalPeriodOpen`), leídos a través de la
 * transacción: así ve los ejercicios / periodos que este mismo reverso acaba de reabrir
 * (`isPostingAllowed` del motor lee el prisma raíz y no los vería).
 */
export async function assertOriginalPeriodOpen(tx: Prisma.TransactionClient, entry: { id: string; organizationId: string; propertyId: string | null; entryDate: Date }): Promise<void> {
  const day = isoDay(entry.entryDate);
  const fiscalYear = await resolveFiscalYear(tx, entry.organizationId, entry.propertyId, day);
  if (fiscalYear.status === "closed") {
    throw ledgerConflict("FISCAL_YEAR_CLOSED", `El ejercicio ${fiscalYear.code} del asiento original (${day}) está cerrado: reábrelo antes de revertir el lote.`, { yearCode: fiscalYear.code, fiscalYearId: fiscalYear.id, entryDate: day, journalEntryId: entry.id });
  }
  const closed = await tx.fiscalPeriod.findFirst({
    where: { organizationId: entry.organizationId, OR: [{ propertyId: entry.propertyId ?? null }, { propertyId: null }], startDate: { lte: dateOnlyUtc(day) }, endDate: { gte: dateOnlyUtc(day) }, status: "closed" },
    select: { periodCode: true }
  });
  if (closed) {
    throw ledgerConflict("FISCAL_PERIOD_CLOSED", `El periodo ${closed.periodCode} del asiento original (${day}) está cerrado: reábrelo antes de revertir el lote.`, { periodCode: closed.periodCode, entryDate: day, journalEntryId: entry.id });
  }
}

async function reverseImportInTx(tx: Prisma.TransactionClient, importRow: ImportRow, input: { reason: string; reversedBy: string | null; correlationId?: string; replacedById?: string | null }): Promise<{ row: ImportRow; reversalIds: string[]; reopenedYears: string[] }> {
  if (importRow.status === "reversed") return { row: importRow, reversalIds: [], reopenedYears: [] };
  if (importRow.status !== "posted") throw ledgerConflict("LEDGER_IMPORT_NOT_POSTED", "El lote no está contabilizado: no hay nada que revertir.", { importId: importRow.id, status: importRow.status });
  const organizationId = importRow.organizationId;
  const reversalIds: string[] = [...importRow.reversalJournalEntryIds];
  const reopenedYears: string[] = [];
  // 1 · Ejercicios cerrados por ESTE lote → open (reabrir = revertir el lote); periodos cerrados por él → open.
  if (importRow.journalEntryIds.length > 0) {
    const years = await tx.fiscalYear.findMany({ where: { organizationId, status: "closed", OR: [{ closingEntryId: { in: importRow.journalEntryIds } }, { openingEntryId: { in: importRow.journalEntryIds } }] }, select: { id: true, code: true } });
    for (const year of years) {
      await tx.fiscalYear.update({ where: { id: year.id }, data: { status: "open", closedAt: null, closingEntryId: null, openingEntryId: null, netResult: null } });
      reopenedYears.push(year.code);
    }
  }
  await tx.fiscalPeriod.updateMany({ where: { organizationId, status: "closed", closingNotes: importClosingNote(importRow.id) }, data: { status: "open", closedAt: null, closedBy: null, closingNotes: null } });
  // 2 · Reverso marcado de cada asiento del lote (nunca los asientos previos del diario).
  //     L2-05: los asientos del lote en una consulta (antes un findUnique por asiento), filtrada por organización.
  const entryRows = await tx.journalEntry.findMany({
    where: { id: { in: [...importRow.journalEntryIds] }, organizationId },
    select: { id: true, organizationId: true, propertyId: true, entryDate: true, status: true, reversedById: true, entryNumber: true, fiscalYearCode: true },
    take: Math.max(1, importRow.journalEntryIds.length)
  });
  const entryById = new Map(entryRows.map((entry) => [entry.id, entry]));
  for (const journalEntryId of importRow.journalEntryIds) {
    const entry = entryById.get(journalEntryId);
    if (!entry) continue;
    if (entry.reversedById) {
      if (!reversalIds.includes(entry.reversedById)) reversalIds.push(entry.reversedById);
      continue;
    }
    if (entry.status !== "posted") continue;
    await assertOriginalPeriodOpen(tx, entry);
    const record = await reverseJournalEntry({
      organizationId,
      journalEntryId,
      reason: input.reason,
      sourceType: "reversal",
      sourceId: `ledger-import-reverse:${importRow.id}:${journalEntryId}`,
      description: `Reverso del lote Sage 200 ${importRow.id} (asiento ${entry.fiscalYearCode ?? ""}/${entry.entryNumber ?? "?"}): ${input.reason}`,
      createdBy: input.reversedBy,
      tx,
      ignoreClosedPeriod: true,
      correlationId: input.correlationId
    });
    if (!reversalIds.includes(record.id)) reversalIds.push(record.id);
  }
  // 3 · Filas de libros de IVA del lote: solo las que ningún OTRO lote vat_books posted haya vuelto a escribir
  //     (la detección de solapes lo impide desde esta ronda; las filas heredadas de un lote posterior se conservan).
  if (importRow.kind === "vat_books") {
    const vatEntries = await tx.ledgerImportEntry.findMany({ where: { importId: importRow.id, sourceType: LEDGER_VAT_BOOK_SOURCE_TYPE }, select: { sourceId: true } });
    const sourceIds = [...new Set(vatEntries.map((row) => row.sourceId).filter((id): id is string => !!id))];
    if (sourceIds.length > 0) {
      const owned = await tx.ledgerImportEntry.findMany({ where: { organizationId, status: "posted", sourceType: LEDGER_VAT_BOOK_SOURCE_TYPE, sourceId: { in: sourceIds }, importId: { not: importRow.id }, import: { status: "posted", kind: "vat_books" } }, select: { sourceId: true } });
      const keep = new Set(owned.map((row) => row.sourceId));
      const deletable = sourceIds.filter((id) => !keep.has(id));
      if (deletable.length > 0) await tx.vatBookEntry.deleteMany({ where: { organizationId, sourceType: LEDGER_VAT_BOOK_SOURCE_TYPE, sourceId: { in: deletable } } });
    }
  }
  const row = await tx.ledgerImport.update({
    where: { id: importRow.id },
    data: { status: "reversed", reversalJournalEntryIds: reversalIds, reversedAt: new Date(), reversedBy: input.reversedBy, reversalReason: input.reason, ...(input.replacedById ? { replacedById: input.replacedById } : {}) }
  });
  return { row, reversalIds, reopenedYears };
}

/** Reversa ENTEROS los lotes solapados (`replace`), cada uno con todos sus centros dentro del ámbito del usuario (404 opaco si no). */
async function replaceImportsInTx(tx: Prisma.TransactionClient, organizationId: string, importIds: readonly string[], input: { newImportId: string; reversedBy: string | null; correlationId?: string; scopeContext: UserContext }): Promise<string[]> {
  const replaced: string[] = [];
  // L2-05: los lotes a sustituir en una consulta (antes un findUnique por lote), filtrados por organización.
  const rows = await tx.ledgerImport.findMany({ where: { id: { in: [...importIds] }, organizationId }, take: Math.max(1, importIds.length) });
  const rowById = new Map(rows.map((row) => [row.id, row]));
  for (const importId of importIds) {
    const row = rowById.get(importId);
    if (!row || row.status !== "posted") continue;
    assertFinanceReadScopeMany(input.scopeContext, await importPropertyIds(tx, importId));
    await reverseImportInTx(tx, row, { reason: `sustituido por ${input.newImportId}`, reversedBy: input.reversedBy, correlationId: input.correlationId, replacedById: input.newImportId });
    replaced.push(importId);
  }
  return replaced;
}

async function importPropertyIds(db: Db, importId: string): Promise<string[]> {
  const rows = await db.ledgerImportEntry.findMany({ where: { importId, propertyId: { not: null } }, select: { propertyId: true }, distinct: ["propertyId"] });
  return rows.map((row) => row.propertyId).filter((id): id is string => !!id);
}

async function loadImportOrThrow(db: Db, organizationId: string, importId: string): Promise<ImportRow> {
  const row = await db.ledgerImport.findUnique({ where: { id: importId } });
  if (!row || row.organizationId !== organizationId) throw ledgerNotFound("LEDGER_IMPORT_NOT_FOUND", IMPORT_NOT_FOUND);
  return row;
}

function auditSummary(row: ImportRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    importId: row.id,
    kind: row.kind,
    format: row.format,
    status: row.status,
    contentHash: row.contentHash,
    fileName: row.fileName,
    fiscalYearCode: row.fiscalYearCode,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    rowCount: row.rowCount,
    entryCount: row.entryCount,
    skippedCount: row.skippedCount,
    warningCount: row.warningCount,
    totalDebit: moneyString(row.totalDebit),
    totalCredit: moneyString(row.totalCredit),
    journalEntryIds: row.journalEntryIds,
    reversalJournalEntryIds: row.reversalJournalEntryIds,
    ...extra
  };
}

function auditAfterPost(context: UserContext, outcome: PostOutcome, extra: { replacedImportIds: string[]; correlationId?: string; allowClosed: boolean; actorType: "user" | "system" }): void {
  const organizationId = outcome.row.organizationId;
  const base = { organizationId, actorUserId: context.userId, actorType: extra.actorType, correlationId: extra.correlationId } as const;
  for (const account of outcome.createdAccounts) {
    recordAuditEvent({ ...base, action: "ACCOUNT_CREATED", entityType: "account", entityId: account.id, afterJson: { code: account.code, name: account.name, kind: account.kind, parentCode: account.parentCode, usaliDepartment: account.usaliDepartment, usaliLine: account.usaliLine, importId: outcome.row.id } });
  }
  for (const year of outcome.createdYears) {
    recordAuditEvent({ ...base, action: "FISCAL_YEAR_OPENED", entityType: "fiscal_year", entityId: year.id, afterJson: { code: year.code, startDate: `${year.code}-01-01`, endDate: `${year.code}-12-31`, importId: outcome.row.id } });
  }
  for (const period of outcome.createdPeriods) {
    recordAuditEvent({ ...base, action: "FISCAL_PERIOD_OPENED", entityType: "fiscal_period", entityId: period.id, afterJson: { periodCode: period.periodCode, periodType: "month", importId: outcome.row.id } });
  }
  for (const year of outcome.closedYears) {
    recordAuditEvent({ ...base, action: "FISCAL_YEAR_CLOSED", entityType: "fiscal_year", entityId: year.fiscalYearId, afterJson: { code: year.code, importId: outcome.row.id, source: "sage200_import" } });
  }
  recordAuditEvent({
    ...base,
    action: "LEDGER_IMPORT_POSTED",
    entityType: "ledger_import",
    entityId: outcome.row.id,
    afterJson: auditSummary(outcome.row, { created: outcome.created, skipped: outcome.skipped, replacedImportIds: extra.replacedImportIds, allowClosed: extra.allowClosed, createdAccounts: outcome.createdAccounts.map((account) => account.code), createdYears: outcome.createdYears.map((year) => year.code), closedYears: outcome.closedYears.map((year) => year.code) })
  });
}

async function reconciliationAfterPost(input: { context: UserContext; row: ImportRow; balance: LedgerImportBalanceAttachment | undefined; createdBy: string | null; correlationId?: string; warnings: string[] }): Promise<LedgerReconciliationDto | null> {
  const { row } = input;
  if (optionsOf(row).reconcile !== true) return null;
  if (!input.balance || (!input.balance.content && !input.balance.contentBase64)) {
    input.warnings.push("Se pidió reconciliar pero no se adjuntó el balance de sumas y saldos de Sage: lanza la reconciliación por separado.");
    return null;
  }
  if (!row.periodFrom || !row.periodTo) {
    input.warnings.push("El lote no tiene rango de meses: no se puede reconciliar automáticamente.");
    return null;
  }
  const [year, month] = row.periodTo.split("-").map(Number) as [number, number];
  const to = `${row.periodTo}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
  try {
    return await reconcileLedger({
      context: input.context,
      body: { from: `${row.periodFrom}-01`, to, propertyId: input.balance.propertyId ?? undefined, format: input.balance.format, content: input.balance.content ?? undefined, contentBase64: input.balance.contentBase64 ?? undefined, sheetName: input.balance.sheetName, importId: row.id },
      createdBy: input.createdBy,
      correlationId: input.correlationId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.warnings.push(`La reconciliación tras el lote falló (el lote queda contabilizado): ${message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export async function previewLedgerImport(input: { context: UserContext; body: LedgerImportPreviewBody; legalEntityId?: string | null; db?: Db }): Promise<LedgerImportPreview> {
  requirePermissions(input.context, ["accounting.journal.post"]);
  const db = input.db ?? prisma;
  const analysis = await analyseBody({ organizationId: input.context.organizationId, scopeContext: input.context, body: input.body, db, legalEntityId: input.legalEntityId });
  return previewOf(analysis);
}

// ---------------------------------------------------------------------------
// Create (+ post)
// ---------------------------------------------------------------------------

function throwFirstBlocker(analysis: Analysis): void {
  const blocker = analysis.blockers[0];
  if (blocker) throw blockerError(blocker);
}

export async function createLedgerImport(input: { context: UserContext; body: LedgerImportCreateBody; createdBy?: string | null; correlationId?: string; legalEntityId?: string | null; balance?: LedgerImportBalanceAttachment; actorType?: "user" | "system" }): Promise<LedgerImportCreateResult> {
  requirePermissions(input.context, ["accounting.journal.post"]);
  const organizationId = input.context.organizationId;
  const post = input.body.post !== false;
  const options = input.body.options ?? {};
  const replace = options.replace === true;
  if (replace && !post) throw ledgerBadRequest("VALIDATION_ERROR", "replace exige post: true: un lote en borrador no sustituye lotes contabilizados.", { field: "options.replace" });
  const createdBy = input.createdBy === undefined ? input.context.userId : input.createdBy;
  const analysis = await analyseBody({ organizationId, scopeContext: input.context, body: input.body, db: prisma, legalEntityId: input.legalEntityId });
  throwFirstBlocker(analysis);
  // Un borrador guarda las filas canónicas (NIF, nombres, importes) en mappingJson hasta contabilizarlo: acotado.
  if (!post && analysis.rows.length > LEDGER_IMPORT_MAX_DRAFT_ROWS) throw ledgerBadRequest("LEDGER_IMPORT_TOO_MANY_ROWS", `Un borrador conserva como máximo ${LEDGER_IMPORT_MAX_DRAFT_ROWS} filas del fichero (este trae ${analysis.rows.length}): contabilízalo directamente (post: true) o usa el CLI.`, { rows: analysis.rows.length, max: LEDGER_IMPORT_MAX_DRAFT_ROWS });

  const outcome = await prisma.$transaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const scope = await resolveLedgerScope(input.context, { legalEntityId: input.legalEntityId ?? null }, tx);
    const duplicate = await findDuplicateImport(tx, organizationId, analysis.contentHash);
    const overlaps = await findOverlapsOf(tx, organizationId, analysis);
    const txBlockers = computeBlockers({ kind: analysis.kind, replace, duplicate, overlaps, journal: null, balances: null, plannedCount: 0, vatSettingsMissing: false });
    if (txBlockers[0]) throw blockerError(txBlockers[0]);
    const created = await tx.ledgerImport.create({
      data: {
        organizationId,
        legalEntityId: scope.legalEntityId,
        system: SYSTEM,
        kind: analysis.kind,
        format: analysis.format,
        fileName: analysis.fileName,
        contentHash: analysis.contentHash,
        sourceCompanyCode: analysis.sourceCompanyCode,
        fiscalYearCode: analysis.fiscalYearCode,
        periodFrom: analysis.periodFrom,
        periodTo: analysis.periodTo,
        status: "draft",
        rowCount: analysis.rowCount,
        mappingJson: mappingJsonOf(analysis, !post),
        warningsJson: analysis.warnings as Prisma.InputJsonValue,
        warningCount: analysis.warnings.length,
        totalDebit: analysis.totals.debit.toFixed(2),
        totalCredit: analysis.totals.credit.toFixed(2),
        notes: input.body.notes?.trim() || null,
        createdBy
      }
    });
    const replacedImportIds = replace ? await replaceImportsInTx(tx, organizationId, [...new Set([...(duplicate && !MASTER_KINDS.includes(analysis.kind) ? [duplicate.id] : []), ...overlaps.map((overlap) => overlap.importId)])], { newImportId: created.id, reversedBy: createdBy, correlationId: input.correlationId, scopeContext: input.context }) : [];
    if (!post) {
      const draftEntries: EntryCreate[] = [...analysis.planned.map((entry) => ({ ...baseEntry(created.id, organizationId, entry), status: "draft", journalEntryId: null, sourceType: entry.sourceType, sourceId: entry.sourceId, warningsJson: entry.warnings })), ...skippedNativeEntries(created.id, organizationId, analysis)];
      if (draftEntries.length > 0) await tx.ledgerImportEntry.createMany({ data: draftEntries });
      return { ...emptyOutcome(created), warnings: analysis.warnings, replacedImportIds, posted: false };
    }
    const posted = await postImportInTx(tx, created, analysis, { createdBy, correlationId: input.correlationId, allowClosed: options.allowClosed === true });
    return { ...posted, replacedImportIds, posted: true };
  }, TX_OPTIONS);

  const actorType = input.actorType ?? "user";
  if (outcome.posted) auditAfterPost(input.context, outcome, { replacedImportIds: outcome.replacedImportIds, correlationId: input.correlationId, allowClosed: options.allowClosed === true, actorType });
  else recordAuditEvent({ organizationId, actorUserId: input.context.userId, actorType, action: "LEDGER_IMPORTED", entityType: "ledger_import", entityId: outcome.row.id, afterJson: auditSummary(outcome.row, { replacedImportIds: outcome.replacedImportIds }), correlationId: input.correlationId });
  const warnings = [...outcome.warnings];
  const reconciliation = outcome.posted ? await reconciliationAfterPost({ context: input.context, row: outcome.row, balance: input.balance, createdBy, correlationId: input.correlationId, warnings }) : null;
  const { entries } = await entryDtosOf(prisma, outcome.row.id);
  return { import: toImportRecord(outcome.row), entries, created: outcome.created, skipped: outcome.skipped, warnings, reconciliation };
}

// ---------------------------------------------------------------------------
// Post (borrador → contabilizado)
// ---------------------------------------------------------------------------

export async function postLedgerImport(input: { context: UserContext; importId: string; replace?: boolean; correlationId?: string; balance?: LedgerImportBalanceAttachment; actorType?: "user" | "system" }): Promise<LedgerImportCreateResult> {
  requirePermissions(input.context, ["accounting.journal.post"]);
  const organizationId = input.context.organizationId;
  const replace = input.replace === true;
  const existing = await loadImportOrThrow(prisma, organizationId, input.importId);
  assertFinanceReadScopeMany(input.context, await importPropertyIds(prisma, existing.id));
  if (existing.status === "posted") throw ledgerConflict("LEDGER_IMPORT_ALREADY_POSTED", "El lote ya está contabilizado.", { importId: existing.id });
  if (existing.status === "reversed") throw ledgerConflict("LEDGER_IMPORT_REVERSED", "El lote está revertido: crea uno nuevo.", { importId: existing.id });
  const draftRows = draftRowsOf(existing);
  if (!draftRows || draftRows.length === 0) throw ledgerConflict("LEDGER_IMPORT_NOT_POSTED", "El borrador no conserva las filas del fichero: impórtalo de nuevo.", { importId: existing.id });
  const mapping = mappingOf(existing);
  const options: LedgerImportOptions = { ...optionsOf(existing), replace };
  const analysis = await analyseRows({ organizationId, scopeContext: input.context, kind: existing.kind as LedgerImportKind, format: existing.format as LedgerImportFormat, fileName: existing.fileName, rows: draftRows, rowCount: existing.rowCount, parseWarnings: [], company: existing.sourceCompanyCode, mapping, options, db: prisma, excludeImportId: existing.id });
  throwFirstBlocker(analysis);
  const before = auditSummary(existing);

  const outcome = await prisma.$transaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const row = await loadImportOrThrow(tx, organizationId, input.importId);
    if (row.status !== "draft") throw ledgerConflict(row.status === "posted" ? "LEDGER_IMPORT_ALREADY_POSTED" : "LEDGER_IMPORT_REVERSED", "El lote ya no está en borrador.", { importId: row.id, status: row.status });
    const duplicate = await findDuplicateImport(tx, organizationId, analysis.contentHash, row.id);
    const overlaps = await findOverlapsOf(tx, organizationId, analysis, row.id);
    const txBlockers = computeBlockers({ kind: analysis.kind, replace, duplicate, overlaps, journal: null, balances: null, plannedCount: 0, vatSettingsMissing: false });
    if (txBlockers[0]) throw blockerError(txBlockers[0]);
    const replacedImportIds = replace ? await replaceImportsInTx(tx, organizationId, [...new Set([...(duplicate && !MASTER_KINDS.includes(analysis.kind) ? [duplicate.id] : []), ...overlaps.map((overlap) => overlap.importId)])], { newImportId: row.id, reversedBy: input.context.userId, correlationId: input.correlationId, scopeContext: input.context }) : [];
    const posted = await postImportInTx(tx, row, analysis, { createdBy: input.context.userId, correlationId: input.correlationId, allowClosed: options.allowClosed === true });
    return { ...posted, replacedImportIds };
  }, TX_OPTIONS);

  auditAfterPost(input.context, outcome, { replacedImportIds: outcome.replacedImportIds, correlationId: input.correlationId, allowClosed: options.allowClosed === true, actorType: input.actorType ?? "user" });
  recordAuditEvent({ organizationId, actorUserId: input.context.userId, actorType: input.actorType ?? "user", action: "LEDGER_IMPORT_DRAFT_POSTED", entityType: "ledger_import", entityId: outcome.row.id, beforeJson: before, afterJson: auditSummary(outcome.row), correlationId: input.correlationId });
  const warnings = [...outcome.warnings];
  const reconciliation = await reconciliationAfterPost({ context: input.context, row: outcome.row, balance: input.balance, createdBy: input.context.userId, correlationId: input.correlationId, warnings });
  const { entries } = await entryDtosOf(prisma, outcome.row.id);
  return { import: toImportRecord(outcome.row), entries, created: outcome.created, skipped: outcome.skipped, warnings, reconciliation };
}

// ---------------------------------------------------------------------------
// Reverse (idempotente)
// ---------------------------------------------------------------------------

export async function reverseLedgerImport(input: { context: UserContext; importId: string; reason: string; correlationId?: string; actorType?: "user" | "system" }): Promise<LedgerImportRecord & { alreadyReversed: boolean }> {
  requirePermissions(input.context, ["accounting.journal.post"]);
  const organizationId = input.context.organizationId;
  const reason = input.reason?.trim() ?? "";
  if (!reason) throw ledgerBadRequest("JOURNAL_REVERSAL_REASON_REQUIRED", "Indica el motivo del reverso.");
  const existing = await loadImportOrThrow(prisma, organizationId, input.importId);
  assertFinanceReadScopeMany(input.context, await importPropertyIds(prisma, existing.id));
  if (existing.status === "reversed") return { ...toImportRecord(existing), alreadyReversed: true };
  if (existing.status === "draft") throw ledgerConflict("LEDGER_IMPORT_NOT_POSTED", "El lote no está contabilizado: no hay nada que revertir.", { importId: existing.id, status: existing.status });
  const before = auditSummary(existing);

  const outcome = await prisma.$transaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const row = await loadImportOrThrow(tx, organizationId, input.importId);
    if (row.status === "reversed") return { row, reversalIds: [] as string[], reopenedYears: [] as string[], alreadyReversed: true };
    const reversed = await reverseImportInTx(tx, row, { reason, reversedBy: input.context.userId, correlationId: input.correlationId });
    return { ...reversed, alreadyReversed: false };
  }, TX_OPTIONS);

  if (!outcome.alreadyReversed) {
    recordAuditEvent({
      organizationId,
      actorUserId: input.context.userId,
      actorType: input.actorType ?? "user",
      action: "LEDGER_IMPORT_REVERSED",
      entityType: "ledger_import",
      entityId: outcome.row.id,
      beforeJson: before,
      afterJson: auditSummary(outcome.row, { reason, reversalJournalEntryIds: outcome.reversalIds, reopenedYears: outcome.reopenedYears }),
      correlationId: input.correlationId
    });
  }
  return { ...toImportRecord(outcome.row), alreadyReversed: outcome.alreadyReversed };
}

// ---------------------------------------------------------------------------
// List / get
// ---------------------------------------------------------------------------

export async function listLedgerImports(input: { context: UserContext; query?: LedgerImportListQuery }): Promise<LedgerImportRecord[]> {
  requirePermissions(input.context, ["accounting.read"]);
  const query = input.query ?? {};
  const organizationId = input.context.organizationId;
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? LEDGER_IMPORT_LIST_DEFAULT_LIMIT), 1), LEDGER_IMPORT_LIST_MAX_LIMIT);
  const rows = await prisma.ledgerImport.findMany({
    where: {
      organizationId,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.to ? { periodFrom: { lte: query.to } } : {}),
      ...(query.from ? { periodTo: { gte: query.from } } : {})
    },
    orderBy: { createdAt: "desc" },
    take: limit
  });
  if (rows.length === 0) return [];
  const propertyRows = await prisma.ledgerImportEntry.findMany({ where: { importId: { in: rows.map((row) => row.id) }, propertyId: { not: null } }, select: { importId: true, propertyId: true }, distinct: ["importId", "propertyId"] });
  const byImport = new Map<string, string[]>();
  for (const row of propertyRows) if (row.propertyId) byImport.set(row.importId, [...(byImport.get(row.importId) ?? []), row.propertyId]);
  // R11: un lote sin centro en sus entradas (plan, libros, terceros, diario / saldos a nivel sociedad) es de toda la
  // sociedad: exige accounting.entity.read, como el detalle (`getLedgerImport` → 404 ENTITY_SCOPE_REQUIRED).
  const entityScope = hasEntityReadScope(input.context);
  return rows
    .filter((row) => {
      const propertyIds = byImport.get(row.id) ?? [];
      if (propertyIds.length === 0) return entityScope;
      return propertyIds.every((propertyId) => propertyWithinScope(input.context, propertyId));
    })
    .map(toImportRecord);
}

/** Detalle del lote (el objeto que lee el front) más, en un lote balances, la página de `balances`: `balanceOffset` … de `balanceTotal`. */
export type LedgerImportDetailPage = LedgerImportDetail & { balanceTotal?: number; balanceOffset?: number };

export async function getLedgerImport(input: { context: UserContext; importId: string; query?: LedgerImportDetailQuery }): Promise<LedgerImportDetailPage> {
  requirePermissions(input.context, ["accounting.read"]);
  const row = await loadImportOrThrow(prisma, input.context.organizationId, input.importId);
  assertFinanceReadScopeMany(input.context, await importPropertyIds(prisma, row.id));
  // Página de entradas: un lote de 20.000 asientos se recorre con ?offset=&limit= (auditable entero desde la API).
  const limit = Math.min(Math.max(Math.trunc(input.query?.limit ?? LEDGER_IMPORT_DETAIL_DEFAULT_LIMIT), 1), LEDGER_IMPORT_DETAIL_MAX_LIMIT);
  const offset = Math.max(Math.trunc(input.query?.offset ?? 0), 0);
  const { entries, total } = await entryDtosOf(prisma, row.id, limit, offset);
  const detail: LedgerImportDetailPage = { import: toImportRecord(row), entries, entryTotal: total, entryOffset: offset, mapping: mappingOf(row) };
  if (row.kind === "balances") {
    // L2-05: los saldos importados se paginan con el MISMO offset/limit que las entradas (406 filas en un lote de Faranda).
    const balanceWhere = { importId: row.id, organizationId: row.organizationId };
    const [balances, balanceTotal] = await Promise.all([
      prisma.ledgerImportBalance.findMany({ where: balanceWhere, orderBy: [{ periodCode: "asc" }, { propertyCode: "asc" }, { sourceAccount: "asc" }], skip: offset, take: limit }),
      prisma.ledgerImportBalance.count({ where: balanceWhere })
    ]);
    detail.balances = balances.map(balanceDto);
    detail.balanceTotal = balanceTotal;
    detail.balanceOffset = offset;
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Mapa de cuentas (GET accounting.read · PUT accounting.configure)
// ---------------------------------------------------------------------------

export async function getAccountMap(input: { context: UserContext }): Promise<LedgerAccountMapResponse> {
  requirePermissions(input.context, ["accounting.read"]);
  const map = await loadPersistedAccountMap(prisma, input.context.organizationId);
  return { system: SYSTEM, entries: [...map.values()] };
}

/** Valida las filas del mapa contra el plan (puro sobre el lookup); devuelve errores en español. */
export function validateAccountMapEntries(entries: readonly LedgerAccountMapDto[], chart: ChartLookup): Array<{ index: number; sourceAccount: string; message: string }> {
  const errors: Array<{ index: number; sourceAccount: string; message: string }> = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const sourceAccount = (entry.sourceAccount ?? "").trim();
    if (!sourceAccount) {
      errors.push({ index, sourceAccount, message: "sourceAccount es obligatorio." });
      return;
    }
    if (seen.has(sourceAccount)) errors.push({ index, sourceAccount, message: "cuenta Sage repetida en el mapa." });
    seen.add(sourceAccount);
    if (!(LEDGER_ACCOUNT_MAP_ACTIONS as readonly string[]).includes(entry.action)) {
      errors.push({ index, sourceAccount, message: `acción desconocida «${String(entry.action)}».` });
      return;
    }
    const code = entry.accountCode?.trim() ?? "";
    if (entry.action === "block") {
      if (code) errors.push({ index, sourceAccount, message: "una cuenta bloqueada no lleva cuenta destino." });
      return;
    }
    if (!code) {
      errors.push({ index, sourceAccount, message: "accountCode es obligatorio salvo en block." });
      return;
    }
    if (entry.action === "map_by_rate") {
      if (code !== "472" && code !== "477") errors.push({ index, sourceAccount, message: "map_by_rate solo admite el prefijo 472 o 477." });
      return;
    }
    if (!LEDGER_ACCOUNT_CODE_PATTERN.test(code)) {
      errors.push({ index, sourceAccount, message: `la cuenta destino ${code} no cumple el patrón PGC.` });
      return;
    }
    const target = chart.get(code);
    if (entry.action === "create") {
      if (target && !target.isPostable) errors.push({ index, sourceAccount, message: `la cuenta ${code} existe y es una cabecera.` });
      if (!target) {
        const group = accountGroup(code);
        if ((group === 6 || group === 7) && !(entry.usaliDepartment && entry.usaliLine && usaliValid({ usaliDepartment: entry.usaliDepartment, usaliLine: entry.usaliLine }))) {
          const template = usaliFor(entry, code);
          if (!template) errors.push({ index, sourceAccount, message: `la subcuenta ${code} (grupo ${group}) necesita departamento y línea USALI válidos.` });
        }
      }
      return;
    }
    if (!target) errors.push({ index, sourceAccount, message: `la cuenta destino ${code} no existe en el plan.` });
    else if (!target.isPostable) errors.push({ index, sourceAccount, message: `la cuenta destino ${code} es una cabecera y no admite apuntes.` });
  });
  return errors;
}

export async function putAccountMap(input: { context: UserContext; body: LedgerAccountMapPutBody; correlationId: string }): Promise<LedgerAccountMapResponse> {
  requirePermissions(input.context, ["accounting.configure"]);
  const organizationId = input.context.organizationId;
  if (input.body.system && input.body.system !== SYSTEM) throw ledgerBadRequest("LEDGER_IMPORT_MAP_INVALID", `Sistema no admitido: ${String(input.body.system)}.`, { errors: [{ index: -1, sourceAccount: "", message: "system" }] });
  const entries = (input.body.entries ?? []).map((entry) => ({ ...entry, sourceAccount: entry.sourceAccount?.trim() ?? "", accountCode: entry.accountCode?.trim() || null, carryCounterparty: entry.carryCounterparty ?? false }));
  const { lookup } = await loadChartLookup(prisma, organizationId);
  const errors = validateAccountMapEntries(entries, lookup);
  if (errors.length > 0) throw ledgerBadRequest("LEDGER_IMPORT_MAP_INVALID", `El mapa tiene ${errors.length} fila(s) inválida(s): ${errors.slice(0, 3).map((error) => `${error.sourceAccount || `#${error.index}`}: ${error.message}`).join(" ")}`, { errors });
  // Altas de subcuentas `create` que aún no existen, en la MISMA transacción que persiste el mapa (patrón del lote
  // `plan`: padre = prefijo existente más largo, naturaleza heredada, USALI de la fila o de la plantilla en 6/7); si
  // una fila posterior falla nada queda a medias. Se audita ACCOUNT_CREATED por cuenta tras el commit.
  const createdAccounts = await prisma.$transaction(async (tx) => {
    const store = prismaChartStore(tx);
    const current = await store.listAccounts(organizationId);
    const codesKnown = new Set(current.map((row) => row.code));
    const byCode = new Map(current.map((row) => [row.code, row]));
    const rows: Array<NewChartAccountRow & { parentCode: string | null }> = [];
    for (const entry of entries) {
      if (entry.action !== "create" || !entry.accountCode || codesKnown.has(entry.accountCode)) continue;
      const code = entry.accountCode;
      const parentCode = resolveParentCode(code, codesKnown);
      const parent = parentCode ? byCode.get(parentCode) ?? rows.find((row) => row.code === parentCode) : undefined;
      if (!parent) throw ledgerBadRequest("ACCOUNT_KIND_REQUIRED", `La cuenta ${code} no tiene cuenta padre en el plan de la que heredar la naturaleza.`, { accountCode: code });
      const group = accountGroup(code);
      const usali = group === 6 || group === 7 ? usaliFor(entry, code) : null;
      if ((group === 6 || group === 7) && (!usali || !usaliValid(usali))) throw ledgerBadRequest("USALI_MAPPING_INCOMPLETE", `La subcuenta ${code} (grupo ${group}) necesita departamento y línea USALI válidos.`, { accountCode: code });
      const kind = parent.kind as AccountKind;
      rows.push({ organizationId, code, name: (entry.sourceName ?? "").trim() || `Cuenta ${entry.sourceAccount}`, kind, accountType: legacyAccountType(kind), group, level: accountLevel(code), isPostable: isPostableCode(code), usaliDepartment: usali?.usaliDepartment ?? null, usaliLine: usali?.usaliLine ?? null, parentCode });
      codesKnown.add(code);
    }
    if (rows.length > 0) await store.createAccounts(rows.map(({ parentCode: _parentCode, ...row }) => row));
    const refreshed = rows.length > 0 ? new Map((await store.listAccounts(organizationId)).map((row) => [row.code, row])) : byCode;
    const created: Array<{ id: string; code: string; name: string; kind: string; parentCode: string | null; usaliDepartment: string | null; usaliLine: string | null }> = [];
    for (const row of rows) {
      const account = refreshed.get(row.code);
      if (!account) continue;
      const parent = row.parentCode ? refreshed.get(row.parentCode) : undefined;
      if (parent && account.parentId !== parent.id) await store.updateAccount(account.id, { parentId: parent.id });
      created.push({ id: account.id, code: account.code, name: account.name, kind: String(account.kind), parentCode: row.parentCode, usaliDepartment: account.usaliDepartment, usaliLine: account.usaliLine });
    }
    const keep = new Set(entries.map((entry) => entry.sourceAccount));
    await tx.ledgerAccountMap.deleteMany({ where: { organizationId, system: SYSTEM, sourceAccount: { notIn: [...keep] } } });
    for (const entry of entries) await upsertAccountMap(tx, organizationId, entry, input.context.userId);
    return created;
  });
  for (const account of createdAccounts) {
    recordAuditEvent({ organizationId, actorUserId: input.context.userId, actorType: "user", action: "ACCOUNT_CREATED", entityType: "account", entityId: account.id, afterJson: { code: account.code, name: account.name, kind: account.kind, parentCode: account.parentCode, usaliDepartment: account.usaliDepartment, usaliLine: account.usaliLine, source: "ledger_account_map" }, correlationId: input.correlationId });
  }
  recordAuditEvent({ organizationId, actorUserId: input.context.userId, actorType: "user", action: "LEDGER_ACCOUNT_MAP_UPDATED", entityType: "ledger_account_map", entityId: organizationId, afterJson: { system: SYSTEM, entries: entries.length, createdAccounts: createdAccounts.map((account) => account.code) }, correlationId: input.correlationId });
  return getAccountMap({ context: input.context });
}

// ---------------------------------------------------------------------------
// Mapa analítico (GET accounting.read · PUT accounting.configure)
// ---------------------------------------------------------------------------

export async function getAnalyticsMap(input: { context: UserContext }): Promise<LedgerAnalyticsMapResponse> {
  requirePermissions(input.context, ["accounting.read"]);
  const { config, entries } = await loadPersistedAnalyticsMap(prisma, input.context.organizationId);
  return { system: SYSTEM, centreDimension: config.centreDimension, costCentreDimension: config.costCentreDimension, unassignedPolicy: config.unassignedPolicy, entries };
}

export function validateAnalyticsMapEntries(entries: readonly LedgerAnalyticsMapDto[], propertyIds: ReadonlySet<string>): Array<{ index: number; sourceCode: string; message: string }> {
  const errors: Array<{ index: number; sourceCode: string; message: string }> = [];
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const sourceCode = (entry.sourceCode ?? "").trim();
    if (!(LEDGER_ANALYTICS_DIMENSIONS as readonly string[]).includes(entry.dimension)) errors.push({ index, sourceCode, message: `dimensión desconocida «${String(entry.dimension)}».` });
    if (!sourceCode) errors.push({ index, sourceCode, message: "sourceCode es obligatorio." });
    const key = `${entry.dimension}:${sourceCode}`;
    if (seen.has(key)) errors.push({ index, sourceCode, message: "código repetido en la dimensión." });
    seen.add(key);
    if (entry.propertyId && !propertyIds.has(entry.propertyId)) errors.push({ index, sourceCode, message: "el centro no es de la organización." });
    if (entry.costCentreCode && !(LEDGER_USALI_COST_CENTRE_CODES as readonly string[]).includes(entry.costCentreCode)) errors.push({ index, sourceCode, message: `centro de coste USALI desconocido «${entry.costCentreCode}».` });
  });
  return errors;
}

export async function putAnalyticsMap(input: { context: UserContext; body: LedgerAnalyticsMapPutBody; correlationId: string }): Promise<LedgerAnalyticsMapResponse> {
  requirePermissions(input.context, ["accounting.configure"]);
  const organizationId = input.context.organizationId;
  const body = input.body;
  const errors: Array<{ index: number; sourceCode: string; message: string }> = [];
  if (!(LEDGER_ANALYTICS_DIMENSIONS as readonly string[]).includes(body.centreDimension)) errors.push({ index: -1, sourceCode: "", message: "centreDimension desconocida." });
  if (body.costCentreDimension && !(LEDGER_ANALYTICS_DIMENSIONS as readonly string[]).includes(body.costCentreDimension)) errors.push({ index: -1, sourceCode: "", message: "costCentreDimension desconocida." });
  if (!isLedgerUnassignedPolicy(body.unassignedPolicy)) errors.push({ index: -1, sourceCode: "", message: "unassignedPolicy debe ser block, office o property:<id>." });
  const properties = await loadProperties(prisma, organizationId);
  const propertyIds = new Set(properties.map((property) => property.id));
  const entries = (body.entries ?? []).map((entry) => ({ ...entry, sourceCode: entry.sourceCode?.trim() ?? "", propertyId: entry.propertyId || null, costCentreCode: entry.costCentreCode || null }));
  errors.push(...validateAnalyticsMapEntries(entries, propertyIds));
  if (errors.length > 0) throw ledgerBadRequest("LEDGER_IMPORT_MAP_INVALID", `El mapa analítico tiene ${errors.length} error(es): ${errors.slice(0, 3).map((error) => `${error.sourceCode || "configuración"}: ${error.message}`).join(" ")}`, { errors });
  assertFinanceReadScopeMany(input.context, entries.map((entry) => entry.propertyId).filter((id): id is string => !!id));
  const config: AnalyticsConfig = { centreDimension: body.centreDimension, costCentreDimension: body.costCentreDimension ?? null, unassignedPolicy: body.unassignedPolicy };
  await prisma.$transaction(async (tx) => {
    const keys = new Set(entries.map((entry) => `${entry.dimension}:${entry.sourceCode}`));
    const current = await tx.ledgerAnalyticsMap.findMany({ where: { organizationId, system: SYSTEM }, select: { id: true, dimension: true, sourceCode: true } });
    const stale = current.filter((row) => row.dimension !== ANALYTICS_CONFIG_DIMENSION && !keys.has(`${row.dimension}:${row.sourceCode}`)).map((row) => row.id);
    if (stale.length > 0) await tx.ledgerAnalyticsMap.deleteMany({ where: { id: { in: stale } } });
    for (const entry of entries) {
      await tx.ledgerAnalyticsMap.upsert({
        where: { organizationId_system_dimension_sourceCode: { organizationId, system: SYSTEM, dimension: entry.dimension, sourceCode: entry.sourceCode } },
        create: { organizationId, system: SYSTEM, dimension: entry.dimension, sourceCode: entry.sourceCode, sourceName: entry.sourceName ?? null, propertyId: entry.propertyId, costCentreCode: entry.costCentreCode },
        update: { sourceName: entry.sourceName ?? null, propertyId: entry.propertyId, costCentreCode: entry.costCentreCode }
      });
    }
    await tx.ledgerAnalyticsMap.upsert({
      where: { organizationId_system_dimension_sourceCode: { organizationId, system: SYSTEM, dimension: ANALYTICS_CONFIG_DIMENSION, sourceCode: ANALYTICS_CONFIG_CODE } },
      create: { organizationId, system: SYSTEM, dimension: ANALYTICS_CONFIG_DIMENSION, sourceCode: ANALYTICS_CONFIG_CODE, sourceName: JSON.stringify(config), propertyId: null, costCentreCode: null },
      update: { sourceName: JSON.stringify(config) }
    });
  });
  recordAuditEvent({ organizationId, actorUserId: input.context.userId, actorType: "user", action: "LEDGER_ANALYTICS_MAP_UPDATED", entityType: "ledger_analytics_map", entityId: organizationId, afterJson: { system: SYSTEM, ...config, entries: entries.length }, correlationId: input.correlationId });
  return getAnalyticsMap({ context: input.context });
}

// ---------------------------------------------------------------------------
// Plantillas canónicas
// ---------------------------------------------------------------------------

export function buildLedgerImportTemplate(kind: LedgerImportKind): { fileName: string; content: string; contentType: string } {
  try {
    return { fileName: canonicalTemplateFileName(kind), content: buildCanonicalTemplate(kind), contentType: "text/csv; charset=utf-8" };
  } catch (error) {
    toHttpError(error);
  }
}
