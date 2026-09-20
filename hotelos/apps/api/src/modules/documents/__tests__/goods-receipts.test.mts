// Unit tests · Tanda T9 · lote T9-09 — recepciones de mercancía (diseño §7.2).
// Sin base de datos: funciones puras del servicio (unicidad por número, artículo
// por nombre/sku, cuándo hay movimiento de stock, disputa, DTO, esquemas zod).
// Fixtures inventadas. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/goods-receipts.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "@prisma/client";
import {
  disputeTransition,
  findDuplicateReceipt,
  GOODS_RECEIPT_AUDIT_ACTIONS,
  GOODS_RECEIPT_MANAGE_PERMISSION,
  goodsReceiptDisputeSchema,
  goodsReceiptListQuerySchema,
  goodsReceiptSchema,
  normalizeDeliveryNoteNumber,
  noteWithDispute,
  noteWithSupplierName,
  receiptLineBase,
  resolveInventoryItem,
  stockMovementsFor,
  toGoodsReceiptDetail,
  toGoodsReceiptRecord,
  type InventoryItemLike
} from "../goods-receipts.service.js";

const D = (value: string | number) => new Prisma.Decimal(value);
const details = (error: unknown): { code?: string; lineNo?: number } => ((error as { details?: { code?: string } }).details ?? {}) as { code?: string; lineNo?: number };

describe("nº de albarán y unicidad (organización, proveedor, número)", () => {
  it("normaliza separadores y mayúsculas", () => {
    assert.equal(normalizeDeliveryNoteNumber("ALB-2026/0042"), "ALB20260042");
    assert.equal(normalizeDeliveryNoteNumber(" alb 2026 0042 "), "ALB20260042");
    assert.equal(normalizeDeliveryNoteNumber(""), "");
  });

  const existing = [
    { id: "gr_1", supplierId: "sup_a", supplierTaxId: "B12345674", deliveryNoteNumber: "ALB-2026/0042" },
    { id: "gr_2", supplierId: null, supplierTaxId: "X1234567L", deliveryNoteNumber: "A-77" },
    { id: "gr_3", supplierId: null, supplierTaxId: null, deliveryNoteNumber: "SIN-PROV-1" }
  ];

  it("mismo proveedor y mismo número escrito de otra forma → duplicado; otro proveedor → no", () => {
    assert.equal(findDuplicateReceipt(existing, { supplierId: "sup_a", supplierTaxId: null, deliveryNoteNumber: "alb 2026 0042" })?.id, "gr_1");
    assert.equal(findDuplicateReceipt(existing, { supplierId: "sup_b", supplierTaxId: "B12345674", deliveryNoteNumber: "ALB-2026/0042" }), null);
    assert.equal(findDuplicateReceipt(existing, { supplierId: "sup_a", supplierTaxId: null, deliveryNoteNumber: "ALB-2026/0043" }), null);
  });

  it("sin supplierId compara por NIF solo con filas sin proveedor enlazado; sin nada, con filas sin proveedor ni NIF", () => {
    assert.equal(findDuplicateReceipt(existing, { supplierId: null, supplierTaxId: "X1234567L", deliveryNoteNumber: "a77" })?.id, "gr_2");
    assert.equal(findDuplicateReceipt(existing, { supplierId: null, supplierTaxId: "B12345674", deliveryNoteNumber: "ALB-2026/0042" }), null, "la fila gr_1 tiene supplierId: no casa por NIF");
    assert.equal(findDuplicateReceipt(existing, { supplierId: null, supplierTaxId: null, deliveryNoteNumber: "sin prov 1" })?.id, "gr_3");
    assert.equal(findDuplicateReceipt(existing, { supplierId: null, supplierTaxId: null, deliveryNoteNumber: "A-77" }), null);
  });

  it("se excluye a sí misma (edición) y un número vacío nunca es duplicado", () => {
    assert.equal(findDuplicateReceipt(existing, { id: "gr_1", supplierId: "sup_a", supplierTaxId: null, deliveryNoteNumber: "ALB-2026/0042" }), null);
    assert.equal(findDuplicateReceipt(existing, { supplierId: "sup_a", supplierTaxId: null, deliveryNoteNumber: "---" }), null);
  });
});

describe("artículo de inventario por id, sku o nombre (nunca se inventa)", () => {
  const items: InventoryItemLike[] = [
    { id: "it_cafe", name: "Café molido 1 kg", sku: "CAF-001", active: true },
    { id: "it_leche", name: "Leche entera 1 L", sku: null, active: true },
    { id: "it_leche_old", name: "Leche entera 1 L", sku: null, active: false },
    { id: "it_toalla_a", name: "Toalla de baño", sku: "TOA-A", active: true },
    { id: "it_toalla_b", name: "Toalla de baño", sku: "TOA-B", active: true }
  ];

  it("id explícito existente → ese id; id desconocido → invalid", () => {
    assert.equal(resolveInventoryItem({ inventoryItemId: "it_leche_old", description: "otra cosa" }, items), "it_leche_old");
    assert.equal(resolveInventoryItem({ inventoryItemId: "it_nope", description: "Café molido 1 kg" }, items), "invalid");
  });

  it("por nombre normalizado (acentos, mayúsculas, puntuación) y por sku exacto", () => {
    assert.equal(resolveInventoryItem({ description: "CAFE MOLIDO, 1 KG" }, items), "it_cafe");
    assert.equal(resolveInventoryItem({ description: "caf-001" }, items), "it_cafe");
    assert.equal(resolveInventoryItem({ description: "Leche entera 1 L" }, items), "it_leche", "el inactivo no cuenta: coincidencia única con el activo");
  });

  it("ambigüedad, parecido parcial o descripción vacía → null", () => {
    assert.equal(resolveInventoryItem({ description: "Toalla de baño" }, items), null, "dos artículos activos con el mismo nombre");
    assert.equal(resolveInventoryItem({ description: "Café molido" }, items), null, "no hay coincidencia parcial");
    assert.equal(resolveInventoryItem({ description: "  " }, items), null);
    assert.equal(resolveInventoryItem({ description: "Café molido 1 kg" }, []), null);
  });
});

describe("movimiento de stock: solo con artículo y ubicación, en Decimal(12,2)", () => {
  const lines = [
    { lineNo: 1, inventoryItemId: "it_cafe", quantityReceived: D("12.345"), unitPrice: D("8.1234") },
    { lineNo: 2, inventoryItemId: null, quantityReceived: D("3.000"), unitPrice: D("1.0000") },
    { lineNo: 3, inventoryItemId: "it_leche", quantityReceived: "40", unitPrice: null }
  ];

  it("sin ubicación no hay movimiento", () => {
    assert.deepEqual(stockMovementsFor(lines, null), []);
    assert.deepEqual(stockMovementsFor(lines, undefined), []);
  });

  it("con ubicación: una por línea con artículo, cantidad y coste redondeados al céntimo", () => {
    assert.deepEqual(stockMovementsFor(lines, "loc_1"), [
      { lineNo: 1, inventoryItemId: "it_cafe", stockLocationId: "loc_1", quantity: 12.35, unitCost: 8.12 },
      { lineNo: 3, inventoryItemId: "it_leche", stockLocationId: "loc_1", quantity: 40, unitCost: null }
    ]);
  });

  it("una cantidad que redondea a 0,00 → 400 STOCK_QUANTITY_TOO_SMALL con la línea", () => {
    assert.throws(
      () => stockMovementsFor([{ lineNo: 4, inventoryItemId: "it_cafe", quantityReceived: "0.004" }], "loc_1"),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400 && details(error).code === "STOCK_QUANTITY_TOO_SMALL" && details(error).lineNo === 4
    );
  });
});

describe("disputa y notas", () => {
  it("received / matched → disputed; billed y disputed no cambian", () => {
    assert.deepEqual(disputeTransition("received"), { ok: true, next: "disputed" });
    assert.deepEqual(disputeTransition("matched"), { ok: true, next: "disputed" });
    const billed = disputeTransition("billed");
    assert.equal(billed.ok, false);
    if (!billed.ok) assert.match(billed.reason, /facturada/);
    const again = disputeTransition("disputed");
    assert.equal(again.ok, false);
    if (!again.ok) assert.match(again.reason, /ya está disputada/);
  });

  it("la nota conserva el texto previo y añade la disputa; el nombre libre del proveedor se guarda en la nota una sola vez", () => {
    assert.equal(noteWithDispute(null, "Faltan 2 cajas"), "Disputa: Faltan 2 cajas");
    assert.equal(noteWithDispute("Entrega parcial", " Faltan 2 cajas "), "Entrega parcial · Disputa: Faltan 2 cajas");
    assert.equal(noteWithSupplierName(undefined, "Distribuciones Ficticias SL"), "Proveedor: Distribuciones Ficticias SL");
    assert.equal(noteWithSupplierName("Puerta trasera", "Distribuciones Ficticias SL"), "Proveedor: Distribuciones Ficticias SL · Puerta trasera");
    assert.equal(noteWithSupplierName("Proveedor: Distribuciones Ficticias SL · x", "Distribuciones Ficticias SL"), "Proveedor: Distribuciones Ficticias SL · x");
    assert.equal(noteWithSupplierName("  ", null), null);
  });

  it("acciones de auditoría y clave de gestión fijadas", () => {
    assert.equal(GOODS_RECEIPT_AUDIT_ACTIONS.created, "GOODS_RECEIPT_CREATED");
    assert.equal(GOODS_RECEIPT_AUDIT_ACTIONS.disputed, "GOODS_RECEIPT_DISPUTED");
    assert.equal(GOODS_RECEIPT_MANAGE_PERMISSION, "procurement.manage");
  });
});

describe("DTO: base de línea, baseTotal, líneas ordenadas y facturas cotejadas", () => {
  const now = new Date("2026-09-19T10:00:00.000Z");
  const row = {
    id: "gr_1",
    organizationId: "org_x",
    propertyId: "prop_x",
    supplierId: "sup_a",
    supplierTaxId: "B12345674",
    deliveryNoteNumber: "ALB-1",
    deliveryDate: new Date("2026-09-18T00:00:00.000Z"),
    purchaseOrderId: null,
    status: "received" as const,
    receivedBy: "usr_1",
    incomingDocumentId: "doc_1",
    note: null,
    createdAt: now,
    updatedAt: now,
    lines: [
      { id: "l2", goodsReceiptId: "gr_1", lineNo: 2, description: "B", inventoryItemId: null, purchaseOrderLineId: null, quantityOrdered: null, quantityReceived: D("2.5"), unit: "kg", unitPrice: D("4"), base: null, taxRate: D("10"), stockMovementId: null },
      { id: "l1", goodsReceiptId: "gr_1", lineNo: 1, description: "A", inventoryItemId: "it_1", purchaseOrderLineId: null, quantityOrdered: D("3"), quantityReceived: D("3"), unit: null, unitPrice: D("1.2345"), base: D("3.70"), taxRate: null, stockMovementId: "sm_1" },
      { id: "l3", goodsReceiptId: "gr_1", lineNo: 3, description: "C sin importe", inventoryItemId: null, purchaseOrderLineId: null, quantityOrdered: null, quantityReceived: D("1"), unit: null, unitPrice: null, base: null, taxRate: null, stockMovementId: null }
    ]
  };

  it("receiptLineBase: la base dada manda; si no, cantidad × precio a 2 decimales; sin nada, null", () => {
    assert.equal(receiptLineBase({ base: D("3.70"), quantityReceived: D("3"), unitPrice: D("1.2345") })?.toFixed(2), "3.70");
    assert.equal(receiptLineBase({ quantityReceived: D("2.5"), unitPrice: D("4") })?.toFixed(2), "10.00");
    assert.equal(receiptLineBase({ quantityReceived: D("1") }), null);
  });

  it("registro y detalle con la forma del contrato compartido", () => {
    const record = toGoodsReceiptRecord(row, { supplierName: "Distribuciones Ficticias SL", registryNumber: "DOC-L2A-2026-000007" });
    assert.equal(record.deliveryDate, "2026-09-18");
    assert.equal(record.lineCount, 3);
    assert.equal(record.baseTotal, "13.70");
    assert.equal(record.supplierName, "Distribuciones Ficticias SL");
    assert.equal(record.registryNumber, "DOC-L2A-2026-000007");
    const matches = [
      { id: "m1", supplierBillLineId: "bl_1", goodsReceiptLineId: "l1", purchaseOrderLineId: null, matchedQuantity: D("3.000"), matchedBase: D("3.70"), quantityVariance: D("0"), priceVariance: D("-0.0045"), status: "auto", matchedBy: "usr_1", createdAt: now, supplierBillLine: { supplierBillId: "bill_9" } },
      { id: "m2", supplierBillLineId: "bl_7", goodsReceiptLineId: "l2", purchaseOrderLineId: null, matchedQuantity: null, matchedBase: null, quantityVariance: null, priceVariance: null, status: "confirmed", matchedBy: null, createdAt: now, supplierBillLine: { supplierBillId: "bill_9" } }
    ];
    const detail = toGoodsReceiptDetail(row, { supplierName: null, registryNumber: null }, matches);
    assert.deepEqual(detail.lines.map((line) => line.lineNo), [1, 2, 3]);
    assert.equal(detail.lines[0]!.quantityReceived, "3.000");
    assert.equal(detail.lines[0]!.unitPrice, "1.2345");
    assert.equal(detail.lines[0]!.base, "3.70");
    assert.equal(detail.lines[1]!.taxRate, "10.00");
    assert.equal(detail.lines[1]!.base, null);
    assert.deepEqual(detail.supplierBillIds, ["bill_9"]);
    assert.equal(detail.matches.length, 2);
    assert.equal(detail.matches[0]!.priceVariance, "-0.0045");
    assert.equal(detail.matches[0]!.matchedQuantity, "3.000");
    assert.equal(detail.matches[1]!.status, "confirmed");
  });
});

describe("esquemas zod (strict)", () => {
  const valid = {
    supplierId: "sup_a",
    deliveryNoteNumber: "ALB-2026/0042",
    deliveryDate: "2026-09-18",
    stockLocationId: "loc_1",
    lines: [{ description: "Café molido 1 kg", quantityReceived: "12.345", unitPrice: 8.1234, taxRate: 10, inventoryItemId: "it_cafe" }]
  };

  it("acepta números o cadenas decimales y devuelve Decimal / Date", () => {
    const parsed = goodsReceiptSchema.parse(valid);
    assert.equal(parsed.deliveryDate.toISOString(), "2026-09-18T00:00:00.000Z");
    assert.equal(parsed.lines[0]!.quantityReceived.toFixed(3), "12.345");
    assert.equal(parsed.lines[0]!.unitPrice?.toFixed(4), "8.1234");
    assert.equal(parsed.lines[0]!.taxRate?.toFixed(2), "10.00");
  });

  it("rechaza cantidad cero o con 4 decimales, precio negativo, fecha inexistente, sin líneas y claves desconocidas", () => {
    const bad = (patch: Record<string, unknown>) => goodsReceiptSchema.safeParse({ ...valid, ...patch }).success;
    assert.equal(bad({ lines: [{ description: "x", quantityReceived: 0 }] }), false);
    assert.equal(bad({ lines: [{ description: "x", quantityReceived: "1.0001" }] }), false);
    assert.equal(bad({ lines: [{ description: "x", quantityReceived: 1, unitPrice: -1 }] }), false);
    assert.equal(bad({ deliveryDate: "2026-02-30" }), false);
    assert.equal(bad({ lines: [] }), false);
    assert.equal(bad({ extra: true }), false);
    assert.equal(bad({ lines: [{ description: "x", quantityReceived: 1, foo: 1 }] }), false);
  });

  it("disputa: reason de 3 a 300 caracteres; lista: solo los filtros del contrato", () => {
    assert.equal(goodsReceiptDisputeSchema.safeParse({ reason: "ok" }).success, false);
    assert.equal(goodsReceiptDisputeSchema.safeParse({ reason: "Faltan 2 cajas" }).success, true);
    assert.equal(goodsReceiptListQuerySchema.safeParse({ status: "received", from: "2026-09-01", limit: "10", envelope: "1" }).success, true);
    assert.equal(goodsReceiptListQuerySchema.safeParse({ status: "open" }).success, false);
    assert.equal(goodsReceiptListQuerySchema.safeParse({ foo: "1" }).success, false);
  });
});
