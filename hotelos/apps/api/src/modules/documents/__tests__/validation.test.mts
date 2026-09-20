// Unit tests · Tanda T9 · lote T9-06b — comprobaciones del servidor (diseño §5.1 «Validar»).
// Sin base de datos, sin red; NIF calculados sobre dígitos inventados. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/validation.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cifFor } from "./fixtures.js";
import type { GoodsReceiptLike } from "../matching.js";
import {
  DUPLICATE_DATE_WINDOW_DAYS,
  checksWithStatus,
  documentNumberOf,
  extractedRetentionRate,
  hasFailedCheck,
  quotedReferences,
  resolveLines,
  tolerancesOf,
  validateDocument,
  type ExtractedDocumentFields,
  type ValidateDocumentInput
} from "../validation.js";

const NIF = cifFor("B", "7654321");
const OTHER_NIF = cifFor("A", "1234567");
const INVALID_NIF = `${NIF.slice(0, -1)}${NIF.endsWith("0") ? "1" : "0"}`;

/** 120 × 1,25 + 40 × 0,50 = 170,00 base · IVA 21 % 35,70 · total 205,70. */
const invoiceFields = (over: Partial<ExtractedDocumentFields> = {}): ExtractedDocumentFields => ({
  supplierName: "Lavandería Cantábrica Demo SL",
  supplierTaxId: NIF,
  documentNumber: "F-2026-0042",
  issueDate: "2026-09-10",
  total: "205.70",
  lines: [
    { description: "Lavado y planchado de sábanas (kg)", quantity: 120, unitPrice: "1.25", taxRate: 21 },
    { description: "Toallas de baño (unidad)", quantity: 40, unitPrice: "0.50", taxRate: 21 }
  ],
  ...over
});

const run = (over: Partial<ValidateDocumentInput> = {}) => validateDocument({ kind: "invoice", fields: invoiceFields(), ...over });

const receipt = (over: Partial<GoodsReceiptLike> = {}): GoodsReceiptLike => ({
  id: "gr_1",
  propertyId: "prop_demo",
  supplierTaxId: NIF,
  deliveryNoteNumber: "ALB-2026/0042",
  status: "received",
  lines: [
    { id: "grl_1", description: "Lavado y planchado de sábanas (kg)", quantityReceived: "120.000", unitPrice: "1.2500" },
    { id: "grl_2", description: "Toallas de baño (unidad)", quantityReceived: "40.000", unitPrice: "0.5000" }
  ],
  ...over
});

describe("validateDocument · forma", () => {
  it("devuelve siempre las siete comprobaciones con estado y mensaje en español", () => {
    const checks = run();
    assert.deepEqual(Object.keys(checks).sort(), ["duplicate", "match", "nif", "retention", "supplier", "totals", "vat"]);
    for (const check of Object.values(checks)) {
      assert.ok(["ok", "warn", "fail"].includes(check.status));
      assert.ok(check.message.length > 0);
    }
    assert.equal(hasFailedCheck(checks), false);
    assert.deepEqual(checksWithStatus(checks, "warn"), ["supplier"], "proveedor desconocido es el único aviso de la factura base");
  });

  it("una carta no lleva NIF, importes ni cotejo: todo «no aplica» en ok", () => {
    const checks = validateDocument({ kind: "letter", fields: { senderName: "Ayuntamiento Demo", subject: "Convocatoria" } });
    assert.equal(hasFailedCheck(checks), false);
    assert.equal(checks.nif.status, "ok");
    assert.equal(checks.totals.status, "ok");
    assert.equal(checks.vat.status, "ok");
    assert.equal(checks.match.status, "ok");
    assert.equal(checks.duplicate.details?.applicable, false);
  });
});

describe("nif", () => {
  it("NIF inválido → fail en factura (aviso en ticket); ausente → fail en factura, aviso en albarán, ok en ticket", () => {
    assert.equal(run({ fields: invoiceFields({ supplierTaxId: INVALID_NIF }) }).nif.status, "fail");
    assert.equal(run({ kind: "receipt", fields: invoiceFields({ supplierTaxId: INVALID_NIF }) }).nif.status, "warn");
    const missing = run({ fields: invoiceFields({ supplierTaxId: null }) }).nif;
    assert.equal(missing.status, "fail");
    assert.equal(missing.details?.missing, true);
    assert.equal(run({ kind: "delivery_note", fields: invoiceFields({ supplierTaxId: "" }) }).nif.status, "warn");
    assert.equal(run({ kind: "receipt", fields: invoiceFields({ supplierTaxId: undefined }) }).nif.status, "ok");
  });

  it("NIF válido → ok con el valor normalizado y si es sociedad", () => {
    const check = run({ fields: invoiceFields({ supplierTaxId: ` es-${NIF.toLowerCase()} ` }) }).nif;
    assert.equal(check.status, "ok");
    assert.equal(check.details?.value, NIF);
    assert.equal(check.details?.isCompany, true);
    assert.equal(run({ fields: invoiceFields({ supplierTaxId: "12345678Z" }) }).nif.details?.isCompany, false);
  });
});

describe("supplier", () => {
  it("proveedor desconocido → warn sin origen Sage", () => {
    const check = run().supplier;
    assert.equal(check.status, "warn");
    assert.equal(check.details?.fromSage, false);
    assert.match(check.message, /desconocido/i);
  });

  it("solo en Sage → warn «proponer alta desde Sage» con nombre, NIF y cuenta", () => {
    const check = run({ sageSupplier: { name: "LAVANDERIA CANTABRICA DEMO SL", taxId: NIF, sourceAccount: "4000012", accounts: ["4000012", "4100003"] } }).supplier;
    assert.equal(check.status, "warn");
    assert.match(check.message, /alta desde Sage/);
    assert.equal(check.details?.fromSage, true);
    assert.equal(check.details?.taxId, NIF);
    assert.equal(check.details?.sourceAccount, "4000012");
    assert.deepEqual(check.details?.accounts, ["4000012", "4100003"]);
  });

  it("proveedor dado de alta → ok; con NIF distinto del extraído → warn", () => {
    const supplier = { id: "sup_1", name: "Lavandería Cantábrica Demo SL", taxId: NIF };
    assert.equal(run({ supplier }).supplier.status, "ok");
    const mismatch = run({ supplier: { ...supplier, taxId: OTHER_NIF } }).supplier;
    assert.equal(mismatch.status, "warn");
    assert.equal(mismatch.details?.mismatch, true);
  });
});

describe("totals", () => {
  it("cuadra al céntimo → ok con los totales calculados", () => {
    const check = run().totals;
    assert.equal(check.status, "ok");
    assert.equal(check.details?.computedTotal, "205.70");
    assert.equal(check.details?.baseTotal, "170.00");
    assert.equal(check.details?.taxTotal, "35.70");
    assert.equal(check.details?.printedTotal, "205.70");
  });

  it("± 0,01 → ok con la diferencia anotada; más → fail", () => {
    const rounding = run({ fields: invoiceFields({ total: "205.71" }) }).totals;
    assert.equal(rounding.status, "ok");
    assert.equal(rounding.details?.difference, "0.01");
    const off = run({ fields: invoiceFields({ total: "210.00" }) }).totals;
    assert.equal(off.status, "fail");
    assert.equal(off.details?.difference, "4.30");
    assert.match(off.message, /no cuadra/);
  });

  it("factura: total impreso sin líneas o una línea sin importe → fail; sin total impreso → warn; nada extraído → warn needsManual (RV-11)", () => {
    const noLines = run({ fields: invoiceFields({ lines: [] }) }).totals;
    assert.equal(noLines.status, "fail");
    assert.match(noLines.message, /faltan las líneas/);
    const nothing = run({ fields: invoiceFields({ lines: null, total: null }) }).totals;
    assert.equal(nothing.status, "warn", "sin líneas ni total no hay contradicción: formulario manual");
    assert.equal(nothing.details?.needsManual, true);
    const noAmount = run({ fields: invoiceFields({ lines: [{ description: "Servicio", taxRate: 21 }] }) }).totals;
    assert.equal(noAmount.status, "fail");
    assert.deepEqual(noAmount.details?.linesWithoutAmount, [1]);
    const noPrinted = run({ fields: invoiceFields({ total: undefined }) }).totals;
    assert.equal(noPrinted.status, "warn");
    assert.equal(noPrinted.details?.computedTotal, "205.70");
  });

  it("albarán y tique sin líneas ni total (imagen sin proveedor, escaneo sin texto) → warn needsManual, nunca fail (RV-11: aprobar la recepción o el gasto no exige override)", () => {
    for (const kind of ["delivery_note", "receipt"] as const) {
      const nothing = run({ kind, fields: { ...invoiceFields({ lines: null, total: null }), lines: null, total: null } }).totals;
      assert.equal(nothing.status, "warn", kind);
      assert.equal(nothing.details?.needsManual, true, kind);
      const printedOnly = run({ kind, fields: { ...invoiceFields({ lines: null }), lines: null } }).totals;
      assert.equal(printedOnly.status, "warn", `${kind}: total impreso sin líneas se revisa a mano`);
      const noAmount = run({ kind, fields: invoiceFields({ lines: [{ description: "Servicio", taxRate: 21 }] }) }).totals;
      assert.equal(noAmount.status, "warn", `${kind}: línea sin importe`);
      assert.deepEqual(noAmount.details?.linesWithoutAmount, [1]);
    }
    // Una contradicción real sigue en fail también fuera de la factura.
    assert.equal(run({ kind: "receipt", fields: invoiceFields({ total: "210.00" }) }).totals.status, "fail");
  });

  it("cuota impresa fuera de ± 0,01 → fail LINE_QUOTA_MISMATCH; con retención impresa el total la descuenta", () => {
    const quota = run({ fields: invoiceFields({ lines: [{ description: "x", base: "100.00", taxRate: 21, quota: "21.50" }], total: "121.50" }) }).totals;
    assert.equal(quota.status, "fail");
    assert.equal(quota.details?.code, "LINE_QUOTA_MISMATCH");
    const retained = run({ fields: invoiceFields({ lines: [{ description: "Honorarios", base: "1000.00", taxRate: 21 }], retentionRate: 15, total: "1060.00" }) }).totals;
    assert.equal(retained.status, "ok");
    assert.equal(retained.details?.retentionAmount, "150.00");
  });
});

describe("vat", () => {
  it("tipos admitidos → ok; 5 % → fail needsManual unsupported_rate", () => {
    assert.deepEqual(run().vat.details?.rates, ["21"]);
    const five = run({ fields: invoiceFields({ lines: [{ description: "x", base: "100.00", taxRate: 5 }], total: "105.00" }) }).vat;
    assert.equal(five.status, "fail");
    assert.equal(five.details?.needsManual, true);
    assert.equal(five.details?.reason, "unsupported_rate");
    assert.deepEqual(five.details?.unsupported, ["5"]);
    assert.equal(run({ fields: invoiceFields({ lines: [{ description: "x", base: "100.00", taxRate: 5 }], total: "105.00" }) }).totals.status, "ok", "los totales se suman igualmente");
  });

  it("recargo de equivalencia, ISP e intracomunitaria → fail needsManual con motivo", () => {
    assert.equal(run({ fields: invoiceFields({ surchargeRate: "5.2" }) }).vat.details?.reason, "recargo_equivalencia");
    assert.equal(run({ fields: invoiceFields({ vatRegime: "recargo_equivalencia" }) }).vat.status, "fail");
    assert.equal(run({ fields: invoiceFields({ reverseCharge: true }) }).vat.details?.reason, "isp");
    assert.equal(run({ fields: invoiceFields({ intraCommunity: true }) }).vat.details?.reason, "intracomunitaria");
  });

  it("sin tipo extraído → warn en factura, ok en albarán", () => {
    assert.equal(run({ fields: invoiceFields({ lines: [{ description: "x", base: "100.00" }], total: "100.00" }) }).vat.status, "warn");
    assert.equal(run({ kind: "delivery_note", fields: invoiceFields({ lines: [{ description: "x", quantity: 2, unitPrice: "1.00" }], total: null }) }).vat.status, "ok");
  });
});

describe("duplicate", () => {
  const bill = { id: "sb_1", invoiceNumber: "F-2026-0042", total: "205.70", issueDate: "2026-09-10", supplierTaxId: NIF };

  it("mismo sha256 → fail con el documento original", () => {
    const check = run({ sha256Duplicate: { id: "doc_1", registryNumber: "DOC-RA-2026-000001" } }).duplicate;
    assert.equal(check.status, "fail");
    assert.equal(check.details?.source, "file");
    assert.equal(check.details?.documentId, "doc_1");
  });

  it("proveedor + número exacto en las facturas registradas → fail con el enlace", () => {
    const check = run({ existingBills: [bill] }).duplicate;
    assert.equal(check.status, "fail");
    assert.equal(check.details?.source, "supplier_bill");
    assert.equal(check.details?.supplierBillId, "sb_1");
    assert.equal(check.details?.kind, "exact");
    assert.equal(run({ existingBills: [{ ...bill, status: "cancelled" }] }).duplicate.status, "ok", "una factura anulada no cuenta");
    assert.equal(run({ existingBills: [{ ...bill, supplierTaxId: OTHER_NIF }] }).duplicate.status, "ok", "otro proveedor no cuenta");
  });

  it("proveedor + número exacto en Sage → fail con origen sage200", () => {
    const check = run({ sageReceived: [{ number: "F-2026-0042", total: "205.70", date: "2026-09-11", sourceId: "1:2026:F-2026-0042" }] }).duplicate;
    assert.equal(check.status, "fail");
    assert.equal(check.details?.source, "sage200");
    assert.equal(check.details?.sourceId, "1:2026:F-2026-0042");
    assert.equal(run({ sageReceived: [{ number: "F-2026-0042", total: "205.70", date: "2026-09-11", counterpartyNif: OTHER_NIF }] }).duplicate.status, "ok", "fila de otro NIF no cuenta");
  });

  it("fuzzy (dos de: número sin separadores, importe ± 0,01, fecha ± 3 días) → warn", () => {
    const sameNumberOtherFormat = run({ existingBills: [{ ...bill, invoiceNumber: "F/2026/0042", issueDate: "2026-01-01" }] }).duplicate;
    assert.equal(sameNumberOtherFormat.status, "warn");
    assert.equal(sameNumberOtherFormat.details?.kind, "fuzzy");
    assert.deepEqual(sameNumberOtherFormat.details?.signals, { number: true, total: true, date: false });
    const sage = run({ sageReceived: [{ number: "F-2026-0099", total: "205.71", date: `2026-09-${10 + DUPLICATE_DATE_WINDOW_DAYS}` }] }).duplicate;
    assert.equal(sage.status, "warn");
    assert.equal(sage.details?.source, "sage200");
    assert.deepEqual(sage.details?.signals, { number: false, total: true, date: true });
    assert.equal(run({ sageReceived: [{ number: "F-2026-0099", total: "205.70", date: "2026-09-14" }] }).duplicate.status, "ok", "solo el importe no basta");
    assert.equal(run({ sageReceived: [{ number: "F-2026-0099", total: "999.00", date: "2026-09-11" }] }).duplicate.status, "ok", "solo la fecha no basta");
  });

  it("albarán con el mismo número ya recibido → fail con origen goods_receipt", () => {
    const check = validateDocument({ kind: "delivery_note", fields: invoiceFields({ deliveryNoteNumber: "alb-2026/0042", total: null }), receipts: [receipt()] }).duplicate;
    assert.equal(check.status, "fail");
    assert.equal(check.details?.source, "goods_receipt");
    assert.equal(check.details?.goodsReceiptId, "gr_1");
  });
});

describe("retention", () => {
  const supplier = { id: "sup_1", name: "Asesoría Demo", taxId: NIF, retentionRate: "15.00" };

  it("ficha con 15 % y factura sin retención → warn; ambos 15 % → ok", () => {
    const missing = run({ supplier }).retention;
    assert.equal(missing.status, "warn");
    assert.equal(missing.details?.expectedRate, "15");
    assert.equal(missing.details?.extractedRate, null);
    const fields = invoiceFields({ lines: [{ description: "Honorarios", base: "1000.00", taxRate: 21 }], retentionRate: 15, total: "1060.00" });
    assert.equal(run({ supplier, fields }).retention.status, "ok");
  });

  it("factura con retención y ficha sin ella o sin proveedor → warn; tipos distintos → warn; ninguna → ok", () => {
    const fields = invoiceFields({ lines: [{ description: "Honorarios", base: "1000.00", taxRate: 21 }], retentionAmount: "70.00", total: "1140.00" });
    assert.equal(run({ fields }).retention.status, "warn");
    assert.equal(run({ fields }).retention.details?.extractedRate, "7");
    assert.equal(run({ supplier: { ...supplier, retentionRate: null }, fields }).retention.status, "warn");
    assert.equal(run({ supplier, fields }).retention.status, "warn");
    assert.equal(run().retention.status, "ok");
    assert.equal(validateDocument({ kind: "receipt", fields: invoiceFields() }).retention.details?.applicable, false);
  });
});

describe("match", () => {
  it("sin albaranes del proveedor → ok none; albaranes sin coincidencia → warn", () => {
    const none = run().match;
    assert.equal(none.status, "ok");
    assert.equal(none.details?.status, "none");
    const other = run({ receipts: [receipt({ lines: [{ id: "grl_7", description: "Cajas de vino", quantityReceived: "6.000", unitPrice: "12.0000" }] })] }).match;
    assert.equal(other.status, "warn");
    assert.equal(other.details?.status, "none");
    assert.equal(other.details?.candidateReceipts, 1);
  });

  it("full → ok con los cotejos; variance → fail; partial → warn", () => {
    const full = run({ receipts: [receipt()] }).match;
    assert.equal(full.status, "ok");
    assert.equal(full.details?.status, "full");
    assert.deepEqual(full.details?.receiptIds, ["gr_1"]);
    assert.equal((full.details?.matches as unknown[]).length, 2);
    const variance = run({ fields: invoiceFields({ lines: [{ description: "Lavado y planchado de sábanas (kg)", quantity: 120, unitPrice: "1.2875", taxRate: 21, deliveryNoteRef: "ALB-2026/0042" }], total: "186.94" }), receipts: [receipt()] }).match;
    assert.equal(variance.status, "fail");
    assert.equal(variance.details?.status, "variance");
    const partial = run({ fields: invoiceFields({ lines: [...invoiceFields().lines!, { description: "Portes", base: "9.00", taxRate: 21 }], total: "216.59" }), receipts: [receipt()] }).match;
    assert.equal(partial.status, "warn");
    assert.equal(partial.details?.status, "partial");
  });

  it("solo albaranes recibidos, del mismo NIF y del mismo centro; el texto de la factura aporta el número citado", () => {
    assert.equal(run({ receipts: [receipt({ status: "billed" })] }).match.details?.candidateReceipts, 0);
    assert.equal(run({ propertyId: "prop_demo", receipts: [receipt({ propertyId: "prop_other" })] }).match.details?.candidateReceipts, 0);
    assert.equal(run({ receipts: [receipt({ supplierTaxId: OTHER_NIF })] }).match.details?.candidateReceipts, 0);
    assert.equal(run({ supplier: { id: "sup_1", taxId: NIF }, receipts: [receipt({ supplierTaxId: null, supplierId: "sup_1" })] }).match.details?.status, "full");
    assert.deepEqual(quotedReferences("Según albarán ALB 2026/0042 del día 8", [receipt()]), ["ALB-2026/0042"]);
    const byText = run({ fields: invoiceFields({ text: "Ref. albarán ALB-2026/0042" }), receipts: [receipt()] }).match;
    assert.ok((byText.details?.matches as Array<{ matchedBy: string }>).every((m) => m.matchedBy === "reference"));
  });

  it("las tolerancias de la organización se leen de los ajustes (cadenas del DTO)", () => {
    const t = tolerancesOf({ priceTolerancePct: "5.00", quantityTolerance: "0.500", amountToleranceAbs: "2.00" });
    assert.equal(String(t.priceTolerancePct), "5");
    assert.equal(String(t.quantityTolerance), "0.5");
    assert.equal(String(t.amountToleranceAbs), "2");
    assert.equal(String(tolerancesOf(null).priceTolerancePct), "2.00");
  });
});

describe("helpers", () => {
  it("documentNumberOf prefiere documentNumber y acepta invoiceNumber; resolveLines deriva la base y el tipo único", () => {
    assert.equal(documentNumberOf({ documentNumber: " A-1 ", invoiceNumber: "B-2" }), "A-1");
    assert.equal(documentNumberOf({ invoiceNumber: "B-2" }), "B-2");
    assert.equal(documentNumberOf({}), null);
    const lines = resolveLines({ taxRate: 10, lines: [{ description: "Menú", quantity: 3, unitPrice: "12.50" }] });
    assert.equal(lines[0]?.base?.toFixed(2), "37.50");
    assert.equal(lines[0]?.rateCode, "10");
    assert.equal(extractedRetentionRate({ retentionAmount: "150.00" }, lines)?.toString(), "400");
    assert.equal(extractedRetentionRate({}, lines), null);
  });
});
