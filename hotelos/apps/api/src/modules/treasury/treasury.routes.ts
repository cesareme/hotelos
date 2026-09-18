// Treasury / banking / commissions / payroll · HTTP surface of the lote
// tesoreria-banca.
//
// Registered from server.ts with `registerTreasuryRoutes(app)` (handoff to the
// integrator). Permissions: route-permissions.partial.ts (spread into
// routePermissionManifest); the contract test reads that file. The legacy
// /banking, /payroll and /commissions routes in server.ts keep calling the
// same services (importCsb43, manualMatch, calculatePeriod…), which now
// persist, post through the ledger and accept the finance keys; the GET
// payroll export in server.ts is read-only since export.service stopped
// mutating — the mutation lives on POST /payroll/periods/:id/export here.
//
// Tenancy: property-scoped queries go through grantPropertyAccess (opaque 404
// for another organization / an unassigned property); entity routes use
// assertEntityAccess with the tenancy resolvers.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createId } from "../../lib/ids.js";
import { assertEntityAccess, grantPropertyAccess, resolveOrganizationScope } from "../../lib/tenancy.js";
import { BadRequestError } from "../../lib/http-error.js";
import { importCsb43 } from "../banking-spain/banking.service.js";
import { importStatementFromCsv } from "../banking/bank-statement.service.js";
import { autoMatchStatement, reconcileLine, suggestForLine, unmatch, type ReconcileTargetType } from "../banking/reconciliation.service.js";
import { accrueCommission, getAccrual, isOtaChannel, reverseCommissionAccrual, settleCommissionAccrual } from "../commissions/commission-accrual.service.js";
import { exportPeriod, normalisePayrollExportFormat } from "../payroll/export.service.js";
import { approvePeriod, getPeriod, payPeriod } from "../payroll/periods.service.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { prisma } from "@hotelos/database";
import { requirePermissions } from "../auth/auth.service.js";
import { COMMISSION_WRITE_KEYS, TREASURY_WRITE_KEYS, requireAnyPermission } from "./permissions.js";
import { buildSupplierPaymentRemittance, createRemittance, getRemittance, listRemittances, updateRemittanceStatus } from "./sepa-remittance.service.js";
import { treasuryForecast, treasuryPayables, treasuryPosition, treasuryReceivables, type TreasuryScopeInput } from "./treasury.service.js";

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha YYYY-MM-DD");
const dateInput = z.union([isoDay, z.string().datetime({ offset: true })]);

// Tanda 6b · L4: `?scope=entity` = the whole sociedad (accounting.entity.read); default = one centre.
const scopeQuerySchema = z.object({ propertyId: z.string().min(1).optional(), asOf: dateInput.optional(), scope: z.enum(["property", "entity"]).optional() }).strict();
const importBodySchema = z.object({ format: z.enum(["csb43", "csv"]), content: z.string().min(1), source: z.string().max(40).optional(), autoMatch: z.boolean().optional(), createMissingAccount: z.boolean().optional() }).strict();
const reconcileBodySchema = z
  .object({
    matchType: z.enum(["payment", "card_settlement", "supplier_bill", "payroll_period", "commission_accrual", "bank_fee", "bank_interest", "manual"]),
    matchedEntityId: z.string().min(1).max(400).optional(),
    notes: z.string().max(500).optional()
  })
  .strict();
const autoReconcileBodySchema = z.object({ dryRun: z.boolean().optional() }).strict();
const remittanceBodySchema = z.object({ kind: z.enum(["norma19", "norma34"]), propertyId: z.string().min(1).optional(), bankAccountId: z.string().min(1).optional(), body: z.unknown() }).strict();
const remittanceListQuerySchema = z.object({ propertyId: z.string().min(1).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict();
const supplierRemittanceBodySchema = z.object({ propertyId: z.string().min(1).optional(), bankAccountId: z.string().min(1), billIds: z.array(z.string().min(1)).min(1).max(500), executionDate: isoDay, generate: z.boolean().optional() }).strict();
const settleBodySchema = z.object({ paidAt: dateInput.optional(), bankLedgerCode: z.string().min(3).max(12).optional(), reference: z.string().max(120).optional() }).strict();
const reverseBodySchema = z.object({ reason: z.string().max(240).optional() }).strict();
const accrueBodySchema = z.object({ propertyId: z.string().min(1).optional(), reservationId: z.string().min(1), channelCode: z.string().min(1).max(60).optional(), baseAmount: z.union([z.number().positive(), z.string().regex(/^\d+([.,]\d{1,2})?$/)]).optional(), accruedAt: dateInput.optional() }).strict();
const exportBodySchema = z.object({ format: z.enum(["a3", "sage", "csv"]).optional() }).strict();
const payBodySchema = z.object({ paidAt: dateInput.optional(), bankLedgerCode: z.string().min(3).max(12).optional(), reference: z.string().max(120).optional() }).strict();
/** Tanda 8a: body of POST /payroll/periods/:id/approve (payroll.approve). */
const approvePayrollBodySchema = z.object({ note: z.string().trim().min(1).max(1000).optional() }).strict();

async function propertyScope(request: FastifyRequest, requested?: string): Promise<string> {
  const propertyId = requested ?? request.userContext.propertyId;
  if (!propertyId) throw new BadRequestError("propertyId es obligatorio.");
  await grantPropertyAccess(request, propertyId);
  return propertyId;
}

/**
 * Ámbito de tesorería (Tanda 6b · L4): `?scope=entity` → the whole sociedad of
 * the caller's organisation (the service applies the shared whole-sociedad read
 * guard: opaque 404 ENTITY_SCOPE_REQUIRED for a centre-bound user, design §5.2
 * R11); otherwise one centre through grantPropertyAccess (opaque 404).
 */
async function treasuryScopeOf(request: FastifyRequest, q: { propertyId?: string; asOf?: string; scope?: "property" | "entity" }): Promise<TreasuryScopeInput> {
  const asOf = q.asOf ? new Date(q.asOf) : undefined;
  if (q.scope === "entity") {
    const organizationId = await resolveOrganizationScope(request);
    return { scope: "entity", organizationId, asOf, context: request.userContext };
  }
  const propertyId = await propertyScope(request, q.propertyId);
  return { propertyId, asOf };
}

export function registerTreasuryRoutes(app: FastifyInstance): void {
  // ---- Tesorería (lectura) ----
  app.get("/treasury/position", async (request) => {
    const q = parseOr400(scopeQuerySchema, request.query ?? {}, "query");
    return treasuryPosition(await treasuryScopeOf(request, q));
  });

  app.get("/treasury/receivables", async (request) => {
    const q = parseOr400(scopeQuerySchema, request.query ?? {}, "query");
    return treasuryReceivables(await treasuryScopeOf(request, q));
  });

  app.get("/treasury/payables", async (request) => {
    const q = parseOr400(scopeQuerySchema, request.query ?? {}, "query");
    return treasuryPayables(await treasuryScopeOf(request, q));
  });

  app.get("/treasury/forecast", async (request) => {
    const q = parseOr400(scopeQuerySchema, request.query ?? {}, "query");
    return treasuryForecast(await treasuryScopeOf(request, q));
  });

  // ---- Banca: importación persistida (CSB43 / CSV) y conciliación ----
  app.post("/treasury/bank-accounts/:id/statements/import", async (request) => {
    const { id } = request.params as { id: string };
    const owner = await assertEntityAccess(request, { entity: "bankAccount", id });
    const body = parseOr400(importBodySchema, request.body ?? {}, "body");
    requireAnyPermission(request.userContext, TREASURY_WRITE_KEYS);
    if (body.format === "csv") return importStatementFromCsv({ bankAccountId: id, csv: body.content, source: body.source ?? "csv" });
    const account = await prisma.bankAccount.findUnique({ where: { id }, select: { propertyId: true } });
    return importCsb43({ context: request.userContext, propertyId: owner.propertyId ?? account?.propertyId ?? request.userContext.propertyId, content: body.content, bankAccountId: id, autoMatch: body.autoMatch, createMissingAccount: body.createMissingAccount });
  });

  app.get("/treasury/bank-lines/:bankLineId/suggestions", async (request) => {
    const { bankLineId } = request.params as { bankLineId: string };
    await assertEntityAccess(request, { entity: "bankStatementLine", id: bankLineId });
    return suggestForLine(bankLineId);
  });

  app.post("/treasury/bank-lines/:bankLineId/reconcile", async (request) => {
    const { bankLineId } = request.params as { bankLineId: string };
    await assertEntityAccess(request, { entity: "bankStatementLine", id: bankLineId });
    const body = parseOr400(reconcileBodySchema, request.body ?? {}, "body");
    return reconcileLine({ bankLineId, matchType: body.matchType as ReconcileTargetType, matchedEntityId: body.matchedEntityId, notes: body.notes, context: request.userContext });
  });

  app.delete("/treasury/bank-lines/:bankLineId/reconcile", async (request) => {
    const { bankLineId } = request.params as { bankLineId: string };
    await assertEntityAccess(request, { entity: "bankStatementLine", id: bankLineId });
    return unmatch(bankLineId, { context: request.userContext });
  });

  app.post("/treasury/statements/:id/auto-reconcile", async (request) => {
    const { id } = request.params as { id: string };
    await assertEntityAccess(request, { entity: "bankStatement", id });
    const body = parseOr400(autoReconcileBodySchema, request.body ?? {}, "body");
    return autoMatchStatement(id, { dryRun: body.dryRun, context: request.userContext });
  });

  // ---- Remesas SEPA (Norma 19 / 34) persistidas ----
  app.post("/treasury/sepa/remittances", async (request) => {
    const body = parseOr400(remittanceBodySchema, request.body ?? {}, "body");
    const propertyId = await propertyScope(request, body.propertyId);
    return createRemittance({ context: request.userContext, propertyId, kind: body.kind, body: body.body, bankAccountId: body.bankAccountId ?? null, correlationId: createId("corr") });
  });

  app.get("/treasury/sepa/remittances", async (request) => {
    const q = parseOr400(remittanceListQuerySchema, request.query ?? {}, "query");
    const propertyId = q.propertyId ? await propertyScope(request, q.propertyId) : null;
    return { items: await listRemittances({ context: request.userContext, propertyId, limit: q.limit }) };
  });

  app.get("/treasury/sepa/remittances/:id", async (request) => {
    const { id } = request.params as { id: string };
    return getRemittance({ context: request.userContext, id });
  });

  app.post("/treasury/sepa/remittances/:id/status", async (request) => {
    const { id } = request.params as { id: string };
    return updateRemittanceStatus({ context: request.userContext, id, body: request.body ?? {} });
  });

  app.post("/treasury/sepa/supplier-payments", async (request) => {
    const body = parseOr400(supplierRemittanceBodySchema, request.body ?? {}, "body");
    const propertyId = await propertyScope(request, body.propertyId);
    const built = await buildSupplierPaymentRemittance({ context: request.userContext, propertyId, bankAccountId: body.bankAccountId, billIds: body.billIds, executionDate: body.executionDate });
    if (!body.generate) return built;
    const remittance = await createRemittance({ context: request.userContext, propertyId, kind: "norma34", body: built.body, bankAccountId: body.bankAccountId, correlationId: createId("corr") });
    return { ...built, remittance };
  });

  // ---- Comisiones: devengo manual, liquidación y reverso ----
  app.get("/commissions/accruals/:id", async (request) => {
    const { id } = request.params as { id: string };
    const accrual = await getAccrual(id);
    await grantPropertyAccess(request, accrual.propertyId);
    return accrual;
  });

  app.post("/commissions/accrue", async (request) => {
    const body = parseOr400(accrueBodySchema, request.body ?? {}, "body");
    requireAnyPermission(request.userContext, COMMISSION_WRITE_KEYS);
    const owner = await assertEntityAccess(request, { entity: "reservation", id: body.reservationId });
    const reservation = await prisma.reservation.findUnique({ where: { id: body.reservationId }, select: { channel: true, propertyId: true, departureDate: true } });
    if (!reservation) throw new BadRequestError("La reserva no existe.");
    const channelCode = body.channelCode ?? reservation.channel;
    if (!isOtaChannel(channelCode)) throw new BadRequestError("La reserva es de canal directo: no devenga comisión.");
    return accrueCommission({ propertyId: owner.propertyId ?? reservation.propertyId, reservationId: body.reservationId, channelCode, baseAmount: body.baseAmount ?? null, accruedAt: body.accruedAt ?? reservation.departureDate, createdBy: request.userContext.userId, reference: body.reservationId });
  });

  app.post("/commissions/accruals/:id/settle", async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOr400(settleBodySchema, request.body ?? {}, "body");
    requireAnyPermission(request.userContext, COMMISSION_WRITE_KEYS);
    const accrual = await getAccrual(id);
    await grantPropertyAccess(request, accrual.propertyId);
    return settleCommissionAccrual({ accrualId: id, paidAt: body.paidAt, bankLedgerCode: body.bankLedgerCode ?? null, reference: body.reference ?? null, createdBy: request.userContext.userId });
  });

  app.post("/commissions/accruals/:id/reverse", async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOr400(reverseBodySchema, request.body ?? {}, "body");
    requireAnyPermission(request.userContext, COMMISSION_WRITE_KEYS);
    const accrual = await getAccrual(id);
    await grantPropertyAccess(request, accrual.propertyId);
    return reverseCommissionAccrual({ accrualId: id, reason: body.reason ?? null, createdBy: request.userContext.userId });
  });

  // ---- Nóminas: detalle, exportación (POST, muta) y pago ----
  app.get("/payroll/periods/:id", async (request) => {
    const { id } = request.params as { id: string };
    await assertEntityAccess(request, { entity: "payrollPeriod", id });
    return getPeriod(id);
  });

  app.post("/payroll/periods/:id/export", async (request) => {
    const { id } = request.params as { id: string };
    await assertEntityAccess(request, { entity: "payrollPeriod", id });
    const body = parseOr400(exportBodySchema, request.body ?? {}, "body");
    return exportPeriod({ context: request.userContext, periodId: id, format: normalisePayrollExportFormat(body.format), correlationId: createId("corr"), markExported: true });
  });

  // Tanda 8a · general management approves the monthly register (payroll.approve;
  // approver ≠ calculator) before dirección financiera pays it (payables.pay;
  // payer ≠ approver; an unapproved period is 409 PAYROLL_NOT_APPROVED).
  app.post("/payroll/periods/:id/approve", async (request) => {
    const { id } = request.params as { id: string };
    await assertEntityAccess(request, { entity: "payrollPeriod", id });
    const body = parseOr400(approvePayrollBodySchema, request.body ?? {}, "body");
    await resolveOrganizationScope(request);
    return approvePeriod({ context: request.userContext, periodId: id, note: body.note, correlationId: createId("corr") });
  });

  app.post("/payroll/periods/:id/pay", async (request) => {
    const { id } = request.params as { id: string };
    await assertEntityAccess(request, { entity: "payrollPeriod", id });
    const body = parseOr400(payBodySchema, request.body ?? {}, "body");
    requirePermissions(request.userContext, ["payables.pay"]);
    await resolveOrganizationScope(request);
    return payPeriod({ context: request.userContext, periodId: id, paidAt: body.paidAt, bankLedgerCode: body.bankLedgerCode ?? null, reference: body.reference ?? null, correlationId: createId("corr") });
  });
}
