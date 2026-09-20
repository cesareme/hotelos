// Unit tests of the pure helpers of Documentos y digitalización (Tanda T9 ·
// lote T9-04). Run with the front unit command:
//   corepack pnpm --filter @hotelos/admin-web test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOCUMENT_CHECK_KEYS, DOCUMENT_ERROR_CODES, DOCUMENT_PHYSICAL_STATUSES, DOCUMENT_PROPOSED_ACTIONS, DOCUMENT_REJECT_REASONS, INCOMING_DOCUMENT_KINDS, INCOMING_DOCUMENT_SOURCES, INCOMING_DOCUMENT_STATUSES } from "@hotelos/shared";
import {
  CHECK_LABELS,
  DOCUMENT_ERROR_MESSAGES,
  DOCUMENT_KIND_LABELS,
  DOCUMENT_SOURCE_LABELS,
  DOCUMENT_STATUS_LABELS,
  MAX_TAB_LABEL_LENGTH,
  PHYSICAL_STATUS_LABELS,
  PROPOSED_ACTION_LABELS,
  REJECT_REASON_LABELS,
  addBusinessDays,
  checkTone,
  confidenceTone,
  documentErrorMessage,
  formatBytes,
  formatRegistry,
  groupByProperty,
  parseRegistry,
  slaBadge,
  statusTone
} from "../documents-helpers";

const ENGLISH = /\b(Invoice|Delivery|Receipt|Letter|Contract|Pending|Approved|Rejected|Archived|Review|Office|Centre|Unknown|Other)\b/;

describe("documents-helpers · labels", () => {
  it("cover every wire value of the shared catalogues (@hotelos/shared documents-types) in Spanish", () => {
    assert.deepEqual(Object.keys(DOCUMENT_KIND_LABELS).sort(), [...INCOMING_DOCUMENT_KINDS].sort());
    assert.deepEqual(Object.keys(DOCUMENT_STATUS_LABELS).sort(), [...INCOMING_DOCUMENT_STATUSES].sort());
    assert.deepEqual(Object.keys(DOCUMENT_SOURCE_LABELS).sort(), [...INCOMING_DOCUMENT_SOURCES].sort());
    assert.deepEqual(Object.keys(PHYSICAL_STATUS_LABELS).sort(), [...DOCUMENT_PHYSICAL_STATUSES].sort());
    assert.deepEqual(Object.keys(PROPOSED_ACTION_LABELS).sort(), [...DOCUMENT_PROPOSED_ACTIONS].sort());
    assert.deepEqual(Object.keys(REJECT_REASON_LABELS).sort(), [...DOCUMENT_REJECT_REASONS].sort());
    assert.deepEqual(Object.keys(CHECK_LABELS).sort(), [...DOCUMENT_CHECK_KEYS].sort());
    // The design's values (§8 enums, §5 actions, §6.1 reject reasons, §5 checks) are what the catalogue carries.
    assert.deepEqual([...INCOMING_DOCUMENT_STATUSES].sort(), ["approved", "archived", "captured", "in_review", "posted", "rejected", "returned_to_centre", "sent_to_office"]);
    assert.deepEqual([...DOCUMENT_REJECT_REASONS].sort(), ["duplicate", "illegible", "missing_pages", "not_ours", "other"]);
    for (const record of [DOCUMENT_KIND_LABELS, DOCUMENT_STATUS_LABELS, DOCUMENT_SOURCE_LABELS, PHYSICAL_STATUS_LABELS, PROPOSED_ACTION_LABELS, REJECT_REASON_LABELS, CHECK_LABELS]) {
      for (const [key, label] of Object.entries(record)) {
        assert.ok(label.trim().length > 0, `${key} sin etiqueta`);
        assert.ok(!ENGLISH.test(label), `${key} → «${label}» no está en español`);
        assert.ok(!label.includes("_"), `${key} → «${label}» filtra el código`);
      }
    }
  });

  it("stay within the 28 characters a tab label may carry", () => {
    assert.equal(MAX_TAB_LABEL_LENGTH, 28);
    for (const record of [DOCUMENT_KIND_LABELS, DOCUMENT_STATUS_LABELS, DOCUMENT_SOURCE_LABELS, PHYSICAL_STATUS_LABELS, PROPOSED_ACTION_LABELS, REJECT_REASON_LABELS, CHECK_LABELS]) {
      for (const [key, label] of Object.entries(record)) assert.ok(label.length <= MAX_TAB_LABEL_LENGTH, `${key} → «${label}» tiene ${label.length} caracteres`);
    }
    assert.equal(DOCUMENT_KIND_LABELS.invoice, "Factura");
    assert.equal(DOCUMENT_STATUS_LABELS.returned_to_centre, "Devuelto al centro");
    assert.equal(PROPOSED_ACTION_LABELS.create_supplier_bill, "Crear factura recibida");
  });
});

describe("documents-helpers · tones", () => {
  it("statusTone maps the eight statuses and falls back to neutral", () => {
    assert.equal(statusTone("captured"), "neutral");
    assert.equal(statusTone("sent_to_office"), "info");
    assert.equal(statusTone("in_review"), "accent");
    assert.equal(statusTone("approved"), "success");
    assert.equal(statusTone("posted"), "success");
    assert.equal(statusTone("archived"), "neutral");
    assert.equal(statusTone("returned_to_centre"), "warning");
    assert.equal(statusTone("rejected"), "danger");
    assert.equal(statusTone("whatever"), "neutral");
    assert.equal(statusTone(null), "neutral");
  });

  it("checkTone: ok → success · warn → warning · fail → danger · missing → neutral", () => {
    assert.equal(checkTone("ok"), "success");
    assert.equal(checkTone("warn"), "warning");
    assert.equal(checkTone("fail"), "danger");
    assert.equal(checkTone(undefined), "neutral");
  });

  it("confidenceTone: ≥ 0,85 green · 0,6–0,85 amber · < 0,6 red · none → «Manual» grey, with the percentage as label", () => {
    // lib/format percent() glues the sign with a no-break space (es-ES).
    const pct = (n: number) => `${n}\u00a0%`;
    assert.deepEqual(confidenceTone(0.92), { tone: "success", label: pct(92) });
    assert.deepEqual(confidenceTone(0.85), { tone: "success", label: pct(85) });
    assert.deepEqual(confidenceTone(0.849), { tone: "warning", label: pct(85) });
    assert.deepEqual(confidenceTone(0.6), { tone: "warning", label: pct(60) });
    assert.deepEqual(confidenceTone(0.59), { tone: "danger", label: pct(59) });
    assert.deepEqual(confidenceTone("0.9500"), { tone: "success", label: pct(95) });
    assert.deepEqual(confidenceTone(1.4), { tone: "success", label: pct(100) });
    assert.deepEqual(confidenceTone(null), { tone: "neutral", label: "Manual" });
    assert.deepEqual(confidenceTone(undefined), { tone: "neutral", label: "Manual" });
    assert.deepEqual(confidenceTone("n/a"), { tone: "neutral", label: "Manual" });
  });
});

describe("documents-helpers · formatting", () => {
  it("formatBytes in es-ES, base 1024, up to GB", () => {
    assert.equal(formatBytes(812), "812 B");
    assert.equal(formatBytes(512 * 1024), "512 KB");
    assert.equal(formatBytes(1536 * 1024), "1,5 MB");
    assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), "2,5 GB");
    assert.equal(formatBytes("2048"), "2 KB");
    assert.equal(formatBytes(-1), "—");
    assert.equal(formatBytes(null), "—");
  });

  it("parseRegistry / formatRegistry read and print «DOC-<centro>-<año>-<nnnnnn>»", () => {
    assert.deepEqual(parseRegistry("DOC-FAR-2026-000123"), { propertyCode: "FAR", year: 2026, sequence: 123 });
    assert.deepEqual(parseRegistry(" doc-ab12-2026-000007 "), { propertyCode: "AB12", year: 2026, sequence: 7 });
    assert.equal(parseRegistry("FAR-2026-000123"), null);
    assert.equal(parseRegistry(""), null);
    assert.equal(formatRegistry("doc-far-2026-000123"), "DOC-FAR-2026-000123");
    assert.equal(formatRegistry("DOC-FAR-2026-000123", { short: true }), "FAR-2026-000123");
    assert.equal(formatRegistry(null), "—");
    assert.equal(formatRegistry("   "), "—");
  });
});

describe("documents-helpers · error messages", () => {
  it("cover every DOCUMENT_ERROR_CODES of @hotelos/shared with a Spanish sentence, and nothing else", () => {
    assert.deepEqual(Object.keys(DOCUMENT_ERROR_MESSAGES).sort(), [...DOCUMENT_ERROR_CODES].sort());
    assert.ok(DOCUMENT_ERROR_CODES.length >= 16);
    for (const code of DOCUMENT_ERROR_CODES) {
      const message = DOCUMENT_ERROR_MESSAGES[code];
      assert.ok(message && message.length > 20, `${code} sin mensaje`);
      assert.ok(!/\b(not found|invalid|error|failed)\b/i.test(message), `${code} → mensaje en inglés`);
    }
    assert.ok(Object.isFrozen(DOCUMENT_ERROR_MESSAGES));
  });

  it("documentErrorMessage: documents code first, then a finance code, then the API message, then the fallback", () => {
    const typed = (code: string, message = "raw") => Object.assign(new Error(message), { status: 409, details: { code } });
    assert.equal(documentErrorMessage(typed("DOCUMENT_DUPLICATE_FILE")), DOCUMENT_ERROR_MESSAGES.DOCUMENT_DUPLICATE_FILE);
    assert.equal(documentErrorMessage(typed("CHART_NOT_PROVISIONED")), "La organización no tiene plan de cuentas: provisiona la plantilla PGC Pymes hotelero antes de contabilizar.");
    assert.equal(documentErrorMessage(typed("SOMETHING_ELSE", "Mensaje del API")), "Mensaje del API");
    assert.equal(documentErrorMessage(new Error("  "), "Respaldo"), "Respaldo");
    assert.equal(documentErrorMessage(null), "No se pudo completar la operación con el documento. Inténtalo de nuevo.");
    assert.equal(documentErrorMessage("texto suelto"), "texto suelto");
  });
});

describe("documents-helpers · groupByProperty", () => {
  it("groups by centre keeping row order, sorted by code, then name, codeless centres last", () => {
    const rows = [
      { id: "1", propertyId: "p2", propertyCode: "SAN", propertyName: "Hotel Santiago" },
      { id: "2", propertyId: "p1", propertyCode: "COR", propertyName: "Hotel Coruña" },
      { id: "3", propertyId: "p3", propertyCode: null, propertyName: "Oficina central" },
      { id: "4", propertyId: "p2", propertyCode: "SAN", propertyName: "Hotel Santiago" },
      { id: "5", propertyId: "p4", propertyCode: null, propertyName: "Almacén" },
      { id: "6", propertyId: "p1" }
    ];
    const groups = groupByProperty(rows);
    assert.deepEqual(
      groups.map((g) => [g.propertyId, g.propertyCode, g.propertyName, g.rows.map((r) => r.id)]),
      [
        ["p1", "COR", "Hotel Coruña", ["2", "6"]],
        ["p2", "SAN", "Hotel Santiago", ["1", "4"]],
        ["p4", null, "Almacén", ["5"]],
        ["p3", null, "Oficina central", ["3"]]
      ]
    );
    assert.deepEqual(groupByProperty([]), []);
  });
});

describe("documents-helpers · SLA", () => {
  it("addBusinessDays skips Saturdays and Sundays", () => {
    assert.equal(addBusinessDays("2026-09-18", 2), "2026-09-22"); // Friday + 2 → Tuesday
    assert.equal(addBusinessDays("2026-09-19", 2), "2026-09-22"); // Saturday + 2 → Tuesday
    assert.equal(addBusinessDays("2026-09-21", 5), "2026-09-28"); // Monday + 5 → next Monday
    assert.equal(addBusinessDays("2026-09-21", 0), "2026-09-21");
    assert.equal(addBusinessDays("2026-12-31", 1), "2027-01-01");
  });

  it("slaBadge: green with days left, amber the day before and the same day, red once breached, grey when not sent", () => {
    const sentAt = "2026-09-16T09:30:00.000Z"; // Wednesday → due Friday 18 with 2 business days
    assert.deepEqual(slaBadge(sentAt, 2, "2026-09-16T12:00:00.000Z"), { tone: "success", label: "Vence en 2 días", dueOn: "2026-09-18", daysLeft: 2, breached: false });
    assert.deepEqual(slaBadge(sentAt, 2, "2026-09-17T12:00:00.000Z"), { tone: "warning", label: "Vence mañana", dueOn: "2026-09-18", daysLeft: 1, breached: false });
    assert.deepEqual(slaBadge(sentAt, 2, "2026-09-18T12:00:00.000Z"), { tone: "warning", label: "Vence hoy", dueOn: "2026-09-18", daysLeft: 0, breached: false });
    assert.deepEqual(slaBadge(sentAt, 2, "2026-09-19T12:00:00.000Z"), { tone: "danger", label: "Vencido hace 1 día", dueOn: "2026-09-18", daysLeft: -1, breached: true });
    assert.deepEqual(slaBadge(sentAt, 2, "2026-09-23T12:00:00.000Z"), { tone: "danger", label: "Vencido hace 5 días", dueOn: "2026-09-18", daysLeft: -5, breached: true });
    assert.deepEqual(slaBadge(null, 2, "2026-09-23T12:00:00.000Z"), { tone: "neutral", label: "Sin enviar", dueOn: null, daysLeft: null, breached: false });
  });

  it("slaBadge counts the day in Madrid (a late-night UTC send is the next calendar day)", () => {
    // 2026-09-18 23:30 UTC is already Saturday 19 in Madrid → +2 business days → Tuesday 22.
    assert.equal(slaBadge("2026-09-18T23:30:00.000Z", 2, "2026-09-21T12:00:00.000Z").dueOn, "2026-09-22");
  });
});
