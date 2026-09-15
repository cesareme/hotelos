// Rate grid v2 · HTTP surface of the rate-manager module.
//
// Registrado desde server.ts con `registerRateGridRoutes(app, { outbox })`
// (outbox opcional: sin él el bridge resuelve channel-manager/delivery.service).
// Permisos: route-permissions.partial.ts — entradas fusionadas en
// routePermissionManifest (security/route-permissions.ts); el contract test
// lee ese fichero.
//
// Tenancy: every route lives under /properties/:propertyId, which the global
// hook already validates against the caller's organisation; ids inside bodies
// (plans, room types, channels, journal) are validated by the services (400
// UNKNOWN_IDS / 404). Bodies and queries are zod-validated in the services so
// direct callers get the same 400s.

import type { FastifyInstance } from "fastify";
import { createId } from "../../lib/ids.js";
import { parsePageQuery } from "../../lib/pagination.js";
import type { RateGridOutbox } from "./channel-outbox.bridge.js";
import { setRateGridOutbox } from "./channel-outbox.bridge.js";
import { getRateJournal, getRateJournalEntry, revertRateJournal } from "./journal.service.js";
import { gridQuerySchema, parseOr400, rederiveQuerySchema, syncStatusQuerySchema } from "./rate-grid.schemas.js";
import { bulkUpdateRateGrid, getRateGrid, getRateGridSyncStatus, pushRateGrid, rederiveRatePlan } from "./rate-grid.service.js";

export type RateGridRouteDeps = {
  /** Real outbox (channel-manager/delivery.service). Omitted → bridge resolves it (or the honest fallback). */
  outbox?: RateGridOutbox;
};

type PropertyParams = { propertyId: string };

export function registerRateGridRoutes(app: FastifyInstance, deps: RateGridRouteDeps = {}): void {
  if (deps.outbox) setRateGridOutbox(deps.outbox);

  app.get("/properties/:propertyId/rate-grid", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const q = parseOr400(gridQuerySchema, request.query ?? {}, "query");
    return getRateGrid({
      propertyId,
      from: q.from,
      to: q.to,
      ratePlanIds: q.ratePlanIds,
      roomTypeIds: q.roomTypeIds,
      channelId: q.channelId ?? null,
      demand: q.demand === "1" || q.demand === "true",
      outbox: deps.outbox
    });
  });

  app.post("/properties/:propertyId/rate-grid/bulk-update", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const body = (request.body ?? {}) as Record<string, unknown>;
    return bulkUpdateRateGrid({
      propertyId,
      context: request.userContext,
      cells: body.cells as never,
      ops: body.ops as never,
      reason: body.reason as never,
      publish: body.publish as never,
      clientRequestId: body.clientRequestId as never,
      correlationId: createId("corr"),
      outbox: deps.outbox
    });
  });

  app.post("/properties/:propertyId/rate-grid/push", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const body = (request.body ?? {}) as Record<string, unknown>;
    return pushRateGrid({
      propertyId,
      context: request.userContext,
      from: body.from as never,
      to: body.to as never,
      channelIds: body.channelIds as never,
      ratePlanIds: body.ratePlanIds as never,
      roomTypeIds: body.roomTypeIds as never,
      kinds: body.kinds as never,
      journalId: body.journalId as never,
      outbox: deps.outbox
    });
  });

  app.get("/properties/:propertyId/rate-grid/sync-status", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const q = parseOr400(syncStatusQuerySchema, request.query ?? {}, "query");
    return getRateGridSyncStatus({ propertyId, from: q.from, to: q.to, channelIds: q.channelIds, outbox: deps.outbox });
  });

  app.get("/properties/:propertyId/rate-journal", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const page = parsePageQuery((request.query ?? {}) as Record<string, unknown>, { limit: 50, max: 200 });
    return getRateJournal({ propertyId, limit: page.limit, cursor: page.cursor });
  });

  app.get("/properties/:propertyId/rate-journal/:journalId", async (request) => {
    const { propertyId, journalId } = request.params as PropertyParams & { journalId: string };
    return getRateJournalEntry({ propertyId, journalId });
  });

  app.post("/properties/:propertyId/rate-journal/:journalId/revert", async (request) => {
    const { propertyId, journalId } = request.params as PropertyParams & { journalId: string };
    const body = (request.body ?? {}) as { force?: boolean; reason?: string };
    return revertRateJournal({ propertyId, journalId, context: request.userContext, correlationId: createId("corr"), body });
  });

  app.post("/properties/:propertyId/rate-plans/:ratePlanId/rederive", async (request) => {
    const { propertyId, ratePlanId } = request.params as PropertyParams & { ratePlanId: string };
    const q = parseOr400(rederiveQuerySchema, request.query ?? {}, "query");
    return rederiveRatePlan({ propertyId, ratePlanId, context: request.userContext, from: q.from, to: q.to, correlationId: createId("corr") });
  });
}
