// OPERA Cloud · modo sombra (Tanda 7b · L2) — servicio de importación,
// contabilización, reverso, listado y detalle de los lotes de ingresos diarios
// (`PmsShadowRevenueImport`). Patrón de la Tanda 6c (payroll/cost-import.service.ts).
//
// Un lote = un fichero de ingresos de OPERA de UN business date (XML
// GEN_XMLBO_REVENUE, findeptcodes XML / Delimited o RESPONSYS_TRX) identificado
// por el sha256 de sus bytes. Contabilizar = UN asiento por (hotel, business
// date) con sourceType `pms_shadow_revenue` (revenue-import.posting.ts) a través
// del puente `ledger()` (motor único del diario: numeración, periodos cerrados,
// idempotencia por sourceId).
//
// Orden de guardas de `importPmsShadowRevenue` (diseño §6.4; cada una falla
// antes de escribir nada):
//   1. permiso `accounting.journal.post` → 403; propiedad de la organización → 404 opaco;
//   2. parseo → 400 PMS_SHADOW_FILE_TOO_LARGE / PMS_SHADOW_FILE_UNREADABLE / PMS_SHADOW_REVENUE_EMPTY /
//      PMS_SHADOW_FEED_UNKNOWN;
//   3. `hotel_code` del fichero ≠ `operaHotelCode` del perfil → 409 PMS_SHADOW_REVENUE_HOTEL_MISMATCH;
//      fecha del fichero ≠ `businessDate` del cuerpo → 400 PMS_SHADOW_REVENUE_DAY_MISMATCH;
//      sin fecha en ninguno → 400 VALIDATION_ERROR; `replace` sin `post` → 400 VALIDATION_ERROR;
//   4. mapeo del perfil (`trxMappingJson`; `body.mapping` lo sustituye: CLI y tests): con `post`
//      todo código REVENUE sin mapear → 400 OPERA_TRX_CODE_UNMAPPED { codes } (nada escrito);
//   5. transacción propia (`maxWait 15 s`, `timeout 180 s`) bajo
//      `pg_advisory_xact_lock(hashtext('pms_shadow_revenue:<propertyId>'))`:
//      mismo hash en un lote no revertido → 409 PMS_SHADOW_REVENUE_DUPLICATE salvo `force`;
//      otro lote no revertido del mismo día → 409 PMS_SHADOW_REVENUE_ALREADY_POSTED salvo `replace`
//      (revierte ENTERO el anterior en la misma transacción y lo marca `replacedById`);
//   6. lote `draft` con linesJson (códigos, descripciones, importes: sin PII), totales, avisos y
//      reconciliación; 7. si `post`: CostCenter USALI (se reutiliza el existente sin reescribirlo),
//      asiento vía `ledger().postJournalEntry({ db: tx })` (`created !== true` → 409
//      PMS_SHADOW_REVENUE_ENTRY_EXISTS), lote `posted`; 8. auditoría fuera de la transacción.
// Un periodo cerrado (409 FISCAL_YEAR_CLOSED / FISCAL_PERIOD_CLOSED del motor) deshace TODO:
// el lote NO queda. Reverso: el periodo del asiento ORIGINAL debe estar abierto aunque
// `entryDate` sea otra fecha (contable-6C-02). Solo se reversan asientos cuyos ids están en
// `journalEntryIds` del lote: los asientos previos del diario no se tocan nunca.

import { createHash } from "node:crypto";
import { prisma } from "@hotelos/database";
import { Prisma } from "@prisma/client";
import type {
  IsoDate,
  MoneyString,
  PmsShadowBlocker,
  PmsShadowRevenueImportRecord,
  PmsShadowRevenueLine,
  PmsShadowRevenuePreview,
  PmsShadowRevenueReconciliation,
  PmsShadowRevenueSource,
  PmsShadowRevenueStatus,
  PmsShadowRevenueTotals,
  PmsShadowTrxCodeMapping
} from "@hotelos/shared";
import { PMS_SHADOW_REVENUE_STATUSES } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { dateOnlyUtc, ledgerBadRequest, ledgerConflict, ledgerNotFound, resolveFiscalYear } from "../accounting/accounting.service.js";
import { isPostingAllowed } from "../accounting/fiscal-period.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { assertPropertyInOrg } from "../pms/pms.service.js";
import { ledger, type Db } from "../treasury/ledger-bridge.js";
import { dec, isoDay, money } from "../treasury/money.js";
import { requireAnyPermission } from "../treasury/permissions.js";
import { parseRevenueFile, type PmsShadowRevenueFileInput, type PmsShadowRevenueParsed } from "./revenue-import.parser.js";
import {
  PMS_SHADOW_COST_CENTRE_TYPE,
  buildPmsShadowRevenueEntry,
  checkTrialBalance,
  pmsShadowCostCentreCode,
  pmsShadowCostCentreName,
  resolveTrxMapping,
  sumRevenueTotals
} from "./revenue-import.posting.js";

const TX_OPTIONS = { maxWait: 15_000, timeout: 180_000 } as const;
const IMPORT_NOT_FOUND = "Lote de ingresos no encontrado.";
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const MAX_REASON_LENGTH = 500;
const PMS_SHADOW_SYSTEM = "opera_cloud";
const POST_KEYS = ["accounting.journal.post"] as const;

type ImportRow = NonNullable<Awaited<ReturnType<typeof prisma.pmsShadowRevenueImport.findUnique>>>;
type ProfileRow = NonNullable<Awaited<ReturnType<typeof prisma.pmsShadowProfile.findUnique>>>;
type PropertyLite = { id: string; code: string | null; name: string };

// ---------------------------------------------------------------------------
// Tipos de entrada
// ---------------------------------------------------------------------------

/** Valores declarados por OPERA para el cuadre (Trial Balance / Manager Report del mismo día). */
export type PmsShadowRevenueDeclared = {
  transactionTotalToday?: MoneyString | null;
  roomRevenue?: MoneyString | null;
  totalRevenue?: MoneyString | null;
};

export type PmsShadowRevenueImportBody = PmsShadowRevenueFileInput & {
  businessDate?: IsoDate | null;
  post: boolean;
  replace: boolean;
  includePayments?: boolean;
  /** Ignora el 409 PMS_SHADOW_REVENUE_DUPLICATE (mismo fichero ya importado). */
  force?: boolean;
  /** Sustituye el mapeo del perfil (CLI y tests). */
  mapping?: PmsShadowTrxCodeMapping[] | null;
  reconciliation?: PmsShadowRevenueDeclared | null;
};

export type PmsShadowRevenuePreviewBody = Omit<PmsShadowRevenueImportBody, "post" | "replace"> & { post?: boolean; replace?: boolean };

/** `reconciliationJson` del lote: valores declarados + resultado del cuadre Σ total_amount ≡ Transaction Total Today. */
export type PmsShadowRevenueReconciliationJson = {
  declared: PmsShadowRevenueDeclared;
  check: PmsShadowRevenueReconciliation;
};

/** Reconciliación del día para el panel y el job (L3): lo contabilizado por Anfitorio frente a lo declarado por OPERA. */
export type PmsShadowRevenueDayReconciliation = {
  propertyId: string;
  businessDate: IsoDate;
  importId: string | null;
  status: PmsShadowRevenueStatus | null;
  /** Σ H − D de las líneas 705.x del asiento del lote contabilizado (0.00 sin lote). */
  revenue705: MoneyString;
  /** Σ H − D de las líneas 477.x. */
  tax477: MoneyString;
  totals: PmsShadowRevenueTotals | null;
  declared: PmsShadowRevenueDeclared;
  check: PmsShadowRevenueReconciliation | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** sha256 hex de los bytes del fichero tal cual (idempotencia por contenido). */
export function revenueContentHash(bytes: Uint8Array | string): string {
  return createHash("sha256")
    .update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes)
    .digest("hex");
}

function isIsoDate(value: unknown): value is IsoDate {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

async function lockProperty(tx: Prisma.TransactionClient, propertyId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pms_shadow_revenue:${propertyId}`}))`;
}

async function loadProperty(db: Db, organizationId: string, propertyId: string): Promise<PropertyLite> {
  const property = await db.property.findUnique({ where: { id: propertyId }, select: { id: true, organizationId: true, code: true, name: true } });
  if (!property || property.organizationId !== organizationId) throw ledgerNotFound("PROPERTY_NOT_FOUND", "Propiedad no encontrada.");
  return { id: property.id, code: property.code, name: property.name };
}

function hotelLabelOf(property: PropertyLite): string {
  return property.code?.trim() || property.name?.trim() || property.id;
}

async function loadProfile(db: Db, organizationId: string, propertyId: string): Promise<ProfileRow | null> {
  const profile = await db.pmsShadowProfile.findUnique({ where: { propertyId_system: { propertyId, system: PMS_SHADOW_SYSTEM } } });
  if (!profile || profile.organizationId !== organizationId) return null;
  return profile;
}

function mappingOfProfile(profile: ProfileRow | null): PmsShadowTrxCodeMapping[] {
  const raw = profile?.trxMappingJson;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is PmsShadowTrxCodeMapping => !!entry && typeof entry === "object" && typeof (entry as { code?: unknown }).code === "string" && typeof (entry as { kind?: unknown }).kind === "string");
}

async function loadImportOrThrow(db: Db, organizationId: string, propertyId: string, importId: string): Promise<ImportRow> {
  const row = await db.pmsShadowRevenueImport.findUnique({ where: { id: importId } });
  if (!row || row.organizationId !== organizationId || row.propertyId !== propertyId) throw ledgerNotFound("PMS_SHADOW_REVENUE_NOT_FOUND", IMPORT_NOT_FOUND);
  return row;
}

function linesOf(row: ImportRow): PmsShadowRevenueLine[] {
  return Array.isArray(row.linesJson) ? (row.linesJson as unknown as PmsShadowRevenueLine[]) : [];
}

function warningsOf(row: ImportRow): string[] {
  return Array.isArray(row.warningsJson) ? (row.warningsJson as unknown[]).filter((w): w is string => typeof w === "string") : [];
}

function reconciliationOf(row: ImportRow): PmsShadowRevenueReconciliationJson {
  const raw = (row.reconciliationJson && typeof row.reconciliationJson === "object" && !Array.isArray(row.reconciliationJson) ? row.reconciliationJson : {}) as Partial<PmsShadowRevenueReconciliationJson>;
  return { declared: raw.declared ?? {}, check: raw.check ?? { sumTotalAmount: "0.00", delta: "0.00", ok: true } };
}

function totalsOf(row: ImportRow): PmsShadowRevenueTotals {
  return { revenue: money(row.totalRevenue), tax: money(row.totalTax), payments: money(row.totalPayments), other: money(row.totalOther) };
}

export function toRevenueImportRecord(row: ImportRow): PmsShadowRevenueImportRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    businessDate: isoDay(row.businessDate),
    source: row.source as PmsShadowRevenueSource,
    fileName: row.fileName,
    contentHash: row.contentHash,
    status: row.status as PmsShadowRevenueStatus,
    lines: linesOf(row),
    totals: totalsOf(row),
    journalEntryIds: row.journalEntryIds,
    reversalJournalEntryIds: row.reversalJournalEntryIds,
    reconciliation: reconciliationOf(row).check,
    warnings: warningsOf(row),
    replacedById: row.replacedById,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    reversedAt: row.reversedAt ? row.reversedAt.toISOString() : null,
    reversedBy: row.reversedBy,
    reversalReason: row.reversalReason
  };
}

function cleanDeclared(declared: PmsShadowRevenueDeclared | null | undefined): PmsShadowRevenueDeclared {
  const out: PmsShadowRevenueDeclared = {};
  if (!declared) return out;
  for (const key of ["transactionTotalToday", "roomRevenue", "totalRevenue"] as const) {
    const value = declared[key];
    if (value === null || value === undefined || String(value).trim() === "") continue;
    out[key] = money(dec(String(value)));
  }
  return out;
}

function auditSummary(row: ImportRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    importId: row.id,
    propertyId: row.propertyId,
    businessDate: isoDay(row.businessDate),
    status: row.status,
    source: row.source,
    fileName: row.fileName,
    contentHash: row.contentHash,
    totals: totalsOf(row),
    lines: linesOf(row).length,
    journalEntryIds: row.journalEntryIds,
    reversalJournalEntryIds: row.reversalJournalEntryIds,
    replacedById: row.replacedById,
    ...extra
  };
}

// ---------------------------------------------------------------------------
// Análisis (parseo + perfil + mapeo): compartido por preview e import
// ---------------------------------------------------------------------------

type Analysis = {
  parsed: PmsShadowRevenueParsed;
  bytes: Uint8Array;
  source: PmsShadowRevenueSource;
  contentHash: string;
  profile: ProfileRow | null;
  mapping: PmsShadowTrxCodeMapping[];
  resolved: PmsShadowRevenueLine[];
  unmapped: PmsShadowRevenueLine[];
  totals: PmsShadowRevenueTotals;
  /** Fecha del fichero o la del cuerpo; null si ninguna. */
  businessDate: IsoDate | null;
  /** Ambas fechas presentes y distintas. */
  dayMismatch: { fileDate: IsoDate; businessDate: IsoDate } | null;
  /** hotel_code del fichero ≠ operaHotelCode del perfil. */
  hotelMismatch: { fileHotelCode: string; profileHotelCode: string } | null;
  declared: PmsShadowRevenueDeclared;
  check: PmsShadowRevenueReconciliation;
  warnings: string[];
};

async function analyse(db: Db, input: { organizationId: string; propertyId: string; body: PmsShadowRevenuePreviewBody }): Promise<Analysis> {
  const { body } = input;
  if (body.businessDate !== undefined && body.businessDate !== null && !isIsoDate(body.businessDate)) {
    throw ledgerBadRequest("VALIDATION_ERROR", "businessDate debe tener formato YYYY-MM-DD.", { field: "businessDate" });
  }
  const { parsed, bytes, source } = parseRevenueFile({ fileName: body.fileName, source: body.source, content: body.content, contentBase64: body.contentBase64 });
  const contentHash = revenueContentHash(bytes);
  const profile = await loadProfile(db, input.organizationId, input.propertyId);
  const mapping = Array.isArray(body.mapping) ? body.mapping : mappingOfProfile(profile);
  const { resolved, unmapped, warnings: mappingWarnings } = resolveTrxMapping(parsed.lines, mapping);
  const warnings = [...parsed.warnings, ...mappingWarnings];
  if (!profile) warnings.push("La propiedad no tiene perfil de modo sombra: el mapeo de transaction codes debe venir en la petición.");

  const requested = body.businessDate ?? null;
  const fileDate = parsed.businessDate;
  const dayMismatch = fileDate && requested && fileDate !== requested ? { fileDate, businessDate: requested } : null;
  const businessDate = fileDate ?? requested;
  const hotelMismatch = parsed.hotelCode && profile?.operaHotelCode && parsed.hotelCode.trim().toUpperCase() !== profile.operaHotelCode.trim().toUpperCase()
    ? { fileHotelCode: parsed.hotelCode, profileHotelCode: profile.operaHotelCode }
    : null;
  const declared = cleanDeclared(body.reconciliation);
  const check = checkTrialBalance(parsed.sumTotalAmount, declared.transactionTotalToday ?? null);
  if (declared.transactionTotalToday && !check.ok) {
    warnings.push(`Σ importes del fichero (${check.sumTotalAmount}) no cuadra con el Transaction Total Today declarado (${check.transactionTotalToday}): desviación ${check.delta}.`);
  }
  return { parsed, bytes, source, contentHash, profile, mapping, resolved, unmapped, totals: sumRevenueTotals(resolved), businessDate, dayMismatch, hotelMismatch, declared, check, warnings };
}

function assertDayAndHotel(analysis: Analysis): IsoDate {
  if (analysis.hotelMismatch) {
    throw ledgerConflict("PMS_SHADOW_REVENUE_HOTEL_MISMATCH", `El código de hotel del fichero (${analysis.hotelMismatch.fileHotelCode}) no es el del perfil de esta propiedad (${analysis.hotelMismatch.profileHotelCode}).`, analysis.hotelMismatch);
  }
  if (analysis.dayMismatch) {
    throw ledgerBadRequest("PMS_SHADOW_REVENUE_DAY_MISMATCH", `El fichero corresponde al ${analysis.dayMismatch.fileDate} y la petición indica ${analysis.dayMismatch.businessDate}.`, analysis.dayMismatch);
  }
  if (!analysis.businessDate) {
    throw ledgerBadRequest("VALIDATION_ERROR", "El fichero no declara el business date: indícalo en businessDate (YYYY-MM-DD).", { field: "businessDate" });
  }
  return analysis.businessDate;
}

// ---------------------------------------------------------------------------
// Lotes vivos: duplicado por hash y día ya cubierto
// ---------------------------------------------------------------------------

async function findLiveByHash(db: Db, propertyId: string, contentHash: string, excludeId?: string): Promise<ImportRow | null> {
  return db.pmsShadowRevenueImport.findFirst({
    where: { propertyId, contentHash, status: { not: "reversed" }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    orderBy: { createdAt: "desc" }
  });
}

async function findLiveByDay(db: Db, propertyId: string, businessDate: IsoDate, excludeId?: string): Promise<ImportRow[]> {
  return db.pmsShadowRevenueImport.findMany({
    where: { propertyId, businessDate: dateOnlyUtc(businessDate), status: { not: "reversed" }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    orderBy: { createdAt: "asc" }
  });
}

function duplicateError(existing: ImportRow): never {
  throw ledgerConflict("PMS_SHADOW_REVENUE_DUPLICATE", `Este fichero de ingresos ya se importó (lote ${existing.id}, ${existing.status === "posted" ? "contabilizado" : "en borrador"}). Revierte el lote anterior o usa «sustituir» (replace).`, {
    importId: existing.id,
    status: existing.status,
    businessDate: isoDay(existing.businessDate)
  });
}

function alreadyPostedError(existing: ImportRow[]): never {
  const first = existing[0]!;
  throw ledgerConflict("PMS_SHADOW_REVENUE_ALREADY_POSTED", `Los ingresos del ${isoDay(first.businessDate)} ya tienen un lote ${first.status === "posted" ? "contabilizado" : "en borrador"} (${first.id}). Usa «sustituir» (replace: reverso + nuevo).`, {
    importId: first.id,
    status: first.status,
    importIds: existing.map((row) => row.id),
    businessDate: isoDay(first.businessDate)
  });
}

// ---------------------------------------------------------------------------
// Periodo abierto
// ---------------------------------------------------------------------------

async function periodBlocker(db: Db, organizationId: string, propertyId: string, day: IsoDate): Promise<PmsShadowBlocker | null> {
  const fiscalYear = await resolveFiscalYear(db, organizationId, propertyId, day);
  if (fiscalYear.status === "closed") {
    return { code: "FISCAL_YEAR_CLOSED", message: `El ejercicio ${fiscalYear.code} está cerrado: no admite asientos con fecha ${day}.`, details: { yearCode: fiscalYear.code, entryDate: day } };
  }
  const period = await isPostingAllowed(organizationId, propertyId, dateOnlyUtc(day));
  if (!period.allowed) {
    return { code: "FISCAL_PERIOD_CLOSED", message: `El periodo ${period.closedPeriodCode} está cerrado: no admite asientos con fecha ${day}.`, details: { periodCode: period.closedPeriodCode, entryDate: day } };
  }
  return null;
}

/**
 * El periodo (y ejercicio) del asiento ORIGINAL debe estar abierto para
 * revertirlo, aunque el reverso lleve otra `entryDate` (contable-6C-02, réplica
 * de payroll/cost-import.service.ts): la regla de lectura de los estados excluye
 * la pareja marcada entera, así que un reverso fechado en un periodo abierto
 * haría desaparecer los 705.x / 477.x del periodo cerrado.
 */
async function assertOriginalPeriodOpen(tx: Prisma.TransactionClient, entry: { id: string; organizationId: string; propertyId: string | null; entryDate: Date }): Promise<void> {
  const day = isoDay(entry.entryDate);
  const fiscalYear = await resolveFiscalYear(tx, entry.organizationId, entry.propertyId, day);
  if (fiscalYear.status === "closed") {
    throw ledgerConflict("FISCAL_YEAR_CLOSED", `El ejercicio ${fiscalYear.code} del asiento original (${day}) está cerrado: reábrelo antes de revertir el lote; un reverso fechado en otro ejercicio alteraría el ejercicio cerrado.`, { yearCode: fiscalYear.code, fiscalYearId: fiscalYear.id, entryDate: day, journalEntryId: entry.id });
  }
  const period = await isPostingAllowed(entry.organizationId, entry.propertyId ?? undefined, dateOnlyUtc(day));
  if (!period.allowed) {
    throw ledgerConflict("FISCAL_PERIOD_CLOSED", `El periodo ${period.closedPeriodCode} del asiento original (${day}) está cerrado: reábrelo antes de revertir el lote; un reverso fechado en un periodo abierto alteraría el periodo cerrado.`, { periodCode: period.closedPeriodCode, entryDate: day, journalEntryId: entry.id });
  }
}

// ---------------------------------------------------------------------------
// Centros de coste USALI, contabilización y reverso dentro de la transacción
// ---------------------------------------------------------------------------

/**
 * CostCenter { propertyId, code: USALI en mayúsculas, type "usali" }: se crea si no
 * existe (bajo el lock de la propiedad) y, si ya existe con ese (propertyId, code), se
 * REUTILIZA sin reescribir `type` ni `active` (SEC-6C-05, réplica de
 * ensureUsaliCostCentres de 6c); un tipo distinto o inactivo se avisa.
 * Devuelve departamento → id.
 */
async function ensureUsaliCostCentres(tx: Prisma.TransactionClient, propertyId: string, hotelLabel: string, lines: readonly PmsShadowRevenueLine[]): Promise<{ ids: Map<string, string>; warnings: string[] }> {
  const ids = new Map<string, string>();
  const warnings: string[] = [];
  // Tanda L2 (L2-06): the departments of the day (line order, deduplicated),
  // ONE lookup of their centres and ONE createMany for the missing ones
  // (was findUnique + create per department, inside the property lock).
  type Department = Parameters<typeof pmsShadowCostCentreCode>[0];
  const departments: Department[] = [];
  for (const line of lines) {
    if (line.kind !== "revenue" || !line.usaliDepartment) continue;
    const department = line.usaliDepartment as Department;
    if (!departments.includes(department)) departments.push(department);
  }
  if (departments.length === 0) return { ids, warnings };
  const codeOf = new Map(departments.map((department) => [department, pmsShadowCostCentreCode(department)]));
  const existingRows = await tx.costCenter.findMany({
    where: { propertyId, code: { in: Array.from(codeOf.values()) } },
    select: { id: true, code: true, type: true, active: true }
  });
  const existingByCode = new Map(existingRows.map((row) => [row.code, row]));
  const missing: Department[] = [];
  for (const department of departments) {
    const code = codeOf.get(department)!;
    const existing = existingByCode.get(code);
    if (existing) {
      if (existing.type !== PMS_SHADOW_COST_CENTRE_TYPE || !existing.active) {
        warnings.push(`centro de coste ${code} de ${hotelLabel} ya existía (tipo «${existing.type}»${existing.active ? "" : ", inactivo"}) y se reutiliza sin modificarlo: sus apuntes ${existing.type === PMS_SHADOW_COST_CENTRE_TYPE ? "" : "no "}se enrutan al departamento USALI`);
      }
      ids.set(department, existing.id);
      continue;
    }
    missing.push(department);
  }
  if (missing.length > 0) {
    const created = await tx.costCenter.createManyAndReturn({
      data: missing.map((department) => ({ propertyId, code: codeOf.get(department)!, name: pmsShadowCostCentreName(department), type: PMS_SHADOW_COST_CENTRE_TYPE, active: true })),
      select: { id: true, code: true }
    });
    const createdByCode = new Map(created.map((row) => [row.code, row.id]));
    for (const department of missing) {
      const id = createdByCode.get(codeOf.get(department)!);
      if (id) ids.set(department, id);
    }
  }
  return { ids, warnings };
}

async function postImportInTx(tx: Prisma.TransactionClient, row: ImportRow, input: { hotelLabel: string; lines: readonly PmsShadowRevenueLine[]; includePayments: boolean; createdBy: string | null }): Promise<{ row: ImportRow; journalEntryId: string; warnings: string[] }> {
  const businessDate = isoDay(row.businessDate);
  const { ids: costCentreIds, warnings: costCentreWarnings } = await ensureUsaliCostCentres(tx, row.propertyId, input.hotelLabel, input.lines);
  const entry = buildPmsShadowRevenueEntry({ propertyId: row.propertyId, hotelLabel: input.hotelLabel, businessDate, lines: input.lines, includePayments: input.includePayments, costCentreIds });
  const record = await ledger().postJournalEntry({
    organizationId: row.organizationId,
    propertyId: row.propertyId,
    entryDate: entry.entryDate,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    description: entry.description,
    reference: entry.reference,
    lines: entry.lines.map((line) => ({ accountCode: line.accountCode, debit: line.debit, credit: line.credit, description: line.description ?? undefined, costCenterId: line.costCenterId ?? null, taxRateCode: line.taxRateCode ?? null })),
    createdBy: input.createdBy,
    db: tx
  });
  if (record.created !== true) {
    throw ledgerConflict("PMS_SHADOW_REVENUE_ENTRY_EXISTS", `Ya existe un asiento de ingresos de OPERA con la clave ${entry.sourceId}: el día no se puede contabilizar dos veces.`, { sourceId: entry.sourceId, journalEntryId: record.id });
  }
  const warnings = [...costCentreWarnings, ...entry.warnings];
  const updated = await tx.pmsShadowRevenueImport.update({
    where: { id: row.id },
    data: {
      status: "posted",
      journalEntryIds: [record.id],
      postedAt: new Date(),
      linesJson: input.lines as unknown as Prisma.InputJsonValue,
      totalRevenue: entry.totals.revenue,
      totalTax: entry.totals.tax,
      totalPayments: entry.totals.payments,
      totalOther: entry.totals.other,
      warningsJson: [...warningsOf(row), ...warnings] as unknown as Prisma.InputJsonValue,
      reversedAt: null,
      reversedBy: null,
      reversalReason: null
    }
  });
  return { row: updated, journalEntryId: record.id, warnings };
}

async function reverseImportInTx(tx: Prisma.TransactionClient, row: ImportRow, input: { reason: string; entryDate?: IsoDate | null; reversedBy: string | null; hotelLabel: string; replacedById?: string | null }): Promise<{ row: ImportRow; reversalJournalEntryIds: string[] }> {
  if (row.status === "reversed") return { row, reversalJournalEntryIds: [] };
  const businessDate = isoDay(row.businessDate);
  const reversalIds: string[] = [...row.reversalJournalEntryIds];
  const created: string[] = [];
  if (row.status === "posted" && row.journalEntryIds.length > 0) {
    // Tanda L2 (L2-06): the entries of the lot in one query, filtered by the
    // organisation of the import (was one findUnique per id + a check in
    // memory); the loop keeps the order of row.journalEntryIds.
    const entries = await tx.journalEntry.findMany({
      where: { id: { in: row.journalEntryIds }, organizationId: row.organizationId },
      select: { id: true, organizationId: true, propertyId: true, entryDate: true, status: true, reversedById: true }
    });
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    for (const journalEntryId of row.journalEntryIds) {
      const entry = entryById.get(journalEntryId);
      if (!entry) continue;
      if (entry.reversedById) {
        if (!reversalIds.includes(entry.reversedById)) reversalIds.push(entry.reversedById);
        continue;
      }
      if (entry.status !== "posted") continue;
      await assertOriginalPeriodOpen(tx, entry);
      const record = await ledger().reverseJournalEntry({
        organizationId: row.organizationId,
        journalEntryId,
        entryDate: input.entryDate ?? isoDay(entry.entryDate),
        description: `Reverso ingresos OPERA · ${input.hotelLabel} · ${businessDate} — ${input.reason}`,
        reference: businessDate,
        createdBy: input.reversedBy,
        db: tx
      });
      if (!reversalIds.includes(record.id)) reversalIds.push(record.id);
      created.push(record.id);
    }
  }
  const updated = await tx.pmsShadowRevenueImport.update({
    where: { id: row.id },
    data: {
      status: "reversed",
      reversalJournalEntryIds: reversalIds,
      reversedAt: new Date(),
      reversedBy: input.reversedBy,
      reversalReason: input.reason,
      ...(input.replacedById ? { replacedById: input.replacedById } : {})
    }
  });
  return { row: updated, reversalJournalEntryIds: created };
}

/** Revierte ENTEROS los lotes vivos del mismo día (`replace: true`); un borrador pasa a `reversed` sin asientos. */
async function replaceImportsInTx(tx: Prisma.TransactionClient, previous: readonly ImportRow[], input: { newImportId: string; reversedBy: string | null; hotelLabel: string }): Promise<string[]> {
  const replaced: string[] = [];
  for (const row of previous) {
    if (row.status === "reversed") continue;
    await reverseImportInTx(tx, row, { reason: `sustituido por ${input.newImportId}`, reversedBy: input.reversedBy, hotelLabel: input.hotelLabel, replacedById: input.newImportId });
    replaced.push(row.id);
  }
  return replaced;
}

// ---------------------------------------------------------------------------
// Preview (nunca escribe)
// ---------------------------------------------------------------------------

export async function previewPmsShadowRevenue(input: { context: UserContext; propertyId: string; body: PmsShadowRevenuePreviewBody; db?: Db }): Promise<PmsShadowRevenuePreview> {
  requirePermissions(input.context, [...POST_KEYS]);
  const db = input.db ?? prisma;
  const organizationId = input.context.organizationId;
  await assertPropertyInOrg(input.propertyId, organizationId);
  const replace = input.body.replace === true;
  const force = input.body.force === true;
  const includePayments = input.body.includePayments === true;
  const analysis = await analyse(db, { organizationId, propertyId: input.propertyId, body: input.body });
  const blockers: PmsShadowBlocker[] = [];
  const warnings = [...analysis.warnings];

  if (analysis.hotelMismatch) {
    blockers.push({ code: "PMS_SHADOW_REVENUE_HOTEL_MISMATCH", message: `El código de hotel del fichero (${analysis.hotelMismatch.fileHotelCode}) no es el del perfil (${analysis.hotelMismatch.profileHotelCode}).`, details: analysis.hotelMismatch });
  }
  if (analysis.dayMismatch) {
    blockers.push({ code: "PMS_SHADOW_REVENUE_DAY_MISMATCH", message: `El fichero corresponde al ${analysis.dayMismatch.fileDate} y la petición indica ${analysis.dayMismatch.businessDate}.`, details: analysis.dayMismatch });
  }
  if (!analysis.businessDate) {
    blockers.push({ code: "VALIDATION_ERROR", message: "El fichero no declara el business date: indícalo en businessDate.", details: { field: "businessDate" } });
  }
  if (analysis.unmapped.length > 0) {
    blockers.push({
      code: "OPERA_TRX_CODE_UNMAPPED",
      message: `${analysis.unmapped.length} transaction code(s) sin mapear: complétalos en el perfil antes de contabilizar el día.`,
      details: { codes: analysis.unmapped.map((line) => ({ code: line.code, description: line.description, amount: line.amount })) }
    });
  }
  const duplicate = await findLiveByHash(db, input.propertyId, analysis.contentHash);
  if (duplicate && !force && !replace) {
    blockers.push({ code: "PMS_SHADOW_REVENUE_DUPLICATE", message: `Este fichero ya se importó (lote ${duplicate.id}, ${duplicate.status === "posted" ? "contabilizado" : "en borrador"}).`, details: { importId: duplicate.id, status: duplicate.status } });
  }
  if (analysis.businessDate) {
    const live = await findLiveByDay(db, input.propertyId, analysis.businessDate);
    if (live.length > 0) {
      if (replace) warnings.push(`replace: se revertirá${live.length > 1 ? "n" : ""} ${live.length} lote(s) del ${analysis.businessDate} (${live.map((row) => row.id).join(", ")}).`);
      else blockers.push({ code: "PMS_SHADOW_REVENUE_ALREADY_POSTED", message: `Los ingresos del ${analysis.businessDate} ya tienen un lote ${live[0]!.status === "posted" ? "contabilizado" : "en borrador"} (${live[0]!.id}).`, details: { importId: live[0]!.id, status: live[0]!.status, importIds: live.map((row) => row.id) } });
    }
    const period = await periodBlocker(db, organizationId, input.propertyId, analysis.businessDate);
    if (period) blockers.push(period);
  }
  if (analysis.unmapped.length === 0 && analysis.businessDate) {
    try {
      const costCentreIds = new Map<string, string>();
      for (const line of analysis.resolved) if (line.kind === "revenue" && line.usaliDepartment) costCentreIds.set(line.usaliDepartment, "preview");
      const entry = buildPmsShadowRevenueEntry({ propertyId: input.propertyId, hotelLabel: "preview", businessDate: analysis.businessDate, lines: analysis.resolved, includePayments, costCentreIds });
      warnings.push(...entry.warnings);
    } catch (error) {
      const details = (error as { details?: { code?: string } }).details;
      if (details?.code === "PMS_SHADOW_REVENUE_EMPTY") blockers.push({ code: "PMS_SHADOW_REVENUE_EMPTY", message: (error as Error).message });
      else throw error;
    }
  }
  return {
    source: analysis.source,
    hotelCode: analysis.parsed.hotelCode,
    businessDate: analysis.businessDate ?? "",
    lines: analysis.resolved,
    totals: analysis.totals,
    unmapped: analysis.unmapped,
    reconciliation: analysis.check,
    canPost: blockers.length === 0,
    blockers,
    warnings
  };
}

// ---------------------------------------------------------------------------
// Import (+ post)
// ---------------------------------------------------------------------------

export async function importPmsShadowRevenue(input: { context: UserContext; propertyId: string; body: PmsShadowRevenueImportBody; createdBy?: string | null; correlationId: string; shadowRunId?: string | null }): Promise<PmsShadowRevenueImportRecord> {
  requirePermissions(input.context, [...POST_KEYS]);
  const organizationId = input.context.organizationId;
  await assertPropertyInOrg(input.propertyId, organizationId);
  const post = input.body.post === true;
  const replace = input.body.replace === true;
  const force = input.body.force === true;
  const includePayments = input.body.includePayments === true;
  if (replace && !post) {
    throw ledgerBadRequest("VALIDATION_ERROR", "replace exige post: true: un lote en borrador no sustituye lotes contabilizados. Crea el borrador sin replace y contabilízalo después con replace.", { field: "replace" });
  }
  const createdBy = input.createdBy === undefined ? input.context.userId : input.createdBy;
  const property = await loadProperty(prisma, organizationId, input.propertyId);
  const hotelLabel = hotelLabelOf(property);
  const analysis = await analyse(prisma, { organizationId, propertyId: input.propertyId, body: input.body });
  const businessDate = assertDayAndHotel(analysis);
  if (post && analysis.unmapped.length > 0) {
    throw ledgerBadRequest("OPERA_TRX_CODE_UNMAPPED", `${analysis.unmapped.length} transaction code(s) sin mapear: complétalos en el perfil antes de contabilizar el día.`, {
      codes: analysis.unmapped.map((line) => ({ code: line.code, description: line.description, amount: line.amount }))
    });
  }
  const fileName = input.body.fileName?.trim() || null;

  const outcome = await prisma.$transaction(async (tx) => {
    await lockProperty(tx, input.propertyId);
    const duplicate = await findLiveByHash(tx, input.propertyId, analysis.contentHash);
    if (duplicate && !force && !replace) duplicateError(duplicate);
    const live = await findLiveByDay(tx, input.propertyId, businessDate);
    if (live.length > 0 && !replace) alreadyPostedError(live);
    const created = await tx.pmsShadowRevenueImport.create({
      data: {
        organizationId,
        propertyId: input.propertyId,
        businessDate: dateOnlyUtc(businessDate),
        source: analysis.source,
        fileName,
        contentHash: analysis.contentHash,
        status: "draft",
        linesJson: analysis.resolved as unknown as Prisma.InputJsonValue,
        totalRevenue: analysis.totals.revenue,
        totalTax: analysis.totals.tax,
        totalPayments: analysis.totals.payments,
        totalOther: analysis.totals.other,
        reconciliationJson: { declared: analysis.declared, check: analysis.check } as unknown as Prisma.InputJsonValue,
        warningsJson: analysis.warnings as unknown as Prisma.InputJsonValue,
        createdBy
      }
    });
    const replacedImportIds = replace ? await replaceImportsInTx(tx, live, { newImportId: created.id, reversedBy: createdBy, hotelLabel }) : [];
    if (replace && duplicate && !live.some((row) => row.id === duplicate.id)) {
      // Mismo fichero importado antes para OTRO día no revertido (fecha forzada distinta): se sustituye también.
      await reverseImportInTx(tx, duplicate, { reason: `sustituido por ${created.id}`, reversedBy: createdBy, hotelLabel, replacedById: created.id });
      replacedImportIds.push(duplicate.id);
    }
    let row = created;
    let warnings: string[] = [];
    if (post) {
      const posted = await postImportInTx(tx, created, { hotelLabel, lines: analysis.resolved, includePayments, createdBy });
      row = posted.row;
      warnings = posted.warnings;
    }
    if (input.shadowRunId) {
      await tx.pmsShadowRun.updateMany({ where: { id: input.shadowRunId, organizationId, propertyId: input.propertyId }, data: { revenueImportId: row.id } });
    }
    return { row, warnings, replacedImportIds };
  }, TX_OPTIONS);

  recordAuditEvent({
    organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: post ? "PMS_SHADOW_REVENUE_POSTED" : "PMS_SHADOW_REVENUE_IMPORTED",
    entityType: "pms_shadow_revenue_import",
    entityId: outcome.row.id,
    afterJson: auditSummary(outcome.row, { replacedImportIds: outcome.replacedImportIds, includePayments, shadowRunId: input.shadowRunId ?? null, warnings: outcome.warnings }),
    correlationId: input.correlationId
  });
  return toRevenueImportRecord(outcome.row);
}

// ---------------------------------------------------------------------------
// Post (borrador → contabilizado)
// ---------------------------------------------------------------------------

export async function postPmsShadowRevenue(input: { context: UserContext; propertyId: string; importId: string; correlationId: string; body?: { replace?: boolean; includePayments?: boolean; mapping?: PmsShadowTrxCodeMapping[] | null } }): Promise<PmsShadowRevenueImportRecord> {
  requirePermissions(input.context, [...POST_KEYS]);
  const organizationId = input.context.organizationId;
  await assertPropertyInOrg(input.propertyId, organizationId);
  const replace = input.body?.replace === true;
  const includePayments = input.body?.includePayments === true;
  const existing = await loadImportOrThrow(prisma, organizationId, input.propertyId, input.importId);
  if (existing.status === "posted") throw ledgerConflict("PMS_SHADOW_REVENUE_ALREADY_POSTED", "El lote ya está contabilizado.", { importId: existing.id, status: existing.status });
  if (existing.status === "reversed") throw ledgerConflict("PMS_SHADOW_REVENUE_NOT_POSTED", "El lote está revertido: importa el fichero de nuevo.", { importId: existing.id, status: existing.status });
  const property = await loadProperty(prisma, organizationId, input.propertyId);
  const hotelLabel = hotelLabelOf(property);
  const before = auditSummary(existing);

  const outcome = await prisma.$transaction(async (tx) => {
    await lockProperty(tx, input.propertyId);
    const row = await loadImportOrThrow(tx, organizationId, input.propertyId, input.importId);
    if (row.status !== "draft") throw ledgerConflict(row.status === "posted" ? "PMS_SHADOW_REVENUE_ALREADY_POSTED" : "PMS_SHADOW_REVENUE_NOT_POSTED", "El lote ya no está en borrador.", { importId: row.id, status: row.status });
    const businessDate = isoDay(row.businessDate);
    // El mapeo se vuelve a resolver con el perfil actual: un borrador con códigos sin mapear se contabiliza tras completar el perfil.
    const profile = await loadProfile(tx, organizationId, input.propertyId);
    const mapping = Array.isArray(input.body?.mapping) ? input.body.mapping : mappingOfProfile(profile);
    const stored = linesOf(row);
    const { resolved, unmapped, warnings: mappingWarnings } = resolveTrxMapping(
      stored.map((line) => ({ code: line.code, description: line.description, transactionType: line.transactionType, amount: line.amount, ...(line.ledgers ? { ledgers: line.ledgers } : {}) })),
      mapping
    );
    if (unmapped.length > 0) {
      throw ledgerBadRequest("OPERA_TRX_CODE_UNMAPPED", `${unmapped.length} transaction code(s) sin mapear: complétalos en el perfil antes de contabilizar el día.`, {
        codes: unmapped.map((line) => ({ code: line.code, description: line.description, amount: line.amount }))
      });
    }
    const duplicate = await findLiveByHash(tx, input.propertyId, row.contentHash, row.id);
    const live = await findLiveByDay(tx, input.propertyId, businessDate, row.id);
    if (!replace) {
      if (duplicate) duplicateError(duplicate);
      if (live.length > 0) alreadyPostedError(live);
    }
    const replacedImportIds = replace ? await replaceImportsInTx(tx, [...live, ...(duplicate && !live.some((r) => r.id === duplicate.id) ? [duplicate] : [])], { newImportId: row.id, reversedBy: input.context.userId, hotelLabel }) : [];
    const posted = await postImportInTx(tx, row, { hotelLabel, lines: resolved, includePayments, createdBy: input.context.userId });
    return { row: posted.row, warnings: [...mappingWarnings, ...posted.warnings], replacedImportIds };
  }, TX_OPTIONS);

  recordAuditEvent({
    organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PMS_SHADOW_REVENUE_POSTED",
    entityType: "pms_shadow_revenue_import",
    entityId: outcome.row.id,
    beforeJson: before,
    afterJson: auditSummary(outcome.row, { replacedImportIds: outcome.replacedImportIds, includePayments, warnings: outcome.warnings }),
    correlationId: input.correlationId
  });
  return toRevenueImportRecord(outcome.row);
}

// ---------------------------------------------------------------------------
// Reverse
// ---------------------------------------------------------------------------

export async function reversePmsShadowRevenue(input: { context: UserContext; propertyId: string; importId: string; reason: string; entryDate?: IsoDate | null; correlationId: string }): Promise<PmsShadowRevenueImportRecord> {
  requirePermissions(input.context, [...POST_KEYS]);
  const organizationId = input.context.organizationId;
  await assertPropertyInOrg(input.propertyId, organizationId);
  const reason = (input.reason ?? "").trim();
  if (!reason) throw ledgerBadRequest("JOURNAL_REVERSAL_REASON_REQUIRED", "Indica el motivo del reverso.", { field: "reason" });
  if (reason.length > MAX_REASON_LENGTH) throw ledgerBadRequest("VALIDATION_ERROR", `El motivo del reverso no puede superar ${MAX_REASON_LENGTH} caracteres.`, { field: "reason" });
  if (input.entryDate !== undefined && input.entryDate !== null && !isIsoDate(input.entryDate)) throw ledgerBadRequest("VALIDATION_ERROR", "entryDate debe tener formato YYYY-MM-DD.", { field: "entryDate" });
  const existing = await loadImportOrThrow(prisma, organizationId, input.propertyId, input.importId);
  if (existing.status !== "posted") {
    throw ledgerConflict("PMS_SHADOW_REVENUE_NOT_POSTED", existing.status === "reversed" ? "El lote ya está revertido." : "El lote de ingresos no está contabilizado: no hay nada que revertir.", { importId: existing.id, status: existing.status });
  }
  const property = await loadProperty(prisma, organizationId, input.propertyId);
  const hotelLabel = hotelLabelOf(property);
  const before = auditSummary(existing);

  const outcome = await prisma.$transaction(async (tx) => {
    await lockProperty(tx, input.propertyId);
    const row = await loadImportOrThrow(tx, organizationId, input.propertyId, input.importId);
    if (row.status !== "posted") throw ledgerConflict("PMS_SHADOW_REVENUE_NOT_POSTED", "El lote ya no está contabilizado.", { importId: row.id, status: row.status });
    return reverseImportInTx(tx, row, { reason, entryDate: input.entryDate ?? null, reversedBy: input.context.userId, hotelLabel });
  }, TX_OPTIONS);

  recordAuditEvent({
    organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PMS_SHADOW_REVENUE_REVERSED",
    entityType: "pms_shadow_revenue_import",
    entityId: outcome.row.id,
    beforeJson: before,
    afterJson: auditSummary(outcome.row, { reason, entryDate: input.entryDate ?? null, reversalJournalEntryIds: outcome.reversalJournalEntryIds }),
    correlationId: input.correlationId
  });
  return toRevenueImportRecord(outcome.row);
}

// ---------------------------------------------------------------------------
// Listado y detalle
// ---------------------------------------------------------------------------

const READ_KEYS = ["accounting.read", "accounting.reports.read", "accounting.journal.post"] as const;

export async function listPmsShadowRevenueImports(input: { context: UserContext; propertyId: string; status?: PmsShadowRevenueStatus | null; from?: IsoDate | null; to?: IsoDate | null; limit?: number | null }): Promise<PmsShadowRevenueImportRecord[]> {
  requireAnyPermission(input.context, [...READ_KEYS]);
  const organizationId = input.context.organizationId;
  await assertPropertyInOrg(input.propertyId, organizationId);
  if (input.status && !(PMS_SHADOW_REVENUE_STATUSES as readonly string[]).includes(input.status)) throw ledgerBadRequest("VALIDATION_ERROR", "status debe ser draft, posted o reversed.", { field: "status" });
  for (const [field, value] of [["from", input.from], ["to", input.to]] as const) {
    if (value !== undefined && value !== null && !isIsoDate(value)) throw ledgerBadRequest("VALIDATION_ERROR", `${field} debe tener formato YYYY-MM-DD.`, { field });
  }
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? DEFAULT_LIST_LIMIT) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const rows = await prisma.pmsShadowRevenueImport.findMany({
    where: {
      organizationId,
      propertyId: input.propertyId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.from || input.to ? { businessDate: { ...(input.from ? { gte: dateOnlyUtc(input.from) } : {}), ...(input.to ? { lte: dateOnlyUtc(input.to) } : {}) } } : {})
    },
    orderBy: [{ businessDate: "desc" }, { createdAt: "desc" }],
    take: limit
  });
  return rows.map(toRevenueImportRecord);
}

export async function getPmsShadowRevenueImport(input: { context: UserContext; propertyId: string; importId: string }): Promise<PmsShadowRevenueImportRecord> {
  requireAnyPermission(input.context, [...READ_KEYS]);
  const organizationId = input.context.organizationId;
  await assertPropertyInOrg(input.propertyId, organizationId);
  const row = await loadImportOrThrow(prisma, organizationId, input.propertyId, input.importId);
  return toRevenueImportRecord(row);
}

// ---------------------------------------------------------------------------
// Reconciliación del día (para el job y el panel de L3 / L4)
// ---------------------------------------------------------------------------

/**
 * Σ 705.x y Σ 477.x del asiento del lote contabilizado del día (H − D, a partir
 * de las líneas del diario, nunca de los totales guardados) y los valores
 * declarados por OPERA en `reconciliationJson`. Helper interno sin permisos: el
 * llamador ya aisló propiedad y organización; `organizationId`, si se pasa,
 * descarta lotes de otra organización.
 */
export async function reconciliationForDay(propertyId: string, businessDate: IsoDate, options: { organizationId?: string | null; db?: Db } = {}): Promise<PmsShadowRevenueDayReconciliation> {
  const db = options.db ?? prisma;
  if (!isIsoDate(businessDate)) throw ledgerBadRequest("VALIDATION_ERROR", "businessDate debe tener formato YYYY-MM-DD.", { field: "businessDate" });
  const rows = await db.pmsShadowRevenueImport.findMany({
    where: { propertyId, businessDate: dateOnlyUtc(businessDate), ...(options.organizationId ? { organizationId: options.organizationId } : {}) },
    orderBy: { createdAt: "desc" }
  });
  const posted = rows.find((row) => row.status === "posted") ?? null;
  const latest = posted ?? rows[0] ?? null;
  let revenue705 = dec(0);
  let tax477 = dec(0);
  if (posted && posted.journalEntryIds.length > 0) {
    const entries = await db.journalEntry.findMany({ where: { id: { in: posted.journalEntryIds }, organizationId: posted.organizationId, status: "posted" }, select: { id: true } });
    const entryIds = entries.map((entry) => entry.id);
    if (entryIds.length > 0) {
      const lines = await db.journalLine.findMany({ where: { journalEntryId: { in: entryIds } }, select: { accountCode: true, accountId: true, debit: true, credit: true } });
      const missing = lines.filter((line) => !line.accountCode).map((line) => line.accountId);
      const accounts = missing.length > 0 ? new Map((await db.account.findMany({ where: { id: { in: missing } }, select: { id: true, code: true } })).map((account) => [account.id, account.code])) : new Map<string, string>();
      for (const line of lines) {
        const code = line.accountCode ?? accounts.get(line.accountId) ?? "";
        const net = dec(line.credit).minus(dec(line.debit));
        if (code.startsWith("705")) revenue705 = revenue705.plus(net);
        else if (code.startsWith("477")) tax477 = tax477.plus(net);
      }
    }
  }
  const reconciliation = latest ? reconciliationOf(latest) : null;
  return {
    propertyId,
    businessDate,
    importId: latest?.id ?? null,
    status: latest ? (latest.status as PmsShadowRevenueStatus) : null,
    revenue705: money(revenue705),
    tax477: money(tax477),
    totals: posted ? totalsOf(posted) : null,
    declared: reconciliation?.declared ?? {},
    check: reconciliation?.check ?? null
  };
}

/** Para el CLI y el job: vista de un lote por id sin contexto de usuario (aislamiento por organización y propiedad). */
export async function loadPmsShadowRevenueImport(organizationId: string, propertyId: string, importId: string, db: Db = prisma): Promise<PmsShadowRevenueImportRecord | null> {
  const row = await db.pmsShadowRevenueImport.findUnique({ where: { id: importId } });
  if (!row || row.organizationId !== organizationId || row.propertyId !== propertyId) return null;
  return toRevenueImportRecord(row);
}

