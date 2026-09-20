// Unit tests · Tanda T9 · lote T9-09 — cotejo factura–albarán persistido
// (diseño §7.2). Persistencia SIMULADA en memoria (BillMatchingStore): el plan
// puro y el servicio con un almacén falso; la implementación Prisma la cubre
// tests/integration/goods-receipts.test.mts. Fixtures inventadas. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/bill-matching.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import type { UserContext } from "../../../lib/demo-store.js";
import { DEFAULT_MATCH_TOLERANCES } from "../matching.js";
import {
  BILL_MATCH_AUDIT_ACTION,
  createBillMatchingService,
  planBillMatch,
  supplierBillMatchSchema,
  type BillForMatching,
  type BillMatchingStore,
  type ExistingMatch,
  type MatchPlan,
  type PersistedMatchRow,
  type ReceiptForMatching
} from "../bill-matching.service.js";

const D = (value: string | number | null) => (value === null ? null : new Prisma.Decimal(value));
const details = (error: unknown): { code?: string } => ((error as { details?: { code?: string } }).details ?? {}) as { code?: string };
const statusOf = (error: unknown): number | undefined => (error as { statusCode?: number }).statusCode;

const bill = (over: Partial<BillForMatching> = {}): BillForMatching => ({
  id: "bill_1",
  organizationId: "org_x",
  propertyId: "prop_a",
  supplierId: "sup_a",
  supplierTaxId: "B12345674",
  status: "draft",
  matchStatus: "none",
  lines: [
    { id: "bl_1", lineNo: 1, description: "Lavado y planchado de sabanas KG", quantity: "120.000", unitPrice: "1.2500", base: "150.00", deliveryNoteRef: null },
    { id: "bl_2", lineNo: 2, description: "Toallas de baño", quantity: "40.000", unitPrice: "0.5000", base: "20.00", deliveryNoteRef: null }
  ],
  ...over
});

const receipt = (over: Partial<ReceiptForMatching> = {}): ReceiptForMatching => ({
  id: "gr_1",
  propertyId: "prop_a",
  supplierId: "sup_a",
  supplierTaxId: "B12345674",
  deliveryNoteNumber: "ALB-2026/0042",
  deliveryDate: "2026-09-08",
  status: "received",
  lines: [
    { id: "grl_1", lineNo: 1, description: "Lavado y planchado de sábanas (kg)", quantityReceived: "120.000", unitPrice: "1.2500", base: null },
    { id: "grl_2", lineNo: 2, description: "Toallas de baño (unidad)", quantityReceived: "40.000", unitPrice: "0.5000", base: null }
  ],
  ...over
});

const plan = (input: { bill?: BillForMatching; receipts?: ReceiptForMatching[]; existing?: ExistingMatch[] } = {}): MatchPlan =>
  planBillMatch({ bill: input.bill ?? bill(), receipts: input.receipts ?? [receipt()], existing: input.existing ?? [], tolerances: DEFAULT_MATCH_TOLERANCES, matchedBy: "usr_1" });

describe("planBillMatch · full / variance / partial", () => {
  it("todas las líneas casan dentro de tolerancia → full, dos upserts y la recepción pasa a billed", () => {
    const p = plan();
    assert.equal(p.matchStatus, "full");
    assert.equal(p.upserts.length, 2);
    assert.deepEqual(p.upserts.map((u) => [u.supplierBillLineId, u.goodsReceiptLineId, u.withinTolerance]), [["bl_1", "grl_1", true], ["bl_2", "grl_2", true]]);
    assert.equal(p.upserts[0]!.priceVariance, "0.0000");
    assert.equal(p.upserts[0]!.matchedBase, "150.00");
    assert.deepEqual(p.deleteMatchIds, []);
    assert.deepEqual(p.receiptStatus, [{ goodsReceiptId: "gr_1", status: "billed" }]);
    assert.deepEqual(p.unmatchedBillLines, []);
  });

  it("precio +3 % en una línea → variance; la recepción NO cambia de estado", () => {
    const b = bill();
    b.lines[0] = { ...b.lines[0]!, unitPrice: "1.2875", base: "154.50" };
    const p = plan({ bill: b });
    assert.equal(p.matchStatus, "variance");
    assert.equal(p.upserts.length, 2);
    assert.equal(p.upserts[0]!.withinTolerance, false);
    assert.equal(p.upserts[0]!.priceVariance, "0.0375");
    assert.equal(p.upserts[1]!.withinTolerance, true);
    assert.deepEqual(p.receiptStatus, [{ goodsReceiptId: "gr_1", status: "matched" }], "una recepción con una varianza y una línea correcta queda matched, nunca billed");
  });

  it("varianza en todas las líneas: la recepción sigue received (ni matched ni billed)", () => {
    const b = bill();
    b.lines = b.lines.map((line) => ({ ...line, quantity: line.quantity === "120.000" ? "125.000" : "45.000" }));
    const p = plan({ bill: b });
    assert.equal(p.matchStatus, "variance");
    assert.deepEqual(p.receiptStatus, []);
  });

  it("la factura tiene una línea sin albarán → partial; la recepción con todas sus líneas cubiertas → billed", () => {
    const b = bill();
    b.lines.push({ id: "bl_3", lineNo: 3, description: "Portes", quantity: "1.000", unitPrice: "12.0000", base: "12.00", deliveryNoteRef: null });
    const p = plan({ bill: b });
    assert.equal(p.matchStatus, "partial");
    assert.deepEqual(p.unmatchedBillLines, [3]);
    assert.deepEqual(p.receiptStatus, [{ goodsReceiptId: "gr_1", status: "billed" }]);
  });

  it("recepción con una línea de más → matched (no billed) y la factura full", () => {
    const r = receipt();
    r.lines.push({ id: "grl_3", lineNo: 3, description: "Albornoces", quantityReceived: "5.000", unitPrice: "9.0000", base: null });
    const p = plan({ receipts: [r] });
    assert.equal(p.matchStatus, "full");
    assert.deepEqual(p.receiptStatus, [{ goodsReceiptId: "gr_1", status: "matched" }]);
  });

  it("sin recepciones → none, sin escrituras", () => {
    const p = plan({ receipts: [] });
    assert.equal(p.matchStatus, "none");
    assert.deepEqual(p.upserts, []);
    assert.deepEqual(p.receiptStatus, []);
    assert.deepEqual(p.unmatchedBillLines, [1, 2]);
  });
});

describe("planBillMatch · decisiones humanas y otras facturas", () => {
  it("una línea confirmada no se vuelve a cotejar y cuenta para full y para billed", () => {
    const existing: ExistingMatch[] = [{ id: "m_c", supplierBillId: "bill_1", supplierBillLineId: "bl_1", goodsReceiptLineId: "grl_1", status: "confirmed" }];
    const p = plan({ existing });
    assert.deepEqual(p.upserts.map((u) => u.supplierBillLineId), ["bl_2"]);
    assert.equal(p.matchStatus, "full");
    assert.deepEqual(p.receiptStatus, [{ goodsReceiptId: "gr_1", status: "billed" }]);
    assert.deepEqual(p.deleteMatchIds, []);
  });

  it("un par rechazado no se vuelve a proponer → esa línea queda sin cotejo (partial)", () => {
    const existing: ExistingMatch[] = [{ id: "m_r", supplierBillId: "bill_1", supplierBillLineId: "bl_1", goodsReceiptLineId: "grl_1", status: "rejected" }];
    const p = plan({ existing });
    assert.deepEqual(p.upserts.map((u) => u.supplierBillLineId), ["bl_2"]);
    assert.equal(p.matchStatus, "partial");
    assert.deepEqual(p.unmatchedBillLines, [1]);
    assert.deepEqual(p.receiptStatus, [{ goodsReceiptId: "gr_1", status: "matched" }]);
  });

  it("las líneas de albarán ya cotejadas con OTRA factura no entran en el pool pero cuentan como cubiertas", () => {
    const existing: ExistingMatch[] = [{ id: "m_o", supplierBillId: "bill_other", supplierBillLineId: "blx_1", goodsReceiptLineId: "grl_1", status: "auto" }];
    const p = plan({ existing });
    assert.deepEqual(p.upserts.map((u) => [u.supplierBillLineId, u.goodsReceiptLineId]), [["bl_2", "grl_2"]]);
    assert.equal(p.matchStatus, "partial");
    assert.deepEqual(p.receiptStatus, [{ goodsReceiptId: "gr_1", status: "billed" }]);
  });

  it("los `auto` de esta factura que ya no salen se borran (re-cotejo tras editar)", () => {
    const existing: ExistingMatch[] = [
      { id: "m_old", supplierBillId: "bill_1", supplierBillLineId: "bl_1", goodsReceiptLineId: "grl_2", status: "auto" },
      { id: "m_keep", supplierBillId: "bill_1", supplierBillLineId: "bl_2", goodsReceiptLineId: "grl_2", status: "auto" }
    ];
    const p = plan({ existing });
    assert.deepEqual(p.deleteMatchIds, ["m_old"]);
    assert.equal(p.upserts.length, 2);
  });

  it("es idempotente: con los upserts de la primera pasada como existentes, la segunda no borra nada y propone lo mismo", () => {
    const first = plan();
    const existing: ExistingMatch[] = first.upserts.map((u, index) => ({ id: `m_${index}`, supplierBillId: "bill_1", supplierBillLineId: u.supplierBillLineId, goodsReceiptLineId: u.goodsReceiptLineId, status: "auto" }));
    const second = plan({ existing, receipts: [receipt({ status: "billed" })] });
    assert.deepEqual(second.upserts, first.upserts);
    assert.deepEqual(second.deleteMatchIds, []);
    assert.equal(second.matchStatus, "full");
    assert.deepEqual(second.receiptStatus, [], "la recepción ya está billed: no se toca");
  });
});

// ---------------------------------------------------------------------------
// Servicio con almacén simulado
// ---------------------------------------------------------------------------

type Row = PersistedMatchRow;

function fakeStore(seed: { bills: BillForMatching[]; receipts: ReceiptForMatching[]; rows?: Row[] }) {
  const rows: Row[] = seed.rows ?? [];
  let seq = 0;
  const billOfLine = (lineId: string): string | null => seed.bills.find((b) => b.lines.some((l) => l.id === lineId))?.id ?? null;
  const calls: string[] = [];
  const store: BillMatchingStore = {
    async loadBill(propertyId, billId) {
      calls.push(`loadBill:${billId}`);
      return seed.bills.find((b) => b.id === billId && b.propertyId === propertyId) ?? null;
    },
    async loadTolerances() {
      calls.push("loadTolerances");
      return DEFAULT_MATCH_TOLERANCES;
    },
    async loadReceiptsByIds(_org, propertyId, ids) {
      calls.push(`byIds:${ids.join(",")}`);
      return seed.receipts.filter((r) => r.propertyId === propertyId && ids.includes(r.id));
    },
    async loadOpenReceiptsOfSupplier({ propertyId, supplierId, supplierTaxId }) {
      calls.push("open");
      return seed.receipts.filter((r) => r.propertyId === propertyId && (r.status === "received" || r.status === "matched") && ((supplierId && r.supplierId === supplierId) || (supplierTaxId && r.supplierTaxId === supplierTaxId)));
    },
    async loadMatches({ billLineIds, receiptLineIds }) {
      return rows
        .filter((r) => billLineIds.includes(r.supplierBillLineId) || receiptLineIds.includes(r.goodsReceiptLineId))
        .map((r) => ({ id: r.id, supplierBillId: billOfLine(r.supplierBillLineId) ?? "?", supplierBillLineId: r.supplierBillLineId, goodsReceiptLineId: r.goodsReceiptLineId, status: r.status }));
    },
    async persist(plan) {
      calls.push(`persist:${plan.matchStatus}`);
      for (const id of plan.deleteMatchIds) {
        const index = rows.findIndex((r) => r.id === id && r.status === "auto");
        if (index >= 0) rows.splice(index, 1);
      }
      for (const u of plan.upserts) {
        const existing = rows.find((r) => r.supplierBillLineId === u.supplierBillLineId && r.goodsReceiptLineId === u.goodsReceiptLineId);
        const values = { matchedQuantity: D(u.matchedQuantity), matchedBase: D(u.matchedBase), quantityVariance: D(u.quantityVariance), priceVariance: D(u.priceVariance), status: "auto", matchedBy: u.matchedBy };
        if (existing) Object.assign(existing, values);
        else rows.push({ id: `m_${++seq}`, supplierBillLineId: u.supplierBillLineId, goodsReceiptLineId: u.goodsReceiptLineId, purchaseOrderLineId: null, createdAt: new Date("2026-09-19T10:00:00.000Z"), ...values });
      }
      const b = seed.bills.find((x) => x.id === plan.billId);
      if (b) b.matchStatus = plan.matchStatus;
      for (const change of plan.receiptStatus) {
        const r = seed.receipts.find((x) => x.id === change.goodsReceiptId);
        if (r) r.status = change.status;
      }
      const lineIds = new Set(b?.lines.map((l) => l.id) ?? []);
      return rows.filter((r) => lineIds.has(r.supplierBillLineId));
    }
  };
  return { store, rows, calls, seed };
}

const context = (permissions: string[] = ["procurement.manage"]): UserContext =>
  ({ organizationId: "org_x", propertyId: "prop_a", userId: "usr_1", fullName: "Compras L2", deviceId: "dev_1", permissions } as UserContext);

describe("matchSupplierBill · servicio con almacén simulado", () => {
  it("auto: cotejo full → filas auto persistidas, factura full, recepción billed, auditoría BILL_MATCHED", async () => {
    const fake = fakeStore({ bills: [bill()], receipts: [receipt()] });
    const audits: Array<Record<string, unknown>> = [];
    const service = createBillMatchingService({ store: fake.store, audit: ((input: Record<string, unknown>) => (audits.push(input), { id: "aud_1" })) as never });
    const response = await service.matchSupplierBill({ context: context(), propertyId: "prop_a", billId: "bill_1", body: {}, correlationId: "corr_1" });
    assert.equal(response.supplierBillId, "bill_1");
    assert.equal(response.matchStatus, "full");
    assert.equal(response.matches.length, 2);
    assert.equal(response.matches[0]!.status, "auto");
    assert.equal(response.matches[0]!.matchedQuantity, "120.000");
    assert.equal(response.matches[0]!.matchedBase, "150.00");
    assert.equal(response.matches[0]!.priceVariance, "0.0000");
    assert.equal(response.matches[0]!.matchedBy, "usr_1");
    assert.equal(fake.seed.bills[0]!.matchStatus, "full");
    assert.equal(fake.seed.receipts[0]!.status, "billed");
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.action, BILL_MATCH_AUDIT_ACTION);
    assert.equal(audits[0]!.entityType, "supplier_bill");
    assert.equal(audits[0]!.entityId, "bill_1");
    assert.deepEqual(audits[0]!.beforeJson, { matchStatus: "none" });
    assert.equal((audits[0]!.afterJson as { matchStatus: string }).matchStatus, "full");
    assert.ok(fake.calls.includes("open"), "sin goodsReceiptIds busca las recepciones abiertas del proveedor");
  });

  it("es idempotente: una segunda ejecución devuelve los mismos ids y no crea ni borra filas", async () => {
    const fake = fakeStore({ bills: [bill()], receipts: [receipt()] });
    const service = createBillMatchingService({ store: fake.store, audit: (() => ({ id: "aud" })) as never });
    const first = await service.matchSupplierBill({ context: context(), propertyId: "prop_a", billId: "bill_1", body: { auto: true } });
    const second = await service.matchSupplierBill({ context: context(), propertyId: "prop_a", billId: "bill_1", body: { goodsReceiptIds: ["gr_1"] } });
    assert.deepEqual(second.matches.map((m) => m.id), first.matches.map((m) => m.id));
    assert.equal(fake.rows.length, 2);
    assert.equal(second.matchStatus, "full");
  });

  it("variance: las varianzas llegan con signo (factura − albarán); solo con varianzas la recepción sigue received", async () => {
    const b = bill();
    b.lines = b.lines.map((line, index) => (index === 0 ? { ...line, unitPrice: "1.2875", base: "154.50" } : { ...line, quantity: "45.000", base: "22.50" }));
    const fake = fakeStore({ bills: [b], receipts: [receipt()] });
    const service = createBillMatchingService({ store: fake.store, audit: (() => ({ id: "aud" })) as never });
    const response = await service.matchSupplierBill({ context: context(), propertyId: "prop_a", billId: "bill_1", body: {} });
    assert.equal(response.matchStatus, "variance");
    assert.equal(response.matches.find((m) => m.supplierBillLineId === "bl_1")?.priceVariance, "0.0375");
    assert.equal(response.matches.find((m) => m.supplierBillLineId === "bl_2")?.quantityVariance, "5.000");
    assert.equal(fake.seed.receipts[0]!.status, "received");
    assert.equal(fake.seed.bills[0]!.matchStatus, "variance");
  });

  it("por id se admite una recepción billed (re-cotejo idempotente) pero no una disputada", async () => {
    const fake = fakeStore({ bills: [bill()], receipts: [receipt({ status: "billed" })] });
    const service = createBillMatchingService({ store: fake.store, audit: (() => ({ id: "aud" })) as never });
    const auto = await service.matchSupplierBill({ context: context(), propertyId: "prop_a", billId: "bill_1", body: { auto: true } });
    assert.equal(auto.matchStatus, "none", "en auto solo entran received | matched");
    const byId = await service.matchSupplierBill({ context: context(), propertyId: "prop_a", billId: "bill_1", body: { goodsReceiptIds: ["gr_1"] } });
    assert.equal(byId.matchStatus, "full");
    assert.equal(fake.seed.receipts[0]!.status, "billed");
  });

  it("errores tipados: 403 sin procurement.manage, 400 sin ids y auto:false, 404 factura, 404 recepción, 409 recepción disputada, 409 factura anulada", async () => {
    const fake = fakeStore({ bills: [bill(), bill({ id: "bill_c", status: "cancelled" })], receipts: [receipt(), receipt({ id: "gr_d", status: "disputed", deliveryNoteNumber: "ALB-9" })] });
    const service = createBillMatchingService({ store: fake.store, audit: (() => ({ id: "aud" })) as never });
    await assert.rejects(service.matchSupplierBill({ context: context(["payables.read"]), propertyId: "prop_a", billId: "bill_1", body: {} }), (error: unknown) => statusOf(error) === 403);
    await assert.rejects(service.matchSupplierBill({ context: context(), propertyId: "prop_a", billId: "bill_1", body: { auto: false } }), (error: unknown) => statusOf(error) === 400 && details(error).code === "VALIDATION_ERROR");
    await assert.rejects(service.matchSupplierBill({ context: context(), propertyId: "prop_a", billId: "bill_1", body: { goodsReceiptIds: [] } }), (error: unknown) => statusOf(error) === 400);
    await assert.rejects(service.matchSupplierBill({ context: context(), propertyId: "prop_a", billId: "bill_x", body: {} }), (error: unknown) => statusOf(error) === 404);
    await assert.rejects(service.matchSupplierBill({ context: context(), propertyId: "prop_b", billId: "bill_1", body: {} }), (error: unknown) => statusOf(error) === 404, "otro centro: 404 opaco");
    await assert.rejects(service.matchSupplierBill({ context: context(), propertyId: "prop_a", billId: "bill_1", body: { goodsReceiptIds: ["gr_1", "gr_missing"] } }), (error: unknown) => statusOf(error) === 404);
    await assert.rejects(service.matchSupplierBill({ context: context(), propertyId: "prop_a", billId: "bill_1", body: { goodsReceiptIds: ["gr_d"] } }), (error: unknown) => statusOf(error) === 409 && details(error).code === "INVALID_STATUS_TRANSITION");
    await assert.rejects(service.matchSupplierBill({ context: context(), propertyId: "prop_a", billId: "bill_c", body: {} }), (error: unknown) => statusOf(error) === 409 && details(error).code === "INVALID_STATUS_TRANSITION");
    assert.equal(fake.rows.length, 0, "ningún error escribió filas");
  });

  it("factura sin proveedor ni NIF: 400 SUPPLIER_REQUIRED en auto; con goodsReceiptIds explícitos sí coteja", async () => {
    const fake = fakeStore({ bills: [bill({ supplierId: null, supplierTaxId: null })], receipts: [receipt()] });
    const service = createBillMatchingService({ store: fake.store, audit: (() => ({ id: "aud" })) as never });
    await assert.rejects(service.matchSupplierBill({ context: context(), propertyId: "prop_a", billId: "bill_1", body: {} }), (error: unknown) => statusOf(error) === 400 && details(error).code === "SUPPLIER_REQUIRED");
    const response = await service.matchSupplierBill({ context: context(), propertyId: "prop_a", billId: "bill_1", body: { goodsReceiptIds: ["gr_1"] } });
    assert.equal(response.matchStatus, "full");
  });

  it("esquema del cuerpo: strict, ids únicos de 1 a 50, auto booleano", () => {
    assert.equal(supplierBillMatchSchema.safeParse({}).success, true);
    assert.equal(supplierBillMatchSchema.safeParse({ auto: "yes" }).success, false);
    assert.equal(supplierBillMatchSchema.safeParse({ goodsReceiptIds: [] }).success, false);
    assert.equal(supplierBillMatchSchema.safeParse({ goodsReceiptIds: ["gr_1"], extra: 1 }).success, false);
  });
});
