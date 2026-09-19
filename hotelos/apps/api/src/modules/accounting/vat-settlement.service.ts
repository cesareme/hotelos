// Finanzas · lote «iva-modelos» — Liquidación de IVA del periodo.
//
// Canonical rule (runbook §2): D 477.tipo (cuota repercutida) / H 472.tipo
// (cuota soportada deducible) / H 4750 (a ingresar) or D 4700 (a compensar o
// devolver). The lines come from the SAME computation as the Modelo 303
// (modelo-303.service.ts): the pending compensation applied in the period
// (casilla 78) is credited to 4700 and only the remainder goes to 4750, so
// the ledger balance of 4700 always equals casilla 87 + the negative results.
// Amounts are always positive on debit OR credit (a rate whose net quota is
// negative — more rectificativas than sales — flips side, never a negative
// line). One settlement entry per period: sourceType `vat_settlement`,
// sourceId `vat-settlement:<period>` (idempotency key of the projection,
// contract §1.3); a second call is 409 ALREADY_SETTLED; reversing posts the
// inverse entry with `reversalOfId` and never deletes.
//
// Ledger engine. Every entry goes through the ledger lot's single posting
// service (accounting.service.ts postJournalEntry / reverseJournalEntry). At
// the time of writing that service still has the legacy draft → post
// signature, so this module declares the interface it expects
// (`LedgerEngine`) and ships `interimLedgerEngine`: a Prisma implementation of
// the contract (numbering max+1 under pg_advisory_xact_lock(hashtext(org ||
// fiscalYearCode)), entryDate, accountCode/taxRateCode/taxBase on every line,
// closed-period check, status posted). The integrator swaps it for the ledger
// lot's engine through `registerFiscalRoutes(app, { ledger })` — see the
// handoff in the lot report. Nothing else in this module touches the journal.

import { Prisma } from "@prisma/client";
import { prisma } from "@hotelos/database";
import type { FiscalPeriodDto, VatSettlementLineDto, VatSettlementPreview, VatSettlementResult, VatSettlementReversalResult } from "@hotelos/shared/src/fiscal-types.js";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { requirePermissions } from "../auth/auth.service.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { isPostingAllowed } from "./fiscal-period.service.js";
import { assertFinanceReadScope } from "../../lib/finance-scope.js";
import type { JournalEntryKind } from "@hotelos/shared/src/accounting-types.js";
import { journalNumberingLockKey, postJournalEntry as postCanonicalJournalEntry, reverseJournalEntry as reverseCanonicalJournalEntry } from "./accounting.service.js";
import { modelo303ForPeriod, resolveSettlementPeriod, vatSettlementSourceId, type Modelo303Computation } from "./modelo-303.service.js";
import { ZERO, dateColumn, dateColumnDay, ensureVatSettings, getVatSettings, isIsoDay, madridDay, money, round2, toWire, type Money } from "./vat-books.service.js";

// ── Ledger engine contract (implemented by the ledger lot) ──────────────────

export type LedgerLineInput = {
  accountCode: string;
  /** Positive amount on exactly one side (string with 2 decimals or Decimal). */
  debit: Money | string;
  credit: Money | string;
  description?: string;
  taxRateCode?: string | null;
  taxBase?: Money | string | null;
};

export type LedgerPostInput = {
  organizationId: string;
  propertyId?: string | null;
  /** Accounting date (YYYY-MM-DD): fixes fiscal year, period and the diary order. */
  entryDate: string;
  /** Values of docs/runbooks/finanzas-contabilidad.md §1.1 (here `vat_settlement`). */
  sourceType: string;
  sourceId: string;
  description: string;
  reference?: string | null;
  entryKind?: string;
  lines: LedgerLineInput[];
  createdBy?: string | null;
  reversalOfId?: string | null;
};

export type LedgerPostedEntry = {
  id: string;
  entryNumber: number | null;
  fiscalYearCode: string | null;
  entryDate: string;
};

export type LedgerReverseInput = {
  organizationId: string;
  journalEntryId: string;
  entryDate: string;
  description: string;
  createdBy?: string | null;
};

export type LedgerEngine = {
  postJournalEntry(input: LedgerPostInput): Promise<LedgerPostedEntry>;
  reverseJournalEntry(input: LedgerReverseInput): Promise<LedgerPostedEntry>;
};

// ── Interim engine (Prisma, follows the contract) ───────────────────────────

function assertLines(lines: readonly LedgerLineInput[]): { debit: Money; credit: Money } {
  if (lines.length < 2) throw new BadRequestError("Un asiento necesita al menos dos líneas.");
  let debit = ZERO;
  let credit = ZERO;
  for (const line of lines) {
    const d = round2(money(line.debit));
    const c = round2(money(line.credit));
    if (d.lessThan(0) || c.lessThan(0)) throw new BadRequestError(`Línea ${line.accountCode}: los importes deben ser positivos (nunca líneas negativas).`);
    if (d.isZero() === c.isZero()) throw new BadRequestError(`Línea ${line.accountCode}: importe en debe O en haber, no en ambos ni en ninguno.`);
    debit = debit.plus(d);
    credit = credit.plus(c);
  }
  if (!debit.equals(credit)) {
    throw new ConflictError(`El asiento no cuadra: debe ${debit.toFixed(2)} ≠ haber ${credit.toFixed(2)}.`, { code: "JOURNAL_UNBALANCED", debit: debit.toFixed(2), credit: credit.toFixed(2) });
  }
  return { debit, credit };
}

async function postWithin(tx: Prisma.TransactionClient, input: LedgerPostInput): Promise<LedgerPostedEntry> {
  assertLines(input.lines);
  if (!isIsoDay(input.entryDate)) throw new BadRequestError("entryDate debe ser una fecha YYYY-MM-DD.");
  const codes = Array.from(new Set(input.lines.map((line) => line.accountCode)));
  const accounts = await tx.account.findMany({ where: { organizationId: input.organizationId, code: { in: codes } }, select: { id: true, code: true, isPostable: true } });
  const byCode = new Map(accounts.map((account) => [account.code, account]));
  const missing = codes.filter((code) => !byCode.has(code));
  if (missing.length > 0) {
    throw new ConflictError(`Faltan cuentas en el plan contable de la organización: ${missing.join(", ")}. Provisiona el plan «PGC Pymes hotelero» antes de contabilizar.`, { code: "CHART_NOT_PROVISIONED", missing });
  }
  const headers = codes.filter((code) => byCode.get(code)!.isPostable === false);
  if (headers.length > 0) throw new ConflictError(`Las cuentas ${headers.join(", ")} son cabeceras (no admiten apuntes).`, { code: "ACCOUNT_NOT_POSTABLE", accounts: headers });
  const postingDate = dateColumn(input.entryDate);
  const period = await isPostingAllowed(input.organizationId, input.propertyId ?? undefined, postingDate);
  if (!period.allowed) throw new ConflictError(`El periodo contable ${period.closedPeriodCode} está cerrado: no se puede asentar en ${input.entryDate}.`, { code: "PERIOD_CLOSED", periodCode: period.closedPeriodCode });
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: { organizationId: input.organizationId, OR: [{ propertyId: input.propertyId ?? null }, { propertyId: null }], startDate: { lte: postingDate }, endDate: { gte: postingDate } },
    select: { id: true, code: true, status: true },
    orderBy: [{ propertyId: "desc" }]
  });
  if (fiscalYear && fiscalYear.status === "closed") throw new ConflictError(`El ejercicio ${fiscalYear.code} está cerrado.`, { code: "FISCAL_YEAR_CLOSED", fiscalYearCode: fiscalYear.code });
  const fiscalYearCode = fiscalYear?.code ?? input.entryDate.slice(0, 4);
  // Same advisory-lock key as the canonical engine (accounting.service): two
  // writers numbering MAX+1 under different keys raced into UNIQUE_VIOLATION.
  const lockKey = journalNumberingLockKey(input.organizationId, fiscalYearCode);
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
  const last = await tx.journalEntry.aggregate({ where: { organizationId: input.organizationId, fiscalYearCode }, _max: { entryNumber: true } });
  const entryNumber = (last._max.entryNumber ?? 0) + 1;
  const created = await tx.journalEntry.create({
    data: {
      organizationId: input.organizationId,
      propertyId: input.propertyId ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      status: "posted",
      postedAt: new Date(),
      createdBy: input.createdBy ?? null,
      fiscalYearId: fiscalYear?.id ?? null,
      entryKind: input.entryKind ?? "normal",
      entryDate: postingDate,
      entryNumber,
      fiscalYearCode,
      description: input.description,
      reference: input.reference ?? null,
      reversalOfId: input.reversalOfId ?? null
    },
    select: { id: true, entryNumber: true, fiscalYearCode: true, entryDate: true }
  });
  await tx.journalLine.createMany({
    data: input.lines.map((line) => ({
      journalEntryId: created.id,
      accountId: byCode.get(line.accountCode)!.id,
      accountCode: line.accountCode,
      debit: round2(money(line.debit)),
      credit: round2(money(line.credit)),
      currency: "EUR",
      description: line.description ?? null,
      taxRateCode: line.taxRateCode ?? null,
      taxBase: line.taxBase === null || line.taxBase === undefined ? null : round2(money(line.taxBase))
    }))
  });
  return { id: created.id, entryNumber: created.entryNumber, fiscalYearCode: created.fiscalYearCode, entryDate: dateColumnDay(created.entryDate) };
}

export const interimLedgerEngine: LedgerEngine = {
  postJournalEntry(input) {
    return prisma.$transaction((tx) => postWithin(tx, input), { maxWait: 15_000, timeout: 60_000 });
  },
  reverseJournalEntry(input) {
    return prisma.$transaction(
      async (tx) => {
        const entry = await tx.journalEntry.findUnique({ where: { id: input.journalEntryId } });
        if (!entry || entry.organizationId !== input.organizationId) throw new NotFoundError("El asiento no existe.");
        if (entry.reversedById || entry.status === "reversed") throw new ConflictError("El asiento ya está anulado.", { code: "ALREADY_REVERSED", reversalJournalEntryId: entry.reversedById });
        const lines = await tx.journalLine.findMany({ where: { journalEntryId: entry.id } });
        const accountIds = lines.map((line) => line.accountId);
        const accounts = await tx.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, code: true } });
        const codeById = new Map(accounts.map((account) => [account.id, account.code]));
        const reversal = await postWithin(tx, {
          organizationId: entry.organizationId,
          propertyId: entry.propertyId,
          entryDate: input.entryDate,
          sourceType: "reversal",
          sourceId: `${entry.id}:reversal`,
          description: input.description,
          reference: entry.reference,
          entryKind: "reversal",
          createdBy: input.createdBy ?? null,
          reversalOfId: entry.id,
          lines: lines.map((line) => ({
            accountCode: line.accountCode ?? codeById.get(line.accountId) ?? "",
            debit: line.credit,
            credit: line.debit,
            description: line.description ?? undefined,
            taxRateCode: line.taxRateCode,
            taxBase: line.taxBase
          }))
        });
        await tx.journalEntry.update({ where: { id: entry.id }, data: { reversedById: reversal.id, status: "reversed" } });
        return reversal;
      },
      { maxWait: 15_000, timeout: 60_000 }
    );
  }
};

/**
 * Canonical engine (integration 2026-09-16): the ledger lot's single posting
 * service (accounting.service postJournalEntry / reverseJournalEntry) behind
 * the `LedgerEngine` contract — numbering under the engine's advisory lock,
 * idempotency by (org, sourceType, sourceId), closed-period guard, marked
 * reversals. server.ts injects it through `registerFiscalRoutes(app, { ledger })`;
 * `interimLedgerEngine` stays for the in-process tests that mount the routes
 * without the whole server.
 */
export const canonicalLedgerEngine: LedgerEngine = {
  async postJournalEntry(input) {
    const posted = await postCanonicalJournalEntry({
      organizationId: input.organizationId,
      propertyId: input.propertyId ?? null,
      entryDate: input.entryDate,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      description: input.description,
      reference: input.reference ?? null,
      entryKind: (input.entryKind ?? "normal") as JournalEntryKind,
      reversalOfId: input.reversalOfId ?? null,
      createdBy: input.createdBy ?? null,
      lines: input.lines.map((line) => ({
        accountCode: line.accountCode,
        debit: line.debit,
        credit: line.credit,
        description: line.description ?? null,
        taxRateCode: line.taxRateCode ?? null,
        taxBase: line.taxBase ?? null
      }))
    });
    return { id: posted.id, entryNumber: posted.entryNumber, fiscalYearCode: posted.fiscalYearCode, entryDate: posted.entryDate };
  },
  async reverseJournalEntry(input) {
    const reversal = await reverseCanonicalJournalEntry({
      organizationId: input.organizationId,
      journalEntryId: input.journalEntryId,
      reason: input.description,
      description: input.description,
      entryDate: input.entryDate,
      createdBy: input.createdBy ?? null
    });
    return { id: reversal.id, entryNumber: reversal.entryNumber, fiscalYearCode: reversal.fiscalYearCode, entryDate: reversal.entryDate };
  }
};

// ── Settlement lines from the 303 computation (pure) ────────────────────────

export type SettlementLine = { accountCode: string; description: string; debit: Money; credit: Money; taxRateCode: string | null; taxBase: Money | null };

export type SettlementPlan = {
  lines: SettlementLine[];
  resultado: "to_pay" | "to_offset" | "zero";
  importe: Money;
  totalDebit: Money;
  totalCredit: Money;
  avisos: string[];
};

function rateSuffix(rate: Money): string {
  // 21 → "21", 10 → "10", 4 → "04", 7 → "07" (template subaccounts 477.xx / 472.xx); non-integer → null.
  if (!rate.isInteger()) return "";
  return rate.toFixed(0).padStart(2, "0");
}

/**
 * D 477.tipo / H 472.tipo / H 4700 (compensation applied) / H 4750 (to pay)
 * or D 4700 (to offset). `hasAccount` tells which subaccounts exist so a
 * missing 477.xx / 472.xx falls back to the 3-digit account with an aviso.
 */
export function settlementLinesFrom(computation: Modelo303Computation, hasAccount: (code: string) => boolean): SettlementPlan {
  const avisos: string[] = [];
  const lines: SettlementLine[] = [];
  const accountFor = (base: "477" | "472", rate: Money): string => {
    const suffix = rateSuffix(rate);
    const candidate = suffix ? `${base}.${suffix}` : "";
    if (candidate && hasAccount(candidate)) return candidate;
    avisos.push(`Subcuenta ${candidate || `${base}.<tipo>`} no existe en el plan: la cuota al ${rate.toFixed(2)} % se asienta en ${base}.`);
    return base;
  };
  for (const bucket of computation.devengado) {
    const cuota = round2(bucket.cuota);
    if (cuota.isZero()) continue;
    const accountCode = accountFor("477", bucket.rate);
    lines.push({
      accountCode,
      description: `IVA repercutido al ${bucket.rate.toFixed(0)} % (cuota devengada del periodo)`,
      debit: cuota.greaterThan(0) ? cuota : ZERO,
      credit: cuota.lessThan(0) ? cuota.abs() : ZERO,
      taxRateCode: bucket.rate.toFixed(0),
      taxBase: round2(bucket.base)
    });
  }
  for (const bucket of computation.recargo) {
    const cuota = round2(bucket.cuota);
    if (cuota.isZero()) continue;
    lines.push({ accountCode: "477", description: `Recargo de equivalencia repercutido al ${bucket.rate.toString()} %`, debit: cuota.greaterThan(0) ? cuota : ZERO, credit: cuota.lessThan(0) ? cuota.abs() : ZERO, taxRateCode: `RE${bucket.rate.toString()}`, taxBase: round2(bucket.base) });
  }
  // Deductible quota per rate (pre-prorrata rows; the prorrata reduction, when any, is posted as one 472 → 634 adjustment by the ledger lot — reported as aviso).
  const soportado = new Map<string, { rate: Money; base: Money; cuota: Money }>();
  for (const row of computation.deductibleRows) {
    const key = row.rate.toFixed(2);
    const bucket = soportado.get(key) ?? { rate: row.rate, base: ZERO, cuota: ZERO };
    bucket.base = bucket.base.plus(row.base);
    bucket.cuota = bucket.cuota.plus(row.quota);
    soportado.set(key, bucket);
  }
  let deductibleTotal = ZERO;
  for (const bucket of Array.from(soportado.values()).sort((a, b) => b.rate.comparedTo(a.rate))) {
    const cuota = round2(bucket.cuota);
    if (cuota.isZero()) continue;
    deductibleTotal = deductibleTotal.plus(cuota);
    const accountCode = accountFor("472", bucket.rate);
    lines.push({
      accountCode,
      description: `IVA soportado deducible al ${bucket.rate.toFixed(0)} % (cuota del periodo)`,
      debit: cuota.lessThan(0) ? cuota.abs() : ZERO,
      credit: cuota.greaterThan(0) ? cuota : ZERO,
      taxRateCode: bucket.rate.toFixed(0),
      taxBase: round2(bucket.base)
    });
  }
  if (!round2(deductibleTotal).equals(computation.totalCuotaDeducible)) {
    avisos.push(`La prorrata reduce la deducción de ${round2(deductibleTotal).toFixed(2)} € a ${computation.totalCuotaDeducible.toFixed(2)} €: la diferencia (${round2(deductibleTotal).minus(computation.totalCuotaDeducible).toFixed(2)} €) queda en 472 hasta que el lote ledger la lleve a gasto (634).`);
  }
  // Result before compensation = Σ477 − Σ472 as posted (repercutido net − soportado posted).
  const repercutido = lines.filter((line) => line.accountCode.startsWith("477")).reduce((sum, line) => sum.plus(line.debit).minus(line.credit), ZERO);
  const soportadoPosted = lines.filter((line) => line.accountCode.startsWith("472")).reduce((sum, line) => sum.plus(line.credit).minus(line.debit), ZERO);
  const resultado66 = round2(repercutido.minus(soportadoPosted));
  let resultado: SettlementPlan["resultado"] = "zero";
  let importe = ZERO;
  if (resultado66.greaterThan(0)) {
    const compensacion = Prisma.Decimal.min(computation.compensacionPendienteInicial, resultado66);
    if (compensacion.greaterThan(0)) {
      lines.push({ accountCode: "4700", description: "Cuotas a compensar de periodos anteriores aplicadas (casilla 78)", debit: ZERO, credit: compensacion, taxRateCode: null, taxBase: null });
    }
    const aIngresar = round2(resultado66.minus(compensacion));
    if (aIngresar.greaterThan(0)) {
      lines.push({ accountCode: "4750", description: "Hacienda Pública, acreedora por IVA (resultado a ingresar, casilla 71)", debit: ZERO, credit: aIngresar, taxRateCode: null, taxBase: null });
      resultado = "to_pay";
      importe = aIngresar;
    } else {
      resultado = "zero";
      importe = ZERO;
    }
  } else if (resultado66.lessThan(0)) {
    lines.push({ accountCode: "4700", description: "Hacienda Pública, deudora por IVA (resultado a compensar, casilla 71)", debit: resultado66.abs(), credit: ZERO, taxRateCode: null, taxBase: null });
    resultado = "to_offset";
    importe = resultado66.abs();
  }
  const totalDebit = round2(lines.reduce((sum, line) => sum.plus(line.debit), ZERO));
  const totalCredit = round2(lines.reduce((sum, line) => sum.plus(line.credit), ZERO));
  return { lines, resultado, importe, totalDebit, totalCredit, avisos };
}

function lineDto(line: SettlementLine): VatSettlementLineDto {
  return { accountCode: line.accountCode, description: line.description, debit: toWire(line.debit), credit: toWire(line.credit), taxRateCode: line.taxRateCode, taxBase: line.taxBase === null ? null : toWire(line.taxBase) };
}

// ── Preview / settle / reverse ──────────────────────────────────────────────

async function chartLookup(organizationId: string): Promise<(code: string) => boolean> {
  const accounts = await prisma.account.findMany({ where: { organizationId, OR: [{ code: { startsWith: "477" } }, { code: { startsWith: "472" } }, { code: { in: ["4700", "4750"] } }] }, select: { code: true, isPostable: true } });
  const postable = new Set(accounts.filter((account) => account.isPostable).map((account) => account.code));
  return (code) => postable.has(code);
}

async function buildPreview(input: { organizationId: string; periodo: FiscalPeriodDto }): Promise<VatSettlementPreview> {
  const settings = await getVatSettings(input.organizationId);
  const model = await modelo303ForPeriod({ organizationId: input.organizationId, periodo: input.periodo, settings });
  const hasAccount = await chartLookup(input.organizationId);
  const plan = settlementLinesFrom(model.computation, hasAccount);
  const existing = model.report.fuentes.liquidacion && !model.report.fuentes.liquidacion.reversed ? model.report.fuentes.liquidacion : null;
  const avisos = [...plan.avisos];
  if (!hasAccount("4750") || !hasAccount("4700")) avisos.push("Faltan las cuentas 4750/4700 en el plan contable: la liquidación no puede asentarse (provisiona el plan «PGC Pymes hotelero»).");
  // Corrector FIX-1 (SEC-01): a chained 110 means earlier periods are not posted; their result is not in 4700 yet.
  if (model.compensacionEncadenadaDesde.length > 0) {
    avisos.push(`La casilla 110 (${model.computation.compensacionPendienteInicial.toFixed(2)} €) incluye el resultado de ${model.compensacionEncadenadaDesde.length} periodo(s) sin asiento de liquidación (${model.compensacionEncadenadaDesde.join(", ")}): asiéntalos antes para que el saldo de 4700 cuadre con la compensación aplicada.`);
  }
  return {
    organizationId: input.organizationId,
    periodo: input.periodo,
    resultado: plan.resultado,
    importe: toWire(plan.importe),
    compensacionAplicada: toWire(model.computation.compensacionAplicada),
    compensacionPendienteInicial: toWire(model.computation.compensacionPendienteInicial),
    compensacionPendienteFinal: toWire(model.computation.compensacionPendienteFinal),
    lines: plan.lines.map(lineDto),
    totalDebit: toWire(plan.totalDebit),
    totalCredit: toWire(plan.totalCredit),
    balanced: plan.totalDebit.equals(plan.totalCredit),
    avisos,
    existing: existing ? { journalEntryId: existing.journalEntryId, entryNumber: existing.entryNumber, fiscalYearCode: existing.fiscalYearCode, entryDate: existing.entryDate } : null,
    modelo303: model.report
  };
}

export async function previewVatSettlement(input: { context: UserContext; period: string }): Promise<VatSettlementPreview> {
  requirePermissions(input.context, ["accounting.read"]);
  // The settlement is of the sociedad (propertyId = null): whole-sociedad scope required (R11).
  assertFinanceReadScope(input.context, null);
  const settings = await getVatSettings(input.context.organizationId);
  const periodo = resolveSettlementPeriod({ period: input.period }, settings.periodicity);
  return buildPreview({ organizationId: input.context.organizationId, periodo });
}

export type VatSettlementDeps = { ledger?: LedgerEngine; today?: () => string };

export async function settleVatPeriod(input: { context: UserContext; period: string; entryDate?: string; correlationId?: string }, deps: VatSettlementDeps = {}): Promise<VatSettlementResult> {
  requirePermissions(input.context, ["accounting.journal.post"]);
  const ledger = deps.ledger ?? interimLedgerEngine;
  const organizationId = input.context.organizationId;
  const settings = await ensureVatSettings(organizationId);
  const periodo = resolveSettlementPeriod({ period: input.period }, settings.periodicity);
  const today = deps.today ? deps.today() : madridDay(new Date());
  if (periodo.to >= today) {
    throw new ConflictError(`El periodo ${periodo.code} no ha terminado (hasta ${periodo.to}): la liquidación se asienta al cierre del periodo.`, { code: "PERIOD_NOT_ENDED", to: periodo.to });
  }
  const entryDate = input.entryDate ?? periodo.to;
  if (!isIsoDay(entryDate)) throw new BadRequestError("entryDate debe ser una fecha YYYY-MM-DD.");
  if (entryDate < periodo.to) throw new BadRequestError(`entryDate no puede ser anterior al fin del periodo (${periodo.to}).`);
  const preview = await buildPreview({ organizationId, periodo });
  if (preview.existing) {
    throw new ConflictError(`El periodo ${periodo.code} ya está liquidado (asiento ${preview.existing.entryNumber ?? preview.existing.journalEntryId}).`, { code: "ALREADY_SETTLED", journalEntryId: preview.existing.journalEntryId });
  }
  if (preview.lines.length === 0) throw new ConflictError(`Sin cuotas de IVA en ${periodo.code}: nada que liquidar.`, { code: "NOTHING_TO_SETTLE" });
  if (!preview.balanced) throw new ConflictError("La liquidación no cuadra; revisa los avisos.", { code: "JOURNAL_UNBALANCED" });
  const posted = await ledger.postJournalEntry({
    organizationId,
    propertyId: null,
    entryDate,
    sourceType: "vat_settlement",
    sourceId: vatSettlementSourceId(periodo.code),
    description: `Liquidación IVA ${periodo.code} (Modelo 303 ${periodo.aeatPeriod}/${periodo.year})`,
    reference: `303 ${periodo.aeatPeriod}/${periodo.year}`,
    createdBy: input.context.userId,
    lines: preview.lines.map((line) => ({ accountCode: line.accountCode, debit: line.debit.toFixed(2), credit: line.credit.toFixed(2), description: line.description, taxRateCode: line.taxRateCode, taxBase: line.taxBase === null ? null : line.taxBase.toFixed(2) }))
  });
  recordAuditEvent({
    organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "VAT_SETTLEMENT_POSTED",
    entityType: "journal_entry",
    entityId: posted.id,
    afterJson: { period: periodo.code, resultado: preview.resultado, importe: preview.importe, entryNumber: posted.entryNumber, fiscalYearCode: posted.fiscalYearCode, lines: preview.lines },
    correlationId: input.correlationId
  });
  return { journalEntryId: posted.id, entryNumber: posted.entryNumber, fiscalYearCode: posted.fiscalYearCode, entryDate: posted.entryDate, resultado: preview.resultado, importe: preview.importe, lines: preview.lines };
}

export async function reverseVatSettlement(input: { context: UserContext; period: string; reason?: string; entryDate?: string; correlationId?: string }, deps: VatSettlementDeps = {}): Promise<VatSettlementReversalResult> {
  requirePermissions(input.context, ["accounting.journal.post"]);
  const ledger = deps.ledger ?? interimLedgerEngine;
  const organizationId = input.context.organizationId;
  const settings = await getVatSettings(organizationId);
  const periodo = resolveSettlementPeriod({ period: input.period }, settings.periodicity);
  const entry = await prisma.journalEntry.findFirst({ where: { organizationId, sourceType: "vat_settlement", sourceId: vatSettlementSourceId(periodo.code), status: "posted", reversedById: null }, select: { id: true } });
  if (!entry) throw new NotFoundError(`El periodo ${periodo.code} no tiene asiento de liquidación vigente.`);
  const entryDate = input.entryDate ?? (deps.today ? deps.today() : madridDay(new Date()));
  if (!isIsoDay(entryDate)) throw new BadRequestError("entryDate debe ser una fecha YYYY-MM-DD.");
  const reason = input.reason?.trim();
  const reversal = await ledger.reverseJournalEntry({ organizationId, journalEntryId: entry.id, entryDate, description: `Anulación liquidación IVA ${periodo.code}${reason ? ` — ${reason}` : ""}`, createdBy: input.context.userId });
  recordAuditEvent({
    organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "VAT_SETTLEMENT_REVERSED",
    entityType: "journal_entry",
    entityId: entry.id,
    afterJson: { period: periodo.code, reversalJournalEntryId: reversal.id, reason: reason ?? null },
    correlationId: input.correlationId
  });
  return { reversedJournalEntryId: entry.id, reversalJournalEntryId: reversal.id, entryNumber: reversal.entryNumber, entryDate: reversal.entryDate };
}
