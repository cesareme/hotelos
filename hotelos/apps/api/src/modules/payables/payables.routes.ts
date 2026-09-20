// Payables · HTTP surface (Finanzas 2026-09-15, lote proveedores-activos).
//
// Registrado desde server.ts con `registerPayablesRoutes(app)` (integrador).
// Tanda T9 (T9-09): también registra las 4 rutas de recepciones de mercancía
// (modules/documents/goods-receipts.routes.ts) y la ruta de cotejo
// POST …/supplier-bills/:billId/match; sus 5 filas van en el partial de aquí.
// Permisos: route-permissions.partial.ts — entradas fusionadas en
// routePermissionManifest (security/route-permissions.ts); el contract test
// lee este fichero y el partial.
//
// Tenancy: supplier routes hang from /organizations/:organizationId and go
// through `assertEntityAccess` (same org, or platform admin re-pointed);
// documents hang from /properties/:propertyId, which the global hook already
// validates against the caller's organisation, and every service re-checks
// that the row belongs to that property (neutral 404 otherwise). Paths are
// namespaced under /payables so the legacy `/properties/:propertyId/supplier-
// bills` and `/supplier-bills/drafts` routes of server.ts keep working until
// the integrator retires them.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createId } from "../../lib/ids.js";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { createExpense, EXPENSE_PAID_WITH, getExpense, listExpenses, reverseExpense } from "./expenses.service.js";
import {
  approveSupplierBill,
  BILL_STATUSES,
  cancelSupplierBill,
  createSupplierBill,
  getPayablesAging,
  getSupplierBill,
  getSupplierBillAttachment,
  listSupplierBills,
  paySupplierBill,
  postSupplierBill,
  updateSupplierBill
} from "./supplier-bills.service.js";
import { createSupplier, getSupplier, listSuppliers, updateSupplier } from "./suppliers.service.js";
// Tanda T9 (documentos · lote T9-09): recepciones de mercancía y cotejo factura–albarán.
import { matchSupplierBill } from "../documents/bill-matching.service.js";
import { registerGoodsReceiptRoutes } from "../documents/goods-receipts.routes.js";

type OrganizationParams = { organizationId: string };
type SupplierParams = OrganizationParams & { supplierId: string };
type PropertyParams = { propertyId: string };
type BillParams = PropertyParams & { billId: string };
type ExpenseParams = PropertyParams & { expenseId: string };

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha AAAA-MM-DD");
const boolQuery = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");
const limitQuery = z.coerce.number().int().min(1).max(500).optional();

const supplierListQuery = z.object({ q: z.string().max(120).optional(), active: boolQuery.optional(), limit: limitQuery }).strict();
const billListQuery = z
  .object({
    status: z.enum(BILL_STATUSES).optional(),
    supplierId: z.string().min(1).max(64).optional(),
    from: isoDay.optional(),
    to: isoDay.optional(),
    dueBefore: isoDay.optional(),
    q: z.string().max(120).optional(),
    limit: limitQuery
  })
  .strict();
const agingQuery = z.object({ asOf: isoDay.optional() }).strict();
const expenseListQuery = z
  .object({ from: isoDay.optional(), to: isoDay.optional(), paidWith: z.enum(EXPENSE_PAID_WITH).optional(), includeCancelled: boolQuery.optional(), q: z.string().max(120).optional(), limit: limitQuery })
  .strict();

export function registerPayablesRoutes(app: FastifyInstance): void {
  // ── Suppliers (organisation-owned) ────────────────────────────────────────
  app.get("/organizations/:organizationId/payables/suppliers", async (request) => {
    const { organizationId } = await assertEntityAccess(request, { entity: "organization", id: (request.params as OrganizationParams).organizationId });
    const q = parseOr400(supplierListQuery, request.query ?? {}, "Filtro");
    return listSuppliers({ organizationId, q: q.q, active: q.active ?? null, limit: q.limit });
  });

  app.post("/organizations/:organizationId/payables/suppliers", async (request, reply) => {
    const { organizationId } = await assertEntityAccess(request, { entity: "organization", id: (request.params as OrganizationParams).organizationId });
    const supplier = await createSupplier({ context: request.userContext, organizationId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(supplier);
  });

  app.get("/organizations/:organizationId/payables/suppliers/:supplierId", async (request) => {
    const params = request.params as SupplierParams;
    const { organizationId } = await assertEntityAccess(request, { entity: "organization", id: params.organizationId });
    return getSupplier(organizationId, params.supplierId);
  });

  app.patch("/organizations/:organizationId/payables/suppliers/:supplierId", async (request) => {
    const params = request.params as SupplierParams;
    const { organizationId } = await assertEntityAccess(request, { entity: "organization", id: params.organizationId });
    return updateSupplier({ context: request.userContext, organizationId, supplierId: params.supplierId, body: request.body, correlationId: createId("corr") });
  });

  // ── Supplier bills (property-owned) ───────────────────────────────────────
  app.get("/properties/:propertyId/payables/supplier-bills", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const q = parseOr400(billListQuery, request.query ?? {}, "Filtro");
    return listSupplierBills({ propertyId, ...q });
  });

  app.post("/properties/:propertyId/payables/supplier-bills", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const bill = await createSupplierBill({ context: request.userContext, propertyId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(bill);
  });

  app.get("/properties/:propertyId/payables/aging", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const q = parseOr400(agingQuery, request.query ?? {}, "Filtro");
    return getPayablesAging({ propertyId, asOf: q.asOf });
  });

  app.get("/properties/:propertyId/payables/supplier-bills/:billId", async (request) => {
    const params = request.params as BillParams;
    return getSupplierBill(params.propertyId, params.billId);
  });

  app.patch("/properties/:propertyId/payables/supplier-bills/:billId", async (request) => {
    const params = request.params as BillParams;
    return updateSupplierBill({ context: request.userContext, propertyId: params.propertyId, billId: params.billId, body: request.body, correlationId: createId("corr") });
  });

  app.post("/properties/:propertyId/payables/supplier-bills/:billId/approve", async (request) => {
    const params = request.params as BillParams;
    return approveSupplierBill({ context: request.userContext, propertyId: params.propertyId, billId: params.billId, body: request.body, correlationId: createId("corr") });
  });

  app.post("/properties/:propertyId/payables/supplier-bills/:billId/post", async (request) => {
    const params = request.params as BillParams;
    return postSupplierBill({ context: request.userContext, propertyId: params.propertyId, billId: params.billId, body: request.body, correlationId: createId("corr") });
  });

  app.post("/properties/:propertyId/payables/supplier-bills/:billId/pay", async (request) => {
    const params = request.params as BillParams;
    return paySupplierBill({ context: request.userContext, propertyId: params.propertyId, billId: params.billId, body: request.body, correlationId: createId("corr") });
  });

  app.post("/properties/:propertyId/payables/supplier-bills/:billId/cancel", async (request) => {
    const params = request.params as BillParams;
    return cancelSupplierBill({ context: request.userContext, propertyId: params.propertyId, billId: params.billId, body: request.body, correlationId: createId("corr") });
  });

  app.get("/properties/:propertyId/payables/supplier-bills/:billId/attachment", async (request) => {
    const params = request.params as BillParams;
    return getSupplierBillAttachment(params.propertyId, params.billId);
  });

  // Tanda T9 (diseño §7.2 / §9): cotejo a 2 vías con albaranes (procurement.manage).
  app.post("/properties/:propertyId/payables/supplier-bills/:billId/match", async (request) => {
    const params = request.params as BillParams;
    return matchSupplierBill({ context: request.userContext, propertyId: params.propertyId, billId: params.billId, body: request.body, correlationId: createId("corr") });
  });

  // ── Expenses / tickets (property-owned) ───────────────────────────────────
  app.get("/properties/:propertyId/payables/expenses", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const q = parseOr400(expenseListQuery, request.query ?? {}, "Filtro");
    return listExpenses({ propertyId, ...q });
  });

  app.post("/properties/:propertyId/payables/expenses", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const expense = await createExpense({ context: request.userContext, propertyId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(expense);
  });

  app.get("/properties/:propertyId/payables/expenses/:expenseId", async (request) => {
    const params = request.params as ExpenseParams;
    return getExpense(params.propertyId, params.expenseId);
  });

  app.post("/properties/:propertyId/payables/expenses/:expenseId/reverse", async (request) => {
    const params = request.params as ExpenseParams;
    return reverseExpense({ context: request.userContext, propertyId: params.propertyId, expenseId: params.expenseId, body: request.body, correlationId: createId("corr") });
  });

  // ── Recepciones de mercancía (Tanda T9 · T9-09; rutas en modules/documents/goods-receipts.routes.ts, filas en el partial de este módulo) ──
  registerGoodsReceiptRoutes(app);
}
