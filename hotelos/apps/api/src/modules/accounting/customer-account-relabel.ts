// Customer sub-ledger sanitation: 430 → 4300 (fix:ledger 2026-09-16, t6#4).
//
// Until this fix the ledger engine, the projection and the historical replay
// debited / credited the 3-digit «430 Clientes» while the invoicing, folio
// and payments writers used the sub-account «4300 Clientes (euros)»: one
// customer, two accounts, and neither mayor told the truth. Every writer now
// uses CUSTOMER_ACCOUNT_CODE (packages/shared) = 4300; what remains is the
// history already posted to 430 (Faranda: the 61 asientos of the 2026-09-16
// replay, all sandbox re-projections of documents).
//
// What this module does — and does not:
//   · it MOVES journal lines from 430 to 4300 (account_id + account_code)
//     inside one transaction, with the same amounts, sides, dates and
//     numbers: 430 is the header of 4300 (PGC: cuenta → subcuenta), so the
//     balance of the 43 subgroup, the trial balance, the balance sheet and
//     every report stay identical to the cent; only the level of detail of
//     the customer sub-ledger changes. It is a relabel, not an asiento;
//   · it never touches an entry dated inside a CLOSED fiscal year (blocking:
//     reopen first — a closed ejercicio is untouchable by design);
//   · it is audited (ACCOUNTING_CUSTOMER_ACCOUNT_RELABELED with the before /
//     after sums) and idempotent (a second run finds 0 lines);
//   · it is the sandbox-appropriate correction. For a legalised diario (art.
//     27 Código de Comercio, libros ya presentados) the operator must prefer
//     an asiento de reclasificación D 4300 / H 430 for the net balance at the
//     date instead; this module refuses nothing in that respect because the
//     platform has no notion of legalised books yet — the CLI documents it.
//
// Dry-run by default; the apply path is only reachable through the CLI
// (scripts/accounting-relabel-customer-account.ts) with --apply --confirm.

import { prisma } from "@hotelos/database";
import { Prisma } from "@prisma/client";
import { CUSTOMER_ACCOUNT_CODE } from "../../../../../packages/shared/src/accounting-types.js";
import { ZERO, ledgerConflict, type Decimal } from "./accounting.service.js";

const D = Prisma.Decimal;

/** The header the legacy writers used (3-digit «Clientes»). */
export const LEGACY_CUSTOMER_ACCOUNT_CODE = "430";
export const AUDIT_ACTION_CUSTOMER_RELABEL = "ACCOUNTING_CUSTOMER_ACCOUNT_RELABELED";

export type RelabelBreakdownRow = { sourceType: string; entries: number; lines: number; debit: string; credit: string };

export type CustomerRelabelPlan = {
  organizationId: string;
  fromCode: string;
  toCode: string;
  fromAccountId: string | null;
  toAccountId: string | null;
  /** Lines currently on 430 (any entry status). */
  lines: number;
  entries: number;
  debit: string;
  credit: string;
  bySourceType: RelabelBreakdownRow[];
  /** Entries dated inside a closed fiscal year: the run is refused while any exists. */
  closedYearEntries: number;
  /** Typed reasons the apply would be refused (empty = applicable). */
  blocking: string[];
};

export type CustomerRelabelResult = CustomerRelabelPlan & {
  applied: boolean;
  /** Lines actually updated (== plan.lines when applied). */
  updated: number;
  /** 4300 balance (debit − credit) after the run, for the operator's eyes. */
  targetBalanceAfter: string;
};

type Client = Prisma.TransactionClient | typeof prisma;

type RawBreakdown = { source_type: string; entries: bigint | number; lines: bigint | number; debit: Prisma.Decimal; credit: Prisma.Decimal };

async function breakdown(client: Client, organizationId: string, accountId: string): Promise<RelabelBreakdownRow[]> {
  const rows = await client.$queryRaw<RawBreakdown[]>`
    SELECT je.source_type, COUNT(DISTINCT je.id) AS entries, COUNT(jl.id) AS lines,
           COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.organization_id = ${organizationId} AND jl.account_id = ${accountId}
    GROUP BY je.source_type
    ORDER BY je.source_type`;
  return rows.map((row) => ({ sourceType: row.source_type, entries: Number(row.entries), lines: Number(row.lines), debit: new D(row.debit).toFixed(2), credit: new D(row.credit).toFixed(2) }));
}

async function closedYearEntryCount(client: Client, organizationId: string, accountId: string): Promise<number> {
  const rows = await client.$queryRaw<Array<{ n: bigint | number }>>`
    SELECT COUNT(DISTINCT je.id) AS n
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    JOIN fiscal_years fy ON fy.organization_id = je.organization_id
      AND (fy.property_id IS NULL OR fy.property_id = je.property_id)
      AND fy.status = 'closed'
      AND je.entry_date >= fy.start_date::date AND je.entry_date <= fy.end_date::date
    WHERE je.organization_id = ${organizationId} AND jl.account_id = ${accountId}`;
  return Number(rows[0]?.n ?? 0);
}

/** Read-only: what an apply would move, and why it would be refused. */
export async function planCustomerAccountRelabel(organizationId: string, client: Client = prisma): Promise<CustomerRelabelPlan> {
  const accounts = await client.account.findMany({
    where: { organizationId, code: { in: [LEGACY_CUSTOMER_ACCOUNT_CODE, CUSTOMER_ACCOUNT_CODE] } },
    select: { id: true, code: true, kind: true, isPostable: true }
  });
  const from = accounts.find((a) => a.code === LEGACY_CUSTOMER_ACCOUNT_CODE) ?? null;
  const to = accounts.find((a) => a.code === CUSTOMER_ACCOUNT_CODE) ?? null;
  const blocking: string[] = [];
  if (!to) blocking.push("TARGET_ACCOUNT_MISSING");
  else if (!to.isPostable) blocking.push("TARGET_ACCOUNT_NOT_POSTABLE");
  else if (String(to.kind) !== "asset") blocking.push("TARGET_ACCOUNT_KIND");
  const rows = from ? await breakdown(client, organizationId, from.id) : [];
  const closedYearEntries = from ? await closedYearEntryCount(client, organizationId, from.id) : 0;
  if (closedYearEntries > 0) blocking.push("CLOSED_FISCAL_YEAR_ENTRIES");
  let debit: Decimal = ZERO;
  let credit: Decimal = ZERO;
  let lines = 0;
  let entries = 0;
  for (const row of rows) {
    debit = debit.plus(row.debit);
    credit = credit.plus(row.credit);
    lines += row.lines;
    entries += row.entries;
  }
  return {
    organizationId,
    fromCode: LEGACY_CUSTOMER_ACCOUNT_CODE,
    toCode: CUSTOMER_ACCOUNT_CODE,
    fromAccountId: from?.id ?? null,
    toAccountId: to?.id ?? null,
    lines,
    entries,
    debit: debit.toFixed(2),
    credit: credit.toFixed(2),
    bySourceType: rows,
    closedYearEntries,
    blocking
  };
}

async function targetBalance(client: Client, organizationId: string, accountId: string): Promise<string> {
  const rows = await client.$queryRaw<Array<{ balance: Prisma.Decimal | null }>>`
    SELECT COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0) AS balance
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.organization_id = ${organizationId} AND jl.account_id = ${accountId} AND je.status <> 'draft'`;
  return new D(rows[0]?.balance ?? 0).toFixed(2);
}

/**
 * Move every 430 line of the organisation to 4300 in one transaction
 * (advisory lock per organisation; the plan is recomputed inside the lock),
 * then record the audit event. Refuses with 409 when the plan is blocking.
 */
export async function applyCustomerAccountRelabel(organizationId: string, input: { actorUserId?: string | null; correlationId?: string } = {}): Promise<CustomerRelabelResult> {
  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${organizationId}:customer-relabel`}))`;
      const plan = await planCustomerAccountRelabel(organizationId, tx);
      if (plan.blocking.length > 0) {
        throw ledgerConflict("CUSTOMER_RELABEL_BLOCKED", `No se puede trasladar 430 → 4300 en ${organizationId}: ${plan.blocking.join(", ")}.`, { organizationId, blocking: plan.blocking, closedYearEntries: plan.closedYearEntries });
      }
      if (plan.lines === 0 || !plan.fromAccountId || !plan.toAccountId) {
        return { ...plan, applied: false, updated: 0, targetBalanceAfter: plan.toAccountId ? await targetBalance(tx, organizationId, plan.toAccountId) : "0.00" };
      }
      const updated = await tx.$executeRaw`
        UPDATE journal_lines jl
        SET account_id = ${plan.toAccountId}, account_code = ${CUSTOMER_ACCOUNT_CODE}
        FROM journal_entries je
        WHERE je.id = jl.journal_entry_id AND je.organization_id = ${organizationId} AND jl.account_id = ${plan.fromAccountId}`;
      if (updated !== plan.lines) {
        // The plan and the update ran under the same lock: a mismatch means a concurrent writer bypassed it.
        throw ledgerConflict("CUSTOMER_RELABEL_MISMATCH", `Se esperaban ${plan.lines} líneas y se actualizaron ${updated}: transacción revertida.`, { organizationId, expected: plan.lines, updated });
      }
      const remaining = await tx.journalLine.count({ where: { accountId: plan.fromAccountId } });
      if (remaining !== 0) throw ledgerConflict("CUSTOMER_RELABEL_MISMATCH", `Quedan ${remaining} líneas en 430 tras el traslado: transacción revertida.`, { organizationId, remaining });
      return { ...plan, applied: true, updated, targetBalanceAfter: await targetBalance(tx, organizationId, plan.toAccountId) };
    },
    { maxWait: 15_000, timeout: 120_000 }
  );
  if (result.applied) {
    // Dynamic import: audit.service drags the demo store; the CLI and the tests only need it on apply.
    const audit = await import("../audit/audit.service.js");
    audit.recordAuditEvent({
      organizationId,
      actorUserId: input.actorUserId ?? undefined,
      actorType: input.actorUserId ? "user" : "system",
      action: AUDIT_ACTION_CUSTOMER_RELABEL,
      entityType: "account",
      entityId: result.toAccountId ?? CUSTOMER_ACCOUNT_CODE,
      beforeJson: { fromCode: result.fromCode, lines: result.lines, entries: result.entries, debit: result.debit, credit: result.credit, bySourceType: result.bySourceType },
      afterJson: { toCode: result.toCode, updated: result.updated, targetBalanceAfter: result.targetBalanceAfter },
      correlationId: input.correlationId ?? "corr_customer_relabel"
    });
  }
  return result;
}
