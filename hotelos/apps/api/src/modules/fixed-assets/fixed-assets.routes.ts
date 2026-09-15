// Fixed assets · HTTP surface (Finanzas 2026-09-15, lote proveedores-activos).
//
// Registrado desde server.ts con `registerFixedAssetsRoutes(app)` (integrador).
// Permisos: route-permissions.partial.ts (fusionado en routePermissionManifest;
// el contract test lee ambos ficheros).
//
// The element register hangs from /properties/:propertyId (`asset-register`,
// distinct from the legacy read-only `GET /properties/:propertyId/fixed-assets`
// of server.ts, which keeps its old shape until the integrator retires it);
// depreciation runs are per organisation (one run per month for every element
// of the organisation, unique (organizationId, period)).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createId } from "../../lib/ids.js";
import { assertEntityAccess } from "../../lib/tenancy.js";
import { parseOr400 } from "../rate-manager/rate-grid.schemas.js";
import { getDepreciationRun, listDepreciationRuns, PERIOD_PATTERN, postDepreciationRun, previewDepreciationRun, reverseDepreciationRun } from "./depreciation.service.js";
import { createFixedAsset, disposeFixedAsset, getFixedAsset, listFixedAssetRegister, updateFixedAsset } from "./fixed-assets.service.js";

type OrganizationParams = { organizationId: string };
type RunParams = OrganizationParams & { runId: string };
type PropertyParams = { propertyId: string };
type AssetParams = PropertyParams & { assetId: string };

const assetListQuery = z
  .object({ status: z.enum(["active", "fully_depreciated", "disposed"]).optional(), q: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(500).optional() })
  .strict();
const previewQuery = z.object({ period: z.string().regex(PERIOD_PATTERN, "formato AAAA-MM") }).strict();
const runsQuery = z.object({ limit: z.coerce.number().int().min(1).max(240).optional() }).strict();

export function registerFixedAssetsRoutes(app: FastifyInstance): void {
  // ── Element register (property-owned) ─────────────────────────────────────
  app.get("/properties/:propertyId/asset-register", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    const q = parseOr400(assetListQuery, request.query ?? {}, "Filtro");
    return listFixedAssetRegister({ propertyId, ...q });
  });

  app.post("/properties/:propertyId/asset-register", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const asset = await createFixedAsset({ context: request.userContext, propertyId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(asset);
  });

  app.get("/properties/:propertyId/asset-register/:assetId", async (request) => {
    const params = request.params as AssetParams;
    return getFixedAsset(params.propertyId, params.assetId);
  });

  app.patch("/properties/:propertyId/asset-register/:assetId", async (request) => {
    const params = request.params as AssetParams;
    return updateFixedAsset({ context: request.userContext, propertyId: params.propertyId, assetId: params.assetId, body: request.body, correlationId: createId("corr") });
  });

  app.post("/properties/:propertyId/asset-register/:assetId/dispose", async (request) => {
    const params = request.params as AssetParams;
    return disposeFixedAsset({ context: request.userContext, propertyId: params.propertyId, assetId: params.assetId, body: request.body, correlationId: createId("corr") });
  });

  // ── Depreciation runs (organisation-owned) ────────────────────────────────
  app.get("/organizations/:organizationId/depreciation-runs", async (request) => {
    const { organizationId } = await assertEntityAccess(request, { entity: "organization", id: (request.params as OrganizationParams).organizationId });
    const q = parseOr400(runsQuery, request.query ?? {}, "Filtro");
    return listDepreciationRuns(organizationId, q.limit);
  });

  app.get("/organizations/:organizationId/depreciation-runs/preview", async (request) => {
    const { organizationId } = await assertEntityAccess(request, { entity: "organization", id: (request.params as OrganizationParams).organizationId });
    const q = parseOr400(previewQuery, request.query ?? {}, "Filtro");
    return previewDepreciationRun(organizationId, q.period);
  });

  app.post("/organizations/:organizationId/depreciation-runs", async (request, reply) => {
    const { organizationId } = await assertEntityAccess(request, { entity: "organization", id: (request.params as OrganizationParams).organizationId });
    const run = await postDepreciationRun({ context: request.userContext, organizationId, body: request.body, correlationId: createId("corr") });
    return reply.code(run.alreadyPosted ? 200 : 201).send(run);
  });

  app.get("/organizations/:organizationId/depreciation-runs/:runId", async (request) => {
    const params = request.params as RunParams;
    const { organizationId } = await assertEntityAccess(request, { entity: "organization", id: params.organizationId });
    return getDepreciationRun(organizationId, params.runId);
  });

  app.post("/organizations/:organizationId/depreciation-runs/:runId/reverse", async (request) => {
    const params = request.params as RunParams;
    const { organizationId } = await assertEntityAccess(request, { entity: "organization", id: params.organizationId });
    return reverseDepreciationRun({ context: request.userContext, organizationId, runId: params.runId, body: request.body, correlationId: createId("corr") });
  });
}
