import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import { LEDGER_IMPORT_SOURCE_TYPES } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { isIsoDate } from "../../lib/query-dates.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { ZERO, aggregateAccountBalances, dateOnlyUtc, isoDay, nextDay, postJournalEntry, reverseJournalEntry, type AccountBalanceRow } from "./accounting.service.js";
import { buildClosingEntry, buildOpeningEntry, buildRegularizationEntry, RESULT_ACCOUNT, type YearBalance } from "./posting-rules.js";
import { assertEntityScopedFiscalInput } from "./fiscal-period.service.js";

// ---------------------------------------------------------------------------
// Spanish PGC year-end close (canonical rule «Regularización» of the runbook §2)
// ---------------------------------------------------------------------------
//
// Three asientos through the ledger engine (numbered, dated, marked):
//   1) Regularización (entryKind regularization, fecha = último día):
//      6xx → 129 ← 7xx — the net on 129 is the result of the year.
//   2) Cierre (closing, same date): every balance-sheet account (129 with
//      the result included) to zero with its inverse.
//   3) Apertura (opening, first day of the NEXT year, stamped with that
//      year's fiscalYearId): the closing lines with their sides swapped.
// Balances come from the diario by FECHA CONTABLE (entryDate, inclusive),
// never by postedAt. Reopening REVERSES the three asientos (reversalOfId /
// reversedById, entryKind reversal) — nothing is deleted — so a later close
// starts clean and the trail keeps both.
// Rolling 129 into reservas (113) is a separate manual asiento by design.
//
// Ámbito (Tanda 6b · L4, design §5.2 R1/R4): the ejercicio is the sociedad's.
// `propertyId` on GET/POST /accounting/fiscal-years → 400
// FISCAL_YEAR_IS_ENTITY_SCOPED (assertEntityScopedFiscalInput); a per-hotel
// year would regularise a partial 6/7 against the same 129. The close itself
// posts regularización / cierre / apertura without a centre (entryKind exempt
// from WORK_CENTER_REQUIRED). Legacy property-scoped rows (0 in the local
// database) stay readable through `loadYear`.
//
// Cierre importado (Tanda 7c · L2, design §5.3 / §10.4.2 #3): cuando el cierre
// del ejercicio viene de Sage 200 (lote `journal` con regularization + closing,
// o lote `balances`), el importador contabiliza ESOS asientos y llama a
// `markFiscalYearClosedFromImport` (status closed sin generar asientos propios).
// `reopenFiscalYear` no reabre un ejercicio cerrado así: postJournalEntry fija
// fiscalYearId y entryKind en todo asiento (accounting.service.ts:648), de modo
// que la búsqueda de closeEntries alcanzaría los cierres importados y los
// reversaría a medias (sin tocar el lote). Responde 409
// FISCAL_YEAR_CLOSED_FROM_IMPORT { fiscalYearId, importId }: reabrir = revertir
// el lote (`reverseLedgerImport` devuelve el ejercicio a open).

export type FiscalYearStatus = "open" | "closing" | "closed";

export type FiscalYearRecord = {
  id: string;
  organizationId: string;
  propertyId?: string;
  code: string;
  startDate: string;
  endDate: string;
  status: FiscalYearStatus;
  closedAt?: string;
  closingEntryId?: string;
  openingEntryId?: string;
  netResult?: number;
  createdAt: string;
  updatedAt: string;
};

export type FiscalYearStatusReport = FiscalYearRecord & {
  openPeriods: number;
  draftJournals: number;
  hasOpenJournals: boolean;
  blockingChecks: Array<{ code: string; message: string; severity: "error" | "warn" }>;
  netResultPreview?: number;
  regularizationLinePreview?: Array<{
    accountCode: string;
    accountName: string;
    accountType: string;
    debit: number;
    credit: number;
  }>;
};

export type CloseFiscalYearResult = {
  fiscalYear: FiscalYearRecord;
  /** null when the year had no P&L movement (nothing to regularise). */
  regularizationEntryId: string | null;
  closingEntryId: string;
  openingEntryId: string;
  nextFiscalYearId?: string;
  netResult: number;
  followUps: string[];
};

const RESULT_ACCOUNT_CODE = RESULT_ACCOUNT;
const RESULT_ACCOUNT_NAME = "Resultado del ejercicio";

type FiscalYearRow = NonNullable<Awaited<ReturnType<typeof prisma.fiscalYear.findUnique>>>;

function mapYear(row: FiscalYearRow): FiscalYearRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    propertyId: row.propertyId ?? undefined,
    code: row.code,
    startDate: isoDay(row.startDate),
    endDate: isoDay(row.endDate),
    status: row.status as FiscalYearStatus,
    closedAt: row.closedAt?.toISOString(),
    closingEntryId: row.closingEntryId ?? undefined,
    openingEntryId: row.openingEntryId ?? undefined,
    netResult: row.netResult != null ? Number(row.netResult) : undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function yearConflict(code: string, message: string, extra: Record<string, unknown> = {}): ConflictError {
  return new ConflictError(message, { ...extra, code });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listFiscalYears(input: {
  context: UserContext;
  propertyId?: string;
}): Promise<FiscalYearRecord[]> {
  assertEntityScopedFiscalInput(input.propertyId, "ejercicio");
  const rows = await prisma.fiscalYear.findMany({
    where: {
      organizationId: input.context.organizationId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {})
    },
    orderBy: { startDate: "desc" }
  });
  return rows.map(mapYear);
}

export async function createFiscalYear(input: {
  context: UserContext;
  propertyId?: string;
  code: string;
  startDate: string;
  endDate: string;
  correlationId: string;
}): Promise<FiscalYearRecord> {
  requirePermissions(input.context, ["accounting.journal.post"]);
  assertEntityScopedFiscalInput(input.propertyId, "ejercicio");
  if (!isIsoDate(input.startDate) || !isIsoDate(input.endDate)) throw new BadRequestError("startDate y endDate deben ser fechas YYYY-MM-DD.");
  if (input.startDate >= input.endDate) throw new BadRequestError("startDate debe ser anterior a endDate.");
  if (!input.code || input.code.length > 16) throw new BadRequestError("code es obligatorio (máximo 16 caracteres).");
  const overlapping = await prisma.fiscalYear.findFirst({
    where: {
      organizationId: input.context.organizationId,
      propertyId: input.propertyId ?? null,
      startDate: { lte: dateOnlyUtc(input.endDate) },
      endDate: { gte: dateOnlyUtc(input.startDate) }
    },
    select: { code: true }
  });
  if (overlapping) throw yearConflict("FISCAL_YEAR_OVERLAP", `El ejercicio se solapa con ${overlapping.code}.`, { yearCode: overlapping.code });
  const created = await prisma.fiscalYear.create({
    data: {
      organizationId: input.context.organizationId,
      propertyId: input.propertyId ?? null,
      code: input.code,
      startDate: dateOnlyUtc(input.startDate),
      endDate: dateOnlyUtc(input.endDate),
      status: "open"
    }
  });
  recordAuditEvent({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "FISCAL_YEAR_OPENED",
    entityType: "fiscal_year",
    entityId: created.id,
    afterJson: { code: input.code, startDate: input.startDate, endDate: input.endDate },
    correlationId: input.correlationId
  });
  return mapYear(created);
}

async function loadYear(context: UserContext, id: string): Promise<FiscalYearRow> {
  const year = await prisma.fiscalYear.findUnique({ where: { id } });
  if (!year || year.organizationId !== context.organizationId) throw new NotFoundError("Ejercicio fiscal no encontrado.");
  return year;
}

export async function getFiscalYearStatus(input: {
  context: UserContext;
  id: string;
}): Promise<FiscalYearStatusReport> {
  const year = await loadYear(input.context, input.id);
  const [openPeriods, draftJournals] = await Promise.all([
    prisma.fiscalPeriod.count({
      where: {
        organizationId: year.organizationId,
        ...(year.propertyId ? { propertyId: year.propertyId } : {}),
        startDate: { gte: year.startDate },
        endDate: { lte: year.endDate },
        status: { not: "closed" }
      }
    }),
    prisma.journalEntry.count({
      where: {
        organizationId: year.organizationId,
        ...(year.propertyId ? { propertyId: year.propertyId } : {}),
        status: "draft",
        entryDate: { gte: year.startDate, lte: year.endDate }
      }
    })
  ]);

  const preview = await previewRegularization(year);

  const blockingChecks: FiscalYearStatusReport["blockingChecks"] = [];
  if (year.status === "closed") {
    blockingChecks.push({ code: "ALREADY_CLOSED", message: `El ejercicio ${year.code} ya está cerrado.`, severity: "error" });
  }
  if (openPeriods > 0) {
    blockingChecks.push({ code: "OPEN_PERIODS", message: `${openPeriods} periodo(s) fiscal(es) de ${year.code} siguen abiertos.`, severity: "error" });
  }
  if (draftJournals > 0) {
    blockingChecks.push({ code: "DRAFT_JOURNALS", message: `Hay ${draftJournals} asiento(s) en borrador dentro de ${year.code}.`, severity: "error" });
  }
  if (preview.missingResultAccount) {
    blockingChecks.push({
      code: "MISSING_ACCOUNT_129",
      message: `La cuenta ${RESULT_ACCOUNT_CODE} «${RESULT_ACCOUNT_NAME}» no existe en el plan de cuentas: provisiónalo antes de cerrar.`,
      severity: "error"
    });
  }

  return {
    ...mapYear(year),
    openPeriods,
    draftJournals,
    hasOpenJournals: draftJournals > 0,
    blockingChecks,
    netResultPreview: preview.netResult,
    regularizationLinePreview: preview.lines
  };
}

// ---------------------------------------------------------------------------
// Balances by fecha contable
// ---------------------------------------------------------------------------

/** Balances of every account with movement in the year (normal + reversal entries; never the close itself). */
async function balancesForYear(year: FiscalYearRow): Promise<AccountBalanceRow[]> {
  return aggregateAccountBalances({
    organizationId: year.organizationId,
    propertyId: year.propertyId,
    from: isoDay(year.startDate),
    to: isoDay(year.endDate),
    excludeKinds: ["regularization", "closing"]
  });
}

function toYearBalances(rows: AccountBalanceRow[]): YearBalance[] {
  return rows.map((row) => ({ accountCode: row.accountCode, accountName: row.accountName, kind: row.kind, debit: row.debit, credit: row.credit }));
}

type PreviewResult = {
  netResult: number;
  lines: FiscalYearStatusReport["regularizationLinePreview"];
  missingResultAccount: boolean;
};

async function previewRegularization(year: FiscalYearRow): Promise<PreviewResult> {
  const rows = await balancesForYear(year);
  const resultAccount = await prisma.account.findUnique({
    where: { organizationId_code: { organizationId: year.organizationId, code: RESULT_ACCOUNT_CODE } },
    select: { id: true, name: true }
  });
  const regularization = buildRegularizationEntry({
    organizationId: year.organizationId,
    propertyId: year.propertyId,
    fiscalYearId: year.id,
    yearCode: year.code,
    entryDate: isoDay(year.endDate),
    balances: toYearBalances(rows)
  });
  const nameByCode = new Map(rows.map((row) => [row.accountCode, { name: row.accountName, type: row.accountType }]));
  return {
    netResult: Number(regularization.netResult.toFixed(2)),
    lines: regularization.lines.map((line) => ({
      accountCode: line.accountCode,
      accountName: line.accountCode === RESULT_ACCOUNT_CODE ? resultAccount?.name ?? RESULT_ACCOUNT_NAME : nameByCode.get(line.accountCode)?.name ?? "",
      accountType: line.accountCode === RESULT_ACCOUNT_CODE ? "equity" : nameByCode.get(line.accountCode)?.type ?? "",
      debit: Number(line.debit),
      credit: Number(line.credit)
    })),
    missingResultAccount: !resultAccount
  };
}

// ---------------------------------------------------------------------------
// Close orchestration
// ---------------------------------------------------------------------------

export async function closeFiscalYear(input: {
  context: UserContext;
  id: string;
  correlationId: string;
  createNextYear?: boolean;
}): Promise<CloseFiscalYearResult> {
  // Tanda 8a (RBAC · L2, design §4.6): the year close is accounting.period.close
  // (dirección financiera) + the high-risk confirmation; reopening is unchanged.
  requirePermissions(input.context, ["accounting.period.close", "ai.high_risk.confirm"]);

  const year = await loadYear(input.context, input.id);
  if (year.status === "closed") throw yearConflict("FISCAL_YEAR_ALREADY_CLOSED", `El ejercicio ${year.code} ya está cerrado.`, { yearCode: year.code });
  // Tanda 7c: el cierre de Sage 200 ya importado (regularización / cierre `sage200_journal` o `sage200_balance`
  // vivos, aunque el ejercicio siga `open` porque llegó antes que «ejercicios») no se vuelve a generar: cerrar
  // = importar «ejercicios» (marca el ejercicio cerrado con esos asientos) o revertir el lote y cerrar aquí.
  const importedClose = await prisma.journalEntry.findFirst({
    where: {
      organizationId: year.organizationId,
      status: { not: "draft" },
      reversedById: null,
      sourceType: { in: [LEDGER_IMPORT_SOURCE_TYPES.journal, LEDGER_IMPORT_SOURCE_TYPES.balance] },
      entryKind: { in: ["regularization", "closing"] },
      OR: [{ fiscalYearId: year.id }, { fiscalYearCode: year.code, entryDate: { gte: year.startDate, lte: year.endDate } }]
    },
    select: { id: true }
  });
  if (importedClose) {
    const importEntry = await prisma.ledgerImportEntry.findFirst({ where: { journalEntryId: importedClose.id }, select: { importId: true } });
    throw yearConflict("FISCAL_YEAR_CLOSED_FROM_IMPORT", `El ejercicio ${year.code} ya tiene la regularización o el cierre importados de Sage 200: cerrarlo aquí los duplicaría. Importa «ejercicios» para marcarlo cerrado o revierte el lote ${importEntry?.importId ?? ""}.`, {
      fiscalYearId: year.id,
      yearCode: year.code,
      importId: importEntry?.importId ?? null,
      journalEntryId: importedClose.id
    });
  }

  const openPeriodCount = await prisma.fiscalPeriod.count({
    where: {
      organizationId: year.organizationId,
      ...(year.propertyId ? { propertyId: year.propertyId } : {}),
      startDate: { gte: year.startDate },
      endDate: { lte: year.endDate },
      status: { not: "closed" }
    }
  });
  if (openPeriodCount > 0) {
    throw yearConflict("FISCAL_YEAR_OPEN_PERIODS", `No se puede cerrar ${year.code}: ${openPeriodCount} periodo(s) fiscal(es) siguen abiertos.`, { openPeriods: openPeriodCount });
  }
  const draftCount = await prisma.journalEntry.count({
    where: {
      organizationId: year.organizationId,
      ...(year.propertyId ? { propertyId: year.propertyId } : {}),
      status: "draft",
      entryDate: { gte: year.startDate, lte: year.endDate }
    }
  });
  if (draftCount > 0) {
    throw yearConflict("FISCAL_YEAR_DRAFT_JOURNALS", `No se puede cerrar ${year.code}: hay ${draftCount} asiento(s) en borrador dentro del ejercicio.`, { drafts: draftCount });
  }
  const resultAccount = await prisma.account.findUnique({
    where: { organizationId_code: { organizationId: year.organizationId, code: RESULT_ACCOUNT_CODE } },
    select: { id: true }
  });
  if (!resultAccount) {
    throw yearConflict("MISSING_ACCOUNT_129", `La cuenta ${RESULT_ACCOUNT_CODE} «${RESULT_ACCOUNT_NAME}» no existe en el plan de cuentas de la organización: provisiónalo antes de cerrar.`);
  }

  const balances = toYearBalances(await balancesForYear(year));
  if (balances.length === 0) {
    throw yearConflict("FISCAL_YEAR_NO_MOVEMENTS", `El ejercicio ${year.code} no tiene asientos: no hay nada que regularizar ni cerrar.`, { yearCode: year.code });
  }
  const yearEnd = isoDay(year.endDate);
  const regularization = buildRegularizationEntry({ organizationId: year.organizationId, propertyId: year.propertyId, fiscalYearId: year.id, yearCode: year.code, entryDate: yearEnd, balances });
  const closing = buildClosingEntry({ organizationId: year.organizationId, propertyId: year.propertyId, fiscalYearId: year.id, yearCode: year.code, entryDate: yearEnd, balances, netResult: regularization.netResult });
  const nextYearStart = nextDay(yearEnd);
  const nextYearEndDate = dateOnlyUtc(nextYearStart);
  nextYearEndDate.setUTCFullYear(nextYearEndDate.getUTCFullYear() + 1);
  nextYearEndDate.setUTCDate(nextYearEndDate.getUTCDate() - 1);
  const nextCode = /^\d+$/.test(year.code) ? String(Number(year.code) + 1) : `${year.code}+1`;
  const opening = buildOpeningEntry(closing, { fiscalYearId: year.id, nextYearCode: nextCode, entryDate: nextYearStart });
  const netResult = Number(regularization.netResult.toFixed(2));

  const result = await prisma.$transaction(async (tx) => {
    let nextYear = await tx.fiscalYear.findFirst({ where: { organizationId: year.organizationId, propertyId: year.propertyId, code: nextCode } });
    if (!nextYear) {
      nextYear = await tx.fiscalYear.create({
        data: { organizationId: year.organizationId, propertyId: year.propertyId, code: nextCode, startDate: dateOnlyUtc(nextYearStart), endDate: nextYearEndDate, status: "open" }
      });
    }
    const common = { organizationId: year.organizationId, propertyId: year.propertyId, createdBy: input.context.userId, correlationId: input.correlationId, ignoreClosedPeriod: true, tx };
    const regEntry = regularization.lines.length > 0
      ? await postJournalEntry({ ...common, ...regularization, fiscalYearId: year.id, entryKind: "regularization" })
      : null;
    const closeEntry = await postJournalEntry({ ...common, ...closing, fiscalYearId: year.id, entryKind: "closing" });
    const openEntry = await postJournalEntry({ ...common, ...opening, fiscalYearId: nextYear.id, entryKind: "opening" });
    const updatedYear = await tx.fiscalYear.update({
      where: { id: year.id },
      data: { status: "closed", closedAt: new Date(), closingEntryId: closeEntry.id, openingEntryId: openEntry.id, netResult: regularization.netResult.toFixed(2) }
    });
    return { year: updatedYear, nextYear, regEntryId: regEntry?.id ?? null, closeEntryId: closeEntry.id, openEntryId: openEntry.id };
  }, { maxWait: 15_000, timeout: 120_000 });

  const followUps: string[] = [
    `Traspasar el resultado de la cuenta 129 (${netResult.toFixed(2)} EUR) a reservas (113) o a resultados negativos (121) con un asiento manual tras la aprobación de cuentas.`
  ];
  if (Math.abs(netResult) >= 0.005) followUps.push("Aplicar el resultado según el acuerdo de la junta; este cierre solo ejecuta la mecánica contable.");

  recordAuditEvent({
    organizationId: year.organizationId,
    propertyId: year.propertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "FISCAL_YEAR_CLOSED",
    entityType: "fiscal_year",
    entityId: year.id,
    beforeJson: mapYear(year),
    afterJson: { ...mapYear(result.year), regularizationEntryId: result.regEntryId, closingEntryId: result.closeEntryId, openingEntryId: result.openEntryId, netResult },
    correlationId: input.correlationId
  });
  recordDomainEvent({
    organizationId: year.organizationId,
    propertyId: year.propertyId ?? "",
    entityType: "fiscal_year",
    entityId: year.id,
    eventType: "FiscalYearClosed",
    payload: { code: year.code, netResult, regularizationEntryId: result.regEntryId, closingEntryId: result.closeEntryId, openingEntryId: result.openEntryId, nextFiscalYearId: result.nextYear.id },
    actorType: "user",
    actorUserId: input.context.userId,
    correlationId: input.correlationId
  });

  return {
    fiscalYear: mapYear(result.year),
    regularizationEntryId: result.regEntryId,
    closingEntryId: result.closeEntryId,
    openingEntryId: result.openEntryId,
    nextFiscalYearId: result.nextYear.id,
    netResult,
    followUps
  };
}

// ---------------------------------------------------------------------------
// Reopen — reverses (never deletes) the three asientos
// ---------------------------------------------------------------------------

export async function reopenFiscalYear(input: {
  context: UserContext;
  id: string;
  reason: string;
  correlationId: string;
}): Promise<FiscalYearRecord> {
  requirePermissions(input.context, ["accounting.journal.post", "ai.high_risk.confirm"]);
  const year = await loadYear(input.context, input.id);
  if (year.status !== "closed") throw yearConflict("FISCAL_YEAR_NOT_CLOSED", `El ejercicio ${year.code} no está cerrado.`, { yearCode: year.code });
  if (!input.reason || input.reason.trim().length === 0) throw new BadRequestError("Indica el motivo de la reapertura.");

  const laterClosed = await prisma.fiscalYear.findFirst({
    where: { organizationId: year.organizationId, propertyId: year.propertyId, startDate: { gt: year.startDate }, status: "closed" },
    select: { code: true }
  });
  if (laterClosed) {
    throw yearConflict("FISCAL_YEAR_LATER_CLOSED", `No se puede reabrir ${year.code}: el ejercicio posterior ${laterClosed.code} también está cerrado. Reábrelo primero.`, { yearCode: laterClosed.code });
  }

  // Tanda 7c: un cierre importado de Sage 200 (sage200_journal / sage200_balance) no se reabre
  // aquí; se revierte el lote que lo trajo (la comprobación precede a la búsqueda de closeEntries).
  const importedClose = await prisma.journalEntry.findFirst({
    where: {
      organizationId: year.organizationId,
      status: { not: "draft" },
      reversedById: null,
      sourceType: { in: [LEDGER_IMPORT_SOURCE_TYPES.journal, LEDGER_IMPORT_SOURCE_TYPES.balance] },
      OR: [
        { id: { in: [year.closingEntryId, year.openingEntryId].filter((id): id is string => Boolean(id)) } },
        { fiscalYearId: year.id, entryKind: { in: ["regularization", "closing"] } }
      ]
    },
    select: { id: true }
  });
  if (importedClose) {
    const importEntry = await prisma.ledgerImportEntry.findFirst({ where: { journalEntryId: importedClose.id }, select: { importId: true } });
    throw yearConflict("FISCAL_YEAR_CLOSED_FROM_IMPORT", `El ejercicio ${year.code} se cerró con los asientos importados de Sage 200: reabrir = revertir el lote.`, {
      fiscalYearId: year.id,
      yearCode: year.code,
      importId: importEntry?.importId ?? null,
      journalEntryId: importedClose.id
    });
  }

  const closeEntries = await prisma.journalEntry.findMany({
    where: {
      organizationId: year.organizationId,
      status: "posted",
      reversedById: null,
      OR: [
        { fiscalYearId: year.id, entryKind: { in: ["regularization", "closing"] } },
        { sourceType: { in: ["regularization", "closing", "opening"] }, sourceId: { startsWith: `year-close:${year.id}:` } },
        ...(year.closingEntryId ? [{ id: year.closingEntryId }] : []),
        ...(year.openingEntryId ? [{ id: year.openingEntryId }] : [])
      ]
    },
    select: { id: true, entryKind: true, entryDate: true }
  });

  const reversals: string[] = [];
  const updated = await prisma.$transaction(async (tx) => {
    for (const entry of closeEntries) {
      const reversal = await reverseJournalEntry({
        organizationId: year.organizationId,
        journalEntryId: entry.id,
        reason: `reapertura del ejercicio ${year.code}: ${input.reason}`,
        entryDate: isoDay(entry.entryDate),
        sourceType: "reversal",
        sourceId: `year-reopen:${year.id}:${entry.entryKind}:${entry.id}`,
        createdBy: input.context.userId,
        correlationId: input.correlationId,
        ignoreClosedPeriod: true,
        tx
      });
      reversals.push(reversal.id);
    }
    return tx.fiscalYear.update({
      where: { id: year.id },
      data: { status: "open", closedAt: null, closingEntryId: null, openingEntryId: null, netResult: null }
    });
  }, { maxWait: 15_000, timeout: 120_000 });

  recordAuditEvent({
    organizationId: year.organizationId,
    propertyId: year.propertyId ?? undefined,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "FISCAL_YEAR_REOPENED",
    entityType: "fiscal_year",
    entityId: year.id,
    beforeJson: mapYear(year),
    afterJson: { ...mapYear(updated), reason: input.reason, reversedEntryIds: closeEntries.map((e) => e.id), reversalEntryIds: reversals },
    correlationId: input.correlationId
  });

  return mapYear(updated);
}

// ---------------------------------------------------------------------------
// Cierre importado desde Sage 200 (Tanda 7c · L2) — sin asientos propios
// ---------------------------------------------------------------------------

/** Cliente mínimo que usa `markFiscalYearClosedFromImport` (la transacción del lote o un doble en los tests). */
export type FiscalYearImportCloseClient = {
  fiscalYear: Pick<Prisma.TransactionClient["fiscalYear"], "findUnique" | "update">;
  fiscalPeriod: Pick<Prisma.TransactionClient["fiscalPeriod"], "updateMany">;
};

export type MarkFiscalYearClosedFromImportInput = {
  fiscalYearId: string;
  /** Asiento `closing` importado (grupos 1-5). */
  closingEntryId: string;
  /** Asiento `opening` del ejercicio siguiente importado en el mismo lote, si lo hubo. */
  openingEntryId?: string | null;
  /** Resultado del ejercicio (129) que dejó la regularización importada; texto con dos decimales. */
  netResult: string | number;
  /** Lote que trae el cierre (queda en `closingNotes` de los periodos que se cierran). */
  importId: string;
  /** FIX-1 · F4 (A-04): actor de la importación → `closedBy` de los periodos; sin actor, `import:<importId>`. */
  closedBy?: string | null;
};

/** Nota con la que el cierre importado cierra los periodos que seguían abiertos. */
export function importClosingNote(importId: string): string {
  return `cerrado por importación ${importId}`;
}

/**
 * Deja el ejercicio `closed` con los asientos de cierre / apertura IMPORTADOS (Sage 200),
 * SIN generar regularización, cierre ni apertura propios (design §5.3): el lote ya los
 * contabilizó con su `entryKind`. Rehúsa un ejercicio ya cerrado
 * (409 FISCAL_YEAR_ALREADY_CLOSED) y cierra los periodos del ejercicio que sigan
 * abiertos con la nota «cerrado por importación <importId>» y `closedBy` = actor de la
 * importación o `import:<importId>` (el reverso del lote los reabre y deja closedBy null).
 * Se ejecuta dentro de la transacción del lote: no audita (lo hace el lote tras el commit).
 */
export async function markFiscalYearClosedFromImport(tx: FiscalYearImportCloseClient, input: MarkFiscalYearClosedFromImportInput): Promise<{ fiscalYearId: string; code: string; closedPeriods: number }> {
  const year = await tx.fiscalYear.findUnique({ where: { id: input.fiscalYearId } });
  if (!year) throw new NotFoundError("Ejercicio fiscal no encontrado.");
  if (year.status === "closed") throw yearConflict("FISCAL_YEAR_ALREADY_CLOSED", `El ejercicio ${year.code} ya está cerrado.`, { yearCode: year.code, fiscalYearId: year.id });
  const netResult = typeof input.netResult === "number" ? input.netResult.toFixed(2) : input.netResult;
  await tx.fiscalYear.update({
    where: { id: year.id },
    data: { status: "closed", closedAt: new Date(), closingEntryId: input.closingEntryId, openingEntryId: input.openingEntryId ?? null, netResult }
  });
  const closed = await tx.fiscalPeriod.updateMany({
    where: {
      organizationId: year.organizationId,
      propertyId: year.propertyId ?? null,
      startDate: { gte: year.startDate },
      endDate: { lte: year.endDate },
      status: { not: "closed" }
    },
    data: { status: "closed", closedAt: new Date(), closedBy: input.closedBy ?? `import:${input.importId}`, closingNotes: importClosingNote(input.importId) }
  });
  return { fiscalYearId: year.id, code: year.code, closedPeriods: closed.count };
}

/** Net result of a year as computed from the diario (for tests and the UI). */
export async function computeYearResult(year: { organizationId: string; propertyId: string | null; startDate: Date; endDate: Date }): Promise<number> {
  const rows = await aggregateAccountBalances({ organizationId: year.organizationId, propertyId: year.propertyId, from: isoDay(year.startDate), to: isoDay(year.endDate), excludeKinds: ["regularization", "closing"], kinds: ["income", "expense"] });
  const net = rows.reduce((acc, row) => acc.plus(row.credit).minus(row.debit), ZERO);
  return Number(net.toFixed(2));
}
