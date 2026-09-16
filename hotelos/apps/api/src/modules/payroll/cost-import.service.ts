// Coste de personal importado (Tanda 6c · L1) — servicio de importación,
// contabilización, reverso, listado y detalle de lotes (`PayrollCostImport`).
//
// Un lote = un fichero agregado (centro × mes × grupo × departamento; nunca
// datos por persona) identificado por el sha256 de su contenido normalizado.
// Contabilizar = UN asiento por (centro, mes) fechado el último día del mes
// (`cost-import.posting.ts`) a través del puente `ledger()` (motor único del
// diario: numeración, periodos cerrados, idempotencia por sourceId).
//
// Orden de guardas de `createPayrollCostImport` (diseño §3.2; cada una falla
// antes de escribir nada):
//   1. permisos (`PAYROLL_WRITE_KEYS`) → 403;
//   2. parseo → 400 PAYROLL_IMPORT_INVALID { errors };
//   3. grupo → 400 PAYROLL_IMPORT_GROUP_INVALID; organizationId del JSON ≠ organización → 400 PAYROLL_IMPORT_ORGANIZATION_MISMATCH;
//   4. centros → 400 PAYROLL_IMPORT_CENTRE_UNMAPPED (la preview devuelve `unmappedCentres` con sugerencias);
//      departamentos → 400 PAYROLL_IMPORT_DEPARTMENT_UNMAPPED; no admite `labor` → 400 USALI_LINE_NOT_ADMITTED;
//   5. tenencia (Property de la organización) + ámbito R11 (`assertFinanceReadScopeMany`) → 404 opaco;
//   6. transacción propia (`maxWait 15 s`, `timeout 180 s`) bajo `pg_advisory_xact_lock('payroll_cost_import:<org>')`:
//      duplicado (mismo hash vivo) → 409 PAYROLL_IMPORT_DUPLICATE; solape (celda ya contabilizada) → 409 PAYROLL_IMPORT_OVERLAP;
//      con `replace: true` los lotes afectados se revierten ENTEROS antes de crear el nuevo — solo si TODOS sus
//      centros están en el ámbito del usuario (SEC-6C-01: 404 opaco, como el reverso directo) y solo con `post: true`
//      (contable-6C-01: `replace` + `post: false` → 400, un borrador no sustituye lotes contabilizados);
//   7. lote + líneas + referencias; 8. si `post`: CostCenter usali (se reutiliza el existente sin reescribirlo, SEC-6C-05),
//      asientos vía `ledger().postJournalEntry({ db: tx })` (`created === false` → 409 PAYROLL_IMPORT_ENTRY_EXISTS),
//      lote `posted`; 9. auditoría fuera de la transacción.
// Un periodo cerrado (409 FISCAL_PERIOD_CLOSED del motor) deshace TODO: nada queda a medias.
// Nómina real ya contabilizada en alguna celda (contable-6C-08): aviso en la preview Y en el resultado de create / post
// (`warnings`, lo que ven el cajón y el CLI con --apply); no bloquea porque el lote importado puede ser la única nómina del centro.
// Topes por lote (SEC-6C-03): ≤ PAYROLL_COST_IMPORT_MAX_MONTHS meses, ≤ _MAX_CELLS celdas, ≤ _MAX_ROWS filas
// (400 PAYROLL_IMPORT_INVALID): la transacción retiene el lock de numeración del ejercicio hasta el commit.
// Reverso (contable-6C-02): el periodo del asiento ORIGINAL debe estar abierto aunque `entryDate` sea otra fecha
// (la lectura de los estados excluye la pareja marcada entera: un reverso fechado fuera alteraría el periodo cerrado).
//
// `legalEntityId` sale de `resolveLedgerScope` (nunca de organization.taxId /
// legalName ni de property.legalName). Solo se reversan asientos cuyos ids están
// en `journalEntryIds` del lote: los asientos previos del diario no se tocan nunca.

import { prisma } from "@hotelos/database";
import { Prisma } from "@prisma/client";
import type {
  PayrollCostCentreMonthDto,
  PayrollCostDepartmentTotals,
  PayrollCostDuplicateRef,
  PayrollCostGroup,
  PayrollCostGroupTotals,
  PayrollCostImportCreateBody,
  PayrollCostImportCreateResult,
  PayrollCostImportDetail,
  PayrollCostImportEntryDto,
  PayrollCostImportListQuery,
  PayrollCostImportPostBody,
  PayrollCostImportPreview,
  PayrollCostImportPreviewBody,
  PayrollCostImportRecord,
  PayrollCostImportReverseBody,
  PayrollCostImportSource,
  PayrollCostImportStatus,
  PayrollCostLineDto,
  PayrollCostMapping,
  PayrollCostOverlapRef,
  PayrollCostPayrollPeriodRef,
  PayrollCostReferenceDto,
  PayrollCostRowDto,
  PayrollCostTotals,
  PayrollCostUsaliDepartment
} from "@hotelos/shared";
import { PAYROLL_COST_IMPORT_MAX_CELLS, PAYROLL_COST_IMPORT_MAX_MONTHS, PAYROLL_COST_IMPORT_MAX_ROWS } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { assertFinanceReadScopeMany, propertyWithinScope, resolveLedgerScope } from "../../lib/finance-scope.js";
import { NotFoundError } from "../../lib/http-error.js";
import { dateOnlyUtc, ledgerBadRequest, ledgerConflict, ledgerNotFound, loadJournalEntry, resolveFiscalYear } from "../accounting/accounting.service.js";
import { isPostingAllowed } from "../accounting/fiscal-period.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { ledger, type Db, type LedgerEntryRecord } from "../treasury/ledger-bridge.js";
import { dec, isoDay, money, round2, type Dec } from "../treasury/money.js";
import { PAYROLL_READ_KEYS, PAYROLL_WRITE_KEYS, requireAnyPermission } from "../treasury/permissions.js";
import {
  applyPayrollCostMapping,
  parsePayrollCostContent,
  payrollCostContentHash,
  type PayrollCostParseResult,
  type PayrollCostPlan,
  type PayrollCostPlanProperty,
  type PayrollCostPlanRow
} from "./cost-import.parser.js";
import {
  PAYROLL_COST_CENTRE_TYPE,
  PAYROLL_COST_SOURCE_TYPE,
  buildPayrollCostEntries,
  periodLabel,
  usaliCostCentreCode,
  usaliCostCentreName,
  type PayrollCostPostingCell
} from "./cost-import.posting.js";

export { PAYROLL_COST_SOURCE_TYPE };

const TX_OPTIONS = { maxWait: 15_000, timeout: 180_000 } as const;
const IMPORT_NOT_FOUND = "Importación de coste de personal no encontrada.";
const ORGANIZATION_NOT_FOUND = "Organización no encontrada.";
const PROPERTY_NOT_FOUND = "Propiedad no encontrada.";
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const ZERO = new Prisma.Decimal(0);

type ImportRow = NonNullable<Awaited<ReturnType<typeof prisma.payrollCostImport.findUnique>>>;
type LineRow = NonNullable<Awaited<ReturnType<typeof prisma.payrollCostLine.findFirst>>>;
type ReferenceRow = NonNullable<Awaited<ReturnType<typeof prisma.payrollCostReference.findFirst>>>;
type PropertyLite = PayrollCostPlanProperty & { tradeName: string | null };

/** Fila de coste con importes Decimal (plan en memoria o `payroll_cost_lines`). */
export type CostRowLike = {
  costGroup: string;
  usaliDepartment: string;
  gross: Dec;
  employerSs: Dec;
  totalCost: Dec;
  reportedTotalCost: Dec | null;
  headcount: Dec;
};

// ---------------------------------------------------------------------------
// Totales (puros, reutilizados por el informe)
// ---------------------------------------------------------------------------

export function sumCostTotals(rows: readonly CostRowLike[]): PayrollCostTotals {
  let gross: Dec = ZERO;
  let employerSs: Dec = ZERO;
  let totalCost: Dec = ZERO;
  let reported: Dec | null = null;
  let headcount: Dec = ZERO;
  for (const row of rows) {
    gross = gross.plus(row.gross);
    employerSs = employerSs.plus(row.employerSs);
    totalCost = totalCost.plus(row.totalCost);
    if (row.reportedTotalCost) reported = (reported ?? ZERO).plus(row.reportedTotalCost);
    headcount = headcount.plus(row.headcount);
  }
  return { lines: rows.length, gross: money(gross), employerSs: money(employerSs), totalCost: money(totalCost), reportedTotalCost: reported ? money(reported) : null, headcount: money(headcount) };
}

export function costTotalsByGroup(rows: readonly CostRowLike[]): PayrollCostGroupTotals[] {
  const groups = new Map<string, CostRowLike[]>();
  for (const row of rows) groups.set(row.costGroup, [...(groups.get(row.costGroup) ?? []), row]);
  return Array.from(groups.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([costGroup, groupRows]) => ({ costGroup: costGroup as PayrollCostGroup, ...sumCostTotals(groupRows) }));
}

export function costTotalsByDepartment(rows: readonly CostRowLike[]): PayrollCostDepartmentTotals[] {
  const departments = new Map<string, CostRowLike[]>();
  for (const row of rows) departments.set(row.usaliDepartment, [...(departments.get(row.usaliDepartment) ?? []), row]);
  return Array.from(departments.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([usaliDepartment, departmentRows]) => ({ usaliDepartment: usaliDepartment as PayrollCostUsaliDepartment, ...sumCostTotals(departmentRows) }));
}

function headcountString(value: Dec | null): string | null {
  return value === null ? null : round2(value).toFixed(2);
}

/**
 * Media mensual de empleados del lote: por mes, Σ de (empleados del informe
 * del centro, si los hay, o Σ headcount de sus filas); media de los meses con
 * dato a 2 decimales; null sin datos. Los empleados del informe priman porque
 * Σ por celda sobrecuenta a quien figura en dos grupos.
 */
export function headcountAverageOf(
  rows: ReadonlyArray<{ propertyId: string; periodCode: string; headcount: Dec }>,
  references: ReadonlyArray<{ propertyId: string; periodCode: string; employeesReported: Dec | null }>
): Dec | null {
  const reported = new Map<string, Dec>();
  for (const reference of references) {
    if (reference.employeesReported !== null) reported.set(`${reference.propertyId}|${reference.periodCode}`, reference.employeesReported);
  }
  const linesByCell = new Map<string, Dec>();
  for (const row of rows) {
    const key = `${row.propertyId}|${row.periodCode}`;
    linesByCell.set(key, (linesByCell.get(key) ?? ZERO).plus(row.headcount));
  }
  const byMonth = new Map<string, Dec>();
  for (const key of new Set([...reported.keys(), ...linesByCell.keys()])) {
    const periodCode = key.slice(key.indexOf("|") + 1);
    const value = reported.get(key) ?? linesByCell.get(key) ?? ZERO;
    byMonth.set(periodCode, (byMonth.get(periodCode) ?? ZERO).plus(value));
  }
  if (byMonth.size === 0) return null;
  let total: Dec = ZERO;
  for (const value of byMonth.values()) total = total.plus(value);
  return round2(total.div(byMonth.size));
}

// ---------------------------------------------------------------------------
// Contexto, tenencia y ámbito
// ---------------------------------------------------------------------------

function resolveOrganization(context: UserContext, requested?: string | null): { organizationId: string; scopeContext: UserContext } {
  const organizationId = requested?.trim() || context.organizationId;
  if (organizationId !== context.organizationId && !context.isPlatformAdmin) throw new NotFoundError(ORGANIZATION_NOT_FOUND);
  return { organizationId, scopeContext: organizationId === context.organizationId ? context : { ...context, organizationId } };
}

async function loadProperties(db: Db, organizationId: string): Promise<PropertyLite[]> {
  return db.property.findMany({ where: { organizationId }, select: { id: true, code: true, name: true, tradeName: true, kind: true }, orderBy: { createdAt: "asc" } });
}

function propertyIndex(properties: readonly PropertyLite[]): Map<string, PropertyLite> {
  return new Map(properties.map((property) => [property.id, property]));
}

function assertPropertiesOwned(propertyIds: readonly string[], properties: readonly PropertyLite[]): void {
  const known = new Set(properties.map((property) => property.id));
  for (const propertyId of propertyIds) {
    if (!known.has(propertyId)) throw ledgerNotFound("PROPERTY_NOT_FOUND", PROPERTY_NOT_FOUND, { propertyId });
  }
}

async function lockOrganization(tx: Prisma.TransactionClient, organizationId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payroll_cost_import:${organizationId}`}))`;
}

async function loadImportOrThrow(db: Db, organizationId: string, importId: string): Promise<ImportRow> {
  const row = await db.payrollCostImport.findUnique({ where: { id: importId } });
  if (!row || row.organizationId !== organizationId) throw ledgerNotFound("PAYROLL_IMPORT_NOT_FOUND", IMPORT_NOT_FOUND);
  return row;
}

type CellKey = { propertyId: string; periodCode: string };

async function importCells(db: Db, importIds: readonly string[]): Promise<Map<string, CellKey[]>> {
  const out = new Map<string, CellKey[]>();
  if (importIds.length === 0) return out;
  const rows = await db.payrollCostLine.findMany({
    where: { importId: { in: [...importIds] } },
    select: { importId: true, propertyId: true, periodCode: true },
    distinct: ["importId", "propertyId", "periodCode"],
    orderBy: [{ periodCode: "asc" }, { propertyId: "asc" }]
  });
  for (const row of rows) out.set(row.importId, [...(out.get(row.importId) ?? []), { propertyId: row.propertyId, periodCode: row.periodCode }]);
  return out;
}

function propertyIdsOf(cells: readonly CellKey[]): string[] {
  const out: string[] = [];
  for (const cell of cells) if (!out.includes(cell.propertyId)) out.push(cell.propertyId);
  return out;
}

// ---------------------------------------------------------------------------
// Análisis (parseo + mapeo + tenencia): compartido por preview y create
// ---------------------------------------------------------------------------

/** Nº de meses inclusivos entre dos "YYYY-MM". */
function monthSpan(from: string, to: string): number {
  const [fromYear, fromMonth] = from.split("-").map(Number) as [number, number];
  const [toYear, toMonth] = to.split("-").map(Number) as [number, number];
  return (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1;
}

/**
 * Topes de un lote (SEC-6C-03): filas, meses distintos y celdas (centro, mes) = asientos.
 * Cada tope es un issue sin línea; la preview los lista en `errors` y `create` responde
 * 400 PAYROLL_IMPORT_INVALID con ellos.
 */
export function importLimitIssues(parsed: Pick<PayrollCostParseResult, "rows">, plan: Pick<PayrollCostPlan, "rows" | "cells" | "periodFrom" | "periodTo">): PayrollCostImportPreview["errors"] {
  const issues: PayrollCostImportPreview["errors"] = [];
  const rows = Math.max(parsed.rows.length, plan.rows.length);
  if (rows > PAYROLL_COST_IMPORT_MAX_ROWS) issues.push({ line: null, message: `El fichero tiene ${rows} filas; un lote admite como máximo ${PAYROLL_COST_IMPORT_MAX_ROWS}: divídelo por meses.` });
  const months = new Set(plan.rows.map((row) => row.periodCode)).size;
  const span = plan.periodFrom && plan.periodTo ? monthSpan(plan.periodFrom, plan.periodTo) : months;
  if (Math.max(months, span) > PAYROLL_COST_IMPORT_MAX_MONTHS) issues.push({ line: null, message: `El fichero abarca ${Math.max(months, span)} meses (${plan.periodFrom} → ${plan.periodTo}); un lote admite como máximo ${PAYROLL_COST_IMPORT_MAX_MONTHS}: importa un rango por lote.` });
  if (plan.cells.length > PAYROLL_COST_IMPORT_MAX_CELLS) issues.push({ line: null, message: `El fichero genera ${plan.cells.length} asientos (centro × mes); un lote admite como máximo ${PAYROLL_COST_IMPORT_MAX_CELLS}: divídelo por meses.` });
  return issues;
}

type Analysis = {
  parsed: PayrollCostParseResult;
  plan: PayrollCostPlan;
  properties: PropertyLite[];
  contentHash: string;
  errors: PayrollCostImportPreview["errors"];
};

async function analyseContent(input: { organizationId: string; scopeContext: UserContext; body: PayrollCostImportPreviewBody; db: Db; strict: boolean }): Promise<Analysis> {
  const { body, strict } = input;
  const parsed = parsePayrollCostContent({ format: body.format, content: body.content });
  const errors = [...parsed.errors];
  if (parsed.sourceOrganizationId && parsed.sourceOrganizationId !== input.organizationId) {
    errors.push({ line: null, message: `El fichero declara la organización «${parsed.sourceOrganizationId}», distinta de la actual.` });
  }
  const properties = await loadProperties(input.db, input.organizationId);
  const plan = applyPayrollCostMapping(parsed, { mapping: body.mapping ?? null, properties });
  const limitIssues = importLimitIssues(parsed, plan);
  errors.push(...limitIssues);
  if (strict) {
    if (parsed.errors.length > 0) throw ledgerBadRequest("PAYROLL_IMPORT_INVALID", `El fichero tiene ${parsed.errors.length} línea(s) con errores.`, { errors: parsed.errors });
    if (limitIssues.length > 0) throw ledgerBadRequest("PAYROLL_IMPORT_INVALID", `El fichero supera los topes de un lote: ${limitIssues.map((issue) => issue.message).join(" ")}`, { errors: limitIssues });
    if (parsed.rows.length === 0) throw ledgerBadRequest("PAYROLL_IMPORT_EMPTY", "El fichero no contiene líneas de coste.");
    if (plan.unmappedGroups.length > 0) throw ledgerBadRequest("PAYROLL_IMPORT_GROUP_INVALID", `Grupo de coste no reconocido: ${plan.unmappedGroups.map((g) => `«${g.label}»`).join(", ")}.`, { labels: plan.unmappedGroups.map((g) => g.label) });
    if (parsed.sourceOrganizationId && parsed.sourceOrganizationId !== input.organizationId) {
      throw ledgerBadRequest("PAYROLL_IMPORT_ORGANIZATION_MISMATCH", "El fichero pertenece a otra organización.", { sourceOrganizationId: parsed.sourceOrganizationId });
    }
    if (plan.unmappedCentres.length > 0) {
      throw ledgerBadRequest("PAYROLL_IMPORT_CENTRE_UNMAPPED", `Centros del informe sin centro de trabajo del ERP: ${plan.unmappedCentres.map((c) => `«${c.label}»`).join(", ")}. Indica el mapeo (mapping.centres).`, {
        labels: plan.unmappedCentres.map((c) => c.label),
        rows: plan.unmappedCentres.reduce((acc, c) => acc + c.rows, 0),
        unmappedCentres: plan.unmappedCentres
      });
    }
    if (plan.unmappedDepartments.length > 0) {
      throw ledgerBadRequest("PAYROLL_IMPORT_DEPARTMENT_UNMAPPED", `Departamentos del informe sin departamento USALI: ${plan.unmappedDepartments.map((d) => `«${d.label}»`).join(", ")}. Indica el mapeo (mapping.departments).`, { labels: plan.unmappedDepartments.map((d) => d.label) });
    }
    if (plan.notAdmitted.length > 0) {
      const first = plan.notAdmitted[0]!;
      throw ledgerBadRequest("USALI_LINE_NOT_ADMITTED", `El departamento USALI «${first.department}» no admite la línea de personal (labor): ${first.labels.map((l) => `«${l}»`).join(", ")}.`, { department: first.department, labels: first.labels });
    }
  }
  // Tenencia (los propertyId del mapeo llegan anidados en el cuerpo: el hook global no los concede) y ámbito R11.
  assertPropertiesOwned(plan.propertyIds, properties);
  assertFinanceReadScopeMany(input.scopeContext, plan.propertyIds);
  return { parsed, plan, properties, contentHash: payrollCostContentHash(parsed), errors };
}

// ---------------------------------------------------------------------------
// Duplicado, solape y nóminas reales
// ---------------------------------------------------------------------------

function duplicateRef(row: ImportRow): PayrollCostDuplicateRef {
  return { importId: row.id, status: row.status, fileName: row.fileName, postedAt: row.postedAt ? row.postedAt.toISOString() : null, periodFrom: row.periodFrom, periodTo: row.periodTo };
}

async function findDuplicate(db: Db, organizationId: string, contentHash: string, excludeImportId?: string): Promise<ImportRow | null> {
  return db.payrollCostImport.findFirst({
    where: { organizationId, contentHash, status: { not: "reversed" }, ...(excludeImportId ? { id: { not: excludeImportId } } : {}) },
    orderBy: { createdAt: "desc" }
  });
}

async function findOverlaps(db: Db, organizationId: string, cells: readonly CellKey[], excludeImportId?: string): Promise<PayrollCostOverlapRef[]> {
  if (cells.length === 0) return [];
  const lines = await db.payrollCostLine.findMany({
    where: {
      organizationId,
      import: { status: "posted" },
      ...(excludeImportId ? { importId: { not: excludeImportId } } : {}),
      OR: cells.map((cell) => ({ propertyId: cell.propertyId, periodCode: cell.periodCode }))
    },
    select: { importId: true, propertyId: true, periodCode: true },
    distinct: ["importId", "propertyId", "periodCode"]
  });
  if (lines.length === 0) return [];
  const imports = await db.payrollCostImport.findMany({ where: { id: { in: Array.from(new Set(lines.map((l) => l.importId))) } }, select: { id: true, fileName: true, periodFrom: true, periodTo: true } });
  const byId = new Map(imports.map((row) => [row.id, row]));
  return lines
    .map((line) => {
      const row = byId.get(line.importId);
      return { importId: line.importId, fileName: row?.fileName ?? null, periodFrom: row?.periodFrom ?? line.periodCode, periodTo: row?.periodTo ?? line.periodCode, propertyId: line.propertyId, periodCode: line.periodCode };
    })
    .sort((a, b) => a.periodCode.localeCompare(b.periodCode) || a.propertyId.localeCompare(b.propertyId) || a.importId.localeCompare(b.importId));
}

async function findPayrollPeriodsPosted(db: Db, organizationId: string, cells: readonly CellKey[]): Promise<PayrollCostPayrollPeriodRef[]> {
  if (cells.length === 0) return [];
  const months = Array.from(new Set(cells.map((cell) => cell.periodCode)));
  const periods = await db.payrollPeriod.findMany({
    where: { organizationId, periodCode: { in: months }, journalEntryIds: { isEmpty: false } },
    select: { id: true, propertyId: true, periodCode: true }
  });
  const cellSet = new Set(cells.map((cell) => `${cell.propertyId}|${cell.periodCode}`));
  return periods
    .filter((period) => period.propertyId === null || cellSet.has(`${period.propertyId}|${period.periodCode}`))
    .map((period) => ({ periodId: period.id, propertyId: period.propertyId ?? null, periodCode: period.periodCode }))
    .sort((a, b) => a.periodCode.localeCompare(b.periodCode) || (a.propertyId ?? "").localeCompare(b.propertyId ?? ""));
}

/**
 * Aviso de nómina real (`PayrollPeriod` con asientos) ya contabilizada en alguna celda (centro, mes)
 * del lote (contable-6C-08): lo emite la preview y lo REPITE el resultado de create / post, porque el
 * 640/642 se devengaría dos veces si la nómina real ya está en el diario. No bloquea: el lote importado
 * puede ser la única nómina del centro; si la real es la buena, se revierte el lote (runbook §18.12).
 */
function payrollPeriodsWarning(periods: readonly PayrollCostPayrollPeriodRef[], properties: Map<string, PropertyLite>): string | null {
  if (periods.length === 0) return null;
  const cells = periods.map((period) => `${period.propertyId ? (properties.get(period.propertyId)?.code ?? period.propertyId) : "sociedad"} · ${period.periodCode}`);
  return `${periods.length} periodo(s) de nómina real ya contabilizado(s) en el mismo centro y mes (${cells.join(", ")}): revisa que el coste no se devengue dos veces; si la nómina real es la buena, revierte este lote`;
}

function replacedIdsOf(duplicate: ImportRow | null, overlaps: readonly PayrollCostOverlapRef[]): string[] {
  const out: string[] = [];
  if (duplicate) out.push(duplicate.id);
  for (const overlap of overlaps) if (!out.includes(overlap.importId)) out.push(overlap.importId);
  return out;
}

/**
 * Lotes (duplicado + solapes) con algún centro FUERA del ámbito R11 del usuario: la
 * preview y los 409 enmascaran su fichero y fecha (SEC-6C-04) y `replace` no puede
 * revertirlos (SEC-6C-01, 404 opaco como el reverso directo).
 */
async function outOfScopeImports(db: Db, scopeContext: UserContext, importIds: readonly string[]): Promise<Set<string>> {
  const hidden = new Set<string>();
  if (importIds.length === 0) return hidden;
  const cells = await importCells(db, importIds);
  for (const importId of importIds) {
    if (!propertyIdsOf(cells.get(importId) ?? []).every((propertyId) => propertyWithinScope(scopeContext, propertyId))) hidden.add(importId);
  }
  return hidden;
}

function maskDuplicateRef(ref: PayrollCostDuplicateRef, hidden: ReadonlySet<string>): PayrollCostDuplicateRef {
  return hidden.has(ref.importId) ? { ...ref, fileName: null, postedAt: null } : ref;
}

function maskOverlapRefs(refs: readonly PayrollCostOverlapRef[], hidden: ReadonlySet<string>): PayrollCostOverlapRef[] {
  return refs.map((ref) => (hidden.has(ref.importId) ? { ...ref, fileName: null } : ref));
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

function rowDto(row: PayrollCostPlanRow, employeesReported: Dec | null): PayrollCostRowDto {
  return {
    line: row.line,
    workCenterLabel: row.workCenterLabel,
    workCenterCode: row.centreCodeHint,
    periodCode: row.periodCode,
    costGroup: row.costGroup ?? row.costGroupLabel,
    departmentLabel: row.departmentLabel,
    usaliDepartment: row.usaliDepartment,
    gross: money(row.gross),
    employerSs: money(row.employerSs),
    totalCost: money(row.totalCost),
    reportedTotalCost: row.reportedTotalCost ? money(row.reportedTotalCost) : null,
    headcount: money(row.headcount),
    netSalesReported: row.netSalesReported ? money(row.netSalesReported) : null,
    roomsAvailableReported: row.roomsAvailableReported,
    employeesReported: headcountString(employeesReported)
  };
}

type CellSource = { propertyId: string; periodCode: string; workCenterLabels: string[]; rows: CostRowLike[]; employeesReported: Dec | null };

function centreMonthDto(cell: CellSource, properties: Map<string, PropertyLite>): PayrollCostCentreMonthDto {
  const property = properties.get(cell.propertyId);
  const byDepartment = costTotalsByDepartment(cell.rows);
  return {
    ...sumCostTotals(cell.rows),
    propertyId: cell.propertyId,
    propertyCode: property?.code ?? null,
    propertyName: property?.name ?? null,
    workCenterLabels: cell.workCenterLabels,
    periodCode: cell.periodCode,
    employeesReported: headcountString(cell.employeesReported),
    departments: byDepartment.map((d) => d.usaliDepartment),
    byGroup: costTotalsByGroup(cell.rows),
    byDepartment
  };
}

function planCellSources(plan: PayrollCostPlan): CellSource[] {
  const references = new Map(plan.references.map((reference) => [`${reference.propertyId}|${reference.periodCode}`, reference.employeesReported]));
  return plan.cells.map((cell) => ({
    propertyId: cell.propertyId,
    periodCode: cell.periodCode,
    workCenterLabels: cell.workCenterLabels,
    rows: cell.rows.map((row) => ({ costGroup: row.costGroup ?? row.costGroupLabel, usaliDepartment: row.usaliDepartment ?? "", gross: row.gross, employerSs: row.employerSs, totalCost: row.totalCost, reportedTotalCost: row.reportedTotalCost, headcount: row.headcount })),
    employeesReported: references.get(`${cell.propertyId}|${cell.periodCode}`) ?? null
  }));
}

function lineCellSources(lines: readonly LineRow[], references: readonly ReferenceRow[]): CellSource[] {
  const referenceMap = new Map(references.map((reference) => [`${reference.propertyId}|${reference.periodCode}`, reference.employeesReported ? dec(reference.employeesReported) : null]));
  const cells = new Map<string, CellSource>();
  for (const line of lines) {
    const key = `${line.propertyId}|${line.periodCode}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { propertyId: line.propertyId, periodCode: line.periodCode, workCenterLabels: [], rows: [], employeesReported: referenceMap.get(key) ?? null };
      cells.set(key, cell);
    }
    if (!cell.workCenterLabels.includes(line.workCenterLabel)) cell.workCenterLabels.push(line.workCenterLabel);
    cell.rows.push(lineAsCostRow(line));
  }
  return Array.from(cells.values()).sort((a, b) => a.periodCode.localeCompare(b.periodCode) || a.propertyId.localeCompare(b.propertyId));
}

function lineAsCostRow(line: LineRow): CostRowLike {
  return { costGroup: line.costGroup, usaliDepartment: line.usaliDepartment, gross: dec(line.gross), employerSs: dec(line.employerSs), totalCost: dec(line.totalCost), reportedTotalCost: line.reportedTotalCost ? dec(line.reportedTotalCost) : null, headcount: dec(line.headcount) };
}

function mappingOf(row: ImportRow): PayrollCostMapping {
  const raw = row.mappingJson;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const record = (key: string): Record<string, string> | undefined => {
    const inner = value[key];
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(inner as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return out;
  };
  return { centres: record("centres") ?? {}, departments: (record("departments") ?? {}) as PayrollCostMapping["departments"], groups: (record("groups") ?? {}) as PayrollCostMapping["groups"] };
}

function sourceOf(value: string): PayrollCostImportSource {
  return value === "csv" || value === "json" || value === "informe_rrhh" ? value : "json";
}

function toImportRecord(row: ImportRow, cells: readonly CellKey[]): PayrollCostImportRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    legalEntityId: row.legalEntityId ?? null,
    source: sourceOf(row.source),
    fileName: row.fileName ?? null,
    contentHash: row.contentHash,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    status: row.status as PayrollCostImportStatus,
    rowCount: row.rowCount,
    totalGross: money(row.totalGross),
    totalEmployerSs: money(row.totalEmployerSs),
    totalCost: money(row.totalCost),
    reportedTotalCost: row.reportedTotalCost ? money(row.reportedTotalCost) : null,
    headcountAverage: row.headcountAverage ? headcountString(dec(row.headcountAverage)) : null,
    mapping: mappingOf(row),
    propertyIds: propertyIdsOf(cells),
    centreMonths: cells.length,
    journalEntryIds: [...row.journalEntryIds],
    reversalJournalEntryIds: [...row.reversalJournalEntryIds],
    notes: row.notes ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    reversedAt: row.reversedAt ? row.reversedAt.toISOString() : null,
    reversedBy: row.reversedBy ?? null,
    reversalReason: row.reversalReason ?? null
  };
}

function periodCodeOfEntry(reference: string | null, entryDate: string): string {
  return reference && /^\d{4}-\d{2}$/.test(reference) ? reference : entryDate.slice(0, 7);
}

function entryDtoFromRecord(record: LedgerEntryRecord, kind: PayrollCostImportEntryDto["kind"], properties: Map<string, PropertyLite>): PayrollCostImportEntryDto {
  let totalDebit: Dec = ZERO;
  for (const line of record.lines) totalDebit = totalDebit.plus(dec(line.debit));
  return {
    id: record.id,
    kind,
    propertyId: record.propertyId ?? "",
    propertyCode: record.propertyId ? (properties.get(record.propertyId)?.code ?? null) : null,
    periodCode: periodCodeOfEntry(record.reference, record.entryDate),
    entryDate: record.entryDate,
    entryNumber: record.entryNumber,
    fiscalYearCode: record.fiscalYearCode,
    status: record.status as PayrollCostImportEntryDto["status"],
    sourceId: record.sourceId ?? "",
    description: record.description,
    totalDebit: money(totalDebit),
    created: record.created,
    reversalOfId: record.reversalOfId,
    reversedById: record.reversedById
  };
}

async function entryDtosByIds(db: Db, ids: readonly string[], kind: PayrollCostImportEntryDto["kind"], properties: Map<string, PropertyLite>): Promise<PayrollCostImportEntryDto[]> {
  const out: PayrollCostImportEntryDto[] = [];
  for (const id of ids) {
    const view = await loadJournalEntry(db, id);
    if (!view) continue;
    out.push({
      id: view.id,
      kind,
      propertyId: view.propertyId ?? "",
      propertyCode: view.propertyId ? (properties.get(view.propertyId)?.code ?? null) : null,
      periodCode: periodCodeOfEntry(view.reference, view.entryDate),
      entryDate: view.entryDate,
      entryNumber: view.entryNumber,
      fiscalYearCode: view.fiscalYearCode,
      status: view.status,
      sourceId: view.sourceId ?? "",
      description: view.description,
      totalDebit: view.totalDebit,
      created: true,
      reversalOfId: view.reversalOfId,
      reversedById: view.reversedById
    });
  }
  return out;
}

function lineDto(line: LineRow, properties: Map<string, PropertyLite>, costCentreCodes: Map<string, string>): PayrollCostLineDto {
  return {
    id: line.id,
    importId: line.importId,
    organizationId: line.organizationId,
    propertyId: line.propertyId,
    propertyCode: properties.get(line.propertyId)?.code ?? null,
    workCenterLabel: line.workCenterLabel,
    costGroup: line.costGroup as PayrollCostGroup,
    departmentLabel: line.departmentLabel,
    usaliDepartment: line.usaliDepartment as PayrollCostUsaliDepartment,
    costCenterId: line.costCenterId ?? null,
    costCenterCode: line.costCenterId ? (costCentreCodes.get(line.costCenterId) ?? null) : null,
    periodCode: line.periodCode,
    gross: money(line.gross),
    employerSs: money(line.employerSs),
    totalCost: money(line.totalCost),
    reportedTotalCost: line.reportedTotalCost ? money(line.reportedTotalCost) : null,
    headcount: money(line.headcount)
  };
}

function referenceDto(reference: ReferenceRow, properties: Map<string, PropertyLite>): PayrollCostReferenceDto {
  return {
    id: reference.id,
    importId: reference.importId,
    organizationId: reference.organizationId,
    propertyId: reference.propertyId,
    propertyCode: properties.get(reference.propertyId)?.code ?? null,
    workCenterLabel: reference.workCenterLabel ?? null,
    periodCode: reference.periodCode,
    employeesReported: reference.employeesReported ? headcountString(dec(reference.employeesReported)) : null,
    roomsAvailableReported: reference.roomsAvailableReported ?? null,
    netSalesReported: reference.netSalesReported ? money(reference.netSalesReported) : null
  };
}

// ---------------------------------------------------------------------------
// Contabilización y reverso dentro de la transacción
// ---------------------------------------------------------------------------

/**
 * CostCenter { propertyId, code: USALI en mayúsculas, type "usali" }: se crea si no existe
 * (bajo el lock de la organización) y, si ya existe con ese (propertyId, code), se REUTILIZA
 * sin reescribir `type` ni `active` (SEC-6C-05: cambiarlos alteraría el enrutado USALI de
 * sus apuntes históricos); un tipo distinto o inactivo se avisa. Devuelve
 * `<propertyId>|<department>` → id y los avisos.
 */
async function ensureUsaliCostCentres(tx: Prisma.TransactionClient, pairs: ReadonlyArray<{ propertyId: string; usaliDepartment: PayrollCostUsaliDepartment }>, properties: Map<string, PropertyLite>): Promise<{ ids: Map<string, string>; warnings: string[] }> {
  const ids = new Map<string, string>();
  const warnings: string[] = [];
  for (const pair of pairs) {
    const key = `${pair.propertyId}|${pair.usaliDepartment}`;
    if (ids.has(key)) continue;
    const code = usaliCostCentreCode(pair.usaliDepartment);
    const existing = await tx.costCenter.findUnique({ where: { propertyId_code: { propertyId: pair.propertyId, code } }, select: { id: true, type: true, active: true } });
    if (existing) {
      if (existing.type !== PAYROLL_COST_CENTRE_TYPE || !existing.active) {
        const centre = properties.get(pair.propertyId)?.code ?? pair.propertyId;
        warnings.push(`centro de coste ${code} de ${centre} ya existía (tipo «${existing.type}»${existing.active ? "" : ", inactivo"}) y se reutiliza sin modificarlo: sus apuntes ${existing.type === PAYROLL_COST_CENTRE_TYPE ? "" : "no "}se enrutan al departamento USALI`);
      }
      ids.set(key, existing.id);
      continue;
    }
    const created = await tx.costCenter.create({ data: { propertyId: pair.propertyId, code, name: usaliCostCentreName(pair.usaliDepartment), type: PAYROLL_COST_CENTRE_TYPE, active: true }, select: { id: true } });
    ids.set(key, created.id);
  }
  return { ids, warnings };
}

type PostOutcome = { row: ImportRow; entries: PayrollCostImportEntryDto[]; warnings: string[] };

async function postImportInTx(tx: Prisma.TransactionClient, importRow: ImportRow, input: { createdBy: string | null; properties: Map<string, PropertyLite> }): Promise<PostOutcome> {
  const lines = await tx.payrollCostLine.findMany({ where: { importId: importRow.id }, orderBy: [{ periodCode: "asc" }, { propertyId: "asc" }, { usaliDepartment: "asc" }] });
  const references = await tx.payrollCostReference.findMany({ where: { importId: importRow.id } });
  const pairs = lines.map((line) => ({ propertyId: line.propertyId, usaliDepartment: line.usaliDepartment as PayrollCostUsaliDepartment }));
  const { ids: costCentres, warnings: costCentreWarnings } = await ensureUsaliCostCentres(tx, pairs, input.properties);

  const cellMap = new Map<string, PayrollCostPostingCell>();
  for (const line of lines) {
    const key = `${line.propertyId}|${line.periodCode}`;
    let cell = cellMap.get(key);
    if (!cell) {
      const property = input.properties.get(line.propertyId);
      cell = { propertyId: line.propertyId, propertyCode: property?.code ?? null, propertyName: property?.name ?? null, periodCode: line.periodCode, departments: [] };
      cellMap.set(key, cell);
    }
    const department = line.usaliDepartment as PayrollCostUsaliDepartment;
    let bucket = cell.departments.find((d) => d.usaliDepartment === department);
    if (!bucket) {
      bucket = { usaliDepartment: department, costCenterId: costCentres.get(`${line.propertyId}|${department}`)!, gross: ZERO, employerSs: ZERO };
      cell.departments.push(bucket);
    }
    bucket.gross = dec(bucket.gross).plus(dec(line.gross));
    bucket.employerSs = dec(bucket.employerSs).plus(dec(line.employerSs));
  }
  const { entries, warnings: entryWarnings } = buildPayrollCostEntries({ importId: importRow.id, cells: Array.from(cellMap.values()) });
  const warnings = [...costCentreWarnings, ...entryWarnings];

  const journalEntryIds: string[] = [];
  const entryDtos: PayrollCostImportEntryDto[] = [];
  for (const entry of entries) {
    const record = await ledger().postJournalEntry({
      organizationId: importRow.organizationId,
      propertyId: entry.propertyId,
      entryDate: entry.entryDate,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      description: entry.description,
      reference: entry.reference,
      lines: entry.lines.map((line) => ({ accountCode: line.accountCode, debit: line.debit, credit: line.credit, description: line.description ?? undefined, costCenterId: line.costCenterId ?? null })),
      createdBy: input.createdBy,
      db: tx
    });
    if (record.created !== true) {
      throw ledgerConflict("PAYROLL_IMPORT_ENTRY_EXISTS", `Ya existe un asiento con la clave ${entry.sourceId}: el lote no se puede contabilizar dos veces.`, { sourceId: entry.sourceId, journalEntryId: record.id });
    }
    journalEntryIds.push(record.id);
    entryDtos.push(entryDtoFromRecord(record, "entry", input.properties));
  }

  // Un updateMany por pareja (centro, departamento) distinta, no por línea (SEC-6C-06: 21 frente a 363 en Faranda).
  for (const [key, costCenterId] of costCentres) {
    const [propertyId, usaliDepartment] = key.split("|") as [string, string];
    await tx.payrollCostLine.updateMany({ where: { importId: importRow.id, propertyId, usaliDepartment }, data: { costCenterId } });
  }
  const headcountAverage = headcountAverageOf(
    lines.map((line) => ({ propertyId: line.propertyId, periodCode: line.periodCode, headcount: dec(line.headcount) })),
    references.map((reference) => ({ propertyId: reference.propertyId, periodCode: reference.periodCode, employeesReported: reference.employeesReported ? dec(reference.employeesReported) : null }))
  );
  const row = await tx.payrollCostImport.update({
    where: { id: importRow.id },
    data: { status: "posted", journalEntryIds, postedAt: new Date(), headcountAverage, reversedAt: null, reversedBy: null, reversalReason: null }
  });
  return { row, entries: entryDtos, warnings };
}

/**
 * El periodo (y ejercicio) del asiento ORIGINAL debe estar abierto para revertirlo,
 * aunque el reverso lleve otra `entryDate` (contable-6C-02): el motor solo valida la
 * fecha del reverso y marca el original `reversed`, y la regla de lectura de los
 * estados excluye la pareja marcada entera, así que un reverso fechado en un periodo
 * abierto haría desaparecer el 640/642 del periodo cerrado sin que el abierto reciba
 * el abono. Mes cerrado a posteriori → reabrirlo antes de revertir.
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

async function reverseImportInTx(tx: Prisma.TransactionClient, importRow: ImportRow, input: { reason: string; entryDate?: string | null; reversedBy: string | null; properties: Map<string, PropertyLite> }): Promise<{ row: ImportRow; reversals: PayrollCostImportEntryDto[] }> {
  if (importRow.status === "reversed") return { row: importRow, reversals: [] };
  const reversalIds: string[] = [...importRow.reversalJournalEntryIds];
  const reversals: PayrollCostImportEntryDto[] = [];
  if (importRow.status === "posted") {
    for (const journalEntryId of importRow.journalEntryIds) {
      const entry = await tx.journalEntry.findUnique({ where: { id: journalEntryId }, select: { id: true, organizationId: true, propertyId: true, entryDate: true, reference: true, status: true, reversedById: true } });
      if (!entry || entry.organizationId !== importRow.organizationId) continue;
      if (entry.reversedById) {
        if (!reversalIds.includes(entry.reversedById)) reversalIds.push(entry.reversedById);
        continue;
      }
      if (entry.status !== "posted") continue;
      await assertOriginalPeriodOpen(tx, entry);
      const periodCode = periodCodeOfEntry(entry.reference, isoDay(entry.entryDate));
      const property = entry.propertyId ? input.properties.get(entry.propertyId) : undefined;
      const centre = property?.code || property?.name || entry.propertyId || "sociedad";
      const record = await ledger().reverseJournalEntry({
        organizationId: importRow.organizationId,
        journalEntryId,
        entryDate: input.entryDate ?? isoDay(entry.entryDate),
        description: `Reverso coste de personal ${periodLabel(periodCode)} · ${centre} — ${input.reason}`,
        reference: periodCode,
        createdBy: input.reversedBy,
        db: tx
      });
      if (!reversalIds.includes(record.id)) reversalIds.push(record.id);
      reversals.push(entryDtoFromRecord(record, "reversal", input.properties));
    }
  }
  const row = await tx.payrollCostImport.update({
    where: { id: importRow.id },
    data: { status: "reversed", reversalJournalEntryIds: reversalIds, reversedAt: new Date(), reversedBy: input.reversedBy, reversalReason: input.reason }
  });
  return { row, reversals };
}

/**
 * Revierte ENTEROS los lotes afectados por `replace: true` (duplicado + solapes); un
 * borrador pasa a `reversed` sin asientos. Cada lote exige que TODOS sus centros estén
 * en el ámbito R11 del usuario (SEC-6C-01: el mismo 404 opaco que el reverso directo;
 * un CSV de un solo centro no puede revertir un lote que también cubre otros).
 */
async function replaceImportsInTx(tx: Prisma.TransactionClient, organizationId: string, importIds: readonly string[], input: { newImportId: string; reversedBy: string | null; properties: Map<string, PropertyLite>; scopeContext: UserContext }): Promise<string[]> {
  const replaced: string[] = [];
  const cells = await importCells(tx, importIds);
  for (const importId of importIds) {
    const row = await tx.payrollCostImport.findUnique({ where: { id: importId } });
    if (!row || row.organizationId !== organizationId || row.status === "reversed") continue;
    assertFinanceReadScopeMany(input.scopeContext, propertyIdsOf(cells.get(importId) ?? []));
    await reverseImportInTx(tx, row, { reason: `sustituido por ${input.newImportId}`, reversedBy: input.reversedBy, properties: input.properties });
    replaced.push(importId);
  }
  return replaced;
}

function auditSummary(row: ImportRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    importId: row.id,
    status: row.status,
    contentHash: row.contentHash,
    fileName: row.fileName,
    source: row.source,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    rowCount: row.rowCount,
    totalGross: money(row.totalGross),
    totalEmployerSs: money(row.totalEmployerSs),
    totalCost: money(row.totalCost),
    reportedTotalCost: row.reportedTotalCost ? money(row.reportedTotalCost) : null,
    journalEntryIds: row.journalEntryIds,
    reversalJournalEntryIds: row.reversalJournalEntryIds,
    mapping: mappingOf(row),
    ...extra
  };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export async function previewPayrollCostImport(input: { context: UserContext; body: PayrollCostImportPreviewBody; db?: Db }): Promise<PayrollCostImportPreview> {
  requireAnyPermission(input.context, PAYROLL_WRITE_KEYS);
  const db = input.db ?? prisma;
  const { organizationId, scopeContext } = resolveOrganization(input.context, input.body.organizationId);
  const replace = input.body.replace === true;
  const { parsed, plan, properties, contentHash, errors } = await analyseContent({ organizationId, scopeContext, body: input.body, db, strict: false });
  const propertyMap = propertyIndex(properties);
  const cells = plan.cells.map((cell) => ({ propertyId: cell.propertyId, periodCode: cell.periodCode }));
  const duplicate = parsed.rows.length > 0 ? await findDuplicate(db, organizationId, contentHash) : null;
  const overlaps = await findOverlaps(db, organizationId, cells);
  const payrollPeriodsPosted = await findPayrollPeriodsPosted(db, organizationId, cells);
  const references = new Map(plan.references.map((reference) => [`${reference.propertyId}|${reference.periodCode}`, reference.employeesReported]));
  const rows = plan.rows.map((row) => rowDto(row, row.propertyId ? (references.get(`${row.propertyId}|${row.periodCode}`) ?? null) : null));
  const costRows: CostRowLike[] = plan.rows.map((row) => ({ costGroup: row.costGroup ?? row.costGroupLabel, usaliDepartment: row.usaliDepartment ?? "", gross: row.gross, employerSs: row.employerSs, totalCost: row.totalCost, reportedTotalCost: row.reportedTotalCost, headcount: row.headcount }));
  const mappedRows = plan.rows.filter((row) => row.propertyId);
  const headcountAverage = headcountAverageOf(
    mappedRows.map((row) => ({ propertyId: row.propertyId!, periodCode: row.periodCode, headcount: row.headcount })),
    plan.references
  );
  const warnings = [...parsed.warnings, ...plan.warnings];
  const periodsWarning = payrollPeriodsWarning(payrollPeriodsPosted, propertyMap);
  if (periodsWarning) warnings.push(periodsWarning);
  const replacedImportIds = replacedIdsOf(duplicate, overlaps);
  const hidden = await outOfScopeImports(db, scopeContext, replacedImportIds);
  if (replace && hidden.size > 0) warnings.push(`${hidden.size} lote(s) ya contabilizado(s) incluyen centros fuera de tu ámbito y no se pueden sustituir desde este contexto`);
  const canPost = errors.length === 0 && plan.complete && parsed.rows.length > 0 && (replace ? hidden.size === 0 : !duplicate && overlaps.length === 0);
  return {
    organizationId,
    format: input.body.format,
    contentHash,
    periodFrom: plan.periodFrom,
    periodTo: plan.periodTo,
    rowCount: plan.rows.length,
    rows,
    totals: { ...sumCostTotals(costRows), headcountAverage: headcountString(headcountAverage) },
    byCentreMonth: planCellSources(plan).map((cell) => centreMonthDto(cell, propertyMap)),
    byGroup: costTotalsByGroup(costRows),
    byDepartment: costTotalsByDepartment(costRows.filter((row) => row.usaliDepartment !== "")),
    mapping: plan.mapping,
    unmappedCentres: plan.unmappedCentres,
    unmappedDepartments: plan.unmappedDepartments,
    unmappedGroups: plan.unmappedGroups,
    duplicateOf: duplicate ? maskDuplicateRef(duplicateRef(duplicate), hidden) : null,
    overlaps: maskOverlapRefs(overlaps, hidden),
    payrollPeriodsPosted,
    replacedImportIds: replace ? replacedImportIds : [],
    errors,
    warnings,
    replace,
    canPost
  };
}

// ---------------------------------------------------------------------------
// Create (+ post)
// ---------------------------------------------------------------------------

export async function createPayrollCostImport(input: { context: UserContext; body: PayrollCostImportCreateBody; createdBy?: string | null; correlationId?: string }): Promise<PayrollCostImportCreateResult> {
  requireAnyPermission(input.context, PAYROLL_WRITE_KEYS);
  const { organizationId, scopeContext } = resolveOrganization(input.context, input.body.organizationId);
  const post = input.body.post !== false;
  const replace = input.body.replace === true;
  // contable-6C-01: con `post: false` el reemplazo dejaría el diario sin el coste (lotes anteriores revertidos, nuevo en borrador).
  if (replace && !post) throw ledgerBadRequest("VALIDATION_ERROR", "replace exige post: true: un lote en borrador no sustituye lotes contabilizados. Crea el borrador sin replace y contabilízalo con POST /payroll/cost-imports/:id/post { replace: true }.", { field: "replace" });
  const createdBy = input.createdBy === undefined ? input.context.userId : input.createdBy;
  const { parsed, plan, properties, contentHash } = await analyseContent({ organizationId, scopeContext, body: input.body, db: prisma, strict: true });
  if (plan.cells.length === 0) throw ledgerBadRequest("PAYROLL_IMPORT_EMPTY", "El fichero no contiene celdas (centro, mes) contabilizables.");
  const propertyMap = propertyIndex(properties);
  const source: PayrollCostImportSource = input.body.source ?? parsed.source;
  const costRows: CostRowLike[] = plan.rows.map((row) => ({ costGroup: row.costGroup!, usaliDepartment: row.usaliDepartment!, gross: row.gross, employerSs: row.employerSs, totalCost: row.totalCost, reportedTotalCost: row.reportedTotalCost, headcount: row.headcount }));
  const totals = sumCostTotals(costRows);
  const headcountAverage = headcountAverageOf(plan.rows.map((row) => ({ propertyId: row.propertyId!, periodCode: row.periodCode, headcount: row.headcount })), plan.references);
  const cellKeys = plan.cells.map((cell) => ({ propertyId: cell.propertyId, periodCode: cell.periodCode }));

  const outcome = await prisma.$transaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const scope = await resolveLedgerScope(scopeContext, {}, tx);
    const duplicate = await findDuplicate(tx, organizationId, contentHash);
    const overlaps = await findOverlaps(tx, organizationId, cellKeys);
    const payrollPeriodsPosted = await findPayrollPeriodsPosted(tx, organizationId, cellKeys);
    if (!replace) {
      const hidden = await outOfScopeImports(tx, scopeContext, replacedIdsOf(duplicate, overlaps));
      if (duplicate) {
        throw ledgerConflict("PAYROLL_IMPORT_DUPLICATE", `Este fichero ya se importó (lote ${duplicate.id}, ${duplicate.status === "posted" ? "contabilizado" : "en borrador"}). Usa replace para sustituirlo.`, maskDuplicateRef(duplicateRef(duplicate), hidden) as unknown as Record<string, unknown>);
      }
      if (overlaps.length > 0) {
        throw ledgerConflict("PAYROLL_IMPORT_OVERLAP", `${overlaps.length} celda(s) centro × mes ya están contabilizadas por otro lote. Usa replace para sustituir los lotes afectados enteros.`, { overlaps: maskOverlapRefs(overlaps, hidden) });
      }
    }
    const created = await tx.payrollCostImport.create({
      data: {
        organizationId,
        legalEntityId: scope.legalEntityId,
        source,
        fileName: input.body.fileName?.trim() || null,
        contentHash,
        periodFrom: plan.periodFrom!,
        periodTo: plan.periodTo!,
        status: "draft",
        rowCount: plan.rows.length,
        totalGross: totals.gross,
        totalEmployerSs: totals.employerSs,
        totalCost: totals.totalCost,
        reportedTotalCost: totals.reportedTotalCost,
        headcountAverage,
        mappingJson: plan.mapping as Prisma.InputJsonValue,
        notes: input.body.notes?.trim() || null,
        createdBy
      }
    });
    await tx.payrollCostLine.createMany({
      data: plan.rows.map((row) => ({
        importId: created.id,
        organizationId,
        propertyId: row.propertyId!,
        workCenterLabel: row.workCenterLabel,
        costGroup: row.costGroup!,
        departmentLabel: row.departmentLabel,
        usaliDepartment: row.usaliDepartment!,
        periodCode: row.periodCode,
        gross: row.gross,
        employerSs: row.employerSs,
        totalCost: row.totalCost,
        reportedTotalCost: row.reportedTotalCost,
        headcount: row.headcount
      }))
    });
    if (plan.references.length > 0) {
      await tx.payrollCostReference.createMany({
        data: plan.references.map((reference) => ({
          importId: created.id,
          organizationId,
          propertyId: reference.propertyId,
          workCenterLabel: reference.workCenterLabel,
          periodCode: reference.periodCode,
          employeesReported: reference.employeesReported,
          roomsAvailableReported: reference.roomsAvailableReported,
          netSalesReported: reference.netSalesReported
        }))
      });
    }
    const replacedImportIds = replace ? await replaceImportsInTx(tx, organizationId, replacedIdsOf(duplicate, overlaps), { newImportId: created.id, reversedBy: createdBy, properties: propertyMap, scopeContext }) : [];
    let row = created;
    let entries: PayrollCostImportEntryDto[] = [];
    let warnings: string[] = [];
    if (post) {
      const posted = await postImportInTx(tx, created, { createdBy, properties: propertyMap });
      row = posted.row;
      entries = posted.entries;
      warnings = [...posted.warnings];
    }
    const periodsWarning = payrollPeriodsWarning(payrollPeriodsPosted, propertyMap);
    if (periodsWarning) warnings.push(periodsWarning);
    return { row, entries, warnings, replacedImportIds };
  }, TX_OPTIONS);

  const record = toImportRecord(outcome.row, cellKeys);
  recordAuditEvent({
    organizationId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: post ? "PAYROLL_COST_IMPORT_POSTED" : "PAYROLL_COST_IMPORTED",
    entityType: "payroll_cost_import",
    entityId: outcome.row.id,
    afterJson: auditSummary(outcome.row, { replacedImportIds: outcome.replacedImportIds, entries: outcome.entries.map((entry) => ({ id: entry.id, entryNumber: entry.entryNumber, fiscalYearCode: entry.fiscalYearCode, sourceId: entry.sourceId, totalDebit: entry.totalDebit })) }),
    correlationId: input.correlationId
  });
  return { ...record, entries: outcome.entries, replacedImportIds: outcome.replacedImportIds, warnings: [...parsed.warnings, ...plan.warnings, ...outcome.warnings] };
}

// ---------------------------------------------------------------------------
// Post (borrador → contabilizado)
// ---------------------------------------------------------------------------

export async function postPayrollCostImport(input: { context: UserContext; importId: string; body?: PayrollCostImportPostBody; correlationId?: string }): Promise<PayrollCostImportCreateResult> {
  requireAnyPermission(input.context, PAYROLL_WRITE_KEYS);
  const organizationId = input.context.organizationId;
  const replace = input.body?.replace === true;
  const existing = await loadImportOrThrow(prisma, organizationId, input.importId);
  const cells = (await importCells(prisma, [existing.id])).get(existing.id) ?? [];
  assertFinanceReadScopeMany(input.context, propertyIdsOf(cells));
  if (existing.status === "posted") throw ledgerConflict("PAYROLL_IMPORT_ALREADY_POSTED", "El lote ya está contabilizado.", { importId: existing.id });
  if (existing.status === "reversed") throw ledgerConflict("PAYROLL_IMPORT_REVERSED", "El lote está revertido: importa el fichero de nuevo.", { importId: existing.id });
  const properties = propertyIndex(await loadProperties(prisma, organizationId));
  assertPropertiesOwned(propertyIdsOf(cells), Array.from(properties.values()));

  const before = auditSummary(existing);
  const outcome = await prisma.$transaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const row = await loadImportOrThrow(tx, organizationId, input.importId);
    if (row.status !== "draft") throw ledgerConflict(row.status === "posted" ? "PAYROLL_IMPORT_ALREADY_POSTED" : "PAYROLL_IMPORT_REVERSED", "El lote ya no está en borrador.", { importId: row.id, status: row.status });
    const duplicate = await findDuplicate(tx, organizationId, row.contentHash, row.id);
    const overlaps = await findOverlaps(tx, organizationId, cells, row.id);
    const payrollPeriodsPosted = await findPayrollPeriodsPosted(tx, organizationId, cells);
    if (!replace) {
      const hidden = await outOfScopeImports(tx, input.context, replacedIdsOf(duplicate, overlaps));
      if (duplicate) throw ledgerConflict("PAYROLL_IMPORT_DUPLICATE", `Este contenido ya está importado en el lote ${duplicate.id}. Usa replace para sustituirlo.`, maskDuplicateRef(duplicateRef(duplicate), hidden) as unknown as Record<string, unknown>);
      if (overlaps.length > 0) throw ledgerConflict("PAYROLL_IMPORT_OVERLAP", `${overlaps.length} celda(s) centro × mes ya están contabilizadas por otro lote. Usa replace para sustituir los lotes afectados enteros.`, { overlaps: maskOverlapRefs(overlaps, hidden) });
    }
    const replacedImportIds = replace ? await replaceImportsInTx(tx, organizationId, replacedIdsOf(duplicate, overlaps), { newImportId: row.id, reversedBy: input.context.userId, properties, scopeContext: input.context }) : [];
    const posted = await postImportInTx(tx, row, { createdBy: input.context.userId, properties });
    const periodsWarning = payrollPeriodsWarning(payrollPeriodsPosted, properties);
    return { ...posted, warnings: periodsWarning ? [...posted.warnings, periodsWarning] : posted.warnings, replacedImportIds };
  }, TX_OPTIONS);

  recordAuditEvent({
    organizationId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "PAYROLL_COST_IMPORT_POSTED",
    entityType: "payroll_cost_import",
    entityId: outcome.row.id,
    beforeJson: before,
    afterJson: auditSummary(outcome.row, { replacedImportIds: outcome.replacedImportIds, entries: outcome.entries.map((entry) => ({ id: entry.id, entryNumber: entry.entryNumber, fiscalYearCode: entry.fiscalYearCode, sourceId: entry.sourceId, totalDebit: entry.totalDebit })) }),
    correlationId: input.correlationId
  });
  return { ...toImportRecord(outcome.row, cells), entries: outcome.entries, replacedImportIds: outcome.replacedImportIds, warnings: outcome.warnings };
}

// ---------------------------------------------------------------------------
// Reverse (idempotente)
// ---------------------------------------------------------------------------

export async function reversePayrollCostImport(input: { context: UserContext; importId: string; body: PayrollCostImportReverseBody; correlationId?: string }): Promise<PayrollCostImportRecord> {
  requireAnyPermission(input.context, PAYROLL_WRITE_KEYS);
  const organizationId = input.context.organizationId;
  const reason = input.body.reason?.trim() ?? "";
  if (!reason) throw ledgerBadRequest("JOURNAL_REVERSAL_REASON_REQUIRED", "Indica el motivo del reverso.");
  if (input.body.entryDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.body.entryDate)) throw ledgerBadRequest("VALIDATION_ERROR", "entryDate debe tener formato YYYY-MM-DD.");
  const existing = await loadImportOrThrow(prisma, organizationId, input.importId);
  const cells = (await importCells(prisma, [existing.id])).get(existing.id) ?? [];
  assertFinanceReadScopeMany(input.context, propertyIdsOf(cells));
  if (existing.status === "reversed") return { ...toImportRecord(existing, cells), alreadyReversed: true };
  const properties = propertyIndex(await loadProperties(prisma, organizationId));

  const before = auditSummary(existing);
  const outcome = await prisma.$transaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const row = await loadImportOrThrow(tx, organizationId, input.importId);
    if (row.status === "reversed") return { row, reversals: [], alreadyReversed: true };
    const reversed = await reverseImportInTx(tx, row, { reason, entryDate: input.body.entryDate ?? null, reversedBy: input.context.userId, properties });
    return { ...reversed, alreadyReversed: false };
  }, TX_OPTIONS);

  if (!outcome.alreadyReversed) {
    recordAuditEvent({
      organizationId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "PAYROLL_COST_IMPORT_REVERSED",
      entityType: "payroll_cost_import",
      entityId: outcome.row.id,
      beforeJson: before,
      afterJson: auditSummary(outcome.row, { reason, reversals: outcome.reversals.map((entry) => ({ id: entry.id, entryNumber: entry.entryNumber, fiscalYearCode: entry.fiscalYearCode, reversalOfId: entry.reversalOfId })) }),
      correlationId: input.correlationId
    });
  }
  return { ...toImportRecord(outcome.row, cells), alreadyReversed: outcome.alreadyReversed };
}

// ---------------------------------------------------------------------------
// List / get
// ---------------------------------------------------------------------------

export async function listPayrollCostImports(input: { context: UserContext; query?: PayrollCostImportListQuery }): Promise<PayrollCostImportRecord[]> {
  requireAnyPermission(input.context, PAYROLL_READ_KEYS);
  const query = input.query ?? {};
  const { organizationId, scopeContext } = resolveOrganization(input.context, query.organizationId);
  const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
  const rows = await prisma.payrollCostImport.findMany({
    where: {
      organizationId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.to ? { periodFrom: { lte: query.to } } : {}),
      ...(query.from ? { periodTo: { gte: query.from } } : {})
    },
    orderBy: { createdAt: "desc" },
    take: limit
  });
  const cells = await importCells(prisma, rows.map((row) => row.id));
  return rows
    .map((row) => ({ row, cells: cells.get(row.id) ?? [] }))
    .filter(({ cells: rowCells }) => propertyIdsOf(rowCells).every((propertyId) => propertyWithinScope(scopeContext, propertyId)))
    .map(({ row, cells: rowCells }) => toImportRecord(row, rowCells));
}

export async function getPayrollCostImport(input: { context: UserContext; importId: string }): Promise<PayrollCostImportDetail> {
  requireAnyPermission(input.context, PAYROLL_READ_KEYS);
  const organizationId = input.context.organizationId;
  const row = await loadImportOrThrow(prisma, organizationId, input.importId);
  const lines = await prisma.payrollCostLine.findMany({ where: { importId: row.id }, orderBy: [{ periodCode: "asc" }, { workCenterLabel: "asc" }, { costGroup: "asc" }, { departmentLabel: "asc" }] });
  const cells = (await importCells(prisma, [row.id])).get(row.id) ?? [];
  assertFinanceReadScopeMany(input.context, propertyIdsOf(cells));
  const references = await prisma.payrollCostReference.findMany({ where: { importId: row.id }, orderBy: [{ periodCode: "asc" }, { propertyId: "asc" }] });
  const properties = propertyIndex(await loadProperties(prisma, organizationId));
  const costCentreIds = Array.from(new Set(lines.map((line) => line.costCenterId).filter((id): id is string => Boolean(id))));
  const costCentres = costCentreIds.length ? await prisma.costCenter.findMany({ where: { id: { in: costCentreIds } }, select: { id: true, code: true } }) : [];
  const costCentreCodes = new Map(costCentres.map((centre) => [centre.id, centre.code]));
  const entries = await entryDtosByIds(prisma, row.journalEntryIds, "entry", properties);
  const reversals = await entryDtosByIds(prisma, row.reversalJournalEntryIds, "reversal", properties);
  return {
    ...toImportRecord(row, cells),
    lines: lines.map((line) => lineDto(line, properties, costCentreCodes)),
    references: references.map((reference) => referenceDto(reference, properties)),
    byCentreMonth: lineCellSources(lines, references).map((cell) => centreMonthDto(cell, properties)),
    entries,
    reversals
  };
}
