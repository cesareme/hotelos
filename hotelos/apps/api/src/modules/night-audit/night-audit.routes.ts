// Cierre del día — HTTP surface of the night-audit module.
//
// Registered from server.ts with `registerNightAuditRoutes(app)` (convention
// rate grid v2: *.routes.ts + route-permissions.partial.ts). Until the
// integrator wires it, server.ts keeps its four legacy registrations (same
// paths, same services); registering both would make Fastify throw, so the
// handoff replaces them. Every route lives under /properties/:propertyId,
// validated by the global tenancy hook.

import type { FastifyInstance } from "fastify";
import { createId } from "../../lib/ids.js";
import { getCurrentBusinessDate, getNightAuditRun, listNightAuditRuns, runNightAudit } from "./night-audit.service.js";

type PropertyParams = { propertyId: string };
type RunParams = { propertyId: string; runId: string };

export function registerNightAuditRoutes(app: FastifyInstance): void {
  app.get("/properties/:propertyId/night-audit/business-date", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const current = await getCurrentBusinessDate(propertyId);
    return { propertyId, currentDate: current };
  });

  app.get("/properties/:propertyId/night-audit/runs", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return listNightAuditRuns(propertyId);
  });

  app.get("/properties/:propertyId/night-audit/runs/:runId", async (request) => {
    const { propertyId, runId } = request.params as RunParams;
    return getNightAuditRun(propertyId, runId);
  });

  app.post("/properties/:propertyId/night-audit/run", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return runNightAudit({ context: request.userContext, propertyId, correlationId: createId("corr") });
  });

  app.get("/properties/:propertyId/night-audit/preflight", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const { buildPreflight } = await import("./night-audit-preflight.service.js");
    return buildPreflight({ propertyId });
  });
}
