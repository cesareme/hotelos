// Activo inmobiliario · ejecución de una obra (Tanda ACT · L4, diseño §4
// `CapexProject` ampliado y decisión del brief: «capex como proyectos con
// presupuesto y ejecución por asientos reales de Sage (cuentas 23x/21x por
// hotel) cuando existan»).
//
// Hecho verificado en la BD: el plan de Sage lleva el centro en las cifras
// 5-6 de la cuenta de 10 dígitos (2110040001 → 211) y ledger_account_maps las
// colapsa a 210/211/212…, así que el centro sale de journal_entries.property_id
// y la cuenta de journal_lines.account_code. La ejecución leída del diario es
// Σ(debe − haber) de las líneas de asientos `posted` de tipo `normal` (sin
// apertura, cierre, regularización ni reversos) del centro, entre `from`
// (startDate del proyecto, si la tiene) y `to` (targetEndDate o hoy), cuya
// cuenta empieza por alguno de los prefijos del proyecto
// (`executionAccountPrefixes`, por defecto DEFAULT_CAPEX_EXECUTION_PREFIXES).
// Un solo `$queryRaw` parametrizado (Prisma.sql / Prisma.join).
//
// `executionOf` decide la fuente: el diario cuando hay líneas, si no la suma
// de `CapexItem.actualCost` (partidas del proyecto). Los cálculos son puros y
// van exportados para __tests__/capex-execution.test.mts (sin BD).

import { prisma } from "@hotelos/database";
import { Prisma } from "@prisma/client";
import type { CapexExecutionSource, CapexWorkKind, IsoDay, MoneyString } from "@hotelos/shared";
import { dec, money, round2, ZERO, type Decimal } from "../payables/money.js";

type Db = Prisma.TransactionClient | typeof prisma;

/** Prefijos por defecto (21x inmovilizado material salvo terrenos 210 y vehículos 218; 231/232 en curso). */
export const DEFAULT_CAPEX_EXECUTION_PREFIXES: readonly string[] = ["211", "212", "213", "215", "216", "217", "219", "231", "232"];

const PREFIX_PATTERN = /^\d{2,10}$/;

/** Lista de prefijos de `executionAccountPrefixes` («211,212»); vacío o null → los de por defecto. Deduplica y descarta lo que no sea numérico. */
export function parseExecutionPrefixes(raw: string | null | undefined): string[] {
  const parsed = (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => PREFIX_PATTERN.test(part));
  const unique = Array.from(new Set(parsed));
  return unique.length > 0 ? unique : [...DEFAULT_CAPEX_EXECUTION_PREFIXES];
}

/** Forma persistida de la lista (separada por comas); null borra la personalización. */
export function serializeExecutionPrefixes(prefixes: readonly string[] | null | undefined): string | null {
  if (!prefixes) return null;
  const unique = Array.from(new Set(prefixes.map((p) => p.trim()).filter((p) => PREFIX_PATTERN.test(p))));
  return unique.length > 0 ? unique.join(",") : null;
}

export type LedgerExecutionWindow = {
  organizationId: string;
  propertyId: string;
  /** Inicio (inclusive) o null sin límite inferior. */
  from: IsoDay | null;
  /** Fin (inclusive). */
  to: IsoDay;
  prefixes: readonly string[];
};

export type LedgerExecution = {
  /** Σ(debe − haber) de las líneas que cumplen la ventana (0 sin líneas). */
  amount: Decimal;
  /** Número de líneas sumadas; 0 = el diario no tiene ejecución para el proyecto. */
  lines: number;
};

/** Ventana de lectura del diario de un proyecto: [startDate, targetEndDate ?? hoy]. */
export function executionWindow(project: { startDate: Date | null; targetEndDate: Date | null }, today: IsoDay): { from: IsoDay | null; to: IsoDay } {
  const from = project.startDate ? project.startDate.toISOString().slice(0, 10) : null;
  const to = project.targetEndDate ? project.targetEndDate.toISOString().slice(0, 10) : today;
  return { from, to };
}

/** SQL parametrizado de la ejecución (exportado para el test unitario: parámetros y forma, sin BD). */
export function buildLedgerExecutionSql(window: LedgerExecutionWindow): Prisma.Sql {
  const prefixes = window.prefixes.length > 0 ? window.prefixes : DEFAULT_CAPEX_EXECUTION_PREFIXES;
  const accountFilter = Prisma.join(
    prefixes.map((prefix) => Prisma.sql`jl.account_code LIKE ${`${prefix}%`}`),
    " OR "
  );
  const fromFilter = window.from ? Prisma.sql`AND je.entry_date >= ${window.from}::date` : Prisma.empty;
  return Prisma.sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS amount, COUNT(*)::int AS lines
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.organization_id = ${window.organizationId}
      AND je.property_id = ${window.propertyId}
      AND je.status = 'posted'
      AND je.entry_kind = 'normal'
      AND je.entry_date <= ${window.to}::date
      ${fromFilter}
      AND jl.account_code IS NOT NULL
      AND (${accountFilter})
  `;
}

/** Ejecución leída del diario del centro (un solo $queryRaw). */
export async function computeLedgerExecution(db: Db, window: LedgerExecutionWindow): Promise<LedgerExecution> {
  const rows = await db.$queryRaw<Array<{ amount: string | null; lines: number | bigint | null }>>(buildLedgerExecutionSql(window));
  const row = rows[0];
  const lines = Number(row?.lines ?? 0);
  return { amount: lines > 0 ? round2(dec(row?.amount ?? "0")) : ZERO, lines };
}

export type CapexExecution = {
  executedAmountLedger: MoneyString | null;
  executedAmountItems: MoneyString;
  executedAmount: MoneyString;
  executionSource: CapexExecutionSource;
};

/** Σ `CapexItem.actualCost` (partidas del proyecto). */
export function itemsExecution(items: ReadonlyArray<{ actualCost: Decimal | string | number }>): Decimal {
  return round2(items.reduce((acc, item) => acc.plus(dec(item.actualCost)), ZERO));
}

/**
 * Fuente y cifras de ejecución de un proyecto. Con `ledger` (recién leído)
 * manda el diario si tiene líneas; sin `ledger` se usa la caché
 * `executedAmountLedger` de la fila (null = sin líneas la última vez).
 */
export function executionOf(project: { executedAmountLedger: Decimal | string | number | null }, items: ReadonlyArray<{ actualCost: Decimal | string | number }>, ledger?: LedgerExecution | null): CapexExecution {
  const ledgerAmount: Decimal | null = ledger ? (ledger.lines > 0 ? round2(ledger.amount) : null) : project.executedAmountLedger === null ? null : round2(dec(project.executedAmountLedger));
  const itemsAmount = itemsExecution(items);
  const fromLedger = ledgerAmount !== null;
  return {
    executedAmountLedger: fromLedger ? money(ledgerAmount) : null,
    executedAmountItems: money(itemsAmount),
    executedAmount: money(fromLedger ? ledgerAmount : itemsAmount),
    executionSource: fromLedger ? "ledger" : "items"
  };
}

/** Coste de capitalización: ejecución (diario o partidas) + ICIO (§4: «coste = Σ actualCost + ICIO + licencias»). */
export function capitalizationCost(execution: Pick<CapexExecution, "executedAmount">, icioAmount: Decimal | string | number | null | undefined): Decimal {
  return round2(dec(execution.executedAmount).plus(icioAmount === null || icioAmount === undefined ? ZERO : dec(icioAmount)));
}

/** Cuenta de inmovilizado al capitalizar: 212 (instalaciones técnicas) para eficiencia energética, 211 (construcciones) en el resto. */
export function capitalizationAccountFor(workKind: CapexWorkKind | string | null | undefined): "211" | "212" {
  return workKind === "eficiencia_energetica" ? "212" : "211";
}
