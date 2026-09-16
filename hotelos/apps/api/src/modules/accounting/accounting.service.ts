// Accounting ledger engine (Finanzas · lote ledger · 2026-09-15).
//
// ONE writer for the libro diario: every asiento of the platform — invoices,
// payments, POS, supplier bills, payroll, commissions, depreciation, VAT
// settlement, year-end close, manual entries — goes through
// `postJournalEntry`, which:
//   · validates the lines (positive amounts on one side, Decimal to the cent)
//     and refuses an unbalanced entry (Σ debit == Σ credit, exact);
//   · resolves account codes against the ORGANISATION chart (postable accounts
//     only); an organisation without a chart gets the «PGC Pymes hotelero»
//     template provisioned on the spot (chart-of-accounts.service) — never a
//     silent skip, never a fake account;
//   · refuses to post into a closed fiscal period (409 FISCAL_PERIOD_CLOSED)
//     or into a CLOSED fiscal year — status `closed` after regularización +
//     cierre (409 FISCAL_YEAR_CLOSED; fix:ledger t6#3) — unless the caller is
//     the year-end close / reopen itself (`ignoreClosedPeriod`);
//   · numbers the entry sequentially per (organisation, ejercicio) under
//     `pg_advisory_xact_lock(hashtext(organizationId || fiscalYearCode))`, so
//     two concurrent posts never share a number and the unique index
//     (organizationId, fiscalYearCode, entryNumber) never bites;
//   · is idempotent by (organizationId, sourceType, sourceId): a second post
//     of the same document returns the existing entry (`created: false`);
//   · demands a work centre (`propertyId`) when any line hits groups 6/7 —
//     400 WORK_CENTER_REQUIRED (Tanda 6b · L4, design §5.2 R4) — unless the
//     asiento is a regularización / cierre / apertura / anulación, a VAT
//     settlement, or a manual entry flagged `societyLevel: true`; the guard is
//     switched off with STRUCTURE_ENABLED=false (lib/finance-scope.ts);
//   · refuses a work centre of ANOTHER organisation (fix:L4 t6b#6, design
//     §5.2 R10.1): `propertyId` must be a Property of `organizationId`, else
//     an opaque 404 PROPERTY_NOT_FOUND — the same answer the tenant hook
//     gives HTTP callers — so event-driven writers, the assistant and scripts
//     that call the service directly cannot book an asiento on a foreign
//     centre (`requireJournalWorkCenter`, also applied to drafts);
//   · writes entryDate (fecha contable), description, reference, accountCode,
//     taxRateCode / taxBase per line — the contract of
//     docs/runbooks/finanzas-contabilidad.md §1.3.
// `reverseJournalEntry` produces the marked inverse (reversalOfId /
// reversedById, entryKind reversal); nothing is ever deleted.
//
// Money: Prisma.Decimal everywhere, rounded HALF_UP to 2 decimals; the wire
// contract (packages/shared/src/accounting-types.ts) carries strings.
// Legacy exports server.ts still imports (createJournalEntryDraft,
// listJournalEntries, listAccounts, createSupplierBillDraft, listSupplierBills
// and the draft-posting overload of postJournalEntry) are kept at the bottom
// and routed through the engine; the integrator redirects the old routes to
// ledger.routes.ts.

import { prisma } from "@hotelos/database";
import { Prisma } from "@prisma/client";
import type { UserContext } from "../../lib/demo-store.js";
import { createId } from "../../lib/ids.js";
import { buildPage, decodeCursor, type Page } from "../../lib/pagination.js";
import { isIsoDate } from "../../lib/query-dates.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import {
  CHART_TEMPLATE_CODE,
  PGC_PYMES_HOTEL_TEMPLATE,
  USALI_DEPARTMENT_LINES,
  accountGroup,
  accountLevel,
  isPostableCode,
  legacyAccountType,
  parentCandidates,
  prismaChartStore,
  provisionOrganizationChart,
  type AccountKind,
  type UsaliDepartment,
  type UsaliLine
} from "./chart-of-accounts.service.js";
import { isPostingAllowed } from "./fiscal-period.service.js";
import { isStructureEnabled } from "../../lib/finance-scope.js";
import type {
  AccountLedgerView,
  AccountingSettingsPatchInput,
  AccountingSettingsView,
  ChartAccountCreateInput,
  ChartAccountPatchInput,
  ChartAccountView,
  JournalEntryKind,
  JournalEntryStatus,
  JournalEntryView,
  JournalLineView,
  JournalListPage,
  JournalListQuery,
  LedgerMovementView,
  ManualJournalEntryInput,
  MoneyString
} from "../../../../../packages/shared/src/accounting-types.js";

export type {
  AccountLedgerView,
  AccountingSettingsPatchInput,
  AccountingSettingsView,
  ChartAccountCreateInput,
  ChartAccountPatchInput,
  ChartAccountView,
  JournalEntryKind,
  JournalEntryStatus,
  JournalEntryView,
  JournalLineView,
  JournalListPage,
  JournalListQuery,
  LedgerMovementView,
  ManualJournalEntryInput,
  MoneyString
};

// ---------------------------------------------------------------------------
// Money helpers (Decimal, never float)
// ---------------------------------------------------------------------------

export type Decimal = Prisma.Decimal;
export type MoneyLike = Prisma.Decimal | string | number;

const D = Prisma.Decimal;

/** Decimal rounded HALF_UP (away from zero on .5) to 2 decimals; throws 400 on garbage. */
export function money(value: MoneyLike, label = "importe"): Decimal {
  let decimal: Decimal;
  try {
    decimal = value instanceof D ? value : new D(typeof value === "number" ? value.toString() : value);
  } catch {
    throw new BadRequestError(`El ${label} no es un número válido.`);
  }
  if (!decimal.isFinite()) throw new BadRequestError(`El ${label} no es un número válido.`);
  return decimal.toDecimalPlaces(2, D.ROUND_HALF_UP);
}

export function moneyString(value: MoneyLike): MoneyString {
  return money(value).toFixed(2);
}

export const ZERO: Decimal = new D(0);

export function sumMoney(values: Iterable<MoneyLike>): Decimal {
  let total: Decimal = ZERO;
  for (const value of values) total = total.plus(money(value));
  return total;
}

/** Calendar day (YYYY-MM-DD) of an instant in an IANA time zone (Europe/Madrid, Atlantic/Canary…). */
export function localDateInTz(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
  }
}

export function dateOnlyUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function requireEntryDate(value: unknown): string {
  if (!isIsoDate(value)) throw new BadRequestError("La fecha contable (entryDate) debe tener formato YYYY-MM-DD.");
  return value;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** 409 with details.code (the typed code always wins over an `extra.code`). */
export function ledgerConflict(code: string, message: string, extra: Record<string, unknown> = {}): ConflictError {
  return new ConflictError(message, { ...extra, code });
}

/** 400 with details.code (the typed code always wins over an `extra.code`). */
export function ledgerBadRequest(code: string, message: string, extra: Record<string, unknown> = {}): BadRequestError {
  const error = new BadRequestError(message);
  error.details = { ...extra, code };
  return error;
}

/** 404 with details.code (opaque message: never says whether the row exists elsewhere). */
export function ledgerNotFound(code: string, message: string, extra: Record<string, unknown> = {}): NotFoundError {
  const error = new NotFoundError(message);
  error.details = { ...extra, code };
  return error;
}

// ---------------------------------------------------------------------------
// Post input
// ---------------------------------------------------------------------------

export type JournalLineInput = {
  accountCode: string;
  debit?: MoneyLike | null;
  credit?: MoneyLike | null;
  description?: string | null;
  taxRateCode?: string | null;
  taxBase?: MoneyLike | null;
  costCenterId?: string | null;
};

export type PostJournalEntryInput = {
  organizationId: string;
  /** Work centre: a Property of `organizationId` (hotel or office); any other id → opaque 404 PROPERTY_NOT_FOUND. */
  propertyId?: string | null;
  /** Fecha contable (devengo), YYYY-MM-DD. */
  entryDate: string;
  /** docs/runbooks/finanzas-contabilidad.md §1.1 values. */
  sourceType: string;
  sourceId: string;
  description: string;
  reference?: string | null;
  entryKind?: JournalEntryKind;
  lines: JournalLineInput[];
  createdBy?: string | null;
  currencyCode?: string;
  fiscalYearId?: string | null;
  /** Entry this one undoes (set by reverseJournalEntry). */
  reversalOfId?: string | null;
  /** Reuse the caller's transaction so the document and its asiento commit together. */
  tx?: Prisma.TransactionClient;
  /** Year-end close posts into the period it closes: skip the closed-period guard. */
  ignoreClosedPeriod?: boolean;
  /** Provision the template chart when the organisation has none (default true). */
  autoProvisionChart?: boolean;
  /**
   * Sociedad-level manual asiento (design §5.2 R4): lines of groups 6/7 are
   * accepted without a work centre. Only meaningful with sourceType "manual";
   * the diario labels such entries «Sociedad (sin centro)».
   */
  societyLevel?: boolean;
  correlationId?: string;
};

export type PostedJournalEntry = JournalEntryView & {
  /** false when an entry for (organizationId, sourceType, sourceId) already existed. */
  created: boolean;
};

type NormalizedLine = {
  accountCode: string;
  debit: Decimal;
  credit: Decimal;
  description: string | null;
  taxRateCode: string | null;
  taxBase: Decimal | null;
  costCenterId: string | null;
};

const ACCOUNT_CODE_PATTERN = /^[1-9][0-9]{0,7}(\.[0-9]{1,3})?$/;

/** Pure: validates and rounds the lines; throws 400 with details.code on any defect. Exported for the unit tests. */
export function normalizeJournalLines(lines: readonly JournalLineInput[]): { lines: NormalizedLine[]; totalDebit: Decimal; totalCredit: Decimal } {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw ledgerBadRequest("JOURNAL_TOO_FEW_LINES", "Un asiento necesita al menos dos líneas.");
  }
  const normalized: NormalizedLine[] = [];
  let totalDebit: Decimal = ZERO;
  let totalCredit: Decimal = ZERO;
  lines.forEach((line, index) => {
    const code = typeof line.accountCode === "string" ? line.accountCode.trim() : "";
    if (!ACCOUNT_CODE_PATTERN.test(code)) {
      throw ledgerBadRequest("ACCOUNT_CODE_INVALID", `La línea ${index + 1} no tiene un código de cuenta válido («${code}»).`, { line: index + 1 });
    }
    const debit = line.debit === undefined || line.debit === null ? ZERO : money(line.debit, `debe de la línea ${index + 1}`);
    const credit = line.credit === undefined || line.credit === null ? ZERO : money(line.credit, `haber de la línea ${index + 1}`);
    if (debit.isNegative() || credit.isNegative()) {
      throw ledgerBadRequest("JOURNAL_NEGATIVE_LINE", `La línea ${index + 1} tiene un importe negativo: usa el sentido contrario (debe/haber).`, { line: index + 1 });
    }
    if (debit.isZero() === credit.isZero()) {
      throw ledgerBadRequest("JOURNAL_LINE_SIDE", `La línea ${index + 1} debe llevar importe en debe o en haber (no en ambos ni en ninguno).`, { line: index + 1 });
    }
    normalized.push({
      accountCode: code,
      debit,
      credit,
      description: line.description ? String(line.description).slice(0, 500) : null,
      taxRateCode: line.taxRateCode ? String(line.taxRateCode) : null,
      taxBase: line.taxBase === undefined || line.taxBase === null ? null : money(line.taxBase, `base de la línea ${index + 1}`),
      costCenterId: line.costCenterId ?? null
    });
    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);
  });
  if (!totalDebit.equals(totalCredit)) {
    throw ledgerBadRequest("JOURNAL_UNBALANCED", `El asiento no cuadra: debe ${totalDebit.toFixed(2)} ≠ haber ${totalCredit.toFixed(2)}.`, {
      totalDebit: totalDebit.toFixed(2),
      totalCredit: totalCredit.toFixed(2)
    });
  }
  return { lines: normalized, totalDebit, totalCredit };
}

/** Kept for the legacy draft flow and the contract tests: number-based balance check (rounded to the cent). */
export function assertBalancedJournal(lines: ReadonlyArray<{ accountCode: string; debit: number; credit: number }>): void {
  const totalDebit = sumMoney(lines.map((l) => l.debit));
  const totalCredit = sumMoney(lines.map((l) => l.credit));
  if (!totalDebit.equals(totalCredit)) {
    throw ledgerBadRequest("JOURNAL_UNBALANCED", `El asiento no cuadra: debe ${totalDebit.toFixed(2)} ≠ haber ${totalCredit.toFixed(2)}.`);
  }
}

// ---------------------------------------------------------------------------
// Work centre (dimensión «centro») — Tanda 6b · L4, design §5.2 R4
// ---------------------------------------------------------------------------

/** entryKind values that never carry a centre: the year-end mechanics and marked reversals (they mirror their original). */
export const WORK_CENTER_EXEMPT_ENTRY_KINDS: readonly string[] = ["regularization", "closing", "opening", "reversal"];
/** sourceType values posted at sociedad level by design (the VAT settlement nets 472/477 of the whole NIF). */
export const WORK_CENTER_EXEMPT_SOURCE_TYPES: readonly string[] = ["vat_settlement"];

/** True when any line posts to a PGC group 6 (gastos) or 7 (ingresos) account. Pure. */
export function linesRequireWorkCenter(lines: ReadonlyArray<{ accountCode: string }>): boolean {
  return lines.some((line) => {
    const first = String(line.accountCode).trim().charAt(0);
    return first === "6" || first === "7";
  });
}

export type WorkCenterRuleInput = {
  propertyId: string | null | undefined;
  entryKind: string | null | undefined;
  sourceType: string;
  societyLevel?: boolean | null;
  lines: ReadonlyArray<{ accountCode: string }>;
};

/**
 * Pure decision of R4: an asiento without `propertyId` whose lines touch
 * groups 6/7 needs a work centre, except the exempt kinds / sources and a
 * manual entry explicitly flagged `societyLevel`. Balance-sheet-only entries
 * (groups 1-5) never need one. Exported for the unit tests.
 */
export function workCenterRequired(input: WorkCenterRuleInput): boolean {
  if (input.propertyId) return false;
  if (WORK_CENTER_EXEMPT_ENTRY_KINDS.includes(input.entryKind ?? "normal")) return false;
  if (WORK_CENTER_EXEMPT_SOURCE_TYPES.includes(input.sourceType)) return false;
  if (input.sourceType === "manual" && input.societyLevel === true) return false;
  return linesRequireWorkCenter(input.lines);
}

/** 1-based indexes of the lines that hit groups 6/7 (for the error details). */
function workCenterLineIndexes(lines: ReadonlyArray<{ accountCode: string }>): number[] {
  return lines.flatMap((line, index) => (linesRequireWorkCenter([line]) ? [index + 1] : []));
}

/**
 * Throws 400 WORK_CENTER_REQUIRED when the rule applies. Gated by
 * STRUCTURE_ENABLED (default on) so a deployment can fall back to the
 * pre-Tanda-6b behaviour without a code change (design §8.2).
 */
export function assertWorkCenter(input: WorkCenterRuleInput): void {
  if (!isStructureEnabled()) return;
  if (!workCenterRequired(input)) return;
  throw ledgerBadRequest(
    "WORK_CENTER_REQUIRED",
    "Las líneas de gastos e ingresos (grupos 6 y 7) exigen un centro de trabajo (propertyId): indica el hotel o la oficina central, o marca el asiento manual como de sociedad (societyLevel).",
    { lines: workCenterLineIndexes(input.lines), entryKind: input.entryKind ?? "normal", sourceType: input.sourceType }
  );
}

/** Subset of the Prisma client the centre check touches (the root client, an interactive transaction, or a unit-test fake). */
export type JournalWorkCenterDb = Pick<Prisma.TransactionClient, "property">;

export type JournalWorkCenter = { id: string; kind: string };

/**
 * The work centre of an asiento must be a Property of the organisation that
 * posts it (invariant R10.1; fix:L4 t6b#6). Until now the only guard was the
 * HTTP tenant hook, so event-driven writers, the assistant and scripts calling
 * the service directly could book an asiento of organisation A on a centre of
 * organisation B. Missing or foreign → opaque 404 PROPERTY_NOT_FOUND (same
 * status the hook gives, so neither a foreign nor a sister centre is ever
 * confirmed). `null`/`undefined` → null without touching the database (an
 * asiento of the sociedad is R4's business, not this guard's). Returns the
 * centre with its `kind` for callers that label it (hotel / office).
 */
export async function requireJournalWorkCenter(db: JournalWorkCenterDb, organizationId: string, propertyId: string | null | undefined): Promise<JournalWorkCenter | null> {
  if (!propertyId) return null;
  const property = await db.property.findUnique({ where: { id: propertyId }, select: { id: true, organizationId: true, kind: true } });
  if (!property || property.organizationId !== organizationId) {
    throw ledgerNotFound("PROPERTY_NOT_FOUND", "Propiedad no encontrada.", { propertyId });
  }
  return { id: property.id, kind: String(property.kind) };
}

// ---------------------------------------------------------------------------
// Fiscal year code / accounts
// ---------------------------------------------------------------------------

type Client = Prisma.TransactionClient | typeof prisma;

export type FiscalYearRef = { code: string; id: string | null; /** FiscalYear.status (open · closing · closed); null when no FiscalYear row covers the date. */ status: string | null };

/** FiscalYear covering the date (organisation-wide row or the property's own), else the calendar year. */
export async function resolveFiscalYear(client: Client, organizationId: string, propertyId: string | null | undefined, entryDate: string): Promise<FiscalYearRef> {
  const day = dateOnlyUtc(entryDate);
  const year = await client.fiscalYear.findFirst({
    where: {
      organizationId,
      OR: [{ propertyId: null }, ...(propertyId ? [{ propertyId }] : [])],
      startDate: { lte: day },
      endDate: { gte: day }
    },
    orderBy: [{ propertyId: "desc" }, { startDate: "desc" }],
    select: { id: true, code: true, status: true }
  });
  if (year) return { code: year.code, id: year.id, status: year.status };
  return { code: entryDate.slice(0, 4), id: null, status: null };
}

/**
 * The lock of the diario for a fecha contable: a CLOSED fiscal year (its
 * regularización and cierre are posted; PGC: the ejercicio is closed until it
 * is reopened by reversal) refuses any asiento dated inside it, and so does
 * a closed FiscalPeriod (month / quarter). Both are typed 409s; the year-end
 * close and reopen bypass them with `ignoreClosedPeriod`.
 */
export async function assertEntryDateOpen(organizationId: string, propertyId: string | null | undefined, entryDate: string, fiscalYear: FiscalYearRef): Promise<void> {
  if (fiscalYear.status === "closed") {
    throw ledgerConflict("FISCAL_YEAR_CLOSED", `El ejercicio ${fiscalYear.code} está cerrado: no admite asientos con fecha ${entryDate}. Reábrelo (anulaciones marcadas) antes de contabilizar.`, {
      yearCode: fiscalYear.code,
      fiscalYearId: fiscalYear.id,
      entryDate
    });
  }
  const period = await isPostingAllowed(organizationId, propertyId ?? undefined, dateOnlyUtc(entryDate));
  if (!period.allowed) {
    throw ledgerConflict("FISCAL_PERIOD_CLOSED", `El periodo ${period.closedPeriodCode} está cerrado: no admite asientos con fecha ${entryDate}.`, {
      periodCode: period.closedPeriodCode,
      entryDate
    });
  }
}

type AccountRef = { id: string; code: string; name: string; isPostable: boolean; kind: string };

/**
 * Account codes → rows of the organisation chart. When some are missing and
 * the organisation has no provisioned chart, the template is provisioned in
 * the same transaction (additive, idempotent) and the lookup retried. Still
 * missing → 409 ACCOUNT_NOT_FOUND; a header account → 409 ACCOUNT_NOT_POSTABLE.
 */
export async function resolvePostableAccounts(client: Client, organizationId: string, codes: readonly string[], autoProvision = true): Promise<Map<string, AccountRef>> {
  const unique = Array.from(new Set(codes));
  const select = { id: true, code: true, name: true, isPostable: true, kind: true } as const;
  let rows = await client.account.findMany({ where: { organizationId, code: { in: unique } }, select });
  let missing = unique.filter((code) => !rows.some((row) => row.code === code));
  if (missing.length > 0 && autoProvision) {
    const setting = await client.accountingSetting.findFirst({ where: { organizationId, propertyId: null }, select: { chartTemplate: true } });
    if (setting?.chartTemplate !== CHART_TEMPLATE_CODE) {
      const result = await provisionOrganizationChart(organizationId, { store: prismaChartStore(client) });
      recordAuditEvent({
        organizationId,
        actorType: "system",
        action: "ACCOUNTING_CHART_PROVISIONED",
        entityType: "organization",
        entityId: organizationId,
        afterJson: { reason: "auto_provision_on_post", created: result.created, linked: result.linked, totalAfter: result.totalAfter, missingCodes: missing }
      });
      rows = await client.account.findMany({ where: { organizationId, code: { in: unique } }, select });
      missing = unique.filter((code) => !rows.some((row) => row.code === code));
    }
  }
  if (missing.length > 0) {
    throw ledgerConflict("ACCOUNT_NOT_FOUND", `La organización no tiene las cuentas ${missing.join(", ")} en su plan contable.`, { organizationId, codes: missing });
  }
  const headers = rows.filter((row) => !row.isPostable).map((row) => row.code);
  if (headers.length > 0) {
    throw ledgerConflict("ACCOUNT_NOT_POSTABLE", `Las cuentas ${headers.join(", ")} son cabeceras (grupo/subgrupo) y no admiten apuntes.`, { codes: headers });
  }
  return new Map(rows.map((row) => [row.code, { ...row, kind: String(row.kind) }]));
}

function lockKey(organizationId: string, fiscalYearCode: string): string {
  return `${organizationId}${fiscalYearCode}`;
}

/**
 * The ONE advisory-lock key of journal numbering per (organisation, fiscal
 * year). Exported (integration 2026-09-16) so the ledger ports that still
 * number MAX+1 themselves (payables/ledger-port.ts, vat-settlement interim
 * engine) serialise against this engine instead of racing it.
 */
export function journalNumberingLockKey(organizationId: string, fiscalYearCode: string): string {
  return lockKey(organizationId, fiscalYearCode);
}

async function acquireNumberingLock(client: Client, organizationId: string, fiscalYearCode: string): Promise<void> {
  // $executeRaw: the lock function returns void, which $queryRaw cannot deserialise.
  await client.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey(organizationId, fiscalYearCode)}))`;
}

async function nextEntryNumber(client: Client, organizationId: string, fiscalYearCode: string): Promise<number> {
  const rows = await client.$queryRaw<Array<{ next: number | bigint }>>`
    SELECT COALESCE(MAX(entry_number), 0) + 1 AS next
    FROM journal_entries
    WHERE organization_id = ${organizationId} AND fiscal_year_code = ${fiscalYearCode}`;
  return Number(rows[0]?.next ?? 1);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

type EntryRow = NonNullable<Awaited<ReturnType<typeof prisma.journalEntry.findUnique>>>;
type LineRow = NonNullable<Awaited<ReturnType<typeof prisma.journalLine.findFirst>>>;

function decimalString(value: Prisma.Decimal | null | undefined): MoneyString {
  return value ? new D(value).toFixed(2) : "0.00";
}

function toLineView(line: LineRow, account: { code: string; name: string } | undefined): JournalLineView {
  return {
    id: line.id,
    accountId: line.accountId,
    accountCode: line.accountCode ?? account?.code ?? line.accountId,
    accountName: account?.name ?? null,
    debit: decimalString(line.debit),
    credit: decimalString(line.credit),
    description: line.description ?? null,
    taxRateCode: line.taxRateCode ?? null,
    taxBase: line.taxBase ? new D(line.taxBase).toFixed(2) : null,
    costCenterId: line.costCenterId ?? null
  };
}

function toEntryView(entry: EntryRow, lines: JournalLineView[]): JournalEntryView {
  return {
    id: entry.id,
    organizationId: entry.organizationId,
    propertyId: entry.propertyId ?? null,
    entryNumber: entry.entryNumber ?? null,
    fiscalYearCode: entry.fiscalYearCode ?? null,
    fiscalYearId: entry.fiscalYearId ?? null,
    entryDate: isoDay(entry.entryDate),
    postedAt: entry.postedAt ? entry.postedAt.toISOString() : null,
    status: entry.status as JournalEntryStatus,
    entryKind: entry.entryKind,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId ?? null,
    description: entry.description ?? null,
    reference: entry.reference ?? null,
    reversalOfId: entry.reversalOfId ?? null,
    reversedById: entry.reversedById ?? null,
    createdBy: entry.createdBy ?? null,
    currencyCode: entry.currencyCode,
    lines,
    totalDebit: sumMoney(lines.map((l) => l.debit)).toFixed(2),
    totalCredit: sumMoney(lines.map((l) => l.credit)).toFixed(2)
  };
}

async function hydrateEntries(client: Client, entries: EntryRow[]): Promise<JournalEntryView[]> {
  if (entries.length === 0) return [];
  const lines = await client.journalLine.findMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } }, orderBy: { id: "asc" } });
  const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
  const accounts = accountIds.length > 0 ? await client.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, code: true, name: true } }) : [];
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const linesByEntry = new Map<string, JournalLineView[]>();
  for (const line of lines) {
    const bucket = linesByEntry.get(line.journalEntryId) ?? [];
    bucket.push(toLineView(line, accountById.get(line.accountId)));
    linesByEntry.set(line.journalEntryId, bucket);
  }
  return entries.map((entry) => {
    const entryLines = (linesByEntry.get(entry.id) ?? []).sort((a, b) => {
      // Debits first, then credits, then by account code — the classic diario layout.
      const sideA = a.debit === "0.00" ? 1 : 0;
      const sideB = b.debit === "0.00" ? 1 : 0;
      return sideA - sideB || a.accountCode.localeCompare(b.accountCode);
    });
    return toEntryView(entry, entryLines);
  });
}

export async function loadJournalEntry(client: Client, id: string): Promise<JournalEntryView | null> {
  const entry = await client.journalEntry.findUnique({ where: { id } });
  if (!entry) return null;
  const [view] = await hydrateEntries(client, [entry]);
  return view ?? null;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

type LegacyPostDraftInput = { context: UserContext; journalEntryId: string; correlationId: string };

const TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

/**
 * Post an asiento. Idempotent by (organizationId, sourceType, sourceId);
 * numbered per ejercicio under an advisory lock; balanced to the cent;
 * postable accounts of the organisation chart (auto-provisioned when absent).
 * The legacy overload (`{ journalEntryId }`) posts a draft created with
 * createJournalEntryDraft through the same numbering.
 */
export function postJournalEntry(input: LegacyPostDraftInput): Promise<JournalEntryDraft>;
export function postJournalEntry(input: PostJournalEntryInput): Promise<PostedJournalEntry>;
export function postJournalEntry(input: LegacyPostDraftInput | PostJournalEntryInput): Promise<JournalEntryDraft | PostedJournalEntry> {
  if ("journalEntryId" in input) return postDraftJournalEntry(input);
  return postJournalEntryCore(input);
}

async function postJournalEntryCore(input: PostJournalEntryInput): Promise<PostedJournalEntry> {
  if (!input.organizationId) throw ledgerBadRequest("ORGANIZATION_REQUIRED", "organizationId es obligatorio.");
  if (!input.sourceType || !input.sourceId) throw ledgerBadRequest("JOURNAL_SOURCE_REQUIRED", "sourceType y sourceId son obligatorios.");
  const entryDate = requireEntryDate(input.entryDate);
  const description = typeof input.description === "string" && input.description.trim().length > 0 ? input.description.trim().slice(0, 500) : null;
  if (!description) throw ledgerBadRequest("JOURNAL_DESCRIPTION_REQUIRED", "El concepto del asiento es obligatorio.");
  const normalized = normalizeJournalLines(input.lines);
  const propertyId = input.propertyId ?? null;
  const entryKind: JournalEntryKind = input.entryKind ?? "normal";

  const run = async (tx: Prisma.TransactionClient): Promise<PostedJournalEntry> => {
    const fiscalYear = await resolveFiscalYear(tx, input.organizationId, propertyId, entryDate);
    await acquireNumberingLock(tx, input.organizationId, fiscalYear.code);

    const existing = await tx.journalEntry.findFirst({
      where: { organizationId: input.organizationId, sourceType: input.sourceType, sourceId: input.sourceId },
      select: { id: true }
    });
    if (existing) {
      const view = await loadJournalEntry(tx, existing.id);
      return { ...view!, created: false };
    }

    // R10.1: the centre must belong to the posting organisation (after the idempotent lookup, like R4: a replay of an existing key is returned as-is).
    await requireJournalWorkCenter(tx, input.organizationId, propertyId);
    // R4: groups 6/7 need a centre (after the idempotent lookup, so a legacy entry is still returned as-is).
    assertWorkCenter({ propertyId, entryKind, sourceType: input.sourceType, societyLevel: input.societyLevel, lines: normalized.lines });
    if (!input.ignoreClosedPeriod) await assertEntryDateOpen(input.organizationId, propertyId, entryDate, fiscalYear);

    const accounts = await resolvePostableAccounts(tx, input.organizationId, normalized.lines.map((l) => l.accountCode), input.autoProvisionChart !== false);
    const entryNumber = await nextEntryNumber(tx, input.organizationId, fiscalYear.code);

    const entry = await tx.journalEntry.create({
      data: {
        organizationId: input.organizationId,
        propertyId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        status: "posted",
        postedAt: new Date(),
        createdBy: input.createdBy ?? null,
        currencyCode: input.currencyCode ?? "EUR",
        fiscalYearId: input.fiscalYearId ?? fiscalYear.id,
        entryKind,
        entryDate: dateOnlyUtc(entryDate),
        entryNumber,
        fiscalYearCode: fiscalYear.code,
        description,
        reference: input.reference ? String(input.reference).slice(0, 200) : null,
        reversalOfId: input.reversalOfId ?? null
      }
    });
    await tx.journalLine.createMany({
      data: normalized.lines.map((line) => ({
        journalEntryId: entry.id,
        accountId: accounts.get(line.accountCode)!.id,
        accountCode: line.accountCode,
        debit: line.debit.toFixed(2),
        credit: line.credit.toFixed(2),
        currency: input.currencyCode ?? "EUR",
        description: line.description ?? description,
        taxRateCode: line.taxRateCode,
        taxBase: line.taxBase ? line.taxBase.toFixed(2) : null,
        costCenterId: line.costCenterId
      }))
    });
    if (input.reversalOfId) {
      await tx.journalEntry.update({ where: { id: input.reversalOfId }, data: { reversedById: entry.id, status: "reversed" } });
    }
    const view = await loadJournalEntry(tx, entry.id);
    return { ...view!, created: true };
  };

  const posted = input.tx ? await run(input.tx) : await prisma.$transaction(run, TX_OPTIONS);
  if (posted.created) {
    recordDomainEvent({
      organizationId: input.organizationId,
      propertyId: propertyId ?? "",
      entityType: "journal_entry",
      entityId: posted.id,
      eventType: "JournalEntryPosted",
      payload: {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        entryNumber: posted.entryNumber,
        fiscalYearCode: posted.fiscalYearCode,
        entryDate,
        totalDebit: posted.totalDebit
      },
      actorType: input.createdBy ? "user" : "system",
      actorUserId: input.createdBy ?? undefined,
      correlationId: input.correlationId ?? createId("corr")
    });
  }
  return posted;
}

export type ReverseJournalEntryOptions = {
  organizationId: string;
  journalEntryId: string;
  reason: string;
  /** Defaults to the reversed entry's own date. */
  entryDate?: string;
  /** Defaults to "reversal"; document-driven reversals pass their own (invoice_cancellation…). */
  sourceType?: string;
  /** Defaults to `reversal:<journalEntryId>`. */
  sourceId?: string;
  description?: string;
  reference?: string | null;
  createdBy?: string | null;
  tx?: Prisma.TransactionClient;
  ignoreClosedPeriod?: boolean;
  correlationId?: string;
};

/**
 * Marked inverse of a posted entry: same accounts, sides swapped, entryKind
 * "reversal", reversalOfId set and the original flagged reversedById /
 * status "reversed". Idempotent: an already-reversed entry returns its
 * reversal. Drafts cannot be reversed (400).
 */
export async function reverseJournalEntry(options: ReverseJournalEntryOptions): Promise<PostedJournalEntry> {
  const run = async (tx: Prisma.TransactionClient): Promise<PostedJournalEntry> => {
    const original = await tx.journalEntry.findUnique({ where: { id: options.journalEntryId } });
    if (!original || original.organizationId !== options.organizationId) throw new NotFoundError("Asiento no encontrado.");
    if (original.status === "draft") throw ledgerBadRequest("JOURNAL_DRAFT_NOT_REVERSIBLE", "Un asiento en borrador no se revierte: elimínalo o contabilízalo.");
    if (original.reversedById) {
      const view = await loadJournalEntry(tx, original.reversedById);
      if (view) return { ...view, created: false };
    }
    if (original.entryKind === "reversal") {
      throw ledgerConflict("JOURNAL_REVERSAL_OF_REVERSAL", "Un asiento de anulación no se revierte: contabiliza de nuevo el documento original.", { journalEntryId: original.id });
    }
    const lines = await tx.journalLine.findMany({ where: { journalEntryId: original.id }, orderBy: { id: "asc" } });
    const accounts = await tx.account.findMany({ where: { id: { in: Array.from(new Set(lines.map((l) => l.accountId))) } }, select: { id: true, code: true } });
    const codeById = new Map(accounts.map((a) => [a.id, a.code]));
    const reason = options.reason?.trim();
    if (!reason) throw ledgerBadRequest("JOURNAL_REVERSAL_REASON_REQUIRED", "Indica el motivo de la anulación.");
    const label = original.entryNumber !== null ? `${original.fiscalYearCode ?? ""}/${original.entryNumber}` : original.id;
    return postJournalEntryCore({
      organizationId: original.organizationId,
      propertyId: original.propertyId,
      entryDate: options.entryDate ?? isoDay(original.entryDate),
      sourceType: options.sourceType ?? "reversal",
      sourceId: options.sourceId ?? `reversal:${original.id}`,
      description: options.description ?? `Anulación del asiento ${label}: ${reason}`,
      reference: options.reference === undefined ? original.reference : options.reference,
      entryKind: "reversal",
      createdBy: options.createdBy ?? null,
      currencyCode: original.currencyCode,
      reversalOfId: original.id,
      tx,
      ignoreClosedPeriod: options.ignoreClosedPeriod,
      correlationId: options.correlationId,
      lines: lines.map((line) => ({
        accountCode: line.accountCode ?? codeById.get(line.accountId) ?? line.accountId,
        debit: line.credit,
        credit: line.debit,
        description: line.description ? `Anulación: ${line.description}` : null,
        taxRateCode: line.taxRateCode,
        taxBase: line.taxBase,
        costCenterId: line.costCenterId
      }))
    });
  };
  return options.tx ? run(options.tx) : prisma.$transaction(run, TX_OPTIONS);
}

/** Entry for a document, if already posted (idempotency lookup used by the rules and the replay). */
export async function findJournalEntryBySource(client: Client, organizationId: string, sourceType: string, sourceId: string): Promise<{ id: string; entryNumber: number | null; fiscalYearCode: string | null; status: string; reversedById: string | null } | null> {
  return client.journalEntry.findFirst({
    where: { organizationId, sourceType, sourceId },
    select: { id: true, entryNumber: true, fiscalYearCode: true, status: true, reversedById: true }
  });
}

// ---------------------------------------------------------------------------
// Manual entries (POST /accounting/journal, POST /accounting/journal/:id/reverse)
// ---------------------------------------------------------------------------

/**
 * `societyLevel` (Tanda 6b · L4): a manual asiento of the sociedad without a
 * centre (R4). Until the shared `ManualJournalEntryInput` and the route schema
 * (ledger.routes.ts, L5) carry the flag it is accepted here as an extension.
 */
export type ManualJournalEntryBody = ManualJournalEntryInput & { societyLevel?: boolean };

export async function createManualJournalEntry(input: { context: UserContext; body: ManualJournalEntryBody; correlationId: string }): Promise<PostedJournalEntry> {
  requirePermissions(input.context, ["accounting.journal.post"]);
  const body = input.body;
  const posted = await postJournalEntry({
    organizationId: input.context.organizationId,
    propertyId: body.propertyId ?? null,
    entryDate: body.entryDate,
    sourceType: "manual",
    sourceId: createId("man"),
    description: body.description,
    reference: body.reference ?? null,
    createdBy: input.context.userId,
    societyLevel: body.societyLevel === true,
    correlationId: input.correlationId,
    lines: body.lines.map((line) => ({
      accountCode: line.accountCode,
      debit: line.debit ?? null,
      credit: line.credit ?? null,
      description: line.description ?? null,
      taxRateCode: line.taxRateCode ?? null,
      taxBase: line.taxBase ?? null,
      costCenterId: line.costCenterId ?? null
    }))
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: body.propertyId ?? input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "JOURNAL_ENTRY_POSTED",
    entityType: "journal_entry",
    entityId: posted.id,
    afterJson: { entryNumber: posted.entryNumber, fiscalYearCode: posted.fiscalYearCode, entryDate: posted.entryDate, totalDebit: posted.totalDebit, lines: posted.lines.length, societyLevel: body.societyLevel === true },
    correlationId: input.correlationId
  });
  return posted;
}

export async function reverseJournalEntryByUser(input: { context: UserContext; journalEntryId: string; reason: string; entryDate?: string; correlationId: string }): Promise<PostedJournalEntry> {
  requirePermissions(input.context, ["accounting.journal.post", "ai.high_risk.confirm"]);
  if (input.entryDate !== undefined) requireEntryDate(input.entryDate);
  const reversal = await reverseJournalEntry({
    organizationId: input.context.organizationId,
    journalEntryId: input.journalEntryId,
    reason: input.reason,
    entryDate: input.entryDate,
    createdBy: input.context.userId,
    correlationId: input.correlationId
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: reversal.propertyId ?? input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "JOURNAL_ENTRY_REVERSED",
    entityType: "journal_entry",
    entityId: input.journalEntryId,
    afterJson: { reversalId: reversal.id, entryNumber: reversal.entryNumber, fiscalYearCode: reversal.fiscalYearCode, reason: input.reason },
    correlationId: input.correlationId
  });
  return reversal;
}

// ---------------------------------------------------------------------------
// Queries: diario paginado, asiento, mayor
// ---------------------------------------------------------------------------

const JOURNAL_MAX_LIMIT = 500;
/** Detail cap of the mayor (movements returned); totals and closing balance always cover the whole window. */
export const LEDGER_MAX_MOVEMENTS = 5000;

function journalWhere(organizationId: string, query: JournalListQuery): Prisma.JournalEntryWhereInput {
  const where: Prisma.JournalEntryWhereInput = { organizationId };
  if (query.propertyId) where.propertyId = query.propertyId;
  if (query.sourceType) where.sourceType = query.sourceType;
  if (query.status) where.status = query.status;
  if (query.from || query.to) {
    where.entryDate = {
      ...(query.from ? { gte: dateOnlyUtc(query.from) } : {}),
      ...(query.to ? { lte: dateOnlyUtc(query.to) } : {})
    };
  }
  if (query.q) {
    const q = query.q.trim();
    if (q.length > 0) {
      where.OR = [
        { description: { contains: q, mode: "insensitive" } },
        { reference: { contains: q, mode: "insensitive" } },
        { sourceId: { contains: q, mode: "insensitive" } }
      ];
    }
  }
  return where;
}

/** Diario: entryDate desc, id desc (creation order inside the day == numbering order), keyset cursor. */
export async function listJournal(input: { context: UserContext; query: JournalListQuery }): Promise<JournalListPage> {
  requirePermissions(input.context, ["accounting.read"]);
  const query = input.query;
  if (query.from !== undefined) requireEntryDate(query.from);
  if (query.to !== undefined) requireEntryDate(query.to);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), JOURNAL_MAX_LIMIT);
  const where = journalWhere(input.context.organizationId, query);
  if (query.accountCode) {
    where.id = { in: await entryIdsForAccount(input.context.organizationId, query.accountCode, where) };
  }
  const cursor = decodeCursor(query.cursor ?? null);
  const cursorWhere: Prisma.JournalEntryWhereInput = cursor
    ? { OR: [{ entryDate: { lt: dateOnlyUtc(cursor.k) } }, { entryDate: dateOnlyUtc(cursor.k), id: { lt: cursor.id } }] }
    : {};
  const [rows, total] = await Promise.all([
    prisma.journalEntry.findMany({ where: { AND: [where, cursorWhere] }, orderBy: [{ entryDate: "desc" }, { id: "desc" }], take: limit + 1 }),
    prisma.journalEntry.count({ where })
  ]);
  const page: Page<EntryRow> = buildPage(rows, limit, total, (row) => isoDay(row.entryDate));
  const items = await hydrateEntries(prisma, page.items);
  return { items, nextCursor: page.nextCursor, total: page.total };
}

async function entryIdsForAccount(organizationId: string, accountCode: string, where: Prisma.JournalEntryWhereInput): Promise<string[]> {
  const account = await prisma.account.findUnique({ where: { organizationId_code: { organizationId, code: accountCode } }, select: { id: true } });
  if (!account) return [];
  const lines = await prisma.journalLine.findMany({ where: { accountId: account.id }, select: { journalEntryId: true }, distinct: ["journalEntryId"], take: 20_000 });
  const ids = lines.map((l) => l.journalEntryId);
  if (ids.length === 0) return [];
  const entries = await prisma.journalEntry.findMany({ where: { AND: [where, { id: { in: ids } }] }, select: { id: true } });
  return entries.map((e) => e.id);
}

export async function getJournalEntry(input: { context: UserContext; journalEntryId: string }): Promise<JournalEntryView> {
  requirePermissions(input.context, ["accounting.read"]);
  const view = await loadJournalEntry(prisma, input.journalEntryId);
  if (!view || view.organizationId !== input.context.organizationId) throw new NotFoundError("Asiento no encontrado.");
  return view;
}

/** Report scope shared by mayor, sumas y saldos, balance, PyG: never drafts. */
export const REPORT_STATUSES: JournalEntryStatus[] = ["posted", "reversed"];

type LedgerMovementRow = {
  line_id: string;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  line_description: string | null;
  entry_id: string;
  entry_number: number | null;
  fiscal_year_code: string | null;
  entry_date: Date;
  source_type: string;
  source_id: string | null;
  description: string | null;
  reference: string | null;
};

/**
 * Mayor de una cuenta: opening balance before `from` (pure running sum of
 * every posted entry, cierre and apertura included — the mayor is the
 * history of the account), movements in [from, to] (inclusive) with running
 * balance, closing balance. Reversed entries and their reversals are listed
 * (they happened) and net to zero.
 *
 * ONE bounded SQL query (fix:ledger t6#13): journal_lines of the account
 * joined to journal_entries with the organisation / property / status / date
 * filters in SQL, ordered `(entry_date, entry_number NULLS LAST, entry id,
 * line id)` and `LIMIT cap + 1` — the diario is never loaded to filter it in
 * memory and no `IN (<every id of the window>)` is sent. `totals` and
 * `closingBalance` are SQL sums over the WHOLE window, so they stay exact
 * when `truncated` is true (the detail is what gets cut, never the balance).
 * `maxMovements` is a test hook (not exposed over HTTP).
 */
export async function getAccountLedger(input: { context: UserContext; accountCode: string; from?: string; to?: string; propertyId?: string; maxMovements?: number }): Promise<AccountLedgerView> {
  requirePermissions(input.context, ["accounting.read"]);
  const organizationId = input.context.organizationId;
  const to = input.to ?? isoDay(new Date());
  requireEntryDate(to);
  if (input.from !== undefined) requireEntryDate(input.from);
  const account = await prisma.account.findUnique({ where: { organizationId_code: { organizationId, code: input.accountCode } } });
  if (!account) throw new NotFoundError(`La cuenta ${input.accountCode} no existe en el plan de la organización.`);
  const cap = Math.max(1, Math.min(input.maxMovements ?? LEDGER_MAX_MOVEMENTS, LEDGER_MAX_MOVEMENTS));

  const [opening, window] = await Promise.all([
    input.from
      ? aggregateAccountBalances({ organizationId, propertyId: input.propertyId, to: previousDay(input.from), accountIds: [account.id], includeReversedPairs: true })
      : Promise.resolve([] as AccountBalanceRow[]),
    aggregateAccountBalances({ organizationId, propertyId: input.propertyId, from: input.from ?? null, to, accountIds: [account.id], includeReversedPairs: true })
  ]);
  const openingBalance = opening[0] ? opening[0].debit.minus(opening[0].credit) : ZERO;
  const totalDebit: Decimal = window[0]?.debit ?? ZERO;
  const totalCredit: Decimal = window[0]?.credit ?? ZERO;

  // `account_code` is the indexed column (journal_lines_account_code_idx); `account_id` is the truth. A legacy
  // line with a null code is still found by its id.
  const conditions: Prisma.Sql[] = [
    Prisma.sql`jl.account_id = ${account.id}`,
    Prisma.sql`(jl.account_code = ${account.code} OR jl.account_code IS NULL)`,
    Prisma.sql`je.organization_id = ${organizationId}`,
    Prisma.sql`je.status <> 'draft'`,
    Prisma.sql`je.entry_date <= ${dateOnlyUtc(to)}::date`
  ];
  if (input.from) conditions.push(Prisma.sql`je.entry_date >= ${dateOnlyUtc(input.from)}::date`);
  if (input.propertyId) conditions.push(Prisma.sql`je.property_id = ${input.propertyId}`);
  const rows = await prisma.$queryRaw<LedgerMovementRow[]>`
    SELECT jl.id AS line_id, jl.debit, jl.credit, jl.description AS line_description,
           je.id AS entry_id, je.entry_number, je.fiscal_year_code, je.entry_date, je.source_type, je.source_id, je.description, je.reference
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY je.entry_date ASC, je.entry_number ASC NULLS LAST, je.id ASC, jl.id ASC
    LIMIT ${cap + 1}`;
  const truncated = rows.length > cap;
  const shown = truncated ? rows.slice(0, cap) : rows;
  let balance = openingBalance;
  const movements: LedgerMovementView[] = shown.map((row) => {
    const debit = new D(row.debit);
    const credit = new D(row.credit);
    balance = balance.plus(debit).minus(credit);
    return {
      journalEntryId: row.entry_id,
      entryNumber: row.entry_number ?? null,
      fiscalYearCode: row.fiscal_year_code ?? null,
      entryDate: isoDay(row.entry_date),
      sourceType: row.source_type,
      sourceId: row.source_id ?? null,
      description: row.line_description ?? row.description ?? null,
      reference: row.reference ?? null,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
      balance: balance.toFixed(2)
    };
  });
  return {
    organizationId,
    propertyId: input.propertyId ?? null,
    accountCode: account.code,
    accountName: account.name,
    kind: String(account.kind),
    from: input.from ?? null,
    to,
    openingBalance: openingBalance.toFixed(2),
    movements,
    totals: { debit: totalDebit.toFixed(2), credit: totalCredit.toFixed(2) },
    closingBalance: openingBalance.plus(totalDebit).minus(totalCredit).toFixed(2),
    truncated
  };
}

export function previousDay(iso: string): string {
  const d = dateOnlyUtc(iso);
  d.setUTCDate(d.getUTCDate() - 1);
  return isoDay(d);
}

export function nextDay(iso: string): string {
  const d = dateOnlyUtc(iso);
  d.setUTCDate(d.getUTCDate() + 1);
  return isoDay(d);
}

// ---------------------------------------------------------------------------
// Aggregation shared by the reports (SQL SUM over numeric — exact)
// ---------------------------------------------------------------------------

export type AccountBalanceRow = {
  accountId: string;
  accountCode: string;
  accountName: string;
  /** Legacy alias (revenue == income) the reports still branch on. */
  accountType: string;
  kind: string;
  debit: Decimal;
  credit: Decimal;
};

export type AggregateBalancesInput = {
  organizationId: string;
  propertyId?: string | null;
  /** Inclusive bounds (YYYY-MM-DD). */
  from?: string | null;
  to?: string | null;
  /** entryKind values to leave out (regularization/closing/opening for the PyG). */
  excludeKinds?: readonly string[];
  /**
   * Balance «as of» semantics: the asiento de cierre dated on/after this day
   * is left out, so the 31/12 picture is the pre-close one (129 with the
   * result) while a later date includes cierre + apertura and lands on the
   * reinstated balances.
   */
  closingCutoff?: string | null;
  /** Reversed entries and their reversals net to zero: left out by default (a reopened close never double counts). */
  includeReversedPairs?: boolean;
  accountIds?: readonly string[];
  /** Restrict to these kinds (income/expense for the PyG). */
  kinds?: readonly string[];
};

/** Σ debit / Σ credit per account over the posted entries of the window — one SQL statement, numeric sums. */
export async function aggregateAccountBalances(input: AggregateBalancesInput): Promise<AccountBalanceRow[]> {
  const conditions: Prisma.Sql[] = [Prisma.sql`je.organization_id = ${input.organizationId}`, Prisma.sql`je.status <> 'draft'`];
  if (!input.includeReversedPairs) conditions.push(Prisma.sql`je.reversed_by_id IS NULL`, Prisma.sql`je.reversal_of_id IS NULL`);
  if (input.propertyId) conditions.push(Prisma.sql`je.property_id = ${input.propertyId}`);
  if (input.from) conditions.push(Prisma.sql`je.entry_date >= ${dateOnlyUtc(input.from)}::date`);
  if (input.to) conditions.push(Prisma.sql`je.entry_date <= ${dateOnlyUtc(input.to)}::date`);
  if (input.excludeKinds && input.excludeKinds.length > 0) conditions.push(Prisma.sql`je.entry_kind <> ALL(${input.excludeKinds as string[]}::text[])`);
  if (input.closingCutoff) conditions.push(Prisma.sql`NOT (je.entry_kind = 'closing' AND je.entry_date >= ${dateOnlyUtc(input.closingCutoff)}::date)`);
  if (input.accountIds && input.accountIds.length > 0) conditions.push(Prisma.sql`jl.account_id = ANY(${input.accountIds as string[]}::text[])`);
  if (input.kinds && input.kinds.length > 0) conditions.push(Prisma.sql`a.kind::text = ANY(${input.kinds as string[]}::text[])`);
  const rows = await prisma.$queryRaw<Array<{ account_id: string; code: string; name: string; account_type: string; kind: string; debit: Prisma.Decimal; credit: Prisma.Decimal }>>`
    SELECT a.id AS account_id, a.code, a.name, a.account_type, a.kind::text AS kind,
           COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE ${Prisma.join(conditions, " AND ")}
    GROUP BY a.id, a.code, a.name, a.account_type, a.kind
    ORDER BY a.code`;
  return rows.map((row) => ({
    accountId: row.account_id,
    accountCode: row.code,
    accountName: row.name,
    accountType: row.account_type,
    kind: row.kind,
    debit: new D(row.debit),
    credit: new D(row.credit)
  }));
}

// ---------------------------------------------------------------------------
// CSV export (diario / mayor) — gestoría-friendly universal layout
// ---------------------------------------------------------------------------

/** `;` separated, comma decimals, UTF-8 BOM; columns fecha;asiento;cuenta;concepto;debe;haber;documento;nif;base;iva. */
export const JOURNAL_CSV_HEADER = ["fecha", "asiento", "cuenta", "concepto", "debe", "haber", "documento", "nif", "base", "iva"] as const;

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function csvMoney(value: MoneyString | null | undefined): string {
  return value ? value.replace(".", ",") : "";
}

export function journalEntriesToCsv(entries: readonly JournalEntryView[]): string {
  const rows: string[] = [JOURNAL_CSV_HEADER.join(";")];
  for (const entry of entries) {
    const number = entry.entryNumber !== null ? `${entry.fiscalYearCode ?? ""}/${entry.entryNumber}` : entry.id;
    for (const line of entry.lines) {
      rows.push(
        [
          csvCell(entry.entryDate),
          csvCell(number),
          csvCell(line.accountCode),
          csvCell(line.description ?? entry.description ?? ""),
          csvMoney(line.debit),
          csvMoney(line.credit),
          csvCell(entry.reference ?? entry.sourceId ?? ""),
          "",
          csvMoney(line.taxBase),
          csvCell(line.taxRateCode ?? "")
        ].join(";")
      );
    }
  }
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}

export function ledgerToCsv(ledger: AccountLedgerView): string {
  const rows: string[] = ["fecha;asiento;cuenta;concepto;debe;haber;saldo;documento"];
  rows.push(`${csvCell(ledger.from ?? "")};;${csvCell(ledger.accountCode)};Saldo inicial;;;${csvMoney(ledger.openingBalance)};`);
  for (const movement of ledger.movements) {
    const number = movement.entryNumber !== null ? `${movement.fiscalYearCode ?? ""}/${movement.entryNumber}` : movement.journalEntryId;
    rows.push(
      [
        csvCell(movement.entryDate),
        csvCell(number),
        csvCell(ledger.accountCode),
        csvCell(movement.description ?? ""),
        csvMoney(movement.debit),
        csvMoney(movement.credit),
        csvMoney(movement.balance),
        csvCell(movement.reference ?? movement.sourceId ?? "")
      ].join(";")
    );
  }
  rows.push(`${csvCell(ledger.to)};;${csvCell(ledger.accountCode)};Saldo final;${csvMoney(ledger.totals.debit)};${csvMoney(ledger.totals.credit)};${csvMoney(ledger.closingBalance)};`);
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}

/** Every entry of a window (for the CSV export): capped at 20 000 entries, oldest first. */
export async function exportJournal(input: { context: UserContext; query: JournalListQuery }): Promise<{ csv: string; entries: number }> {
  requirePermissions(input.context, ["accounting.read"]);
  if (input.query.from !== undefined) requireEntryDate(input.query.from);
  if (input.query.to !== undefined) requireEntryDate(input.query.to);
  const where = journalWhere(input.context.organizationId, input.query);
  where.status = input.query.status ?? { in: REPORT_STATUSES };
  const rows = await prisma.journalEntry.findMany({ where, orderBy: [{ entryDate: "asc" }, { entryNumber: "asc" }, { id: "asc" }], take: 20_000 });
  const entries = await hydrateEntries(prisma, rows);
  return { csv: journalEntriesToCsv(entries), entries: entries.length };
}

// ---------------------------------------------------------------------------
// Chart of accounts (GET/POST/PATCH /accounting/chart)
// ---------------------------------------------------------------------------

type AccountRow = NonNullable<Awaited<ReturnType<typeof prisma.account.findFirst>>>;

function toChartView(row: AccountRow, codeById: Map<string, string>): ChartAccountView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: String(row.kind),
    accountType: row.accountType,
    group: row.group,
    level: row.level,
    isPostable: row.isPostable,
    parentId: row.parentId ?? null,
    parentCode: row.parentId ? codeById.get(row.parentId) ?? null : null,
    usaliDepartment: row.usaliDepartment ?? null,
    usaliLine: row.usaliLine ?? null
  };
}

export async function listChartAccounts(input: { context: UserContext; postableOnly?: boolean }): Promise<{ organizationId: string; chartTemplate: string | null; accounts: ChartAccountView[] }> {
  requirePermissions(input.context, ["accounting.read"]);
  const organizationId = input.context.organizationId;
  const [rows, setting] = await Promise.all([
    prisma.account.findMany({ where: { organizationId }, orderBy: { code: "asc" } }),
    prisma.accountingSetting.findFirst({ where: { organizationId, propertyId: null }, select: { chartTemplate: true } })
  ]);
  if (rows.length === 0) {
    throw ledgerConflict("CHART_NOT_PROVISIONED", "La organización no tiene plan de cuentas: provisiónalo (accounting:provision-chart) o contabiliza un primer asiento.", { organizationId });
  }
  const codeById = new Map(rows.map((row) => [row.id, row.code]));
  const accounts = rows.filter((row) => !input.postableOnly || row.isPostable).map((row) => toChartView(row, codeById));
  return { organizationId, chartTemplate: setting?.chartTemplate ?? null, accounts };
}

function assertUsali(department: string | null | undefined, line: string | null | undefined): { usaliDepartment: string | null; usaliLine: string | null } {
  if (!department && !line) return { usaliDepartment: null, usaliLine: null };
  if (!department || !line) throw ledgerBadRequest("USALI_MAPPING_INCOMPLETE", "usaliDepartment y usaliLine van juntos.");
  const lines = USALI_DEPARTMENT_LINES[department as UsaliDepartment];
  if (!lines) throw ledgerBadRequest("USALI_DEPARTMENT_INVALID", `Departamento USALI desconocido: ${department}.`);
  if (!lines.includes(line as UsaliLine)) throw ledgerBadRequest("USALI_LINE_INVALID", `La línea USALI ${line} no se admite en el departamento ${department}.`);
  return { usaliDepartment: department, usaliLine: line };
}

export async function createChartAccount(input: { context: UserContext; body: ChartAccountCreateInput; correlationId: string }): Promise<ChartAccountView> {
  requirePermissions(input.context, ["accounting.configure"]);
  const organizationId = input.context.organizationId;
  const code = input.body.code?.trim() ?? "";
  if (!ACCOUNT_CODE_PATTERN.test(code)) throw ledgerBadRequest("ACCOUNT_CODE_INVALID", "El código de cuenta debe ser numérico PGC (p. ej. 6291 o 705.5).");
  const name = input.body.name?.trim() ?? "";
  if (name.length < 2 || name.length > 200) throw ledgerBadRequest("ACCOUNT_NAME_INVALID", "El nombre de la cuenta debe tener entre 2 y 200 caracteres.");
  const usali = assertUsali(input.body.usaliDepartment, input.body.usaliLine);

  const existingRows = await prisma.account.findMany({ where: { organizationId }, select: { id: true, code: true, kind: true } });
  if (existingRows.some((row) => row.code === code)) throw ledgerConflict("ACCOUNT_CODE_EXISTS", `La cuenta ${code} ya existe.`, { accountCode: code });
  const byCode = new Map(existingRows.map((row) => [row.code, row]));
  const parentCode = parentCandidates(code).find((candidate) => byCode.has(candidate)) ?? null;
  const parent = parentCode ? byCode.get(parentCode)! : null;
  const kind: AccountKind | null = input.body.kind ?? (parent ? (String(parent.kind) as AccountKind) : null);
  if (!kind) throw ledgerBadRequest("ACCOUNT_KIND_REQUIRED", "Indica la naturaleza (kind) de la cuenta: no hay cuenta padre de la que heredarla.");
  if (parent && input.body.kind && String(parent.kind) !== input.body.kind) {
    throw ledgerBadRequest("ACCOUNT_KIND_MISMATCH", `La naturaleza ${input.body.kind} no coincide con la de la cuenta padre ${parentCode} (${String(parent.kind)}).`);
  }
  const created = await prisma.account.create({
    data: {
      organizationId,
      code,
      name,
      kind,
      accountType: legacyAccountType(kind),
      group: accountGroup(code),
      level: accountLevel(code),
      isPostable: input.body.isPostable ?? isPostableCode(code),
      parentId: parent?.id ?? null,
      ...usali
    }
  });
  recordAuditEvent({
    organizationId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ACCOUNT_CREATED",
    entityType: "account",
    entityId: created.id,
    afterJson: { code, name, kind, parentCode, ...usali },
    correlationId: input.correlationId
  });
  return toChartView(created, new Map(existingRows.map((row) => [row.id, row.code])));
}

export async function patchChartAccount(input: { context: UserContext; code: string; body: ChartAccountPatchInput; correlationId: string }): Promise<ChartAccountView> {
  requirePermissions(input.context, ["accounting.configure"]);
  const organizationId = input.context.organizationId;
  const row = await prisma.account.findUnique({ where: { organizationId_code: { organizationId, code: input.code } } });
  if (!row) throw new NotFoundError(`La cuenta ${input.code} no existe en el plan de la organización.`);
  const data: Prisma.AccountUpdateInput = {};
  if (input.body.name !== undefined) {
    const name = input.body.name.trim();
    if (name.length < 2 || name.length > 200) throw ledgerBadRequest("ACCOUNT_NAME_INVALID", "El nombre de la cuenta debe tener entre 2 y 200 caracteres.");
    data.name = name;
  }
  if (input.body.usaliDepartment !== undefined || input.body.usaliLine !== undefined) {
    const usali = assertUsali(input.body.usaliDepartment ?? row.usaliDepartment, input.body.usaliLine ?? row.usaliLine);
    if (input.body.usaliDepartment === null && input.body.usaliLine === null) {
      data.usaliDepartment = null;
      data.usaliLine = null;
    } else {
      data.usaliDepartment = usali.usaliDepartment;
      data.usaliLine = usali.usaliLine;
    }
  }
  if (input.body.isPostable !== undefined && input.body.isPostable !== row.isPostable) {
    if (!input.body.isPostable) {
      const used = await prisma.journalLine.count({ where: { accountId: row.id } });
      if (used > 0) throw ledgerConflict("ACCOUNT_HAS_ENTRIES", `La cuenta ${row.code} tiene ${used} apuntes: no puede convertirse en cabecera.`, { accountCode: row.code, lines: used });
    }
    data.isPostable = input.body.isPostable;
  }
  if (Object.keys(data).length === 0) throw ledgerBadRequest("ACCOUNT_PATCH_EMPTY", "No hay ningún cambio que aplicar.");
  const updated = await prisma.account.update({ where: { id: row.id }, data });
  recordAuditEvent({
    organizationId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ACCOUNT_UPDATED",
    entityType: "account",
    entityId: row.id,
    beforeJson: { name: row.name, isPostable: row.isPostable, usaliDepartment: row.usaliDepartment, usaliLine: row.usaliLine },
    afterJson: data,
    correlationId: input.correlationId
  });
  const parentCode = updated.parentId ? (await prisma.account.findUnique({ where: { id: updated.parentId }, select: { code: true } }))?.code ?? null : null;
  return toChartView(updated, new Map(updated.parentId && parentCode ? [[updated.parentId, parentCode]] : []));
}

// ---------------------------------------------------------------------------
// Settings (GET/PATCH /accounting/settings)
// ---------------------------------------------------------------------------

export async function getAccountingSettings(input: { context: UserContext }): Promise<AccountingSettingsView> {
  requirePermissions(input.context, ["accounting.read"]);
  const organizationId = input.context.organizationId;
  const [setting, vat, accountCount] = await Promise.all([
    prisma.accountingSetting.findFirst({ where: { organizationId, propertyId: null }, orderBy: { updatedAt: "asc" } }),
    prisma.vatSettings.findUnique({ where: { organizationId } }),
    prisma.account.count({ where: { organizationId } })
  ]);
  return {
    organizationId,
    chartTemplate: setting?.chartTemplate ?? null,
    chartProvisioned: setting?.chartTemplate === CHART_TEMPLATE_CODE && accountCount > 0,
    accountCount,
    fiscalYearStartMonth: setting?.fiscalYearStartMonth ?? 1,
    vat: {
      periodicity: vat?.periodicity ?? "quarterly",
      regime: vat?.regime ?? "general",
      prorrataPct: vat?.prorrataPct ? new D(vat.prorrataPct).toFixed(2) : null,
      taxFigure: vat?.taxFigure ?? "IVA",
      persisted: vat !== null
    }
  };
}

export async function updateAccountingSettings(input: { context: UserContext; body: AccountingSettingsPatchInput; correlationId: string }): Promise<AccountingSettingsView> {
  requirePermissions(input.context, ["accounting.configure"]);
  const organizationId = input.context.organizationId;
  const body = input.body;
  const before = await getAccountingSettings({ context: input.context });
  await prisma.$transaction(async (tx) => {
    if (body.fiscalYearStartMonth !== undefined) {
      const setting = await tx.accountingSetting.findFirst({ where: { organizationId, propertyId: null }, orderBy: { updatedAt: "asc" }, select: { id: true } });
      if (setting) await tx.accountingSetting.update({ where: { id: setting.id }, data: { fiscalYearStartMonth: body.fiscalYearStartMonth } });
      else await tx.accountingSetting.create({ data: { organizationId, propertyId: null, fiscalYearStartMonth: body.fiscalYearStartMonth } });
    }
    if (body.vatPeriodicity !== undefined || body.vatRegime !== undefined || body.prorrataPct !== undefined || body.taxFigure !== undefined) {
      const prorrata = body.prorrataPct === undefined ? undefined : body.prorrataPct === null ? null : money(body.prorrataPct, "porcentaje de prorrata").toFixed(2);
      if (prorrata !== undefined && prorrata !== null && (new D(prorrata).lessThan(0) || new D(prorrata).greaterThan(100))) {
        throw ledgerBadRequest("PRORRATA_INVALID", "La prorrata debe estar entre 0 y 100.");
      }
      const data = {
        ...(body.vatPeriodicity !== undefined ? { periodicity: body.vatPeriodicity } : {}),
        ...(body.vatRegime !== undefined ? { regime: body.vatRegime } : {}),
        ...(prorrata !== undefined ? { prorrataPct: prorrata } : {}),
        ...(body.taxFigure !== undefined ? { taxFigure: body.taxFigure } : {})
      };
      await tx.vatSettings.upsert({ where: { organizationId }, create: { organizationId, ...data }, update: data });
    }
  });
  const after = await getAccountingSettings({ context: input.context });
  recordAuditEvent({
    organizationId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "ACCOUNTING_SETTINGS_UPDATED",
    entityType: "organization",
    entityId: organizationId,
    beforeJson: before,
    afterJson: after,
    correlationId: input.correlationId
  });
  return after;
}

// ---------------------------------------------------------------------------
// Legacy surface (server.ts): drafts, listing, static chart, supplier bills
// ---------------------------------------------------------------------------

export type JournalLineDraft = {
  accountCode: string;
  debit: number;
  credit: number;
  description?: string;
};

export type JournalEntryDraft = {
  id: string;
  organizationId: string;
  propertyId?: string;
  sourceType: string;
  sourceId?: string;
  status: "draft" | "posted" | "reversed";
  entryDate?: string;
  entryNumber?: number | null;
  fiscalYearCode?: string | null;
  description?: string | null;
  reference?: string | null;
  lines: JournalLineDraft[];
};

export type AccountTemplate = {
  code: string;
  name: string;
  accountType: "asset" | "liability" | "equity" | "revenue" | "expense";
};

/**
 * @deprecated The organisation chart is the only chart (GET /accounting/chart).
 * Kept for `GET /organizations/:id/accounts`, whose fallback must become a 409
 * CHART_NOT_PROVISIONED (handoff): meanwhile it returns the postable accounts
 * of the «PGC Pymes hotelero» template instead of the old 7 fake rows.
 */
export function listAccounts(): AccountTemplate[] {
  return PGC_PYMES_HOTEL_TEMPLATE.filter((account) => isPostableCode(account.code)).map((account) => ({
    code: account.code,
    name: account.name,
    accountType: legacyAccountType(account.kind)
  }));
}

function toDraftView(view: JournalEntryView): JournalEntryDraft {
  return {
    id: view.id,
    organizationId: view.organizationId,
    propertyId: view.propertyId ?? undefined,
    sourceType: view.sourceType,
    sourceId: view.sourceId ?? undefined,
    status: view.status,
    entryDate: view.entryDate,
    entryNumber: view.entryNumber,
    fiscalYearCode: view.fiscalYearCode,
    description: view.description,
    reference: view.reference,
    lines: view.lines.map((line) => ({
      accountCode: line.accountCode,
      debit: Number(line.debit),
      credit: Number(line.credit),
      description: line.description ?? undefined
    }))
  };
}

/** @deprecated Use listJournal (paginated, filters). Newest 500 entries of the organisation. */
export async function listJournalEntries(organizationId: string): Promise<JournalEntryDraft[]> {
  const entries = await prisma.journalEntry.findMany({ where: { organizationId }, orderBy: [{ entryDate: "desc" }, { id: "desc" }], take: 500 });
  const views = await hydrateEntries(prisma, entries);
  return views.map(toDraftView);
}

/**
 * Draft entry (status draft, not numbered). Kept for POST /journal-entries/drafts;
 * the ledger routes post directly (POST /accounting/journal). The draft is
 * validated like a posted entry (balance, existing postable accounts).
 */
export async function createJournalEntryDraft(input: {
  organizationId: string;
  propertyId?: string;
  sourceType: string;
  sourceId?: string;
  entryDate?: string;
  description?: string;
  reference?: string;
  lines: JournalLineDraft[];
}): Promise<JournalEntryDraft> {
  const normalized = normalizeJournalLines(input.lines ?? []);
  const entryDate = input.entryDate ? requireEntryDate(input.entryDate) : isoDay(new Date());
  // R10.1: a draft on a foreign centre could never be posted either — same opaque 404 as the engine.
  await requireJournalWorkCenter(prisma, input.organizationId, input.propertyId);
  // A draft dated in a closed year / period could never be posted: refuse it up front with the same codes.
  await assertEntryDateOpen(input.organizationId, input.propertyId, entryDate, await resolveFiscalYear(prisma, input.organizationId, input.propertyId, entryDate));
  const accounts = await resolvePostableAccounts(prisma, input.organizationId, normalized.lines.map((l) => l.accountCode));
  const created = await prisma.$transaction(async (tx) => {
    const entry = await tx.journalEntry.create({
      data: {
        organizationId: input.organizationId,
        propertyId: input.propertyId ?? null,
        sourceType: input.sourceType || "manual",
        sourceId: input.sourceId ?? `manual:${createId("je")}`,
        status: "draft",
        entryDate: dateOnlyUtc(entryDate),
        description: input.description?.slice(0, 500) ?? null,
        reference: input.reference?.slice(0, 200) ?? null
      }
    });
    await tx.journalLine.createMany({
      data: normalized.lines.map((line) => ({
        journalEntryId: entry.id,
        accountId: accounts.get(line.accountCode)!.id,
        accountCode: line.accountCode,
        debit: line.debit.toFixed(2),
        credit: line.credit.toFixed(2),
        currency: "EUR",
        description: line.description
      }))
    });
    return entry.id;
  });
  const view = await loadJournalEntry(prisma, created);
  return toDraftView(view!);
}

/** Legacy draft posting: numbers the draft under the same lock and flips it to posted. */
async function postDraftJournalEntry(input: LegacyPostDraftInput): Promise<JournalEntryDraft> {
  requirePermissions(input.context, ["accounting.journal.post", "ai.high_risk.confirm"]);
  const entry = await prisma.journalEntry.findUnique({ where: { id: input.journalEntryId } });
  // Opaque 404 for a draft of another organisation (service-level, like reverseJournalEntry: the route hook is not the only guard).
  if (!entry || entry.organizationId !== input.context.organizationId) throw ledgerNotFound("JOURNAL_ENTRY_NOT_FOUND", "Asiento no encontrado.", { journalEntryId: input.journalEntryId });
  if (entry.status !== "draft") {
    const view = await loadJournalEntry(prisma, entry.id);
    return toDraftView(view!);
  }
  const lines = await prisma.journalLine.findMany({ where: { journalEntryId: entry.id } });
  assertBalancedJournal(lines.map((l) => ({ accountCode: l.accountCode ?? l.accountId, debit: Number(l.debit), credit: Number(l.credit) })));
  // R10.1: a draft created before the centre check could still point at a foreign centre.
  await requireJournalWorkCenter(prisma, entry.organizationId, entry.propertyId);
  // R4 also applies to the legacy draft flow (a draft carries no societyLevel flag).
  assertWorkCenter({ propertyId: entry.propertyId, entryKind: entry.entryKind, sourceType: entry.sourceType, lines: lines.map((l) => ({ accountCode: l.accountCode ?? "" })) });
  const entryDate = isoDay(entry.entryDate);
  await assertEntryDateOpen(entry.organizationId, entry.propertyId, entryDate, await resolveFiscalYear(prisma, entry.organizationId, entry.propertyId, entryDate));
  const updated = await prisma.$transaction(async (tx) => {
    const fiscalYear = await resolveFiscalYear(tx, entry.organizationId, entry.propertyId, entryDate);
    await acquireNumberingLock(tx, entry.organizationId, fiscalYear.code);
    const entryNumber = await nextEntryNumber(tx, entry.organizationId, fiscalYear.code);
    const accounts = await tx.account.findMany({ where: { id: { in: lines.map((l) => l.accountId) } }, select: { id: true, code: true } });
    for (const line of lines) {
      if (!line.accountCode) {
        await tx.journalLine.update({ where: { id: line.id }, data: { accountCode: accounts.find((a) => a.id === line.accountId)?.code ?? null } });
      }
    }
    return tx.journalEntry.update({
      where: { id: entry.id },
      data: { status: "posted", postedAt: new Date(), entryNumber, fiscalYearCode: fiscalYear.code, fiscalYearId: entry.fiscalYearId ?? fiscalYear.id, createdBy: entry.createdBy ?? input.context.userId }
    });
  }, TX_OPTIONS);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "JOURNAL_ENTRY_POSTED",
    entityType: "journal_entry",
    entityId: entry.id,
    beforeJson: { status: entry.status },
    afterJson: { status: updated.status, entryNumber: updated.entryNumber, fiscalYearCode: updated.fiscalYearCode },
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    entityType: "journal_entry",
    entityId: entry.id,
    eventType: "JournalEntryPosted",
    payload: { sourceType: updated.sourceType, sourceId: updated.sourceId, entryNumber: updated.entryNumber, fiscalYearCode: updated.fiscalYearCode },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });
  const view = await loadJournalEntry(prisma, entry.id);
  return toDraftView(view!);
}

// ---- Supplier bill drafts (legacy; the proveedores lot replaces this flow) ----

export type SupplierBillDraft = {
  id: string;
  propertyId: string;
  supplierName: string;
  supplierTaxId?: string;
  invoiceNumber?: string;
  issueDate?: string;
  dueDate?: string;
  total: number;
  taxTotal: number;
  status: "draft" | "approved" | "posted" | "paid" | "cancelled";
  documentObjectKey?: string;
  suggestedAccountCode?: string;
  roomId?: string;
  // IRPF retention (e.g. professional services from an autónomo).
  // `retentionRate` is the % withheld (15 means 15%).
  // `retentionAmount` is the EUR figure withheld and posted to cuenta 4751.
  // `rowCode` is the Modelo 111 row (default "02" profesionales).
  retentionRate?: number;
  retentionAmount?: number;
  rowCode?: string;
  paymentDate?: string;
};

function isoDateString(value: Date | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.toISOString().slice(0, 10);
}

function parseDateInput(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00.000Z`);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

type PrismaSupplierBillRow = NonNullable<Awaited<ReturnType<typeof prisma.supplierBill.findFirst>>>;

function hydrateBill(row: PrismaSupplierBillRow): SupplierBillDraft {
  return {
    id: row.id,
    propertyId: row.propertyId,
    supplierName: row.supplierName ?? row.supplierId ?? "Proveedor desconocido",
    supplierTaxId: row.supplierTaxId ?? undefined,
    invoiceNumber: row.invoiceNumber ?? undefined,
    issueDate: isoDateString(row.issueDate),
    dueDate: isoDateString(row.dueDate),
    total: Number(row.total),
    taxTotal: Number(row.taxTotal),
    status: row.status,
    documentObjectKey: row.documentObjectKey ?? undefined,
    suggestedAccountCode: row.suggestedAccountCode ?? undefined,
    roomId: row.roomId ?? undefined,
    retentionRate: row.retentionRate === null || row.retentionRate === undefined ? undefined : Number(row.retentionRate),
    retentionAmount: row.retentionAmount === null || row.retentionAmount === undefined ? undefined : Number(row.retentionAmount),
    rowCode: row.rowCode ?? undefined,
    paymentDate: isoDateString(row.paymentDate)
  };
}

/**
 * Legacy draft (POST /supplier-bills/drafts). The draft is NOT posted to the
 * ledger (a draft is not an accounting event): the proveedores lot posts at
 * «posted» through posting-rules.buildSupplierBillEntry. The
 * SupplierBillCreated event still feeds the Modelo 111 withholding projection.
 */
export async function createSupplierBillDraft(input: {
  context: UserContext;
  supplierName: string;
  supplierTaxId?: string;
  invoiceNumber?: string;
  issueDate?: string;
  dueDate?: string;
  total: number;
  taxTotal: number;
  documentObjectKey?: string;
  suggestedAccountCode?: string;
  roomId?: string;
  retentionRate?: number;
  retentionAmount?: number;
  rowCode?: string;
  paymentDate?: string;
  correlationId: string;
}): Promise<SupplierBillDraft> {
  // Withholding base = net excluding IVA (total − taxTotal), the AEAT-correct base for professionals.
  const grossBase = Math.max(0, input.total - input.taxTotal);
  const retentionRate = input.retentionRate ?? 0;
  let retentionAmount = input.retentionAmount ?? 0;
  if (retentionRate > 0 && retentionAmount === 0 && grossBase > 0) {
    const ratePct = retentionRate >= 1 ? retentionRate / 100 : retentionRate;
    retentionAmount = Math.round(grossBase * ratePct * 100) / 100;
  }
  const suggestedAccountCode = input.suggestedAccountCode ?? "622";
  const property = await prisma.property.findUnique({ where: { id: input.context.propertyId }, select: { organizationId: true } });
  const row = await prisma.supplierBill.create({
    data: {
      id: createId("sb"),
      propertyId: input.context.propertyId,
      organizationId: property?.organizationId ?? input.context.organizationId,
      supplierId: null,
      supplierName: input.supplierName,
      supplierTaxId: input.supplierTaxId ?? null,
      invoiceNumber: input.invoiceNumber ?? null,
      issueDate: parseDateInput(input.issueDate) ?? null,
      dueDate: parseDateInput(input.dueDate) ?? null,
      paymentDate: parseDateInput(input.paymentDate) ?? null,
      total: moneyString(input.total),
      taxTotal: moneyString(input.taxTotal),
      baseTotal: moneyString(grossBase),
      retentionRate: retentionRate > 0 ? retentionRate.toString() : null,
      retentionAmount: retentionAmount > 0 ? moneyString(retentionAmount) : null,
      rowCode: input.rowCode ?? null,
      suggestedAccountCode,
      roomId: input.roomId ?? null,
      status: "draft",
      documentObjectKey: input.documentObjectKey ?? null
    }
  });
  const bill = hydrateBill(row);

  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "SUPPLIER_BILL_DRAFT_CREATED",
    entityType: "supplier_bill",
    entityId: bill.id,
    afterJson: bill,
    correlationId: input.correlationId
  });

  recordDomainEvent({
    organizationId: input.context.organizationId,
    propertyId: input.context.propertyId,
    entityType: "supplier_bill",
    entityId: bill.id,
    eventType: "SupplierBillCreated",
    payload: {
      supplierName: bill.supplierName,
      supplierTaxId: bill.supplierTaxId,
      total: bill.total,
      taxTotal: bill.taxTotal,
      grossAmount: grossBase,
      suggestedAccountCode: bill.suggestedAccountCode ?? suggestedAccountCode,
      status: bill.status,
      // Carried so the withholding-tax posting rule projects a WithholdingTaxRecord (Modelo 111).
      retentionRate: bill.retentionRate ?? 0,
      retentionAmount: bill.retentionAmount ?? 0,
      rowCode: bill.rowCode ?? "02",
      paymentDate: bill.paymentDate ?? input.issueDate
    },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return bill;
}

export async function listSupplierBills(propertyId: string): Promise<SupplierBillDraft[]> {
  const rows = await prisma.supplierBill.findMany({ where: { propertyId }, orderBy: { issueDate: "desc" } });
  return rows.map((row) => hydrateBill(row));
}
