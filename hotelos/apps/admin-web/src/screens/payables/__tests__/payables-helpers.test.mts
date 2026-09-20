// Unit tests of the pure helpers of the Proveedores, gastos e inmovilizado lot
// (Tanda 6 · Finanzas · lote 6-E). Run with the front unit command:
//   cd apps/api && TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test \
//     $(find ../admin-web/src -path '*/__tests__/*.test.mts')

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DOCUMENT_ERROR_CODES, SUPPLIER_BILL_MATCH_STATUSES, SUPPLIER_BILL_SOURCES } from "@hotelos/shared";
import {
  BILL_MATCH_LABELS,
  BILL_MATCH_TONES,
  BILL_SOURCE_LABELS,
  BILL_SOURCE_TONES,
  accountLabel,
  accountOptions,
  addDays,
  amountOf,
  attachmentRejection,
  base64OfDataUrl,
  billApprovalBlock,
  billAttachmentSource,
  billMatchLabel,
  billMatchTone,
  billSourceLabel,
  billSourceTone,
  decimalInput,
  describeFailure,
  isExpenseAccount,
  isInvestmentAccount,
  isTreasuryAccount,
  maxCoefficientLabel,
  openBillAttachment,
  periodLabel,
  previousMonthPeriod,
  quotaOf,
  to2
} from "../payables-helpers";
import { FINANCE_ERROR_MESSAGES, financeErrorMessage } from "../../../services/finance-contracts";
import { DOCUMENT_ERROR_MESSAGES } from "../../documents/documents-helpers";

const account = (code: string, name: string, isPostable = true) => ({
  id: code,
  code,
  name,
  kind: "expense",
  accountType: "expense",
  group: Number(code[0]),
  level: 3,
  isPostable,
  parentId: null,
  parentCode: code.slice(0, 2),
  usaliDepartment: null,
  usaliLine: null
});

describe("payables-helpers · decimales", () => {
  it("normalises es-ES and wire inputs to 2-decimal strings", () => {
    assert.equal(decimalInput("12,5"), "12.50");
    assert.equal(decimalInput("1.234,56"), "1234.56");
    assert.equal(decimalInput("100"), "100.00");
    assert.equal(decimalInput(" 0.21 "), "0.21");
  });

  it("rejects more than 2 decimals, text and empty input", () => {
    assert.equal(decimalInput("12.345"), null);
    assert.equal(decimalInput("12,345"), null);
    assert.equal(decimalInput("abc"), null);
    assert.equal(decimalInput(""), null);
  });

  it("amountOf tolerates wire strings and invalid input", () => {
    assert.equal(amountOf("106.00"), 106);
    assert.equal(amountOf("24,50"), 24.5);
    assert.equal(amountOf(""), 0);
    assert.equal(amountOf(null), 0);
  });

  it("quotaOf rounds to the cent like the API (half-up)", () => {
    assert.equal(quotaOf(100, 21), 21);
    assert.equal(quotaOf(1, 21), 0.21);
    assert.equal(quotaOf(10.05, 10), 1.01);
    assert.equal(to2(106), "106.00");
  });
});

describe("payables-helpers · fechas y periodos", () => {
  it("addDays proposes the due date from the payment term without a time-zone slide", () => {
    assert.equal(addDays("2026-09-10", 30), "2026-10-10");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  });

  it("previousMonthPeriod is the usual month to depreciate", () => {
    assert.equal(previousMonthPeriod("2026-09-16"), "2026-08");
    assert.equal(previousMonthPeriod("2026-01-05"), "2025-12");
  });

  it("periodLabel prints «mes año» in es-ES and leaves malformed codes alone", () => {
    assert.match(periodLabel("2026-08"), /ago.*2026/);
    assert.equal(periodLabel("2026"), "2026");
  });
});

describe("payables-helpers · adjuntos", () => {
  it("accepts PDF / JPEG / PNG up to 512 KiB and rejects the rest in Spanish", () => {
    assert.equal(attachmentRejection({ type: "application/pdf", size: 512 * 1024 }), null);
    assert.equal(attachmentRejection({ type: "image/png", size: 10 }), null);
    assert.match(attachmentRejection({ type: "image/gif", size: 10 }) ?? "", /PDF|JPEG|PNG/);
    assert.match(attachmentRejection({ type: "application/pdf", size: 512 * 1024 + 1 }) ?? "", /512 KiB/);
  });

  it("base64OfDataUrl strips the data: prefix", () => {
    assert.equal(base64OfDataUrl("data:application/pdf;base64,JVBERi0="), "JVBERi0=");
    assert.equal(base64OfDataUrl("JVBERi0="), "JVBERi0=");
  });
});

describe("payables-helpers · cuentas y errores", () => {
  it("filters the pickers by group and hides headers", () => {
    const chart = [account("6", "Compras y gastos", false), account("629", "Otros servicios"), account("216", "Mobiliario"), account("572", "Bancos"), account("4300", "Clientes"), account("600", "Compras")];
    assert.deepEqual(accountOptions(chart, isExpenseAccount).map((o) => o.value), ["600", "629"]);
    assert.deepEqual(accountOptions(chart, isInvestmentAccount).map((o) => o.value), ["216"]);
    assert.deepEqual(accountOptions(chart, isTreasuryAccount).map((o) => o.value), ["572"]);
    assert.equal(accountOptions(chart, isExpenseAccount)[1].label, "629 · Otros servicios");
    assert.equal(accountLabel(chart, "216"), "216 · Mobiliario");
    assert.equal(accountLabel(chart, "999"), "999");
    assert.equal(accountLabel(chart, null), "—");
  });

  it("maxCoefficientLabel formats the LIS table maximum", () => {
    assert.match(maxCoefficientLabel("mobiliario"), /^10\s?%$/);
    assert.match(maxCoefficientLabel("informatica"), /^25\s?%$/);
  });

  it("describeFailure keeps the details.code and maps it to the Spanish sentence", () => {
    const failure = describeFailure({ message: "raw", status: 409, details: { code: "PREVIOUS_PERIOD_MISSING", pendingPeriods: ["2026-07", "2026-08"] } }, "fallback");
    assert.equal(failure.code, "PREVIOUS_PERIOD_MISSING");
    assert.match(failure.message, /mes a mes/);
    assert.match(failure.message, /2026-07, 2026-08/);
    const plain = describeFailure(new Error("El archivo está vacío."), "fallback");
    assert.equal(plain.code, null);
    assert.equal(plain.message, "El archivo está vacío.");
    assert.equal(describeFailure(undefined, "fallback").message, "fallback");
  });
});

// ---------------------------------------------------------------------------
// Tanda T9 · lote T9-11: origen, cotejo, adjunto binario y puertas de aprobación
// ---------------------------------------------------------------------------

describe("payables-helpers · origen y cotejo (T9-11)", () => {
  it("labels every wire source and match status of the shared contract, in Spanish and short enough for a badge", () => {
    for (const source of SUPPLIER_BILL_SOURCES) {
      assert.ok(BILL_SOURCE_LABELS[source], `source ${source} sin etiqueta`);
      assert.ok(BILL_SOURCE_TONES[source], `source ${source} sin tono`);
      assert.ok(BILL_SOURCE_LABELS[source].length <= 28);
    }
    for (const status of SUPPLIER_BILL_MATCH_STATUSES) {
      assert.ok(BILL_MATCH_LABELS[status], `matchStatus ${status} sin etiqueta`);
      assert.ok(BILL_MATCH_TONES[status], `matchStatus ${status} sin tono`);
      assert.ok(BILL_MATCH_LABELS[status].length <= 28);
    }
    assert.equal(BILL_SOURCE_LABELS.manual, "Manual");
    assert.equal(BILL_SOURCE_LABELS.digitized, "Digitalizada");
    assert.equal(BILL_SOURCE_LABELS.e_invoice, "e-factura");
    assert.deepEqual([BILL_MATCH_LABELS.none, BILL_MATCH_LABELS.partial, BILL_MATCH_LABELS.full, BILL_MATCH_LABELS.variance], ["Sin cotejar", "Parcial", "Completo", "Diferencias"]);
  });

  it("billSourceLabel / billMatchLabel tolerate an unknown or missing wire value (older API) and keep the tones", () => {
    assert.equal(billSourceLabel("digitized"), "Digitalizada");
    assert.equal(billSourceLabel(undefined), "Manual");
    assert.equal(billSourceLabel("something_else"), "Manual");
    assert.equal(billSourceTone("e_invoice"), "accent");
    assert.equal(billSourceTone(null), "neutral");
    assert.equal(billMatchLabel("variance"), "Diferencias");
    assert.equal(billMatchLabel(null), "Sin cotejar");
    assert.equal(billMatchTone("full"), "success");
    assert.equal(billMatchTone("variance"), "danger");
    assert.equal(billMatchTone("unknown"), "neutral");
  });
});

describe("payables-helpers · openBillAttachment decide inline / blob (T9-11)", () => {
  const blob = { size: 3, type: "application/pdf" } as unknown as Blob;

  it("billAttachmentSource: inline base64 first, then the binary route of the document, otherwise none", () => {
    assert.equal(billAttachmentSource({ inline: true, base64: "JVBERi0=", mimeType: "application/pdf" }), "inline");
    assert.equal(billAttachmentSource({ inline: false, downloadPath: "/properties/p1/documents/d1/file" }), "download");
    assert.equal(billAttachmentSource({ inline: true, base64: "", mimeType: "application/pdf", downloadPath: "/properties/p1/documents/d1/file" }), "download");
    assert.equal(billAttachmentSource({ inline: false, documentObjectKey: "org/o/prop/p/doc/d/abc.pdf" }), "none");
    assert.equal(billAttachmentSource({ inline: false }), "none");
  });

  it("an inline attachment opens from its base64 without touching the network", async () => {
    const calls: string[] = [];
    const result = await openBillAttachment(
      { inline: true, base64: "JVBERi0=", mimeType: "application/pdf" },
      {
        fetchBlob: async (path) => {
          calls.push(`fetch:${path}`);
          return blob;
        },
        openInline: (base64, mime) => {
          calls.push(`inline:${base64}:${mime}`);
          return true;
        },
        openBlob: () => {
          calls.push("blob");
          return true;
        }
      }
    );
    assert.deepEqual(result, { source: "inline", opened: true });
    assert.deepEqual(calls, ["inline:JVBERi0=:application/pdf"]);
  });

  it("a digitised attachment fetches the Blob of `downloadPath` and opens it; a blocked window reports opened: false", async () => {
    const calls: string[] = [];
    const deps = {
      fetchBlob: async (path: string) => {
        calls.push(`fetch:${path}`);
        return blob;
      },
      openInline: () => {
        calls.push("inline");
        return true;
      },
      openBlob: (opened: Blob) => {
        calls.push(`blob:${opened.type}`);
        return calls.length < 3;
      }
    };
    const first = await openBillAttachment({ inline: false, base64: null, mimeType: null, downloadPath: "/properties/p1/documents/d1/file", documentObjectKey: "org/o/prop/p1/doc/d1/aa.pdf" }, deps);
    assert.deepEqual(first, { source: "download", opened: true });
    assert.deepEqual(calls, ["fetch:/properties/p1/documents/d1/file", "blob:application/pdf"]);
    const blocked = await openBillAttachment({ inline: false, downloadPath: "/properties/p1/documents/d1/file" }, deps);
    assert.deepEqual(blocked, { source: "download", opened: false });
  });

  it("a bill without a showable attachment answers none and opens nothing", async () => {
    let touched = false;
    const result = await openBillAttachment(
      { inline: false, documentObjectKey: "org/o/prop/p/doc/d/abc.pdf" },
      {
        fetchBlob: async () => {
          touched = true;
          return blob;
        },
        openBlob: () => {
          touched = true;
          return true;
        },
        openInline: () => {
          touched = true;
          return true;
        }
      }
    );
    assert.deepEqual(result, { source: "none", opened: false });
    assert.equal(touched, false);
  });
});

describe("payables-helpers · puertas de aprobación y mensajes (T9-11)", () => {
  it("billApprovalBlock reads the tier gate with its tiers and pending request and offers the supervisor PIN", () => {
    const block = billApprovalBlock({ message: "raw", status: 403, details: { code: "RBAC_LEVEL_EXCEEDED", tier: "T4", maxTier: "T3", kind: "supplier_bill", requestId: "apr_0123456789abcdef" } });
    assert.ok(block);
    assert.equal(block.code, "RBAC_LEVEL_EXCEEDED");
    assert.equal(block.action, "supervisor");
    assert.equal(block.tier, "T4");
    assert.equal(block.maxTier, "T3");
    assert.equal(block.requestId, "apr_0123456789abcdef");
    assert.match(block.message, /supera tu tramo de aprobación/);
    assert.match(block.message, /Tramo del importe: T4; tu tramo máximo: T3\./);
    assert.match(block.message, /Solicitud pendiente: apr_0123456789abcdef\./);
    const bare = billApprovalBlock({ status: 403, details: { code: "RBAC_LEVEL_EXCEEDED", tier: "T4", maxTier: "T3" } });
    assert.ok(bare);
    assert.equal(bare.requestId, null);
    assert.doesNotMatch(bare.message, /Solicitud pendiente/);
  });

  it("billApprovalBlock: separation of duties has no action; the match guard offers the match with its reason; other codes are null", () => {
    const sod = billApprovalBlock({ status: 409, details: { code: "RBAC_SOD_CONFLICT", rule: "creator_ne_approver" } });
    assert.ok(sod);
    assert.equal(sod.action, null);
    assert.equal(sod.message, FINANCE_ERROR_MESSAGES.RBAC_SOD_CONFLICT);
    assert.match(sod.message, /Quien registró la factura no puede aprobarla ni pagarla/);
    const variance = billApprovalBlock({ status: 409, details: { code: "SUPPLIER_BILL_MATCH_REQUIRED", matchStatus: "variance", reason: "variance", pendingReceipts: 0 } });
    assert.ok(variance);
    assert.equal(variance.action, "match");
    assert.match(variance.message, /necesita cotejarse/);
    assert.match(variance.message, /diferencias fuera de tolerancia/);
    const pending = billApprovalBlock({ status: 409, details: { code: "SUPPLIER_BILL_MATCH_REQUIRED", matchStatus: "none", reason: "pending_receipts", pendingReceipts: 2 } });
    assert.ok(pending);
    assert.match(pending.message, /2 albaranes pendientes de cotejar/);
    const one = financeErrorMessage({ details: { code: "SUPPLIER_BILL_MATCH_REQUIRED", reason: "pending_receipts", pendingReceipts: 1 } });
    assert.match(one, /1 albarán pendiente de cotejar/);
    assert.equal(billApprovalBlock({ status: 409, details: { code: "SUPPLIER_BILL_DUPLICATE" } }), null);
    assert.equal(billApprovalBlock(new Error("red")), null);
    assert.equal(billApprovalBlock(undefined), null);
  });

  it("FINANCE_ERROR_MESSAGES carries the RBAC gates, the match guard and every DOCUMENT_* code, with the same sentences as documents-helpers", () => {
    assert.match(FINANCE_ERROR_MESSAGES.RBAC_SOD_CONFLICT, /^Quien registró la factura no puede aprobarla ni pagarla/);
    assert.match(FINANCE_ERROR_MESSAGES.RBAC_LEVEL_EXCEEDED, /^El importe supera tu tramo de aprobación: pide autorización/);
    assert.match(FINANCE_ERROR_MESSAGES.RBAC_LEVEL_EXCEEDED, /Pendientes/);
    assert.equal(FINANCE_ERROR_MESSAGES.SUPPLIER_BILL_MATCH_REQUIRED, DOCUMENT_ERROR_MESSAGES.SUPPLIER_BILL_MATCH_REQUIRED);
    // The three generic codes keep the finance sentence here (documents-helpers looks its own dictionary up first).
    const generic = new Set(["VALIDATION_ERROR", "PROPERTY_NOT_FOUND", "ENTITY_SCOPE_REQUIRED"]);
    for (const code of DOCUMENT_ERROR_CODES) {
      assert.ok(FINANCE_ERROR_MESSAGES[code], `${code} sin frase en FINANCE_ERROR_MESSAGES`);
      if (!generic.has(code)) assert.equal(FINANCE_ERROR_MESSAGES[code], DOCUMENT_ERROR_MESSAGES[code], `${code} diverge de documents-helpers`);
    }
    const failure = describeFailure({ status: 409, details: { code: "DOCUMENT_DUPLICATE_FILE" } }, "fallback");
    assert.equal(failure.code, "DOCUMENT_DUPLICATE_FILE");
    assert.equal(failure.message, DOCUMENT_ERROR_MESSAGES.DOCUMENT_DUPLICATE_FILE);
  });
});
