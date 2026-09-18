// Libro registro de facturas emitidas (RD 1619/2012) — the ONE live writer of
// the emitidas book, used by invoice.service.ts for F1/F2, rectificativas and
// cancellations. One row per document AND rate (VatBookEntry unique on
// organisation · book · sourceType · sourceId · rate); written in the SAME
// transaction as the fiscal document. The period is computed with the
// organisation's VatSettings (quarterly by default; the IVA/AEAT lote owns
// ensureVatSettings — this reader never creates the row, it falls back to the
// documented defaults).
//
// sourceId convention (Tanda L3-C; single source: accounting/vat-books.service.ts,
// whose `deriveVatBookRows` / `rebuildVatBooks` derive the SAME rows so a rebuild
// reproduces the live book row by row):
//   · `<invoiceId>`             — the document's own rows (issue: positive on F1/F2,
//                                 signed by the document on a rectificativa);
//   · `<invoiceId>#anulacion`   — negating counter-rows of a cancellation
//                                 (`negate: true`), dated on the cancellation instant;
//   · `<originalId>#sustituida` — negating counter-rows of the ORIGINAL replaced by a
//                                 rectificativa por sustitución («S»), dated on the
//                                 substitute's issue instant; the substitute writes
//                                 its own full rows under its own id.
// `skipDuplicates: true` keeps every write idempotent by (sourceType, sourceId,
// rate): a retry of the same transaction never doubles a row. The pre-L3 suffix
// `<id>:anulacion` is never written here; the rebuild purges it.

import type { Prisma } from "@hotelos/database";
import type { VatBookRowInput } from "./invoice-snapshot.js";

export { VAT_BOOK_CANCELLATION_SUFFIX, VAT_BOOK_SUPERSEDED_SUFFIX, cancellationSourceId, supersededSourceId } from "../accounting/vat-books.service.js";

export type VatPeriodicity = "quarterly" | "monthly";

/** "2026-Q3" (quarterly) or "2026-09" (monthly) for a date, Europe/Madrid calendar. Pure. */
export function vatPeriodFor(date: Date, periodicity: VatPeriodicity): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit" }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")!.value;
  const month = Number(parts.find((p) => p.type === "month")!.value);
  if (periodicity === "monthly") return `${year}-${String(month).padStart(2, "0")}`;
  return `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
}

export type VatSettingsSlice = { periodicity: VatPeriodicity; taxFigure: string };

/** VatSettings of the organisation or the documented defaults (quarterly · IVA). */
export async function readVatSettings(tx: Pick<Prisma.TransactionClient, "vatSettings">, organizationId: string): Promise<VatSettingsSlice> {
  const row = await tx.vatSettings.findUnique({ where: { organizationId }, select: { periodicity: true, taxFigure: true } });
  return { periodicity: row?.periodicity ?? "quarterly", taxFigure: row?.taxFigure ?? "IVA" };
}

export type IssuedVatBookInput = {
  organizationId: string;
  propertyId: string | null;
  sourceType: "invoice" | "rectification" | "simplified";
  /**
   * Invoice id; `${invoiceId}#anulacion` for the counter-rows of a cancellation;
   * `${originalId}#sustituida` for the counter-rows of an original replaced by a
   * rectificativa «S» (see the header: `cancellationSourceId` / `supersededSourceId`).
   */
  sourceId: string;
  date: Date;
  series: string | null;
  number: string | null;
  counterpartyNif: string | null;
  counterpartyName: string | null;
  rows: VatBookRowInput[];
  /** Multiply every amount by −1 (cancellation counter-rows). */
  negate?: boolean;
};

/**
 * Write the emitted-book rows of a document. Idempotent: rows that already
 * exist for (sourceType, sourceId, rate) are skipped. Returns the number of
 * rows written.
 */
export async function writeIssuedVatBookRows(tx: Pick<Prisma.TransactionClient, "vatBookEntry" | "vatSettings">, input: IssuedVatBookInput): Promise<number> {
  if (input.rows.length === 0) return 0;
  const settings = await readVatSettings(tx, input.organizationId);
  const period = vatPeriodFor(input.date, settings.periodicity);
  const sign = input.negate ? -1 : 1;
  const day = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(input.date)}T00:00:00.000Z`);
  const result = await tx.vatBookEntry.createMany({
    data: input.rows.map((row) => ({
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      book: "emitidas" as const,
      date: day,
      series: input.series,
      number: input.number,
      counterpartyNif: input.counterpartyNif,
      counterpartyName: input.counterpartyName,
      base: (row.base * sign).toFixed(2),
      rate: row.rate.toFixed(2),
      quota: (row.quota * sign).toFixed(2),
      total: (row.total * sign).toFixed(2),
      retention: "0.00",
      taxFigure: row.taxFigure || settings.taxFigure,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      period,
      deductible: true
    })),
    skipDuplicates: true
  });
  return result.count;
}
