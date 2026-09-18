// Cierre del día — HTTP surface of the night-audit module.
//
// Registered from server.ts with `registerNightAuditRoutes(app)` (convention
// rate grid v2: *.routes.ts + route-permissions.partial.ts). Until the
// integrator wires it, server.ts keeps its four legacy registrations (same
// paths, same services); registering both would make Fastify throw, so the
// handoff replaces them. Every route lives under /properties/:propertyId,
// validated by the global tenancy hook.
//
// Tanda 8a (RBAC · L2, design §4.7): `run` needs night_audit.run; the income
// audit `runs/:runId/review` needs night_audit.review (reviewer ≠ runner) and
// `runs/:runId/reopen` needs night_audit.reopen with a reason code of
// REOPEN_REASON_CODES (≤ 7 days with the key, later the day_reopen approval
// of another person). Bodies are zod-validated here (strict, Spanish).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createId } from "../../lib/ids.js";
import { parse } from "../../lib/validate.js";
import { REOPEN_REASON_CODES, getCurrentBusinessDate, getNightAuditRun, listNightAuditRuns, reopenNightAuditRun, reviewNightAuditRun, runNightAudit } from "./night-audit.service.js";

type PropertyParams = { propertyId: string };
type RunParams = { propertyId: string; runId: string };

const reopenReasonCodes = Object.keys(REOPEN_REASON_CODES) as [keyof typeof REOPEN_REASON_CODES, ...Array<keyof typeof REOPEN_REASON_CODES>];

export const NightAuditReviewSchema = z.object({ note: z.string().trim().min(1).max(1000).optional() }).strict();

export const NightAuditReopenSchema = z
  .object({
    reasonCode: z.enum(reopenReasonCodes),
    reasonText: z.string().trim().min(1).max(1000).optional(),
    supervisorAuthorizationId: z.string().trim().min(1).max(64).optional()
  })
  .strict();

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

  app.post("/properties/:propertyId/night-audit/runs/:runId/review", async (request) => {
    const { propertyId, runId } = request.params as RunParams;
    const body = parse(NightAuditReviewSchema, request.body ?? {});
    return reviewNightAuditRun({ context: request.userContext, propertyId, runId, note: body.note, correlationId: createId("corr") });
  });

  app.post("/properties/:propertyId/night-audit/runs/:runId/reopen", async (request) => {
    const { propertyId, runId } = request.params as RunParams;
    const body = parse(NightAuditReopenSchema, request.body ?? {});
    return reopenNightAuditRun({
      context: request.userContext,
      propertyId,
      runId,
      reasonCode: body.reasonCode,
      reasonText: body.reasonText,
      supervisorAuthorizationId: body.supervisorAuthorizationId ?? null,
      correlationId: createId("corr")
    });
  });
}
