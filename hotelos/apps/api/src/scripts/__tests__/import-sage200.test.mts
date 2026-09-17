// Unit tests puros del CLI sage200:import (Tanda 7c · L3). Sin base de datos:
// flags (dry-run por defecto, --apply exige --confirm igual a --organization,
// --type con los seis valores de LEDGER_IMPORT_KINDS, exclusiones --dry-run/--apply,
// --reverse exige --reason y --confirm, --reconcile suelto exige --balance/--from/--to,
// --template exige --out), USAGE, tablas de presentación con cifras SINTÉTICAS,
// formato de un HttpError del servicio, código de salida del dry-run y constantes
// del usuario de sistema. Desde apps/api:
//   node --import tsx --test src/scripts/__tests__/import-sage200.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LedgerImportPreview, LedgerImportRecord } from "@hotelos/shared";
import { LEDGER_IMPORT_CLI_CREATED_BY, LEDGER_IMPORT_KINDS, LEDGER_IMPORT_SYSTEM_USER_ID } from "@hotelos/shared";
import { BadRequestError, ConflictError } from "../../lib/http-error.js";
import {
  CLI_PERMISSIONS,
  CLI_TYPES,
  CORRELATION_ID,
  CREATED_BY,
  SCRIPT_LABEL,
  SYSTEM_USER_ID,
  USAGE,
  assertConfirmMatches,
  dryRunExitCode,
  formatDryRun,
  formatEs,
  formatHttpError,
  formatMonthTable,
  formatPropertyTable,
  formatReverseResult,
  parseFlags,
  systemContext
} from "../import-sage200.js";

/** 400 con `details` como los emite ledgerBadRequest (BadRequestError no acepta details en el constructor). */
function badRequest(message: string, details?: Record<string, unknown>): BadRequestError {
  const error = new BadRequestError(message);
  if (details) error.details = details;
  return error;
}

const ORG = "org_sintetica_demo";
const BASE = ["--type", "journal", "--file", "diario-2026-09.csv", "--organization", ORG];

describe("parseFlags · lote", () => {
  it("dry-run por defecto; --type, --file y --organization obligatorios; los seis tipos son los de LEDGER_IMPORT_KINDS", () => {
    const flags = parseFlags(BASE);
    assert.equal(flags.mode, "import");
    assert.equal(flags.type, "journal");
    assert.equal(flags.file, "diario-2026-09.csv");
    assert.equal(flags.organization, ORG);
    assert.equal(flags.apply, false);
    assert.equal(flags.confirm, null);
    assert.equal(flags.replace, false);
    assert.equal(flags.json, false);
    assert.equal(flags.help, false);
    assert.deepEqual([...CLI_TYPES], [...LEDGER_IMPORT_KINDS]);
    for (const kind of LEDGER_IMPORT_KINDS) assert.equal(parseFlags(["--type", kind, "--file", "f.csv", "--organization", ORG]).type, kind);
    assert.throws(() => parseFlags(["--file", "f.csv", "--organization", ORG]), /--type </);
    assert.throws(() => parseFlags(["--type", "journal", "--organization", ORG]), /--file/);
    assert.throws(() => parseFlags(["--type", "journal", "--file", "f.csv"]), /--organization/);
    assert.throws(() => parseFlags(["--type", "diario", "--file", "f.csv", "--organization", ORG]), /--type "diario" no es un tipo de lote válido/);
    assert.throws(() => parseFlags(["--type"]), /necesita un valor/);
    assert.throws(() => parseFlags([...BASE, "--file", "otro.csv"]), /--file solo puede indicarse una vez/);
    assert.throws(() => parseFlags([...BASE, "--force"]), /Flag desconocido "--force"/);
  });

  it("--format, --sheet, --mapping, --entity, --unassigned y --json se aceptan; valores fuera de catálogo se rechazan", () => {
    const flags = parseFlags([...BASE, "--format", "sage_ime_csv", "--sheet", "Diario", "--mapping", "mapeo.json", "--entity", "le_1", "--unassigned", "office", "--numbering", "delegacion", "--json", "--dry-run"]);
    assert.deepEqual([flags.format, flags.sheet, flags.mapping, flags.entity, flags.unassigned, flags.numbering, flags.json], ["sage_ime_csv", "Diario", "mapeo.json", "le_1", "office", "delegacion", true]);
    assert.equal(parseFlags([...BASE]).numbering, null, "sin --numbering la numeración es única por periodo");
    assert.throws(() => parseFlags([...BASE, "--format", "xlsx"]), /--format "xlsx" no es un formato válido/);
    assert.throws(() => parseFlags([...BASE, "--unassigned", "manual"]), /--unassigned "manual" no es válido/);
    assert.throws(() => parseFlags([...BASE, "--numbering", "hotel"]), /--numbering "hotel" no es válido/);
  });

  it("--apply exige --confirm; --confirm sin --apply, --dry-run + --apply, --allow-closed sin --apply o sin --reason se rechazan (salida 2)", () => {
    assert.throws(() => parseFlags([...BASE, "--apply"]), /--apply exige --confirm/);
    assert.throws(() => parseFlags([...BASE, "--confirm", ORG]), /--confirm solo tiene sentido con --apply/);
    assert.throws(() => parseFlags([...BASE, "--dry-run", "--apply", "--confirm", ORG]), /excluyentes/);
    assert.throws(() => parseFlags([...BASE, "--allow-closed"]), /--allow-closed solo tiene sentido con --apply/);
    assert.throws(() => parseFlags([...BASE, "--apply", "--confirm", ORG, "--allow-closed"]), /--allow-closed exige --reason/);
    const apply = parseFlags([...BASE, "--apply", "--confirm", ORG, "--replace", "--allow-closed", "--reason", "ejercicio cerrado en Sage"]);
    assert.deepEqual([apply.apply, apply.confirm, apply.replace, apply.allowClosed, apply.reason], [true, ORG, true, true, "ejercicio cerrado en Sage"]);
  });

  it("--reconcile dentro de un lote solo con --type journal y --balance; --balance sin --reconcile y --from/--to en un lote se rechazan", () => {
    const flags = parseFlags([...BASE, "--reconcile", "--balance", "sumas-y-saldos-2026-09.xlsx"]);
    assert.equal(flags.mode, "import");
    assert.equal(flags.reconcile, true);
    assert.equal(flags.balance, "sumas-y-saldos-2026-09.xlsx");
    assert.throws(() => parseFlags([...BASE, "--reconcile"]), /exige --balance/);
    assert.throws(() => parseFlags(["--type", "plan", "--file", "plan.xlsx", "--organization", ORG, "--reconcile", "--balance", "b.xlsx"]), /solo se admite con --type journal/);
    assert.throws(() => parseFlags([...BASE, "--balance", "b.xlsx"]), /--balance solo tiene sentido con --reconcile/);
    assert.throws(() => parseFlags([...BASE, "--from", "2026-09-01", "--to", "2026-09-30"]), /solo se admiten en la reconciliación suelta/);
  });
});

describe("parseFlags · reconciliación suelta, reverso y plantilla", () => {
  it("--reconcile suelto exige --balance, --from, --to (YYYY-MM-DD, from ≤ to) y --organization; --property opcional", () => {
    const flags = parseFlags(["--reconcile", "--balance", "b.xlsx", "--from", "2026-09-01", "--to", "2026-09-30", "--organization", ORG, "--property", "RA"]);
    assert.equal(flags.mode, "reconcile");
    assert.deepEqual([flags.balance, flags.from, flags.to, flags.organization, flags.property, flags.apply], ["b.xlsx", "2026-09-01", "2026-09-30", ORG, "RA", false]);
    assert.throws(() => parseFlags(["--reconcile", "--from", "2026-09-01", "--to", "2026-09-30", "--organization", ORG]), /exige --balance/);
    assert.throws(() => parseFlags(["--reconcile", "--balance", "b.xlsx", "--organization", ORG]), /exige --from/);
    assert.throws(() => parseFlags(["--reconcile", "--balance", "b.xlsx", "--from", "01/09/2026", "--to", "2026-09-30", "--organization", ORG]), /fechas YYYY-MM-DD/);
    assert.throws(() => parseFlags(["--reconcile", "--balance", "b.xlsx", "--from", "2026-10-01", "--to", "2026-09-30", "--organization", ORG]), /igual o anterior/);
    assert.throws(() => parseFlags(["--reconcile", "--balance", "b.xlsx", "--from", "2026-09-01", "--to", "2026-09-30"]), /exige --organization/);
    assert.throws(() => parseFlags(["--reconcile", "--balance", "b.xlsx", "--from", "2026-09-01", "--to", "2026-09-30", "--organization", ORG, "--apply", "--confirm", ORG]), /no se combina/);
  });

  it("--reverse <importId> exige --reason y --confirm, siempre escribe (sin --dry-run) y no se combina con --type ni --file", () => {
    const flags = parseFlags(["--reverse", "imp_1", "--reason", "diario de septiembre erróneo", "--confirm", ORG]);
    assert.equal(flags.mode, "reverse");
    assert.deepEqual([flags.reverse, flags.reason, flags.confirm, flags.apply, flags.organization], ["imp_1", "diario de septiembre erróneo", ORG, true, null]);
    assert.equal(parseFlags(["--reverse", "imp_1", "--reason", "x", "--confirm", ORG, "--organization", ORG]).organization, ORG);
    assert.throws(() => parseFlags(["--reverse", "imp_1", "--confirm", ORG]), /--reverse exige --reason/);
    assert.throws(() => parseFlags(["--reverse", "imp_1", "--reason", "x"]), /--reverse exige --confirm/);
    assert.throws(() => parseFlags(["--reverse", "imp_1", "--reason", "x", "--confirm", ORG, "--dry-run"]), /no admite --dry-run/);
    assert.throws(() => parseFlags(["--reverse", "imp_1", "--reason", "x", "--confirm", ORG, "--type", "journal"]), /no se combina/);
  });

  it("--template <type> exige --out y no toca la BD; tipo inválido se rechaza; --help / -h cortocircuitan", () => {
    const flags = parseFlags(["--template", "balances", "--out", "plantilla.csv"]);
    assert.equal(flags.mode, "template");
    assert.deepEqual([flags.template, flags.out], ["balances", "plantilla.csv"]);
    assert.throws(() => parseFlags(["--template", "balances"]), /--template exige --out/);
    assert.throws(() => parseFlags(["--template", "saldos", "--out", "x.csv"]), /--template "saldos" no es un tipo de lote válido/);
    assert.equal(parseFlags(["--help"]).help, true);
    assert.equal(parseFlags(["--apply", "-h"]).help, true);
  });

  it("USAGE nombra todos los flags, los seis tipos, el script pnpm, las constantes del usuario de sistema y el aviso de la cadena de auditoría", () => {
    for (const flag of ["--type", "--file", "--organization", "--entity", "--format", "--sheet", "--mapping", "--unassigned", "--numbering", "--dry-run", "--apply", "--confirm", "--replace", "--allow-closed", "--reason", "--reconcile", "--balance", "--from", "--to", "--property", "--reverse", "--template", "--out", "--json", "--help"]) {
      assert.ok(USAGE.includes(flag), `USAGE menciona ${flag}`);
    }
    for (const kind of LEDGER_IMPORT_KINDS) assert.ok(USAGE.includes(kind), `USAGE menciona ${kind}`);
    assert.ok(USAGE.includes(SYSTEM_USER_ID));
    assert.ok(USAGE.includes(CREATED_BY));
    assert.ok(USAGE.includes(CORRELATION_ID));
    assert.match(USAGE, /sage200:import/);
    assert.match(USAGE, /cadena de auditoría/);
    assert.match(USAGE, /NUNCA --replace sobre Faranda/);
    assert.match(USAGE, /Códigos de salida: 0 ok · 1 fallo/);
  });
});

describe("assertConfirmMatches", () => {
  it("sin --apply no comprueba nada; con --apply el confirm debe ser exactamente la organización", () => {
    assert.doesNotThrow(() => assertConfirmMatches({ apply: false, confirm: null, organization: ORG }));
    assert.doesNotThrow(() => assertConfirmMatches({ apply: true, confirm: ORG, organization: ORG }));
    assert.throws(() => assertConfirmMatches({ apply: true, confirm: "org_otra", organization: ORG }), /no coincide con --organization/);
    assert.throws(() => assertConfirmMatches({ apply: true, confirm: null, organization: ORG }), /Nada escrito/);
  });
});

/** Celdas de una fila `| a | b |` sin los espacios de alineación. */
function cells(row: string): string[] {
  return row.split("|").slice(1, -1).map((value) => value.trim());
}

function preview(overrides: Partial<LedgerImportPreview> = {}): LedgerImportPreview {
  return {
    kind: "journal",
    format: "sage_ime_csv",
    system: "sage200",
    fileName: "diario-2026-09.csv",
    contentHash: "a".repeat(64),
    sourceCompanyCode: "1",
    fiscalYearCode: "2026",
    periodFrom: "2026-09",
    periodTo: "2026-09",
    rowCount: 16,
    entryCount: 5,
    lineCount: 13,
    totalDebit: "4286.50",
    totalCredit: "4286.50",
    byMonth: [{ periodCode: "2026-09", entries: 5, lines: 13, debit: "4286.50", credit: "4286.50" }],
    byProperty: [
      { propertyId: "prop_ra", propertyCode: "RA", entries: 2, debit: "1402.50", credit: "1402.50" },
      { propertyId: "prop_lt", propertyCode: "LT", entries: 2, debit: "2384.00", credit: "2384.00" },
      { propertyId: null, propertyCode: "SOC", entries: 1, debit: "500.00", credit: "500.00" }
    ],
    unmappedAccounts: [],
    unmappedAnalytics: [],
    centreRequired: [],
    unbalanced: [],
    nativeSkipped: [],
    existing: [],
    closingDetected: [],
    duplicateOf: null,
    overlaps: [],
    payrollCostImportsPosted: [],
    existingNativeEntries: 0,
    vatSettingsMissing: false,
    warnings: [],
    canPost: true,
    blockers: [],
    ...overrides
  };
}

describe("formatEs · formatMonthTable · formatPropertyTable", () => {
  it("formatEs agrupa miles con punto y decimales con coma sin depender de ICU", () => {
    assert.equal(formatEs("1234567.5"), "1.234.567,50");
    assert.equal(formatEs(1234), "1.234,00");
    assert.equal(formatEs("-531.92"), "-531,92");
    assert.equal(formatEs(103456, 0), "103.456");
    assert.equal(formatEs(null), "—");
    assert.equal(formatEs("abc"), "abc");
  });

  it("la tabla por mes ordena por mes y alinea las cifras a la derecha; la tabla por centro ordena por código", () => {
    const months = formatMonthTable([
      { periodCode: "2026-10", entries: 3, lines: 8, debit: "1500.00", credit: "1500.00" },
      { periodCode: "2026-09", entries: 5, lines: 13, debit: "4286.50", credit: "4286.50" }
    ]);
    assert.equal(months.length, 4, "cabecera + separador + 2 filas");
    assert.deepEqual(cells(months[0]!), ["Mes", "Asientos", "Apuntes", "Debe", "Haber"]);
    assert.match(months[1]!, /^\|(-+\|)+$/);
    assert.deepEqual(cells(months[2]!), ["2026-09", "5", "13", "4.286,50", "4.286,50"]);
    assert.deepEqual(cells(months[3]!), ["2026-10", "3", "8", "1.500,00", "1.500,00"]);
    assert.ok(months[3]!.includes("| 1.500,00 |"), `importes alineados a la derecha: ${months[3]}`);
    assert.equal(formatMonthTable([]).length, 2, "sin filas: cabecera y separador");
    const centres = formatPropertyTable(preview().byProperty);
    assert.deepEqual(cells(centres[0]!), ["Centro", "Asientos", "Debe", "Haber"]);
    assert.deepEqual(centres.slice(2).map((row) => cells(row)[0]), ["LT", "RA", "SOC"]);
    assert.deepEqual(cells(centres[3]!), ["RA", "2", "1.402,50", "1.402,50"]);
  });
});

describe("formatDryRun · dryRunExitCode", () => {
  const header = { organizationId: ORG, organizationName: "Sociedad Sintética", legalEntityId: "le_sint", legalName: "Hoteles Sintéticos SA", file: "diario-2026-09.csv", bytes: 4096, type: "journal" as const, requestedFormat: null, mappingFile: null, balanceFile: null };

  it("con canPost imprime cabecera, tablas, totales, «ninguna» en las listas vacías y «Nada escrito»; salida 0", () => {
    const lines = formatDryRun(header, preview(), { replace: false, unassigned: null });
    const text = lines.join("\n");
    assert.match(lines[0]!, /^\[sage200:import\] previsualización \(dry-run\) · organización Sociedad Sintética \(org_sintetica_demo\)$/);
    assert.match(text, /Sociedad: Hoteles Sintéticos SA \(le_sint\)/);
    assert.match(text, /Fichero: diario-2026-09\.csv · 4\.096 bytes · tipo journal \(Diario\) · formato sage_ime_csv \(detectado\)/);
    assert.match(text, /Hash de contenido: a{64}/);
    assert.match(text, /Empresa Sage: 1 · Ejercicio: 2026 · Rango: 2026-09 → 2026-09 · 16 filas · 5 asientos · 13 apuntes/);
    assert.match(text, /Totales: Debe 4\.286,50 · Haber 4\.286,50/);
    assert.match(text, /Cuentas sin mapear: ninguna/);
    assert.match(text, /Analítica sin mapear: ninguna/);
    assert.match(text, /Asientos sin centro \(6\/7\): ninguno/);
    assert.match(text, /Nativos excluidos .*: ninguno/);
    assert.match(text, /Ya existentes .*: ninguno/);
    assert.match(text, /canPost: sí/);
    assert.match(text, /Nada escrito \(dry-run\)/);
    assert.equal(dryRunExitCode(preview()), 0);
  });

  it("sin canPost lista cuentas y analítica sin mapear con sugerencia, nativos excluidos, ya existentes, duplicado, solapes y bloqueos; salida 1", () => {
    const blocked = preview({
      unmappedAccounts: [
        { sourceAccount: "9990000001", sourceName: "Cuenta rara", lineCount: 2, suggestion: null },
        { sourceAccount: "6230002", sourceName: "Asesoría fiscal", lineCount: 1, suggestion: { sourceAccount: "6230002", sourceName: "Asesoría fiscal", action: "create", accountCode: "623.2", carryCounterparty: false, suggested: true } }
      ],
      unmappedAnalytics: [{ dimension: "delegacion", sourceCode: "ZZ", sourceName: null, lineCount: 3 }],
      centreRequired: [{ sourceEntryNumber: "1504", sourcePeriod: "9", accounts: ["6210000"] }],
      nativeSkipped: [{ sourceEntryNumber: "1502", sourcePeriod: "9", series: "FAC-2026", number: "000015", invoiceNumber: "FAC-2026-000015", sourceType: "invoice", sourceId: "inv_sint" }],
      existing: [{ sourceEntryNumber: "1501", sourcePeriod: "9", journalEntryId: "je_sint", entryNumber: 110, fiscalYearCode: "2026" }],
      duplicateOf: { importId: "imp_dup", fileName: "diario-2026-09.csv", createdAt: "2026-09-17T10:00:00.000Z", status: "posted" },
      overlaps: [{ importId: "imp_over", status: "posted", periodFrom: "2026-09", periodTo: "2026-09", entries: 4 }],
      existingNativeEntries: 3,
      warnings: ["Modo sombra: 1 asiento excluido."],
      canPost: false,
      blockers: ["Hay cuentas de Sage sin mapear."]
    });
    const text = formatDryRun(header, blocked, { replace: true, unassigned: "office" }).join("\n");
    assert.match(text, /Cuentas sin mapear: 2/);
    assert.match(text, /· 9990000001 «Cuenta rara» \(2 apuntes\) → sugerencia: sin propuesta \(block\)/);
    assert.match(text, /· 6230002 «Asesoría fiscal» \(1 apuntes\) → sugerencia: create → 623\.2/);
    assert.match(text, /· delegacion ZZ \(3 apuntes\)/);
    assert.match(text, /· asiento 1504 \(periodo 9\): 6210000/);
    assert.match(text, /· asiento 1502 \(periodo 9\) · FAC-2026-000015 · invoice\/inv_sint/);
    assert.match(text, /· asiento 1501 \(periodo 9\) → 2026\/110/);
    assert.match(text, /Duplicado: .*imp_dup.*se revertirá ENTERO por --replace/);
    assert.match(text, /Solapes: 1 lote\(s\).*se revertirán ENTEROS por --replace/);
    assert.match(text, /lote imp_over \(posted, 2026-09 → 2026-09\): 4 asiento\(s\)/);
    assert.match(text, /ya tiene 3 asiento\(s\) nativo\(s\)/);
    assert.match(text, /Política de apuntes 6\/7 sin centro: office/);
    assert.match(text, /Avisos: 1\n\s+· Modo sombra: 1 asiento excluido\./);
    assert.match(text, /Bloqueos: 1\n\s+· Hay cuentas de Sage sin mapear\./);
    assert.match(text, /canPost: no/);
    assert.equal(dryRunExitCode(blocked), 1);
  });
});

describe("formatReverseResult · formatHttpError", () => {
  const record: LedgerImportRecord = {
    id: "imp_sint",
    kind: "journal",
    format: "canonical_csv",
    system: "sage200",
    fileName: "diario-2026-09.csv",
    contentHash: "b".repeat(64),
    sourceCompanyCode: "1",
    fiscalYearCode: "2026",
    periodFrom: "2026-09",
    periodTo: "2026-09",
    status: "reversed",
    rowCount: 14,
    entryCount: 5,
    skippedCount: 1,
    warningCount: 0,
    totalDebit: "1289.00",
    totalCredit: "1289.00",
    journalEntryIds: ["je_1", "je_2"],
    reversalJournalEntryIds: ["je_3", "je_4"],
    replacedById: null,
    notes: null,
    createdBy: "cli:import-sage200",
    createdAt: "2026-09-17T10:00:00.000Z",
    postedAt: "2026-09-17T10:00:01.000Z",
    reversedAt: "2026-09-17T11:00:00.000Z",
    reversedBy: "usr_system_sage200_import",
    reversalReason: "diario erróneo"
  };

  it("el reverso distingue el primer reverso del idempotente y cita asientos, reversos y motivo", () => {
    const first = formatReverseResult({ ...record, alreadyReversed: false }).join("\n");
    assert.match(first, /lote imp_sint revertido · journal · diario-2026-09\.csv · 2026-09 → 2026-09/);
    assert.match(first, /Asientos del lote: 2 · reversos: 2 · motivo: diario erróneo · reversedBy usr_system_sage200_import/);
    assert.match(formatReverseResult({ ...record, alreadyReversed: true }).join("\n"), /ya estaba revertido \(idempotente, nada escrito\)/);
  });

  it("un HttpError del servicio imprime code, detalles (importId, overlaps, accounts, codes, entries, errors) y «Nada escrito»", () => {
    const duplicate = new ConflictError("Este fichero ya se importó.", { code: "LEDGER_IMPORT_DUPLICATE", importId: "imp_dup", status: "posted" });
    const lines = formatHttpError(duplicate);
    assert.equal(lines[0], `${SCRIPT_LABEL} LEDGER_IMPORT_DUPLICATE (409): Este fichero ya se importó.`);
    assert.match(lines[1]!, /Lote afectado: imp_dup \(posted\) → --replace/);
    assert.equal(lines.at(-1), "  Nada escrito.");
    const overlap = formatHttpError(new ConflictError("Solapes.", { code: "LEDGER_IMPORT_OVERLAP", overlaps: [{ importId: "a" }, { importId: "b" }] })).join("\n");
    assert.match(overlap, /Solapes: 2 lote\(s\)/);
    const unmapped = formatHttpError(badRequest("Cuentas sin mapear.", { code: "LEDGER_IMPORT_ACCOUNT_UNMAPPED", accounts: [{ sourceAccount: "9990000001", lineCount: 2 }, "6230002"] })).join("\n");
    assert.match(unmapped, /Cuentas: 9990000001, 6230002/);
    const analytics = formatHttpError(badRequest("Analítica.", { code: "LEDGER_IMPORT_ANALYTICS_UNMAPPED", codes: [{ dimension: "delegacion", sourceCode: "ZZ" }] })).join("\n");
    assert.match(analytics, /Códigos analíticos: ZZ/);
    const centre = formatHttpError(badRequest("Centro.", { code: "LEDGER_IMPORT_CENTRE_REQUIRED", entries: [{ sourceEntryNumber: "1504" }] })).join("\n");
    assert.match(centre, /Asientos: 1504/);
    const invalid = formatHttpError(badRequest("Fichero inválido.", { code: "LEDGER_IMPORT_INVALID", errors: [{ line: 3, message: "importe no numérico" }, { index: 0, sourceAccount: "4300000123", message: "cuenta repetida" }] })).join("\n");
    assert.match(invalid, /· línea 3: importe no numérico/);
    assert.match(invalid, /· 4300000123: cuenta repetida/);
    const generic = formatHttpError(badRequest("Sin código."));
    assert.equal(generic[0], `${SCRIPT_LABEL} HTTP_400 (400): Sin código.`);
  });
});

describe("usuario de sistema", () => {
  it("constantes del diseño §7.3 / §10.4.1 (de @hotelos/shared) y contexto con las claves del servicio, del manifiesto y ámbito de toda la sociedad (sin assignedPropertyIds)", () => {
    assert.equal(SYSTEM_USER_ID, "usr_system_sage200_import");
    assert.equal(SYSTEM_USER_ID, LEDGER_IMPORT_SYSTEM_USER_ID);
    assert.equal(CREATED_BY, "cli:import-sage200");
    assert.equal(CREATED_BY, LEDGER_IMPORT_CLI_CREATED_BY);
    assert.equal(CORRELATION_ID, "corr_sage200_import");
    assert.equal(SCRIPT_LABEL, "[sage200:import]");
    const context = systemContext(ORG, "prop_ra");
    assert.equal(context.userId, SYSTEM_USER_ID);
    assert.equal(context.deviceId, CREATED_BY);
    assert.equal(context.organizationId, ORG);
    assert.equal(context.propertyId, "prop_ra");
    assert.equal(context.isPlatformAdmin, false);
    assert.equal(context.assignedPropertyIds, undefined);
    for (const key of ["accounting.journal.post", "accounting.configure", "accounting.read", "accounting.reports.read", "accounting.entity.read"]) assert.ok(context.permissions.includes(key as never), key);
    assert.deepEqual([...CLI_PERMISSIONS].sort(), [...context.permissions].sort());
  });
});
