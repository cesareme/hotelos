// Unit tests · Tanda 7c · L2 — cierre importado del ejercicio (`fiscal-year.service.ts`):
// `markFiscalYearClosedFromImport` con una transacción falsa (update del ejercicio y de sus
// periodos abiertos con la nota «cerrado por importación <importId>»; rehúsa un ejercicio ya
// cerrado; 404 si no existe) y pin de fuente: en `reopenFiscalYear` la comprobación
// sage200_* (409 FISCAL_YEAR_CLOSED_FROM_IMPORT) precede a la búsqueda de closeEntries. El
// 409 real se cubre en tests/integration/ledger-import.test.mts. Desde apps/api:
//   node --import tsx --test src/modules/accounting/import/__tests__/fiscal-year-import-close.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { HttpError } from "../../../../lib/http-error.js";
import { importClosingNote, markFiscalYearClosedFromImport, type FiscalYearImportCloseClient } from "../../fiscal-year.service.js";

type YearRow = { id: string; organizationId: string; propertyId: string | null; code: string; status: string; startDate: Date; endDate: Date };

function fakeTx(year: YearRow | null, closedPeriods = 3): FiscalYearImportCloseClient & { updates: Array<Record<string, unknown>>; periodUpdates: Array<Record<string, unknown>> } {
  const updates: Array<Record<string, unknown>> = [];
  const periodUpdates: Array<Record<string, unknown>> = [];
  return {
    updates,
    periodUpdates,
    fiscalYear: {
      findUnique: async () => year,
      update: async (args: Record<string, unknown>) => {
        updates.push(args);
        return { ...year, ...(args.data as Record<string, unknown>) };
      }
    },
    fiscalPeriod: {
      updateMany: async (args: Record<string, unknown>) => {
        periodUpdates.push(args);
        return { count: closedPeriods };
      }
    }
  } as unknown as FiscalYearImportCloseClient & { updates: Array<Record<string, unknown>>; periodUpdates: Array<Record<string, unknown>> };
}

const openYear: YearRow = { id: "fy_2024", organizationId: "org_li", propertyId: null, code: "2024", status: "open", startDate: new Date("2024-01-01T00:00:00Z"), endDate: new Date("2024-12-31T00:00:00Z") };

describe("markFiscalYearClosedFromImport (transacción falsa)", () => {
  it("deja el ejercicio closed con los asientos importados y cierra los periodos abiertos con la nota del lote, sin generar asientos", async () => {
    const tx = fakeTx(openYear, 12);
    const result = await markFiscalYearClosedFromImport(tx, { fiscalYearId: "fy_2024", closingEntryId: "je_close", openingEntryId: "je_open", netResult: "60000.00", importId: "imp_bal" });
    assert.deepEqual(result, { fiscalYearId: "fy_2024", code: "2024", closedPeriods: 12 });
    assert.equal(tx.updates.length, 1);
    const data = tx.updates[0]!.data as Record<string, unknown>;
    assert.deepEqual({ status: data.status, closingEntryId: data.closingEntryId, openingEntryId: data.openingEntryId, netResult: data.netResult }, { status: "closed", closingEntryId: "je_close", openingEntryId: "je_open", netResult: "60000.00" });
    assert.ok(data.closedAt instanceof Date);
    assert.equal(tx.periodUpdates.length, 1);
    const where = tx.periodUpdates[0]!.where as Record<string, unknown>;
    assert.deepEqual({ organizationId: where.organizationId, propertyId: where.propertyId, status: where.status }, { organizationId: "org_li", propertyId: null, status: { not: "closed" } });
    assert.deepEqual(where.startDate, { gte: openYear.startDate });
    assert.deepEqual(where.endDate, { lte: openYear.endDate });
    const periodData = tx.periodUpdates[0]!.data as Record<string, unknown>;
    assert.deepEqual({ status: periodData.status, closingNotes: periodData.closingNotes }, { status: "closed", closingNotes: "cerrado por importación imp_bal" });
    assert.equal(importClosingNote("imp_bal"), "cerrado por importación imp_bal");
  });

  it("netResult numérico se guarda con dos decimales y openingEntryId ausente queda null", async () => {
    const tx = fakeTx(openYear, 0);
    await markFiscalYearClosedFromImport(tx, { fiscalYearId: "fy_2024", closingEntryId: "je_close", netResult: -1234.5, importId: "imp_bal" });
    const data = tx.updates[0]!.data as Record<string, unknown>;
    assert.deepEqual({ netResult: data.netResult, openingEntryId: data.openingEntryId }, { netResult: "-1234.50", openingEntryId: null });
  });

  it("rehúsa un ejercicio ya cerrado (409 FISCAL_YEAR_ALREADY_CLOSED) sin escribir nada", async () => {
    const tx = fakeTx({ ...openYear, status: "closed" });
    await assert.rejects(markFiscalYearClosedFromImport(tx, { fiscalYearId: "fy_2024", closingEntryId: "je_close", netResult: "0.00", importId: "imp_bal" }), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.statusCode, 409);
      assert.equal((error.details as { code: string }).code, "FISCAL_YEAR_ALREADY_CLOSED");
      return true;
    });
    assert.deepEqual([tx.updates.length, tx.periodUpdates.length], [0, 0]);
  });

  it("ejercicio inexistente → 404", async () => {
    const tx = fakeTx(null);
    await assert.rejects(markFiscalYearClosedFromImport(tx, { fiscalYearId: "fy_x", closingEntryId: "je_close", netResult: "0.00", importId: "imp_bal" }), (error: unknown) => error instanceof HttpError && error.statusCode === 404);
  });
});

describe("reopenFiscalYear · pin de fuente (design §10.4.2 #3)", () => {
  const source = readFileSync(fileURLToPath(new URL("../../fiscal-year.service.ts", import.meta.url)), "utf8");
  const reopenStart = source.indexOf("export async function reopenFiscalYear(");
  const reopenBody = source.slice(reopenStart, source.indexOf("export async function", reopenStart + 10));

  it("la comprobación sage200_journal / sage200_balance precede a la búsqueda de closeEntries y responde 409 FISCAL_YEAR_CLOSED_FROM_IMPORT { fiscalYearId, importId }", () => {
    assert.ok(reopenStart > 0);
    const guard = reopenBody.indexOf("FISCAL_YEAR_CLOSED_FROM_IMPORT");
    const closeEntries = reopenBody.indexOf("const closeEntries = await prisma.journalEntry.findMany(");
    assert.ok(guard > 0 && closeEntries > 0 && guard < closeEntries, "la guarda va antes de closeEntries");
    const guardBlock = reopenBody.slice(reopenBody.indexOf("const importedClose"), closeEntries);
    assert.match(guardBlock, /sourceType: \{ in: \[LEDGER_IMPORT_SOURCE_TYPES\.journal, LEDGER_IMPORT_SOURCE_TYPES\.balance\] \}/);
    assert.match(guardBlock, /status: \{ not: "draft" \}/);
    assert.match(guardBlock, /reversedById: null/);
    assert.match(guardBlock, /fiscalYearId: year\.id, entryKind: \{ in: \["regularization", "closing"\] \}/);
    assert.match(guardBlock, /ledgerImportEntry\.findFirst\(\{ where: \{ journalEntryId: importedClose\.id \}/);
    assert.match(guardBlock, /fiscalYearId: year\.id,\s*yearCode: year\.code,\s*importId: importEntry\?\.importId \?\? null/);
    assert.match(guardBlock, /reabrir = revertir el lote/);
  });

  it("closeFiscalYear sigue rechazando un ejercicio ya cerrado y markFiscalYearClosedFromImport no contabiliza asientos", () => {
    const closeStart = source.indexOf("export async function closeFiscalYear(");
    const closeBody = source.slice(closeStart, source.indexOf("export async function reopenFiscalYear("));
    assert.match(closeBody, /FISCAL_YEAR_ALREADY_CLOSED/);
    // SD-06: un ejercicio `open` con regularización / cierre importados vivos no se cierra de nuevo (duplicaría 129 y el cierre).
    const guard = closeBody.indexOf("FISCAL_YEAR_CLOSED_FROM_IMPORT");
    const openPeriods = closeBody.indexOf("const openPeriodCount");
    assert.ok(guard > 0 && openPeriods > 0 && guard < openPeriods, "la guarda del cierre importado precede al recuento de periodos abiertos");
    const guardBlock = closeBody.slice(closeBody.indexOf("const importedClose"), openPeriods);
    assert.match(guardBlock, /sourceType: \{ in: \[LEDGER_IMPORT_SOURCE_TYPES\.journal, LEDGER_IMPORT_SOURCE_TYPES\.balance\] \}/);
    assert.match(guardBlock, /entryKind: \{ in: \["regularization", "closing"\] \}/);
    assert.match(guardBlock, /OR: \[\{ fiscalYearId: year\.id \}, \{ fiscalYearCode: year\.code, entryDate: \{ gte: year\.startDate, lte: year\.endDate \} \}\]/, "también los asientos importados antes de que existiera el ejercicio (fiscalYearId null)");
    assert.match(guardBlock, /reversedById: null/);
    const markStart = source.indexOf("export async function markFiscalYearClosedFromImport(");
    const markBody = source.slice(markStart, source.indexOf("/** Net result of a year", markStart));
    assert.doesNotMatch(markBody, /postJournalEntry|reverseJournalEntry/, "sin asientos propios");
    assert.match(markBody, /status: "closed", closedAt: new Date\(\), closingEntryId: input\.closingEntryId, openingEntryId: input\.openingEntryId \?\? null, netResult/);
  });
});
