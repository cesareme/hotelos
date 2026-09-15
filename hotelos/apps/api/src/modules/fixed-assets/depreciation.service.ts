// Fixed assets · monthly depreciation runs (Finanzas 2026-09-15).
//
// One DepreciationRun per organisation and month ("YYYY-MM", unique), one
// journal entry D 68x / H 28xx with a line pair per element, dated on the
// last day of the month (sourceType "depreciation", sourceId = run id).
// Amount per element and month (straight line, art. 12 LIS coefficient):
//   monthly = round2((cost − residual) × coef / 100 / 12)
//   first month prorated by days from the start date (puesta en condiciones
//   de funcionamiento); the last month takes whatever is left so that
//   accumulated + residual = cost to the cent; elements without category /
//   coefficient / accounts (legacy rows) are reported as skipped, never
//   guessed. Idempotent: posting a period that is already posted returns the
//   run as-is; a reversed run can be posted again; runs must be posted in
//   order (no later posted run may exist) and only the latest posted run can
//   be reversed, so `accumulatedDepreciation` always equals the sum of the
//   live lines.
// No gaps (t6#12): the monthly charge is the systematic application of the
//   annual coefficient (PGC NRV 2ª.2.1, art. 12.1 LIS), so a month can only be
//   posted when every earlier month that had something to depreciate is
//   posted: after the latest posted run the chain must be consecutive; for the
//   first run of the organisation it starts at the earliest start date of its
//   depreciable elements (elements are registered with accumulated 0, so the
//   runs are the only source of accumulated depreciation). Months in which no
//   element would depreciate are not required. The POST answers 409
//   PREVIOUS_PERIOD_MISSING with `pendingPeriods` and the preview lists them.

import { prisma } from "@hotelos/database";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import type { UserContext } from "../../lib/demo-store.js";
import { HttpError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent, recordDomainEvent } from "../audit/audit.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { getLedgerPort, type LedgerEntryResult, type LedgerLineInput } from "../payables/ledger-port.js";
import { dec, money, round2, sum, ZERO, type Decimal } from "../payables/money.js";
import { fullMonthQuota, isDepreciable, loadEntryDto, type FixedAssetRow } from "./fixed-assets.service.js";

type Tx = Prisma.TransactionClient;

export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export type PeriodBounds = { period: string; year: number; month: number; start: Date; end: Date; daysInMonth: number };

/** Calendar bounds of a "YYYY-MM" period (UTC-midnight dates). */
export function periodBounds(period: string): PeriodBounds {
  if (!PERIOD_PATTERN.test(period)) {
    throw new HttpError(400, `Periodo no válido: ${period} (formato AAAA-MM).`, true, { code: "PERIOD_INVALID", period });
  }
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return { period, year, month, start, end, daysInMonth: end.getUTCDate() };
}

export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function previousPeriod(period: string): string {
  const { year, month } = periodBounds(period);
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

export function nextPeriod(period: string): string {
  const { year, month } = periodBounds(period);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

/** "YYYY-MM" of a UTC date. */
export function periodOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type DepreciationInput = {
  acquisitionCost: Decimal;
  residualValue: Decimal;
  coefficientPct: Decimal;
  accumulatedDepreciation: Decimal;
  /** Start of depreciation (UTC midnight). */
  startDate: Date;
  disposedAt?: Date | null;
};

export type DepreciationAmount = { amount: Decimal; accumulatedAfter: Decimal; netBookValueAfter: Decimal; reason: string | null };

/**
 * Pure monthly amount of ONE element for a period:
 *   · not yet in service (start after the period) or disposed before it → 0;
 *   · full month = (cost − residual) × coef / 100 / 12 rounded to the cent;
 *   · the start month is prorated by the days in service (day 1 = full month);
 *   · capped by what is left to depreciate (cost − residual − accumulated),
 *     so the last month closes the element to the cent.
 */
export function depreciationForPeriod(asset: DepreciationInput, bounds: PeriodBounds): DepreciationAmount {
  const cost = round2(asset.acquisitionCost);
  const residual = round2(asset.residualValue);
  const accumulated = round2(asset.accumulatedDepreciation);
  const remaining = cost.minus(residual).minus(accumulated);
  const done = (reason: string | null, amount = ZERO): DepreciationAmount => ({
    amount,
    accumulatedAfter: accumulated.plus(amount),
    netBookValueAfter: cost.minus(accumulated.plus(amount)),
    reason
  });
  if (asset.coefficientPct.isZero()) return done("sin coeficiente (elemento no amortizable)");
  if (remaining.lte(ZERO)) return done("totalmente amortizado");
  if (asset.startDate > bounds.end) return done("todavía no está en funcionamiento");
  if (asset.disposedAt && asset.disposedAt < bounds.start) return done("dado de baja antes del periodo");
  let amount = fullMonthQuota(cost, residual, asset.coefficientPct);
  if (asset.startDate >= bounds.start && asset.startDate <= bounds.end) {
    const daysInService = bounds.daysInMonth - asset.startDate.getUTCDate() + 1;
    if (daysInService < bounds.daysInMonth) amount = round2(amount.times(daysInService).div(bounds.daysInMonth));
  }
  // Last month: whatever is left, and a leftover smaller than half a quota is
  // absorbed now (1.000 € at 25 % closes in month 48 with 20,99 € instead of
  // leaving 0,16 € for a 49th month).
  if (amount.gt(remaining) || remaining.minus(amount).lt(fullMonthQuota(cost, residual, asset.coefficientPct).div(2))) amount = remaining;
  return done(null, amount);
}

/**
 * Months before `period` that still need a posted run (pure, ascending):
 *   · after the latest posted run the chain is consecutive, so every month in
 *     (latestPostedPeriod, period) is a candidate; with no posted run yet the
 *     candidates start at the earliest start date of the elements;
 *   · a candidate is pending only when some element would depreciate in it
 *     (amount > 0 from the current state: the elements' accumulated only moves
 *     through posted runs, so for the first pending month the amount is exact
 *     and for the later ones it is at worst conservative);
 *   · no depreciable elements, or a period at or before the lower bound → [].
 */
export function pendingPeriodsBefore(input: { period: string; latestPostedPeriod: string | null; elements: ReadonlyArray<DepreciationInput> }): string[] {
  periodBounds(input.period);
  if (input.elements.length === 0) return [];
  let cursor: string;
  if (input.latestPostedPeriod) {
    cursor = nextPeriod(input.latestPostedPeriod);
  } else {
    cursor = input.elements.map((element) => periodOf(element.startDate)).sort()[0]!;
  }
  const pending: string[] = [];
  while (cursor < input.period) {
    const bounds = periodBounds(cursor);
    if (input.elements.some((element) => depreciationForPeriod(element, bounds).amount.gt(ZERO))) pending.push(cursor);
    cursor = nextPeriod(cursor);
  }
  return pending;
}

export type RunLineDto = {
  fixedAssetId: string;
  name: string;
  propertyId: string;
  accountCode: string | null;
  depreciationAccountCode: string | null;
  expenseAccountCode: string | null;
  amount: string;
  accumulatedAfter: string;
  netBookValueAfter: string;
};

export type RunSkippedDto = { fixedAssetId: string; name: string; propertyId: string; reason: string };

export type DepreciationRunDto = {
  id: string | null;
  organizationId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  status: "draft" | "posted" | "reversed" | "preview";
  totalAmount: string;
  journalEntryId: string | null;
  reversalJournalEntryId: string | null;
  createdBy: string | null;
  createdAt: string | null;
  lines: RunLineDto[];
  skipped: RunSkippedDto[];
  /** True when the POST found the period already posted and returned it unchanged. */
  alreadyPosted: boolean;
  /** Preview only: earlier months that must be posted first (ascending; the POST of this period answers 409 PREVIOUS_PERIOD_MISSING while non-empty). [] on posted / reversed runs. */
  pendingPeriods: string[];
  entry: LedgerEntryResult | null;
};

const runSchema = z.object({ period: z.string().regex(PERIOD_PATTERN, "formato AAAA-MM") }).strict();
const reverseSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

function typed(statusCode: number, code: string, message: string, extra: Record<string, unknown> = {}): HttpError {
  return new HttpError(statusCode, message, true, { code, ...extra });
}

type Computed = { lines: Array<RunLineDto & { asset: FixedAssetRow; amountDec: Decimal; accumulatedAfterDec: Decimal }>; skipped: RunSkippedDto[]; total: Decimal };

type LoadedElements = {
  /** Elements the run can depreciate, with their pure input (current accumulated). */
  depreciable: Array<{ asset: FixedAssetRow; input: DepreciationInput }>;
  /** Legacy rows without category / coefficient / accounts / dates: reported, never guessed. */
  skipped: RunSkippedDto[];
};

/** Live (active / fully depreciated) elements of the organisation, split into depreciable inputs and skipped rows. */
async function loadElements(tx: Tx | typeof prisma, organizationId: string): Promise<LoadedElements> {
  const assets = await tx.fixedAsset.findMany({ where: { organizationId, status: { in: ["active", "fully_depreciated"] } }, orderBy: [{ propertyId: "asc" }, { name: "asc" }] });
  const depreciable: LoadedElements["depreciable"] = [];
  const skipped: RunSkippedDto[] = [];
  for (const asset of assets) {
    if (!isDepreciable(asset)) {
      skipped.push({ fixedAssetId: asset.id, name: asset.name, propertyId: asset.propertyId, reason: "sin categoría, coeficiente o cuentas (completa la ficha del elemento)" });
      continue;
    }
    const startDate = asset.startDate ?? asset.acquisitionDate;
    if (!startDate) {
      skipped.push({ fixedAssetId: asset.id, name: asset.name, propertyId: asset.propertyId, reason: "sin fecha de adquisición ni de puesta en funcionamiento" });
      continue;
    }
    depreciable.push({
      asset,
      input: { acquisitionCost: dec(asset.acquisitionCost), residualValue: dec(asset.residualValue), coefficientPct: dec(asset.coefficientPct!), accumulatedDepreciation: dec(asset.accumulatedDepreciation), startDate, disposedAt: asset.disposedAt }
    });
  }
  return { depreciable, skipped };
}

/** Latest posted period of the organisation (the anchor of the monthly chain) or null before the first run. */
async function latestPostedPeriod(tx: Tx | typeof prisma, organizationId: string): Promise<string | null> {
  const latest = await tx.depreciationRun.findFirst({ where: { organizationId, status: "posted" }, select: { period: true }, orderBy: { period: "desc" } });
  return latest?.period ?? null;
}

function computeRun(loaded: LoadedElements, bounds: PeriodBounds): Computed {
  const lines: Computed["lines"] = [];
  const skipped: RunSkippedDto[] = [...loaded.skipped];
  for (const { asset, input } of loaded.depreciable) {
    const result = depreciationForPeriod(input, bounds);
    if (result.reason || result.amount.isZero()) {
      skipped.push({ fixedAssetId: asset.id, name: asset.name, propertyId: asset.propertyId, reason: result.reason ?? "cuota cero" });
      continue;
    }
    lines.push({
      fixedAssetId: asset.id,
      name: asset.name,
      propertyId: asset.propertyId,
      accountCode: asset.accountCode ?? null,
      depreciationAccountCode: asset.depreciationAccountCode ?? null,
      expenseAccountCode: asset.expenseAccountCode ?? null,
      amount: money(result.amount),
      accumulatedAfter: money(result.accumulatedAfter),
      netBookValueAfter: money(result.netBookValueAfter),
      asset,
      amountDec: result.amount,
      accumulatedAfterDec: result.accumulatedAfter
    });
  }
  return { lines, skipped, total: sum(lines.map((l) => l.amountDec)) };
}

function pendingPeriodsError(period: string, pending: string[], latest: string | null): HttpError {
  const shown = pending.slice(0, 6).join(", ") + (pending.length > 6 ? ` y ${pending.length - 6} más` : "");
  return typed(409, "PREVIOUS_PERIOD_MISSING", `Faltan corridas anteriores (${shown}): las corridas de amortización se contabilizan mes a mes y sin huecos.`, {
    period,
    pendingPeriods: pending,
    latestPostedPeriod: latest
  });
}

/** Journal lines of a run (pure): D expense / H accumulated per element. */
export function buildDepreciationLines(lines: ReadonlyArray<{ name: string; expenseAccountCode: string; depreciationAccountCode: string; amount: Decimal }>, period: string): LedgerLineInput[] {
  const out: LedgerLineInput[] = [];
  for (const line of lines) {
    out.push({ accountCode: line.expenseAccountCode, debit: line.amount, description: `Amortización ${period} ${line.name}` });
    out.push({ accountCode: line.depreciationAccountCode, credit: line.amount, description: `Amortización acumulada ${period} ${line.name}` });
  }
  return out;
}

type RunRow = Prisma.DepreciationRunGetPayload<{ include: { lines: true } }>;

async function runDto(tx: Tx | typeof prisma, row: RunRow, extra: { skipped?: RunSkippedDto[]; alreadyPosted?: boolean; pendingPeriods?: string[] } = {}): Promise<DepreciationRunDto> {
  const assetIds = row.lines.map((l) => l.fixedAssetId);
  const assets = assetIds.length ? await tx.fixedAsset.findMany({ where: { id: { in: assetIds } }, select: { id: true, name: true, propertyId: true, accountCode: true, depreciationAccountCode: true, expenseAccountCode: true } }) : [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  const entry = row.journalEntryId ? await (tx === prisma ? prisma.$transaction((t) => loadEntryDto(t, row.organizationId, row.journalEntryId!)) : loadEntryDto(tx as Tx, row.organizationId, row.journalEntryId)) : null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    period: row.period,
    periodStart: row.periodStart.toISOString().slice(0, 10),
    periodEnd: row.periodEnd.toISOString().slice(0, 10),
    status: row.status,
    totalAmount: money(row.totalAmount),
    journalEntryId: row.journalEntryId ?? null,
    reversalJournalEntryId: row.reversalJournalEntryId ?? null,
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
    lines: row.lines.map((l) => {
      const asset = byId.get(l.fixedAssetId);
      return {
        fixedAssetId: l.fixedAssetId,
        name: asset?.name ?? l.fixedAssetId,
        propertyId: asset?.propertyId ?? "",
        accountCode: asset?.accountCode ?? null,
        depreciationAccountCode: asset?.depreciationAccountCode ?? null,
        expenseAccountCode: asset?.expenseAccountCode ?? null,
        amount: money(l.amount),
        accumulatedAfter: money(l.accumulatedAfter),
        netBookValueAfter: money(l.netBookValueAfter)
      };
    }),
    skipped: extra.skipped ?? [],
    alreadyPosted: extra.alreadyPosted ?? false,
    pendingPeriods: extra.pendingPeriods ?? [],
    entry
  };
}

export async function listDepreciationRuns(organizationId: string, limit = 60): Promise<DepreciationRunDto[]> {
  const rows = await prisma.depreciationRun.findMany({ where: { organizationId }, include: { lines: true }, orderBy: { period: "desc" }, take: Math.min(Math.max(limit, 1), 240) });
  const out: DepreciationRunDto[] = [];
  for (const row of rows) out.push(await runDto(prisma, row));
  return out;
}

export async function getDepreciationRun(organizationId: string, runId: string): Promise<DepreciationRunDto> {
  const row = await prisma.depreciationRun.findFirst({ where: { id: runId, organizationId }, include: { lines: true } });
  if (!row) throw new NotFoundError("Corrida de amortización no encontrada.");
  return runDto(prisma, row);
}

/** What a run of `period` would post, computed from the current state of the elements (nothing written). */
export async function previewDepreciationRun(organizationId: string, period: string): Promise<DepreciationRunDto> {
  const bounds = periodBounds(period);
  const existing = await prisma.depreciationRun.findUnique({ where: { organizationId_period: { organizationId, period } }, include: { lines: true } });
  if (existing && existing.status === "posted") return runDto(prisma, existing, { alreadyPosted: true });
  const loaded = await loadElements(prisma, organizationId);
  const pendingPeriods = pendingPeriodsBefore({ period, latestPostedPeriod: await latestPostedPeriod(prisma, organizationId), elements: loaded.depreciable.map((e) => e.input) });
  const computed = computeRun(loaded, bounds);
  return {
    id: existing?.id ?? null,
    organizationId,
    period,
    periodStart: bounds.start.toISOString().slice(0, 10),
    periodEnd: bounds.end.toISOString().slice(0, 10),
    status: "preview",
    totalAmount: money(computed.total),
    journalEntryId: null,
    reversalJournalEntryId: null,
    createdBy: null,
    createdAt: null,
    lines: computed.lines.map(({ asset: _asset, amountDec: _a, accumulatedAfterDec: _b, ...line }) => line),
    skipped: computed.skipped,
    alreadyPosted: false,
    pendingPeriods,
    entry: null
  };
}

export async function postDepreciationRun(input: { context: UserContext; organizationId: string; body: unknown; correlationId: string }): Promise<DepreciationRunDto> {
  const data = parseOr400(runSchema, input.body ?? {}, "Corrida de amortización");
  const bounds = periodBounds(data.period);
  if (data.period > currentPeriod()) throw typed(400, "PERIOD_IN_FUTURE", `No se puede amortizar un periodo futuro (${data.period}).`, { period: data.period });
  const result = await prisma.$transaction(async (tx) => {
    // One run at a time per organisation: the amounts depend on the accumulated depreciation the previous run left.
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`depreciation|${input.organizationId}`}))`);
    const existing = await tx.depreciationRun.findUnique({ where: { organizationId_period: { organizationId: input.organizationId, period: data.period } }, include: { lines: true } });
    if (existing && existing.status === "posted") return { row: existing, alreadyPosted: true, skipped: [] as RunSkippedDto[], entry: null as LedgerEntryResult | null };
    const later = await tx.depreciationRun.findFirst({ where: { organizationId: input.organizationId, status: "posted", period: { gt: data.period } }, select: { period: true }, orderBy: { period: "asc" } });
    if (later) throw typed(409, "LATER_RUN_EXISTS", `Ya hay una corrida contabilizada posterior (${later.period}): las corridas se contabilizan en orden.`, { period: data.period, laterPeriod: later.period });
    // No gaps: every earlier month with something to depreciate must be posted first (see header).
    const loaded = await loadElements(tx, input.organizationId);
    const latest = await latestPostedPeriod(tx, input.organizationId);
    const pending = pendingPeriodsBefore({ period: data.period, latestPostedPeriod: latest, elements: loaded.depreciable.map((e) => e.input) });
    if (pending.length > 0) throw pendingPeriodsError(data.period, pending, latest);
    const computed = computeRun(loaded, bounds);
    // The run row exists (draft) before its entry so the entry's sourceId is
    // the real run id; a reversed run of the same period is reused (unique
    // (organizationId, period)) and its old lines dropped.
    const draft = existing
      ? await tx.depreciationRun.update({ where: { id: existing.id }, data: { status: "draft", journalEntryId: null, reversalJournalEntryId: null, lines: { deleteMany: {} } }, select: { id: true } })
      : await tx.depreciationRun.create({ data: { organizationId: input.organizationId, period: data.period, periodStart: bounds.start, periodEnd: bounds.end, status: "draft", createdBy: input.context.userId }, select: { id: true } });
    // Idempotency key of the entry: the run id; a run posted again after a
    // reversal gets "<runId>#<n>" (its previous entry stays, reversed).
    const priorEntries = existing ? await tx.journalEntry.count({ where: { organizationId: input.organizationId, sourceType: "depreciation", sourceId: { startsWith: draft.id } } }) : 0;
    let entry: LedgerEntryResult | null = null;
    if (computed.lines.length > 0) {
      entry = await getLedgerPort().post(tx, {
        organizationId: input.organizationId,
        propertyId: null,
        entryDate: bounds.end,
        sourceType: "depreciation",
        sourceId: priorEntries === 0 ? draft.id : `${draft.id}#${priorEntries + 1}`,
        description: `Amortización ${data.period}`,
        reference: data.period,
        createdBy: input.context.userId,
        lines: buildDepreciationLines(
          computed.lines.map((l) => ({ name: l.name, expenseAccountCode: l.expenseAccountCode!, depreciationAccountCode: l.depreciationAccountCode!, amount: l.amountDec })),
          data.period
        )
      });
    }
    const row: RunRow = await tx.depreciationRun.update({
      where: { id: draft.id },
      data: {
        status: "posted",
        totalAmount: computed.total,
        journalEntryId: entry?.id ?? null,
        reversalJournalEntryId: null,
        createdBy: input.context.userId,
        periodStart: bounds.start,
        periodEnd: bounds.end,
        lines: { create: computed.lines.map((l) => ({ fixedAssetId: l.fixedAssetId, amount: l.amountDec, accumulatedAfter: l.accumulatedAfterDec, netBookValueAfter: dec(l.netBookValueAfter) })) }
      },
      include: { lines: true }
    });
    for (const line of computed.lines) {
      const depreciable = dec(line.asset.acquisitionCost).minus(dec(line.asset.residualValue));
      await tx.fixedAsset.update({
        where: { id: line.fixedAssetId },
        data: { accumulatedDepreciation: line.accumulatedAfterDec, status: line.accumulatedAfterDec.gte(depreciable) ? "fully_depreciated" : "active" }
      });
    }
    return { row, alreadyPosted: false, skipped: computed.skipped, entry };
  });
  const dto = await runDto(prisma, result.row, { skipped: result.skipped, alreadyPosted: result.alreadyPosted });
  if (!result.alreadyPosted) {
    recordAuditEvent({
      organizationId: input.organizationId,
      propertyId: input.context.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "DEPRECIATION_RUN_POSTED",
      entityType: "depreciation_run",
      entityId: dto.id ?? undefined,
      afterJson: { period: dto.period, totalAmount: dto.totalAmount, elements: dto.lines.length, skipped: dto.skipped.length, journalEntryId: dto.journalEntryId },
      correlationId: input.correlationId
    });
    recordDomainEvent({
      organizationId: input.organizationId,
      propertyId: input.context.propertyId,
      entityType: "depreciation_run",
      entityId: dto.id ?? "",
      eventType: "DepreciationRunPosted",
      payload: { period: dto.period, totalAmount: dto.totalAmount, elements: dto.lines.length, journalEntryId: dto.journalEntryId },
      actorType: "user",
      actorUserId: input.context.userId,
      correlationId: input.correlationId
    });
  }
  return dto;
}

export async function reverseDepreciationRun(input: { context: UserContext; organizationId: string; runId: string; body: unknown; correlationId: string }): Promise<DepreciationRunDto> {
  const data = parseOr400(reverseSchema, input.body ?? {}, "Anulación");
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`depreciation|${input.organizationId}`}))`);
    const run = await tx.depreciationRun.findFirst({ where: { id: input.runId, organizationId: input.organizationId }, include: { lines: true } });
    if (!run) throw new NotFoundError("Corrida de amortización no encontrada.");
    if (run.status === "reversed") return { row: run, reversal: null as LedgerEntryResult | null };
    if (run.status !== "posted") throw typed(409, "INVALID_STATUS_TRANSITION", `Solo se anula una corrida contabilizada (estado actual: ${run.status}).`, { status: run.status });
    const later = await tx.depreciationRun.findFirst({ where: { organizationId: input.organizationId, status: "posted", period: { gt: run.period } }, select: { period: true } });
    if (later) throw typed(409, "LATER_RUN_EXISTS", `Anula antes la corrida posterior (${later.period}).`, { laterPeriod: later.period });
    let reversal: LedgerEntryResult | null = null;
    if (run.journalEntryId) {
      reversal = await getLedgerPort().reverse(tx, {
        organizationId: input.organizationId,
        journalEntryId: run.journalEntryId,
        entryDate: run.periodEnd,
        sourceType: "reversal",
        sourceId: `depreciation_reversal:${run.id}`,
        description: `Anulación amortización ${run.period}: ${data.reason}`,
        createdBy: input.context.userId
      });
    }
    for (const line of run.lines) {
      const asset = await tx.fixedAsset.findUnique({ where: { id: line.fixedAssetId }, select: { accumulatedDepreciation: true, status: true } });
      if (!asset) continue;
      const accumulated = dec(asset.accumulatedDepreciation).minus(dec(line.amount));
      await tx.fixedAsset.update({
        where: { id: line.fixedAssetId },
        data: { accumulatedDepreciation: accumulated.lt(ZERO) ? ZERO : accumulated, ...(asset.status === "fully_depreciated" ? { status: "active" } : {}) }
      });
    }
    const row = await tx.depreciationRun.update({ where: { id: run.id }, data: { status: "reversed", reversalJournalEntryId: reversal?.id ?? null }, include: { lines: true } });
    return { row, reversal };
  });
  const dto = await runDto(prisma, result.row);
  if (result.reversal) {
    recordAuditEvent({
      organizationId: input.organizationId,
      propertyId: input.context.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: "DEPRECIATION_RUN_REVERSED",
      entityType: "depreciation_run",
      entityId: dto.id ?? undefined,
      afterJson: { period: dto.period, reason: data.reason, reversalJournalEntryId: dto.reversalJournalEntryId },
      correlationId: input.correlationId
    });
    recordDomainEvent({
      organizationId: input.organizationId,
      propertyId: input.context.propertyId,
      entityType: "depreciation_run",
      entityId: dto.id ?? "",
      eventType: "DepreciationRunReversed",
      payload: { period: dto.period, reason: data.reason, reversalJournalEntryId: dto.reversalJournalEntryId, totalAmount: dto.totalAmount },
      actorType: "user",
      actorUserId: input.context.userId,
      correlationId: input.correlationId
    });
  }
  return dto;
}

export { runSchema as depreciationRunSchema, reverseSchema as reverseDepreciationRunSchema };
