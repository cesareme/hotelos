// TPV · arqueo — HTTP surface of the POS module.
//
// Registered from server.ts with `registerPosRoutes(app)` (convention rate
// grid v2: *.routes.ts + route-permissions.partial.ts). Until the integrator
// wires it, server.ts keeps its own six legacy POS registrations (same paths,
// same services) — registering both would make Fastify throw on the duplicate
// route, so the handoff replaces them, never adds.
//
// Tenancy: /properties/:propertyId routes go through the global propertyId
// hook; /pos/tickets/:id routes resolve the ticket owner through
// assertEntityAccess (lib/tenancy.ts, posTicket resolver). Bodies and queries
// are zod-validated here (pos.schemas.ts) so a malformed amount never reaches
// the money path.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { createId } from "../../lib/ids.js";
import { BadRequestError } from "../../lib/http-error.js";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { parse } from "../../lib/validate.js";
import { approveCashClosure, closeCashClosure, getCashClosure, getPosCashSummary, listCashClosures, openCashClosure } from "./pos-cash-closure.service.js";
import { addPosLine, closePosTicket, listPosOutlets, listPosTickets, openPosTicket, voidPosTicket } from "./pos.service.js";
import {
  CashClosureApproveSchema,
  CashClosureCloseSchema,
  CashClosureListQuerySchema,
  CashClosureOpenSchema,
  PosCashSummaryQuerySchema,
  PosCloseSchema,
  PosLineSchema,
  PosTicketOpenSchema,
  PosTicketsQuerySchema,
  PosVoidSchema
} from "./pos.schemas.js";

type PropertyParams = { propertyId: string };
type TicketParams = { id: string };
type ClosureParams = { propertyId: string; closureId: string };

/** 400 (not a TypeError → 500) when a JSON body is missing or not an object. */
function requireObjectBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("El cuerpo de la petición debe ser un objeto JSON.");
  }
  return body as Record<string, unknown>;
}

function closedFromOf(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const instant = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(value);
  if (Number.isNaN(instant.getTime())) throw new BadRequestError("El parámetro closedFrom no es una fecha válida.");
  return instant;
}

async function assertTicketAccess(request: FastifyRequest, ticketId: string): Promise<void> {
  await assertEntityAccess(request as never, { entity: "posTicket", id: ticketId });
}

export function registerPosRoutes(app: FastifyInstance): void {
  // ── Board ────────────────────────────────────────────────────────────────
  app.get("/properties/:propertyId/pos/outlets", async (request) => {
    return listPosOutlets((request.params as PropertyParams).propertyId);
  });

  app.get("/properties/:propertyId/pos/tickets", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const q = parse(PosTicketsQuerySchema, request.query ?? {}, "query");
    return listPosTickets(propertyId, { status: q.status, closedFrom: closedFromOf(q.closedFrom), closedLimit: q.limit });
  });

  app.post("/pos/tickets", async (request) => {
    const body = parse(PosTicketOpenSchema, requireObjectBody(request.body));
    return openPosTicket({ propertyId: body.propertyId ?? request.userContext.propertyId, outletId: body.outletId, roomNumber: body.roomNumber });
  });

  app.post("/pos/tickets/:id/lines", async (request) => {
    const { id } = request.params as TicketParams;
    await assertTicketAccess(request, id);
    const body = parse(PosLineSchema, requireObjectBody(request.body));
    return addPosLine({ ticketId: id, name: body.name, quantity: body.quantity ?? 1, unitPrice: body.unitPrice, productId: body.productId ?? null });
  });

  app.post("/pos/tickets/:id/close", async (request) => {
    const { id } = request.params as TicketParams;
    await assertTicketAccess(request, id);
    const body = parse(PosCloseSchema, requireObjectBody(request.body));
    return closePosTicket({ context: request.userContext, ticketId: id, settlement: body.settlement, correlationId: createId("corr") });
  });

  // Tanda 8a · void of a closed ticket of the current business day
  // (pos.order.void or a supervisor PIN for that key); nothing is deleted.
  app.post("/pos/tickets/:id/void", async (request) => {
    const { id } = request.params as TicketParams;
    await assertTicketAccess(request, id);
    const body = parse(PosVoidSchema, requireObjectBody(request.body));
    return voidPosTicket({
      context: request.userContext,
      ticketId: id,
      reasonCode: body.reasonCode,
      reasonText: body.reasonText,
      supervisorAuthorizationId: body.supervisorAuthorizationId ?? null,
      correlationId: createId("corr")
    });
  });

  // ── Cash summary (read model) ────────────────────────────────────────────
  app.get("/properties/:propertyId/pos/cash-summary", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const q = parse(PosCashSummaryQuerySchema, request.query ?? {}, "query");
    return getPosCashSummary({ propertyId, date: q.date, from: q.from, to: q.to, outletId: q.outletId });
  });

  // ── Cash closures (persisted counts) ─────────────────────────────────────
  app.get("/properties/:propertyId/pos/cash-closures", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const q = parse(CashClosureListQuerySchema, request.query ?? {}, "query");
    return listCashClosures(propertyId, { status: q.status, outletId: q.outletId, from: q.from, to: q.to, limit: q.limit });
  });

  app.post("/properties/:propertyId/pos/cash-closures", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const body = parse(CashClosureOpenSchema, requireObjectBody(request.body ?? {}));
    const closure = await openCashClosure({
      context: request.userContext,
      propertyId,
      outletId: body.outletId,
      businessDate: body.businessDate,
      openingFloat: body.openingFloat,
      notes: body.notes,
      correlationId: createId("corr")
    });
    return reply.code(201).send(closure);
  });

  app.get("/properties/:propertyId/pos/cash-closures/:closureId", async (request) => {
    const { propertyId, closureId } = request.params as ClosureParams;
    return getCashClosure(propertyId, closureId);
  });

  app.post("/properties/:propertyId/pos/cash-closures/:closureId/close", async (request) => {
    const { propertyId, closureId } = request.params as ClosureParams;
    const body = parse(CashClosureCloseSchema, requireObjectBody(request.body));
    return closeCashClosure({
      context: request.userContext,
      propertyId,
      closureId,
      countedByMethod: body.countedByMethod,
      counts: body.counts,
      notes: body.notes,
      correlationId: createId("corr")
    });
  });

  app.post("/properties/:propertyId/pos/cash-closures/:closureId/approve", async (request) => {
    const { propertyId, closureId } = request.params as ClosureParams;
    const body = parse(CashClosureApproveSchema, requireObjectBody(request.body ?? {}));
    return approveCashClosure({ context: request.userContext, propertyId, closureId, notes: body.notes, correlationId: createId("corr") });
  });
}
