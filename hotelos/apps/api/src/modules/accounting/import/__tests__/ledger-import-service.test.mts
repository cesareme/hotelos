// Unit tests · Tanda 7c · L2 — servicio de lotes (`ledger-import.service.ts`) sin base de
// datos: clave de idempotencia con sufijo #n sobre un cliente falso, bloqueantes / canPost,
// duplicado por hash vivo, agrupación de solapes (análisis del replace), vatSettingsMissing
// con `findUnique` null, decodificación y topes, empresa del fichero frente a la sociedad,
// mapa efectivo y acciones del plan; más el pin de fuente de vat-books (rebuild conserva
// sage200; toVatBookCreateInput exportado). Desde apps/api:
//   node --import tsx --test src/modules/accounting/import/__tests__/ledger-import-service.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LEDGER_IMPORT_MAX_BASE64_CHARS, LEDGER_IMPORT_MAX_ENTRIES_PER_BATCH, LEDGER_IMPORT_SOURCE_TYPES, type LedgerAccountMapDto } from "@hotelos/shared";
import { HttpError } from "../../../../lib/http-error.js";
import { PGC_PYMES_HOTEL_TEMPLATE, isPostableCode, splitUsaliRef } from "../../chart-of-accounts.service.js";
import type { ChartLookup } from "../ledger-import.mapping.js";
import type { PlannedEntry } from "../ledger-import.posting.js";
import type { CanonicalPlanRow } from "../ledger-import.canonical.js";
import {
  TX_OPTIONS,
  assertCompanyMatches,
  computeBlockers,
  decodeImportContent,
  isVatSettingsMissing,
  mergeAccountMaps,
  overlapRowsOf,
  planActionsOf,
  plannedKeysOf,
  resolveEffectiveAccountMap,
  resolveSourceKey,
  resolveSourceKeyFromIndex,
  sageKeyOf,
  validateAccountMapEntries,
  validateAnalyticsMapEntries,
  type SourceKeyClient
} from "../ledger-import.service.js";

const chart: ChartLookup = new Map(
  PGC_PYMES_HOTEL_TEMPLATE.map((account) => {
    const usali = splitUsaliRef(account.usali);
    return [account.code, { isPostable: isPostableCode(account.code), kind: account.kind, usaliDepartment: usali?.usaliDepartment ?? null, usaliLine: usali?.usaliLine ?? null, name: account.name }];
  })
);

type FakeEntry = { id: string; sourceType: string; sourceId: string; status: string; entryNumber: number | null; fiscalYearCode: string | null; reversedById: string | null };

/** Cliente falso de `findJournalEntryBySource`: registra las claves consultadas. */
function fakeClient(rows: FakeEntry[]): SourceKeyClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    journalEntry: {
      findFirst: async (args: { where: { organizationId: string; sourceType: string; sourceId: string } }) => {
        asked.push(args.where.sourceId);
        const row = rows.find((candidate) => candidate.sourceType === args.where.sourceType && candidate.sourceId === args.where.sourceId);
        return row ? { id: row.id, entryNumber: row.entryNumber, fiscalYearCode: row.fiscalYearCode, status: row.status, reversedById: row.reversedById } : null;
      }
    }
  } as unknown as SourceKeyClient & { asked: string[] };
}

function plannedEntry(overrides: Partial<PlannedEntry> & { sourceId: string }): PlannedEntry {
  return {
    sourceType: LEDGER_IMPORT_SOURCE_TYPES.journal,
    entryDate: "2026-09-03",
    entryKind: "normal",
    description: "Electricidad",
    reference: "Sage 200 · asiento 2026/1501 · periodo 9 · diario 0",
    propertyId: "prop_ha",
    propertyCode: "HA",
    fiscalYearCode: "2026",
    lines: [],
    totalDebit: "302.50",
    totalCredit: "302.50",
    source: { companyCode: "1", fiscalYear: "2026", period: "9", entryNumber: "1501", channel: null },
    splitParts: 1,
    warnings: [],
    ...overrides
  };
}

async function expectHttp<T>(promise: Promise<T> | (() => T), statusCode: number, code: string): Promise<Record<string, unknown>> {
  try {
    await (typeof promise === "function" ? Promise.resolve().then(promise) : promise);
  } catch (error) {
    assert.ok(error instanceof HttpError, `expected HttpError, got ${String(error)}`);
    assert.equal(error.statusCode, statusCode);
    const details = (error.details ?? {}) as Record<string, unknown>;
    assert.equal(details.code, code, error.message);
    return details;
  }
  assert.fail(`expected ${statusCode} ${code}`);
}

describe("ledger-import.service · resolveSourceKey (sufijo #n sobre un cliente falso)", () => {
  it("clave libre → la propia clave y ningún asiento vivo", async () => {
    const client = fakeClient([]);
    const resolved = await resolveSourceKey(client, "org", "sage200_journal", "1:2026:9:1501");
    assert.deepEqual(resolved, { key: "1:2026:9:1501", live: null });
    assert.deepEqual(client.asked, ["1:2026:9:1501"]);
  });

  it("clave viva → la misma clave y el asiento vivo (→ skipped_existing)", async () => {
    const client = fakeClient([{ id: "je_1", sourceType: "sage200_journal", sourceId: "1:2026:9:1501", status: "posted", entryNumber: 7, fiscalYearCode: "2026", reversedById: null }]);
    const resolved = await resolveSourceKey(client, "org", "sage200_journal", "1:2026:9:1501");
    assert.equal(resolved.key, "1:2026:9:1501");
    assert.deepEqual(resolved.live, { id: "je_1", entryNumber: 7, fiscalYearCode: "2026" });
  });

  it("toda clave previa reversed → sufijo #n libre (#1, luego #2)", async () => {
    const client = fakeClient([
      { id: "je_1", sourceType: "sage200_journal", sourceId: "1:2026:9:1501", status: "reversed", entryNumber: 7, fiscalYearCode: "2026", reversedById: "je_r" },
      { id: "je_2", sourceType: "sage200_journal", sourceId: "1:2026:9:1501#1", status: "reversed", entryNumber: 9, fiscalYearCode: "2026", reversedById: "je_r2" }
    ]);
    const resolved = await resolveSourceKey(client, "org", "sage200_journal", "1:2026:9:1501");
    assert.deepEqual(resolved, { key: "1:2026:9:1501#2", live: null });
    assert.deepEqual(client.asked, ["1:2026:9:1501", "1:2026:9:1501#1", "1:2026:9:1501#2"]);
  });

  it("clave reversed y #1 vivo → #1 con su asiento (no se contabiliza dos veces)", async () => {
    const client = fakeClient([
      { id: "je_1", sourceType: "sage200_journal", sourceId: "k", status: "reversed", entryNumber: 1, fiscalYearCode: "2026", reversedById: "je_r" },
      { id: "je_2", sourceType: "sage200_journal", sourceId: "k#1", status: "posted", entryNumber: 3, fiscalYearCode: "2026", reversedById: null }
    ]);
    const resolved = await resolveSourceKey(client, "org", "sage200_journal", "k");
    assert.equal(resolved.key, "k#1");
    assert.equal(resolved.live?.id, "je_2");
  });

  it("SD-11 · resolveSourceKeyFromIndex replica la resolución sobre el índice cargado con una consulta (clave viva, reversed → #n, #1 vivo)", () => {
    const index = new Map([
      ["sage200_journal|1:2026:9:1501", [{ id: "je_1", sourceId: "1:2026:9:1501", status: "posted", entryNumber: 7, fiscalYearCode: "2026" }]],
      ["sage200_journal|1:2026:9:1502", [{ id: "je_2", sourceId: "1:2026:9:1502", status: "reversed", entryNumber: 8, fiscalYearCode: "2026" }]],
      ["sage200_journal|1:2026:9:1503", [{ id: "je_3", sourceId: "1:2026:9:1503", status: "reversed", entryNumber: 9, fiscalYearCode: "2026" }, { id: "je_4", sourceId: "1:2026:9:1503#1", status: "posted", entryNumber: 10, fiscalYearCode: "2026" }]]
    ]);
    assert.deepEqual(resolveSourceKeyFromIndex(index, "sage200_journal", "1:2026:9:1501"), { key: "1:2026:9:1501", live: { id: "je_1", entryNumber: 7, fiscalYearCode: "2026" } });
    assert.deepEqual(resolveSourceKeyFromIndex(index, "sage200_journal", "1:2026:9:1502"), { key: "1:2026:9:1502#1", live: null });
    assert.deepEqual(resolveSourceKeyFromIndex(index, "sage200_journal", "1:2026:9:1503"), { key: "1:2026:9:1503#1", live: { id: "je_4", entryNumber: 10, fiscalYearCode: "2026" } });
    assert.deepEqual(resolveSourceKeyFromIndex(index, "sage200_journal", "1:2026:9:1599"), { key: "1:2026:9:1599", live: null });
    const source = readFileSync(fileURLToPath(new URL("../ledger-import.service.ts", import.meta.url)), "utf8");
    assert.match(source, /const keyIndex = await loadSourceKeyIndex\(tx, organizationId/, "la contabilización usa el índice, no una consulta por asiento");
    assert.match(source, /const index = await loadSourceKeyIndex\(db, organizationId, \[\.\.\.new Set\(planned\.map\(\(entry\) => entry\.sourceType\)\)\]/, "findExistingEntries también");
  });

  it("SD-03 / C2 / SD-07 / SD-10 · pines de fuente: solapes de vat_books por sourceId, reverso que respeta filas de otro lote, saldos sobre ejercicio con diario, listado con ámbito de sociedad, tope del borrador", () => {
    const source = readFileSync(fileURLToPath(new URL("../ledger-import.service.ts", import.meta.url)), "utf8");
    assert.match(source, /analysis\.kind === "vat_books" \? findVatOverlaps\(db, organizationId, analysis\.vatRows, excludeImportId\)/);
    assert.equal((source.match(/await findOverlapsOf\(/g) ?? []).length, 3, "análisis, create y post recalculan los solapes con el mismo helper por tipo");
    assert.match(source, /importId: \{ not: importRow\.id \}, import: \{ status: "posted", kind: "vat_books" \}/, "el reverso solo borra las filas que ningún otro lote vat_books posted escribió");
    assert.match(source, /findYearKindConflicts\(db, organizationId, kind, analysis\.fiscalYearCode/);
    assert.match(source, /if \(propertyIds\.length === 0\) return entityScope;/, "un lote sin centro exige accounting.entity.read en el listado");
    assert.match(source, /analysis\.rows\.length > LEDGER_IMPORT_MAX_DRAFT_ROWS\) throw ledgerBadRequest\("LEDGER_IMPORT_TOO_MANY_ROWS"/);
    assert.match(source, /const \{ index: nativeIndex \} = await buildNativeIndex\(db, organizationId\);\n\s+const built = buildVatBookRows\(rows, \{ periodicity, organizationId, companyCode: input\.company \?\? undefined, nativeIndex \}\);/, "C1: el lote vat_books excluye los documentos nativos");
    assert.doesNotMatch(source, /createChartAccount\(/, "SD-08: PUT account-map da de alta subcuentas dentro de su transacción (prismaChartStore(tx))");
  });

  it("la transacción del lote usa 15 s / 600 s", () => {
    assert.deepEqual(TX_OPTIONS, { maxWait: 15_000, timeout: 600_000 });
  });
});

describe("ledger-import.service · computeBlockers / canPost", () => {
  const journalOk = { unmapped: [], unmappedAnalytics: [], centreRequired: [], unbalanced: [], errors: [] };
  const duplicate = { id: "imp_1", status: "posted", fileName: "a.csv", createdAt: new Date("2026-09-17T10:00:00Z") };

  it("sin problemas → sin bloqueantes (canPost)", () => {
    assert.deepEqual(computeBlockers({ kind: "journal", replace: false, duplicate: null, overlaps: [], journal: journalOk, balances: null, plannedCount: 3, vatSettingsMissing: false }), []);
  });

  it("cuentas sin mapear → 400 LEDGER_IMPORT_ACCOUNT_UNMAPPED { accounts } en español", () => {
    const blockers = computeBlockers({ kind: "journal", replace: false, duplicate: null, overlaps: [], journal: { ...journalOk, unmapped: [{ sourceAccount: "9990000001", sourceName: null, lineCount: 2, suggestion: null }] }, balances: null, plannedCount: 1, vatSettingsMissing: false });
    assert.equal(blockers[0]?.code, "LEDGER_IMPORT_ACCOUNT_UNMAPPED");
    assert.equal(blockers[0]?.status, 400);
    assert.deepEqual(blockers[0]?.details?.accounts, ["9990000001"]);
    assert.match(blockers[0]!.message, /sin mapear/);
  });

  it("analítica, centro y descuadre → códigos propios; demasiados asientos → TOO_MANY_ENTRIES", () => {
    const blockers = computeBlockers({
      kind: "journal",
      replace: false,
      duplicate: null,
      overlaps: [],
      journal: { ...journalOk, unmappedAnalytics: [{ dimension: "delegacion", sourceCode: "ZZ", sourceName: null, lineCount: 1 }], centreRequired: [{ sourceEntryNumber: "1504", sourcePeriod: "9", accounts: ["6280001"] }], unbalanced: [{ sourceEntryNumber: "1509", sourcePeriod: "9", debit: "10.00", credit: "9.00" }] },
      balances: null,
      plannedCount: LEDGER_IMPORT_MAX_ENTRIES_PER_BATCH + 1,
      vatSettingsMissing: false
    });
    assert.deepEqual(blockers.map((blocker) => blocker.code), ["LEDGER_IMPORT_ANALYTICS_UNMAPPED", "LEDGER_IMPORT_CENTRE_REQUIRED", "LEDGER_IMPORT_UNBALANCED", "LEDGER_IMPORT_TOO_MANY_ENTRIES"]);
    assert.deepEqual(blockers[3]?.details, { entries: LEDGER_IMPORT_MAX_ENTRIES_PER_BATCH + 1, max: LEDGER_IMPORT_MAX_ENTRIES_PER_BATCH });
  });

  it("duplicado por hash vivo → 409 LEDGER_IMPORT_DUPLICATE en journal / balances / vat_books; con replace no bloquea; en maestros nunca", () => {
    for (const kind of ["journal", "balances", "vat_books"] as const) {
      const blockers = computeBlockers({ kind, replace: false, duplicate, overlaps: [], journal: null, balances: null, plannedCount: 0, vatSettingsMissing: false });
      assert.equal(blockers[0]?.code, "LEDGER_IMPORT_DUPLICATE", kind);
      assert.equal(blockers[0]?.status, 409);
      assert.equal(blockers[0]?.details?.importId, "imp_1");
    }
    assert.deepEqual(computeBlockers({ kind: "journal", replace: true, duplicate, overlaps: [], journal: null, balances: null, plannedCount: 0, vatSettingsMissing: false }), []);
    for (const kind of ["plan", "fiscal_years", "third_parties"] as const) {
      assert.deepEqual(computeBlockers({ kind, replace: false, duplicate, overlaps: [], journal: null, balances: null, plannedCount: 0, vatSettingsMissing: false }), [], kind);
    }
  });

  it("solapes → 409 LEDGER_IMPORT_OVERLAP { overlaps } salvo replace (análisis del replace)", () => {
    const overlaps = [{ importId: "imp_9", status: "posted" as const, periodFrom: "2026-09", periodTo: "2026-09", entries: 4 }];
    const blockers = computeBlockers({ kind: "journal", replace: false, duplicate: null, overlaps, journal: journalOk, balances: null, plannedCount: 5, vatSettingsMissing: false });
    assert.equal(blockers[0]?.code, "LEDGER_IMPORT_OVERLAP");
    assert.deepEqual(blockers[0]?.details?.overlaps, overlaps);
    assert.deepEqual(computeBlockers({ kind: "journal", replace: true, duplicate: null, overlaps, journal: journalOk, balances: null, plannedCount: 5, vatSettingsMissing: false }), []);
  });

  it("vat_books sin fila vat_settings → 409 LEDGER_IMPORT_VAT_SETTINGS_MISSING; los demás tipos no", () => {
    assert.equal(computeBlockers({ kind: "vat_books", replace: false, duplicate: null, overlaps: [], journal: null, balances: null, plannedCount: 0, vatSettingsMissing: true })[0]?.code, "LEDGER_IMPORT_VAT_SETTINGS_MISSING");
    assert.deepEqual(computeBlockers({ kind: "journal", replace: false, duplicate: null, overlaps: [], journal: journalOk, balances: null, plannedCount: 1, vatSettingsMissing: true }), []);
  });

  it("los bloqueantes extra (ejercicio ≠ YYYY, plan) van primero", () => {
    const extra = [{ status: 400 as const, code: "LEDGER_IMPORT_YEAR_CODE_INVALID", message: "x", details: { code: "25" } }];
    const blockers = computeBlockers({ kind: "journal", replace: false, duplicate, overlaps: [], journal: journalOk, balances: null, plannedCount: 1, vatSettingsMissing: false, extra });
    assert.deepEqual(blockers.map((blocker) => blocker.code), ["LEDGER_IMPORT_YEAR_CODE_INVALID", "LEDGER_IMPORT_DUPLICATE"]);
  });
});

describe("ledger-import.service · claves Sage y solapes", () => {
  it("plannedKeysOf: (empresa, ejercicio, periodo, asiento) sin repetir las partes por centro; saldos usan el periodo como nº", () => {
    const keys = plannedKeysOf([
      plannedEntry({ sourceId: "1:2026:9:1503:HA", propertyCode: "HA", source: { companyCode: "1", fiscalYear: "2026", period: "9", entryNumber: "1503", channel: null } }),
      plannedEntry({ sourceId: "1:2026:9:1503:HB", propertyCode: "HB", source: { companyCode: "1", fiscalYear: "2026", period: "9", entryNumber: "1503", channel: null } }),
      plannedEntry({ sourceId: "1:2024:2024-03:SOC", sourceType: LEDGER_IMPORT_SOURCE_TYPES.balance, source: null, propertyId: null, propertyCode: "SOC", fiscalYearCode: "2024" })
    ]);
    assert.deepEqual(keys.map(sageKeyOf), ["1:2026:9:1503", "1:2024:2024-03:2024-03"]);
  });

  it("overlapRowsOf agrupa por lote y cuenta cada clave una vez aunque el lote tenga varias partes", () => {
    const keys = plannedKeysOf([plannedEntry({ sourceId: "1:2026:9:1501" }), plannedEntry({ sourceId: "1:2026:9:1503:HA", source: { companyCode: "1", fiscalYear: "2026", period: "9", entryNumber: "1503", channel: null } })]);
    const posted = [
      { importId: "imp_a", status: "posted", periodFrom: "2026-09", periodTo: "2026-09", sourceCompanyCode: "1", sourceFiscalYear: "2026", sourcePeriod: "9", sourceEntryNumber: "1501" },
      { importId: "imp_a", status: "posted", periodFrom: "2026-09", periodTo: "2026-09", sourceCompanyCode: "1", sourceFiscalYear: "2026", sourcePeriod: "9", sourceEntryNumber: "1503" },
      { importId: "imp_a", status: "posted", periodFrom: "2026-09", periodTo: "2026-09", sourceCompanyCode: "1", sourceFiscalYear: "2026", sourcePeriod: "9", sourceEntryNumber: "1503" },
      { importId: "imp_b", status: "posted", periodFrom: "2026-08", periodTo: "2026-08", sourceCompanyCode: "1", sourceFiscalYear: "2026", sourcePeriod: "8", sourceEntryNumber: "1501" },
      { importId: "imp_c", status: "posted", periodFrom: "2026-09", periodTo: "2026-09", sourceCompanyCode: "1", sourceFiscalYear: "2026", sourcePeriod: "9", sourceEntryNumber: "1501" }
    ];
    assert.deepEqual(overlapRowsOf(keys, posted), [
      { importId: "imp_a", status: "posted", periodFrom: "2026-09", periodTo: "2026-09", entries: 2 },
      { importId: "imp_c", status: "posted", periodFrom: "2026-09", periodTo: "2026-09", entries: 1 }
    ]);
  });
});

describe("ledger-import.service · vat_settings, decodificación y empresa", () => {
  it("isVatSettingsMissing: findUnique null → true; fila → false; nunca crea", async () => {
    const calls: string[] = [];
    const missing = { vatSettings: { findUnique: async () => { calls.push("findUnique"); return null; }, create: async () => { calls.push("create"); return {}; } } } as unknown as Parameters<typeof isVatSettingsMissing>[0];
    assert.equal(await isVatSettingsMissing(missing, "org"), true);
    const present = { vatSettings: { findUnique: async () => ({ id: "vs_1" }) } } as unknown as Parameters<typeof isVatSettingsMissing>[0];
    assert.equal(await isVatSettingsMissing(present, "org"), false);
    assert.deepEqual(calls, ["findUnique"]);
  });

  it("decodeImportContent: content · contentBase64 · topes 400 LEDGER_IMPORT_TOO_LARGE { bytes, max } · vacío 400 LEDGER_IMPORT_EMPTY", async () => {
    assert.deepEqual(decodeImportContent({ content: "cuenta;titulo\n" }), { content: "cuenta;titulo\n", byteLength: 14 });
    const decoded = decodeImportContent({ contentBase64: Buffer.from("hola").toString("base64") });
    assert.equal(Buffer.from(decoded.bytes!).toString("utf8"), "hola");
    assert.equal(decoded.byteLength, 4);
    const details = await expectHttp(() => decodeImportContent({ contentBase64: "A".repeat(LEDGER_IMPORT_MAX_BASE64_CHARS + 4) }), 400, "LEDGER_IMPORT_TOO_LARGE");
    assert.equal(details.max, 20 * 1024 * 1024);
    await expectHttp(() => decodeImportContent({}), 400, "LEDGER_IMPORT_EMPTY");
    await expectHttp(() => decodeImportContent({ contentBase64: "" , content: "" }), 400, "LEDGER_IMPORT_EMPTY");
  });

  it("assertCompanyMatches: CodigoEmpresa numérico pasa; NIF distinto de la sociedad → 400 LEDGER_IMPORT_COMPANY_MISMATCH; igual pasa", async () => {
    assertCompanyMatches("1", "A12345674");
    assertCompanyMatches(null, "A12345674");
    assertCompanyMatches("a-12345674", "A12345674");
    const details = await expectHttp(() => assertCompanyMatches("A23456783", "A12345674"), 400, "LEDGER_IMPORT_COMPANY_MISMATCH");
    assert.deepEqual(details, { fileCompany: "A23456783", entity: "A12345674", code: "LEDGER_IMPORT_COMPANY_MISMATCH" });
  });
});

describe("ledger-import.service · mapa efectivo y acciones del plan", () => {
  it("mergeAccountMaps: la entrada del cuerpo gana sobre la persistida", () => {
    const persisted = new Map<string, LedgerAccountMapDto>([["4770000", { sourceAccount: "4770000", action: "map_by_rate", accountCode: "477", carryCounterparty: false }]]);
    const merged = mergeAccountMaps(persisted, [{ sourceAccount: " 4770000 ", action: "block", accountCode: null, carryCounterparty: false }, { sourceAccount: "6280001", action: "map", accountCode: "628.1", carryCounterparty: false }]);
    assert.equal(merged.get("4770000")?.action, "block");
    assert.equal(merged.get("6280001")?.accountCode, "628.1");
    assert.equal(merged.size, 2);
  });

  it("resolveEffectiveAccountMap: explícita (regla 1) o propuesta (2-7) por cuenta usada; PorIva de cualquier apunte activa map_by_rate", () => {
    const explicit = new Map<string, LedgerAccountMapDto>([["6290002", { sourceAccount: "6290002", action: "map", accountCode: "629.9", carryCounterparty: false }]]);
    const map = resolveEffectiveAccountMap(
      [{ account: "6280001", name: "Electricidad" }, { account: "6290002" }, { account: "4770000", porIva: null }, { account: "4770000", porIva: "10" }, { account: "4300000123" }, { account: "9990000001" }],
      explicit,
      chart
    );
    assert.deepEqual([map.get("6280001")?.action, map.get("6280001")?.accountCode, map.get("6280001")?.suggested], ["map", "628.1", true]);
    assert.deepEqual([map.get("6290002")?.action, map.get("6290002")?.accountCode, map.get("6290002")?.suggested], ["map", "629.9", false]);
    assert.deepEqual([map.get("4770000")?.action, map.get("4770000")?.accountCode], ["map_by_rate", "477"]);
    assert.deepEqual([map.get("4300000123")?.action, map.get("4300000123")?.accountCode, map.get("4300000123")?.carryCounterparty], ["collapse", "4300", true]);
    assert.equal(map.get("9990000001")?.action, "block");
  });

  it("planActionsOf: create con padre, naturaleza heredada y USALI de la plantilla; existente igual → exists; nombre distinto → conflict + 409 ACCOUNT_CODE_EXISTS; sin padre → ACCOUNT_KIND_REQUIRED", () => {
    const row = (cuenta: string, titulo: string | null): CanonicalPlanRow => ({ line: 1, cuenta, titulo, nif: null, pais: null, longitud: null });
    const explicit = new Map<string, LedgerAccountMapDto>();
    const { actions, blockers } = planActionsOf([row("6230002", "Asesoría fiscal"), row("6280001", "Electricidad"), row("9990000001", "Rara")], explicit, chart);
    assert.deepEqual(actions.map((action) => action.outcome), ["create", "mapped", "blocked"]);
    const created = actions[0]!.newAccount!;
    assert.deepEqual([created.code, created.name, created.kind, created.parentCode, created.group, created.level, created.isPostable, created.usaliDepartment, created.usaliLine], ["623.2", "Asesoría fiscal", "expense", "623", 6, 4, true, "admin_general", "other_expense"]);
    assert.deepEqual(blockers, []);

    const withAccount: ChartLookup = new Map(chart);
    (withAccount as Map<string, { isPostable: boolean; kind: string; usaliDepartment: string | null; usaliLine: string | null; name?: string | null }>).set("623.2", { isPostable: true, kind: "expense", usaliDepartment: "admin_general", usaliLine: "other_expense", name: "Asesoría fiscal" });
    const explicitCreate = new Map<string, LedgerAccountMapDto>([["6230002", { sourceAccount: "6230002", action: "create", accountCode: "623.2", carryCounterparty: false }]]);
    const same = planActionsOf([row("6230002", "Asesoría fiscal")], explicitCreate, withAccount);
    assert.equal(same.actions[0]?.outcome, "exists");
    assert.deepEqual(same.blockers, []);
    const renamed = planActionsOf([row("6230002", "Otro nombre")], explicitCreate, withAccount);
    assert.equal(renamed.actions[0]?.outcome, "conflict");
    assert.deepEqual([renamed.blockers[0]?.status, renamed.blockers[0]?.code], [409, "ACCOUNT_CODE_EXISTS"]);

    const orphan = new Map<string, LedgerAccountMapDto>([["8880001", { sourceAccount: "8880001", action: "create", accountCode: "888.1", carryCounterparty: false }]]);
    const noParent = planActionsOf([row("8880001", "Sin padre")], orphan, chart);
    assert.equal(noParent.blockers[0]?.code, "ACCOUNT_KIND_REQUIRED");
  });

  it("validateAccountMapEntries / validateAnalyticsMapEntries: errores en español por fila", () => {
    const errors = validateAccountMapEntries(
      [
        { sourceAccount: "4770000", action: "map_by_rate", accountCode: "477", carryCounterparty: false },
        { sourceAccount: "6280001", action: "map", accountCode: "628.1", carryCounterparty: false },
        { sourceAccount: "6280002", action: "map", accountCode: "628.99", carryCounterparty: false },
        { sourceAccount: "9990000001", action: "block", accountCode: "999", carryCounterparty: false },
        { sourceAccount: "6400000", action: "map", accountCode: "64", carryCounterparty: false }
      ],
      chart
    );
    assert.deepEqual(errors.map((error) => error.sourceAccount), ["6280002", "9990000001", "6400000"]);
    assert.match(errors[0]!.message, /no existe en el plan/);
    assert.match(errors[2]!.message, /cabecera/);
    const analytics = validateAnalyticsMapEntries([{ dimension: "delegacion", sourceCode: "HA", propertyId: "prop_ha", costCentreCode: null }, { dimension: "departamento", sourceCode: "HAB", propertyId: null, costCentreCode: "ROOMS" }, { dimension: "delegacion", sourceCode: "ZZ", propertyId: "prop_otra", costCentreCode: "PISOS" }], new Set(["prop_ha"]));
    assert.deepEqual(analytics.map((error) => error.message), ["el centro no es de la organización.", "centro de coste USALI desconocido «PISOS»."]);
  });
});

describe("ledger-import.service · pin de fuente (vat-books)", () => {
  const source = readFileSync(fileURLToPath(new URL("../../vat-books.service.ts", import.meta.url)), "utf8");

  it("rebuildVatBooks conserva las filas sage200 y toVatBookCreateInput está exportada", () => {
    const rebuild = source.indexOf("export async function rebuildVatBooks(");
    assert.ok(rebuild > 0);
    const body = source.slice(rebuild, source.indexOf("recordAuditEvent", rebuild));
    assert.match(body, /vatBookEntry\.deleteMany\(\{\s*where: \{ organizationId, sourceType: \{ not: "sage200" \}/);
    assert.match(source, /export function toVatBookCreateInput\(row: VatBookRow\): Prisma\.VatBookEntryCreateManyInput/);
    assert.doesNotMatch(source, /^function toCreateInput\(/m, "la antigua privada ya no existe como función");
  });
});
