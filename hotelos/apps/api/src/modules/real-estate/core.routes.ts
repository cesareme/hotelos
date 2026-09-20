// Activo inmobiliario · rutas core (Tanda ACT · L1): ficha, unidades, cargas,
// valoraciones y tenencia bajo /properties/:propertyId/real-estate/*.
//
// Registradas desde real-estate.register.ts (`registerRealEstateRoutes`, que a
// su vez llama server.ts); permisos en core-route-permissions.partial.ts
// (real_estate.read para GET, real_estate.manage para escrituras). La guardia
// global de tenencia de server.ts (pickPropertyId → grantPropertyAccess) cubre
// el :propertyId; los servicios buscan cada fila a través del activo del
// centro y responden 404 opaco. Patrón: modules/fixed-assets/fixed-assets.routes.ts.

import type { FastifyInstance } from "fastify";
import { createId } from "../../lib/ids.js";
import {
  createRealEstateAsset,
  createRealEstateCharge,
  createRealEstateUnit,
  createRealEstateValuation,
  getRealEstateAssetDetail,
  listRealEstateValuations,
  updateRealEstateAsset,
  updateRealEstateCharge,
  updateRealEstateUnit
} from "./real-estate.service.js";
import { createRealEstateTenure, listRealEstateTenures, updateRealEstateTenure } from "./tenure.service.js";

type PropertyParams = { propertyId: string };
type UnitParams = PropertyParams & { unitId: string };
type ChargeParams = PropertyParams & { chargeId: string };
type TenureParams = PropertyParams & { tenureId: string };

export function registerRealEstateCoreRoutes(app: FastifyInstance): void {
  // ── Ficha ──────────────────────────────────────────────────────────────────
  app.get("/properties/:propertyId/real-estate", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return getRealEstateAssetDetail(propertyId);
  });

  app.post("/properties/:propertyId/real-estate", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const detail = await createRealEstateAsset({ context: request.userContext, propertyId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(detail);
  });

  app.patch("/properties/:propertyId/real-estate", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return updateRealEstateAsset({ context: request.userContext, propertyId, body: request.body, correlationId: createId("corr") });
  });

  // ── Unidades registrales / catastrales y sus cargas ───────────────────────
  app.post("/properties/:propertyId/real-estate/units", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const unit = await createRealEstateUnit({ context: request.userContext, propertyId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(unit);
  });

  app.patch("/properties/:propertyId/real-estate/units/:unitId", async (request) => {
    const params = request.params as UnitParams;
    return updateRealEstateUnit({ context: request.userContext, propertyId: params.propertyId, unitId: params.unitId, body: request.body, correlationId: createId("corr") });
  });

  app.post("/properties/:propertyId/real-estate/units/:unitId/charges", async (request, reply) => {
    const params = request.params as UnitParams;
    const charge = await createRealEstateCharge({ context: request.userContext, propertyId: params.propertyId, unitId: params.unitId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(charge);
  });

  app.patch("/properties/:propertyId/real-estate/charges/:chargeId", async (request) => {
    const params = request.params as ChargeParams;
    return updateRealEstateCharge({ context: request.userContext, propertyId: params.propertyId, chargeId: params.chargeId, body: request.body, correlationId: createId("corr") });
  });

  // ── Valoraciones ──────────────────────────────────────────────────────────
  app.get("/properties/:propertyId/real-estate/valuations", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return listRealEstateValuations(propertyId);
  });

  app.post("/properties/:propertyId/real-estate/valuations", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const valuation = await createRealEstateValuation({ context: request.userContext, propertyId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(valuation);
  });

  // ── Tenencia ──────────────────────────────────────────────────────────────
  app.get("/properties/:propertyId/real-estate/tenures", async (request) => {
    const { propertyId } = request.params as PropertyParams;
    return listRealEstateTenures(propertyId);
  });

  app.post("/properties/:propertyId/real-estate/tenures", async (request, reply) => {
    const { propertyId } = request.params as PropertyParams;
    const tenure = await createRealEstateTenure({ context: request.userContext, propertyId, body: request.body, correlationId: createId("corr") });
    return reply.code(201).send(tenure);
  });

  app.patch("/properties/:propertyId/real-estate/tenures/:tenureId", async (request) => {
    const params = request.params as TenureParams;
    return updateRealEstateTenure({ context: request.userContext, propertyId: params.propertyId, tenureId: params.tenureId, body: request.body, correlationId: createId("corr") });
  });
}
