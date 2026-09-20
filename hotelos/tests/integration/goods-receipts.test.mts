/**
 * Tanda T9 · lote T9-09 · integración (Postgres): recepciones de mercancía con
 * movimiento de stock transaccional y cotejo factura–albarán a 2 vías sobre un
 * tenant AISLADO (helpers/l2-tenant.mts, organización `org_l2_t9gr…`), auth real
 * y RBAC_STRICT; Faranda y org_123 solo se leen (invariantes antes y después).
 *
 * Cubre: POST goods-receipt con 2 líneas y ubicación → 201 + 2 StockMovement
 * `receipt` (sourceType goods_receipt) en la MISMA transacción (rollback
 * demostrado con createGoodsReceiptInTx dentro de una transacción abortada);
 * duplicado → 409 GOODS_RECEIPT_DUPLICATE (también con el número escrito de otra
 * forma); factura de proveedor con líneas iguales → match full y recepción billed;
 * precio +3 % → variance sin tocar la recepción; cotejo idempotente; GET lista
 * (array, sobre, cursor, filtros) y detalle; dispute; 403 para recepción;
 * 404 opaco desde otro tenant; auditoría GOODS_RECEIPT_CREATED / BILL_MATCHED.
 *
 * Fixtures inventadas; ningún nombre real.
 *
 * Run: cd apps/api && node --env-file-if-exists=../../.env --import tsx --test ../../tests/integration/goods-receipts.test.mts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const tenantHelpers = await import("./helpers/l2-tenant.mts");
const { createIsolatedTenant, enableModules, cleanupTenant, loginOrThrow, newRunId, STRICT_ENV, withEnv, farandaInvariants, cifFor } = tenantHelpers;
type IsolatedTenant = Awaited<ReturnType<typeof createIsolatedTenant>>;
type Session = Awaited<ReturnType<typeof loginOrThrow>>;

const { prisma, hashPassword } = await import("@hotelos/database");
const { buildApiServer } = await import("../../apps/api/src/server.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { resetRbacScopeCacheForTests } = await import("../../apps/api/src/lib/rbac-scope.js");
const { createGoodsReceiptInTx } = await import("../../apps/api/src/modules/documents/goods-receipts.service.js");

type ApiApp = Awaited<ReturnType<typeof buildApiServer>>;
type Json = Record<string, any>;
type Reply = { status: number; body: Json; headers: Record<string, string | string[] | undefined> };

const strict = <T>(run: () => Promise<T>): Promise<T> => withEnv(STRICT_ENV, run);

async function call(app: ApiApp, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, session: Session, payload?: unknown): Promise<Reply> {
  const res = await strict(() => app.inject({ method, url, headers: { ...session.headers }, ...(payload === undefined ? {} : { payload }) }));
  let body: Json = {};
  try {
    body = res.body ? (JSON.parse(res.body) as Json) : {};
  } catch {
    body = { raw: res.body };
  }
  return { status: res.statusCode, body, headers: res.headers as Record<string, string | string[] | undefined> };
}

const codeOf = (reply: Reply): string | undefined => (reply.body.details as { code?: string } | undefined)?.code;

/** Usuario extra con una plantilla en los centros dados (barrido por cleanupTenant; patrón documents-upload.test.mts). */
async function addUser(tenant: IsolatedTenant, key: string, templateKey: string, propertyIds: string[]): Promise<{ id: string; email: string }> {
  const id = `usr_t9gr_${key}_${tenant.run}`;
  const email = `${key}.t9gr.${tenant.run}@faranda.test`;
  await prisma.user.create({
    data: { id, organizationId: tenant.organizationId, email, fullName: `T9 ${key} ${tenant.run}`, status: "active", passwordHash: hashPassword(tenant.password), mustChangePassword: false, passwordChangedAt: new Date() }
  });
  const roleId = tenant.roles[templateKey];
  if (!roleId) throw new Error(`Sin rol de plantilla «${templateKey}» en ${tenant.organizationId}.`);
  for (const propertyId of propertyIds) {
    await prisma.userRoleAssignment.create({ data: { userId: id, roleId, scopeType: "property", propertyId, organizationId: tenant.organizationId, reason: `t9gr ${key}` } });
  }
  resetRbacScopeCacheForTests();
  return { id, email };
}

const RUN_A = `t9gr${newRunId()}`;
const RUN_B = `${RUN_A}b`;

let app: ApiApp;
let tenantA: IsolatedTenant;
let tenantB: IsolatedTenant;
let clerkA: Session;
let accountantA: Session;
let receptionistA: Session;
let ownerB: Session;
let baseline: Awaited<ReturnType<typeof farandaInvariants>>;

let supplierId: string;
let supplierTaxId: string;
let locationId: string;
let itemSabanas: string;
let itemToallas: string;
let itemCafe: string;

let receipt1: Json;
let receipt2: Json;
let bill1: Json;
let bill2: Json;

const RECEIPT_1_LINES = [
  { description: "Lavado y planchado de sábanas (kg)", quantityReceived: "120.000", unit: "kg", unitPrice: "1.2500", taxRate: 21 },
  { description: "Toallas de baño", quantityReceived: 40, unit: "ud", unitPrice: 0.5, taxRate: 21 }
];

before(async () => {
  app = await buildApiServer();
  await app.ready();
  baseline = await farandaInvariants();
  tenantA = await createIsolatedTenant(RUN_A);
  tenantB = await createIsolatedTenant(RUN_B);
  await enableModules(tenantA.propertyA, ["erp_accounting", "procurement_inventory"]);
  const clerk = await addUser(tenantA, "clerk", "admin_clerk", [tenantA.propertyA]);
  clerkA = await strict(() => loginOrThrow(app, clerk.email, tenantA.password));
  accountantA = await strict(() => loginOrThrow(app, tenantA.users.accountant.email, tenantA.password));
  receptionistA = await strict(() => loginOrThrow(app, tenantA.users.receptionist.email, tenantA.password));
  ownerB = await strict(() => loginOrThrow(app, tenantB.users.owner.email, tenantB.password));

  supplierTaxId = cifFor("B", 4242);
  const supplier = await prisma.supplier.create({ data: { organizationId: tenantA.organizationId, name: `Lavandería Ficticia ${RUN_A} SL`, taxId: supplierTaxId, countryCode: "ES" } });
  supplierId = supplier.id;
  const location = await prisma.stockLocation.create({ data: { propertyId: tenantA.propertyA, name: `Economato ${RUN_A}`, locationType: "store" } });
  locationId = location.id;
  itemSabanas = (await prisma.inventoryItem.create({ data: { propertyId: tenantA.propertyA, sku: `SAB-${RUN_A}`, name: "Lavado y planchado de sábanas (kg)", unit: "kg", unitCost: "1.25" } })).id;
  itemToallas = (await prisma.inventoryItem.create({ data: { propertyId: tenantA.propertyA, name: "Toallas de baño", unit: "ud", unitCost: "0.5" } })).id;
  itemCafe = (await prisma.inventoryItem.create({ data: { propertyId: tenantA.propertyA, name: "Café molido 1 kg", unit: "kg", unitCost: "8" } })).id;
});

after(async () => {
  try {
    if (tenantA) await cleanupTenant(tenantA.organizationId);
    if (tenantB) await cleanupTenant(tenantB.organizationId);
    assert.equal(await prisma.organization.count({ where: { id: { in: [tenantA?.organizationId ?? "", tenantB?.organizationId ?? ""] } } }), 0, "sin organizaciones residuales");
    if (baseline) assert.deepEqual(await farandaInvariants(), baseline, "Faranda intacta");
  } finally {
    await app?.close();
  }
});

describe("T9-09 · alta de recepción con movimiento de stock", () => {
  it("POST 201 con 2 líneas y ubicación: artículos resueltos (id explícito y por nombre) y 2 StockMovement receipt de la recepción", async () => {
    const reply = await call(app, "POST", `/properties/${tenantA.propertyA}/goods-receipts`, clerkA, {
      supplierId,
      deliveryNoteNumber: "ALB-2026/0042",
      deliveryDate: "2026-09-18",
      stockLocationId: locationId,
      note: "Entrega de la mañana",
      lines: [{ ...RECEIPT_1_LINES[0], inventoryItemId: itemSabanas }, RECEIPT_1_LINES[1]]
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    receipt1 = reply.body;
    assert.equal(receipt1.status, "received");
    assert.equal(receipt1.organizationId, tenantA.organizationId);
    assert.equal(receipt1.propertyId, tenantA.propertyA);
    assert.equal(receipt1.supplierId, supplierId);
    assert.equal(receipt1.supplierTaxId, supplierTaxId);
    assert.match(receipt1.supplierName, /Lavandería Ficticia/);
    assert.equal(receipt1.deliveryDate, "2026-09-18");
    assert.equal(receipt1.receivedBy, clerkA.userId);
    assert.equal(receipt1.lineCount, 2);
    assert.equal(receipt1.baseTotal, "170.00");
    assert.equal(receipt1.lines.length, 2);
    assert.equal(receipt1.lines[0].inventoryItemId, itemSabanas);
    assert.equal(receipt1.lines[1].inventoryItemId, itemToallas, "resuelto por nombre exacto");
    assert.equal(receipt1.lines[0].quantityReceived, "120.000");
    assert.equal(receipt1.lines[1].unitPrice, "0.5000");
    assert.ok(receipt1.lines.every((line: Json) => typeof line.stockMovementId === "string"), "cada línea con artículo lleva movimiento");
    assert.deepEqual(receipt1.matches, []);
    assert.deepEqual(receipt1.supplierBillIds, []);

    const movements = await prisma.stockMovement.findMany({ where: { sourceType: "goods_receipt", sourceId: receipt1.id }, orderBy: { quantity: "asc" } });
    assert.equal(movements.length, 2);
    assert.deepEqual(movements.map((m) => m.movementType), ["receipt", "receipt"]);
    assert.deepEqual(movements.map((m) => m.quantity.toFixed(2)), ["40.00", "120.00"]);
    assert.deepEqual(movements.map((m) => m.unitCost?.toFixed(2)), ["0.50", "1.25"]);
    assert.ok(movements.every((m) => m.stockLocationId === locationId && m.propertyId === tenantA.propertyA));
    assert.deepEqual(new Set(movements.map((m) => m.id)), new Set(receipt1.lines.map((line: Json) => line.stockMovementId)));

    await flushAuditQueues();
    const audit = await prisma.auditEvent.findMany({ where: { organizationId: tenantA.organizationId, action: "GOODS_RECEIPT_CREATED", entityId: receipt1.id } });
    assert.equal(audit.length, 1);
    assert.equal((audit[0]!.afterJson as Json).stockMovements, 2);
    assert.equal((audit[0]!.afterJson as Json).deliveryNoteNumber, "ALB-2026/0042");
  });

  it("los movimientos van en la MISMA transacción: una transacción abortada tras createGoodsReceiptInTx no deja recepción ni movimientos", async () => {
    const before = await prisma.stockMovement.count({ where: { propertyId: tenantA.propertyA } });
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        const detail = await createGoodsReceiptInTx(tx, {
          organizationId: tenantA.organizationId,
          propertyId: tenantA.propertyA,
          receivedBy: clerkA.userId,
          body: { supplierId, deliveryNoteNumber: "ALB-ROLLBACK", deliveryDate: "2026-09-18", stockLocationId: locationId, lines: [{ description: "Café molido 1 kg", quantityReceived: 5, unitPrice: 8 }] }
        });
        assert.equal(detail.lines[0]!.inventoryItemId, itemCafe);
        assert.ok(detail.lines[0]!.stockMovementId);
        throw new Error("abort-t9gr");
      }),
      /abort-t9gr/
    );
    assert.equal(await prisma.goodsReceipt.count({ where: { organizationId: tenantA.organizationId, deliveryNoteNumber: "ALB-ROLLBACK" } }), 0);
    assert.equal(await prisma.stockMovement.count({ where: { propertyId: tenantA.propertyA } }), before);
  });

  it("sin ubicación no hay movimiento; artículo desconocido → 400 INVENTORY_ITEM_INVALID; ubicación ajena → 400 STOCK_LOCATION_INVALID", async () => {
    const noLocation = await call(app, "POST", `/properties/${tenantA.propertyA}/goods-receipts`, clerkA, {
      supplierId,
      deliveryNoteNumber: "ALB-2026/0043",
      deliveryDate: "2026-09-19",
      lines: [{ description: "Café molido 1 kg", quantityReceived: 10, unitPrice: "8.0000", taxRate: 10 }]
    });
    assert.equal(noLocation.status, 201, JSON.stringify(noLocation.body));
    receipt2 = noLocation.body;
    assert.equal(receipt2.lines[0].inventoryItemId, itemCafe, "resuelto por nombre aunque no haya ubicación");
    assert.equal(receipt2.lines[0].stockMovementId, null);
    assert.equal(await prisma.stockMovement.count({ where: { sourceType: "goods_receipt", sourceId: receipt2.id } }), 0);

    const badItem = await call(app, "POST", `/properties/${tenantA.propertyA}/goods-receipts`, clerkA, {
      supplierId,
      deliveryNoteNumber: "ALB-BAD-ITEM",
      deliveryDate: "2026-09-19",
      lines: [{ description: "x", quantityReceived: 1, inventoryItemId: "it_inexistente" }]
    });
    assert.equal(badItem.status, 400, JSON.stringify(badItem.body));
    assert.equal(codeOf(badItem), "INVENTORY_ITEM_INVALID");

    const foreignLocation = await prisma.stockLocation.create({ data: { propertyId: tenantA.propertyB, name: `Almacén B ${RUN_A}`, locationType: "store" } });
    const badLocation = await call(app, "POST", `/properties/${tenantA.propertyA}/goods-receipts`, clerkA, {
      supplierId,
      deliveryNoteNumber: "ALB-BAD-LOC",
      deliveryDate: "2026-09-19",
      stockLocationId: foreignLocation.id,
      lines: [{ description: "x", quantityReceived: 1 }]
    });
    assert.equal(badLocation.status, 400, JSON.stringify(badLocation.body));
    assert.equal(codeOf(badLocation), "STOCK_LOCATION_INVALID");
    assert.equal(await prisma.goodsReceipt.count({ where: { organizationId: tenantA.organizationId, deliveryNoteNumber: { in: ["ALB-BAD-ITEM", "ALB-BAD-LOC"] } } }), 0);
  });

  it("duplicado (mismo proveedor y número, incluso escrito de otra forma) → 409 GOODS_RECEIPT_DUPLICATE; por NIF sin supplierId enlaza al proveedor y también es duplicado", async () => {
    const same = await call(app, "POST", `/properties/${tenantA.propertyA}/goods-receipts`, clerkA, { supplierId, deliveryNoteNumber: "ALB-2026/0042", deliveryDate: "2026-09-18", lines: [{ description: "x", quantityReceived: 1 }] });
    assert.equal(same.status, 409, JSON.stringify(same.body));
    assert.equal(codeOf(same), "GOODS_RECEIPT_DUPLICATE");
    assert.equal(same.body.details.goodsReceiptId, receipt1.id);
    const variant = await call(app, "POST", `/properties/${tenantA.propertyA}/goods-receipts`, clerkA, { supplierId, deliveryNoteNumber: "alb 2026 0042", deliveryDate: "2026-09-18", lines: [{ description: "x", quantityReceived: 1 }] });
    assert.equal(variant.status, 409);
    assert.equal(codeOf(variant), "GOODS_RECEIPT_DUPLICATE");
    const byTaxId = await call(app, "POST", `/properties/${tenantA.propertyA}/goods-receipts`, clerkA, { supplierTaxId, deliveryNoteNumber: "ALB-2026-0042", deliveryDate: "2026-09-18", lines: [{ description: "x", quantityReceived: 1 }] });
    assert.equal(byTaxId.status, 409, JSON.stringify(byTaxId.body));
    assert.equal(codeOf(byTaxId), "GOODS_RECEIPT_DUPLICATE");
    assert.equal(await prisma.goodsReceipt.count({ where: { organizationId: tenantA.organizationId } }), 2);
  });

  it("400 VALIDATION_ERROR (sin líneas, cantidad cero, clave desconocida) y 400 SUPPLIER_REQUIRED sin proveedor", async () => {
    for (const body of [
      { supplierId, deliveryNoteNumber: "ALB-V", deliveryDate: "2026-09-18", lines: [] },
      { supplierId, deliveryNoteNumber: "ALB-V", deliveryDate: "2026-09-18", lines: [{ description: "x", quantityReceived: 0 }] },
      { supplierId, deliveryNoteNumber: "ALB-V", deliveryDate: "2026-09-18", lines: [{ description: "x", quantityReceived: 1 }], foo: 1 }
    ]) {
      const reply = await call(app, "POST", `/properties/${tenantA.propertyA}/goods-receipts`, clerkA, body);
      assert.equal(reply.status, 400, JSON.stringify(reply.body));
      assert.equal(codeOf(reply), "VALIDATION_ERROR");
    }
    const noSupplier = await call(app, "POST", `/properties/${tenantA.propertyA}/goods-receipts`, clerkA, { deliveryNoteNumber: "ALB-V", deliveryDate: "2026-09-18", lines: [{ description: "x", quantityReceived: 1 }] });
    assert.equal(noSupplier.status, 400);
    assert.equal(codeOf(noSupplier), "SUPPLIER_REQUIRED");
  });
});

describe("T9-09 · cotejo factura–albarán", () => {
  it("factura con líneas iguales → match full, 2 BillLineMatch auto, factura full y recepción billed; auditoría BILL_MATCHED", async () => {
    const created = await call(app, "POST", `/properties/${tenantA.propertyA}/payables/supplier-bills`, clerkA, {
      supplierId,
      invoiceNumber: `F-${RUN_A}-0001`,
      issueDate: "2026-09-19",
      lines: [
        { description: "Lavado y planchado de sabanas KG", expenseAccountCode: "600", base: "150.00", taxRate: 21, quantity: 120, unitPrice: "1.25" },
        { description: "Toallas de baño", expenseAccountCode: "600", base: "20.00", taxRate: 21, quantity: 40, unitPrice: "0.5" }
      ]
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    bill1 = created.body;

    const matched = await call(app, "POST", `/properties/${tenantA.propertyA}/payables/supplier-bills/${bill1.id}/match`, clerkA, {});
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    assert.equal(matched.body.supplierBillId, bill1.id);
    assert.equal(matched.body.matchStatus, "full");
    assert.equal(matched.body.matches.length, 2);
    const byBillLine = new Map((matched.body.matches as Json[]).map((m) => [m.supplierBillLineId, m]));
    const lineIds = (bill1.lines as Json[]).map((line) => line.id);
    assert.deepEqual([...byBillLine.keys()].sort(), [...lineIds].sort());
    const first = byBillLine.get(lineIds[0])!;
    assert.equal(first.goodsReceiptLineId, receipt1.lines[0].id);
    assert.equal(first.status, "auto");
    assert.equal(first.matchedQuantity, "120.000");
    assert.equal(first.matchedBase, "150.00");
    assert.equal(first.priceVariance, "0.0000");
    assert.equal(first.quantityVariance, "0.000");
    assert.equal(first.matchedBy, clerkA.userId);

    const billRow = await prisma.supplierBill.findUnique({ where: { id: bill1.id }, select: { matchStatus: true } });
    assert.equal(billRow?.matchStatus, "full");
    const receiptRow = await prisma.goodsReceipt.findUnique({ where: { id: receipt1.id }, select: { status: true } });
    assert.equal(receiptRow?.status, "billed");
    assert.equal(await prisma.billLineMatch.count({ where: { supplierBillLine: { supplierBillId: bill1.id } } }), 2);

    await flushAuditQueues();
    const audit = await prisma.auditEvent.findMany({ where: { organizationId: tenantA.organizationId, action: "BILL_MATCHED", entityId: bill1.id } });
    assert.equal(audit.length, 1);
    assert.equal((audit[0]!.afterJson as Json).matchStatus, "full");
    assert.deepEqual((audit[0]!.afterJson as Json).receiptStatus, [{ goodsReceiptId: receipt1.id, status: "billed" }]);
  });

  it("el cotejo es idempotente: misma respuesta, mismos ids, sin filas nuevas", async () => {
    const before = (await prisma.billLineMatch.findMany({ where: { supplierBillLine: { supplierBillId: bill1.id } }, select: { id: true } })).map((m) => m.id).sort();
    const again = await call(app, "POST", `/properties/${tenantA.propertyA}/payables/supplier-bills/${bill1.id}/match`, clerkA, { goodsReceiptIds: [receipt1.id] });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.matchStatus, "full");
    assert.deepEqual((again.body.matches as Json[]).map((m) => m.id).sort(), before);
    assert.equal(await prisma.billLineMatch.count({ where: { supplierBillLine: { supplierBillId: bill1.id } } }), 2);
  });

  it("precio +3 % → variance con la varianza con signo; la recepción sigue received", async () => {
    const created = await call(app, "POST", `/properties/${tenantA.propertyA}/payables/supplier-bills`, clerkA, {
      supplierId,
      invoiceNumber: `F-${RUN_A}-0002`,
      issueDate: "2026-09-19",
      lines: [{ description: "Café molido 1 kg", expenseAccountCode: "600", base: "82.40", taxRate: 10, quantity: 10, unitPrice: "8.24" }]
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    bill2 = created.body;
    const matched = await call(app, "POST", `/properties/${tenantA.propertyA}/payables/supplier-bills/${bill2.id}/match`, clerkA, { auto: true });
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    assert.equal(matched.body.matchStatus, "variance");
    assert.equal(matched.body.matches.length, 1);
    assert.equal(matched.body.matches[0].goodsReceiptLineId, receipt2.lines[0].id);
    assert.equal(matched.body.matches[0].priceVariance, "0.2400");
    assert.equal(matched.body.matches[0].quantityVariance, "0.000");
    assert.equal((await prisma.supplierBill.findUnique({ where: { id: bill2.id }, select: { matchStatus: true } }))?.matchStatus, "variance");
    assert.equal((await prisma.goodsReceipt.findUnique({ where: { id: receipt2.id }, select: { status: true } }))?.status, "received");
  });

  it("errores: 404 factura de otro centro, 404 recepción desconocida, 403 sin procurement.manage", async () => {
    const otherProperty = await call(app, "POST", `/properties/${tenantA.propertyB}/payables/supplier-bills/${bill1.id}/match`, accountantA, {});
    assert.equal(otherProperty.status, 404, JSON.stringify(otherProperty.body));
    const unknownReceipt = await call(app, "POST", `/properties/${tenantA.propertyA}/payables/supplier-bills/${bill1.id}/match`, clerkA, { goodsReceiptIds: ["gr_inexistente"] });
    assert.equal(unknownReceipt.status, 404, JSON.stringify(unknownReceipt.body));
    const forbidden = await call(app, "POST", `/properties/${tenantA.propertyA}/payables/supplier-bills/${bill1.id}/match`, receptionistA, {});
    assert.equal(forbidden.status, 403, JSON.stringify(forbidden.body));
  });
});

describe("T9-09 · lista, detalle, disputa y tenencia", () => {
  it("GET lista (inventory.read): array por defecto con cabeceras, sobre con ?envelope=1, cursor con ?limit=1 y filtros", async () => {
    const list = await call(app, "GET", `/properties/${tenantA.propertyA}/goods-receipts`, accountantA);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(Array.isArray(list.body));
    assert.equal((list.body as unknown as Json[]).length, 2);
    assert.equal(list.headers["x-total-count"], "2");
    assert.deepEqual((list.body as unknown as Json[]).map((r) => r.deliveryNoteNumber), ["ALB-2026/0043", "ALB-2026/0042"], "fecha de albarán descendente");
    assert.equal((list.body as unknown as Json[])[1]!.status, "billed");
    assert.match((list.body as unknown as Json[])[1]!.supplierName, /Lavandería Ficticia/);

    const envelope = await call(app, "GET", `/properties/${tenantA.propertyA}/goods-receipts?envelope=1`, accountantA);
    assert.equal(envelope.status, 200);
    assert.equal(envelope.body.total, 2);
    assert.equal(envelope.body.items.length, 2);
    assert.equal(envelope.body.nextCursor, null);

    const page1 = await call(app, "GET", `/properties/${tenantA.propertyA}/goods-receipts?limit=1`, accountantA);
    assert.equal(page1.status, 200);
    assert.equal((page1.body as unknown as Json[]).length, 1);
    const cursor = page1.headers["x-next-cursor"];
    assert.equal(typeof cursor, "string");
    const page2 = await call(app, "GET", `/properties/${tenantA.propertyA}/goods-receipts?limit=1&cursor=${encodeURIComponent(String(cursor))}`, accountantA);
    assert.equal(page2.status, 200);
    assert.equal(page2.body.items.length, 1);
    assert.equal(page2.body.items[0].id, receipt1.id);
    assert.equal(page2.body.nextCursor, null);

    const billed = await call(app, "GET", `/properties/${tenantA.propertyA}/goods-receipts?status=billed`, accountantA);
    assert.deepEqual((billed.body as unknown as Json[]).map((r) => r.id), [receipt1.id]);
    const search = await call(app, "GET", `/properties/${tenantA.propertyA}/goods-receipts?q=0043`, accountantA);
    assert.deepEqual((search.body as unknown as Json[]).map((r) => r.id), [receipt2.id]);
    const dated = await call(app, "GET", `/properties/${tenantA.propertyA}/goods-receipts?from=2026-09-19&to=2026-09-19`, accountantA);
    assert.deepEqual((dated.body as unknown as Json[]).map((r) => r.id), [receipt2.id]);
    const badFilter = await call(app, "GET", `/properties/${tenantA.propertyA}/goods-receipts?status=open`, accountantA);
    assert.equal(badFilter.status, 400);
    assert.equal(codeOf(badFilter), "VALIDATION_ERROR");
  });

  it("GET detalle con líneas, cotejos y facturas cotejadas", async () => {
    const detail = await call(app, "GET", `/properties/${tenantA.propertyA}/goods-receipts/${receipt1.id}`, accountantA);
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.status, "billed");
    assert.equal(detail.body.lines.length, 2);
    assert.equal(detail.body.matches.length, 2);
    assert.deepEqual(detail.body.supplierBillIds, [bill1.id]);
    assert.equal(detail.body.note, "Entrega de la mañana");
    const missing = await call(app, "GET", `/properties/${tenantA.propertyA}/goods-receipts/gr_inexistente`, accountantA);
    assert.equal(missing.status, 404);
  });

  it("dispute: received → disputed con la razón en la nota; repetir → 409; una recepción billed → 409", async () => {
    const disputed = await call(app, "POST", `/properties/${tenantA.propertyA}/goods-receipts/${receipt2.id}/dispute`, clerkA, { reason: "Llegó 1 kg menos de café" });
    assert.equal(disputed.status, 200, JSON.stringify(disputed.body));
    assert.equal(disputed.body.status, "disputed");
    assert.equal(disputed.body.note, "Disputa: Llegó 1 kg menos de café");
    const again = await call(app, "POST", `/properties/${tenantA.propertyA}/goods-receipts/${receipt2.id}/dispute`, clerkA, { reason: "Otra vez" });
    assert.equal(again.status, 409);
    assert.equal(codeOf(again), "INVALID_STATUS_TRANSITION");
    const billed = await call(app, "POST", `/properties/${tenantA.propertyA}/goods-receipts/${receipt1.id}/dispute`, clerkA, { reason: "Ya facturada" });
    assert.equal(billed.status, 409);
    assert.equal(codeOf(billed), "INVALID_STATUS_TRANSITION");
    const tooShort = await call(app, "POST", `/properties/${tenantA.propertyA}/goods-receipts/${receipt2.id}/dispute`, clerkA, { reason: "no" });
    assert.equal(tooShort.status, 400);
    await flushAuditQueues();
    assert.equal(await prisma.auditEvent.count({ where: { organizationId: tenantA.organizationId, action: "GOODS_RECEIPT_DISPUTED", entityId: receipt2.id } }), 1);
    const notMatchable = await call(app, "POST", `/properties/${tenantA.propertyA}/payables/supplier-bills/${bill2.id}/match`, clerkA, { goodsReceiptIds: [receipt2.id] });
    assert.equal(notMatchable.status, 409, "una recepción disputada no se coteja por id");
    assert.equal(codeOf(notMatchable), "INVALID_STATUS_TRANSITION");
  });

  it("403 para recepción (sin procurement.manage ni inventory.read) y 404 opaco desde otro tenant", async () => {
    const post = await call(app, "POST", `/properties/${tenantA.propertyA}/goods-receipts`, receptionistA, { supplierId, deliveryNoteNumber: "ALB-403", deliveryDate: "2026-09-18", lines: [{ description: "x", quantityReceived: 1 }] });
    assert.equal(post.status, 403, JSON.stringify(post.body));
    const list = await call(app, "GET", `/properties/${tenantA.propertyA}/goods-receipts`, receptionistA);
    assert.equal(list.status, 403, JSON.stringify(list.body));
    const dispute = await call(app, "POST", `/properties/${tenantA.propertyA}/goods-receipts/${receipt2.id}/dispute`, receptionistA, { reason: "sin permiso" });
    assert.equal(dispute.status, 403);
    assert.equal(await prisma.goodsReceipt.count({ where: { organizationId: tenantA.organizationId, deliveryNoteNumber: "ALB-403" } }), 0);

    const foreign = await call(app, "GET", `/properties/${tenantB.propertyA}/goods-receipts/${receipt1.id}`, ownerB);
    assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
    const foreignList = await call(app, "GET", `/properties/${tenantB.propertyA}/goods-receipts`, ownerB);
    assert.equal(foreignList.status, 200);
    assert.deepEqual(foreignList.body, []);
    const crossProperty = await call(app, "GET", `/properties/${tenantA.propertyB}/goods-receipts/${receipt1.id}`, accountantA);
    assert.equal(crossProperty.status, 404, "la recepción cuelga del centro A: 404 desde B");
  });
});
