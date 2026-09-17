import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { ReservationImportPreview, ReservationImportPreviewRow, ReservationImportRowRecord, ReservationImportSummary } from "@hotelos/shared";
import {
  IGNORE_COLUMN_VALUE,
  IMPORT_FIELDS,
  IMPORT_FIELD_LABELS,
  IMPORT_REPORT_HEADER,
  IMPORT_REQUIRED_FIELDS,
  IMPORT_STATUS_LABELS,
  IMPORT_STEPS,
  ROW_FILTERS,
  applyMappingChoice,
  availabilityExceeded,
  availabilityLine,
  base64OfArrayBuffer,
  buildImportReportCsv,
  buildMapping,
  canUndoImport,
  csvCell,
  detectFormatFromName,
  effectiveMapping,
  exampleForColumn,
  exampleForField,
  importAuthorLabel,
  fieldOptions,
  fieldSelectValue,
  fileSizeLabel,
  filterRows,
  formatLabel,
  guestName,
  importFileLabel,
  importStatusLabel,
  importStatusTone,
  isImportField,
  isRowFilter,
  issueText,
  issuesSummary,
  issuesTitle,
  mappingSourceLabel,
  mappingSourceTone,
  missingRequiredLabels,
  normalizedValueOf,
  previewBlockers,
  reportFileName,
  resultKpis,
  resultTitle,
  resultTone,
  rowOutcomeLabel,
  rowStatusLabel,
  rowStatusTone,
  rowsLabel,
  stepIndexOf,
  stepStateLabel,
  stepSummary,
  stepTone,
  summaryKpis,
  truncateText,
  undoOutcomeLabel,
  undoSummary
} from "../reservation-import-helpers.ts";

// Pure helpers only (no React, no api-client). Every guest in these fixtures is
// FICTITIOUS (invented names, @example.com addresses): no test carries data of a
// real person (design §1.10).

/** Intl separates figures from «€» with a no-break space; the assertions compare on a plain one. */
const plain = (text: string) => text.replace(/\u00a0/g, " ");

const shared = readFileSync(new URL("../../../../../../packages/shared/src/reservation-import-types.ts", import.meta.url), "utf8");

function sharedArray(name: string): string[] {
  const match = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`).exec(shared);
  assert.ok(match, `${name} not found in the shared contract`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function sharedRecord(name: string): Record<string, string> {
  const match = new RegExp(`export const ${name}[^=]*= Object\\.freeze\\(\\{([\\s\\S]*?)\\}\\);`).exec(shared);
  assert.ok(match, `${name} not found in the shared contract`);
  return Object.fromEntries([...match[1].matchAll(/^\s*([a-z_]+):\s*"([^"]*)"/gm)].map((m) => [m[1], m[2]]));
}

const normalized = (over: Partial<NonNullable<ReservationImportPreviewRow["normalized"]>> = {}): NonNullable<ReservationImportPreviewRow["normalized"]> => ({
  externalReference: "IMP-TEST-001",
  arrivalDate: "2026-10-12",
  departureDate: "2026-10-15",
  nights: 3,
  roomTypeId: "rt_dbl",
  roomTypeCode: "DBL",
  ratePlanId: "rp_bar",
  ratePlanCode: "BAR",
  roomsCount: 1,
  adults: 2,
  children: 0,
  infants: 0,
  boardType: "BB",
  channel: "direct",
  sourceCode: "directo",
  estado: "confirmada",
  historical: false,
  guest: { firstName: "Lucía", surname1: "Ferreiro", surname2: "Castro", email: "lucia.ferreiro@example.com", phone: "+34600111001", nationality: "ESP", documentType: "DNI", documentNumber: "11111111H" },
  totalAmount: "312.00",
  totalSource: "file",
  currency: "EUR",
  vipFlag: false,
  ...over
});

const previewRow = (over: Partial<ReservationImportPreviewRow> = {}): ReservationImportPreviewRow => ({
  rowNumber: 1,
  line: 2,
  status: "valid",
  issues: [],
  resolved: { externalReference: "IMP-TEST-001", arrivalDate: "2026-10-12", departureDate: "2026-10-15", nights: 3, roomTypeCode: "DBL", ratePlanCode: "BAR", roomNumber: null, roomsCount: 1, estado: "confirmada", historical: false, totalAmount: "312.00", totalSource: "file" },
  ...over
});

const summary = (over: Partial<ReservationImportSummary> = {}): ReservationImportSummary => ({ valid: 3, warning: 1, error: 0, skipped: 0, historical: 0, toCreate: 4, ...over });

const preview = (over: Partial<ReservationImportPreview> = {}): ReservationImportPreview => ({
  propertyId: "prop_test",
  format: "csv",
  fileName: "reservas.csv",
  contentHash: "abc",
  encoding: "utf-8",
  header: ["Check-in", "Check-out", "Room Type", "Guest name"],
  mapping: { "Check-in": "llegada", "Check-out": "salida", "Room Type": "tipo_habitacion", "Guest name": "nombre" },
  mappingSource: { "Check-in": "synonym", "Check-out": "synonym", "Room Type": "synonym", "Guest name": "synonym" },
  unmappedColumns: [],
  missingRequired: [],
  splitName: true,
  catalog: { roomTypes: [], ratePlans: [], defaultRatePlanCode: "BAR", currency: "EUR" },
  businessDate: "2026-09-16",
  rowCount: 4,
  summary: summary(),
  rows: [previewRow({ normalized: normalized() }), previewRow({ rowNumber: 2, line: 3, status: "warning", issues: [{ code: "RESERVATION_IMPORT_ROW_TOTAL_QUOTED", message: "Fila 2: importe cotizado desde la tarifa (columna importe_total)." }] })],
  sampleSize: 200,
  availability: { byRoomType: [], overbookingRows: [] },
  duplicates: { byReferenceRows: [], inFileRows: [], possibleRows: [], ofImport: null },
  totals: { fromFile: "1248.00", quoted: "0.00", currency: "EUR" },
  options: { omitirInvalidas: false, permitirOverbooking: false, historico: false, force: false },
  canImport: true,
  blockers: [],
  warnings: [],
  ...over
});

const rowRecord = (over: Partial<ReservationImportRowRecord> = {}): ReservationImportRowRecord => ({
  id: "row_1",
  importId: "imp_1",
  rowNumber: 1,
  outcome: "created",
  externalReference: "IMP-TEST-001",
  arrivalDate: "2026-10-12",
  departureDate: "2026-10-15",
  roomTypeCode: "DBL",
  ratePlanCode: "BAR",
  roomsCount: 1,
  reservationId: "res_1",
  reservationCode: "RES-00086",
  errorCode: null,
  errorMessage: null,
  warnings: [],
  undoOutcome: null,
  ...over
});

describe("Importar reservas · pasos del asistente", () => {
  it("has the four steps in order and derives tone, state label and summary from the current index", () => {
    assert.deepEqual(
      IMPORT_STEPS.map((step) => step.key),
      ["file", "columns", "review", "result"]
    );
    assert.deepEqual(
      IMPORT_STEPS.map((step) => step.label),
      ["Fichero", "Columnas", "Revisión", "Resultado"]
    );
    assert.equal(stepIndexOf("review"), 2);
    assert.deepEqual([stepTone(0, 2), stepTone(2, 2), stepTone(3, 2)], ["success", "accent", "neutral"]);
    assert.deepEqual([stepStateLabel(0, 2), stepStateLabel(2, 2), stepStateLabel(3, 2)], ["hecho", "actual", "pendiente"]);
    assert.equal(stepSummary(1), "Paso 2 de 4 · Columnas");
  });
});

describe("Importar reservas · fichero", () => {
  it("base64OfArrayBuffer keeps every byte 0x00-0xFF (latin1 survives until the API decodes)", () => {
    const bytes = new Uint8Array(256 + 70_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 256;
    const encoded = base64OfArrayBuffer(bytes.buffer);
    assert.equal(encoded, Buffer.from(bytes).toString("base64"));
    assert.deepEqual(new Uint8Array(Buffer.from(encoded, "base64")), bytes);
    assert.equal(base64OfArrayBuffer(new ArrayBuffer(0)), "");
    // A BOM + «é ñ €» in windows-1252 (E9 F1 80): the bytes travel untouched.
    const latin1 = new Uint8Array([0xef, 0xbb, 0xbf, 0xe9, 0xf1, 0x80]);
    assert.equal(base64OfArrayBuffer(latin1.buffer), Buffer.from(latin1).toString("base64"));
  });

  it("detects the format by extension (xlsx / xlsm; the rest is csv) and labels sizes and formats", () => {
    assert.equal(detectFormatFromName("Reservas.XLSX"), "xlsx");
    assert.equal(detectFormatFromName("libro.xlsm"), "xlsx");
    assert.equal(detectFormatFromName("reservas.csv"), "csv");
    assert.equal(detectFormatFromName("reservas.txt"), "csv");
    assert.equal(detectFormatFromName(null), "csv");
    assert.deepEqual([formatLabel("csv"), formatLabel("xlsx"), formatLabel(null)], ["CSV", "XLSX", "—"]);
    assert.equal(fileSizeLabel(512), "512 B");
    assert.equal(fileSizeLabel(2048), "2 KB");
    assert.equal(fileSizeLabel(5 * 1024 * 1024), "5 MB");
    assert.equal(fileSizeLabel(1.5 * 1024 * 1024), "1,5 MB");
    assert.equal(fileSizeLabel(-1), "—");
  });
});

describe("Importar reservas · campos y mapeo", () => {
  it("mirrors the 33 fields, their Spanish labels and the mandatory ones of the shared contract", () => {
    assert.deepEqual([...IMPORT_FIELDS], sharedArray("RESERVATION_IMPORT_FIELDS"));
    assert.equal(IMPORT_FIELDS.length, 33);
    assert.deepEqual({ ...IMPORT_FIELD_LABELS }, sharedRecord("RESERVATION_IMPORT_LABELS_ES"));
    assert.deepEqual([...IMPORT_REQUIRED_FIELDS], sharedArray("RESERVATION_IMPORT_REQUIRED_FIELDS"));
    assert.deepEqual({ ...IMPORT_STATUS_LABELS }, sharedRecord("RESERVATION_IMPORT_STATUS_LABELS_ES"));
    assert.ok(isImportField("llegada"));
    assert.ok(!isImportField("ignorar"));
    assert.ok(!isImportField(IGNORE_COLUMN_VALUE));
  });

  it("fieldOptions lists «Ignorar columna» first and marks the mandatory fields", () => {
    const options = fieldOptions();
    assert.equal(options.length, 34);
    assert.deepEqual(options[0], { value: IGNORE_COLUMN_VALUE, label: "Ignorar columna" });
    assert.equal(options.find((option) => option.value === "llegada")?.label, "Llegada (obligatorio)");
    assert.equal(options.find((option) => option.value === "salida")?.label, "Salida (salida o noches)");
    assert.equal(options.find((option) => option.value === "canal")?.label, "Canal");
    assert.equal(fieldSelectValue(null), IGNORE_COLUMN_VALUE);
    assert.equal(fieldSelectValue("vip"), "vip");
  });

  it("buildMapping keeps only the decided columns of the header and drops empties, unknown fields and absent columns", () => {
    const header = ["Check-in", "Room Type", "Extra", ""];
    const mapping = buildMapping(header, { "Check-in": "llegada", "Room Type": IGNORE_COLUMN_VALUE, Extra: "", Fantasma: "salida", "": "noches" });
    assert.deepEqual(mapping, { "Check-in": "llegada", "Room Type": null });
    assert.deepEqual(buildMapping(header, { "Check-in": "campo_inventado" }), undefined);
    assert.deepEqual(buildMapping(header, { Extra: null }), { Extra: null });
    assert.equal(buildMapping(header, {}), undefined);
    assert.equal(buildMapping(header, { "Check-in": undefined }), undefined);
  });

  it("applyMappingChoice moves a field taken by another column to «Ignorar» so the API never sees a conflict", () => {
    const proposal = { A: "llegada" as const, B: "salida" as const, C: null };
    const next = applyMappingChoice(proposal, {}, "C", "llegada");
    assert.deepEqual(next, { A: null, C: "llegada" });
    assert.deepEqual(effectiveMapping(proposal, next), { A: null, B: "salida", C: "llegada" });
    // Ignoring a column touches nothing else; picking the same field again is a no-op on the others.
    assert.deepEqual(applyMappingChoice(proposal, next, "B", IGNORE_COLUMN_VALUE), { A: null, C: "llegada", B: null });
    assert.deepEqual(applyMappingChoice(proposal, next, "C", "llegada"), { A: null, C: "llegada" });
    assert.deepEqual(missingRequiredLabels(["llegada", "tipo_habitacion"]), ["Llegada", "Tipo de habitación"]);
    assert.deepEqual([mappingSourceLabel("synonym"), mappingSourceLabel("fuzzy"), mappingSourceLabel("explicit"), mappingSourceLabel(null)], ["Sinónimo", "Aproximado", "Manual", "Sin mapear"]);
    assert.deepEqual([mappingSourceTone("synonym"), mappingSourceTone("none")], ["success", "neutral"]);
  });

  it("exampleForField reads the first non-empty normalised value of the sample, capped at 32 characters", () => {
    const rows = [previewRow({ status: "error" }), previewRow({ rowNumber: 2, normalized: normalized({ specialRequests: "Cama de matrimonio y llegada tardía por vuelo" }) })];
    assert.equal(exampleForField(rows, "llegada"), "2026-10-12");
    assert.equal(exampleForField(rows, "apellidos"), "Ferreiro Castro");
    assert.equal(exampleForField(rows, "peticiones"), "Cama de matrimonio y llegada ta…");
    assert.equal(exampleForField(rows, "habitacion"), "");
    assert.equal(exampleForField(rows, null), "");
  });

  it("FUX-04: exampleForColumn reads the RAW sample cell by column index (unmapped columns and rows with errors included) and falls back to the normalised value without a raw sample", () => {
    const base = { line: 2, issues: [], guestReuse: null } as const;
    const errored: ReservationImportPreviewRow[] = [
      { ...base, rowNumber: 1, status: "error", cells: ["Booking ID", "12/10/2026", "", "Ferreiro, Lucía"] },
      { ...base, rowNumber: 2, status: "error", cells: ["BK-2", "13/10/2026", "Doble vista mar", "Nowak, Marek"] }
    ];
    assert.equal(exampleForColumn(errored, 0, null), "Booking ID", "an unmapped column shows its first raw cell");
    assert.equal(exampleForColumn(errored, 1, "noches"), "12/10/2026", "the file's own spelling, not the normalised ISO");
    assert.equal(exampleForColumn(errored, 2, "tipo_habitacion"), "Doble vista mar", "skips the empty cell of the first row");
    assert.equal(exampleForColumn(errored, 3, "nombre", 10), "Ferreiro,…");
    assert.equal(exampleForColumn(errored, 9, "vip"), "", "a column beyond the row is empty");
    const outsideSample: ReservationImportPreviewRow[] = [{ ...base, rowNumber: 3, status: "valid" }];
    assert.equal(exampleForColumn([...outsideSample, ...errored], 0, null), "Booking ID", "rows without cells (outside the sample) are skipped");
    // Older API without `cells`: the normalised value of the field, as before.
    const legacy = [previewRow({ status: "error" }), previewRow({ rowNumber: 2, normalized: normalized({}) })];
    assert.ok(legacy.every((row) => !row.cells));
    assert.equal(exampleForColumn(legacy, 5, "llegada"), "2026-10-12");
    assert.equal(exampleForColumn(legacy, 5, null), "");
  });

  it("FUX-02: importAuthorLabel never paints a raw id: the CLI (new and legacy createdBy) is «Sistema · importación masiva de reservas», the viewer is named, others are «otro usuario»", () => {
    const session = { userId: "cmrhw9jyb0005fyvb4ykaumyc", fullName: "Carmen Ferreiro" };
    assert.equal(importAuthorLabel("usr_system_reservation_import", session), "Sistema · importación masiva de reservas");
    assert.equal(importAuthorLabel("cli:import-reservations", session), "Sistema · importación masiva de reservas", "lots persisted before ronda 1");
    assert.equal(importAuthorLabel("cmrhw9jyb0005fyvb4ykaumyc", session), "Carmen Ferreiro");
    assert.equal(importAuthorLabel("cmrhw9jyb0005fyvb4ykaumyc", { userId: "cmrhw9jyb0005fyvb4ykaumyc", fullName: "" }), "tú");
    assert.equal(importAuthorLabel("cmu1mifcp0000fyo1wzvq7txo", session), "otro usuario");
    assert.equal(importAuthorLabel("cmu1mifcp0000fyo1wzvq7txo", null), "otro usuario");
    assert.equal(importAuthorLabel(null, session), "—");
    for (const id of ["cmrhw9jyb0005fyvb4ykaumyc", "cli:import-reservations", "usr_system_reservation_import"]) assert.doesNotMatch(importAuthorLabel(id, null), /cmrhw|cli:|usr_/);
    assert.equal(normalizedValueOf(normalized(), "vip"), "no");
    assert.equal(normalizedValueOf(normalized({ totalSource: "quoted" }), "importe_total"), "");
    assert.equal(normalizedValueOf(normalized(), "canal"), "directo");
    assert.equal(guestName(normalized()), "Lucía Ferreiro Castro");
    assert.equal(truncateText("abc", 3), "abc");
    assert.equal(truncateText("abcdef", 4), "abc…");
  });
});

describe("Importar reservas · revisión", () => {
  it("filterRows keeps every row for «all» and the matching verdicts otherwise, in file order", () => {
    const rows = [previewRow({ rowNumber: 1, status: "valid" }), previewRow({ rowNumber: 2, status: "error" }), previewRow({ rowNumber: 3, status: "warning" }), previewRow({ rowNumber: 4, status: "skipped" }), previewRow({ rowNumber: 5, status: "error" })];
    assert.deepEqual(filterRows(rows, "all").map((row) => row.rowNumber), [1, 2, 3, 4, 5]);
    assert.deepEqual(filterRows(rows, "error").map((row) => row.rowNumber), [2, 5]);
    assert.deepEqual(filterRows(rows, "skipped").map((row) => row.rowNumber), [4]);
    assert.deepEqual(filterRows(rows, "valid").map((row) => row.rowNumber), [1]);
    assert.deepEqual(
      ROW_FILTERS.map((filter) => filter.value),
      ["all", "valid", "warning", "error", "skipped"]
    );
    assert.ok(isRowFilter("warning"));
    assert.ok(!isRowFilter("otro"));
  });

  it("labels and tones of the row verdicts, the summary KPIs and the issues never leak a value of the file", () => {
    assert.deepEqual([rowStatusLabel("valid"), rowStatusLabel("warning"), rowStatusLabel("error"), rowStatusLabel("skipped")], ["Válida", "Con avisos", "Con errores", "Omitida"]);
    assert.deepEqual([rowStatusTone("valid"), rowStatusTone("error"), rowStatusTone("otro")], ["success", "danger", "neutral"]);
    const kpis = summaryKpis(summary({ error: 2, historical: 1, toCreate: 3 }));
    assert.deepEqual(
      kpis.map((kpi) => [kpi.label, kpi.value]),
      [
        ["Válidas", "3"],
        ["Con avisos", "1"],
        ["Con errores", "2"],
        ["Omitidas", "0"],
        ["Histórico", "1"],
        ["A crear", "3"]
      ]
    );
    assert.equal(kpis[2].tone, "danger");
    const issues = [
      { code: "RESERVATION_IMPORT_ROW_INVALID_DATE" as const, message: "Fila 3: fecha no válida (columna llegada)." },
      { code: "RESERVATION_IMPORT_ROW_MISSING_FIELD" as const, message: "" },
      { code: "RESERVATION_IMPORT_ROW_LONG_STAY" as const, message: "Fila 3: más de 60 noches." }
    ];
    assert.equal(issueText(issues[1]), "RESERVATION_IMPORT_ROW_MISSING_FIELD");
    assert.equal(issuesSummary(issues), "Fila 3: fecha no válida (columna llegada). · RESERVATION_IMPORT_ROW_MISSING_FIELD (+1)");
    assert.equal(issuesSummary([]), "—");
    assert.equal(issuesTitle(issues)?.split("\n").length, 3);
    assert.equal(issuesTitle([]), undefined);
  });

  it("explains availability per room type (range rule of the PMS) and lists rows in Spanish", () => {
    const type = { roomTypeId: "rt_dbl", code: "DBL", name: "Doble", totalRooms: 2, rowsRequested: 3, peakBookedDb: 1, peakBookedFile: 2, nightsExceeded: ["2026-10-13"], rangeRuleRows: [3] };
    const line = availabilityLine(type);
    assert.match(line, /^DBL · Doble: cupo 2 · pedidas 3 · pico en la base de datos 1 · pico del fichero 2 · 1 noche excedida · 1 fila rechazada por la regla de rango del PMS aunque quepan por noche \(filas 3\)$/);
    assert.equal(availabilityLine({ ...type, nightsExceeded: [], rangeRuleRows: [] }), "DBL · Doble: cupo 2 · pedidas 3 · pico en la base de datos 1 · pico del fichero 2");
    assert.deepEqual(availabilityExceeded([type, { ...type, roomTypeId: "rt_sup", nightsExceeded: [], rangeRuleRows: [] }]).map((entry) => entry.roomTypeId), ["rt_dbl"]);
    assert.equal(rowsLabel([3]), "fila 3");
    assert.equal(rowsLabel([3, 7, 12]), "filas 3, 7 y 12");
    assert.equal(rowsLabel([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3), "filas 1, 2 y 3 (+7)");
    assert.equal(rowsLabel([]), "—");
  });

  it("previewBlockers says in Spanish why «Importar» is disabled, and nothing when the preview can import", () => {
    assert.deepEqual(previewBlockers(null), ["carga un fichero y previsualízalo antes de importar"]);
    assert.deepEqual(previewBlockers(preview()), []);
    assert.deepEqual(previewBlockers(preview({ missingRequired: ["llegada", "nombre"], canImport: false })), ["faltan columnas obligatorias por mapear: Llegada, Nombre"]);
    assert.deepEqual(previewBlockers(preview({ summary: summary({ error: 2, toCreate: 2 }), canImport: false })), ["2 filas con errores: corrígelas o activa «Omitir filas inválidas»"]);
    assert.deepEqual(previewBlockers(preview({ summary: summary({ error: 2, toCreate: 2 }), options: { omitirInvalidas: true, permitirOverbooking: false, historico: false, force: false } })), []);
    assert.deepEqual(previewBlockers(preview({ duplicates: { byReferenceRows: [], inFileRows: [], possibleRows: [], ofImport: { importId: "imp_9", createdAt: "2026-09-16T10:00:00.000Z", status: "imported", fileName: "reservas.csv" } }, canImport: false })), [
      "este fichero ya se importó (lote reservas.csv): deshaz el anterior o activa «Importar de todos modos»"
    ]);
    assert.deepEqual(previewBlockers(preview({ summary: summary({ valid: 0, warning: 0, toCreate: 0, skipped: 4 }), canImport: false })), ["no hay ninguna reserva que crear"]);
    assert.deepEqual(previewBlockers(preview({ rowCount: 0, rows: [], summary: summary({ valid: 0, warning: 0, toCreate: 0 }), canImport: false })), ["el fichero no tiene filas de datos"]);
    assert.deepEqual(previewBlockers(preview({ blockers: [{ code: "RESERVATION_IMPORT_TOO_MANY_ROWS", message: "El fichero supera las 5.000 filas: pártelo." }], canImport: false })), ["El fichero supera las 5.000 filas: pártelo"]);
    // FUX-07: a blocker the API already reported under its own code is not repeated by the local reason.
    assert.deepEqual(
      previewBlockers(preview({ blockers: [{ code: "RESERVATION_IMPORT_INVALID", message: "Hay 2 fila(s) con errores: corrígelas o activa «Omitir filas inválidas»." }], summary: summary({ error: 2, toCreate: 2 }), canImport: false })),
      ["Hay 2 fila(s) con errores: corrígelas o activa «Omitir filas inválidas»"]
    );
    assert.deepEqual(
      previewBlockers(preview({ blockers: [{ code: "RESERVATION_IMPORT_MAPPING_INCOMPLETE", message: "Faltan columnas obligatorias por mapear: «Llegada»." }], missingRequired: ["llegada"], canImport: false })),
      ["Faltan columnas obligatorias por mapear: «Llegada»"]
    );
    assert.deepEqual(
      previewBlockers(
        preview({
          blockers: [{ code: "RESERVATION_IMPORT_DUPLICATE", message: "Este fichero ya se importó (lote imp_9, 2026-09-16): deshaz el lote anterior o activa «Importar de todos modos»." }],
          duplicates: { byReferenceRows: [], inFileRows: [], possibleRows: [], ofImport: { importId: "imp_9", createdAt: "2026-09-16T10:00:00.000Z", status: "imported", fileName: "reservas.csv" } },
          canImport: false
        })
      ),
      ["Este fichero ya se importó (lote imp_9, 2026-09-16): deshaz el lote anterior o activa «Importar de todos modos»"]
    );
  });
});

describe("Importar reservas · resultado", () => {
  it("importStatusLabel covers the five lot statuses and their tones; unknown statuses come back as given", () => {
    assert.deepEqual(["processing", "imported", "partial", "failed", "undone"].map(importStatusLabel), ["Interrumpida", "Importada", "Parcial", "Fallida", "Deshecha"]);
    assert.deepEqual(["processing", "imported", "partial", "failed", "undone"].map(importStatusTone), ["warning", "success", "warning", "danger", "neutral"]);
    assert.equal(importStatusLabel("otro"), "otro");
    assert.equal(importStatusTone("otro"), "neutral");
    assert.deepEqual(["imported", "partial", "failed", "undone", "processing"].map(resultTone), ["success", "warning", "danger", "neutral", "warning"]);
    assert.deepEqual([rowOutcomeLabel("created"), rowOutcomeLabel("skipped"), rowOutcomeLabel("error")], ["Creada", "Omitida", "Error"]);
    assert.deepEqual([undoOutcomeLabel("cancelled"), undoOutcomeLabel("kept"), undoOutcomeLabel("skipped"), undoOutcomeLabel(null)], ["Cancelada", "Conservada (ya con check-in)", "Sin cambios (ya cancelada)", "—"]);
    assert.ok(canUndoImport({ status: "imported" }));
    assert.ok(canUndoImport({ status: "processing" }));
    assert.ok(!canUndoImport({ status: "undone" }));
    assert.ok(!canUndoImport({ status: "failed" }));
  });

  it("resultTitle and resultKpis read the counters of the lot", () => {
    const base = { status: "imported" as const, createdCount: 30, skippedCount: 0, errorCount: 0, warningCount: 4, undoneCount: 0, undoKeptCount: 0, totalAmount: "8760.00", currency: "EUR" };
    assert.equal(resultTitle(base), "30 reservas importadas");
    assert.equal(resultTitle({ ...base, status: "partial", createdCount: 25, skippedCount: 3, errorCount: 2 }), "Importación parcial: 25 reservas creadas, 3 omitidas, 2 con error");
    assert.equal(resultTitle({ ...base, status: "failed", createdCount: 0, errorCount: 5, skippedCount: 1 }), "Importación fallida: ninguna reserva creada (5 filas con error, 1 omitida)");
    assert.equal(resultTitle({ ...base, status: "undone", undoneCount: 29, undoKeptCount: 1 }), "Importación deshecha: 29 reservas canceladas, 1 conservada");
    assert.equal(resultTitle({ ...base, status: "processing", createdCount: 12 }), "Importación interrumpida: 12 reservas creadas hasta el corte; se puede deshacer");
    const kpis = resultKpis(base);
    assert.deepEqual(
      kpis.map((kpi) => [kpi.label, plain(kpi.value)]),
      [
        ["Creadas", "30"],
        ["Omitidas", "0"],
        ["Con error", "0"],
        ["Con avisos", "4"],
        ["Importe creado", "8760,00 €"]
      ]
    );
    assert.equal(kpis[0].tone, "success");
    assert.equal(undoSummary({ alreadyUndone: false, undoneCount: 5, undoKeptCount: 0 }), "5 reservas canceladas");
    assert.equal(undoSummary({ alreadyUndone: false, undoneCount: 4, undoKeptCount: 1 }), "4 reservas canceladas · 1 conservada (ya con check-in)");
    assert.equal(undoSummary({ alreadyUndone: true, undoneCount: 0, undoKeptCount: 0 }), "La importación ya estaba deshecha: no se ha cambiado nada.");
    assert.equal(importFileLabel({ fileName: " reservas.csv ", id: "imp_1" }), "reservas.csv");
    assert.equal(importFileLabel({ fileName: null, id: "imp_1" }), "imp_1");
    assert.equal(reportFileName({ id: "imp_1" }), "informe-importacion-imp_1.csv");
  });

  it("buildImportReportCsv writes BOM + «;» + CRLF with the twelve columns, escapes quotes, separators and line breaks, and carries no guest data", () => {
    const rows = [
      rowRecord(),
      rowRecord({ id: "row_2", rowNumber: 2, outcome: "error", reservationId: null, reservationCode: null, externalReference: 'REF;"2"', arrivalDate: null, departureDate: null, roomTypeCode: null, ratePlanCode: null, errorCode: "RESERVATION_IMPORT_ROW_INVALID_DATE", errorMessage: "Fila 2: fecha no válida (columna llegada).\nRevisa el formato." }),
      rowRecord({ id: "row_3", rowNumber: 3, outcome: "skipped", reservationId: null, reservationCode: null, errorCode: "RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE", errorMessage: "Fila 3: la referencia ya existe (reserva RES-00010).", warnings: [{ code: "RESERVATION_IMPORT_ROW_GUEST_REUSED", message: "Fila 3: huésped reutilizado por e-mail." }, { code: "RESERVATION_IMPORT_ROW_TOTAL_QUOTED", message: "Fila 3: importe cotizado." }], undoOutcome: "skipped" })
    ];
    const csv = buildImportReportCsv(rows);
    assert.ok(csv.startsWith("\uFEFF"), "BOM");
    const lines = csv.slice(1).split("\r\n");
    assert.equal(lines.at(-1), "", "ends with CRLF");
    assert.equal(lines[0], IMPORT_REPORT_HEADER.join(";"));
    assert.equal(lines[0], "fila;resultado;codigo_reserva;referencia_externa;llegada;salida;tipo_habitacion;tarifa;habitaciones;codigo_error;mensaje;avisos");
    assert.equal(lines[1], "1;Creada;RES-00086;IMP-TEST-001;2026-10-12;2026-10-15;DBL;BAR;1;;;");
    // Row 2: the reference with «;» and quotes is quoted with the quotes doubled; the bare «\n» of the message stays inside the quotes (only CRLF ends a record).
    assert.equal(lines[2], '2;Error;;"REF;""2""";;;;;1;RESERVATION_IMPORT_ROW_INVALID_DATE;"Fila 2: fecha no válida (columna llegada).\nRevisa el formato.";');
    assert.equal(lines[3], "3;Omitida;;IMP-TEST-001;2026-10-12;2026-10-15;DBL;BAR;1;RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE;Fila 3: la referencia ya existe (reserva RES-00010).;Fila 3: huésped reutilizado por e-mail. | Fila 3: importe cotizado.");
    assert.equal(lines.length, 5, "header + 3 records + trailing CRLF");
    assert.ok(!csv.includes("Lucía") && !csv.includes("example.com") && !csv.includes("11111111H"), "the report never carries guest data");
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(12), "12");
    assert.equal(csvCell("a;b"), '"a;b"');
    assert.equal(csvCell('a"b'), '"a""b"');
    assert.equal(csvCell("sin cambios"), "sin cambios");
    assert.equal(buildImportReportCsv([]), `\uFEFF${IMPORT_REPORT_HEADER.join(";")}\r\n`);
  });

  it("SEC-T7-02: a referencia_externa that starts like a formula (= + - @ tab CR, blanks included) is neutralised with an apostrophe and quoted; numbers stay numeric", () => {
    assert.equal(csvCell("=1+1"), "\"'=1+1\"");
    assert.equal(csvCell("+1+1"), "\"'+1+1\"");
    assert.equal(csvCell("-2+3"), "\"'-2+3\"");
    assert.equal(csvCell("@SUM(1)"), "\"'@SUM(1)\"");
    assert.equal(csvCell("  =HYPERLINK(\"http://x\")"), "\"'  =HYPERLINK(\"\"http://x\"\")\"");
    assert.equal(csvCell("\t=1"), "\"'\t=1\"");
    assert.equal(csvCell("=cmd|'/c calc'!A1"), "\"'=cmd|'/c calc'!A1\"");
    assert.equal(csvCell(-3), "-3", "a number is ours and stays numeric");
    assert.equal(csvCell("BK-2026-001"), "BK-2026-001", "a plain locator is untouched");
    assert.equal(csvCell("2026-10-12"), "2026-10-12");
    const row: ReservationImportRowRecord = {
      id: "rir_x",
      importId: "imp_1",
      rowNumber: 1,
      outcome: "created",
      externalReference: "=cmd|'/c calc'!A1",
      arrivalDate: "2026-10-12",
      departureDate: "2026-10-14",
      roomTypeCode: "DBL",
      ratePlanCode: "BAR",
      roomsCount: 1,
      reservationId: "res_1",
      reservationCode: "RES-000001",
      errorCode: null,
      errorMessage: null,
      warnings: [],
      undoOutcome: null
    };
    const line = buildImportReportCsv([row]).split("\r\n")[1]!;
    assert.match(line, /;"'=cmd\|'\/c calc'!A1";/);
    assert.doesNotMatch(line, /;=cmd/);
  });
});
